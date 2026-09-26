const test = require('node:test');
const assert = require('node:assert');
const H = require('../shared/hints');
const { GoStopGame } = require('../lib/gostop');
const { HWATU } = require('../shared/cards');
const id = (m, i) => (m - 1) * 4 + i;
const P2 = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const P3 = [...P2, { id: 'c', name: 'C' }];

test('족보 구성원 정의: 고도리·홍단·청단·초단·광', () => {
  assert.deepEqual(H.SETS.godori.members, [id(2, 0), id(4, 0), id(8, 1)]);
  assert.deepEqual(H.SETS.hong.members, [id(1, 1), id(2, 1), id(3, 1)]);
  assert.deepEqual(H.SETS.cheong.members, [id(6, 1), id(9, 1), id(10, 1)]);
  assert.deepEqual(H.SETS.cho.members, [id(4, 1), id(5, 1), id(7, 1)]);
  assert.equal(H.GWANG.length, 5);
  assert.deepEqual(H.setsOfCard(id(8, 1)), ['godori']);
  assert.deepEqual(H.setsOfCard(id(1, 0)), ['gwang']);
  assert.deepEqual(H.setsOfCard(id(12, 2)), []); // 비띠는 단 아님
});

test('진행도/배지: 피는 쌍피 2장으로, 완성 표시', () => {
  const caps = [id(1, 1), id(2, 1), id(3, 1), id(1, 0), id(11, 1), id(5, 2), id(9, 0)];
  const p = H.progress(caps);
  assert.equal(p.sets.hong, 3);
  assert.equal(p.gwang, 1);
  assert.equal(p.pi, 3); // 쌍피 2 + 피 1
  assert.equal(p.yeol, 1); // 9월 열끗
  const b = H.badges(caps);
  const hong = b.find((x) => x.key === 'hong');
  assert.equal(hong.label, '홍단 3/3');
  assert.equal(hong.done, true);
  assert.equal(b.find((x) => x.key === 'pi').label, '피3/10');
  assert.ok(!b.find((x) => x.key === 'cheong')); // 0장인 족보는 배지 없음
});

test('완성 목록: 3광/비광 3광/고도리/피 10장', () => {
  assert.deepEqual(H.completed([id(1, 0), id(3, 0), id(8, 0)]), ['3광']);
  assert.deepEqual(H.completed([id(1, 0), id(3, 0), id(12, 0)]), ['비광 3광']);
  assert.ok(H.completed([id(2, 0), id(4, 0), id(8, 1)]).includes('고도리'));
  const pis = [id(1, 2), id(1, 3), id(2, 2), id(2, 3), id(3, 2), id(3, 3), id(4, 2), id(4, 3), id(11, 1)];
  assert.ok(H.completed(pis).includes('피 10장'));
});

function view(capsBySeat, floor, hand, me = 0) {
  return { mySeat: me, floor, hand, players: capsBySeat.map((c, i) => ({ name: 'P' + i, captured: c })) };
}

test('위협: 상대 청단 1장 남음 + 바닥에 있으면 막을 손패 표시', () => {
  const v = view([[], [id(6, 1), id(9, 1)]], [id(10, 1), id(1, 2)], [id(10, 3), id(5, 2)]);
  const t = H.threats(v);
  assert.equal(t.length, 1);
  assert.equal(t[0].set, '청단');
  assert.deepEqual(t[0].missing, [id(10, 1)]);
  assert.deepEqual(t[0].onFloor, [id(10, 1)]);
  assert.deepEqual(t[0].blockers, [id(10, 3)]);
  const tags = H.handTags(v);
  assert.equal(tags[id(10, 3)][0].kind, 'block');
});

test('위협: 내가 이미 하나 먹은 족보는 경고 안 함, 부족 카드가 내 손에 있으면 막기 태그', () => {
  const v1 = view([[id(10, 1)], [id(6, 1), id(9, 1)]], [], []);
  assert.equal(H.threats(v1).length, 0);
  const v2 = view([[], [id(2, 0), id(4, 0)]], [], [id(8, 1)]);
  const t = H.threats(v2);
  assert.equal(t[0].set, '고도리');
  assert.deepEqual(t[0].inHand, [id(8, 1)]);
  assert.equal(H.handTags(v2)[id(8, 1)][0].label, '막기');
});

