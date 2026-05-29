# Living Game — Enforcer Service

A standalone Node.js service that reviews PRs which received enough votes to be approved but then had their branch updated. It inspects the diff, calls Claude to judge whether the change is purely mechanical conflict resolution, and posts a verdict back to the game server.

## How it works

1. Polls `GET /vote-tally` every 60 seconds
2. For each PR with `enforcerState = needs-enforcer-review`:
   - Fetches the diff between `approvedSha` and `newSha` via GitHub API
   - Sends the diff to Claude (`claude-sonnet-4-6`) with a conservative prompt
   - Parses Claude's `VERDICT: approve` or `VERDICT: block` response
   - Posts the verdict to `POST /enforcer-verdict` on the game server
   - Posts a GitHub comment explaining the decision

## Required environment variables

All three must be set as Railway environment variables before the service will start:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude calls. Get from https://console.anthropic.com/settings/keys |
| `SERVER_URL` | Game server Railway URL, e.g. `https://living-game-server-production.up.railway.app` |
| `GITHUB_TOKEN` | GitHub personal access token with `repo` scope (for reading diffs and posting comments). Generate at https://github.com/settings/tokens |

## Deploying on Railway

1. In the Railway dashboard, open the `living-game` project.
2. Click **New Service** → **GitHub Repo**.
3. Select the `Yoakshat/living-game` repo.
4. Under **Root Directory**, set it to `enforcer/`.
5. Railway will detect the `Procfile` and run `node index.js` as a worker (no web port needed).
6. Go to the service **Variables** tab and add:
   - `ANTHROPIC_API_KEY` = your Anthropic key
   - `SERVER_URL` = `https://living-game-server-production.up.railway.app`
   - `GITHUB_TOKEN` = your GitHub token with `repo` scope
7. Deploy. Railway logs will show `[enforcer] Starting.` and then poll activity every 60 seconds.

## Optional environment variables

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | `60000` | How often to poll the server (milliseconds) |

## Verifying it works

In Railway logs you should see every 60 seconds:
```
[enforcer] Polling /vote-tally...
[enforcer] No PRs pending enforcer review.
```

When a PR is in enforcer review:
```
[enforcer] PR #42 needs review — approvedSha=abc1234 newSha=def5678
[enforcer] PR #42 fetching diff abc1234...def5678
[enforcer] PR #42 diff fetched (1234 chars)
[enforcer] PR #42 calling Claude
[enforcer] PR #42 Claude response: VERDICT: approve\nREASON: ...
[enforcer] PR #42 VERDICT: approve — Delta is purely mechanical conflict resolution.
[enforcer] PR #42 verdict posted: {"status":"approved"}
[enforcer] PR #42 GitHub comment posted
```
