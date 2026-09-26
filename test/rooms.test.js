// 공개 방 목록 · 관전 · AI 자리 넘겨받기 (소켓 통합 테스트)
process.env.AI_DELAY_SCALE = '0.01';
const test = require('node:test');
const assert = require('node:assert');
const { io: ioc } = require('socket.io-client');
const { server, io, rooms, roomList } = require('../server');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => { for (const r of rooms.values()) if (r.timer) clearTimeout(r.timer); io.close(); });

function client(pid, name) {
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  const c = { s, pid, name, st: null, rooms: null, waiters: [] };
  s.on('state', (st) => { c.st = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  s.on('rooms', (l) => { c.rooms = l; });
  c.emit = (ev, d) => new Promise((res) => s.emit(ev, Object.assign({ pid, name }, d || {}), res));
  c.until = (pred, ms = 8000) => new Promise((res, rej) => {
    if (c.st && pred(c.st)) return res(c.st);
    const t = setTimeout(() => rej(new Error('timeout ' + name)), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); res(st); return true; } return false; });
  });
  return c;
}
// 사람 플레이어 자동 진행 (맞고/고스톱): 첫 패 내기, 고/스톱은 스톱
function autoPlay(c) {
  const step = (st) => {
    const o = st.game && st.game.options;
    if (!o || st.game.result) return;
    if (o.phase === 'play') { const k = o.cards[0]; c.s.emit('action', k ? { type: 'play', card: k.id, floorCard: k.matches ? k.matches[0] : undefined } : { type: 'flipOnly' }, () => {}); }
    else if (o.phase === 'goStop') c.s.emit('action', { type: 'stop' }, () => {});
    else if (o.phase === 'chooseFlip') c.s.emit('action', { type: 'chooseFlip', floorCard: o.choices[0] }, () => {});
  };
  c.s.on('state', step);
  if (c.st) step(c.st);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('AI 방 공개 목록 → 관전 → 판 끝나면 AI 자리 넘겨받기 → 다음 판 참여, 꽉 차면 관전만, 비공개', async () => {
  const A = client('pa', '민수'), B = client('pb', '영희'), C = client('pc', '철수');
  const r = await A.emit('createRoom', { game: 'matgo', perPoint: 10, ai: true, level: 'easy' });
  assert.ok(r.ok);
  const code = r.code;
  await B.emit('watchRooms');
  await sleep(100);
  let item = B.rooms.find((x) => x.code === code);
  assert.ok(item, '공개 목록에 AI 방이 보여야 함');
  assert.strictEqual(item.host, '민수'); assert.strictEqual(item.ai, 1); assert.strictEqual(item.humans, 1);
  assert.strictEqual(item.status, 'playing'); assert.strictEqual(item.join, 'next');

  // 진행 중 → 관전자로 입장 (다음 판부터 참여)
  const jb = await B.emit('joinRoom', { code });
  assert.ok(jb.ok);
  const sb = await B.until((st) => st.spectator);
  assert.strictEqual(sb.spectator.waiting, true);
  assert.strictEqual(sb.game.mySeat, -1);
  assert.ok(sb.game.players.every((p) => p.hand === null), '관전자는 손패를 볼 수 없음');
  assert.ok(sb.game.deal === null || sb.game.deal.every((d) => d.to !== 'hand' || d.card === null), '돌리는 패도 가려짐');
  const bad = await B.emit('action', { type: 'flipOnly' });
  assert.strictEqual(bad.ok, false, '관전자는 행동 불가');
  const room = rooms.get(code);
  assert.strictEqual(room.players.length, 2);
  assert.ok(room.players.some((p) => p.ai));

  // 판이 끝나면 AI 자리를 넘겨받음
  autoPlay(A);
  const sr = await B.until((st) => !st.spectator && st.room.status === 'result', 30000);
  assert.ok(sr.room.players.some((p) => p.id === 'pb' && !p.ai));
  assert.ok(!room.players.some((p) => p.ai), 'AI가 빠짐');
  assert.strictEqual(room.hostId, 'pa', '방장은 그대로');
  await A.emit('start');
  const s2 = await B.until((st) => st.room.status === 'playing' && st.game && st.game.mySeat >= 0);
  assert.ok(s2.game.players.some((p) => p.id === 'pb'));

  // 사람으로 꽉 참 → 관전만
  await sleep(100);
  item = B.rooms && roomList().find((x) => x.code === code);
  assert.strictEqual(item.join, 'watch');
  await C.emit('joinRoom', { code });
  const sc = await C.until((st) => st.spectator);
  assert.strictEqual(sc.spectator.waiting, false);
  assert.ok(sc.game.players.every((p) => p.hand === null));
  assert.strictEqual(sc.room.spectators.length, 1);

  // 비공개 전환 → 목록에서 사라짐
  await A.emit('setPrivate', { private: true });
  assert.ok(!roomList().some((x) => x.code === code));
  const bad2 = await B.emit('setPrivate', { private: false });
  assert.strictEqual(bad2.ok, false, '방장만 변경 가능');
  // 관전 나가기
  await C.emit('leave');
  assert.strictEqual(room.spectators.length, 0);
  [A, B, C].forEach((c) => c.s.close());
});

test('대기실(판 사이)에서는 AI 자리를 바로 넘겨받음 · 비공개로 만든 방은 목록에 없음', async () => {
  const H = client('ph', '호스트'), D = client('pd', '길동'), P = client('pp', '비밀');
  const r = await H.emit('createRoom', { game: 'gostop', perPoint: 10 });
  await H.emit('addAI', {}); await H.emit('addAI', {});
  const room = rooms.get(r.code);
  assert.strictEqual(room.players.filter((p) => p.ai).length, 2);
  assert.strictEqual(roomList().find((x) => x.code === r.code).join, 'seat');
  await D.emit('joinRoom', { code: r.code });
  const sd = await D.until((st) => st.room.players.some((p) => p.id === 'pd'));
  assert.ok(!sd.spectator);
  assert.strictEqual(room.players.length, 3);
  assert.strictEqual(room.players.filter((p) => p.ai).length, 1);
  assert.strictEqual(room.hostId, 'ph');
  const rp = await P.emit('createRoom', { game: 'seotda', perPoint: 10, ai: true, aiCount: 2, private: true });
  assert.ok(!roomList().some((x) => x.code === rp.code));
  [H, D, P].forEach((c) => c.s.close());
});

test('맞고 첫 판은 선 고르기로 선을 정하고(서버 결정), 다음 판은 지난 판 승자가 선', async () => {
  const A = client('sa', '선테스트');
  const r = await A.emit('createRoom', { game: 'matgo', perPoint: 10, ai: true, level: 'easy' });
  assert.ok(r.ok);
  const st = await A.until((s) => s.game && s.game.seon);
  const seon = st.game.seon;
  assert.strictEqual(seon.reason, 'draw');
  assert.strictEqual(seon.draws.length, 2);
  assert.strictEqual(st.game.turn, seon.seat, '선 고르기 결과가 실제 첫 차례');
  const room = rooms.get(r.code);
  room.lastWinner = room.players[1].id; // 지난 판 승자 = AI 자리
  room.status = 'result'; room.engine.over = true;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const nx = await A.emit('start');
  assert.ok(nx.ok, JSON.stringify(nx));
  const st2 = await A.until((s) => s.room.round === 2 && s.game && s.game.seon);
  assert.deepStrictEqual(st2.game.seon, { reason: 'winner', seat: 1 });
  assert.strictEqual(st2.game.turn, 1);
  A.s.close();
});
