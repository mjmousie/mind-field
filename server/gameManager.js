const { buildQuestionPool } = require('./triviaService');
const db = require('./db');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const COUNTDOWN_SECS    = 10;
const QUESTION_SECS     = 15;
const BREAK_SECS        = 4;
const REVEAL_INTRO_SECS = 3;
const REVEAL_SHOW_SECS  = 3;
const QUAL_COUNT        = 10;
const QUAL_THRESHOLD    = 7;
const TRANSITION_SECS   = 15;

// ─────────────────────────────────────────────
// ROOM STORE
// ─────────────────────────────────────────────
const rooms = new Map();

function generateRoomKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key;
  do {
    key = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(key));
  return key;
}

// ─────────────────────────────────────────────
// ROOM LIFECYCLE
// ─────────────────────────────────────────────
function createRoom({ hostId, hostName, roomName, location, categoryId, categoryName }) {
  const roomKey = generateRoomKey();
  const room = {
    roomKey, hostId, hostName, roomName, location, categoryId, categoryName,
    hostSocketId:   null,
    players:        new Map(),
    status:         'waiting',
    phase:          'qualification',  // 'qualification' | 'transition' | 'mindfield'
    questions:      [],
    qualIndex:      0,    // 0-9 during qualification
    mfIndex:        0,    // 0-N during mindfield
    totalStarted:   0,
    qualThreshold:  QUAL_THRESHOLD,
    startedAt:      null,
    gameId:         null,
    timers:         {}
  };
  rooms.set(roomKey, room);
  return room;
}

function getRoom(roomKey)      { return rooms.get(roomKey) ?? null; }
function getRoomByHostId(hostId) {
  for (const room of rooms.values()) { if (room.hostId === hostId) return room; }
  return null;
}
function deleteRoom(roomKey) {
  const room = rooms.get(roomKey);
  if (!room) return;
  Object.values(room.timers).forEach(t => clearTimeout(t));
  rooms.delete(roomKey);
}

// ─────────────────────────────────────────────
// PLAYER MANAGEMENT
// ─────────────────────────────────────────────
function addPlayer(roomKey, socketId, nickname) {
  const room = rooms.get(roomKey);
  if (!room) return { error: 'Room not found' };

  if (room.status !== 'waiting') {
    for (const [oldId, p] of room.players.entries()) {
      if (p.nickname.toLowerCase() === nickname.toLowerCase()) {
        room.players.delete(oldId);
        room.players.set(socketId, p);
        return { success: true, rejoined: true, player: p };
      }
    }
    return { error: 'Game already in progress' };
  }

  for (const p of room.players.values()) {
    if (p.nickname.toLowerCase() === nickname.toLowerCase()) {
      return { error: 'That nickname is already taken in this room' };
    }
  }

  room.players.set(socketId, {
    nickname,
    active:         true,
    answered:       false,
    selectedAnswer: null,
    correct:        false,
    qualScore:      0,
    qualified:      false,
    playerId:       null,   // set after token verification
    qualCorrect:    0,
    qualIncorrect:  0,
    mfCorrect:      0,
    mfIncorrect:    0
  });
  return { success: true };
}

function removePlayer(roomKey, socketId) {
  const room = rooms.get(roomKey);
  if (room) room.players.delete(socketId);
}

function setPlayerAccount(roomKey, socketId, playerId) {
  const room = rooms.get(roomKey);
  if (!room) return;
  const player = room.players.get(socketId);
  if (player) player.playerId = playerId;
}

function getPlayerList(room) {
  return Array.from(room.players.values()).map(p => ({
    nickname:  p.nickname,
    active:    p.active,
    qualScore: p.qualScore,
    qualified: p.qualified
  }));
}

function getActivePlayers(room) {
  return Array.from(room.players.entries())
    .filter(([, p]) => p.active)
    .map(([socketId, p]) => ({ socketId, nickname: p.nickname }));
}

function getScores(room) {
  return Array.from(room.players.values())
    .map(p => ({ nickname: p.nickname, score: p.qualScore }))
    .sort((a, b) => b.score - a.score);
}

