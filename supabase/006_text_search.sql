-- Search inside Ashreinu's own texts: the Hebrew outline and the hanacha of
-- every talk the pipeline has collected ("Collect all", free), catalogued
-- or not. The index keeps itself up to date as texts are collected.
--
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run. Building the index over thousands of texts can take a
-- minute.

-- Every word of the outline and hanacha, for fast lookup.
alter table track_metadata add column if not exists text_tsv tsvector
  generated always as (to_tsvector('simple', coalesce(outline_he, '') || ' ' || coalesce(transcript, ''))) stored;
create index if not exists track_metadata_text_tsv on track_metadata using gin (text_tsv);

-- q: a tsquery (built by the app, e.g. "(אהבת|ואהבת) <-> (ישראל|וישראל)").
-- Returns the best-matching tracks with a short snippet around the match
-- (the matched words wrapped in ⟦ ⟧).
create or replace function search_texts(q text, max_results int default 30)
returns table (ashreinu_event_id bigint, snippet text, rank real)
language sql stable as $$
  with hits as (
    select t.ashreinu_event_id, t.outline_he, t.transcript, ts_rank(t.text_tsv, to_tsquery('simple', q)) as rank
    from track_metadata t
    where t.text_tsv @@ to_tsquery('simple', q) and t.status <> 'skipped'
    order by rank desc
    limit max_results
  )
  select h.ashreinu_event_id,
         ts_headline('simple', coalesce(h.transcript, '') || ' … ' || coalesce(h.outline_he, ''), to_tsquery('simple', q),
                     'MaxWords=24, MinWords=10, MaxFragments=1, StartSel=⟦, StopSel=⟧'),
         h.rank
  from hits h
  order by h.rank desc;
$$;
grant execute on function search_texts(text, int) to service_role;
