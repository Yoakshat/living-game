// Procedural art: all visuals are generated as textures at boot time using a
// Phaser.Graphics object rendered to a texture. Done carefully (multi-layer
// shading, highlights, shadows, noise speckles) these read as real, composed art
// in a screenshot — not flat placeholder blocks.
//
// A small seeded PRNG keeps per-tile variation deterministic so the world looks
// the same every load (helpful for screenshot-based agents).

function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

// Blend two hex colors. amt 0 -> a, 1 -> b.
function mix(a, b, amt) {
  const ca = Phaser.Display.Color.IntegerToColor(a);
  const cb = Phaser.Display.Color.IntegerToColor(b);
  const r = Math.round(ca.red + (cb.red - ca.red) * amt);
  const g = Math.round(ca.green + (cb.green - ca.green) * amt);
  const bl = Math.round(ca.blue + (cb.blue - ca.blue) * amt);
  return (r << 16) | (g << 8) | bl;
}

export const TILE = 48;

// --- Grass tiles -----------------------------------------------------------
// Several tile variants so the ground reads as a textured field, not one flat
// swatch. Each variant has a base fill, a subtle patchwork of lighter/darker
// blades, and scattered speckles. Variants are tiled across the map with a tiny
// bit of per-position rotation/flip handled by the caller's variant pick.
const GRASS_BASE = 0x4a8c3f;
const GRASS_DARK = 0x3c7733;
const GRASS_LIGHT = 0x5fa84e;
const GRASS_HILIGHT = 0x77c061;

function makeGrassTexture(scene, key, seed) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const rng = makeRng(seed);

  // Base fill with a faint vertical gradient feel via two stacked fills.
  g.fillStyle(GRASS_BASE, 1);
  g.fillRect(0, 0, TILE, TILE);

  // Soft patches of slightly different greens to break up the flatness.
  const patches = 5;
  for (let i = 0; i < patches; i++) {
    const px = rng() * TILE;
    const py = rng() * TILE;
    const pr = 6 + rng() * 10;
    const col = rng() > 0.5 ? GRASS_DARK : GRASS_LIGHT;
    g.fillStyle(col, 0.28);
    g.fillCircle(px, py, pr);
  }

  // Short grass-blade strokes for texture.
  const blades = 26;
  for (let i = 0; i < blades; i++) {
    const bx = rng() * TILE;
    const by = rng() * TILE;
    const h = 3 + rng() * 4;
    const lean = (rng() - 0.5) * 2;
    const col = rng() > 0.4 ? GRASS_LIGHT : GRASS_HILIGHT;
    g.lineStyle(1, col, 0.5 + rng() * 0.35);
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(bx + lean, by - h);
    g.strokePath();
  }

  // A few tiny dark speckles (dirt/shadow) for grit.
  for (let i = 0; i < 6; i++) {
    g.fillStyle(GRASS_DARK, 0.4);
    g.fillCircle(rng() * TILE, rng() * TILE, 0.8 + rng() * 0.8);
  }

  g.generateTexture(key, TILE, TILE);
  g.destroy();
}

// --- Tree ------------------------------------------------------------------
// A shaded brown trunk plus layered foliage circles with shadow + highlight.
// Texture is taller than the collision body (canopy overhangs); the caller sets
// a smaller physics body around the trunk base.
const TREE_W = 64;
const TREE_H = 80;

function makeTreeTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = TREE_W / 2;

  // Ground shadow ellipse under the tree.
  g.fillStyle(0x000000, 0.18);
  g.fillEllipse(cx, TREE_H - 8, 44, 14);

  // Trunk: shaded brown with a darker right edge.
  const trunkW = 12;
  const trunkH = 26;
  const trunkX = cx - trunkW / 2;
  const trunkY = TREE_H - trunkH - 6;
  g.fillStyle(0x6b4a2b, 1);
  g.fillRoundedRect(trunkX, trunkY, trunkW, trunkH, 3);
  g.fillStyle(0x563a20, 1); // shadow side
  g.fillRoundedRect(trunkX + trunkW * 0.55, trunkY, trunkW * 0.45, trunkH, { tl: 0, tr: 3, br: 3, bl: 0 });
  g.fillStyle(0x7d5836, 1); // highlight side
  g.fillRect(trunkX + 1, trunkY + 2, 3, trunkH - 4);

  // Foliage: a cluster of overlapping circles, shadow layer first, then mid,
  // then highlight pops on the upper-left (light source).
  const leafShadow = 0x2f5d27;
  const leafMid = 0x3f7d33;
  const leafLight = 0x5aa148;
  const leafHi = 0x74c060;

  const blobs = [
    { x: cx, y: 30, r: 24 },
    { x: cx - 16, y: 36, r: 18 },
    { x: cx + 16, y: 36, r: 18 },
    { x: cx - 8, y: 22, r: 16 },
    { x: cx + 9, y: 24, r: 15 },
    { x: cx, y: 14, r: 14 },
  ];

  // Shadow underside (offset down-right).
  g.fillStyle(leafShadow, 1);
  for (const b of blobs) g.fillCircle(b.x + 3, b.y + 4, b.r);
  // Mid body.
  g.fillStyle(leafMid, 1);
  for (const b of blobs) g.fillCircle(b.x, b.y, b.r);
  // Light layer (offset up-left, smaller).
  g.fillStyle(leafLight, 1);
  for (const b of blobs) g.fillCircle(b.x - 3, b.y - 3, b.r * 0.7);
  // Highlight specks on the sunlit side.
  g.fillStyle(leafHi, 0.9);
  for (const b of blobs) g.fillCircle(b.x - b.r * 0.4, b.y - b.r * 0.45, b.r * 0.28);

  g.generateTexture(key, TREE_W, TREE_H);
  g.destroy();
  return { w: TREE_W, h: TREE_H };
}

// --- Rock ------------------------------------------------------------------
// A shaded gray boulder with a couple of facets and a highlight, clearly NOT a
// tree: low, rounded, stony, no green.
const ROCK_W = 56;
const ROCK_H = 48;

function makeRockTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = ROCK_W / 2;

  // Ground shadow.
  g.fillStyle(0x000000, 0.2);
  g.fillEllipse(cx, ROCK_H - 6, 46, 12);

  const dark = 0x5b5f66;
  const mid = 0x7c828b;
  const light = 0x9aa0a8;
  const hi = 0xc2c7cd;

  // Main boulder silhouette (irregular polygon for a stony, non-circular shape).
  const poly = [
    8, 34,
    4, 22,
    14, 12,
    26, 8,
    40, 11,
    50, 20,
    52, 32,
    44, 40,
    24, 41,
  ];
  g.fillStyle(mid, 1);
  g.fillPoints(toPoints(poly), true);

  // Darker lower-right facet (shadow).
  g.fillStyle(dark, 1);
  g.fillPoints(
    toPoints([26, 8, 40, 11, 50, 20, 52, 32, 44, 40, 32, 30]),
    true
  );

  // Lighter upper-left facet.
  g.fillStyle(light, 1);
  g.fillPoints(
    toPoints([8, 34, 4, 22, 14, 12, 26, 8, 22, 24]),
    true
  );

  // Bright highlight on the top edge (sunlit).
  g.fillStyle(hi, 0.85);
  g.fillPoints(toPoints([14, 12, 26, 8, 30, 13, 18, 17]), true);

  // A couple of crack lines for stony detail.
  g.lineStyle(1.5, dark, 0.7);
  g.beginPath();
  g.moveTo(24, 22);
  g.lineTo(34, 33);
  g.strokePath();
  g.beginPath();
  g.moveTo(20, 30);
  g.lineTo(28, 36);
  g.strokePath();

  g.generateTexture(key, ROCK_W, ROCK_H);
  g.destroy();
  return { w: ROCK_W, h: ROCK_H };
}

function toPoints(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) {
    pts.push(new Phaser.Geom.Point(flat[i], flat[i + 1]));
  }
  return pts;
}

// --- Player ----------------------------------------------------------------
// A small top-down figure: rounded body (distinct warm color so it pops against
// green), a head, and a facing indicator (a lighter "visor"/front marker) so the
// direction is readable. Generated facing each of 4 directions.
const PLAYER_SIZE = 40;
const BODY = 0xe14b4b;
const BODY_DARK = 0xb43636;
const BODY_HI = 0xff7a6e;
const SKIN = 0xf0c9a0;
const SKIN_SH = 0xd6a877;
const FACE = 0xfff2d6;

function drawPlayer(g, dir) {
  const c = PLAYER_SIZE / 2;

  // Ground shadow.
  g.fillStyle(0x000000, 0.22);
  g.fillEllipse(c, PLAYER_SIZE - 5, 26, 8);

  // Body (torso) — rounded, with shaded sides.
  g.fillStyle(BODY, 1);
  g.fillRoundedRect(c - 11, c - 4, 22, 22, 7);
  g.fillStyle(BODY_DARK, 1);
  g.fillRoundedRect(c + 2, c - 4, 9, 22, { tl: 0, tr: 7, br: 7, bl: 0 });
  g.fillStyle(BODY_HI, 0.9);
  g.fillRoundedRect(c - 10, c - 3, 4, 18, 3);

  // Head — skin tone circle with shading.
  g.fillStyle(SKIN, 1);
  g.fillCircle(c, c - 8, 9);
  g.fillStyle(SKIN_SH, 1);
  g.fillCircle(c + 2.5, c - 6, 6.5);
  g.fillStyle(SKIN, 1);
  g.fillCircle(c - 1, c - 9, 7);

  // Facing indicator: a bright marker on the head showing where the player
  // looks. Placed per-direction so orientation reads in a still screenshot.
  g.fillStyle(FACE, 1);
  if (dir === 'down') {
    g.fillCircle(c - 3, c - 8, 1.7);
    g.fillCircle(c + 3, c - 8, 1.7);
  } else if (dir === 'up') {
    // Back of head — small hair tuft instead of eyes.
    g.fillStyle(0x6b4a2b, 1);
    g.fillCircle(c, c - 9, 6);
  } else if (dir === 'left') {
    g.fillCircle(c - 5, c - 8, 1.8);
  } else if (dir === 'right') {
    g.fillCircle(c + 5, c - 8, 1.8);
  }
}

function makePlayerTextures(scene) {
  for (const dir of ['down', 'up', 'left', 'right']) {
    const g = scene.make.graphics({ x: 0, y: 0, add: false });
    drawPlayer(g, dir);
    g.generateTexture('player-' + dir, PLAYER_SIZE, PLAYER_SIZE);
    g.destroy();
  }
  return { size: PLAYER_SIZE };
}

// --- Campfire --------------------------------------------------------------
// A visible landmark at the world center. Stone ring, glowing embers, orange
// flames with a bright yellow core. Purely decorative — no collision.
const CAMPFIRE_W = 48;
const CAMPFIRE_H = 48;

function makeCampfireTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = CAMPFIRE_W / 2, cy = CAMPFIRE_H / 2 + 4;

  // Stone ring — dark grey boulders arranged in a circle.
  const stones = [0, 45, 90, 135, 180, 225, 270, 315];
  for (const deg of stones) {
    const rad = (deg * Math.PI) / 180;
    const sx = cx + Math.cos(rad) * 13;
    const sy = cy + Math.sin(rad) * 9;
    g.fillStyle(0x7a7060, 1);
    g.fillEllipse(sx, sy, 8, 6);
    g.fillStyle(0x5a5248, 1);
    g.fillEllipse(sx + 1, sy + 1, 5, 4);
  }

  // Glowing ember bed — orange-red oval at the base.
  g.fillStyle(0xcc3300, 1);
  g.fillEllipse(cx, cy + 2, 18, 10);
  g.fillStyle(0xff6600, 0.9);
  g.fillEllipse(cx, cy + 1, 12, 7);
  g.fillStyle(0xffaa00, 0.8);
  g.fillEllipse(cx, cy, 7, 4);

  // Flames — layered triangles: outer orange, inner yellow, bright core.
  g.fillStyle(0xff6600, 0.95);
  g.fillTriangle(cx - 8, cy, cx + 8, cy, cx - 2, cy - 18);
  g.fillTriangle(cx - 6, cy, cx + 9, cy, cx + 3, cy - 15);

  g.fillStyle(0xffaa00, 0.9);
  g.fillTriangle(cx - 5, cy, cx + 5, cy, cx, cy - 14);
  g.fillTriangle(cx - 3, cy, cx + 7, cy, cx + 4, cy - 11);

  g.fillStyle(0xffee55, 1);
  g.fillTriangle(cx - 3, cy - 1, cx + 3, cy - 1, cx, cy - 10);

  // Bright core.
  g.fillStyle(0xffffff, 0.7);
  g.fillCircle(cx, cy - 4, 2);

  // Smoke wisps — faint grey circles drifting up.
  g.fillStyle(0xaaaaaa, 0.25);
  g.fillCircle(cx - 2, cy - 22, 4);
  g.fillStyle(0xaaaaaa, 0.15);
  g.fillCircle(cx + 3, cy - 28, 5);

  g.generateTexture(key, CAMPFIRE_W, CAMPFIRE_H);
  g.destroy();
  return { w: CAMPFIRE_W, h: CAMPFIRE_H };
}

