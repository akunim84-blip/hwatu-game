const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { SeotdaGame } = require('./lib/seotda');
const { GoStopGame } = require('./lib/gostop');
const { rngInt } = require('./lib/util');
const AI = require('./lib/ai');
const { Accounts, START_MONEY, BANKRUPT_MONEY } = require('./lib/accounts');

const PORT = Number(process.env.PORT || 3300);
const START_CHIPS = START_MONEY; // 가상 머니 1,000,000원 (실제 돈 아님)
const accounts = new Accounts();
const STAKES = { seotda: [5000, 10000, 50000, 100000], matgo: [500, 1000, 5000, 10000], gostop: [500, 1000, 5000, 10000] };
const DEFAULT_STAKE = { seotda: 10000, matgo: 1000, gostop: 1000 };
// 턴 타이머 (TIMER_V1): 사람 차례마다 10초. 애니메이션(패 돌리기·선 정하기·먹는 연출) 시간은 따로 더 줌
const TURN_MS = Number(process.env.TURN_MS || 10000);
const AUTO_MS = process.env.AUTO_MS ? Number(process.env.AUTO_MS) : null; // (시뮬레이션용) 연결 끊긴 플레이어 자동 진행 시간 덮어쓰기
const SQUEEZE_GRACE = 1500; // 섯다: 패 받은 뒤 쪼기(스퀴즈) 볼 시간
const TIMEOUT_TEXT = '시간 초과 — 자동으로 냈어요';
// 채팅 (CHAT_V1)
const CHAT_MAX = 100, CHAT_KEEP = 50, CHAT_RATE_N = 5, CHAT_RATE_MS = 5000;
const AI_DELAY_SCALE = Number(process.env.AI_DELAY_SCALE || 1); // 시뮬레이션용 AI 지연 배율
const AI_DEAL_WAIT = 2500; // 새 판 패 돌리기 애니메이션 동안 AI 대기 (섯다)
const AI_DEAL_WAIT_GOSTOP = 3700; // 맞고/고스톱: 셔플(1초) + 한 장씩 돌리기(~2.4초)
const SEON_WAIT_DRAW = 2600; // 시작 연출: 선 고르기(카드 뒤집기) + '판 시작' 도장
const SEON_WAIT_WINNER = 1300; // 시작 연출: '선: 지난 판 승자' + '판 시작' 도장
const GAMES = {
  seotda: { name: '섯다', min: 2, max: 5 },
  matgo: { name: '맞고', min: 2, max: 2 },
  gostop: { name: '고스톱', min: 3, max: 3 },
};

const app = express();
// 역방향 프록시(Synology/nginx/Cloudflare Tunnel) 뒤에서 돌 때: TRUST_PROXY=1 이면 바로 앞 프록시 1단계를 믿음
// → req.ip 가 실제 접속자 IP, req.secure 가 X-Forwarded-Proto(https) 반영. (Docker 이미지 기본값 1, Render 는 설정 안 함 = 예전 동작)
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY === 'true' ? true : TRUST_PROXY);
// 가벼운 상태 확인 (Docker HEALTHCHECK·역방향 프록시용): DB 안 건드림
app.get('/healthz', (req, res) => res.set('Cache-Control', 'no-store').type('text').send('ok'));
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

