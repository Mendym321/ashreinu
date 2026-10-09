// Query understanding for catalogue search: turns what someone typed into a
// Postgres full-text query, expanding spelling variants ("Shabbat" →
// shabbos/shabbat/…) and topic aliases ("galus" → the Exile topic), so the
// database can rank matches. Pure functions, no database access.

import { VARIANT_GROUPS, normalize } from './vocab.js';

// Small words that carry no meaning in a search ("talks about teshuvah for kids").
const STOPWORDS = new Set(['a', 'an', 'the', 'about', 'for', 'of', 'on', 'in', 'to', 'and', 'or', 'with', 'by',
  'from', 'is', 'are', 'what', 'how', 'why', 'when', 'rebbe\'s', 'rebbes', 'sicha', 'sichos', 'talk', 'talks', 'on']);

// Words too common in this archive to make a talk "related" on their own:
// "Shabbos Chanukah" shouldn't widen to every talk that mentions Shabbos
// ("when Rosh Hashanah falls on Shabbos").
const GENERIC = new Set(['shabbos', 'farbrengen', 'motzei', 'motzai', 'parshas', 'parsha', 'yom tov', 'rebbe']);

// Words inside a phrase, safe for to_tsquery (letters and digits only).
function words(phrase) { return normalize(phrase).split(/[^\p{L}\p{N}]+/u).filter(Boolean); }

// One alternative as tsquery syntax: a word, or a phrase joined with <-> ("followed by").
function asTs(phrase, prefix) {
  const w = words(phrase);
  if (!w.length) return null;
  if (w.length === 1) return w[0] + (prefix ? ':*' : '');
  return '(' + w.join(' <-> ') + ')';
}

// Rewrite every known spelling variant to its group's standard form (the
// first entry): "shabbat candles" → "shabbos candles". Longest first, so
// "rosh hashana" is handled before "rosh".
function canonicalize(text) {
  const pairs = [];
  for (const group of VARIANT_GROUPS) {
    const canon = words(group[0]).join(' ');
    for (const v of group) pairs.push([words(v).join(' '), canon]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  let out = ' ' + text.trim() + ' ';
  for (const [from, to] of pairs) {
    if (!from || from === to) continue;
    out = out.split(' ' + from + ' ').join(' ' + to + ' ');
  }
  return out;
}
const groupOf = (canon) => VARIANT_GROUPS.find(g => words(g[0]).join(' ') === canon);

// topics: rows from the topics table ({ slug, name_en, name_he, aliases, parent_slug }).
export function understandQuery(rawQuery, topics = []) {
  if (!words(rawQuery).length) return null;
  // Step 1: standard spellings, so topic aliases and variants line up.
  let rest = canonicalize(words(rawQuery).join(' '));

  const concepts = [];   // each: list of alternative phrases (any one may match)
  const topicSlugs = new Set();
  const take = (phrase) => {
    const needle = ' ' + phrase + ' ';
    if (!phrase || !rest.includes(needle)) return false;
    rest = rest.replace(needle, ' ');
    return true;
  };
  const altsWithVariants = (names) => [...new Set(names.flatMap(n => {
    const canon = canonicalize(words(n).join(' ')).trim();
    return [n, ...(groupOf(canon) || [])];
  }))];

  // Step 2: topics (name + aliases, compared in standard spelling), longest first.
  const topicUnits = [];
  for (const t of topics.filter(t => t.parent_slug)) {
    const names = [t.name_en, t.name_he, ...(t.aliases || [])].filter(Boolean);
    for (const n of names) topicUnits.push({ phrase: canonicalize(words(n).join(' ')).trim(), t, names });
  }
  topicUnits.sort((a, b) => b.phrase.length - a.phrase.length);
  for (const u of topicUnits) {
    if (take(u.phrase)) { topicSlugs.add(u.t.slug); concepts.push({ alts: altsWithVariants(u.names) }); }
  }

  // Step 3: remaining known variant phrases.
  const groups = VARIANT_GROUPS.map(g => ({ canon: words(g[0]).join(' '), g })).sort((a, b) => b.canon.length - a.canon.length);
  for (const { canon, g } of groups) if (take(canon)) concepts.push({ alts: g });

  // Step 4: leftover single words, minus filler. The last word typed may be
  // unfinished ("teshu…"), so it matches as a prefix.
  const lastTyped = words(rawQuery).slice(-1)[0];
  for (const w of rest.trim().split(' ').filter(w => w && !STOPWORDS.has(w))) {
    concepts.push({ alts: [w], prefix: w === lastTyped && w.length >= 3 });
  }

  const toTs = (joiner, list = concepts) => list
    .map(c => '(' + [...new Set(c.alts.map(a => asTs(a, c.prefix)).filter(Boolean))].join(' | ') + ')')
    .filter(s => s !== '()')
    .join(joiner);

  const isGeneric = c => GENERIC.has(normalize(String(c.alts[0])).trim());
  return {
    all: toTs(' & '),        // every concept must match (precise)
    // any concept may match (fallback when "all" finds little), but not a
    // generic word alone when something more specific was typed too
    any: toTs(' | ', concepts.some(c => !isGeneric(c)) ? concepts.filter(c => !isGeneric(c)) : concepts),
    raw: normalize(rawQuery),
    topicSlugs: [...topicSlugs],
    concepts,
  };
}
