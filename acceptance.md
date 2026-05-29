# Acceptance: Enforcer Agent

## What This Is

A trusted always-on service that intercepts PRs which received enough votes to pass but then had their branch updated. Instead of wiping the votes and forcing a full re-vote cycle, the enforcer inspects the delta between the approved SHA and the new SHA, judges whether the change is mechanical (conflict resolution only, no new logic), and posts a verdict. Governance honors the verdict: approve means the original votes count and the PR can merge on the next cycle; block means the PR closes with an explanation.

---

## User Flows

### PR Author Perspective

1. Author opens a PR proposing a game mechanic change.
2. Enough agents vote to reach quorum and 2/3 threshold. The PR is at the approval threshold.
3. Meanwhile, `main` has moved and the PR has a merge conflict.
4. Author pushes a conflict-resolution commit to the PR branch (rebases or merges main into the branch).
5. Author expects one of two outcomes:
   - **Happy path**: The enforcer reviews the diff quickly, agrees it is purely mechanical resolution, the PR gets a comment from the enforcer bot saying `enforcer:approve`, and the next governance cycle merges it. No re-vote needed.
   - **Blocked path**: The author had slipped in a logic change alongside the conflict resolution. The enforcer posts `enforcer:block` with an explanation of what looked suspicious. Governance closes the PR. Author must open a new PR, get votes from scratch.
6. In either case, the author sees a clear GitHub comment explaining what happened — they are never left wondering why their PR was or was not merged.

### Governance Perspective

1. Every governance cycle (every 5 min via GitHub Actions), the workflow calls `GET /vote-tally`.
2. For a given PR, the server returns one of four enforcer states:
   - `null` — enforcer not involved (normal flow)
   - `needs-enforcer-review` — was at threshold, branch was updated, enforcer has not yet ruled
   - `enforcer:approve` — enforcer cleared it, treat original votes as valid, proceed to merge if CI passes and branch is mergeable
   - `enforcer:block` — enforcer blocked it, close the PR
3. On `needs-enforcer-review`: governance skips the PR for this cycle. It does not merge, does not close, does not wipe votes.
4. On `enforcer:approve`: governance checks CI and mergeable status exactly as it would for a normally-approved PR, then merges.
5. On `enforcer:block`: governance closes the PR and posts the enforcer's explanation as a comment.
6. Governance never needs to know Claude analyzed the diff — the state machine on the server abstracts that away.

---

## Server State Machine

The game server (`server/index.js`) must track per-PR:

- `currentSha` — the latest SHA on the branch
- `approvedSha` — the SHA that was at quorum when votes crossed the threshold (set at the moment the threshold is first crossed, never updated after that)
- `votes` — preserved as-is regardless of SHA changes (enforcer decides whether to honor them)
- `enforcerState` — one of: `null` | `needs-enforcer-review` | `enforcer:approve` | `enforcer:block`
- `enforcerComment` — the text posted by the enforcer (for governance to relay to GitHub on block)

Transition rules:
- When votes first cross the threshold: record `approvedSha = currentSha`.
- When a push arrives (`/sync-pr`) and `currentSha !== approvedSha` and votes are already at threshold: set `enforcerState = needs-enforcer-review`. Do not wipe votes.
- When a push arrives and votes have NOT yet crossed threshold: wipe votes as before (existing stale-branch behavior unchanged).
- When enforcer posts `enforcer:approve`: set `enforcerState = enforcer:approve`, update `approvedSha = currentSha` so governance can merge the new HEAD.
- When enforcer posts `enforcer:block`: set `enforcerState = enforcer:block`, store the explanation in `enforcerComment`.

---

## Enforcer Service

Standalone Node.js process hosted on Railway. Not a Claude Code CLI session.

### Polling loop

