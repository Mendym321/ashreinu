-- Stories (sippurim) the Rebbe tells inside a talk: "the Tzemach Tzedek
-- said…", "the Rebbe Rashab once went to Tashlich…". Claude pulls these out
-- of a track's hanacha while it catalogues it (api/pipeline.js), so they
-- become their own searchable, shareable cards that play the exact track.
-- One row per story. Re-cataloguing a track replaces its stories.
--
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.

create table if not exists stories (
  id                bigserial primary key,
  ashreinu_event_id bigint not null,          -- the track the story is told in
  farbrengen_id     bigint,                   -- its parent farbrengen, for context
  position          int not null default 0,   -- order within the track
  title_en          text not null,
  retelling_en      text not null,
  who               text[] not null default '{}',
  hebrew_quote      text,
  updated_at        timestamptz not null default now(),
  unique (ashreinu_event_id, position)
);
create index if not exists stories_event on stories (ashreinu_event_id);
create index if not exists stories_farb  on stories (farbrengen_id);

-- Free-text search over the title and the retelling (people named are
-- almost always in the retelling too).
alter table stories add column if not exists search_tsv tsvector
  generated always as (to_tsvector('simple', coalesce(title_en, '') || ' ' || coalesce(retelling_en, ''))) stored;
create index if not exists stories_search on stories using gin (search_tsv);

alter table stories enable row level security;
grant select, insert, update, delete on stories to service_role;
grant usage, select on sequence stories_id_seq to service_role;
