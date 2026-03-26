// ─────────────────────────────────────────────
// db.js — PostgreSQL via Supabase
// All database operations go through this file.
// server.js, gameManager.js, authManager.js, and
// triviaService.js call these functions and don't
// care what's underneath.
// ─────────────────────────────────────────────
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // required for Supabase
});

// Test connection on startup
pool.query('SELECT NOW()')
  .then(() => console.log('[DB] Connected to Supabase PostgreSQL'))
  .catch(e => console.error('[DB] Connection error:', e.message));

// ─────────────────────────────────────────────
// HOST HELPERS
// ─────────────────────────────────────────────
async function findHostByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM hosts WHERE email = $1',
    [email]
  );
  return rows[0] ?? null;
}

async function findHostById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM hosts WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

async function findHostByGoogleId(googleId) {
  const { rows } = await pool.query(
    'SELECT * FROM hosts WHERE google_id=$1', [googleId]
  );
  return rows[0] ?? null;
}

async function updateHost(id, fields) {
  const setClauses = [];
  const values     = [];
  let   i          = 1;
  for (const [key, val] of Object.entries(fields)) {
    setClauses.push(`${key}=$${i++}`);
    values.push(val);
  }
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE hosts SET ${setClauses.join(',')} WHERE id=$${i} RETURNING *`,
    values
  );
  return rows[0];
}

async function insertHost({ full_name, display_name, email, password_hash, google_id }) {
  const { rows } = await pool.query(
    `INSERT INTO hosts (full_name, display_name, email, password_hash, google_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [full_name, display_name, email, password_hash ?? null, google_id ?? null]
  );
  return rows[0];
}

// ─────────────────────────────────────────────
// GAME HELPERS
// ─────────────────────────────────────────────
async function insertGame({ host_id, room_name, location, category_id,
                            category_name, room_key, total_players, started_at }) {
  const { rows } = await pool.query(
    `INSERT INTO games
       (host_id, room_name, location, category_id, category_name,
        room_key, total_players, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [host_id, room_name, location, category_id, category_name,
     room_key, total_players, started_at]
  );
  return rows[0];
}

async function updateGame(id, { winner_nickname, total_questions, ended_at }) {
  await pool.query(
    `UPDATE games
     SET winner_nickname=$1, total_questions=$2, ended_at=$3
     WHERE id=$4`,
    [winner_nickname, total_questions, ended_at, id]
  );
}

async function getGamesByHostId(host_id) {
  const { rows } = await pool.query(
    `SELECT * FROM games WHERE host_id=$1 ORDER BY started_at DESC LIMIT 18`,
    [host_id]
  );
  return rows;
}

// ─────────────────────────────────────────────
// PROMOTIONS HELPERS
// ─────────────────────────────────────────────
async function getPromotions(hostId) {
  const { rows } = await pool.query(
    'SELECT venue, host_data FROM promotions WHERE host_id=$1',
    [String(hostId)]
  );
  if (!rows[0]) return { venue: [], host: [] };
  return {
    venue: rows[0].venue      || [],
    host:  rows[0].host_data  || []
  };
}

async function savePromotions(hostId, { venue, host }) {
  await pool.query(
    `INSERT INTO promotions (host_id, venue, host_data)
     VALUES ($1, $2, $3)
     ON CONFLICT (host_id) DO UPDATE
       SET venue=$2, host_data=$3`,
    [String(hostId), JSON.stringify(venue), JSON.stringify(host)]
  );
}

// ─────────────────────────────────────────────
// USED QUESTIONS HELPERS
// ─────────────────────────────────────────────
async function getUsedQuestions(categorySlug) {
  const { rows } = await pool.query(
    'SELECT question_id FROM used_questions WHERE category_slug=$1',
    [categorySlug]
  );
  return new Set(rows.map(r => r.question_id));
}

async function markQuestionsUsed(categorySlug, ids) {
  for (const id of ids) {
    await pool.query(
      `INSERT INTO used_questions (category_slug, question_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [categorySlug, id]
    );
  }
}

async function resetUsedQuestions(categorySlug) {
  await pool.query(
    'DELETE FROM used_questions WHERE category_slug=$1',
    [categorySlug]
  );
}

