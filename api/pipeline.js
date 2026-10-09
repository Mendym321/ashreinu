// The metadata pipeline — one function, several modes (Vercel Hobby allows
// 12 functions; this is the last slot, so future pipeline steps become new
// modes here rather than new files).
//
// Track-first approach: Ashreinu already stores, per audio track, a Hebrew
// outline ("long description") and sometimes a hanacha (transcript). Those
// are attached to the exact track, so there's no sicha-splitting or
// text-to-audio matching to do. Claude reads them and writes English
// metadata for that one track.
//
// Pilot / inspection (nothing saved):
// GET /api/pipeline?mode=source&id=EVENT_ID   -> the track + its outline/transcript (no AI)
// GET /api/pipeline?mode=preview&id=EVENT_ID  -> same, plus Claude's metadata
//
// Production (writes to the track_metadata table — see supabase/track_metadata.sql):
// GET /api/pipeline?mode=collect&limit=N      -> fetch outlines/hanachos for the next N tracks (no AI)
// GET /api/pipeline?mode=pending&limit=N      -> ids that are collected and waiting for Claude
// GET /api/pipeline?mode=enrich&id=EVENT_ID   -> run Claude on one collected track and save the entry
// GET /api/pipeline?mode=stats                -> progress counts and total cost so far
// GET /api/pipeline?mode=list&offset=N        -> catalogued entries, newest first (for review)
// GET /api/pipeline?mode=reindex&offset=N     -> rebuild search text from stored fields (no AI), 200 at a time

import { timingSafeEqual } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { OCCASIONS, PARSHIYOS, audienceFor, normalize, hebrewSearchForms, occasionsOn } from '../lib/vocab.js';

const ASHREINU = 'https://5qlaecnhel.execute-api.us-east-1.amazonaws.com/prod/ashreinu/api/v1';
const MODEL = 'claude-opus-5-5';

// Bump when the prompt or schema changes meaningfully; entries made with an
// older version can then be re-run ("upgrade") without touching locked ones.
const PROMPT_VERSION = 6;

// Topics come from the `topics` table (editable in Supabase), so the menu
// can change without a code change. Cached briefly between requests.
let topicCache = null, topicCacheAt = 0;
async function loadTopics(supabase) {
  if (topicCache && Date.now() - topicCacheAt < 5 * 60 * 1000) return topicCache;
  const { data, error } = await supabase.from('topics').select('slug, name_en, name_he, parent_slug, aliases, description, sort').eq('active', true).order('sort');
  if (error) throw new Error('Could not load topics (has supabase/002_topics_and_search.sql been run?): ' + error.message);
  const groups = data.filter(t => !t.parent_slug);
  const leaves = data.filter(t => t.parent_slug);
  topicCache = {
    all: data, leaves, bySlug: Object.fromEntries(data.map(t => [t.slug, t])),
    // The menu Claude sees: grouped, with what each topic covers.
    menu: groups.map(g => `${g.name_en}:\n` + leaves.filter(l => l.parent_slug === g.slug)
      .map(l => `  - ${l.slug}: ${l.name_en}${l.description ? ' (' + l.description + ')' : ''}`).join('\n')).join('\n'),
  };
  topicCacheAt = Date.now();
  return topicCache;
}

function buildSchema(topicSlugs) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title_en', 'title_he', 'summary_en', 'key_points', 'main_topic', 'other_topics', 'suggested_new_topics',
               'occasions', 'parsha', 'people', 'sources', 'phrases', 'confidence', 'confidence_reason', 'evergreen', 'evergreen_reason'],
    properties: {
      title_en: { type: 'string', description: 'Short, catchy English title, like an episode title: 2-6 words, at most ~40 characters. A title, not a sentence.' },
      title_he: { type: 'string', description: 'Short Hebrew heading (the outline\'s own heading when it has one)' },
      summary_en: { type: 'string', description: '1-3 natural sentences explaining the idea, within the word limit given' },
      key_points: { type: 'array', items: { type: 'string' }, description: 'For multi-point outlines: one plain-English bullet per main point; otherwise empty' },
      main_topic: { type: 'string', enum: topicSlugs, description: 'The ONE topic this talk is mainly about' },
      other_topics: { type: 'array', items: { type: 'string', enum: topicSlugs }, description: '0-3 more topics that are a substantial part of the talk' },
      suggested_new_topics: { type: 'array', items: { type: 'string' }, description: 'Important themes missing from the topic menu (usually empty)' },
      occasions: { type: 'array', items: { type: 'string', enum: OCCASIONS }, description: 'Occasions the talk is for or substantially about' },
      parsha: { type: 'string', enum: [...PARSHIYOS, 'none'], description: 'The weekly portion the talk discusses, or none' },
      people: { type: 'array', items: { type: 'string' }, description: 'People the talk meaningfully discusses' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Works cited, at book level' },
      phrases: { type: 'array', items: { type: 'string' }, description: 'Famous sayings the talk quotes or centres on (often empty)' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      confidence_reason: { type: 'string', description: 'One short sentence: why this confidence' },
      ...EVERGREEN_PROPS,
    },
  };
}
// How well a talk would work featured on the home page for anyone (see
// EVERGREEN_RULES). Shared by the full entry and the rating-only pass.
const EVERGREEN_PROPS = {
  evergreen: { type: 'integer', enum: [1, 2, 3, 4, 5], description: 'How well this talk works featured for any listener today (see the evergreen rules)' },
  evergreen_reason: { type: 'string', description: 'One short sentence: why this score' },
};
const EVERGREEN_RULES = `evergreen (1-5): would this talk work FEATURED on the home page, for any listener today who knows nothing about its background? Judge the talk's message, not the quality of the material.
- 5: a universal, striking message anyone can take into their life (on faith, joy, purpose, struggle, family, how to treat others, serving G-d in daily life), and it stands on its own.
- 4: a clear, broadly relevant lesson; little background needed. A talk tied to a festival or parsha can be a 4 or 5 if its lesson is universal.
- 3: interesting, but needs background, or mainly about one occasion's details or a scholarly point.
- 2: tied to a specific event, campaign, institution, group or moment in time (a particular gathering, a call to action of that year, words to one yeshiva or group).
- 1: technical, administrative or fragmentary (thanks, announcements, instructions, a brief remark, a niche halachic or textual detail).`;