function createRoom(game, perPoint, bonus, priv) {
  const code = newCode();
  const room = {
    code, game, perPoint, bonus: bonus !== false, private: !!priv, created: Date.now(),
    players: [], // {id, name, chips, connected, sockets:Set, wins}
    spectators: [], // {id, name, connected, sockets:Set, waiting} — 관전자 (waiting: 다음 판부터 AI 자리 대신 참여)
    hostId: null, status: 'lobby', engine: null, round: 0, mult: 1,
    history: [], lastWinner: null, actSeq: 0, dealer: 0, timer: null, lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

// 자리에 보여 줄 전적: 전체 + 이 방 게임 (계정만)
function recOf(p, game) {
  const a = p.acct && accounts.cache.get(p.acct);
  if (!a) return undefined;
  const st = accounts.statsOf(a);
  return { t: st.total, g: st[game] };
}
function publicRoom(room) {
  return {
    code: room.code, game: room.game, gameName: GAMES[room.game].name, perPoint: room.perPoint, bonus: room.bonus,
    min: GAMES[room.game].min, max: GAMES[room.game].max,
    hostId: room.hostId, status: room.status, actSeq: room.actSeq, round: room.round, mult: room.mult,
    players: room.players.map((p) => ({ id: p.id, name: p.name, chips: p.chips, net: p.net || 0, refilled: p.refilled || 0, member: !!p.acct, connected: p.connected, leaveReserved: !!p.leaveReserved, rec: recOf(p, room.game), wins: p.wins, ai: !!p.ai, level: p.ai ? p.level : undefined, playing: !!(room.engine && room.engine.seatOf(p.id) >= 0) })),
    history: room.history.slice(-10),
    startChips: START_CHIPS,
    private: !!room.private,
    spectators: room.spectators.filter((x) => x.connected).map((x) => ({ id: x.id, name: x.name, waiting: !!x.waiting })),
    // 턴 타이머: 남은 ms (애니메이션 대기 포함) · 전체 ms. 클라이언트는 받은 순간 기준으로 카운트다운
    turn: room.turnKey && room.turnDeadline ? { pid: room.turnPid, ms: Math.max(0, room.turnDeadline - Date.now()), total: room.turnTotal } : null,
  };
}

// ---------- 공개 방 목록 / 관전 / AI 자리 넘겨받기 ----------
const hasHumanOnline = (room) => room.players.some((p) => !p.ai && p.connected) || room.spectators.some((x) => x.connected);
// 지금 사람이 앉을 수 있는 자리: 빈 자리 또는 AI 자리
const openSeat = (room) => room.players.length < GAMES[room.game].max || room.players.some((p) => p.ai);
function roomListItem(room) {
  const host = room.players.find((p) => p.id === room.hostId) || room.players.find((p) => !p.ai);
  const aiCount = room.players.filter((p) => p.ai).length;
  const open = openSeat(room);
  return {
    code: room.code, game: room.game, gameName: GAMES[room.game].name, host: host ? host.name : '?',
    humans: room.players.length - aiCount, ai: aiCount, max: GAMES[room.game].max, status: room.status, round: room.round,
    perPoint: room.perPoint, spectators: room.spectators.filter((x) => x.connected).length,
    join: room.status === 'playing' ? (open ? 'next' : 'watch') : open ? 'seat' : 'watch', // seat: 바로 참여, next: 관전 후 다음 판부터, watch: 관전만
  };
}
function roomList() {
  return [...rooms.values()].filter((r) => !r.private && hasHumanOnline(r)).sort((a, b) => b.created - a.created).slice(0, 30).map(roomListItem);
}
let roomsTimer = null, roomsLast = '';
function pushRoomList(now) {
  const send = () => {
    roomsTimer = null;
    const list = roomList();
    const j = JSON.stringify(list);
    if (j === roomsLast) return;
    roomsLast = j;
    io.to('lobby-watch').emit('rooms', list);
  };
  if (now) { if (roomsTimer) clearTimeout(roomsTimer); return send(); }
  if (!roomsTimer) { roomsTimer = setTimeout(send, 300); if (roomsTimer.unref) roomsTimer.unref(); }
}
// 사람을 자리에 앉힘 (빈 자리 → 뒤쪽 AI 자리 교체). 앉혔으면 true
// 사람의 현재 잔액: 계정이면 저장된 잔액, 손님이면 방 안에서만 1,000,000원
function moneyOf(p) {
  if (p.acct) { const a = accounts.cache.get(p.acct); if (a) return a.balance; }
  return p.chips != null ? p.chips : START_CHIPS;
}
function seatHuman(room, sp) {
  const G = GAMES[room.game];
  if (room.players.length >= G.max) {
    const bot = room.players.slice().reverse().find((x) => x.ai);
    if (!bot) return false;
    const k = room.players.indexOf(bot);
    room.players.splice(k, 1);
  }
  room.spectators = room.spectators.filter((x) => x !== sp);
  // 같은 객체를 플레이어로 전환 (소켓 연결 정보 유지)
  Object.assign(sp, { chips: moneyOf(sp), wins: 0, net: 0 });
  delete sp.waiting;
  room.players.push(sp);
  if (!room.players.some((x) => x.id === room.hostId && !x.ai && x.connected)) room.hostId = sp.id;
  return true;
}
// 판과 판 사이(대기실·결과 화면·새 판 시작 직전)에 기다리던 관전자를 자리에 앉힘
function promoteWaiting(room) {
  if (room.status === 'playing') return false;
  let changed = false;
  for (const sp of room.spectators.slice()) {
    if (!sp.waiting || !sp.connected) continue;
    if (!seatHuman(room, sp)) { sp.waiting = false; continue; }
    changed = true;
  }
  return changed;
}

function broadcast(room) {
  room.lastActive = Date.now();
  scheduleAuto(room); // 턴 마감 시각을 먼저 정해서 상태와 함께 보냄
  const pub = publicRoom(room);
  for (const p of room.players) {
    const view = room.engine ? room.engine.view(p.id) : null;
    for (const sid of p.sockets) io.to(sid).emit('state', { room: pub, me: p.id, game: view });
  }
  // 관전자: 공개 정보만 (engine.view에 자리 없는 id → 손패는 모두 가려짐)
  for (const sp of room.spectators) {
    if (!sp.sockets.size) continue;
    const view = room.engine ? room.engine.view(sp.id) : null;
    for (const sid of sp.sockets) io.to(sid).emit('state', { room: pub, me: sp.id, game: view, spectator: { waiting: !!sp.waiting } });
  }
  pushRoomList();
}

// 이름 바꾸기: 방·관전자·게임 엔진 안의 옛 플레이어 id('u:옛키')를 새 id로, 이름도 새 이름으로 (다른 사람 화면에도 바로 반영)
function remapIds(obj, oldPid, newPid, newName, seen) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) { if (obj[i] === oldPid) obj[i] = newPid; else remapIds(obj[i], oldPid, newPid, newName, seen); }
  } else {
    const proto = Object.getPrototypeOf(obj);
    if (seen.size > 1 && proto !== Object.prototype && proto !== null) return; // 엔진 안의 일반 객체·배열만 (타이머·Set 등 제외)
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === 'function') continue;
      let kk = k;
      if (k === oldPid && oldPid !== newPid) { obj[newPid] = obj[k]; delete obj[k]; kk = newPid; }
      if (obj[kk] === oldPid) obj[kk] = newPid;
      else remapIds(obj[kk], oldPid, newPid, newName, seen);
    }
    if (obj.id === newPid && typeof obj.name === 'string') obj.name = newName;
    if (Array.isArray(obj.winners) && Array.isArray(obj.winnerNames)) obj.winners.forEach((w, i) => { if (w === newPid) obj.winnerNames[i] = newName; });
  }
}
function renameInRooms(oldPid, newPid, newName) {
  for (const room of rooms.values()) {
    let hit = false;
    for (const p of room.players.concat(room.spectators)) if (p.id === oldPid) { p.id = newPid; p.name = newName; if (p.acct) p.acct = newPid.slice(2); hit = true; }
    if (!hit) continue;
    if (room.hostId === oldPid) room.hostId = newPid;
    if (room.lastWinner === oldPid) room.lastWinner = newPid;
    room.history.forEach((h) => { if (h.delta && h.delta[oldPid] !== undefined) { h.delta[newPid] = h.delta[oldPid]; delete h.delta[oldPid]; } });
    if (room.engine) remapIds(room.engine, oldPid, newPid, newName, new Set());
    if (room.timer) { clearTimeout(room.timer); room.timer = null; } // 예약된 자동 진행은 새 id로 다시 예약 (broadcast → scheduleAuto)
    broadcast(room);
  }
  pushRoomList(true);
}

