const test = require('node:test');
const assert = require('node:assert');
const { GoStopGame, scoreCaptured } = require('../lib/gostop');
const { SeotdaGame } = require('../lib/seotda');
const { HWATU } = require('../shared/cards');
const id = (m, i) => (m - 1) * 4 + i; // i: 0 광/열끗, 1 띠/열끗, 2·3 피 (11월 1=쌍피, 12월 3=쌍피)
const P2 = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const P3 = [...P2, { id: 'c', name: 'C' }];

function rig(n, hands, floor, flips) {
  const used = new Set([...hands.flat(), ...floor, ...flips]);
  const months = new Set([...used].map((c) => HWATU[c].m));
  const all = HWATU.filter((c) => !c.bonus && !used.has(c.id));
  const rest = [...all.filter((c) => !months.has(c.m)), ...all.filter((c) => months.has(c.m))].map((c) => c.id);
  const hs = n === 2 ? 10 : 7, fs = n === 2 ? 8 : 6;
  while (hands.length < n) hands = [...hands, []];
  const H = hands.map((h) => { const x = h.slice(); while (x.length < hs) x.push(rest.shift()); return x; });
  const F = floor.slice(); while (F.length < fs) F.push(rest.shift());
  const order = [...H.flat(), ...F, ...flips, ...rest.reverse()];
  return new GoStopGame(n === 2 ? P2 : P3, { deck: order.reverse(), bonus: false, perPoint: 10 });
}
// 테스트용: 바닥/덱을 직접 세팅
function setup(g, { hand0, floor, deck, cap1 }) {
  if (hand0) g.players[0].hand = hand0;
  if (floor) g.floor = floor;
  if (deck) g.deck = deck.slice().reverse();
  if (cap1) g.players[1].captured = cap1;
}

