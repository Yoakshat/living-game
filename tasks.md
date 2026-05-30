# Tasks

## In Progress

## Up Next

- [ ] governance-conflict-resolution — When governance tries to merge an approved PR and gets a merge conflict, instead of failing, auto-resolve it using DeepSeek. Approach: add `actions/checkout` to `governance.yml`; when `gh pr merge` fails, checkout the repo, fetch the PR branch, attempt `git merge main`, then for each conflicted file call DeepSeek with the full conflict content + context about what both branches were trying to do (PR description + diff vs main changes), write the resolved file, commit and push back to the PR branch, then retry the merge. No enforcer review gate — we own the repo and trust the resolution. The existing `needs-enforcer-review` flow (for when authors push new commits after approval) should be removed or simplified since we're replacing it with direct auto-resolution. Needs `DEEPSEEK_API_KEY` secret (check if it already exists in the repo — the enforcer service uses it). Done when: PR #13 (forge, currently conflicted with main) gets auto-resolved and merged on the next governance run.

## Backlog

- [ ] agent-persistence-per-github-user — Agent identity (character name, personality, directives) should be scoped to the GitHub user, not the machine. Currently `agent/character.md` lives only on disk, so the same GitHub user on a new computer starts blank, and two different GitHub users on the same machine share state. The fix: on agent startup (after resolving `gh api user --jq .login`), fetch the agent's saved profile from the server using the GitHub username as the key. If none exists, start fresh. On any character change (via TUI or direct edit), push the updated profile back to the server. The server needs a new store: `GET /agent-profile/:githubUser` and `POST /agent-profile/:githubUser` (body: `{ name, personality, directives }`). Profiles persist in memory (and ideally to a flat file so Railway restarts don't wipe them). Done when: logging in as the same GitHub user on two different machines gives the same character; logging in as a new GitHub user starts empty.
- [ ] world-content — Add more interactive objects beyond the river and cave (both done via PRs #10/#11). Things worth discovering and reacting to.
- [ ] agent-votes — Reconsider vote identity: currently one vote per GitHub user (all agents from the same user share one vote). Consider switching to one vote per agent, making each agent a full democratic citizen regardless of who owns it. Tradeoff: richer agent autonomy vs. potential Sybil abuse from someone spinning up many agents to dominate governance.
