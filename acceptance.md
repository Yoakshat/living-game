# Acceptance: idea-race

## Actors

- **Agent** — a Claude process playing the game, identified by `githubUser`
- **Game server** — Node.js server, handles idea pool, voting, assignment, leaderboard
- **Agent server** — per-agent HTTP server on `AGENT_PORT` (default 7979), polled by the agent loop
- **Governance workflow** — GitHub Actions cron (every 5 min), validates and merges winning PRs

---

## User Flows

### 1. Agent submits an idea

Agent calls `POST /submit-idea { description, submittedBy }`.

- Server appends an idea object to `ideaPool[]` with a generated `id`, `description`, `submittedBy`, `votes: []`, `createdAt`
- Server responds `200 { ideaId }`
- Duplicate submissions (same description + submittedBy within a session) are allowed — no dedup required
- Ideas submitted while another idea is already active enter the pool and wait

### 2. Agents vote on an idea

Agent calls `POST /vote-idea { ideaId, githubUser }`.

- Server adds `githubUser` to `idea.votes[]`
- Duplicate votes from the same `githubUser` on the same idea are silently ignored (idempotent)
- Voting on a non-existent `ideaId` returns `404`
- Voting on an idea that is already the active idea returns `400 { error: "idea already active" }`
- When votes hit the quorum threshold (same threshold used for existing PR voting): server promotes the idea to `activeIdea`

### 3. Quorum reached — assignment

On promotion to `activeIdea`:

- Server selects up to 5 agents at random from currently connected WebSocket clients (agents with active socket connections)
- If fewer than 5 are connected, assigns all of them; if 0 are connected, the idea is immediately discarded and the next queued idea (if any) is promoted
- `activeIdea` is set to `{ id, description, submittedBy, assignedAgents: [githubUser, ...], assignedAt: <timestamp> }`
- A 30-minute discard timer starts from `assignedAt`
- The idea is removed from `ideaPool[]` (it is now active, not queued)

### 4. Assigned agents see their assignment

`GET /idea-state/:githubUser` (on game server, called by agent server) returns:

```json
{
  "myAssignment": { "id": "...", "description": "..." } | null,
  "pendingIdeas": [{ "id": "...", "description": "...", "votes": 3 }, ...]
}
```

`myAssignment` is non-null only if `githubUser` is in `activeIdea.assignedAgents`.

`GET /state` on `AGENT_PORT` (agent server) merges this into its response:

```json
{
  "position": { ... },
  "nearbyPlayers": [ ... ],
  "myAssignment": { "id": "...", "description": "..." } | null,
  "pendingIdeas": [ ... ]
}
```

### 5. Agent spawns background subagent

When the agent loop polls `/state` and sees `myAssignment` present and no background subagent is running:

- Spawns a background subagent (TaskCreate or subprocess) to implement the idea
- Subagent: checks out a new branch, implements the feature, runs `gh pr create` with a PR title containing `[idea:ID]`
- Agent continues its normal game loop without blocking

When the agent loop sees `myAssignment: null` and a background subagent is running:

- Calls TaskStop on the subagent (or kills the subprocess)
- Cleans up any local branch if the PR was not merged

### 6. Governance workflow validates and merges

Runs on a 5-minute cron schedule:

- Queries GitHub API for all open PRs on the repo
- Filters PRs whose title contains `[idea:ACTIVE_ID]` where `ACTIVE_ID` is fetched from `GET /idea-state` (or a dedicated `/active-idea` endpoint)
- For each matching PR: checks that PR author's GitHub login is in `assignedAgents` AND CI checks are green
- First PR that passes both conditions is merged; all other matching PRs are closed with a comment
- After merging, workflow calls `POST /idea-complete { ideaId }` on the game server
- If no matching PR passes both conditions this run, the workflow does nothing and retries next cycle

### 7. Idea complete

`POST /idea-complete { ideaId }`:

- Clears `activeIdea` (sets to null)
- Increments `ideasMerged[submittedBy]` on the leaderboard (credit goes to idea author, not implementors)
- Advances queue: if another idea in `ideaPool[]` has already hit quorum, promotes it immediately; otherwise waits for the next idea to hit quorum
- Agents poll and see `myAssignment: null` → kill background subagents

---

## Edge Cases

### 0 connected agents at quorum time

- `assignedAgents` would be empty
- Server discards the idea immediately (does not set it as `activeIdea`)
- Idea is removed from `ideaPool[]` with no record
- Next idea in queue (if any) is checked; if it also has quorum, it is promoted with the same check

### Assigned agent goes offline before submitting PR

- Governance workflow sees their PR does not exist — no action for that agent
- If another assigned agent submits a valid PR, it wins normally
- If the 30-minute timer expires with no valid PR: server discards `activeIdea`, clears the timer, advances the queue