test('점수: 광', () => {
  assert.equal(scoreCaptured([id(1, 0), id(3, 0), id(8, 0)]).total, 3);
  assert.equal(scoreCaptured([id(1, 0), id(3, 0), id(12, 0)]).total, 2);
  assert.equal(scoreCaptured([id(1, 0), id(3, 0), id(8, 0), id(12, 0)]).total, 4);
  assert.equal(scoreCaptured([id(1, 0), id(3, 0), id(8, 0), id(11, 0), id(12, 0)]).total, 15);
  assert.equal(scoreCaptured([id(1, 0), id(3, 0)]).total, 0);
});
test('점수: 고도리, 열끗', () => {
  assert.equal(scoreCaptured([id(2, 0), id(4, 0), id(8, 1)]).total, 5);
  assert.equal(scoreCaptured([id(2, 0), id(4, 0), id(8, 1), id(5, 0), id(6, 0)]).total, 6); // 고도리5 + 열끗5장 1
  assert.equal(scoreCaptured([id(5, 0), id(6, 0), id(7, 0), id(9, 0), id(10, 0), id(12, 1)]).total, 2);
});
test('점수: 단, 띠', () => {
  assert.equal(scoreCaptured([id(1, 1), id(2, 1), id(3, 1)]).total, 3);
  assert.equal(scoreCaptured([id(6, 1), id(9, 1), id(10, 1)]).total, 3);
  assert.equal(scoreCaptured([id(4, 1), id(5, 1), id(7, 1)]).total, 3);
  assert.equal(scoreCaptured([id(1, 1), id(2, 1), id(3, 1), id(4, 1), id(12, 2)]).total, 4); // 홍단3 + 띠5장1
  assert.equal(scoreCaptured([id(1, 1), id(2, 1), id(4, 1), id(6, 1)]).total, 0);
});
test('점수: 피 (쌍피 2장 계산)', () => {
  const pis = [id(1, 2), id(1, 3), id(2, 2), id(2, 3), id(3, 2), id(3, 3), id(4, 2), id(4, 3), id(5, 2)];
  assert.equal(scoreCaptured(pis).total, 0);
  assert.equal(scoreCaptured([...pis, id(5, 3)]).total, 1);
  assert.equal(scoreCaptured([...pis, id(11, 1)]).total, 2);
  assert.equal(scoreCaptured([...pis, id(11, 1), 48]).total, 4);
  assert.equal(scoreCaptured([...pis, id(11, 1)]).piValue, 11);
});
test('기본: 같은 달 먹기 + 뒤집기 먹기', () => {
  const g = rig(2, [[id(1, 2)]], [id(1, 0), id(2, 2)], [id(2, 3)]);
  g.act('a', { type: 'play', card: id(1, 2) });
  assert.deepEqual(g.players[0].captured.sort((x, y) => x - y), [id(1, 0), id(1, 2), id(2, 2), id(2, 3)].sort((x, y) => x - y));
  assert.equal(g.turn, 1);
});
test('뻑', () => {
  const g = rig(2, [[id(1, 2)]], [id(1, 0)], [id(1, 3)]);
  g.act('a', { type: 'play', card: id(1, 2) });
  assert.equal(g.players[0].ppeok, 1);
  assert.equal(g.players[0].captured.length, 0);
  assert.equal(g.floor.filter((c) => HWATU[c].m === 1).length, 3);
  // 상대가 뻑을 먹으면 4장 + 피 뺏기
  g.players[0].captured = [id(9, 2)];
  g.players[1].hand[0] = id(1, 1);
  g.act('b', { type: 'play', card: id(1, 1) });
  assert.ok(g.players[1].captured.includes(id(1, 0)) && g.players[1].captured.includes(id(1, 3)));
  assert.ok(g.players[1].captured.includes(id(9, 2)), '피 뺏기');
});
test('쪽 + 피 뺏기', () => {
  const g = rig(2, [[id(2, 2)]], [], [id(2, 3)]);
  setup(g, { cap1: [id(11, 2)] });
  g.floor = g.floor.filter((c) => HWATU[c].m !== 2);
  g.act('a', { type: 'play', card: id(2, 2) });
  assert.ok(g.players[0].captured.includes(id(2, 3)));
  assert.ok(g.players[0].captured.includes(id(11, 2)));
  assert.ok(g.events.some((e) => e.includes('쪽')));
});
test('따닥', () => {
  const g = rig(2, [[id(3, 1)]], [id(3, 0), id(3, 2)], [id(3, 3)]);
  setup(g, { cap1: [id(11, 2)] });
  g.act('a', { type: 'play', card: id(3, 1), floorCard: id(3, 0) });
  for (let i = 0; i < 4; i++) assert.ok(g.players[0].captured.includes(id(3, i)));
  assert.ok(g.players[0].captured.includes(id(11, 2)));
  assert.ok(g.events.some((e) => e.includes('따닥')));
});
test('바닥 2장 선택 필요', () => {
  const g = rig(2, [[id(3, 1)]], [id(3, 0), id(3, 2)], [id(5, 2)]);
  assert.throws(() => g.act('a', { type: 'play', card: id(3, 1) }));
  assert.ok(g.players[0].hand.includes(id(3, 1)));
  g.act('a', { type: 'play', card: id(3, 1), floorCard: id(3, 2) });
  assert.ok(g.players[0].captured.includes(id(3, 2)));
  assert.ok(g.floor.includes(id(3, 0)));
});
test('뒤집은 패 선택 (chooseFlip)', () => {
  const g = rig(2, [[id(9, 2)]], [id(6, 0), id(6, 1)], [id(6, 2)]);
  g.act('a', { type: 'play', card: id(9, 2) });
  assert.equal(g.phase, 'chooseFlip');
  assert.throws(() => g.act('a', { type: 'chooseFlip', floorCard: id(9, 2) }));
  g.act('a', { type: 'chooseFlip', floorCard: id(6, 1) });
  assert.ok(g.players[0].captured.includes(id(6, 1)));
  assert.equal(g.turn, 1);
});
test('싹쓸이', () => {
  const g = rig(2, [[id(1, 1)]], [], []);
  setup(g, { floor: [id(1, 0), id(2, 2)], deck: [id(2, 3), id(5, 2)], cap1: [id(11, 2)] });
  g.act('a', { type: 'play', card: id(1, 1) });
  assert.equal(g.floor.length, 0);
  assert.ok(g.events.some((e) => e.includes('싹쓸이')));
  assert.ok(g.players[0].captured.includes(id(11, 2)));
});
test('폭탄 + 흔들기', () => {
  const g = rig(2, [[id(4, 0), id(4, 1), id(4, 2)]], [id(4, 3)], [id(9, 3)]);
  g.act('a', { type: 'play', card: id(4, 0) });
  for (let i = 0; i < 4; i++) assert.ok(g.players[0].captured.includes(id(4, i)));
  assert.equal(g.players[0].shakes, 1);
  assert.equal(g.players[0].bombFlips, 2);
  assert.equal(g.players[0].hand.length, 7);
  const g2 = rig(2, [[id(5, 0), id(5, 1), id(5, 2)]], [], [id(9, 3)]);
  g2.floor = g2.floor.filter((c) => HWATU[c].m !== 5);
  g2.act('a', { type: 'play', card: id(5, 0), shake: true });
  assert.equal(g2.players[0].shakes, 1);
});
test('정산: 광박·피박·고, 칩 합 0', () => {
  const g = rig(2, [], [], []);
  g.players[0].captured = [id(1, 0), id(3, 0), id(8, 0), id(1, 2), id(1, 3), id(2, 2), id(2, 3), id(3, 2), id(3, 3), id(4, 2), id(4, 3), id(5, 2), id(5, 3), id(6, 2)];
  g.players[1].captured = [id(6, 3), id(7, 2)];
  g.players[0].go = 1;
  g.endWin(0);
  // 광3 + 피11장 2 = 5, +1고 = 6점, 광박 x2 피박 x2 → 24 × 10칩
  assert.equal(g.result.points, 6);
  assert.deepEqual(g.result.losers[0].tags, ['광박', '피박']);
  assert.equal(g.result.chipDelta.a, 240);
  assert.equal(g.result.chipDelta.b, -240);
});
test('정산: 3고 2배, 3인 고박', () => {
  const g = rig(3, [], [], []);
  g.players[0].captured = [id(1, 1), id(2, 1), id(3, 1)];
  g.players[1].captured = [id(8, 0)];
  g.players[2].captured = [id(12, 0)];
  g.players[0].go = 3;
  g.endWin(0);
  assert.equal(g.result.points, (3 + 2) * 2);
  const g2 = rig(3, [], [], []);
  g2.players[0].captured = [id(1, 1), id(2, 1), id(3, 1)];
  g2.players[1].go = 1;
  g2.endWin(0);
  assert.equal(g2.result.chipDelta.b, -60);
  assert.equal(g2.result.chipDelta.c, 0);
  assert.equal(g2.result.chipDelta.a, 60);
});

