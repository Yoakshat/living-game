# Acceptance Criteria: world-content

## Overview
Three new landmarks are added to the game world. Each must be visually distinct,
procedurally generated (no external assets), and noticeable to screenshot-viewing agents.

---

## 1. River

**What it looks like:**
- A horizontal strip of water tiles crossing the map
- Tiles are blue-tinted with subtle highlights and ripple-like texture — unmistakably water
- Water visually contrasts with the surrounding grass

**Where it is:**
- Runs horizontally at approximately 30% down from the top of the map (around tile-row 7)
- Stretches the full width of the map
- About 2–3 tiles tall so it reads as a real river

**Agent behaviour:**
- Agents cannot walk through the river tiles (static physics bodies block passage)
- Agents can walk alongside the river freely
- In a screenshot, an agent near the northern part of the map should see the blue water strip

**Definition of done:**
- River tiles render as clearly blue
- Collision bodies are present on all river tiles
- The river is clearly visible in a screenshot from anywhere near that region

---

## 2. Cave Entrance

**What it looks like:**
- A dark, near-circular dark opening — a black/dark-grey hollow
- Surrounded by a rocky stone frame (grey faceted rocks forming an arch or ring)
- Clearly reads as a dark hole — distinct from surrounding rocks/trees

**Where it is:**
- Located in the upper-right area of the map
- A single sprite at approximately (worldWidth * 0.75, worldHeight * 0.25)
- Roughly 80×80 pixels

**Agent behaviour:**
- No collision — agents can walk over it (visual landmark only)
- Agents walking near the northeast of the map will see it

**Definition of done:**
- Clearly renders as a dark cave opening with a stone frame
- No collision body
- Visually distinct from nearby rock and tree objects

---

## 3. Well

**What it looks like:**
- A stone ring (circular arrangement of grey stone blocks)
- Dark centre (the well opening — very dark, near-black)
- Reads as a classic village well, not a campfire

**Where it is:**
- Placed at approximately (worldWidth * 0.35, worldHeight * 0.6) — south-west quadrant
- Size roughly 48×48 pixels

**Agent behaviour:**
- No collision — purely decorative landmark
- Agents roaming the world will encounter it

**Definition of done:**
- Stone ring with dark centre is clearly visible
- Distinguishable from the campfire (no flames, cooler palette)
- Placed in a reachable, visible location

---

## Build acceptance
- `npm run build` completes with no errors
- No external asset files added — all textures procedurally generated in `src/textures.js`
- Changes confined to `src/textures.js` and `src/scenes/WorldScene.js`
