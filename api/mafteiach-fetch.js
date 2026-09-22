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

    // Find the "בלתי מוגה" (unedited/raw) section specifically — that's the
    // source type we want, as distinct from "מוגה" (edited) or "מאמרים".
    const biltiIdx = html.indexOf('בלתי מוגה');
    const bilti = biltiIdx === -1 ? html : html.slice(biltiIdx, biltiIdx + 3000);

    // Grab every Drive URL directly, regardless of exact surrounding tag
    // structure or quoting style — much more robust than matching <a> tags.
    const urlPattern = /https:\/\/drive\.google\.com\/[^\s"'<>\\]+/g;
    const rawUrls = [...bilti.matchAll(urlPattern)].map(m => m[0]);

    // For each URL, grab the link text that follows it (between > and <)
    const linksWithLabels = rawUrls.map(url => {
      const urlIdx = bilti.indexOf(url);
      const after = bilti.slice(urlIdx, urlIdx + 300);
      const labelMatch = after.match(/>([^<]{1,60})<\/a>/);
      return { url, label: labelMatch ? labelMatch[1] : null };
    });

    res.status(200).json({
      fetchedUrl: url,
      htmlLength: html.length,
      foundBiltiMugahSection: biltiIdx !== -1,
      driveLinksInBiltiSection: linksWithLabels,
      biltiSectionSample: bilti.slice(0, 1200)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
