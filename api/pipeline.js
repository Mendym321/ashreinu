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
// GET /api/pipeline?mode=source&id=EVENT_ID   -> the track + its outline/transcript (no AI)
// GET /api/pipeline?mode=preview&id=EVENT_ID  -> same, plus Claude's metadata (nothing saved)

import Anthropic from '@anthropic-ai/sdk';

const ASHREINU = 'https://5qlaecnhel.execute-api.us-east-1.amazonaws.com/prod/ashreinu/api/v1';
const MODEL = 'claude-opus-5-5';

// A fixed topic list keeps tags consistent ("geulah" vs "redemption" vs
// "moshiach" would otherwise all appear). Claude must pick from this list,
// and can separately suggest new topics for a human to review and add.
const TOPICS = [
  'moshiach & geulah', 'ahavas yisroel', 'achdus', 'shlichus', 'mivtzoim', 'chinuch',
  'children & tzivos hashem', 'jewish women', 'torah study', 'rambam study', 'chitas',
  'tanya', 'chassidus', 'pnimiyus hatorah', 'tefillah', 'teshuvah', 'simcha',
  'emunah & bitachon', 'avodas hashem', 'bittul', 'mesiras nefesh', 'dira betachtonim',
  'galus', 'tzedakah', 'gemilus chassadim', 'tefillin', 'mezuzah', 'shabbos candles',
  'kashrus', 'taharas hamishpacha', 'shabbos', 'yom tov', 'hiskashrus', 'the frierdiker rebbe',
  'the alter rebbe', 'the baal shem tov', 'rebbeim & chassidic history', 'minhagim', 'halacha',
  'parsha', 'eretz yisroel', 'shleimus haaretz', 'sheva mitzvos bnei noach', 'world events',
  'science & torah', 'health & wellbeing', 'parnassah', 'family & marriage', 'bar & bas mitzvah',
  'kiddush hashem', 'jewish identity', 'outreach', 'community', 'yechidus & brachos',
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title_en', 'title_he', 'summary_en', 'key_points', 'topics', 'suggested_new_topics',
             'occasions', 'sources', 'confidence', 'confidence_reason'],
  properties: {
    title_en: { type: 'string', description: 'Track title for a list: 2-6 words, at most ~45 characters, names the subject' },
    title_he: { type: 'string', description: 'Short Hebrew title, 2-6 words, using the outline\'s own wording where possible' },
    summary_en: { type: 'string', description: 'Plain-English summary, within the word limit given in the message' },
    key_points: { type: 'array', items: { type: 'string' }, description: 'One short bullet per main point of the outline, in order; empty if there is only one point' },
    topics: { type: 'array', items: { type: 'string', enum: TOPICS }, description: '2-6 topics from the fixed list' },
    suggested_new_topics: { type: 'array', items: { type: 'string' }, description: 'Important themes missing from the list (often empty)' },
    occasions: { type: 'array', items: { type: 'string' }, description: 'Dates/occasions discussed, e.g. "19 Kislev", "Pesach Sheini"' },
    sources: { type: 'array', items: { type: 'string' }, description: 'Sources cited, e.g. "Tanya ch. 37", "Bamidbar 26:2"' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    confidence_reason: { type: 'string', description: 'One short sentence: why this confidence' },
  },
};

