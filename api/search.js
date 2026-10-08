import { createClient } from '@supabase/supabase-js';
import { understandQuery } from '../lib/searchQuery.js';
import { groupNiggunim, niggunKey, niggunTitle } from '../lib/niggunim.js';

// Fields the app needs for a track row (not raw_data, which is large).
const ROW_FIELDS = 'id, parent_id, parent_name, name, type, hebrew_year, hebrew_month, hebrew_day, hebrew_month_name, secular_year, secular_month, secular_day, duration_ms, audio_uri, pics:raw_data->pictures, desc:raw_data->>description';

// JEM photos from the event itself (Ashreinu has them for about a quarter of
// farbrengens), as covers: 300px for cards, 900px for the big player. The
// large raw_data is dropped from what's sent to the app.
function attachPhotos(rows) {
  for (const row of rows) {
    if (row.desc === undefined) row.desc = row.raw_data?.description || null;
    const pics = row.pics || row.raw_data?.pictures || [];
    const pic = pics.find(p => p?.urls?.['300px'] && !p.video_still) || pics.find(p => p?.urls?.['300px']);
    if (pic) { row.photo = pic.urls['300px']; row.photo_lg = pic.urls['900px'] || pic.urls['300px']; }
    delete row.pics; delete row.raw_data;
  }
}

async function loadTopics(supabase) {
  const { data, error } = await supabase.from('topics').select('slug, name_en, name_he, parent_slug, aliases, description, sort').eq('active', true).order('sort');
  return error ? [] : data;
}

// Same filters as the main list (type chips, year, month, occasion dates).
function applyFilters(query, { type, year, month, dates }) {
  if (type === 'sicha') query = query.ilike('type', '%sicha%');
  else if (type === 'maamar') query = query.or(`type.ilike.%ma'amar%,type.ilike.%maamar%`);
  else if (type === 'farbrengen') query = query.eq('type', 'Farbrengen');
  else if (type === 'nigun') query = query.ilike('type', '%nigun%');
  if (year) query = query.eq('hebrew_year', parseInt(year, 10));
  if (month) query = query.eq('hebrew_month_name', month);
  if (dates) {
    try {
      const pairs = JSON.parse(dates);
      if (Array.isArray(pairs) && pairs.length) query = query.or(pairs.map(([m, d]) => `and(hebrew_month.eq.${+m},hebrew_day.eq.${+d})`).join(','));
    } catch (e) { /* ignore malformed dates */ }
  }
  return query;
}

// Catalogued talks for an occasion: those said on its days (any year), plus
// those tagged with it though said on another date. The date is a fact, so a
// talk given on Sukkos stays on the Sukkos shelf whatever its tags say.
async function occasionTalks(supabase, occasion, dates) {
  const onDays = [];
  if (dates) {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await applyFilters(supabase.from('ashreinu_events').select('id').not('audio_uri', 'is', null).not('parent_id', 'is', null), { dates })
        .order('id').range(from, from + 999);
      if (error) throw new Error(error.message);
      onDays.push(...data.map(r => r.id));
      if (data.length < 1000) break;
    }
  }
  const catalogued = [];
  for (let i = 0; i < onDays.length; i += 200) {
    const { data, error } = await supabase.from('track_metadata').select('ashreinu_event_id').eq('status', 'enriched').in('ashreinu_event_id', onDays.slice(i, i + 200));
    if (error) throw new Error(error.message);
    catalogued.push(...data.map(r => r.ashreinu_event_id));
  }
  const { data: tagged, error } = await supabase.from('track_metadata').select('ashreinu_event_id').eq('status', 'enriched').contains('occasions', [occasion]).limit(100);
  if (error) throw new Error(error.message);
  const ids = [...new Set([...catalogued, ...tagged.map(r => r.ashreinu_event_id)])].slice(0, 100);
  return rowsForIds(supabase, ids, {});
}

