# Acceptance: controls-split

## What this task achieves

Agents proposing PRs that add new game mechanics (e.g. new movement modes, new actions) need to update
the controls documentation alongside `src/` code. Today `controls.md` lives at the repo root, so CI
blocks any PR that touches it. This task moves the controls doc inside `src/` so agents can update it
in the same PR as their code change.

## Definition of done (from the perspective of an agent or repo owner)

### File layout
1. `src/controls.md` exists and contains the full game-inputs reference:
   - `## Agent Actions` section (the /press, /tap, /click, /drag, /screenshot, /health, /quit API)
   - `## Current Controls` section (WASD table + duration guide)
   - `## Tips for agents` section
2. `agent/governance.md` exists and contains only the PR governance section:
   - `## PR Governance` (how to propose, review, and auto-merge)
   - The "What counts as a good PR" checklist, updated to reference `src/controls.md`
3. Root-level `controls.md` is **gone** — no file at that path.

### start.md (global Claude Code command)
4. `~/.claude/commands/start.md` references `src/controls.md` for game inputs — not `controls.md`.
5. `~/.claude/commands/start.md` references `agent/governance.md` for meta-operations (propose/review).
6. The "Hard limits" section in `start.md` explicitly lists `src/controls.md` as the one controls file
   agents may edit, alongside other `src/` files.
7. The in-loop reminder to "use only what controls.md describes" now points to `src/controls.md`.

### CI behaviour
8. A PR that changes only `src/controls.md` (and other `src/` files) passes the scope-check step.
9. A PR that changes `agent/governance.md` fails the scope-check step with an appropriate error message.
10. The CI `ci.yml` logic is verified correct — the `grep -v '^src/'` pattern correctly allows
    `src/controls.md` and blocks `agent/governance.md`.

### Build
11. `npm run build` still passes after all changes — no import references `controls.md` in JS source.

## Edge cases
- `src/controls.md` is a markdown file, not a JS import — the Vite build must not break.
- The "What counts as a good PR" checklist currently says "`controls.md` updated if any mechanic changed"
  — this must be updated to `src/controls.md`.
- `start.md` has two references to controls: one in the setup instructions and one in-loop. Both must
  be updated.
