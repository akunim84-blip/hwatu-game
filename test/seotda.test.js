const test = require('node:test');
const assert = require('node:assert');
const { evalHand, showdown, SeotdaGame } = require('../lib/seotda');
// 섯다 카드 id: (월-1)*2 + (0: 광/열끗, 1: 띠/8월 열끗)
const id = (m, top = true) => (m - 1) * 2 + (top ? 0 : 1);
const H = (a, b) => evalHand(a, b);

test('광땡', () => {
  assert.equal(H(id(3), id(8)).name, '38광땡');
  assert.equal(H(id(1), id(8)).name, '18광땡');
  assert.equal(H(id(1), id(3)).name, '13광땡');
  assert.ok(H(id(3), id(8)).rank > H(id(1), id(8)).rank);
  // 광이 아닌 카드는 광땡 아님 (3띠 + 8광 = 1끗)
  assert.equal(H(id(3, false), id(8)).name, '1끗');
});
test('땡', () => {
  assert.equal(H(id(10), id(10, false)).name, '장땡');
  assert.equal(H(id(1), id(1, false)).name, '1땡');
  assert.ok(H(id(10), id(10, false)).rank > H(id(9), id(9, false)).rank);
  assert.ok(H(id(1), id(1, false)).rank > H(id(1), id(2)).rank);
  assert.ok(H(id(1, false), id(8)).rank < H(id(1), id(1, false)).rank);
});
test('중간 족보 순서', () => {
  const order = [[1, 2, '알리'], [1, 4, '독사'], [1, 9, '구삥'], [1, 10, '장삥'], [10, 4, '장사'], [4, 6, '세륙']];
  let prev = 10000;
  for (const [a, b, n] of order) {
    const h = H(id(a, false), id(b, false));
    assert.equal(h.name, n);
    assert.ok(h.rank < prev); prev = h.rank;
  }
  assert.ok(H(id(4, false), id(6, false)).rank > H(id(2), id(7)).rank); // 세륙 > 갑오
});
test('끗', () => {
  assert.equal(H(id(2), id(7)).name, '갑오');
  assert.equal(H(id(2), id(8, false)).name, '망통');
  assert.equal(H(id(5), id(3, false)).name, '8끗');
  assert.equal(H(id(2), id(5)).name, '7끗');
});
test('특수 족보 판정', () => {
  assert.equal(H(id(4), id(7)).name, '암행어사');
  assert.equal(H(id(4, false), id(7)).name, '1끗');
  assert.equal(H(id(3), id(7)).name, '땡잡이');
  assert.equal(H(id(3, false), id(7)).name, '망통');
  assert.equal(H(id(4), id(9)).name, '멍텅구리구사');
  assert.equal(H(id(4, false), id(9)).name, '구사');
});
const sdn = (...hs) => showdown(hs.map((h, idx) => ({ idx, hand: h })));
test('암행어사는 13/18광땡을 잡고 38광땡은 못 잡음', () => {
  assert.deepEqual(sdn(H(id(1), id(8)), H(id(4), id(7))).winners, [1]);
  assert.deepEqual(sdn(H(id(1), id(3)), H(id(4), id(7)), H(id(10), id(10, false))).winners, [1]);
  assert.deepEqual(sdn(H(id(3), id(8)), H(id(4), id(7))).winners, [0]);
  assert.deepEqual(sdn(H(id(2), id(5)), H(id(4), id(7))).winners, [0]); // 7끗 > 1끗
});
test('땡잡이는 1~9땡을 잡고 장땡은 못 잡음', () => {
  assert.deepEqual(sdn(H(id(9), id(9, false)), H(id(3), id(7))).winners, [1]);
  assert.deepEqual(sdn(H(id(10), id(10, false)), H(id(3), id(7))).winners, [0]);
  assert.deepEqual(sdn(H(id(1), id(2)), H(id(3), id(7))).winners, [0]); // 알리 > 망통
});
test('구사/멍텅구리구사 재경기', () => {
  assert.equal(sdn(H(id(1), id(2)), H(id(4, false), id(9))).redeal, true);
  assert.equal(sdn(H(id(2), id(2, false)), H(id(4, false), id(9))).redeal, false);
  assert.equal(sdn(H(id(9), id(9, false)), H(id(4), id(9))).redeal, true);
  assert.equal(sdn(H(id(10), id(10, false)), H(id(4), id(9))).redeal, false);
});
test('동점은 판돈 분배', () => {
  assert.deepEqual(sdn(H(id(2), id(7)), H(id(3, false), id(6))).winners, [0, 1]);
});
test('베팅: 모두 다이하면 마지막 사람 승, 칩 보존', () => {
  const g = new SeotdaGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], { ante: 100, dealer: 0 });
  assert.equal(g.pot, 300);
  assert.equal(g.seats[g.turn].id, 'b');
  g.act('b', { type: 'bbing' });
  g.act('c', { type: 'half' });
  assert.throws(() => g.act('c', { type: 'call' }));
  g.act('a', { type: 'die' });
  g.act('b', { type: 'die' });
  assert.ok(g.over);
  assert.deepEqual(g.result.winners, ['c']);
  const sum = Object.values(g.result.chipDelta).reduce((a, b) => a + b, 0);
  assert.equal(sum, 0);
  assert.equal(g.result.chipDelta.a, -100);
  assert.equal(g.result.chipDelta.b, -200);
});
test('베팅: 체크-체크면 쇼다운', () => {
  const g = new SeotdaGame([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], { ante: 50, dealer: 1 });
  let guard = 0;
  while (!g.over && guard++ < 20) g.act(g.seats[g.turn].id, { type: 'check' });
  assert.ok(g.over);
  assert.equal(Object.values(g.result.chipDelta).reduce((a, b) => a + b, 0), 0);
});
