const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

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
// players: Map<socketId, { id, color, name, x, y, moveCount }>
const players = new Map();
const usedColors = new Set();

// --- Leaderboard stats -------------------------------------------------------
// playerStats: Map<playerName, { name, color, prsmerged, worldChanges }>
// Keyed by name (stable identifier across reconnects).
const playerStats = new Map();

function assignColor() {
  for (const color of COLOR_PALETTE) {
    if (!usedColors.has(color)) return color;
  }
  const h = Math.floor(Math.random() * 360);
  return `hsl(${h},80%,60%)`;
}

// --- PR governance state ----------------------------------------------------
// prs: Map<prNumber, {
//   number, title, url, openedAt, sha, currentSha, ciPassed,
//   votes: Map<agentId, 'yes'|'no'>,
//   approvedSha,          // SHA when votes first crossed threshold (null until then)
//   enforcerState,        // null | 'needs-enforcer-review' | 'enforcer:approve' | 'enforcer:block'
//   enforcerComment,      // explanation from enforcer (for governance to relay on block)
//   enforcerPendingSince, // Date when enforcerState was set to 'needs-enforcer-review'
//   newSha,               // incoming SHA that triggered enforcer review
// }>
const prs = new Map();

// Compute quorum based on current active agents
function getQuorum() {
  return Math.max(Math.ceil(players.size * 0.05), 1);
}

// Check if votes on a PR have crossed the approval threshold
function isAtThreshold(pr) {
  let yes = 0, total = 0;
  for (const v of pr.votes.values()) {
    total++;
    if (v === 'yes') yes++;
  }
  const quorum = getQuorum();
  return total >= quorum && (yes * 3) >= (total * 2);
}

async function githubFetch(url) {
  const headers = { 'User-Agent': 'living-game-server' };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return await res.json();
}

async function fetchOpenPRs() {
  try {
    return await githubFetch(
      'https://api.github.com/repos/Yoakshat/living-game/pulls?state=open&per_page=20'
    );
  } catch {
    return null;
  }
}

// Returns 'passed' | 'failed' | 'pending'
async function getCIStatus(sha) {
  try {
    const data = await githubFetch(
      `https://api.github.com/repos/Yoakshat/living-game/commits/${sha}/check-runs`
    );
    if (!data || data.total_count === 0) return 'pending';
    const runs = data.check_runs;
    if (runs.some((r) => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion))) return 'failed';
    if (runs.some((r) => r.status === 'in_progress' || r.status === 'queued')) return 'pending';
    return 'passed';
  } catch {
    return 'pending';
  }
}

async function pollGitHub() {
  const openPRs = await fetchOpenPRs();
  if (!openPRs) return;

  const openNumbers = new Set(openPRs.map((pr) => pr.number));

  // Remove PRs that closed/merged since last poll
  for (const num of prs.keys()) {
    if (!openNumbers.has(num)) {
      console.log(`[PR] #${num} closed — removing from tracking`);
      prs.delete(num);
    }
  }

  // Detect new PRs; track them but only notify agents once CI passes
  for (const pr of openPRs) {
    if (!prs.has(pr.number)) {
      prs.set(pr.number, {
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        openedAt: new Date(pr.created_at),
        sha: pr.head.sha,
        currentSha: pr.head.sha,
        ciPassed: false,
        votes: new Map(),
        approvedSha: null,
        enforcerState: null,
        enforcerComment: null,
        enforcerPendingSince: null,
        newSha: null,
      });
      console.log(`[PR] Tracking #${pr.number}: ${pr.title} (waiting for CI)`);
    }
  }

  // Promote PRs to voting once CI passes
  for (const pr of prs.values()) {
    if (pr.ciPassed) continue;
    const ci = await getCIStatus(pr.currentSha);
    if (ci === 'passed') {
      pr.ciPassed = true;
      console.log(`[PR] #${pr.number} CI passed — notifying agents`);
      for (const [socketId] of players) {
        io.to(socketId).emit('pr:review_needed', [
          { number: pr.number, title: pr.title, url: pr.url },
        ]);
      }
    } else if (ci === 'failed') {
      console.log(`[PR] #${pr.number} CI failed — governance will close it`);
    }
  }
}

