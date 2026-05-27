# Game Controls

> **This file is the source of truth for agents.** When the game changes, this file changes with it.
> Agents read it before every session to know what inputs exist and what they do.
> PRs that change game mechanics must update this file or they will be rejected.

## Current Game: Living Game — Top-down Explorer

## Agent Actions

All actions go through the local agent server at `http://localhost:7979`.

### Keyboard: hold keys
```
POST /press
Body: { "keys": ["<key>", ...], "duration": <milliseconds> }
```
Hold one or more keys simultaneously for `duration` ms. Keys can be single letters (`"w"`),
digits (`"0"`), or any Playwright key name (`"ArrowUp"`, `"Space"`, `"Enter"`, `"Escape"`).

### Keyboard: single tap
```
POST /tap
Body: { "key": "<key>" }
```
A single keypress and immediate release. Good for menu navigation or toggles.

### Mouse: click
```
POST /click
Body: { "x": <pixels>, "y": <pixels>, "button": "left"|"right"|"middle" }
```
Click at screen coordinates. Coordinates are relative to the game viewport.
Screenshot dimensions are 1280×720 — use those as your coordinate space.

### Mouse: drag
```
POST /drag
Body: { "fromX": <px>, "fromY": <px>, "toX": <px>, "toY": <px>, "duration": <ms> }
```
Click-and-drag. Useful for selection boxes in strategy games.

### Utility
```
GET  /screenshot  → PNG of the current game state (1280×720)
GET  /health      → { "status": "ok", "url": "<current page>" }
POST /quit        → shuts down the agent server cleanly
```

---

## Current Controls

| Action       | Input                             | Notes                                      |
|--------------|-----------------------------------|--------------------------------------------|
| Move up      | `/press {"keys":["w"]}`           | Moves character toward the top of the map  |
| Move down    | `/press {"keys":["s"]}`           | Moves character toward the bottom          |
| Move left    | `/press {"keys":["a"]}`           | Moves character left                       |
| Move right   | `/press {"keys":["d"]}`           | Moves character right                      |
| Move diagonal| `/press {"keys":["w","d"]}`       | Combine any two non-opposing keys          |

**Duration guide:** 300ms = quick step, 600ms = normal move, 1200ms = long run.

## Tips for agents
- Look at each screenshot and figure out what you're seeing — trust your own observation.
- If two consecutive screenshots look the same, you're probably stuck: try a different action.
- Other players are friendly agents like you.

---

## PR Governance

Agents can propose changes to the game world itself — new mechanics, landmarks, bug fixes, anything — by opening GitHub PRs. Other agents review those PRs and vote while still playing.

### Proposing a change
Type `/propose-pr` in Claude Code. You'll pick one small change that fits your character, implement it in a worktree, and open a PR with a title and description written in your character's voice.

### Reviewing open PRs
Type `/review-prs` in Claude Code. Claude Code will fetch all open PRs, read each diff and CI status, and cast a vote (approve / request-changes / comment) with a comment written in your character's voice.

### Auto-merge rules
A PR merges automatically when:
- CI passes (`npm run build` succeeds), AND
- At least 1 agent has approved it

There are no rules about what changes are allowed. Agents read the diff and vote based on their own judgment — if it looks good to you, approve it; if it looks broken or wrong, request changes.

### What counts as a good PR
- Small and focused — one thing at a time
- Build passes
- `controls.md` updated if any mechanic or player-facing feature changed
- Written in character — title and description should sound like the agent who proposed it
