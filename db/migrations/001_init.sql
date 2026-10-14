-- Phase 1 schema: properties, stays, event log, milestone jobs, review requests,
-- reviews, reply drafts, and recovery cases (used to hold review requests).

create table if not exists properties (
  id                  text primary key,
  name                text not null,
  timezone            text not null default 'America/Los_Angeles',
  checkout_time       text not null default '11:00',        -- HH:MM local, used when the report has no actual time
  review_delay_min    integer not null default 120,          -- send review request this long after checkout
  quiet_start         text not null default '20:00',         -- no SMS from quiet_start to quiet_end, local time
  quiet_end           text not null default '09:00',
  google_place_id     text,
  google_location     text,                                  -- accounts/{a}/locations/{l}
  reply_mode          text not null default 'auto_high'      -- approval_all | auto_high | auto_all
                      check (reply_mode in ('approval_all', 'auto_high', 'auto_all')),
  voice_notes         text not null default '',              -- how the property sounds in public replies
  signoff             text not null default '',              -- e.g. "Priya, General Manager"
  request_template    text not null default
    'Hi {first_name}, thanks for staying at {property_name}! If you have a minute, we''d really appreciate a review: {review_link}',
  report_mapping      jsonb,                                 -- ASI CSV column mapping, see src/ingest/asiReport.ts
  created_at          timestamptz not null default now()
);

create table if not exists stays (
  id                  bigserial primary key,
  property_id         text not null references properties(id),
  confirmation        text not null,
  guest_first_name    text,
  guest_last_name     text,
  email               text,
  phone               text,
  sms_opt_in          boolean not null default false,
  room                text,
  channel             text,                                  -- booking source from the PMS, if reported
  arrival_date        date not null,
  departure_date      date not null,
  status              text not null
                      check (status in ('reserved', 'in_house', 'checked_out', 'cancelled', 'no_show')),
  checked_in_at       timestamptz,
  checked_out_at      timestamptz,
  state_hash          text not null,                         -- hash of tracked fields, for change detection
  first_seen_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (property_id, confirmation)
);

-- Append-only event log. idempotency_key makes overlapping ingests (report re-uploads,
-- polling plus future webhooks) safe: the same change never produces two events.
create table if not exists events (
  id                  bigserial primary key,
  property_id         text not null references properties(id),
  stay_id             bigint references stays(id),
  type                text not null,
  idempotency_key     text not null unique,
  payload             jsonb not null default '{}',
  occurred_at         timestamptz not null,
  processed_at        timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists events_unprocessed on events (id) where processed_at is null;

-- One job per stay per milestone. Rescheduling updates run_at instead of adding rows.
create table if not exists jobs (
  id                  bigserial primary key,
  stay_id             bigint not null references stays(id),
  kind                text not null,                         -- review_request (Phase 2 adds pre_arrival, check_in, mid_stay)
  run_at              timestamptz not null,
  status              text not null default 'pending'
                      check (status in ('pending', 'running', 'done', 'cancelled', 'skipped', 'failed')),
  attempts            integer not null default 0,
  result              text,
  updated_at          timestamptz not null default now(),
  unique (stay_id, kind)
);
create index if not exists jobs_due on jobs (run_at) where status = 'pending';

create table if not exists review_requests (
  id                  bigserial primary key,
  stay_id             bigint not null unique references stays(id),
  channel             text not null check (channel in ('sms', 'email')),
  destination         text not null,
  body                text not null,
  provider_id         text,
  sent_at             timestamptz not null default now()
);

create table if not exists recovery_cases (
  id                  bigserial primary key,
  stay_id             bigint not null references stays(id),
  summary             text not null,
  resolution          text,
  opened_at           timestamptz not null default now(),
  resolved_at         timestamptz
);

create table if not exists reviews (
  id                  bigserial primary key,
  property_id         text not null references properties(id),
  source              text not null,                         -- google (Phase 3: booking_com, expedia, tripadvisor)
  external_id         text not null,
  author              text,
  rating              integer check (rating between 1 and 5),
  body                text,
  reviewed_at         timestamptz not null,
  existing_reply      text,
  stay_id             bigint references stays(id),           -- best-effort match to a stay
  synced_at           timestamptz not null default now(),
  unique (source, external_id)
);

create table if not exists reply_drafts (
  id                  bigserial primary key,
  review_id           bigint not null unique references reviews(id),
  draft               text not null,
  final_text          text,
  status              text not null default 'pending'
                      check (status in ('pending', 'approved', 'posted', 'dismissed', 'failed')),
  decided_by          text,                                  -- 'auto' or the approver
  edited              boolean not null default false,        -- approver changed the draft; used to tune voice
  error               text,
  created_at          timestamptz not null default now(),
  decided_at          timestamptz,
  posted_at           timestamptz
);

create table if not exists sync_state (
  key                 text primary key,
  value               text not null,
  updated_at          timestamptz not null default now()
);
