// Temporary test endpoint: fetches a Drive PDF and returns basic info
// so we can see whether the file is public and what format Drive serves it in.
// Usage: /api/test-pdf?id=1ixyOc0rSNdsiEIW6JJcnTgPjWPrlPcIE

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ?id=' });

  const url = `https://drive.google.com/uc?export=download&id=${id}`;

  try {
    const r = await fetch(url, { redirect: 'follow' });
    const contentType = r.headers.get('content-type') || '';
    const contentLength = r.headers.get('content-length') || 'unknown';

    // If Drive serves an HTML "confirm download" page instead of the file
    // (happens for large files or ones needing a virus-scan bypass token),
    // we need to detect that rather than treat it as PDF bytes.
    if (contentType.includes('text/html')) {
      const text = await r.text();
      const snippet = text.slice(0, 500);
      return res.status(200).json({
        result: 'got_html_not_pdf',
        contentType,
        finalUrl: r.url,
        snippet
      });
    }

    const buf = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF

    res.status(200).json({
      result: isPdf ? 'got_real_pdf' : 'got_unknown_binary',
      contentType,
      contentLength,
      byteLength: buf.byteLength,
      finalUrl: r.url
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