// 이름 변경 반영 (본인·관리자 공통): 같은 계정 소켓 모두 새 키로, 방 자리·방 목록·순위 갱신
function applyRename(r) {
  if (r.newKey !== r.oldKey) {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.acct === r.oldKey) { s.leave('acct:' + r.oldKey); s.data.acct = r.newKey; s.join('acct:' + r.newKey); }
    }
  }
  renameInRooms('u:' + r.oldKey, 'u:' + r.newKey, r.account.nickname);
  io.to('acct:' + r.newKey).emit('me', r.account);
  pushRanking();
}
const inRound = (room, pid) => room.status === 'playing' && room.engine && !room.engine.over && room.engine.seatOf(pid) >= 0;
function closeRoomIfEmpty(room) {
  if (!room.spectators.some((x) => x.connected) && (humans(room).length === 0 || (room.solo && !humans(room).some((x) => x.connected)))) {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    rooms.delete(room.code);
    return true;
  }
  return false;
}
// 계정이 사라짐 (본인 삭제·관리자 삭제): 접속 중인 기기 로그아웃 + 알림, 방에서 빼기
//  (진행 중인 판이면 그 판은 계정 없는 자리로 자동 진행 후 정리 — 삭제된 계정에 돈이 다시 쓰이지 않게)
function dropAccountEverywhere(key, text, exceptSocket) {
  const pid = 'u:' + key;
  for (const s of io.sockets.sockets.values()) {
    if (s.data.acct !== key) continue;
    if (s.data.dropRoom) s.data.dropRoom();
    s.leave('acct:' + key); s.data.acct = null;
    if (s !== exceptSocket) s.emit('accountDeleted', { text });
  }
  for (const room of [...rooms.values()]) {
    const sp = room.spectators.find((x) => x.id === pid);
    const p = room.players.find((x) => x.id === pid);
    if (!sp && !p) continue;
    room.spectators = room.spectators.filter((x) => x.id !== pid);
    if (p) {
      if (inRound(room, pid)) { p.acct = null; p.chips = START_CHIPS; p.connected = false; p.sockets.clear(); }
      else {
        room.players = room.players.filter((x) => x !== p);
        if (room.status === 'result') { room.status = 'lobby'; room.engine = null; }
      }
      if (room.hostId === pid) { const nh = room.players.find((x) => !x.ai && x.connected && x.id !== pid) || room.players.find((x) => !x.ai && x.id !== pid); if (nh) room.hostId = nh.id; }
    }
    if (!closeRoomIfEmpty(room)) { if (room.status !== 'playing') promoteWaiting(room); broadcast(room); }
  }
  pushRoomList(true);
  pushRanking();
}
// 관리자: 방 닫기 (모두 내보내고 방 삭제)
function closeRoom(room, text) {
  for (const p of room.players.concat(room.spectators)) {
    for (const sid of p.sockets) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data.dropRoom) s.data.dropRoom();
      io.to(sid).emit('kicked', { text });
    }
  }
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  rooms.delete(room.code);
  pushRoomList(true);
}

// ---------- 채팅 (CHAT_V1) ----------
// 글자 정리: 앞뒤 공백·제어문자 제거, 100자, 꺾쇠(<>)는 전각으로 바꿔 HTML이 될 수 없게 (클라이언트도 한 번 더 이스케이프)
function cleanChat(t) {
  return String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/</g, '＜').replace(/>/g, '＞').slice(0, CHAT_MAX);
}
function pushChat(room, msg) {
  room.chatSeq = (room.chatSeq || 0) + 1;
  const m = Object.assign({ n: room.chatSeq, t: Date.now() }, msg);
  room.chat = (room.chat || []).concat(m).slice(-CHAT_KEEP);
  io.to(room.code).emit('chat', m);
  return m;
}
const sysChat = (room, text) => pushChat(room, { sys: true, text: cleanChat(text) });

function currentActorId(room) {
  const e = room.engine;
  if (!e || e.over) return null;
  if (e.kind === 'seotda') return e.turn >= 0 ? e.seats[e.turn].id : null;
  return e.turn >= 0 ? e.players[e.turn].id : null;
}

