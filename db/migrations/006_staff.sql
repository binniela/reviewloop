-- Per-person sign-in. Until now one shared login did everything, so names recorded in
-- acknowledged_by, decided_by and approved_by can't tell people apart. Those columns now hold the
-- staff member's name; audit_log links each action to a staff row.

create table if not exists staff (
  id              bigint generated always as identity primary key,
  username        text not null,
  name            text not null,
  role            text not null check (role in ('desk', 'gm')),
  password_hash   text,                       -- scrypt; GMs always have one, desk staff may be PIN-only
  pin_hash        text,                       -- scrypt of a 4-digit PIN, for switching person on a desk PC
  created_at      timestamptz not null default now(),
  created_by      text,
  removed_at      timestamptz,                -- kept, not deleted, so the activity log still has a name
  last_active_at  timestamptz
);
create unique index if not exists staff_username_active on staff (lower(username)) where removed_at is null;
create unique index if not exists staff_name_active on staff (lower(name)) where removed_at is null;

-- Shared front-desk computers. A GM registers one from the Staff page; only a registered desk PC
-- offers the pick-your-name-and-PIN screen, so a 4-digit PIN never works from the open internet.
create table if not exists desk_devices (
  id              text primary key,           -- sha256 of the device cookie token
  label           text not null,
  created_at      timestamptz not null,
  created_by      text not null,
  removed_at      timestamptz
);

-- Server-side sessions, so removing someone or resetting their password signs them out everywhere.
create table if not exists staff_sessions (
  token_hash      text primary key,           -- sha256 of the cookie token
  staff_id        bigint not null references staff(id),
  device_id       text references desk_devices(id),  -- set on a desk PC: signs out after inactivity
  created_at      timestamptz not null,
  last_seen_at    timestamptz not null,
  expires_at      timestamptz not null
);
create index if not exists staff_sessions_staff on staff_sessions (staff_id);

-- Who did what, and when. Guest details are joined in when the log is read, so retention
-- redaction applies here too; nothing guest-identifying is copied into this table.
create table if not exists audit_log (
  id              bigint generated always as identity primary key,
  at              timestamptz not null,
  staff_id        bigint references staff(id),
  actor           text not null,              -- name at the time, so the log reads right after renames
  action          text not null,              -- case.take, case.text, case.resolve, case.log, draft.approve, ...
  subject_id      bigint,                     -- case, draft, consent or staff id, depending on action
  detail          text,                       -- staff-facing context only, never guest text
  device          text,                       -- desk PC label when the action happened on one
  imported        boolean not null default false  -- recorded before per-person sign-in existed
);
create index if not exists audit_log_at on audit_log (at desc, id desc);

-- Carry existing history into the log. Everything before this was done under the one shared login,
-- so actions without a recorded name are attributed to it rather than guessed.
insert into audit_log (at, actor, action, subject_id, imported)
select acknowledged_at, acknowledged_by, case when source = 'staff' then 'case.log' else 'case.take' end, id, true
  from recovery_cases where acknowledged_at is not null and acknowledged_by is not null;

insert into audit_log (at, actor, action, subject_id, imported)
select resolved_at, 'Shared sign-in', 'case.resolve', id, true from recovery_cases where resolved_at is not null;

insert into audit_log (at, actor, action, subject_id, imported)
select created_at, 'Shared sign-in', 'case.text', case_id, true
  from messages where kind = 'staff' and direction = 'out' and case_id is not null;

insert into audit_log (at, actor, action, subject_id, imported)
select decided_at, decided_by, case when status = 'dismissed' then 'draft.dismiss' else 'draft.approve' end, id, true
  from reply_drafts where decided_at is not null and decided_by is not null and decided_by not in ('auto', 'replied outside app');

insert into audit_log (at, actor, action, subject_id, imported)
select approved_at, approved_by, 'consent.approve', id, true from consents where approved_at is not null and approved_by is not null;
