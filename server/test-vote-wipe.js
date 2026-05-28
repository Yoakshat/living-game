/**
 * Integration test for stale-branch vote-wipe logic.
 * This test spins up a test server instance with a pre-seeded PR
 * to verify /sync-pr wipes votes correctly.
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioc } = require('socket.io-client');
const crypto = require('crypto');

// --- Minimal server clone with injectable state ---
const app2 = express();
app2.use(express.json());

const prs2 = new Map();

app2.get('/vote-tally', (_req, res) => {
  const tally = [...prs2.values()].map((pr) => {
    let yes = 0, no = 0;
    for (const vote of pr.votes.values()) {
      if (vote === 'yes') yes++;
      else no++;
    }
    return { number: pr.number, title: pr.title, currentSha: pr.currentSha, yesVotes: yes, noVotes: no, totalVotes: yes + no };
  });
  res.json({ activeAgents: 0, prs: tally });
});

app2.post('/sync-pr', (req, res) => {
  const { prNumber, sha } = req.body || {};
  if (typeof prNumber !== 'number' || typeof sha !== 'string') {
    return res.status(400).json({ error: 'prNumber (number) and sha (string) required' });
  }
  const pr = prs2.get(prNumber);
  if (!pr) return res.json({ status: 'unknown', wiped: false });
  if (sha === pr.currentSha) return res.json({ status: 'unchanged', wiped: false });
  pr.votes.clear();
  pr.currentSha = sha;
  pr.ciPassed = false;
  return res.json({ status: 'wiped', wiped: true });
});

const server2 = http.createServer(app2);

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request({ host: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject); req.write(payload); req.end();
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}

async function runTests() {
  const port = 3099;
  await new Promise(r => server2.listen(port, r));
  const base = `http://localhost:${port}`;
  let passed = 0, failed = 0;

  function assert(label, condition, got) {
    if (condition) { console.log(`  PASS: ${label}`); passed++; }
    else { console.error(`  FAIL: ${label} — got: ${JSON.stringify(got)}`); failed++; }
  }

  // Seed a PR with votes
  prs2.set(42, {
    number: 42, title: 'Test PR', url: 'http://example.com',
    currentSha: 'sha001', ciPassed: true,
    votes: new Map([['agent-a', 'yes'], ['agent-b', 'no']]),
  });

  console.log('\n--- Test 1: vote-tally returns currentSha ---');
  let tally = await getJSON(`${base}/vote-tally`);
  const pr42 = tally.prs.find(p => p.number === 42);
  assert('PR 42 present in tally', !!pr42, tally.prs);
  assert('currentSha is sha001', pr42?.currentSha === 'sha001', pr42?.currentSha);
  assert('yesVotes=1', pr42?.yesVotes === 1, pr42?.yesVotes);
  assert('noVotes=1', pr42?.noVotes === 1, pr42?.noVotes);

  console.log('\n--- Test 2: sync-pr with same SHA → unchanged, votes preserved ---');
  let sync = await postJSON(`${base}/sync-pr`, { prNumber: 42, sha: 'sha001' });
  assert('status=unchanged', sync.status === 'unchanged', sync);
  assert('wiped=false', sync.wiped === false, sync);
  tally = await getJSON(`${base}/vote-tally`);
  const pr42b = tally.prs.find(p => p.number === 42);
  assert('votes still present (2 total)', pr42b?.totalVotes === 2, pr42b?.totalVotes);

  console.log('\n--- Test 3: sync-pr with NEW SHA → wiped ---');
  sync = await postJSON(`${base}/sync-pr`, { prNumber: 42, sha: 'sha002' });
  assert('status=wiped', sync.status === 'wiped', sync);
  assert('wiped=true', sync.wiped === true, sync);

  tally = await getJSON(`${base}/vote-tally`);
  const pr42c = tally.prs.find(p => p.number === 42);
  assert('currentSha updated to sha002', pr42c?.currentSha === 'sha002', pr42c?.currentSha);
  assert('yesVotes=0 after wipe', pr42c?.yesVotes === 0, pr42c?.yesVotes);
  assert('noVotes=0 after wipe', pr42c?.noVotes === 0, pr42c?.noVotes);
  assert('totalVotes=0 after wipe', pr42c?.totalVotes === 0, pr42c?.totalVotes);

  console.log('\n--- Test 4: sync-pr for unknown PR → unknown, no error ---');
  sync = await postJSON(`${base}/sync-pr`, { prNumber: 999, sha: 'sha999' });
  assert('status=unknown', sync.status === 'unknown', sync);
  assert('wiped=false', sync.wiped === false, sync);

  console.log('\n--- Test 5: input validation ---');
  // Send string prNumber
  const badResp = await postJSON(`${base}/sync-pr`, { prNumber: 'not-a-number', sha: 'sha' });
  assert('returns 400 error for string prNumber', badResp.error?.includes('required'), badResp);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  server2.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('Unexpected error:', e); process.exit(1); });
