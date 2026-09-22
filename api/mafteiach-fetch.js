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
    const rawHtml = await r.text();

    // The page embeds this markup as an escaped JS string (quotes appear as
    // literal \" and slashes as \/) — unescape before parsing.
    const html = rawHtml.replace(/\\"/g, '"').replace(/\\\//g, '/');

    // Find the "בלתי מוגה" (unedited/raw) section specifically — that's the
    // source type we want, as distinct from "מוגה" (edited) or "מאמרים".
    const biltiIdx = html.indexOf('בלתי מוגה');
    if (biltiIdx === -1) {
      return res.status(200).json({ fetchedUrl: url, foundBiltiMugahSection: false, note: 'No בלתי מוגה section on this page — may only have מוגה or מאמרים, or this date has no farbrengen at all.' });
    }

    // Bound the section: stop at the next box's button (מוגה) so we don't
    // sweep in unrelated links from other sections.
    const nextBoxIdx = html.indexOf('muga-sichos-button', biltiIdx + 50);
    const bilti = nextBoxIdx === -1 ? html.slice(biltiIdx, biltiIdx + 1500) : html.slice(biltiIdx, nextBoxIdx);

    const urlPattern = /https:\/\/drive\.google\.com\/[^\s"'<>]+/g;
    const rawUrls = [...bilti.matchAll(urlPattern)].map(m => m[0]);

    const linksWithLabels = rawUrls.map(url => {
      const urlIdx = bilti.indexOf(url);
      const after = bilti.slice(urlIdx, urlIdx + 200);
      const labelMatch = after.match(/>([^<]{1,60})<\/a>/);
      return { url, label: labelMatch ? labelMatch[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'") : null };
    });

    res.status(200).json({
      fetchedUrl: url,
      foundBiltiMugahSection: true,
      driveLinksInBiltiSection: linksWithLabels
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