const SYSTEM = `You catalogue recordings of the Lubavitcher Rebbe's talks (sichos, ma'amarim) for a searchable audio archive. The listeners are a wide crowd: many have a basic Jewish background but don't know Chassidic terminology. For ONE audio track you get the archive's own material for it: a Hebrew outline (תוכן) written in dense editorial shorthand, and/or a hanacha (a transcript written down from the talk, in Hebrew or Yiddish). Write the English catalogue entry for that track.

The core rule: use the material to understand WHAT the talk says, then say it the way a good teacher would explain it to a friend. Explain, don't translate. A literal rendering of the shorthand reads as gibberish.

Accuracy:
- Every idea in your entry must come from the material. Don't add lessons, claims, stories or conclusions that aren't there.
- You MAY briefly explain a concept so a newcomer understands it (e.g. "'bread of shame', the discomfort of receiving what you didn't earn"). Explaining a term is fine; adding content is not.
- If part of the material is unclear, leave it out rather than guess.

Title (shown in a track list, like an episode title in a podcast app):
- The goal: make someone WANT to tap, while saying truthfully what the talk teaches. Accurate and intriguing; neither alone is enough.
- How: look at the talk's MAIN teaching and find what is surprising in it: the question it answers, the paradox it resolves, the claim that goes against expectation, or an image the teaching itself is built on. Name that.
- Keep the concrete subject in the title: if the talk is about a named day, mitzvah, object or person (Tisha B'Av, the Sukkah, Chanukah lights, the Alter Rebbe), that name usually belongs in the title. It's what people recognise and search for. "Even Tisha B'Av Afternoon Has Joy", not "When Mourning Gives Way by Afternoon".
- Main teaching, not a side story: a story, proof or example brought along the way (a verse, a passage of Gemara, an episode from history) supports the teaching; it is not the title. A talk teaching that the Sukkos water-pouring means serving G-d beyond reason, proven from King David's warriors, is "Water Beyond Reason", never "David's Water from Bethlehem".
- Short: 2-6 words and never more than 40 characters. A title, not a sentence, and no "X vs. Y" constructions. Title Case. A short question is often the best title ("Why No Hallel on Purim?").
- Avoid bland templates that could fit any talk: "The Importance of…", "The Meaning of…", "The Significance of…", "Lessons from…", "Understanding…", "A Lesson in…", "The Power of…", "X and Y". Also avoid a hook with no subject ("A Wave of the Hand").
- Tone: warm, intelligent and reverent, like a great teacher's class title. Never clickbait, never a news headline.
- Plain words someone with a basic Jewish background knows (Moshiach, Shabbos, mitzvah, tzedakah, Sukkah, the Rebbe are fine). No insider terms or sayings a casual listener wouldn't know: halachic terms ("eruv", "muktzeh"), Chassidic terms ("Dira Betachtonim", "Hiskashrus"), or titles that depend on knowing a saying ("Gam Zu L'tovah" vs. "Kol D'avid"). Say the idea in plain English instead.
- If the outline has its own heading, it tells you the subject; still phrase the English title freshly. If the track covers several unrelated subjects, title the main one.
- Bland → better: "The Importance of Joy" → "Joy That Breaks Every Barrier"; "Lessons from Purim" → "Why No Hallel on Purim?"; "The Meaning of the Water Libation" → "Water Beyond Reason"; "Our Children Are Our Guarantors" → "Why G-d Took Children as Guarantors".
- Titles that work: "The Inner Six-Day War", "Why a Second Pesach?", "Bread of Shame", "Two Ways to Bring the Rain", "Spend First, Then Raise the Funds", "Entering the King's Court Uninvited".

Summary: 1-3 natural sentences (up to 4 for long multi-point outlines), within the word limit given. Start with the substance, not "In this sicha" or "The Rebbe explains that".

Key points: only for outlines with several distinct points: one plain-English bullet per main point, in order.

Worked example (a different track, to show the style):
Outline: "ביאור במאמר הצ"צ 'להבין ענין פסח שני' מבאר שפסח שני (יסוד) הוא למע' מפסח ראשון (מלכות) – לכאורה ה"ז סתירה לפשטות הענין, ולתורת אדמו"ר מוהריי"צ 'ניטאָ קיין פאַרפאַלן'; והביאור – פסח שני הוא תיקון לקרבן פסח, אבל ביחס לשאר עניני העבודה דפסח … הוא למע' מהם"
Good title: "Why the Second Pesach Is Higher"
Good summary: "The Tzemach Tzedek writes that Pesach Sheini, the make-up Pesach for those who missed the first, is in a sense higher than the original. The Rebbe asks how a make-up can be higher, and explains: as a correction for the missed offering it comes second, but in other respects it stands above the first."
Bad title: "Pesach Sheini: Yesod and Malchus" (insider terms, says nothing to most listeners).

Use standard Chabad English transliteration (Moshiach, Geulah, mitzvos, Shabbos, Rebbe, Chassidus, davening).
Classification. These power browsing and search, so consistency matters more than coverage:
- main_topic: the ONE topic from the menu below that this talk is mainly about, i.e. where a listener browsing that topic would most want to find it.
- other_topics: 0-3 more topics that are a substantial part of the talk. Not passing mentions. Never repeat main_topic.
- suggested_new_topics: only if an important theme fits no topic on the menu (a person reviews these). Usually empty.
- occasions: occasions the talk is for or substantially about. Don't add one just because of the date it was said: a talk given on Purim about something else gets no "Purim".
- parsha: the weekly Torah portion the talk discusses, or "none".
- people: at most 4 people the talk is really ABOUT or tells a story about (e.g. Avraham Avinu, Mordechai, Rashbi, the Alter Rebbe, the Previous Rebbe), in common Chabad English. Not people only quoted or cited in passing ("as the Tzemach Tzedek writes").
- sources: at most 4 works the talk actually builds on, at book level ("Tanya", "Zohar", "Rambam, Hilchos Teshuvah", "Bamidbar"). Not every citation or footnote, and not standard commentaries mentioned in passing (Rashi on a verse).
- phrases: famous sayings or expressions the talk quotes or centres on, as people remember them ("lechatchila ariber", "nahama dekisufa", "ufaratzta"). Usually empty.

confidence: high if the material clearly covers the talk; medium if brief or partial; low if very thin or unclear.

${EVERGREEN_RULES}`;

function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

// Everything Ashreinu has for one track.
async function fetchSource(id) {
  const ev = (await getJson(`${ASHREINU}/event/${id}`))?.data;
  if (!ev) throw new Error(`Event ${id} not found on Ashreinu`);
  const [outlineRes, transcriptRes] = await Promise.all([
    ev.has_long_description ? getJson(`${ASHREINU}/event/${id}/long-description`) : null,
    ev.has_transcript ? getJson(`${ASHREINU}/event/${id}/transcript`) : null,
  ]);
  const t = transcriptRes?.data && typeof transcriptRes.data === 'object' ? transcriptRes.data : null;
  const date = ev.dates?.[0] || {};
  return {
    id: ev.id,
    name: ev.name,
    type: ev.type,
    parent_name: ev.parent?.name || null,
    hebrew_date: date.hebrew_day ? `${date.hebrew_day} ${date.hebrew_month_name} ${date.hebrew_year}` : null,
    date_occasions: occasionsOn(date.hebrew_month, date.hebrew_day),
    duration_ms: ev.audio_recordings_duration || null,
    description: /nigun/i.test(ev.type || '') ? '' : (ev.description || '').trim(),
    outline: htmlToText(outlineRes?.data),
    transcript: htmlToText(t?.content),
    transcript_kind: t?.type || null, // e.g. "Hanacha (Lahak)", "Yiddish Hanacha (Notik)"
  };
}

// How long the entry may be, derived from the source: a one-line outline
// gets a one-sentence summary. Points are numbered "1)" or lettered "א.".
function lengthBudget(src) {
  // Hanacha only (no outline): keep it short too. A full transcript has far
  // more detail than a listener needs; the summary gives the idea, and only
  // a long talk with clearly separate parts gets a few bullets.
  if (!src.outline) {
    const len = (src.transcript || '').length;
    return len < 2500 ? { summaryWords: 35, points: 0 } : len < 8000 ? { summaryWords: 45, points: 0 } : { summaryWords: 55, points: 3 };
  }
  const words = src.outline.split(/\s+/).filter(Boolean).length;
  const points = (src.outline.match(/(?:^|\s)\d{1,2}\)|(?:^|\n)\s*[א-ת]{1,2}\.\s/g) || []).length;
  return { summaryWords: Math.max(25, Math.min(75, Math.round(words * 0.8))), points: Math.min(points, 6) };
}

// Many outlines open with the editors' own heading, e.g.
// "ד. אדמו"ר מהר"ש: 'לכתחילה אַריבער'" — an expert-written title. Only
// used for single-point outlines: in a multi-point outline the first
// heading covers just point 1, not the whole track. A one-word heading is
// usually a structural label like "סיום" (conclusion), not a subject.
function outlineHeading(outline, points) {
  if (points > 1) return null;
  const first = (outline || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  let heading = first;
  while (/^(?:[א-ת]{1,2}\.|\d{1,2}\))\s*/.test(heading)) heading = heading.replace(/^(?:[א-ת]{1,2}\.|\d{1,2}\))\s*/, '');
  heading = heading.replace(/[.:;,\s]+$/, '').replace(/\s*\([^)]*\)$/, '').replace(/[.:;,\s]+$/, '').trim();
  const words = heading.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 12) return null;
  return heading;
}

// Code-side checks on Claude's answer, shown on the pilot page.
function checkEntry(m, budget) {
  const warnings = [];
  const titleWords = m.title_en.trim().split(/\s+/).length;
  if (m.title_en.length > 45 || titleWords > 7) warnings.push(`Title is long (${titleWords} words, ${m.title_en.length} chars)`);
  if (BLAND_TITLE.test(m.title_en.trim())) warnings.push('Title uses a bland template');
  const sumWords = m.summary_en.trim().split(/\s+/).length;
  if (sumWords > budget.summaryWords * 1.25) warnings.push(`Summary is ${sumWords} words (limit ${budget.summaryWords})`);
  if (budget.points <= 1 && m.key_points.length > 1) warnings.push(`${m.key_points.length} key points for a one-point outline`);
  return warnings;
}

