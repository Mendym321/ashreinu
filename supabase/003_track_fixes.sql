-- track_fixes: corrections a person makes to a track by hand in the
-- pipeline page ("Fix a track"). They win over Ashreinu's own labels and
-- over the catalogue entry Claude wrote. No AI involved.
--   kind 'niggun'     the recording is a niggun; title = its name
--   kind 'not_a_talk' music, silence, a broken recording: Claude skips it
--   kind 'title'      only the title is wrong; title = the right one
--
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.

create table if not exists track_fixes (
  ashreinu_event_id bigint primary key,
  kind              text not null check (kind in ('niggun', 'not_a_talk', 'title')),
  title             text,
  note              text,
  updated_at        timestamptz not null default now()
);
alter table track_fixes enable row level security;
grant select, insert, update, delete on track_fixes to service_role;
