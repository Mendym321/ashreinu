-- 002: curated topics, richer catalogue fields, and ranked search.
-- Run after track_metadata.sql: Supabase → SQL Editor → New query → paste → Run.
-- Safe to re-run. Topic rows are only inserted when missing, so edits you
-- make in the table editor (names, aliases, descriptions) are never overwritten.

create extension if not exists pg_trgm;

-- ── Topics: the browsing menu (like genres) ──
-- Group rows (parent_slug is null) organise the menu; tracks are tagged
-- with the topics inside them. aliases = other words people use for it.
create table if not exists topics (
  slug        text primary key,
  name_en     text not null,
  name_he     text,
  parent_slug text references topics(slug),
  aliases     text[] not null default '{}',
  description text,
  sort        integer not null default 0,
  active      boolean not null default true
);
alter table topics enable row level security;

insert into topics (slug, name_en, name_he, parent_slug, aliases, description, sort) values
  -- Moshiach & Redemption
  ('g-moshiach', 'Moshiach & Redemption', 'משיח וגאולה', null, '{}', 'The coming of Moshiach and the world of the Redemption.', 10),
  ('moshiach', 'The Coming of Moshiach', 'ביאת המשיח', 'g-moshiach', '{moshiach,mashiach,messiah,geulah,redemption,messianic era,yemos hamoshiach}', 'What the Redemption is, and bringing it closer.', 11),
  ('exile', 'Exile', 'גלות', 'g-moshiach', '{galus,golus,exile,diaspora}', 'The meaning of exile and how to live in it.', 12),
  ('beis-hamikdash', 'The Holy Temple', 'בית המקדש', 'g-moshiach', '{beis hamikdash,bais hamikdash,temple,third temple,mishkan}', 'The Beis Hamikdash and the Mishkan.', 13),

  -- Serving G-d
  ('g-avodah', 'Serving G-d', 'עבודת ה''', null, '{}', 'The inner work of a Jew''s relationship with G-d.', 20),
  ('teshuvah', 'Teshuvah', 'תשובה', 'g-avodah', '{teshuvah,teshuva,repentance,returning to g-d}', 'Returning to G-d, at every level.', 21),
  ('prayer', 'Prayer', 'תפילה', 'g-avodah', '{tefillah,davening,prayer,shema}', 'Davening and its meaning.', 22),
  ('torah-study', 'Torah Study', 'לימוד התורה', 'g-avodah', '{limud hatorah,learning,torah study,shiurim}', 'Learning Torah, its value and how to do it.', 23),
  ('joy', 'Joy', 'שמחה', 'g-avodah', '{simcha,joy,happiness,bsimcha}', 'Serving G-d with joy.', 24),
  ('faith-trust', 'Faith & Trust in G-d', 'אמונה ובטחון', 'g-avodah', '{emunah,bitachon,faith,trust,hashgacha pratis,divine providence}', 'Emunah, bitachon and Divine providence.', 25),
  ('love-awe', 'Love & Awe of G-d', 'אהבה ויראה', 'g-avodah', '{ahavas hashem,yiras shamayim,love of g-d,fear of heaven}', 'Ahavah and yirah.', 26),
  ('humility', 'Humility & Self-Nullification', 'ביטול', 'g-avodah', '{bittul,humility,anivus,self-nullification}', 'Bittul and humility.', 27),
  ('self-sacrifice', 'Self-Sacrifice', 'מסירות נפש', 'g-avodah', '{mesiras nefesh,self-sacrifice,martyrdom}', 'Mesiras nefesh in every generation.', 28),
  ('physical-world', 'Holiness in the Physical World', 'דירה בתחתונים', 'g-avodah', '{dira betachtonim,gashmiyus,physicality,elevating the mundane,birurim}', 'Making a home for G-d in this world.', 29),
  ('personal-growth', 'Character & Personal Growth', 'עבודת המידות', 'g-avodah', '{middos,character,self-improvement,growth,refinement}', 'Refining character, step by step.', 30),
  ('challenges', 'Overcoming Challenges', 'התגברות על קשיים', 'g-avodah', '{nisyonos,hardship,challenges,difficulties,obstacles,tests}', 'Facing hardship and obstacles.', 31),
  ('soul', 'The Soul', 'הנשמה', 'g-avodah', '{neshamah,soul,body and soul,nefesh}', 'The Jewish soul and its descent into a body.', 32),

  -- Love & Community
  ('g-community', 'Love & Community', 'אהבת ישראל וקהילה', null, '{}', 'How Jews treat and care for one another.', 40),
  ('ahavas-yisroel', 'Love for Every Jew', 'אהבת ישראל', 'g-community', '{ahavas yisroel,ahavat yisrael,love of a fellow jew,love your fellow}', 'Ahavas Yisroel.', 41),
  ('unity', 'Jewish Unity', 'אחדות ישראל', 'g-community', '{achdus,unity,jewish unity}', 'Achdus among the Jewish people.', 42),
  ('charity', 'Charity & Kindness', 'צדקה וגמילות חסדים', 'g-community', '{tzedakah,charity,gemilus chassadim,kindness,giving}', 'Tzedakah and acts of kindness.', 43),
  ('leadership', 'Communal Leadership', 'עסקנות ציבורית', 'g-community', '{askanim,leaders,community leaders,activists,public service}', 'Responsibilities of communal leaders and activists.', 44),

  -- Spreading Judaism
  ('g-outreach', 'Spreading Judaism', 'הפצת היהדות', null, '{}', 'Reaching out to every Jew and to the world.', 50),
  ('shlichus', 'Shlichus', 'שליחות', 'g-outreach', '{shlichus,shluchim,shliach,emissaries,outreach}', 'The mission of the Rebbe''s shluchim, and of every Jew.', 51),
  ('mivtzoim', 'Mitzvah Campaigns', 'מבצעים', 'g-outreach', '{mivtzoim,mitzvah campaigns,mivtza}', 'The Rebbe''s mitzvah campaigns.', 52),
  ('tefillin', 'Tefillin', 'תפילין', 'g-outreach', '{tefillin,mivtza tefillin,phylacteries}', 'Mivtza Tefillin and the mitzvah of tefillin.', 53),
  ('mezuzah', 'Mezuzah', 'מזוזה', 'g-outreach', '{mezuzah,mivtza mezuzah}', 'Mivtza Mezuzah.', 54),
  ('shabbos-candles', 'Shabbos Candles', 'נרות שבת קודש', 'g-outreach', '{neshek,shabbos candles,candle lighting}', 'Lighting Shabbos and Yom Tov candles.', 55),
  ('kashrus', 'Kosher', 'כשרות', 'g-outreach', '{kashrus,kosher,kashrut}', 'Kashrus.', 56),
  ('family-purity', 'Family Purity', 'טהרת המשפחה', 'g-outreach', '{taharas hamishpacha,mikvah,family purity}', 'Taharas hamishpacha.', 57),
  ('noahide-laws', 'The Seven Noahide Laws', 'שבע מצוות בני נח', 'g-outreach', '{sheva mitzvos,noahide,noachide,bnei noach,gentiles}', 'Spreading the Noahide laws to all mankind.', 58),

  -- Education & Family
  ('g-family', 'Education & Family', 'חינוך ומשפחה', null, '{}', 'Raising and educating the next generation.', 60),
  ('education', 'Jewish Education', 'חינוך', 'g-family', '{chinuch,education,schools,teachers}', 'Chinuch, at home and in school.', 61),
  ('children', 'Children', 'ילדים', 'g-family', '{children,kids,tzivos hashem,young children}', 'Children and Tzivos Hashem.', 62),
  ('women', 'Jewish Women', 'נשי ובנות ישראל', 'g-family', '{women,girls,neshei chabad,jewish women}', 'The role and strength of Jewish women.', 63),
  ('family', 'Marriage & Family', 'בית יהודי', 'g-family', '{marriage,family,shalom bayis,wedding,jewish home}', 'Building a Jewish home.', 64),
  ('bar-mitzvah', 'Bar & Bas Mitzvah', 'בר ובת מצוה', 'g-family', '{bar mitzvah,bas mitzvah,bat mitzvah}', 'Coming of age.', 65),
  ('students', 'Students & Youth', 'תלמידים ונוער', 'g-family', '{students,bochurim,yeshiva students,youth,campus}', 'Yeshiva students, campus youth and young people.', 66),

  -- Torah & Chassidus
  ('g-torah', 'Torah & Chassidus', 'תורה וחסידות', null, '{}', 'Learning: Chassidus, Tanach, Talmud and halacha.', 70),
  ('chassidus', 'Chassidus', 'חסידות', 'g-torah', '{chassidus,chasidut,hasidism,tanya,pnimiyus hatorah}', 'The teachings of Chassidus and the Tanya.', 71),
  ('parsha', 'The Weekly Parsha', 'פרשת השבוע', 'g-torah', '{parsha,parshah,weekly torah portion,sedra,chumash}', 'Lessons from the weekly Torah portion.', 72),
  ('rambam', 'Rambam & Daily Study', 'לימוד הרמב"ם ושיעורים יומיים', 'g-torah', '{rambam,maimonides,chitas,daily study,siyum harambam}', 'The daily Rambam, Chitas and shiurim.', 73),
  ('halacha', 'Jewish Law', 'הלכה', 'g-torah', '{halacha,jewish law,shulchan aruch}', 'Halacha and its reasons.', 74),
  ('talmud', 'Talmud & Siyum', 'תלמוד', 'g-torah', '{gemara,talmud,shas,siyum,mishnah}', 'The Talmud, Mishnah and celebrating a siyum.', 75),
  ('kabbalah', 'Kabbalah & Mysticism', 'קבלה', 'g-torah', '{kabbalah,mysticism,zohar,sefiros}', 'Kabbalistic concepts and the Zohar.', 76),

  -- Jewish Time
  ('g-time', 'Jewish Time', 'זמנים', null, '{}', 'Shabbos, the festivals and the Jewish calendar.', 80),
  ('shabbos', 'Shabbos', 'שבת', 'g-time', '{shabbos,shabbat,sabbath}', 'The holiness and lessons of Shabbos.', 81),
  ('holidays', 'Jewish Holidays', 'מועדי ישראל', 'g-time', '{yom tov,festivals,holidays,yamim tovim}', 'The festivals and their meaning.', 82),
  ('chassidic-dates', 'Chassidic Holidays', 'ימי חג וגאולה בחסידות', 'g-time', '{yud tes kislev,yud shevat,chag hageulah,yahrzeit,hilula}', 'Yud-Tes Kislev, Yud Shevat and other Chassidic days.', 83),
  ('calendar', 'The Jewish Calendar', 'לוח השנה', 'g-time', '{rosh chodesh,jewish calendar,leap year,shemittah,hakhel,jewish months}', 'Months, special years and their lessons.', 84),

  -- Chabad & the Rebbeim
  ('g-chabad', 'Chabad & the Rebbeim', 'חב"ד ורבותינו נשיאינו', null, '{}', 'The Rebbeim, Chassidic history and connection to the Rebbe.', 90),
  ('rebbeim', 'The Rebbeim & Chassidic History', 'רבותינו נשיאינו', 'g-chabad', '{baal shem tov,maggid,alter rebbe,mitteler rebbe,tzemach tzedek,rebbe maharash,rebbe rashab,chassidic history,stories}', 'The Chabad Rebbeim, their lives and stories.', 91),
  ('previous-rebbe', 'The Previous Rebbe', 'כ"ק אדמו"ר מוהריי"צ', 'g-chabad', '{frierdiker rebbe,previous rebbe,rayatz,yosef yitzchak}', 'The Frierdiker Rebbe, his life and leadership.', 92),
  ('connection-rebbe', 'Connection to the Rebbe', 'התקשרות', 'g-chabad', '{hiskashrus,connection to the rebbe,rebbe and chassidim,yechidus}', 'Hiskashrus between Rebbe and Chassidim.', 93),
  ('farbrengen', 'Farbrengens & Chassidic Life', 'התוועדויות וחיי חסידים', 'g-chabad', '{farbrengen,chassidic customs,minhagim,chassidim}', 'Farbrengens, Chassidic customs and way of life.', 94),
  ('blessings', 'Blessings', 'ברכות', 'g-chabad', '{brachos,blessings,brocha,bracha}', 'The Rebbe''s blessings and their meaning.', 95),

  -- World & Society
  ('g-world', 'The World & Society', 'העולם והחברה', null, '{}', 'Israel, world events and Torah''s view of society.', 100),
  ('israel', 'The Land of Israel', 'ארץ ישראל', 'g-world', '{eretz yisroel,israel,holy land,land of israel}', 'Eretz Yisroel and its holiness.', 101),
  ('israel-security', 'Safety of Israel', 'שלימות הארץ', 'g-world', '{shleimus haaretz,security of israel,territories,war,idf}', 'The security and integrity of the Land of Israel.', 102),
  ('world-events', 'World Events', 'מאורעות העולם', 'g-world', '{current events,world events,government,america,society,peace}', 'Torah''s perspective on events and society.', 103),
  ('science', 'Torah & Science', 'תורה ומדע', 'g-world', '{science,technology,medicine,nature}', 'Torah and science.', 104),
  ('livelihood-health', 'Health & Livelihood', 'בריאות ופרנסה', 'g-world', '{parnassah,livelihood,business,health,refuah,healing}', 'Parnassah, health and everyday life.', 105)
