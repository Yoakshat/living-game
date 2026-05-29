# Acceptance Criteria: GitHub Profile Identity

## Feature overview
The leaderboard and voting system tracks GitHub profiles instead of individual socket connections. A player with 3 agents running should still count as one identity for leaderboard aggregation and voting.

## User flows

### 1. Agent connects with GitHub identity
- When `agent/server.js` starts, it runs `gh api user --jq .login` to obtain the GitHub username of the machine's logged-in user.
- The GitHub username is passed as the query param `?gh=<username>` when navigating to the game URL (alongside the existing `?characterName=` param).
- If `gh api user` fails (not logged in, no gh CLI), the agent falls back gracefully — it still opens the game without the `?gh=` param.
- `WorldScene.js` reads `new URLSearchParams(window.location.search).get('gh')` and sends `githubUser` alongside the character name in the `player:identify` event.

### 2. Server stores GitHub username per socket
- `server/index.js` stores `githubUser` on each player entry (alongside `id`, `color`, `name`).
- If no GitHub username was sent, `githubUser` is `null`.
- The assigned animal name is still used as the in-game display name.

### 3. Leaderboard aggregates by GitHub profile
- `GET /leaderboard` aggregates entries by `githubUser` when present.
- Multiple sockets sharing the same `githubUser` have their `prsmerged` and `worldChanges` summed.
- Players without a `githubUser` appear as individual entries keyed by their assigned name.
- Response shape per entry: `{ displayName, githubUser, color, prsmerged, worldChanges }`.
- `displayName` is the `githubUser` when present, otherwise the assigned animal name.

### 4. One vote per GitHub profile per PR
- Votes are keyed by `githubUser` (or fall back to socket ID if `githubUser` is null).
- If a user's second agent tries to vote on the same PR, the vote is silently ignored (already voted).
- The vote from their first agent remains in effect.
- Counting (yes/no) reflects unique voters, not socket count.

### 5. Self-voting is blocked
- When a `pr:vote` event arrives, the server checks if the voter's `githubUser` matches the PR author's GitHub username (`pr.authorGithubUser`).
- If they match, the vote is rejected (no-op, logged to console).
- The PR author's GitHub username is stored on the PR entry when it is first tracked — pulled from the GitHub API (the PR's `user.login` field from the pulls endpoint).
- PRs with `authorGithubUser: null`: self-vote blocking is skipped (can't tell who the author is).

## Edge cases
- Agent without gh CLI: `gh api user` command fails — agent opens game without `?gh=` param. Works exactly like before.
- Two agents same GitHub user: leaderboard shows one row, votes deduped.
- Player with no `githubUser` votes: vote is keyed by socket ID (existing behavior).
- PR with no `authorGithubUser`: self-vote block is not enforced (insufficient data).
- GitHub username contains special characters: URL-encoded when passed as query param.

## Definition of done
- `npm run build` passes without errors.
- Agent startup logs the resolved GitHub username (or "no GitHub user detected").
- Leaderboard endpoint returns aggregated data (manually verifiable by reading the code logic).
- Vote dedup logic is clearly keyed by `githubUser || socket.id`.
- Self-vote block fires when `voter.githubUser === pr.authorGithubUser` (both non-null).
- PR author stored on first `pollGitHub` that discovers the PR.