// 사람 차례가 시작되기 전 연출 시간 (그동안은 시간이 안 줄어든 것처럼 10초를 온전히 줌)
function humanGrace(room) {
  const e = room.engine;
  if (room.actSeq === room.roundStartSeq) return e.kind === 'seotda' ? AI_DEAL_WAIT + SQUEEZE_GRACE : AI_DEAL_WAIT_GOSTOP + (e.seon && e.seon.reason === 'draw' ? SEON_WAIT_DRAW : SEON_WAIT_WINNER);
  if (e.kind !== 'seotda') {
    const lc = e.lastCapture;
    if (lc && lc.seq !== room._lcSeenH) {
      room._lcSeenH = lc.seq;
      const n = (lc.gained || []).length;
      if (n) return 1850 + 35 * n + ((lc.steals || []).length ? 450 : 0);
    }
    return 900;
  }
  return 600;
}
// 시간 초과 자동 행동: 맞는 패 우선(AI 판단, 흔들기는 안 함), 먹을 패는 좋은 쪽, 고/스톱은 스톱, 섯다는 체크 아니면 다이
function timeoutAction(room, pid) {
  const e = room.engine;
  if (e.kind === 'seotda') return e.autoAction(pid);
  const v = e.view(pid);
  const o = v.options;
  if (!o) return;
  if (o.phase === 'goStop') return e.act(pid, { type: 'stop' });
  try {
    const a = AI.decide(v, { level: 'normal', rand: () => 0.5 });
    if (!a) throw new Error('no decision');
    if (a.type === 'play') a.shake = false;
    if (a.type === 'go') throw new Error('stop instead');
    e.act(pid, a);
  } catch (err) { e.autoAction(pid); }
}
function scheduleAuto(room) {
  const actor = currentActorId(room);
  const p = actor && room.players.find((x) => x.id === actor);
  if (p && !p.ai) {
    // 사람 차례: 같은 차례(같은 actSeq)면 마감 시각 유지 — 재접속·입장으로 다시 불려도 시간이 늘지 않음
    const quick = !p.connected && AUTO_MS != null; // 시뮬레이션: 끊긴 사람은 빨리
    const key = actor + '|' + room.round + '|' + room.actSeq + (quick ? '|q' : '');
    if (room.turnKey === key && room.timer) return;
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    const e = room.engine;
    const grace = quick ? 0 : humanGrace(room) * AI_DELAY_SCALE;
    const total = quick ? AUTO_MS : TURN_MS;
    room.turnKey = key; room.turnPid = actor; room.turnTotal = total; room.turnDeadline = Date.now() + grace + total;
    room.timer = setTimeout(() => {
      room.timer = null;
      if (room.turnKey !== key || currentActorId(room) !== actor || room.engine !== e || e.over) return; // 이미 냈으면 아무것도 안 함
      room.turnKey = null;
      try { timeoutAction(room, actor); } catch (err) { console.error('timeout', err.message); }
      if (p.connected) for (const sid of p.sockets) io.to(sid).emit('notice', { type: 'timeout', text: TIMEOUT_TEXT });
      afterAction(room);
    }, grace + total);
    if (room.timer.unref) room.timer.unref();
    return;
  }
  room.turnKey = null; room.turnDeadline = null;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (!actor) return;
  if (p && p.ai) {
    // AI: 사람처럼 0.7~1.5초 생각 (새 판이면 패 돌리기 애니메이션이 끝날 때까지 추가 대기)
    const e = room.engine;
    let ms = 700 + Math.random() * 800;
    if (room.actSeq === room.roundStartSeq) ms += e.kind === 'seotda' ? AI_DEAL_WAIT : AI_DEAL_WAIT_GOSTOP + (e.seon && e.seon.reason === 'draw' ? SEON_WAIT_DRAW : SEON_WAIT_WINNER);
    else if (e.kind !== 'seotda') {
      // 맞고/고스톱: 직전 패 내기·먹기(+피 뺏기) 애니메이션이 끝까지 보이도록 기다림
      ms = 1150 + Math.random() * 600;
      const lc = e.lastCapture;
      if (lc && lc.seq !== room._lcSeen) {
        room._lcSeen = lc.seq;
        const n = (lc.gained || []).length;
        if (n) { ms = 1850 + 35 * n + ((lc.steals || []).length ? 450 : 0) + Math.random() * 450; room._animUntil = Date.now() + ms; }
      } else if (room._animUntil) ms = Math.max(ms, room._animUntil - Date.now()); // 다시 예약돼도(입장·연결 변화) 애니메이션 끝까지 기다림
    }
    room.timer = setTimeout(() => {
      room.timer = null;
      if (currentActorId(room) !== actor || room.engine !== e) return;
      runAI(room, p);
    }, ms * AI_DELAY_SCALE);
    if (room.timer.unref) room.timer.unref(); // 서버(listen)가 프로세스를 유지하므로 무해 — 테스트 종료가 빨라짐
    return;
  }
}

function runAI(room, p) {
  const e = room.engine;
  try {
    const a = AI.decide(e.view(p.id), { level: p.level });
    if (!a) throw new Error('AI 결정 없음');
    e.act(p.id, a);
  } catch (err) {
    // 결정이 거부되면 기본 자동 행동으로 대체 (절대 멈추지 않음)
    try { e.autoAction(p.id); } catch (err2) { console.error('ai', err.message, err2.message); }
  }
  afterAction(room);
}

