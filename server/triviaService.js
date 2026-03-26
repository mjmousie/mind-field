const https = require('https');
const db    = require('./db');

// ─────────────────────────────────────────────
// The Trivia API v2  (the-trivia-api.com)
// Free, no API key required
// US-region filter + used-question deduplication
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// FETCH HELPER
// ─────────────────────────────────────────────
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
  return CATEGORIES;
}

// ─────────────────────────────────────────────
// FETCH QUESTIONS
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// BUILD POOL
// Filters out previously used questions.
// If too many have been used, resets the history
// for that category so the pool never runs dry.
// ─────────────────────────────────────────────
const MIN_QUESTIONS = 15;

async function buildQuestionPool(categorySlug) {
  console.log(`[Trivia] Building pool for: ${categorySlug}`);

  const [easy, medium, hard] = await Promise.all([
    fetchQuestions(categorySlug, 'easy',   20),
    fetchQuestions(categorySlug, 'medium', 20),
    fetchQuestions(categorySlug, 'hard',   20),
  ]);

  console.log(`[Trivia] Fetched easy:${easy.length} medium:${medium.length} hard:${hard.length}`);

  const all = [...easy, ...medium, ...hard];

  // Deduplicate by question text within this fetch
  const seenText = new Set();
  const unique = all.filter(q => {
    if (seenText.has(q.question)) return false;
    seenText.add(q.question);
    return true;
  });

  // Filter out previously used questions
  let usedIds = await db.getUsedQuestions(categorySlug);
  let fresh   = unique.filter(q => !usedIds.has(q.id));

  console.log(`[Trivia] ${usedIds.size} previously used — ${fresh.length} fresh available`);

  // If not enough fresh questions, reset history and use everything
  if (fresh.length < MIN_QUESTIONS) {
    console.log(`[Trivia] Pool nearly exhausted — resetting used history for ${categorySlug}`);
    await db.resetUsedQuestions(categorySlug);
    fresh = unique;
  }

  if (fresh.length < MIN_QUESTIONS) {
    throw new Error(
      `Not enough questions available in this category (found ${fresh.length}, need ${MIN_QUESTIONS}). ` +
      `Please choose a different category.`
    );
  }

  // Mark these questions as used for next time
  await db.markQuestionsUsed(categorySlug, fresh.map(q => q.id));

  console.log(`[Trivia] Pool ready: ${fresh.length} questions`);
  return fresh;
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { getCategories, buildQuestionPool };
