require('dotenv').config();
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const QRCode   = require('qrcode');

const auth = require('./authManager');
const game = require('./gameManager');
const trivia = require('./triviaService');
const db     = require('./db');
const filter = require('./profanityFilter');
const jwt    = require('jsonwebtoken');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
const PORT   = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.hostData = auth.verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const result = await auth.registerHost(req.body);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const result = await auth.loginHost(req.body);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// HOST GOOGLE AUTH + PROFILE ROUTES
// ─────────────────────────────────────────────
app.post('/api/host/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'No credential provided' });

    const payload  = JSON.parse(Buffer.from(credential.split('.')[1], 'base64').toString());
    const { sub: googleId, email, name } = payload;

    let host = await db.findHostByGoogleId(googleId);

    if (!host) {
      host = await db.findHostByEmail(email);
      if (host) {
        await db.updateHost(host.id, { google_id: googleId });
        host = await db.findHostById(host.id);
      } else {
        // New host via Google
        const displayName = name.split(' ')[0].substring(0, 20);
        host = await db.insertHost({ full_name: name, display_name: displayName, email, google_id: googleId });
      }
    }

    const token = jwt.sign(
      { id: host.id, displayName: host.display_name, email: host.email },
      process.env.JWT_SECRET || 'mindfield-dev-secret-change-in-production',
      { expiresIn: '24h' }
    );
    res.json({ success: true, token, host: { id: host.id, displayName: host.display_name, email: host.email } });
  } catch (e) {
    console.error('[Host Google Auth]', e.message);
    res.status(500).json({ error: 'Google sign-in failed' });
  }
});

