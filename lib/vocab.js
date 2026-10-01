// Shared vocabularies for cataloguing and search. Lives in lib/ (not api/),
// so it doesn't count toward Vercel's 12-function limit; api files import it.
//
// Topics are NOT here: they live in the `topics` database table (seeded by
// supabase/002_topics_and_search.sql) so they can be edited in Supabase's
// table editor without touching code.

// Occasions a talk can be for or about. Fixed list, so "Yud Tes Kislev",
// "19 Kislev" and "Chag HaGeulah" all become one filterable value.
export const OCCASIONS = [
  'Rosh Hashanah', 'Yom Kippur', 'Sukkos', 'Shmini Atzeres & Simchas Torah', 'Chanukah', 'Tu BiShvat',
  'Purim', 'Pesach', 'Pesach Sheini', 'Lag BaOmer', 'Shavuos', 'The Three Weeks & Tisha B\'Av',
  'Tu B\'Av', 'Elul', 'Rosh Chodesh', 'Shabbos', 'Sefiras HaOmer',
  'Yud-Tes Kislev', 'Yud Kislev', 'Yud-Daled Kislev', 'Hei Teves', 'Yud Shevat', 'Chof-Beis Shevat',
  'Yud-Alef Nissan', 'Yud-Gimmel Nissan', 'Chof-Ches Sivan', 'Gimmel Tammuz', 'Yud-Beis Tammuz',
  'Chof Av', 'Chai Elul', 'Siyum HaRambam', 'Siyum HaShas', 'Bar/Bas Mitzvah', 'Wedding',
];

// The 54 parshiyos, in Chabad transliteration.
export const PARSHIYOS = [
  'Bereishis', 'Noach', 'Lech Lecha', 'Vayeira', 'Chayei Sarah', 'Toldos', 'Vayeitzei', 'Vayishlach', 'Vayeishev', 'Mikeitz', 'Vayigash', 'Vayechi',
  'Shemos', 'Va\'eira', 'Bo', 'Beshalach', 'Yisro', 'Mishpatim', 'Terumah', 'Tetzaveh', 'Ki Sisa', 'Vayakhel', 'Pekudei',
  'Vayikra', 'Tzav', 'Shemini', 'Tazria', 'Metzora', 'Acharei', 'Kedoshim', 'Emor', 'Behar', 'Bechukosai',
  'Bamidbar', 'Naso', 'Beha\'aloscha', 'Shelach', 'Korach', 'Chukas', 'Balak', 'Pinchas', 'Matos', 'Masei',
  'Devarim', 'Va\'eschanan', 'Eikev', 'Re\'eh', 'Shoftim', 'Ki Seitzei', 'Ki Savo', 'Nitzavim', 'Vayeilech', 'Haazinu', 'Vezos Haberachah',
];

