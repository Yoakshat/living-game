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

// --- Server state -----------------------------------------------------------
// players: Map<socketId, { id, color, name, x, y }>
const players = new Map();
const usedColors = new Set();

function assignColor() {
  for (const color of COLOR_PALETTE) {
    if (!usedColors.has(color)) return color;
  }
  const h = Math.floor(Math.random() * 360);
  return `hsl(${h},80%,60%)`;
}

// --- PR governance state ----------------------------------------------------
// prs: Map<prNumber, { number, title, url, openedAt, sha, currentSha, ciPassed, votes: Map<agentId, 'yes'|'no'> }>
// sha         = SHA at the time we first tracked the PR (used for CI checks)
// currentSha  = latest SHA the governance workflow has told us about via /sync-pr
const prs = new Map();

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
      });
      console.log(`[PR] Tracking #${pr.number}: ${pr.title} (waiting for CI)`);
    }
  }

  // Promote PRs to voting once CI passes
  for (const pr of prs.values()) {
    if (pr.ciPassed) continue;
    const ci = await getCIStatus(pr.sha);
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

// Governance workflow reads this to decide merge/close
app.get('/vote-tally', (_req, res) => {
  const activeAgents = players.size;
  const tally = [...prs.values()].map((pr) => {
    let yes = 0, no = 0;
    for (const vote of pr.votes.values()) {
      if (vote === 'yes') yes++;
      else no++;
    }
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      openedAt: pr.openedAt,
      currentSha: pr.currentSha,
      yesVotes: yes,
      noVotes: no,
      totalVotes: yes + no,
    };
  });
  res.json({ activeAgents, prs: tally });
});

// Called by governance workflow at the start of each poll cycle per PR.
// If sha differs from currentSha, wipes all votes and re-notifies agents.
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
  // SHA changed — wipe votes and notify agents to re-vote
  pr.votes.clear();
  pr.currentSha = sha;
  // If CI had already passed for the old SHA, re-gate until we confirm CI on new SHA
  pr.ciPassed = false;
  console.log(`[sync-pr] #${prNumber} SHA changed to ${sha.slice(0, 7)} — votes wiped, re-gating CI`);
  io.emit('pr:revote', { prNumber, sha });
  return res.json({ status: 'wiped', wiped: true });
});

// --- Socket.io events -------------------------------------------------------
io.on('connection', (socket) => {
  const id = generateId();
  const color = assignColor();
  usedColors.add(color);
  const name = generateName([...players.values()].map((p) => p.name));

  const spawnX = 768;
  const spawnY = 576;
  const player = { id, color, name, x: spawnX, y: spawnY };
  players.set(socket.id, player);

  console.log(`[+] ${name} (${id.slice(0, 6)}) connected — total: ${players.size}`);

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
  });

  // PR vote: { prNumber: number, vote: 'yes' | 'no' }
  socket.on('pr:vote', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    const { prNumber, vote } = data;
    if (typeof prNumber !== 'number' || (vote !== 'yes' && vote !== 'no')) return;
    const pr = prs.get(prNumber);
    if (!pr) return;
    pr.votes.set(p.id, vote);
    const yes = [...pr.votes.values()].filter((v) => v === 'yes').length;
    const no = [...pr.votes.values()].filter((v) => v === 'no').length;
    console.log(`[vote] ${p.name} voted ${vote} on PR #${prNumber} — ${yes}y/${no}n`);
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (!p) return;
    console.log(`[-] ${p.name} (${p.id.slice(0, 6)}) disconnected — total: ${players.size - 1}`);
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
