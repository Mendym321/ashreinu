import { createClient } from '@supabase/supabase-js';

const ASHREINU = 'https://5qlaecnhel.execute-api.us-east-1.amazonaws.com/prod/ashreinu/api/v1';

function supa() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function toRow(ev, parentId, parentName) {
  const d = ev.dates?.[0] || {};
  const audio = ev.audio_recordings?.[0];
  const uri = audio?.assets?.[0]?.uri || null;
  return {
    id: ev.id,
    parent_id: parentId ?? ev.parent_id ?? null,
    parent_name: parentName ?? null,
    name: ev.name || null,
    type: ev.type || null,
    hebrew_year: d.hebrew_year ?? null,
    hebrew_month: d.hebrew_month ?? null,
    hebrew_day: d.hebrew_day ?? null,
    hebrew_month_name: d.hebrew_month_name ?? null,
    secular_year: d.secular_year ?? null,
    secular_month: d.secular_month ?? null,
    secular_day: d.secular_day ?? null,
    duration_ms: ev.audio_recordings_duration ?? audio?.duration ?? null,
    audio_uri: uri,
    restored: ev.restored ?? null,
    has_transcript: ev.has_transcript ?? null,
    raw_data: ev,
    updated_at: new Date().toISOString()
  };
}

export default async function handler(req, res) {
  const start = parseInt(req.query.start || '1', 10);
  const end = parseInt(req.query.end || String(start + 200), 10);
  const CHUNK = 5;

  let farbrengens = 0, notFound = 0, errors = 0;
  const rows = [];

  for (let s = start; s <= end; s += CHUNK) {
    const batch = [];
    for (let id = s; id < Math.min(s + CHUNK, end + 1); id++) batch.push(id);

    const results = await Promise.all(batch.map(async id => {
      try {
        const r = await fetch(`${ASHREINU}/event/${id}`);
        if (r.status === 404) { notFound++; return null; }
        if (!r.ok) { errors++; return null; }
        const j = await r.json();
        return j?.data || j || null;
      } catch { errors++; return null; }
    }));

    results.forEach(ev => {
      if (!ev?.id) return;
      if (ev.parent_id !== null && ev.parent_id !== undefined) return;
      farbrengens++;
      rows.push(toRow(ev, null, null));
      (ev.sub_events || []).forEach(se => {
        rows.push(toRow(se, ev.id, ev.name));
      });
    });

    await new Promise(r => setTimeout(r, 250));
  }

  let upserted = 0;
  if (rows.length) {
    const supabase = supa();
    const { error } = await supabase.from('ashreinu_events').upsert(rows, { onConflict: 'id' });
    if (error) return res.status(500).json({ error: error.message, range: [start, end] });
    upserted = rows.length;
  }

  res.status(200).json({ range: [start, end], farbrengens, upserted, notFound, errors });
}
