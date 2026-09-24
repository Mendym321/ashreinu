// Finds the Ashreinu farbrengen event id for an exact Hebrew date, so the
// finder tool only needs a date, not a manually-looked-up numeric id.
// Usage: /api/find-farbrengen?year=5712&month=3&day=19

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { year, month, day } = req.query;
  if (!year || !month || !day) return res.status(400).json({ error: 'Missing year/month/day' });

  try {
    // Match any TOP-LEVEL event on this date — a proper "Farbrengen" row,
    // or a standalone sicha/ma'amar with no parent (its own container,
    // same as how the Ashreinu app links to it: parentEvent=id&event=id).
    const { data, error } = await supabase
      .from('ashreinu_events')
      .select('id, name, type')
      .eq('hebrew_year', parseInt(year, 10))
      .eq('hebrew_month', parseInt(month, 10))
      .eq('hebrew_day', parseInt(day, 10))
      .is('parent_id', null)
      .limit(5);

    if (error) return res.status(500).json({ error: error.message });
    res.status(200).json({ matches: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
