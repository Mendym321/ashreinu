// Saves segmented+tagged sichos into the farbrengen_texts table, keyed to
// a farbrengen. Overwrites any existing segments for that farbrengen so
// re-running the pipeline on the same date is safe.
// POST body: { farbrengenId, hebrewYear, hebrewMonth, hebrewDay, driveFileId, sourceType, segments: [...] }

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { farbrengenId, hebrewYear, hebrewMonth, hebrewDay, driveFileId, sourceType, segments } = req.body;

  if (!farbrengenId || !segments?.length) {
    return res.status(400).json({ error: 'Missing farbrengenId or segments' });
  }

  try {
    // Clear any existing saved segments for this farbrengen first
    await supabase.from('farbrengen_texts').delete().eq('farbrengen_id', farbrengenId);

    const rows = segments
      .filter(s => s.text) // skip any segment that failed to locate its text
      .map((s, i) => ({
        farbrengen_id: farbrengenId,
        hebrew_year: hebrewYear || null,
        hebrew_month: hebrewMonth || null,
        hebrew_day: hebrewDay || null,
        segment_order: i + 1,
        title_en: s.titleEn || null,
        summary_en: s.summaryEn || null,
        tags: s.tags || [],
        source_type: sourceType || 'toras_menachem',
        source_text: s.text,
        drive_file_id: driveFileId || null
      }));

    const { error } = await supabase.from('farbrengen_texts').insert(rows);
    if (error) return res.status(500).json({ error: error.message });

    res.status(200).json({ saved: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
