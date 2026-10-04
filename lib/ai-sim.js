// 맞고/고스톱 AI 시뮬레이션 도구 (고수·초고수용).
// 공정성: 입력은 오직 그 AI의 view(pid) — 자기 손패 + 공개 정보(바닥·먹은 패·남은 장수·상대 손패 장수).
// 보이지 않는 카드(상대 손패 + 덱)는 '안 보인 카드 묶음'에서 무작위로 다시 나눠서(결정화) 가상 판을 만든다.
// 실제 엔진의 숨은 상태(진짜 덱 순서·상대 손패)는 절대 읽지 않는다.
const { HWATU, GUKJIN, effCard } = require('../shared/cards');
const { GoStopGame, scoreCaptured } = require('./gostop');

const C = (id) => HWATU[id];
// 빠른 카드 가치 (롤아웃용, 국진은 쌍피로)
const FAST_VAL = HWATU.map((c) => {
  const e = effCard(c.id, false);
  if (c.bonus) return 9;
  if (e.type === 'gwang') return e.bi ? 10 : 15;
  if (e.type === 'yeol') return e.godori ? 10 : 6;
  if (e.type === 'tti') return e.dan ? 7 : 4;
  if (e.type === 'ssangpi') return 7;
  return 3;
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleInPlace(a, rand) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

// 내 시점에서 안 보인 카드 목록 (상대 손패 + 덱에 있을 수 있는 카드)
function unseenOf(view) {
  const me = view.mySeat;
  const known = new Set();
  (view.players[me].hand || []).forEach((id) => known.add(id));
  view.floor.forEach((id) => known.add(id));
  view.players.forEach((p) => p.captured.forEach((id) => known.add(id)));
  if (view.pending && view.pending.card != null) known.add(view.pending.card);
  const out = [];
  const max = view.bonus === false ? 48 : 50;
  for (let id = 0; id < max; id++) if (!known.has(id)) out.push(id);
  return out;
}

// 공개 기록으로 상대 손패 추측 (초고수): 바닥에 먹을 수 있는 달이 있었는데 손패로 아무것도 안 먹고 버렸다면
// 그 달 패는 없었을 가능성이 큼. 나중에 그 달을 냈으면 추측 취소.
function inferAvoid(view) {
  const avoid = {};
  const me = view.mySeat;
  for (const e of view.playLog || []) {
    if (e.seat === me) continue;
    const s = avoid[e.seat] || (avoid[e.seat] = new Set());
    const m = C(e.card).m;
    s.delete(m);
    if (!e.months.includes(m)) for (const x of e.months) s.add(x);
  }
  return avoid;
}
// view → 가상 엔진 (숨은 카드는 rand로 새로 나눔). deckTop: 덱 맨 위를 이 카드로 고정 (뒤집기 기대값 계산용)
// avoid: {seat: Set(달)} — 그 상대에게는 이 달 카드를 덜 나눠 줌 (가중치)
function determinize(view, rand, deckTop, avoid) {
  const me = view.mySeat;
  const pool = shuffleInPlace(unseenOf(view), rand);
  if (deckTop != null) { const k = pool.indexOf(deckTop); if (k >= 0) { pool.splice(k, 1); } }
  const g = Object.create(GoStopGame.prototype);
  g.n = view.players.length;
  g.kind = view.kind;
  g.target = view.target;
  g.perPoint = 1;
  g.mult = 1;
  g.useBonus = view.bonus !== false;
  g.events = [];
  g.over = false;
  g.result = null;
  g.turn = view.turn;
  g.phase = view.phase;
  g.floor = view.floor.slice();
  g.pending = view.pending ? { card: view.pending.card, choices: view.pending.choices.slice() } : null;
  g.ctx = { steal: 0, hr: { type: 'none' } };
  g.players = view.players.map((p, k) => {
    let hand;
    if (k === me) hand = (p.hand || []).slice();
    else if (avoid && avoid[k] && avoid[k].size) {
      // 가중 추출: 피하는 달은 가중치 0.15
      hand = [];
      const av = avoid[k];
      for (let t = 0; t < p.handCount && pool.length; t++) {
        let tot = 0;
        for (const id of pool) tot += av.has(C(id).m) ? 0.15 : 1;
        let r = rand() * tot, pick = pool.length - 1;
        for (let j = 0; j < pool.length; j++) { r -= av.has(C(pool[j]).m) ? 0.15 : 1; if (r <= 0) { pick = j; break; } }
        hand.push(pool.splice(pick, 1)[0]);
      }
    } else { hand = pool.splice(0, Math.min(p.handCount, pool.length)); }
    return {
      id: 'p' + k, name: 'p' + k, hand, captured: p.captured.slice(), go: p.go || 0, lastGoScore: p.lastGoScore || 0,
      shakes: p.shakes || 0, bombFlips: p.bombFlips || 0, ppeok: p.ppeok || 0, gukYeol: !!p.gukYeol,
      gukDone: p.gukDone != null ? !!p.gukDone : p.captured.includes(GUKJIN),
    };
  });
  // 덱: pop() = 맨 위
  const deck = pool.slice(0, view.deckCount - (deckTop != null ? 1 : 0));
  if (deckTop != null) deck.push(deckTop);
  g.deck = deck;
  return g;
}

// 엔진 상태 복사 (같은 결정화로 여러 후보를 비교할 때)
function cloneGame(s) {
  const g = Object.create(GoStopGame.prototype);
  g.n = s.n; g.kind = s.kind; g.target = s.target; g.perPoint = s.perPoint; g.mult = s.mult; g.useBonus = s.useBonus;
  g.events = []; g.over = s.over; g.result = s.result; g.turn = s.turn; g.phase = s.phase;
  g.floor = s.floor.slice(); g.deck = s.deck.slice();
  g.pending = s.pending ? { card: s.pending.card, choices: s.pending.choices.slice() } : null;
  g.ctx = s.ctx ? { steal: s.ctx.steal, hr: s.ctx.hr } : { steal: 0, hr: { type: 'none' } };
  g.players = s.players.map((p) => Object.assign({}, p, { hand: p.hand.slice(), captured: p.captured.slice() }));
  return g;
}

// 가벼운 롤아웃 정책: 먹을 수 있으면 가장 비싼 걸, 아니면 가장 싼 패 버리기. 고는 점수 여유·상대 점수 보고 단순 판단
function fastAction(g, i, rand) {
  const p = g.players[i];
  if (g.phase === 'chooseFlip') {
    const ch = g.pending.choices;
    return { type: 'chooseFlip', floorCard: FAST_VAL[ch[0]] >= FAST_VAL[ch[1]] ? ch[0] : ch[1] };
  }
  if (g.phase === 'gukjin') {
    const a = scoreCaptured(p.captured).total, b = scoreCaptured(p.captured, { gukYeol: true }).total;
    return { type: 'gukjin', asYeol: b > a };
  }
  if (g.phase === 'goStop') {
    let oppMax = 0;
    for (let k = 0; k < g.n; k++) if (k !== i) { const s = g.scoreOf(k).total; if (s > oppMax) oppMax = s; }
    const go = p.hand.length >= 3 && oppMax <= (g.n === 2 ? 2 : 1) && p.go < 2 && rand() < 0.7;
    return { type: go ? 'go' : 'stop' };
  }
  // play
  if (!p.hand.length) return { type: 'flipOnly' };
  const cnt = {};
  for (const id of p.hand) { const m = C(id).m; cnt[m] = (cnt[m] || 0) + 1; }
  const fl = {};
  for (const id of g.floor) { const m = C(id).m; (fl[m] || (fl[m] = [])).push(id); }
  let best = null, bestS = -1e9, bestF;
  for (const id of p.hand) {
    const c = C(id);
    let s, f;
    if (c.bonus) s = 20;
    else {
      const fm = fl[c.m] || [];
      if (fm.length === 0) s = -FAST_VAL[id] - (cnt[c.m] >= 2 ? 3 : 0);
      else if (fm.length === 1) s = FAST_VAL[id] + FAST_VAL[fm[0]] + (cnt[c.m] === 3 ? 8 : 0);
      else if (fm.length === 2) { f = FAST_VAL[fm[0]] >= FAST_VAL[fm[1]] ? fm[0] : fm[1]; s = FAST_VAL[id] + FAST_VAL[f]; }
      else s = FAST_VAL[id] + FAST_VAL[fm[0]] + FAST_VAL[fm[1]] + FAST_VAL[fm[2]] + 6;
    }
    s += rand() * 1.5;
    if (s > bestS) { bestS = s; best = id; bestF = f; }
  }
  return { type: 'play', card: best, floorCard: bestF, shake: true };
}

// 조금 더 똑똑한 롤아웃 정책 (초고수): 버릴 때는 같은 달이 다 나온(안전한) 패 우선, 상대가 먹기 좋은 패는 덜 버림,
// 같은 달 두 장을 들고 있으면 한 장짜리 바닥은 아껴 둠, 고는 상대 점수·남은 패·고박 위험을 보고
function smartAction(g, i, rand) {
  const p = g.players[i];
  if (g.phase !== 'play') {
    if (g.phase === 'goStop') {
      let oppMax = 0, oppPi = 99;
      for (let k = 0; k < g.n; k++) if (k !== i) { const s = g.scoreOf(k); if (s.total > oppMax) oppMax = s.total; if (s.piValue < oppPi) oppPi = s.piValue; }
      const hl = p.hand.length;
      const safe = g.n === 2 ? oppMax <= 3 : oppMax <= 1;
      const go = hl >= 3 && safe && p.go < 3 && (g.deck.length >= 6);
      return { type: go ? 'go' : 'stop' };
    }
    return fastAction(g, i, rand);
  }
  if (!p.hand.length) return { type: 'flipOnly' };
  // 공개된 카드 수(바닥 + 먹은 패 + 내 손) → 달별 남은(안 보인) 장수
  const seen = new Int8Array(13);
  for (const id of g.floor) seen[C(id).m]++;
  for (const q of g.players) for (const id of q.captured) seen[C(id).m]++;
  const cnt = new Int8Array(13);
  for (const id of p.hand) { const m = C(id).m; cnt[m]++; seen[m]++; }
  const fl = {};
  for (const id of g.floor) { const m = C(id).m; (fl[m] || (fl[m] = [])).push(id); }
  let best = null, bestS = -1e9, bestF;
  for (const id of p.hand) {
    const c = C(id);
    let s, f;
    if (c.bonus) s = 20;
    else {
      const fm = fl[c.m] || [];
      const unseen = 4 - seen[c.m];
      if (fm.length === 0) {
        s = -FAST_VAL[id] * (unseen <= 0 ? 0.2 : 1) - (cnt[c.m] >= 2 ? 4 : 0);
      } else if (fm.length === 1) {
        s = FAST_VAL[id] + FAST_VAL[fm[0]] + (cnt[c.m] === 3 ? 8 : 0);
        if (cnt[c.m] === 2 && unseen === 0) s -= 6; // 나머지가 내 손 → 나중에 확실히 먹음
      } else if (fm.length === 2) { f = FAST_VAL[fm[0]] >= FAST_VAL[fm[1]] ? fm[0] : fm[1]; s = FAST_VAL[id] + FAST_VAL[f] + 1; }
      else s = FAST_VAL[id] + FAST_VAL[fm[0]] + FAST_VAL[fm[1]] + FAST_VAL[fm[2]] + 8;
    }
    s += rand() * 1.2;
    if (s > bestS) { bestS = s; best = id; bestF = f; }
  }
  return { type: 'play', card: best, floorCard: bestF, shake: true };
}

// 끝까지 진행 → seat 기준 점수(돈/판당 점수) 결과. maxSteps 넘으면 현재 점수 차로 근사
function rollout(g, seat, rand, maxSteps = 200, policy = fastAction) {
  let steps = 0;
  while (!g.over && steps++ < maxSteps) {
    const i = g.turn;
    const a = policy(g, i, rand);
    try { g._act(g.players[i].id, a); } catch (e) { return 0; }
  }
  if (!g.over) return 0;
  return g.result.chipDelta['p' + seat] || 0;
}

module.exports = { inferAvoid, determinize, cloneGame, rollout, fastAction, smartAction, unseenOf, mulberry32, shuffleInPlace, FAST_VAL };
