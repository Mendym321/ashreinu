// Fetches saved written segments for a farbrengen, for the "read along"
// panel in the search UI.
// Usage: /api/get-farbrengen-text?farbrengenId=X

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { farbrengenId } = req.query;
  if (!farbrengenId) return res.status(400).json({ error: 'Missing farbrengenId' });

  try {
    const { data, error } = await supabase
      .from('farbrengen_texts')
      .select('*')
      .eq('farbrengen_id', farbrengenId)
      .order('segment_order', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    res.setHeader('Cache-Control', 's-maxage=300');
    res.status(200).json({ segments: data, hasText: data.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
