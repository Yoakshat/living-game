import { chromium } from 'playwright';
import http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Action log — written to logs/agent-<timestamp>.log so crashes don't erase history.
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);
const logFile = path.join(logsDir, `agent-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}

const execFileAsync = promisify(execFile);

const PORT = parseInt(process.env.AGENT_PORT || '7979', 10);
const SERVER_URL = process.env.SERVER_URL || 'https://living-game-server-production.up.railway.app';

// Character name — set via CHARACTER_NAME env var or defaults to 'Wolf'.
const CHARACTER_NAME = process.env.CHARACTER_NAME || 'Wolf';

let githubUser = null;

// Resolve the GitHub username of the currently authenticated gh CLI user.
// GH_TOKEN env var (set by the TUI per-agent) is picked up automatically by gh.
async function resolveGithubUser() {
  try {
    const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], { timeout: 8000 });
    const username = stdout.trim();
    if (username) {
      log(`GitHub user: ${username}`);
      return username;
    }
  } catch {
    // gh not installed, not logged in, or command failed — that's fine
  }
  log('No GitHub user detected — connecting without identity');
  return null;
}

// Maps shorthand key names to Playwright key codes.
// Single lowercase letters map to their KeyX code; anything else is passed through as-is
// (e.g. "ArrowUp", "Space", "Enter", "Escape", "ShiftLeft" all work directly).
function resolveKey(k) {
  if (/^[a-z]$/.test(k)) return `Key${k.toUpperCase()}`;
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  return k; // already a Playwright key name
}

let browser = null;
let page = null;

async function init() {
  // Resolve GitHub identity before opening the browser
  githubUser = await resolveGithubUser();

  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  page = await context.newPage();

  let gameUrl = `https://yoakshat.github.io/living-game/?characterName=${encodeURIComponent(CHARACTER_NAME)}`;
  if (githubUser) {
    gameUrl += `&gh=${encodeURIComponent(githubUser)}`;
  }
  await page.goto(gameUrl);
  await page.waitForSelector('canvas', { timeout: 15000 });

  // Wait extra 2 seconds for Phaser to fully initialize
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Click the canvas once to give it keyboard focus
  const canvas = await page.$('canvas');
  await canvas.click();

  log(`Character: ${CHARACTER_NAME}`);
  log(`Game loaded — canvas is active`);
}

async function handleRequest(req, res) {
  const { method, url } = req;

  if (method === 'GET' && url === '/health') {
    const currentUrl = page ? page.url() : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', url: currentUrl }));
    return;
  }

  if (method === 'GET' && url === '/screenshot') {
    try {
      const buffer = await page.screenshot({ type: 'png' });
      log('screenshot');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buffer.length });
      res.end(buffer);
    } catch (err) {
      log(`screenshot ERROR: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (method === 'POST' && url === '/press') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { keys, duration } = JSON.parse(body);
        const mapped = keys.map((k) => resolveKey(k.toLowerCase()));
        log(`press [${keys.join('+')}] ${duration}ms`);
        await Promise.all(mapped.map((k) => page.keyboard.down(k)));
        await new Promise((resolve) => setTimeout(resolve, duration));
        await Promise.all(mapped.map((k) => page.keyboard.up(k)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log(`press ERROR: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Single keypress (no hold duration) — useful for menu navigation, confirmations
  if (method === 'POST' && url === '/tap') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { key } = JSON.parse(body);
        await page.keyboard.press(resolveKey(key.toLowerCase()));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Mouse click — for games with point-and-click or UI interactions
  if (method === 'POST' && url === '/click') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { x, y, button = 'left' } = JSON.parse(body);
        await page.mouse.click(x, y, { button });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Mouse drag — for RTS unit selection boxes, drag-and-drop, etc.
  if (method === 'POST' && url === '/drag') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { fromX, fromY, toX, toY, duration = 300 } = JSON.parse(body);
        await page.mouse.move(fromX, fromY);
        await page.mouse.down();
        await page.mouse.move(toX, toY, { steps: Math.max(10, Math.floor(duration / 16)) });
        await new Promise((resolve) => setTimeout(resolve, duration));
        await page.mouse.up();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Returns PRs this agent hasn't voted on yet, fetched directly from the game server
  if (method === 'GET' && url === '/pending-votes') {
    try {
      if (!githubUser) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      const response = await fetch(`${SERVER_URL}/unvoted-prs?gh=${encodeURIComponent(githubUser)}`);
      const data = await response.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Cast a vote on a PR: { pr: number, vote: 'yes' | 'no' }
  if (method === 'POST' && url === '/cast-vote') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { pr, vote } = JSON.parse(body);
        log(`cast-vote PR#${pr} → ${vote}`);
        await page.evaluate(({ pr, vote }) => window.__livingGame.castVote(pr, vote), { pr, vote });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log(`cast-vote ERROR: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (method === 'POST' && url === '/quit') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    await cleanup();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

async function cleanup() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
  process.exit(0);
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

const server = http.createServer(handleRequest);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`PORT ${PORT} already in use — retrying in 3s`);
    setTimeout(() => server.listen(PORT), 3000);
  } else {
    log(`SERVER ERROR: ${err.message}`);
    process.exit(1);
  }
});

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
  process.exit(1);
});

// Initialize browser then start listening
init()
  .then(() => {
    server.listen(PORT, () => {
      log(`Agent server ready at http://localhost:${PORT} — log: ${logFile}`);
    });
  })
  .catch((err) => {
    log(`INIT FAILED: ${err.stack || err.message}`);
    process.exit(1);
  });
