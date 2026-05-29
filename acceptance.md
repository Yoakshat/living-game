# Acceptance: personality-tui

## What This Is

A terminal UI players launch alongside their agent to configure personality and directives, and view the leaderboard. Players already run the agent in a terminal (Claude Code), so a TUI is the most natural companion interface.

---

## User Flows

### Launch
1. Player runs `npm run tui` from the `agent/` directory.
2. TUI opens showing three panels simultaneously.
3. Header displays the character name from `character.md`.
4. No crash on launch, even if server is offline or `## Directives` section is missing.

### Personality Panel (top-left)
1. Shows current personality text from the `## Personality` section of `character.md`.
2. User presses `Tab` or arrow keys to cycle through presets: Diplomat, Explorer, Builder, Schemer.
3. Currently selected/highlighted preset is visually distinct.
4. User presses `e` to enter custom personality edit mode.
5. On selecting a preset or saving custom text, `## Personality` section of `character.md` is updated immediately.

### Directives Panel (bottom-left)
1. Shows current directives from the `## Directives` section of `character.md` as a numbered list.
2. Arrow keys move highlight through directives.
3. Press `a` to add a new directive (prompts for text; capped at 3).
4. Press `d` to delete the highlighted directive.
5. Press `e` to edit the highlighted directive (pre-fills current text).
6. Changes saved immediately to `character.md`.
7. If `## Directives` section does not exist, TUI creates it.

### Leaderboard Panel (right)
1. On open, fetches from game server `/leaderboard` endpoint.
2. Shows players ranked by PRs merged and world changes.
3. Shows name, PRs merged, world changes columns with color indicator.
4. Refreshes every 30 seconds automatically.
5. Shows "No data yet" if response is empty.
6. Shows "Server offline" gracefully if server unreachable — does not crash.

### Exit
- Press `q` or `Ctrl+C` to exit cleanly.

---

## Definition of Done

1. `npm run tui` from `agent/` launches the TUI without errors.
2. All three panels are visible with box borders and labels.
3. Editing personality (preset or custom) persists to `character.md` when re-read.
4. Adding, editing, and deleting a directive persists to `character.md`.
5. Leaderboard panel shows data from `/leaderboard` (even zeroed stats are valid).
6. Server offline shows graceful message, not a crash.
7. `q` or `Ctrl+C` exits cleanly.
8. `npm run build` still passes from the repo root.
9. `agent/README.md` documents how to launch the TUI.
10. `agent/character.md` has a `## Directives` section.
11. `GET /leaderboard` endpoint exists on the server and returns `[{ name, color, prsmerged, worldChanges }]`.

---

## Edge Cases
- Missing `## Directives` in `character.md` → TUI creates the section automatically.
- Server unreachable → leaderboard shows "Server offline", TUI continues running.
- Missing `character.md` → TUI shows error and exits cleanly (no stack trace).
- Directives at cap (3) and `a` pressed → shows "Max 3 directives" notice.
- Custom personality empty string → discard, keep previous value.
- Terminal smaller than 80x24 → panels may truncate but TUI does not crash.
