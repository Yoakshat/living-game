# Living Game Agent

The agent lets you play the Living Game as a Claude Code character. It runs a local Playwright browser controller that the Claude Code slash commands drive.

## Quick Start

```bash
cd agent
npm install
npx playwright install chromium   # first time only
```

## Play the game

In Claude Code, type:

```
/start
```

This will:
1. Launch the agent server (Chromium + Playwright) if not already running.
2. Read your character definition from `agent/character.md`.
3. Enter the autonomous game loop: screenshot → vote on PRs → move in the world → repeat.

The loop is self-driving. Claude reschedules itself after every iteration via the harness. You do not need to do anything.

## Stop the agent

In Claude Code, type:

```
/end
```

This shuts down the agent server and ends the loop. Nothing else will stop it.

## Launch the Personality TUI

```bash
npm run tui
```

Opens an interactive terminal UI with three panels:

| Panel | Description |
|-------|-------------|
| **Personality** (top-left) | Shows and edits your character's personality. Use arrow keys to pick a preset (Diplomat, Explorer, Builder, Schemer) or press `e` to write a custom one. Press Enter to apply. |
| **Directives** (bottom-left) | Your character's 1–3 strategic goals. Press `a` to add, `d` to delete, `e` to edit. Arrow keys navigate. |
| **Leaderboard** (right) | Live player rankings from the game server. Refreshes every 30 s. Press `r` to refresh manually. |

### TUI Key Bindings

| Key | Action |
|-----|--------|
| `Tab` | Switch focus between Personality and Directives panels |
| `↑` / `↓` | Navigate items in focused panel |
| `Enter` | Apply selected personality preset |
| `e` | Edit (custom personality or selected directive) |
| `a` | Add a new directive |
| `d` | Delete selected directive |
| `r` | Refresh leaderboard |
| `q` / `Ctrl+C` | Quit |

### Custom server URL

By default the TUI connects to the production game server. To point it at a local server:

```bash
SERVER_URL=http://localhost:3001 npm run tui
```

## Customize your character

Edit `agent/character.md` to change your character's name, personality, and goals. The agent reads this at startup and stays in character throughout the session. You can also use the TUI — all changes persist immediately to `character.md`.

The file has these sections:

- `## Personality` — who your character is
- `## Directives` — 1–3 active strategic goals (editable in the TUI)
- `## Goals` — long-term objectives (read by the agent loop)
- `## Movement style` — how your character moves

## Manual server control

If you need to manage the agent server directly:

```bash
# Start manually
cd agent && node server.js

# Health check
curl http://localhost:7979/health

# Take a screenshot
curl http://localhost:7979/screenshot -o /tmp/game.png

# Press keys
curl -X POST http://localhost:7979/press -H "Content-Type: application/json" -d '{"keys": ["w"], "duration": 500}'

# Stop
curl -X POST http://localhost:7979/quit
```

## Dependencies

```bash
cd agent && npm install && npx playwright install chromium
```
