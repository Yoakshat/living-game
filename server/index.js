const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fsSync = require('fs');
const pathMod = require('path');

// --- Agent profile persistence -----------------------------------------------
// profilesStore: Map<githubUser, { name, personality, directives }>
const PROFILES_PATH = pathMod.join(__dirname, 'profiles.json');
const profilesStore = new Map();

// Load profiles.json into memory on startup (survives Railway restarts)
(function loadProfiles() {
  try {
    if (fsSync.existsSync(PROFILES_PATH)) {
      const raw = fsSync.readFileSync(PROFILES_PATH, 'utf8');
      const obj = JSON.parse(raw);
      for (const [user, profile] of Object.entries(obj)) {
        profilesStore.set(user, profile);
      }
      console.log(`[profiles] Loaded ${profilesStore.size} profile(s) from profiles.json`);
    }
  } catch (err) {
    console.warn(`[profiles] Could not load profiles.json: ${err.message}`);
  }
})();

function saveProfilesToDisk() {
  try {
    fsSync.writeFileSync(PROFILES_PATH, JSON.stringify(Object.fromEntries(profilesStore), null, 2), 'utf8');
  } catch (err) {
    console.warn(`[profiles] Could not write profiles.json: ${err.message}`);
  }
}

function generateId() {
  return crypto.randomUUID();
}

// --- Color palette -----------------------------------------------------------
const COLOR_PALETTE = [
  '#e14b4b', '#4b8ce1', '#e1c14b', '#4be1a0', '#e14bb8', '#b84be1',
  '#4be14b', '#e17a4b', '#4be1e1', '#e1e14b', '#9b4be1', '#4b9be1',
];

// --- Name generation --------------------------------------------------------
const ANIMAL_NAMES = [
  'Wolf', 'Fox', 'Bear', 'Hawk', 'Lynx', 'Elk',
  'Owl', 'Deer', 'Boar', 'Hare', 'Crow', 'Mink',
];

function generateName(takenNames) {
  const taken = new Set(takenNames);
  for (const base of ANIMAL_NAMES) {
    if (!taken.has(base)) return base;
  }
  for (let i = 0; i < 200; i++) {
    const suffix = Math.floor(Math.random() * 99) + 1;
    const base = ANIMAL_NAMES[Math.floor(Math.random() * ANIMAL_NAMES.length)];
    const name = `${base}${suffix}`;
    if (!taken.has(name)) return name;
  }
  return `Player_${generateId().slice(0, 4)}`;
}

// --- Game log (circular buffer, max 100 entries) ----------------------------
const LOG_MAX = 100;
const gameLog = [];

function addLogEntry(type, player, message) {
  const entry = { type, player: player || null, message, timestamp: new Date().toISOString() };
  gameLog.push(entry);
  if (gameLog.length > LOG_MAX) gameLog.shift();
  return entry;
}

// --- Server state -----------------------------------------------------------
// players: Map<socketId, { id, color, name, githubUser, x, y, moveCount }>
const players = new Map();
const usedColors = new Set();

// --- Leaderboard stats -------------------------------------------------------
// playerStats: Map<githubUser|playerName, { displayName, githubUser, color, worldChanges }>
// Keyed by githubUser when available, otherwise by playerName.
const playerStats = new Map();

function assignColor() {
  for (const color of COLOR_PALETTE) {
    if (!usedColors.has(color)) return color;
  }
  const h = Math.floor(Math.random() * 360);
  return `hsl(${h},80%,60%)`;
}

// --- Idea system state -------------------------------------------------------
// ideaPool: array of { id, description, submittedBy, votes: [], createdAt }
const ideaPool = [];
// activeIdea: null | { id, description, submittedBy, assignedAgents: [], assignedAt }
let activeIdea = null;
// ideasMerged: Map<githubUser, number> — credit per idea author
const ideasMerged = new Map();
// discardTimer: handle for the 30-min timeout
let discardTimer = null;

// Compute quorum based on current active agents
function getQuorum() {
  return Math.max(Math.ceil(players.size * 0.05), 1);
}

