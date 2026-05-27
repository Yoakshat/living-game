import { generateTextures } from '../textures.js';

// World is measured in tiles; pixel size derives from the tile size.
const WORLD_TILES_X = 32;
const WORLD_TILES_Y = 24;

const PLAYER_SPEED = 200; // px/sec

export default class WorldScene extends Phaser.Scene {
  constructor() {
    super('WorldScene');
  }

  create() {
    const meta = generateTextures(this);
    this.meta = meta;
    const T = meta.tile;

    this.worldW = WORLD_TILES_X * T;
    this.worldH = WORLD_TILES_Y * T;

    this.physics.world.setBounds(0, 0, this.worldW, this.worldH);

    // --- Grass ground ------------------------------------------------------
    // Tile the whole world with grass variants. A static TileSprite per row
    // would be cheaper, but per-tile variant selection gives the textured,
    // non-uniform field the spec wants. Deterministic variant pick from coords.
    this.add.rectangle(
      this.worldW / 2,
      this.worldH / 2,
      this.worldW,
      this.worldH,
      0x4a8c3f
    ); // safety base under tiles
    for (let ty = 0; ty < WORLD_TILES_Y; ty++) {
      for (let tx = 0; tx < WORLD_TILES_X; tx++) {
        const v = (tx * 7 + ty * 13 + ((tx * ty) % 5)) % meta.grassVariants;
        const img = this.add.image(tx * T, ty * T, 'grass-' + v).setOrigin(0, 0);
        // Subtle per-tile flip to further break up repetition.
        if ((tx + ty) % 2 === 0) img.setFlipX(true);
        if ((tx * ty) % 3 === 0) img.setFlipY(true);
      }
    }

    // --- Obstacles ---------------------------------------------------------
    this.obstacles = this.physics.add.staticGroup();

    const placements = this.buildPlacements(T);

    // Sort by Y so closer (lower) obstacles render in front of farther ones
    // for a believable top-down overlap.
    placements.sort((a, b) => a.y - b.y);

    for (const p of placements) {
      if (p.type === 'tree') {
        this.addTree(p.x, p.y);
      } else {
        this.addRock(p.x, p.y);
      }
    }

    // --- Player ------------------------------------------------------------
    // Spawn in a guaranteed-clear spot near the center.
    const spawn = this.findClearSpawn(placements, T);
    this.player = this.physics.add.sprite(spawn.x, spawn.y, 'player-down');
    this.player.setCollideWorldBounds(true);
    // Collision body sits around the feet/lower body so the head can overlap
    // canopy/obstacle tops naturally.
    const ps = meta.player.size;
    this.player.body.setSize(ps * 0.5, ps * 0.4);
    this.player.body.setOffset(ps * 0.25, ps * 0.5);
    this.player.setDepth(spawn.y); // depth-sort with obstacles
    this.facing = 'down';

    this.physics.add.collider(this.player, this.obstacles);

    // --- Camera ------------------------------------------------------------
    this.cameras.main.setBounds(0, 0, this.worldW, this.worldH);
    this.cameras.main.setBackgroundColor(0x2d402a);
    // Zoom in a touch so the player reads as a figure and obstacle detail is
    // legible in a screenshot, while still showing a generous slice of world.
    this.cameras.main.setZoom(1.6);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.cameras.main.setRoundPixels(true);

    // --- Input -------------------------------------------------------------
    this.keys = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
    // Stop keys from scrolling the page; keep focus on canvas.
    this.input.keyboard.addCapture(['W', 'A', 'S', 'D']);

    // Lightweight, non-visual hook for automated tests / agents to read state.
    // Does not render anything; safe to keep in production.
    const scene = this;
    window.__livingGame = {
      scene,
      world: { w: this.worldW, h: this.worldH },
      playerPos: () => ({ x: scene.player.x, y: scene.player.y }),
    };
  }

