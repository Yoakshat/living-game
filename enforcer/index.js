/**
 * Living Game — Enforcer Service
 *
 * A standalone polling service that:
 *  1. Polls GET /vote-tally every 60 seconds
 *  2. For each PR with enforcerState = 'needs-enforcer-review':
 *     a. Fetches the diff between approvedSha and newSha from GitHub
 *     b. Sends the diff to DeepSeek to judge if it's purely mechanical conflict resolution
 *     c. Posts the verdict to POST /enforcer-verdict on the game server
 *     d. Posts a GitHub comment on the PR explaining the decision
 *
 * Required env vars:
 *   DEEPSEEK_API_KEY   — DeepSeek API key for diff analysis
 *   SERVER_URL         — Game server URL (e.g. https://living-game-server-production.up.railway.app)
 *   GITHUB_TOKEN       — GitHub token for reading diffs and posting comments
 */

const OpenAI = require('openai').default;
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const SERVER_URL = (process.env.SERVER_URL || '').replace(/\/$/, '');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'Yoakshat/living-game';

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const MODEL_TIMEOUT_MS = 120_000;
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

// Track PRs that have been auto-resolved: Map<prNumber, resolvedSha>
// Prevents re-resolving the same commit on every poll cycle.
const resolvedConflicts = new Map();

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
  const url = `https://api.github.com/repos/${GITHUB_REPO}/issues/${prNumber}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'User-Agent': 'living-game-enforcer',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API HTTP ${res.status}: ${text}`);
  }
}

// --- Conflict resolution helpers --------------------------------------------

