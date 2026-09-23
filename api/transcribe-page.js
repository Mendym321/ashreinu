// Renders one specific page of a Drive PDF as an image, then sends it to
// Claude to transcribe. This is the real per-page pipeline — replaces the
// Drive-thumbnail approach, which only ever gave us page 1.
// Usage: /api/transcribe-page?id=FILE_ID&page=N

import { renderPageAsImage } from 'unpdf';

export default async function handler(req, res) {
  const { id, page, context } = req.query;
  if (!id || !page) return res.status(400).json({ error: 'Missing ?id= or ?page=' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const pageNum = parseInt(page, 10);

  try {
    // Step 1: download the PDF bytes
    const r = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, { redirect: 'follow' });
    if (!r.ok) return res.status(502).json({ error: `Drive fetch failed: ${r.status}` });
    const buf = new Uint8Array(await r.arrayBuffer());

    // Step 2: render just this page as a PNG image
    const imgBuffer = await renderPageAsImage(buf, pageNum, {
      canvasImport: () => import('@napi-rs/canvas'),
      scale: 2.0
    });
    const base64Image = Buffer.from(imgBuffer).toString('base64');

    // Step 3: send that page image to Claude for transcription
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Image } },
            {
              type: 'text',
              text: (context
                ? `For context only (do NOT repeat this in your output) — here is the end of the previous page, which may help you correctly read an ambiguous letter or word at the very top of this page (page-top headers have no surrounding sentence context, which can cause letters that look similar in this script — like ת and ח — to be misread):\n\n"...${context}"\n\n`
                : '') +
                'Transcribe this Hebrew document page exactly as written, preserving line breaks, punctuation, footnote markers, and section markers (like שיחה א׳, אות, etc). Output only the transcribed text, nothing else.'
            }
          ]
        }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return res.status(502).json({ error: `Claude API error: ${claudeRes.status}`, detail: errText.slice(0, 500) });
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.[0]?.text || '';

    res.status(200).json({ page: pageNum, text });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 500) });
  }
}
