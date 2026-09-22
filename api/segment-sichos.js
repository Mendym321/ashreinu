// Takes a full farbrengen transcript and asks Claude to split it into
// individual sichos by locating markers like שיחה א', שיחה ב', etc.
// POST body: { text: "full transcript..." }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text in body' });

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: `This is a full transcript of a farbrengen (chassidic gathering) from Toras Menachem / Sichos Kodesh. It's written as one continuous flow, internally divided into numbered points (א, ב, ג, ד...) — but those numbers are NOT sicha boundaries, just points within whatever sicha they fall in.

The ONLY structural marker is a line containing just "* * *" (sometimes rendered as "***" or "— • —" due to OCR/formatting). This marker is used for exactly two things, nothing else:

1. A boundary into a NEW SICHA — the numbered points simply continue as if starting fresh (often back at א, or sometimes continuing the letter sequence — check what actually happens in this document).
2. A short bracketed note that a MA'AMAR was said, itself surrounded by "* * *" on both sides (i.e. "* * *" then a brief note like the ma'amar's title, then "* * *" again) — after which a new sicha begins.

IMPORTANT: niggunim (musical interludes) are NEVER marked by "* * *". They may appear as a bracketed aside like "[כ"ק אדמו"ר שליט"א צוה לנגן ניגון]" INSIDE a sicha's flow, or not be mentioned in the text at all. Do not treat any niggun mention as a boundary — ignore it completely for this task.

Find every single "* * *" in the text — scan the ENTIRE document carefully, don't stop after finding a few — and classify each one as either "new sicha" or "maamar note". Report them in chronological order.

For each TRUE sicha boundary (not the maamar note itself, but the sicha that starts after it), report:
- The first ~8 words of Hebrew text right after that boundary, EXACTLY as written (so we can locate it in the source text ourselves)
- A short English summary of what that sicha covers

Respond ONLY with valid JSON, no other text:
[
  {"firstWords": "exact first few Hebrew words", "titleEn": "short English summary"},
  {"firstWords": "exact first few Hebrew words", "titleEn": "short English summary"}
]

The first sicha always starts at the very beginning of the document, even though there's no "* * *" before it — include it as the first entry.

Here is the transcript:

${text}`
        }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return res.status(502).json({ error: `Claude API error: ${claudeRes.status}`, detail: errText.slice(0, 500) });
    }

    const claudeData = await claudeRes.json();
    let raw = claudeData.content?.[0]?.text || '[]';
    raw = raw.replace(/```json|```/g, '').trim();

    let boundaries;
    try {
      boundaries = JSON.parse(raw);
    } catch (parseErr) {
      return res.status(200).json({ error: 'Could not parse Claude response as JSON', raw });
    }

    // Splice the actual text ourselves using the firstWords markers Claude found,
    // rather than trusting Claude to reproduce long text verbatim (which hits
    // token limits and risks subtle errors in transcription).
    //
    // Exact matching is fragile: the transcript may have inline footnote markers,
    // markdown bold, or OCR letter variations that Claude's "clean" quote doesn't
    // include. So we try progressively shorter prefixes of firstWords until one
    // matches, always searching forward from the previous boundary to keep order correct.
    function findBoundary(haystack, firstWords, searchFrom) {
      const words = firstWords.trim().split(/\s+/);
      for (let n = words.length; n >= 1; n--) {
        const candidate = words.slice(0, n).join(' ');
        const idx = haystack.indexOf(candidate, searchFrom);
        if (idx !== -1) return idx;
      }
      return -1;
    }

    const segments = [];
    let searchFrom = 0;
    for (let i = 0; i < boundaries.length; i++) {
      const b = boundaries[i];
      const startIdx = findBoundary(text, b.firstWords, searchFrom);
      if (startIdx === -1) {
        segments.push({ ...b, text: null, warning: 'Could not locate even a short prefix of firstWords in source text' });
        continue;
      }
      const nextB = boundaries[i + 1];
      let endIdx = text.length;
      if (nextB) {
        const nextIdx = findBoundary(text, nextB.firstWords, startIdx + 1);
        if (nextIdx !== -1) endIdx = nextIdx;
      }
      segments.push({ ...b, text: text.slice(startIdx, endIdx).trim() });
      searchFrom = startIdx + 1;
    }

    res.status(200).json({ segments, count: segments.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
