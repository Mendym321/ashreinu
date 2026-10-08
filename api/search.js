import { createClient } from '@supabase/supabase-js';
import { understandQuery } from '../lib/searchQuery.js';
import { groupNiggunim, niggunKey, niggunTitle, niggunNames, niggunKind } from '../lib/niggunim.js';

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
  // ones marked "not a talk" or a duplicate leave the list.
  const { data: fixList } = await supabase.from('track_fixes').select('ashreinu_event_id, kind, title');
  const fixes = new Map((fixList || []).map(f => [f.ashreinu_event_id, f]));
  for (let i = tracks.length - 1; i >= 0; i--) {
    const f = fixes.get(tracks[i].id);
    if (f?.kind === 'not_a_talk' || f?.kind === 'duplicate') tracks.splice(i, 1);
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
  const loose = new Set(); // matched only some of the words: shown apart, as "related"
  if (hits.length < 8 && u.any && u.any !== u.all) {
    const wide = await call(u.any);
    const seen = new Set(hits.map(h => h.ashreinu_event_id));
    const more = (wide.data || []).filter(h => !seen.has(h.ashreinu_event_id));
    more.forEach(h => loose.add(h.ashreinu_event_id));
    hits = [...hits, ...more];
  }
  const talks = await rowsForIds(supabase, hits.map(h => h.ashreinu_event_id), filters);
  for (const t of talks) if (loose.has(t.id)) t.loose = true;
  const matchedTopics = topics.filter(t => u.topicSlugs.includes(t.slug));
  return { talks: talks.slice(0, 40), matchedTopics };
}

// Attach a real title to each row, so the UI can show it as the main heading
// instead of the generic "Sicha 1" label. A title a human confirmed in
// finder.html (audio_text_links) wins over the catalogue entry Claude wrote
// from Ashreinu's outline (track_metadata).
// keep: also keep tracks fixed as duplicates (with their audio hidden), for
// a single looked-up event; lists drop them unless they hold other tracks.
async function attachConfirmedTitles(supabase, rows, keep) {
  if (!rows.length) return;
  attachPhotos(rows);
  const ids = rows.map(r => r.id);
  const [{ data: links }, { data: catalogue }, { data: fixList }] = await Promise.all([
    supabase.from('audio_text_links').select('ashreinu_event_id, title_en').in('ashreinu_event_id', ids),
    supabase.from('track_metadata').select('ashreinu_event_id, title_en, summary_en, main_topic, topics').eq('status', 'enriched').in('ashreinu_event_id', ids),
    supabase.from('track_fixes').select('*').in('ashreinu_event_id', ids), // no table yet → no fixes
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
      // A second copy of another recording: no audio of its own (so an event
      // holding other tracks opens as an album), and links go to the original.
      if (fix.kind === 'duplicate') { row.audio_uri = null; row.same_as = fix.same_as; }
    }
    if (cat[row.id]) { row.summary_en = cat[row.id].summary_en; row.main_topic = cat[row.id].main_topic; row.other_topics = cat[row.id].topics; }
    // Ashreinu's own English line for a talk, written by its editors, often
    // "Title: what it teaches" ("Every Jew is a Soldier: Lessons from the
    // recent Six Day War."). Shown as-is in the player; for a talk not
    // catalogued yet, its short head becomes the title and the rest the summary.
    const d = !/nigun/i.test(row.type || '') && typeof row.desc === 'string' ? row.desc.trim() : '';
    if (d) {
      row.ashreinu_desc = d;
      const m = d.match(/^([^:]{3,45}):\s*(.+)$/);
      const head = m && m[1].trim().split(/\s+/).length <= 6 ? m[1].trim() : null;
      if (!row.confirmed_title && head) { row.confirmed_title = head; row.title_source = 'ashreinu'; }
      if (!row.summary_en) { row.summary_en = head ? m[2].trim() : d; row.summary_source = 'ashreinu'; }
    }
  }
  const dups = rows.filter(r => fixes[r.id]?.kind === 'duplicate').map(r => r.id);
  if (dups.length && !keep) {
    const { data: kids } = await supabase.from('ashreinu_events').select('parent_id').in('parent_id', dups).not('audio_uri', 'is', null).limit(1000);
    const holders = new Set((kids || []).map(k => k.parent_id));
    for (let i = rows.length - 1; i >= 0; i--) if (dups.includes(rows[i].id) && !holders.has(rows[i].id)) rows.splice(i, 1);
  }
}

