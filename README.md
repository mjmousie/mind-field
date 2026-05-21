# 🧠 Mind Field

**Last Man Standing Trivia** — a real-time bar trivia game where players compete to be the last one standing.

---

## What Is Mind Field?

Mind Field is a hosted trivia game designed for bars, venues, and events. Players join a live game from their phone, answer qualification questions, and the top scorers advance to the **Mind Field Round** — where one wrong answer gets you eliminated.

---

## How It Works

### Qualification Round
- Players answer a set of trivia questions (configurable by the host)
- Questions are sourced from multiple categories via The Trivia API
- Players who score above the threshold advance to the Mind Field

### Mind Field Round
- Last man standing format — one wrong answer and you're out
- Questions continue until only one player remains
- The final survivor wins

### Solo Mode
- Players can also play solo directly from the home page
- 10 qualification questions, 7+ correct to advance
- Survive 5 Mind Field questions in a row to win

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express, Socket.io |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Database | PostgreSQL via Supabase |
| Trivia API | [The Trivia API v2](https://the-trivia-api.com) |
| Auth | JWT (hosts + players), Google OAuth |
| Hosting | Railway |

---

## Project Structure

```
mind-field/
├── server/
│   ├── server.js          # Express + Socket.io + API routes
│   ├── gameManager.js     # Game state, round logic, timers
│   ├── triviaService.js   # Trivia API + custom question support
│   ├── authManager.js     # Host register/login/JWT
│   ├── db.js              # PostgreSQL via Supabase
│   └── profanityFilter.js # Nickname/room name content filter
├── public/
│   ├── index.html         # Landing page
│   ├── shared/
│   │   ├── style.css      # Global styles
│   │   └── brain.svg      # Logo
│   ├── host/
│   │   ├── signin.html
│   │   ├── dashboard.html
│   │   ├── create-room.html
│   │   ├── game-room.html
│   │   ├── promotions.html
│   │   ├── questions.html  # Custom question manager
│   │   └── profile.html
│   └── player/
│       ├── index.html      # Enter room key
│       ├── nickname.html
│       ├── lobby.html      # All player game screens
│       ├── solo.html       # Solo mode
│       ├── player-signup.html
│       ├── player-login.html
│       └── player-profile.html
└── railway.json
```

---

## Environment Variables

Create a `.env` file in the root with the following:

```env
PORT=3000
JWT_SECRET=your-jwt-secret
GOOGLE_PLACES_API_KEY=your-google-places-key
GOOGLE_CLIENT_ID=your-google-oauth-client-id
DATABASE_URL=your-supabase-connection-string
```

---

## Database Setup

Run the following SQL in your Supabase SQL Editor:

```sql
-- Host accounts
CREATE TABLE hosts (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  google_id     TEXT UNIQUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Games
CREATE TABLE games (
  id              SERIAL PRIMARY KEY,
  host_id         INTEGER REFERENCES hosts(id),
  room_name       TEXT,
  location        TEXT,
  category_id     TEXT,
  category_name   TEXT,
  winner_nickname TEXT,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

-- Promotions
CREATE TABLE promotions (
  host_id        TEXT PRIMARY KEY,
  venue          JSONB DEFAULT '[]',
  host_data      JSONB DEFAULT '[]',
  venue_location TEXT DEFAULT ''
);

-- Used questions (deduplication)
CREATE TABLE used_questions (
  category TEXT,
  question_id TEXT,
  used_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (category, question_id)
);

-- Player accounts
CREATE TABLE player_accounts (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  password_hash TEXT,
  google_id     TEXT UNIQUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Player stats
CREATE TABLE player_stats (
  player_id            INTEGER PRIMARY KEY REFERENCES player_accounts(id),
  games_played         INTEGER DEFAULT 0,
  games_won            INTEGER DEFAULT 0,
  questions_correct    INTEGER DEFAULT 0,
  questions_incorrect  INTEGER DEFAULT 0,
  mindfield_rounds     INTEGER DEFAULT 0,
  mindfield_rounds_won INTEGER DEFAULT 0
);

-- Player game history
CREATE TABLE player_game_history (
  id                   SERIAL PRIMARY KEY,
  player_id            INTEGER REFERENCES player_accounts(id),
  game_id              INTEGER REFERENCES games(id),
  room_name            TEXT,
  venue                TEXT,
  qualified            BOOLEAN DEFAULT FALSE,
  won                  BOOLEAN DEFAULT FALSE,
  questions_correct    INTEGER DEFAULT 0,
  questions_incorrect  INTEGER DEFAULT 0,
  reached_mindfield    BOOLEAN DEFAULT FALSE,
  played_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Custom questions
CREATE TABLE custom_questions (
  id          SERIAL PRIMARY KEY,
  category    TEXT NOT NULL,
  question    TEXT NOT NULL,
  correct     TEXT NOT NULL,
  wrong1      TEXT NOT NULL,
  wrong2      TEXT NOT NULL,
  wrong3      TEXT,
  difficulty  TEXT NOT NULL DEFAULT 'medium',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON custom_questions(category);
CREATE INDEX ON custom_questions(difficulty);
```

---

## Running Locally

```bash
npm install
npm run dev
```

The app runs on `http://localhost:3000` by default.

- **Host interface** → `http://localhost:3000/host`
- **Player join** → `http://localhost:3000/player`
- **Landing page** → `http://localhost:3000`

---

## Deploying to Railway

1. Push to GitHub
2. Connect your repo in [Railway](https://railway.app)
3. Add all environment variables in the Railway Variables tab
4. Railway auto-deploys on every push to `master`

The server binds to `0.0.0.0` and uses `process.env.PORT` automatically.

---

## Game Settings (Per Room)

When creating a room, the host can configure:

| Setting | Default | Description |
|---|---|---|
| Questions | 10 | Number of qualification questions |
| Threshold | 7 | Minimum correct to advance to Mind Field |
| Break Time | 90s | Time between qualification end and Mind Field start |

---

## License

Private project — all rights reserved.