// What Claude reads about a track: its facts and Ashreinu's own text.
function buildMaterial(src, budget, heading) {
  return [
    `Track: ${src.name} (${src.type})`,
    src.parent_name ? `Part of: ${src.parent_name}` : null,
    src.hebrew_date ? `Date: ${src.hebrew_date}` : null,
    src.date_occasions?.length ? `This date falls on: ${src.date_occasions.join(', ')}. If the talk discusses that occasion or its themes at all, include it in occasions.` : null,
    src.duration_ms ? `Length: ${Math.round(src.duration_ms / 60000)} minutes` : null,
    src.description ? `The archive editors' own one-line English description of this track (human-written and reliable; use it to anchor the subject, but still follow the title rules): «${src.description}»` : null,
    src.outline ? `\n<outline>\n${src.outline}\n</outline>` : null,
    src.transcript ? `\n<hanacha kind="${src.transcript_kind || 'unknown'}">\n${src.transcript}\n</hanacha>` : null,
    heading ? `\nThe outline's own heading (written by the archive's editors): «${heading}». Use it as title_he (verbatim or lightly shortened). It tells you the subject; phrase title_en naturally, not as a literal translation.` : null,
    `\nLength limits for this track: summary at most ${budget.summaryWords} words; ` +
      (budget.points > 1 ? `at most ${budget.points} key points (one per main part of the talk).` : 'no key points.'),
  ].filter(Boolean).join('\n');
}
// When a person rejected the last entry: show it, with their note, so the
// new attempt changes course instead of repeating itself.
function feedbackBlock(rejected, note) {
  return `\n<rejected_entry>\nTitle: ${rejected.title_en || ''}\nSummary: ${rejected.summary_en || ''}\n</rejected_entry>\n`
    + `The editor read this entry and rejected it. Their note: «${note}». Write a new entry that fixes what they point out. `
    + `The new title must be clearly different from the rejected one, not a rewording of it.`;
}

async function enrich(src, topics) {
  const budget = lengthBudget(src);
  const heading = outlineHeading(src.outline, budget.points);
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const material = buildMaterial(src, budget, heading) + (src.feedback ? feedbackBlock(src.feedback.rejected, src.feedback.note) : '');

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 6000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // if a safety filter wrongly declines, Anthropic re-runs it on a fallback model
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: buildSchema(topics.leaves.map(t => t.slug)) } },
    system: SYSTEM + '\n\nTopic menu (use the slug before the colon):\n' + topics.menu,
    messages: [{ role: 'user', content: material }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined this track (refusal)');
  if (response.stop_reason === 'max_tokens') throw new Error('Response was cut off (max_tokens)');
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('No text in Claude response');
  const u = response.usage || {};
  const metadata = JSON.parse(text);
  // Clean-up in code: short, unique entries; other_topics never repeats main.
  const tidy = (list, maxWords) => {
    const seen = new Set();
    return (list || []).map(x => String(x).trim()).filter(x => {
      const key = x.toLowerCase();
      if (!x || x.split(/\s+/).length > maxWords || seen.has(key)) return false;
      seen.add(key); return true;
    });
  };
  metadata.other_topics = tidy(metadata.other_topics, 9).filter(t => t !== metadata.main_topic).slice(0, 3);
  metadata.people = tidy(metadata.people, 5);
  metadata.sources = tidy(metadata.sources, 6);
  metadata.phrases = tidy(metadata.phrases, 6);
  metadata.occasions = tidy(metadata.occasions, 9);
  if (metadata.parsha === 'none') metadata.parsha = null;
  return {
    metadata,
    budget,
    heading,
    warnings: checkEntry(metadata, budget),
    model: response.model,
    usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens },
  };
}

// ── Storage (Supabase) ──
function supa() { return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY); }

// PostgREST returns at most 1000 rows per request, whatever .limit() says,
// so anything that needs "all" rows pages through with .range().
async function allRows(buildQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await buildQuery().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// Tracks worth cataloguing: real audio, not a whole-farbrengen container or
// a niggun, and Ashreinu has an outline or a transcript for it.
function candidateQuery(supabase, columns, opts) {
  return supabase.from('ashreinu_events').select(columns, opts)
    .not('audio_uri', 'is', null)
    .neq('type', 'Farbrengen')
    .not('type', 'ilike', '%nigun%')
    .or('has_transcript.is.true,raw_data->>has_long_description.eq.true');
}

// Search text in four weighted layers (see supabase/002_topics_and_search.sql):
// A titles + phrases, B classification (topic names + aliases, occasions,
// parsha, people, sources, audience), C summary + key points, D outline.
// description: Ashreinu's own English line for the track. Its "Title:" part
// counts like a title (layer A), the whole line like a summary (layer C), so
// searching Ashreinu's wording finds the talk even after Claude retitled it.
function buildSearchLayers(m, outline, topics, audience, description) {
  const topicWords = [m.main_topic, ...m.other_topics].map(slug => topics.bySlug[slug])
    .filter(Boolean).flatMap(t => [t.name_en, t.name_he, ...(t.aliases || [])]);
  const d = String(description || '').trim();
  const head = (d.match(/^([^:]{3,45}):\s*\S/) || [])[1] || '';
  const layers = {
    search_a: normalize([m.title_en, m.title_he, head, ...m.phrases].join(' \n ')),
    search_b: normalize([...topicWords, ...m.occasions, m.parsha, ...m.people, ...m.sources, ...audience].filter(Boolean).join(' \n ')),
    search_c: normalize([m.summary_en, ...m.key_points, d].join(' \n ')),
    search_d: hebrewSearchForms(normalize(outline || '')),
  };
  // search_text (all layers in one) is kept for simple substring search.
  return { ...layers, search_text: [layers.search_a, layers.search_b, layers.search_c, layers.search_d].join(' \n ') };
}

async function collectNext(supabase, limit) {
  const [candidates, done] = await Promise.all([
    allRows(() => candidateQuery(supabase, 'id').order('id')),
    allRows(() => supabase.from('track_metadata').select('ashreinu_event_id')),
  ]);
  const doneIds = new Set(done.map(r => r.ashreinu_event_id));
  const next = candidates.map(r => r.id).filter(id => !doneIds.has(id)).slice(0, limit);

  // Four at a time — gentle on Ashreinu's API, and fits in Vercel's 60s.
  const results = [];
  const queue = [...next];
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const src = await fetchSource(id);
        const hasSource = !!(src.outline || src.transcript);
        results.push({ ashreinu_event_id: id, outline_he: src.outline || null, transcript: src.transcript || null,
          transcript_kind: src.transcript_kind, status: hasSource ? 'collected' : 'no_source', updated_at: new Date().toISOString() });
      } catch (e) {
        results.push({ ashreinu_event_id: id, status: 'error', error: 'collect: ' + e.message, updated_at: new Date().toISOString() });
      }
    }
  }));
  if (results.length) {
    const { error } = await supabase.from('track_metadata').upsert(results, { onConflict: 'ashreinu_event_id' });
    if (error) throw new Error(error.message);
  }
  return {
    collected: results.filter(r => r.status === 'collected').length,
    no_source: results.filter(r => r.status === 'no_source').length,
    errors: results.filter(r => r.status === 'error').length,
    remaining: candidates.length - doneIds.size - results.length,
  };
}

