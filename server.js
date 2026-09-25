const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { SeotdaGame } = require('./lib/seotda');
const { GoStopGame } = require('./lib/gostop');
const { rngInt } = require('./lib/util');

const PORT = Number(process.env.PORT || 3300);
const START_CHIPS = 10000;
const AUTO_MS = Number(process.env.AUTO_MS || 15000); // 연결 끊긴 플레이어 자동 진행
const GAMES = {
  seotda: { name: '섯다', min: 2, max: 5 },
  matgo: { name: '맞고', min: 2, max: 2 },
  gostop: { name: '고스톱', min: 3, max: 3 },
};

const app = express();
app.use('/cards', express.static(path.join(__dirname, 'public', 'cards'), { maxAge: '7d' }));
app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

const rooms = new Map();

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += A[rngInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanName(n) { return String(n || '').trim().replace(/[<>]/g, '').slice(0, 12) || '손님'; }

function createRoom(game, perPoint, bonus) {
  const code = newCode();
  const room = {
    code, game, perPoint, bonus: bonus !== false,
    players: [], // {id, name, chips, connected, sockets:Set, wins}
    hostId: null, status: 'lobby', engine: null, round: 0, mult: 1,
    history: [], lastWinner: null, actSeq: 0, dealer: 0, timer: null, lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function publicRoom(room) {
  return {
    code: room.code, game: room.game, gameName: GAMES[room.game].name, perPoint: room.perPoint, bonus: room.bonus,
    min: GAMES[room.game].min, max: GAMES[room.game].max,
    hostId: room.hostId, status: room.status, actSeq: room.actSeq, round: room.round, mult: room.mult,
    players: room.players.map((p) => ({ id: p.id, name: p.name, chips: p.chips, connected: p.connected, wins: p.wins, playing: !!(room.engine && room.engine.seatOf(p.id) >= 0) })),
    history: room.history.slice(-10),
    startChips: START_CHIPS,
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  const pub = publicRoom(room);
  for (const p of room.players) {
    const view = room.engine ? room.engine.view(p.id) : null;
    for (const sid of p.sockets) io.to(sid).emit('state', { room: pub, me: p.id, game: view });
  }
  scheduleAuto(room);
}

function currentActorId(room) {
  const e = room.engine;
  if (!e || e.over) return null;
  if (e.kind === 'seotda') return e.turn >= 0 ? e.seats[e.turn].id : null;
  return e.turn >= 0 ? e.players[e.turn].id : null;
}

function scheduleAuto(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const actor = currentActorId(room);
  if (!actor) return;
  const p = room.players.find((x) => x.id === actor);
  if (p && p.connected) return;
  room.timer = setTimeout(() => {
    room.timer = null;
    if (currentActorId(room) !== actor) return;
    try { room.engine.autoAction(actor); afterAction(room); } catch (e) { console.error('auto', e.message); }
  }, AUTO_MS);
}

function afterAction(room) {
  room.actSeq++;
  const e = room.engine;
  if (e && e.over && room.status === 'playing') {
    const r = e.result;
    for (const [pid, d] of Object.entries(r.chipDelta)) {
      const p = room.players.find((x) => x.id === pid);
      if (p) p.chips += d;
    }
    for (const w of r.winners) { const p = room.players.find((x) => x.id === w); if (p) p.wins++; }
    if (room.game !== 'seotda') room.mult = r.nagari ? Math.min(room.mult * 2, 8) : 1;
    room.lastWinner = r.winners[0] || room.lastWinner;
    room.history.push({ round: room.round, winners: r.winnerNames, nagari: !!r.nagari, delta: r.chipDelta, summary: r.nagari ? '나가리' : `${r.winnerNames.join(', ')} 승` });
    room.status = 'result';
  }
  broadcast(room);
}

function startRound(room) {
  const G = GAMES[room.game];
  let seated = room.players.filter((p) => p.connected || room.status !== 'lobby');
  seated = room.players.slice(0, G.max);
  if (seated.length < G.min) throw new Error(`${G.name}은(는) ${G.min}명 이상 필요합니다`);
  if (room.game !== 'seotda' && seated.length !== G.min) throw new Error(`${G.name}은(는) ${G.min}명이 필요합니다`);
  room.round++;
  const ps = seated.map((p) => ({ id: p.id, name: p.name }));
  if (room.game === 'seotda') {
    room.dealer = (room.dealer + 1) % ps.length;
    room.engine = new SeotdaGame(ps, { ante: room.perPoint, dealer: room.dealer });
  } else {
    let first = ps.findIndex((p) => p.id === room.lastWinner);
    if (first < 0) first = 0;
    room.engine = new GoStopGame(ps, { perPoint: room.perPoint, mult: room.mult, first, bonus: room.bonus });
  }
  room.status = 'playing';
  room.actSeq++;
}

io.on('connection', (socket) => {
  let cur = null; // {room, player}
  const fail = (cb, msg) => { if (typeof cb === 'function') cb({ ok: false, error: msg }); else socket.emit('err', msg); };
  const ok = (cb, data) => { if (typeof cb === 'function') cb(Object.assign({ ok: true }, data)); };

  function attach(room, pid, name) {
    let p = room.players.find((x) => x.id === pid);
    if (!p) {
      if (room.players.length >= GAMES[room.game].max) throw new Error('방이 가득 찼습니다');
      if (room.status !== 'lobby' && room.game !== 'seotda') throw new Error('이미 게임이 진행 중입니다');
      p = { id: pid, name: cleanName(name), chips: START_CHIPS, connected: true, sockets: new Set(), wins: 0 };
      room.players.push(p);
    }
    if (name) p.name = cleanName(name);
    if (cur && cur.player !== p) detach();
    p.sockets.add(socket.id);
    p.connected = true;
    if (!room.hostId || !room.players.some((x) => x.id === room.hostId)) room.hostId = p.id;
    cur = { room, player: p };
    socket.join(room.code);
    return p;
  }
  function detach() {
    if (!cur) return;
    const { room, player } = cur;
    player.sockets.delete(socket.id);
    if (player.sockets.size === 0) player.connected = false;
    socket.leave(room.code);
    cur = null;
    broadcast(room);
  }

  socket.on('createRoom', (d, cb) => {
    try {
      d = d || {};
      const game = GAMES[d.game] ? d.game : 'seotda';
      const perPoint = Math.max(1, Math.min(10000, Math.floor(Number(d.perPoint) || 100)));
      if (!d.pid) throw new Error('pid 필요');
      const room = createRoom(game, perPoint, d.bonus);
      attach(room, String(d.pid), d.name);
      room.hostId = String(d.pid);
      ok(cb, { code: room.code });
      broadcast(room);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('joinRoom', (d, cb) => {
    try {
      d = d || {};
      const room = rooms.get(String(d.code || '').toUpperCase().trim());
      if (!room) throw new Error('방을 찾을 수 없습니다');
      if (!d.pid) throw new Error('pid 필요');
      attach(room, String(d.pid), d.name);
      ok(cb, { code: room.code });
      broadcast(room);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('start', (d, cb) => {
    try {
      if (!cur) throw new Error('방에 없습니다');
      const { room, player } = cur;
      if (room.hostId !== player.id) throw new Error('방장만 시작할 수 있습니다');
      if (room.status === 'playing') throw new Error('이미 진행 중');
      startRound(room);
      ok(cb);
      broadcast(room);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('action', (a, cb) => {
    try {
      if (!cur) throw new Error('방에 없습니다');
      const { room, player } = cur;
      if (room.status !== 'playing' || !room.engine) throw new Error('게임 중이 아닙니다');
      if (process.env.DEBUG_ACT) console.log('ACT', room.code, player.id, socket.id, JSON.stringify(a));
      room.engine.act(player.id, a || {});
      ok(cb);
      afterAction(room);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('resetChips', (d, cb) => {
    try {
      if (!cur) throw new Error('방에 없습니다');
      const { room, player } = cur;
      if (room.hostId !== player.id) throw new Error('방장만 가능합니다');
      if (room.status === 'playing') throw new Error('게임 중에는 초기화할 수 없습니다');
      room.players.forEach((p) => { p.chips = START_CHIPS; p.wins = 0; });
      room.history = [];
      room.mult = 1;
      ok(cb);
      broadcast(room);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('toLobby', (d, cb) => {
    try {
      if (!cur) throw new Error('방에 없습니다');
      const { room, player } = cur;
      if (room.hostId !== player.id) throw new Error('방장만 가능합니다');
      if (room.status === 'playing') throw new Error('게임 중입니다');
      room.status = 'lobby'; room.engine = null;
      ok(cb); broadcast(room);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('kick', (d, cb) => {
    try {
      if (!cur) throw new Error('방에 없습니다');
      const { room, player } = cur;
      if (room.hostId !== player.id) throw new Error('방장만 가능합니다');
      if (room.status === 'playing') throw new Error('게임 중에는 내보낼 수 없습니다');
      const t = room.players.find((x) => x.id === (d && d.pid));
      if (!t || t.id === player.id) throw new Error('대상이 없습니다');
      room.players = room.players.filter((x) => x !== t);
      for (const sid of t.sockets) io.to(sid).emit('kicked');
      if (room.status === 'result') { room.status = 'lobby'; room.engine = null; }
      ok(cb); broadcast(room);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('leave', (d, cb) => {
    if (!cur) return ok(cb);
    const { room, player } = cur;
    const playing = room.status === 'playing' && room.engine && room.engine.seatOf(player.id) >= 0;
    player.sockets.delete(socket.id);
    socket.leave(room.code);
    cur = null;
    if (!playing && room.status === 'lobby') {
      room.players = room.players.filter((x) => x !== player);
    } else if (player.sockets.size === 0) player.connected = false;
    if (room.hostId === player.id) {
      const nh = room.players.find((x) => x.connected && x !== player) || room.players.find((x) => x !== player);
      if (nh) room.hostId = nh.id;
    }
    if (room.players.length === 0) rooms.delete(room.code);
    else broadcast(room);
    ok(cb);
  });
  socket.on('disconnect', () => detach());
});

// 오래된 방 정리 (6시간 무활동)
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.lastActive > 6 * 3600 * 1000 && !r.players.some((p) => p.connected)) rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`화투 게임 서버: http://localhost:${PORT}`));
}
module.exports = { server, rooms, PORT };