test('위협: 광 2장이면 3광 경고, 3인에서 두 상대 모두 검사', () => {
  const v = view([[], [id(1, 0), id(3, 0)], [id(6, 1), id(9, 1)]], [], []);
  const sets = H.threats(v).map((t) => `${t.seat}:${t.set}`).sort();
  assert.deepEqual(sets, ['1:3광', '2:청단']);
});

test('손패 태그: 족보 구성원, 바닥 구성원을 먹을 수 있는 패, 거의 완성 표시', () => {
  const v = view([[id(1, 1), id(2, 1)], []], [id(5, 1)], [id(3, 1), id(5, 3), id(11, 2)]);
  const tags = H.handTags(v);
  assert.equal(tags[id(3, 1)][0].label, '홍단');
  assert.equal(tags[id(3, 1)][0].near, true);
  assert.equal(tags[id(5, 3)][0].label, '초단'); // 5월 피로 바닥의 5월 초단 띠를 먹음
  assert.equal(tags[id(11, 2)], undefined);
  // 상대가 구성원을 먹은 족보는 태그 안 함
  const v2 = view([[], [id(1, 1)]], [], [id(3, 1)]);
  assert.equal(H.handTags(v2)[id(3, 1)], undefined);
});

test('돌리는 순서: 맞고는 선부터 한 장씩 번갈아, 바닥은 사이사이 (손 10·10, 바닥 8)', () => {
  const o = GoStopGame.dealOrder(2, 1, false);
  assert.equal(o.length, 28);
  assert.deepEqual(o.slice(0, 3), [{ to: 'hand', seat: 1 }, { to: 'hand', seat: 0 }, { to: 'floor' }]);
  assert.equal(o.filter((d) => d.to === 'floor').length, 8);
  assert.equal(o.filter((d) => d.seat === 0).length, 10);
  const o3 = GoStopGame.dealOrder(3, 0, false);
  assert.equal(o3.length, 27);
  assert.equal(o3.filter((d) => d.to === 'floor').length, 6);
});

test('돌린 순서 = 실제 덱 순서, 남의 손패는 가려서 전송, 첫 수 뒤에는 전송 안 함', () => {
  for (let r = 0; r < 50; r++) {
    const g = new GoStopGame(r % 2 ? P3 : P2, { perPoint: 10, first: r % 2 });
    const hands = g.players.map(() => []), floor = [], caps = g.players.map(() => []);
    for (const d of g.dealSeq) {
      if (d.to === 'hand') hands[d.seat].push(d.card);
      else if (d.to === 'floor') floor.push(d.card);
      else if (d.to === 'cap') { floor.splice(floor.indexOf(d.card), 1); caps[d.seat].push(d.card); }
    }
    g.players.forEach((p, i) => { assert.deepEqual(hands[i], p.hand); assert.deepEqual(caps[i], p.captured); });
    assert.deepEqual(floor.slice().sort((a, b) => a - b), g.floor.slice().sort((a, b) => a - b));
    // 뷰: 내 손패만 id 공개
    const v = g.view('a');
    v.deal.forEach((d) => { if (d.to === 'hand' && d.seat !== 0) assert.equal(d.card, null); if (d.to === 'hand' && d.seat === 0) assert.ok(d.card != null); });
    const all = new Set(g.dealSeq.map((d) => d.card));
    assert.equal(all.size, g.dealSeq.filter((d) => d.to !== 'cap').length); // 중복 없음
    const i = g.turn, o = g.options(i), c = o.cards[0];
    g.act(g.players[i].id, { type: 'play', card: c.id, floorCard: c.matches ? c.matches[0] : undefined });
    assert.equal(g.view('a').deal, null);
  }
});

test('셔플은 매번 다름 (crypto 난수)', () => {
  const firsts = new Set();
  for (let r = 0; r < 200; r++) firsts.add(new GoStopGame(P2, { bonus: false }).dealSeq[0].card);
  assert.ok(firsts.size > 25, `서로 다른 첫 카드 ${firsts.size}종`);
  assert.equal(HWATU.length, 50);
});