function randomPlay(n, bonus) {
  const ps = n === 2 ? P2 : P3;
  const g = new GoStopGame(ps, { bonus, perPoint: 10 });
  const total = bonus ? 50 : 48;
  let steps = 0;
  while (!g.over) {
    if (++steps > 500) throw new Error('stuck');
    const pid = g.players[g.turn].id;
    const o = g.options(g.turn);
    if (o.phase === 'play') {
      if (!o.cards.length || (o.canFlipOnly && Math.random() < 0.3)) g.act(pid, { type: 'flipOnly' });
      else {
        const c = o.cards[Math.floor(Math.random() * o.cards.length)];
        g.act(pid, { type: 'play', card: c.id, floorCard: c.matches && c.matches[Math.floor(Math.random() * c.matches.length)], shake: Math.random() < 0.5 });
      }
    } else if (o.phase === 'chooseFlip') g.act(pid, { type: 'chooseFlip', floorCard: o.choices[1] });
    else g.act(pid, { type: Math.random() < 0.5 ? 'go' : 'stop' });
    const cnt = g.floor.length + g.deck.length + g.players.reduce((s, p) => s + p.hand.length + p.captured.length, 0) + (g.pending ? 1 : 0);
    assert.equal(cnt, total, 'card conservation');
    assert.equal(new Set([...g.floor, ...g.deck, ...g.players.flatMap((p) => [...p.hand, ...p.captured]), ...(g.pending ? [g.pending.card] : [])]).size, total, 'no duplicates');
  }
  assert.equal(Object.values(g.result.chipDelta).reduce((a, b) => a + b, 0), 0);
  return g.result;
}
test('엔진 랜덤 시뮬레이션 (맞고/고스톱 각 3000판, 보너스 on/off)', () => {
  const stats = {};
  for (const n of [2, 3]) for (const bonus of [true, false]) {
    let nag = 0;
    for (let k = 0; k < 1500; k++) if (randomPlay(n, bonus).nagari) nag++;
    stats[`${n}p bonus=${bonus}`] = `나가리 ${nag}/1500`;
  }
  console.log(stats);
});
test('섯다 랜덤 시뮬레이션 3000판', () => {
  for (let k = 0; k < 3000; k++) {
    const n = 2 + (k % 4);
    const ps = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
    const g = new SeotdaGame(ps, { ante: 100, dealer: k });
    let steps = 0;
    while (!g.over) {
      if (++steps > 300) throw new Error('stuck');
      const o = g.options(g.turn);
      const pick = o[Math.floor(Math.random() * o.length)];
      g.act(g.seats[g.turn].id, { type: pick.type });
    }
    assert.equal(Object.values(g.result.chipDelta).reduce((a, b) => a + b, 0), 0);
  }
});
test('view.lastPlay: 낸 패와 뒤집은 패 (애니메이션/효과음용)', () => {
  const g = new GoStopGame(P2, { bonus: false, perPoint: 10 });
  assert.equal(g.view('a').lastPlay, null);
  const i = g.turn, pid = g.players[i].id;
  const o = g.options(i);
  const c = o.cards[0];
  g.act(pid, { type: 'play', card: c.id, floorCard: c.matches ? c.matches[0] : undefined });
  const lp = g.view('a').lastPlay;
  assert.equal(lp.seq, 1);
  assert.equal(lp.seat, i);
  assert.equal(lp.card, c.id);
  assert.equal(lp.flip, g.lastFlip);
  assert.notEqual(lp.flip, null);
});

