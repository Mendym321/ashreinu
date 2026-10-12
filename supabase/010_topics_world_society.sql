-- Sharpen the topic menu so society/public-life talks (e.g. the Rebbe's
-- moment-of-silence campaign for public schools) route to "The World &
-- Society" instead of "Jewish Education", and add "Soviet Jewry" — a theme
-- the tagger kept wanting but the menu was missing.
--
-- Only the topic MENU changes here; it affects how Claude tags talks from now
-- on. Already-catalogued entries keep their topics until they are re-tagged
-- (Re-tag a track) or re-catalogued. Editing the `topics` table takes effect
-- within ~5 minutes (the API caches the menu briefly).
--
-- Run once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run.

-- 1) New topic: Soviet Jewry, under The World & Society (g-world).
insert into topics (slug, name_en, name_he, parent_slug, aliases, description, sort) values
  ('soviet-jewry', 'Soviet Jewry', 'יהדות רוסיה', 'g-world',
   '{soviet jewry,russian jewry,refuseniks,iron curtain,soviet union,behind the iron curtain,russia,ussr}',
   'Jews under Soviet rule and the effort to help and free them.', 106)
on conflict (slug) do nothing;

-- 2) World Events now explicitly covers the Rebbe's campaigns to better
--    society at large, so a public-policy / public-education talk lands here.
update topics set
  description = 'Torah''s perspective on world events and society, and the Rebbe''s calls to better society at large — including the moment of silence in public schools.',
  aliases = '{current events,world events,government,america,society,peace,moment of silence,public schools,public education,moral climate}'
where slug = 'world-events';

-- 3) Jewish Education is specifically Jewish learning, so general / public
--    education stops being pulled here.
update topics set
  description = 'Jewish education (chinuch) — teaching Jewish children Torah and mitzvos, at home and in school. Not general or public-school education.'
where slug = 'education';
