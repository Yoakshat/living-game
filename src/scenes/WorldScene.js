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

// How long scrolls persist before disappearing (ms) — 10 minutes.
const SCROLL_TTL = 10 * 60 * 1000;
// How close a player must be to read a scroll (2 tiles in world pixels).
const SCROLL_READ_DIST = 96;
// Max characters allowed in an explorer note.
const SCROLL_MAX_CHARS = 40;

// Trail tile size: ~48px grid for tracking footsteps.
const TRAIL_TILE = 48;
// Number of visits before a tile becomes a worn dirt trail.
const TRAIL_THRESHOLD = 3;
// How long a trail persists after last visit (5 minutes in ms).
const TRAIL_TTL = 5 * 60 * 1000;
// Warm brown color for dirt trail, with ~40% alpha.
const TRAIL_COLOR = 0x8B4513;
const TRAIL_ALPHA = 0.4;

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
    // Explorer notes: array of { sprite, tooltip, message, expireAt }
    this._scrolls = [];
    // Whether the note-entry UI is open (prevents movement while typing).
    this._noteInputOpen = false;
    // Player-carved trails: map of "tx,ty" → { count, lastVisit, rect }
    this._trailMap = new Map();
    // The last trail tile the local player was on (to avoid duplicate counts).
    this._lastTrailTile = null;
    // Graphics layer for rendering trail dirt patches.
    this._trailGraphics = null;
    // Whether the trail layer needs a redraw.
    this._trailDirty = false;
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

    // --- Trail layer (below obstacles and players) --------------------------
    // Graphics object drawn just above the grass but below everything else.
    this._trailGraphics = this.add.graphics();
    this._trailGraphics.setDepth(1); // above grass (depth 0), below obstacles

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

    // --- Hidden ruins (placed in underexplored areas at the edges/corners) ----
    // Ruins start invisible (alpha=0). When any player walks within 3 tiles
    // (~144px), the ruin flashes into view permanently for all players.
    // Positions chosen to be far from the campfire center, river, and existing
    // landmarks — rewarding players who push to the edges of the world.
    const RUIN_SPOTS = [
      { x: this.worldW * 0.06, y: this.worldH * 0.55 },   // far west edge, mid
      { x: this.worldW * 0.94, y: this.worldH * 0.48 },   // far east edge, mid
      { x: this.worldW * 0.18, y: this.worldH * 0.90 },   // south-west deep corner
      { x: this.worldW * 0.82, y: this.worldH * 0.88 },   // south-east deep corner
      { x: this.worldW * 0.42, y: this.worldH * 0.96 },   // far south, slightly left
      { x: this.worldW * 0.72, y: this.worldH * 0.05 },   // far north, right of beacon
      { x: this.worldW * 0.14, y: this.worldH * 0.20 },   // upper-left, above river
    ];
    this._ruins = RUIN_SPOTS.map((spot, i) => {
      const rx = Math.round(spot.x);
      const ry = Math.round(spot.y);
      const sprite = this.add
        .image(rx, ry, 'ruin')
        .setOrigin(0.5, 0.5)
        .setDepth(ry + meta.ruin.h / 2)
        .setAlpha(0);  // hidden until discovered
      return { id: i, x: rx, y: ry, sprite, revealed: false };
    });

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
      beacon: Phaser.Input.Keyboard.KeyCodes.F,
    });
    this.input.keyboard.addCapture(['W', 'A', 'S', 'D', 'F']);

    // --- Wanderer beacons ---------------------------------------------------
    // Array of active beacons: { graphics, nameTag, x, y, plantedAt }
    this._beacons = [];
    // Cooldown: one beacon per 5 seconds to avoid spam.
    this._lastBeaconTime = -Infinity;
    this._BEACON_COOLDOWN_MS = 5000;
    // Beacon lifetime: 5 minutes.
    this._BEACON_LIFETIME_MS = 5 * 60 * 1000;

    // N key — open note-entry overlay to leave an explorer scroll.
    this.input.keyboard.on('keydown-N', () => {
      if (!this._noteInputOpen) this._openNoteInput();
    });

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

    // --- Meteor shower system ------------------------------------------------
    // Every 8 minutes a shooting star animation crosses the sky and lands at a
    // random map edge tile, leaving a glowing crater for 3 minutes. The first
    // player to walk within 2 tiles earns a Meteor Hunter log entry + a point.
    //
    // Live craters: [{ sprite, x, y, spawnTime, claimed }]
    this._meteors = [];
    // Schedule the first meteor after 8 minutes, then repeat.
    this.time.addEvent({
      delay: 480000,
      loop: true,
      callback: this._spawnMeteor,
      callbackScope: this,
    });

    // Mark scene ready — flush any queued events.
    this._ready = true;
    for (const fn of this._eventQueue) fn();
    this._eventQueue = [];
  }

  // ---- Meteor shower ---------------------------------------------------------

  // Pick a random edge tile position (top row, bottom row, left col, right col).
  _randomEdgeTile() {
    const T = this.meta.tile;
    const edge = Math.floor(Math.random() * 4); // 0=top,1=bottom,2=left,3=right
    let tx, ty;
    if (edge === 0) {
      tx = Math.floor(Math.random() * WORLD_TILES_X);
      ty = 0;
    } else if (edge === 1) {
      tx = Math.floor(Math.random() * WORLD_TILES_X);
      ty = WORLD_TILES_Y - 1;
    } else if (edge === 2) {
      tx = 0;
      ty = Math.floor(Math.random() * WORLD_TILES_Y);
    } else {
      tx = WORLD_TILES_X - 1;
      ty = Math.floor(Math.random() * WORLD_TILES_Y);
    }
    return { x: tx * T + T / 2, y: ty * T + T / 2 };
  }

  _spawnMeteor() {
    const target = this._randomEdgeTile();

    // Shooting star starts from the opposite corner of the screen, off-map.
    // We pick a start point well outside the world bounds on the opposite side.
    const startX = this.worldW - target.x + (Math.random() - 0.5) * 200;
    const startY = -80 - Math.random() * 80;

    // Create a small bright dot for the shooting star (camera-space independent).
    const star = this.add.graphics();
    star.setDepth(9999);
    // Bright yellow-white comet dot with a small glow.
    star.fillStyle(0xffffff, 1);
    star.fillCircle(0, 0, 4);
    star.fillStyle(0xffee44, 0.6);
    star.fillCircle(0, 0, 7);
    star.setPosition(startX, startY);

    // Tween the star across the world to the edge tile over ~1.8 seconds.
    this.tweens.add({
      targets: star,
      x: target.x,
      y: target.y,
      duration: 1800,
      ease: 'Sine.easeIn',
      onComplete: () => {
        star.destroy();
        this._placeCrater(target.x, target.y);
      },
    });
  }

  _placeCrater(wx, wy) {
    const sprite = this.add
      .image(wx, wy, 'meteor-crater')
      .setOrigin(0.5, 0.5)
      .setDepth(wy + this.meta.meteorCrater.h / 2);

    this._meteors.push({
      sprite,
      x: wx,
      y: wy,
      spawnTime: this.time.now,
      claimed: false,
    });
  }

  _checkMeteors(time) {
    const CRATER_LIFETIME = 3 * 60 * 1000; // 3 minutes
    const CLAIM_DIST = this.meta.tile * 2;  // 2 tiles in world pixels
    const serverUrl =
      (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SERVER_URL)
        ? import.meta.env.VITE_SERVER_URL
        : 'https://living-game-server-production.up.railway.app';

    for (let i = this._meteors.length - 1; i >= 0; i--) {
      const m = this._meteors[i];

      // Remove expired craters.
      if (time - m.spawnTime > CRATER_LIFETIME) {
        m.sprite.destroy();
        this._meteors.splice(i, 1);
        continue;
      }

      // Pulse glow on unclaimed craters.
      if (!m.claimed) {
        const pulse = 0.6 + 0.4 * Math.sin(time * 0.004);
        const glow = Phaser.Display.Color.GetColor(
          255,
          Math.round(100 + pulse * 80),
          Math.round(pulse * 50)
        );
        m.sprite.setTint(glow);

        // Check if local player is within 2 tiles.
        const dist = Phaser.Math.Distance.Between(
          this.player.x, this.player.y, m.x, m.y
        );
        if (dist < CLAIM_DIST) {
          m.claimed = true;
          // Dim the claimed crater.
          m.sprite.setTint(0x886644);
          // Log the Meteor Hunter event to the server.
          const playerName = this._selfName || 'Explorer';
          const msg = `${playerName} earns Meteor Hunter badge!`;
          fetch(`${serverUrl}/log-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerName, message: msg }),
          }).catch((err) => console.warn('[meteor] log-event failed:', err));
          console.log('[meteor] Meteor Hunter claimed by', playerName);
        }
      }
    }
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

    // Another player revealed a hidden ruin — make it visible locally too.
    socket.on('ruin:revealed', (data) => {
      this._enqueue(() => {
        const ruin = this._ruins && this._ruins.find((r) => r.id === data.ruinId);
        if (ruin && !ruin.revealed) {
          ruin.revealed = true;
          this.tweens.add({
            targets: ruin.sprite,
            alpha: 1,
            duration: 300,
            ease: 'Sine.easeOut',
            onStart: () => { ruin.sprite.setTint(0xffffff); },
            onComplete: () => { ruin.sprite.clearTint(); },
          });
        }
      });
    });

    socket.on('disconnect', (reason) => {
      console.warn('[multiplayer] disconnected:', reason);
    });

    // A player placed a scroll — spawn it locally.
    socket.on('scroll:placed', (data) => {
      this._enqueue(() => this._spawnScroll(data.x, data.y, data.message, data.expireAt));
    });

    // Another player formed or updated a trail tile — update locally.
    socket.on('trail:update', (data) => {
      this._enqueue(() => this._onTrailUpdate(data.tx, data.ty, data.count, data.lastVisit));
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

  // ---- Explorer notes (scrolls) ---------------------------------------------

  // Open an HTML overlay for the player to type a short note (up to 40 chars).
  _openNoteInput() {
    this._noteInputOpen = true;

    // Dim overlay so the input reads clearly.
    const overlay = document.createElement('div');
    overlay.id = 'note-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'display:flex',
      'flex-direction:column',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.55)',
      'z-index:9999',
      'font-family:"Palatino Linotype",Palatino,serif',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:#1a1208',
      'border:2px solid #c8a83a',
      'border-radius:8px',
      'padding:20px 28px',
      'display:flex',
      'flex-direction:column',
      'gap:12px',
      'max-width:360px',
      'width:90%',
    ].join(';');

    const label = document.createElement('div');
    label.textContent = 'Leave a note (up to 40 chars)';
    label.style.cssText = 'color:#f0d88a;font-size:15px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = SCROLL_MAX_CHARS;
    input.placeholder = 'A message for future explorers…';
    input.style.cssText = [
      'background:#2a1e08',
      'border:1px solid #c8a83a',
      'border-radius:4px',
      'color:#f0d88a',
      'font-family:"Palatino Linotype",Palatino,serif',
      'font-size:14px',
      'padding:8px 10px',
      'outline:none',
      'width:100%',
      'box-sizing:border-box',
    ].join(';');

    const charCount = document.createElement('div');
    charCount.textContent = '0 / 40';
    charCount.style.cssText = 'color:#a08050;font-size:12px;text-align:right;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = [
      'background:transparent',
      'border:1px solid #807040',
      'border-radius:4px',
      'color:#a08050',
      'cursor:pointer',
      'font-family:"Palatino Linotype",Palatino,serif',
      'font-size:13px',
      'padding:6px 14px',
    ].join(';');

    const leaveBtn = document.createElement('button');
    leaveBtn.textContent = 'Leave scroll';
    leaveBtn.style.cssText = [
      'background:#c8a83a',
      'border:none',
      'border-radius:4px',
      'color:#1a1208',
      'cursor:pointer',
      'font-family:"Palatino Linotype",Palatino,serif',
      'font-size:13px',
      'font-weight:bold',
      'padding:6px 14px',
    ].join(';');

    input.addEventListener('input', () => {
      charCount.textContent = `${input.value.length} / 40`;
    });

    const close = (submit) => {
      const msg = input.value.trim();
      document.body.removeChild(overlay);
      this._noteInputOpen = false;
      // Re-focus the canvas so keyboard events resume.
      this.game.canvas.focus();
      if (submit && msg.length > 0) {
        this._placeScroll(msg);
      }
    };

    cancelBtn.addEventListener('click', () => close(false));
    leaveBtn.addEventListener('click', () => close(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(true);
      if (e.key === 'Escape') close(false);
      e.stopPropagation(); // prevent game keys from firing
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(leaveBtn);
    panel.appendChild(label);
    panel.appendChild(input);
    panel.appendChild(charCount);
    panel.appendChild(btnRow);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    // Focus the input after appending.
    setTimeout(() => input.focus(), 0);
  }

  // Place a scroll at the player's current position.
  _placeScroll(message) {
    const x = this.player.x;
    const y = this.player.y;
    const expireAt = Date.now() + SCROLL_TTL;

    // Spawn the scroll locally.
    this._spawnScroll(x, y, message, expireAt);

    // Broadcast to other clients via socket.
    if (this._socket && this._socket.connected) {
      this._socket.emit('scroll:place', { x, y, message, expireAt });
    }
  }

  // Spawn a scroll sprite + tooltip at world coordinates.
  _spawnScroll(x, y, message, expireAt) {
    const sprite = this.add
      .image(x, y, 'scroll')
      .setOrigin(0.5, 0.5)
      .setDepth(y + this.meta.scroll.h / 2);

    // Pulse glow tint (handled in update loop).
    sprite.setTint(0xffd700);

    // Tooltip text — hidden until the player walks near.
    const tooltip = this.add
      .text(x, y - 28, message, {
        fontFamily: '"Palatino Linotype", Palatino, serif',
        fontSize: '12px',
        color: '#f0d88a',
        stroke: '#1a1208',
        strokeThickness: 3,
        align: 'center',
        wordWrap: { width: 180 },
        backgroundColor: '#1a120880',
        padding: { x: 6, y: 4 },
      })
      .setOrigin(0.5, 1)
      .setDepth(99998)
      .setAlpha(0);

    const scrollEntry = { sprite, tooltip, message, expireAt };
    this._scrolls.push(scrollEntry);

    // Auto-remove after TTL.
    const msLeft = expireAt - Date.now();
    this.time.delayedCall(Math.max(msLeft, 0), () => {
      this._removeScroll(scrollEntry);
    });
  }

  _removeScroll(entry) {
    entry.sprite.destroy();
    entry.tooltip.destroy();
    this._scrolls = this._scrolls.filter((s) => s !== entry);
  }

  // Called each update frame — handle scroll glow + proximity tooltips.
  _updateScrolls(time) {
    const pulse = 0.7 + 0.3 * Math.sin(time * 0.003);
    const tint = Phaser.Display.Color.GetColor(
      255,
      Math.round(180 + pulse * 75),
      Math.round(pulse * 60)
    );

    for (const entry of this._scrolls) {
      entry.sprite.setTint(tint);

      // Show/hide tooltip based on player proximity.
      const dist = Phaser.Math.Distance.Between(
        this.player.x, this.player.y,
        entry.sprite.x, entry.sprite.y
      );
      const targetAlpha = dist < SCROLL_READ_DIST ? 1 : 0;
      if (Math.abs(entry.tooltip.alpha - targetAlpha) > 0.05) {
        entry.tooltip.setAlpha(
          Phaser.Math.Linear(entry.tooltip.alpha, targetAlpha, 0.15)
        );
      } else {
        entry.tooltip.setAlpha(targetAlpha);
      }
    }
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

  // ---- Hidden ruins ----------------------------------------------------------
  // Check if any player (local or remote) is within 3 tiles of an unrevealed
  // ruin. If so, trigger a flash reveal tween and mark it as permanent.
  _checkRuinProximity() {
    const REVEAL_DIST = this.meta.tile * 3; // 3 tiles in world pixels
    for (const ruin of this._ruins) {
      if (ruin.revealed) continue;

      // Check local player distance.
      let triggered =
        Phaser.Math.Distance.Between(
          this.player.x, this.player.y, ruin.x, ruin.y
        ) < REVEAL_DIST;

      // Also check remote players so discovery happens for any player near the ruin.
      if (!triggered) {
        for (const [, rp] of this.remotePlayers) {
          if (
            Phaser.Math.Distance.Between(rp.sprite.x, rp.sprite.y, ruin.x, ruin.y) <
            REVEAL_DIST
          ) {
            triggered = true;
            break;
          }
        }
      }

      if (triggered) {
        ruin.revealed = true;
        // Flash: briefly surge to bright white then settle at full opacity.
        this.tweens.add({
          targets: ruin.sprite,
          alpha: 1,
          duration: 120,
          ease: 'Quad.easeOut',
          onStart: () => {
            // White flash overlay — tint the sprite to near-white at the start.
            ruin.sprite.setTint(0xffffff);
          },
          onComplete: () => {
            // Fade tint back to normal over 400ms.
            this.tweens.addCounter({
              from: 255,
              to: 0,
              duration: 400,
              ease: 'Sine.easeOut',
              onUpdate: (tween) => {
                const v = Math.round(tween.getValue());
                const col = Phaser.Display.Color.GetColor(v, v, v);
                // Blend white tint toward neutral (no tint = 0xffffff in Phaser means no change).
                // Remove tint once fully faded.
                if (v <= 10) {
                  ruin.sprite.clearTint();
                } else {
                  ruin.sprite.setTint(Phaser.Display.Color.GetColor(
                    Math.min(255, 155 + v),
                    Math.min(255, 155 + v),
                    Math.min(255, 155 + v)
                  ));
                }
              },
            });
          },
        });

        // Emit discovery via socket so other players see it too.
        if (this._socket && this._socket.connected) {
          this._socket.emit('ruin:revealed', { ruinId: ruin.id, x: ruin.x, y: ruin.y });
        }

        this._showToast('Ancient ruins discovered!', 2800);
        console.log('[ruins] ruin', ruin.id, 'revealed at', ruin.x, ruin.y);
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

    // Block movement while the note-entry overlay is open.
    if (this._noteInputOpen) {
      body.setVelocity(0, 0);
      return;
    }

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

    // Player-carved trails: track tile visits and render worn dirt paths.
    this._updateTrails(time);
    if (this._trailDirty) this._redrawTrails();

    // Explorer scrolls: pulse glow + proximity tooltips.
    this._updateScrolls(time);

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

    // Hidden ruins: reveal if any player is within 3 tiles (144px).
    this._checkRuinProximity();

    // Rune stone glow pulse — a slow sine-wave tint cycle on the stone sprite.
    // Alternates between pale cyan-white and the base sprite color.
    const pulse = 0.6 + 0.4 * Math.sin(time * 0.002);
    const glowTint = Phaser.Display.Color.GetColor(
      Math.round(68 + pulse * 100),   // R: 68–168
      Math.round(220 + pulse * 35),   // G: 220–255
      Math.round(180 + pulse * 75)    // B: 180–255
    );
    this._runeStoneSprite.setTint(glowTint);

    // ---- Wanderer beacons ---------------------------------------------------
    // Plant a beacon when F is pressed (once per cooldown period).
    if (Phaser.Input.Keyboard.JustDown(this.keys.beacon)) {
      const now = time;
      if (now - this._lastBeaconTime >= this._BEACON_COOLDOWN_MS) {
        this._lastBeaconTime = now;
        this._plantBeacon(this.player.x, this.player.y, this._selfName || 'explorer', now);
        this._showToast('Beacon planted! Fades in 5 minutes.', 2000);
      } else {
        const remaining = Math.ceil((this._BEACON_COOLDOWN_MS - (now - this._lastBeaconTime)) / 1000);
        this._showToast(`Beacon cooling down… ${remaining}s`, 1200);
      }
    }

    // Update existing beacons: pulse glow, fade out near expiry, remove expired.
    const now = time;
    for (let i = this._beacons.length - 1; i >= 0; i--) {
      const b = this._beacons[i];
      const age = now - b.plantedAt;
      const lifeRatio = age / this._BEACON_LIFETIME_MS; // 0 → 1 over lifetime

      if (lifeRatio >= 1) {
        // Expired — destroy and remove.
        b.graphics.destroy();
        b.nameTag.destroy();
        this._beacons.splice(i, 1);
        continue;
      }

      // Fade alpha: full for first 80%, then linear fade-out to 0.
      const fadeAlpha = lifeRatio > 0.8 ? 1 - (lifeRatio - 0.8) / 0.2 : 1;

      // Pulsing glow radius: base 12px, +4px sine wave.
      const glowPulse = 0.5 + 0.5 * Math.sin(now * 0.003 + b.x * 0.01);
      const glowR = 12 + glowPulse * 4;

      b.graphics.clear();
      // Outer soft glow ring (warm gold).
      b.graphics.fillStyle(0xffd700, 0.25 * fadeAlpha);
      b.graphics.fillCircle(b.x, b.y, glowR * 2.2);
      // Inner bright core.
      b.graphics.fillStyle(0xffe55c, 0.85 * fadeAlpha);
      b.graphics.fillCircle(b.x, b.y, glowR);
      // Tiny bright center dot.
      b.graphics.fillStyle(0xffffff, fadeAlpha);
      b.graphics.fillCircle(b.x, b.y, 4);

      // Name tag alpha follows beacon alpha.
      b.nameTag.setAlpha(fadeAlpha);
    }

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

  // ---- Player-carved trails ------------------------------------------------

  // Convert world pixel position to trail tile coordinates.
  _worldToTrailTile(wx, wy) {
    return {
      tx: Math.floor(wx / TRAIL_TILE),
      ty: Math.floor(wy / TRAIL_TILE),
    };
  }

  // Called each update to track the local player's tile and increment visit count.
  _updateTrails(time) {
    const { tx, ty } = this._worldToTrailTile(this.player.x, this.player.y);
    const key = `${tx},${ty}`;

    // Only count a new visit when the player moves to a different tile.
    const lastKey = this._lastTrailTile;
    if (key === lastKey) {
      // Expire old trails periodically (don't do it every frame — throttle).
      return;
    }
    this._lastTrailTile = key;

    const now = Date.now();
    const existing = this._trailMap.get(key);
    const prevCount = existing ? existing.count : 0;
    const newCount = prevCount + 1;
    const entry = { count: newCount, lastVisit: now };
    this._trailMap.set(key, entry);

    // If this tile meets or exceeds the threshold, mark it and broadcast.
    if (newCount >= TRAIL_THRESHOLD) {
      this._trailDirty = true;
      if (this._socket && this._socket.connected) {
        this._socket.emit('trail:update', { tx, ty, count: newCount, lastVisit: now });
      }
    }

    // Also expire old trails on each tile step (cheap pass since map is small).
    this._expireTrails(now);
  }

  // Remove trail entries that haven't been visited in TRAIL_TTL ms.
  _expireTrails(now) {
    let changed = false;
    for (const [key, entry] of this._trailMap) {
      if (entry.count >= TRAIL_THRESHOLD && now - entry.lastVisit > TRAIL_TTL) {
        this._trailMap.delete(key);
        changed = true;
      }
    }
    if (changed) this._trailDirty = true;
  }

  // Handle an incoming trail:update event from another client.
  _onTrailUpdate(tx, ty, count, lastVisit) {
    const key = `${tx},${ty}`;
    const existing = this._trailMap.get(key);
    // Only update if the incoming data has a higher count or more recent visit.
    if (!existing || count > existing.count || lastVisit > existing.lastVisit) {
      this._trailMap.set(key, { count, lastVisit });
      if (count >= TRAIL_THRESHOLD) {
        this._trailDirty = true;
      }
    }
  }

  // Redraw the trail graphics layer from the current trail map.
  _redrawTrails() {
    this._trailGraphics.clear();
    this._trailGraphics.fillStyle(TRAIL_COLOR, TRAIL_ALPHA);
    for (const [key, entry] of this._trailMap) {
      if (entry.count < TRAIL_THRESHOLD) continue;
      const [tx, ty] = key.split(',').map(Number);
      const wx = tx * TRAIL_TILE;
      const wy = ty * TRAIL_TILE;
      this._trailGraphics.fillRect(wx, wy, TRAIL_TILE, TRAIL_TILE);
    }
    this._trailDirty = false;
  }

  // ---- Wanderer beacon helpers ---------------------------------------------

  // Plant a glowing trail marker at world position (wx, wy) tagged with playerName.
  // The beacon will pulse and fade over _BEACON_LIFETIME_MS milliseconds.
  _plantBeacon(wx, wy, playerName, plantedAt) {
    // Graphics object lives in world-space, drawn above the ground layer.
    const g = this.add.graphics();
    g.setDepth(wy + 50);

    // Name tag floats above the beacon pin.
    const tag = this.add
      .text(wx, wy - 22, playerName, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '10px',
        color: '#ffe55c',
        stroke: '#000000',
        strokeThickness: 3,
        resolution: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(wy + 51);

    this._beacons.push({ graphics: g, nameTag: tag, x: wx, y: wy, plantedAt });
    console.log(`[beacon] planted at (${Math.round(wx)}, ${Math.round(wy)}) by ${playerName}`);
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