// Every recorded niggun track, grouped into niggunim (see lib/niggunim.js).
// Kept for 10 minutes in a warm server, since the list rarely changes.
let niggunCache = null;
async function loadNiggunim(supabase) {
  if (niggunCache && Date.now() - niggunCache.at < 600000) return niggunCache;
  const tracks = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('ashreinu_events').select('id, name, hebrew_year, description:raw_data->>description')
      .ilike('type', '%nigun%').not('audio_uri', 'is', null).order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    tracks.push(...data);
    if (data.length < 1000) break;
  }
  // Tracks a person marked as a niggun in the pipeline page ("Fix a track"),
  // which Ashreinu filed as something else. Renamed ones take the new name;
  // ones marked "not a talk" (silence, a broken recording) leave the list.
  const { data: fixList } = await supabase.from('track_fixes').select('ashreinu_event_id, kind, title');
  const fixes = new Map((fixList || []).map(f => [f.ashreinu_event_id, f]));
  for (let i = tracks.length - 1; i >= 0; i--) {
    const f = fixes.get(tracks[i].id);
    if (f?.kind === 'not_a_talk') tracks.splice(i, 1);
    else if (f?.title) tracks[i] = { ...tracks[i], name: f.title, description: '' };
  }
  const known = new Set(tracks.map(t => t.id));
  const extra = [...fixes.values()].filter(f => f.kind === 'niggun' && f.title && !known.has(f.ashreinu_event_id));
  if (extra.length) {
    const { data } = await supabase.from('ashreinu_events').select('id, hebrew_year').in('id', extra.map(f => f.ashreinu_event_id));
    const yearById = new Map((data || []).map(r => [r.id, r.hebrew_year]));
    for (const f of extra) if (yearById.has(f.ashreinu_event_id)) tracks.push({ id: f.ashreinu_event_id, name: f.title, description: '', hebrew_year: yearById.get(f.ashreinu_event_id) });
  }
  const yearOf = new Map(tracks.map(t => [t.id, t.hebrew_year]));
  const groups = groupNiggunim(tracks).map(g => {
    const years = g.ids.map(id => yearOf.get(id)).filter(Boolean);
    return { ...g, count: g.ids.length, first: years.length ? Math.min(...years) : null, last: years.length ? Math.max(...years) : null };
  });
  niggunCache = { at: Date.now(), groups };
  return niggunCache;
}
// Niggunim whose name matches what's typed ("daled" → Daled Bavos).
function matchNiggunim(groups, q) {
  const k = niggunKey(q), low = String(q || '').toLowerCase().trim();
  if (low.length < 3 || !k) return [];
  return groups.filter(g => g.count >= 2 && (g.key.startsWith(k) || g.name.toLowerCase().includes(low))).slice(0, 4)
    .map(({ slug, name, count }) => ({ key: slug, name, count }));
}

// Every row with audio (id, parent), paged past the 1000-row cap.
// Every whole event (no parent) with a year: id and year.
async function topLevelRows(supabase, narrow) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await narrow(supabase.from('ashreinu_events').select('id, hebrew_year')
      .is('parent_id', null).not('hebrew_year', 'is', null)).order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function audioRows(supabase, narrow) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await narrow(supabase.from('ashreinu_events').select('id, parent_id')
      .not('audio_uri', 'is', null)).order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// Fetch track rows for catalogue ids, keep the given order, attach titles and topics.
async function rowsForIds(supabase, ids, filters) {
  if (!ids.length) return [];
  const { data, error } = await applyFilters(supabase.from('ashreinu_events').select(ROW_FIELDS).in('id', ids), filters);
  if (error) throw new Error(error.message);
  const byId = Object.fromEntries(data.map(r => [r.id, r]));
  const rows = ids.map(id => byId[id]).filter(Boolean);
  await attachConfirmedTitles(supabase, rows);
  return rows;
}

