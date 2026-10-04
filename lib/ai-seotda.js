// 섯다 AI — 쉬움 · 고수 · 초고수 (보통은 lib/ai.js의 기존 족보 강도 베팅)
// 공정성: view(pid)의 내 패 2장 + 공개 정보(판돈·각자 건 돈·다이 여부)만 사용.
// 초고수의 상대 성향 기억은 판이 끝난 뒤 '공개된' 결과(쇼다운에서 보여준 패, 다이 여부, 건 돈)만 쓴다.
const { SEOTDA } = require('../shared/cards');
const { evalHand, showdown } = require('./seotda');

// ---------- 패 조합 표 (20장 → 190가지) ----------
const HANDS = [];
for (let a = 0; a < SEOTDA.length; a++) for (let b = a + 1; b < SEOTDA.length; b++) HANDS.push({ a, b, h: evalHand(a, b) });
const IDX = new Map(HANDS.map((x, i) => [x.a * 32 + x.b, i]));
const handIdx = (x, y) => IDX.get(Math.min(x, y) * 32 + Math.max(x, y));
let OUT = null; // OUT[i*190+j]: i가 j를 이기면 1, 지면 0, 비김/재경기 0.5 (-1: 카드 겹침)
function outcomes() {
  if (OUT) return OUT;
  const n = HANDS.length;
  OUT = new Float32Array(n * n).fill(-1);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const A = HANDS[i], B = HANDS[j];
    if (A.a === B.a || A.a === B.b || A.b === B.a || A.b === B.b) continue;
    const sd = showdown([{ idx: 0, hand: A.h }, { idx: 1, hand: B.h }]);
    OUT[i * n + j] = sd.redeal ? 0.5 : sd.winners.length > 1 ? 0.5 : sd.winners[0] === 0 ? 1 : 0;
  }
  return OUT;
}
// 무작위 상대 한 명에 대한 승률 (상대 패 순위 매기기용)
let EQ = null, RANKED = null;
function eqTable() {
  if (EQ) return EQ;
  const O = outcomes(), n = HANDS.length;
  EQ = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let j = 0; j < n; j++) { const v = O[i * n + j]; if (v >= 0) { s += v; c++; } } EQ[i] = s / c; }
  RANKED = Array.from(EQ).slice().sort((x, y) => y - x);
  return EQ;
}
// 상대 범위 = 무작위 대비 승률 상위 q 비율의 패. 내 패(카드 2장)를 뺀 조합으로 정확히 계산
function equityVsRange(mine, q) {
  const O = outcomes(); const E = eqTable(); const n = HANDS.length;
  const i = handIdx(mine[0], mine[1]);
  const thr = RANKED[Math.max(0, Math.min(n - 1, Math.ceil(q * n) - 1))];
  let s = 0, c = 0, sAll = 0, cAll = 0;
  for (let j = 0; j < n; j++) {
    const v = O[i * n + j]; if (v < 0) continue;
    sAll += v; cAll++;
    if (E[j] >= thr) { s += v; c++; }
  }
  return c ? s / c : sAll / cAll;
}
const eqRandom = (mine) => eqTable()[handIdx(mine[0], mine[1])];

