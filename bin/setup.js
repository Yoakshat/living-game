#!/usr/bin/env node
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';

const HOME = os.homedir();
const COMMANDS_DIR = path.join(HOME, '.claude', 'commands');
const GAME_DIR = path.join(HOME, 'projects', 'living-game', 'main');
const AGENT_DIR = path.join(GAME_DIR, 'agent');
const REPO_URL = 'https://github.com/Yoakshat/living-game.git';

function ask(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} (default: ${defaultValue}): ` : `${question}: `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, stdio: 'inherit', ...opts });
}

function runCapture(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe' }).toString().trim();
  } catch {
    return '';
  }
}

// ── Welcome ──────────────────────────────────────────────────────────────────
console.log('\nWelcome to Living Game — setting up your agent...\n');

// ── Interactive prompts ───────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const name = await ask(rl, "What's your character's name?", 'Wolf');
const personality = await ask(
  rl,
  'Describe your personality in one line:',
  'A curious explorer who loves discovering new places'
);

rl.close();

// ── Playwright install ────────────────────────────────────────────────────────
const pwVersion = runCapture('npx playwright --version 2>/dev/null');
if (!pwVersion) {
  console.log('\nInstalling Playwright browser...');
  const result = run('npx playwright install chromium');
  if (result.status !== 0) {
    console.warn('\nWarning: Playwright install failed. You can install it manually later with:\n  npx playwright install chromium\n');
  }
} else {
  console.log(`\nPlaywright already installed (${pwVersion}).`);
}

// ── Clone or update repo ──────────────────────────────────────────────────────
if (!fs.existsSync(GAME_DIR)) {
  console.log('\nDownloading Living Game...');
  const cloneResult = run(`git clone ${REPO_URL} ${GAME_DIR}`);
  if (cloneResult.status !== 0) {
    console.error('\nError: Failed to clone the Living Game repository.');
    console.error('Check your internet connection and try again.');
    process.exit(1);
  }
  console.log('Installing dependencies...');
  run('npm install', { cwd: GAME_DIR });
  if (fs.existsSync(AGENT_DIR)) {
    run('npm install', { cwd: AGENT_DIR });
  }
} else {
  console.log('\nLiving Game already downloaded — pulling latest updates...');
  run('git pull', { cwd: GAME_DIR });
}

// ── Ensure ~/.claude/commands/ exists ────────────────────────────────────────
fs.mkdirSync(COMMANDS_DIR, { recursive: true });

// ── Write start.md ────────────────────────────────────────────────────────────
const startMd = `# Start Living Game Agent

You are playing Living Game as **${name}** — ${personality}.

## Setup
Check if the agent server is already running:
\`curl -s http://localhost:7979/health 2>/dev/null\`
- Returns ok → skip to The Loop
- Fails → start it:
  \`cd ~/projects/living-game/main/agent && CHARACTER_NAME="${name}" node server.js &\`
  Wait 10 seconds, then verify with \`curl -s http://localhost:7979/health\`

## The Loop
Read \`~/projects/living-game/main/controls.md\` to understand the current game controls.
Read \`~/projects/living-game/main/agent/character.md\` if you want more character depth.

Repeat until told to stop:
1. \`curl -s http://localhost:7979/screenshot -o /tmp/living-game.png\`
2. Look at \`/tmp/living-game.png\` — observe the game world.
3. Decide your next action using controls from controls.md.
4. Execute it.
5. Say one sentence as ${name} about what you're doing.
6. Go back to step 1.

## Stop
\`curl -s -X POST http://localhost:7979/quit\`
`;

fs.writeFileSync(path.join(COMMANDS_DIR, 'start.md'), startMd);

// ── Write stop.md ─────────────────────────────────────────────────────────────
const stopMd = `# Stop Living Game Agent

Stop the running agent server:
\`curl -s -X POST http://localhost:7979/quit 2>/dev/null && echo "Agent stopped." || echo "Agent was not running."\`
`;

fs.writeFileSync(path.join(COMMANDS_DIR, 'stop.md'), stopMd);

// ── Write character.md ────────────────────────────────────────────────────────
fs.mkdirSync(AGENT_DIR, { recursive: true });

const characterMd = `# Character: ${name}

## Personality
${personality}

## Goals
- Explore the world and interact with other agents
- Stay true to your personality in every decision

## Movement style
- Move based on what you observe and your character's nature
- If stuck, try a different direction
`;

fs.writeFileSync(path.join(AGENT_DIR, 'character.md'), characterMd);

// ── Done ──────────────────────────────────────────────────────────────────────
console.log(`
✓ You're all set, ${name}!

Open Claude Code and type /start to enter the game.
Watch yourself play at https://yoakshat.github.io/living-game/

To stop your agent, type /stop in Claude Code.
`);
