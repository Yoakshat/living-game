import { generateTextures } from '../textures.js';
import { io } from 'socket.io-client';
import { GameLog } from '../ui/GameLog.js';

// World is measured in tiles; pixel size derives from the tile size.
const WORLD_TILES_X = 32;
const WORLD_TILES_Y = 24;

const PLAYER_SPEED = 200; // px/sec

// How often we emit our position to the server (ms). 50ms ≈ 20 Hz.
const MOVE_EMIT_INTERVAL = 50;

// How quickly remote players interpolate toward their target position.
// 0 = no lerp (instant), 1 = never arrives. Good range: 0.15–0.3 per frame.
const LERP_ALPHA = 0.2;

export default class WorldScene extends Phaser.Scene {
  constructor() {
    super('WorldScene');
    // Map of remote players: id → { sprite, nameTag, targetX, targetY }
    this.remotePlayers = new Map();
    this._socket = null;
    this._selfId = null;
    this._selfColor = null;
    this._selfName = null;
    // Queue events that arrive before the scene is fully ready.
    this._eventQueue = [];
    this._ready = false;
    this._lastEmitTime = 0;
    // Game log panel
    this._gameLog = null;
  }

  create() {
    const meta = generateTextures(this);
    this.meta = meta;
    const T = meta.tile;

    this.worldW = WORLD_TILES_X * T;
    this.worldH = WORLD_TILES_Y * T;

    this.physics.world.setBounds(0, 0, this.worldW, this.worldH);

    // --- Grass ground -------------------------------------------------------
    this.add.rectangle(
      this.worldW / 2,
      this.worldH / 2,
      this.worldW,
      this.worldH,
      0x4a8c3f
    );
    for (let ty = 0; ty < WORLD_TILES_Y; ty++) {
      for (let tx = 0; tx < WORLD_TILES_X; tx++) {
        const v = (tx * 7 + ty * 13 + ((tx * ty) % 5)) % meta.grassVariants;
        const img = this.add.image(tx * T, ty * T, 'grass-' + v).setOrigin(0, 0);
        if ((tx + ty) % 2 === 0) img.setFlipX(true);
        if ((tx * ty) % 3 === 0) img.setFlipY(true);
      }
    }

    // --- Obstacles ----------------------------------------------------------
    this.obstacles = this.physics.add.staticGroup();

    const placements = this.buildPlacements(T);
    placements.sort((a, b) => a.y - b.y);

    for (const p of placements) {
      if (p.type === 'tree') {
        this.addTree(p.x, p.y);
      } else {
        this.addRock(p.x, p.y);
      }
    }

    // --- Campfire (decorative landmark at world center) ---------------------
    const cfx = this.worldW / 2;
    const cfy = this.worldH / 2;
    this.add.image(cfx, cfy, 'campfire').setDepth(cfy);

    // --- River (horizontal water strip, ~30% down the map) ------------------
    // Tiles row 6-8 (0-indexed), full width. Static bodies block passage.
    this.buildRiver(T);

    // --- Stone bridge (crossing the river near the cave) --------------------
    // Three tile columns left open in the river; bridge tiles laid on top.
    this.buildBridge(T);

    // --- Cave entrance (upper-right area) -----------------------------------
    // Purely visual landmark — no collision.
    const caveX = Math.round(this.worldW * 0.75);
    const caveY = Math.round(this.worldH * 0.25);
    this.add
      .image(caveX, caveY, 'cave')
      .setOrigin(0.5, 0.5)
      .setDepth(caveY + meta.cave.h / 2);
    this._caveX = caveX;
    this._caveY = caveY;

    // Darkness overlay — fades in as the player approaches the cave.
    // Camera-fixed so it covers the whole viewport regardless of scroll.
    this._caveVignette = this.add.graphics();
    this._caveVignette.setScrollFactor(0);
    this._caveVignette.setDepth(10000);

    // --- Well (south-west quadrant, central-ish) ----------------------------
    // Purely visual landmark — no collision.
    const wellX = Math.round(this.worldW * 0.35);
    const wellY = Math.round(this.worldH * 0.62);
    this.add
      .image(wellX, wellY, 'well')
      .setOrigin(0.5, 0.5)
      .setDepth(wellY + meta.well.h / 2);

    // --- Healing spring (south-east quadrant) --------------------------------
    // A peaceful glowing pool — no collision. A place of rest for weary travelers.
    const springX = Math.round(this.worldW * 0.65);
    const springY = Math.round(this.worldH * 0.72);
    this.add
      .image(springX, springY, 'healing-spring')
      .setOrigin(0.5, 0.5)
      .setDepth(springY + meta.healingSpring.h / 2);

    // --- Imperial beacon tower (north bank, ~30%, 15%) -----------------------
    // A tall dark spire marking the seat of Imperial power — purely decorative.
    const btX = Math.round(this.worldW * 0.30);
    const btY = Math.round(this.worldH * 0.15);
    this.add.image(btX, btY, 'beacon-tower').setOrigin(0.5, 0.5).setDepth(btY + meta.beaconTower.h / 2);

    // --- Player -------------------------------------------------------------
    const spawn = this.findClearSpawn(placements, T);
    this.player = this.physics.add.sprite(spawn.x, spawn.y, 'player-down');
    this.player.setCollideWorldBounds(true);
    const ps = meta.player.size;
    this.player.body.setSize(ps * 0.5, ps * 0.4);
    this.player.body.setOffset(ps * 0.25, ps * 0.5);
    this.player.setDepth(spawn.y);
    this.facing = 'down';

    this.physics.add.collider(this.player, this.obstacles);

    // --- Camera -------------------------------------------------------------
    this.cameras.main.setBounds(0, 0, this.worldW, this.worldH);
    this.cameras.main.setBackgroundColor(0x2d402a);
    this.cameras.main.setZoom(1.6);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.cameras.main.setRoundPixels(true);

    // --- Input --------------------------------------------------------------
    this.keys = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
    });
    this.input.keyboard.addCapture(['W', 'A', 'S', 'D']);

    // --- Introspection hook -------------------------------------------------
    const scene = this;
    this._pendingVotes = []; // PRs waiting for this agent's vote
    window.__livingGame = {
      scene,
      world: { w: this.worldW, h: this.worldH },
      playerPos: () => ({ x: scene.player.x, y: scene.player.y }),
      remotePlayers: () =>
        [...scene.remotePlayers.entries()].map(([id, rp]) => ({
          id,
          x: rp.sprite.x,
          y: rp.sprite.y,
        })),
      // PRs this agent hasn't voted on yet
      pendingVotes: () => scene._pendingVotes,
      // Cast a vote — relayed to server via Socket.io
      castVote: (prNumber, vote) => {
        if (scene._socket) scene._socket.emit('pr:vote', { prNumber, vote });
        scene._pendingVotes = scene._pendingVotes.filter((p) => p.number !== prNumber);
      },
    };

    // --- Local player name tag ----------------------------------------------
    // Will be set once we get self:init from server.
    this._selfNameTag = null;

    // --- Connect to multiplayer server --------------------------------------
    this._connectMultiplayer(spawn);

    // --- Game log panel -----------------------------------------------------
    const logServerUrl =
      (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SERVER_URL)
        ? import.meta.env.VITE_SERVER_URL
        : 'http://localhost:3001';
    this._gameLog = new GameLog(logServerUrl);

    // Mark scene ready — flush any queued events.
    this._ready = true;
    for (const fn of this._eventQueue) fn();
    this._eventQueue = [];
  }

  _connectMultiplayer(spawn) {
    const serverUrl =
      (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SERVER_URL)
        ? import.meta.env.VITE_SERVER_URL
        : 'http://localhost:3001';

    let socket;
    try {
      socket = io(serverUrl, {
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 5000,
      });
    } catch (err) {
      console.warn('[multiplayer] Could not create socket:', err);
      return;
    }

    this._socket = socket;

    socket.on('connect', () => {
      console.log('[multiplayer] connected:', socket.id);
      // Send character name and GitHub username (from URL params) so the server
      // can use them as the display name and identity key.
      const params = new URLSearchParams(window.location.search);
      const characterName = params.get('characterName') || '';
      const githubUser = params.get('gh') || '';
      socket.emit('player:identify', { name: characterName, githubUser });
      // Emit our spawn position so the server state is accurate immediately.
      socket.emit('player:move', { x: this.player.x, y: this.player.y });
    });

    socket.on('connect_error', (err) => {
      console.warn('[multiplayer] connection error — playing offline:', err.message);
    });

    // Server sends our identity + full current player list.
    socket.on('self:init', (data) => {
      this._enqueue(() => this._onSelfInit(data));
    });

    // A new player joined while we were already connected.
    socket.on('player:join', (data) => {
      this._enqueue(() => this._onPlayerJoin(data));
    });

    // A remote player moved.
    socket.on('player:moved', (data) => {
      this._enqueue(() => this._onPlayerMoved(data));
    });

    // A player disconnected.
    socket.on('player:left', (data) => {
      this._enqueue(() => this._onPlayerLeft(data));
    });

    // A player's name was updated (after player:identify).
    socket.on('player:renamed', (data) => {
      this._enqueue(() => this._onPlayerRenamed(data));
    });

    // Server pushes PRs that need this agent's vote.
    socket.on('pr:review_needed', (incoming) => {
      this._enqueue(() => {
        for (const pr of incoming) {
          if (!this._pendingVotes.find((p) => p.number === pr.number)) {
            this._pendingVotes.push(pr);
            console.log(`[governance] PR #${pr.number} needs your vote: ${pr.title}`);
          }
        }
      });
    });

    // Server notifies agents that a PR's SHA changed — all prior votes were wiped.
    // Remove it from pending (in case it was already queued) then re-add it so
    // the agent re-reviews the updated diff.
    socket.on('pr:revote', ({ prNumber, sha }) => {
      this._enqueue(() => {
        this._pendingVotes = this._pendingVotes.filter((p) => p.number !== prNumber);
        // Re-fetch the PR info from the tally so we have title/url.
        // For now just log — the server will re-emit pr:review_needed once CI passes on the new SHA.
        console.log(`[governance] PR #${prNumber} updated (SHA ${sha.slice(0, 7)}) — votes wiped, awaiting new CI green`);
      });
    });

    socket.on('disconnect', (reason) => {
      console.warn('[multiplayer] disconnected:', reason);
    });
  }

  // Queue an event handler to run after scene is ready, or run immediately.
  _enqueue(fn) {
    if (this._ready) {
      fn();
    } else {
      this._eventQueue.push(fn);
    }
  }

  _onSelfInit(data) {
    const { id, color, name, others } = data;
    this._selfId = id;
    this._selfColor = color;
    this._selfName = name;

    // Tint local player sprite to server-assigned color.
    this.player.setTint(Phaser.Display.Color.HexStringToColor(color).color);

    // Local player name tag.
    this._selfNameTag = this._makeNameTag(name);

    // Register color for log panel
    if (this._gameLog) this._gameLog.setPlayerColor(name, color);

    // Render all players already in the world.
    for (const other of others) {
      this._spawnRemotePlayer(other);
    }
  }

  _onPlayerJoin(data) {
    if (data.id === this._selfId) return; // shouldn't happen, but guard
    this._spawnRemotePlayer(data);
  }

  _onPlayerMoved(data) {
    const rp = this.remotePlayers.get(data.id);
    if (!rp) return;
    rp.targetX = data.x;
    rp.targetY = data.y;
  }

  _onPlayerLeft(data) {
    const rp = this.remotePlayers.get(data.id);
    if (!rp) return;
    rp.sprite.destroy();
    rp.nameTag.destroy();
    this.remotePlayers.delete(data.id);
    console.log('[multiplayer] player left:', data.id);
  }

  _onPlayerRenamed(data) {
    const { id, name } = data;
    // Update local player name tag if this is us.
    if (id === this._selfId) {
      this._selfName = name;
      if (this._selfNameTag) {
        this._selfNameTag.setText(name);
      }
      // Re-register color under new name for log panel
      if (this._selfColor && this._gameLog) {
        this._gameLog.setPlayerColor(name, this._selfColor);
      }
      return;
    }
    // Update remote player name tag.
    const rp = this.remotePlayers.get(id);
    if (!rp) return;
    rp.nameTag.setText(name);
    // Re-register color under new name for log panel
    if (rp.color && this._gameLog) {
      this._gameLog.setPlayerColor(name, rp.color);
    }
  }

  // Create a remote player sprite + name tag and add to the map.
  _spawnRemotePlayer({ id, color, name, x, y }) {
    if (this.remotePlayers.has(id)) return; // already exists (duplicate event)

    const sprite = this.physics.add.sprite(x, y, 'player-down');
    // Remove body so remote players don't collide with anything.
    sprite.body.enable = false;

    // Apply the server-assigned color as a tint.
    const tintColor = Phaser.Display.Color.HexStringToColor(color).color;
    sprite.setTint(tintColor);
    sprite.setDepth(y);

    const nameTag = this._makeNameTag(name);

    this.remotePlayers.set(id, {
      sprite,
      nameTag,
      targetX: x,
      targetY: y,
      color,
    });

    // Register color for log panel
    if (this._gameLog) this._gameLog.setPlayerColor(name, color);

    console.log('[multiplayer] player joined:', id, name, color);
  }

  // Create a floating name tag text.
  _makeNameTag(name) {
    return this.add
      .text(0, 0, name, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '11px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
        resolution: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(99999);
  }

  // ---- Obstacle helpers (unchanged) ----------------------------------------
  buildPlacements(T) {
    const rng = mulberry32(20260527);
    const placements = [];
    const cell = T * 3;
    const margin = T;
    for (let y = margin + cell / 2; y < this.worldH - margin; y += cell) {
      for (let x = margin + cell / 2; x < this.worldW - margin; x += cell) {
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
    const w = this.meta.tree.w;
    const h = this.meta.tree.h;
    t.setOrigin(0.5, 0.5);
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

  // Tile columns that are open for the stone bridge crossing (no water collision).
  // Centered around tile x=24 (cave entrance x) so the path leads straight to the cave.
  static get BRIDGE_COLS() { return [22, 23, 24]; }

  // Build a horizontal river: tile rows RIVER_ROW_START to RIVER_ROW_END (inclusive).
  // Each tile is a visual image + a static physics body blocking passage.
  // Bridge columns are left open (visual water only, no collision body) so the
  // stone bridge overlay lets players cross.
  buildRiver(T) {
    const RIVER_ROW_START = 6;
    const RIVER_ROW_END = 8; // 3 tiles tall
    const bridgeCols = new Set(WorldScene.BRIDGE_COLS);
    for (let ty = RIVER_ROW_START; ty <= RIVER_ROW_END; ty++) {
      for (let tx = 0; tx < WORLD_TILES_X; tx++) {
        const v = (tx * 3 + ty * 7) % this.meta.waterVariants;
        const wx = tx * T;
        const wy = ty * T;
        // Visual tile (drawn before obstacles so it appears under trees/rocks).
        this.add
          .image(wx, wy, 'water-' + v)
          .setOrigin(0, 0)
          .setDepth(wy);

        // Bridge columns: no collision body — players can walk across.
        if (bridgeCols.has(tx)) continue;

        // Physics body to block player passage through the water.
        const body = this.obstacles.create(wx + T / 2, wy + T / 2, 'water-' + v);
        body.setOrigin(0.5, 0.5);
        body.body.setSize(T, T);
        body.setDepth(wy);
        body.setAlpha(0); // invisible — the visual image above handles rendering
        body.refreshBody();
      }
    }
  }

  // Lay stone bridge tiles over the open gap in the river.
  // The bridge tiles render above the water and below any player/obstacle on top.
  buildBridge(T) {
    const RIVER_ROW_START = 6;
    const RIVER_ROW_END = 8;
    for (const tx of WorldScene.BRIDGE_COLS) {
      for (let ty = RIVER_ROW_START; ty <= RIVER_ROW_END; ty++) {
        const wx = tx * T;
        const wy = ty * T;
        // Bridge tile sits above water (depth wy + 1) but below players.
        this.add
          .image(wx, wy, 'bridge')
          .setOrigin(0, 0)
          .setDepth(wy + 1);
      }
    }
  }

  findClearSpawn(placements, T) {
    const cx = this.worldW / 2;
    const cy = this.worldH / 2;
    const clearance = T * 1.5;
    const candidates = [{ x: cx, y: cy }];
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

  // ---- Update loop ---------------------------------------------------------
  update(time) {
    const k = this.keys;
    const body = this.player.body;

    let vx = 0;
    let vy = 0;
    if (k.left.isDown) vx -= 1;
    if (k.right.isDown) vx += 1;
    if (k.up.isDown) vy -= 1;
    if (k.down.isDown) vy += 1;

    if (vx !== 0 || vy !== 0) {
      const len = Math.hypot(vx, vy);
      body.setVelocity((vx / len) * PLAYER_SPEED, (vy / len) * PLAYER_SPEED);

      let dir = this.facing;
      if (Math.abs(vx) > Math.abs(vy)) {
        dir = vx < 0 ? 'left' : 'right';
      } else {
        dir = vy < 0 ? 'up' : 'down';
      }
      if (dir !== this.facing) {
        this.facing = dir;
        this.player.setTexture('player-' + dir);
        // Re-apply tint after texture change.
        if (this._selfColor) {
          this.player.setTint(
            Phaser.Display.Color.HexStringToColor(this._selfColor).color
          );
        }
      }
    } else {
      body.setVelocity(0, 0);
    }

    this.player.setDepth(this.player.y);

    // Emit position at ~20Hz while connected.
    if (this._socket && this._socket.connected) {
      if (time - this._lastEmitTime >= MOVE_EMIT_INTERVAL) {
        this._lastEmitTime = time;
        this._socket.emit('player:move', {
          x: this.player.x,
          y: this.player.y,
        });
      }
    }

    // Local player name tag follows the sprite.
    if (this._selfNameTag) {
      this._selfNameTag.setPosition(
        this.player.x,
        this.player.y - this.meta.player.size / 2 - 4
      );
    }

    // Update remote players: lerp toward target + update name tags.
    for (const [, rp] of this.remotePlayers) {
      rp.sprite.x = Phaser.Math.Linear(rp.sprite.x, rp.targetX, LERP_ALPHA);
      rp.sprite.y = Phaser.Math.Linear(rp.sprite.y, rp.targetY, LERP_ALPHA);
      rp.sprite.setDepth(rp.sprite.y);
      rp.nameTag.setPosition(
        rp.sprite.x,
        rp.sprite.y - this.meta.player.size / 2 - 4
      );
    }

    // Cave darkness: dim the screen as the player enters the cave.
    // Radius at which darkness starts (world pixels). At center: max darkness.
    const CAVE_DARK_RADIUS = 140;
    const dist = Phaser.Math.Distance.Between(
      this.player.x, this.player.y, this._caveX, this._caveY
    );
    const alpha = Phaser.Math.Clamp(1 - dist / CAVE_DARK_RADIUS, 0, 1) * 0.7;
    this._caveVignette.clear();
    if (alpha > 0.01) {
      this._caveVignette.fillStyle(0x000000, alpha);
      this._caveVignette.fillRect(
        0, 0,
        this.cameras.main.width,
        this.cameras.main.height
      );
    }
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
