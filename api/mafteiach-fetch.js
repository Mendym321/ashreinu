// Diagnostic: fetches a Mafteiach page for a given Hebrew date and returns
// the raw HTML so we can see its real structure before writing a parser.
// Usage: /api/mafteiach-fetch?year=5715&month=3&day=19

export default async function handler(req, res) {
  const { year, month, day } = req.query;
  if (!year || !month || !day) return res.status(400).json({ error: 'Missing ?year= &month= &day=' });

  const url = `https://www.mafteiach.app/all/${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;

  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) return res.status(502).json({ error: `Mafteiach returned ${r.status}`, url });
    const html = await r.text();

    // Pull out just the parts likely to contain Drive links and labels,
    // so the response isn't the whole page's CSS/JS noise.
    const driveLinks = [...html.matchAll(/<a[^>]+href="(https:\/\/drive\.google\.com[^"]+)"[^>]*>([^<]*)<\/a>/g)]
      .map(m => ({ url: m[1], label: m[2] }));

    const h5Labels = [...html.matchAll(/<h5[^>]*>([^<]*)<\/h5>/g)].map(m => m[1]);

    res.status(200).json({
      fetchedUrl: url,
      htmlLength: html.length,
      driveLinksFound: driveLinks.length,
      driveLinks,
      h5Labels,
      // include a chunk of raw HTML too, in case the regexes above miss the real structure
      rawHtmlSample: html.slice(html.indexOf('drive.google') > 500 ? html.indexOf('drive.google') - 500 : 0, html.indexOf('drive.google') + 1500)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
