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
_Will be filled in as we build._

## How to Run
_Will be filled in as we build._