// ─────────────────────────────────────────────
// GAME START
// ─────────────────────────────────────────────
async function startGame(roomKey, io) {
  const room = rooms.get(roomKey);
  if (!room)                     return { error: 'Room not found' };
  if (room.status !== 'waiting') return { error: 'Game is not in waiting state' };
  if (room.players.size < 1)     return { error: 'No players have joined yet' };

  try {
    room.questions = await buildQuestionPool(room.categoryId);
  } catch (e) {
    return { error: e.message };
  }

  room.status       = 'countdown';
  room.phase        = 'qualification';
  room.qualIndex    = 0;
  room.mfIndex      = 0;
  room.totalStarted = room.players.size;
  room.startedAt    = new Date();

  const dbGame = await db.insertGame({
    host_id:       room.hostId,
    room_name:     room.roomName,
    location:      room.location,
    category_id:   room.categoryId,
    category_name: room.categoryName,
    room_key:      room.roomKey,
    total_players: room.players.size,
    started_at:    room.startedAt.toISOString()
  });
  room.gameId = dbGame.id;

  broadcastCountdown(roomKey, io, COUNTDOWN_SECS, () => startQualRound(roomKey, io), 'game:countdown');
  return { success: true };
}

// ─────────────────────────────────────────────
// QUALIFICATION ROUND
// ─────────────────────────────────────────────
function startQualRound(roomKey, io) {
  const room = rooms.get(roomKey);
  if (!room) return;

  room.status = 'active';

  if (room.qualIndex >= QUAL_COUNT) {
    endQualification(roomKey, io);
    return;
  }

  const q = room.questions[room.qualIndex];

  // Reset per-round answer state
  for (const p of room.players.values()) {
    p.answered = false; p.selectedAnswer = null; p.correct = false;
  }

  const basePayload = {
    phase:       'qualification',
    round:       room.qualIndex + 1,
    totalRounds: QUAL_COUNT,
    question:    q.question,
    choices:     q.choices,
    timer:       QUESTION_SECS,
    difficulty:  q.difficulty
  };

  // Host gets base payload
  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit('game:question', basePayload);
  }
  // Each player gets payload + their personal score
  for (const [socketId, player] of room.players.entries()) {
    io.to(socketId).emit('game:question', {
      ...basePayload,
      playerScore: player.qualScore
    });
  }

  let timeLeft = QUESTION_SECS;
  const tick = () => {
    const r = rooms.get(roomKey);
    if (!r) return;
    const allIn = Array.from(r.players.values()).every(p => p.answered);
    if (allIn) { revealQualAnswer(roomKey, io); return; }
    timeLeft--;
    io.to(roomKey).emit('game:timer', { timeLeft });
    if (timeLeft <= 0) revealQualAnswer(roomKey, io);
    else r.timers.question = setTimeout(tick, 1000);
  };
  room.timers.question = setTimeout(tick, 1000);
}

function revealQualAnswer(roomKey, io) {
  const room = rooms.get(roomKey);
  if (!room) return;

  clearTimeout(room.timers.question);
  room.status = 'reveal';

  const q = room.questions[room.qualIndex];

  // Phase 1 — "And the correct answer is..."
  io.to(roomKey).emit('game:reveal-intro');

  room.timers.revealIntro = setTimeout(() => {
    const r2 = rooms.get(roomKey);
    if (!r2) return;

    // Phase 2 — show correct answer + update scores
    for (const player of r2.players.values()) {
      if (player.answered && player.selectedAnswer === q.correct) {
        player.correct     = true;
        player.qualScore  += 1;
        player.qualCorrect += 1;
      } else if (player.answered) {
        player.qualIncorrect += 1;
      }
    }

    io.to(roomKey).emit('game:reveal', {
      correctAnswer: q.correct,
      phase:         'qualification'
    });

    // Emit scores update to host
    io.to(roomKey).emit('game:scores-update', { scores: getScores(r2) });

    room.timers.revealShow = setTimeout(() => {
      const r3 = rooms.get(roomKey);
      if (!r3) return;

      // Send personal qual result to each player
      for (const [socketId, player] of r3.players.entries()) {
        io.to(socketId).emit('game:qual-result', {
          result:      player.correct ? 'correct' : 'wrong',
          score:       player.qualScore,
          round:       r3.qualIndex + 1,
          totalRounds: QUAL_COUNT
        });
      }

      const isLastQual = r3.qualIndex >= QUAL_COUNT - 1;

      if (isLastQual) {
        // Go to qualification end
        endQualification(roomKey, io);
      } else {
        broadcastCountdown(roomKey, io, BREAK_SECS, () => {
          const r4 = rooms.get(roomKey);
          if (!r4) return;
          r4.qualIndex++;
          startQualRound(roomKey, io);
        }, 'game:break');
      }
    }, REVEAL_SHOW_SECS * 1000);

  }, REVEAL_INTRO_SECS * 1000);
}

