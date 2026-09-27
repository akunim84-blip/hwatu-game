// 국진 (9월 열끗, 술잔) 규칙: 기본 쌍피, 먹은 사람이 열끗으로 쓸 수도 있음 (맞고/고스톱)
const test = require('node:test');
const assert = require('node:assert');
const { GoStopGame, scoreCaptured } = require('../lib/gostop');
const AI = require('../lib/ai');
const H = require('../shared/hints');
const { GUKJIN, HWATU, effCard } = require('../shared/cards');
const id = (m, i) => (m - 1) * 4 + i;
const P2 = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];

function capGame({ hand0, floor, deck, cap0, cap1 }) {
  const g = new GoStopGame(P2, { bonus: false, perPoint: 10, first: 0 });
  g.players.forEach((p) => { p.captured = []; });
  g.players[1].hand = [id(12, 1), id(12, 2)];
  if (hand0) g.players[0].hand = hand0;
  if (floor) g.floor = floor;
  if (deck) g.deck = deck.slice().reverse();
  if (cap0) g.players[0].captured = cap0;
  if (cap1) g.players[1].captured = cap1;
  return g;
}

test('국진 카드: 9월 열끗(id 32), 기본 쌍피로 계산', () => {
  assert.equal(GUKJIN, id(9, 0));
  assert.equal(HWATU[GUKJIN].m, 9);
  assert.equal(HWATU[GUKJIN].type, 'yeol');
  assert.equal(effCard(GUKJIN).type, 'ssangpi');
  assert.equal(effCard(GUKJIN).piValue, 2);
  assert.equal(effCard(GUKJIN, true).type, 'yeol');
});

test('점수: 국진 쌍피면 피 2장, 열끗이면 열끗 1장 (고도리와 무관)', () => {
  const pis = [id(1, 2), id(1, 3), id(2, 2), id(2, 3), id(3, 2), id(3, 3), id(4, 2), id(4, 3)]; // 피 8
  const s1 = scoreCaptured([...pis, GUKJIN]);
  assert.equal(s1.piValue, 10); assert.equal(s1.yeolCount, 0); assert.equal(s1.total, 1);
  const s2 = scoreCaptured([...pis, GUKJIN], { gukYeol: true });
  assert.equal(s2.piValue, 8); assert.equal(s2.yeolCount, 1); assert.equal(s2.total, 0);
  // 열끗 4장 + 국진: 열끗으로 쓰면 5장 1점
  const ye = [id(5, 0), id(6, 0), id(7, 0), id(10, 0)];
  assert.equal(scoreCaptured([...ye, GUKJIN]).total, 0);
  assert.equal(scoreCaptured([...ye, GUKJIN], { gukYeol: true }).total, 1);
  // 고도리 3장 + 국진: 어느 쪽이든 고도리 5점 그대로
  const go = [id(2, 0), id(4, 0), id(8, 1)];
  assert.equal(scoreCaptured([...go, GUKJIN]).total, 5);
  assert.equal(scoreCaptured([...go, GUKJIN], { gukYeol: true }).total, 5);
});

test('사람이 국진을 먹으면 차례가 끝나기 전에 쌍피/열끗 고르기 단계 → 고르면 점수 반영', () => {
  const g = capGame({ hand0: [id(9, 2), id(6, 2)], floor: [GUKJIN, id(11, 2)], deck: [id(5, 2), id(7, 2)] });
  g.act('a', { type: 'play', card: id(9, 2), floorCard: GUKJIN });
  assert.equal(g.phase, 'gukjin');
  assert.equal(g.turn, 0, '고를 때까지 차례 유지');
  const o = g.view('a').options;
  assert.equal(o.phase, 'gukjin');
  assert.equal(o.card, GUKJIN);
  assert.equal(g.view('b').options, null);
  assert.throws(() => g.act('b', { type: 'gukjin', asYeol: true }), /차례/);
  assert.throws(() => g.act('a', { type: 'play', card: id(6, 2) }), /국진/);
  g.act('a', { type: 'gukjin', asYeol: true });
  assert.equal(g.turn, 1);
  assert.equal(g.players[0].gukYeol, true);
  const me = g.view('b').players[0];
  assert.equal(me.gukYeol, true);
  assert.equal(me.piValue, 1); // 9월 피 1장만
  assert.ok(!g.players[0].captured.includes(GUKJIN) || g.scoreOf(0).yeolCount === 1);
});

test('시간 초과/자동 행동은 기본 쌍피', () => {
  const g = capGame({ hand0: [id(9, 2), id(6, 2)], floor: [GUKJIN, id(11, 2)], deck: [id(5, 2), id(7, 2)] });
  g.act('a', { type: 'play', card: id(9, 2), floorCard: GUKJIN });
  g.autoAction('a');
  assert.equal(g.players[0].gukYeol, false);
  assert.equal(g.scoreOf(0).piValue, 3);
  assert.equal(g.turn, 1);
});

