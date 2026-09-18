// Third attempt: unpdf wraps pdf.js specifically for serverless/edge runtimes
// (Vercel, Cloudflare Workers) and avoids the worker-thread crash that
// plain pdfjs-dist hits outside a browser.
// Usage: /api/test-pdf-text3?id=FILE_ID

import { extractText, getDocumentProxy } from 'unpdf';

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ?id=' });

  const url = `https://drive.google.com/uc?export=download&id=${id}`;

  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return res.status(502).json({ error: `Drive returned ${r.status}` });
    const buf = new Uint8Array(await r.arrayBuffer());

    const pdf = await getDocumentProxy(buf);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });

    res.status(200).json({
      totalPages,
      textLength: text.length,
      textPreview: text.slice(0, 1500)
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 500) });
  }
}
