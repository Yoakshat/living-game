# Acceptance: multi-agent-tui

## What This Is

A persistent multi-agent manager TUI that replaces the single-character TUI.
Instead of managing one `character.md`, it manages a roster of named agents,
each with their own personality and directives, stored under `agent/agents/<slug>/`.

---

## Layout

Three panels left-to-right:

### Left panel — Agent Roster (~35% width)
- Lists all agents discovered by scanning `agent/agents/*/character.md`
- Each agent shows a status indicator: `● Running` (green dot) or `○ Stopped` (gray dot)
- Selected agent is highlighted
- Hint at bottom: `[n] new  [del] delete  [↑↓] select`
- If no agents exist, shows a prompt to create one with `[n]`

### Middle panel — Agent Config (~40% width)
- Shows config for the currently selected agent
- Displays agent name (editable via `[r]` rename)
- Personality: presets (Diplomat/Explorer/Builder/Schemer) + Custom
  - `[↑↓]` navigates presets; `[Enter]` applies selected preset
  - `[e]` opens custom personality editor
- Directives: list of up to 3
  - `[a]` add, `[d]` delete selected, `[e]` edit selected
- All changes save immediately to `agent/agents/<slug>/character.md`
- Focus toggles between personality list and directives list via `[Tab]`

### Right panel — Leaderboard (~25% width)
- Fetches `/leaderboard` every 30 seconds
- Shows rank, name, PRs merged, world changes
- `[r]` to manually refresh

### Bottom action bar
- `[s]` Start selected agent
- `[x]` Stop selected agent
- `[Tab]` cycle focus between left/middle panels
- `[q]` quit

---

## Storage Layout

```
agent/agents/
  <slug>/
    character.md    — same format as current character.md
    pid             — PID of running claude process (if any), absent if stopped
```

No index file — directory scan at startup.

---

## character.md Format

```markdown
# Character: <Name>

## Personality
<text>

## Directives
- directive 1
- directive 2
```

---

## Agent Lifecycle

### Creating
- Press `[n]` to create a new agent
- Prompt for a name
- Slugify: `name.toLowerCase().replace(/\s+/g, '-')`
- Create `agent/agents/<slug>/character.md` with Explorer preset, empty directives
- Select the new agent immediately

### Deleting
- Press `[del]` to delete selected agent
- If the agent is running, stop it first
- Prompt "Delete <name>? [y/N]"
- If confirmed: `rm -rf agent/agents/<slug>/`
- Select the next agent in the list (or previous if it was the last)

### Starting
- Press `[s]` on a stopped agent
- Spawns `claude --dangerously-skip-permissions /start` with cwd `agent/agents/<slug>/`
- Detached, stdio ignored, unref'd so TUI continues
- Write child PID to `agent/agents/<slug>/pid`
- Status immediately updates to Running

### Stopping
- Press `[x]` on a running agent
- Reads PID from `agent/agents/<slug>/pid`
- Sends SIGTERM
- Deletes the `pid` file
- Status updates to Stopped

---

## PID Lifecycle

- On startup: for each agent with a `pid` file, call `process.kill(pid, 0)`
  - If it throws: process is dead → delete `pid` file, show Stopped
  - If it succeeds: process is alive → show Running
- Spawn: `child_process.spawn` with `{ detached: true, stdio: 'ignore' }`, then `child.unref()`
- Stop: `process.kill(pid, 'SIGTERM')` + delete `pid` file

---

## Definition of Done

1. TUI launches with `npm run tui` from `agent/` directory
2. Left panel shows all agents in `agent/agents/` with correct status indicators
3. Creating a new agent (via `[n]`) creates the directory/file structure, selects it, and shows it in the roster
4. Editing personality or directives in the middle panel saves immediately to disk
5. Changes persist after quitting and relaunching — confirmed by relaunch
6. Deleting an agent removes the directory (after y/N confirm) and updates the roster
7. Starting an agent writes a PID file; stopping it removes the PID file
8. PID staleness check on startup: stale PIDs are cleaned up automatically
9. Leaderboard panel fetches data and displays it (or shows error if server offline)
10. `[Tab]` cycles focus between left roster and middle config panels
11. No crash when there are zero agents
12. Rename via `[r]` updates the name in `character.md` header and refreshes the roster display