function gitExec(cmd, cwd, opts = {}) {
  // Wrapper around execSync that injects credentials via env vars
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'living-game-enforcer',
    GIT_AUTHOR_EMAIL: 'enforcer@living-game',
    GIT_COMMITTER_NAME: 'living-game-enforcer',
    GIT_COMMITTER_EMAIL: 'enforcer@living-game',
    // Prevent git from prompting for credentials; pass token in URL instead
    GIT_TERMINAL_PROMPT: '0',
    ...opts.env,
  };
  return execSync(cmd, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function getConflictedFiles(repoDir) {
  const output = gitExec('git diff --name-only --diff-filter=U', repoDir);
  return output.trim().split('\n').filter(Boolean);
}

const CONFLICT_SYSTEM_PROMPT = `You are resolving a merge conflict in "Living Game" — a top-down multiplayer world where AI agents propose changes via PRs.

You will receive a file with standard git conflict markers (<<<<<<< HEAD, =======, >>>>>>>) and the intent of the PR being merged. Produce the fully resolved file. Always make a judgment call — never refuse. If both sides add something new, keep both. If they modify the same thing differently, pick whichever makes more sense for the game based on the PR description.

Output ONLY the resolved file content. No explanation, no markdown fences.`;

async function resolveFileConflict(prTitle, prBody, filePath, conflictContent) {
  const prompt = `PR being merged: ${prTitle}
PR description: ${prBody || '(none)'}

File: ${filePath}

${conflictContent.slice(0, 50_000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const response = await deepseek.chat.completions.create(
      {
        model: 'deepseek-chat',
        max_tokens: 8192,
        messages: [
          { role: 'system', content: CONFLICT_SYSTEM_PROMPT },
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

// Generic retry wrapper that accepts an async function (instead of a prompt string)
async function callModelFn(fn) {
  let lastError;
  for (let attempt = 0; attempt <= MODEL_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) console.log(`[enforcer] Retry attempt ${attempt}`);
      return await fn();
    } catch (err) {
      lastError = err;
      console.error(`[enforcer] Model attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  throw lastError;
}

async function resolveConflict(prNumber, prData) {
  const conflictKey = `conflict:${prNumber}`;
  if (inFlight.has(conflictKey)) {
    console.log(`[conflict] PR #${prNumber} conflict resolution already in flight — skipping`);
    return;
  }
  inFlight.add(conflictKey);

  const branchName = prData.head.ref;
  const headSha = prData.head.sha;
  const tmpDir = `/tmp/living-game-resolve-${prNumber}`;
  const repoUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`;

  console.log(`[conflict] PR #${prNumber} — starting conflict resolution (branch=${branchName}, sha=${headSha.slice(0, 7)})`);

  try {
    // 1. Clone directly onto the PR branch (needs full history for 3-way merge)
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`[conflict] PR #${prNumber} cloning branch ${branchName}`);
    execSync(`git clone --branch "${branchName}" "${repoUrl}" "${tmpDir}"`, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 2. Attempt merge with main
    console.log(`[conflict] PR #${prNumber} merging origin/main`);
    try {
      gitExec('git merge origin/main --no-edit', tmpDir);
      // Merge succeeded without conflicts — nothing to resolve
      console.log(`[conflict] PR #${prNumber} merged cleanly — no conflicts to resolve`);
      return; // finally block handles cleanup
    } catch (mergeErr) {
      // Expected: merge left conflict markers
      console.log(`[conflict] PR #${prNumber} merge produced conflicts — proceeding with resolution`);
    }

    // 3. Collect conflicted files
    const conflictedFiles = getConflictedFiles(tmpDir);
    if (conflictedFiles.length === 0) {
      console.log(`[conflict] PR #${prNumber} no conflicted files found — aborting merge and skipping`);
      try { gitExec('git merge --abort', tmpDir); } catch {}
      return;
    }
    console.log(`[conflict] PR #${prNumber} conflicted files: ${conflictedFiles.join(', ')}`);

    // 4. Resolve each file via DeepSeek (one call per file, with PR intent)
    const prTitle = prData.title || `PR #${prNumber}`;
    const prBody = prData.body || '';
    const resolvedFileSummaries = [];

    for (const relFile of conflictedFiles) {
      const absFile = path.join(tmpDir, relFile);
      const conflictContent = fs.readFileSync(absFile, 'utf8');
      console.log(`[conflict] PR #${prNumber} resolving ${relFile} via DeepSeek`);

      let resolved;
      try {
        resolved = await callModelFn(() => resolveFileConflict(prTitle, prBody, relFile, conflictContent));
      } catch (err) {
        console.error(`[conflict] PR #${prNumber} DeepSeek failed for ${relFile}: ${err.message}`);
        try { gitExec('git merge --abort', tmpDir); } catch {}
        return;
      }

      // Strip markdown fences if model wrapped output
      resolved = resolved.replace(/^```[a-z]*\n?/m, '').replace(/\n?```\s*$/m, '');

      if (!resolved.trim()) {
        console.error(`[conflict] PR #${prNumber} empty response for ${relFile} — aborting`);
        try { gitExec('git merge --abort', tmpDir); } catch {}
        return;
      }

      fs.writeFileSync(absFile, resolved, 'utf8');
      resolvedFileSummaries.push(relFile);
      console.log(`[conflict] PR #${prNumber} ${relFile} resolved`);
    }

    // 5. Stage and commit
    console.log(`[conflict] PR #${prNumber} staging resolved files`);
    gitExec('git add -A', tmpDir);

    const commitMsg = `Auto-resolve merge conflict with main\n\nResolved files: ${resolvedFileSummaries.join(', ')}`;
    const commitMsgFile = path.join(tmpDir, '.git', 'CONFLICT_RESOLVE_MSG');
    fs.writeFileSync(commitMsgFile, commitMsg, 'utf8');
    gitExec(`git commit -F "${commitMsgFile}"`, tmpDir);

    console.log(`[conflict] PR #${prNumber} pushing to origin/${branchName}`);
    gitExec(`git push origin "HEAD:${branchName}"`, tmpDir);

    const newSha = gitExec('git rev-parse HEAD', tmpDir).trim();
    console.log(`[conflict] PR #${prNumber} pushed resolved commit ${newSha.slice(0, 7)}`);

    // 8. Record the resolved SHA so we don't re-resolve on next poll
    resolvedConflicts.set(prNumber, newSha);

    // 9. Post GitHub comment
    const fileList = resolvedFileSummaries.map(f => `- \`${f}\``).join('\n');
    await postGitHubComment(prNumber,
      `**Enforcer: merge conflict auto-resolved** ✓\n\n` +
      `The enforcer automatically resolved a merge conflict with \`main\`.\n\n` +
      `**Files resolved:**\n${fileList}\n\n` +
      `Both contributions have been preserved where possible. ` +
      `CI will run on the updated branch — governance will proceed normally once it passes.`
    );
    console.log(`[conflict] PR #${prNumber} conflict resolution complete`);

  } catch (err) {
    console.error(`[conflict] PR #${prNumber} resolution failed: ${err.message}`);
    // Leave PR open — don't close on unexpected errors, just log and move on
  } finally {
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    inFlight.delete(conflictKey);
  }
}

// --- Model helpers ----------------------------------------------------------

const SYSTEM_PROMPT = `You are a strict code reviewer for a multiplayer game project. Your sole job is to determine whether a git diff represents PURELY mechanical conflict resolution — nothing more.

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
          { role: 'system', content: SYSTEM_PROMPT },
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

function parseVerdict(modelText) {
  const lines = modelText.split('\n').map((l) => l.trim());
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

  // Default to block if the response was unclear
  if (!verdict) {
    verdict = 'block';
    reason = reason || 'Model response was ambiguous — blocking for safety.';
  }
  if (!reason) {
    reason = verdict === 'approve'
      ? 'Delta is purely mechanical conflict resolution.'
      : 'Model determined the changes were not purely mechanical.';
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

    // 2. Build prompt and call DeepSeek
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

// --- GitHub governance helpers ----------------------------------------------

async function githubRequest(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...options,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'User-Agent': 'living-game-enforcer',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : await res.json();
}

async function getPRDetails(prNumber) {
  try { return await githubRequest(`/pulls/${prNumber}`); }
  catch { return null; }
}

async function getCIStatus(sha) {
  try {
    const data = await githubRequest(`/commits/${sha}/check-runs`);
    if (!data || !data.total_count) return 'pending';
    const runs = data.check_runs;
    if (runs.some(r => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion))) return 'failed';
    if (runs.some(r => r.status === 'in_progress' || r.status === 'queued')) return 'pending';
    return 'passed';
  } catch { return 'pending'; }
}

async function mergePR(prNumber, title) {
  await githubRequest(`/pulls/${prNumber}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'squash', commit_title: `${title} (#${prNumber})` }),
  });
  console.log(`[governance] PR #${prNumber} merged`);
}