// Spelling variants people type for the same thing. Search expands a query
// word to its whole group, so "Shabbat" finds "Shabbos", "Hanukkah" finds
// "Chanukah", and so on. Topic aliases (from the topics table) are added to
// these at search time. Lower-case; multi-word entries are phrases.
export const VARIANT_GROUPS = [
  ['shabbos', 'shabbat', 'shabos', 'shabbes', 'shabat', 'sabbath', 'שבת'],
  ['sukkos', 'sukkot', 'succos', 'succot', 'sukkah', 'sukka'],
  ['shavuos', 'shavuot', 'shavuoth'],
  ['chanukah', 'chanuka', 'hanukkah', 'hanukah', 'hanuka', 'channukah'],
  ['pesach', 'passover', 'peisach'],
  ['purim', 'poorim'],
  ['rosh hashanah', 'rosh hashana', 'rosh hashono'],
  ['yom kippur', 'yom kipur'],
  ['simchas torah', 'simchat torah'],
  ['shmini atzeres', 'shemini atzeret', 'shmini atzeret'],
  ['lag baomer', 'lag bomer', 'lag b\'omer', 'lag ba\'omer'],
  ['tisha bav', 'tisha b\'av', 'tishah b\'av'],
  ['moshiach', 'mashiach', 'mashiah', 'messiah', 'moshiah', 'משיח'],
  ['geulah', 'geula', 'redemption', 'גאולה'],
  ['galus', 'golus', 'galut', 'exile', 'גלות'],
  ['mitzvos', 'mitzvot', 'mitzvahs', 'commandments'],
  ['mitzvah', 'mitzva', 'commandment'],
  ['teshuvah', 'teshuva', 'tshuva', 'repentance', 'return', 'תשובה'],
  ['tefillah', 'tefila', 'tefilla', 'prayer', 'davening', 'תפילה'],
  ['tefillin', 'tfillin', 'phylacteries'],
  ['tzedakah', 'tzedaka', 'tzdaka', 'charity', 'צדקה'],
  ['bitachon', 'bitochon', 'trust in g-d', 'trust'],
  ['emunah', 'emuna', 'faith'],
  ['simcha', 'simchah', 'joy', 'happiness'],
  ['ahavas yisroel', 'ahavat yisrael', 'ahavas yisrael', 'love of a fellow jew'],
  ['achdus', 'achdut', 'unity'],
  ['chinuch', 'education'],
  ['chassidus', 'chasidus', 'chasidut', 'chassidut', 'hasidism', 'chassidism', 'חסידות'],
  ['chassidim', 'chasidim', 'hasidim'],
  ['rebbe', 'rebbi', 'the rebbe'],
  ['frierdiker rebbe', 'previous rebbe', 'rayatz', 'rebbe rayatz', 'yosef yitzchak'],
  ['alter rebbe', 'baal hatanya', 'schneur zalman', 'rabbi schneur zalman'],
  ['baal shem tov', 'besht', 'baal shem'],
  ['rambam', 'maimonides', 'mishneh torah'],
  ['eretz yisroel', 'eretz yisrael', 'israel', 'land of israel', 'holy land'],
  ['beis hamikdash', 'bais hamikdash', 'beit hamikdash', 'temple', 'holy temple'],
  ['mivtzoim', 'mivtzaim', 'mitzvah campaigns'],
  ['shlichus', 'shlichut', 'shluchim', 'shliach', 'emissaries'],
  ['yud shevat', '10 shevat', 'tenth of shevat'],
  ['yud tes kislev', 'yud-tes kislev', '19 kislev', 'chag hageulah'],
  ['yud beis tammuz', 'yud-beis tammuz', '12 tammuz'],
  ['tammuz', 'tamuz'],
  ['teves', 'tevet'],
  ['shevat', 'shvat', 'sh\'vat'],
  ['nissan', 'nisan'],
  ['iyar', 'iyyar'],
  ['cheshvan', 'marcheshvan', 'heshvan'],
  ['maamar', 'ma\'amar', 'mamar', 'discourse'],
  ['sicha', 'sichah', 'talk'],
  ['farbrengen', 'farbrengens', 'chassidic gathering'],
  ['tanya', 'tania'],
  ['kashrus', 'kashrut', 'kosher'],
  ['bar mitzvah', 'bar mitzva', 'bas mitzvah', 'bat mitzvah'],
  ['noahide', 'noachide', 'seven noahide laws', 'sheva mitzvos', 'bnei noach'],
];

// Who a talk was addressed to, read from Ashreinu's own labels on the
// track (its name/type) — free and exact, no AI needed.
export const AUDIENCE_RULES = [
  [/bar\s*\/?\s*bas\s*mitzvah|bar mitzvah|bas mitzvah/i, 'Bar & Bas Mitzvah'],
  [/choson|kallah|wedding/i, 'Chassanim & Kallos'],
  [/children|tzivos hashem|kids/i, 'Children'],
  [/women|n'shei|neshei|girls/i, 'Women & Girls'],
  [/graduat|students|bochurim|yeshiva|campus/i, 'Students'],
  [/shluchim|shlichus|emissar/i, 'Shluchim'],
  [/guests|visitors/i, 'Guests'],
  [/parade/i, 'Children'],
];

export function audienceFor(name, type) {
  const text = `${name || ''} ${type || ''}`;
  const found = new Set();
  for (const [re, label] of AUDIENCE_RULES) if (re.test(text)) found.add(label);
  return [...found];
}

// ── Search text normalization ──
// Lower-case, unify apostrophes/hyphens, strip Hebrew vowel points, so stored
// text and queries compare the same way.
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')        // Hebrew niqqud / cantillation
    .replace(/[’‘`´]/g, "'")
    .replace(/[״"]/g, '"')
    .replace(/[-–—_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Hebrew glues prefix letters onto words (ו and, ה the, ב in, כ like, ל to,
// מ from, ש that): "בגלות" is "in exile". To let a search for "גלות" find
// it, also store each word with up to two prefix letters removed.
export function hebrewSearchForms(text) {
  const extra = new Set();
  for (const w of String(text || '').split(/[^\u05D0-\u05EA"']+/)) {
    if (w.length < 4) continue;
    let stem = w;
    for (let i = 0; i < 2 && /^[והבכלמש]/.test(stem) && stem.length > 3; i++) {
      stem = stem.slice(1);
      extra.add(stem);
    }
  }
  return extra.size ? text + ' \n ' + [...extra].join(' ') : text;
}
