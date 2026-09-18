// Second attempt at text extraction using pdf.js instead of pdf-parse —
// pdf.js reads the PDF's internal font encoding tables more correctly,
// which matters for older Hebrew PDFs with custom character mappings.
// Usage: /api/test-pdf-text2?id=FILE_ID

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ?id=' });

  const url = `https://drive.google.com/uc?export=download&id=${id}`;

  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return res.status(502).json({ error: `Drive returned ${r.status}` });
    const buf = new Uint8Array(await r.arrayBuffer());

    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    let fullText = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      fullText += pageText + '\n\n';
    }

    res.status(200).json({
      pageCount: doc.numPages,
      textLength: fullText.length,
      textPreview: fullText.slice(0, 1500)
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 500) });
  }
}
