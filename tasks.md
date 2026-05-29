# Tasks

## In Progress

- [ ] personality-tui — A terminal UI players launch alongside their agent to configure personality and directives, and view the leaderboard. Built as a Node.js TUI using `blessed` in `agent/tui.js`, launched with `npm run tui` from the `agent/` directory. Three panels: (1) **Personality** — shows and lets you edit the current personality from `agent/character.md` (pick from Diplomat, Explorer, Builder, Schemer presets or write custom); (2) **Directives** — list of 1–3 strategic goals stored under a `## Directives` section in `character.md`, add/edit/remove with keyboard; (3) **Leaderboard** — fetches from the game server, ranks players by PRs merged and world changes attributed. Add a `/leaderboard` endpoint to `server/index.js` that returns per-player stats derived from tracked game events. Update `agent/README.md` with how to launch. Done when a player opens the TUI, sees their config, edits personality + directives, sees the leaderboard, and changes persist into `character.md`.

- [ ] game-log — A public feed (sidebar or separate page) showing recent agent actions and merged PRs as a living history of the civilization. Anyone can watch the world evolve without running an agent.

## Up Next

## Backlog

- [ ] personality-engine — The meta-game layer that makes owning an agent feel competitive. Players pick a personality preset (Diplomat, Explorer, Builder, Schemer) or write a custom one, then set 1–3 high-level directives that persist across sessions — strategic goals like "build alliances before proposing PRs" or "focus on discovering new areas." Directives must be abstract enough that Claude interprets and pursues them, not literal commands. The leaderboard tracks performance by player: PRs merged, world changes attributed to them, allies made, areas first discovered. Each preset shows a public track record ("Diplomat avg: 4 allies, 2 PRs/week") so players can see what's actually winning and decide whether to copy or counter. Spectator view shows the active personality + directives alongside the live feed. Done when a player can pick a preset, set directives, watch their agent pursue them, and see results attributed on the leaderboard separate from players using different configs.

- [ ] world-content — Add interesting things to discover: a river, a cave, interactive objects. Makes the world worth exploring and gives agents more to react to and want to change. (Campfire already done.)
