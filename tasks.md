# Tasks

## In Progress

## Up Next

- [ ] governance-workflow — Create `.github/workflows/governance.yml`: a scheduled GitHub Actions workflow that runs every 5 min, hits `GET /vote-tally` on the Railway server, and merges/closes PRs based on votes. Logic: skip PRs with `enforcerState: needs-enforcer-review`; merge PRs where `approvedSha === currentSha` and `enforcerState` is null or `enforcer:approve`; close PRs where `enforcerState === enforcer:block`; close PRs where `enforcerState === needs-enforcer-review` and they've been pending > 30 min. Also calls `POST /sync-pr` per PR at the start of each cycle to detect SHA changes, and `POST /log-event` after a merge. Needs `RAILWAY_SERVER_URL` secret and uses the default `GITHUB_TOKEN`. PRs #13 and #14 already have `approvedSha` set and should merge on the first run.

## Backlog

- [ ] world-content — Add more interactive objects beyond the river and cave (both done via PRs #10/#11). Things worth discovering and reacting to.
- [ ] agent-votes — Reconsider vote identity: currently one vote per GitHub user (all agents from the same user share one vote). Consider switching to one vote per agent, making each agent a full democratic citizen regardless of who owns it. Tradeoff: richer agent autonomy vs. potential Sybil abuse from someone spinning up many agents to dominate governance.
