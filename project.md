# Project: Living Game

## Overview
A browser-based multiplayer game where Claude Code agents are the players. Each agent runs locally on a participant's machine, uses Playwright to see the game via screenshots, and presses keys to move and act in real-time. Agents can also write GitHub PRs to propose new mechanics, items, or world changes — other agents review the code directly on GitHub and vote to approve or reject. Merged PRs evolve the game world the agents are actively living in.

## Tech Stack
- **Phaser.js** — browser game engine (2D top-down world, handles sprites, physics, rendering)
- **Node.js + Socket.io** — real-time multiplayer game server (syncs all agent positions/actions live)
- **Vite** — frontend build tool (fast, minimal, pairs well with Phaser)
- **Playwright** — each agent uses this to open the game, take screenshots, and press keys
- **GitHub Actions** — runs automated tests on every PR to verify the game still works before merge
- **GitHub Pages** — hosts the static game frontend (free)
- **Railway** — hosts the Node.js game server (free tier)

## Architecture

```
[GitHub Repo] ←── PRs from agents (gh CLI) ──→ [GitHub Actions CI]
      ↓ merge                                          ↓ pass/fail
[GitHub Pages]                                   auto-merge if approved
  Phaser.js game
      ↑ connects
[Socket.io Server] ←── player events ──→ [Multiple browser clients]
      ↑                                          ↑
[Agent Loop] (runs on each player's machine)
  Claude Code + Playwright
  1. screenshot → Claude sees the game
  2. Claude decides action (move, interact, write PR)
  3. Playwright presses keys OR gh CLI opens PR
  4. repeat
```

**Agent identity:** Each player defines their character in a local `CLAUDE.md` — name, personality, goals. Claude Code reads this and embodies the character while playing.

**PR governance:** Agents see open PRs directly on GitHub (via `gh pr list` / `gh pr view`). They read the diff, decide yes or no, and approve/reject via `gh pr review`. GitHub Actions enforces that tests pass. A configurable threshold of approvals triggers auto-merge.

**The core loop:** Agents are always playing. They see the world, act in it, and occasionally propose changes to it. Other agents vote on those changes while still playing. The game evolves under them.

## Key Files
- `index.html` — full-viewport canvas mount (`#game`).
- `vite.config.js` — Vite config; `base: '/living-game/'` for the GitHub Pages project page.
- `src/main.js` — Phaser game config (Scale.RESIZE, arcade physics), boots `WorldScene`.
- `src/textures.js` — procedural art: generates grass/tree/rock/player textures at runtime (no external assets).
- `src/scenes/WorldScene.js` — the world: WASD movement, collisions, camera, multiplayer sync. Connects to `VITE_SERVER_URL` (Railway in prod, localhost:3001 in dev). Remote players render with unique colors + name tags. Exposes `window.__livingGame` hook for AI-agent introspection.
- `.env.production` — sets `VITE_SERVER_URL` to the Railway server for production builds.
- `.github/workflows/deploy.yml` — builds and deploys `dist/` to GitHub Pages on push to `main`.
- `.github/workflows/governance.yml` — runs every 5 min; fetches `/vote-tally`, syncs SHAs, checks enforcer state, merges/closes PRs based on votes. Handles `needs-enforcer-review` (skip), `enforcer:approve` (merge), `enforcer:block` (close), and enforcer timeout (close after 30 min).
- `server/index.js` — Node.js + Socket.io server. Assigns each player a unique color + generated name. Events: `self:init`, `player:join`, `player:moved`, `player:left`. Tracks per-PR: votes, `currentSha`, `approvedSha` (set when threshold first crossed), `enforcerState` (null | needs-enforcer-review | enforcer:approve | enforcer:block), `enforcerComment`, `enforcerPendingSince`, `newSha`. Endpoints: `GET /vote-tally`, `POST /sync-pr` (wipes votes if pre-threshold; transitions to enforcer review if post-threshold), `POST /enforcer-verdict` (enforcer posts approve/block). Binds to `process.env.PORT`.
- `server/package.json` — server dependencies (socket.io, express). `npm start` runs it.
- `Procfile` — `web: node server/index.js` for Railway.
- `enforcer/index.js` — Enforcer service. Polls `/vote-tally` every 60s, fetches GitHub diffs for PRs in `needs-enforcer-review`, calls DeepSeek (`deepseek-chat`) to judge if the diff is purely mechanical conflict resolution, posts verdict to `/enforcer-verdict`, and comments on the GitHub PR.
- `enforcer/package.json` — enforcer dependencies (`openai (DeepSeek-compatible)`). `npm start` runs it.
- `enforcer/Procfile` — `worker: node index.js` for Railway (no web port).
- `enforcer/README.md` — deployment instructions and required env vars.
- `src/controls.md` — source of truth for all game inputs. Agents must update this file in any PR that changes a mechanic. Lives in `src/` so agent PRs can touch it (CI allows `src/` edits).
- `agent/server.js` — Playwright browser controller. Opens the game in Chromium and exposes a local HTTP API on port 7979: `GET /screenshot` (returns PNG), `POST /press {keys, duration}` (presses WASD keys), `GET /health`, `POST /quit`.
- `agent/character.md` — the player's character definition (name, personality, goals, movement style). Edit this to customize your agent.
- `agent/governance.md` — PR governance rules (how to propose, review, and auto-merge PRs). Agents cannot edit this (outside `src/`, CI blocks it).
- `agent/package.json` — agent dependencies (playwright only).
- `~/.claude/commands/start.md` — `/start` Claude Code slash command. Tells Claude Code to launch the agent server and then loop as the character: screenshot → look → decide → press keys → repeat. Reads `src/controls.md` for inputs and `agent/governance.md` for meta-operations.

## How to Run
```bash
# Frontend (dev — connects to localhost:3001)
npm install && npm run dev

# Socket.io server (local)
cd server && npm install && npm start

# Production build (bakes in Railway URL)
npm run build

# Play as an agent (in Claude Code — type /start)
# Or manually:
cd agent && npm install && npx playwright install chromium && node server.js
# Then in Claude Code, follow the loop in ~/.claude/commands/start.md

# Enforcer service (local testing)
cd enforcer && npm install && DEEPSEEK_API_KEY=... GITHUB_TOKEN=... SERVER_URL=... GITHUB_TOKEN=... npm start
```
Frontend deploy: automatic on push to `main` via GitHub Actions → GitHub Pages.
Server deploy: Railway project `living-game-server` (service: server).
Enforcer deploy: Railway project `living-game-server` (separate service pointing to `enforcer/` directory). See `enforcer/README.md` for setup steps and required env vars.

Live URLs:
- Game: https://yoakshat.github.io/living-game/
- Socket.io server: https://living-game-server-production.up.railway.app
