import { chromium } from 'playwright';
import http from 'http';

const PORT = 7979;

const KEY_MAP = {
  w: 'KeyW',
  a: 'KeyA',
  s: 'KeyS',
  d: 'KeyD',
};

let browser = null;
let page = null;

async function init() {
  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  page = await context.newPage();

  await page.goto('https://yoakshat.github.io/living-game/');
  await page.waitForSelector('canvas', { timeout: 15000 });

  // Wait extra 2 seconds for Phaser to fully initialize
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Click the canvas once to give it keyboard focus
  const canvas = await page.$('canvas');
  await canvas.click();

  console.log('Game loaded — canvas is active');
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
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buffer.length });
      res.end(buffer);
    } catch (err) {
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
        const mappedKeys = keys.map((k) => KEY_MAP[k.toLowerCase()] || k);

        // Press all keys simultaneously
        await Promise.all(mappedKeys.map((k) => page.keyboard.down(k)));

        // Hold for duration ms
        await new Promise((resolve) => setTimeout(resolve, duration));

        // Release all keys
        await Promise.all(mappedKeys.map((k) => page.keyboard.up(k)));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
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

// Initialize browser then start listening
init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Agent server ready at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize browser:', err);
    process.exit(1);
  });
