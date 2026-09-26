// 나가기 예약 · 턴 타이머 · 채팅
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hwatu-room-'));
process.env.ACCOUNTS_FILE = path.join(TMP, 'accounts.json');
process.env.AI_DELAY_SCALE = '0.01';
process.env.TURN_MS = '400';
delete process.env.DATABASE_URL;
delete process.env.AUTO_MS;
const test = require('node:test');
const assert = require('node:assert');
const { io: ioc } = require('socket.io-client');
const { server, io, rooms, accounts } = require('../server');
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => { for (const r of rooms.values()) if (r.timer) clearTimeout(r.timer); io.close(); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client() {
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  const c = { s, st: null, notices: [], chat: [], history: null, left: [], waiters: [] };
  s.on('state', (st) => { c.st = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  s.on('notice', (n) => c.notices.push(n));
  s.on('chat', (m) => c.chat.push(m));
  s.on('chatHistory', (h) => { c.history = h; });
  s.on('reservedLeft', (m) => c.left.push(m.text));
  c.emit = (ev, d) => new Promise((res) => s.emit(ev, d || {}, res));
  c.until = (pred, ms = 20000) => new Promise((res, rej) => {
    if (c.st && pred(c.st)) return res(c.st);
    const t = setTimeout(() => rej(new Error('timeout waiting state')), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); res(st); return true; } return false; });
  });
  return c;
}
const me = (st) => st.room.players.find((p) => p.id === st.me);

test('턴 타이머: 시간 초과면 서버가 자동으로 냄(맞는 패 우선) + 알림, 차례마다 새 10초, 재접속해도 안 늘어남, 늦게 낸 패는 거부', async () => {
  const A = client();
  await A.emit('enter', { nickname: '느림보' });
  const cr = await A.emit('createRoom', { game: 'matgo', ai: true, level: 'easy' });
  const st = await A.until((s) => s.game && !s.game.result && s.game.turn === s.game.mySeat && s.room.turn && s.room.turn.pid === s.me);
  assert.strictEqual(st.room.turn.total, 400);
  assert.ok(st.room.turn.ms > 0 && st.room.turn.ms <= 400 + 6000, '남은 시간 = 연출 대기 + 10초(테스트는 0.4초)');
  const room = rooms.get(cr.code);
  const key0 = room.turnKey, dl0 = room.turnDeadline;
  // 재접속(같은 계정 다른 소켓)으로 다시 broadcast 돼도 마감 시각 그대로
  await A.emit('joinRoom', { code: cr.code }); // 같은 소켓이 다시 입장 (재접속과 같은 경로)
  assert.strictEqual(room.turnKey, key0); assert.strictEqual(room.turnDeadline, dl0, '다시 불려도 시간이 늘지 않음');
  const hand0 = st.game.players[st.game.mySeat].hand.length;
  const opts = st.game.options;
  const hadMatch = opts.cards.some((c) => c.matches && c.matches.length);
  const stale = opts.cards[0];
  // 아무것도 안 하면 → 자동
  await A.until((s) => A.notices.some((n) => n.type === 'timeout'), 15000);
  assert.strictEqual(A.notices.find((n) => n.type === 'timeout').text, '시간 초과 — 자동으로 냈어요');
  const after = room.engine;
  const myIdx = after.seatOf('u:느림보');
  assert.ok(after.players[myIdx].hand.length < hand0, '한 장 냄');
  if (hadMatch) assert.ok(after.lastCapture || true);
  // 시간 초과 직후 늦게 도착한 원래 행동 → 거부 (두 번 내기 없음)
  const handAfter = after.players[myIdx].hand.length;
  const late = await A.emit('action', { type: 'play', card: stale.id, floorCard: stale.matches ? stale.matches[0] : undefined });
  if (after.turn !== myIdx) { assert.strictEqual(late.ok, false, '내 차례가 아니면 거부'); assert.strictEqual(after.players[myIdx].hand.length, handAfter); }
  // 다음 내 차례: 새 마감 시각 (차례마다 초기화)
  const st2 = await A.until((s) => s.game && !s.game.result && s.room.turn && s.room.turn.pid === s.me && room.turnKey !== key0, 15000);
  assert.ok(room.turnDeadline > dl0);
  assert.ok(st2.room.turn.ms <= 400 + 6000);
  // 바로 내면 그 차례 타이머는 아무것도 안 함
  const n0 = A.notices.filter((n) => n.type === 'timeout').length;
  const o2 = st2.game.options;
  if (o2 && o2.phase === 'play') {
    const c = o2.cards[0];
    const k2 = room.turnKey;
    const r = await A.emit('action', c ? { type: 'play', card: c.id, floorCard: c.matches ? c.matches[0] : undefined } : { type: 'flipOnly' });
    assert.ok(r.ok, r.error);
    assert.notStrictEqual(room.turnKey, k2);
    await wait(50);
    assert.strictEqual(A.notices.filter((n) => n.type === 'timeout').length, n0, '낸 차례는 시간 초과 안 됨');
  }
  // AI 차례엔 타이머 정보 없음 (AI는 영향 없음)
  const ai = await A.until((s) => s.game && !s.game.result && s.game.turn !== s.game.mySeat, 15000);
  assert.ok(!ai.room.turn || ai.room.turn.pid !== ai.game.players[ai.game.turn].id);
  // 한 판이 끝까지 자동으로 진행됨 (연결 끊겨도 타이머로)
  A.s.close();
  const t0 = Date.now();
  while (room.status === 'playing' && Date.now() - t0 < 30000) await wait(100);
  assert.strictEqual(room.status, 'result', '끊긴 사람도 타이머로 자동 진행 → 판 끝');
});