function endQualification(roomKey, io) {
  const room = rooms.get(roomKey);
  if (!room) return;

  room.status = 'transition';
  room.phase  = 'transition';

  const allScores = getScores(room);

  // Determine threshold — lower it until at least 2 qualify
  let threshold = QUAL_THRESHOLD;
  let qualifiers;
  while (threshold >= 0) {
    qualifiers = allScores.filter(s => s.score >= threshold);
    if (qualifiers.length >= 2) break;
    threshold--;
  }
  // If still < 2 (everyone tied at 0), just take everyone
  if (!qualifiers || qualifiers.length < 2) {
    qualifiers = allScores;
    threshold  = 0;
  }

  room.qualThreshold = threshold;

  // Mark players qualified/not
  const qualSet = new Set(qualifiers.map(q => q.nickname));
  for (const player of room.players.values()) {
    player.qualified = qualSet.has(player.nickname);
  }

  io.to(roomKey).emit('game:qualification-end', {
    qualifiers,
    threshold,
    allScores,
    transitionSecs: TRANSITION_SECS
  });

  // Transition countdown then start Mind Field
  broadcastCountdown(roomKey, io, TRANSITION_SECS,
    () => startMindField(roomKey, io), 'game:transition');
}

// ─────────────────────────────────────────────
// MIND FIELD ROUND
// ─────────────────────────────────────────────
function startMindField(roomKey, io) {
  const room = rooms.get(roomKey);
  if (!room) return;

  room.phase   = 'mindfield';
  room.status  = 'active';
  room.mfIndex = 0;

  // Deactivate non-qualifiers
  for (const player of room.players.values()) {
    player.active = player.qualified;
  }

  const active = getActivePlayers(room);

  // Edge case: only 1 qualifier → they win immediately
  if (active.length <= 1) {
    const winner = active[0]?.nickname ?? null;
    endGame(roomKey, io, winner);
    return;
  }

  io.to(roomKey).emit('game:mindfield-start', {
    qualifiers: active.map(p => p.nickname)
  });

  // Small pause then begin
  room.timers.mfStart = setTimeout(() => startMfRound(roomKey, io), 2000);
}

function startMfRound(roomKey, io) {
  const room = rooms.get(roomKey);
  if (!room) return;

  room.status = 'active';

  const qIndex = QUAL_COUNT + room.mfIndex;
  if (qIndex >= room.questions.length) {
    endGame(roomKey, io, null);
    return;
  }

  const q = room.questions[qIndex];

  for (const p of room.players.values()) {
    if (p.active) { p.answered = false; p.selectedAnswer = null; p.correct = false; }
  }

  const basePayload = {
    phase:      'mindfield',
    round:      room.mfIndex + 1,
    question:   q.question,
    choices:    q.choices,
    timer:      QUESTION_SECS,
    difficulty: q.difficulty
  };

  if (room.hostSocketId) io.to(room.hostSocketId).emit('game:question', basePayload);
  for (const [socketId, player] of room.players.entries()) {
    if (player.active) io.to(socketId).emit('game:question', basePayload);
  }

  let timeLeft = QUESTION_SECS;
  const tick = () => {
    const r = rooms.get(roomKey);
    if (!r) return;
    const active = getActivePlayers(r);
    const allIn  = active.length > 0 && active.every(p => r.players.get(p.socketId)?.answered);
    if (allIn) { revealMfAnswer(roomKey, io); return; }
    timeLeft--;
    io.to(roomKey).emit('game:timer', { timeLeft });
    if (timeLeft <= 0) revealMfAnswer(roomKey, io);
    else r.timers.question = setTimeout(tick, 1000);
  };
  room.timers.question = setTimeout(tick, 1000);
}

