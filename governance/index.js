const http = require('http');

const SERVER_URL = process.env.SERVER_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'Yoakshat/living-game';
const POLL_MS = 30_000;

if (!SERVER_URL) { console.error('SERVER_URL required'); process.exit(1); }
if (!GITHUB_TOKEN) { console.error('GITHUB_TOKEN required'); process.exit(1); }

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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

async function autoResolveConflict(pr) {
  try {
    const files = await ghFetch(`/pulls/${pr.number}/files`);
    for (const file of files) {
      const path = file.filename;
      let prContent, mainContent, mainSha;
      try {
        const prFile = await ghFetch(`/contents/${path}?ref=${encodeURIComponent(pr.head.ref)}`);
        prContent = Buffer.from(prFile.content, 'base64').toString('utf8');
      } catch (err) {
        log(`autoResolveConflict: could not fetch PR version of ${path}: ${err.message}`);
        return false;
      }
      try {
        const mainFile = await ghFetch(`/contents/${path}?ref=main`);
        mainContent = Buffer.from(mainFile.content, 'base64').toString('utf8');
        mainSha = mainFile.sha;
      } catch (err) {
        log(`autoResolveConflict: could not fetch main version of ${path}: ${err.message}`);
        return false;
      }

      // Call DeepSeek to merge the two versions
      let mergedContent;
      try {
        const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              {
                role: 'system',
                content: 'You are a code merge expert. Given two versions of a file, produce a clean merge that preserves both changes. Return ONLY the merged file content with no explanation, no markdown fences, no commentary.',
              },
              {
                role: 'user',
                content: `PR branch version:\n\n${prContent}\n\n---\n\nmain branch version:\n\n${mainContent}\n\nMerge these, keeping both changes. Return only the merged file.`,
              },
            ],
            temperature: 0,
          }),
          signal: AbortSignal.timeout(60000),
        });
        if (!dsRes.ok) {
          const errText = await dsRes.text();
          log(`autoResolveConflict: DeepSeek error for ${path}: ${dsRes.status} ${errText}`);
          return false;
        }
        const dsData = await dsRes.json();
        mergedContent = dsData.choices[0].message.content;
      } catch (err) {
        log(`autoResolveConflict: DeepSeek call failed for ${path}: ${err.message}`);
        return false;
      }

      // Push merged content back to the PR branch
      try {
        const encodedContent = Buffer.from(mergedContent).toString('base64');
        await ghFetch(`/contents/${path}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Auto-resolve conflict in ${path}`,
            content: encodedContent,
            sha: mainSha,
            branch: pr.head.ref,
          }),
        });
        log(`autoResolveConflict: resolved ${path}`);
      } catch (err) {
        log(`autoResolveConflict: could not push merged ${path}: ${err.message}`);
        return false;
      }
    }
    return true;
  } catch (err) {
    log(`autoResolveConflict: unexpected error: ${err.message}`);
    return false;
  }
}

async function govern() {
  // 1. Fetch active idea from game server
  let activeIdea;
  try {
    const res = await fetch(`${SERVER_URL}/active-idea`, { signal: AbortSignal.timeout(8000) });
    activeIdea = await res.json();
  } catch (err) {
    log(`Could not reach game server: ${err.message}`);
    return;
  }
  if (!activeIdea || !activeIdea.id) return;

  const { id: ideaId, assignedAgent } = activeIdea;
  const tag = `[idea:${ideaId}]`;
  log(`Active idea: ${ideaId} — scanning PRs for ${tag}`);

  // 2. Fetch open PRs
  const prs = await ghFetch('/pulls?state=open&per_page=50');
  const matching = prs.filter(pr => pr.title.includes(tag));
  if (matching.length === 0) { log('No matching PRs this cycle'); return; }

  log(`Found ${matching.length} matching PR(s)`);

  let winner = null;

  for (const pr of matching) {
    const author = pr.user.login;
    const num = pr.number;

    // Must be the assigned agent
    if (author !== assignedAgent) {
      log(`PR #${num}: author ${author} is not the assigned agent (${assignedAgent}) — closing`);
      await ghFetch(`/issues/${num}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `Author \`${author}\` is not the assigned agent for this idea. Closing.` }),
      });
      await ghFetch(`/pulls/${num}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      });
      continue;
    }

    // CI must be green
    let ci;
    try { ci = await getCIStatus(pr.head.sha); } catch (err) { ci = 'pending'; }
    if (ci !== 'success') {
      log(`PR #${num}: CI is ${ci} — skipping`);
      continue;
    }

    if (!winner) {
      winner = pr;
      log(`PR #${num} wins — merging`);
      try {
        await ghFetch(`/pulls/${num}/merge`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ merge_method: 'squash', commit_title: pr.title }),
        });
        log(`PR #${num} merged`);
      } catch (err) {
        const isConflict = err.message.includes('405') || err.message.toLowerCase().includes('conflict');
        if (isConflict && process.env.DEEPSEEK_API_KEY) {
          log(`PR #${num} has a merge conflict — attempting auto-resolve with DeepSeek`);
          const resolved = await autoResolveConflict(pr);
          if (resolved) {
            log(`PR #${num} conflicts resolved — retrying merge`);
            try {
              await ghFetch(`/pulls/${num}/merge`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merge_method: 'squash', commit_title: pr.title }) });
              log(`PR #${num} merged after conflict resolution`);
            } catch (retryErr) {
              log(`PR #${num} retry merge failed: ${retryErr.message}`);
              winner = null;
              continue;
            }
          } else {
            log(`PR #${num} could not auto-resolve conflicts — skipping`);
            winner = null;
            continue;
          }
        } else {
          log(`PR #${num} merge failed: ${err.message}`);
          winner = null;
          continue;
        }
      }
      // Notify game server
      try {
        await fetch(`${SERVER_URL}/idea-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ideaId }),
          signal: AbortSignal.timeout(8000),
        });
        log(`idea-complete posted for ${ideaId}`);
      } catch (err) {
        log(`idea-complete failed: ${err.message}`);
      }
    } else {
      log(`PR #${num}: another PR already won — closing`);
      await ghFetch(`/issues/${num}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Another implementation won the race for this idea. Closing.' }),
      });
      await ghFetch(`/pulls/${num}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      });
    }
  }
}

async function loop() {
  while (true) {
    try { await govern(); } catch (err) { log(`govern error: ${err.message}`); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Health endpoint so Railway knows the service is alive
const healthServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
});
healthServer.listen(process.env.PORT || 4000, () => {
  log(`Governance service started — polling every ${POLL_MS / 1000}s`);
  if (!process.env.DEEPSEEK_API_KEY) log('[warn] DEEPSEEK_API_KEY not set — conflict auto-resolution disabled');
  loop();
});
