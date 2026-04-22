const https = require('https');
const db    = require('./db');

const BASE_URL = 'https://the-trivia-api.com/v2/questions';

const CATEGORIES = [
  { id: 'general_knowledge',   name: 'General Knowledge'  },
  { id: 'history',             name: 'History'             },
  { id: 'science',             name: 'Science'             },
  { id: 'sport_and_leisure',   name: 'Sport & Leisure'     },
  { id: 'film_and_tv',         name: 'Film & TV'           },
  { id: 'music',               name: 'Music'               },
  { id: 'food_and_drink',      name: 'Food & Drink'        },
  { id: 'geography',           name: 'Geography'           },
  { id: 'society_and_culture', name: 'Society & Culture'   },
  { id: 'arts_and_literature', name: 'Arts & Literature'   },
];

const CUSTOM_PREFIX = 'custom:';

function isCustomCategory(slug) {
  return slug && slug.startsWith(CUSTOM_PREFIX);
}

function customCategoryName(slug) {
  return slug.replace(CUSTOM_PREFIX, '');
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse response')); }
      });
    }).on('error', reject);
  });
}

async function getCategories() {
  const customCats = await db.getCustomCategories();
  const customList = customCats.map(c => ({
    id:   CUSTOM_PREFIX + c,
    name: c + ' ★'
  }));
  return [
    { id: 'all', name: '🎲 All Categories (Mixed)' },
    ...CATEGORIES,
    ...customList
  ];
}

async function fetchQuestions(categorySlug, difficulty, limit) {
  const params = new URLSearchParams({
    limit:        String(limit),
    categories:   categorySlug,
    difficulties: difficulty,
    regions:      'US',
  });

  let questions = await httpsGet(`${BASE_URL}?${params}`);

  if (!Array.isArray(questions) || questions.length < Math.min(limit, 5)) {
    await new Promise(r => setTimeout(r, 400));
    const params2 = new URLSearchParams({
      limit:        String(limit),
      categories:   categorySlug,
      difficulties: difficulty,
    });
    questions = await httpsGet(`${BASE_URL}?${params2}`);
  }

  if (!Array.isArray(questions)) return [];

  return questions.map(q => ({
    id:         q.id || q.question?.text || Math.random().toString(36),
    question:   q.question?.text || '',
    correct:    q.correctAnswer  || '',
    choices:    shuffle([q.correctAnswer, ...(q.incorrectAnswers || [])]),
    difficulty: q.difficulty     || difficulty,
  })).filter(q => q.question && q.correct);
}

async function buildAllCategoriesPool(target) {
  console.log(`[Trivia] Building mixed pool — ${target} questions across all categories`);
  const slugs  = CATEGORIES.map(c => c.id);
  const perCat = Math.ceil(target / slugs.length);
  const all    = [];

  for (const slug of slugs) {
    try {
      const qs = await fetchQuestions(slug, 'medium', perCat);
      all.push(...qs);
      await new Promise(r => setTimeout(r, 200));
    } catch {}
  }

  const seen   = new Set();
  const unique = all.filter(q => {
    if (seen.has(q.question)) return false;
    seen.add(q.question);
    return true;
  });

  const pool = shuffle(unique).slice(0, target);
  if (pool.length < MIN_QUESTIONS) {
    throw new Error(`Could not fetch enough mixed questions (got ${pool.length})`);
  }
  console.log(`[Trivia] Mixed pool ready: ${pool.length} questions`);
  return pool;
}

async function buildCustomQuestionPool(categorySlug) {
  const categoryName = customCategoryName(categorySlug);
  console.log(`[Trivia] Building CUSTOM pool for: ${categoryName}`);
  const rows = await db.getCustomQuestions(categoryName);
  if (!rows || rows.length < MIN_QUESTIONS) {
    throw new Error(`Not enough custom questions in "${categoryName}" (found ${rows?.length || 0}, need ${MIN_QUESTIONS}).`);
  }
  const order = { easy: 0, medium: 1, hard: 2 };
  const questions = rows
    .map(r => ({
      id:         String(r.id),
      question:   r.question,
      correct:    r.correct,
      choices:    shuffle([r.correct, r.wrong1, r.wrong2, r.wrong3].filter(Boolean)),
      difficulty: r.difficulty
    }))
    .sort((a, b) => (order[a.difficulty] || 1) - (order[b.difficulty] || 1));
  console.log(`[Trivia] Custom pool ready: ${questions.length} questions`);
  return questions;
}

const MIN_QUESTIONS = 15;

async function buildQuestionPool(categorySlug) {
  if (isCustomCategory(categorySlug)) return buildCustomQuestionPool(categorySlug);
  if (categorySlug === 'all') return buildAllCategoriesPool(25);

  console.log(`[Trivia] Building pool for: ${categorySlug}`);
  const [easy, medium, hard] = await Promise.all([
    fetchQuestions(categorySlug, 'easy',   20),
    fetchQuestions(categorySlug, 'medium', 20),
    fetchQuestions(categorySlug, 'hard',   20),
  ]);
  console.log(`[Trivia] Fetched easy:${easy.length} medium:${medium.length} hard:${hard.length}`);

  const all = [...easy, ...medium, ...hard];
  const seenText = new Set();
  const unique = all.filter(q => {
    if (seenText.has(q.question)) return false;
    seenText.add(q.question);
    return true;
  });

  let usedIds = await db.getUsedQuestions(categorySlug);
  let fresh   = unique.filter(q => !usedIds.has(q.id));
  console.log(`[Trivia] ${usedIds.size} previously used — ${fresh.length} fresh available`);

  if (fresh.length < MIN_QUESTIONS) {
    console.log(`[Trivia] Pool nearly exhausted — resetting used history for ${categorySlug}`);
    await db.resetUsedQuestions(categorySlug);
    fresh = unique;
  }

  if (fresh.length < MIN_QUESTIONS) {
    throw new Error(`Not enough questions available in this category (found ${fresh.length}, need ${MIN_QUESTIONS}).`);
  }

  await db.markQuestionsUsed(categorySlug, fresh.map(q => q.id));
  console.log(`[Trivia] Pool ready: ${fresh.length} questions`);
  return fresh;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { getCategories, buildQuestionPool, isCustomCategory };