function revealMfAnswer(roomKey, io) {
  const room = rooms.get(roomKey);
  if (!room) return;

  clearTimeout(room.timers.question);
  room.status = 'reveal';

  const q = room.questions[QUAL_COUNT + room.mfIndex];

  io.to(roomKey).emit('game:reveal-intro');

  room.timers.revealIntro = setTimeout(() => {
    const r2 = rooms.get(roomKey);
    if (!r2) return;

    for (const player of r2.players.values()) {
      if (player.active) {
        player.correct = player.answered && player.selectedAnswer === q.correct;
        if (player.correct) {
          player.mfCorrect += 1;
        } else if (player.answered) {
          player.mfIncorrect += 1;
        }
      }
    }

    io.to(roomKey).emit('game:reveal', {
      correctAnswer: q.correct,
      phase:         'mindfield'
    });

    room.timers.revealShow = setTimeout(() => {
      const r3 = rooms.get(roomKey);
      if (!r3) return;

      // Count survivors before sending results
      let survivors = 0;
      for (const p of r3.players.values()) {
        if (p.active && p.correct) survivors++;
      }

      for (const [socketId, player] of r3.players.entries()) {
        if (!player.active) continue;
        io.to(socketId).emit('player:result', {
          result:      player.correct ? 'correct' : 'wrong',
          nextRoundIn: BREAK_SECS
        });
      }

      if (survivors <= 1) {
        eliminateMfPlayers(roomKey, io);
      } else {
        broadcastCountdown(roomKey, io, BREAK_SECS, () => eliminateMfPlayers(roomKey, io), 'game:break');
      }
    }, REVEAL_SHOW_SECS * 1000);

  }, REVEAL_INTRO_SECS * 1000);
}

function eliminateMfPlayers(roomKey, io) {
  const room = rooms.get(roomKey);
  if (!room) return;

  const eliminated = [];
  for (const [socketId, player] of room.players.entries()) {
    if (player.active && !player.correct) {
      player.active = false;
      eliminated.push({ socketId, nickname: player.nickname });
    }
  }

  const activePlayers = getActivePlayers(room);

  io.to(roomKey).emit('game:eliminations', {
    eliminated:   eliminated.map(e => e.nickname),
    playerList:   getPlayerList(room),
    activeCount:  activePlayers.length,
    totalStarted: room.totalStarted
  });

  if (activePlayers.length <= 1) {
    endGame(roomKey, io, activePlayers[0]?.nickname ?? null);
    return;
  }

  room.mfIndex++;
  startMfRound(roomKey, io);
}

// ─────────────────────────────────────────────
// PLAYER ANSWER  (phase-aware)
// ─────────────────────────────────────────────
function playerAnswer(roomKey, socketId, answer, io) {
  const room = rooms.get(roomKey);
  if (!room || room.status !== 'active') return;

  const player = room.players.get(socketId);
  if (!player || player.answered) return;

  // During qual, all players are active. During MF, only active ones.
  if (room.phase === 'mindfield' && !player.active) return;

  player.answered       = true;
  player.selectedAnswer = answer;

  // In MF, check early-end if all active answered
  if (room.phase === 'mindfield') {
    const active = getActivePlayers(room);
    if (active.every(p => room.players.get(p.socketId)?.answered)) {
      clearTimeout(room.timers.question);
      revealMfAnswer(roomKey, io);
    }
  } else {
    // Qual: end early if everyone answered
    if (Array.from(room.players.values()).every(p => p.answered)) {
      clearTimeout(room.timers.question);
      revealQualAnswer(roomKey, io);
    }
  }
}

