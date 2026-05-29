/**
 * Living Game — Enforcer Service
 *
 * A standalone polling service that:
 *  1. Polls GET /vote-tally every 60 seconds
 *  2. For each PR with enforcerState = 'needs-enforcer-review':
 *     a. Fetches the diff between approvedSha and newSha from GitHub
 *     b. Sends the diff to Claude to judge if it's purely mechanical conflict resolution
 *     c. Posts the verdict to POST /enforcer-verdict on the game server
 *     d. Posts a GitHub comment on the PR explaining the decision
 *
 * Required env vars:
 *   DEEPSEEK_API_KEY   — DeepSeek API key for diff analysis
 *   SERVER_URL         — Game server URL (e.g. https://living-game-server-production.up.railway.app)
 *   GITHUB_TOKEN       — GitHub token for reading diffs and posting comments
 */

import OpenAI from 'openai';

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const SERVER_URL = (process.env.SERVER_URL || '').replace(/\/$/, '');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'Yoakshat/living-game';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const MODEL_TIMEOUT_MS = 30_000;
const MODEL_MAX_RETRIES = 2;

// Validate required env vars at startup
if (!DEEPSEEK_API_KEY) {
  console.error('[enforcer] FATAL: DEEPSEEK_API_KEY is not set. Set this env var in Railway before deploying.');
  process.exit(1);
}
if (!SERVER_URL) {
  console.error('[enforcer] FATAL: SERVER_URL is not set. Set this env var in Railway.');
  process.exit(1);
}
if (!GITHUB_TOKEN) {
  console.error('[enforcer] FATAL: GITHUB_TOKEN is not set. Set this env var in Railway.');
  process.exit(1);
}

const deepseek = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

// Track PRs currently being analyzed to avoid duplicate concurrent analysis
const inFlight = new Set();

// --- HTTP helpers -----------------------------------------------------------

async function serverFetch(path, options = {}) {
  const url = `${SERVER_URL}${path}`;
  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'living-game-enforcer',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json();
  } catch (err) {
    throw new Error(`Server request failed (${url}): ${err.message}`);
  }
}

async function githubFetch(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'User-Agent': 'living-game-enforcer',
      Accept: 'application/vnd.github+json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API HTTP ${res.status} for ${path}: ${text}`);
  }
  return await res.json();
}

// --- GitHub helpers ---------------------------------------------------------

