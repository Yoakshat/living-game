# Tasks

## In Progress

## Up Next

- [ ] game-scaffold — Set up Vite + Phaser.js project with a 2D top-down world. Tilemap with walkable grass terrain, trees/rocks as obstacles, and a single player character sprite that moves with WASD. Deploy to GitHub Pages. This is the visual world agents will live in — it needs to look good enough that an agent seeing a screenshot actually perceives a real place, not a placeholder.

- [ ] multiplayer-server — Add Node.js + Socket.io game server. All connected clients see each other's characters moving in real-time. Each player has a unique color and name tag above their head. Host on Railway. Done when two browser tabs open to the game show each other's movement live.

- [ ] agent-loop — The core script each player runs via Claude Code. Uses Playwright to open the game in a browser, takes a screenshot every ~2 seconds, feeds it to Claude with the character's personality context (from CLAUDE.md), and executes whatever Claude decides — WASD keypresses, interactions, or opening a terminal to write a PR. Claude can batch multiple decisions per turn. Done when a single agent autonomously wanders the world for 5 minutes without human input.

- [ ] character-system — Each agent gets a distinct visual identity: unique sprite color, name, and a `character.md` template that defines personality + goals + motivations. The agent loop reads this file to stay in character. Include 3 starter character templates (explorer, builder, skeptic) so new players can pick one and go.

- [ ] pr-constitution — Define what agents are allowed to propose via PR. Write a `CONSTITUTION.md` that specifies: allowed change types (new terrain, new items, new mechanics, visual changes), forbidden changes (removing the PR system itself, giving one agent special powers, breaking multiplayer), and the approval threshold (e.g. 2 approvals + CI pass = auto-merge). Set up GitHub Actions to run the test suite on every PR.

- [ ] ci-test-suite — Automated tests that run on every PR via GitHub Actions. Tests: game loads in browser (Playwright), multiplayer connects (two headless clients join and see each other), no console errors, character movement works. These are the gates that protect the world from broken PRs. Done when a deliberately broken PR fails CI and a good PR passes.

- [ ] pr-workflow — Polish the agent's ability to propose and vote on PRs. Agent can run `gh pr list` mid-game, read a diff, and approve/reject with a comment explaining their reasoning (in character). The game HUD shows a small indicator when PRs are open. Done when an agent writes a PR, a second agent reviews and approves it in-character, and it auto-merges.

## Backlog

- [ ] world-content — Add interesting things to discover: a river, a cave, a campfire, interactive objects. Makes the world worth exploring and gives agents more to react to and want to change.

- [ ] game-log — A public feed (sidebar or separate page) showing recent agent actions and merged PRs as a living history of the civilization. Anyone can watch the world evolve without running an agent.

- [ ] agent-memory — Agents can write notes to a local `memory.md` between sessions so they remember what they've built, who they've met, and what PRs they've voted on. Makes characters feel continuous across sessions.