test('한 번 고르면 다음 차례엔 다시 묻지 않음', () => {
  const g = capGame({ hand0: [id(9, 2), id(6, 2)], floor: [GUKJIN, id(11, 2)], deck: [id(5, 2), id(7, 2)] });
  g.act('a', { type: 'play', card: id(9, 2), floorCard: GUKJIN });
  g.act('a', { type: 'gukjin', asYeol: false });
  g.act('b', { type: 'play', card: id(12, 1) });
  g.act('a', { type: 'play', card: id(6, 2) });
  assert.notEqual(g.phase, 'gukjin');
});

test('AI: 점수가 더 높은 쪽 (같으면 쌍피)', () => {
  const view = (asPi, asYeol) => ({ options: { phase: 'gukjin', card: GUKJIN, asPi, asYeol }, mySeat: 0, players: [{ captured: [], score: 0 }, { captured: [], score: 0 }], target: 7 });
  assert.deepEqual(AI.decide(view(0, 1), {}), { type: 'gukjin', asYeol: true });
  assert.deepEqual(AI.decide(view(1, 0), {}), { type: 'gukjin', asYeol: false });
  assert.deepEqual(AI.decide(view(0, 0), {}), { type: 'gukjin', asYeol: false });
  // 실제 엔진: 열끗 4장 들고 국진 → 열끗 5장이 낫다
  const g = capGame({ hand0: [id(9, 2), id(6, 2)], floor: [GUKJIN, id(11, 2)], deck: [id(5, 2), id(7, 2)], cap0: [id(5, 0), id(6, 0), id(7, 0), id(10, 0)] });
  g.act('a', { type: 'play', card: id(9, 2), floorCard: GUKJIN });
  const o = g.view('a').options;
  assert.equal(o.asYeol, 1); assert.equal(o.asPi, 0);
  assert.deepEqual(AI.decide(g.view('a'), { level: 'normal', rand: () => 0.5 }), { type: 'gukjin', asYeol: true });
});

test('피 뺏기: 쌍피로 쓰는 국진은 쌍피처럼 뺏김(가져간 쪽도 쌍피), 열끗으로 쓰면 못 뺏음', () => {
  const g = capGame({ cap1: [GUKJIN, id(5, 0)] });
  assert.equal(g.stealPi(1, 0), true);
  assert.deepEqual(g.players[0].captured, [GUKJIN]);
  assert.equal(g.scoreOf(0).piValue, 2);
  assert.equal(g.players[0].gukDone, true, '뺏은 국진은 고르기 없음');
  const g2 = capGame({ cap1: [GUKJIN, id(5, 0)] });
  g2.players[1].gukYeol = true; g2.players[1].gukDone = true;
  assert.equal(g2.stealPi(1, 0), false);
  assert.deepEqual(g2.players[1].captured, [GUKJIN, id(5, 0)]);
  // 일반 피가 있으면 피부터
  const g3 = capGame({ cap1: [GUKJIN, id(5, 2)] });
  g3.stealPi(1, 0);
  assert.deepEqual(g3.players[0].captured, [id(5, 2)]);
});

test('피박: 국진 선택에 따라 피 장수가 달라짐', () => {
  const winCaps = [id(1, 2), id(1, 3), id(2, 2), id(2, 3), id(3, 2), id(3, 3), id(4, 2), id(4, 3), id(5, 2), id(5, 3)]; // 피 10 → 1점
  const loserPi = [id(6, 2), id(6, 3), id(7, 2), id(7, 3)]; // 피 4
  const run = (gukYeol) => {
    const g = capGame({ cap0: winCaps.slice(), cap1: [...loserPi, GUKJIN] });
    g.players[1].gukYeol = gukYeol; g.players[1].gukDone = true;
    g.endWin(0);
    return g.result;
  };
  const tags = (r) => JSON.stringify(r);
  assert.ok(!/피박/.test(tags(run(false))), '쌍피면 피 6장 → 피박 아님');
  assert.ok(/피박/.test(tags(run(true))), '열끗이면 피 4장 → 피박');
});

test('힌트/배지도 국진 선택 반영', () => {
  assert.equal(H.progress([GUKJIN]).pi, 2);
  assert.equal(H.progress([GUKJIN]).yeol, 0);
  assert.equal(H.progress([GUKJIN], true).yeol, 1);
  assert.equal(H.progress([GUKJIN], true).pi, 0);
});

test('랜덤 판: 국진 단계가 멈추지 않고 AI로 끝까지 진행', () => {
  for (let k = 0; k < 300; k++) {
    const g = new GoStopGame(k % 2 ? P2 : [...P2, { id: 'c', name: 'C' }], { bonus: true, perPoint: 10 });
    let steps = 0;
    while (!g.over) {
      if (++steps > 500) throw new Error('stuck');
      const pid = g.players[g.turn].id;
      const a = AI.decide(g.view(pid), { level: 'normal' });
      g.act(pid, a);
    }
  }
});