app.post('/api/host/profile', requireAuth, async (req, res) => {
  try {
    const { displayName, currentPassword, newPassword } = req.body;
    const fields = {};

    if (displayName && displayName.trim()) {
      fields.display_name = displayName.trim();
    }

    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password is required to set a new password' });
      const host = await db.findHostById(req.hostData.id);
      const bcrypt = require('bcryptjs');
      if (!host.password_hash || !bcrypt.compareSync(currentPassword, host.password_hash)) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
      fields.password_hash = bcrypt.hashSync(newPassword, 10);
    }

    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update' });

    const updated = await db.updateHost(req.hostData.id, fields);
    res.json({ success: true, displayName: updated.display_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// PLAYER AUTH ROUTES
// ─────────────────────────────────────────────
const PLAYER_JWT_SECRET = process.env.JWT_SECRET + '_player';

function signPlayerToken(player) {
  return jwt.sign(
    { id: player.id, displayName: player.display_name, email: player.email },
    PLAYER_JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function verifyPlayerToken(token) {
  return jwt.verify(token, PLAYER_JWT_SECRET);
}

function requirePlayerAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.playerData = verifyPlayerToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Register
app.post('/api/player/register', async (req, res) => {
  try {
    const { fullName, displayName, email, password } = req.body;
    if (!fullName || !displayName || !email || !password)
      return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    if (await db.findPlayerByEmail(email))
      return res.status(400).json({ error: 'An account with that email already exists' });
    if (await db.findPlayerByDisplayName(displayName))
      return res.status(400).json({ error: 'That display name is already taken' });

    const bcrypt = require('bcryptjs');
    const password_hash = bcrypt.hashSync(password, 10);
    const player = await db.insertPlayer({ full_name: fullName, display_name: displayName, email, password_hash });
    const token  = signPlayerToken(player);
    res.json({ success: true, token, player: { id: player.id, displayName: player.display_name, email: player.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/player/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const player = await db.findPlayerByEmail(email);
    if (!player) return res.status(401).json({ error: 'Invalid email or password' });

    const bcrypt = require('bcryptjs');
    if (!player.password_hash || !bcrypt.compareSync(password, player.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });

    const token = signPlayerToken(player);
    res.json({ success: true, token, player: { id: player.id, displayName: player.display_name, email: player.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Google OAuth — verify token from client
app.post('/api/player/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'No credential provided' });

    // Decode the Google JWT (we trust Google's signature via their public keys)
    const payload = JSON.parse(Buffer.from(credential.split('.')[1], 'base64').toString());
    const { sub: googleId, email, name } = payload;

    let player = await db.findPlayerByGoogleId(googleId);

    if (!player) {
      // Check if email already exists — link accounts
      player = await db.findPlayerByEmail(email);
      if (player) {
        // Link google_id to existing account
        const { rows } = await require('./db').pool ? [] :
          [{ rows: [player] }];
        // Update google_id
        const { Pool } = require('pg');
        await (new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }))
          .query('UPDATE player_accounts SET google_id=$1 WHERE id=$2', [googleId, player.id]);
      } else {
        // New player via Google — use name as display name, may need to update
        const displayName = name.replace(/\s+/g, '').substring(0, 12);
        const existing = await db.findPlayerByDisplayName(displayName);
        const finalName = existing ? displayName + Math.floor(Math.random() * 99) : displayName;
        player = await db.insertPlayer({ full_name: name, display_name: finalName, email, google_id: googleId });
      }
    }

    const token = signPlayerToken(player);
    res.json({ success: true, token, player: { id: player.id, displayName: player.display_name, email: player.email }, isNew: !player.password_hash && !player.google_id });
  } catch (e) {
    console.error('[Google Auth]', e.message);
    res.status(500).json({ error: 'Google sign-in failed' });
  }
});

// Get profile + stats
app.get('/api/player/profile', requirePlayerAuth, async (req, res) => {
  try {
    const player  = await db.findPlayerById(req.playerData.id);
    const stats   = await db.getPlayerStats(req.playerData.id);
    const history = await db.getPlayerGameHistory(req.playerData.id);
    res.json({ player: { id: player.id, fullName: player.full_name, displayName: player.display_name, email: player.email }, stats, history });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verify token (used by player pages on load)
app.get('/api/player/me', requirePlayerAuth, async (req, res) => {
  try {
    const player = await db.findPlayerById(req.playerData.id);
    if (!player) return res.status(404).json({ error: 'Player not found' });
    res.json({ id: player.id, displayName: player.display_name, email: player.email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update display name
app.post('/api/player/display-name', requirePlayerAuth, async (req, res) => {
  try {
    const { displayName } = req.body;
    if (!displayName || !displayName.trim())
      return res.status(400).json({ error: 'Display name is required' });
    if (displayName.trim().length > 12)
      return res.status(400).json({ error: 'Display name must be 12 characters or less' });

    const existing = await db.findPlayerByDisplayName(displayName.trim());
    if (existing && existing.id !== req.playerData.id)
      return res.status(400).json({ error: 'That display name is already taken' });

    await db.updatePlayerDisplayName(req.playerData.id, displayName.trim());
    res.json({ success: true, displayName: displayName.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// TRIVIA ROUTES
// ─────────────────────────────────────────────
app.get('/api/categories', async (_req, res) => {
  try {
    const categories = await trivia.getCategories();
    res.json(categories);
  } catch {
    res.status(500).json({ error: 'Failed to fetch categories from OpenTDB' });
  }
});

// ─────────────────────────────────────────────
// GOOGLE PLACES PROXY
// ─────────────────────────────────────────────
app.get('/api/places', requireAuth, async (req, res) => {
  const query = req.query.query?.trim();
  if (!query) return res.json({ places: [] });

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Google Places API key not configured' });

  try {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get(url, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });

    const places = (data.results || []).slice(0, 5).map(p => ({
      name:    p.name,
      address: p.formatted_address
    }));
    res.json({ places });
  } catch (e) {
    console.error('[Places] Error:', e.message);
    res.status(500).json({ error: 'Failed to fetch places' });
  }
});

// ─────────────────────────────────────────────
// ROOM ROUTES
// ─────────────────────────────────────────────

// Create a new room
app.post('/api/rooms', requireAuth, async (req, res) => {
  try {
    // One room per host at a time
    const existing = game.getRoomByHostId(req.hostData.id);
    if (existing) {
      return res.status(400).json({ error: 'You already have an active room. End it before creating a new one.' });
    }

    const { roomName, location, categoryId, categoryName } = req.body;
    if (!roomName || !location || !categoryId || !categoryName) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Profanity check on room name
    if (!filter.isClean(roomName)) {
      return res.status(400).json({ error: 'Room name contains inappropriate content. Please choose a different name.' });
    }

    const room = game.createRoom({
      hostId:       req.hostData.id,
      hostName:     req.hostData.displayName,
      roomName,
      location,
      categoryId:   categoryId,   // slug string e.g. 'general_knowledge'
      categoryName
    });

    // QR code deep-links players straight to the room entry page
    const joinUrl   = `${req.protocol}://${req.get('host')}/player?key=${room.roomKey}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 220, margin: 1 });

    res.json({
      success:      true,
      roomKey:      room.roomKey,
      roomName:     room.roomName,
      location:     room.location,
      categoryName: room.categoryName,
      hostName:     room.hostName,
      qrCode:       qrDataUrl,
      joinUrl
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Validate a room key (used by player "Check Room" screen)
app.get('/api/rooms/:key', (req, res) => {
  const room = game.getRoom(req.params.key.toUpperCase());
  if (!room)                      return res.status(404).json({ error: 'Room not found. Check the code and try again.' });
  if (room.status !== 'waiting')  return res.status(400).json({ error: 'This game is already in progress.' });

  res.json({
    roomKey:  room.roomKey,
    roomName: room.roomName,
    status:   room.status
  });
});

// ─────────────────────────────────────────────
// PROMOTIONS ROUTES
// ─────────────────────────────────────────────

app.get('/api/promotions', requireAuth, async (req, res) => {
  try {
    const result = await db.getPromotions(req.hostData.id);
    res.json(result);
  } catch (e) {
    console.error('[Promotions] Load error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/promotions', requireAuth, async (req, res) => {
  try {
    const { venue, host: hostPromos } = req.body;
    // All 4 fields required for a promo to count
    const isComplete = p => p?.headline?.trim() && p?.days?.trim() && p?.startTime?.trim() && p?.description?.trim();
    const cleanVenue = (venue      || []).filter(isComplete);
    const cleanHost  = (hostPromos || []).filter(isComplete);
    await db.savePromotions(req.hostData.id, { venue: cleanVenue, host: cleanHost });
    console.log(`[Promotions] Saved for host ${req.hostData.id}: ${cleanVenue.length} venue, ${cleanHost.length} host`);
    res.json({ success: true, saved: { venue: cleanVenue.length, host: cleanHost.length } });
  } catch (e) {
    console.error('[Promotions] Save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Game history for dashboard
app.get('/api/history', requireAuth, async (req, res) => {
  const history = await game.getGameHistory(req.hostData.id);
  res.json(history);
});

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // ── HOST EVENTS ──────────────────────────

  // Host joins their room channel (after creating it via REST)
  socket.on('host:join-room', ({ roomKey, token }) => {
    try {
      const hostData = auth.verifyToken(token);
      const room     = game.getRoom(roomKey);

      if (!room || room.hostId !== hostData.id) {
        socket.emit('error', { message: 'Unauthorized room access' });
        return;
      }

      room.hostSocketId = socket.id;
      socket.join(roomKey);
      socket.data.roomKey = roomKey;
      socket.data.isHost  = true;

      // Send current player list immediately so the preview populates
      socket.emit('room:update', {
        players:      game.getPlayerList(room),
        total:        room.players.size,
        activeCount:  game.getActivePlayers(room).length,
        totalStarted: room.totalStarted || room.players.size
      });

      console.log(`[Host] ${hostData.displayName} connected to room ${roomKey}`);
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  // Host presses "Start"
  socket.on('host:start', async ({ roomKey, token }) => {
    try {
      const hostData = auth.verifyToken(token);
      const room     = game.getRoom(roomKey);
      if (!room || room.hostId !== hostData.id) {
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }
      const result = await game.startGame(roomKey, io);
      if (result.error) socket.emit('error', { message: result.error });
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  // Host cancels the room from preview screen
  socket.on('host:cancel-room', ({ roomKey, token }) => {
    try {
      const hostData = auth.verifyToken(token);
      const room     = game.getRoom(roomKey);
      if (!room || room.hostId !== hostData.id) return;

      io.to(roomKey).emit('room:cancelled');
      game.deleteRoom(roomKey);
      console.log(`[Host] Room ${roomKey} cancelled`);
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  // Host exits after game ends → return to dashboard
  socket.on('host:exit', ({ roomKey, token }) => {
    try {
      const hostData = auth.verifyToken(token);
      const room     = game.getRoom(roomKey);
      if (!room || room.hostId !== hostData.id) return;
      game.deleteRoom(roomKey);
    } catch { /* silent */ }
  });

  // ── PLAYER EVENTS ────────────────────────

  // Player joins a room after nickname entry
  socket.on('player:join', async ({ roomKey, nickname, playerToken }) => {
    if (!filter.isClean(nickname)) {
      socket.emit('player:join-error', { message: 'That nickname is not allowed. Please choose a different one.' });
      return;
    }

    const result = game.addPlayer(roomKey, socket.id, nickname);

    if (result.error) {
      socket.emit('player:join-error', { message: result.error });
      return;
    }

    socket.join(roomKey);
    socket.data.roomKey  = roomKey;
    socket.data.nickname = nickname;
    socket.data.isHost   = false;
    socket.data.playerId = null;

    // Link registered player account if token provided
    if (playerToken) {
      try {
        const PLAYER_JWT_SECRET = process.env.JWT_SECRET + '_player';
        const payload = jwt.verify(playerToken, PLAYER_JWT_SECRET);
        socket.data.playerId = payload.id;
        game.setPlayerAccount(roomKey, socket.id, payload.id);
      } catch {
        // Invalid token — treat as guest
      }
    }

    const room       = game.getRoom(roomKey);
    const playerList = game.getPlayerList(room);

    socket.emit('player:joined', {
      nickname,
      roomName:    room.roomName,
      playerCount: playerList.length
    });

    // Broadcast refreshed player list to everyone (host preview + all lobby players)
    io.to(roomKey).emit('room:update', {
      players:      playerList,
      total:        playerList.length,
      activeCount:  game.getActivePlayers(room).length,
      totalStarted: room.totalStarted || playerList.length
    });

    console.log(`[Player] "${nickname}" joined room ${roomKey} (${playerList.length} total)`);
  });

  // Player submits an answer
  socket.on('player:answer', ({ roomKey, answer }) => {
    game.playerAnswer(roomKey, socket.id, answer, io);
  });

  // Player voluntarily leaves (Leave Room button)
  socket.on('player:leave', ({ roomKey }) => {
    handlePlayerLeave(socket, roomKey);
  });

  // ── DISCONNECT ───────────────────────────

  socket.on('disconnect', () => {
    console.log(`[-] Socket disconnected: ${socket.id}`);
    if (socket.data.roomKey && !socket.data.isHost) {
      handlePlayerLeave(socket, socket.data.roomKey);
    }
  });
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
async function handlePlayerLeave(socket, roomKey) {
  const room = game.getRoom(roomKey);
  if (!room) return;

  // Save partial stats for registered players who leave early
  if (socket.data.playerId && room.status === 'active') {
    const player = room.players.get(socket.id);
    if (player) {
      await game.savePlayerStats(room, player, false);
    }
  }

  game.removePlayer(roomKey, socket.id);
  socket.leave(roomKey);

  const playerList = game.getPlayerList(room);
  io.to(roomKey).emit('room:update', {
    players:      playerList,
    total:        playerList.length,
    activeCount:  game.getActivePlayers(room).length,
    totalStarted: room.totalStarted || playerList.length
  });
}

// ─────────────────────────────────────────────
// SPA FALLBACKS
// ─────────────────────────────────────────────
app.get('/', (_req, res) =>
  res.redirect('/player')
);

app.get('/player', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'player', 'index.html'))
);

app.get('/host', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'host', 'signin.html'))
);

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🧠  Mind Field running → http://localhost:${PORT}\n`);
  console.log(`    Host interface  →  http://localhost:${PORT}/host`);
  console.log(`    Player join     →  http://localhost:${PORT}/player\n`);
});