// Ranked catalogue search ("Talks"): precise first (every concept must
// match); if that finds little, widen to any concept and add those below.
async function searchTalks(supabase, q, topics, filters) {
  const u = understandQuery(q, topics);
  if (!u) return { talks: [], matchedTopics: [] };
  const call = (tsq) => supabase.rpc('search_catalogue', { q_simple: tsq, q_english: tsq, q_raw: u.raw, topic_slugs: u.topicSlugs, max_results: 60 });
  const precise = await call(u.all);
  if (precise.error) throw new Error(precise.error.message);
  let hits = precise.data || [];
  if (hits.length < 8 && u.any && u.any !== u.all) {
    const wide = await call(u.any);
    const seen = new Set(hits.map(h => h.ashreinu_event_id));
    hits = [...hits, ...(wide.data || []).filter(h => !seen.has(h.ashreinu_event_id))];
  }
  const talks = await rowsForIds(supabase, hits.map(h => h.ashreinu_event_id), filters);
  const matchedTopics = topics.filter(t => u.topicSlugs.includes(t.slug));
  return { talks: talks.slice(0, 40), matchedTopics };
}

// Attach a real title to each row, so the UI can show it as the main heading
// instead of the generic "Sicha 1" label. A title a human confirmed in
// finder.html (audio_text_links) wins over the catalogue entry Claude wrote
// from Ashreinu's outline (track_metadata).
async function attachConfirmedTitles(supabase, rows) {
  if (!rows.length) return;
  attachPhotos(rows);
  const ids = rows.map(r => r.id);
  const [{ data: links }, { data: catalogue }, { data: fixList }] = await Promise.all([
    supabase.from('audio_text_links').select('ashreinu_event_id, title_en').in('ashreinu_event_id', ids),
    supabase.from('track_metadata').select('ashreinu_event_id, title_en, summary_en, main_topic, topics').eq('status', 'enriched').in('ashreinu_event_id', ids),
    supabase.from('track_fixes').select('ashreinu_event_id, kind, title').in('ashreinu_event_id', ids), // no table yet → no fixes
  ]);
  const fixes = Object.fromEntries((fixList || []).map(f => [f.ashreinu_event_id, f]));
  const verified = Object.fromEntries((links || []).filter(l => l.title_en).map(l => [l.ashreinu_event_id, l.title_en]));
  const cat = Object.fromEntries((catalogue || []).filter(c => c.title_en).map(c => [c.ashreinu_event_id, c]));
  for (const row of rows) {
    // A niggun track named only "Two Nigunim" gets the names Ashreinu lists.
    const niggun = /nigun/i.test(row.type || '') ? niggunTitle(row.name, row.desc) : null;
    row.confirmed_title = verified[row.id] || cat[row.id]?.title_en || niggun || null;
    row.title_source = verified[row.id] ? 'verified' : cat[row.id] ? 'catalogue' : niggun ? 'ashreinu' : null;
    // A fix made by hand in the pipeline page wins over everything.
    const fix = fixes[row.id];
    if (fix) {
      if (fix.kind === 'niggun') row.type = 'Nigun';
      if (fix.title) { row.confirmed_title = fix.title; row.title_source = 'fixed'; }
    }
    if (cat[row.id]) { row.summary_en = cat[row.id].summary_en; row.main_topic = cat[row.id].main_topic; row.other_topics = cat[row.id].topics; }
  }
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { q = '', type = '', year = '', month = '', limit = '200', dates = '', distinct = '', parentId = '', occasion = '', toplevel = '' } = req.query;

  // Newest catalogued talks (home "Newly catalogued" shelf).
  if (req.query.recent) {
    const n = Math.max(1, Math.min(parseInt(req.query.recent, 10) || 12, 40));
    const { data, error } = await supabase.from('track_metadata').select('ashreinu_event_id')
      .eq('status', 'enriched').order('enriched_at', { ascending: false }).limit(n);
    if (error) return res.status(200).json({ results: [] }); // catalogue not set up yet
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(200).json({ results: await rowsForIds(supabase, data.map(r => r.ashreinu_event_id), {}) });
  }

  // A random handful of catalogued talks (home "Talks to explore"), so the
  // home page feels fresh on each visit.
  if (req.query.explore) {
    const n = Math.max(1, Math.min(parseInt(req.query.explore, 10) || 12, 40));
    const ids = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('track_metadata').select('ashreinu_event_id').eq('status', 'enriched').order('ashreinu_event_id').range(from, from + 999);
      if (error) return res.status(200).json({ results: [] }); // catalogue not set up yet
      ids.push(...data.map(r => r.ashreinu_event_id));
      if (data.length < 1000) break;
    }
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(200).json({ results: await rowsForIds(supabase, ids.slice(0, n), {}) });
  }

  // One event's row by id (e.g. a farbrengen opened from one of its tracks).
  if (req.query.event) {
    const { data, error } = await supabase.from('ashreinu_events').select(ROW_FIELDS).eq('id', parseInt(req.query.event, 10)).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (data) await attachConfirmedTitles(supabase, [data]);
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.status(200).json({ result: data || null });
  }

  // Niggunim: the list (sung at least twice, most-sung first), or one
  // niggun's recordings in date order.
  if (req.query.niggunim || req.query.niggun) {
    try {
      const { groups } = await loadNiggunim(supabase);
      res.setHeader('Cache-Control', 's-maxage=600');
      if (req.query.niggunim) {
        return res.status(200).json({ niggunim: groups.filter(g => g.count >= 2).map(({ slug, name, count, first, last }) => ({ key: slug, name, count, first, last })) });
      }
      const wanted = String(req.query.niggun);
      const g = groups.find(x => x.slug === wanted) || groups.find(x => x.key === niggunKey(wanted.replace(/-/g, ' ')));
      if (!g) return res.status(404).json({ error: 'Unknown niggun' });
      const rows = [];
      for (let i = 0; i < g.ids.length; i += 200) {
        const { data, error } = await supabase.from('ashreinu_events').select(ROW_FIELDS).in('id', g.ids.slice(i, i + 200));
        if (error) throw new Error(error.message);
        rows.push(...data);
      }
      await attachConfirmedTitles(supabase, rows);
      rows.sort((a, b) => (a.hebrew_year || 0) - (b.hebrew_year || 0) || (a.hebrew_month || 0) - (b.hebrew_month || 0) || (a.hebrew_day || 0) - (b.hebrew_day || 0) || a.id - b.id);
      return res.status(200).json({ niggun: { key: g.slug, name: g.name, count: g.count, first: g.first, last: g.last }, results: rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // Topic list (the browsing menu), with how many talks each has as main topic.
  if (req.query.topics) {
    const topics = await loadTopics(supabase);
    const counts = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('track_metadata').select('main_topic').eq('status', 'enriched').not('main_topic', 'is', null).range(from, from + 999);
      if (error) break;
      data.forEach(r => { counts[r.main_topic] = (counts[r.main_topic] || 0) + 1; });
      if (data.length < 1000) break;
    }
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.status(200).json({ topics: topics.map(t => ({ ...t, count: counts[t.slug] || 0 })) });
  }

  // Topic page: talks whose MAIN topic it is first, then those where it's secondary.
  if (req.query.topic) {
    const slug = String(req.query.topic);
    const topics = await loadTopics(supabase);
    const topic = topics.find(t => t.slug === slug);
    if (!topic) return res.status(404).json({ error: 'Unknown topic' });
    // A group page (e.g. "Serving G-d") gathers the talks of all its topics.
    const slugs = topic.parent_slug ? [slug] : topics.filter(t => t.parent_slug === slug).map(t => t.slug);
    const [main, other] = await Promise.all([
      supabase.from('track_metadata').select('ashreinu_event_id').eq('status', 'enriched').in('main_topic', slugs).limit(300),
      topic.parent_slug
        ? supabase.from('track_metadata').select('ashreinu_event_id').eq('status', 'enriched').contains('topics', [slug]).limit(200)
        : Promise.resolve({ data: [] }),
    ]);
    if (main.error) return res.status(500).json({ error: main.error.message });
    const mainIds = (main.data || []).map(r => r.ashreinu_event_id);
    const otherIds = (other.data || []).map(r => r.ashreinu_event_id).filter(id => !mainIds.includes(id));
    const filters = { type, year, month, dates };
    const [mainRows, otherRows] = await Promise.all([rowsForIds(supabase, mainIds, filters), rowsForIds(supabase, otherIds, filters)]);
    const chrono = (a, b) => (a.hebrew_year || 0) - (b.hebrew_year || 0) || a.id - b.id;
    res.setHeader('Cache-Control', 's-maxage=120');
    return res.status(200).json({
      topic, subtopics: topic.parent_slug ? [] : topics.filter(t => t.parent_slug === slug),
      main: mainRows.sort(chrono), related: otherRows.sort(chrono),
    });
  }

  // Special mode: return the actual audio children of a farbrengen, in
  // recording order — Sicha 1, Nigun 1, Sicha 2... — for the assignment
  // tool that maps written segments to specific audio tracks, and for the
  // main app's "show all tracks" on a farbrengen.
  if (parentId) {
    const { data, error } = await supabase
      .from('ashreinu_events')
      .select(ROW_FIELDS)
      .eq('parent_id', parseInt(parentId, 10))
      .order('id', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    await attachConfirmedTitles(supabase, data);
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
  // Years that have something to PLAY, each with how many such events it
  // has. An event's year is the WHOLE event's date (a farbrengen's), not a
  // single track's: some tracks carry their own odd dates (5700, 5706...)
  // or belong to no event, and those made empty years appear.
  if (distinct === 'years') {
    let tops, audio;
    try { [tops, audio] = await Promise.all([topLevelRows(supabase, q => q), audioRows(supabase, q => q)]); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    const yearOf = new Map(tops.map(t => [t.id, t.hebrew_year]));
    const events = {}; // year -> Set of event ids
    for (const r of audio) {
      const ev = r.parent_id ?? r.id, y = yearOf.get(ev);
      if (y) (events[y] ||= new Set()).add(ev);
    }
    const years = Object.keys(events).map(Number).sort((a, b) => a - b);
    // One JEM photo per year (from a farbrengen that has one), for its tile.
    const photos = {};
    try {
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from('ashreinu_events').select('id, hebrew_year, pics:raw_data->pictures')
          .is('parent_id', null).eq('type', 'Farbrengen').order('id').range(from, from + 999);
        if (error) throw new Error(error.message);
        for (const r of data) {
          if (photos[r.hebrew_year] || !Array.isArray(r.pics)) continue;
          const pic = r.pics.find(p => p?.urls?.['300px'] && !p.video_still) || r.pics.find(p => p?.urls?.['300px']);
          if (pic) photos[r.hebrew_year] = pic.urls['300px'];
        }
        if (data.length < 1000) break;
      }
    } catch (e) { /* tiles fall back to colour */ }
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({ years, counts: Object.fromEntries(years.map(y => [y, events[y].size])), photos });
  }

  // A year page: every whole event of that year with audio (a farbrengen
  // counts through its tracks), in date order, with its number of tracks.
  if (req.query.year_events) {
    const year = parseInt(req.query.year_events, 10);
    try {
      const tops = await topLevelRows(supabase, q => q.eq('hebrew_year', year));
      const tracks = {}; // event id -> audio tracks inside it; own audio counts as present
      for (let i = 0; i < tops.length; i += 150) {
        const ids = tops.slice(i, i + 150).map(t => t.id).join(',');
        for (const r of await audioRows(supabase, q => q.or(`id.in.(${ids}),parent_id.in.(${ids})`))) {
          const ev = r.parent_id ?? r.id;
          tracks[ev] = (tracks[ev] || 0) + (r.parent_id ? 1 : 0);
        }
      }
      const ids = Object.keys(tracks).map(Number);
      const rows = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from('ashreinu_events').select(ROW_FIELDS).in('id', ids.slice(i, i + 200));
        if (error) throw new Error(error.message);
        rows.push(...data);
      }
      await attachConfirmedTitles(supabase, rows);
      for (const r of rows) r.track_count = tracks[r.id] || 0;
      rows.sort((a, b) => (a.hebrew_month || 0) - (b.hebrew_month || 0) || (a.hebrew_day || 0) - (b.hebrew_day || 0) || a.id - b.id);
      res.setHeader('Cache-Control', 's-maxage=600');
      return res.status(200).json({ year, events: rows });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // Home shelves (toplevel) need only the row fields, not the large raw_data.
  let query = supabase.from('ashreinu_events').select(toplevel ? ROW_FIELDS : '*', { count: 'exact' }).limit(Math.min(parseInt(limit, 10) || 200, 300));

  // Tag search: if the query text matches a saved tag on any farbrengen's
  // written text, fold that whole farbrengen (and all its sub-events) into
  // the results too, alongside ordinary name matches.
  let tagFarbrengenIds = [];
  if (q) {
    const safe = q.replace(/[%_,()]/g, '');
    try {
      const { data: tagMatches } = await supabase
        .from('farbrengen_texts')
        .select('farbrengen_id')
        .contains('tags', [safe.toLowerCase()]);
      tagFarbrengenIds = [...new Set((tagMatches || []).map(r => r.farbrengen_id))];
    } catch (e) { /* tags table may not have matches — fine, just skip */ }

    // Confirmed-track search: a human-verified title/summary/tag match
    // points at one exact audio track, so include just that track (not its
    // whole farbrengen like the tag search above).
    let confirmedEventIds = [];
    try {
      const [byText, byTag] = await Promise.all([
        supabase.from('audio_text_links').select('ashreinu_event_id')
          .or(`title_en.ilike.%${safe}%,summary_en.ilike.%${safe}%`),
        supabase.from('audio_text_links').select('ashreinu_event_id')
          .contains('tags', [safe.toLowerCase()])
      ]);
      confirmedEventIds = [...new Set([...(byText.data || []), ...(byTag.data || [])].map(r => r.ashreinu_event_id))];
    } catch (e) { /* no confirmed links yet — fine, just skip */ }


    const clauses = [`name.ilike.%${safe}%`, `parent_name.ilike.%${safe}%`];
    if (tagFarbrengenIds.length) {
      const idList = tagFarbrengenIds.join(',');
      clauses.push(`id.in.(${idList})`, `parent_id.in.(${idList})`);
    }
    if (confirmedEventIds.length) clauses.push(`id.in.(${confirmedEventIds.join(',')})`);
    query = query.or(clauses.join(','));
  }

  // Type matching: Ashreinu's real field spellings are "Nigun" (one g) and
  // "Ma'amar" (with an apostrophe) — plain substring checks were missing both.
  if (type === 'sicha') query = query.ilike('type', '%sicha%');
  else if (type === 'maamar') query = query.or(`type.ilike.%ma'amar%,type.ilike.%maamar%`);
  else if (type === 'farbrengen') query = query.eq('type', 'Farbrengen');
  else if (type === 'nigun') query = query.ilike('type', '%nigun%');

  if (year) query = query.eq('hebrew_year', parseInt(year, 10));
  if (month) query = query.eq('hebrew_month_name', month);
  // Only whole events (a farbrengen, a Kos Shel Brachah, a rally...), not the
  // tracks inside them: the home shelves show one card per event.
  if (toplevel) query = query.is('parent_id', null);

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

  // Ranked "Talks" from the catalogue run alongside the chronological list.
  // On an occasion page, "Talks" are the catalogue entries tagged with that
  // occasion, whatever date they were said on.
  const talksPromise = occasion && !q
    ? occasionTalks(supabase, String(occasion), dates)
        .then(talks => ({ talks, matchedTopics: [] }))
        .catch(e => ({ talks: [], matchedTopics: [], talksError: e.message }))
    : q
    ? loadTopics(supabase).then(topics => searchTalks(supabase, q, topics, { type, year, month, dates }))
        // catalogue not set up yet: the list still works, but say why Talks is empty
        .catch(e => ({ talks: [], matchedTopics: [], talksError: e.message }))
    : Promise.resolve({ talks: [], matchedTopics: [] });

  const niggunPromise = q ? loadNiggunim(supabase).then(n => matchNiggunim(n.groups, q)).catch(() => []) : Promise.resolve([]);
  const [{ data, error, count }, { talks, matchedTopics, talksError }, matchedNiggunim] = await Promise.all([query, talksPromise, niggunPromise]);
  if (error) return res.status(500).json({ error: error.message });

  await attachConfirmedTitles(supabase, data);

  res.setHeader('Cache-Control', 's-maxage=30');
  res.status(200).json({ results: data, count, talks, matchedTopics, matchedNiggunim, ...(talksError ? { talksError } : {}) });
}
