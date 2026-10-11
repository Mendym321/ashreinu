-- Lets the "find stories in catalogued tracks" scan (api/pipeline.js) resume:
-- once a track's stored text has been checked for stories, it's stamped here
-- so later runs skip it. Separate from cataloguing; costs nothing to add.
--
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.

alter table track_metadata add column if not exists stories_scanned_at timestamptz;
