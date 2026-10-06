// Niggunim as their own "genre": each niggun is like a song, and every time
// it was sung at a farbrengen is one recording of it. The names come from
// Ashreinu itself (a track's name, or its description when the name is
// generic: "Two Nigunim" → "V'Atah Omarta, Lechatchila Ariber"). No AI.

// A track name that says nothing about which niggun it is.
const GENERIC_NAME = /^((two|three|four|five|six|seven)\s+)?nigun(im)?(\s*\d+)?$/i;
// Parts of a description that aren't niggun names.
const NOT_A_NIGGUN = /^((two|three|four|five|six|seven)\s+)?nigun(im)?(\s*\d+)?$|^conversations?$|^l?e?'?chaims?$|^the rebbe\b|\brequests?\b|\bsings?\b|\blead\b|^\d+$/i;

// Spellings that the automatic matching below can't tell are the same.
// Key: any spelling (lower case), value: the one to group under.
const SAME_AS = {
  'ufaratza': 'ufaratzta',
  'tzamah': 'tzamah lecha nafshi',
  'tzama lecha nafshi': 'tzamah lecha nafshi',
  'darkecha': 'darkecha elokeinu',
  'ki anu': 'ki anu amecha',
  'beinoni': 'the beinoni',
  'nigun of harav levi yitzchok': "harav levi yitzchok's nigun",
  'dalet bavos': 'daled bavos',
  'tzamah lecha': 'tzamah lecha nafshi',
  'nye zhuritzi': 'nye zhuritzy chloptzy',
  'viharikosi': "v'harikosi lachem bracha",
  "v'harikosi lachem": "v'harikosi lachem bracha",
  'aimosai': "amosai ka'asi mar",
  'hup cossack': 'hop cossak',
  "reb levik's nigun": "harav levi yitzchok's nigun",
  'nigun beinoni': 'the beinoni',
  'nigun lechatchila ariber': 'lechatchila ariber',
  "nigun l'shabbos v'yom tov": "nigun shabbos v'yom tov",
  'mimitzrayim': "mimitzrayim ge'altanu",
  'prazos teshev': 'prazos teshev yerushalayim',
  'atah bechartanu': 'atah vechartanu',
};

// One spelling-insensitive key per name: lower case, no apostrophes or
// parentheses, y→i, a word's final "h" dropped, then its consonants only.
// "Nye Zhuritzy Chloptzy" and "Nye Zhuritzi Chloptzi" share a key, as do
// "Amosai" / "Aimosai" and "Nigun Hachana" / "Nigun Hachanah".
export function niggunKey(name) {
  let s = String(name || '').toLowerCase().replace(/[’`‘]/g, "'").replace(/\(.*?\)/g, ' ').replace(/[^a-z' ]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^the /, '').replace(/\s+\d+$/, '');
  s = SAME_AS[s] || SAME_AS['the ' + s] || s;
  return s.replace(/^the /, '').split(' ').map(w => w.replace(/'/g, '').replace(/y/g, 'i').replace(/h$/, '').replace(/[aeiou]/g, '')).filter(Boolean).join(' ');
}

// The niggun names a track carries, in order (a track can hold several).
export function niggunNames(name, description) {
  const text = String(description || '').trim() || (GENERIC_NAME.test(String(name || '').trim()) ? '' : String(name || ''));
  return text.replace(/[’`‘]/g, "'").split(/[,.;]|\s+and\s+|\s+&\s+/i)
    .map(t => t.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim().replace(/\s+\d+$/, ''))
    .filter(t => t && t.length <= 45 && !NOT_A_NIGGUN.test(t));
}

// A better title for a niggun track whose own name is generic.
export function niggunTitle(name, description) {
  if (!GENERIC_NAME.test(String(name || '').trim())) return null;
  const names = [...new Set(niggunNames('', description))];
  return names.length ? names.join(', ') : null;
}

// Group tracks into niggunim. tracks: [{ id, name, description }].
// Returns [{ key, name, ids }], the most-recorded first; the display name is
// the spelling used most often.
export function groupNiggunim(tracks) {
  const groups = new Map();
  for (const t of tracks) {
    for (const n of niggunNames(t.name, t.description)) {
      const key = niggunKey(n);
      if (!key) continue;
      const g = groups.get(key) || { key, ids: new Set(), spellings: {} };
      g.ids.add(t.id);
      g.spellings[n] = (g.spellings[n] || 0) + 1;
      groups.set(key, g);
    }
  }
  return [...groups.values()].map(g => {
    const name = Object.entries(g.spellings).sort((a, b) => b[1] - a[1])[0][0];
    // slug: a readable link name ("daled-bavos"); key: spelling-proof match
    return { key: g.key, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name, ids: [...g.ids] };
  }).sort((a, b) => b.ids.length - a.ids.length || a.name.localeCompare(b.name));
}
