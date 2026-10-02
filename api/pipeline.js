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

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { OCCASIONS, PARSHIYOS, audienceFor, normalize, hebrewSearchForms } from '../lib/vocab.js';

const ASHREINU = 'https://5qlaecnhel.execute-api.us-east-1.amazonaws.com/prod/ashreinu/api/v1';
const MODEL = 'claude-opus-5-5';

// Bump when the prompt or schema changes meaningfully; entries made with an
// older version can then be re-run ("upgrade") without touching locked ones.
const PROMPT_VERSION = 2;

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
               'occasions', 'parsha', 'people', 'sources', 'phrases', 'confidence', 'confidence_reason'],
    properties: {
      title_en: { type: 'string', description: 'Natural, clear English title of the idea: 3-8 words, at most ~55 characters' },
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
    },
  };
}

const SYSTEM = `You catalogue recordings of the Lubavitcher Rebbe's talks (sichos, ma'amarim) for a searchable audio archive. The listeners are a wide crowd: many have a basic Jewish background but don't know Chassidic terminology. For ONE audio track you get the archive's own material for it: a Hebrew outline (תוכן) written in dense editorial shorthand, and/or a hanacha (a transcript written down from the talk, in Hebrew or Yiddish). Write the English catalogue entry for that track.

The core rule: use the material to understand WHAT the talk says, then say it the way a good teacher would explain it to a friend. Explain, don't translate. A literal rendering of the shorthand reads as gibberish.

Accuracy:
- Every idea in your entry must come from the material. Don't add lessons, claims, stories or conclusions that aren't there.
- You MAY briefly explain a concept so a newcomer understands it (e.g. "'bread of shame', the discomfort of receiving what you didn't earn"). Explaining a term is fine; adding content is not.
- If part of the material is unclear, leave it out rather than guess.

Title (shown in a track list, like a song title in a music app):
- The idea of the talk in natural, concrete words: 3-8 words, at most ~55 characters.
- Someone with a basic Jewish background should understand it at a glance. Widely known words are fine (Moshiach, Shabbos, Pesach, mitzvah, tzedakah, Torah, the Rebbe); avoid unexplained insider terms (e.g. "Dira Betachtonim", "Mesirus Nefesh", "Hiskashrus") in the title.
- Not clinical or abstract ("Festivals and Ordinary Weekdays" says nothing), not a bare list of terms, no filler ("A Sicha on…", "The Rebbe Explains…").
- A question is fine when the talk itself asks it ("Why…?").
- If the outline has its own heading, it tells you the subject; still phrase the English title naturally.
- If the track covers several unrelated subjects, title the main one.
- Good: "Six-Day War Lessons for the Inner Battle" — concrete, natural, says the idea.

Summary: 1-3 natural sentences (up to 4 for long multi-point outlines), within the word limit given. Start with the substance, not "In this sicha" or "The Rebbe explains that".

Key points: only for outlines with several distinct points: one plain-English bullet per main point, in order.

Worked example (a different track, to show the style):
Outline: "ביאור במאמר הצ"צ 'להבין ענין פסח שני' מבאר שפסח שני (יסוד) הוא למע' מפסח ראשון (מלכות) – לכאורה ה"ז סתירה לפשטות הענין, ולתורת אדמו"ר מוהריי"צ 'ניטאָ קיין פאַרפאַלן'; והביאור – פסח שני הוא תיקון לקרבן פסח, אבל ביחס לשאר עניני העבודה דפסח … הוא למע' מהם"
Good title: "Is the Second Pesach Greater Than the First?"
Good summary: "The Tzemach Tzedek writes that Pesach Sheini, the make-up Pesach for those who missed the first, is in a sense higher than the original. The Rebbe asks how a make-up can be higher, and explains: as a correction for the missed offering it comes second, but in other respects it stands above the first."
Bad title: "Pesach Sheini: Yesod and Malchus" (insider terms, says nothing to most listeners).

Use standard Chabad English transliteration (Moshiach, Geulah, mitzvos, Shabbos, Rebbe, Chassidus, davening).
Classification. These power browsing and search, so consistency matters more than coverage:
- main_topic: the ONE topic from the menu below that this talk is mainly about, i.e. where a listener browsing that topic would most want to find it.
- other_topics: 0-3 more topics that are a substantial part of the talk. Not passing mentions. Never repeat main_topic.
- suggested_new_topics: only if an important theme fits no topic on the menu (a person reviews these). Usually empty.
- occasions: occasions the talk is for or substantially about. Don't add one just because of the date it was said: a talk given on Purim about something else gets no "Purim".
- parsha: the weekly Torah portion the talk discusses, or "none".
- people: people the talk meaningfully discusses (e.g. Avraham Avinu, Mordechai, Rashbi, the Alter Rebbe, the Previous Rebbe), in common Chabad English. Not people only cited as a source.
- sources: works cited, at book level ("Tanya", "Zohar", "Rambam, Hilchos Teshuvah", "Bamidbar"), not chapter and verse.
- phrases: famous sayings or expressions the talk quotes or centres on, as people remember them ("lechatchila ariber", "nahama dekisufa", "ufaratzta"). Usually empty.

confidence: high if the material clearly covers the talk; medium if brief or partial; low if very thin or unclear.`;

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
    duration_ms: ev.audio_recordings_duration || null,
    outline: htmlToText(outlineRes?.data),
    transcript: htmlToText(t?.content),
    transcript_kind: t?.type || null, // e.g. "Hanacha (Lahak)", "Yiddish Hanacha (Notik)"
  };
}