function addAI(room, level) {
  const G = GAMES[room.game];
  if (room.players.length >= G.max) throw new Error('빈 자리가 없습니다');
  const used = new Set(room.players.map((x) => x.name));
  const base = AI.AI_NAMES.find((n) => !used.has('🤖 ' + n)) || 'AI봇';
  const p = { id: 'ai-' + Math.random().toString(36).slice(2, 10), name: '🤖 ' + base, chips: START_CHIPS, net: 0, connected: true, sockets: new Set(), wins: 0, ai: true, level: level === 'easy' ? 'easy' : 'normal' };
  room.players.push(p);
  return p;
}
const humans = (room) => room.players.filter((x) => !x.ai);

// 판 정산 (가상 머니): 계정은 저장소에 바로 기록, 0원 이하 → 파산 300,000원 (AI는 조용히 1,000,000원 충전)
function settlePlayer(room, p, d, outcome) {
  p.net = (p.net || 0) + d;
  if (p.acct && accounts.cache.has(p.acct)) {
    const a = accounts.cache.get(p.acct);
    const r = accounts.settleCached(a, d, outcome); // 잔액 + 전적 한 번에 저장 (AI·손님은 기록 안 함)
    p.chips = r.balance;
    room.saving = r.saved.catch((e) => console.error('정산 저장 실패', p.acct, e.message));
    if (r.bankrupt) notifyBankrupt(p);
    io.to('acct:' + a.key).emit('me', accounts.pub(a));
    return;
  }
  p.chips += d;
  if (p.chips <= 0) {
    const before = p.chips;
    p.chips = p.ai ? START_CHIPS : BANKRUPT_MONEY;
    p.refilled = (p.refilled || 0) + (p.chips - before);
    if (!p.ai) notifyBankrupt(p);
  }
}
function notifyBankrupt(p) {
  for (const sid of p.sockets) io.to(sid).emit('notice', { type: 'bankrupt', text: '파산! 300,000원으로 다시 시작' });
}
let rankTimer = null;
function pushRanking() {
  if (rankTimer) return;
  rankTimer = setTimeout(async () => { rankTimer = null; try { io.to('lobby-watch').emit('ranking', await accounts.top(10)); } catch (e) {} }, 1500);
  if (rankTimer.unref) rankTimer.unref();
}

// 전적: 이긴 사람 승, 나머지 패. 나가리·섯다 동점(판돈 나눔)은 무 (동점이면 이긴 사람들만 무, 나머지는 패)
// 판에 앉았던 사람 전부 (연결 끊김·나가기 예약 포함 — 자리 주인 계정에 기록). AI·손님은 settlePlayer에서 기록 안 함
function roundOutcomes(e) {
  const r = e.result;
  const seats = (e.kind === 'seotda' ? e.seats : e.players).map((x) => x.id);
  const tie = !r.nagari && r.winners.length > 1;
  return [...new Set(seats.concat(Object.keys(r.chipDelta || {})))].map((pid) => ({
    pid, delta: (r.chipDelta && r.chipDelta[pid]) || 0,
    res: r.nagari ? 'd' : r.winners.includes(pid) ? (tie ? 'd' : 'w') : 'l',
  }));
}
function afterAction(room) {
  room.actSeq++;
  const e = room.engine;
  if (e && e.kind === 'seotda' && e.redeals !== room.seenRedeals) { room.seenRedeals = e.redeals; room.roundStartSeq = room.actSeq; } // 재경기: 다시 패 돌림
  if (e && e.over && room.status === 'playing') {
    const r = e.result;
    for (const o of roundOutcomes(e)) {
      const p = room.players.find((x) => x.id === o.pid);
      if (p) settlePlayer(room, p, o.delta, { game: room.game, res: o.res });
    }
    pushRanking();
    for (const w of r.winners) { const p = room.players.find((x) => x.id === w); if (p) p.wins++; }
    if (room.game !== 'seotda') room.mult = r.nagari ? Math.min(room.mult * 2, 8) : 1;
    room.lastWinner = r.winners[0] || room.lastWinner;
    room.history.push({ round: room.round, winners: r.winnerNames, nagari: !!r.nagari, delta: r.chipDelta, summary: r.nagari ? '나가리' : `${r.winnerNames.join(', ')} 승` });
    room.status = 'result';
    promoteWaiting(room); // 판이 끝나면 기다리던 사람이 AI 자리를 넘겨받음
    if (room.players.some((p) => p.leaveReserved)) {
      broadcast(room); // 예약한 사람도 결과(정산된 돈)를 먼저 받음
      return processReservedLeaves(room);
    }
  }
  broadcast(room);
}
// 나가기 예약 (한게임 방식): 판이 끝나고 정산된 뒤 자동으로 방에서 나감. 자리는 AI가 이어받고, 방장은 다음 사람에게,
// 사람이 아무도 없으면 방을 닫음
function processReservedLeaves(room) {
  const G = GAMES[room.game];
  for (const p of room.players.filter((x) => x.leaveReserved)) {
    delete p.leaveReserved;
    for (const sid of [...p.sockets]) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data.dropRoom) s.data.dropRoom();
      io.to(sid).emit('reservedLeft', { text: '예약한 대로 방에서 나왔어요' });
    }
    p.sockets.clear(); p.connected = false;
    sysChat(room, `${p.name}님이 나갔어요 (나가기 예약)`);
    const k = room.players.indexOf(p);
    room.players.splice(k, 1);
    if (room.players.length < G.max && humans(room).length) {
      const lvl = (room.players.find((x) => x.ai) || {}).level;
      const bot = addAI(room, lvl || 'normal');
      room.players.splice(room.players.indexOf(bot), 1);
      room.players.splice(k, 0, bot); // 같은 자리에 AI
    }
    if (room.hostId === p.id) { const nh = room.players.find((x) => !x.ai && x.connected) || room.players.find((x) => !x.ai); if (nh) room.hostId = nh.id; }
  }
  if (closeRoomIfEmpty(room)) { pushRoomList(true); return; }
  promoteWaiting(room);
  broadcast(room);
  pushRoomList();
}