// ── JEM's curated playlists (imported by the pipeline page; see
// supabase/005_playlists.sql). A clip is an excerpt of a recording with its
// own human-written title; it plays from start_ms to end_ms. ──
const PLAYLIST_LANGUAGE = new Set([352, 666, 885, 1969]); // English, Hebrew, Russian, French
function playlistGroup(p) {
  const n = p.name || '';
  if (p.taxonomy === 'book') return 'Books';
  if (p.taxonomy === 'timeline' || p.taxonomy === 'date_based_timeline') return 'Timelines';
  if (p.taxonomy === 'interactive_article' || /^stories$/i.test(n)) return 'Stories & moments';
  if (PLAYLIST_LANGUAGE.has(p.id)) return 'Languages';
  if (/podcast/i.test(n)) return 'Podcasts';
  if (/unknown dates|^current$/i.test(n)) return 'More';
  if (!/[a-z]/i.test(n)) return 'In Hebrew';
  if (/highlights|lessons|playlist|celebrations|nigunim|purim|pesach|shavuos|chanukah|sukkos|omer|tishrei|elul|kislev|shevat|nissan|tammuz|\bav\b|adar|teves|cheshvan|iyar|sivan/i.test(n)) return 'Seasons & occasions';
  return 'Themes';
}
const PLAYLIST_GROUPS = ['Seasons & occasions', 'Themes', 'Stories & moments', 'Timelines', 'Podcasts', 'In Hebrew', 'Languages', 'Books', 'More'];
// Clips as track rows the app can play: the clip's own title, the recording
// it comes from, and (when we have that recording) its date and farbrengen.
async function clipRows(supabase, clips, playlistName) {
  const evIds = [...new Set(clips.map(c => c.event_id).filter(Boolean))];
  const ev = {};
  for (let i = 0; i < evIds.length; i += 200) {
    const { data } = await supabase.from('ashreinu_events').select(ROW_FIELDS).in('id', evIds.slice(i, i + 200));
    for (const e of data || []) ev[e.id] = e;
  }
  return clips.map(c => {
    const e = ev[c.event_id] || {};
    const start = c.start_ms || 0, end = c.end_ms || null;
    return {
      id: 'c' + c.clip_id, clip_id: c.clip_id, event_id: c.event_id || null, playlist_id: c.playlist_id, playlist_name: c.playlist_name || playlistName || null,
      parent_id: e.parent_id || null, parent_name: e.parent_name || null, type: e.type || 'Clip',
      name: e.name || c.playlist_name || playlistName || 'JEM playlist',
      confirmed_title: c.name || e.name || 'Clip', title_source: 'jem',
      hebrew_year: e.hebrew_year || null, hebrew_month: e.hebrew_month || null, hebrew_day: e.hebrew_day || null, hebrew_month_name: e.hebrew_month_name || null,
      secular_year: e.secular_year || null, secular_month: e.secular_month || null, secular_day: e.secular_day || null,
      audio_uri: c.audio_uri, start_ms: start, end_ms: end, duration_ms: end ? end - start : e.duration_ms || null,
      photo: c.picture || null, photo_lg: c.picture ? c.picture.replace(/h_300,(.*?)w_300/, 'h_900,$1w_900') : null,
      has_document: !!c.has_document,
    };
  });
}
const CLIP_FIELDS = 'playlist_id, position, clip_id, name, audio_uri, start_ms, end_ms, picture, event_id, has_document';

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
    // Only talks that work for anyone: rated 4-5 for featuring by Claude
    // (evergreen), or chosen by a person (featured = true); never ones a
    // person ruled out. Talks not rated yet only fill in if too few are rated.
    const n = Math.max(1, Math.min(parseInt(req.query.explore, 10) || 12, 40));
    const rows = [];
    let rated = true;
    for (let from = 0; ; from += 1000) {
      let { data, error } = await supabase.from('track_metadata').select('ashreinu_event_id, evergreen, featured').eq('status', 'enriched').order('ashreinu_event_id').range(from, from + 999);
      if (error && rated) { // no featuring columns yet (supabase/004_featured.sql): every talk counts
        rated = false;
        ({ data, error } = await supabase.from('track_metadata').select('ashreinu_event_id').eq('status', 'enriched').order('ashreinu_event_id').range(from, from + 999));
      }
      if (error) return res.status(200).json({ results: [] }); // catalogue not set up yet
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    const good = shuffle(rows.filter(r => r.featured === true || (r.featured !== false && r.evergreen >= 4)));
    const unrated = shuffle(rows.filter(r => r.featured == null && r.evergreen == null));
    const ids = [...good, ...(good.length < n ? unrated : [])].slice(0, n).map(r => r.ashreinu_event_id);
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(200).json({ results: await rowsForIds(supabase, ids, {}) });
  }

  // JEM's playlists: the list (grouped), one playlist's clips, one clip, or a
  // clip's written text (English summary and the original, split apart).
  if (req.query.playlists) {
    const { data, error } = await supabase.from('playlists').select('id, name, hebrew_name, taxonomy, picture, clip_count, total_ms, sort, extra')
      .eq('published', true).gt('clip_count', 0).order('sort');
    // Not set up or not imported yet: say so, and never keep that empty
    // answer in Vercel's cache (it would hide the playlists once imported).
    if (error || !data.length) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ playlists: [], groups: [], setup: error ? 'tables missing: run supabase/005_playlists.sql' : 'no playlists imported yet: use Import JEM playlists in the pipeline page' });
    }
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=604800');
    return res.status(200).json({ groups: PLAYLIST_GROUPS, playlists: data.map(p => ({ id: p.id, name: p.name, hebrew_name: p.hebrew_name, picture: p.picture,
      count: p.clip_count, total_ms: p.total_ms, group: playlistGroup(p),
      years: p.extra?.timeline_event_year_start ? [p.extra.timeline_event_year_start, p.extra.timeline_event_year_end] : null })) });
  }
  if (req.query.playlist) {
    const id = parseInt(req.query.playlist, 10);
    const [{ data: p }, { data: clips, error }] = await Promise.all([
      supabase.from('playlists').select('id, name, hebrew_name, description, taxonomy, picture, clip_count, total_ms').eq('id', id).maybeSingle(),
      supabase.from('playlist_clips').select(CLIP_FIELDS).eq('playlist_id', id).order('position'),
    ]);
    if (error || !p) return res.status(404).json({ error: 'Unknown playlist' });
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=604800');
    return res.status(200).json({ playlist: { ...p, group: playlistGroup(p) }, results: await clipRows(supabase, clips, p.name) });
  }
  if (req.query.clip) {
    const { data } = await supabase.from('playlist_clips').select(CLIP_FIELDS + ', playlists(name)').eq('clip_id', parseInt(req.query.clip, 10)).limit(1);
    if (!data?.length) return res.status(200).json({ result: null });
    const c = { ...data[0], playlist_name: data[0].playlists?.name };
    res.setHeader('Cache-Control', 's-maxage=600');
    return res.status(200).json({ result: (await clipRows(supabase, [c]))[0] });
  }
  if (req.query.clipdoc) {
    const { data } = await supabase.from('playlist_clips').select('document').eq('clip_id', parseInt(req.query.clipdoc, 10)).not('document', 'is', null).limit(1);
    const text = data?.[0]?.document || '';
    // English paragraphs are JEM's summary; Hebrew/Yiddish ones the source.
    const paras = text.split(/\n\s*\n|\n/).map(t => t.trim()).filter(Boolean);
    const isHeb = t => (t.match(/[֐-׿]/g) || []).length > t.replace(/\s/g, '').length / 3;
    const english = paras.filter(t => !isHeb(t) && !/^summary$/i.test(t)), hebrew = paras.filter(isHeb);
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({ summary: english.join('\n\n'), text: hebrew.join('\n\n') });
  }

  // One event's row by id (e.g. a farbrengen opened from one of its tracks).
  if (req.query.event) {
    const { data, error } = await supabase.from('ashreinu_events').select(ROW_FIELDS).eq('id', parseInt(req.query.event, 10)).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (data) await attachConfirmedTitles(supabase, [data], true);
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.status(200).json({ result: data || null });
  }

  // Niggunim: the list (sung at least twice, most-sung first), or one
  // niggun's recordings in date order.
  if (req.query.niggunim || req.query.niggun) {
    try {
      const { groups } = await loadNiggunim(supabase);
      // Served from Vercel's cache: fresh for 10 minutes, and after that the
      // saved copy is still sent at once while a fresh one is made behind the
      // scenes, so nobody waits for the whole list to be rebuilt.
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=604800');
      if (req.query.niggunim) {
        return res.status(200).json({ niggunim: groups.filter(g => g.count >= 2).map(({ slug, name, count, first, last }) => {
          const kind = niggunKind(name);
          return { key: slug, name, count, first, last, ...(kind !== null ? { kind: true, gloss: kind } : {}) };
        }) });
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
      // The OTHER niggunim on each recording ("with Daled Bavos"): this
      // niggun's own spellings ("Nye Zhuritzi Chloptzi 2") don't count.
      for (const r of rows) {
        const seen = new Set([g.key]);
        r.other_niggunim = (r.title_source === 'fixed' ? [] : niggunNames(r.name, r.desc))
          .filter(n => { const k = niggunKey(n); if (!k || seen.has(k)) return false; seen.add(k); return true; });
      }
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


    // Ashreinu's own English description of a track is searched too.
    const clauses = [`name.ilike.%${safe}%`, `parent_name.ilike.%${safe}%`, `raw_data->>description.ilike.%${safe}%`];
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
  // Moments from JEM's playlists whose own title matches ("every last child").
  const clipsPromise = q && q.trim().length >= 3
    ? supabase.from('playlist_clips').select(CLIP_FIELDS + ', playlists(name)').ilike('name', '%' + q.trim().replace(/[%_,()]/g, ' ') + '%').limit(24)
      .then(({ data }) => {
        const seen = new Set(); // a clip can sit in more than one playlist
        const list = (data || []).filter(c => !seen.has(c.clip_id) && seen.add(c.clip_id)).slice(0, 10).map(c => ({ ...c, playlist_name: c.playlists?.name }));
        return list.length ? clipRows(supabase, list) : [];
      }).catch(() => [])
    : Promise.resolve([]);
  const [{ data, error, count }, { talks, matchedTopics, talksError }, matchedNiggunim, clips] = await Promise.all([query, talksPromise, niggunPromise, clipsPromise]);
  if (error) return res.status(500).json({ error: error.message });

  await attachConfirmedTitles(supabase, data);

  // "Top result": whatever's TITLE (ours, Claude's, JEM's clip title) or
  // Ashreinu's description contains the whole phrase typed, wherever it came
  // from: "Every Jew is a Soldier" finds that talk first, not talks that
  // merely mention Jews. Only for real phrases (two words or more).
  const norm = t => String(t || '').toLowerCase().replace(/[’‘`']/g, '').replace(/[^a-z0-9\u0590-\u05ff]+/g, ' ').trim();
  const phrase = norm(q);
  let top = [];
  if (phrase.split(' ').length >= 2) {
    const seen = new Set();
    top = [...(talks || []), ...(clips || []), ...(data || [])]
      .map(r => ({ r, inTitle: norm(r.confirmed_title).includes(phrase), inDesc: norm(r.ashreinu_desc).includes(phrase) }))
      .filter(x => (x.inTitle || x.inDesc) && !seen.has(String(x.r.id)) && seen.add(String(x.r.id)))
      .sort((a, b) => b.inTitle - a.inTitle)
      .slice(0, 3).map(x => (x.inTitle ? x.r : { ...x.r, matched_desc: true }));
  }

  res.setHeader('Cache-Control', 's-maxage=30');
  res.status(200).json({ results: data, count, top, talks, matchedTopics, matchedNiggunim, clips, ...(talksError ? { talksError } : {}) });
}