// --- Water tile ------------------------------------------------------------
// Blue water tile with subtle ripple highlights. Used to build the river.
// Clearly distinguishable from grass — cooler hue, no blades.
const WATER_BASE = 0x2255aa;
const WATER_DEEP = 0x1a3e80;
const WATER_LIGHT = 0x4488cc;
const WATER_HILIGHT = 0x88bbee;

function makeWaterTexture(scene, key, seed) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const rng = makeRng(seed);

  // Deep-water base.
  g.fillStyle(WATER_BASE, 1);
  g.fillRect(0, 0, TILE, TILE);

  // Darker depth patches.
  for (let i = 0; i < 4; i++) {
    g.fillStyle(WATER_DEEP, 0.35);
    g.fillEllipse(rng() * TILE, rng() * TILE, 8 + rng() * 14, 6 + rng() * 8);
  }

  // Ripple highlight streaks (horizontal ellipses).
  const ripples = 5;
  for (let i = 0; i < ripples; i++) {
    const rx = rng() * TILE;
    const ry = rng() * TILE;
    const rw = 10 + rng() * 16;
    const rh = 2 + rng() * 3;
    g.fillStyle(WATER_LIGHT, 0.4 + rng() * 0.25);
    g.fillEllipse(rx, ry, rw, rh);
  }

  // Bright specular highlight dots.
  for (let i = 0; i < 4; i++) {
    g.fillStyle(WATER_HILIGHT, 0.55 + rng() * 0.3);
    g.fillCircle(rng() * TILE, rng() * TILE, 1 + rng() * 1.5);
  }

  g.generateTexture(key, TILE, TILE);
  g.destroy();
}

// --- Cave entrance ---------------------------------------------------------
// A dark hollow with a rocky stone frame. No collision — purely a visual
// landmark. Dark interior reads unmistakably as a cave.
const CAVE_W = 80;
const CAVE_H = 80;

function makeCaveTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = CAVE_W / 2;
  const cy = CAVE_H / 2 + 4;

  // Ground shadow beneath the whole entrance.
  g.fillStyle(0x000000, 0.3);
  g.fillEllipse(cx, cy + 8, 64, 20);

  // Outer rocky frame — irregular ring of grey stone chunks.
  const frameStones = [
    { deg: 0,   rx: 26, ry: 18, ew: 16, eh: 12 },
    { deg: 45,  rx: 24, ry: 16, ew: 13, eh: 10 },
    { deg: 90,  rx: 28, ry: 18, ew: 14, eh: 12 },
    { deg: 135, rx: 24, ry: 16, ew: 12, eh: 10 },
    { deg: 180, rx: 26, ry: 18, ew: 16, eh: 12 },
    { deg: 225, rx: 24, ry: 16, ew: 14, eh: 10 },
    { deg: 270, rx: 28, ry: 18, ew: 14, eh: 12 },
    { deg: 315, rx: 24, ry: 16, ew: 12, eh: 10 },
  ];
  for (const s of frameStones) {
    const rad = (s.deg * Math.PI) / 180;
    const sx = cx + Math.cos(rad) * s.rx;
    const sy = cy + Math.sin(rad) * s.ry;
    g.fillStyle(0x6e6e6e, 1);
    g.fillEllipse(sx, sy, s.ew, s.eh);
    g.fillStyle(0x9a9a9a, 1);
    g.fillEllipse(sx - 2, sy - 2, s.ew * 0.55, s.eh * 0.55);
    g.fillStyle(0x4a4a4a, 1);
    g.fillEllipse(sx + 2, sy + 2, s.ew * 0.45, s.eh * 0.45);
  }

  // Dark interior — the cave void.
  g.fillStyle(0x0a0a0f, 1);
  g.fillEllipse(cx, cy, 36, 30);

  // Slightly lighter inner edge (rim of the opening catching light).
  g.fillStyle(0x2a2030, 0.8);
  g.fillEllipse(cx, cy, 28, 22);

  // Deepest void.
  g.fillStyle(0x000000, 1);
  g.fillEllipse(cx, cy + 2, 20, 16);

  // Small highlight at the top of the frame (sunlit rim stone).
  g.fillStyle(0xbbbbbb, 0.7);
  g.fillEllipse(cx, cy - 18, 20, 6);

  g.generateTexture(key, CAVE_W, CAVE_H);
  g.destroy();
  return { w: CAVE_W, h: CAVE_H };
}

// --- Well ------------------------------------------------------------------
// A stone-ring well with a dark centre opening. No collision — landmark only.
// Clearly distinguished from the campfire: no flames, cool grey palette.
const WELL_W = 52;
const WELL_H = 52;

function makeWellTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = WELL_W / 2;
  const cy = WELL_H / 2 + 2;

  // Ground shadow.
  g.fillStyle(0x000000, 0.22);
  g.fillEllipse(cx, cy + 14, 42, 12);

  // Outer stone ring — eight stone blocks around a circle.
  const wellStones = [0, 45, 90, 135, 180, 225, 270, 315];
  for (const deg of wellStones) {
    const rad = (deg * Math.PI) / 180;
    const sx = cx + Math.cos(rad) * 16;
    const sy = cy + Math.sin(rad) * 12;
    g.fillStyle(0x888070, 1);
    g.fillRoundedRect(sx - 5, sy - 4, 10, 8, 2);
    g.fillStyle(0xaaa090, 0.8);
    g.fillRoundedRect(sx - 4, sy - 3, 5, 4, 1);
    g.fillStyle(0x555048, 0.6);
    g.fillRoundedRect(sx + 1, sy + 1, 4, 3, 1);
  }

  // Dark well interior (the water below).
  g.fillStyle(0x0a0f18, 1);
  g.fillEllipse(cx, cy, 22, 18);
  // Faint water glint at the bottom of the well.
  g.fillStyle(0x1a3e6a, 0.7);
  g.fillEllipse(cx - 2, cy + 2, 12, 8);
  g.fillStyle(0x4488aa, 0.4);
  g.fillEllipse(cx - 3, cy + 1, 5, 3);

  // Wooden crossbeam over the well opening.
  g.fillStyle(0x7a5530, 1);
  g.fillRoundedRect(cx - 18, cy - 4, 36, 5, 2);
  g.fillStyle(0x5a3e22, 0.7);
  g.fillRoundedRect(cx - 18, cy, 36, 2, 1);
  g.fillStyle(0x9a7248, 0.8);
  g.fillRoundedRect(cx - 17, cy - 3, 8, 2, 1);

  // Vertical post on each side of the beam.
  g.fillStyle(0x7a5530, 1);
  g.fillRoundedRect(cx - 20, cy - 12, 5, 20, 2);
  g.fillRoundedRect(cx + 14, cy - 12, 5, 20, 2);
  g.fillStyle(0x5a3e22, 0.6);
  g.fillRect(cx - 18, cy - 11, 2, 18);
  g.fillRect(cx + 16, cy - 11, 2, 18);

  g.generateTexture(key, WELL_W, WELL_H);
  g.destroy();
  return { w: WELL_W, h: WELL_H };
}