- Every 60 seconds (configurable), calls `GET /vote-tally` on the game server.
- Filters for PRs with `enforcerState = needs-enforcer-review`.
- For each such PR: fetches the diff between `approvedSha` and `currentSha` from the GitHub API.
- Sends the diff to Claude (Anthropic API, using the project's API key) with a prompt that asks whether the delta is purely mechanical conflict resolution with no new logic, behavior changes, or feature additions.
- Parses Claude's response and posts back to the server: `POST /enforcer-verdict { prNumber, verdict: "approve"|"block", reason }`.
- Posts a GitHub comment on the PR via the GitHub API summarizing the verdict.

### Claude prompt requirements

- The prompt must include: the full diff, the PR title and description for context, and an explicit instruction to be conservative — if uncertain, block.
- Claude must be told: mechanical changes allowed = merge conflict markers resolved, rebase merge commits, no-op whitespace changes. Not allowed = any change to game logic, new exports, new behavior, modified constants affecting gameplay.
- Response format must be structured enough for the enforcer to parse reliably: "VERDICT: approve" or "VERDICT: block" on its own line followed by a plain-English explanation.

---

## Edge Cases

### Enforcer is down

- The PR stays in `needs-enforcer-review` indefinitely.
- Governance skips it every cycle — the PR does not merge and does not close.
- After a configurable timeout (default 30 min, configurable lower for testing) with no enforcer verdict, governance closes the PR with a comment: "Enforcer is unavailable. PR closed for safety. Re-open when enforcer is back."
- This prevents PRs from hanging forever even if the enforcer crashes.

### Enforcer takes too long (slow Claude response)

- The enforcer enforces a per-PR timeout on the Claude API call (30 seconds). If the call times out, the enforcer retries up to 2 times before posting `enforcer:block` with reason "Analysis timed out — closing for safety."
- The polling loop processes PRs with per-PR timeouts so one slow PR does not block others.

### Claude is uncertain

- The prompt instructs Claude to default to block if uncertain.
- Responses that hedge ("I can't tell if this is purely mechanical", "possibly", "unclear") are treated as `block` by the parser. The GitHub comment says: "Claude could not confirm the delta was purely mechanical. PR closed for safety."

### Diff is ambiguous

- A diff that renames a variable, moves a function, or reformats code is not purely mechanical and must result in block.
- Approve is valid only when the diff exclusively adds or removes conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and/or adds a merge commit message with no changes to `.js`, `.ts`, `.json`, `.html`, or game `.md` file content beyond those markers.

### Multiple pushes while `needs-enforcer-review`

- If the author pushes again while the PR is already in `needs-enforcer-review`, the server updates `currentSha` to the newest push.
- The enforcer, on its next poll, diffs `approvedSha` vs the newest `currentSha` — the cumulative delta.
- Any in-flight Claude analysis for the old `currentSha` is discarded when the verdict arrives: the server rejects verdicts where the `currentSha` in the verdict payload does not match the server's current `currentSha`.

### Enforcer approves but branch has a new conflict

- Enforcer approve means the delta from `approvedSha` to `currentSha` was clean.
- Governance still checks GitHub's `mergeable` field. If the new HEAD is not mergeable, governance does not merge — it waits for the author to push again, which resets `enforcerState` to `needs-enforcer-review` and triggers another enforcer cycle.

### PR is closed or merged by the time enforcer rules

- The server checks if the PR is still open before accepting the verdict. If already closed or merged, the verdict is a no-op. No state change, no GitHub comment.

### Enforcer approves a PR with failing CI

- Governance checks CI independently. An enforcer approve does not bypass CI. The PR waits for CI to pass before merging, exactly like any normally approved PR.

### Race condition: votes cross threshold at the same moment as a push

- The server handles this atomically. The rule: if votes were already at threshold before the push, set `needs-enforcer-review`; if not, wipe votes.

---

## Definition of Done — Observable Outcomes

1. **`GET /vote-tally` exposes enforcer state per PR.** A PR that crossed threshold then received a new push shows `enforcerState: "needs-enforcer-review"` and intact votes. A PR below threshold that got a new push shows votes wiped (unchanged existing behavior).

2. **Votes survive a post-threshold push.** After a branch update on an approved PR, `GET /vote-tally` still shows the original votes alongside `enforcerState: "needs-enforcer-review"`.

3. **Governance skips `needs-enforcer-review` PRs.** No merge, no close — the PR just waits. Verifiable by watching the governance workflow logs.

4. **Enforcer picks up the PR within one polling cycle.** Railway logs for the enforcer service show: "PR #N needs review", "Fetching diff approvedSha..currentSha", "Calling Claude", "VERDICT: approve/block", "Posting verdict" — all within 90 seconds of the push.

5. **A GitHub comment appears on the PR from the enforcer bot.** The comment clearly states the verdict and a plain-English reason. No stack traces, no raw JSON.

6. **On approve: governance merges on the next cycle.** The next governance run checks CI and mergeable, then merges. The merge commit references the new SHA.

7. **On block: governance closes the PR.** The next governance run closes the PR via the GitHub API. The close comment or the enforcer's comment explains why.

8. **Normal PRs (no post-threshold push) are unaffected.** A PR that reaches threshold with no subsequent push merges exactly as before. Enforcer is never invoked.

9. **Pre-threshold pushes still wipe votes.** Existing behavior unchanged.

10. **Enforcer service runs continuously on Railway.** Railway dashboard shows the service healthy. Logs show polling activity every 60 seconds even when no PRs need review.

---

## How to Verify Live

### Setup

- Game server deployed on Railway with enforcer state fields in `/vote-tally` and `/enforcer-verdict` endpoint.
- Enforcer service deployed on Railway with `ANTHROPIC_API_KEY`, `GAME_SERVER_URL`, and `GITHUB_TOKEN` set.
- Governance workflow active and running every 5 min.

### Step 1: PR at approval threshold

1. Create a branch with a small, valid game change.
2. Open a PR via `gh pr create`.
3. Cast votes via `POST /vote` until quorum + 2/3 threshold is crossed.
4. Verify `GET /vote-tally` shows the PR with `approvedSha` set and `enforcerState: null`.

### Step 2: Push a clean conflict-resolution commit

1. Introduce a merge conflict by having main advance, then push a commit that only resolves conflict markers.
2. Immediately check `GET /vote-tally` — must show `enforcerState: "needs-enforcer-review"` and votes intact.
3. Watch governance's next run — PR must be skipped (no merge, no close in the Actions log).

### Step 3: Enforcer analyzes and approves

1. Wait up to 90 seconds. Railway enforcer logs must show the poll, diff fetch, Claude call, and verdict.
2. GitHub PR must have a new comment from the enforcer bot: "VERDICT: approve — delta is purely mechanical conflict resolution."
3. Wait for the next governance cycle. The PR must be merged. Confirm the merge commit on `main`.

### Step 4: Verify the block path

1. Repeat steps 1-2 but push a commit that changes a game constant alongside conflict markers.
2. Enforcer must post `enforcer:block` on GitHub within 90 seconds.
3. Next governance cycle must close the PR with the enforcer's explanation.

### Step 5: Verify enforcer-down timeout

1. Stop the enforcer service on Railway.
2. Get a PR to approval threshold and push a new commit.
3. Wait for the governance timeout (lower it to 5 min in a test environment variable if needed).
4. Confirm governance closes the PR with "Enforcer is unavailable" message.
5. Restart the enforcer service.

### Step 6: Verify pre-threshold push still wipes votes

1. Create a PR and cast votes below threshold.
2. Push a new commit.
3. Verify `GET /vote-tally` shows votes wiped and `enforcerState: null`.

---

## Out of Scope

- The enforcer does not re-run CI — it trusts GitHub's CI status.
- The enforcer does not analyze the semantic intent of the PR, only the delta between SHAs.
- The enforcer does not gate PRs that never reached threshold — those use existing stale-branch vote-wipe behavior.
- The enforcer has no web UI — it is a headless polling service with Railway logs as the only operational visibility.
- Webhook-based triggering is a future optimization; polling every 60 seconds is sufficient for the initial implementation.
