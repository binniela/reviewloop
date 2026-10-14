-- Sends the provider refused for good, or that ran out of retries, end as 'failed' and show on
-- Operations instead of retrying forever.
alter table outbound_queue drop constraint if exists outbound_queue_status_check;
alter table outbound_queue add constraint outbound_queue_status_check
  check (status in ('pending', 'sending', 'sent', 'cancelled', 'failed')) not valid;
create index if not exists outbound_queue_problems on outbound_queue (locked_at desc) where status in ('failed', 'cancelled');
