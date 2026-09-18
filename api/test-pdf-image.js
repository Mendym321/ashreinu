// Tests Drive's stable thumbnail/render endpoint — gives us a real rendered
// image of the PDF page, sidestepping the broken font-encoding problem
// entirely since we'll read this visually instead of extracting text codes.
// Usage: /api/test-pdf-image?id=FILE_ID

export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing ?id=' });

  const url = `https://drive.google.com/thumbnail?id=${id}&sz=w2000`;

  try {
    const r = await fetch(url, { redirect: 'follow' });
    const contentType = r.headers.get('content-type') || '';

    if (!r.ok) {
      return res.status(200).json({ result: 'failed', status: r.status, contentType });
    }

    const buf = await r.arrayBuffer();

    // If the caller wants the actual image, stream it back directly
    if (req.query.raw === '1') {
      res.setHeader('Content-Type', contentType);
      return res.send(Buffer.from(buf));
    }

    // Otherwise just report what we got
    res.status(200).json({
      result: 'success',
      contentType,
      byteLength: buf.byteLength,
      isImage: contentType.startsWith('image/')
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
