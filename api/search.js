import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { q = '', type = '', year = '', month = '', limit = '200', dates = '', distinct = '', parentId = '' } = req.query;

  // Special mode: return the actual audio children of a farbrengen, in
  // recording order — Sicha 1, Nigun 1, Sicha 2... — for the assignment
  // tool that maps written segments to specific audio tracks.
  if (parentId) {
    const { data, error } = await supabase
      .from('ashreinu_events')
      .select('id, name, type, duration_ms')
      .eq('parent_id', parseInt(parentId, 10))
      .order('id', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ results: data });
  }

  // Special mode: return every event ID currently in our database, so a
  // gap-finder tool can diff against the full 1–14000 range and discover
  // exactly which IDs were missed (e.g. from rate-limiting during the
  // original bulk scan) without re-scanning everything from scratch.
  // Supabase's PostgREST layer caps any single query at a default max-rows
  // limit (commonly 1000) regardless of what .limit() the client requests —
  // so we page through in batches of 1000 to get the true full set.
  if (distinct === 'allIds') {
    let allIds = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('ashreinu_events')
        .select('id')
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) return res.status(500).json({ error: error.message });
      allIds.push(...data.map(r => r.id));
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    // No caching here — this is a diagnostic tool that needs the current
    // truth, not a stale snapshot from mid-recovery.
    return res.status(200).json({ ids: allIds });
  }

  // Special mode: return distinct Hebrew years present in the data, for the
  // "Browse by year" homepage row — earliest first, so the scroll reads
  // left-to-right in real chronological order.
  if (distinct === 'years') {
    let allYears = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('ashreinu_events')
        .select('hebrew_year')
        .eq('type', 'Farbrengen')
        .not('hebrew_year', 'is', null)
        .order('hebrew_year', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) return res.status(500).json({ error: error.message });
      allYears.push(...data.map(r => r.hebrew_year));
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    const years = [...new Set(allYears)].sort((a, b) => a - b);
    return res.status(200).json({ years });
  }

  let query = supabase.from('ashreinu_events').select('*', { count: 'exact' }).limit(parseInt(limit, 10));

  // Tag search: if the query text matches a saved tag on any farbrengen's
  // written text, fold that whole farbrengen (and all its sub-events) into
  // the results too, alongside ordinary name matches.
  let tagFarbrengenIds = [];
  if (q) {
    const safe = q.replace(/[%_]/g, '');
    try {
      const { data: tagMatches } = await supabase
        .from('farbrengen_texts')
        .select('farbrengen_id')
        .contains('tags', [safe.toLowerCase()]);
      tagFarbrengenIds = [...new Set((tagMatches || []).map(r => r.farbrengen_id))];
    } catch (e) { /* tags table may not have matches — fine, just skip */ }

    if (tagFarbrengenIds.length) {
      const idList = tagFarbrengenIds.join(',');
      query = query.or(`name.ilike.%${safe}%,parent_name.ilike.%${safe}%,id.in.(${idList}),parent_id.in.(${idList})`);
    } else {
      query = query.or(`name.ilike.%${safe}%,parent_name.ilike.%${safe}%`);
    }
  }

  // Type matching: Ashreinu's real field spellings are "Nigun" (one g) and
  // "Ma'amar" (with an apostrophe) — plain substring checks were missing both.
  if (type === 'sicha') query = query.ilike('type', '%sicha%');
  else if (type === 'maamar') query = query.or(`type.ilike.%ma'amar%,type.ilike.%maamar%`);
  else if (type === 'farbrengen') query = query.eq('type', 'Farbrengen');
  else if (type === 'nigun') query = query.ilike('type', '%nigun%');

  if (year) query = query.eq('hebrew_year', parseInt(year, 10));
  if (month) query = query.eq('hebrew_month_name', month);

  // Collections: a named occasion (e.g. Sukkos) maps to a specific set of
  // [month,day] pairs, possibly spanning more than one Hebrew month (like
  // Chanukah crossing from Kislev into Tevet). Matches any of them, any year.
  if (dates) {
    try {
      const pairs = JSON.parse(dates); // [[month,day], [month,day], ...]
      if (Array.isArray(pairs) && pairs.length) {
        const orClause = pairs.map(([m, d]) => `and(hebrew_month.eq.${m},hebrew_day.eq.${d})`).join(',');
        query = query.or(orClause);
      }
    } catch (e) { /* ignore malformed dates param */ }
  }

  // Chronological order: earliest year first, and within the same day, in
  // the order events actually happened (id is sequential in recording order
  // — Sicha 1, Nigun 1, Sicha 2... in the sequence they occurred).
  query = query
    .order('hebrew_year', { ascending: true, nullsFirst: false })
    .order('hebrew_month', { ascending: true, nullsFirst: false })
    .order('hebrew_day', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });

  // Filter out "phantom" entries: a non-Farbrengen row (a Sicha/Nigun/
  // Ma'amar) with no audio at all isn't legitimate content — it's a
  // draft/orphaned record from Ashreinu's raw data that never actually
  // went live in their own app. A real Farbrengen container is fine with
  // no audio of its own (its children carry it) — only exclude the rest.
  query = query.or('type.eq.Farbrengen,audio_uri.not.is.null');

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.setHeader('Cache-Control', 's-maxage=30');
  res.status(200).json({ results: data, count });
}