function promoteIdea(idea) {
  // Remove from pool
  const idx = ideaPool.indexOf(idea);
  if (idx !== -1) ideaPool.splice(idx, 1);

  // Pick up to 5 random connected agents (players with githubUser set)
  const eligible = [...players.values()].filter(p => p.githubUser);
  const shuffled = eligible.sort(() => Math.random() - 0.5).slice(0, 5);
  const assignedAgents = shuffled.map(p => p.githubUser);

  if (assignedAgents.length === 0) {
    console.log(`[idea] No connected agents — discarding idea "${idea.description}"`);
    advanceQueue();
    return;
  }

  activeIdea = {
    id: idea.id,
    description: idea.description,
    submittedBy: idea.submittedBy,
    assignedAgents,
    assignedAt: new Date(),
  };
  console.log(`[idea] Promoted "${idea.description}" — assigned to: ${assignedAgents.join(', ')}`);

  // 30-min discard timer
  discardTimer = setTimeout(() => {
    if (activeIdea && activeIdea.id === idea.id) {
      console.log(`[idea] 30-min timeout — discarding "${idea.description}"`);
      activeIdea = null;
      advanceQueue();
    }
  }, 30 * 60 * 1000);
}

function advanceQueue() {
  // Find earliest idea in pool that has reached quorum
  const ready = ideaPool.find(i => i.votes.length >= getQuorum());
  if (ready) promoteIdea(ready);
}

// --- Express + Socket.io ----------------------------------------------------
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (
        !origin ||
        origin === 'https://yoakshat.github.io' ||
        /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
      ) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ['GET', 'HEAD', 'POST'],
    credentials: false,
  },
});

app.use(express.json());