// ---------- 공통: 이번 판 공개 상황 ----------
function situation(view) {
  const me = view.mySeat;
  const o = view.options || [];
  const has = (t) => o.find((x) => x.type === t);
  const seats = view.seats;
  const ante = view.ante;
  const opps = seats.map((s, i) => ({ s, i })).filter((x) => x.i !== me && !x.s.folded);
  const n = seats.length;
  // 내 뒤에 아직 행동할 사람 수 (대략: 지금 판돈에 못 맞춘 사람 + 아직 안 건 사람)
  let behind = 0;
  for (let k = 1; k < n; k++) { const j = (me + k) % n; const s = seats[j]; if (!s.folded && (view.currentBet === 0 ? true : s.roundBet < view.currentBet)) behind++; }
  if (view.currentBet === 0) behind = Math.max(0, behind - 0); // 체크 돌기
  const call = has('call');
  return { me, o, has, ante, opps, behind, call, toCall: call ? call.amount : 0, pot: view.pot, cards: seats[me].cards };
}
// 상대가 이번 판에 건 정도 → 범위(상위 몇 %). 판돈 기준 공격성
function oppRange(view, x, model) {
  const ante = view.ante;
  const extra = x.s.roundBet; // 기본 판돈 외에 이번 판에 더 건 돈
  let q;
  if (extra <= 0) q = 1; // 아직 안 걸었거나 체크
  else if (extra <= ante) q = 0.8; // 삥
  else if (extra <= ante * 3) q = 0.5;
  else if (extra <= ante * 8) q = 0.32;
  else q = 0.2;
  if (model) {
    // 허세가 잦은 상대는 범위를 넓게, 정직한 상대는 좁게
    const b = model.bluffRate;
    if (extra > ante && b != null) q = Math.min(1, q + (b - 0.15) * 1.2 * (1 - q) + (b < 0.08 ? -0.05 : 0));
    q = Math.max(0.08, q);
  }
  return q;
}

// ---------- 쉬움: 거의 아무렇게나 콜/다이 ----------
function decideEasy(view, rand) {
  const { has, call } = situation(view);
  const r = rand();
  const pick = (list) => { for (const [t, p] of list) if (r < p && has(t)) return { type: t }; return has('check') ? { type: 'check' } : call ? { type: 'call' } : { type: 'die' }; };
  // 패를 거의 안 보고 아무렇게나 (누적 확률)
  if (has('check')) return pick([['check', 0.5], ['bbing', 0.75], ['half', 1]]);
  return pick([['die', 0.27], ['call', 0.7], ['half', 0.9], ['ddadang', 1]]);
}

