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
          content: `This is a full transcript of a farbrengen (chassidic gathering), containing multiple sichos (talks) separated by markers like "שיחה א'", "שיחה ב'", "שיחה ג'" etc, and possibly ma'amarim.

Split this into its individual sichos/sections. For each one, identify:
- Its marker/number (e.g. "שיחה א'")
- A short title summarizing its topic (in English, one line)
- The full Hebrew text of that section

Respond ONLY with valid JSON in this exact format, no other text:
[
  {"marker": "שיחה א'", "titleEn": "short English summary", "text": "full hebrew text of this section"},
  {"marker": "שיחה ב'", "titleEn": "short English summary", "text": "full hebrew text of this section"}
]

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

    let segments;
    try {
      segments = JSON.parse(raw);
    } catch (parseErr) {
      return res.status(200).json({ error: 'Could not parse Claude response as JSON', raw });
    }

    res.status(200).json({ segments, count: segments.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
