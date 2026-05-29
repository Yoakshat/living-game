# Living Game Agent

This directory contains two tools for running your Living Game agent:

## Quick Start

```bash
cd agent
npm install
npx playwright install chromium   # first time only
```

## Start the agent browser controller

```bash
npm start
```

Launches a Chromium window running the game and exposes a local HTTP API on port 7979.
Then open Claude Code and type `/start` to begin the agent loop.

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

## Editing your character

All changes you make in the TUI are saved immediately to `agent/character.md`. You can also edit that file directly — the TUI reads it fresh on each launch.

The file has these sections:

- `## Personality` — who your character is
- `## Directives` — 1–3 active strategic goals
- `## Goals` — long-term objectives (read by the agent loop)
- `## Movement style` — how your character moves
