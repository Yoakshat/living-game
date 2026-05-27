/**
 * Multiplayer integration test — two browser contexts, Playwright.
 * Run with: node test-multiplayer.js
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import path from 'path';

const GAME_URL = 'http://localhost:5173/living-game/';
const SCREENSHOT_DIR = path.resolve('./test-screenshots');
const WAIT_FOR_GAME_MS = 5000; // time to let Phaser + Socket.io init

mkdirSync(SCREENSHOT_DIR, { recursive: true });

let passed = 0;
let failed = 0;
const findings = [];

function pass(label) {
  passed++;
  console.log(`  PASS  ${label}`);
}
function fail(label, detail) {
  failed++;
  findings.push({ label, detail });
  console.log(`  FAIL  ${label} — ${detail}`);
}

async function waitForGame(page, label) {
  try {
    await page.waitForFunction(
      () => window.__livingGame && window.__livingGame.playerPos,
      { timeout: WAIT_FOR_GAME_MS }
    );
    console.log(`  [OK] ${label}: game hook ready`);
    return true;
  } catch {
    console.log(`  [ERR] ${label}: game hook never appeared (Phaser may have failed to load)`);
    return false;
  }
}

async function waitForRemotePlayers(page, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = await page.evaluate(() => {
      if (!window.__livingGame) return 0;
      return window.__livingGame.remotePlayers().length;
    });
    if (n >= count) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function getRemotePlayers(page) {
  return page.evaluate(() => {
    if (!window.__livingGame) return [];
    return window.__livingGame.remotePlayers();
  });
}

async function getPlayerPos(page) {
  return page.evaluate(() => {
    if (!window.__livingGame) return null;
    return window.__livingGame.playerPos();
  });
}

async function getConsoleErrors(page) {
  return page._errors || [];
}

const browser = await chromium.launch({ headless: true });

const ctx1Errors = [];
const ctx2Errors = [];

// --- Context 1 ---
const context1 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page1 = await context1.newPage();
page1.on('console', msg => {
  if (msg.type() === 'error') ctx1Errors.push(msg.text());
});
page1.on('pageerror', err => ctx1Errors.push(err.message));

// --- Context 2 ---
const context2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page2 = await context2.newPage();
page2.on('console', msg => {
  if (msg.type() === 'error') ctx2Errors.push(msg.text());
});
page2.on('pageerror', err => ctx2Errors.push(err.message));

try {
  console.log('\n=== Loading Tab 1 ===');
  await page1.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
  const p1ready = await waitForGame(page1, 'Tab1');

  console.log('\n=== Loading Tab 2 ===');
  await page2.goto(GAME_URL, { waitUntil: 'domcontentloaded' });
  const p2ready = await waitForGame(page2, 'Tab2');

  if (!p1ready || !p2ready) {
    fail('Game loads in both tabs', 'Phaser/game hook did not appear within timeout');
    await page1.screenshot({ path: `${SCREENSHOT_DIR}/error-tab1-load.png` });
    await page2.screenshot({ path: `${SCREENSHOT_DIR}/error-tab2-load.png` });
    await browser.close();
    process.exit(1);
  }

  pass('Game loads in both tabs');

  // Wait a bit for socket connection + self:init
  await new Promise(r => setTimeout(r, 2000));

  // --- TEST: Each tab sees the other player ---
  console.log('\n=== Checking remote player visibility ===');
  const p1SeesRemotes = await waitForRemotePlayers(page1, 1, 4000);
  const p2SeesRemotes = await waitForRemotePlayers(page2, 1, 4000);

  if (p1SeesRemotes) pass('Tab1 sees Tab2\'s player');
  else fail('Tab1 sees Tab2\'s player', 'remotePlayers() returned 0 after 4s');

  if (p2SeesRemotes) pass('Tab2 sees Tab1\'s player');
  else fail('Tab2 sees Tab1\'s player', 'remotePlayers() returned 0 after 4s');

  await page1.screenshot({ path: `${SCREENSHOT_DIR}/01-both-connected-tab1.png` });
  await page2.screenshot({ path: `${SCREENSHOT_DIR}/02-both-connected-tab2.png` });
  console.log('  Screenshots: 01-both-connected-tab1.png, 02-both-connected-tab2.png');

  // --- TEST: Get self names / check identity data
  const selfName1 = await page1.evaluate(() => window.__livingGame?.scene?._selfName);
  const selfName2 = await page2.evaluate(() => window.__livingGame?.scene?._selfName);
  const selfColor1 = await page1.evaluate(() => window.__livingGame?.scene?._selfColor);
  const selfColor2 = await page2.evaluate(() => window.__livingGame?.scene?._selfColor);

  console.log(`\n  Tab1 identity: name="${selfName1}" color="${selfColor1}"`);
  console.log(`  Tab2 identity: name="${selfName2}" color="${selfColor2}"`);

  if (selfName1 && selfName2 && selfName1 !== selfName2) pass('Players have distinct names');
  else fail('Players have distinct names', `name1="${selfName1}" name2="${selfName2}"`);

  if (selfColor1 && selfColor2 && selfColor1 !== selfColor2) pass('Players have distinct colors');
  else fail('Players have distinct colors', `color1="${selfColor1}" color2="${selfColor2}"`);

  // --- TEST: Movement sync Tab1 → Tab2 ---
  console.log('\n=== Testing movement sync Tab1 → Tab2 ===');
  const remotesBefore = await getRemotePlayers(page2);
  const remotePosBeforeMove = remotesBefore[0] ? { x: remotesBefore[0].x, y: remotesBefore[0].y } : null;

  // Press D (right) in Tab1 for 1 second
  await page1.keyboard.down('KeyD');
  await new Promise(r => setTimeout(r, 1000));
  await page1.keyboard.up('KeyD');
  await new Promise(r => setTimeout(r, 500)); // let lerp settle

  const remotesAfter = await getRemotePlayers(page2);
  const remotePosAfterMove = remotesAfter[0] ? { x: remotesAfter[0].x, y: remotesAfter[0].y } : null;

  console.log(`  Remote pos in Tab2 before move: ${JSON.stringify(remotePosBeforeMove)}`);
  console.log(`  Remote pos in Tab2 after move:  ${JSON.stringify(remotePosAfterMove)}`);

  if (remotePosBeforeMove && remotePosAfterMove) {
    const dx = Math.abs(remotePosAfterMove.x - remotePosBeforeMove.x);
    if (dx > 10) pass(`Movement Tab1→Tab2 reflected (dx=${dx.toFixed(1)}px)`);
    else fail('Movement Tab1→Tab2 reflected', `Remote player barely moved: dx=${dx.toFixed(1)}px`);
  } else {
    fail('Movement Tab1→Tab2 reflected', 'Could not get remote player positions');
  }

  await page2.screenshot({ path: `${SCREENSHOT_DIR}/03-after-tab1-moved-tab2-view.png` });
  console.log('  Screenshot: 03-after-tab1-moved-tab2-view.png');

  // --- TEST: Movement sync Tab2 → Tab1 ---
  console.log('\n=== Testing movement sync Tab2 → Tab1 ===');
  const remotes1Before = await getRemotePlayers(page1);
  const remotePos1Before = remotes1Before[0] ? { x: remotes1Before[0].x, y: remotes1Before[0].y } : null;

  await page2.keyboard.down('KeyW');
  await new Promise(r => setTimeout(r, 1000));
  await page2.keyboard.up('KeyW');
  await new Promise(r => setTimeout(r, 500));

  const remotes1After = await getRemotePlayers(page1);
  const remotePos1After = remotes1After[0] ? { x: remotes1After[0].x, y: remotes1After[0].y } : null;

  console.log(`  Remote pos in Tab1 before move: ${JSON.stringify(remotePos1Before)}`);
  console.log(`  Remote pos in Tab1 after move:  ${JSON.stringify(remotePos1After)}`);

  if (remotePos1Before && remotePos1After) {
    const dy = Math.abs(remotePos1After.y - remotePos1Before.y);
    if (dy > 10) pass(`Movement Tab2→Tab1 reflected (dy=${dy.toFixed(1)}px)`);
    else fail('Movement Tab2→Tab1 reflected', `Remote player barely moved: dy=${dy.toFixed(1)}px`);
  } else {
    fail('Movement Tab2→Tab1 reflected', 'Could not get remote player positions');
  }

  await page1.screenshot({ path: `${SCREENSHOT_DIR}/04-after-tab2-moved-tab1-view.png` });
  console.log('  Screenshot: 04-after-tab2-moved-tab1-view.png');

  // --- Screenshot both at rest showing two players ---
  await page1.screenshot({ path: `${SCREENSHOT_DIR}/05-two-players-at-rest-tab1.png` });
  await page2.screenshot({ path: `${SCREENSHOT_DIR}/06-two-players-at-rest-tab2.png` });
  console.log('  Screenshots: 05-two-players-at-rest-tab1.png, 06-two-players-at-rest-tab2.png');

  // --- TEST: Disconnect removes character ---
  console.log('\n=== Testing disconnect cleanup ===');
  const remoteCountBefore = await page2.evaluate(() => window.__livingGame?.remotePlayers().length || 0);
  console.log(`  Remote players in Tab2 before Tab1 closes: ${remoteCountBefore}`);

  // Close context1 (disconnect)
  await context1.close();
  console.log('  Tab1 closed — waiting 3s...');
  await new Promise(r => setTimeout(r, 3000));

  const remoteCountAfter = await page2.evaluate(() => window.__livingGame?.remotePlayers().length || 0);
  console.log(`  Remote players in Tab2 after Tab1 closed: ${remoteCountAfter}`);

  if (remoteCountAfter === 0) pass('Disconnect removes character from Tab2');
  else fail('Disconnect removes character from Tab2', `Still ${remoteCountAfter} remote player(s) after Tab1 closed`);

  await page2.screenshot({ path: `${SCREENSHOT_DIR}/07-after-tab1-disconnect-tab2-view.png` });
  console.log('  Screenshot: 07-after-tab1-disconnect-tab2-view.png');

  // --- Console error check ---
  console.log('\n=== Console error check ===');
  const filteredCtx1 = ctx1Errors.filter(e =>
    !e.includes('favicon') &&
    !e.includes('net::ERR_') // ignore offline resource errors
  );
  const filteredCtx2 = ctx2Errors.filter(e =>
    !e.includes('favicon') &&
    !e.includes('net::ERR_')
  );

  if (filteredCtx1.length === 0) pass('Tab1 zero uncaught console errors');
  else fail('Tab1 zero uncaught console errors', `${filteredCtx1.length} error(s): ${filteredCtx1.slice(0, 3).join(' | ')}`);

  if (filteredCtx2.length === 0) pass('Tab2 zero uncaught console errors');
  else fail('Tab2 zero uncaught console errors', `${filteredCtx2.length} error(s): ${filteredCtx2.slice(0, 3).join(' | ')}`);

} catch (err) {
  console.error('\nUnexpected test error:', err);
  fail('Test execution', err.message);
  await page1.screenshot({ path: `${SCREENSHOT_DIR}/error-unexpected-tab1.png` }).catch(() => {});
  await page2.screenshot({ path: `${SCREENSHOT_DIR}/error-unexpected-tab2.png` }).catch(() => {});
}

await browser.close();

// --- Build check (run separately via shell) ---

console.log('\n=============================');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (findings.length > 0) {
  console.log('\nFAILURES:');
  for (const f of findings) {
    console.log(`  - ${f.label}: ${f.detail}`);
  }
}
console.log('=============================');
process.exit(failed > 0 ? 1 : 0);
