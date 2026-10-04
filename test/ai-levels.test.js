// AI 난이도 4단계: 방 설정 연결(소켓) + 공정성(숨은 정보 미사용) + 모든 레벨이 합법 수로 끝까지
process.env.AI_DELAY_SCALE = '0.01';
const test = require('node:test');
const assert = require('node:assert');
const { io: ioc } = require('socket.io-client');
const { GoStopGame } = require('../lib/gostop');
const { SeotdaGame } = require('../lib/seotda');
const AI = require('../lib/ai');
const S = require('../lib/ai-sim');
const { server, io, rooms, roomList } = require('../server');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => { for (const r of rooms.values()) if (r.timer) clearTimeout(r.timer); io.close(); });
function client(pid, name) {
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  const c = { s, st: null, waiters: [] };
  s.on('state', (st) => { c.st = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  c.emit = (ev, d) => new Promise((res) => s.emit(ev, Object.assign({ pid, name }, d || {}), res));
  c.until = (pred, ms = 8000) => new Promise((res, rej) => {
    if (c.st && pred(c.st)) return res(c.st);
    const t = setTimeout(() => rej(new Error('timeout ' + name)), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); res(st); return true; } return false; });
  });
  return c;
}
const LV = ['easy', 'normal', 'hard', 'expert'];
const P2 = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const P3 = [...P2, { id: 'c', name: 'C' }];

test('난이도 4단계 이름', () => {
  assert.deepStrictEqual(AI.LEVELS, { easy: '쉬움', normal: '보통', hard: '고수', expert: '초고수' });
  assert.strictEqual(AI.normLevel('xx'), 'normal');
  assert.strictEqual(AI.normLevel('expert'), 'expert');
});

test('방 설정: AI와 바로 하기 난이도 → 방·AI 자리·공개 목록에 표시, 방장만 판 사이에 바꿈(모든 AI 함께)', async () => {
  const H = client('lv-host', '난이도방장'); const G = client('lv-guest', '난이도손님');
  // 친구 방(기본 보통) → 대기실에서 AI 추가
  const cr = await H.emit('createRoom', { game: 'gostop' });
  let st = await H.until((s) => s.room && s.room.code === cr.code);
  assert.strictEqual(st.room.aiLevel, 'normal');
  assert.strictEqual(st.room.aiLevelName, '보통');
  await H.emit('addAI', { level: 'easy' }); // 옛 클라이언트의 레벨 인자는 무시 → 방 설정을 따름
  st = await H.until((s) => s.room.players.some((p) => p.ai));
  assert.strictEqual(st.room.players.find((p) => p.ai).level, 'normal');
  // 방장: 고수로 → 앉아 있는 AI 모두 고수, 이후 추가하는 AI도 고수
  const r1 = await H.emit('setAiLevel', { level: 'hard' });
  assert.ok(r1.ok);
  await H.emit('addAI');
  st = await H.until((s) => s.room.aiLevel === 'hard' && s.room.players.filter((p) => p.ai).length === 2);
  assert.ok(st.room.players.filter((p) => p.ai).every((p) => p.level === 'hard'));
  // 손님은 못 바꿈
  await G.emit('joinRoom', { code: cr.code });
  await G.until((s) => s.room && s.room.code === cr.code);
  const r2 = await G.emit('setAiLevel', { level: 'easy' });
  assert.ok(!r2.ok);
  // 잘못된 값
  assert.ok(!(await H.emit('setAiLevel', { level: 'god' })).ok);
  // 공개 방 목록에 난이도
  const item = roomList().find((x) => x.code === cr.code);
  assert.ok(item);
  if (item.ai) assert.strictEqual(item.aiLevelName, '고수');
  [H, G].forEach((c) => c.s.close());

  // AI와 바로 하기: 초고수로 시작 → 판 중에는 못 바꿈
  const S1 = client('lv-solo', '초고수연습');
  const cr2 = await S1.emit('createRoom', { game: 'matgo', ai: true, level: 'expert' });
  st = await S1.until((s) => s.room && s.room.code === cr2.code && s.room.status === 'playing');
  assert.strictEqual(st.room.aiLevel, 'expert');
  assert.ok(st.room.players.filter((p) => p.ai).every((p) => p.level === 'expert'));
  const item2 = roomList().find((x) => x.code === cr2.code);
  assert.strictEqual(item2 && item2.aiLevel, 'expert');
  const r3 = await S1.emit('setAiLevel', { level: 'easy' });
  assert.ok(!r3.ok, '판 중에는 거절');
  assert.match(r3.error, /판이 끝난 뒤/);
  S1.s.close();
});

