-- track_metadata: one row per audio track, holding Ashreinu's own source
-- material for it (outline / hanacha) and the English catalogue entry
-- Claude writes from it.
--
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: every statement uses "if not exists".

create table if not exists track_metadata (
  ashreinu_event_id   bigint primary key,

  -- Source material, as collected from Ashreinu
  outline_he          text,          -- the "long description" outline (Hebrew)
  transcript          text,          -- hanacha, when there is one
  transcript_kind     text,          -- e.g. 'Hanacha (Lahak)', 'Yiddish Hanacha (Notik)'

  -- Pipeline state: 'collected' → 'enriched', or 'no_source' / 'error'
  status              text not null default 'collected',
  error               text,

  -- Claude's catalogue entry
  title_en            text,
  title_he            text,
  summary_en          text,
  key_points          text[] not null default '{}',
  keywords            text[] not null default '{}',
  topics              text[] not null default '{}',
  suggested_new_topics text[] not null default '{}',
  occasions           text[] not null default '{}',
  sources             text[] not null default '{}',
  confidence          text,
  confidence_reason   text,

  -- Everything search should look at, lower-cased, in one column
  search_text         text,

  -- Bookkeeping
  model               text,
  input_tokens        integer,
  output_tokens       integer,
  enriched_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists track_metadata_status_idx on track_metadata (status);
create index if not exists track_metadata_topics_idx on track_metadata using gin (topics);

-- Only the server (which uses the service key) may read or write this table.
-- With row-level security on and no policies, the public anon key can't touch it.
alter table track_metadata enable row level security;
