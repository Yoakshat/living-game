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
    // Store campfire position for night-cycle glow
    this._campfireX = cfx;
    this._campfireY = cfy;

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

    // --- Day/night cycle overlay --------------------------------------------
    // Sits above the world but below HUD elements.
    // The overlay is a full-screen dark rectangle (camera-fixed) whose alpha
    // varies with the cycle phase.  At night we also punch a "torch" hole
    // around each player so they can only see ~150 px around themselves, and
    // lighter glow halos around landmark beacons (campfire, well, cave area).
    //
    // Cycle timing (ms):
    //   DAY  180 000  (3 min, fully transparent overlay)
    //   DUSK  60 000  (1 min transition day→night)
    //   NIGHT 120 000 (2 min dark)
    //   DAWN  60 000  (1 min transition night→day)
    //   Total cycle: 420 000 ms (7 min)
    this._DN_DAY_MS   = 180000;
    this._DN_DUSK_MS  =  60000;
    this._DN_NIGHT_MS = 120000;
    this._DN_DAWN_MS  =  60000;
    this._DN_CYCLE_MS = this._DN_DAY_MS + this._DN_DUSK_MS + this._DN_NIGHT_MS + this._DN_DAWN_MS;
    this._dnStartTime = 0;  // set in update once time is available

    // Graphics layer: world-space, high depth but below HUD.
    this._nightOverlay = this.add.graphics();
    this._nightOverlay.setDepth(9500);

    // Small clock label (camera-fixed, bottom-right).
    this._clockLabel = this.add
      .text(0, 0, 'Day', {
        fontFamily: '"Palatino Linotype", Palatino, serif',
        fontSize: '13px',
        color: '#ffe9b0',
        stroke: '#241a08',
        strokeThickness: 3,
      })
      .setOrigin(1, 1)
      .setScrollFactor(0)
      .setDepth(10004);

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
    this._wellX = wellX;
    this._wellY = wellY;

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

    // --- Sith meditation chamber (north bank, ~55%, 12%) ---------------------
    // A dark circular stone platform with a faint red glow — a place of silent power.
    const mcX = Math.round(this.worldW * 0.55);
    const mcY = Math.round(this.worldH * 0.12);
    this.add.image(mcX, mcY, 'meditation-chamber').setOrigin(0.5, 0.5).setDepth(mcY + meta.meditationChamber.h / 2);

    // --- Ruined stone arch (far northwest corner, ~8%, 8%) ------------------
    // A crumbling ancient arch swallowed by vines and moss — a remnant of a
    // lost civilization that bold explorers can discover at the world's edge.
    // Static collidable object so players must navigate around it.
    const archX = Math.round(this.worldW * 0.08);
    const archY = Math.round(this.worldH * 0.08);
    const archSprite = this.obstacles.create(archX, archY, 'stone-arch');
    archSprite.setOrigin(0.5, 0.5);
    const archW = meta.stoneArch.w;
    const archH = meta.stoneArch.h;
    // Collision body covers the base of both pillars (lower ~40% of the texture).
    const archBodyW = archW * 0.85;
    const archBodyH = archH * 0.38;
    archSprite.body.setSize(archBodyW, archBodyH);
    archSprite.body.setOffset((archW - archBodyW) / 2, archH - archBodyH - 4);
    archSprite.setDepth(archY + archH / 2);
    archSprite.refreshBody();

    // --- Ancient rune stone (inside cave, ~75%, 24%) -----------------------
    // A glowing rune-covered slab deep in the cave. Pulsing with cold light.
    // When the player stands within 2 tiles (~96px), a cryptic message appears.
    const rsX = Math.round(this.worldW * 0.75);
    const rsY = Math.round(this.worldH * 0.24);
    this._runeStoneX = rsX;
    this._runeStoneY = rsY;
    this._runeStoneSprite = this.add
      .image(rsX, rsY, 'rune-stone')
      .setOrigin(0.5, 0.5)
      .setDepth(rsY + meta.runeStone.h / 2);

    // Cryptic message overlay — camera-fixed, shown when player is near the stone.
    this._runeMsgVisible = false;
    this._runeMsgBg = this.add.graphics();
    this._runeMsgBg.setScrollFactor(0);
    this._runeMsgBg.setDepth(10001);
    this._runeMsgBg.setAlpha(0);

    this._runeMsgText = this.add
      .text(0, 0, 'THE PATH UNSEEN IS THE TRUEST WAY', {
        fontFamily: '"Palatino Linotype", Palatino, serif',
        fontSize: '15px',
        color: '#88ffdd',
        stroke: '#001a0e',
        strokeThickness: 4,
        align: 'center',
        wordWrap: { width: 280 },
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(10002)
      .setAlpha(0);

    // --- Map fragments (hidden in the world's distant corners/edges) -------
    // Collectibles that reward thorough exploration. Each is a torn parchment
    // scrap placed near a corner or far edge of the world. Walking within
    // pickup range collects it; collecting all of them reveals the full map.
    // No physics body — pickup is a simple distance check in update().
    const fragmentSpots = [
      { x: this.worldW * 0.04, y: this.worldH * 0.04 },   // far NW corner
      { x: this.worldW * 0.96, y: this.worldH * 0.05 },   // far NE corner
      { x: this.worldW * 0.04, y: this.worldH * 0.95 },   // far SW corner
      { x: this.worldW * 0.97, y: this.worldH * 0.92 },   // far SE corner
      { x: this.worldW * 0.50, y: this.worldH * 0.02 },   // far north edge, mid
    ];
    this._fragments = fragmentSpots.map((spot, i) => {
      const fx = Math.round(spot.x);
      const fy = Math.round(spot.y);
      const sprite = this.add
        .image(fx, fy, 'map-fragment')
        .setOrigin(0.5, 0.5)
        .setDepth(fy + meta.mapFragment.h / 2);
      return { id: i, x: fx, y: fy, sprite, collected: false };
    });
    this._fragmentsCollected = 0;
    this._fragmentsTotal = this._fragments.length;

    // Fragment counter — small camera-fixed HUD text, top-left.
    this._fragmentCounterText = this.add
      .text(0, 0, this._fragmentCounterLabel(), {
        fontFamily: '"Palatino Linotype", Palatino, serif',
        fontSize: '14px',
        color: '#ffe9b0',
        stroke: '#241a08',
        strokeThickness: 4,
      })
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(10003);

    // Toast — brief camera-fixed message shown on pickup / full discovery.
    this._toastText = this.add
      .text(0, 0, '', {
        fontFamily: '"Palatino Linotype", Palatino, serif',
        fontSize: '16px',
        color: '#ffd66b',
        stroke: '#241a08',
        strokeThickness: 4,
        align: 'center',
        wordWrap: { width: 360 },
      })
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(10003)
      .setAlpha(0);
    this._toastTimer = null;

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

  // ---- Map fragment helpers --------------------------------------------------
  _fragmentCounterLabel() {
    return `Map fragments: ${this._fragmentsCollected}/${this._fragmentsTotal}`;
  }

  _showToast(message, duration = 2600) {
    if (this._toastTimer) {
      this._toastTimer.remove();
      this._toastTimer = null;
    }
    const camW = this.cameras.main.width;
    const camH = this.cameras.main.height;
    this._toastText.setText(message);
    this._toastText.setPosition(camW / 2, camH * 0.18);
    this._toastText.setAlpha(1);
    this._toastTimer = this.time.delayedCall(duration, () => {
      this._toastText.setAlpha(0);
    });
  }

  _checkFragmentPickups() {
    const PICKUP_DIST = 36;
    for (const frag of this._fragments) {
      if (frag.collected) continue;
      const d = Phaser.Math.Distance.Between(
        this.player.x, this.player.y, frag.x, frag.y
      );
      if (d < PICKUP_DIST) {
        frag.collected = true;
        frag.sprite.destroy();
        this._fragmentsCollected++;
        this._fragmentCounterText.setText(this._fragmentCounterLabel());

        if (this._fragmentsCollected >= this._fragmentsTotal) {
          this._showToast('World map fully discovered!', 4000);
          console.log('[map fragments] world map fully discovered');
        } else {
          this._showToast(
            `Map fragment found! (${this._fragmentsCollected}/${this._fragmentsTotal})`
          );
        }
      }
    }
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

    // ---- Day / night cycle --------------------------------------------------
    // Initialise start time on the first update tick.
    if (this._dnStartTime === 0) this._dnStartTime = time;

    const elapsed = (time - this._dnStartTime) % this._DN_CYCLE_MS;
    const DAY   = this._DN_DAY_MS;
    const DUSK  = this._DN_DUSK_MS;
    const NIGHT = this._DN_NIGHT_MS;
    const DAWN  = this._DN_DAWN_MS;

    // nightAlpha: 0 = full day, 1 = full night.
    let nightAlpha = 0;
    let phaseLabel = 'Day';
    if (elapsed < DAY) {
      nightAlpha = 0;
      phaseLabel = 'Day';
    } else if (elapsed < DAY + DUSK) {
      nightAlpha = (elapsed - DAY) / DUSK;
      phaseLabel = 'Dusk';
    } else if (elapsed < DAY + DUSK + NIGHT) {
      nightAlpha = 1;
      phaseLabel = 'Night';
    } else {
      nightAlpha = 1 - (elapsed - DAY - DUSK - NIGHT) / DAWN;
      phaseLabel = 'Dawn';
    }

    this._nightOverlay.clear();
    if (nightAlpha > 0.01) {
      const cam = this.cameras.main;
      const camX = cam.scrollX;
      const camY = cam.scrollY;
      const camW = cam.width;
      const camH = cam.height;
      const zoom = cam.zoom;
      // World-pixel dimensions that fill the viewport.
      const wW = camW / zoom;
      const wH = camH / zoom;

      // Max darkness alpha at full night.
      const maxAlpha = 0.85;
      const overlayAlpha = nightAlpha * maxAlpha;

      // Player visibility radius in world pixels.
      const VIS_R = 150;
      // Beacon glow radius (campfire, well) — slightly wider than player.
      const BEACON_R = 80;
      // How many gradient steps to approximate a radial gradient.
      const STEPS = 24;

      // Helper: draw a radial "hole" cutout that softens at the edge.
      // We draw a series of concentric circles from inside out, fading from
      // 0 alpha (transparent, = visible area) to overlayAlpha (dark).
      const drawHole = (wx, wy, radius) => {
        for (let s = 0; s < STEPS; s++) {
          const t2 = s / STEPS;
          const holeAlpha = overlayAlpha * t2 * t2; // quadratic fade
          const r = radius * (1 - t2);
          this._nightOverlay.fillStyle(0x000d1a, holeAlpha);
          this._nightOverlay.fillCircle(wx, wy, r);
        }
      };

      // 1. Draw the base dark overlay covering the full visible world area.
      this._nightOverlay.fillStyle(0x000d1a, overlayAlpha);
      this._nightOverlay.fillRect(camX, camY, wW, wH);

      // 2. Punch visibility holes — local player.
      drawHole(this.player.x, this.player.y, VIS_R);

      // 3. Remote players also get a small personal visibility radius.
      for (const [, rp] of this.remotePlayers) {
        drawHole(rp.sprite.x, rp.sprite.y, VIS_R * 0.8);
      }

      // 4. Campfire beacon glow (warm orange tint).
      for (let s = 0; s < STEPS; s++) {
        const t2 = s / STEPS;
        const holeAlpha = overlayAlpha * t2 * t2;
        const r = BEACON_R * (1 - t2);
        this._nightOverlay.fillStyle(0xff6a00, holeAlpha);
        this._nightOverlay.fillCircle(this._campfireX, this._campfireY, r);
      }

      // 5. Well beacon glow (soft blue).
      for (let s = 0; s < STEPS; s++) {
        const t2 = s / STEPS;
        const holeAlpha = overlayAlpha * t2 * t2;
        const r = BEACON_R * 0.7 * (1 - t2);
        this._nightOverlay.fillStyle(0x4488ff, holeAlpha);
        this._nightOverlay.fillCircle(this._wellX, this._wellY, r);
      }

      // 6. Cave entrance beacon (faint purple).
      for (let s = 0; s < STEPS; s++) {
        const t2 = s / STEPS;
        const holeAlpha = overlayAlpha * t2 * t2;
        const r = BEACON_R * 0.6 * (1 - t2);
        this._nightOverlay.fillStyle(0xaa44cc, holeAlpha);
        this._nightOverlay.fillCircle(this._caveX, this._caveY, r);
      }
    }

    // Clock label — bottom-right of viewport.
    {
      const cam = this.cameras.main;
      this._clockLabel.setText(phaseLabel);
      this._clockLabel.setPosition(cam.width - 8, cam.height - 8);
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

    // Map fragments: pulse a soft golden glow and check for player pickup.
    const fragPulse = 0.5 + 0.5 * Math.sin(time * 0.0035);
    const fragTint = Phaser.Display.Color.GetColor(
      255,
      Math.round(210 + fragPulse * 45),
      Math.round(140 + fragPulse * 90)
    );
    for (const frag of this._fragments) {
      if (!frag.collected) frag.sprite.setTint(fragTint);
    }
    this._checkFragmentPickups();

    // Rune stone glow pulse — a slow sine-wave tint cycle on the stone sprite.
    // Alternates between pale cyan-white and the base sprite color.
    const pulse = 0.6 + 0.4 * Math.sin(time * 0.002);
    const glowTint = Phaser.Display.Color.GetColor(
      Math.round(68 + pulse * 100),   // R: 68–168
      Math.round(220 + pulse * 35),   // G: 220–255
      Math.round(180 + pulse * 75)    // B: 180–255
    );
    this._runeStoneSprite.setTint(glowTint);

    // Rune stone proximity: show/hide cryptic message within ~96px (2 tiles).
    const RUNE_TRIGGER_DIST = 96;
    const runeDist = Phaser.Math.Distance.Between(
      this.player.x, this.player.y, this._runeStoneX, this._runeStoneY
    );
    const nearRune = runeDist < RUNE_TRIGGER_DIST;

    if (nearRune !== this._runeMsgVisible) {
      this._runeMsgVisible = nearRune;
      const targetAlpha = nearRune ? 1 : 0;
      this.tweens.add({
        targets: [this._runeMsgBg, this._runeMsgText],
        alpha: targetAlpha,
        duration: 400,
        ease: 'Sine.easeInOut',
      });

      if (nearRune) {
        // Position the message panel at the bottom-center of the viewport.
        const camW = this.cameras.main.width;
        const camH = this.cameras.main.height;
        const panelW = 320;
        const panelH = 64;
        const px = camW / 2;
        const py = camH - 60;

        this._runeMsgBg.clear();
        this._runeMsgBg.fillStyle(0x000000, 0.72);
        this._runeMsgBg.strokeRect(px - panelW / 2 - 1, py - panelH / 2 - 1, panelW + 2, panelH + 2);
        this._runeMsgBg.fillRoundedRect(px - panelW / 2, py - panelH / 2, panelW, panelH, 6);
        this._runeMsgBg.lineStyle(1, 0x44ffcc, 0.5);
        this._runeMsgBg.strokeRoundedRect(px - panelW / 2, py - panelH / 2, panelW, panelH, 6);
        this._runeMsgText.setPosition(px, py);
      }
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
