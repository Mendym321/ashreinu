-- Featuring: which catalogued talks the home page's "Talks to explore"
-- shelf may show. Claude rates each talk 1-5 for how well it works for any
-- listener (evergreen); the shelf shows 4s and 5s. A person can overrule:
-- featured = true (always may be featured) or false (never).
--
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run.

alter table track_metadata add column if not exists evergreen        smallint;
alter table track_metadata add column if not exists evergreen_reason text;
alter table track_metadata add column if not exists featured         boolean;
