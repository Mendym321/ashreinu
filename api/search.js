import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { q = '', type = '', year = '', month = '', limit = '200', dates = '', distinct = '' } = req.query;

  // Special mode: return distinct Hebrew years present in the data, for the
  // "Browse by year" homepage row. Fetches years in manageable pages rather
  // than every row, since we only need the distinct set.
  if (distinct === 'years') {
    const { data, error } = await supabase
      .from('ashreinu_events')
      .select('hebrew_year')
      .eq('type', 'Farbrengen')
      .not('hebrew_year', 'is', null)
      .order('hebrew_year', { ascending: false })
      .limit(2000);
    if (error) return res.status(500).json({ error: error.message });
    const years = [...new Set(data.map(r => r.hebrew_year))];
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({ years });
  }

  let query = supabase.from('ashreinu_events').select('*', { count: 'exact' }).limit(parseInt(limit, 10));

  if (q) {
    const safe = q.replace(/[%_]/g, '');
    query = query.or(`name.ilike.%${safe}%,parent_name.ilike.%${safe}%`);
  }
  if (type === 'sicha') query = query.ilike('type', '%sicha%');
  else if (type === 'maamar') query = query.ilike('type', '%maamar%');
  else if (type === 'farbrengen') query = query.eq('type', 'Farbrengen');
  else if (type === 'niggun') query = query.ilike('type', '%niggun%');

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

  query = query.order('secular_year', { ascending: false, nullsFirst: false });

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.setHeader('Cache-Control', 's-maxage=30');
  res.status(200).json({ results: data, count });
}