// ---- 먹기 이벤트 (lastCapture): 클라이언트 먹기/피 뺏기 애니메이션용 ----
function capGame({ hand0, floor, deck, cap1 }) {
  const g = new GoStopGame(P2, { bonus: false, perPoint: 10, first: 0 });
  g.players.forEach((p) => { p.captured = []; });
  g.players[1].hand = [id(12, 1), id(12, 2)];
  setup(g, { hand0, floor, deck, cap1 });
  return g;
}
test('lastCapture: 한 쌍 먹기 → 먹은 카드, 뺏기 없음', () => {
  const g = capGame({ hand0: [id(1, 2), id(6, 2)], floor: [id(1, 0), id(11, 2)], deck: [id(5, 2), id(7, 2)] });
  g.act('a', { type: 'play', card: id(1, 2), floorCard: id(1, 0) });
  const c = g.view('b').lastCapture;
  assert.equal(c.seat, 0);
  assert.deepEqual(c.gained.slice().sort((x, y) => x - y), [id(1, 0), id(1, 2)]);
  assert.deepEqual(c.steals, []);
  assert.equal(c.seq, 1);
});
test('lastCapture: 쪽 → 두 장 먹고 상대 피 1장 뺏음 (출처 기록)', () => {
  const g = capGame({ hand0: [id(3, 2), id(6, 2)], floor: [id(11, 2), id(10, 2)], deck: [id(3, 3), id(7, 2)], cap1: [id(9, 2), id(9, 0)] });
  g.act('a', { type: 'play', card: id(3, 2) });
  const c = g.lastCapture;
  assert.deepEqual(c.gained.slice().sort((x, y) => x - y), [id(3, 2), id(3, 3)]);
  assert.deepEqual(c.steals, [{ from: 1, to: 0, card: id(9, 2) }]);
  assert.ok(g.players[0].captured.includes(id(9, 2)));
});
test('lastCapture: 뻑이면 먹은 것 없음, 뻑 먹기는 4장 + 뺏기', () => {
  const g = capGame({ hand0: [id(1, 2), id(6, 2)], floor: [id(1, 0), id(11, 2)], deck: [id(1, 3), id(7, 2)] });
  g.act('a', { type: 'play', card: id(1, 2), floorCard: id(1, 0) });
  assert.deepEqual(g.lastCapture.gained, []);
  assert.equal(g.floor.filter((x) => HWATU[x].m === 1).length, 3);
  // 상대가 1월 마지막 장으로 뻑 먹기
  g.players[1].hand = [id(1, 1), id(12, 2)];
  g.players[0].captured = [id(9, 2)];
  g.deck = [id(4, 2), id(8, 3)].reverse();
  g.act('b', { type: 'play', card: id(1, 1) });
  const c = g.lastCapture;
  assert.equal(c.seat, 1);
  assert.equal(c.gained.filter((x) => HWATU[x].m === 1).length, 4);
  assert.deepEqual(c.steals.map((s) => [s.from, s.to]), [[0, 1]]);
});
test('lastCapture: 뒤집은 패 선택(chooseFlip)은 별도 이벤트(seq 증가)', () => {
  const g = capGame({ hand0: [id(6, 2), id(7, 3)], floor: [id(10, 0), id(10, 1), id(11, 2)], deck: [id(10, 2), id(5, 2)] });
  g.act('a', { type: 'play', card: id(6, 2) });
  assert.equal(g.phase, 'chooseFlip');
  const s1 = g.lastCapture.seq;
  assert.deepEqual(g.lastCapture.gained, []);
  g.act('a', { type: 'chooseFlip', floorCard: id(10, 0) });
  assert.equal(g.lastCapture.seq, s1 + 1);
  assert.deepEqual(g.lastCapture.gained.slice().sort((x, y) => x - y), [id(10, 0), id(10, 2)]);
});

