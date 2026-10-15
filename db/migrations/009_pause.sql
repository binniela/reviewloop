-- A GM can stop every guest text for one hotel in one click (a bad import, a wrong template, an
-- unhappy owner). Held texts stay queued and go out once when texting resumes. Staff alerts are
-- never paused.
alter table properties add column if not exists guest_texts_paused_at timestamptz;
alter table properties add column if not exists guest_texts_paused_by text;
