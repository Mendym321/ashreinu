import { createClient } from '@supabase/supabase-js';
import { understandQuery } from '../lib/searchQuery.js';

// Fields the app needs for a track row (not raw_data, which is large).
const ROW_FIELDS = 'id, parent_id, parent_name, name, type, hebrew_year, hebrew_month, hebrew_day, hebrew_month_name, secular_year, secular_month, secular_day, duration_ms, audio_uri';

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
  const ids = rows.map(r => r.id);
  const [{ data: links }, { data: catalogue }] = await Promise.all([
    supabase.from('audio_text_links').select('ashreinu_event_id, title_en').in('ashreinu_event_id', ids),
    supabase.from('track_metadata').select('ashreinu_event_id, title_en, summary_en, main_topic, topics').eq('status', 'enriched').in('ashreinu_event_id', ids),
  ]);
  const verified = Object.fromEntries((links || []).filter(l => l.title_en).map(l => [l.ashreinu_event_id, l.title_en]));
  const cat = Object.fromEntries((catalogue || []).filter(c => c.title_en).map(c => [c.ashreinu_event_id, c]));
  for (const row of rows) {
    row.confirmed_title = verified[row.id] || cat[row.id]?.title_en || null;
    row.title_source = verified[row.id] ? 'verified' : cat[row.id] ? 'catalogue' : null;
    if (cat[row.id]) { row.summary_en = cat[row.id].summary_en; row.main_topic = cat[row.id].main_topic; row.other_topics = cat[row.id].topics; }
  }
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { q = '', type = '', year = '', month = '', limit = '200', dates = '', distinct = '', parentId = '' } = req.query;

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
      .select('id, name, type, duration_ms, audio_uri, parent_id, parent_name, hebrew_year, hebrew_month, hebrew_day, hebrew_month_name, secular_year, secular_month, secular_day')
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
  if (distinct === 'years') {
    let allYears = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('ashreinu_events')
        .select('hebrew_year')
        .eq('type', 'Farbrengen')
        .not('hebrew_year', 'is', null)
        .order('hebrew_year', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) return res.status(500).json({ error: error.message });
      allYears.push(...data.map(r => r.hebrew_year));
      if (data.length < pageSize) break;
      offset += pageSize;
    }
    const years = [...new Set(allYears)].sort((a, b) => a - b);
    return res.status(200).json({ years });
  }

  let query = supabase.from('ashreinu_events').select('*', { count: 'exact' }).limit(parseInt(limit, 10));

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
  const talksPromise = q
    ? loadTopics(supabase).then(topics => searchTalks(supabase, q, topics, { type, year, month, dates }))
        .catch(() => ({ talks: [], matchedTopics: [] }))   // catalogue not set up yet: list still works
    : Promise.resolve({ talks: [], matchedTopics: [] });

  const [{ data, error, count }, { talks, matchedTopics }] = await Promise.all([query, talksPromise]);
  if (error) return res.status(500).json({ error: error.message });

  await attachConfirmedTitles(supabase, data);

  res.setHeader('Cache-Control', 's-maxage=30');
  res.status(200).json({ results: data, count, talks, matchedTopics });
}