// ─────────────────────────────────────────────
// SAVE PLAYER STATS  (called at end or on leave)
// ─────────────────────────────────────────────
async function savePlayerStats(room, player, won) {
  if (!player.playerId) return; // guest — skip
  try {
    await db.updatePlayerStats(player.playerId, {
      won,
      correct:           player.qualCorrect + player.mfCorrect,
      incorrect:         player.qualIncorrect + player.mfIncorrect,
      qualified:         player.qualified,
      reachedMindfield:  player.qualified,
      mfRoundsWon:       player.mfCorrect  // each correct MF answer = 1 round survived
    });
    await db.insertPlayerGameHistory({
      player_id:           player.playerId,
      game_id:             room.gameId,
      room_name:           room.roomName,
      venue:               room.location,
      qualified:           player.qualified,
      won,
      questions_correct:   player.qualCorrect + player.mfCorrect,
      questions_incorrect: player.qualIncorrect + player.mfIncorrect,
      reached_mindfield:   player.qualified
    });
  } catch (e) {
    console.error('[Stats] Failed to save for player', player.nickname, e.message);
  }
}

// ─────────────────────────────────────────────
// END GAME
// ─────────────────────────────────────────────
async function endGame(roomKey, io, winnerNickname) {
  const room = rooms.get(roomKey);
  if (!room) return;

  room.status = 'ended';
  const endedAt      = new Date();
  const totalPlayers = room.players.size;
  const totalRounds  = room.phase === 'mindfield'
    ? QUAL_COUNT + room.mfIndex + 1
    : QUAL_COUNT;

  if (room.gameId) {
    await db.updateGame(room.gameId, {
      winner_nickname: winnerNickname,
      total_questions: totalRounds,
      ended_at:        endedAt.toISOString()
    });
  }

  // Save stats for all registered players
  for (const player of room.players.values()) {
    const won = player.nickname === winnerNickname;
    await savePlayerStats(room, player, won);
  }

  io.to(roomKey).emit('game:end', {
    winner:         winnerNickname,
    totalQuestions: totalRounds,
    totalPlayers
  });

  if (winnerNickname) {
    for (const [socketId, player] of room.players.entries()) {
      if (player.nickname === winnerNickname) {
        io.to(socketId).emit('player:winner', {
          totalPlayers,
          outlasted: totalPlayers - 1
        });
        break;
      }
    }
  }
}

// ─────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────
async function getGameHistory(hostId) {
  return db.getGamesByHostId(hostId);
}

// ─────────────────────────────────────────────
// CURRENT QUESTION  (for rejoin)
// ─────────────────────────────────────────────
function getCurrentQuestion(roomKey) {
  const room = rooms.get(roomKey);
  if (!room || room.status !== 'active') return null;

  if (room.phase === 'qualification') {
    const q = room.questions[room.qualIndex];
    if (!q) return null;
    return { phase: 'qualification', round: room.qualIndex + 1, totalRounds: QUAL_COUNT, question: q.question, choices: q.choices, timer: QUESTION_SECS };
  }
  if (room.phase === 'mindfield') {
    const q = room.questions[QUAL_COUNT + room.mfIndex];
    if (!q) return null;
    return { phase: 'mindfield', round: room.mfIndex + 1, question: q.question, choices: q.choices, timer: QUESTION_SECS };
  }
  return null;
}

// ─────────────────────────────────────────────
// INTERNAL COUNTDOWN HELPER
// ─────────────────────────────────────────────
function broadcastCountdown(roomKey, io, seconds, onComplete, eventName) {
  const room = rooms.get(roomKey);
  if (!room) return;
  io.to(roomKey).emit(eventName, { seconds });
  let count = seconds;
  const tick = () => {
    count--;
    if (count <= 0) {
      onComplete();
    } else {
      io.to(roomKey).emit(eventName, { seconds: count });
      room.timers[eventName] = setTimeout(tick, 1000);
    }
  };
  room.timers[eventName] = setTimeout(tick, 1000);
}

module.exports = {
  createRoom, getRoom, getRoomByHostId, deleteRoom,
  addPlayer, removePlayer, getPlayerList, getActivePlayers,
  startGame, playerAnswer, endGame, getGameHistory, getCurrentQuestion,
  setPlayerAccount, savePlayerStats
};
