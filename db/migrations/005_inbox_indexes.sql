create index if not exists recovery_cases_open_inbox on recovery_cases (opened_at desc)
  where resolved_at is null;
create index if not exists recovery_cases_resolved_inbox on recovery_cases (resolved_at desc)
  where resolved_at is not null;
create index if not exists recovery_cases_unacked on recovery_cases (opened_at desc)
  where resolved_at is null and acknowledged_at is null;
create index if not exists recovery_cases_urgent_open on recovery_cases (opened_at desc)
  where resolved_at is null and urgency = 'urgent';
create index if not exists messages_case_inbound_latest on messages (case_id, created_at desc)
  where direction = 'in';
create index if not exists messages_unmatched_recent on messages (created_at desc)
  where direction = 'in' and kind = 'inbound' and case_id is null;
create index if not exists reply_drafts_awaiting on reply_drafts (status)
  where status in ('pending', 'failed');
create index if not exists consents_pending_recent on consents (created_at desc)
  where approved_at is null;