function startRound(room) {
  const G = GAMES[room.game];
  room.status = room.status === 'playing' ? 'playing' : 'lobby';
  promoteWaiting(room);
  let seated = room.players.filter((p) => p.connected || room.status !== 'lobby');
  seated = room.players.slice(0, G.max);
  if (seated.length < G.min) throw new Error(`${G.name}은(는) ${G.min}명 이상 필요합니다`);
  if (room.game !== 'seotda' && seated.length !== G.min) throw new Error(`${G.name}은(는) ${G.min}명이 필요합니다`);
  seated.forEach((p) => { if (p.acct) p.chips = moneyOf(p); }); // 다른 방에서 바뀐 잔액 반영
  room.round++;
  const ps = seated.map((p) => ({ id: p.id, name: p.name }));
  if (room.game === 'seotda') {
    room.dealer = (room.dealer + 1) % ps.length;
    room.engine = new SeotdaGame(ps, { ante: room.perPoint, dealer: room.dealer });
  } else {
    // 선: 지난 판 승자. 첫 판(또는 승자가 자리에 없음)이면 선 고르기 — 각자 한 장씩 뒤집어 높은 달
    let first = ps.findIndex((p) => p.id === room.lastWinner);
    let seon = null;
    if (first < 0) { seon = GoStopGame.drawSeon(ps.length); first = seon.seat; }
    room.engine = new GoStopGame(ps, { perPoint: room.perPoint, mult: room.mult, first, bonus: room.bonus, seon });
  }
  room.status = 'playing';
  room.actSeq++;
  room.roundStartSeq = room.actSeq; room._lcSeen = null;
  room.seenRedeals = 0;
}

