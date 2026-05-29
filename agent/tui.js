/**
 * Living Game — Multi-Agent Manager TUI
 * Run: npm run tui  (from agent/ directory)
 *
 * Three panels:
 *   Left   (~35%) — Agent roster with status indicators
 *   Middle (~40%) — Agent config (personality + directives)
 *   Right  (~25%) — Leaderboard (fetches /leaderboard every 30s)
 *
 * Storage: agent/agents/<slug>/character.md + pid
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);
const blessed = require('blessed');

// ── paths ────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, 'agents');
const SERVER_URL =
  process.env.SERVER_URL ||
  'https://living-game-server-production.up.railway.app';

// ── personality presets ──────────────────────────────────────────────────────
const PRESETS = {
  Diplomat: `A careful negotiator who speaks softly and thinks in alliances.\nAlways weighs the consequences before acting, preferring to resolve\nconflict through dialogue and clever positioning.`,
  Explorer: `A lone explorer driven by restless curiosity. Never stays in one place long.\nDrawn to open spaces and the edges of the world. Cautious around obstacles\nbut bold when the path is clear.`,
  Builder: `A tireless craftsperson obsessed with leaving the world better than they found it.\nSees potential in every empty patch of land and empty slot in the game world.\nAlways planning the next structure or improvement.`,
  Schemer: `A cunning opportunist who plays the long game. Rarely acts without\na hidden motive. Watches others carefully, waits for the right moment,\nand strikes when the odds are overwhelmingly favorable.`,
};

const PRESET_NAMES = Object.keys(PRESETS);

// ── agent storage helpers ────────────────────────────────────────────────────
function ensureAgentsDir() {
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function agentDir(slug) {
  return path.join(AGENTS_DIR, slug);
}

function characterPath(slug) {
  return path.join(agentDir(slug), 'character.md');
}

function pidPath(slug) {
  return path.join(agentDir(slug), 'pid');
}

function portFilePath(slug) {
  return path.join(agentDir(slug), 'port');
}

function readPort(slug) {
  const p = portFilePath(slug);
  if (!fs.existsSync(p)) return null;
  const n = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
  return isNaN(n) ? null : n;
}

function assignPort() {
  const used = new Set();
  if (fs.existsSync(AGENTS_DIR)) {
    for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = readPort(entry.name);
      if (p !== null) used.add(p);
    }
  }
  let port = 7979;
  while (used.has(port)) port++;
  return port;
}

function defaultCharacterMd(name) {
  return `# Character: ${name}\n\n## Personality\n${PRESETS.Explorer}\n\n## Directives\n`;
}

function readCharacterMd(slug) {
  const p = characterPath(slug);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function writeCharacterMd(slug, md) {
  fs.writeFileSync(characterPath(slug), md, 'utf8');
}

function parseName(md) {
  const m = md.match(/^#\s+Character:\s*(.+)/m);
  return m ? m[1].trim() : 'Unknown';
}

function parseSection(md, header) {
  const re = new RegExp(`##\\s+${header}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

function updateSection(md, header, newContent) {
  const re = new RegExp(`(##\\s+${header}\\s*\\n)[\\s\\S]*?(?=\\n##\\s|$)`);
  const replacement = `$1${newContent}\n`;
  if (re.test(md)) {
    return md.replace(re, replacement);
  }
  return md.trimEnd() + `\n\n## ${header}\n${newContent}\n`;
}

function parseDirectives(md) {
  const section = parseSection(md, 'Directives');
  if (!section) return [];
  return section
    .split('\n')
    .map((l) => l.replace(/^[-*\d.]+\s*/, '').trim())
    .filter(Boolean);
}

function directivesToMarkdown(list) {
  return list.map((d) => `- ${d}`).join('\n');
}

