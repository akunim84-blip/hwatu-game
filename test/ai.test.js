const test = require('node:test');
const assert = require('node:assert');
const { GoStopGame } = require('../lib/gostop');
const { SeotdaGame } = require('../lib/seotda');
const AI = require('../lib/ai');
const id = (m, i) => (m - 1) * 4 + i;
const sid = (m, i) => (m - 1) * 2 + i; // 섯다: i 0 광/열끗, 1 띠/열끗
const P2 = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const P3 = [...P2, { id: 'c', name: 'C' }];
const seq = (arr) => { let k = 0; return () => arr[k++ % arr.length]; };

function gostopWith(hand, floor, n = 2) {
  const g = new GoStopGame(n === 2 ? P2 : P3, { bonus: false, perPoint: 10, first: 0 });
  g.players[0].hand = hand.slice();
  g.floor = floor.slice();
  g.players.forEach((p) => { p.captured = []; });
  return g;
}

test('AI(맞고): 피보다 광을 먹는 수를 고름', () => {
  const g = gostopWith([id(1, 2), id(3, 3), id(5, 2)], [id(1, 0), id(3, 2), id(9, 2)]);
  const a = AI.decideGostop(g.view('a'), { rand: () => 0.5 });
  assert.equal(a.type, 'play');
  assert.equal(a.card, id(1, 2)); // 1월 피로 1월 광(송학)을 먹음
  assert.equal(a.floorCard, id(1, 0));
});

test('AI(맞고): 바닥 두 장 중 더 좋은 패(띠)를 고름', () => {
  const g = gostopWith([id(2, 2), id(7, 3)], [id(2, 1), id(2, 3), id(9, 3)]);
  const a = AI.decideGostop(g.view('a'), { rand: () => 0.5 });
  assert.equal(a.card, id(2, 2));
  assert.equal(a.floorCard, id(2, 1)); // 홍단 띠
});

test('AI(맞고): 먹을 게 없으면 비싼 광 대신 싼 피를 버림', () => {
  const g = gostopWith([id(8, 0), id(4, 3)], [id(10, 2), id(11, 2)]);
  const a = AI.decideGostop(g.view('a'), { rand: () => 0.5 });
  assert.equal(a.card, id(4, 3));
});

test('AI(맞고): 상대 족보(홍단 2장) 막기 우선', () => {
  const g = gostopWith([id(3, 2), id(6, 2)], [id(3, 1), id(6, 3)]);
  g.players[1].captured = [id(1, 1), id(2, 1)]; // 상대 홍단 2장
  const a = AI.decideGostop(g.view('a'), { rand: () => 0.5 });
  assert.equal(a.card, id(3, 2));
  assert.equal(a.floorCard, id(3, 1));
});

test('AI(맞고): 흔들기 가능하면 흔들기 선언', () => {
  const g = gostopWith([id(5, 0), id(5, 1), id(5, 2)], [id(9, 2)]);
  const a = AI.decideGostop(g.view('a'), { rand: () => 0.5 });
  assert.equal(a.type, 'play');
  assert.equal(a.shake, true);
});

test('AI(맞고): 뒤집은 패 선택 시 가치 높은 패', () => {
  const view = { kind: 'matgo', mySeat: 0, players: [{ captured: [], hand: [], handCount: 3, score: 0 }, { captured: [], handCount: 3, score: 0 }], floor: [], options: { phase: 'chooseFlip', choices: [id(8, 3), id(8, 0)], card: id(8, 2) } };
  assert.equal(AI.decideGostop(view, { rand: () => 0.5 }).floorCard, id(8, 0));
});

