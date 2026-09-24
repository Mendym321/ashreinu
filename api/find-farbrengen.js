// Finds the Ashreinu top-level event id for an exact Hebrew date, so the
// finder tool only needs a date, not a manually-looked-up numeric id.
// Usage: /api/find-farbrengen?year=5712&monthName=Kislev&day=19

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { year, monthName, day } = req.query;
  if (!year || !monthName || !day) return res.status(400).json({ error: 'Missing year/monthName/day' });

  try {
    // Match on the month NAME (text) rather than our internal month number —
    // sidesteps any leap-year numbering ambiguity entirely. Also don't
    // require parent_id to be null here: fetch every event on this date,
    // then prefer a real "Farbrengen" row, then any standalone top-level
    // event (a solo sicha/ma'amar with no parent), in that order.
    const { data, error } = await supabase
      .from('ashreinu_events')
      .select('id, name, type, parent_id')
      .eq('hebrew_year', parseInt(year, 10))
      .eq('hebrew_month_name', monthName)
      .eq('hebrew_day', parseInt(day, 10))
      .limit(20);

    if (error) return res.status(500).json({ error: error.message });

    const farbrengen = data.find(r => r.type === 'Farbrengen');
    const standalone = data.find(r => r.parent_id === null);
    const best = farbrengen || standalone || data[0] || null;

    res.status(200).json({ matches: best ? [best] : [], allOnThisDate: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
