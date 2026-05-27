# Acceptance: agent-loop

Locked definition of done for the autonomous agent loop. Scope is a Node.js
script that drives a real browser via Playwright, feeds screenshots to Claude,
and executes the resulting movement decisions in-game — indefinitely, without
human input.

The defining constraint: a single agent must open the live game, read its own
`character.md`, and wander the world for 5 full minutes without crashing,
hanging, or requiring any human action.

---

## 1. Setup & startup

- `ANTHROPIC_API_KEY` env var is required. If missing, the agent exits
  immediately with a clear, human-readable error message — no stack trace,
  just "ANTHROPIC_API_KEY is not set. Export it and try again."
- `character.md` is read from the agent directory at startup. A default
  template ships with the repo so the agent works out of the box without any
  user editing.
- `npm install` inside the `agent/` directory installs all dependencies with
  no manual steps beyond that.
- Agent starts with `node agent/agent.js` OR `npm start` from within `agent/`.
- A `~/.claude/commands/start.md` slash-command file exists so Claude Code
  users can type `/start` to launch the agent without knowing the exact
  command.
- The agent opens `https://yoakshat.github.io/living-game/` and waits until
  the game world is visibly rendered (Phaser canvas present, not a
  blank/loading screen) before the first decision cycle begins.

---

## 2. Decision loop

Each cycle executes in order:

1. **Screenshot** — captures the current game viewport.
2. **API call** — sends the screenshot plus the full contents of `character.md`
   to Claude (model: `claude-haiku-4-5`) with a system prompt that instructs
   it to return a structured action.
3. **Parse** — extracts a structured action from the response:
   - `keys`: array of WASD keys to hold simultaneously (e.g. `["w", "d"]`)
   - `duration`: milliseconds to hold those keys (e.g. `800`)
   - `reason` (optional): short string explaining the decision
4. **Execute** — holds the specified keys for the specified duration via
   Playwright, then releases all keys.
5. **Log** — prints a single line: timestamp, keys, duration, reason.
6. Repeat immediately (target: ≤ 3 seconds total per cycle under normal
   network conditions).

---

## 3. Claude response contract

- Claude must return a JSON object (inline in the response or wrapped in a
  code block) containing at minimum `keys` and `duration`.
- If the response is missing, malformed, or unparseable, the agent logs a
  `[WARN]` line and skips to the next cycle — it does not throw or exit.
- If the API call fails (network error, rate limit, timeout), the agent logs
  an `[ERROR]` line, waits one cycle interval, and continues — it does not
  exit.
- The `reason` field, when present, must reflect what was visible on screen
  (e.g., "open field ahead, heading north-east") not generic filler — this is
  enforced by the system prompt.

---

## 4. Character context

- The full text of `character.md` is included in every Claude API call.
- The default `character.md` template includes: character name, personality
  adjectives, movement tendencies, and goals.
- Players can edit `character.md` to customize; the agent picks up changes on
  the next run (not hot-reloaded mid-run).
- Movement decisions must feel distinct from a character with a different
  `character.md` — a cautious character should hug walls; an explorer should
  seek new terrain.

---

## 5. Observable movement behavior

- The agent's character appears in the game world and its position changes
  visibly over time — it does not stand still.
- Over a 5-minute unattended run the character travels in at least 3 distinct
  compass directions (logged keys confirm this — not just "w" every cycle).
- The agent does not get permanently stuck walking into a wall for more than
  ~10 seconds — it must eventually change direction.
- Movement decisions are informed by screen content: the `reason` field in
  logs references visible features (terrain, obstacles, other players) not
  generic phrases.

---

## 6. Robustness

- If Playwright loses the page (navigation error, page crash, detached frame),
  the agent attempts `page.reload()` once before giving up on that cycle and
  continuing the loop.
- Ctrl+C (SIGINT) stops the agent cleanly: keys are released, the browser
  closes, and no zombie Chromium processes remain.
- The agent runs for a full 5 minutes in a real test without crashing,
  hanging, or exiting on its own.

---

## 7. Logging format

Each cycle produces exactly one log line (plus warn/error lines when needed):

```
[HH:MM:SS] keys=["w","d"] duration=900ms reason="heading toward clearing"
[WARN] Unparseable Claude response, skipping cycle
[ERROR] API call failed: fetch timeout, retrying next cycle
```

---

## 8. Definition of done — tester checklist

- [ ] `node agent/agent.js` with no `ANTHROPIC_API_KEY` exits with a clear
      error message, not a stack trace.
- [ ] `node agent/agent.js` with a valid key opens the browser, loads the
      game, and starts the loop without any human interaction.
- [ ] First screenshot is taken only after the game canvas is visible
      (verified by log timestamp vs. page load time).
- [ ] Every cycle produces a log line with keys, duration, and reason.
- [ ] Agent runs for 5 full minutes without crashing or requiring input.
- [ ] Over the 5-minute run, logs show at least 3 distinct directions of
      movement (keys vary — not all "w" or all one combination).
- [ ] Injecting a malformed Claude response (by temporarily breaking the
      prompt) produces a `[WARN]` log line and the loop continues.
- [ ] Pressing Ctrl+C stops the agent; no Chromium process remains in `ps`.
- [ ] `/start` in Claude Code runs the agent (verifiable by checking
      `~/.claude/commands/start.md` exists and contains the correct command).
- [ ] A watcher observing the live game URL sees the agent's character moving
      around the world during the 5-minute run.

---

## Out of scope

- Voting, inventory, combat, PR creation, multi-agent coordination.
- Hot-reloading `character.md` mid-run.
- Server-side validation of agent actions.
- Any UI for the agent — it is a headless CLI process.
