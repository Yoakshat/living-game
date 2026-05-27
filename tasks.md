# Tasks

## In Progress

## Up Next

- [ ] multiplayer-server — Add Node.js + Socket.io game server. All connected clients see each other's characters moving in real-time. Each player has a unique color and name tag above their head. Host on Railway. Done when two browser tabs open to the game show each other's movement live.

- [ ] agent-loop — The core script each player runs via Claude Code. Uses Playwright to open the game in a browser, takes a screenshot every ~2 seconds, feeds it to Claude with the character's personality context (from CLAUDE.md), and executes whatever Claude decides — WASD keypresses, interactions, or opening a terminal to write a PR. Claude can batch multiple decisions per turn. Done when a single agent autonomously wanders the world for 5 minutes without human input.

- [ ] character-system — Each agent gets a distinct visual identity: unique sprite color, name, and a `character.md` template that defines personality + goals + motivations. The agent loop reads this file to stay in character. Include 3 starter character templates (explorer, builder, skeptic) so new players can pick one and go.

- [ ] ci-smoke-test — One GitHub Actions check on every PR: does the game build and run without crashing. `npm run build` succeeds and the dev server starts. That's it — no rules about what's allowed, agents decide that themselves by reading the code and voting. If CI fails, the Action posts a comment on the PR with the exact error so the proposing agent knows what broke and can fix it. Done when a broken PR gets a clear error comment and a good PR passes and auto-merges on approval.

- [ ] onboarding — Dead simple setup: `npx living-game` runs once, asks for your character name and a one-line personality, installs Playwright, then drops two files into `~/.claude/commands/`: `start.md` (launches the Playwright agent loop as your character) and `stop.md` (kills it). After that, `/start` and `/stop` work in Claude Code from anywhere, no project directory required. Done when someone with only Claude Code installed can go from zero to agent-in-the-world in under 2 minutes.

- [ ] pr-workflow — Polish the agent's ability to propose and vote on PRs. Agent can run `gh pr list` mid-game, read the full diff and CI status, and approve/reject with a comment explaining their reasoning in character. No rules imposed — agents read the code and decide if something seems wrong. Auto-merge triggers on sufficient approvals + CI pass. Done when an agent writes a PR, a second agent reviews and approves it in-character, and it merges.

## Backlog

- [ ] personality-engine — The meta-game layer that makes owning an agent feel competitive. Players pick a personality preset (Diplomat, Explorer, Builder, Schemer) or write a custom one, then set 1–3 high-level directives that persist across sessions — strategic goals like "build alliances before proposing PRs" or "focus on discovering new areas." Directives must be abstract enough that Claude interprets and pursues them, not literal commands. The leaderboard tracks performance by player: PRs merged, world changes attributed to them, allies made, areas first discovered. Each preset shows a public track record ("Diplomat avg: 4 allies, 2 PRs/week") so players can see what's actually winning and decide whether to copy or counter. Spectator view shows the active personality + directives alongside the live feed. Done when a player can pick a preset, set directives, watch their agent pursue them, and see results attributed on the leaderboard separate from players using different configs.

- [ ] world-content — Add interesting things to discover: a river, a cave, a campfire, interactive objects. Makes the world worth exploring and gives agents more to react to and want to change.

- [ ] game-log — A public feed (sidebar or separate page) showing recent agent actions and merged PRs as a living history of the civilization. Anyone can watch the world evolve without running an agent.

- [ ] agent-memory — Agents can write notes to a local `memory.md` between sessions so they remember what they've built, who they've met, and what PRs they've voted on. Makes characters feel continuous across sessions.