async function enrichStored(supabase, id, note) {
  const [{ data: tm, error: e1 }, { data: ev, error: e2 }] = await Promise.all([
    supabase.from('track_metadata').select('*').eq('ashreinu_event_id', id).maybeSingle(),
    supabase.from('ashreinu_events').select('id, name, type, parent_name, hebrew_day, hebrew_month, hebrew_month_name, hebrew_year, duration_ms, description:raw_data->>description').eq('id', id).maybeSingle(),
  ]);
  if (e1 || e2) throw new Error((e1 || e2).message);
  if (!tm) throw new Error(`Track ${id} hasn't been collected yet`);
  if (tm.status === 'skipped') throw new Error(`Track ${id} was fixed by hand as not a talk (Fix a track); remove that fix first`);
  // Batch runs leave locked entries alone; a redo a person asks for with a
  // note is deliberate, so it may replace one.
  if (tm.locked && !note) return { id, skipped: 'locked (edited by a person), so re-runs leave it alone' };
  const topics = await loadTopics(supabase);
  const audience = audienceFor(ev?.name, ev?.type);
  const src = {
    id, name: ev?.name, type: ev?.type, parent_name: ev?.parent_name,
    hebrew_date: ev?.hebrew_day ? `${ev.hebrew_day} ${ev.hebrew_month_name} ${ev.hebrew_year}` : null,
    date_occasions: occasionsOn(ev?.hebrew_month, ev?.hebrew_day),
    duration_ms: ev?.duration_ms, outline: tm.outline_he || '', transcript: tm.transcript || '', transcript_kind: tm.transcript_kind,
    description: /nigun/i.test(ev?.type || '') ? '' : (ev?.description || '').trim(),
    feedback: note && tm.status === 'enriched' ? { rejected: { title_en: tm.title_en, summary_en: tm.summary_en }, note } : null,
  };
  try {
    const r = await enrich(src, topics);
    const m = r.metadata;
    const row = {
      status: 'enriched', error: null, prompt_version: PROMPT_VERSION, locked: false,
      title_en: m.title_en, title_he: m.title_he, summary_en: m.summary_en, key_points: m.key_points,
      main_topic: m.main_topic, topics: m.other_topics, suggested_new_topics: m.suggested_new_topics,
      occasions: m.occasions, parsha: m.parsha, people: m.people, sources: m.sources, phrases: m.phrases,
      audience, keywords: [], confidence: m.confidence, confidence_reason: m.confidence_reason,
      evergreen: m.evergreen ?? null, evergreen_reason: m.evergreen_reason || null,
      ...buildSearchLayers(m, tm.outline_he, topics, audience, src.description), model: r.model,
      input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens,
      enriched_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    let { error } = await supabase.from('track_metadata').update(row).eq('ashreinu_event_id', id);
    // Before supabase/004_featured.sql is run there are no evergreen columns.
    if (error && /evergreen/.test(error.message)) {
      delete row.evergreen; delete row.evergreen_reason;
      ({ error } = await supabase.from('track_metadata').update(row).eq('ashreinu_event_id', id));
    }
    if (error) throw new Error(error.message);
    return { id, saved: true, metadata: m, previous_title: tm.status === 'enriched' ? tm.title_en : null, audience, warnings: r.warnings, usage: r.usage };
  } catch (e) {
    // A failed redo must not take a good entry out of the app.
    if (tm.status !== 'enriched') await supabase.from('track_metadata').update({ status: 'error', error: 'enrich: ' + e.message, updated_at: new Date().toISOString() }).eq('ashreinu_event_id', id);
    throw e;
  }
}

// Five alternative titles for one track, for a person to choose from. Uses
// the same title rules; the current title (and the person's note) are shown
// so the options go somewhere new. Nothing is saved.
// Titles alone are cheap: Claude reads the track's facts, its outline (or the
// opening of its hanacha) and the entry's own summary and key points, not the
// whole transcript, with only the title rules and less thinking time. About a
// fifth of the cost of a full entry.
const TITLE_SYSTEM = SYSTEM.slice(0, SYSTEM.indexOf('\nSummary:'));
async function writeTitles(supabase, id, note, count) {
  const [{ data: tm, error: e1 }, { data: ev, error: e2 }] = await Promise.all([
    supabase.from('track_metadata').select('*').eq('ashreinu_event_id', id).maybeSingle(),
    supabase.from('ashreinu_events').select('id, name, type, parent_name, hebrew_day, hebrew_month, hebrew_month_name, hebrew_year').eq('id', id).maybeSingle(),
  ]);
  if (e1 || e2) throw new Error((e1 || e2).message);
  if (!tm) throw new Error(`Track ${id} hasn't been collected yet`);
  if (tm.status === 'skipped') throw new Error(`Track ${id} was fixed by hand as not a talk (Fix a track); remove that fix first`);
  const occ = occasionsOn(ev?.hebrew_month, ev?.hebrew_day);
  const material = [
    `Track: ${ev?.name} (${ev?.type})`,
    ev?.parent_name ? `Part of: ${ev.parent_name}` : null,
    ev?.hebrew_day ? `Date: ${ev.hebrew_day} ${ev.hebrew_month_name} ${ev.hebrew_year}` + (occ.length ? ` (${occ.join(', ')})` : '') : null,
    tm.outline_he ? `\n<outline>\n${tm.outline_he}\n</outline>` : tm.transcript ? `\n<hanacha_opening>\n${tm.transcript.slice(0, 1500)}\n</hanacha_opening>` : null,
    tm.summary_en ? `\n<what_the_talk_teaches>\n${tm.summary_en}${(tm.key_points || []).length ? '\n- ' + tm.key_points.join('\n- ') : ''}\n</what_the_talk_teaches>` : null,
    `\nTASK: write ${count === 1 ? 'your best 3 English titles for this talk, best first' : count + ' alternative English titles for this talk'}, following the title rules.`
      + (count > 1 ? ' Make them genuinely different from each other (different angles on the main teaching, a question, a short phrase), not rewordings.' : '')
      + (count === 1
          ? (tm.title_en ? ` The current title is «${tm.title_en}». If it already does the job well (clear subject, plain words, short, makes you want to listen), you may keep it: return it as one of the three.` : '')
          : (tm.title_en ? ` The current title is «${tm.title_en}»; don't repeat or merely reword it.` : ''))
      + (note ? ` The editor's note on what they want: «${note}».` : ''),
  ].filter(Boolean).join('\n');
  const response = await new Anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: {
      type: 'object', additionalProperties: false, required: ['titles'],
      properties: { titles: { type: 'array', items: { type: 'string' }, description: count === 1 ? 'Exactly 3 titles, best first' : `Exactly ${count} alternative titles` } },
    } } },
    system: TITLE_SYSTEM,
    messages: [{ role: 'user', content: material }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined this track (refusal)');
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('No text in Claude response');
  const titles = [...new Set(JSON.parse(text).titles.map(t => String(t).trim()).filter(Boolean))].slice(0, count === 1 ? 3 : count + 1);
  const u = response.usage || {};
  const cost = +((u.input_tokens || 0) / 1e6 * PRICE_IN + (u.output_tokens || 0) / 1e6 * PRICE_OUT).toFixed(4);
  return { tm, titles, usage: u, cost };
}
// The firm rules, checked in code rather than trusted to the prompt.
const BLAND_TITLE = /^(the (importance|meaning|significance|power) of|lessons? (from|in|of)|understanding|a lesson in)\b/i;
function titlePasses(t) {
  t = String(t || '').trim();
  return t.length > 0 && t.length <= 42 && t.split(/\s+/).length <= 7 && !BLAND_TITLE.test(t) && !/\bvs\.?\s/i.test(t);
}
// Five options for a person to choose from. Nothing is saved.
async function suggestTitles(supabase, id, note) {
  const r = await writeTitles(supabase, id, note, 5);
  const good = r.titles.filter(titlePasses);
  return { id, current: r.tm.title_en, titles: good.length ? good : r.titles, usage: r.usage, cost: r.cost };
}
// Replace just the title (summary, topics etc. stay). Skips entries a person
// locked unless they asked with a note.
// Rating only (for entries made before ratings existed): how well the talk
// works featured on the home page. Reads just the entry, so it costs well
// under a cent.
const NO_FEATURE_COLUMNS = 'The featuring columns are missing: run supabase/004_featured.sql in Supabase first';
async function rateEvergreen(supabase, id) {
  const { data: tm, error: e1 } = await supabase.from('track_metadata')
    .select('status, title_en, summary_en, key_points, occasions, outline_he').eq('ashreinu_event_id', id).maybeSingle();
  if (e1) throw new Error(e1.message);
  if (tm?.status !== 'enriched') throw new Error(`Track ${id} isn't catalogued yet`);
  const material = [
    `Title: ${tm.title_en}`,
    `Summary: ${tm.summary_en}`,
    (tm.key_points || []).length ? 'Key points:\n- ' + tm.key_points.join('\n- ') : null,
    (tm.occasions || []).length ? `Occasions: ${tm.occasions.join(', ')}` : null,
    tm.outline_he ? `\n<outline>\n${tm.outline_he.slice(0, 1500)}\n</outline>` : null,
    '\nTASK: rate this talk for featuring, following the evergreen rules.',
  ].filter(Boolean).join('\n');
  const response = await new Anthropic().beta.messages.create({
    model: MODEL, max_tokens: 300,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: {
      type: 'object', additionalProperties: false, required: ['evergreen', 'evergreen_reason'], properties: EVERGREEN_PROPS,
    } } },
    system: `You help curate an archive of the Lubavitcher Rebbe's recorded talks for a wide audience.\n\n${EVERGREEN_RULES}`,
    messages: [{ role: 'user', content: material }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude declined this track (refusal)');
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('No text in Claude response');
  const r = JSON.parse(text);
  const { error } = await supabase.from('track_metadata').update({ evergreen: r.evergreen, evergreen_reason: r.evergreen_reason }).eq('ashreinu_event_id', id);
  if (error) throw new Error(/evergreen/.test(error.message) ? NO_FEATURE_COLUMNS : error.message);
  const u = response.usage || {};
  const cost = +((u.input_tokens || 0) / 1e6 * PRICE_IN + (u.output_tokens || 0) / 1e6 * PRICE_OUT).toFixed(4);
  return { id, evergreen: r.evergreen, reason: r.evergreen_reason, title: tm.title_en, cost };
}
// A person's call: 'yes' always may be featured, 'no' never, 'auto' = the rating decides.
async function setFeatured(supabase, id, value) {
  const featured = value === 'yes' ? true : value === 'no' ? false : null;
  const { error } = await supabase.from('track_metadata').update({ featured }).eq('ashreinu_event_id', id).eq('status', 'enriched');
  if (error) throw new Error(/featured/.test(error.message) ? NO_FEATURE_COLUMNS : error.message);
  return { id, featured };
}

async function retitle(supabase, id, note) {
  const { data: lock } = await supabase.from('track_metadata').select('locked, status').eq('ashreinu_event_id', id).maybeSingle();
  if (!lock || lock.status !== 'enriched') throw new Error(`Track ${id} isn't catalogued yet`);
  if (lock.locked && !note) return { id, skipped: 'locked (edited by a person), so re-runs leave it alone' };
  const r = await writeTitles(supabase, id, note, 1);
  // The first of Claude's three that passes the firm rules (short, not a
  // bland template); if none does, keep the current title.
  const title = r.titles.find(titlePasses) || r.tm.title_en;
  if (!title) throw new Error('No title came back');
  if (title === r.tm.title_en) return { id, saved: true, kept: true, title, previous_title: r.tm.title_en, cost: r.cost };
  const { error } = await supabase.from('track_metadata').update({ title_en: title, locked: false, updated_at: new Date().toISOString() }).eq('ashreinu_event_id', id);
  if (error) throw new Error(error.message);
  const { data: row } = await supabase.from('track_metadata')
    .select('ashreinu_event_id, title_en, title_he, summary_en, key_points, main_topic, topics, occasions, parsha, people, sources, phrases, audience, outline_he')
    .eq('ashreinu_event_id', id).maybeSingle();
  if (row) await reindexRow(supabase, await loadTopics(supabase), row);
  return { id, saved: true, title, previous_title: r.tm.title_en, cost: r.cost };
}

// Save a title a person chose (or typed), lock the entry so batch runs keep
// it, and refresh its search words.
async function setTitle(supabase, id, title) {
  title = String(title || '').trim().slice(0, 90);
  if (!title) throw new Error('Empty title');
  const { error } = await supabase.from('track_metadata').update({ title_en: title, locked: true, updated_at: new Date().toISOString() })
    .eq('ashreinu_event_id', id).eq('status', 'enriched');
  if (error) throw new Error(error.message);
  const { data: r, error: e2 } = await supabase.from('track_metadata')
    .select('ashreinu_event_id, title_en, title_he, summary_en, key_points, main_topic, topics, occasions, parsha, people, sources, phrases, audience, outline_he')
    .eq('ashreinu_event_id', id).maybeSingle();
  if (e2 || !r) throw new Error(e2?.message || 'Entry not found');
  await reindexRow(supabase, await loadTopics(supabase), r);
  return { id, saved: true, title, locked: true };
}

// "Fix a track": a person's own correction, saved in track_fixes (see
// supabase/003_track_fixes.sql). No AI. A track marked as a niggun, not a talk
// or a duplicate also leaves the catalogue: its track_metadata row (if any) is set to
// 'skipped', so Claude never writes a talk entry for it and an entry already
// written stops showing. Removing the fix undoes both.
const NO_FIX_TABLE = 'The track_fixes table is missing or out of date: run supabase/003_track_fixes.sql in Supabase (again)';
const fixTableError = (e) => /track_fixes|same_as/.test(e.message) && /does not exist|schema cache|could not find|check constraint/i.test(e.message) ? NO_FIX_TABLE : e.message;
async function getFix(supabase, id) {
  const [{ data: ev, error: e1 }, { data: fix, error }, { data: tm }] = await Promise.all([
    supabase.from('ashreinu_events').select('id, name, type, parent_name, hebrew_day, hebrew_month_name, hebrew_year, duration_ms, description:raw_data->>description').eq('id', id).maybeSingle(),
    supabase.from('track_fixes').select('*').eq('ashreinu_event_id', id).maybeSingle(),
    supabase.from('track_metadata').select('status, title_en, outline_he, transcript, transcript_kind').eq('ashreinu_event_id', id).maybeSingle(),
  ]);
  if (e1) throw new Error(e1.message);
  if (error) throw new Error(fixTableError(error));
  if (!ev) throw new Error(`No track #${id} in the archive`);
  return { id, track: ev, fix: fix || null, catalogue: tm ? { status: tm.status, title: tm.title_en,
    outline: (tm.outline_he || '').slice(0, 300), outline_chars: (tm.outline_he || '').length,
    text: (tm.transcript || '').slice(0, 300), text_chars: (tm.transcript || '').length, text_kind: tm.transcript_kind } : null };
}
// Give a track its source text by hand: Ashreinu's outline/hanacha copied
// from another track (when Ashreinu attached it to the wrong one), and/or
// text pasted in (e.g. the edited sicha from Likkutei Sichos). Free; then
// "Catalogue" runs Claude on it as usual.
async function setText(supabase, id, body) {
  const from = parseInt(body.from, 10) || null;
  const text = String(body.text || '').trim().slice(0, 60000);
  const kind = String(body.kind || '').trim().slice(0, 120) || 'Pasted text';
  if (!from && !text) throw new Error('Give a track number to copy from, or paste some text');
  if (from === id) throw new Error("Can't copy a track's text onto itself");
  const [{ data: ev }, { data: tm }] = await Promise.all([
    supabase.from('ashreinu_events').select('id, audio_uri').eq('id', id).maybeSingle(),
    supabase.from('track_metadata').select('status, outline_he, transcript, transcript_kind').eq('ashreinu_event_id', id).maybeSingle(),
  ]);
  if (!ev?.audio_uri) throw new Error(`Track #${id} isn't a recording in the archive`);
  if (tm?.status === 'skipped') throw new Error(`Track #${id} is fixed as not a talk; remove that fix first`);
  const row = { outline_he: tm?.outline_he || null, transcript: tm?.transcript || null, transcript_kind: tm?.transcript_kind || null };
  if (from) {
    const { data: src } = await supabase.from('track_metadata').select('outline_he, transcript, transcript_kind').eq('ashreinu_event_id', from).maybeSingle();
    if (!src || (!src.outline_he && !src.transcript)) throw new Error(`Track #${from} has no outline or hanacha to copy`);
    if (src.outline_he) row.outline_he = src.outline_he;
    if (src.transcript) { row.transcript = src.transcript; row.transcript_kind = src.transcript_kind; }
  }
  if (text) { row.transcript = text; row.transcript_kind = kind; }
  // A new source means the entry should be (re)written: it waits for Claude.
  const now = new Date().toISOString();
  const { error } = tm
    ? await supabase.from('track_metadata').update({ ...row, ...(tm.status === 'enriched' ? {} : { status: 'collected', error: null }), updated_at: now }).eq('ashreinu_event_id', id)
    : await supabase.from('track_metadata').insert({ ashreinu_event_id: id, ...row, status: 'collected', updated_at: now });
  if (error) throw new Error(error.message);
  return { id, saved: true, outline_chars: (row.outline_he || '').length, text_chars: (row.transcript || '').length, text_kind: row.transcript_kind, already_catalogued: tm?.status === 'enriched' };
}
// Put back a catalogue entry a fix had taken out (or, if Claude never wrote
// one, let the track be catalogued like any other).
async function unskip(supabase, id, tm) {
  if (tm?.status !== 'skipped') return;
  if (tm.title_en) await supabase.from('track_metadata').update({ status: 'enriched', error: null }).eq('ashreinu_event_id', id);
  else await supabase.from('track_metadata').delete().eq('ashreinu_event_id', id);
}
async function setFix(supabase, id, kind, title, note, sameAs) {
  title = String(title || '').trim().slice(0, 90);
  note = String(note || '').trim().slice(0, 300);
  const { data: tm } = await supabase.from('track_metadata').select('status, title_en').eq('ashreinu_event_id', id).maybeSingle();
  if (kind === 'remove') {
    const { error } = await supabase.from('track_fixes').delete().eq('ashreinu_event_id', id);
    if (error) throw new Error(fixTableError(error));
    await unskip(supabase, id, tm);
    return { id, removed: true };
  }
  if (!['niggun', 'not_a_talk', 'title', 'duplicate'].includes(kind)) throw new Error('Unknown kind of fix');
  let same = null;
  if (kind === 'duplicate') {
    same = parseInt(String(sameAs || '').replace(/[^0-9]/g, ''), 10);
    if (!same) throw new Error('Type the number of the track it duplicates');
    if (same === id) throw new Error("A track can't duplicate itself");
    const { data: orig } = await supabase.from('ashreinu_events').select('id, audio_uri').eq('id', same).maybeSingle();
    if (!orig?.audio_uri) throw new Error(`Track #${same} isn't a recording in the archive`);
    title = '';
  }
  if (kind !== 'not_a_talk' && kind !== 'duplicate' && !title) throw new Error(kind === 'niggun' ? "Type the niggun's name" : 'Type the title');
  const { error } = await supabase.from('track_fixes').upsert({ ashreinu_event_id: id, kind, title: title || null, same_as: same, note: note || null, updated_at: new Date().toISOString() });
  if (error) throw new Error(fixTableError(error));
  if (kind === 'title') await unskip(supabase, id, tm); // only the title was wrong: it's still a talk
  else {
    const why = 'Fixed by hand: ' + (kind === 'niggun' ? 'a niggun' : kind === 'duplicate' ? 'duplicate of #' + same : 'not a talk');
    const { error: e2 } = tm
      ? await supabase.from('track_metadata').update({ status: 'skipped', error: why }).eq('ashreinu_event_id', id)
      : await supabase.from('track_metadata').insert({ ashreinu_event_id: id, status: 'skipped', error: why });
    if (e2) throw new Error(e2.message);
  }
  return { id, saved: true, kind, title: title || null, same_as: same, took_out_of_catalogue: kind !== 'title' && tm?.status === 'enriched' };
}

// ── JEM's curated playlists (supabase/005_playlists.sql) ──
// Step 1 saves the list; step 2 runs once per playlist (each fits in one
// request): its clips, their written texts, and which of our tracks holds
// each clip's recording. Free, no AI; re-running refreshes everything.
const NO_PLAYLIST_TABLES = 'The playlist tables are missing: run supabase/005_playlists.sql in Supabase first';
const playlistError = (e) => /playlist/.test(e.message) && /does not exist|schema cache|could not find/i.test(e.message) ? NO_PLAYLIST_TABLES : e.message;
const picOf = (urls) => urls?.['300px'] || urls?.['900px'] || null;
async function importPlaylistList(supabase) {
  const list = (await getJson(`${ASHREINU}/playlists`))?.data;
  if (!Array.isArray(list)) throw new Error("Couldn't read Ashreinu's playlists");
  const rows = list.map((p, i) => ({ id: p.id, name: p.name, hebrew_name: p.hebrew_name || null, description: p.description || null,
    taxonomy: p.taxonomy, published: p.published !== false, sort: i, updated_at: new Date().toISOString() }));
  const { error } = await supabase.from('playlists').upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(playlistError(error));
  // Playlists Ashreinu no longer has are removed (their clips go with them).
  const { data: ours } = await supabase.from('playlists').select('id');
  const gone = (ours || []).map(r => r.id).filter(id => !rows.some(r => r.id === id));
  if (gone.length) await supabase.from('playlists').delete().in('id', gone);
  return { ids: rows.filter(r => r.published).map(r => r.id), removed: gone.length };
}
// A playlist's time of year, read from its clips' dates: when at least 70%
// of its dated clips (and at least 3) fall within one month-long stretch of
// the calendar, whatever the year, it belongs to that time ("Unity in
// Separation": all from the end of Nissan). Returns [month, day] of the
// stretch's middle, or null for a playlist of no particular season.
function playlistSeason(dates) {
  if (dates.length < 3) return null;
  const ord = ([m, d]) => (m - 1) * 30 + d; // Ashreinu numbers months 1-13 from Tishrei
  const days = dates.map(ord).sort((a, b) => a - b), YEAR = 390;
  let best = null;
  for (const start of days) {
    const inside = days.filter(x => ((x - start) % YEAR + YEAR) % YEAR <= 30);
    if (!best || inside.length > best.inside.length) best = { start, inside };
  }
  if (best.inside.length / days.length < 0.7) return null;
  const mid = best.inside[Math.floor(best.inside.length / 2)];
  return [Math.floor((mid - 1) / 30) + 1, ((mid - 1) % 30) + 1];
}
async function importPlaylist(supabase, id) {
  const p = (await getJson(`${ASHREINU}/playlist/${id}`))?.data;
  if (!p) throw new Error(`Ashreinu has no playlist ${id}`);
  const clips = p.clips || [];
  // Written texts, four at a time.
  const docs = {};
  const queue = clips.filter(c => c.has_document).map(c => c.id);
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (queue.length) {
      const cid = queue.shift();
      const d = (await getJson(`${ASHREINU}/clip/${cid}/document`))?.data;
      if (d) docs[cid] = htmlToText(d);
    }
  }));
  // Our track for each recording, matched by its audio file.
  const uris = [...new Set(clips.map(c => c.audio_recording?.assets?.[0]?.uri).filter(Boolean))];
  const eventOf = {}, dateOf = {};
  for (let i = 0; i < uris.length; i += 100) {
    const { data } = await supabase.from('ashreinu_events').select('id, audio_uri, hebrew_month, hebrew_day').in('audio_uri', uris.slice(i, i + 100));
    for (const e of data || []) { eventOf[e.audio_uri] = e.id; if (e.hebrew_month && e.hebrew_day) dateOf[e.audio_uri] = [e.hebrew_month, e.hebrew_day]; }
  }
  const rows = clips.map((c, i) => {
    const rec = c.audio_recording || {}, uri = rec.assets?.[0]?.uri || null;
    const start = c.start_time || 0, end = c.end_time || rec.duration || null;
    return { playlist_id: id, position: i, clip_id: c.id, name: c.title || c.name || rec.name || null, description: c.description || null,
      recording_id: rec.id || null, audio_uri: uri, start_ms: start, end_ms: end, picture: picOf(c.picture_urls),
      event_id: uri ? eventOf[uri] || null : null, document: docs[c.id] || null };
  });
  const del = await supabase.from('playlist_clips').delete().eq('playlist_id', id);
  if (del.error) throw new Error(playlistError(del.error));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('playlist_clips').insert(rows.slice(i, i + 200));
    if (error) throw new Error(playlistError(error));
  }
  const { id: _i, name: _n, description: _d, taxonomy: _t, hebrew_name: _h, published: _p, clips: _c, ...extra } = p;
  const season = playlistSeason(rows.map(r => dateOf[r.audio_uri]).filter(Boolean));
  if (season) extra.season = season;
  const total = rows.reduce((a, r) => a + Math.max(0, (r.end_ms || 0) - (r.start_ms || 0)), 0);
  const { error } = await supabase.from('playlists').update({
    clip_count: rows.length, total_ms: total, extra: Object.keys(extra).length ? extra : null, updated_at: new Date().toISOString(),
    picture: picOf(p.background_picture_urls) || rows.find(r => r.picture)?.picture || null,
  }).eq('id', id);
  if (error) throw new Error(playlistError(error));
  return { id, name: p.name, clips: rows.length, matched: rows.filter(r => r.event_id).length, documents: Object.keys(docs).length };
}