// ─────────────────────────────────────────────
// PLAYER ACCOUNT HELPERS
// ─────────────────────────────────────────────
async function findPlayerByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM player_accounts WHERE email=$1', [email]
  );
  return rows[0] ?? null;
}

async function findPlayerByDisplayName(displayName) {
  const { rows } = await pool.query(
    'SELECT * FROM player_accounts WHERE LOWER(display_name)=LOWER($1)', [displayName]
  );
  return rows[0] ?? null;
}

async function findPlayerById(id) {
  const { rows } = await pool.query(
    'SELECT * FROM player_accounts WHERE id=$1', [id]
  );
  return rows[0] ?? null;
}

async function findPlayerByGoogleId(googleId) {
  const { rows } = await pool.query(
    'SELECT * FROM player_accounts WHERE google_id=$1', [googleId]
  );
  return rows[0] ?? null;
}

async function insertPlayer({ full_name, display_name, email, password_hash, google_id }) {
  const { rows } = await pool.query(
    `INSERT INTO player_accounts (full_name, display_name, email, password_hash, google_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [full_name, display_name, email, password_hash ?? null, google_id ?? null]
  );
  // Create stats row
  await pool.query(
    'INSERT INTO player_stats (player_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [rows[0].id]
  );
  return rows[0];
}

async function getPlayerStats(playerId) {
  const { rows } = await pool.query(
    'SELECT * FROM player_stats WHERE player_id=$1', [playerId]
  );
  return rows[0] ?? null;
}

async function updatePlayerStats(playerId, { won, correct, incorrect, qualified, reachedMindfield, mfRoundsWon }) {
  await pool.query(
    `INSERT INTO player_stats (player_id, games_played, games_won, questions_correct, questions_incorrect, mindfield_rounds, mindfield_rounds_won)
     VALUES ($1,1,$2,$3,$4,$5,$6)
     ON CONFLICT (player_id) DO UPDATE SET
       games_played         = player_stats.games_played + 1,
       games_won            = player_stats.games_won + $2,
       questions_correct    = player_stats.questions_correct + $3,
       questions_incorrect  = player_stats.questions_incorrect + $4,
       mindfield_rounds     = player_stats.mindfield_rounds + $5,
       mindfield_rounds_won = player_stats.mindfield_rounds_won + $6`,
    [playerId, won ? 1 : 0, correct, incorrect, reachedMindfield ? 1 : 0, mfRoundsWon || 0]
  );
}

async function insertPlayerGameHistory({ player_id, game_id, room_name, venue, qualified, won, questions_correct, questions_incorrect, reached_mindfield }) {
  await pool.query(
    `INSERT INTO player_game_history
       (player_id, game_id, room_name, venue, qualified, won, questions_correct, questions_incorrect, reached_mindfield)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [player_id, game_id ?? null, room_name ?? null, venue ?? null, qualified, won, questions_correct, questions_incorrect, reached_mindfield]
  );
}

async function updatePlayerDisplayName(playerId, displayName) {
  const { rows } = await pool.query(
    'UPDATE player_accounts SET display_name=$1 WHERE id=$2 RETURNING *',
    [displayName, playerId]
  );
  return rows[0];
}

async function getPlayerGameHistory(playerId) {
  const { rows } = await pool.query(
    `SELECT * FROM player_game_history WHERE player_id=$1 ORDER BY played_at DESC LIMIT 5`,
    [playerId]
  );
  return rows;
}

module.exports = {
  findHostByEmail,
  findHostByGoogleId,
  updateHost,
  findHostById,
  insertHost,
  insertGame,
  updateGame,
  getGamesByHostId,
  getPromotions,
  savePromotions,
  getUsedQuestions,
  markQuestionsUsed,
  resetUsedQuestions,
  findPlayerByEmail,
  findPlayerByDisplayName,
  findPlayerById,
  findPlayerByGoogleId,
  insertPlayer,
  getPlayerStats,
  updatePlayerStats,
  insertPlayerGameHistory,
  updatePlayerDisplayName,
  getPlayerGameHistory
};