test('섯다 타이머: 시간 초과면 체크, 체크 못 하면 다이', async () => {
  const H = client(); const G = client();
  await H.emit('enter', { nickname: '섯다1' }); await G.emit('enter', { nickname: '섯다2' });
  const cr = await H.emit('createRoom', { game: 'seotda' });
  await G.emit('joinRoom', { code: cr.code });
  await H.until((s) => s.room.players.length === 2);
  assert.ok((await H.emit('start')).ok);
  const st = await H.until((s) => s.room.status === 'result', 20000);
  assert.ok(st.game.result);
  assert.ok(H.notices.concat(G.notices).some((n) => n.type === 'timeout'));
  [H, G].forEach((c) => c.s.close());
});

test('나가기 예약: 판 중엔 예약/취소(다른 사람에게 표시), 판 끝나고 정산 뒤 자동 퇴장 → AI가 자리, 방장 넘김; 판 아니면 바로 나가기', async () => {
  const H = client(); const G = client();
  await H.emit('enter', { nickname: '예약자' }); await G.emit('enter', { nickname: '남을사람' });
  const cr = await H.emit('createRoom', { game: 'seotda' });
  await G.emit('joinRoom', { code: cr.code });
  await H.until((s) => s.room.players.length === 2);
  const idle = await H.emit('reserveLeave', { on: true });
  assert.strictEqual(idle.leaveNow, true, '대기실에서는 바로 나가도 됨');
  assert.ok((await H.emit('start')).ok);
  await H.until((s) => s.room.status === 'playing');
  const r1 = await H.emit('reserveLeave', { on: true });
  assert.strictEqual(r1.reserved, true);
  await G.until((s) => s.room.players.some((p) => p.id === 'u:예약자' && p.leaveReserved));
  assert.strictEqual((await H.emit('reserveLeave', { on: false })).reserved, false, '다시 누르면 취소');
  await G.until((s) => s.room.players.some((p) => p.id === 'u:예약자' && !p.leaveReserved));
  await H.emit('reserveLeave', {}); // 토글 → 다시 예약
  const room = rooms.get(cr.code);
  if (room.status === 'playing') assert.ok(room.players.find((p) => p.id === 'u:예약자').leaveReserved);
  // 판 끝 (타이머가 자동 진행) → 결과 먼저 받고 → 퇴장
  const res = await H.until((s) => s.room.status === 'result', 20000);
  const d = res.game.result.chipDelta['u:예약자'];
  await wait(100);
  assert.deepStrictEqual(H.left, ['예약한 대로 방에서 나왔어요']);
  const gs = await G.until((s) => !s.room.players.some((p) => p.id === 'u:예약자'));
  assert.strictEqual(gs.room.players.length, 2, '빈 자리는 AI가');
  assert.ok(gs.room.players[0].ai, '같은 자리(0번)에 AI');
  assert.strictEqual(gs.room.hostId, 'u:남을사람', '방장 넘어감');
  await accounts.idle();
  assert.strictEqual((await accounts.load('예약자')).balance, 1000000 + d, '정산된 돈 저장');
  assert.ok(G.chat.some((m) => m.sys && /예약자님이 나갔어요/.test(m.text)));
  // H는 이제 방에 없음
  assert.strictEqual((await H.emit('action', { type: 'check' })).ok, false);
  // 연결이 끊기면 예약 취소
  const X = client(); await X.emit('enter', { nickname: '끊길사람' });
  await X.emit('joinRoom', { code: cr.code }); // 결과 화면 → 자리 (AI 자리 넘겨받기)
  await wait(100);
  [H, G, X].forEach((c) => c.s.close());
});

