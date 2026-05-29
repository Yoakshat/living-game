/**
 * Living Game — Personality TUI
 * Run: npm run tui  (from agent/ directory)
 *
 * Three panels:
 *   Personality  (top-left)   — presets + custom edit
 *   Directives   (bottom-left)— up to 3 strategic goals
 *   Leaderboard  (right)      — fetches /leaderboard every 30 s
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const blessed = require('blessed');

// ── paths ────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHARACTER_MD = path.join(__dirname, 'character.md');
const SERVER_URL = process.env.SERVER_URL ||
  'https://living-game-server-production.up.railway.app';

// ── personality presets ──────────────────────────────────────────────────────
const PRESETS = {
  Diplomat: `A careful negotiator who speaks softly and thinks in alliances.\nAlways weighs the consequences before acting, preferring to resolve\nconflict through dialogue and clever positioning.`,
  Explorer: `A lone explorer driven by restless curiosity. Never stays in one place long.\nDrawn to open spaces and the edges of the world. Cautious around obstacles\nbut bold when the path is clear.`,
  Builder: `A tireless craftsperson obsessed with leaving the world better than they found it.\nSees potential in every empty patch of land and empty slot in the game world.\nAlways planning the next structure or improvement.`,
  Schemer: `A cunning opportunist who plays the long game. Rarely acts without\na hidden motive. Watches others carefully, waits for the right moment,\nand strikes when the odds are overwhelmingly favorable.`,
};

const PRESET_NAMES = Object.keys(PRESETS);

// ── character.md helpers ─────────────────────────────────────────────────────
function readCharacter() {
  if (!fs.existsSync(CHARACTER_MD)) {
    return null;
  }
  return fs.readFileSync(CHARACTER_MD, 'utf8');
}

function parseName(md) {
  const m = md.match(/^#\s+Character:\s*(.+)/m);
  return m ? m[1].trim() : 'Unknown';
}

function parseSection(md, header) {
  // Matches ## header up to next ## or end
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
  // Section doesn't exist — append it
  return md.trimEnd() + `\n\n## ${header}\n${newContent}\n`;
}

function writeCharacter(md) {
  fs.writeFileSync(CHARACTER_MD, md, 'utf8');
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

// ── leaderboard fetch ────────────────────────────────────────────────────────
async function fetchLeaderboard() {
  try {
    const res = await fetch(`${SERVER_URL}/leaderboard`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return { players: data };
  } catch (err) {
    return { error: 'Server offline' };
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const rawMd = readCharacter();
  if (!rawMd) {
    process.stderr.write(`Error: character.md not found at ${CHARACTER_MD}\n`);
    process.exit(1);
  }

  let md = rawMd;
  const charName = parseName(md);

  // Ensure ## Directives section exists
  if (!parseSection(md, 'Directives')) {
    md = updateSection(md, 'Directives', '');
    writeCharacter(md);
  }

  // ── screen ────────────────────────────────────────────────────────────────
  const screen = blessed.screen({
    smartCSR: true,
    title: `Living Game — ${charName}`,
  });

  // ── header ────────────────────────────────────────────────────────────────
  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: `{bold}{cyan-fg} Living Game  ·  Character: ${charName}{/cyan-fg}{/bold}`,
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      bg: 'black',
    },
  });

  // ── left column ───────────────────────────────────────────────────────────
  const leftWidth = '40%';
  const topHeight = '50%';

  // Personality box
  const personalityBox = blessed.box({
    top: 3,
    left: 0,
    width: leftWidth,
    height: topHeight,
    label: ' {bold}Personality{/bold} ',
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      label: { fg: 'yellow' },
    },
    scrollable: false,
    padding: { left: 1, right: 1 },
  });

  // Preset list inside personality box
  const presetList = blessed.list({
    parent: personalityBox,
    top: 0,
    left: 0,
    width: '100%-2',
    height: PRESET_NAMES.length + 1,
    items: PRESET_NAMES.map((n) => ` ${n}`),
    keys: true,
    mouse: true,
    vi: false,
    style: {
      selected: { bg: 'yellow', fg: 'black', bold: true },
      item: { fg: 'white' },
    },
  });

  const personalityPreview = blessed.box({
    parent: personalityBox,
    top: PRESET_NAMES.length + 1,
    left: 0,
    width: '100%-2',
    height: '100%-' + (PRESET_NAMES.length + 2),
    content: '',
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    style: { fg: 'gray' },
  });

  const personalityHint = blessed.box({
    parent: personalityBox,
    bottom: 0,
    left: 0,
    width: '100%-2',
    height: 1,
    content: ' [↑↓] select  [Enter] apply  [e] custom',
    style: { fg: 'blue' },
    tags: false,
  });

  // Directives box
  const directivesBox = blessed.box({
    top: 3 + topHeight,
    left: 0,
    width: leftWidth,
    bottom: 2,
    label: ' {bold}Directives{/bold} ',
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      label: { fg: 'green' },
    },
  });

  const directivesList = blessed.list({
    parent: directivesBox,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-3',
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
    parent: directivesBox,
    bottom: 0,
    left: 0,
    width: '100%-2',
    height: 1,
    content: ' [a] add  [d] delete  [e] edit  [↑↓] navigate',
    style: { fg: 'blue' },
    tags: false,
  });

  // ── right column — leaderboard ─────────────────────────────────────────────
  const leaderboardBox = blessed.box({
    top: 3,
    left: leftWidth,
    right: 0,
    bottom: 2,
    label: ' {bold}Leaderboard{/bold} ',
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'magenta' },
      label: { fg: 'magenta' },
    },
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
    height: 2,
    content:
      ' {bold}[Tab]{/bold} switch panel   {bold}[q/{ctrl+c}]{/bold} quit   {bold}[r]{/bold} refresh leaderboard',
    tags: true,
    border: { type: 'line' },
    style: {
      border: { fg: 'gray' },
      fg: 'white',
    },
  });

  screen.append(header);
  screen.append(personalityBox);
  screen.append(directivesBox);
  screen.append(leaderboardBox);
  screen.append(footer);

  // ── state ─────────────────────────────────────────────────────────────────
  let focus = 'personality'; // 'personality' | 'directives'
  let directives = parseDirectives(md);
  let currentPersonality = parseSection(md, 'Personality') || '';

  // Find which preset matches current personality (if any)
  function findPresetIndex() {
    for (let i = 0; i < PRESET_NAMES.length; i++) {
      if (currentPersonality.trim() === PRESETS[PRESET_NAMES[i]].trim()) {
        return i;
      }
    }
    return -1; // custom
  }

  // ── personality helpers ───────────────────────────────────────────────────
  function refreshPresetList() {
    const idx = findPresetIndex();
    const items = PRESET_NAMES.map((n, i) => {
      const marker = i === idx ? '✓ ' : '  ';
      return `${marker}${n}`;
    });
    items.push(findPresetIndex() === -1 ? '✓ Custom' : '  Custom');
    presetList.setItems(items);
    if (idx >= 0) presetList.select(idx);
    else presetList.select(PRESET_NAMES.length);
    personalityPreview.setContent(currentPersonality);
    screen.render();
  }

  function applyPreset(name) {
    if (name === 'Custom') return; // enter edit mode instead
    const text = PRESETS[name];
    if (!text) return;
    currentPersonality = text;
    md = updateSection(md, 'Personality', currentPersonality);
    writeCharacter(md);
    personalityPreview.setContent(currentPersonality);
    screen.render();
  }

  // ── directives helpers ────────────────────────────────────────────────────
  function refreshDirectivesList() {
    const items = directives.length
      ? directives.map((d, i) => ` ${i + 1}. ${d}`)
      : [' (none — press a to add)'];
    directivesList.setItems(items);
    screen.render();
  }

  function saveDirectives() {
    md = updateSection(md, 'Directives', directivesToMarkdown(directives));
    writeCharacter(md);
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

      const colW = { rank: 4, name: 14, color: 3, prs: 6, wc: 8 };
      const header2 =
        ' Rank  Name           PRs   Changes\n' +
        ' ────  ─────────────  ───   ───────';
      content = '\n' + header2 + '\n';

      sorted.forEach((p, i) => {
        const rank = String(i + 1).padEnd(colW.rank);
        const name = (p.name || '?').slice(0, 13).padEnd(colW.name);
        const prs = String(p.prsmerged || 0).padEnd(colW.prs);
        const wc = String(p.worldChanges || 0);
        const colorDot = p.color ? `{${p.color}-fg}●{/${p.color}-fg}` : ' ';
        content += ` ${rank} ${colorDot} ${name} ${prs}  ${wc}\n`;
      });
    }

    content += `\n\n {gray-fg}Updated: ${lbLastUpdated}{/gray-fg}`;
    leaderboardBox.setContent(content);
    screen.render();
  }

  async function refreshLeaderboard() {
    leaderboardBox.setContent('\n {yellow-fg}Loading…{/yellow-fg}');
    screen.render();
    const result = await fetchLeaderboard();
    renderLeaderboard(result);
  }

  // ── focus helpers ─────────────────────────────────────────────────────────
  function setFocus(panel) {
    focus = panel;
    personalityBox.style.border.fg = panel === 'personality' ? 'yellow' : 'gray';
    directivesBox.style.border.fg = panel === 'directives' ? 'green' : 'gray';
    if (panel === 'personality') presetList.focus();
    else directivesList.focus();
    screen.render();
  }

  // ── inline prompt helper ──────────────────────────────────────────────────
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

  // ── key bindings ──────────────────────────────────────────────────────────
  screen.key(['q', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  screen.key(['tab'], () => {
    setFocus(focus === 'personality' ? 'directives' : 'personality');
  });

  screen.key(['r'], () => {
    refreshLeaderboard();
  });

  // Personality panel keys
  presetList.key(['enter'], () => {
    const sel = presetList.selected;
    const name = sel < PRESET_NAMES.length ? PRESET_NAMES[sel] : 'Custom';
    if (name === 'Custom') {
      prompt('Custom personality', currentPersonality, (val) => {
        if (val) {
          currentPersonality = val;
          md = updateSection(md, 'Personality', currentPersonality);
          writeCharacter(md);
          personalityPreview.setContent(currentPersonality);
          refreshPresetList();
        }
      });
    } else {
      applyPreset(name);
      refreshPresetList();
    }
  });

  presetList.key(['e'], () => {
    prompt('Custom personality', currentPersonality, (val) => {
      if (val) {
        currentPersonality = val;
        md = updateSection(md, 'Personality', currentPersonality);
        writeCharacter(md);
        personalityPreview.setContent(currentPersonality);
        refreshPresetList();
      }
    });
  });

  // Directives panel keys
  directivesList.key(['a'], () => {
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
    if (directives.length === 0) return;
    const sel = directivesList.selected;
    if (sel >= directives.length) return;
    directives.splice(sel, 1);
    saveDirectives();
    refreshDirectivesList();
  });

  directivesList.key(['e'], () => {
    if (directives.length === 0) return;
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

  // Tab between panels (from list widgets too)
  presetList.key(['tab'], () => setFocus('directives'));
  directivesList.key(['tab'], () => setFocus('personality'));

  // ── initial render ────────────────────────────────────────────────────────
  refreshPresetList();
  refreshDirectivesList();
  setFocus('personality');

  refreshLeaderboard();
  const lbInterval = setInterval(refreshLeaderboard, 30_000);

  screen.on('destroy', () => clearInterval(lbInterval));
  screen.render();
}

main();
