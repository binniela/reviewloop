-- Durable inbound side effects and explicit operational states.
create table outbound_queue (
  id bigserial primary key,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  sent_at timestamptz
);
create index outbound_queue_due on outbound_queue (next_attempt_at) where status = 'pending';
alter table messages add column dedupe_key text unique;
alter table recovery_cases add column kind text not null default 'complaint' check (kind in ('complaint', 'request'));
alter table recovery_cases add column escalation_error text;
alter table recovery_cases add column escalation_next_attempt_at timestamptz;
alter table recovery_cases add column guest_confirmed_at timestamptz;
alter table consents add column approved_at timestamptz;
alter table consents add column approved_by text;
alter table properties alter column reply_mode set default 'approval_all';
-- Existing pilots also start with human approval after this safety migration.
update properties set reply_mode = 'approval_all';
-- Historic heuristic matches are not identity verification.
alter table reviews add column stay_verified_at timestamptz;
alter table messages add column in_reply_to bigint references messages(id);
-- Callbacks may arrive before the synchronous send result has been stored.
create table sms_delivery_receipts (
  provider_id text primary key,
  status text not null,
  rank integer not null,
  error_code text,
  updated_at timestamptz not null
);
alter table recovery_cases add column followup_claimed_at timestamptz;
alter table recovery_cases add column followup_error text;
