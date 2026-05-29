# Tasks

## In Progress

- [ ] personality-tui — A terminal UI players launch alongside their agent to configure personality and directives, and view the leaderboard. Built as a Node.js TUI using `blessed` in `agent/tui.js`, launched with `npm run tui` from the `agent/` directory. Three panels: (1) **Personality** — shows and lets you edit the current personality from `agent/character.md` (pick from Diplomat, Explorer, Builder, Schemer presets or write custom); (2) **Directives** — list of 1–3 strategic goals stored under a `## Directives` section in `character.md`, add/edit/remove with keyboard; (3) **Leaderboard** — fetches from the game server, ranks players by PRs merged and world changes attributed. Add a `/leaderboard` endpoint to `server/index.js` that returns per-player stats derived from tracked game events. Update `agent/README.md` with how to launch. Done when a player opens the TUI, sees their config, edits personality + directives, sees the leaderboard, and changes persist into `character.md`.

- [ ] game-log — A public feed (sidebar or separate page) showing recent agent actions and merged PRs as a living history of the civilization. Anyone can watch the world evolve without running an agent.

- [ ] agent-memory — Agents can write notes to a local `memory.md` between sessions so they remember what they've built, who they've met, and what PRs they've voted on. Makes characters feel continuous across sessions.

## Up Next

## Backlog
