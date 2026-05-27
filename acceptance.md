# Acceptance: game-scaffold

The locked definition of done for the foundational visual world. Scope is a single
locally-controlled character moving through a believable 2D top-down world that
builds and deploys to GitHub Pages. **No multiplayer, no AI agent loop, no PR
governance** — those are later tasks and are explicitly out of scope here.

The defining constraint: an agent perceives the world only through screenshots.
A screenshot of this game, shown to a human or an AI with no prior context, must
be **legible** — the viewer can identify at a glance "this is walkable ground,
that is an obstacle I can't pass, and that is my character."

---

## 1. User flows

### Opening the game
- Opening the game URL (dev server locally, or the deployed GitHub Pages URL)
  loads the game in the browser with no manual steps.
- The world renders within a few seconds. No blank/black screen that persists,
  no infinite loading spinner, no requirement to click "start" before the world
  appears.
- The browser console shows **no uncaught errors** and **no failed asset
  requests (no 404s)** on load. This applies in both dev and the deployed build.
- The game canvas fills (or is clearly centered within) the browser viewport —
  it is not a tiny box in the corner.

### Seeing the world
- On load the viewer sees a top-down 2D world: a field of walkable terrain
  populated with obstacles, and a single player character somewhere in view.
- The player character is on screen and visually centered (camera follows the
  player — see camera behavior below).

### Moving
- The viewer can immediately move the character with WASD keys (no click-to-focus
  ritual beyond the canvas being the active element; clicking the canvas once to
  focus is acceptable if needed).
- Movement is real-time and smooth — the character visibly translates across the
  terrain as keys are held, not teleporting in large jumps.

### Hitting obstacles
- Walking into a tree or rock stops the character at the obstacle. The character
  does not pass through, overlap, or clip into obstacles.

---

## 2. Visual / UX requirements (screenshot-legible)

A tester will judge these by **looking at a screenshot**. Each must be pass/fail
identifiable without reading code.

- **Terrain legibility**: The ground reads as grass / walkable ground — a
  consistent, recognizable green (or clearly natural ground) terrain covering the
  walkable area. It must not look like a flat untextured color block or a
  debug-grid placeholder. Some visual variation/texture so it reads as a "place,"
  not a swatch.
- **Distinct obstacles — trees**: Trees are clearly identifiable as trees
  (recognizable shape/silhouette, green foliage and/or trunk). Multiple trees are
  present in the world.
- **Distinct obstacles — rocks**: Rocks are clearly identifiable as rocks
  (gray/stone, rounded or boulder-like, visually distinct from trees). Multiple
  rocks are present.
- **Trees vs rocks are distinguishable** from each other at a glance — a viewer
  would not confuse one for the other.
- **Player character**: A single character sprite is clearly visible and
  distinguishable from terrain and obstacles. It reads as a character/figure (not
  a plain dot or a colored square indistinguishable from a rock). It stands out
  against the grass.
- **Composition**: The scene looks intentionally arranged — obstacles are
  distributed across the world (not all clumped in one corner, not a perfectly
  uniform grid that screams "placeholder"). The result should feel like a small
  natural place.
- **No placeholder tells**: No visible debug text, no "Hello Phaser" banner, no
  magenta/checkerboard missing-texture artifacts, no untextured primitive shapes
  standing in for art.

---

## 3. Movement behavior

- **W** = move up, **S** = move down, **A** = move left, **D** = move right
  (top-down screen-relative directions).
- **Diagonals**: Holding two perpendicular keys (e.g., W+D) moves the character
  diagonally. Diagonal speed should be normalized so diagonal movement is not
  noticeably faster than straight movement (no speed boost from moving diagonally).
- **Movement is continuous while held**: The character keeps moving as long as a
  key is held and stops when released.
- **World edges**: The walkable world has defined bounds. The character cannot
  walk off the map / out of the world — it stops at the world boundary and the
  camera does not reveal empty void beyond the world edge (the camera clamps to
  world bounds).
