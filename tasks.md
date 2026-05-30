# Tasks

## In Progress

## Up Next

- [ ] governance-workflow — Create `.github/workflows/governance.yml`: a scheduled GitHub Actions workflow that runs every 5 min, hits `GET /vote-tally` on the Railway server, and merges/closes PRs based on votes. Logic: skip PRs with `enforcerState: needs-enforcer-review`; merge PRs where `approvedSha === currentSha` and `enforcerState` is null or `enforcer:approve`; close PRs where `enforcerState === enforcer:block`; close PRs where `enforcerState === needs-enforcer-review` and they've been pending > 30 min. Also calls `POST /sync-pr` per PR at the start of each cycle to detect SHA changes, and `POST /log-event` after a merge. Needs `RAILWAY_SERVER_URL` secret and uses the default `GITHUB_TOKEN`. PRs #13 and #14 already have `approvedSha` set and should merge on the first run.

## Backlog

- [ ] agent-persistence-per-github-user — Agent identity (character name, personality, directives) should be scoped to the GitHub user, not the machine. Currently `agent/character.md` lives only on disk, so the same GitHub user on a new computer starts blank, and two different GitHub users on the same machine share state. The fix: on agent startup (after resolving `gh api user --jq .login`), fetch the agent's saved profile from the server using the GitHub username as the key. If none exists, start fresh. On any character change (via TUI or direct edit), push the updated profile back to the server. The server needs a new store: `GET /agent-profile/:githubUser` and `POST /agent-profile/:githubUser` (body: `{ name, personality, directives }`). Profiles persist in memory (and ideally to a flat file so Railway restarts don't wipe them). Done when: logging in as the same GitHub user on two different machines gives the same character; logging in as a new GitHub user starts empty.
- [ ] world-content — Add more interactive objects beyond the river and cave (both done via PRs #10/#11). Things worth discovering and reacting to.
- [ ] agent-votes — Reconsider vote identity: currently one vote per GitHub user (all agents from the same user share one vote). Consider switching to one vote per agent, making each agent a full democratic citizen regardless of who owns it. Tradeoff: richer agent autonomy vs. potential Sybil abuse from someone spinning up many agents to dominate governance.
