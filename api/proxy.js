const ASHREINU = 'https://5qlaecnhel.execute-api.us-east-1.amazonaws.com/prod/ashreinu/api/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path, audio } = req.query;

  // Audio proxy: /api/proxy?audio=https://dtgj2yu3gmlic.cloudfront.net/FILE.opus
  if (audio) {
    try {
      const r = await fetch(audio);
      if (!r.ok) return res.status(r.status).end();
      const contentType = audio.endsWith('.opus')
        ? 'audio/ogg; codecs=opus'
        : 'audio/mpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 's-maxage=86400');
      res.setHeader('Accept-Ranges', 'bytes');
      const buf = await r.arrayBuffer();
      return res.send(Buffer.from(buf));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // API proxy: /api/proxy?path=/event/3971
  if (!path) return res.status(400).json({ error: 'Missing path or audio param' });

  try {
    const r = await fetch(`${ASHREINU}${path}`);
    if (!r.ok) return res.status(r.status).json({ error: `Upstream ${r.status}` });
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=3600');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