- **Collision against trees/rocks**: Obstacles are solid. Moving into one halts
  movement in that direction. The player can still slide along / move in other
  unobstructed directions while pressed against an obstacle (i.e., collision
  blocks only the blocked axis, it doesn't freeze the character entirely).

---

## 4. Camera behavior

- The camera follows the player so the player stays at (or near) the center of the
  viewport as it moves.
- The camera is clamped to world bounds: at the edges of the world the camera
  stops scrolling rather than showing empty space outside the world.

---

## 5. Edge cases

- **Holding two keys**: Diagonal movement works (see above). Holding two opposing
  keys (e.g., A+D) results in no net horizontal movement (cancels out) rather than
  jitter or error.
- **Walking into an obstacle**: Character stops cleanly at the obstacle, no
  clipping, no getting stuck permanently — releasing toward the obstacle and
  pressing away moves the character away normally.
- **Reaching the map boundary**: Character stops at the edge; no crash; no
  scrolling into void; pressing back into the world moves normally.
- **Rapid / mashed key presses**: Rapidly tapping or switching keys does not
  crash the game, does not leave the character "stuck" moving after all keys are
  released, and does not throw console errors.
- **Window resize**: Resizing the browser window keeps the game rendering
  correctly — the canvas adapts (scales or re-fits) without breaking the view,
  leaving black bars that dominate the screen, or throwing errors. The player
  remains visible after resize.
- **Key release while moving**: Releasing all movement keys brings the character
  to a stop (no perpetual drift).

---

## 6. Build & deploy

- **Dev server**: `npm install` then `npm run dev` starts a local dev server and
  the game loads and is playable at the printed localhost URL.
- **Production build**: `npm run build` completes successfully with no errors and
  produces a static output directory (e.g., `dist/`).
- **Base path**: The production build is configured for a GitHub Pages **project
  page** (served from a subpath like `/<repo>/`), so all asset paths resolve
  correctly when deployed — no 404s on JS/CSS/images due to absolute `/` paths.
  The deployed page must actually render the world, not a blank page caused by
  broken asset URLs.
- **Deployed on GitHub Pages**: The game is reachable at its GitHub Pages URL and
  is fully playable there (loads, renders the world, WASD moves, collisions work)
  with no console errors or 404s. Behavior on the deployed build matches local.
- A preview of the production build locally (e.g., `npm run preview` with the
  correct base path) renders and plays correctly, matching dev behavior.

---

## 7. Definition of done — tester checklist

A tester verifies each as pass/fail:

- [ ] Game loads in a browser (dev and deployed) with no uncaught console errors
      and no 404 asset requests.
- [ ] A screenshot of the game is **legible**: a viewer with no context can point
      to the grass, the trees, the rocks, and the player character.
- [ ] Terrain reads as grass/walkable ground with visual texture, not a flat
      placeholder color or debug grid.
- [ ] Multiple trees present and identifiable as trees.
- [ ] Multiple rocks present and identifiable as rocks, distinct from trees.
- [ ] A single player character is clearly visible and distinct from terrain and
      obstacles.
- [ ] W/A/S/D move the character up/left/down/right respectively.
- [ ] Diagonal movement works and is speed-normalized.
- [ ] Movement is smooth and real-time; releasing keys stops the character.
- [ ] Walking into a tree or rock blocks the player (no clip-through), and the
      player can slide along the obstacle on the free axis.
- [ ] The player cannot leave the world bounds; the camera clamps at world edges.
- [ ] The camera follows the player, keeping it centered.
- [ ] Opposing keys cancel; rapid presses don't crash or leave the player stuck.
- [ ] Window resize keeps the game rendering correctly with the player visible.
- [ ] `npm run dev` serves a playable game locally.
- [ ] `npm run build` succeeds and the build is configured with the correct
      GitHub Pages project-page base path.
- [ ] The deployed GitHub Pages build is live, renders the world, and is fully
      playable with no console errors or 404s.

---

## Out of scope (do NOT implement here)
- Multiplayer / Socket.io server / other players.
- The AI agent loop, Playwright control, or Claude integration.
- PR governance, voting, GitHub Actions CI.
- Inventory, items, combat, NPCs, or any gameplay mechanics beyond walking and
  colliding.
