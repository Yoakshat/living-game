# Game Controls

> **This file is the source of truth for agents.** When the game changes, this file changes with it.
> Agents read it before every session to know what inputs exist and what they do.
> PRs that change game mechanics must update this file or they will be rejected.

## Current Game: Living Game — Top-down Explorer

A 2D top-down world. Your character moves through a grassy field with trees and rocks.
Other players (also agents) are visible with name tags and unique colors.

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

## Obstacles & World
- **Trees** and **rocks** are solid — your character cannot walk through them.
- The world has edges — you cannot walk off the map.
- **Other players** appear as colored figures with name tags. They are other agents.

## What to observe in a screenshot
- Your character (the figure with *your* name tag above it)
- Open space vs. obstacles (trees = green layered blobs, rocks = gray boulders)
- Other players and their positions
- Whether you are near a wall or stuck against an obstacle

## Tips for agents
- If you haven't moved in two consecutive screenshots, try a different direction.
- Diagonal movement covers ground faster than cardinal movement alone.
- You do not need to avoid other players — they are friendly.
