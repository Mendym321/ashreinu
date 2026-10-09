// Search inside the Hebrew/Yiddish texts (outlines, hanachos): turns what
// someone typed into a Postgres tsquery for search_texts()
// (supabase/006_text_search.sql). Hebrew typed in is searched as is; English
// is mapped through a small hand-made dictionary of the terms people
// actually search for ("ahavas yisroel" → אהבת ישראל), plus the topics'
// Hebrew names. No AI, so it's instant, free and never invents a term.

// [Hebrew, ...English spellings]. English is compared lower-case, without
// apostrophes. Longest matches are tried first.
const TERMS = [
  ['אהבת ישראל', 'ahavas yisroel', 'ahavas yisrael', 'ahavat yisrael', 'ahavas israel', 'love of a fellow jew', 'love for every jew'],
  ['אחדות', 'achdus', 'achdut', 'unity'],
  ['משיח', 'moshiach', 'mashiach', 'messiah'],
  ['גאולה', 'geulah', 'geula', 'redemption'],
  ['גלות', 'galus', 'galut', 'exile'],
  ['בית המקדש', 'beis hamikdash', 'beit hamikdash', 'holy temple', 'the temple'],
  ['תשובה', 'teshuvah', 'teshuva', 'repentance'],
  ['תפילה', 'tefillah', 'tefilah', 'tefila', 'prayer'],
  ['תורה', 'torah'],
  ['לימוד התורה', 'limud hatorah', 'torah study'],
  ['שמחה', 'simcha', 'simchah', 'joy', 'happiness'],
  ['אמונה', 'emunah', 'emuna', 'faith'],
  ['בטחון', 'bitachon', 'trust in g-d', 'trust in god', 'trust'],
  ['אהבה', 'ahavah'],
  ['יראה', 'yirah', 'yiras shamayim', 'awe'],
  ['ביטול', 'bittul', 'bitul', 'self-nullification', 'humility'],
  ['מסירת נפש', 'mesiras nefesh', 'mesirus nefesh', 'mesirat nefesh', 'self-sacrifice', 'self sacrifice'],
  ['קבלת עול', 'kabbalas ol', 'kabolas ol', 'kabalat ol'],
  ['עבודה', 'avodah', 'avoda', 'divine service'],
  ['נשמה', 'neshama', 'neshamah', 'soul'],
  ['נפש', 'nefesh'],
  ['דירה בתחתונים', 'dirah betachtonim', 'dira betachtonim', 'dwelling place below'],
  ['צדקה', 'tzedakah', 'tzedaka', 'charity'],
  ['גמילות חסדים', 'gemilus chasadim', 'gemilut chasadim', 'kindness'],
  ['שליחות', 'shlichus', 'shlichut'],
  ['שלוחים', 'shluchim'],
  ['מבצע', 'mivtza', 'mivtzah', 'mivtzoim', 'mitzvah campaign', 'mitzvah campaigns'],
  ['תפילין', 'tefillin', 'tefilin'],
  ['מזוזה', 'mezuzah', 'mezuza'],
  ['נרות שבת', 'shabbos candles', 'shabbat candles', 'neros shabbos', 'candle lighting'],
  ['כשרות', 'kashrus', 'kashrut', 'kosher'],
  ['טהרת המשפחה', 'taharas hamishpacha', 'family purity'],
  ['שבע מצוות בני נח', 'seven noahide laws', 'noahide laws', 'sheva mitzvos'],
  ['חינוך', 'chinuch', 'education'],
  ['ילדים', 'children', 'kids'],
  ['צבאות השם', 'tzivos hashem'],
  ['נשים', 'women', 'nashim'],
  ['חתונה', 'wedding', 'chasuna', 'chasunah'],
  ['בר מצוה', 'bar mitzvah', 'bar mitzva'],
  ['ישיבה', 'yeshiva', 'yeshivah'],
  ['תמימים', 'temimim', 'tmimim'],
  ['תומכי תמימים', 'tomchei temimim'],
  ['חסידות', 'chassidus', 'chasidus', 'chassidut', 'chasidut', 'hasidism'],
  ['חסידים', 'chassidim', 'chasidim'],
  ['התוועדות', 'farbrengen', 'hisvaadus', 'hitvaadut'],
  ['רמב"ם', 'rambam', 'maimonides'],
  ['תניא', 'tanya'],
  ['זוהר', 'zohar'],
  ['קבלה', 'kabbalah', 'kabbala'],
  ['גמרא', 'gemara', 'talmud'],
  ['סיום', 'siyum'],
  ['הלכה', 'halacha', 'halachah', 'jewish law'],
  ['פרשה', 'parsha', 'parshah', 'parashah', 'weekly portion'],
  ['ארץ ישראל', 'eretz yisroel', 'eretz yisrael', 'land of israel', 'israel'],
  ['שלימות הארץ', 'shleimus haaretz', 'shlemut haaretz', 'safety of israel'],
  ['ירושלים', 'yerushalayim', 'jerusalem'],
  ['אדמו"ר הזקן', 'alter rebbe', 'baal hatanya'],
  ['אדמו"ר האמצעי', 'mitteler rebbe'],
  ['צמח צדק', 'tzemach tzedek'],
  ['מהר"ש', 'rebbe maharash', 'maharash'],
  ['מהורש"ב', 'rebbe rashab', 'rashab'],
  ['כ"ק מו"ח אדמו"ר', 'frierdiker rebbe', 'previous rebbe', 'rebbe rayatz', 'rayatz'],
  ['בעל שם טוב', 'baal shem tov', 'baal shem'],
  ['המגיד', 'maggid', 'the maggid'],
  ['לוי יצחק', 'levi yitzchok', 'levi yitzchak'],
  ['הרבנית חנה', 'rebbetzin chana'],
  ['הרבנית חי\' מושקא', 'rebbetzin chaya mushka', 'rebbetzin'],
  ['לכתחילה אריבער', 'lechatchila ariber', 'lechatchilah ariber'],
  ['ופרצת', 'ufaratzta', 'u\'faratzta'],
  ['דור השביעי', 'dor hashvii', 'seventh generation'],
  ['שבת', 'shabbos', 'shabbat', 'sabbath'],
  ['ראש השנה', 'rosh hashanah', 'rosh hashana'],
  ['יום כיפור', 'yom kippur'],
  ['סוכות', 'sukkos', 'sukkot', 'succos'],
  ['שמחת תורה', 'simchas torah', 'simchat torah'],
  ['חנוכה', 'chanukah', 'hanukkah', 'chanuka'],
  ['פורים', 'purim'],
  ['פסח', 'pesach', 'passover'],
  ['פסח שני', 'pesach sheini', 'pesach sheni'],
  ['ספירת העומר', 'sefiras haomer', 'sefirat haomer', 'counting the omer'],
  ['ל"ג בעומר', 'lag baomer', 'lag bomer'],
  ['שבועות', 'shavuos', 'shavuot'],
  ['מתן תורה', 'matan torah', 'giving of the torah'],
  ['תשעה באב', 'tisha bav', 'tisha beav'],
  ['בין המצרים', 'bein hametzarim', 'three weeks'],
  ['אלול', 'elul'],
  ['ט"ו בשבט', 'tu bishvat', 'tu beshvat'],
  ['י"ט כסלו', 'yud tes kislev', '19 kislev'],
  ['י"ב תמוז', 'yud beis tammuz', '12 tammuz'],
  ['י\' שבט', 'yud shevat', '10 shevat'],
  ['ראש חודש', 'rosh chodesh'],
  ['יום הולדת', 'birthday'],
  ['ברכה', 'bracha', 'brachah', 'blessing'],
  ['פרנסה', 'parnassah', 'parnasa', 'livelihood'],
  ['רפואה', 'refuah', 'refua', 'healing', 'health'],
  ['שלום', 'shalom', 'peace'],
  ['מלחמה', 'war', 'milchama'],
  ['צבא', 'army', 'soldiers', 'soldier'],
  ['נצחון', 'victory', 'nitzachon'],
  ['נס', 'miracle', 'nes'],
  ['אור', 'light', 'ohr'],
  ['חושך', 'darkness', 'choshech'],
  ['מעשה', 'action', 'maaseh'],
  ['מעשה הוא העיקר', 'maaseh hu haikar', 'action is the main thing'],
  ['הפצת המעיינות', 'hafatzas hamaayanos', 'spreading the wellsprings', 'spreading chassidus'],
  ['אהבת השם', 'ahavas hashem', 'love of g-d', 'love of god'],
];