// ---- 공정성: 공개 정보가 같고 숨은 정보(상대 손패·덱 순서)만 다른 두 판 → view가 같고, 같은 난수면 모든 레벨이 같은 결정 ----
function seeded(seed) { return S.mulberry32(seed); }
function hiddenShuffleGostop(g, me, seed) {
  // 상대 손패 + 덱을 한데 모아 섞은 뒤 같은 장수로 다시 나눔 (공개 정보는 그대로)
  const r = seeded(seed);
  const pool = [];
  g.players.forEach((p, k) => { if (k !== me) pool.push(...p.hand); });
  pool.push(...g.deck);
  S.shuffleInPlace(pool, r);
  g.players.forEach((p, k) => { if (k !== me) p.hand = pool.splice(0, p.hand.length); });
  g.deck = pool;
}
test('공정성(맞고/고스톱): 숨은 카드가 달라도 view가 같으면 모든 레벨의 결정이 같음', () => {
  for (const [n, ps] of [[2, P2], [3, P3]]) {
    for (let t = 0; t < 6; t++) {
      const g = new GoStopGame(ps, { bonus: true, perPoint: 10, first: 0 });
      // 몇 수 진행 (보통 AI)
      for (let k = 0; k < 2 * t && !g.over; k++) { const pid = g.players[g.turn].id; g.act(pid, AI.decide(g.view(pid), { level: 'normal', rand: seeded(k) })); }
      if (g.over || g.phase !== 'play') continue;
      const me = g.turn, pid = g.players[me].id;
      const v1 = JSON.parse(JSON.stringify(g.view(pid)));
      const real = JSON.stringify({ hands: g.players.map((p) => p.hand), deck: g.deck });
      hiddenShuffleGostop(g, me, 100 + t);
      assert.notStrictEqual(JSON.stringify({ hands: g.players.map((p) => p.hand), deck: g.deck }), real, '숨은 정보가 실제로 바뀜');
      const v2 = JSON.parse(JSON.stringify(g.view(pid)));
      assert.deepStrictEqual(v2, v1, 'view에는 숨은 정보가 없음');
      for (const lv of LV) {
        const a1 = AI.decide(v1, { level: lv, rand: seeded(7), maxMs: 1e9, budget: 120 });
        const a2 = AI.decide(v2, { level: lv, rand: seeded(7), maxMs: 1e9, budget: 120 });
        assert.deepStrictEqual(a2, a1, `${n}인 ${lv}`);
      }
    }
  }
});

test('공정성: AI는 view만 받고, 상대 손패는 null · 덱은 장수만 (view를 얼려도 결정 가능 = 고치지 않음)', () => {
  const g = new GoStopGame(P2, { bonus: true, perPoint: 10, first: 0 });
  const v = g.view('a');
  assert.strictEqual(v.players[1].hand, null);
  assert.strictEqual(v.deck, undefined);
  assert.strictEqual(typeof v.deckCount, 'number');
  const freeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } return o; };
  const fv = freeze(JSON.parse(JSON.stringify(v)));
  for (const lv of LV) assert.ok(AI.decide(fv, { level: lv, rand: seeded(3), budget: 60 }));
  const sg = new SeotdaGame(P3, { ante: 100 });
  const sv = sg.view(sg.seats[sg.turn].id);
  assert.ok(sv.seats.filter((s, i) => i !== sv.mySeat).every((s) => s.cards.every((c) => c === null)));
  const fsv = freeze(JSON.parse(JSON.stringify(sv)));
  for (const lv of LV) assert.ok(AI.decide(fsv, { level: lv, rand: seeded(3), memory: {} }));
});

