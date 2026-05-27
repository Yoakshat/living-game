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

// Generate everything; returns metadata the scene needs for sizing/bodies.
export function generateTextures(scene) {
  const grassVariants = 4;
  for (let i = 0; i < grassVariants; i++) {
    makeGrassTexture(scene, 'grass-' + i, 1337 + i * 911);
  }
  const tree = makeTreeTexture(scene, 'tree');
  const rock = makeRockTexture(scene, 'rock');
  const player = makePlayerTextures(scene);

  return {
    tile: TILE,
    grassVariants,
    tree,
    rock,
    player,
  };
}