// Rebuild the search layers from what's stored now: after a person edits an
// entry in the table editor, or a topic's names/aliases change. No AI.
async function reindex(supabase, offset) {
  const topics = await loadTopics(supabase);
  const { data, error } = await supabase.from('track_metadata')
    .select('ashreinu_event_id, title_en, title_he, summary_en, key_points, main_topic, topics, occasions, parsha, people, sources, phrases, audience, outline_he')
    .eq('status', 'enriched').order('ashreinu_event_id').range(offset, offset + 199);
  if (error) throw new Error(error.message);
  const desc = await descriptionsFor(supabase, data.map(r => r.ashreinu_event_id));
  for (const r of data) await reindexRow(supabase, topics, { ...r, description: desc[r.ashreinu_event_id] || '' });
  return { reindexed: data.length, next_offset: data.length === 200 ? offset + 200 : null };
}
// Ashreinu's English description of each track (none for niggunim, where it
// lists the niggunim's names instead).
async function descriptionsFor(supabase, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase.from('ashreinu_events').select('id, type, description:raw_data->>description').in('id', ids.slice(i, i + 200));
    for (const e of data || []) if (!/nigun/i.test(e.type || '') && e.description) out[e.id] = e.description.trim();
  }
  return out;
}
async function reindexRow(supabase, topics, r) {
  const m = { ...r, key_points: r.key_points || [], other_topics: r.topics || [], occasions: r.occasions || [],
              people: r.people || [], sources: r.sources || [], phrases: r.phrases || [] };
  const description = r.description ?? (await descriptionsFor(supabase, [r.ashreinu_event_id]))[r.ashreinu_event_id];
  const { error } = await supabase.from('track_metadata')
    .update({ ...buildSearchLayers(m, r.outline_he, topics, r.audience || [], description), updated_at: new Date().toISOString() })
    .eq('ashreinu_event_id', r.ashreinu_event_id);
  if (error) throw new Error(error.message);
}