on conflict (slug) do nothing;

-- ── Catalogue v2 fields ──
alter table track_metadata
  add column if not exists main_topic     text,               -- topic slug: what the talk is mainly about
  add column if not exists parsha         text,
  add column if not exists people         text[] not null default '{}',
  add column if not exists phrases        text[] not null default '{}',   -- famous sayings quoted
  add column if not exists audience       text[] not null default '{}',   -- from Ashreinu's own labels
  add column if not exists prompt_version integer,
  add column if not exists locked         boolean not null default false, -- true = human-edited; re-runs skip it
  -- Search text in four weighted layers (built by the pipeline):
  add column if not exists search_a text,   -- titles and famous phrases
  add column if not exists search_b text,   -- topics (with aliases), occasions, parsha, people, sources, audience
  add column if not exists search_c text,   -- summary and key points
  add column if not exists search_d text;   -- the Hebrew outline

-- Ranked full-text index: A (strongest) .. D (weakest). 'simple' keeps
-- transliterated words intact; 'english' adds stemming (talks → talk) for
-- the English summary layer.
alter table track_metadata add column if not exists search_tsv tsvector generated always as (
  setweight(to_tsvector('simple', coalesce(search_a, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(search_b, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(search_c, '')), 'C') ||
  setweight(to_tsvector('simple', coalesce(search_c, '')), 'C') ||
  setweight(to_tsvector('simple', coalesce(search_d, '')), 'D')
) stored;

create index if not exists track_metadata_tsv_idx on track_metadata using gin (search_tsv);
create index if not exists track_metadata_title_trgm_idx on track_metadata using gin (title_en gin_trgm_ops);
create index if not exists track_metadata_main_topic_idx on track_metadata (main_topic);

-- ── Ranked catalogue search ──
-- q_simple / q_english: tsquery strings built by api/search.js (with
-- spelling variants and aliases already expanded). topic_slugs: topics the
-- query names, so talks whose MAIN topic matches rank first. q_raw: the
-- plain query, for typo-tolerant title matching.
create or replace function search_catalogue(q_simple text, q_english text, q_raw text, topic_slugs text[], max_results integer default 60)
returns table (ashreinu_event_id bigint, rank real)
language sql stable as $$
  with q as (
    -- (written out case by case: in SQL, null || anything is null)
    select case
      when coalesce(q_simple, '') = '' and coalesce(q_english, '') = '' then null
      when coalesce(q_english, '') = '' then to_tsquery('simple', q_simple)
      when coalesce(q_simple, '') = '' then to_tsquery('english', q_english)
      else to_tsquery('simple', q_simple) || to_tsquery('english', q_english)
    end as tsq
  )
  select t.ashreinu_event_id,
         (coalesce(ts_rank_cd(t.search_tsv, q.tsq), 0)
          + case when t.main_topic = any(coalesce(topic_slugs, '{}')) then 1.0 else 0 end
          + case when t.topics && coalesce(topic_slugs, '{}') then 0.4 else 0 end
          + case when coalesce(q_raw, '') <> '' then word_similarity(q_raw, coalesce(t.title_en, '')) * 0.5 else 0 end
         )::real as rank
  from track_metadata t, q
  where t.status = 'enriched'
    and (   (q.tsq is not null and t.search_tsv @@ q.tsq)
         or t.main_topic = any(coalesce(topic_slugs, '{}'))
         or t.topics && coalesce(topic_slugs, '{}')
         or (coalesce(q_raw, '') <> '' and word_similarity(q_raw, coalesce(t.title_en, '')) > 0.55))
  order by rank desc
  limit max_results;
$$;