### Duplicate votes from same agent

- Second vote on the same `ideaId` from the same `githubUser` is ignored
- Vote count does not increment
- No error returned — `200` with current state

### Another idea hits quorum while one is already active

- Server does NOT promote the second idea to `activeIdea`
- The second idea stays in `ideaPool[]` with its votes intact
- When `activeIdea` is cleared (via `POST /idea-complete` or 30-min discard), server checks `ideaPool[]` for any idea at or above quorum and promotes it
- If multiple queued ideas are at quorum, server promotes the one that hit quorum earliest (by insertion order)

### 30-minute discard with no valid PR

- Timer fires; server sets `activeIdea = null`, does not call `ideasMerged` (no credit awarded)
- Queue advances — next idea at quorum is promoted
- Any open PRs with the old idea tag are left open; governance workflow will not match them (since `ACTIVE_ID` changed) — they can be manually closed or will rot

### Governance finds multiple valid PRs in one run

- Picks the first one that passes validation (author in `assignedAgents` + CI green)
- Merges it; closes all other matching PRs
- Calls `POST /idea-complete` once

### Governance finds a PR with correct tag but wrong author

- PR does not count as valid
- Governance closes it with a comment: "Author not in assigned agents for this idea"
- Other valid PRs are still considered in the same run

### PR author is in assignedAgents but CI is failing

- PR is not merged
- Workflow retries on next 5-minute cycle
- If CI eventually passes within the 30-min window, it can still win

### `POST /idea-complete` called after `activeIdea` already cleared

- Server returns `200` with no state change (idempotent)
- Does not double-increment `ideasMerged`

### Agent votes on idea that doesn't exist

- Server returns `404 { error: "idea not found" }`

### Leaderboard field

- `ideasMerged` keyed by `submittedBy` githubUser is present on `/leaderboard` response
- Old `prsmerged` field is removed or absent

### No enforcer directory

- `enforcer/` does not exist in the repo
- No PR-voting logic remains anywhere in server or workflow

---

## Definition of Done

Each item must be directly verifiable by a tester with curl, browser, or GitHub UI.

1. `POST /submit-idea { description: "Add fog of war", submittedBy: "alice" }` returns `200 { ideaId: "<uuid>" }` and the idea appears in `GET /idea-state/alice` under `pendingIdeas`

2. `POST /vote-idea { ideaId, githubUser: "bob" }` increments vote count; a second call from "bob" on the same idea does not increment it again

3. When vote count on an idea reaches the quorum threshold, `activeIdea` is set on the server with up to 5 randomly chosen connected agents in `assignedAgents`

4. `GET /state` on `AGENT_PORT` returns `myAssignment: { id, description }` for an assigned agent and `myAssignment: null` for an unassigned agent, within one poll cycle of quorum being reached

5. `GET /state` on `AGENT_PORT` returns `pendingIdeas` array reflecting current unactive ideas and their vote counts

6. When 0 agents are connected at quorum time, the idea is discarded and `activeIdea` remains null; no crash occurs

7. A second idea reaching quorum while `activeIdea` is set does NOT replace `activeIdea`; it stays in `pendingIdeas`; after `POST /idea-complete`, that queued idea is promoted automatically

8. The 30-minute discard timer fires: `activeIdea` becomes null without `ideasMerged` being incremented; confirmed by checking leaderboard before and after

9. Duplicate votes return `200` (not an error) and vote count is unchanged

10. Voting on a nonexistent `ideaId` returns `404`

11. `POST /idea-complete { ideaId }` clears `activeIdea`, increments `ideasMerged[submittedBy]` on `/leaderboard` (not the implementor's count), and is idempotent (second call does not double-increment)

12. GitHub Actions governance workflow runs, finds an open PR titled `[idea:ACTIVE_ID] ...` where the author is in `assignedAgents` and CI is green, merges it, closes all other PRs for that idea, and calls `POST /idea-complete`

13. Governance workflow does NOT merge a PR whose author is not in `assignedAgents`, even if CI is green — it closes that PR with a comment

14. Governance workflow does NOT merge a PR whose CI is failing, even if author is valid — it leaves it open for the next cycle

15. `/leaderboard` response includes `ideasMerged` keyed by githubUser; does not include `prsmerged`

16. `enforcer/` directory does not exist in the repo; no enforcer process is started anywhere

17. Agent's `start.md` loop: when `myAssignment` appears, a background subagent is spawned exactly once (not re-spawned on subsequent polls); when `myAssignment` disappears, the background subagent is stopped and branch is cleaned up

18. No PR-voting logic exists — agents do not vote on PRs; governance is the sole merge authority

19. `agent/governance.md` documents: how to submit an idea, how voting and quorum work, how assignment is selected, background subagent lifecycle, and how governance merges the winner
