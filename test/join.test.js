// 관전자 게임 참가 예약 (JOIN_V1) + 자리 전적 (PROFREC_V1)
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hwatu-join-'));
process.env.ACCOUNTS_FILE = path.join(TMP, 'accounts.json');
process.env.AI_DELAY_SCALE = '0.01';
process.env.TURN_MS = '250';
delete process.env.DATABASE_URL;
delete process.env.AUTO_MS;
const test = require('node:test');
const assert = require('node:assert');
const { io: ioc } = require('socket.io-client');
const { server, io, rooms, accounts } = require('../server');
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => { for (const r of rooms.values()) if (r.timer) clearTimeout(r.timer); io.close(); });
function client() {
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  const c = { s, st: null, waiters: [] };
  s.on('state', (st) => { c.st = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  c.emit = (ev, d) => new Promise((res) => s.emit(ev, d || {}, res));
  c.until = (pred, ms = 30000) => new Promise((res, rej) => {
    if (c.st && pred(c.st)) return res(c.st);
    const t = setTimeout(() => rej(new Error('timeout waiting state')), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); res(st); return true; } return false; });
  });
  return c;
}
const seated = (st, id) => st.room.players.some((p) => p.id === id);

test('참가 예약: 판 중 들어온 관전자는 먼저 온 순서대로 판이 끝나면 AI 자리에 앉음, 자리 없으면 예약 유지(순번), 취소/재예약은 맨 뒤로', async () => {
  const H = client(); const X = client(); const Y = client();
  await H.emit('enter', { nickname: '참가방장', pin: '1111' });
  await X.emit('enter', { nickname: '참가엑스', pin: '1111' });
  await Y.emit('enter', { nickname: '참가와이', pin: '1111' });
  const cr = await H.emit('createRoom', { game: 'matgo', ai: true, level: 'easy' }); // 나 + AI 1
  await H.until((s) => s.room.status === 'playing');
  await X.emit('joinRoom', { code: cr.code });
  await Y.emit('joinRoom', { code: cr.code });
  let sx = await X.until((s) => s.spectator);
  let sy = await Y.until((s) => s.spectator && s.spectator.rank === 2);
  assert.strictEqual(sx.spectator.waiting, true, 'AI 자리가 있으면 자동 예약');
  // X 취소 → Y가 1번, X 재예약 → 2번
  let r = await X.emit('setWaiting', { on: false });
  assert.ok(r.ok); assert.strictEqual(r.waiting, false);
  sy = await Y.until((s) => s.spectator && s.spectator.rank === 1);
  r = await X.emit('setWaiting', { on: true });
  assert.strictEqual(r.rank, 2);
  // 판이 끝나면 Y가 AI 자리에, X는 예약 유지 (자리 없음)
  const end = await Y.until((s) => !s.spectator && seated(s, 'u:참가와이'), 60000);
  assert.ok(!end.room.players.some((p) => p.ai), 'AI 자리를 넘겨받음');
  sx = await X.until((s) => s.spectator && s.spectator.waiting && !s.spectator.seatOpen);
  assert.strictEqual(sx.spectator.rank, 1);
  // 자리에 앉은 사람은 예약 불가
  assert.strictEqual((await Y.emit('setWaiting', { on: true })).code, 'SEATED');
  // 사람이 나가서 자리가 나면 (판 사이) 예약자가 자동으로 앉음
  await H.until((s) => s.room.status !== 'playing', 60000);
  await Y.emit('leave');
  const sx2 = await X.until((s) => !s.spectator && seated(s, 'u:참가엑스'), 10000);
  assert.ok(sx2);
  [H, X, Y].forEach((c) => c.s.close());
});

test('사람으로 꽉 찬 방: 관전자는 자동 예약 안 됨 → 참가하기 누르면 예약(자리 나면 자동 참가), 판 사이에 자리가 나면 앉음', async () => {
  const A = client(); const B = client(); const V = client();
  await A.emit('enter', { nickname: '꽉참1', pin: '1111' }); await B.emit('enter', { nickname: '꽉참2', pin: '1111' }); await V.emit('enter', { nickname: '꽉참관전', pin: '1111' });
  const cr = await A.emit('createRoom', { game: 'matgo' });
  await B.emit('joinRoom', { code: cr.code });
  await A.until((s) => s.room.players.length === 2);
  await V.emit('joinRoom', { code: cr.code });
  let sv = await V.until((s) => s.spectator);
  assert.strictEqual(sv.spectator.waiting, false);
  assert.strictEqual(sv.spectator.seatOpen, false);
  const r = await V.emit('setWaiting', { on: true });
  assert.ok(r.ok && r.waiting && !r.seated);
  sv = await V.until((s) => s.spectator && s.spectator.waiting);
  assert.ok(sv.room.spectators.find((x) => x.name === '꽉참관전').waiting, '다른 사람에게도 예약 표시');
  await B.emit('leave'); // 대기실에서 나감 → 자리 남
  await V.until((s) => !s.spectator && seated(s, 'u:꽉참관전'), 10000);
  [A, B, V].forEach((c) => c.s.close());
});

test('자리 전적: 방 상태의 계정 플레이어에 이 게임 전적(g)·전체(t), AI는 없음, 판이 끝나면 갱신', async () => {
  const S = client();
  await S.emit('enter', { nickname: '전적자리', pin: '1111' });
  await S.emit('createRoom', { game: 'seotda', ai: true, level: 'easy' });
  let st = await S.until((s) => s.room.status === 'playing');
  const me = (x) => x.room.players.find((p) => p.id === 'u:전적자리');
  assert.deepStrictEqual(me(st).rec.g, { w: 0, d: 0, l: 0 });
  assert.strictEqual(me(st).rec.t.rate, 0);
  for (const p of st.room.players.filter((x) => x.ai)) assert.strictEqual(p.rec, undefined);
  st = await S.until((s) => s.room.status === 'result', 30000);
  const g = me(st).rec.g;
  assert.strictEqual(g.w + g.d + g.l, 1, '판이 끝나자마자 전적 반영');
  assert.deepStrictEqual(g, accounts.statsOf(accounts.cache.get('전적자리')).seotda);
  S.s.close();
});