// How long the entry may be, derived from the source: a one-line outline
// gets a one-sentence summary. Points are numbered "1)" or lettered "א.".
function lengthBudget(src) {
  if (!src.outline) return { summaryWords: 60, points: 5 };
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
  if (m.title_en.length > 60 || titleWords > 9) warnings.push(`Title is long (${titleWords} words, ${m.title_en.length} chars)`);
  const sumWords = m.summary_en.trim().split(/\s+/).length;
  if (sumWords > budget.summaryWords * 1.25) warnings.push(`Summary is ${sumWords} words (limit ${budget.summaryWords})`);
  if (budget.points <= 1 && m.key_points.length > 1) warnings.push(`${m.key_points.length} key points for a one-point outline`);
  return warnings;
}

async function enrich(src, topics) {
  const budget = lengthBudget(src);
  const heading = outlineHeading(src.outline, budget.points);
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const material = [
    `Track: ${src.name} (${src.type})`,
    src.parent_name ? `Part of: ${src.parent_name}` : null,
    src.hebrew_date ? `Date: ${src.hebrew_date}` : null,
    src.duration_ms ? `Length: ${Math.round(src.duration_ms / 60000)} minutes` : null,
    src.outline ? `\n<outline>\n${src.outline}\n</outline>` : null,
    src.transcript ? `\n<hanacha kind="${src.transcript_kind || 'unknown'}">\n${src.transcript}\n</hanacha>` : null,
    heading ? `\nThe outline's own heading (written by the archive's editors): «${heading}». Use it as title_he (verbatim or lightly shortened). It tells you the subject; phrase title_en naturally, not as a literal translation.` : null,
    `\nLength limits for this track: summary at most ${budget.summaryWords} words; ` +
      (budget.points > 1 ? `at most ${budget.points} key points (one per outline point).` : 'no key points (single-point outline).'),
  ].filter(Boolean).join('\n');

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
function buildSearchLayers(m, outline, topics, audience) {
  const topicWords = [m.main_topic, ...m.other_topics].map(slug => topics.bySlug[slug])
    .filter(Boolean).flatMap(t => [t.name_en, t.name_he, ...(t.aliases || [])]);
  const layers = {
    search_a: normalize([m.title_en, m.title_he, ...m.phrases].join(' \n ')),
    search_b: normalize([...topicWords, ...m.occasions, m.parsha, ...m.people, ...m.sources, ...audience].filter(Boolean).join(' \n ')),
    search_c: normalize([m.summary_en, ...m.key_points].join(' \n ')),
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

async function enrichStored(supabase, id) {
  const [{ data: tm, error: e1 }, { data: ev, error: e2 }] = await Promise.all([
    supabase.from('track_metadata').select('*').eq('ashreinu_event_id', id).maybeSingle(),
    supabase.from('ashreinu_events').select('id, name, type, parent_name, hebrew_day, hebrew_month_name, hebrew_year, duration_ms').eq('id', id).maybeSingle(),
  ]);
  if (e1 || e2) throw new Error((e1 || e2).message);
  if (!tm) throw new Error(`Track ${id} hasn't been collected yet`);
  if (tm.locked) return { id, skipped: 'locked (edited by a person), so re-runs leave it alone' };
  const topics = await loadTopics(supabase);
  const audience = audienceFor(ev?.name, ev?.type);
  const src = {
    id, name: ev?.name, type: ev?.type, parent_name: ev?.parent_name,
    hebrew_date: ev?.hebrew_day ? `${ev.hebrew_day} ${ev.hebrew_month_name} ${ev.hebrew_year}` : null,
    duration_ms: ev?.duration_ms, outline: tm.outline_he || '', transcript: tm.transcript || '', transcript_kind: tm.transcript_kind,
  };
  try {
    const r = await enrich(src, topics);
    const m = r.metadata;
    const row = {
      status: 'enriched', error: null, prompt_version: PROMPT_VERSION,
      title_en: m.title_en, title_he: m.title_he, summary_en: m.summary_en, key_points: m.key_points,
      main_topic: m.main_topic, topics: m.other_topics, suggested_new_topics: m.suggested_new_topics,
      occasions: m.occasions, parsha: m.parsha, people: m.people, sources: m.sources, phrases: m.phrases,
      audience, keywords: [], confidence: m.confidence, confidence_reason: m.confidence_reason,
      ...buildSearchLayers(m, tm.outline_he, topics, audience), model: r.model,
      input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens,
      enriched_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('track_metadata').update(row).eq('ashreinu_event_id', id);
    if (error) throw new Error(error.message);
    return { id, saved: true, metadata: m, audience, warnings: r.warnings, usage: r.usage };
  } catch (e) {
    await supabase.from('track_metadata').update({ status: 'error', error: 'enrich: ' + e.message, updated_at: new Date().toISOString() }).eq('ashreinu_event_id', id);
    throw e;
  }
}

// Rebuild the search layers from what's stored now: after a person edits an
// entry in the table editor, or a topic's names/aliases change. No AI.
async function reindex(supabase, offset) {
  const topics = await loadTopics(supabase);
  const { data, error } = await supabase.from('track_metadata')
    .select('ashreinu_event_id, title_en, title_he, summary_en, key_points, main_topic, topics, occasions, parsha, people, sources, phrases, audience, outline_he')
    .eq('status', 'enriched').order('ashreinu_event_id').range(offset, offset + 199);
  if (error) throw new Error(error.message);
  for (const r of data) {
    const m = { ...r, key_points: r.key_points || [], other_topics: r.topics || [], occasions: r.occasions || [],
                people: r.people || [], sources: r.sources || [], phrases: r.phrases || [] };
    const { error: e } = await supabase.from('track_metadata')
      .update({ ...buildSearchLayers(m, r.outline_he, topics, r.audience || []), updated_at: new Date().toISOString() })
      .eq('ashreinu_event_id', r.ashreinu_event_id);
    if (e) throw new Error(e.message);
  }
  return { reindexed: data.length, next_offset: data.length === 200 ? offset + 200 : null };
}

// Opus 5.5 pricing ($ per million tokens), for the running cost estimate.
const PRICE_IN = 4, PRICE_OUT = 20;
async function stats(supabase) {
  const count = async (q) => { const { count, error } = await q; if (error) throw new Error(error.message); return count; };
  const statuses = ['collected', 'enriched', 'no_source', 'error'];
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
  return {
    candidates, ...counts, outdated, prompt_version: PROMPT_VERSION,
    not_collected: Math.max(0, candidates - statuses.reduce((a, st) => a + counts[st], 0)),
    tokens: { input: tin, output: tout }, cost_so_far: +cost.toFixed(2),
    avg_cost_per_track: counts.enriched ? +(cost / counts.enriched).toFixed(4) : null,
  };
}

export default async function handler(req, res) {
  const { mode, id } = req.query;
  const needsId = ['source', 'preview', 'enrich'].includes(mode);
  if (needsId && (!id || !/^\d+$/.test(id))) return res.status(400).json({ error: 'Missing or invalid ?id=' });
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '30', 10) || 30, 100));

  try {
    if (mode === 'collect') return res.status(200).json(await collectNext(supa(), Math.min(limit, 40)));
    if (mode === 'pending') {
      const supabase = supa();
      let q = supabase.from('track_metadata').select('ashreinu_event_id').order('ashreinu_event_id').limit(limit);
      if (req.query.upgrade) {
        // Entries made with an older prompt version, never ones a person has edited.
        q = q.eq('status', 'enriched').eq('locked', false).or(`prompt_version.is.null,prompt_version.lt.${PROMPT_VERSION}`);
      } else {
        q = q.in('status', req.query.retry ? ['collected', 'error'] : ['collected']);
      }
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return res.status(200).json({ ids: data.map(r => r.ashreinu_event_id) });
    }
    if (mode === 'enrich') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
      return res.status(200).json(await enrichStored(supa(), parseInt(id, 10)));
    }
    if (mode === 'stats') return res.status(200).json(await stats(supa()));
    if (mode === 'list') {
      const supabase = supa();
      const offset = Math.max(0, parseInt(req.query.offset || '0', 10) || 0);
      const [{ data, error }, topics] = await Promise.all([
        supabase.from('track_metadata').select('*').eq('status', 'enriched')
          .order('enriched_at', { ascending: false }).range(offset, offset + limit - 1),
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
