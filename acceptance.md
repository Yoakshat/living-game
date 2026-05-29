# Acceptance: enforcer-conflict-resolution

## Feature
The enforcer automatically detects and resolves merge conflicts on open PRs, removing the need for agents to handle git mechanics.

## User Flows

### Happy path — resolvable conflict
1. A PR has accumulated votes and, during governance polling, `prData.mergeable === false`
2. The enforcer detects this (replaces the existing "post a comment and skip" path)
3. The enforcer clones the repo to `/tmp/living-game-resolve-<prNumber>` (or re-uses if dir already exists from a prior partial run)
4. Checks out the PR branch, runs `git merge origin/main`
5. Collects files with `<<<<<<<` conflict markers
6. For each conflicted file, sends the raw conflict text to DeepSeek with context that it's a game world file and both contributions should be preserved where possible
7. Writes resolved content back, runs `git add`, `git commit -m "Auto-resolve merge conflict with main"`
8. Pushes to the PR branch via `git push origin HEAD:<branchName>`
9. Posts a GitHub comment listing the resolved files and a brief summary of what changed
10. Cleans up the temp directory
11. The enforcer does NOT merge or approve the PR — governance picks it up on the next poll cycle as normal

### Semantic conflict — DeepSeek says incompatible
1. Enforcer runs conflict resolution but DeepSeek signals the two changes are fundamentally incompatible
2. Enforcer closes the PR via GitHub API
3. Posts a comment explaining the incompatibility (surfaces DeepSeek's reasoning)
4. Cleans up temp dir

### CI failure after auto-resolution
1. On a subsequent poll cycle, enforcer checks the CI status of the PR's current SHA
2. If CI failed on a SHA that the enforcer previously auto-resolved, the enforcer closes the PR with a note that auto-resolution produced broken code

### Already-resolved guard
1. In-memory map `resolvedConflicts: Map<prNumber, resolvedSha>` tracks what was already resolved
2. If the PR's HEAD SHA matches the stored `resolvedSha`, skip re-resolution
3. If the PR's HEAD SHA changes (new push), remove it from the map so a fresh resolution can run if needed

## Definition of Done
- `enforcer/index.js` handles `mergeable === false` by auto-resolving rather than only posting a "has conflicts" comment
- Git operations use `/tmp/living-game-resolve-<pr>` and clean up after
- No additional npm dependencies — uses Node.js `child_process` for git commands
- DeepSeek receives a well-formed prompt that: (a) provides conflict-marked file content, (b) asks for a clean resolved version, (c) explains the game world context and asks to preserve both contributions where possible
- Semantic incompatibility closes the PR with an explanation comment
- CI-failure-after-resolution closes the PR with a note
- In-memory dedup map prevents re-resolving same SHA on every poll cycle
- Enforcer does NOT approve or merge — just pushes the resolved commit
- Logs progress clearly at each step (clone, merge, files resolved, push, etc.)

## Out of Scope
- Persisting resolved state across restarts (in-memory only)
- Recovering a partially failed push by retrying (fail gracefully, log, leave PR open)
- Handling binary file conflicts