io.on('connection', (socket) => {
  let cur = null; // {room, player}
  // 서버가 이 소켓을 방에서 빼야 할 때 (계정 삭제·방 닫기)
  socket.data.dropRoom = () => { if (!cur) return; cur.player.sockets.delete(socket.id); if (!cur.player.sockets.size) cur.player.connected = false; socket.leave(cur.room.code); cur = null; };
  const fail = (cb, msg, code) => { if (typeof cb === 'function') cb({ ok: false, error: msg, code }); else socket.emit('err', msg); };
  const ok = (cb, data) => { if (typeof cb === 'function') cb(Object.assign({ ok: true }, data)); };

  // 로그인한 계정이면 계정 기준 id/닉네임, 아니면 손님(테스트·시뮬레이션용)
  function ident(d) {
    if (socket.data.acct) { const a = accounts.cache.get(socket.data.acct); return { pid: 'u:' + socket.data.acct, name: a ? a.nickname : d.name, acct: socket.data.acct }; }
    if (!d.pid) throw new Error('pid 필요');
    const pid = String(d.pid);
    if (pid.startsWith('u:')) throw new Error('로그인이 필요합니다');
    return { pid, name: d.name, acct: null };
  }
  function attach(room, pid, name, acct) {
    let p = room.players.find((x) => x.id === pid) || room.spectators.find((x) => x.id === pid);
    if (!p) {
      // 새로 온 사람: 판 사이면 바로 자리(빈 자리/AI 자리), 판 진행 중이면 관전 → 다음 판부터 AI 자리 넘겨받기, 사람으로 꽉 차면 관전만
      p = { id: pid, name: cleanName(name), acct: acct || null, connected: true, sockets: new Set(), waiting: openSeat(room) };
      if (!acct) p.chips = START_CHIPS;
      room.spectators.push(p);
      p.isNew = true;
    }
    if (p.waiting) promoteWaiting(room);
    if (name) p.name = cleanName(name);
    if (cur && cur.player !== p) detach();
    p.sockets.add(socket.id);
    p.connected = true;
    if (room.players.includes(p) && (!room.hostId || !room.players.some((x) => x.id === room.hostId))) room.hostId = p.id;
    cur = { room, player: p };
    socket.join(room.code);
    socket.emit('chatHistory', { code: room.code, list: room.chat || [] }); // 새로 들어오거나 재접속하면 최근 대화
    if (p.isNew) { delete p.isNew; if (room.players.length + room.spectators.length > 1) sysChat(room, `${p.name}님이 들어왔어요`); }
    return p;
  }
  function detach() {
    if (!cur) return;
    const { room, player } = cur;
    player.sockets.delete(socket.id);
    if (player.sockets.size === 0) { player.connected = false; delete player.leaveReserved; } // 연결이 끊기면 나가기 예약 취소
    socket.leave(room.code);
    cur = null;
    broadcast(room);
  }

  socket.on('createRoom', (d, cb) => {
    try {
      d = d || {};
      const game = GAMES[d.game] ? d.game : 'seotda';
      const perPoint = Math.max(1, Math.min(100000, Math.floor(Number(d.perPoint) || DEFAULT_STAKE[game])));
      const who = ident(d);
      const room = createRoom(game, perPoint, d.bonus, d.private);
      attach(room, who.pid, who.name, who.acct);
      room.hostId = who.pid;
      if (d.ai) {
        // 'AI와 바로 하기': AI로 자리를 채우고 바로 시작
        const n = game === 'seotda' ? Math.max(1, Math.min(4, Math.floor(Number(d.aiCount) || 3))) : GAMES[game].min - 1;
        for (let k = 0; k < n; k++) addAI(room, d.level);
        room.solo = true;
        startRound(room);
      }
      ok(cb, { code: room.code });
      broadcast(room);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('joinRoom', (d, cb) => {
    try {
      d = d || {};
      const room = rooms.get(String(d.code || '').toUpperCase().trim());
      if (!room) throw new Error('방을 찾을 수 없습니다');
      const who = ident(d);
      attach(room, who.pid, who.name, who.acct);
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
  socket.on('addAI', (d, cb) => {
    try {
      if (!cur) throw new Error('방에 없습니다');
      const { room, player } = cur;
      if (room.hostId !== player.id) throw new Error('방장만 AI를 추가할 수 있습니다');
      if (room.status === 'playing') throw new Error('게임 중에는 추가할 수 없습니다');
      addAI(room, d && d.level);
      if (room.status === 'result') { room.status = 'lobby'; room.engine = null; }
      ok(cb); broadcast(room);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('resetChips', (d, cb) => {
    try {
      if (!cur) throw new Error('방에 없습니다');
      const { room, player } = cur;
      if (room.hostId !== player.id) throw new Error('방장만 가능합니다');
      if (room.status === 'playing') throw new Error('게임 중에는 초기화할 수 없습니다');
      room.players.forEach((p) => { if (!p.acct) p.chips = START_CHIPS; p.wins = 0; p.net = 0; }); // 계정 잔액은 그대로 (기록만 초기화)
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
  // 나가기 버튼: 판 진행 중이면 예약/취소 (계속 정상 플레이), 판이 아니면 바로 나가도 된다고 알려 줌 (클라이언트가 leave)
  socket.on('reserveLeave', (d, cb) => {
    if (!cur) return fail(cb, '방에 없습니다');
    const { room, player } = cur;
    if (!room.players.includes(player) || !inRound(room, player.id)) { delete player.leaveReserved; return ok(cb, { leaveNow: true }); }
    const on = d && d.on !== undefined ? !!d.on : !player.leaveReserved;
    if (on) player.leaveReserved = true; else delete player.leaveReserved;
    ok(cb, { reserved: on });
    broadcast(room);
  });
  // 채팅: 방 안 사람(관전자 포함)에게. 5초에 5개까지
  socket.on('chat', (d, cb) => {
    if (!cur) return fail(cb, '방에 없습니다');
    const { room, player } = cur;
    const text = cleanChat(d && d.text);
    if (!text) return fail(cb, '내용을 입력하세요');
    const now = Date.now();
    const times = (socket.data.chatTimes || []).filter((t) => now - t < CHAT_RATE_MS);
    if (times.length >= CHAT_RATE_N) { socket.data.chatTimes = times; return fail(cb, '채팅이 너무 빨라요. 잠시 후에 보내세요', 'RATE'); }
    times.push(now); socket.data.chatTimes = times;
    const m = pushChat(room, { pid: player.id, name: player.name, text });
    ok(cb, { n: m.n });
  });
  socket.on('leave', (d, cb) => {
    if (!cur) return ok(cb);
    const { room, player } = cur;
    if (room.players.includes(player) || room.spectators.includes(player)) sysChat(room, `${player.name}님이 나갔어요`);
    const playing = room.status === 'playing' && room.engine && room.engine.seatOf(player.id) >= 0;
    player.sockets.delete(socket.id);
    socket.leave(room.code);
    cur = null;
    if (room.spectators.includes(player)) {
      room.spectators = room.spectators.filter((x) => x !== player);
      broadcast(room);
      return ok(cb);
    }
    if (!playing && room.status === 'lobby') {
      room.players = room.players.filter((x) => x !== player);
    } else if (player.sockets.size === 0) player.connected = false;
    if (room.hostId === player.id) {
      const nh = room.players.find((x) => !x.ai && x.connected && x !== player) || room.players.find((x) => !x.ai && x !== player);
      if (nh) room.hostId = nh.id;
    }
    if (!room.spectators.some((x) => x.connected) && (humans(room).length === 0 || (room.solo && !humans(room).some((x) => x.connected)))) {
      // 사람이 아무도 없으면 방 정리 (AI끼리 계속 돌지 않게)
      if (room.timer) { clearTimeout(room.timer); room.timer = null; }
      rooms.delete(room.code);
      pushRoomList();
    } else { if (room.status !== 'playing') promoteWaiting(room); broadcast(room); }
    ok(cb);
  });
  // ---------- 계정 (닉네임 + PIN) ----------
  const bindAcct = (a) => {
    if (socket.data.acct && socket.data.acct !== a.key) socket.leave('acct:' + socket.data.acct);
    socket.data.acct = a.key; socket.join('acct:' + a.key);
  };
  const pinTries = { n: 0, t: 0 };
  socket.on('enter', async (d, cb) => {
    try {
      d = d || {};
      const now = Date.now();
      if (now - pinTries.t > 60000) { pinTries.n = 0; pinTries.t = now; }
      if (++pinTries.n > 12) throw new Error('잠시 후 다시 시도하세요');
      const r = await accounts.enter(d.nickname, d.pin);
      bindAcct({ key: r.key });
      ok(cb, { token: r.token, account: r.account, created: r.created });
    } catch (e) { fail(cb, e.message, e.code); }
  });
  // PIN 설정/변경: 로그인한 기기에서만 (다른 기기에서도 이 이름을 쓰려면)
  socket.on('setPin', async (d, cb) => {
    try {
      d = d || {};
      if (!socket.data.acct) throw new Error('먼저 입장하세요');
      const now = Date.now();
      if (now - pinTries.t > 60000) { pinTries.n = 0; pinTries.t = now; }
      if (++pinTries.n > 12) throw new Error('잠시 후 다시 시도하세요');
      const acct = await accounts.setPin(socket.data.acct, d.pin, d.currentPin);
      io.to('acct:' + socket.data.acct).emit('me', acct);
      ok(cb, { account: acct });
    } catch (e) { fail(cb, e.message, e.code); }
  });
  // 이름 바꾸기: 로그인한 본인만 (기기 토큰/PIN으로 인증된 소켓). PIN 있는 계정은 지금 PIN 확인
  socket.on('rename', async (d, cb) => {
    try {
      d = d || {};
      if (!socket.data.acct) throw new Error('먼저 입장하세요');
      const now = Date.now();
      if (now - pinTries.t > 60000) { pinTries.n = 0; pinTries.t = now; }
      if (++pinTries.n > 12) throw new Error('잠시 후 다시 시도하세요');
      const r = await accounts.rename(socket.data.acct, d.nickname, d.currentPin);
      applyRename(r);
      ok(cb, { account: r.account });
    } catch (e) { fail(cb, e.message, e.code); }
  });
  // 계정 삭제: 본인만. 지금 이름 입력 확인 + PIN 있는 계정은 지금 PIN. 진행 중인 판에 앉아 있으면 거부
  socket.on('deleteAccount', async (d, cb) => {
    try {
      d = d || {};
      const key = socket.data.acct;
      if (!key) throw new Error('먼저 입장하세요');
      const now = Date.now();
      if (now - pinTries.t > 60000) { pinTries.n = 0; pinTries.t = now; }
      if (++pinTries.n > 12) throw new Error('잠시 후 다시 시도하세요');
      for (const room of rooms.values()) {
        if (inRound(room, 'u:' + key)) return fail(cb, `${GAMES[room.game].name} 방(${room.code})에서 판이 진행 중이에요. 판이 끝나고 방에서 나간 뒤 다시 해 주세요`, 'IN_GAME');
      }
      const r = await accounts.remove(key, d.confirmName, d.currentPin);
      console.log(`[account] 본인 삭제: ${r.nickname}`);
      dropAccountEverywhere(key, '다른 기기에서 이 계정을 삭제했어요', socket);
      ok(cb);
    } catch (e) { fail(cb, e.message, e.code); }
  });
  // 초대 링크용 방 정보 (공개 정보만: 게임 종류·방장 이름·상태)
  socket.on('roomInfo', (d, cb) => {
    const room = rooms.get(String((d && d.code) || '').toUpperCase().trim());
    if (!room) return fail(cb, '방을 찾을 수 없어요. 방이 끝났을 수 있어요', 'NO_ROOM');
    ok(cb, { room: roomListItem(room) });
  });
  socket.on('auth', async (d, cb) => {
    try {
      const a = await accounts.byToken(d && d.token);
      if (!a) throw new Error('다시 입장해 주세요');
      bindAcct(a);
      ok(cb, { account: accounts.pub(a) });
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('logout', async (d, cb) => {
    try { if (d && d.token) await accounts.logout(d.token); } catch (e) {}
    if (socket.data.acct) socket.leave('acct:' + socket.data.acct);
    socket.data.acct = null;
    ok(cb);
  });
  socket.on('ranking', async (d, cb) => { try { ok(cb, { list: await accounts.top(10) }); } catch (e) { fail(cb, e.message); } });
  socket.on('watchRooms', (d, cb) => { socket.join('lobby-watch'); socket.emit('rooms', roomList()); ok(cb); });
  socket.on('unwatchRooms', () => socket.leave('lobby-watch'));
  socket.on('setPrivate', (d, cb) => {
    try {
      if (!cur) throw new Error('방에 없습니다');
      const { room, player } = cur;
      if (room.hostId !== player.id) throw new Error('방장만 가능합니다');
      room.private = !!(d && d.private);
      ok(cb); broadcast(room); pushRoomList(true);
    } catch (e) { fail(cb, e.message); }
  });
  socket.on('disconnect', () => detach());
});

// 오래된 방 정리 (6시간 무활동)
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const idle = now - r.lastActive;
    const nobody = !hasHumanOnline(r);
    if (nobody && (idle > 6 * 3600 * 1000 || (r.solo && idle > 3600 * 1000))) { if (r.timer) clearTimeout(r.timer); rooms.delete(code); pushRoomList(); }
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`화투 게임 서버: http://localhost:${PORT}`));
  // Docker 정지/재시작(SIGTERM) 때 바로 깔끔하게 종료
  const bye = (sig) => { console.log(`${sig} 받음 → 서버 종료`); io.close(); setTimeout(() => process.exit(0), 800).unref(); };
  process.once('SIGTERM', () => bye('SIGTERM'));
  process.once('SIGINT', () => bye('SIGINT'));
}
const admin = require('./lib/admin').mountAdmin(app, { accounts, rooms, io, GAMES, broadcast, pushRanking, applyRename, dropAccountEverywhere, closeRoom, inRound });

module.exports = { server, io, rooms, PORT, roomList, accounts, STAKES, settlePlayer, roundOutcomes, admin };
