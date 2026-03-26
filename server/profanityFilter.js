// ─────────────────────────────────────────────
// profanityFilter.js
// Catches profanity, slurs, and inappropriate
// nicknames including partial words and common
// letter substitutions (leet-speak).
// ─────────────────────────────────────────────

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/6/g, 'g')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/\+/g, 't')
    .replace(/[^a-z]/g, '');
}

// Each entry is tested as a substring of the
// normalized nickname — so 'nig' catches 'nig',
// 'nigg', 'nigger', 'nigga' etc.
const BLOCKED = [

  // ── General profanity ───────────────────────
  'fuck', 'fuk', 'fvck', 'fck', 'fucc',
  'shit', 'sht',
  'ass', 'arse',
  'bitch', 'biatch',
  'cunt', 'cvnt',
  'cock', 'cok',
  'dick', 'dik',
  'pussy', 'puss',
  'bastard',
  'piss',
  'whore', 'whor',
  'slut',
  'prick',
  'twat',
  'wank',
  'crap',
  'damn',

  // ── Racial slurs (roots — catches all variants) ──
  'nig',          // nigg, nigger, nigga, nigs
  'chink',
  'gook',
  'spic', 'spick',
  'kike',
  'wetback',
  'beaner',
  'honky', 'honkey',
  'towelhead',
  'raghead',
  'sandnig',
  'zipperhead',
  'greaseball',
  'dago',
  'wop',
  'polack',
  'kraut',
  'jap',
  'coon',
  'sambo',
  'redskin',
  'injun',
  'cholo',
  'spook',
  'pickaninny',
  'darky', 'darkie',
  'negro',
  'mulatto',
  'halfbreed',
  'yellowskin',
  'brownskin',
  'blackie',
  'whitey',
  'cracker',

  // ── Homophobic / transphobic slurs ──────────
  'fag',          // catches faggot, fagot, fags
  'dyke',
  'tranny',
  'shemale',
  'heshe',
  'gayboy',
  'gayboi',
  'gaywad',
  'gaytard',
  'gayroom',
  'gaybar',
  'gaybash',
  'gayhate',
  'gaypride',     // used derogatorily
  'gayporn',
  'homo',
  'homie',        // only when paired — too common alone, skip
  'lesbo',
  'sissy',
  'poofter',
  'poof',
  'queer',
  'pansy',
  'femboy',
  'bender',
  'battyboy',
  'sodomite',

  // ── Sexual content ───────────────────────────
  'penis', 'peni',
  'vagina', 'vagin',
  'vulva',
  'boob', 'tit',
  'butt',
  'anal', 'anus',
  'porn',
  'dildo',
  'masturbat',
  'cum',
  'jizz', 'jism',
  'sperm', 'semen',
  'blowjob', 'handjob', 'rimjob',
  'erection', 'boner',
  'nude', 'naked',
  'sext',
  'incest',
  'rape', 'rapist',
  'molest',
  'pedophile', 'pedo',
  'pervert', 'perv',

  // ── Hate / extremism ────────────────────────
  'nazi',
  'hitler',
  'heil',
  'kkk',
  'klan',
  'isis',
  'jihad',
  'terrorist',
  'supremacist',

  // ── Misc inappropriate ───────────────────────
  'retard',
  'autist',
  'tard',
  'idiot',
  'moron',
  'imbecile',
  'psycho',
  'lunatic',
  'mental',
];

// Words that are fine alone but offensive as part of a compound
const OFFENSIVE_COMPOUNDS = [
  { trigger: 'gay', companions: ['room','bar','boy','boi','wad','tard','bash','porn','sex','club','hate','slur','joke','man','men','girl','women','lady','lord','king','lord','ass','fuck','shit','cunt','dick','cock','bitch','whore','slut'] },
  { trigger: 'trans', companions: ['bash','hate','phobe','phobic','joke','slur'] },
];

function hasOffensiveCompound(normalized) {
  for (const { trigger, companions } of OFFENSIVE_COMPOUNDS) {
    if (normalized.includes(trigger)) {
      for (const companion of companions) {
        if (normalized.includes(companion)) return true;
      }
    }
  }
  return false;
}

function isClean(text) {
  if (!text || typeof text !== 'string') return false;
  const n = normalize(text);
  for (const word of BLOCKED) {
    if (n.includes(word)) {
      console.log(`[Filter] Blocked "${text}" — matched: "${word}"`);
      return false;
    }
  }
  if (hasOffensiveCompound(n)) {
    console.log(`[Filter] Blocked "${text}" — offensive compound detected`);
    return false;
  }
  return true;
}

module.exports = { isClean };
