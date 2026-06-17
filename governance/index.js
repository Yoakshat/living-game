const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');

const SERVER_URL = process.env.SERVER_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'Yoakshat/living-game';
const POLL_MS = 10_000;
const REPO_DIR = '/tmp/living-game-repo';

if (!SERVER_URL) { console.error('SERVER_URL required'); process.exit(1); }
if (!GITHUB_TOKEN) { console.error('GITHUB_TOKEN required'); process.exit(1); }

let repoReady = false;
let mergeLock = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function git(cmd) {
  return execSync(`git ${cmd}`, { cwd: REPO_DIR, stdio: 'pipe' }).toString().trim();
}

function ensureRepo() {
  if (repoReady) return;
  const remoteUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git`;
  if (!fs.existsSync(REPO_DIR)) {
    log('Cloning repo...');
    execSync(`git clone ${remoteUrl} ${REPO_DIR}`, { stdio: 'pipe' });
  }
  git('config user.email "governance@living-game"');
  git('config user.name "Living Game Governance"');
  git(`remote set-url origin ${remoteUrl}`);
  repoReady = true;
  log('Repo ready');
}

async function ghFetch(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'living-game-governance',
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function getCIStatus(sha) {
  const data = await ghFetch(`/commits/${sha}/check-runs`);
  if (!data || data.total_count === 0) return 'pending';
  const runs = data.check_runs;
  if (runs.some(r => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion))) return 'failed';
  if (runs.some(r => !r.conclusion || r.status === 'in_progress' || r.status === 'queued')) return 'pending';
  return 'success';
}

function extractIdeaId(title) {
  const match = title.match(/\[idea:([^\]]+)\]/);
  return match ? match[1] : null;
}

async function closePR(num, msg) {
  try {
    await ghFetch(`/issues/${num}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: msg }),
    });
    await ghFetch(`/pulls/${num}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'closed' }),
    });
  } catch (err) {
    log(`Failed to close PR #${num}: ${err.message}`);
  }
}

async function notifyServer(ideaId) {
  try {
    await fetch(`${SERVER_URL}/idea-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ideaId }),
      signal: AbortSignal.timeout(8000),
    });
    log(`idea-complete posted for ${ideaId}`);
  } catch (err) {
    log(`idea-complete failed for ${ideaId}: ${err.message}`);
  }
}

async function govern() {
  if (mergeLock) return;

  let allPRs;
  try {
    allPRs = await ghFetch('/pulls?state=open&per_page=100');
  } catch (err) {
    log(`Failed to fetch PRs: ${err.message}`);
    return;
  }

  const ideaPRs = allPRs.filter(pr => extractIdeaId(pr.title));
  if (ideaPRs.length === 0) return;

  // Check CI for all idea PRs in parallel
  const ciResults = await Promise.all(
    ideaPRs.map(pr =>
      getCIStatus(pr.head.sha)
        .then(ci => ({ pr, ci }))
        .catch(() => ({ pr, ci: 'pending' }))
    )
  );

  const readyPRs = ciResults.filter(r => r.ci === 'success').map(r => r.pr);
  const pendingPRs = ciResults.filter(r => r.ci !== 'success');

  for (const { pr, ci } of pendingPRs) {
    log(`PR #${pr.number} "${pr.title.slice(0, 50)}" CI: ${ci}`);
  }

  if (readyPRs.length === 0) return;
  log(`${readyPRs.length} PR(s) ready — union-merging`);

  mergeLock = true;
  try {
    ensureRepo();
    git('fetch origin');
    git('checkout main');
    git('pull origin main');

    const mergedNums = new Set();
    const completedIdeas = new Set();

    for (const pr of readyPRs) {
      const branch = pr.head.ref;
      try {
        const result = git(`merge -X union --no-edit origin/${branch}`);
        log(`PR #${pr.number} (${branch}): ${result.split('\n')[0]}`);
        mergedNums.add(pr.number);
        const ideaId = extractIdeaId(pr.title);
        if (ideaId) completedIdeas.add(ideaId);
      } catch (err) {
        const msg = err.stderr ? err.stderr.toString().split('\n')[0] : err.message;
        log(`PR #${pr.number} merge error: ${msg}`);
        try { git('merge --abort'); } catch {}
      }
    }

    if (mergedNums.size > 0) {
      git('push origin main');
      log(`Pushed ${mergedNums.size} merge(s) to main`);
    }

    for (const pr of readyPRs) {
      if (mergedNums.has(pr.number)) {
        await closePR(pr.number, 'Union-merged into main — both sides of any conflict were kept.');
      }
    }

    for (const ideaId of completedIdeas) {
      await notifyServer(ideaId);
    }
  } catch (err) {
    log(`Govern error: ${err.message}`);
    try { git('merge --abort'); } catch {}
    try { git('reset --hard origin/main'); } catch {}
  } finally {
    mergeLock = false;
  }
}

async function loop() {
  while (true) {
    try { await govern(); } catch (err) { log(`Loop error: ${err.message}`); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

const healthServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
});
healthServer.listen(process.env.PORT || 4000, () => {
  log(`Governance service started — polling every ${POLL_MS / 1000}s`);
  try { ensureRepo(); } catch (err) { log(`Initial clone failed: ${err.message}`); }
  loop();
});