// ---------- 고수 / 초고수 ----------
// 헤즈업(상대 1명): 남은 베팅을 작은 게임 트리로 끝까지 계산. 상대는 '패 순위에 따라 행동하는 모델'로 가정하고
// 상대 행동을 볼 때마다 상대 범위를 베이즈로 좁힘. 고수는 일반적인 상대 모델, 초고수는 이 상대에게서 본 공개 행동·쇼다운으로 모델을 맞춤.
// 여러 명: 상대별 범위 승률 곱 + 판돈 비율 EV (간단 모델)
const QUANT = (() => { // 패 순위(0=가장 강함 ~ 1=가장 약함)
  const E = eqTable(); const n = HANDS.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => E[y] - E[x]);
  const q = new Float32Array(n); order.forEach((h, r) => { q[h] = (r + 0.5) / n; });
  return q;
})();
const PRIOR = { face: [{ c: 0.8, r: 0.1, br: 0.03 }, { c: 0.62, r: 0.1, br: 0.03 }, { c: 0.45, r: 0.07, br: 0.02 }], open: { b: 0.3, bb: 0.07 } };
const sizeBucket = (s) => (s < 0.2 ? 0 : s < 0.38 ? 1 : 2);
const sig = (x) => 1 / (1 + Math.exp(-x / 0.035));
// 상대 모델 파라미터 (초고수: 기억으로 보정, 의사 표본 수만큼 기본값과 섞음)
function oppParams(m, expert) {
  const P = { face: PRIOR.face.map((x) => Object.assign({}, x)), open: Object.assign({}, PRIOR.open) };
  if (!expert || !m) return P;
  const bs = m.aggShow >= 1 ? (m.aggWeak + 0.6) / (m.aggShow + 4) : 0.15; // 공격적으로 건 판 중 약한 패 비율 (쇼다운에서 본 것)
  for (let b = 0; b < 3; b++) {
    const f = m.face[b]; const n = f.fold + f.call + f.raise; const k = 3;
    if (!n) continue;
    const pr = P.face[b];
    const cont = ((f.call + f.raise) + pr.c * k) / (n + k);
    const rais = (f.raise + (pr.r + pr.br) * k) / (n + k);
    pr.c = cont; pr.r = rais * (1 - bs); pr.br = Math.min(0.9, (rais * bs) / Math.max(0.05, 1 - cont));
  }
  const o = m.open; const n = o.check + o.bet;
  if (n) { const bet = (o.bet + (PRIOR.open.b + PRIOR.open.bb) * 5) / (n + 5); P.open.b = bet * (1 - bs); P.open.bb = Math.min(0.9, (bet * bs) / Math.max(0.05, 1 - P.open.b)); }
  return P;
}
// 상대 한 명의 행동 확률 (패 j 기준)
function oppPolicy(j, st, P) {
  const u = QUANT[j];
  if (st.cb - st.bets[1] > 0) {
    const toCall = st.cb - st.bets[1];
    const pr = P.face[sizeBucket(toCall / (st.pot + toCall))];
    const canRaise = st.raises < 4;
    const valueR = canRaise ? sig(pr.r - u) : 0;
    const cont = sig(pr.c - u);
    const weak = 1 - cont;
    const bl = canRaise ? weak * pr.br : 0;
    return { raise: valueR + bl, call: Math.max(0, cont - valueR), die: weak - bl };
  }
  const bet = sig(P.open.b - u) + (1 - sig(P.open.b - u)) * P.open.bb;
  return { raise: bet, check: 1 - bet };
}
function halfTo(st, who, ante) { const toCall = st.cb - st.bets[who]; return st.cb + Math.max(ante, Math.floor((st.pot + toCall) / 2)); }
function myActions(st, ante) {
  const out = ['die'];
  if (st.cb === 0) { out.push('check', 'bbing'); } else out.push('call');
  if (st.raises < 4) { out.push('half'); if (st.cb > 0) out.push('ddadang'); }
  return out;
}
function applyAct(st, who, t, ante) {
  const x = { pot: st.pot, cb: st.cb, bets: st.bets.slice(), raises: st.raises, contrib: st.contrib, need: st.need.slice() };
  const pay = (amt) => { x.bets[who] += amt; x.pot += amt; if (who === 0) x.contrib += amt; };
  const other = 1 - who;
  if (t === 'check') x.need[who] = false;
  else if (t === 'call') { pay(x.cb - x.bets[who]); x.need[who] = false; }
  else if (t === 'bbing') { pay(ante); x.cb = ante; x.need[who] = false; x.need[other] = true; }
  else { const to = t === 'ddadang' ? x.cb * 2 : halfTo(x, who, ante); pay(to - x.bets[who]); x.cb = to; x.raises++; x.need[who] = false; x.need[other] = true; }
  return x;
}
// 내 패 i, 상대 범위 w(패별 가중치) → 쇼다운 승률
function showEq(i, w) {
  const O = outcomes(); const n = HANDS.length; let s = 0, t = 0;
  for (let j = 0; j < n; j++) { const wj = w[j]; if (!wj) continue; s += wj * O[i * n + j]; t += wj; }
  return t ? s / t : 0.5;
}
// 트리 값: 내 돈 (이번 판 끝났을 때 받는 돈 - 낸 돈 전체)
function treeValue(i, w, st, turn, ante, P, depth) {
  if (!st.need[0] && !st.need[1]) return showEq(i, w) * st.pot - st.contrib;
  if (depth > 12) return showEq(i, w) * st.pot - st.contrib;
  if (turn === 0) {
    if (!st.need[0]) return treeValue(i, w, st, 1, ante, P, depth + 1);
    let best = -1e9;
    for (const t of myActions(st, ante)) {
      const v = t === 'die' ? -st.contrib : treeValue(i, w, applyAct(st, 0, t, ante), 1, ante, P, depth + 1);
      if (v > best) best = v;
    }
    return best;
  }
  if (!st.need[1]) return treeValue(i, w, st, 0, ante, P, depth + 1);
  // 상대 차례: 행동별로 범위를 나눔
  const n = HANDS.length;
  const acc = {}; let tot = 0;
  for (let j = 0; j < n; j++) {
    const wj = w[j]; if (!wj) continue;
    const pol = oppPolicy(j, st, P);
    for (const a in pol) { const pa = wj * pol[a]; if (pa <= 1e-9) continue; (acc[a] || (acc[a] = { p: 0, w: new Float32Array(n) })).p += pa; acc[a].w[j] = pa; }
    tot += wj;
  }
  let v = 0;
  for (const a in acc) {
    const pa = acc[a].p / tot;
    let child;
    if (a === 'die') child = st.pot - st.contrib;
    else {
      const t = a === 'raise' ? (st.cb === 0 ? 'bbing' : 'half') : a;
      child = treeValue(i, acc[a].w, applyAct(st, 1, t, ante), 0, ante, P, depth + 1);
    }
    v += pa * child;
  }
  return v;
}
// 이번 판 공개 행동으로 상대 범위 갱신 (베이즈)
function rangeFromLog(view, oppSeat, myCards, P) {
  const n = HANDS.length; const O = outcomes(); const i = handIdx(myCards[0], myCards[1]);
  const w = new Float32Array(n);
  for (let j = 0; j < n; j++) w[j] = O[i * n + j] >= 0 ? 1 : 0; // 내 카드와 겹치지 않는 패
  const log = (view.log || []).filter((e) => e.redeal === view.redeals);
  const ante = view.ante; let cb = 0; const bets = {}; let pot = view.seats.length * ante * 0 + 0;
  // 재경기 판이면 판돈은 이월됨 — 로그의 pot 값을 그대로 씀
  for (const e of log) {
    if (e.seat === oppSeat) {
      const st = { pot: e.pot, cb, bets: [0, bets[e.seat] || 0], raises: 0 };
      const pol = (j) => oppPolicy(j, st, P);
      const key = e.type === 'die' ? 'die' : e.type === 'check' ? 'check' : e.type === 'call' ? 'call' : 'raise';
      for (let j = 0; j < n; j++) if (w[j]) { const pr = pol(j)[key]; w[j] *= pr == null ? 0.5 : Math.max(0.02, pr); }
    }
    bets[e.seat] = (bets[e.seat] || 0) + e.paid;
    if (e.type === 'bbing') cb = ante; else if (e.type === 'half' || e.type === 'ddadang') cb = bets[e.seat];
  }
  return w;
}
function decidePro(view, rand, level, memory) {
  const sit = situation(view);
  const { has, call, toCall, pot, cards, opps, behind, ante } = sit;
  const expert = level === 'expert';
  const models = expert && memory ? memory.opp || {} : {};
  const me = sit.me;
  let ev = {};
  if (opps.length === 1) {
    const x = opps[0];
    const P = oppParams(models[x.s.id], expert);
    const w = rangeFromLog(view, x.i, cards, P);
    const i = handIdx(cards[0], cards[1]);
    const meS = view.seats[me];
    const st0 = { pot, cb: view.currentBet, bets: [meS.roundBet, x.s.roundBet], raises: (view.log || []).filter((e) => e.redeal === view.redeals && (e.type === 'half' || e.type === 'ddadang')).length, contrib: meS.contrib, need: [true, true] };
    // 상대가 이미 맞춰 놓았으면(내가 마지막) 상대는 더 행동할 필요 없음
    st0.need[1] = x.s.roundBet < view.currentBet || (view.currentBet === 0 && !(view.log || []).some((e) => e.redeal === view.redeals && e.seat === x.i));
    for (const o of sit.o) {
      ev[o.type] = o.type === 'die' ? -meS.contrib : treeValue(i, w, applyAct(st0, 0, o.type, ante), 1, ante, P, 0);
    }
    for (const k in ev) ev[k] += meS.contrib; // 이미 낸 돈은 기준점으로
  } else {
    // 여러 명: 상대별 범위 승률 곱
    // 상대별로 이번 판 공개 행동에서 범위를 좁힌 뒤 승률 곱
    const i = handIdx(cards[0], cards[1]);
    const Ps = opps.map((x) => oppParams(models[x.s.id], expert));
    const ws = opps.map((x, k) => rangeFromLog(view, x.i, cards, Ps[k]));
    let eq = 1;
    ws.forEach((w) => { eq *= showEq(i, w); });
    const behindRisk = (e) => behind * 0.06 * pot * (1 - e);
    ev.die = 0;
    if (has('check')) ev.check = eq * pot - behindRisk(eq);
    if (call) ev.call = eq * (pot + toCall) - toCall - behindRisk(eq) * 0.5;
    for (const t of ['bbing', 'half', 'ddadang']) {
      const opt = has(t); if (!opt) continue;
      const R = opt.amount; const callAdd = Math.max(0, R - toCall); const size = callAdd / Math.max(1, pot + R);
      let pAllFold = 1, eqC = 1, nCall = 0;
      opps.forEach((x, k) => {
        const pr = Ps[k].face[sizeBucket(size)];
        const c = pr.c;
        // 따라오는 패 = 범위 중 강한 쪽 c 비율
        const st = { pot: pot + R, cb: view.currentBet + callAdd, bets: [0, x.s.roundBet], raises: 0 };
        const wc = ws[k].map((wj, j) => (wj ? wj * (1 - oppPolicy(j, st, Ps[k]).die) : 0));
        pAllFold *= 1 - c; eqC *= showEq(i, wc); nCall += c;
      });
      ev[t] = pAllFold * pot + (1 - pAllFold) * (eqC * (pot + R + callAdd * Math.max(1, nCall)) - R);
    }
  }
  const keys = Object.keys(ev);
  let best = keys[0];
  for (const k of keys) if (ev[k] > ev[best]) best = k;
  if (!expert) {
    const near = keys.filter((k) => ev[best] - ev[k] < ante * 0.02);
    return { type: near[Math.floor(rand() * near.length)] };
  }
  // 초고수: 비슷한 EV끼리 섞기 (읽히지 않게) — 손해가 작을 때만
  const MIX = 0.015;
  const near = keys.filter((k) => ev[best] - ev[k] < Math.max(ante * MIX, Math.abs(ev[best]) * MIX / 2));
  return { type: near[Math.floor(rand() * near.length)] };
}