async function closePR(prNumber, comment) {
  await githubRequest(`/pulls/${prNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
  if (comment) await postGitHubComment(prNumber, comment);
  console.log(`[governance] PR #${prNumber} closed`);
}

// --- Governance loop --------------------------------------------------------

const ENFORCER_TIMEOUT_MS = 30 * 60 * 1000;

async function governPR(pr, quorum, freshTallyFn) {
  const prData = await getPRDetails(pr.number);
  if (!prData || prData.state !== 'open') return;

  // Enforcer:block → close
  if (pr.enforcerState === 'enforcer:block') {
    await closePR(pr.number, `**Enforcer verdict: blocked.** ${pr.enforcerComment || ''}`);
    return;
  }

  // Enforcer review in progress → check timeout
  if (pr.enforcerState === 'needs-enforcer-review') {
    if (pr.enforcerPendingSince) {
      const elapsed = Date.now() - new Date(pr.enforcerPendingSince).getTime();
      if (elapsed >= ENFORCER_TIMEOUT_MS) {
        await closePR(pr.number, `Enforcer unavailable — closed after ${Math.round(elapsed / 60000)} minutes waiting for verdict. Re-open when the enforcer is back online.`);
      }
    }
    return;
  }

  // Sync SHA — wipes votes if pushed after last tally
  const currentSha = prData.head.sha;
  const syncResult = await serverFetch('/sync-pr', {
    method: 'POST',
    body: JSON.stringify({ prNumber: pr.number, sha: currentSha }),
  }).catch(() => ({ status: 'error' }));
  if (syncResult.status === 'enforcer-pending') return;

  // Re-fetch fresh tally after sync (votes may have been wiped)
  const fresh = await freshTallyFn();
  const freshPR = (fresh.prs || []).find(p => p.number === pr.number);
  if (!freshPR || freshPR.enforcerState === 'needs-enforcer-review') return;

  // Merge conflict check — auto-resolve instead of just commenting
  if (prData.mergeable === false) {
    // If we already resolved this exact SHA, wait for GitHub to recompute mergeability
    if (resolvedConflicts.has(pr.number) && resolvedConflicts.get(pr.number) === currentSha) {
      console.log(`[conflict] PR #${pr.number} already resolved at ${currentSha.slice(0, 7)} — waiting for GitHub mergeability recompute`);
      return;
    }

    // If SHA changed since last resolution, clear the record so we can re-resolve
    if (resolvedConflicts.has(pr.number) && resolvedConflicts.get(pr.number) !== currentSha) {
      console.log(`[conflict] PR #${pr.number} SHA changed since last resolution — clearing record`);
      resolvedConflicts.delete(pr.number);
    }

    // Trigger auto-resolution (non-blocking — next poll will see the pushed commit)
    resolveConflict(pr.number, prData).catch(err =>
      console.error(`[conflict] PR #${pr.number} unexpected resolution error: ${err.message}`)
    );
    return;
  }
  if (prData.mergeable === null) return; // GitHub still computing

  // currentSha was set above when syncing; reuse it here.

  // If CI failed on a SHA that the enforcer auto-resolved, close with explanation
  if (resolvedConflicts.has(pr.number) && resolvedConflicts.get(pr.number) === currentSha) {
    const ci = await getCIStatus(currentSha);
    if (ci === 'failed') {
      resolvedConflicts.delete(pr.number);
      await closePR(pr.number,
        `**Enforcer: closing after failed auto-resolution**\n\n` +
        `CI failed on the commit that the enforcer pushed to resolve the merge conflict. ` +
        `The auto-resolution likely introduced a breakage. Please resolve the conflict manually, verify the game works, and open a new PR.`
      );
      return;
    }
    if (ci === 'pending') return;
    // CI passed — fall through to normal governance
  }

  const ci = await getCIStatus(freshPR.currentSha);
  if (ci === 'failed') { await closePR(pr.number, 'Closing — CI failed. Fix the build errors and resubmit.'); return; }
  if (ci === 'pending') return;

  // Enforcer approved → merge
  if (freshPR.enforcerState === 'enforcer:approve') { await mergePR(pr.number, prData.title); return; }

  const { yesVotes: yes, noVotes: no, totalVotes: total } = freshPR;
  console.log(`[governance] PR #${pr.number}: ${yes}y/${no}n (quorum=${quorum})`);

  if (total >= quorum) {
    if (yes * 3 >= total * 2) {
      await mergePR(pr.number, prData.title);
    } else {
      await closePR(pr.number, `Vote closed: **${yes} yes / ${no} no** (quorum was ${quorum}). Approval below 2/3 — closing. Fix and resubmit when ready.`);
    }
  } else {
    // Stale after 48h
    const ageHours = (Date.now() - new Date(pr.openedAt).getTime()) / 3_600_000;
    if (ageHours >= 48) {
      await closePR(pr.number, `Closed after ${Math.round(ageHours)}h with insufficient votes (${total}/${quorum} needed). Resubmit when more agents are active.`);
    }
  }
}

async function governancePoll(tally) {
  const quorum = Math.max(Math.ceil((tally.activeAgents || 0) * 0.05), 1);
  const prs = (tally.prs || []).filter(pr => pr.number);
  if (prs.length === 0) {
    console.log('[governance] No open PRs to govern.');
    return;
  }

  console.log(`[governance] ${prs.length} tracked PR(s), quorum=${quorum}`);

  // Cache one fresh tally per governance cycle to avoid hammering the server
  let cachedFresh = null;
  const freshTallyFn = async () => {
    if (!cachedFresh) cachedFresh = await serverFetch('/vote-tally');
    return cachedFresh;
  };

  for (const pr of prs) {
    try { await governPR(pr, quorum, freshTallyFn); }
    catch (err) { console.error(`[governance] PR #${pr.number} error: ${err.message}`); }
  }
}

// --- Polling loop -----------------------------------------------------------

async function poll() {
  let tally;
  try {
    tally = await serverFetch('/vote-tally');
  } catch (err) {
    console.error(`[enforcer] Failed to fetch vote tally: ${err.message} — will retry next cycle`);
    return;
  }

  // Run enforcer review for PRs needing diff analysis
  const pendingEnforcer = (tally.prs || []).filter(pr => pr.enforcerState === 'needs-enforcer-review');
  if (pendingEnforcer.length > 0) {
    console.log(`[enforcer] ${pendingEnforcer.length} PR(s) need enforcer review.`);
    await Promise.allSettled(pendingEnforcer.map(pr => analyzePR(pr)));
  }

  // Run governance (merge/close based on votes)
  await governancePoll(tally);
}

async function runLoop() {
  console.log(`[enforcer] Starting. SERVER_URL=${SERVER_URL} POLL_INTERVAL=${POLL_INTERVAL_MS}ms`);

  await poll();
  setInterval(() => {
    poll().catch((err) => console.error('[enforcer] Unhandled poll error:', err));
  }, POLL_INTERVAL_MS);
}

runLoop().catch((err) => {
  console.error('[enforcer] Fatal startup error:', err);
  process.exit(1);
});