// ── PID helpers ──────────────────────────────────────────────────────────────
function readPid(slug) {
  const p = pidPath(slug);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim();
  const n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

function writePid(slug, pid) {
  fs.writeFileSync(pidPath(slug), String(pid), 'utf8');
}

function deletePid(slug) {
  const p = pidPath(slug);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── agent scanning ───────────────────────────────────────────────────────────
function scanAgents() {
  ensureAgentsDir();
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  const agents = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const md = readCharacterMd(slug);
    if (!md) continue;

    const name = parseName(md);

    // Check PID staleness on startup
    const pid = readPid(slug);
    let running = false;
    if (pid !== null) {
      if (isProcessAlive(pid)) {
        running = true;
      } else {
        deletePid(slug);
      }
    }

    agents.push({ slug, name, running });
  }

  return agents.sort((a, b) => a.slug.localeCompare(b.slug));
}

// ── leaderboard fetch ────────────────────────────────────────────────────────
async function fetchLeaderboard() {
  try {
    const res = await fetch(`${SERVER_URL}/leaderboard`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return { players: data };
  } catch {
    return { error: 'Server offline' };
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  ensureAgentsDir();

  // ── mutable state ─────────────────────────────────────────────────────────
  let agents = scanAgents();
  let selectedIdx = 0;
  let focusPanel = 'roster'; // 'roster' | 'config'
  let configFocus = 'personality'; // 'personality' | 'directives'

  // Per-selected-agent state (reloaded when selection changes)
  let currentMd = '';
  let currentPersonality = '';
  let directives = [];

  // ── screen ────────────────────────────────────────────────────────────────
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Living Game — Multi-Agent Manager',
  });

  // ── header ────────────────────────────────────────────────────────────────
  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content:
      '{bold}{cyan-fg} Living Game  ·  Multi-Agent Manager{/cyan-fg}{/bold}',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, bg: 'black' },
  });

  // ── left panel — roster ───────────────────────────────────────────────────
  const rosterBox = blessed.box({
    top: 3,
    left: 0,
    width: '35%',
    bottom: 3,
    label: ' {bold}Agents{/bold} ',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, label: { fg: 'cyan' } },
  });

  const rosterList = blessed.list({
    parent: rosterBox,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-3',
    keys: true,
    mouse: true,
    vi: false,
    items: [],
    style: {
      selected: { bg: 'cyan', fg: 'black', bold: true },
      item: { fg: 'white' },
    },
  });

  const rosterHint = blessed.box({
    parent: rosterBox,
    bottom: 0,
    left: 0,
    width: '100%-2',
    height: 1,
    content: ' [n] new  [del] delete  [s] start  [x] stop',
    style: { fg: 'blue' },
    tags: false,
  });

  // ── middle panel — config ─────────────────────────────────────────────────
  const configBox = blessed.box({
    top: 3,
    left: '35%',
    width: '40%',
    bottom: 3,
    label: ' {bold}Config{/bold} ',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'yellow' }, label: { fg: 'yellow' } },
  });

  // Agent name + status at top of config panel
  const agentNameBox = blessed.box({
    parent: configBox,
    top: 0,
    left: 0,
    width: '100%-2',
    height: 2,
    content: '',
    tags: true,
    style: { fg: 'white' },
  });

  // Personality section label
  const personalityLabel = blessed.box({
    parent: configBox,
    top: 2,
    left: 0,
    width: '100%-2',
    height: 1,
    content: ' {yellow-fg}{bold}Personality{/bold}{/yellow-fg}  [r] rename',
    tags: true,
  });

  const presetList = blessed.list({
    parent: configBox,
    top: 3,
    left: 0,
    width: '100%-2',
    height: PRESET_NAMES.length + 2, // presets + Custom row
    items: [],
    keys: true,
    mouse: true,
    vi: false,
    style: {
      selected: { bg: 'yellow', fg: 'black', bold: true },
      item: { fg: 'white' },
    },
  });

  const personalityPreview = blessed.box({
    parent: configBox,
    top: 3 + PRESET_NAMES.length + 2,
    left: 0,
    width: '100%-2',
    height: 3,
    content: '',
    tags: false,
    scrollable: true,
    style: { fg: 'gray' },
  });

  const personalityHint = blessed.box({
    parent: configBox,
    top: 3 + PRESET_NAMES.length + 2 + 3,
    left: 0,
    width: '100%-2',
    height: 1,
    content: ' [↑↓] select  [Enter] apply  [e] custom',
    style: { fg: 'blue' },
    tags: false,
  });

  // Directives section
  const directivesLabel = blessed.box({
    parent: configBox,
    top: 3 + PRESET_NAMES.length + 2 + 3 + 1,
    left: 0,
    width: '100%-2',
    height: 1,
    content: ' {green-fg}{bold}Directives{/bold}{/green-fg}',
    tags: true,
  });

  const directivesList = blessed.list({
    parent: configBox,
    top: 3 + PRESET_NAMES.length + 2 + 3 + 1 + 1,
    left: 0,
    width: '100%-2',
    height: 4,
    keys: true,
    mouse: true,
    vi: false,
    items: [],
    style: {
      selected: { bg: 'green', fg: 'black', bold: true },
      item: { fg: 'white' },
    },
  });

  const directivesHint = blessed.box({
    parent: configBox,
    bottom: 0,
    left: 0,
    width: '100%-2',
    height: 1,
    content: ' [a] add  [d] delete  [e] edit  [↑↓] navigate',
    style: { fg: 'blue' },
    tags: false,
  });

  // ── right panel — leaderboard ─────────────────────────────────────────────
  const leaderboardBox = blessed.box({
    top: 3,
    left: '75%',
    right: 0,
    bottom: 3,
    label: ' {bold}Leaderboard{/bold} ',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'magenta' }, label: { fg: 'magenta' } },
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
    padding: { left: 1, right: 1 },
  });

  // ── footer ────────────────────────────────────────────────────────────────
  const footer = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    content:
      ' {bold}[s]{/bold} start  {bold}[x]{/bold} stop  {bold}[n]{/bold} new  {bold}[del]{/bold} delete  {bold}[Tab]{/bold} switch panel  {bold}[r]{/bold} refresh lb  {bold}[q]{/bold} quit',
    tags: true,
    border: { type: 'line' },
    style: { border: { fg: 'gray' }, fg: 'white' },
  });

  screen.append(header);
  screen.append(rosterBox);
  screen.append(configBox);
  screen.append(leaderboardBox);
  screen.append(footer);

  // ── prompt helper ─────────────────────────────────────────────────────────
  function prompt(label, prefill, cb) {
    const dialog = blessed.prompt({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 8,
      border: { type: 'line' },
      style: { border: { fg: 'white' }, label: { fg: 'white' } },
      label: ` ${label} `,
    });
    dialog.input(prefill || '', (err, value) => {
      dialog.destroy();
      screen.render();
      if (!err && value !== null) cb(value.trim());
    });
    screen.render();
  }

  // ── roster helpers ────────────────────────────────────────────────────────
  function refreshRoster() {
    if (agents.length === 0) {
      rosterList.setItems([' (no agents — press n)']);
    } else {
      const items = agents.map((a) => {
        const dot = a.running ? '● ' : '○ ';
        return ` ${dot}${a.name}`;
      });
      rosterList.setItems(items);
    }
    if (selectedIdx >= agents.length) {
      selectedIdx = Math.max(0, agents.length - 1);
    }
    if (agents.length > 0) rosterList.select(selectedIdx);
    screen.render();
  }

  // ── config helpers ────────────────────────────────────────────────────────
  function loadSelectedAgent() {
    if (agents.length === 0) {
      agentNameBox.setContent(' {gray-fg}No agents — press [n] to create one{/gray-fg}');
      presetList.setItems([]);
      personalityPreview.setContent('');
      directivesList.setItems([]);
      screen.render();
      return;
    }

    const agent = agents[selectedIdx];
    const md = readCharacterMd(agent.slug);
    if (!md) return;

    currentMd = md;
    currentPersonality = parseSection(md, 'Personality') || '';
    directives = parseDirectives(md);

    const statusStr = agent.running
      ? '{green-fg}● Running{/green-fg}'
      : '{gray-fg}○ Stopped{/gray-fg}';
    agentNameBox.setContent(` {bold}${agent.name}{/bold}   ${statusStr}`);

    refreshPresetList();
    refreshDirectivesList();
    screen.render();
  }

  function findPresetIndex() {
    for (let i = 0; i < PRESET_NAMES.length; i++) {
      if (currentPersonality.trim() === PRESETS[PRESET_NAMES[i]].trim()) {
        return i;
      }
    }
    return -1;
  }

  function refreshPresetList() {
    const idx = findPresetIndex();
    const items = PRESET_NAMES.map((n, i) => {
      const marker = i === idx ? '✓ ' : '  ';
      return `${marker}${n}`;
    });
    items.push(idx === -1 ? '✓ Custom' : '  Custom');
    presetList.setItems(items);
    if (idx >= 0) presetList.select(idx);
    else presetList.select(PRESET_NAMES.length);
    // Show first 3 lines of personality as preview
    personalityPreview.setContent(
      currentPersonality.split('\n').slice(0, 3).join('\n'),
    );
    screen.render();
  }

  function applyPreset(name) {
    if (name === 'Custom') return;
    const text = PRESETS[name];
    if (!text) return;
    currentPersonality = text;
    savePersonality();
    refreshPresetList();
  }

  function savePersonality() {
    if (agents.length === 0) return;
    const agent = agents[selectedIdx];
    currentMd = updateSection(currentMd, 'Personality', currentPersonality);
    writeCharacterMd(agent.slug, currentMd);
  }

  function refreshDirectivesList() {
    const items = directives.length
      ? directives.map((d, i) => ` ${i + 1}. ${d}`)
      : [' (none — press a to add)'];
    directivesList.setItems(items);
    screen.render();
  }

  function saveDirectives() {
    if (agents.length === 0) return;
    const agent = agents[selectedIdx];
    currentMd = updateSection(
      currentMd,
      'Directives',
      directivesToMarkdown(directives),
    );
    writeCharacterMd(agent.slug, currentMd);
  }

  // ── focus helpers ─────────────────────────────────────────────────────────
  function setFocusPanel(panel) {
    focusPanel = panel;
    rosterBox.style.border.fg = panel === 'roster' ? 'cyan' : 'gray';
    configBox.style.border.fg = panel === 'config' ? 'yellow' : 'gray';
    if (panel === 'roster') {
      rosterList.focus();
    } else {
      if (configFocus === 'personality') presetList.focus();
      else directivesList.focus();
    }
    screen.render();
  }

  function setConfigFocus(sub) {
    configFocus = sub;
    focusPanel = 'config';
    configBox.style.border.fg = 'yellow';
    rosterBox.style.border.fg = 'gray';
    if (sub === 'personality') presetList.focus();
    else directivesList.focus();
    screen.render();
  }

  // ── leaderboard helpers ───────────────────────────────────────────────────
  let lbLastUpdated = null;

  function renderLeaderboard(result) {
    lbLastUpdated = new Date().toLocaleTimeString();
    let content = '';

    if (result.error) {
      content = `\n {red-fg}${result.error}{/red-fg}\n\n Refresh with [r]`;
    } else if (!result.players || result.players.length === 0) {
      content = '\n {gray-fg}No data yet{/gray-fg}\n\n Refresh with [r]';
    } else {
      const sorted = [...result.players].sort((a, b) => {
        const score = (p) => (p.prsmerged || 0) * 3 + (p.worldChanges || 0);
        return score(b) - score(a);
      });

      const hdr =
        ' Rank  Name           PRs   Changes\n' +
        ' ────  ─────────────  ───   ───────';
      content = '\n' + hdr + '\n';

      sorted.forEach((p, i) => {
        const rank = String(i + 1).padEnd(4);
        const name = (p.displayName || p.name || '?').slice(0, 13).padEnd(14);
        const prs = String(p.prsmerged || 0).padEnd(6);
        const wc = String(p.worldChanges || 0);
        const colorDot = p.color ? `{${p.color}-fg}●{/${p.color}-fg}` : ' ';
        content += ` ${rank} ${colorDot} ${name} ${prs}  ${wc}\n`;
      });
    }

    content += `\n\n {gray-fg}Updated: ${lbLastUpdated}{/gray-fg}`;
    leaderboardBox.tags = true;
    leaderboardBox.setContent(content);
    screen.render();
  }

  async function refreshLeaderboard() {
    leaderboardBox.tags = true;
    leaderboardBox.setContent('\n {yellow-fg}Loading…{/yellow-fg}');
    screen.render();
    const result = await fetchLeaderboard();
    renderLeaderboard(result);
  }

  // ── agent operations ──────────────────────────────────────────────────────
  function createAgent(name) {
    const slug = slugify(name);
    if (!slug) return;
    const dir = agentDir(slug);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      writeCharacterMd(slug, defaultCharacterMd(name));
      fs.writeFileSync(portFilePath(slug), String(assignPort()), 'utf8');
    }
    agents = scanAgents();
    const newIdx = agents.findIndex((a) => a.slug === slug);
    selectedIdx = newIdx >= 0 ? newIdx : 0;
    refreshRoster();
    loadSelectedAgent();
  }

  function deleteAgent() {
    if (agents.length === 0) return;
    const agent = agents[selectedIdx];

    // Stop first if running
    if (agent.running) {
      stopAgent(agent.slug);
    }

    prompt(`Delete ${agent.name}? [y/N]`, '', (val) => {
      if (val.toLowerCase() !== 'y') return;
      fs.rmSync(agentDir(agent.slug), { recursive: true, force: true });
      agents = scanAgents();
      selectedIdx = Math.min(selectedIdx, Math.max(0, agents.length - 1));
      refreshRoster();
      loadSelectedAgent();
    });
  }

  function startAgent(slug) {
    // Already running?
    const existingPid = readPid(slug);
    if (existingPid !== null && isProcessAlive(existingPid)) return;

    const dir = agentDir(slug);
    const startScript = path.join(__dirname, 'start.sh');
    const child = spawn('bash', [startScript], {
      cwd: dir,
      detached: true,  // makes bash a session leader so we can kill the group
      stdio: 'ignore',
    });
    child.unref();
    writePid(slug, child.pid);

    const agentEntry = agents.find((a) => a.slug === slug);
    if (agentEntry) agentEntry.running = true;
    refreshRoster();
    loadSelectedAgent();
  }

  function stopAgent(slug) {
    const pid = readPid(slug);
    if (pid === null) return;
    try {
      // Kill the entire process group (negative PID) so the bash wrapper
      // and any running claude child both get the signal
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Already dead — that's fine
    }
    deletePid(slug);

    const agentEntry = agents.find((a) => a.slug === slug);
    if (agentEntry) agentEntry.running = false;
    refreshRoster();
    loadSelectedAgent();
  }

  function renameAgent() {
    if (agents.length === 0) return;
    const agent = agents[selectedIdx];
    prompt('New name', agent.name, (val) => {
      if (!val || val === agent.name) return;
      let md = readCharacterMd(agent.slug);
      if (!md) return;
      md = md.replace(/^#\s+Character:\s*.+/m, `# Character: ${val}`);
      writeCharacterMd(agent.slug, md);
      agents = scanAgents();
      const newIdx = agents.findIndex((a) => a.slug === agent.slug);
      selectedIdx = newIdx >= 0 ? newIdx : 0;
      refreshRoster();
      loadSelectedAgent();
    });
  }

  // ── key bindings — global ─────────────────────────────────────────────────
  screen.key(['q', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.key(['tab'], () => {
    if (focusPanel === 'roster') setFocusPanel('config');
    else setFocusPanel('roster');
  });

  screen.key(['r'], () => refreshLeaderboard());

  screen.key(['s'], () => {
    if (agents.length === 0) return;
    startAgent(agents[selectedIdx].slug);
  });

  screen.key(['x'], () => {
    if (agents.length === 0) return;
    stopAgent(agents[selectedIdx].slug);
  });

  screen.key(['n'], () => {
    prompt('Agent name', '', (val) => {
      if (val) createAgent(val);
    });
  });

  screen.key(['delete', 'backspace'], () => deleteAgent());

  // ── key bindings — roster list ─────────────────────────────────────────────
  rosterList.key(['up', 'k'], () => {
    setImmediate(() => {
      const idx = rosterList.selected;
      if (idx !== selectedIdx && idx < agents.length) {
        selectedIdx = idx;
        loadSelectedAgent();
      }
    });
  });

  rosterList.key(['down', 'j'], () => {
    setImmediate(() => {
      const idx = rosterList.selected;
      if (idx !== selectedIdx && idx < agents.length) {
        selectedIdx = idx;
        loadSelectedAgent();
      }
    });
  });

  rosterList.on('select', (item, index) => {
    if (index < agents.length) {
      selectedIdx = index;
      loadSelectedAgent();
    }
  });

  rosterList.key(['tab'], () => setFocusPanel('config'));
  rosterList.key(['n'], () => {
    prompt('Agent name', '', (val) => {
      if (val) createAgent(val);
    });
  });
  rosterList.key(['delete', 'backspace'], () => deleteAgent());
  rosterList.key(['s'], () => {
    if (agents.length > 0) startAgent(agents[selectedIdx].slug);
  });
  rosterList.key(['x'], () => {
    if (agents.length > 0) stopAgent(agents[selectedIdx].slug);
  });

  // ── key bindings — preset list (personality) ───────────────────────────────
  presetList.key(['enter'], () => {
    if (agents.length === 0) return;
    const sel = presetList.selected;
    const name = sel < PRESET_NAMES.length ? PRESET_NAMES[sel] : 'Custom';
    if (name === 'Custom') {
      prompt('Custom personality', currentPersonality, (val) => {
        if (val) {
          currentPersonality = val;
          savePersonality();
          refreshPresetList();
        }
      });
    } else {
      applyPreset(name);
    }
  });

  presetList.key(['e'], () => {
    if (agents.length === 0) return;
    prompt('Custom personality', currentPersonality, (val) => {
      if (val) {
        currentPersonality = val;
        savePersonality();
        refreshPresetList();
      }
    });
  });

  presetList.key(['r'], () => renameAgent());
  presetList.key(['tab'], () => setConfigFocus('directives'));

  // ── key bindings — directives list ────────────────────────────────────────
  directivesList.key(['a'], () => {
    if (agents.length === 0) return;
    if (directives.length >= 3) {
      directivesHint.setContent(' {red-fg}Max 3 directives{/red-fg}');
      directivesHint.tags = true;
      screen.render();
      setTimeout(() => {
        directivesHint.tags = false;
        directivesHint.setContent(
          ' [a] add  [d] delete  [e] edit  [↑↓] navigate',
        );
        screen.render();
      }, 2000);
      return;
    }
    prompt('New directive', '', (val) => {
      if (val) {
        directives.push(val);
        saveDirectives();
        refreshDirectivesList();
      }
    });
  });

  directivesList.key(['d'], () => {
    if (agents.length === 0 || directives.length === 0) return;
    const sel = directivesList.selected;
    if (sel >= directives.length) return;
    directives.splice(sel, 1);
    saveDirectives();
    refreshDirectivesList();
  });

  directivesList.key(['e'], () => {
    if (agents.length === 0 || directives.length === 0) return;
    const sel = directivesList.selected;
    if (sel >= directives.length) return;
    prompt('Edit directive', directives[sel], (val) => {
      if (val) {
        directives[sel] = val;
        saveDirectives();
        refreshDirectivesList();
      }
    });
  });

  directivesList.key(['r'], () => renameAgent());
  directivesList.key(['tab'], () => setConfigFocus('personality'));

  // ── initial render ────────────────────────────────────────────────────────
  refreshRoster();
  loadSelectedAgent();
  setFocusPanel('roster');

  refreshLeaderboard();
  const lbInterval = setInterval(refreshLeaderboard, 30_000);
  screen.on('destroy', () => clearInterval(lbInterval));
  screen.render();
}

main();
