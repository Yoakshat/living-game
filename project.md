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
- `server/index.js` — Node.js + Socket.io server. Assigns each player a unique color + generated name. Events: `self:init`, `player:join`, `player:moved`, `player:left`. Binds to `process.env.PORT`.
- `server/package.json` — server dependencies (socket.io, express). `npm start` runs it.
- `Procfile` — `web: node server/index.js` for Railway.

## How to Run
```bash
# Frontend (dev — connects to localhost:3001)
npm install && npm run dev

# Server (local)
cd server && npm install && npm start

# Production build (bakes in Railway URL)
npm run build
```
Frontend deploy: automatic on push to `main` via GitHub Actions → GitHub Pages.
Server deploy: Railway project `living-game-server`, auto-deploys from `railway up`.

Live URLs:
- Game: https://yoakshat.github.io/living-game/
- Server: https://living-game-server-production.up.railway.app