test('결과 화면용 정보: 족보별 점수·고 횟수·흔들기·박 태그', () => {
  const g = new GoStopGame(P2, { bonus: false, perPoint: 1000, first: 0 });
  const pis = HWATU.filter((c) => c.type === 'pi' && !c.bonus).map((c) => c.id);
  g.players[0].captured = [id(1, 0), id(3, 0), id(8, 0), ...pis.slice(0, 11)];
  g.players[1].captured = [pis[11]];
  g.players[0].go = 1; g.players[0].shakes = 1;
  g.endWin(0);
  const r = g.result;
  assert.ok(r.scoreLines.some((l) => l.label === '3광' && l.pts === 3));
  assert.ok(r.scoreLines.some((l) => /^피/.test(l.label)));
  assert.strictEqual(r.scoreLines.reduce((a, l) => a + l.pts, 0), r.baseScore);
  assert.strictEqual(r.go, 1); assert.strictEqual(r.shakes, 1); assert.strictEqual(r.nagariMult, 1);
  assert.deepStrictEqual(r.losers[0].tags, ['광박', '피박']);
  assert.strictEqual(r.chipDelta.a, r.points * 2 * 2 * 2 * 1000);
  assert.strictEqual(r.chipDelta.a + r.chipDelta.b, 0);
});

test('선 고르기: 서로 다른 카드, 최고 달이 한 명뿐, 그 자리가 선 (시작 연출용 view.seon)', () => {
  for (let k = 0; k < 200; k++) {
    const n = k % 2 ? 3 : 2;
    const s = GoStopGame.drawSeon(n);
    assert.strictEqual(s.reason, 'draw');
    assert.strictEqual(s.draws.length, n);
    assert.strictEqual(new Set(s.draws.map((d) => d.card)).size, n);
    assert.ok(s.draws.every((d) => !HWATU[d.card].bonus));
    const ms = s.draws.map((d) => HWATU[d.card].m);
    const top = Math.max(...ms);
    assert.strictEqual(ms.filter((m) => m === top).length, 1);
    assert.strictEqual(HWATU[s.draws[s.seat].card].m, top);
  }
  const seon = GoStopGame.drawSeon(2);
  const g = new GoStopGame(P2, { first: seon.seat, seon });
  assert.strictEqual(g.turn, seon.seat);
  const v = g.view('a');
  assert.deepStrictEqual(v.seon.draws, seon.draws);
  assert.strictEqual(v.seon.seat, g.turn);
  // 둘째 판부터: 지난 판 승자
  const g2 = new GoStopGame(P2, { first: 1 });
  assert.deepStrictEqual(g2.view('b').seon, { reason: 'winner', seat: 1 });
  // 첫 수 이후엔 전송 안 함
  const o = g2.options(1); const c = o.cards[0];
  g2.act('b', c ? { type: 'play', card: c.id, floorCard: c.matches ? c.matches[0] : undefined } : { type: 'flipOnly' });
  assert.strictEqual(g2.view('a').seon, null);
});
