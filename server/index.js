const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

// --- Simple UUID (Node 18+ has randomUUID built-in) -------------------------
function generateId() {
  return crypto.randomUUID();
}

// --- Color palette -----------------------------------------------------------
// 12 distinct bright colors that contrast with green grass.
const COLOR_PALETTE = [
  '#e14b4b', // red
  '#4b8ce1', // blue
  '#e1c14b', // yellow
  '#4be1a0', // teal
  '#e14bb8', // pink
  '#b84be1', // purple
  '#4be14b', // bright green
  '#e17a4b', // orange
  '#4be1e1', // cyan
  '#e1e14b', // lime
  '#9b4be1', // violet
  '#4b9be1', // sky blue
];

// --- Name generation --------------------------------------------------------
const ANIMAL_NAMES = [
  'Wolf', 'Fox', 'Bear', 'Hawk', 'Lynx', 'Elk',
  'Owl', 'Deer', 'Boar', 'Hare', 'Crow', 'Mink',
];

function generateName(takenNames) {
  const taken = new Set(takenNames);
  for (const base of ANIMAL_NAMES) {
    if (!taken.has(base)) return base;
  }
  // All base names taken — add suffix
  for (let i = 0; i < 200; i++) {
    const suffix = Math.floor(Math.random() * 99) + 1;
    const base = ANIMAL_NAMES[Math.floor(Math.random() * ANIMAL_NAMES.length)];
    const name = `${base}${suffix}`;
    if (!taken.has(name)) return name;
  }
  return `Player_${generateId().slice(0, 4)}`;
}

// --- Server state -----------------------------------------------------------
// players: Map<socketId, { id, color, name, x, y }>
const players = new Map();
// colorIndex: tracks which colors are currently assigned (by color string)
const usedColors = new Set();

function assignColor() {
  for (const color of COLOR_PALETTE) {
    if (!usedColors.has(color)) return color;
  }
  // More than 12 players — generate a random hue
  const h = Math.floor(Math.random() * 360);
  return `hsl(${h},80%,60%)`;
}

// --- Express + Socket.io ----------------------------------------------------
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Allow: no origin (same-origin requests), GitHub Pages, localhost any port
      if (
        !origin ||
        origin === 'https://yoakshat.github.io' ||
        /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
      ) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ['GET', 'HEAD', 'POST'],
    credentials: false,
  },
});

// Health endpoints — Railway uses these to detect the service is up.
app.get('/', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// --- Socket.io events -------------------------------------------------------
io.on('connection', (socket) => {
  const id = generateId();
  const color = assignColor();
  usedColors.add(color);
  const name = generateName([...players.values()].map((p) => p.name));

  // Default spawn near world center (32×48 = 1536 wide, 24×48 = 1152 tall)
  const spawnX = 768;
  const spawnY = 576;

  const player = { id, color, name, x: spawnX, y: spawnY };
  players.set(socket.id, player);

  console.log(`[+] ${name} (${id.slice(0, 6)}) connected — total: ${players.size}`);

  // 1. Send new client their identity + current list of all other players.
  socket.emit('self:init', {
    id,
    color,
    name,
    others: [...players.values()]
      .filter((p) => p.id !== id)
      .map(({ id: pid, color: pc, name: pn, x, y }) => ({
        id: pid,
        color: pc,
        name: pn,
        x,
        y,
      })),
  });

  // 2. Announce newcomer to everyone already connected.
  socket.broadcast.emit('player:join', { id, color, name, x: spawnX, y: spawnY });

  // 3. Movement: client emits player:move, we broadcast player:moved to others.
  socket.on('player:move', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    const x = typeof data.x === 'number' ? data.x : p.x;
    const y = typeof data.y === 'number' ? data.y : p.y;
    p.x = x;
    p.y = y;
    socket.broadcast.emit('player:moved', { id: p.id, x, y });
  });

  // 4. Disconnect: clean up and notify others.
  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (!p) return;
    console.log(`[-] ${p.name} (${p.id.slice(0, 6)}) disconnected — total: ${players.size - 1}`);
    usedColors.delete(p.color);
    players.delete(socket.id);
    io.emit('player:left', { id: p.id });
  });
});

// --- Boot -------------------------------------------------------------------
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Living Game server listening on port ${PORT}`);
});