const norm = s => String(s || '').toLowerCase().replace(/[’‘`'"״׳]/g, '').replace(/[^a-z0-9א-ת]+/g, ' ').trim();
const ENTRIES = TERMS.flatMap(([he, ...en]) => en.map(e => [norm(e), he])).sort((a, b) => b[0].length - a[0].length);

// Hebrew glues prefix letters onto words (ו and, ה the, ב in, ל to, מ from,
// ש that, כ like, ד of in Yiddish), so each word also matches with them.
const PREFIXES = ['ו', 'ה', 'ב', 'ל', 'מ', 'ש', 'כ', 'ד', 'וה', 'וב', 'ול', 'ומ', 'וש', 'שה', 'שב', 'של', 'מה', 'בה', 'לה', 'כש', 'וכש'];
const heWords = s => String(s || '').replace(/[֑-ׇ]/g, '').split(/[^א-ת]+/).filter(Boolean);
function wordQuery(w) {
  const forms = [w, ...(w.length >= 2 ? PREFIXES.map(p => p + w) : [])];
  return forms.length > 1 ? '(' + forms.join(' | ') + ')' : w;
}
// A Hebrew phrase as a tsquery: its words in order (a word split by ״, as in
// אדמו"ר, stays two adjacent words, the same way the texts were indexed).
function phraseQuery(he) {
  const w = heWords(he);
  if (!w.length) return null;
  return w.length === 1 ? wordQuery(w[0]) : '(' + w.map((x, i) => i === 0 ? wordQuery(x) : x).join(' <-> ') + ')';
}

// q: what was typed; topics: [{ name_en, name_he, aliases }]. Returns
// { tsq, terms } (terms: the Hebrew searched for), or null when nothing in
// the query can be looked for in the Hebrew texts.
export function textQuery(q, topics = []) {
  if (/[א-ת]/.test(q)) {
    const w = heWords(q);
    if (!w.length) return null;
    // A short phrase is searched as a phrase; a longer one as all its words.
    const tsq = w.length <= 4 ? phraseQuery(w.join(' ')) : w.map(wordQuery).join(' & ');
    return { tsq, terms: [w.join(' ')], typed: true };
  }
  let rest = ' ' + norm(q) + ' ';
  const terms = [];
  const entries = [...ENTRIES, ...topics.flatMap(t => t.name_he ? [t.name_en, ...(t.aliases || [])].map(e => [norm(e), t.name_he]) : [])]
    .filter(([e]) => e.length >= 3).sort((a, b) => b[0].length - a[0].length);
  for (const [en, he] of entries) {
    if (rest.includes(' ' + en + ' ')) { rest = rest.replace(' ' + en + ' ', ' '); if (!terms.includes(he)) terms.push(he); }
  }
  if (!terms.length) return null;
  const parts = terms.map(phraseQuery).filter(Boolean);
  // all the terms; anyTsq (any one of them) is tried when all finds too little
  return { tsq: parts.join(' & '), anyTsq: parts.length > 1 ? parts.join(' | ') : null, terms, typed: false };
}