const SYSTEM = `You catalogue recordings of the Lubavitcher Rebbe's talks (sichos, ma'amarim) for a searchable audio archive, used by ordinary listeners browsing on their phones. For ONE audio track you get the archive's own material for it: a Hebrew outline (תוכן) and/or a hanacha (a transcript written down from the talk, in Hebrew or Yiddish). Write the English catalogue entry for that track.

Accuracy comes first:
- Say only what the material says. Don't add explanations, implications, or background that aren't in it.
- Match the source's level of detail. A short outline gets a short entry; never expand it.
- If something is unclear, leave it out rather than guess.

Titles appear in a track list, like song titles in a music app:
- 2-6 words, at most ~45 characters. Short enough to read at a glance on a phone.
- Name the subject; don't argue a point. Prefer "Physicality in the Days of Moshiach" over "Why the World Needs Physicality in the Future Redemption".
- Build it from the outline's own key terms (the occasion, mitzvah, concept or verse it discusses).
- If the track covers several unrelated subjects, title the main one; the rest go in key points and topics.
- No filler words like "A Sicha on", "The Rebbe Explains", "Insights Into".
- Examples of the style: "Pesach Sheini and the First Pesach", "Mivtza Tefillin", "Lag BaOmer and Rashbi's Teachings", "Blessings for the Graduates", "Ahavas Yisroel Before Davening".

Summary: plain, easy English for a general listener, within the word limit given in the message. Start with the substance, not "In this sicha" or "The Rebbe explains". Briefly gloss a Hebrew term only if a newcomer would be lost without it.

Key points: one short bullet per main numbered point of the outline, in its order, faithful to it. Leave empty if there's only one point.

Use standard Chabad English transliteration (Moshiach, Geulah, mitzvos, Shabbos, Rebbe, Chassidus, Rashbi, davening).
Topics: choose only from the allowed list; put important missing themes in suggested_new_topics.
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
  if (!src.outline) return { summaryWords: 50, points: 5 };
  const words = src.outline.split(/\s+/).filter(Boolean).length;
  const points = (src.outline.match(/(?:^|\s)\d{1,2}\)|(?:^|\n)\s*[א-ת]{1,2}\.\s/g) || []).length;
  return { summaryWords: Math.max(12, Math.min(60, Math.round(words * 0.5))), points: Math.min(points, 6) };
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
  if (m.title_en.length > 50 || titleWords > 7) warnings.push(`Title is long (${titleWords} words, ${m.title_en.length} chars)`);
  const sumWords = m.summary_en.trim().split(/\s+/).length;
  if (sumWords > budget.summaryWords * 1.25) warnings.push(`Summary is ${sumWords} words (limit ${budget.summaryWords})`);
  if (budget.points <= 1 && m.key_points.length > 1) warnings.push(`${m.key_points.length} key points for a one-point outline`);
  return warnings;
}

async function enrich(src) {
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
    heading ? `\nThe outline's own heading (written by the archive's editors): «${heading}». Use it for title_he (verbatim, or lightly shortened), and make title_en a faithful English rendering of it in the title style.` : null,
    `\nLength limits for this track: summary at most ${budget.summaryWords} words; ` +
      (budget.points > 1 ? `at most ${budget.points} key points (one per outline point).` : 'no key points unless the material clearly has several distinct points.'),
  ].filter(Boolean).join('\n');

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 6000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // if a safety filter wrongly declines, Anthropic re-runs it on a fallback model
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: material }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined this track (refusal)');
  if (response.stop_reason === 'max_tokens') throw new Error('Response was cut off (max_tokens)');
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('No text in Claude response');
  const u = response.usage || {};
  const metadata = JSON.parse(text);
  return {
    metadata,
    budget,
    heading,
    warnings: checkEntry(metadata, budget),
    model: response.model,
    usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens },
  };
}

export default async function handler(req, res) {
  const { mode, id } = req.query;
  if (!id || !/^\d+$/.test(id)) return res.status(400).json({ error: 'Missing or invalid ?id=' });

  try {
    if (mode === 'source') {
      return res.status(200).json({ source: await fetchSource(id) });
    }
    if (mode === 'preview') {
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
      const source = await fetchSource(id);
      if (!source.outline && !source.transcript) {
        return res.status(200).json({ source, skipped: 'Ashreinu has no outline or transcript for this track' });
      }
      return res.status(200).json({ source, ...(await enrich(source)) });
    }
    return res.status(400).json({ error: 'Unknown mode (use source or preview)' });
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? 502 : 500;
    return res.status(status).json({ error: err.message });
  }
}
