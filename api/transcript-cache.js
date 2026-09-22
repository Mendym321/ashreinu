// Reads or writes the cached raw transcript for a farbrengen, so the
// transcription step (the expensive Claude vision calls) never has to
// run twice for the same document.
// GET  /api/transcript-cache?farbrengenId=X          -> { cached: bool, fullText, pageCount }
// POST /api/transcript-cache { farbrengenId, driveFileId, pageCount, fullText } -> saves it

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (req.method === 'GET') {
    const { farbrengenId } = req.query;
    if (!farbrengenId) return res.status(400).json({ error: 'Missing farbrengenId' });

    const { data, error } = await supabase
      .from('raw_transcripts')
      .select('*')
      .eq('farbrengen_id', farbrengenId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(200).json({ cached: false });

    return res.status(200).json({ cached: true, fullText: data.full_text, pageCount: data.page_count, driveFileId: data.drive_file_id });
  }

  if (req.method === 'POST') {
    const { farbrengenId, driveFileId, pageCount, fullText } = req.body;
    if (!farbrengenId || !fullText) return res.status(400).json({ error: 'Missing farbrengenId or fullText' });

    const { error } = await supabase
      .from('raw_transcripts')
      .upsert({ farbrengen_id: farbrengenId, drive_file_id: driveFileId, page_count: pageCount, full_text: fullText });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ saved: true });
  }

  res.status(405).json({ error: 'GET or POST only' });
}