// Opus 5.5 pricing ($ per million tokens), for the running cost estimate.
const PRICE_IN = 4, PRICE_OUT = 20;
async function stats(supabase) {
  const count = async (q) => { const { count, error } = await q; if (error) throw new Error(error.message); return count; };
  const statuses = ['collected', 'enriched', 'no_source', 'error', 'skipped'];
  const [candidates, ...byStatus] = await Promise.all([
    count(candidateQuery(supabase, 'id', { count: 'exact', head: true })),
    ...statuses.map(st => count(supabase.from('track_metadata').select('ashreinu_event_id', { count: 'exact', head: true }).eq('status', st))),
  ]);
  const tokens = await allRows(() => supabase.from('track_metadata').select('input_tokens, output_tokens').eq('status', 'enriched'));
  const outdated = await count(supabase.from('track_metadata').select('ashreinu_event_id', { count: 'exact', head: true })
    .eq('status', 'enriched').eq('locked', false).or(`prompt_version.is.null,prompt_version.lt.${PROMPT_VERSION}`));
  const tin = tokens.reduce((a, r) => a + (r.input_tokens || 0), 0);
  const tout = tokens.reduce((a, r) => a + (r.output_tokens || 0), 0);
  const cost = tin / 1e6 * PRICE_IN + tout / 1e6 * PRICE_OUT;
  const counts = Object.fromEntries(statuses.map((st, i) => [st, byStatus[i]]));
  // Search health: does the ranked search function exist, and how many
  // catalogued tracks have no search words yet (need "Rebuild search index")?
  const probe = await supabase.rpc('search_catalogue', { q_simple: 'test', q_english: 'test', q_raw: 'test', topic_slugs: [], max_results: 1 });
  const unindexed = await count(supabase.from('track_metadata').select('ashreinu_event_id', { count: 'exact', head: true })
    .eq('status', 'enriched').or('search_b.is.null,search_b.eq.'));
  return {
    candidates, ...counts, outdated, prompt_version: PROMPT_VERSION,
    search_ready: !probe.error, search_error: probe.error?.message || null, unindexed,
    not_collected: Math.max(0, candidates - statuses.reduce((a, st) => a + counts[st], 0)),
    tokens: { input: tin, output: tout }, cost_so_far: +cost.toFixed(2),
    avg_cost_per_track: counts.enriched ? +(cost / counts.enriched).toFixed(4) : null,
  };
}