test('AI 고/스톱: 상대가 거의 났거나 마지막 패면 스톱, 여유 있으면 대체로 고', () => {
  const mk = (oppScore, handCount, go = 0) => ({ kind: 'matgo', target: 7, mySeat: 0, deckCount: 10, players: [{ captured: [], handCount, score: 7, go }, { captured: [], handCount: 5, score: oppScore }], floor: [], options: { phase: 'goStop', score: 7, go } });
  assert.equal(AI.decideGostop(mk(6, 5), { rand: () => 0.5 }).type, 'stop');
  assert.equal(AI.decideGostop(mk(0, 1), { rand: () => 0.5 }).type, 'stop');
  assert.equal(AI.decideGostop(mk(0, 6), { rand: () => 0.3 }).type, 'go');
});

test('AI(섯다): 강한 패는 죽지 않고, 망통은 큰 베팅에 죽음', () => {
  const g = new SeotdaGame(P3, { ante: 100 });
  const me = g.turn;
  g.seats[me].cards = [sid(3, 0), sid(8, 0)]; // 38광땡
  for (const r of [0.01, 0.3, 0.6, 0.95]) {
    const a = AI.decideSeotda(g.view(g.seats[me].id), { rand: () => r });
    assert.notEqual(a.type, 'die');
  }
  // 망통 + 상대 하프
  const g2 = new SeotdaGame(P3, { ante: 100 });
  const first = g2.turn;
  g2.act(g2.seats[first].id, { type: 'half' });
  const me2 = g2.turn;
  g2.seats[me2].cards = [sid(2, 1), sid(8, 1)]; // 2+8 = 망통
  const a2 = AI.decideSeotda(g2.view(g2.seats[me2].id), { rand: () => 0.5 });
  assert.equal(a2.type, 'die');
});

test('AI(섯다): 남의 패를 보지 않음 (view에는 상대 패가 null)', () => {
  const g = new SeotdaGame(P3, { ante: 100 });
  const v = g.view(g.seats[g.turn].id);
  v.seats.forEach((s, i) => { if (i !== v.mySeat) assert.ok(s.cards.every((c) => c === null)); });
  assert.ok(AI.decideSeotda(v, { rand: Math.random }));
});

test('handStrength 순서: 38광땡 > 장땡 > 알리 > 갑오 > 망통', () => {
  const h = (a, b) => AI.handStrength(require('../lib/seotda').evalHand(a, b));
  assert.ok(h(sid(3, 0), sid(8, 0)) > h(sid(10, 0), sid(10, 1)));
  assert.ok(h(sid(10, 0), sid(10, 1)) > h(sid(1, 1), sid(2, 1)));
  assert.ok(h(sid(1, 1), sid(2, 1)) > h(sid(4, 1), sid(5, 1)));
  assert.ok(h(sid(4, 1), sid(5, 1)) > h(sid(2, 1), sid(8, 1)));
});

test('AI끼리 수백 판: 항상 합법적인 수, 판이 끝남 (맞고/고스톱/섯다, 쉬움/보통)', () => {
  for (let r = 0; r < 150; r++) {
    const level = r % 2 ? 'easy' : 'normal';
    const ps = r % 3 === 0 ? P3 : P2;
    const g = new GoStopGame(ps, { perPoint: 10, bonus: r % 4 !== 0 });
    let guard = 0;
    while (!g.over && guard++ < 500) {
      const pid = g.players[g.turn].id;
      g.act(pid, AI.decide(g.view(pid), { level })); // 거부되면 throw → 테스트 실패
    }
    assert.ok(g.over, 'gostop game finished');
  }
  for (let r = 0; r < 200; r++) {
    const level = r % 2 ? 'easy' : 'normal';
    const ps = [...P3, { id: 'd', name: 'D' }, { id: 'e', name: 'E' }].slice(0, 2 + (r % 4));
    const g = new SeotdaGame(ps, { ante: 100 });
    let guard = 0;
    while (!g.over && guard++ < 500) {
      const pid = g.seats[g.turn].id;
      g.act(pid, AI.decide(g.view(pid), { level }));
    }
    assert.ok(g.over, 'seotda game finished');
  }
});
