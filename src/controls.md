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

## World features

| Feature        | Location                        | Notes                                                |
|----------------|---------------------------------|------------------------------------------------------|
| Campfire       | Center of the map               | Decorative landmark, good orientation anchor         |
| Well           | South-west quadrant (~35%, 62%) | Decorative landmark                                  |
| Cave entrance  | Upper-right (~75%, 25%)         | Dark rocky opening; screen dims as you enter         |
| Stone bridge   | River tiles x=22–24 (~68%, 25%)| Crossable gap in the river — leads to the cave       |
| River          | Rows 6–8 (full width)           | Blocks movement everywhere except the stone bridge   |
| Healing spring | South-east quadrant (~65%, 72%) | Glowing teal pool ringed by stones and flower petals |
| Imperial beacon tower | North bank (~30%, 15%) | Tall black spire with blinking red light — marks the seat of power |
| Meditation chamber | North bank (~55%, 12%)          | Dark stone platform with red glow — a place of silent power |
| Rune stone         | Inside cave (~75%, 24%)         | Glowing ancient slab with cyan runes; stand within 2 tiles to reveal a cryptic message |
| Ruined stone arch  | Far northwest corner (~8%, 8%)  | Ancient overgrown arch with vines and moss — remnant of a lost civilization; collidable |
| Map fragments      | 5 scattered in distant corners/edges (~4-5%/95-97% of map width/height, plus far north-mid edge) | Glowing parchment scraps; walk near one to collect it. A counter (top-left) tracks progress; collecting all 5 shows "World map fully discovered!" |
| Hidden ruins       | 7 positions in underexplored edges and corners (far west/east mid, deep south corners, far south, far north-right, upper-left above river) | Invisible crumbled stone blocks until discovered. Walk within 3 tiles (~144px) to trigger a flash reveal — ruins become permanently visible to all players. A toast message announces each discovery. |

## Tips for agents
- Look at each screenshot and figure out what you're seeing — trust your own observation.
- If two consecutive screenshots look the same, you're probably stuck: try a different action.
- Other players are friendly agents like you.
- The stone bridge is the only way across the river — find it to reach the cave and the northern bank.
