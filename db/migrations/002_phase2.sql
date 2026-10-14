-- Phase 2: in-stay messaging, inbound texts, escalation, consent capture, metrics.

alter table properties
  add column if not exists sms_from            text,                      -- this hotel's Twilio number, E.164
  add column if not exists desk_phones         text[] not null default '{}',
  add column if not exists desk_emails         text[] not null default '{}',
  add column if not exists gm_phone            text,                      -- backup alert when the desk doesn't respond
  add column if not exists escalation_minutes  integer not null default 20,
  add column if not exists midstay_hour        integer not null default 10,
  add column if not exists welcome_template    text not null default
    'Hi {first_name}, welcome to {property_name}! If you need anything during your stay, just text this number.',
  add column if not exists midstay_template    text not null default
    'Hi {first_name}, how is everything with your room so far? Reply here if anything needs attention.',
  add column if not exists ack_template        text not null default
    'Thanks for letting us know, {first_name}. We''ve passed this to the front desk and someone will follow up shortly.',
  add column if not exists request_ack_template text not null default
    'Got it, {first_name}. We''ve passed this to the front desk.',
  add column if not exists followup_template   text not null default
    'Hi {first_name}, just checking: is everything better now?';

-- Consent captured outside the PMS. Kept separate from the report-driven columns so a later
-- report saying "no opt-in" can't erase consent the guest gave us directly.
alter table stays
  add column if not exists consent_phone   text,
  add column if not exists consented_at    timestamptz,
  add column if not exists satisfaction    real;            -- -1 (unhappy) to 1 (happy); null = no signal yet

-- Every message to or from a guest or staff member.
create table if not exists messages (
  id              bigserial primary key,
  property_id     text not null references properties(id),
  stay_id         bigint references stays(id),
  case_id         bigint references recovery_cases(id),
  direction       text not null check (direction in ('in', 'out')),
  channel         text not null check (channel in ('sms', 'email')),
  kind            text not null,   -- inbound | review_request | welcome | mid_stay | ack | followup | staff | alert
  from_addr       text,
  to_addr         text not null,
  body            text not null,
  provider_id     text unique,     -- Twilio MessageSid for inbound makes webhook retries no-ops
  classification  jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists messages_stay on messages (stay_id, created_at);

create table if not exists opt_outs (
  phone           text primary key,
  opted_out_at    timestamptz not null default now()
);

-- Opt-ins from the check-in page that didn't match a stay yet (report not ingested, typo).
create table if not exists consents (
  id              bigserial primary key,
  property_id     text not null references properties(id),
  phone           text not null,
  last_name       text not null,
  room            text not null,
  stay_id         bigint references stays(id),
  created_at      timestamptz not null default now()
);

alter table recovery_cases
  add column if not exists source           text not null default 'staff',   -- staff | guest_text
  add column if not exists category         text,
  add column if not exists urgency          text not null default 'normal',
  add column if not exists alerted_at       timestamptz,
  add column if not exists escalated_at     timestamptz,
  add column if not exists acknowledged_at  timestamptz,
  add column if not exists acknowledged_by  text,
  add column if not exists followup_due_at  timestamptz,
  add column if not exists followup_sent_at timestamptz,
  add column if not exists reopened_count   integer not null default 0;

-- Daily review totals per hotel. The first row is the pilot baseline.
create table if not exists review_snapshots (
  property_id     text not null references properties(id),
  source          text not null,
  day             date not null,
  review_count    integer not null,
  avg_rating      real,
  primary key (property_id, source, day)
);
