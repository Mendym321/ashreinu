// Extracts and returns the actual text content of a Drive PDF,
// so we can see whether it's real selectable text or a scanned image
// (scans come back empty or garbled since there's no text layer).
// Usage: /api/test-pdf-text?id=FILE_ID

import pdf from 'pdf-parse/lib/pdf-parse.js';

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ?id=' });

  const url = `https://drive.google.com/uc?export=download&id=${id}`;

  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return res.status(502).json({ error: `Drive returned ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());

    const data = await pdf(buf);

    res.status(200).json({
      pageCount: data.numpages,
      textLength: data.text.length,
      textPreview: data.text.slice(0, 1000),
      hasRealText: data.text.trim().length > 50
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