// Allow GitHub Pages and localhost to fetch REST endpoints (log, leaderboard, etc.)
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (
    !origin ||
    origin === 'https://yoakshat.github.io' ||
    /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Leaderboard — returns players aggregated by GitHub profile, ranked by ideas merged + world changes
app.get('/leaderboard', (_req, res) => {
  // Aggregate playerStats by githubUser (when present) to collapse multiple agents
  // into a single entry. Players without a githubUser keep individual entries.
  const aggregated = new Map(); // key: githubUser || 'name:<name>'

  for (const entry of playerStats.values()) {
    const key = entry.githubUser ? entry.githubUser : `name:${entry.displayName}`;
    if (!aggregated.has(key)) {
      aggregated.set(key, {
        displayName: entry.githubUser || entry.displayName,
        githubUser: entry.githubUser || null,
        color: entry.color,
        ideasMerged: ideasMerged.get(entry.githubUser) || 0,
        worldChanges: entry.worldChanges || 0,
      });
    } else {
      const agg = aggregated.get(key);
      agg.ideasMerged = ideasMerged.get(entry.githubUser) || 0;
      agg.worldChanges = (agg.worldChanges || 0) + (entry.worldChanges || 0);
    }
  }

  const stats = [...aggregated.values()].sort((a, b) => {
    const score = (p) => (p.ideasMerged || 0) * 3 + (p.worldChanges || 0);
    return score(b) - score(a);
  });
  res.json(stats);
});

// Public live feed: last 50 log entries
app.get('/log', (_req, res) => {
  const last50 = gameLog.slice(-50);
  res.json(last50);
});

// External event push (e.g. governance workflow posts PR merges here)
app.post('/log-event', (req, res) => {
  const { type, player, message } = req.body || {};
  if (typeof type !== 'string' || typeof message !== 'string') {
    return res.status(400).json({ error: 'type (string) and message (string) required' });
  }
  addLogEntry(type, player || null, message);
  res.json({ ok: true });
});

// Agent profile — GET: retrieve, POST: upsert
app.get('/agent-profile/:githubUser', (req, res) => {
  const { githubUser } = req.params;
  const profile = profilesStore.get(githubUser);
  if (!profile) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Ensure directives is always an array
  res.json({
    name: profile.name || '',
    personality: profile.personality || '',
    directives: Array.isArray(profile.directives) ? profile.directives : [],
  });
});

app.post('/agent-profile/:githubUser', (req, res) => {
  const { githubUser } = req.params;
  const { name, personality, directives } = req.body || {};
  if (typeof name !== 'string' || typeof personality !== 'string' || !Array.isArray(directives)) {
    return res.status(400).json({ error: 'name (string), personality (string), directives (array) required' });
  }
  const profile = { name, personality, directives };
  profilesStore.set(githubUser, profile);
  saveProfilesToDisk();
  console.log(`[profiles] Saved profile for ${githubUser}`);
  res.json({ ok: true });
});

// --- Idea endpoints ----------------------------------------------------------

// Submit a new idea to the pool
app.post('/submit-idea', (req, res) => {
  const { description, submittedBy } = req.body || {};
  if (typeof description !== 'string' || typeof submittedBy !== 'string') {
    return res.status(400).json({ error: 'description (string) and submittedBy (string) required' });
  }
  const idea = {
    id: generateId(),
    description,
    submittedBy,
    votes: [],
    createdAt: new Date(),
  };
  ideaPool.push(idea);
  console.log(`[idea] New idea submitted by ${submittedBy}: "${description}" (id: ${idea.id})`);
  res.json({ ideaId: idea.id });
});

// Vote on an idea
app.post('/vote-idea', (req, res) => {
  const { ideaId, githubUser } = req.body || {};
  if (typeof ideaId !== 'string' || typeof githubUser !== 'string') {
    return res.status(400).json({ error: 'ideaId (string) and githubUser (string) required' });
  }

  const idea = ideaPool.find(i => i.id === ideaId);
  if (!idea) {
    return res.status(404).json({ error: 'idea not found' });
  }

  if (activeIdea && activeIdea.id === ideaId) {
    return res.status(400).json({ error: 'idea already active' });
  }

  // Idempotent — ignore duplicate votes
  if (idea.votes.includes(githubUser)) {
    return res.json({ votes: idea.votes.length });
  }

  idea.votes.push(githubUser);
  console.log(`[idea] ${githubUser} voted on "${idea.description}" — ${idea.votes.length} vote(s)`);

  // Check quorum: promote if threshold reached and no active idea
  if (idea.votes.length >= getQuorum() && !activeIdea) {
    promoteIdea(idea);
  }

  res.json({ votes: idea.votes.length });
});

// Mark active idea as complete (called by governance workflow after merging)
app.post('/idea-complete', (req, res) => {
  const { ideaId } = req.body || {};

  // Idempotent — if no active idea or id doesn't match, noop
  if (!activeIdea || activeIdea.id !== ideaId) {
    return res.json({ ok: true, noop: true });
  }

  // Clear discard timer
  if (discardTimer) {
    clearTimeout(discardTimer);
    discardTimer = null;
  }

  // Award credit to idea author
  const submittedBy = activeIdea.submittedBy;
  ideasMerged.set(submittedBy, (ideasMerged.get(submittedBy) || 0) + 1);
  console.log(`[idea] Idea "${activeIdea.description}" complete — credit to ${submittedBy} (total: ${ideasMerged.get(submittedBy)})`);

  // Remove from pool if still there (shouldn't be, but defensive)
  const idx = ideaPool.findIndex(i => i.id === ideaId);
  if (idx !== -1) ideaPool.splice(idx, 1);

  activeIdea = null;

  // Advance queue
  advanceQueue();

  res.json({ ok: true });
});

// Per-agent idea state — used by agent server to populate /state
app.get('/idea-state/:githubUser', (req, res) => {
  const { githubUser } = req.params;

  const myAssignment = (activeIdea && activeIdea.assignedAgents.includes(githubUser))
    ? { id: activeIdea.id, description: activeIdea.description }
    : null;

  const pendingIdeas = ideaPool.map(i => ({
    id: i.id,
    description: i.description,
    votes: i.votes.length,
  }));

  res.json({ myAssignment, pendingIdeas });
});

// Active idea — used by governance workflow
app.get('/active-idea', (_req, res) => {
  res.json(activeIdea);
});

// --- Socket.io events -------------------------------------------------------
io.on('connection', (socket) => {
  const id = generateId();
  const color = assignColor();
  usedColors.add(color);
  const name = generateName([...players.values()].map((p) => p.name));

  const spawnX = 768;
  const spawnY = 576;
  // githubUser is null until player:identify arrives
  const player = { id, color, name, githubUser: null, x: spawnX, y: spawnY, lastLoggedAt: 0 };
  players.set(socket.id, player);

  // Initialise leaderboard entry for new players (preserve existing stats on reconnect)
  // Initially keyed by name; will be re-keyed to githubUser once player:identify arrives.
  if (!playerStats.has(name)) {
    playerStats.set(name, { displayName: name, githubUser: null, color, worldChanges: 0 });
  } else {
    // Update color in case it changed
    playerStats.get(name).color = color;
  }

  console.log(`[+] ${name} (${id.slice(0, 6)}) connected — total: ${players.size}`);
  addLogEntry('action', name, `${name} joined the world`);

  // Send identity + existing players
  socket.emit('self:init', {
    id,
    color,
    name,
    others: [...players.values()]
      .filter((p) => p.id !== id)
      .map(({ id: pid, color: pc, name: pn, x, y }) => ({ id: pid, color: pc, name: pn, x, y })),
  });

  // Announce newcomer to others
  socket.broadcast.emit('player:join', { id, color, name, x: spawnX, y: spawnY });

  socket.on('player:identify', (data) => {
    const p = players.get(socket.id);
    if (!p) return;

    // Store GitHub username if provided
    const githubUser = typeof data.githubUser === 'string' ? data.githubUser.trim() : '';
    if (githubUser && !p.githubUser) {
      const oldStatsKey = p.name; // currently keyed by name
      p.githubUser = githubUser;

      // Migrate or merge leaderboard stats to be keyed by githubUser
      const existingGhStats = playerStats.get(githubUser);
      const nameStats = playerStats.get(oldStatsKey);

      if (existingGhStats) {
        // A stats entry already exists for this GitHub user (from a previous session or another agent).
        // Merge the name-keyed stats into the github-keyed stats and remove the name entry.
        if (nameStats && oldStatsKey !== githubUser) {
          existingGhStats.worldChanges = (existingGhStats.worldChanges || 0) + (nameStats.worldChanges || 0);
          playerStats.delete(oldStatsKey);
        }
        existingGhStats.color = p.color;
        existingGhStats.displayName = githubUser;
        existingGhStats.githubUser = githubUser;
      } else if (nameStats) {
        // Promote existing name-keyed entry to github-keyed
        nameStats.githubUser = githubUser;
        nameStats.displayName = githubUser;
        playerStats.delete(oldStatsKey);
        playerStats.set(githubUser, nameStats);
      } else {
        // No existing entry — create fresh
        playerStats.set(githubUser, { displayName: githubUser, githubUser, color: p.color, worldChanges: 0 });
      }

      console.log(`[~] ${p.name} identified as GitHub user: ${githubUser}`);
    }

    // Apply requested display name
    const requestedName = typeof data.name === 'string' ? data.name.trim() : '';
    if (requestedName) {
      const takenByOther = [...players.values()].some((q) => q !== p && q.name === requestedName);
      if (!takenByOther) {
        console.log(`[~] ${p.name} → ${requestedName}`);
        p.name = requestedName;
        io.emit('player:renamed', { id: p.id, name: p.name });
      }
    }
  });

  socket.on('player:move', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    const x = typeof data.x === 'number' ? data.x : p.x;
    const y = typeof data.y === 'number' ? data.y : p.y;
    p.x = x;
    p.y = y;
    socket.broadcast.emit('player:moved', { id: p.id, x, y });
    // Log at most once every 30 seconds per player to avoid flooding
    const now = Date.now();
    if (now - p.lastLoggedAt >= 30_000) {
      p.lastLoggedAt = now;
      addLogEntry('action', p.name, `${p.name} is exploring`);
    }
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (!p) return;
    console.log(`[-] ${p.name} (${p.id.slice(0, 6)}) disconnected — total: ${players.size - 1}`);
    addLogEntry('action', p.name, `${p.name} left the world`);
    usedColors.delete(p.color);
    players.delete(socket.id);
    io.emit('player:left', { id: p.id });
  });
});

// --- Boot -------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Living Game server listening on port ${PORT}`);
});