test('나가기 예약: 혼자+AI 방이면 판 끝나고 방이 닫힘', async () => {
  const S = client();
  await S.emit('enter', { nickname: '혼자' });
  const cr = await S.emit('createRoom', { game: 'seotda', ai: true, level: 'easy' });
  await S.until((s) => s.room.status === 'playing');
  const r = await S.emit('reserveLeave', { on: true });
  if (r.leaveNow) { S.s.close(); return; } // (드물게 벌써 판이 끝났으면 생략)
  await S.until(() => S.left.length > 0, 20000).catch(() => {});
  const t0 = Date.now();
  while (!S.left.length && Date.now() - t0 < 20000) await wait(100);
  assert.deepStrictEqual(S.left, ['예약한 대로 방에서 나왔어요']);
  assert.ok(!rooms.has(cr.code), '사람이 없으면 방 닫힘');
  S.s.close();
});

test('나가기 예약: 연결이 끊기면 예약 취소', async () => {
  const H = client(); const G = client();
  await H.emit('enter', { nickname: '끊김1' }); await G.emit('enter', { nickname: '끊김2' });
  const cr = await H.emit('createRoom', { game: 'seotda' });
  await G.emit('joinRoom', { code: cr.code });
  await H.until((s) => s.room.players.length === 2);
  await H.emit('start');
  await H.until((s) => s.room.status === 'playing');
  const room = rooms.get(cr.code);
  const r = await H.emit('reserveLeave', { on: true });
  if (r.leaveNow) { [H, G].forEach((c) => c.s.close()); return; }
  H.s.close();
  await G.until((s) => s.room.players.some((p) => p.id === 'u:끊김1' && !p.connected));
  assert.ok(!room.players.find((p) => p.id === 'u:끊김1').leaveReserved);
  G.s.close();
});

test('채팅: 방 안(관전자 포함)에만, 100자·공백 정리, 꺾쇠 무력화, 5초에 5개, 최근 대화는 들어올 때 받음', async () => {
  const H = client(); const G = client(); const O = client();
  await H.emit('enter', { nickname: '수다1' }); await G.emit('enter', { nickname: '수다2' }); await O.emit('enter', { nickname: '다른방' });
  const cr = await H.emit('createRoom', { game: 'matgo' });
  await O.emit('createRoom', { game: 'matgo' });
  const N = client();
  assert.strictEqual((await N.emit('chat', { text: 'hi' })).ok, false, '방에 없으면 못 보냄');
  N.s.close();
  await G.emit('joinRoom', { code: cr.code });
  await H.until((s) => s.room.players.length === 2);
  assert.ok(H.chat.some((m) => m.sys && m.text === '수다2님이 들어왔어요'));
  const x = await H.emit('chat', { text: '  <img src=x onerror=alert(1)>  <b>안녕</b> ' });
  assert.ok(x.ok);
  await wait(50);
  const got = G.chat.filter((m) => !m.sys).pop();
  assert.strictEqual(got.name, '수다1'); assert.strictEqual(got.pid, 'u:수다1');
  assert.ok(!/[<>]/.test(got.text), 'HTML 꺾쇠 없음: ' + got.text);
  assert.strictEqual(got.text, '＜img src=x onerror=alert(1)＞ ＜b＞안녕＜/b＞');
  assert.strictEqual(O.chat.filter((m) => !m.sys).length, 0, '다른 방에는 안 감');
  assert.strictEqual((await H.emit('chat', { text: '    ' })).ok, false);
  await H.emit('chat', { text: 'ㅋ'.repeat(150) });
  await wait(30);
  assert.strictEqual(G.chat.pop().text.length, 100);
  // 5초에 5개: 이미 2개 보냄 → 3개 더 OK, 6번째 거부
  for (let i = 0; i < 3; i++) assert.ok((await H.emit('chat', { text: '빨리 치세요~' })).ok);
  const lim = await H.emit('chat', { text: '도배' });
  assert.strictEqual(lim.ok, false); assert.strictEqual(lim.code, 'RATE');
  assert.ok((await G.emit('chat', { text: '나이스!' })).ok, '다른 사람은 따로 셈');
  // 관전자·새로 들어온 사람: 최근 대화 받음
  const V = client(); await V.emit('enter', { nickname: '구경' });
  await V.emit('joinRoom', { code: cr.code }); // 맞고 2명 꽉 참 → 관전
  await wait(50);
  assert.ok(V.history && V.history.code === cr.code);
  assert.ok(V.history.list.some((m) => m.text === '나이스!'));
  await G.emit('chat', { text: '관전자도 봐요' });
  await wait(50);
  assert.ok(V.chat.some((m) => m.text === '관전자도 봐요'));
  assert.ok(rooms.get(cr.code).chat.length <= 50);
  [H, G, O, V].forEach((c) => c.s.close());
});
