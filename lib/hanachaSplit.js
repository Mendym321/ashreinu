// Split a pasted Toras Menachem farbrengen hanacha into its sichos, and line
// them up with the farbrengen's audio tracks on Ashreinu. A farbrengen page
// is one long Hebrew text: lettered sections (א. ב. ג. …) grouped into sichos
// that are separated by a "* * *" line, with the ma'amar and the appeal
// (magbis) sitting among them. Ashreinu lists the same farbrengen as ordered
// tracks (Sicha 1, Nigun, Sicha 2, Ma'amar…). We match them in order, nudged
// by two sure signs: a ma'amar block goes to the ma'amar track, the appeal
// block to the magbis track. No AI; the pipeline enriches afterwards.

// Keep only the spoken body: from the first בס"ד to the footnotes/navigation
// that chabad.org prints around it. Footnotes are reference matter, not the
// talk, so they're dropped.
export function cleanHanacha(raw) {
  let t = String(raw || '').replace(/\r/g, '');
  const start = t.search(/בס["״']?ד/);
  if (start > 0) t = t.slice(start);
  // End at the footnotes or the page's own next/prev navigation.
  const endMarkers = [/\n\s*Footnotes\s*\n/i, /\n\s*«\s*Previous/, /\n\s*Next\s*»/];
  let end = t.length;
  for (const m of endMarkers) { const i = t.search(m); if (i > 200 && i < end) end = i; }
  t = t.slice(0, end);

  // Drop page furniture and the footnote matter a PDF-to-text/Word export
  // (e.g. sofer.ai OCR) leaves inline: "— Page 3 —" banners, a bare page
  // number on its own line, and footnote blocks that open with a
  // parenthesised number, "(12) ...". These are layout and reference matter,
  // not the spoken talk, so we strip them before splitting into sichos —
  // otherwise a footnote block printed at a page break lands inside a sicha.
  // The talk numbers its sections with Hebrew letters (א. ב. ג. …), so no line
  // of the spoken text ever begins with an Arabic digit. Page furniture and
  // footnotes do: the "— Page 3 —" banner, a bare page number, a running
  // header ("255 ל׳ תשרי…"), and footnote blocks in every form the export
  // produced — "(32) …", "32) …", "35. …", and the "229. …" wrap of a long
  // note. One rule — drop a line that opens with a digit — clears them all
  // without touching the talk.
  t = t.split('\n').filter(line => {
    const s = line.trim();
    if (!s) return true;                                        // keep blanks
    if (/^[—–-]+\s*Page\s+\d+\s*[—–-]+$/i.test(s)) return false; // page banner
    if (/^\(?\d+[).]?(\s|$)/.test(s)) return false;             // number/header/footnote
    return true;
  }).join('\n');

  // Strip flattened footnote-reference markers: a small number a PDF export
  // dropped inline after a Hebrew word where a superscript note number stood
  // ("דובר במאמר 1" → "דובר במאמר"). Only a 1–3 digit run standing alone
  // between Hebrew text and a space or punctuation, so real content is left be.
  t = t.replace(/([א-ת׳״"'’)\]])[ \t]+\d{1,3}(?=[\s,.;:)\]]|$)/gm, '$1');

  return t.trim();
}

// A line that is only stars ("*", "* * *") separates one sicha from the next.
const SEP = /^\s*\*(?:\s*\*)*\s*$/;
// A section opener: a Hebrew-letter ordinal at the start of a line ("א. ", "יב. ").
const ORD = /^\s*([א-ת]{1,2})[.．]\s/;
// A ma'amar block opens with "מאמר כעין שיחה", a ד"ה heading, or the
// announcement "(צוה לנגן ו)אמר מאמר ד"ה…" — which may sit behind the
// farbrengen's title when the ma'amar comes first. A passing "מאמר המשנה"
// inside a sicha must not count.
const MAAMAR = /מאמר\s+כעין|(?:ו?אמר|לנגן ואמר)\s+מאמר|מאמר\s+ד["״]ה|ד["״]ה\s+[א-ת]/;
const MAGBIS = /(קרן|מגבית)/;
const MAGBIS_CTX = /(יא[ָא]?רצייט|יארצייט|להשתתף|ישתתף|חינוך)/;

function blockKind(text) {
  // Scan the opening (not just the first line): a short ma'amar announcement
  // can follow a title or "בלתי מוגה" header.
  const head = text.slice(0, 250);
  if (MAAMAR.test(head)) return 'maamar';
  if (MAGBIS.test(text) && MAGBIS_CTX.test(text)) return 'magbis';
  return 'sicha';
}

// Split the cleaned body into blocks on the star lines. Each block: its label
// (the range of section letters it covers, e.g. "א–ג"), a kind, the text, and
// a short preview of the first line.
export function splitBlocks(body) {
  const lines = String(body || '').split('\n');
  const chunks = [];
  let cur = [];
  for (const ln of lines) {
    if (SEP.test(ln)) { if (cur.join('').trim()) chunks.push(cur); cur = []; }
    else cur.push(ln);
  }
  if (cur.join('').trim()) chunks.push(cur);

  return chunks.map(ch => {
    const text = ch.join('\n').trim();
    const ords = [];
    for (const ln of ch) { const m = ln.match(ORD); if (m) ords.push(m[1]); }
    const label = ords.length ? (ords.length === 1 ? ords[0] : ords[0] + '–' + ords[ords.length - 1]) : '';
    const firstReal = (text.replace(ORD, '').trim().split('\n')[0] || '').slice(0, 70);
    return { label, kind: blockKind(text), text, preview: firstReal };
  });
}

// Which tracks can carry spoken text (not a nigun). Keeps Ashreinu's order.
const trackKind = (type) => /ma['’]?amar|מאמר/i.test(type || '') ? 'maamar'
  : /magbis|מגבית/i.test(type || '') ? 'magbis'
  : /sicha|שיחה/i.test(type || '') ? 'sicha' : null;

export function spokenTracks(subEvents) {
  return (subEvents || [])
    .map(s => ({ id: s.id, name: s.name, type: s.type, duration_ms: s.audio_recordings_duration ?? s.duration_ms ?? null, kind: trackKind(s.type) }))
    .filter(t => t.kind);
}

// Best-guess assignment of blocks to tracks, in order. A ma'amar/magbis block
// snaps to the next ma'amar/magbis track; sicha blocks take the next sicha
// track; any leftover block joins the previous track (two blocks, one track).
// Returns an array, one entry per block: { block, track } (track may be null).
export function mapToTracks(blocks, tracks) {
  const out = blocks.map(b => ({ block: b, track: null }));
  let ti = 0;
  const findFrom = (from, k) => { for (let i = from; i < tracks.length; i++) if (tracks[i].kind === k) return i; return -1; };
  for (let bi = 0; bi < blocks.length; bi++) {
    const want = blocks[bi].kind;
    let j = findFrom(ti, want);
    if (j < 0 && want !== 'sicha') j = findFrom(ti, 'sicha'); // ma'amar/magbis not listed separately
    if (j < 0) j = findFrom(ti, 'sicha');
    if (j < 0) { out[bi].track = bi > 0 ? out[bi - 1].track : (tracks[tracks.length - 1] || null); continue; }
    out[bi].track = tracks[j];
    ti = j + 1;
  }
  return out;
}

// Full pipeline: raw paste + the farbrengen's Ashreinu sub_events → the mapping
// for review. The text per track is every block assigned to it, joined.
export function mapHanacha(raw, subEvents) {
  const blocks = splitBlocks(cleanHanacha(raw));
  const tracks = spokenTracks(subEvents);
  const pairs = mapToTracks(blocks, tracks);
  const byTrack = new Map();
  for (const { block, track } of pairs) {
    if (!track) continue;
    if (!byTrack.has(track.id)) byTrack.set(track.id, { track, blocks: [] });
    byTrack.get(track.id).blocks.push(block);
  }
  return {
    blocks,
    tracks,
    pairs,
    assignments: [...byTrack.values()].map(({ track, blocks }) => ({
      track_id: track.id, name: track.name, type: track.type, kind: track.kind,
      labels: blocks.map(b => b.label).filter(Boolean).join(', '),
      text: blocks.map(b => b.text).join('\n\n'),
    })),
  };
}