// The pipeline spends money (Claude) and writes to the catalogue, so every
// call needs the password set as PIPELINE_KEY in Vercel. If it isn't set,
// nothing runs: a missing setting must never leave the door open.
function keyOk(req) {
  const expected = process.env.PIPELINE_KEY || '';
  const given = String(req.headers?.['x-pipeline-key'] || '');
  if (!expected || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// What the archive holds and how much of it the catalogue can cover: every
// audio track, grouped by kind, with hours, how many have Ashreinu's own
// outline or hanacha (so Claude can catalogue them), and how many are done.
function trackKind(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('nigun')) return 'Niggunim';
  if (/shacharis|minchah|ma.?ariv|maftir|prayer|kidush levanah|hataras nedarim|havdalah|kos shel brachah/.test(t)) return 'Davening, Havdalah & Kos Shel Brachah';
  if (t.includes('ma\u2019amar') || t.includes("ma'amar") || t.includes('maamar')) return "Ma'amarim";
  if (t.includes('sicha') || t.includes('farbrengen')) return 'Sichos';
  return 'Other talks (rallies, audiences, Kinusim...)';
}
async function coverage(supabase) {
  const [rows, done] = await Promise.all([
    allRows(() => supabase.from('ashreinu_events').select('id, type, duration_ms, has_transcript, has_ld:raw_data->>has_long_description')
      .not('audio_uri', 'is', null).neq('type', 'Farbrengen').order('id')),
    allRows(() => supabase.from('track_metadata').select('ashreinu_event_id').eq('status', 'enriched').order('ashreinu_event_id')),
  ]);
  const doneIds = new Set(done.map(r => r.ashreinu_event_id));
  const kinds = {};
  for (const r of rows) {
    const k = kinds[trackKind(r.type)] ||= { tracks: 0, hours: 0, with_source: 0, with_source_hours: 0, catalogued: 0 };
    const h = (r.duration_ms || 0) / 3.6e6;
    const hasSource = r.has_transcript === true || r.has_ld === 'true';
    k.tracks++; k.hours += h;
    if (hasSource) { k.with_source++; k.with_source_hours += h; }
    if (doneIds.has(r.id)) k.catalogued++;
  }
  for (const k of Object.values(kinds)) { k.hours = Math.round(k.hours); k.with_source_hours = Math.round(k.with_source_hours); }
  return { kinds };
}

// How the topic list fits the talks actually catalogued: talks per topic
// (as main topic and as a secondary one) and the new topics Claude asked for.
async function topicReport(supabase) {
  const [rows, topics] = await Promise.all([
    allRows(() => supabase.from('track_metadata').select('main_topic, topics, suggested_new_topics').eq('status', 'enriched').order('ashreinu_event_id')),
    loadTopics(supabase),
  ]);
  const main = {}, also = {}, suggested = {};
  for (const r of rows) {
    if (r.main_topic) main[r.main_topic] = (main[r.main_topic] || 0) + 1;
    for (const t of r.topics || []) also[t] = (also[t] || 0) + 1;
    for (const t of r.suggested_new_topics || []) { const k = String(t).trim(); if (k) suggested[k] = (suggested[k] || 0) + 1; }
  }
  return {
    talks: rows.length,
    groups: topics.all.filter(t => !t.parent_slug).map(g => ({ name: g.name_en, topics: topics.leaves.filter(t => t.parent_slug === g.slug)
      .map(t => ({ slug: t.slug, name: t.name_en, main: main[t.slug] || 0, also: also[t.slug] || 0 })) })),
    suggested: Object.entries(suggested).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([name, count]) => ({ name, count })),
  };
}

