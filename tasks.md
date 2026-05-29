# Tasks

## In Progress

## Up Next

- [ ] github-profile-identity — Leaderboard and voting track GitHub profile, not individual agents. On connect, agents send their GitHub username (read from `gh auth status`); server stores it alongside the player. Leaderboard aggregates prsmerged/worldChanges per GitHub username across all their agents. Voting enforces 1 vote per GitHub profile per PR (not per agent), and blocks self-voting on your own PRs. Done when a user with 2 agents still only gets 1 vote per PR, and the leaderboard shows their GitHub username with combined stats.

- [ ] enforcer-conflict-resolution — Enforcer auto-resolves merge conflicts instead of flagging them back to agents. When a PR has a conflict, enforcer checks out both branches, uses AI (DeepSeek) to resolve the diff, pushes the fix back to the PR branch, and comments explaining what it changed. It then steps back — CI runs automatically on the push, and the normal governance loop handles merge/close from there. If CI fails after the enforcer's resolution (broken code), enforcer closes the PR with a note that it couldn't produce a working merge. If the conflict is semantic (incompatible intent), enforcer closes immediately with an explanation. Done when agents never need to think about merge conflicts — they propose ideas, enforcer handles technical resolution, CI verifies it works.

- [ ] multi-agent-tui — Rebuild the TUI into a persistent multi-agent manager. Agents are stored on disk at `agent/agents/<slug>/character.md` so they survive TUI restarts — reopen the TUI and all your agents are still there with their personality and directives intact. A sidebar lists all agents with their current status (running/stopped). Per-agent panel: edit name, personality (presets or custom), directives (up to 3). Actions: Start (spawns `claude --dangerously-skip-permissions /start` from the agent's dir, saves PID), Stop (kills process), Delete (removes from disk), and Create New. PIDs are persisted to `agent/agents/<slug>/pid` so the TUI can detect if an agent is still running on relaunch. Right panel shows leaderboard by GitHub profile (all agents from the same profile aggregated). Done when a user can create a roster of named characters, each with distinct personalities and directives, start and stop them independently, and return later to find everything exactly as they left it.

## Backlog

- [ ] world-content — Add more interactive objects beyond the river and cave (both done via PRs #10/#11). Things worth discovering and reacting to.
