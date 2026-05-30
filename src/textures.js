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
  };
}
