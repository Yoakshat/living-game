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
    // Footrace state
    this._raceActive = false;
    this._raceDestX = 0;
    this._raceDestY = 0;
    this._raceMarker = null;        // Graphics object for the glowing destination
    this._raceCountdownText = null; // HUD text showing time remaining
    this._raceTimer = null;         // Phaser TimerEvent for the 60s countdown
    this._raceSecondsLeft = 0;
    // Territory claiming
    // territories: array of { graphics, nameTag, ownerName, ownerColor, x, y, claimedAt, lastVisit, decayTimer }
    this._territories = [];
    this._TERRITORY_RADIUS = 96;         // 3-tile radius in world pixels
    this._TERRITORY_DECAY_MS = 10 * 60 * 1000; // 10 minutes
    this._STILLNESS_THRESHOLD = 5000;    // 5 seconds of no movement
    this._lastMovedTime = 0;             // time of last position change
    this._lastPlayerX = null;
    this._lastPlayerY = null;
    this._territoryCountText = null;
    // Treasure chests: array of { sprite, glowGraphics, x, y, spawnTime, claimed }
    this._treasureChests = [];
    // Treasure score for this session (counts local claims).
    this._treasureScore = 0;

    // Footprint trails: Map<playerId, { marks: [{x, y, time}], graphics: Graphics }>
    // Each remote player has up to 30 position marks that fade after 3 minutes.
    this._footprints = new Map();
    // How many positions to keep per remote player.
    this._FOOTPRINT_MAX = 30;
    // How long each footmark lasts (ms) — 3 minutes.
    this._FOOTPRINT_TTL = 180000;
    // Minimum distance (px) between recorded footmarks to avoid clutter.
    this._FOOTPRINT_MIN_DIST = 16;

    // Elevation zones: hill and valley regions that affect movement speed and view radius.
    // Hills slow you 20% going uphill (entering), speed you 15% going downhill (leaving).
    // Standing on high ground extends view radius by 1.5 tiles during night.
    // Defined as { x, y, radius, type: 'hill'|'valley', label }
    this._elevationZones = null; // populated in create() after worldW/worldH are known
    this._currentElevation = 'flat'; // 'flat', 'hill', 'valley'
    // Explorer journal — personal log of discoveries (persists this session).
    this._journal = {
      zonesVisited: new Set(),    // zone names visited
      ruinsDiscovered: 0,         // count of ruins revealed
      fragmentsCollected: 0,      // map fragments picked up
      ideasProposed: [],          // idea IDs / titles submitted
    };
    // Whether the journal panel is open.
    this._journalOpen = false;
    // Remote player journals received via socket: Map<playerName, journal>
    this._remoteJournals = new Map();
    // Journal shrine icon near campfire (Graphics)
    this._journalShrineGraphics = null;
    // Whether the journal shrine prompt is visible.
    this._journalShrinePromptVisible = false;
    this._journalShrinePromptText = null;
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

    // --- Elevation zones (hills and valleys) ---------------------------------
    // 3-4 hill regions (lighter, brighter terrain) and 2 valley regions
    // (darker, slightly bluish terrain). These are purely visual overlays
    // that also affect player speed and night view radius.
    this._elevationZones = [
      // Hills — 4 regions scattered across the map
      { x: this.worldW * 0.18, y: this.worldH * 0.18, radius: this.meta.tile * 5, type: 'hill', label: 'Northern Heights' },
      { x: this.worldW * 0.72, y: this.worldH * 0.55, radius: this.meta.tile * 4.5, type: 'hill', label: 'Eastern Ridge' },
      { x: this.worldW * 0.25, y: this.worldH * 0.78, radius: this.meta.tile * 5, type: 'hill', label: 'Southern Bluff' },
      { x: this.worldW * 0.82, y: this.worldH * 0.22, radius: this.meta.tile * 4, type: 'hill', label: 'Watchtower Hill' },
      // Valleys — 2 regions (low-lying, shadowed)
      { x: this.worldW * 0.50, y: this.worldH * 0.65, radius: this.meta.tile * 5, type: 'valley', label: 'Misty Valley' },
      { x: this.worldW * 0.14, y: this.worldH * 0.45, radius: this.meta.tile * 4, type: 'valley', label: 'Shadow Glen' },
    ];

    // Draw terrain shading for elevation zones (behind obstacles).
    const elevG = this.add.graphics();
    elevG.setDepth(1); // just above grass layer
    for (const zone of this._elevationZones) {
      if (zone.type === 'hill') {
        // Hills: bright warm-green gradient — multiple concentric rings fading outward
        const steps = 8;
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const r = zone.radius * (1 - t);
          // Lighten: blend toward bright yellow-green
          const alpha = 0.18 - t * 0.14;
          elevG.fillStyle(0x88cc44, alpha);
          elevG.fillCircle(zone.x, zone.y, r);
        }
        // Bright highlight at the peak
        elevG.fillStyle(0xccee88, 0.22);
        elevG.fillCircle(zone.x, zone.y, zone.radius * 0.3);
        // Contour ring (darker edge)
        elevG.lineStyle(2, 0x5a9a2a, 0.35);
        elevG.strokeCircle(zone.x, zone.y, zone.radius);
        elevG.lineStyle(1.5, 0x5a9a2a, 0.2);
        elevG.strokeCircle(zone.x, zone.y, zone.radius * 0.6);
      } else {
        // Valleys: darker, slightly blue-green tint — shadow pools
        const steps = 8;
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          const r = zone.radius * (1 - t);
          const alpha = 0.20 - t * 0.15;
          elevG.fillStyle(0x224433, alpha);
          elevG.fillCircle(zone.x, zone.y, r);
        }
        // Misty haze at the center
        elevG.fillStyle(0x336655, 0.12);
        elevG.fillCircle(zone.x, zone.y, zone.radius * 0.4);
        // Contour ring
        elevG.lineStyle(2, 0x1a3322, 0.3);
        elevG.strokeCircle(zone.x, zone.y, zone.radius);
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

    // --- Explorer journal shrine (glowing book icon near campfire) ----------
    // Placed one tile south-east of the campfire so it's easy to find.
    this._journalShrineX = cfx + T * 1.5;
    this._journalShrineY = cfy + T * 1.5;
    this._journalShrineGraphics = this.add.graphics();
    this._journalShrineGraphics.setDepth(this._journalShrineY + 10);
    this._drawJournalShrine(0); // initial draw

    // Shrine proximity prompt (camera-fixed, below centre).
    this._journalShrinePromptText = this.add
      .text(0, 0, '[Walk up] Read journals', {
        fontFamily: '"Palatino Linotype", Palatino, serif',
        fontSize: '13px',
        color: '#ffe9b0',
        stroke: '#241a08',
        strokeThickness: 3,
        align: 'center',
      })
      .setOrigin(0.5, 1)
      .setScrollFactor(0)
      .setDepth(10004)
      .setAlpha(0);

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
    // varies with the cycle phase.  At night we punch "light circle" holes
    // around each player (~4 tiles / 192px) and around fixed landmark light
    // sources (campfire, beacon tower, meditation chamber, healing spring).
    //
    // Cycle timing (ms):
    //   DAY  180 000  (3 min, fully transparent overlay)
    //   DUSK  30 000  (30s transition day→night)
    //   NIGHT  90 000  (90s dark)
    //   DAWN   30 000  (30s transition night→day)
    //   Total cycle: 330 000 ms (5.5 min)
    this._DN_DAY_MS   = 180000;
    this._DN_DUSK_MS  =  30000;
    this._DN_NIGHT_MS =  90000;
    this._DN_DAWN_MS  =  30000;
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
    // Store healing spring position for night-cycle glow
    this._healingSpringX = springX;
    this._healingSpringY = springY;

    // --- Imperial beacon tower (north bank, ~30%, 15%) -----------------------
    // A tall dark spire marking the seat of Imperial power — purely decorative.
    const btX = Math.round(this.worldW * 0.30);
    const btY = Math.round(this.worldH * 0.15);
    this.add.image(btX, btY, 'beacon-tower').setOrigin(0.5, 0.5).setDepth(btY + meta.beaconTower.h / 2);
    // Store beacon tower position for night-cycle glow
    this._beaconTowerX = btX;
    this._beaconTowerY = btY;

    // --- Sith meditation chamber (north bank, ~55%, 12%) ---------------------
    // A dark circular stone platform with a faint red glow — a place of silent power.
    const mcX = Math.round(this.worldW * 0.55);
    const mcY = Math.round(this.worldH * 0.12);
    this.add.image(mcX, mcY, 'meditation-chamber').setOrigin(0.5, 0.5).setDepth(mcY + meta.meditationChamber.h / 2);
    // Store meditation chamber position for night-cycle glow
    this._meditationChamberX = mcX;
    this._meditationChamberY = mcY;

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

    // Territory counter — camera-fixed HUD text, top-left (below fragment counter).
    this._territoryCountText = this.add
      .text(0, 20, 'Territories: 0', {
        fontFamily: '"Palatino Linotype", Palatino, serif',
        fontSize: '14px',
        color: '#aaddff',
        stroke: '#0a1a2a',
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
    // Depth 9250: above fog layer (9200) so the local player is always visible
    // through the fog as they explore. Remote players use the same base.
    this.player.setDepth(9250);
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

    // R key — start footrace when near campfire
    this.input.keyboard.on('keydown-R', () => {
      this._tryStartRace();
    });

    // --- Race countdown HUD -------------------------------------------------
    this._raceCountdownText = this.add
      .text(0, 0, '', {
        fontFamily: '"Palatino Linotype", Palatino, serif',
        fontSize: '20px',
        color: '#ff9933',
        stroke: '#241a08',
        strokeThickness: 4,
        align: 'center',
      })
      .setOrigin(0.5, 0)
      .setScrollFactor(0)
      .setDepth(10005)
      .setAlpha(0);

    // Race marker graphics (glowing destination indicator)
    this._raceMarker = this.add.graphics();
    this._raceMarker.setDepth(9800);

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

    // J key — toggle personal explorer journal (or read shrine if nearby).
    this.input.keyboard.on('keydown-J', () => {
      if (this._journalOpen) {
        this._closeJournal();
      } else {
        // If near the journal shrine, show all players' public journals.
        const shrineDist = Phaser.Math.Distance.Between(
          this.player.x, this.player.y,
          this._journalShrineX, this._journalShrineY
        );
        if (shrineDist < this.meta.tile * 2.5) {
          this._openShrineJournal();
        } else {
          this._openMyJournal();
        }
      }
    });

    // T key — claim territory (only if player has been still for 5 seconds).
    this.input.keyboard.on('keydown-T', () => {
      this._tryClaimTerritory();
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

    // --- Dynamic weather system -----------------------------------------------
    // Rain starts randomly every 3–8 minutes, lasts 30–90 seconds, then ends.
    // After rain ends a rainbow briefly appears for 8 seconds.
    this._isRaining = false;
    // Dark overlay (camera-fixed) shown during rain.
    this._rainOverlay = this.add.graphics();
    this._rainOverlay.setScrollFactor(0);
    this._rainOverlay.setDepth(9400);
    this._rainOverlay.setAlpha(0);
    // Rain particle emitter.
    this._rainGraphics = null;
    this._rainParticles = []; // array of { x, y, vx, vy }
    this._rainLastUpdate = 0;
    // Rainbow arc (shown after rain).
    this._rainbowGraphics = this.add.graphics();
    this._rainbowGraphics.setScrollFactor(0);
    this._rainbowGraphics.setDepth(9300);
    this._rainbowGraphics.setAlpha(0);
    // Schedule first rain event.
    this._scheduleNextRain();
    // --- Treasure chests -----------------------------------------------------
    // Every 5 minutes, 3 glowing chests spawn at random distant map edges
    // (>85% from center). The first player to walk within 2 tiles claims it:
    // they get a crown toast announcement to all players and +1 treasure score.
    // Unclaimed chests despawn after 5 minutes and respawn elsewhere.
    this._CHEST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    this._CHEST_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes until despawn
    this._CHEST_COUNT = 3;
    this._CHEST_CLAIM_DIST = this.meta.tile * 2; // 2 tiles = 96px

    // Spawn the first batch immediately (small delay to let scene finish).
    this.time.delayedCall(2000, () => this._spawnTreasureChests());
    // Then repeat every 5 minutes.
    this.time.addEvent({
      delay: this._CHEST_INTERVAL_MS,
      loop: true,
      callback: this._spawnTreasureChests,
      callbackScope: this,
    });

    // --- Footprint trail graphics layer (below players, above ground) ----------
    // One shared Graphics object redrawn each frame for all remote player trails.
    this._footprintGraphics = this.add.graphics();
    this._footprintGraphics.setDepth(50); // above ground (depth 0-1), below players
    // --- Fog of war ----------------------------------------------------------
    // A dark RenderTexture covers the entire world. Tiles are permanently
    // revealed as the local player walks through them. Each revealed tile
    // erases a circle of fog, giving a genuine sense of exploration.
    //
    // Depth 9200: above terrain/obstacles/beacons but below the night overlay
    // (9500) and all HUD layers (10000+). Player sprites at depth=y are well
    // below 9200 for most of the map, so players always render under the fog;
    // we compensate by giving player sprites a higher depth below.
    this._fogRevealRadius = this.meta.tile * 3; // ~3 tiles = 144px reveal radius
    // Set of "tx,ty" strings representing tile coords already revealed.
    this._fogRevealedTiles = new Set();
    // Last tile position that triggered a reveal (avoid re-drawing every frame).
    this._fogLastTileX = -999;
    this._fogLastTileY = -999;

    // Create the full-world RenderTexture filled with dark fog.
    this._fogRT = this.add.renderTexture(0, 0, this.worldW, this.worldH);
    this._fogRT.setOrigin(0, 0);
    this._fogRT.setDepth(9200);
    // Fill with near-black semi-transparent fog.
    this._fogRT.fill(0x000000, 0.82);

    // Graphics object used as an eraser brush — we stamp it onto the RT.
    // Blend mode ERASE punches transparent holes in the RT wherever drawn.
    this._fogBrush = this.add.graphics();
    this._fogBrush.setVisible(false); // never rendered directly

    // Pre-reveal landmark areas so they are not shrouded at game start.
    // campfire center (~50%, 50%)
    this._fogPreReveal(this._campfireX, this._campfireY, this.meta.tile * 5);
    // cave entrance (~75%, 25%)
    this._fogPreReveal(this._caveX, this._caveY, this.meta.tile * 4);
    // healing spring (~65%, 72%)
    this._fogPreReveal(this._healingSpringX, this._healingSpringY, this.meta.tile * 4);

    // Lift fog around the player's spawn position immediately.
    this._fogRevealAt(spawn.x, spawn.y);
    // Seed the last-tile cache so the update loop doesn't re-reveal on frame 1.
    this._fogLastTileX = Math.floor(spawn.x / T);
    this._fogLastTileY = Math.floor(spawn.y / T);
    this._fogRevealedTiles.add(`${this._fogLastTileX},${this._fogLastTileY}`);

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

  // ---- Treasure chest system -------------------------------------------------

  // Pick a random world-edge position that is >85% of map half-size from center.
  // This ensures chests appear near corners/edges, rewarding exploration.
  _randomDistantEdgePos() {
    const T = this.meta.tile;
    const halfW = this.worldW / 2;
    const halfH = this.worldH / 2;
    const THRESHOLD = 0.85;

    // Pick a random edge (top, bottom, left, right).
    const edge = Math.floor(Math.random() * 4);
    let x, y;
    if (edge === 0) {
      // Top edge — x anywhere from 85% to 100% from center on either side.
      const sign = Math.random() > 0.5 ? 1 : -1;
      x = halfW + sign * halfW * (THRESHOLD + Math.random() * (1 - THRESHOLD));
      y = halfH - halfH * (THRESHOLD + Math.random() * (1 - THRESHOLD));
    } else if (edge === 1) {
      // Bottom edge.
      const sign = Math.random() > 0.5 ? 1 : -1;
      x = halfW + sign * halfW * (THRESHOLD + Math.random() * (1 - THRESHOLD));
      y = halfH + halfH * (THRESHOLD + Math.random() * (1 - THRESHOLD));
    } else if (edge === 2) {
      // Left edge.
      x = halfW - halfW * (THRESHOLD + Math.random() * (1 - THRESHOLD));
      const sign = Math.random() > 0.5 ? 1 : -1;
      y = halfH + sign * halfH * (THRESHOLD + Math.random() * (1 - THRESHOLD));
    } else {
      // Right edge.
      x = halfW + halfW * (THRESHOLD + Math.random() * (1 - THRESHOLD));
      const sign = Math.random() > 0.5 ? 1 : -1;
      y = halfH + sign * halfH * (THRESHOLD + Math.random() * (1 - THRESHOLD));
    }

    // Clamp to world bounds with a small tile margin.
    x = Phaser.Math.Clamp(x, T * 1.5, this.worldW - T * 1.5);
    y = Phaser.Math.Clamp(y, T * 1.5, this.worldH - T * 1.5);
    return { x: Math.round(x), y: Math.round(y) };
  }

  // Spawn a fresh batch of CHEST_COUNT treasure chests at distant edge positions.
  // Any existing unclaimed chests are removed first.
  _spawnTreasureChests() {
    // Remove any remaining old chests.
    for (const chest of this._treasureChests) {
      if (chest.sprite) chest.sprite.destroy();
      if (chest.glowGraphics) chest.glowGraphics.destroy();
    }
    this._treasureChests = [];

    for (let i = 0; i < this._CHEST_COUNT; i++) {
      const pos = this._randomDistantEdgePos();
      this._placeChest(pos.x, pos.y);
    }

    console.log(`[chest] spawned ${this._CHEST_COUNT} treasure chests`);
  }

  _placeChest(wx, wy) {
    const sprite = this.add
      .image(wx, wy, 'treasure-chest')
      .setOrigin(0.5, 0.5)
      .setDepth(wy + this.meta.treasureChest.h / 2);

    // Separate graphics layer for the animated glow ring.
    const glowGraphics = this.add.graphics();
    glowGraphics.setDepth(wy + this.meta.treasureChest.h / 2 - 1);

    const entry = {
      sprite,
      glowGraphics,
      x: wx,
      y: wy,
      spawnTime: this.time.now,
      claimed: false,
    };
    this._treasureChests.push(entry);

    // Auto-despawn after lifetime; respawn happens on the repeating timer.
    this.time.delayedCall(this._CHEST_LIFETIME_MS, () => {
      if (!entry.claimed) {
        entry.sprite.destroy();
        entry.glowGraphics.destroy();
        this._treasureChests = this._treasureChests.filter((c) => c !== entry);
        console.log('[chest] despawned unclaimed chest at', wx, wy);
      }
    });
  }

  // Called each update tick to animate chest glow and detect proximity claims.
  _checkTreasureChests(time) {
    const serverUrl =
      (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SERVER_URL)
        ? import.meta.env.VITE_SERVER_URL
        : 'https://living-game-server-production.up.railway.app';

    for (const chest of this._treasureChests) {
      if (chest.claimed) continue;

      // Pulsing golden glow ring around the chest.
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.004 + chest.x * 0.01);
      const glowAlpha = 0.3 + pulse * 0.35;
      const glowR = 28 + pulse * 8;

      chest.glowGraphics.clear();
      chest.glowGraphics.fillStyle(0xffd700, glowAlpha * 0.4);
      chest.glowGraphics.fillCircle(chest.x, chest.y, glowR * 1.4);
      chest.glowGraphics.fillStyle(0xffee55, glowAlpha);
      chest.glowGraphics.fillCircle(chest.x, chest.y, glowR);

      // Apply golden tint pulse on the sprite itself.
      const tintR = Math.round(255);
      const tintG = Math.round(180 + pulse * 75);
      const tintB = Math.round(0 + pulse * 30);
      chest.sprite.setTint(Phaser.Display.Color.GetColor(tintR, tintG, tintB));

      // Check if local player is within 2 tiles.
      const dist = Phaser.Math.Distance.Between(
        this.player.x, this.player.y, chest.x, chest.y
      );
      if (dist < this._CHEST_CLAIM_DIST) {
        chest.claimed = true;
        chest.glowGraphics.clear();
        // Dim to show claimed state.
        chest.sprite.setTint(0x886644);

        this._treasureScore++;
        const playerName = this._selfName || 'Explorer';
        const msg = `👑 ${playerName} found a treasure chest! (+1 treasure)`;

        // Show the announcement locally.
        this._showToast(msg, 4000);

        // Broadcast to all players via socket.
        if (this._socket && this._socket.connected) {
          this._socket.emit('chest:claimed', { playerName, score: this._treasureScore });
        }

        // Log the treasure claim event to the server leaderboard.
        fetch(`${serverUrl}/log-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            playerName,
            message: `${playerName} claimed a treasure chest! (total: ${this._treasureScore})`,
            type: 'treasure',
          }),
        }).catch((err) => console.warn('[chest] log-event failed:', err));

        console.log('[chest] claimed by', playerName, 'at', chest.x, chest.y);
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

    // Another client broadcast that a race started.
    socket.on('race:started', (data) => {
      this._enqueue(() => {
        if (!this._raceActive) {
          this._beginRace(data.destX, data.destY);
        }
      });
    });

    // Another client broadcast that a race was won.
    socket.on('race:won', (data) => {
      this._enqueue(() => {
        this._endRace();
        this._showToast(`🏆 ${data.winner} wins the footrace!`, 4000);
      });
    });

    // A player claimed a treasure chest — show crown toast announcement.
    socket.on('chest:claimed', (data) => {
      this._enqueue(() => {
        const msg = `👑 ${data.playerName} found a treasure chest! (+1 treasure)`;
        this._showToast(msg, 4000);
        console.log('[chest] claimed by', data.playerName);
      });
    });

    // Another player shared their journal — store it for shrine display.
    socket.on('journal:update', (data) => {
      this._enqueue(() => {
        if (data.playerName && data.journal) {
          this._remoteJournals.set(data.playerName, data.journal);
          // If shrine journal is currently open, refresh the display.
          if (this._journalOpen && document.getElementById('journal-overlay')) {
            this._openShrineJournal();
          }
        }
      });
    });

    // Server relays a request for all journals — respond with ours.
    socket.on('journal:request_all', () => {
      this._enqueue(() => this._emitJournal());
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

    // Share initial journal with other players.
    this._emitJournal();

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

    // Record a footmark at the new position (throttled by minimum distance).
    const fp = this._footprints.get(data.id);
    if (fp) {
      const dx = data.x - fp.lastX;
      const dy = data.y - fp.lastY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= this._FOOTPRINT_MIN_DIST) {
        fp.marks.push({ x: data.x, y: data.y, time: Date.now() });
        fp.lastX = data.x;
        fp.lastY = data.y;
        // Prune to max 30 entries (remove oldest).
        if (fp.marks.length > this._FOOTPRINT_MAX) {
          fp.marks.shift();
        }
      }
    }
  }

  _onPlayerLeft(data) {
    const rp = this.remotePlayers.get(data.id);
    if (!rp) return;
    rp.sprite.destroy();
    rp.nameTag.destroy();
    this.remotePlayers.delete(data.id);
    // Clean up footprint trail for departed player.
    this._footprints.delete(data.id);
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
    // Keep above fog layer (9200) so remote players are always visible.
    sprite.setDepth(9250 + y / this.worldH);

    const nameTag = this._makeNameTag(name);

    this.remotePlayers.set(id, {
      sprite,
      nameTag,
      targetX: x,
      targetY: y,
      color,
    });

    // Initialise footprint trail for this remote player.
    this._footprints.set(id, { marks: [], lastX: x, lastY: y });

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
        this._journal.fragmentsCollected++;
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

        this._journal.ruinsDiscovered++;
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
  update(time, delta) {
    const k = this.keys;
    const body = this.player.body;

    // Block movement while the note-entry overlay or journal is open.
    if (this._noteInputOpen || this._journalOpen) {
      body.setVelocity(0, 0);
      // Still run the journal shrine update so the glow animates.
      if (this._journalOpen) this._updateJournalShrine(time);
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

      // Determine current elevation zone under the player.
      let newElevation = 'flat';
      for (const zone of this._elevationZones) {
        const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, zone.x, zone.y);
        if (d < zone.radius) {
          newElevation = zone.type;
          break;
        }
      }

      // Detect transition for speed modifier:
      // Moving INTO a hill zone → uphill (slow 20%)
      // Moving OUT OF a hill zone → downhill (speed 15%)
      let speedMult = 1.0;
      if (this._currentElevation !== newElevation) {
        if (newElevation === 'hill') {
          // Entering a hill — moving uphill → 20% slower
          speedMult = 0.80;
        } else if (this._currentElevation === 'hill' && newElevation !== 'hill') {
          // Leaving a hill — moving downhill → 15% faster
          speedMult = 1.15;
        }
        this._currentElevation = newElevation;
      } else {
        // Staying in same zone — apply sustained modifier
        if (newElevation === 'hill') {
          speedMult = 0.80; // on a hill, consistently slower (uphill effort)
        } else if (newElevation === 'valley') {
          speedMult = 1.0; // valleys: neutral
        }
      }

      // Movement is 10% slower during rain.
      const speed = this._isRaining
        ? PLAYER_SPEED * 0.9 * speedMult
        : PLAYER_SPEED * speedMult;
      body.setVelocity((vx / len) * speed, (vy / len) * speed);

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
      // Update elevation even when still so view radius & other effects stay current.
      let stillElevation = 'flat';
      for (const zone of this._elevationZones) {
        const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, zone.x, zone.y);
        if (d < zone.radius) {
          stillElevation = zone.type;
          break;
        }
      }
      this._currentElevation = stillElevation;
    }

    // Keep player above fog layer (9200) while preserving y-sort among players.
    this.player.setDepth(9250 + this.player.y / this.worldH);

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
      // Keep remote players above fog layer too.
      rp.sprite.setDepth(9250 + rp.sprite.y / this.worldH);
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

      // Player / light-source visibility radius in world pixels.
      // 4 tiles × 48px/tile = 192px clear radius around each light source.
      const VIS_R = 192;
      // Landmark light source radius — same ~4-tile clear zone.
      const LIGHT_R = 192;
      // How many gradient steps to approximate a radial gradient.
      const STEPS = 24;

      // Helper: draw a radial "light circle" that is clear at the centre and
      // fades to the overlay darkness at the edge.
      // colour: Phaser hex colour used for the soft glow tint at the edge.
      const drawLight = (wx, wy, radius, colour) => {
        for (let s = 0; s < STEPS; s++) {
          const t2 = s / STEPS;
          const holeAlpha = overlayAlpha * t2 * t2; // quadratic fade
          const r = radius * (1 - t2);
          this._nightOverlay.fillStyle(colour, holeAlpha);
          this._nightOverlay.fillCircle(wx, wy, r);
        }
      };

      // 1. Draw the base dark overlay covering the full visible world area.
      this._nightOverlay.fillStyle(0x000d1a, overlayAlpha);
      this._nightOverlay.fillRect(camX, camY, wW, wH);

      // 2. Punch visibility holes — local player sees normally within ~4 tiles.
      // Standing on high ground extends view radius by ~1.5 tiles (72px).
      const onHighGround = this._currentElevation === 'hill';
      const playerVis = onHighGround ? VIS_R + 72 : VIS_R;
      drawLight(this.player.x, this.player.y, playerVis, 0x000d1a);

      // 3. Remote players also get a personal light radius.
      for (const [, rp] of this.remotePlayers) {
        drawLight(rp.sprite.x, rp.sprite.y, VIS_R * 0.85, 0x000d1a);
      }

      // 4. Campfire — warm orange glow at world centre.
      drawLight(this._campfireX, this._campfireY, LIGHT_R, 0xff6a00);

      // 5. Imperial beacon tower (~30%/15%) — cool white-blue beacon light.
      drawLight(this._beaconTowerX, this._beaconTowerY, LIGHT_R, 0x88aaff);

      // 6. Meditation chamber (~55%/12%) — deep crimson glow.
      drawLight(this._meditationChamberX, this._meditationChamberY, LIGHT_R, 0xcc2244);

      // 7. Healing spring (~65%/72%) — soft teal glow.
      drawLight(this._healingSpringX, this._healingSpringY, LIGHT_R, 0x22ddbb);
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

    // Journal shrine: animate glow and proximity prompt.
    this._updateJournalShrine(time);

    // Footrace: update pulsing marker and check if local player reached destination.
    if (this._raceActive) {
      this._drawRaceMarker(this._raceDestX, this._raceDestY);
      this._checkRaceWin();
    }
    // Treasure chests: animate glow and check for claims.
    this._checkTreasureChests(time);

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

    // ---- Territory system ---------------------------------------------------
    // Track player stillness for T-key claiming.
    if (this._lastPlayerX === null) {
      this._lastPlayerX = this.player.x;
      this._lastPlayerY = this.player.y;
      this._lastMovedTime = time;
    }
    const movedDist = Phaser.Math.Distance.Between(
      this.player.x, this.player.y,
      this._lastPlayerX, this._lastPlayerY
    );
    if (movedDist > 4) {
      this._lastMovedTime = time;
      this._lastPlayerX = this.player.x;
      this._lastPlayerY = this.player.y;
    }

    // Update territory visuals (pulse glow, check revisit reset, remote player tints).
    this._updateTerritories(time);

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

    // ---- Weather: update rain particles each frame ---------------------------
    this._updateRain(delta);

    // ---- Footprint trails: redraw remote player trails each frame -------------
    this._updateFootprints();
    // ---- Fog of war: reveal tiles as the player moves -----------------------
    this._updateFog();
  }

  // ---- Weather system -------------------------------------------------------

  // Schedule the next rain event after a random 3–8 minute delay.
  _scheduleNextRain() {
    const delayMs = (3 + Math.random() * 5) * 60 * 1000; // 3–8 min
    this.time.delayedCall(delayMs, () => this._startRain());
  }

  // Begin a rain event lasting 30–90 seconds.
  _startRain() {
    this._isRaining = true;

    // Fade in the dark overlay.
    this.tweens.add({
      targets: this._rainOverlay,
      alpha: 1,
      duration: 2000,
      ease: 'Sine.easeIn',
    });

    // Initialise rain particles (50 drops, camera-space coordinates).
    const cam = this.cameras.main;
    this._rainParticles = [];
    for (let i = 0; i < 80; i++) {
      this._rainParticles.push({
        x: Math.random() * cam.width,
        y: Math.random() * cam.height,
        vx: 1.5,
        vy: 12 + Math.random() * 6,
        len: 8 + Math.random() * 8,
        alpha: 0.4 + Math.random() * 0.4,
      });
    }

    // Rain lasts 30–90 seconds.
    const durationMs = (30 + Math.random() * 60) * 1000;
    this.time.delayedCall(durationMs, () => this._stopRain());

    console.log('[weather] rain started, duration', Math.round(durationMs / 1000), 's');
  }

  // End the rain event and show the rainbow.
  _stopRain() {
    this._isRaining = false;
    this._rainParticles = [];

    // Fade out the dark overlay.
    this.tweens.add({
      targets: this._rainOverlay,
      alpha: 0,
      duration: 2000,
      ease: 'Sine.easeOut',
    });

    // Show rainbow for 8 seconds then fade.
    this._drawRainbow();
    this.tweens.add({
      targets: this._rainbowGraphics,
      alpha: 0.4,
      duration: 1500,
      ease: 'Sine.easeOut',
      onComplete: () => {
        this.time.delayedCall(6000, () => {
          this.tweens.add({
            targets: this._rainbowGraphics,
            alpha: 0,
            duration: 1500,
            ease: 'Sine.easeIn',
          });
        });
      },
    });

    // Schedule next rain.
    this._scheduleNextRain();
    console.log('[weather] rain stopped, rainbow showing');
  }

  // Draw a rainbow arc using camera-space coordinates.
  _drawRainbow() {
    const g = this._rainbowGraphics;
    g.clear();

    const cam = this.cameras.main;
    const cx = cam.width / 2;
    const cy = cam.height * 0.85; // arc origin near bottom-center

    const colors = [0xff0000, 0xff8800, 0xffff00, 0x00cc00, 0x0066ff, 0x8800cc];
    const baseR = Math.min(cam.width, cam.height) * 0.55;

    for (let ci = 0; ci < colors.length; ci++) {
      const r = baseR - ci * 10;
      g.lineStyle(8, colors[ci], 1);
      g.beginPath();
      // Draw upper semicircle (Math.PI to 0 = left to right going up).
      const steps = 60;
      for (let s = 0; s <= steps; s++) {
        const angle = Math.PI - (s / steps) * Math.PI;
        const px = cx + Math.cos(angle) * r;
        const py = cy - Math.sin(angle) * r;  // subtract so arc goes up
        if (s === 0) {
          g.moveTo(px, py);
        } else {
          g.lineTo(px, py);
        }
      }
      g.strokePath();
    }
  }

  // Draw rain streaks each frame (camera-space).
  _updateRain(delta) {
    if (!this._isRaining || this._rainParticles.length === 0) {
      // Clear drop graphics when not raining.
      if (this._rainDropGraphics) this._rainDropGraphics.clear();
      return;
    }

    const cam = this.cameras.main;
    const W = cam.width;
    const H = cam.height;

    // Redraw the dark overlay each frame with current dimensions.
    this._rainOverlay.clear();
    if (this._rainOverlay.alpha > 0.01) {
      this._rainOverlay.fillStyle(0x000020, 0.3);
      this._rainOverlay.fillRect(0, 0, W, H);
    }

    // Draw particles on a separate graphics object layered above the overlay.
    if (!this._rainDropGraphics) {
      this._rainDropGraphics = this.add.graphics();
      this._rainDropGraphics.setScrollFactor(0);
      this._rainDropGraphics.setDepth(9450);
    }
    const dg = this._rainDropGraphics;
    dg.clear();

    const dt = delta / 16.67; // normalise to 60fps
    for (const p of this._rainParticles) {
      // Move particle.
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // Wrap around.
      if (p.y > H + p.len) { p.y = -p.len; p.x = Math.random() * W; }
      if (p.x > W + p.len) { p.x = -p.len; }

      // Draw streak.
      dg.lineStyle(1, 0xaaddff, p.alpha);
      dg.beginPath();
      dg.moveTo(p.x, p.y);
      dg.lineTo(p.x - p.vx * p.len * 0.5, p.y - p.vy * p.len * 0.5);
      dg.strokePath();
    }
  }

  // ---- Footrace helpers ----------------------------------------------------

  // Attempt to start a footrace. Only works if within 3 tiles of campfire and
  // no race is currently active.
  _tryStartRace() {
    if (this._raceActive) {
      this._showToast('A race is already in progress!', 1500);
      return;
    }

    const campfireDist = Phaser.Math.Distance.Between(
      this.player.x, this.player.y,
      this._campfireX, this._campfireY
    );
    const THREE_TILES = this.meta.tile * 3;
    if (campfireDist > THREE_TILES) {
      this._showToast('Stand near the campfire to start a race!', 1800);
      return;
    }

    // Pick a random far corner (~5%/95% of world bounds).
    const corners = [
      { x: this.worldW * 0.05, y: this.worldH * 0.05 },  // NW
      { x: this.worldW * 0.95, y: this.worldH * 0.05 },  // NE
      { x: this.worldW * 0.05, y: this.worldH * 0.95 },  // SW
      { x: this.worldW * 0.95, y: this.worldH * 0.95 },  // SE
    ];
    const corner = corners[Math.floor(Math.random() * corners.length)];
    const destX = Math.round(corner.x);
    const destY = Math.round(corner.y);

    // Start the race locally.
    this._beginRace(destX, destY);

    // Broadcast to other players via socket.
    if (this._socket && this._socket.connected) {
      this._socket.emit('race:start', { destX, destY });
    }
  }

  // Begin the race visuals and timer. Called locally and when receiving race:started.
  _beginRace(destX, destY) {
    this._raceActive = true;
    this._raceDestX = destX;
    this._raceDestY = destY;
    this._raceSecondsLeft = 60;

    // Show HUD countdown.
    const camW = this.cameras.main.width;
    this._raceCountdownText.setText('🏁 Race! 60s');
    this._raceCountdownText.setPosition(camW / 2, 12);
    this._raceCountdownText.setAlpha(1);

    // Draw the glowing destination marker.
    this._drawRaceMarker(destX, destY);

    // Show a starting toast.
    this._showToast('Footrace started! Reach the glowing marker!', 3000);

    // Start the 60-second countdown — tick every second.
    if (this._raceTimer) {
      this._raceTimer.remove();
      this._raceTimer = null;
    }
    this._raceTimer = this.time.addEvent({
      delay: 1000,
      loop: true,
      callback: () => {
        this._raceSecondsLeft--;
        if (this._raceSecondsLeft <= 0) {
          // Time expired — no winner.
          this._endRace();
          this._showToast('The footrace expired — no winner!', 3000);
        } else {
          this._raceCountdownText.setText(`🏁 Race! ${this._raceSecondsLeft}s`);
        }
      },
    });
  }

  // Draw (or redraw) the pulsing destination marker in the update loop.
  _drawRaceMarker(x, y) {
    const g = this._raceMarker;
    g.clear();
    if (!this._raceActive) return;

    const t = this.time ? this.time.now : 0;
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.004);
    const outerR = 22 + pulse * 8;
    const innerR = 10 + pulse * 4;

    // Outer glow ring — translucent gold.
    g.fillStyle(0xffdd00, 0.25 + pulse * 0.15);
    g.fillCircle(x, y, outerR * 1.8);

    // Mid ring — brighter gold.
    g.fillStyle(0xffd700, 0.55 + pulse * 0.2);
    g.fillCircle(x, y, outerR);

    // Inner bright core — near-white.
    g.fillStyle(0xffffff, 0.85 + pulse * 0.15);
    g.fillCircle(x, y, innerR);
  }

  // Stop the race: hide HUD, clear marker, cancel timer, reset state.
  _endRace() {
    this._raceActive = false;
    this._raceMarker.clear();
    this._raceCountdownText.setAlpha(0);
    if (this._raceTimer) {
      this._raceTimer.remove();
      this._raceTimer = null;
    }
  }

  // Check if the local player has reached the race destination (within 3 tiles).
  _checkRaceWin() {
    if (!this._raceActive) return;

    const dist = Phaser.Math.Distance.Between(
      this.player.x, this.player.y,
      this._raceDestX, this._raceDestY
    );
    const THREE_TILES = this.meta.tile * 3;
    if (dist < THREE_TILES) {
      const winner = this._selfName || 'Explorer';

      // End the race locally first.
      this._endRace();
      this._showToast(`🏆 ${winner} wins the footrace!`, 4000);

      // Log to server.
      const serverUrl =
        (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SERVER_URL)
          ? import.meta.env.VITE_SERVER_URL
          : 'https://living-game-server-production.up.railway.app';
      const msg = `${winner} earns Fastest Explorer title!`;
      fetch(`${serverUrl}/log-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerName: winner, message: msg }),
      }).catch((err) => console.warn('[race] log-event failed:', err));

      // Broadcast win to other players.
      if (this._socket && this._socket.connected) {
        this._socket.emit('race:win', { winner });
      }
    }
  }

  // ---- Wanderer beacon helpers ---------------------------------------------

  // ---- Territory claiming ---------------------------------------------------

  // Try to claim a territory zone at the player's current position.
  // Succeeds only if the player has been still for 5 seconds.
  _tryClaimTerritory() {
    const now = this.time.now;
    const stillMs = now - this._lastMovedTime;

    if (stillMs < this._STILLNESS_THRESHOLD) {
      const remaining = Math.ceil((this._STILLNESS_THRESHOLD - stillMs) / 1000);
      this._showToast(`Stand still for ${remaining}s more to claim territory.`, 1500);
      return;
    }

    const px = this.player.x;
    const py = this.player.y;

    // Check if there's already an own territory overlapping this position.
    for (const t of this._territories) {
      if (t.ownerName === (this._selfName || 'Explorer')) {
        const d = Phaser.Math.Distance.Between(px, py, t.x, t.y);
        if (d < this._TERRITORY_RADIUS * 1.5) {
          // Refresh the existing territory's decay timer instead of placing a new one.
          t.lastVisit = now;
          if (t.decayTimer) t.decayTimer.remove();
          t.decayTimer = this.time.delayedCall(this._TERRITORY_DECAY_MS, () => {
            this._removeTerritory(t);
          });
          this._showToast('Territory refreshed! (10 min decay reset)', 1800);
          return;
        }
      }
    }

    this._placeTerritory(px, py, this._selfName || 'Explorer', this._selfColor || '#ffffff', now);
    this._showToast('Territory claimed! (glows for 10 minutes)', 2200);
    console.log('[territory] claimed at', Math.round(px), Math.round(py));
  }

  // Place a territory zone at world position (wx, wy) for ownerName.
  _placeTerritory(wx, wy, ownerName, ownerColor, claimedAt) {
    const colorInt = Phaser.Display.Color.HexStringToColor(ownerColor).color;

    // Background glow zone (filled circle with alpha).
    const g = this.add.graphics();
    g.setDepth(wy - 1);  // just above ground, below player

    // Floating name tag above the zone center.
    const tag = this.add
      .text(wx, wy - this._TERRITORY_RADIUS - 10, ownerName, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '11px',
        color: ownerColor,
        stroke: '#000000',
        strokeThickness: 3,
        resolution: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(wy + 50);

    const entry = {
      graphics: g,
      nameTag: tag,
      ownerName,
      ownerColor,
      colorInt,
      x: wx,
      y: wy,
      claimedAt,
      lastVisit: claimedAt,
      decayTimer: null,
    };

    // Schedule automatic removal after decay time.
    entry.decayTimer = this.time.delayedCall(this._TERRITORY_DECAY_MS, () => {
      this._removeTerritory(entry);
    });

    this._territories.push(entry);
    this._updateTerritoryHUD();
  }

  _removeTerritory(entry) {
    if (entry.graphics) entry.graphics.destroy();
    if (entry.nameTag) entry.nameTag.destroy();
    this._territories = this._territories.filter((t) => t !== entry);
    this._updateTerritoryHUD();
  }

  _updateTerritoryHUD() {
    if (!this._territoryCountText) return;
    const myName = this._selfName || 'Explorer';
    const myCount = this._territories.filter((t) => t.ownerName === myName).length;
    this._territoryCountText.setText(`Territories: ${myCount}`);
  }

  // Called each update frame — pulse territory glows and handle remote player tints.
  _updateTerritories(time) {
    const pulse = 0.2 + 0.15 * Math.sin(time * 0.0018);

    for (const t of this._territories) {
      const g = t.graphics;
      g.clear();

      // Outer soft ring.
      g.fillStyle(t.colorInt, pulse * 0.5);
      g.fillCircle(t.x, t.y, this._TERRITORY_RADIUS);

      // Inner brighter core.
      g.fillStyle(t.colorInt, pulse * 0.8);
      g.fillCircle(t.x, t.y, this._TERRITORY_RADIUS * 0.5);

      // Border ring.
      g.lineStyle(2, t.colorInt, 0.6);
      g.strokeCircle(t.x, t.y, this._TERRITORY_RADIUS);
    }

    // Check if local player is inside someone else's territory — apply color tint.
    let insideForeignTerr = false;
    for (const t of this._territories) {
      if (t.ownerName === (this._selfName || 'Explorer')) continue;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, t.x, t.y);
      if (d < this._TERRITORY_RADIUS) {
        insideForeignTerr = true;
        // Blend the territory owner color into the player's tint.
        this.player.setTint(t.colorInt);
        break;
      }
    }
    if (!insideForeignTerr && this._selfColor) {
      // Restore own color.
      this.player.setTint(Phaser.Display.Color.HexStringToColor(this._selfColor).color);
    }

    // Revisit detection: if local player enters their own territory, reset decay.
    const myName = this._selfName || 'Explorer';
    for (const t of this._territories) {
      if (t.ownerName !== myName) continue;
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, t.x, t.y);
      if (d < this._TERRITORY_RADIUS) {
        const now = this.time.now;
        // Only reset if some time has passed since last reset (avoid hammering every frame).
        if (now - t.lastVisit > 30000) {
          t.lastVisit = now;
          if (t.decayTimer) t.decayTimer.remove();
          t.decayTimer = this.time.delayedCall(this._TERRITORY_DECAY_MS, () => {
            this._removeTerritory(t);
          });
          console.log('[territory] decay reset on revisit');
        }
        break;
      }
    }

    // Tint remote players that are inside any territory zone.
    for (const [, rp] of this.remotePlayers) {
      let rpInsideTerr = false;
      for (const t of this._territories) {
        const d = Phaser.Math.Distance.Between(rp.sprite.x, rp.sprite.y, t.x, t.y);
        if (d < this._TERRITORY_RADIUS) {
          rpInsideTerr = true;
          rp.sprite.setTint(t.colorInt);
          break;
        }
      }
      if (!rpInsideTerr && rp.color) {
        rp.sprite.setTint(Phaser.Display.Color.HexStringToColor(rp.color).color);
      }
    }
  }

  // ---- Footprint trails -------------------------------------------------------

  // Redraw all remote player footprint trails, pruning expired marks.
  // Called each update frame. Footmarks are NOT shown for the local player.
  _updateFootprints() {
    const now = Date.now();
    const g = this._footprintGraphics;
    g.clear();

    for (const [id, fp] of this._footprints) {
      const rp = this.remotePlayers.get(id);
      if (!rp) continue;

      // Remove marks older than 3 minutes.
      while (fp.marks.length > 0 && now - fp.marks[0].time > this._FOOTPRINT_TTL) {
        fp.marks.shift();
      }

      if (fp.marks.length === 0) continue;

      // Parse the player's hex color once per frame.
      const colorInt = Phaser.Display.Color.HexStringToColor(rp.color).color;

      for (let i = 0; i < fp.marks.length; i++) {
        const mark = fp.marks[i];
        const age = now - mark.time;

        // Alpha: newest marks are 0.25, oldest marks fade toward 0.05.
        // age 0 → alpha 0.25; age FOOTPRINT_TTL → alpha 0.05
        const ageRatio = age / this._FOOTPRINT_TTL; // 0 (fresh) → 1 (expiring)
        const alpha = 0.25 - ageRatio * 0.20; // 0.25 → 0.05

        // Radius: newest marks are slightly larger (5px), oldest are 3px.
        const radius = 5 - ageRatio * 2; // 5 → 3

        g.fillStyle(colorInt, Math.max(alpha, 0.04));
        g.fillCircle(mark.x, mark.y, Math.max(radius, 2));
      }
    }
  }

  // ---- Explorer Journal -------------------------------------------------------

  // Determine a descriptive zone name for the player's current world position.
  _currentZoneName() {
    const px = this.player.x / this.worldW;
    const py = this.player.y / this.worldH;
    const T = this.meta.tile;
    // Cave: near the cave entrance (upper-right).
    if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this._caveX, this._caveY) < T * 3) {
      return 'Cave Entrance';
    }
    // Campfire area: center.
    if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this._campfireX, this._campfireY) < T * 4) {
      return 'Campfire';
    }
    // Healing spring.
    if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this._healingSpringX, this._healingSpringY) < T * 3) {
      return 'Healing Spring';
    }
    // Well.
    if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this._wellX, this._wellY) < T * 3) {
      return 'The Well';
    }
    // Beacon tower.
    if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this._beaconTowerX, this._beaconTowerY) < T * 3) {
      return 'Imperial Beacon Tower';
    }
    // Meditation chamber.
    if (Phaser.Math.Distance.Between(this.player.x, this.player.y, this._meditationChamberX, this._meditationChamberY) < T * 3) {
      return 'Meditation Chamber';
    }
    // North bank (above river, y < 30%).
    if (py < 0.30) return 'Northern Bank';
    // River crossing (y around 25-33%).
    if (py >= 0.24 && py <= 0.35 && px >= 0.60 && px <= 0.80) return 'Stone Bridge';
    // River zone.
    if (py >= 0.23 && py <= 0.37) return 'The River';
    // Quadrant labels.
    if (px < 0.5 && py < 0.5) return 'Northwest Wilds';
    if (px >= 0.5 && py < 0.5) return 'Northeast Highlands';
    if (px < 0.5 && py >= 0.5) return 'Southwest Lowlands';
    return 'Southeast Badlands';
  }

  // Called from the update loop to track zone visits.
  _trackZoneVisit() {
    const zone = this._currentZoneName();
    if (!this._journal.zonesVisited.has(zone)) {
      this._journal.zonesVisited.add(zone);
      // Broadcast updated journal to other players.
      this._emitJournal();
    }
  }

  // Emit this player's journal snapshot to all peers via socket.
  _emitJournal() {
    if (!this._socket || !this._socket.connected) return;
    const name = this._selfName || 'Explorer';
    this._socket.emit('journal:update', {
      playerName: name,
      journal: this._journalSnapshot(),
    });
  }

  // Create a serialisable snapshot of the local journal.
  _journalSnapshot() {
    return {
      zonesVisited: [...this._journal.zonesVisited],
      ruinsDiscovered: this._journal.ruinsDiscovered,
      fragmentsCollected: this._journal.fragmentsCollected,
      ideasProposed: [...this._journal.ideasProposed],
    };
  }

  // Draw the journal shrine icon (a glowing open book) at the shrine position.
  _drawJournalShrine(time) {
    const g = this._journalShrineGraphics;
    g.clear();
    const x = this._journalShrineX;
    const y = this._journalShrineY;
    const pulse = time ? 0.55 + 0.45 * Math.sin(time * 0.0025) : 0.8;

    // Outer glow aura.
    g.fillStyle(0xffd700, 0.18 * pulse);
    g.fillCircle(x, y, 22);
    g.fillStyle(0xffe9b0, 0.28 * pulse);
    g.fillCircle(x, y, 14);

    // Book cover (dark brown rectangle).
    g.fillStyle(0x5c3a1e, 1);
    g.fillRoundedRect(x - 9, y - 10, 18, 20, 2);

    // Spine.
    g.fillStyle(0x8b5a2b, 1);
    g.fillRect(x - 9, y - 10, 4, 20);

    // Pages (cream open book lines).
    g.fillStyle(0xf5e6c8, 0.9);
    g.fillRect(x - 4, y - 7, 10, 14);

    // Lines on pages.
    g.lineStyle(1, 0xa08050, 0.7);
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.moveTo(x - 3, y - 4 + i * 4);
      g.lineTo(x + 5, y - 4 + i * 4);
      g.strokePath();
    }

    // Golden glow dot at top (magic spark).
    g.fillStyle(0xffd700, pulse);
    g.fillCircle(x + 4, y - 12, 3);
  }

  // Called each update frame — animate shrine and show/hide proximity prompt.
  _updateJournalShrine(time) {
    // Track zone visit on every frame (cheap Set check).
    this._trackZoneVisit();

    this._drawJournalShrine(time);

    const shrineDist = Phaser.Math.Distance.Between(
      this.player.x, this.player.y,
      this._journalShrineX, this._journalShrineY
    );
    const nearShrine = shrineDist < this.meta.tile * 2.5;

    if (nearShrine !== this._journalShrinePromptVisible) {
      this._journalShrinePromptVisible = nearShrine;
      if (this._journalShrinePromptText) {
        const targetAlpha = nearShrine ? 1 : 0;
        this.tweens.add({
          targets: this._journalShrinePromptText,
          alpha: targetAlpha,
          duration: 300,
          ease: 'Sine.easeInOut',
        });
        if (nearShrine) {
          const cam = this.cameras.main;
          this._journalShrinePromptText.setPosition(cam.width / 2, cam.height - 32);
        }
      }
    }
  }

  // Build and show the local player's own journal panel.
  _openMyJournal() {
    this._journalOpen = true;
    this._emitJournal();
    const snap = this._journalSnapshot();
    this._buildJournalPanel('My Explorer Journal', [snap], false);
  }

  // Build and show all players' public journals (read at the shrine).
  _openShrineJournal() {
    this._journalOpen = true;
    // Request all journals from peers via socket before opening.
    if (this._socket && this._socket.connected) {
      this._socket.emit('journal:request_all');
    }
    // Collect known journals (remote + self).
    const myName = this._selfName || 'Explorer';
    const allJournals = [];
    // Self first.
    allJournals.push({ playerName: myName, ...this._journalSnapshot() });
    // Remotes.
    for (const [name, j] of this._remoteJournals) {
      if (name !== myName) allJournals.push({ playerName: name, ...j });
    }
    this._buildJournalPanel('Explorer Journals', allJournals, true);
  }

  // Close the journal panel.
  _closeJournal() {
    this._journalOpen = false;
    const el = document.getElementById('journal-overlay');
    if (el) document.body.removeChild(el);
    this.game.canvas.focus();
  }

  // Build the journal HTML overlay.
  // entries: array of { playerName?, zonesVisited[], ruinsDiscovered, fragmentsCollected, ideasProposed[] }
  // isShrine: if true, show player name headers.
  _buildJournalPanel(title, entries, isShrine) {
    // Remove any existing panel first.
    const existing = document.getElementById('journal-overlay');
    if (existing) document.body.removeChild(existing);

    const overlay = document.createElement('div');
    overlay.id = 'journal-overlay';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.60)',
      'z-index:9999',
      'font-family:"Palatino Linotype",Palatino,serif',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'background:#100c06',
      'border:2px solid #c8a83a',
      'border-radius:10px',
      'padding:22px 28px',
      'max-width:440px',
      'width:92%',
      'max-height:80vh',
      'overflow-y:auto',
      'display:flex',
      'flex-direction:column',
      'gap:14px',
      'box-shadow:0 0 32px #c8a83a44',
    ].join(';');

    // Title bar.
    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'color:#f0d88a;font-size:18px;font-weight:bold;border-bottom:1px solid #5c3a1e;padding-bottom:8px;';
    titleEl.textContent = title;
    panel.appendChild(titleEl);

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#8a7040;font-size:13px;font-style:italic;';
      empty.textContent = 'No journals found yet.';
      panel.appendChild(empty);
    }

    for (const entry of entries) {
      const block = document.createElement('div');
      block.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

      if (isShrine && entry.playerName) {
        const nameEl = document.createElement('div');
        const col = this._remoteJournals.has(entry.playerName)
          ? '#aaddff'
          : '#ffd700'; // gold for self
        nameEl.style.cssText = `color:${col};font-size:15px;font-weight:bold;`;
        nameEl.textContent = `${entry.playerName}'s Journal`;
        block.appendChild(nameEl);
      }

      const addRow = (label, value) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:baseline;';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'color:#a08050;font-size:12px;min-width:140px;flex-shrink:0;';
        lbl.textContent = label;
        const val = document.createElement('span');
        val.style.cssText = 'color:#f0d88a;font-size:13px;';
        val.textContent = value;
        row.appendChild(lbl);
        row.appendChild(val);
        block.appendChild(row);
      };

      const zones = Array.isArray(entry.zonesVisited) ? entry.zonesVisited : [];
      addRow('Zones visited:', zones.length > 0 ? zones.join(', ') : 'None yet');
      addRow('Ruins discovered:', String(entry.ruinsDiscovered || 0));
      addRow('Fragments collected:', String(entry.fragmentsCollected || 0));
      const ideas = Array.isArray(entry.ideasProposed) ? entry.ideasProposed : [];
      addRow('Ideas proposed:', ideas.length > 0 ? ideas.join(', ') : 'None yet');

      if (isShrine) {
        block.style.borderBottom = '1px solid #3a2a0e';
        block.style.paddingBottom = '10px';
      }

      panel.appendChild(block);
    }

    // Close button.
    const closeRow = document.createElement('div');
    closeRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:4px;';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close journal (J)';
    closeBtn.style.cssText = [
      'background:#c8a83a',
      'border:none',
      'border-radius:4px',
      'color:#1a1208',
      'cursor:pointer',
      'font-family:"Palatino Linotype",Palatino,serif',
      'font-size:13px',
      'font-weight:bold',
      'padding:7px 16px',
    ].join(';');
    closeBtn.addEventListener('click', () => this._closeJournal());
    closeRow.appendChild(closeBtn);
    panel.appendChild(closeRow);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    // Re-focus canvas when clicking overlay background (not panel).
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this._closeJournal();
    });
  }

  // ---- Fog of war helpers ---------------------------------------------------

  // Reveal the fog around world-space position (wx, wy) using the current
  // reveal radius. Draws an erasing circle onto the RenderTexture.
  // This permanently lifts fog for this player session.
  _fogRevealAt(wx, wy) {
    const r = this._fogRevealRadius;
    this._fogBrush.clear();
    this._fogBrush.fillStyle(0xffffff, 1);
    this._fogBrush.fillCircle(wx, wy, r);
    // Erase the brush shape from the fog RenderTexture.
    this._fogRT.erase(this._fogBrush);
  }

  // Pre-reveal a large area around a landmark (campfire, cave, spring).
  // Uses a slightly larger radius and records all covered tiles as revealed.
  _fogPreReveal(wx, wy, radius) {
    const T = this.meta.tile;
    this._fogBrush.clear();
    this._fogBrush.fillStyle(0xffffff, 1);
    this._fogBrush.fillCircle(wx, wy, radius);
    this._fogRT.erase(this._fogBrush);

    // Mark all tiles in this area as already revealed so the per-tile tracking
    // in _updateFog doesn't double-draw on first pass.
    const tileR = Math.ceil(radius / T) + 1;
    const cx = Math.floor(wx / T);
    const cy = Math.floor(wy / T);
    for (let dy = -tileR; dy <= tileR; dy++) {
      for (let dx = -tileR; dx <= tileR; dx++) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (tx < 0 || ty < 0 || tx >= WORLD_TILES_X || ty >= WORLD_TILES_Y) continue;
        // Only mark if tile center is within radius.
        const tileCx = tx * T + T / 2;
        const tileCy = ty * T + T / 2;
        const d = Phaser.Math.Distance.Between(wx, wy, tileCx, tileCy);
        if (d < radius) {
          this._fogRevealedTiles.add(`${tx},${ty}`);
        }
      }
    }
  }

  // Called from update() each frame — checks if the player has moved to a new
  // tile and reveals fog around their current position.
  _updateFog() {
    if (!this._fogRT) return;
    const T = this.meta.tile;
    const tx = Math.floor(this.player.x / T);
    const ty = Math.floor(this.player.y / T);
    if (tx === this._fogLastTileX && ty === this._fogLastTileY) return;
    this._fogLastTileX = tx;
    this._fogLastTileY = ty;
    const key = `${tx},${ty}`;
    if (!this._fogRevealedTiles.has(key)) {
      this._fogRevealedTiles.add(key);
      this._fogRevealAt(this.player.x, this.player.y);
    }
  }

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
