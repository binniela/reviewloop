create table if not exists request_limits (
  key text primary key,
  window_start timestamptz not null,
  attempts integer not null
);
