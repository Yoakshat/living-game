# Acceptance: multiplayer-server

Locked definition of done for real-time multiplayer position sync. Scope is a
Node.js + Socket.io server that broadcasts player positions so every connected
browser client sees every other player moving. No game mechanics beyond
movement and identity (color + name tag).

The defining constraint: two browser tabs open to the same game URL must show
each other's characters moving in real-time. A screenshot showing both players
must make it immediately obvious there are two distinct people in the world.

---

## 1. Connection flow

### New player joins
- Opening the game URL causes the client to connect to the Socket.io server
  automatically — no manual action required.
- The server assigns the new client:
  - A unique player ID (UUID or similar).
  - A unique color not currently in use by any other connected player.
  - A generated display name (e.g., "Player_4A2" or similar short identifier).
- The server sends the new client the full current state: all already-connected
  players with their IDs, colors, names, and current x/y positions.
- The new client renders all existing players at their correct current positions
  before the player takes any action.
- The server broadcasts a `player:joined` (or equivalent) event to all existing
  clients so the newcomer's character appears in their world immediately —
  no page refresh required.
- The entire join flow (connect → assign → render) completes within 2 seconds
  on localhost.

### Existing clients see the newcomer
- When a second tab opens, the first tab's game world gains a new character at
  the newcomer's spawn position.
- The new character is rendered with the server-assigned color and name tag
  visible above their sprite.

---

## 2. Movement sync

- When a local player presses WASD/arrow keys, their own character moves
  immediately (client-side, no server round-trip required).
- The client emits a position update event to the server after each movement
  step (or on a regular tick while moving).
- The server broadcasts the position update to all other connected clients.
- Other clients update the moving character's position upon receiving the event.
- **Latency**: on localhost, a remote player's position update is reflected on
  other clients within 200ms.
- **Smoothness**: remote character movement must be visually smooth — no
  snapping/teleporting between discrete positions. Interpolation or frequent
  enough update rate must make movement look fluid at normal walking speed.
- Two players moving simultaneously must both see each other's updates — no
  dropped events when multiple players emit at the same time.

---

## 3. Player identity

- Each connected player is rendered with a visually distinct color sprite tint
  (or color overlay) matching their server-assigned color.
- No two simultaneously connected players share the same color.
- A name tag (text label) floats above each player's character at all times,
  including remote players.
- The local player's own name tag is also visible.
- **Screenshot legibility**: in a screenshot capturing two connected players,
  a viewer with no prior context must be able to:
  - Identify that there are two distinct characters (different colors).
  - Read both name tags without zooming in.
  - Distinguish which character is which player.

---

## 4. Disconnect / cleanup

- When a player closes their tab or loses connection, the server detects the
  disconnect (Socket.io's disconnect event).
- The server broadcasts a `player:left` (or equivalent) event to all remaining
  clients within 2 seconds of the disconnect.
- All remaining clients immediately remove the disconnected player's character
  from their game world — no ghost characters persist.
- The disconnected player's assigned color is freed and may be reassigned to
  future players.
- After a disconnect, the remaining clients' game state is clean — no orphaned
  sprites, no error state, no crashes.

---

## 5. Scale

- The server handles at least 10 simultaneous Socket.io connections without
  crashing, hanging, or dropping movement events.
- Repeated connect/disconnect cycles (e.g., a client reconnecting multiple
  times rapidly) do not cause accumulating ghost state on the server.
- No memory leak observable from the server process during a session with
  multiple players joining and leaving.

---

## 6. Local development

- The server starts with `npm start` or `node server.js` from the server
  directory with no additional setup beyond `npm install`.
- The server listens on port 3000 by default (or configurable via `PORT` env
  var).
- No build step is required to run the server locally.
- The Phaser client connects to `http://localhost:3000` (or equivalent) when
  running locally.
- Two browser tabs opened to the local Phaser dev server connect to the local
  game server and show each other's movement.

---

## 7. Railway deployment

- The server deploys to Railway free tier without code changes — only
  environment variable configuration.
- Railway provides the `PORT` env var automatically; the server must use it.
- The Phaser client reads the server URL from a build-time or runtime config
  (e.g., `VITE_SERVER_URL` env var) so it can target either localhost or the
  Railway URL by changing one value.
- The Railway-deployed server accepts WebSocket connections from the GitHub
  Pages frontend (`https://yoakshat.github.io`) — CORS is configured to allow
  this origin.
- Two browser tabs opened to the GitHub Pages URL connect to the Railway server
  and show each other's movement live.

---

## 8. Edge cases

- **Simultaneous movement**: two or more players moving at exactly the same
  time all see each other's position updates — no starvation or dropped events
  under concurrent load.
- **Join mid-game**: a player who connects while others are actively moving
  sees those players at their correct current positions, not at a stale spawn
  position.
- **Rapid connect/disconnect**: a client that connects and immediately
  disconnects leaves no ghost state on the server or on other clients.
- **Two tabs same browser**: two tabs in the same browser are treated as two
  independent players — each receives a separate ID and color.
- **Server restart**: after the server restarts, Socket.io's default reconnect
  behavior causes clients to attempt reconnection automatically. Once
  reconnected, the server re-sends the full player state so clients
  re-synchronize without a manual page refresh.
- **Late-join spawn**: a newly joined player spawns at a valid in-world
  position (not (0,0) if that is off-map or inside an obstacle). The spawn
  position is visible to the joining player and to existing players.

---

## 9. Definition of done — tester checklist

A tester verifies each as pass/fail:

- [ ] Server starts locally with `npm start` or `node server.js` and no errors.
- [ ] Two browser tabs opened to the local game both connect successfully
      (console shows connected, server logs two connections).
- [ ] Each tab shows two characters: the local player and the remote player.
- [ ] The two characters have visibly different colors.
- [ ] Both characters have readable name tags above their sprites.
- [ ] Moving WASD in Tab A causes the corresponding character to move in Tab B
      within 200ms on localhost, with smooth interpolation (no teleporting).
- [ ] Moving in both tabs simultaneously works — both tabs reflect both players
      moving at once.
- [ ] Closing Tab A causes the character to disappear from Tab B within 2 seconds.
      No ghost character remains.
- [ ] A third tab joining mid-session sees both existing players at their current
      positions; both existing tabs gain the new player's character.
- [ ] A screenshot of two active players shows two distinct colored characters
      with two readable name tags — a viewer can immediately tell there are two
      different players.
- [ ] Server handles 10 simultaneous connections without crashing.
- [ ] Server deploys to Railway; two tabs opened to the GitHub Pages URL connect
      to Railway and show each other's movement live.
- [ ] Switching from localhost to Railway URL requires only changing one config
      value (env var or config constant).

---

## Out of scope (do NOT implement here)

- Inventory, items, combat, NPCs, or any game mechanics beyond walking.
- Chat or messaging between players.
- Authentication or persistent player accounts.
- Anti-cheat or server-side position validation / authority.
- Mobile / touch input support.
- Any changes to the existing WASD movement, collision, or camera behavior from
  the game-scaffold task.
