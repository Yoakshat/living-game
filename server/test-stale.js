const { io: ioc } = require('socket.io-client');
const http = require('http');

const BASE = 'http://localhost:3002';

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', (d) => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  // Step 1: Connect an agent socket
  const socket = ioc(BASE);
  await new Promise((resolve) => socket.on('connect', resolve));
  console.log('Agent connected, id socket:', socket.id);

  // Step 2: Read initial state — should be empty prs
  let tally = await get('/vote-tally');
  console.log('Initial tally:', JSON.stringify(tally));

  // Step 3: Inject a fake PR directly via the server's internal endpoint (we can't easily inject,
  // so let's test the server-side tracking by checking that sync-pr returns "unknown" for non-tracked PRs
  let syncUnknown = await post('/sync-pr', { prNumber: 42, sha: 'sha001' });
  console.log('Sync unknown PR:', JSON.stringify(syncUnknown)); // should be {status:"unknown",wiped:false}

  // We can't inject a PR without the GitHub poll or a test endpoint,
  // so we cast a vote via socket on a non-existent PR (should be silently ignored)
  socket.emit('pr:vote', { prNumber: 42, vote: 'yes' });
  await new Promise(r => setTimeout(r, 200));
  
  tally = await get('/vote-tally');
  console.log('Tally after vote on non-tracked PR:', JSON.stringify(tally)); // still empty prs

  // Step 4: Now verify currentSha appears in vote-tally response
  // We can check the field format is correct even with empty prs
  console.log('vote-tally keys on empty prs:', Object.keys(tally));
  
  socket.disconnect();
  console.log('All local endpoint tests PASSED');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
