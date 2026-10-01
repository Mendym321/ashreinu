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
  'moshiach & redemption', 'exile', 'love for every jew', 'jewish unity', 'spreading judaism',
  'mitzvah campaigns', 'education', 'children', 'jewish women', 'torah study', 'daily rambam',
  'tanya & chassidus', 'prayer', 'teshuvah (returning to g-d)', 'joy', 'faith & trust',
  'serving g-d', 'humility', 'self-sacrifice', 'holiness in the physical world', 'charity',
  'kindness', 'tefillin', 'mezuzah', 'shabbos candles', 'kosher', 'family purity', 'shabbos',
  'jewish holidays', 'connection to the rebbe', 'the previous rebbe', 'chabad rebbeim',
  'chassidic history', 'jewish customs', 'jewish law', 'weekly torah portion', 'land of israel',
  'safety of israel', 'seven noahide laws', 'world events', 'torah & science', 'health',
  'livelihood', 'marriage & family', 'bar & bat mitzvah', 'sanctifying g-d\'s name',
  'jewish identity', 'community leadership', 'blessings', 'personal growth', 'overcoming challenges',
  'purpose of life', 'the soul', 'mourning & yahrzeit',
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title_en', 'title_he', 'summary_en', 'key_points', 'keywords', 'topics', 'suggested_new_topics',
             'occasions', 'sources', 'confidence', 'confidence_reason'],
  properties: {
    title_en: { type: 'string', description: 'Natural, clear English title of the idea: 3-8 words, at most ~55 characters' },
    title_he: { type: 'string', description: 'Short Hebrew heading (the outline\'s own heading when it has one)' },
    summary_en: { type: 'string', description: '1-3 natural sentences explaining the idea, within the word limit given' },
    key_points: { type: 'array', items: { type: 'string' }, description: 'For multi-point outlines: one plain-English bullet per main point; otherwise empty' },
    keywords: { type: 'array', items: { type: 'string' }, description: '4-10 search terms people might type: key Hebrew/Yiddish terms AND their English equivalents, names, places' },
    topics: { type: 'array', items: { type: 'string', enum: TOPICS }, description: '2-6 topics from the fixed list' },
    suggested_new_topics: { type: 'array', items: { type: 'string' }, description: 'Important themes missing from the list (often empty)' },
    occasions: { type: 'array', items: { type: 'string' }, description: 'Dates/occasions discussed, e.g. "19 Kislev", "Pesach Sheini"' },
    sources: { type: 'array', items: { type: 'string' }, description: 'Sources cited, e.g. "Tanya ch. 37", "Bamidbar 26:2"' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    confidence_reason: { type: 'string', description: 'One short sentence: why this confidence' },
  },
};

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

Keywords: 4-10 terms people might search: the key Hebrew/Yiddish terms in Chabad transliteration AND their English equivalents (e.g. "galus", "exile"), plus names, places and occasions mentioned.

Worked example (a different track, to show the style):
Outline: "ביאור במאמר הצ"צ 'להבין ענין פסח שני' מבאר שפסח שני (יסוד) הוא למע' מפסח ראשון (מלכות) – לכאורה ה"ז סתירה לפשטות הענין, ולתורת אדמו"ר מוהריי"צ 'ניטאָ קיין פאַרפאַלן'; והביאור – פסח שני הוא תיקון לקרבן פסח, אבל ביחס לשאר עניני העבודה דפסח … הוא למע' מהם"
Good title: "Is the Second Pesach Greater Than the First?"
Good summary: "The Tzemach Tzedek writes that Pesach Sheini, the make-up Pesach for those who missed the first, is in a sense higher than the original. The Rebbe asks how a make-up can be higher, and explains: as a correction for the missed offering it comes second, but in other respects it stands above the first."
Bad title: "Pesach Sheini: Yesod and Malchus" (insider terms, says nothing to most listeners).

Use standard Chabad English transliteration (Moshiach, Geulah, mitzvos, Shabbos, Rebbe, Chassidus, davening).
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
    heading ? `\nThe outline's own heading (written by the archive's editors): «${heading}». Use it as title_he (verbatim or lightly shortened). It tells you the subject; phrase title_en naturally, not as a literal translation.` : null,
    `\nLength limits for this track: summary at most ${budget.summaryWords} words; ` +
      (budget.points > 1 ? `at most ${budget.points} key points (one per outline point).` : 'no key points (single-point outline).'),
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