async function fetchDiffText(approvedSha, newSha) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/compare/${approvedSha}...${newSha}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'User-Agent': 'living-game-enforcer',
      Accept: 'application/vnd.github.v3.diff',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub compare API HTTP ${res.status}: ${text}`);
  }
  return await res.text();
}

async function postGitHubComment(prNumber, body) {
  await githubFetch(`/repos/${GITHUB_REPO}/issues/${prNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

// --- Claude helpers ---------------------------------------------------------

const CLAUDE_SYSTEM_PROMPT = `You are a strict code reviewer for a multiplayer game project. Your sole job is to determine whether a git diff represents PURELY mechanical conflict resolution — nothing more.

ALLOWED changes (approve these):
- Removing conflict markers (<<<<<<<, =======, >>>>>>>) and choosing one side
- Adding a merge commit message line (no code changes)
- No-op whitespace changes that result directly from resolving a conflict marker

NOT ALLOWED (block these — be conservative):
- Any change to game logic in .js or .ts files
- New functions, classes, or exports
- Modified constants, thresholds, or configuration values that affect gameplay
- New files (except auto-generated lock files that are a direct merge artifact)
- Renaming variables or refactoring code
- Reformatting that goes beyond what the conflict resolution requires
- Changes to .json files (other than package-lock.json auto-merge artifacts)
- Changes to .html or .md game files beyond conflict marker removal

CONSERVATIVE BIAS: If you are uncertain whether a change is mechanical, treat it as NOT mechanical and block. A false positive (blocking a legitimate conflict resolution) is much less harmful than a false negative (approving a logic change disguised as conflict resolution).

Respond with EXACTLY this format — two lines, nothing else:
VERDICT: approve
REASON: <one sentence explaining your decision>

OR:

VERDICT: block
REASON: <one sentence describing what non-mechanical change you detected or why you are uncertain>`;

function buildPrompt(pr, diff) {
  return `PR #${pr.number}: ${pr.title}

Approved SHA: ${pr.approvedSha}
New SHA: ${pr.newSha}

The diff below shows what changed between the SHA that received enough votes to be approved, and the new SHA that was pushed afterward. Determine whether this diff is PURELY mechanical conflict resolution.

=== DIFF ===
${diff.slice(0, 50_000)}
=== END DIFF ===

Remember: approve only if every single change in the diff is a mechanical conflict resolution artifact. Block on any doubt.`;
}

async function callModelWithTimeout(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await deepseek.chat.completions.create(
      {
        model: 'deepseek-chat',
        max_tokens: 256,
        messages: [
          { role: 'system', content: CLAUDE_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      },
      { signal: controller.signal }
    );
    return response.choices[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

async function callModel(prompt) {
  let lastError;
  for (let attempt = 0; attempt <= MODEL_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) console.log(`[enforcer] Retry attempt ${attempt}`);
      return await callModelWithTimeout(prompt);
    } catch (err) {
      lastError = err;
      console.error(`[enforcer] Model attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  throw lastError;
}

function parseVerdict(claudeText) {
  const lines = claudeText.split('\n').map((l) => l.trim());
  let verdict = null;
  let reason = null;

  for (const line of lines) {
    if (line.startsWith('VERDICT:')) {
      const v = line.replace('VERDICT:', '').trim().toLowerCase();
      if (v === 'approve') verdict = 'approve';
      else verdict = 'block'; // anything that is not a clear "approve" is a block
    }
    if (line.startsWith('REASON:')) {
      reason = line.replace('REASON:', '').trim();
    }
  }

  // Default to block if Claude's response was unclear
  if (!verdict) {
    verdict = 'block';
    reason = reason || 'Claude response was ambiguous — blocking for safety.';
  }
  if (!reason) {
    reason = verdict === 'approve'
      ? 'Delta is purely mechanical conflict resolution.'
      : 'Claude determined the changes were not purely mechanical.';
  }

  return { verdict, reason };
}

// --- Core analysis loop -----------------------------------------------------

async function analyzePR(pr) {
  const key = `${pr.number}:${pr.newSha}`;
  if (inFlight.has(key)) {
    console.log(`[enforcer] PR #${pr.number} analysis already in flight — skipping`);
    return;
  }
  inFlight.add(key);

  console.log(`[enforcer] PR #${pr.number} needs review — approvedSha=${pr.approvedSha?.slice(0, 7)} newSha=${pr.newSha?.slice(0, 7)}`);

  let verdict = 'block';
  let reason = 'Analysis failed — blocking for safety.';

  try {
    // 1. Fetch diff
    console.log(`[enforcer] PR #${pr.number} fetching diff ${pr.approvedSha?.slice(0, 7)}...${pr.newSha?.slice(0, 7)}`);
    const diff = await fetchDiffText(pr.approvedSha, pr.newSha);
    console.log(`[enforcer] PR #${pr.number} diff fetched (${diff.length} chars)`);

    // 2. Build prompt and call Claude
    const prompt = buildPrompt(pr, diff);
    console.log(`[enforcer] PR #${pr.number} calling DeepSeek`);

    let modelText;
    try {
      modelText = await callModel(prompt);
    } catch (err) {
      console.error(`[enforcer] PR #${pr.number} model call failed after retries: ${err.message}`);
      verdict = 'block';
      reason = 'Analysis timed out — closing for safety.';
      modelText = null;
    }

    if (modelText) {
      console.log(`[enforcer] PR #${pr.number} DeepSeek response: ${modelText.slice(0, 200)}`);
      const parsed = parseVerdict(modelText);
      verdict = parsed.verdict;
      reason = parsed.reason;
    }
  } catch (err) {
    console.error(`[enforcer] PR #${pr.number} analysis error: ${err.message}`);
    verdict = 'block';
    reason = `Analysis error — blocking for safety. (${err.message.slice(0, 100)})`;
  }

  console.log(`[enforcer] PR #${pr.number} VERDICT: ${verdict} — ${reason}`);

  // 3. Post verdict to server
  try {
    const result = await serverFetch('/enforcer-verdict', {
      method: 'POST',
      body: JSON.stringify({
        prNumber: pr.number,
        verdict,
        reason,
        sha: pr.newSha, // lets server reject stale verdicts
      }),
    });
    console.log(`[enforcer] PR #${pr.number} verdict posted: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[enforcer] PR #${pr.number} failed to post verdict: ${err.message}`);
    inFlight.delete(key);
    return;
  }

  // 4. Post GitHub comment
  const commentBody = verdict === 'approve'
    ? `**Enforcer verdict: approved** ✓\n\n${reason}\n\nThe diff between the approved commit and the new commit is purely mechanical conflict resolution. Original votes remain valid — this PR will be merged on the next governance cycle if CI passes.`
    : `**Enforcer verdict: blocked** ✗\n\n${reason}\n\nThe diff between the approved commit and the new commit contains changes beyond mechanical conflict resolution. Votes have been cleared. Please open a new PR with only the intended game mechanic change and no additional modifications.`;

  try {
    await postGitHubComment(pr.number, commentBody);
    console.log(`[enforcer] PR #${pr.number} GitHub comment posted`);
  } catch (err) {
    console.error(`[enforcer] PR #${pr.number} failed to post GitHub comment: ${err.message}`);
    // Non-fatal — verdict was already posted to server
  }

  inFlight.delete(key);
}

// --- Polling loop -----------------------------------------------------------

async function poll() {
  console.log('[enforcer] Polling /vote-tally...');
  let tally;
  try {
    tally = await serverFetch('/vote-tally');
  } catch (err) {
    console.error(`[enforcer] Failed to fetch vote tally: ${err.message} — will retry next cycle`);
    return;
  }

  const pendingPRs = (tally.prs || []).filter(
    (pr) => pr.enforcerState === 'needs-enforcer-review'
  );

  if (pendingPRs.length === 0) {
    console.log('[enforcer] No PRs pending enforcer review.');
    return;
  }

  console.log(`[enforcer] ${pendingPRs.length} PR(s) need enforcer review.`);

  // Process all pending PRs concurrently (each has its own timeout)
  await Promise.allSettled(pendingPRs.map((pr) => analyzePR(pr)));
}

async function runLoop() {
  console.log(`[enforcer] Starting. SERVER_URL=${SERVER_URL} POLL_INTERVAL=${POLL_INTERVAL_MS}ms`);

  // Run immediately on start, then on interval
  await poll();
  setInterval(() => {
    poll().catch((err) => console.error('[enforcer] Unhandled poll error:', err));
  }, POLL_INTERVAL_MS);
}

runLoop().catch((err) => {
  console.error('[enforcer] Fatal startup error:', err);
  process.exit(1);
});
