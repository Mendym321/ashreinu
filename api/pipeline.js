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
    title_en: { type: 'string', description: 'Specific English title, 4-9 words, naming what THIS talk is about' },
    title_he: { type: 'string', description: 'Short Hebrew title in the style of a sefer heading' },
    summary_en: { type: 'string', description: '2-4 sentence English summary of the main ideas' },
    key_points: { type: 'array', items: { type: 'string' }, description: '3-6 short English bullet points, in order' },
    topics: { type: 'array', items: { type: 'string', enum: TOPICS }, description: '2-6 topics from the fixed list' },
    suggested_new_topics: { type: 'array', items: { type: 'string' }, description: 'Important themes missing from the list (often empty)' },
    occasions: { type: 'array', items: { type: 'string' }, description: 'Dates/occasions discussed, e.g. "19 Kislev", "Pesach Sheini"' },
    sources: { type: 'array', items: { type: 'string' }, description: 'Sources cited, e.g. "Tanya ch. 37", "Bamidbar 26:2"' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    confidence_reason: { type: 'string', description: 'One short sentence: why this confidence' },
  },
};

const SYSTEM = `You catalogue recordings of the Lubavitcher Rebbe's talks (sichos, ma'amarim) for a searchable audio archive. For ONE audio track you get the archive's own material for it: a Hebrew outline (תוכן) and/or a hanacha (a transcript written down from the talk, in Hebrew or Yiddish). Write the English catalogue entry for that track.

Guidelines:
- Base everything only on the material given. Don't add ideas that aren't there.
- The title should tell a listener what this specific talk is about ("Why Pesach Sheini Surpasses the First Pesach"), not generic ("A Sicha on Pesach").
- Use standard Chabad English transliteration (Moshiach, Geulah, mitzvos, Shabbos, Rebbe, Chassidus).
- Topics: choose only from the allowed list. If an important theme is missing, put it in suggested_new_topics.
- confidence: high if the material clearly covers the talk; medium if it's brief or partial; low if it's very thin or unclear.`;

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

async function enrich(src) {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  const material = [
    `Track: ${src.name} (${src.type})`,
    src.parent_name ? `Part of: ${src.parent_name}` : null,
    src.hebrew_date ? `Date: ${src.hebrew_date}` : null,
    src.duration_ms ? `Length: ${Math.round(src.duration_ms / 60000)} minutes` : null,
    src.outline ? `\n<outline>\n${src.outline}\n</outline>` : null,
    src.transcript ? `\n<hanacha kind="${src.transcript_kind || 'unknown'}">\n${src.transcript}\n</hanacha>` : null,
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
  return {
    metadata: JSON.parse(text),
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
