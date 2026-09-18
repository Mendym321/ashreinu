// Returns how many pages a Drive PDF has, so the transcriber knows how
// many pages to loop through.
// Usage: /api/pdf-info?id=FILE_ID

import { getDocumentProxy } from 'unpdf';

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ?id=' });

  try {
    const r = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, { redirect: 'follow' });
    if (!r.ok) return res.status(502).json({ error: `Drive fetch failed: ${r.status}` });
    const buf = new Uint8Array(await r.arrayBuffer());

    const pdf = await getDocumentProxy(buf);
    res.status(200).json({ totalPages: pdf.numPages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
