const ASHREINU = 'https://5qlaecnhel.execute-api.us-east-1.amazonaws.com/prod/ashreinu/api/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path' });

  try {
    const r = await fetch(`${ASHREINU}${path}`);
    if (!r.ok) return res.status(r.status).json({ error: `Upstream ${r.status}` });
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=3600'); // cache for 1 hour on Vercel's CDN
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