// Poll every 2 minutes (safely under unauthenticated GitHub rate limit of 60 req/hr)
setInterval(pollGitHub, 2 * 60 * 1000);
setTimeout(pollGitHub, 5000); // initial poll shortly after boot

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

app.get('/', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Leaderboard — returns all known players ranked by PRs merged + world changes
app.get('/leaderboard', (_req, res) => {
  const stats = [...playerStats.values()].sort((a, b) => {
    const score = (p) => (p.prsmerged || 0) * 3 + (p.worldChanges || 0);
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

// Governance workflow reads this to decide merge/close
app.get('/vote-tally', (_req, res) => {
  const activeAgents = players.size;
  const tally = [...prs.values()].map((pr) => {
    let yes = 0, no = 0;
    for (const vote of pr.votes.values()) {
      if (vote === 'yes') yes++;
      else no++;
    }
    const entry = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      openedAt: pr.openedAt,
      currentSha: pr.currentSha,
      yesVotes: yes,
      noVotes: no,
      totalVotes: yes + no,
      approvedSha: pr.approvedSha,
      enforcerState: pr.enforcerState,
      enforcerComment: pr.enforcerComment,
      enforcerPendingSince: pr.enforcerPendingSince,
      newSha: pr.newSha,
    };
    return entry;
  });
  res.json({ activeAgents, prs: tally });
});

// Called by governance workflow at the start of each poll cycle per PR.
// If sha differs from currentSha:
//   - If votes were at threshold → transition to 'needs-enforcer-review' (keep votes)
//   - If votes were NOT at threshold → wipe votes (existing behavior)
app.post('/sync-pr', (req, res) => {
  const { prNumber, sha } = req.body || {};
  if (typeof prNumber !== 'number' || typeof sha !== 'string') {
    return res.status(400).json({ error: 'prNumber (number) and sha (string) required' });
  }
  const pr = prs.get(prNumber);
  if (!pr) {
    return res.json({ status: 'unknown', wiped: false });
  }
  if (sha === pr.currentSha) {
    return res.json({ status: 'unchanged', wiped: false });
  }

  // SHA changed — check if votes were already at threshold
  const atThreshold = pr.approvedSha !== null || isAtThreshold(pr);

  if (atThreshold) {
    // Votes had crossed threshold: transition to enforcer review
    pr.enforcerState = 'needs-enforcer-review';
    pr.enforcerPendingSince = new Date();
    pr.newSha = sha;
    // Keep currentSha as approvedSha for diff comparison; don't update it yet
    // approvedSha is already set (or set it now if threshold was just crossed inline)
    if (!pr.approvedSha) {
      pr.approvedSha = pr.currentSha;
    }
    console.log(`[sync-pr] #${prNumber} SHA changed to ${sha.slice(0, 7)} — votes at threshold, transitioning to enforcer review (approvedSha=${pr.approvedSha.slice(0, 7)})`);
    return res.json({ status: 'enforcer-pending', wiped: false });
  } else {
    // Votes had NOT crossed threshold: wipe votes (existing behavior)
    pr.votes.clear();
    pr.currentSha = sha;
    pr.approvedSha = null;
    pr.enforcerState = null;
    pr.enforcerComment = null;
    pr.enforcerPendingSince = null;
    pr.newSha = null;
    pr.ciPassed = false;
    console.log(`[sync-pr] #${prNumber} SHA changed to ${sha.slice(0, 7)} — votes wiped, re-gating CI`);
    io.emit('pr:revote', { prNumber, sha });
    return res.json({ status: 'wiped', wiped: true });
  }
});

// Enforcer service posts verdict here
// Body: { prNumber, verdict: 'approve' | 'block', reason, sha }
// 'sha' is the currentSha the enforcer analyzed — rejected if it no longer matches (stale verdict)
app.post('/enforcer-verdict', (req, res) => {
  const { prNumber, verdict, reason, sha } = req.body || {};
  if (
    typeof prNumber !== 'number' ||
    (verdict !== 'approve' && verdict !== 'block') ||
    typeof reason !== 'string'
  ) {
    return res.status(400).json({ error: 'prNumber (number), verdict (approve|block), reason (string) required' });
  }

  const pr = prs.get(prNumber);
  if (!pr) {
    return res.status(404).json({ error: 'PR not found' });
  }
  if (pr.enforcerState !== 'needs-enforcer-review') {
    return res.json({ status: 'ignored', reason: 'PR not in enforcer-pending state' });
  }

  // Reject stale verdicts: if enforcer analyzed an old newSha
  if (sha && pr.newSha && sha !== pr.newSha) {
    console.log(`[enforcer-verdict] #${prNumber} stale verdict for sha ${sha.slice(0, 7)} (current newSha=${pr.newSha.slice(0, 7)}) — ignoring`);
    return res.json({ status: 'stale', reason: 'SHA mismatch — verdict ignored' });
  }

  if (verdict === 'approve') {
    // Clear enforcer pending, update currentSha to the new one, keep votes intact
    pr.enforcerState = 'enforcer:approve';
    pr.enforcerComment = reason;
    pr.currentSha = pr.newSha;
    pr.approvedSha = pr.newSha; // treat the new SHA as approved
    pr.enforcerPendingSince = null;
    pr.newSha = null;
    pr.ciPassed = false; // re-gate CI on the new SHA
    console.log(`[enforcer-verdict] #${prNumber} APPROVED: ${reason}`);
    return res.json({ status: 'approved' });
  } else {
    // Block: clear enforcer pending, wipe votes, update currentSha
    pr.enforcerState = 'enforcer:block';
    pr.enforcerComment = reason;
    pr.currentSha = pr.newSha;
    pr.approvedSha = null;
    pr.votes.clear();
    pr.enforcerPendingSince = null;
    pr.newSha = null;
    pr.ciPassed = false;
    console.log(`[enforcer-verdict] #${prNumber} BLOCKED: ${reason}`);
    return res.json({ status: 'blocked' });
  }
});

// --- Socket.io events -------------------------------------------------------
io.on('connection', (socket) => {
  const id = generateId();
  const color = assignColor();
  usedColors.add(color);
  const name = generateName([...players.values()].map((p) => p.name));

  const spawnX = 768;
  const spawnY = 576;
  const player = { id, color, name, x: spawnX, y: spawnY, moveCount: 0 };
  players.set(socket.id, player);

  // Initialise leaderboard entry for new players (preserve existing stats on reconnect)
  if (!playerStats.has(name)) {
    playerStats.set(name, { name, color, prsmerged: 0, worldChanges: 0 });
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

  // Send CI-passed PRs this agent hasn't voted on yet
  const unvoted = [...prs.values()]
    .filter((pr) => pr.ciPassed && !pr.votes.has(id))
    .map((pr) => ({ number: pr.number, title: pr.title, url: pr.url }));
  if (unvoted.length > 0) {
    socket.emit('pr:review_needed', unvoted);
  }

  socket.on('player:identify', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    const requestedName = typeof data.name === 'string' ? data.name.trim() : '';
    if (!requestedName) return;
    const takenByOther = [...players.values()].some((q) => q !== p && q.name === requestedName);
    if (!takenByOther) {
      console.log(`[~] ${p.name} → ${requestedName}`);
      p.name = requestedName;
      io.emit('player:renamed', { id: p.id, name: p.name });
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
    // Sample ~every 10 moves to log activity without flooding
    p.moveCount = (p.moveCount || 0) + 1;
    if (p.moveCount % 10 === 0) {
      addLogEntry('action', p.name, `${p.name} is exploring`);
    }
  });

  // PR vote: { prNumber: number, vote: 'yes' | 'no' }
  socket.on('pr:vote', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    const { prNumber, vote } = data;
    if (typeof prNumber !== 'number' || (vote !== 'yes' && vote !== 'no')) return;
    const pr = prs.get(prNumber);
    if (!pr) return;
    // Don't allow voting on PRs in enforcer review or already decided
    if (pr.enforcerState) return;
    pr.votes.set(p.id, vote);
    let yes = 0, no = 0;
    for (const v of pr.votes.values()) { if (v === 'yes') yes++; else no++; }
    console.log(`[vote] ${p.name} voted ${vote} on PR #${prNumber} — ${yes}y/${no}n`);

    // Check if votes just crossed the approval threshold
    if (!pr.approvedSha && isAtThreshold(pr)) {
      pr.approvedSha = pr.currentSha;
      console.log(`[vote] PR #${prNumber} crossed approval threshold — approvedSha set to ${pr.approvedSha.slice(0, 7)}`);
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