  // Distribute obstacles across the world in a scattered-but-not-uniform way.
  // Uses jittered grid cells, skips some cells, and biases tree/rock mix so the
  // result feels like a small natural place rather than a regular grid.
  buildPlacements(T) {
    const rng = mulberry32(20260527);
    const placements = [];
    const cell = T * 3; // spacing between candidate cells
    const margin = T; // keep off the very edge
    for (let y = margin + cell / 2; y < this.worldH - margin; y += cell) {
      for (let x = margin + cell / 2; x < this.worldW - margin; x += cell) {
        // Skip ~40% of cells for open clearings.
        if (rng() < 0.4) continue;
        const jx = x + (rng() - 0.5) * cell * 0.7;
        const jy = y + (rng() - 0.5) * cell * 0.7;
        const type = rng() < 0.6 ? 'tree' : 'rock';
        placements.push({ x: Math.round(jx), y: Math.round(jy), type });
      }
    }
    return placements;
  }

  addTree(x, y) {
    const t = this.obstacles.create(x, y, 'tree');
    // Texture origin is center; physics body covers only the trunk base so the
    // player can walk "behind" the canopy.
    const w = this.meta.tree.w;
    const h = this.meta.tree.h;
    t.setOrigin(0.5, 0.5);
    // Trunk base is roughly the bottom-center.
    const bw = 18;
    const bh = 14;
    t.body.setSize(bw, bh);
    t.body.setOffset((w - bw) / 2, h - bh - 6);
    t.setDepth(y + h / 2);
    t.refreshBody();
  }

  addRock(x, y) {
    const r = this.obstacles.create(x, y, 'rock');
    const w = this.meta.rock.w;
    const h = this.meta.rock.h;
    r.setOrigin(0.5, 0.5);
    const bw = w * 0.78;
    const bh = h * 0.55;
    r.body.setSize(bw, bh);
    r.body.setOffset((w - bw) / 2, h - bh - 4);
    r.setDepth(y + h / 2);
    r.refreshBody();
  }

  // Find an open spot near center with no obstacle within a clearance radius.
  findClearSpawn(placements, T) {
    const cx = this.worldW / 2;
    const cy = this.worldH / 2;
    const clearance = T * 1.5;
    const candidates = [
      { x: cx, y: cy },
    ];
    // Spiral outward candidate offsets.
    for (let r = 1; r <= 8; r++) {
      for (const a of [0, 90, 180, 270, 45, 135, 225, 315]) {
        const rad = (a * Math.PI) / 180;
        candidates.push({
          x: cx + Math.cos(rad) * r * T,
          y: cy + Math.sin(rad) * r * T,
        });
      }
    }
    for (const c of candidates) {
      let ok = true;
      for (const p of placements) {
        const d = Phaser.Math.Distance.Between(c.x, c.y, p.x, p.y);
        if (d < clearance) {
          ok = false;
          break;
        }
      }
      if (ok) return c;
    }
    return { x: cx, y: cy };
  }

  update() {
    const k = this.keys;
    const body = this.player.body;

    let vx = 0;
    let vy = 0;
    if (k.left.isDown) vx -= 1;
    if (k.right.isDown) vx += 1;
    if (k.up.isDown) vy -= 1;
    if (k.down.isDown) vy += 1;
    // Opposing keys (e.g. A+D) sum to 0 above -> no net movement, no jitter.

    if (vx !== 0 || vy !== 0) {
      // Normalize so diagonals aren't faster than straight lines.
      const len = Math.hypot(vx, vy);
      body.setVelocity((vx / len) * PLAYER_SPEED, (vy / len) * PLAYER_SPEED);

      // Pick facing texture from dominant axis.
      let dir = this.facing;
      if (Math.abs(vx) > Math.abs(vy)) {
        dir = vx < 0 ? 'left' : 'right';
      } else {
        dir = vy < 0 ? 'up' : 'down';
      }
      if (dir !== this.facing) {
        this.facing = dir;
        this.player.setTexture('player-' + dir);
      }
    } else {
      body.setVelocity(0, 0);
    }

    // Keep player depth-sorted against obstacles as it moves.
    this.player.setDepth(this.player.y);
  }
}

// Deterministic PRNG so world layout is stable across loads.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