// 판 결과에서 공개된 것만 기억: 공개 베팅 기록(누가 무엇을 했는지), 쇼다운에서 보여준 패, 다이 여부
function observe(view, memory) {
  const res = view.result;
  if (!res || res.game !== 'seotda') return;
  const me = view.mySeat;
  memory.opp = memory.opp || {};
  const revealed = new Map((res.reveal || []).map((r) => [r.id, r]));
  const ante = view.ante;
  const get = (id) => memory.opp[id] || (memory.opp[id] = { face: [0, 1, 2].map(() => ({ fold: 0, call: 0, raise: 0 })), open: { check: 0, bet: 0 }, aggShow: 0, aggWeak: 0, hands: 0 });
  view.seats.forEach((s, i) => { if (i !== me) get(s.id).hands++; });
  const bets = {}; let cb = 0; let lastRedeal = -1;
  const aggr = {};
  for (const e of view.log || []) {
    if (e.redeal !== lastRedeal) { lastRedeal = e.redeal; for (const k in bets) bets[k] = 0; cb = 0; }
    if (e.seat !== me) {
      const m = get(view.seats[e.seat].id);
      if (e.toCall > 0) {
        const b = m.face[sizeBucket(e.toCall / (e.pot + e.toCall))];
        if (e.type === 'die') b.fold++; else if (e.type === 'call') b.call++; else b.raise++;
      } else if (e.type === 'check') m.open.check++;
      else if (e.type !== 'die') m.open.bet++;
      if (e.type === 'half' || e.type === 'ddadang' || e.type === 'bbing') aggr[e.seat] = true;
    }
    bets[e.seat] = (bets[e.seat] || 0) + e.paid;
    if (e.type === 'bbing') cb = ante; else if (e.type === 'half' || e.type === 'ddadang') cb = bets[e.seat];
  }
  for (const seat in aggr) {
    const s = view.seats[seat]; const r = revealed.get(s.id);
    if (!r) continue; // 쇼다운에서 보여준 패만
    const m = get(s.id); m.aggShow++;
    if (QUANT[handIdx(r.cards[0], r.cards[1])] > 0.5) m.aggWeak++;
  }
}

module.exports = { decideEasy, decidePro, observe, equityVsRange, eqRandom };