export default async function handler(req, res) {
  if (!process.env.PIPELINE_KEY) return res.status(503).json({ error: 'PIPELINE_KEY is not set in Vercel, so the pipeline is locked.' });
  if (!keyOk(req)) return res.status(401).json({ error: 'Wrong or missing pipeline password.', needKey: true });
  const { mode, id } = req.query;
  const needsId = ['source', 'preview', 'enrich', 'titles', 'settitle', 'retitle', 'fix', 'setfix', 'settext', 'rate', 'setfeatured', 'playlist'].includes(mode);
  if (needsId && (!id || !/^\d+$/.test(id))) return res.status(400).json({ error: 'Missing or invalid ?id=' });
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '30', 10) || 30, 100));

  try {
    if (mode === 'collect') return res.status(200).json(await collectNext(supa(), Math.min(limit, 40)));
    if (mode === 'pending') {
      const supabase = supa();
      // Which come first: oldest (5711 onward), newest, or a mix across all years.
      const order = String(req.query.order || 'old');
      const build = () => {
        const q = supabase.from('track_metadata').select('ashreinu_event_id').order('ashreinu_event_id', { ascending: order !== 'new' });
        // Upgrade: entries made with an older prompt version, never ones a person has edited.
        return req.query.upgrade
          ? q.eq('status', 'enriched').eq('locked', false).or(`prompt_version.is.null,prompt_version.lt.${PROMPT_VERSION}`)
          : q.in('status', req.query.retry ? ['collected', 'error'] : ['collected']);
      };
      if (order === 'mix') {
        // Every waiting id (paged past the 1000-row cap), shuffled.
        const all = await allRows(build);
        const ids = all.map(r => r.ashreinu_event_id);
        for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
        return res.status(200).json({ ids: ids.slice(0, limit) });
      }
      const { data, error } = await build().limit(limit);
      if (error) throw new Error(error.message);
      return res.status(200).json({ ids: data.map(r => r.ashreinu_event_id) });
    }
    if (mode === 'enrich') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
      const note = String(req.query.note || '').trim().slice(0, 500);
      return res.status(200).json(await enrichStored(supa(), parseInt(id, 10), note));
    }
    if (mode === 'titles') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
      return res.status(200).json(await suggestTitles(supa(), parseInt(id, 10), String(req.query.note || '').trim().slice(0, 500)));
    }
    if (mode === 'settitle') return res.status(200).json(await setTitle(supa(), parseInt(id, 10), req.query.title));
    if (mode === 'playlists') return res.status(200).json(await importPlaylistList(supa()));
    if (mode === 'playlist') return res.status(200).json(await importPlaylist(supa(), parseInt(id, 10)));
    if (mode === 'rate') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
      return res.status(200).json(await rateEvergreen(supa(), parseInt(id, 10)));
    }
    if (mode === 'setfeatured') return res.status(200).json(await setFeatured(supa(), parseInt(id, 10), String(req.query.value || 'auto')));
    if (mode === 'unrated') {
      // Catalogued talks with no featuring rating yet (made before ratings existed).
      const rows = await allRows(() => supa().from('track_metadata').select('ashreinu_event_id').eq('status', 'enriched').is('evergreen', null).order('ashreinu_event_id'))
        .catch(e => { throw new Error(/evergreen/.test(e.message) ? NO_FEATURE_COLUMNS : e.message); });
      return res.status(200).json({ ids: rows.map(r => r.ashreinu_event_id) });
    }
    if (mode === 'retitle') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
      return res.status(200).json(await retitle(supa(), parseInt(id, 10), String(req.query.note || '').trim().slice(0, 500)));
    }
    if (mode === 'settext') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      return res.status(200).json(await setText(supa(), parseInt(id, 10), body));
    }
    if (mode === 'fix') return res.status(200).json(await getFix(supa(), parseInt(id, 10)));
    if (mode === 'setfix') return res.status(200).json(await setFix(supa(), parseInt(id, 10), String(req.query.kind || ''), req.query.title, req.query.note, req.query.same_as));
    if (mode === 'stats') return res.status(200).json(await stats(supa()));
    if (mode === 'coverage') return res.status(200).json(await coverage(supa()));
    if (mode === 'topicreport') return res.status(200).json(await topicReport(supa()));
    if (mode === 'list') {
      const supabase = supa();
      const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
      // Optional find: track numbers ("47, 2203") or words in the title/summary.
      const find = String(req.query.find || '').trim().slice(0, 100);
      const findIds = find.match(/^[\d,\s]+$/) ? find.split(/[^\d]+/).filter(Boolean).map(Number) : null;
      let q = supabase.from('track_metadata').select('*').eq('status', 'enriched');
      if (findIds) q = q.in('ashreinu_event_id', findIds);
      else if (find) { const w = find.replace(/[%,()]/g, ' '); q = q.or(`title_en.ilike.%${w}%,summary_en.ilike.%${w}%`); }
      const [{ data, error }, topics] = await Promise.all([
        q.order('enriched_at', { ascending: false }).range(offset, offset + limit - 1),
        loadTopics(supabase),
      ]);
      if (error) throw new Error(error.message);
      const ids = data.map(r => r.ashreinu_event_id);
      const { data: evs } = ids.length
        ? await supabase.from('ashreinu_events').select('id, parent_id, name, type, parent_name, hebrew_day, hebrew_month_name, hebrew_year, duration_ms').in('id', ids)
        : { data: [] };
      const ev = Object.fromEntries((evs || []).map(e => [e.id, e]));
      return res.status(200).json({
        topicNames: Object.fromEntries(topics.leaves.map(t => [t.slug, t.name_en])),
        entries: data.map(r => {
          const e = ev[r.ashreinu_event_id] || {};
          return {
            source: { id: r.ashreinu_event_id, parent_id: e.parent_id, name: e.name, type: e.type, parent_name: e.parent_name,
              hebrew_date: e.hebrew_day ? `${e.hebrew_day} ${e.hebrew_month_name} ${e.hebrew_year}` : null, duration_ms: e.duration_ms,
              outline: r.outline_he || '', transcript: (r.transcript || '').slice(0, 4000), transcript_kind: r.transcript_kind },
            metadata: { title_en: r.title_en, title_he: r.title_he, summary_en: r.summary_en, key_points: r.key_points || [],
              main_topic: r.main_topic, other_topics: r.topics || [], suggested_new_topics: r.suggested_new_topics || [],
              occasions: r.occasions || [], parsha: r.parsha, people: r.people || [], sources: r.sources || [], phrases: r.phrases || [],
              confidence: r.confidence, confidence_reason: r.confidence_reason },
            evergreen: r.evergreen ?? null, evergreen_reason: r.evergreen_reason || null, featured: r.featured ?? null,
            audience: r.audience || [], locked: r.locked, model: r.model,
            usage: { input_tokens: r.input_tokens || 0, output_tokens: r.output_tokens || 0 },
          };
        }),
      });
    }
    if (mode === 'reindex') return res.status(200).json(await reindex(supa(), Math.max(0, parseInt(req.query.offset || '0', 10) || 0)));
    if (mode === 'source') {
      return res.status(200).json({ source: await fetchSource(id) });
    }
    if (mode === 'preview') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
      const source = await fetchSource(id);
      if (!source.outline && !source.transcript) {
        return res.status(200).json({ source, skipped: 'Ashreinu has no outline or transcript for this track' });
      }
      const topics = await loadTopics(supa());
      return res.status(200).json({ source, audience: audienceFor(source.name, source.type), ...(await enrich(source, topics)), topicNames: Object.fromEntries(topics.leaves.map(t => [t.slug, t.name_en])) });
    }
    return res.status(400).json({ error: 'Unknown mode (use source, preview, collect, pending, enrich or stats)' });
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? 502 : 500;
    return res.status(status).json({ error: err.message });
  }
}
