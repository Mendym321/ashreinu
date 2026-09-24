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
  if (distinct === 'allIds') {
    const { data, error } = await supabase
      .from('ashreinu_events')
      .select('id')
      .order('id', { ascending: true })
      .limit(20000);
    if (error) return res.status(500).json({ error: error.message });
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(200).json({ ids: data.map(r => r.id) });
  }

  // Special mode: return distinct Hebrew years present in the data, for the
  // "Browse by year" homepage row — earliest first, so the scroll reads
  // left-to-right in real chronological order.
  if (distinct === 'years') {
    const { data, error } = await supabase
      .from('ashreinu_events')
      .select('hebrew_year')
      .eq('type', 'Farbrengen')
      .not('hebrew_year', 'is', null)
      .order('hebrew_year', { ascending: true })
      .limit(2000);
    if (error) return res.status(500).json({ error: error.message });
    const years = [...new Set(data.map(r => r.hebrew_year))];
    res.setHeader('Cache-Control', 's-maxage=3600');
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

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.setHeader('Cache-Control', 's-maxage=30');
  res.status(200).json({ results: data, count });
}