// --- Stone bridge tile -----------------------------------------------------
// A single horizontal tile of stone bridge planks. Laid across the river to
// form a crossing. Warm grey stone with wood-plank detail and a subtle shadow
// along the water edges.
function makeBridgeTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });

  // Stone foundation slab — warm grey base.
  g.fillStyle(0x8a7e6e, 1);
  g.fillRect(0, 0, TILE, TILE);

  // Slightly darker stone veining across the slab.
  g.fillStyle(0x6e6258, 0.5);
  g.fillRect(0, TILE * 0.3, TILE, 2);
  g.fillRect(0, TILE * 0.65, TILE, 2);
  g.fillStyle(0x6e6258, 0.3);
  g.fillRect(TILE * 0.25, 0, 2, TILE);
  g.fillRect(TILE * 0.72, 0, 2, TILE);

  // Top highlight edge (lit from above).
  g.fillStyle(0xb0a898, 0.7);
  g.fillRect(0, 0, TILE, 3);

  // Bottom shadow edge (water shadow below).
  g.fillStyle(0x3a322a, 0.4);
  g.fillRect(0, TILE - 4, TILE, 4);

  // Left / right mortar lines.
  g.fillStyle(0x5a5048, 0.5);
  g.fillRect(0, 0, 2, TILE);
  g.fillRect(TILE - 2, 0, 2, TILE);

  // A small worn patch in the center — frequent foot traffic.
  g.fillStyle(0xa09080, 0.3);
  g.fillEllipse(TILE / 2, TILE / 2, TILE * 0.55, TILE * 0.45);

  g.generateTexture(key, TILE, TILE);
  g.destroy();
}

// --- Healing spring --------------------------------------------------------
// A glowing pool of restorative water ringed by smooth stones and flower petals.
// Purely decorative — no collision. Signals safety and rest to passing travelers.
const SPRING_W = 64;
const SPRING_H = 64;

function makeHealingSpringTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = SPRING_W / 2;
  const cy = SPRING_H / 2 + 4;

  // Ground shadow.
  g.fillStyle(0x000000, 0.18);
  g.fillEllipse(cx, cy + 12, 54, 14);

  // Outer ring of smooth mossy stones.
  const ringStones = [0, 40, 80, 120, 160, 200, 240, 280, 320];
  for (const deg of ringStones) {
    const rad = (deg * Math.PI) / 180;
    const sx = cx + Math.cos(rad) * 22;
    const sy = cy + Math.sin(rad) * 16;
    g.fillStyle(0x7a8c6e, 1);
    g.fillEllipse(sx, sy, 10, 8);
    g.fillStyle(0x9aac8e, 0.7);
    g.fillEllipse(sx - 1, sy - 1, 5, 4);
  }

  // Pool base — deep teal-blue water.
  g.fillStyle(0x0d6b5e, 1);
  g.fillEllipse(cx, cy, 36, 28);

  // Inner glow — lighter, gives the "healing" feel.
  g.fillStyle(0x18a88e, 0.8);
  g.fillEllipse(cx, cy - 2, 26, 20);

  // Bright core shimmer.
  g.fillStyle(0x5eded0, 0.7);
  g.fillEllipse(cx - 3, cy - 4, 14, 10);

  // Specular highlight spot.
  g.fillStyle(0xafffee, 0.55);
  g.fillEllipse(cx - 5, cy - 6, 6, 4);

  // Ripple rings on the surface.
  g.lineStyle(1, 0x18a88e, 0.5);
  g.strokeEllipse(cx, cy, 28, 22);
  g.lineStyle(1, 0x5eded0, 0.3);
  g.strokeEllipse(cx, cy, 20, 15);

  // Small flower petals around the rim (pink, 5 petals).
  const petalColors = [0xff88aa, 0xffaacc, 0xff99bb, 0xffbbdd, 0xff77aa];
  const petalAngles = [15, 87, 159, 231, 303];
  for (let i = 0; i < petalAngles.length; i++) {
    const rad = (petalAngles[i] * Math.PI) / 180;
    const px = cx + Math.cos(rad) * 19;
    const py = cy + Math.sin(rad) * 14;
    g.fillStyle(petalColors[i], 0.9);
    g.fillEllipse(px, py, 6, 5);
    // Petal center dot.
    g.fillStyle(0xffee88, 0.9);
    g.fillCircle(px, py, 1.2);
  }

  g.generateTexture(key, SPRING_W, SPRING_H);
  g.destroy();
  return { w: SPRING_W, h: SPRING_H };
}

// --- Imperial Beacon Tower -------------------------------------------------
// A tall dark spire marking the seat of Imperial power on the north bank.
// Stone base narrows into a slender dark spire crowned with a red warning light.
const BEACON_W = 60;
const BEACON_H = 100;

function makeBeaconTowerTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = BEACON_W / 2;

  // Ground shadow — elongated ellipse beneath the tower.
  g.fillStyle(0x000000, 0.28);
  g.fillEllipse(cx, BEACON_H - 6, 50, 14);

  // Base foundation — wide dark stone slab at the bottom.
  g.fillStyle(0x2a2a2e, 1);
  g.fillRoundedRect(cx - 22, BEACON_H - 26, 44, 22, 3);
  // Highlight on the top edge of the base.
  g.fillStyle(0x4a4a52, 0.7);
  g.fillRect(cx - 20, BEACON_H - 26, 40, 3);
  // Shadow on the right side of the base.
  g.fillStyle(0x18181a, 0.8);
  g.fillRoundedRect(cx + 6, BEACON_H - 26, 14, 22, { tl: 0, tr: 3, br: 3, bl: 0 });

  // Lower spire body — tapered stone pillar.
  // Wide at the bottom, narrowing as it rises.
  const spirePoints = [
    cx - 14, BEACON_H - 24,
    cx + 14, BEACON_H - 24,
    cx + 9,  BEACON_H - 50,
    cx - 9,  BEACON_H - 50,
  ];
  g.fillStyle(0x242428, 1);
  g.fillPoints(toPoints(spirePoints), true);
  // Left highlight strip on the lower spire.
  g.fillStyle(0x3c3c44, 0.8);
  g.fillRect(cx - 13, BEACON_H - 48, 4, 23);
  // Right shadow strip.
  g.fillStyle(0x141416, 0.9);
  g.fillRect(cx + 5, BEACON_H - 48, 4, 23);

  // Middle spire section — narrower, continues upward.
  const midPoints = [
    cx - 9,  BEACON_H - 50,
    cx + 9,  BEACON_H - 50,
    cx + 5,  BEACON_H - 74,
    cx - 5,  BEACON_H - 74,
  ];
  g.fillStyle(0x1e1e22, 1);
  g.fillPoints(toPoints(midPoints), true);
  g.fillStyle(0x343440, 0.7);
  g.fillRect(cx - 8, BEACON_H - 73, 3, 23);
  g.fillStyle(0x0f0f11, 0.9);
  g.fillRect(cx + 4, BEACON_H - 73, 3, 23);

  // Upper spire — the thin needle tip.
  const upperPoints = [
    cx - 5,  BEACON_H - 74,
    cx + 5,  BEACON_H - 74,
    cx + 2,  BEACON_H - 90,
    cx - 2,  BEACON_H - 90,
  ];
  g.fillStyle(0x1a1a1e, 1);
  g.fillPoints(toPoints(upperPoints), true);

  // Very tip of the spire.
  g.fillStyle(0x111114, 1);
  g.fillTriangle(cx - 2, BEACON_H - 90, cx + 2, BEACON_H - 90, cx, BEACON_H - 98);

  // Small collar / parapet ring just below the beacon light.
  g.fillStyle(0x303038, 1);
  g.fillRoundedRect(cx - 6, BEACON_H - 93, 12, 5, 2);
  g.fillStyle(0x4a4a56, 0.6);
  g.fillRect(cx - 5, BEACON_H - 93, 10, 2);

  // Red beacon light at the very top — the glowing warning lamp.
  // Outer glow halo.
  g.fillStyle(0x880000, 0.35);
  g.fillCircle(cx, BEACON_H - 95, 6);
  // Mid red.
  g.fillStyle(0xcc1111, 1);
  g.fillCircle(cx, BEACON_H - 95, 4);
  // Bright core.
  g.fillStyle(0xff4444, 1);
  g.fillCircle(cx, BEACON_H - 95, 2.5);
  // Specular highlight.
  g.fillStyle(0xff9999, 0.8);
  g.fillCircle(cx - 0.8, BEACON_H - 96, 1);

  g.generateTexture(key, BEACON_W, BEACON_H);
  g.destroy();
  return { w: BEACON_W, h: BEACON_H };
}

// --- Sith meditation chamber -----------------------------------------------
// A dark circular stone platform on the north bank — a place of silent power.
// Cracked dark stone, concentric ring details, radial cracks, faint red glow,
// and a bright red core point. Purely decorative — no collision.
const MC_W = 80;
const MC_H = 80;

function makeMeditationChamberTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = MC_W / 2;
  const cy = MC_H / 2;

  // Ground shadow ellipse beneath the platform.
  g.fillStyle(0x000000, 0.25);
  g.fillEllipse(cx, cy + 14, 68, 16);

  // Dark outer vignette ring — darkens the platform edge.
  g.fillStyle(0x000000, 0.35);
  g.fillCircle(cx, cy, 36);

  // Main stone platform — dark grey filled circle, radius ~32.
  g.fillStyle(0x2a2a2e, 1);
  g.fillCircle(cx, cy, 32);

  // Stone floor details: concentric rings in slightly lighter grey.
  g.lineStyle(1.5, 0x3a3a42, 0.7);
  g.strokeCircle(cx, cy, 26);
  g.lineStyle(1, 0x363640, 0.55);
  g.strokeCircle(cx, cy, 19);
  g.lineStyle(1, 0x323238, 0.45);
  g.strokeCircle(cx, cy, 13);

  // Stone platform outer edge highlight.
  g.lineStyle(2, 0x404048, 0.8);
  g.strokeCircle(cx, cy, 32);

  // Radial crack lines from center outward.
  g.lineStyle(1, 0x141418, 0.85);
  // Crack 1 — northwest.
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx - 20, cy - 16);
  g.strokePath();
  // Crack 2 — northeast.
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx + 18, cy - 14);
  g.strokePath();
  // Crack 3 — south.
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx + 4, cy + 22);
  g.strokePath();
  // Crack 4 — east.
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx + 24, cy + 5);
  g.strokePath();
  // Crack 5 — southwest.
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx - 16, cy + 18);
  g.strokePath();

  // Faint red circular glow in the center — semi-transparent, low alpha ~0.3.
  g.fillStyle(0x880000, 0.18);
  g.fillEllipse(cx, cy, 40, 38);
  g.fillStyle(0xaa0000, 0.22);
  g.fillEllipse(cx, cy, 26, 25);
  g.fillStyle(0xcc1111, 0.28);
  g.fillEllipse(cx, cy, 16, 15);

  // Bright red core point at the center — small bright red circle.
  g.fillStyle(0x990000, 0.9);
  g.fillCircle(cx, cy, 5);
  g.fillStyle(0xee2222, 1);
  g.fillCircle(cx, cy, 3);
  g.fillStyle(0xff6666, 0.85);
  g.fillCircle(cx - 0.8, cy - 0.8, 1.2);

  g.generateTexture(key, MC_W, MC_H);
  g.destroy();
  return { w: MC_W, h: MC_H };
}

// --- Rune stone ------------------------------------------------------------
// A dark ancient stone slab with glowing carved rune symbols — found deep in
// the cave. The stone has a cold blue-green luminescence emanating from etched
// runes. Purely decorative — no collision. Proximity triggers a cryptic message.
const RUNE_W = 44;
const RUNE_H = 52;

function makeRuneStoneTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = RUNE_W / 2;
  const cy = RUNE_H / 2 + 4;

  // Ground shadow beneath the stone.
  g.fillStyle(0x000000, 0.3);
  g.fillEllipse(cx, RUNE_H - 5, 34, 10);

  // Main stone body — dark basalt-like polygon, upright slab.
  const stonePoly = [
    6,  RUNE_H - 10,
    4,  RUNE_H - 28,
    8,  RUNE_H - 42,
    cx, RUNE_H - 50,
    cx + 10, RUNE_H - 44,
    RUNE_W - 5, RUNE_H - 30,
    RUNE_W - 6, RUNE_H - 10,
  ];
  g.fillStyle(0x1a1a22, 1);
  g.fillPoints(toPoints(stonePoly), true);

  // Slightly lighter left face (catching ambient light from above).
  g.fillStyle(0x2a2a38, 1);
  g.fillPoints(
    toPoints([6, RUNE_H - 10, 4, RUNE_H - 28, 8, RUNE_H - 42, cx, RUNE_H - 50, cx - 2, RUNE_H - 30]),
    true
  );

  // Stone outer edge highlight (sunlit top-left rim).
  g.fillStyle(0x44445a, 0.7);
  g.fillPoints(
    toPoints([8, RUNE_H - 42, cx, RUNE_H - 50, cx - 2, RUNE_H - 42]),
    true
  );

  // Glowing rune symbols — carved into the stone, lit with cold blue-green light.
  // Each rune drawn as a simple geometric shape in glowing cyan/teal.
  const glow = 0x44ffcc;
  const glowDim = 0x229977;

  // Rune 1 — a vertical line with two cross-bars (runic I/thorn shape).
  g.lineStyle(1.5, glow, 0.9);
  g.beginPath();
  g.moveTo(cx - 2, RUNE_H - 38);
  g.lineTo(cx - 2, RUNE_H - 22);
  g.strokePath();
  g.beginPath();
  g.moveTo(cx - 2, RUNE_H - 34);
  g.lineTo(cx + 5, RUNE_H - 30);
  g.strokePath();
  g.beginPath();
  g.moveTo(cx - 2, RUNE_H - 28);
  g.lineTo(cx + 4, RUNE_H - 25);
  g.strokePath();

  // Rune 2 — a diamond / lozenge shape above the first.
  g.lineStyle(1, glow, 0.8);
  g.beginPath();
  g.moveTo(cx + 6, RUNE_H - 42);
  g.lineTo(cx + 10, RUNE_H - 38);
  g.lineTo(cx + 6, RUNE_H - 34);
  g.lineTo(cx + 2, RUNE_H - 38);
  g.closePath();
  g.strokePath();

  // Rune 3 — a branching fork (elder-futhark 'algiz' style).
  g.lineStyle(1.5, glowDim, 0.85);
  g.beginPath();
  g.moveTo(cx - 8, RUNE_H - 18);
  g.lineTo(cx - 8, RUNE_H - 30);
  g.strokePath();
  g.beginPath();
  g.moveTo(cx - 8, RUNE_H - 26);
  g.lineTo(cx - 12, RUNE_H - 30);
  g.strokePath();
  g.beginPath();
  g.moveTo(cx - 8, RUNE_H - 26);
  g.lineTo(cx - 4, RUNE_H - 30);
  g.strokePath();

  // Ambient glow halo behind the rune area — a diffuse cold light.
  g.fillStyle(0x00ffcc, 0.06);
  g.fillEllipse(cx, cy - 4, 28, 30);
  g.fillStyle(0x22ddaa, 0.08);
  g.fillEllipse(cx, cy - 2, 18, 20);

  g.generateTexture(key, RUNE_W, RUNE_H);
  g.destroy();
  return { w: RUNE_W, h: RUNE_H };
}

// --- Ruined stone arch -------------------------------------------------------
// A weathered arch of ancient stones, half-swallowed by vines and moss. Two
// crumbling pillars support a broken capstone — the mark of a lost civilization.
// Found deep in the far northwest corner. Purely decorative — no collision.
const ARCH_W = 88;
const ARCH_H = 96;

function makeStoneArchTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = ARCH_W / 2;

  // Ground shadow — wide ellipse under the whole structure.
  g.fillStyle(0x000000, 0.28);
  g.fillEllipse(cx, ARCH_H - 8, 72, 16);

  // --- Left pillar -----------------------------------------------------------
  const pillarW = 14;
  const pillarH = 58;
  const pillarLX = cx - 28;
  const pillarRX = cx + 14;
  const pillarY = ARCH_H - 20 - pillarH;

  // Left pillar — base stone (dark, mossy).
  g.fillStyle(0x4a4a40, 1);
  g.fillRoundedRect(pillarLX, pillarY, pillarW, pillarH, 2);
  // Left pillar — highlight (lit from upper-left).
  g.fillStyle(0x6e6e60, 0.8);
  g.fillRect(pillarLX + 1, pillarY + 2, 4, pillarH - 4);
  // Left pillar — shadow side.
  g.fillStyle(0x2c2c24, 0.9);
  g.fillRect(pillarLX + pillarW - 4, pillarY + 2, 4, pillarH - 4);
  // Horizontal stone-course lines on the left pillar.
  g.lineStyle(1, 0x38382e, 0.65);
  for (let i = 1; i < 5; i++) {
    const ly = pillarY + (pillarH * i) / 5;
    g.beginPath();
    g.moveTo(pillarLX, ly);
    g.lineTo(pillarLX + pillarW, ly);
    g.strokePath();
  }

  // --- Right pillar ----------------------------------------------------------
  g.fillStyle(0x4a4a40, 1);
  g.fillRoundedRect(pillarRX, pillarY + 8, pillarW, pillarH - 8, 2);
  g.fillStyle(0x6e6e60, 0.8);
  g.fillRect(pillarRX + 1, pillarY + 10, 4, pillarH - 12);
  g.fillStyle(0x2c2c24, 0.9);
  g.fillRect(pillarRX + pillarW - 4, pillarY + 10, 4, pillarH - 12);
  g.lineStyle(1, 0x38382e, 0.65);
  for (let i = 1; i < 4; i++) {
    const ly = (pillarY + 8) + ((pillarH - 8) * i) / 4;
    g.beginPath();
    g.moveTo(pillarRX, ly);
    g.lineTo(pillarRX + pillarW, ly);
    g.strokePath();
  }

  // --- Broken capstone (arch lintel) ----------------------------------------
  // Sits on top of both pillars; cracked in the middle with a missing chunk.
  const capY = pillarY - 4;
  const capH = 14;

  // Left half of capstone.
  g.fillStyle(0x555548, 1);
  g.fillRoundedRect(pillarLX - 2, capY, pillarW + 12, capH, 2);
  g.fillStyle(0x7a7a68, 0.7);
  g.fillRect(pillarLX - 1, capY + 1, pillarW + 10, 4);
  g.fillStyle(0x2e2e26, 0.8);
  g.fillRect(pillarLX - 1, capY + capH - 4, pillarW + 10, 4);

  // Right half of capstone (slightly lower — the arch has settled).
  g.fillStyle(0x505044, 1);
  g.fillRoundedRect(pillarRX - 4, capY + 5, pillarW + 8, capH - 2, 2);
  g.fillStyle(0x747464, 0.7);
  g.fillRect(pillarRX - 3, capY + 6, pillarW + 6, 3);

  // Central crack in the lintel — a dark jagged gap.
  g.fillStyle(0x181810, 1);
  g.fillTriangle(
    cx - 4, capY,
    cx + 3, capY,
    cx,     capY + capH + 2
  );

  // --- Collapsed stone at the base (fallen rubble) --------------------------
  // A few irregular stone chunks at the base of the right pillar.
  const rubble = [
    { x: pillarRX + 12, y: ARCH_H - 22, w: 14, h: 9 },
    { x: pillarRX + 18, y: ARCH_H - 16, w: 10, h: 7 },
    { x: pillarLX - 10, y: ARCH_H - 18, w: 12, h: 8 },
  ];
  for (const r of rubble) {
    g.fillStyle(0x484840, 1);
    g.fillRoundedRect(r.x, r.y, r.w, r.h, 2);
    g.fillStyle(0x686858, 0.6);
    g.fillRect(r.x + 1, r.y + 1, r.w - 3, 3);
  }

  // --- Stone bases / footings ------------------------------------------------
  g.fillStyle(0x3c3c34, 1);
  g.fillRoundedRect(pillarLX - 4, ARCH_H - 22, pillarW + 8, 10, 2);
  g.fillRoundedRect(pillarRX - 3, ARCH_H - 18, pillarW + 6, 8, 2);
  g.fillStyle(0x585848, 0.6);
  g.fillRect(pillarLX - 3, ARCH_H - 22, pillarW + 6, 3);
  g.fillRect(pillarRX - 2, ARCH_H - 18, pillarW + 4, 3);

  // --- Vines and moss --------------------------------------------------------
  // Trailing vine lines down the left pillar.
  g.lineStyle(2, 0x2e6e28, 0.75);
  g.beginPath();
  g.moveTo(pillarLX + 3, pillarY + 4);
  g.lineTo(pillarLX + 5, pillarY + 18);
  g.lineTo(pillarLX + 2, pillarY + 32);
  g.lineTo(pillarLX + 6, pillarY + 46);
  g.strokePath();
  g.lineStyle(1.5, 0x3a8830, 0.65);
  g.beginPath();
  g.moveTo(pillarLX + 10, pillarY + 8);
  g.lineTo(pillarLX + 8, pillarY + 22);
  g.lineTo(pillarLX + 11, pillarY + 38);
  g.strokePath();

  // Vine on the right pillar.
  g.lineStyle(2, 0x2e6e28, 0.7);
  g.beginPath();
  g.moveTo(pillarRX + 4, pillarY + 14);
  g.lineTo(pillarRX + 6, pillarY + 28);
  g.lineTo(pillarRX + 3, pillarY + 42);
  g.strokePath();

  // Vine leaves — tiny ellipses along the vine paths.
  const leafPositions = [
    { x: pillarLX + 4, y: pillarY + 14 },
    { x: pillarLX + 3, y: pillarY + 28 },
    { x: pillarLX + 7, y: pillarY + 42 },
    { x: pillarLX + 9, y: pillarY + 20 },
    { x: pillarRX + 5, y: pillarY + 22 },
    { x: pillarRX + 4, y: pillarY + 36 },
    // A few leaves on the capstone.
    { x: cx - 8, y: capY - 3 },
    { x: cx + 5, y: capY - 2 },
  ];
  for (const lp of leafPositions) {
    g.fillStyle(0x3a8030, 0.88);
    g.fillEllipse(lp.x, lp.y, 7, 5);
    g.fillStyle(0x55aa44, 0.5);
    g.fillEllipse(lp.x - 1, lp.y - 1, 3, 2);
  }

  // Moss patches on the stone surfaces — soft green blotches.
  const mossSpots = [
    { x: pillarLX + 5, y: pillarY + 50, rx: 6, ry: 4 },
    { x: pillarLX + 2, y: pillarY + 38, rx: 4, ry: 3 },
    { x: pillarRX + 8, y: pillarY + 30, rx: 5, ry: 3 },
    { x: cx - 6, y: capY + 8, rx: 7, ry: 3 },
    { x: pillarRX + 3, y: ARCH_H - 15, rx: 5, ry: 3 },
  ];
  for (const m of mossSpots) {
    g.fillStyle(0x4a7c3a, 0.45);
    g.fillEllipse(m.x, m.y, m.rx * 2, m.ry * 2);
    g.fillStyle(0x6aaa52, 0.3);
    g.fillEllipse(m.x - 1, m.y - 1, m.rx, m.ry);
  }

  // --- Ancient engravings on the arch face (faint, weathered) ---------------
  g.lineStyle(1, 0x7a7060, 0.35);
  // A simple knotwork spiral on the left pillar face.
  g.beginPath();
  g.moveTo(pillarLX + 6, pillarY + pillarH * 0.55);
  g.lineTo(pillarLX + 8, pillarY + pillarH * 0.48);
  g.lineTo(pillarLX + 11, pillarY + pillarH * 0.52);
  g.lineTo(pillarLX + 9, pillarY + pillarH * 0.60);
  g.lineTo(pillarLX + 6, pillarY + pillarH * 0.58);
  g.strokePath();

  g.generateTexture(key, ARCH_W, ARCH_H);
  g.destroy();
  return { w: ARCH_W, h: ARCH_H };
}

// --- Map fragment -----------------------------------------------------------
// A torn scrap of an old parchment map, half-curled, with faint ink lines and
// a glowing golden edge so it reads as a valuable collectible against the
// grass. Purely decorative with overlap-based pickup (no physics body) —
// the scene handles "collected" detection via distance check.
const FRAGMENT_W = 40;
const FRAGMENT_H = 40;

function makeMapFragmentTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = FRAGMENT_W / 2;
  const cy = FRAGMENT_H / 2;

  // Ground shadow.
  g.fillStyle(0x000000, 0.2);
  g.fillEllipse(cx, FRAGMENT_H - 7, 26, 8);

  // Torn parchment silhouette — irregular polygon, not a clean rectangle.
  const poly = [
    4, 10,
    10, 4,
    24, 2,
    34, 9,
    36, 20,
    30, 30,
    18, 36,
    7, 32,
    2, 22,
  ];
  g.fillStyle(0xd9c08a, 1);
  g.fillPoints(toPoints(poly), true);

  // Darker aged-edge shadow along the lower-right.
  g.fillStyle(0xb89a5e, 1);
  g.fillPoints(
    toPoints([34, 9, 36, 20, 30, 30, 18, 36, 24, 24, 30, 14]),
    true
  );

  // Lighter sunlit patch upper-left.
  g.fillStyle(0xead9a8, 0.8);
  g.fillPoints(
    toPoints([4, 10, 10, 4, 24, 2, 18, 14, 8, 18]),
    true
  );

  // Faint ink map lines — a couple of squiggly "routes" and a small "X".
  g.lineStyle(1, 0x6b5530, 0.7);
  g.beginPath();
  g.moveTo(9, 14);
  g.lineTo(15, 19);
  g.lineTo(13, 25);
  g.lineTo(20, 28);
  g.strokePath();
  g.beginPath();
  g.moveTo(20, 10);
  g.lineTo(27, 16);
  g.strokePath();

  g.lineStyle(1.5, 0x8a3030, 0.85);
  g.beginPath();
  g.moveTo(22, 21);
  g.lineTo(27, 26);
  g.strokePath();
  g.beginPath();
  g.moveTo(27, 21);
  g.lineTo(22, 26);
  g.strokePath();

  // Torn/frayed edge marks — small dark notches along the border.
  g.fillStyle(0x8a7344, 0.6);
  g.fillTriangle(34, 9, 36, 20, 32, 14);
  g.fillTriangle(2, 22, 7, 32, 4, 25);

  // Golden glow ring to signal "collectible" — pulsing handled by the scene
  // via tint, this is just a static base highlight.
  g.lineStyle(2, 0xffd66b, 0.55);
  g.strokeEllipse(cx, cy, 34, 32);

  g.generateTexture(key, FRAGMENT_W, FRAGMENT_H);
  g.destroy();
  return { w: FRAGMENT_W, h: FRAGMENT_H };
}

// --- Meteor crater -----------------------------------------------------------
// A glowing impact crater left behind after a shooting star lands at a map edge.
// Orange/red bowl shape with a bright molten core and outward spatter lines.
// Claimed craters fade out; unclaimed ones pulse with warm orange glow.
const CRATER_W = 56;
const CRATER_H = 56;

function makeMeteorCraterTexture(scene, key) {
  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  const cx = CRATER_W / 2;
  const cy = CRATER_H / 2;

  // Outer debris/scorch ring — dark soot on the ground.
  g.fillStyle(0x1a0800, 0.7);
  g.fillEllipse(cx, cy, 54, 50);

  // Crater rim — raised ring of scorched orange-brown earth.
  g.fillStyle(0x6b2200, 1);
  g.fillEllipse(cx, cy, 44, 40);

  // Mid-tone basin inside the rim.
  g.fillStyle(0x9b3800, 1);
  g.fillEllipse(cx, cy, 34, 30);

  // Inner bowl — bright orange-red, hot rock.
  g.fillStyle(0xdd4400, 1);
  g.fillEllipse(cx, cy, 24, 20);

  // Molten core glow.
  g.fillStyle(0xff7700, 0.9);
  g.fillEllipse(cx, cy, 16, 13);

  // Bright yellow-white hot centre.
  g.fillStyle(0xffdd44, 0.85);
  g.fillEllipse(cx, cy, 8, 7);

  // Specular highlight at the centre.
  g.fillStyle(0xffffff, 0.5);
  g.fillCircle(cx - 1, cy - 1, 2.5);

  // Spatter lines radiating outward — lava ejecta.
  const spatterAngles = [0, 45, 90, 135, 180, 225, 270, 315];
  for (const deg of spatterAngles) {
    const rad = (deg * Math.PI) / 180;
    const sx = cx + Math.cos(rad) * 22;
    const sy = cy + Math.sin(rad) * 20;
    g.lineStyle(1, 0xcc4400, 0.7);
    g.beginPath();
    g.moveTo(cx + Math.cos(rad) * 8, cy + Math.sin(rad) * 7);
    g.lineTo(sx, sy);
    g.strokePath();
    // Small molten droplet at the tip of each spatter.
    g.fillStyle(0xff6600, 0.65);
    g.fillCircle(sx, sy, 2);
  }

  // Outer glow halo — warm orange ambient light.
  g.fillStyle(0xff4400, 0.1);
  g.fillCircle(cx, cy, CRATER_W / 2);

  g.generateTexture(key, CRATER_W, CRATER_H);
  g.destroy();
  return { w: CRATER_W, h: CRATER_H };
}

// Generate everything; returns metadata the scene needs for sizing/bodies.
export function generateTextures(scene) {
  const grassVariants = 4;
  for (let i = 0; i < grassVariants; i++) {
    makeGrassTexture(scene, 'grass-' + i, 1337 + i * 911);
  }
  const tree = makeTreeTexture(scene, 'tree');
  const rock = makeRockTexture(scene, 'rock');
  const player = makePlayerTextures(scene);
  const campfire = makeCampfireTexture(scene, 'campfire');

  // New world landmarks.
  const waterVariants = 3;
  for (let i = 0; i < waterVariants; i++) {
    makeWaterTexture(scene, 'water-' + i, 9999 + i * 1337);
  }
  const cave = makeCaveTexture(scene, 'cave');
  const well = makeWellTexture(scene, 'well');

  // Stone bridge tile (used for the cave river crossing).
  makeBridgeTexture(scene, 'bridge');

  // Healing spring — a peaceful glowing pool on the south bank.
  const healingSpring = makeHealingSpringTexture(scene, 'healing-spring');

  // Imperial beacon tower — tall dark spire on the north bank.
  const beaconTower = makeBeaconTowerTexture(scene, 'beacon-tower');

  // Sith meditation chamber — dark stone platform with red glow, north bank.
  const meditationChamber = makeMeditationChamberTexture(scene, 'meditation-chamber');

  // Ancient rune stone — glowing stone slab inside the cave with cryptic runes.
  const runeStone = makeRuneStoneTexture(scene, 'rune-stone');

  // Ruined stone arch — ancient overgrown remnant in the far northwest corner.
  const stoneArch = makeStoneArchTexture(scene, 'stone-arch');

  // Map fragment — collectible parchment scrap, scattered in distant corners.
  const mapFragment = makeMapFragmentTexture(scene, 'map-fragment');

  // Meteor crater — glowing impact site left by a shooting star at the map edge.
  const meteorCrater = makeMeteorCraterTexture(scene, 'meteor-crater');

  return {
    tile: TILE,
    grassVariants,
    waterVariants,
    tree,
    rock,
    player,
    campfire,
    cave,
    well,
    healingSpring,
    beaconTower,
    meditationChamber,
    runeStone,
    stoneArch,
    mapFragment,
    meteorCrater,
  };
}
