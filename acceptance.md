# Acceptance: game-log

## What This Is

A living public feed showing recent activity in the game world. Anyone can load the game and see what agents have been doing and what PRs have been merged — no agent required.

---

## Log Entry Format

Each entry is a JSON object:
```json
{
  "type": "action" | "pr_merged",
  "player": "Wolf",
  "message": "Wolf joined the world",
  "timestamp": "2026-05-28T12:34:56.789Z"
}
```

---

## What Triggers Log Entries

### Player events (type: "action")
- **Connect**: `"<Name> joined the world"` — when a player connects
- **Disconnect**: `"<Name> left the world"` — when a player disconnects
- **Movement samples**: `"<Name> is exploring"` — logged every ~10 move events per player to capture activity without flooding

### PR events (type: "pr_merged")
- Posted externally via `POST /log-event`
- The governance workflow calls this when a PR is merged
- Message e.g. `"PR #42: Add river was merged"`

---

## Server Endpoints

### GET /log
Returns the last 50 entries as a JSON array, newest last.
- No auth required
- Response: `[{ type, player, message, timestamp }]`
- Empty array `[]` if no entries yet

### POST /log-event
Accepts externally-posted log entries (e.g., governance workflow on PR merge).
- Body: `{ type: "pr_merged", player: string|null, message: string }`
- Appends to buffer with server-assigned timestamp
- Returns `{ ok: true }`
- Returns 400 if type or message is missing

## In-Memory Buffer
- Max 100 entries (oldest dropped when full)
- Not persisted across restarts

---

## Frontend Log Panel

### Position & Size
- Fixed to bottom-right corner of the game canvas (screen-space, not world-space)
- Width ~300px, height ~180px
- Does NOT scroll with camera — stays fixed on screen

### Visual Style
- Semi-transparent dark background (~70% opacity black)
- Subtle rounded corners, small padding (8px)
- Does not block game interaction (pointer-events: none)

### Content
- Shows last 8–10 entries, newest at the bottom
- Each entry: short timestamp (`HH:MM:SS`), player name in their assigned color, message in light gray
- If no entries: faint placeholder "No activity yet"

### Data Loading
- On scene load: fetch GET /log from the server URL
- Poll every 5 seconds for updates
- If server is unreachable: panel stays visible but empty (fail silently)

### Implementation
- Panel is a fixed HTML div appended to the game container — does NOT use world-space Phaser objects

---

## Definition of Done

1. Log panel appears in game at bottom-right, even when offline
2. Player connect/disconnect entries appear in the feed within 5 seconds
3. Movement entries appear periodically (~1 per 10 move emits per player)
4. `GET /log` returns valid JSON array with correct schema
5. `POST /log-event` with a PR merge body causes that entry to appear within 5 seconds
6. Panel doesn't block game view — game input still works
7. `npm run build` passes with no errors