test('공정성(섯다): 상대 패가 달라도 view가 같으면 모든 레벨의 결정이 같음 · 기억은 공개된 쇼다운 패만', () => {
  for (let t = 0; t < 20; t++) {
    const g = new SeotdaGame(t % 2 ? P2 : P3, { ante: 100, dealer: t });
    const me = g.turn, pid = g.seats[me].id;
    const v1 = JSON.parse(JSON.stringify(g.view(pid)));
    // 상대 패를 안 쓰인 카드로 바꿈
    const used = new Set(g.seats.flatMap((s) => s.cards));
    const spare = Array.from({ length: 20 }, (_, i) => i).filter((i) => !used.has(i));
    g.seats.forEach((s, i) => { if (i !== me) s.cards = [spare.pop(), spare.pop()]; });
    const v2 = JSON.parse(JSON.stringify(g.view(pid)));
    assert.deepStrictEqual(v2, v1);
    for (const lv of LV) {
      const mem = { opp: {} };
      assert.deepStrictEqual(AI.decide(v2, { level: lv, rand: seeded(t), memory: JSON.parse(JSON.stringify(mem)) }), AI.decide(v1, { level: lv, rand: seeded(t), memory: JSON.parse(JSON.stringify(mem)) }), lv);
    }
  }
  // 판이 끝난 뒤: 다이한 사람의 패(화면 데이터에 있어도)는 기억에 쓰지 않음
  const g = new SeotdaGame(P3, { ante: 100, dealer: 0 });
  const order = [g.turn];
  g.act(g.seats[g.turn].id, { type: 'half' });
  const folder = g.turn; g.act(g.seats[folder].id, { type: 'die' });
  while (!g.over) { const i = g.turn; g.act(g.seats[i].id, { type: g.options(i).some((o) => o.type === 'call') ? 'call' : 'check' }); }
  const watcher = [0, 1, 2].find((i) => i !== folder);
  const va = JSON.parse(JSON.stringify(g.view(g.seats[watcher].id)));
  const vb = JSON.parse(JSON.stringify(va));
  const used = new Set(g.seats.flatMap((s) => s.cards));
  const spare = Array.from({ length: 20 }, (_, i) => i).filter((i) => !used.has(i));
  vb.seats[folder].cards = [spare[0], spare[1]];
  const ma = {}, mb = {};
  AI.observe(va, { level: 'expert', memory: ma });
  AI.observe(vb, { level: 'expert', memory: mb });
  assert.deepStrictEqual(mb, ma);
  assert.ok(ma.opp && Object.keys(ma.opp).length === 2, '상대 2명 기억');
  void order;
});

test('모든 레벨이 합법 수로 끝까지 (맞고·고스톱 혼합, 섯다 혼합)', () => {
  for (let k = 0; k < 8; k++) {
    const n = 2 + (k % 2);
    const lv = Array.from({ length: n }, (_, i) => LV[(k + i) % 4]);
    const ps = lv.map((l, i) => ({ id: 'p' + i, name: l }));
    const g = new GoStopGame(ps, { bonus: k % 3 !== 0, perPoint: 10, first: k % n });
    let steps = 0;
    while (!g.over) {
      assert.ok(++steps < 400, 'stuck');
      const i = g.turn;
      const a = AI.decide(g.view(ps[i].id), { level: lv[i], budget: 80 });
      g.act(ps[i].id, a); // 불법이면 예외 → 실패
    }
  }
  const mems = LV.map(() => ({}));
  for (let k = 0; k < 60; k++) {
    const ps = LV.map((l, i) => ({ id: 'p' + i, name: l }));
    const g = new SeotdaGame(ps, { ante: 100, dealer: k });
    while (!g.over) { const i = g.turn; g.act(ps[i].id, AI.decide(g.view(ps[i].id), { level: LV[i], memory: mems[i] })); }
    ps.forEach((p, i) => AI.observe(g.view(p.id), { level: LV[i], memory: mems[i] }));
  }
  assert.ok(mems[3].opp && Object.keys(mems[3].opp).length === 3, '초고수는 상대 3명 성향을 기억');
});

test('초고수 생각 시간: 한 수 300ms 안 (시간 상한 + 예산)', () => {
  const g = new GoStopGame(P2, { bonus: true, perPoint: 10, first: 0 });
  let max = 0;
  for (let k = 0; k < 14 && !g.over; k++) {
    const pid = g.players[g.turn].id;
    const t = Date.now();
    const a = AI.decide(g.view(pid), { level: 'expert' });
    max = Math.max(max, Date.now() - t);
    g.act(pid, a);
  }
  assert.ok(max < 300, `최대 ${max}ms`);
});
