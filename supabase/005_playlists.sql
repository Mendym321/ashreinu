-- JEM's own curated playlists from Ashreinu ("Lag B'Omer Highlights",
-- "Yearning for Moshiach", timelines, "Moments"...). Each playlist is a list
-- of clips: an excerpt of a recording (start and end time) with its own
-- human-written title, and sometimes a written text (summary + source).
-- Filled by the pipeline page's "Import JEM playlists" button (free, no AI);
-- re-running it refreshes everything.
--
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.

create table if not exists playlists (
  id           bigint primary key,
  name         text not null,
  hebrew_name  text,
  description  text,
  taxonomy     text,            -- playlist, timeline, interactive_article, book...
  published    boolean not null default true,
  picture      text,            -- cover image (JEM's)
  sort         int,             -- Ashreinu's own order
  clip_count   int not null default 0,
  total_ms     bigint not null default 0,
  extra        jsonb,           -- timeline years, sponsor, background picture...
  updated_at   timestamptz not null default now()
);

create table if not exists playlist_clips (
  playlist_id  bigint not null references playlists(id) on delete cascade,
  position     int not null,
  clip_id      bigint not null,
  name         text,            -- the clip's own title
  description  text,
  recording_id bigint,
  audio_uri    text,
  start_ms     int,
  end_ms       int,
  picture      text,
  event_id     bigint,          -- our track with this recording, when we have it
  document     text,            -- the clip's written text, when it has one
  primary key (playlist_id, position)
);
-- True when the clip has a written text (so lists needn't load the text).
alter table playlist_clips add column if not exists has_document boolean generated always as (document is not null) stored;
create index if not exists playlist_clips_clip  on playlist_clips (clip_id);
create index if not exists playlist_clips_event on playlist_clips (event_id);

alter table playlists      enable row level security;
alter table playlist_clips enable row level security;
grant select, insert, update, delete on playlists, playlist_clips to service_role;
