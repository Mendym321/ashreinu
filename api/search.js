import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { q = '', type = '', year = '', month = '', limit = '200' } = req.query;

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

  query = query.order('secular_year', { ascending: false, nullsFirst: false });

  const { data, error, count } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.setHeader('Cache-Control', 's-maxage=30');
  res.status(200).json({ results: data, count });
}
