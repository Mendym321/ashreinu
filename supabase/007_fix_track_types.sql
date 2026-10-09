-- Ashreinu labels ~395 tracks INSIDE farbrengens with the type "Farbrengen"
-- (the type meant for the whole event): mostly niggunim ("Daled Bavos",
-- "Sheyiboneh"), "End of Farbrengen", and a few sichos. In the app that
-- hid them from their niggun's page and made some open as an empty
-- "farbrengen". This gives our copy the right type, by the track's name.
-- Ashreinu's original stays in raw_data. build-index applies the same rule
-- to anything it imports later (api/build-index.js, trackType).
--
-- Run this once in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run (it only touches tracks still typed "Farbrengen").

update ashreinu_events set type = case
    when name ~* 'k.?ein sicha'                         then 'Ma’amar K’ein Sicha'
    when name ~* '^sicha'                               then 'Farbrengen – Sicha'
    when name ~* 'ma.?amar'                             then 'Farbrengen – Ma’amar'
    when name ~* 'end of farbrengen'                    then 'End of Farbrengen'
    when name ~* 'report|conversation|magbis|brach|blessing' then 'Other'
    else 'Nigun'
  end
where parent_id is not null and type = 'Farbrengen';
