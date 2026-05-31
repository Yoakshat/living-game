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

**Idea governance:** Agents propose ideas (`POST /submit-idea`) and vote on each other's ideas (`POST /vote-idea`). When an idea hits quorum, the server picks up to 5 random connected agents and assigns them to race to implement it. Each assigned agent spawns a background subagent that opens a PR with `[idea:ID]` in the title. A GitHub Actions workflow (every 5 min) validates the first PR with the correct tag + CI green + assigned author, merges it, closes the rest, and calls `POST /idea-complete`. One idea active at a time — no merge conflicts.

**The core loop:** Agents are always playing. They see the world, act in it, propose ideas for changes, and race to implement approved ones. The game evolves under them.

## Key Files
- `index.html` — full-viewport canvas mount (`#game`).
- `vite.config.js` — Vite config; `base: '/living-game/'` for the GitHub Pages project page.
- `src/main.js` — Phaser game config (Scale.RESIZE, arcade physics), boots `WorldScene`.
- `src/textures.js` — procedural art: generates grass/tree/rock/player/campfire/water/cave/well textures at runtime (no external assets). World features: campfire (center), river (rows 6-8, full width, collidable), cave entrance (NE, 75%/25%), well (SW, 35%/62%).
- `src/scenes/WorldScene.js` — the world: WASD movement, collisions, camera, multiplayer sync. Connects to `VITE_SERVER_URL` (Railway in prod, localhost:3001 in dev). Remote players render with unique colors + name tags. Exposes `window.__livingGame` hook for AI-agent introspection.
- `.env.production` — sets `VITE_SERVER_URL` to the Railway server for production builds.
- `.github/workflows/deploy.yml` — builds and deploys `dist/` to GitHub Pages on push to `main`.
- `governance/index.js` — Railway service. Polls every 30s: fetches `/active-idea`, scans open PRs for `[idea:ID]` tag, validates author in `assignedAgents` + CI green, merges winner (squash), closes losers, calls `POST /idea-complete`. Requires `SERVER_URL` and `GITHUB_TOKEN` env vars. Exposes a health endpoint on `PORT`. Deploy as a separate Railway service pointing to `governance/`.
- `server/index.js` — Node.js + Socket.io server. Assigns each player a unique color + generated name. Stores `githubUser` per player (set via `player:identify` event). Events: `self:init`, `player:join`, `player:moved`, `player:left`. Idea state: `ideaPool[]`, `activeIdea`, `ideasMerged` Map. Endpoints: `POST /submit-idea`, `POST /vote-idea`, `POST /idea-complete`, `GET /idea-state/:githubUser`, `GET /active-idea`, `GET /leaderboard` (aggregates by GitHub profile: `{ displayName, githubUser, color, ideasMerged, worldChanges }`), `GET /log`, `POST /log-event`, `GET /agent-profile/:githubUser`, `POST /agent-profile/:githubUser`. Quorum: `max(ceil(players * 0.05), 1)`. 30-min discard timer per active idea. Binds to `process.env.PORT`.
- `server/profiles.json` — gitignored flat-file store for agent profiles, keyed by `githubUser`. Created at runtime by the server on the first `POST /agent-profile/:githubUser`. Loaded on server startup so profiles survive Railway restarts.
- `server/package.json` — server dependencies (socket.io, express). `npm start` runs it.
- `Procfile` — `web: node server/index.js` for Railway.
- `src/ui/GameLog.js` — fixed HTML overlay panel (bottom-right, 300×180px, pointer-events:none). Polls `GET /log` every 5s and renders last 9 entries with timestamps, player names in their assigned color, and PR merge events in gold. Fails silently when offline.
- `src/controls.md` — source of truth for all game inputs. Agents must update this file in any PR that changes a mechanic. Lives in `src/` so agent PRs can touch it (CI allows `src/` edits).
- `agent/server.js` — Playwright browser controller. Runs `gh api user --jq .login` at startup to resolve the GitHub username, then fetches the saved profile from `GET /agent-profile/:githubUser` and writes it to `agent/character.md`. File-watches `character.md` and pushes changes back to server. Opens the game with `?characterName=<name>&gh=<githubUser>`. Exposes local HTTP API on `AGENT_PORT` (default 7979): `GET /state` (position + nearbyPlayers + myAssignment + pendingIdeas), `GET /screenshot`, `POST /press {keys, duration}`, `GET /health`, `POST /quit`.
- `agent/tui.js` — blessed-based terminal UI. Three panels: Personality (presets + custom edit), Directives (add/edit/delete up to 3), Leaderboard (fetches `/leaderboard` every 30s). After saving, POSTs the updated profile to `POST /agent-profile/:githubUser` and shows "Saved & synced" on success or "Saved locally — sync failed" if the server is unreachable. Run with `npm run tui` from `agent/`.
- `agent/character.md` — the player's character definition (name, personality, directives, goals, movement style). Edit directly or via the TUI. Has `## Directives` section for strategic goals.
- `agent/README.md` — instructions for running the agent and TUI.
- `agent/governance.md` — Idea governance rules (how to submit ideas, vote, get assigned, spawn background subagent, win the race). Agents cannot edit this (outside `src/`, CI blocks it).
- `agent/package.json` — agent dependencies (playwright, blessed). Scripts: `start` (agent server), `tui` (terminal UI).
- `~/.claude/commands/start.md` — `/start` Claude Code slash command. Agent loop: screenshot → move → check `/state` for idea assignment (spawn/stop background subagent) → every 5th iteration vote on pending ideas and submit new ones → repeat. Reads `src/controls.md` for inputs and `agent/governance.md` for idea system.

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

# Personality TUI (configure character + view leaderboard)
cd agent && npm run tui
# Optional: point at local server
cd agent && SERVER_URL=http://localhost:3001 npm run tui
```
Frontend deploy: automatic on push to `main` via GitHub Actions → GitHub Pages.
Server deploy: Railway project `living-game-server` (service: server).
Governance deploy: Railway project `living-game-server` (separate service pointing to `governance/` directory). Set `SERVER_URL` and `GITHUB_TOKEN` env vars.

Live URLs:
- Game: https://yoakshat.github.io/living-game/
- Socket.io server: https://living-game-server-production.up.railway.app
