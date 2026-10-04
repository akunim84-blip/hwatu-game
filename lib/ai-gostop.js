// 맞고/고스톱 AI — 쉬움 · 고수 · 초고수 (보통은 lib/ai.js의 기존 탐욕 평가)
// 공정성: 오직 view(pid) — 내 손패 + 공개 정보 — 만 사용. 안 보인 카드는 lib/ai-sim.js가 무작위로 다시 나눠서 추측.
const { HWATU, GUKJIN, effCard } = require('../shared/cards');
const { scoreCaptured } = require('./gostop');
const S = require('./ai-sim');

const C = (id) => HWATU[id];
const SET_DEFS = (() => {
  const by = (f) => HWATU.filter(f).map((c) => c.id);
  return [
    { key: 'godori', pts: 5, members: by((c) => c.godori) },
    { key: 'hong', pts: 3, members: by((c) => c.type === 'tti' && c.dan === 'hong') },
    { key: 'cheong', pts: 3, members: by((c) => c.type === 'tti' && c.dan === 'cheong') },
    { key: 'cho', pts: 3, members: by((c) => c.type === 'tti' && c.dan === 'cho') },
  ];
})();
const GWANG = HWATU.filter((c) => c.type === 'gwang').map((c) => c.id);
const YEOL = HWATU.filter((c) => c.type === 'yeol').map((c) => c.id);
const TTI = HWATU.filter((c) => c.type === 'tti').map((c) => c.id);

// ---------- 행동 후보 ----------
function candidates(view) {
  const o = view.options;
  if (!o) return [];
  if (o.phase === 'chooseFlip') return o.choices.map((f) => ({ type: 'chooseFlip', floorCard: f }));
  if (o.phase === 'gukjin') return [{ type: 'gukjin', asYeol: false }, { type: 'gukjin', asYeol: true }];
  if (o.phase === 'goStop') return [{ type: 'stop' }, { type: 'go' }];
  if (o.phase !== 'play') return [];
  const out = [];
  for (const c of o.cards) {
    if (c.bonus) { out.push({ type: 'play', card: c.id }); continue; }
    if (c.needChoice) for (const f of c.matches) out.push({ type: 'play', card: c.id, floorCard: f });
    else out.push({ type: 'play', card: c.id, floorCard: c.matches && c.matches[0], shake: !!c.canShake });
  }
  if (o.canFlipOnly || !o.cards.length) out.push({ type: 'flipOnly' });
  return out;
}

// ---------- 쉬움: 대체로 아무 패나, 뻔한 먹기도 가끔 놓침, 고는 거의 안 함 ----------
function decideEasy(view, rand) {
  const o = view.options;
  if (!o) return null;
  if (o.phase === 'goStop') return { type: rand() < 0.12 ? 'go' : 'stop' };
  if (o.phase === 'gukjin') return { type: 'gukjin', asYeol: rand() < 0.5 };
  if (o.phase === 'chooseFlip') return { type: 'chooseFlip', floorCard: o.choices[Math.floor(rand() * o.choices.length)] };
  if (o.phase !== 'play') return null;
  if (!o.cards.length) return { type: 'flipOnly' };
  let pool = o.cards;
  // 40%만 '먹을 수 있는 패'를 먼저 봄 (나머지는 완전히 아무 패)
  if (rand() < 0.4) { const m = o.cards.filter((c) => c.bonus || (c.matches && c.matches.length)); if (m.length) pool = m; }
  const c = pool[Math.floor(rand() * pool.length)];
  return { type: 'play', card: c.id, floorCard: c.matches && c.matches.length ? c.matches[Math.floor(rand() * c.matches.length)] : undefined, shake: !!c.canShake && rand() < 0.3 };
}

// ---------- 고수: 정적 평가 ----------
// 안 보인 카드 집합 기준으로 '아직 가질 수 있는' 카드인지
function makeCtx(g, me) {
  const owner = new Int8Array(50).fill(-1); // 먹은 사람
  g.players.forEach((p, k) => p.captured.forEach((id) => { owner[id] = k; }));
  const myHand = new Set(g.players[me].hand);
  const onFloor = new Set(g.floor);
  // 내 시점에서 안 보인 카드 = 결정화된 상대 손패 + 덱 (평가는 이 둘을 구분하지 않음 → 숨은 정보 미사용)
  const unseen = [];
  for (let k = 0; k < g.n; k++) if (k !== me) unseen.push(...g.players[k].hand);
  unseen.push(...g.deck);
  if (g.pending) unseen.push(g.pending.card);
  const unseenByM = {};
  for (const id of unseen) { const m = C(id).m; unseenByM[m] = (unseenByM[m] || 0) + 1; }
  return { owner, myHand, onFloor, unseenN: unseen.length, unseenByM };
}

// 한 사람의 '점수 + 앞으로의 가능성' (점 단위)
function potential(g, k, ctx) {
  const p = g.players[k];
  const gy = !!p.gukYeol;
  const sc = scoreCaptured(p.captured, { gukYeol: gy });
  let v = sc.total;
  const avail = (id) => ctx.owner[id] === -1 || ctx.owner[id] === k;
  const gw = sc.gwangCount;
  if (gw < 3) {
    const left = GWANG.filter((id) => ctx.owner[id] === -1).length;
    if (gw === 2 && left >= 1) v += 1.4; else if (gw === 1 && left >= 2) v += 0.45;
  } else if (gw < 5) v += GWANG.filter((id) => ctx.owner[id] === -1).length ? 0.4 : 0;
  for (const s of SET_DEFS) {
    let have = 0, dead = false;
    for (const id of s.members) { if (ctx.owner[id] === k) have++; else if (!avail(id)) dead = true; }
    if (s.key === 'godori' && gy === false) { /* 국진은 고도리 아님 */ }
    if (have >= 3 || dead) continue;
    v += have === 2 ? s.pts * 0.42 : have === 1 ? s.pts * 0.12 : 0;
  }
  if (sc.yeolCount < 5) v += sc.yeolCount * 0.12 + (sc.yeolCount === 4 ? 0.35 : 0); else v += 0.3;
  if (sc.ttiCount < 5) v += sc.ttiCount * 0.12 + (sc.ttiCount === 4 ? 0.35 : 0); else v += 0.3;
  const pv = sc.piValue;
  if (pv < 10) v += pv * 0.17 + (pv >= 8 ? 0.4 : 0); else v += 0.35;
  return { v, sc };
}

// 바닥에 남긴 패를 상대가 다음 차례에 먹을 확률(대략): 상대 손에 같은 달이 있을 확률
function holdProb(u, U, h) {
  if (u <= 0 || h <= 0 || U <= 0) return 0;
  let q = 1;
  for (let i = 0; i < h; i++) { q *= Math.max(0, (U - u - i)) / (U - i); if (q <= 0) break; }
  return 1 - q;
}

function evalState(g, me) {
  if (g.over) {
    const d = g.result.chipDelta['p' + me] || 0;
    return d * 1.2; // 끝난 판은 실제 돈(점) 그대로
  }
  const ctx = makeCtx(g, me);
  const pots = g.players.map((p, k) => potential(g, k, ctx));
  const my = pots[me].v;
  let oppMax = 0, oppSum = 0;
  pots.forEach((x, k) => { if (k !== me) { oppSum += x.v; if (x.v > oppMax) oppMax = x.v; } });
  let v = g.n === 2 ? my - oppMax : my - (oppMax * 0.65 + oppSum * 0.35 / 2) * 1.0;
  // 바닥 노출: 내가 깔아둔 좋은 패를 상대가 먹을 위험 / 내 손에 짝이 있는 바닥 패는 내 몫일 가능성
  const byM = {};
  for (const id of g.floor) { const m = C(id).m; (byM[m] || (byM[m] = [])).push(id); }
  const oppHand = g.players.reduce((s, p, k) => (k !== me ? Math.max(s, p.hand.length) : s), 0);
  for (const m in byM) {
    const cards = byM[m];
    const val = Math.max(...cards.map((id) => cardPts(id))) * (cards.length >= 3 ? 1.8 : 1);
    const myHold = g.players[me].hand.filter((id) => C(id).m === +m).length;
    const u = ctx.unseenByM[m] || 0;
    const pOpp = holdProb(u, ctx.unseenN, oppHand) * (g.n === 3 ? 1.3 : 1);
    if (myHold) v += val * 0.45 * (1 - Math.min(0.9, pOpp));
    else v -= val * 0.55 * Math.min(1, pOpp);
  }
  // 피박 방어: 내 피가 너무 적은데 상대가 날 것 같으면 감점
  const mySc = pots[me].sc;
  const oppLead = Math.max(...pots.filter((x, k) => k !== me).map((x) => x.sc.total));
  if (mySc.piValue <= 5 && oppLead >= g.target - 3) v -= 0.6;
  if (mySc.gwangCount === 0 && pots.some((x, k) => k !== me && x.sc.gwangCount >= 2)) v -= 0.3;
  // 뻑 개수(3뻑 즉시 승리)
  v += (g.players[me].ppeok || 0) * 0.5;
  return v;
}
// 카드 하나의 대략 점 가치 (바닥 노출 평가용)
function cardPts(id) {
  const c = effCard(id, false);
  if (c.bonus) return 0.6;
  if (c.type === 'gwang') return c.bi ? 0.9 : 1.4;
  if (c.type === 'yeol') return c.godori ? 1.1 : 0.45;
  if (c.type === 'tti') return c.dan ? 0.8 : 0.35;
  if (c.type === 'ssangpi') return 0.55;
  return 0.25;
}

// ---------- 고수 평가: '보통'의 카드 가치·족보 문맥 점수를, 실제로 뒤집기까지 끝난 결과(뻑·쪽·따닥·피 뺏기 포함)에 적용 ----------
function cardValue(id) {
  const c = effCard(id, false);
  if (c.bonus) return 9;
  if (c.type === 'gwang') return c.bi ? 11 : 16;
  if (c.type === 'yeol') return c.godori ? 11 : 7;
  if (c.type === 'tti') return c.dan ? 8 : 5;
  if (c.type === 'ssangpi') return 8;
  return 3.5;
}
function setCounts(ids, gukYeol) {
  const s = { gwang: 0, godori: 0, hong: 0, cheong: 0, cho: 0, yeol: 0, tti: 0, pi: 0 };
  for (const id of ids) {
    const c = effCard(id, gukYeol);
    if (c.type === 'gwang') s.gwang++;
    if (c.type === 'yeol') { s.yeol++; if (c.godori) s.godori++; }
    if (c.type === 'tti') { s.tti++; if (c.dan) s[c.dan]++; }
    s.pi += c.piValue || 0;
  }
  return s;
}
// 내가 먹었을 때 추가 가치. dead: 이미 남이 가져가서 완성 불가능한 족보는 가치 없음
function contextBonus(id, mine, opps, dead) {
  const c = effCard(id, false);
  let b = 0;
  const near = (cnt, need) => (cnt >= need - 1 ? 7 : cnt >= need - 2 ? 3 : 0);
  if (c.type === 'gwang') { b += near(mine.gwang, 3); for (const o of opps) b += o.gwang >= 2 ? 6 : 0; }
  if (c.godori) { if (!dead.godori) b += near(mine.godori, 3) * 1.3; for (const o of opps) b += o.godori >= 2 ? 8 : 0; }
  if (c.dan) { if (!dead[c.dan]) b += near(mine[c.dan], 3) * 1.3; for (const o of opps) b += o[c.dan] >= 2 ? 8 : 0; }
  if (c.piValue) { b += mine.pi >= 7 && mine.pi < 10 ? 3 : mine.pi >= 10 ? 2 : mine.pi <= 5 ? 1 : 0; for (const o of opps) b += o.pi >= 8 ? 2 : 0; }
  if (c.type === 'yeol') b += mine.yeol >= 4 ? 4 : mine.yeol >= 3 ? 1.5 : 0;
  if (c.type === 'tti') b += mine.tti >= 4 ? 4 : mine.tti >= 3 ? 1.5 : 0;
  return b;
}
// 족보가 이미 막혔는지 (그 족보 카드 중 하나라도 다른 사람이 먹음)
function deadSets(captured, k) {
  const d = {};
  for (const s of SET_DEFS) d[s.key] = s.members.some((id) => captured.some((cap, j) => j !== k && cap.includes(id)));
  return d;
}
function makeBase(view) {
  const me = view.mySeat;
  const caps = view.players.map((p) => p.captured);
  return {
    me,
    capBefore: view.players.map((p) => new Set(p.captured)),
    counts: view.players.map((p) => setCounts(p.captured, p.gukYeol)),
    dead: view.players.map((p, k) => deadSets(caps, k)),
    scoreBefore: view.players.map((p) => p.score || 0),
  };
}
// 한 장을 k가 먹었을 때의 가치 (k 기준)
function gainValue(id, base, k) {
  const opps = base.counts.filter((x, j) => j !== k);
  return cardValue(id) + contextBonus(id, base.counts[k], opps, base.dead[k]);
}
function evalGreedy(g, base) {
  const me = base.me;
  if (g.over) return (g.result.chipDelta['p' + me] || 0) * 6;
  let v = 0;
  // 내가 새로 얻은 카드(뒤집기·피 뺏기 포함), 상대가 잃은 카드
  for (const id of g.players[me].captured) if (!base.capBefore[me].has(id)) v += gainValue(id, base, me);
  for (let k = 0; k < g.n; k++) {
    if (k === me) continue;
    for (const id of base.capBefore[k]) if (!g.players[k].captured.includes(id)) v += effCard(id, false).piValue ? 2.5 : 0; // 상대 피를 뺏음
  }
  // 점수 변화
  const sc = g.scoreOf(me).total;
  v += (sc - base.scoreBefore[me]) * 4;
  // 바닥에 남은 패: 상대가 먹을 위험, 내 손에 짝이 있으면 내 몫일 가능성
  const ctx = makeCtx(g, me);
  const byM = {};
  for (const id of g.floor) { const m = C(id).m; (byM[m] || (byM[m] = [])).push(id); }
  const oppHand = g.players.reduce((s, p, k) => (k !== me ? s + p.hand.length : s), 0);
  const handM = {};
  for (const id of g.players[me].hand) { const m = C(id).m; handM[m] = (handM[m] || 0) + 1; }
  for (const m in byM) {
    const cards = byM[m];
    const u = ctx.unseenByM[m] || 0;
    const pOpp = Math.min(0.95, holdProb(u, ctx.unseenN, oppHand));
    let oppVal = 0;
    for (let k = 0; k < g.n; k++) if (k !== me) for (const id of cards) oppVal = Math.max(oppVal, gainValue(id, base, k));
    if (cards.length >= 3) oppVal = cards.reduce((a, id) => a + cardValue(id), 0) + 6; // 뻑: 4장 + 피 뺏기
    let myVal = 0;
    for (const id of cards) myVal = Math.max(myVal, gainValue(id, base, me));
    if (handM[m]) {
      if (handM[m] + cards.length === 4 || u === 0) v += myVal * 0.8; // 그 달 나머지가 다 내 손 → 확실히 내 몫
      else v += myVal * 0.45 * (1 - pOpp);
    } else v -= oppVal * 0.6 * pOpp;
  }
  // 손에 남은 패: 같은 달이 이미 다 나온(안 보인 게 없는) 패는 나중에 버려도 안전 → 약간 가산
  for (const id of g.players[me].hand) { const m = C(id).m; if (!byM[m] && !(ctx.unseenByM[m] > 0)) v += 0.5; }
  v += (g.players[me].ppeok || 0) * 2;
  return v;
}

// 고/스톱 판단 (고수): 지금 스톱 점수 vs 고 했을 때 기대값 (상대가 따라잡을 위험·고박 위험 반영)
function stopPay(g, me) { const x = S.cloneGame(g); x.endWin(me); return x.result.chipDelta['p' + me]; }
function goStopHard(g, me) {
  const pay = stopPay(g, me);
  const p = g.players[me];
  const ctx = makeCtx(g, me);
  const pots = g.players.map((q, k) => potential(g, k, ctx));
  const myTurns = p.hand.length + (p.bombFlips || 0);
  if (myTurns <= 0) return 'stop';
  let worst = 0;
  for (let k = 0; k < g.n; k++) {
    if (k === me) continue;
    const need = g.target - pots[k].sc.total;
    const prog = pots[k].v - pots[k].sc.total; // 쌓아둔 가능성
    const turns = g.players[k].hand.length;
    // 상대가 남은 차례 안에 날 확률 (대략)
    const z = (prog + turns * (g.n === 2 ? 0.55 : 0.45) - need) / 1.6;
    const pr = 1 / (1 + Math.exp(-z));
    if (pr > worst) worst = pr;
  }
  if (g.n === 3) worst = Math.min(1, worst * 1.25); // 상대 둘
  // 고 했을 때: 성공하면 (점수+1 이상) × 배수, 실패하면 상대 점수 × 고박
  const sc = pots[me].sc.total;
  const nextGo = p.go + 1;
  const gain = myTurns >= 3 ? 1.6 : myTurns >= 2 ? 1.0 : 0.5; // 더 쌓일 점수 기대
  const goPts = (sc + gain + Math.min(nextGo, 2)) * (nextGo >= 3 ? Math.pow(2, nextGo - 2) : 1);
  const stopPts = sc + Math.min(p.go, 2) * 1 * (p.go >= 3 ? Math.pow(2, p.go - 2) : 1);
  const mulNow = Math.abs(pay) / Math.max(1, stopPts) || 1; // 박·흔들기 배수 대략
  const lossIfOpp = (g.target + 1) * (g.n === 2 ? 2 : 2 * (g.n - 1)) * 1.2; // 고박: 맞고 2배, 고스톱은 혼자 다 냄
  const evGo = (1 - worst) * goPts * mulNow - worst * lossIfOpp;
  return evGo > pay * 1.05 ? 'go' : 'stop';
}

// 한 수의 기대값: 뒤집을 패(안 보인 카드 중 하나, 모두 같은 확률)를 하나씩 대입해서 평균
function resolveAndEval(g, me, rand, depth = 0, base) {
  // 내 차례 안에서 이어지는 선택(뒤집은 패 고르기, 국진, 고/스톱)은 가장 좋은 쪽으로
  let guard = 0;
  while (!g.over && g.turn === me && guard++ < 6) {
    if (g.phase === 'chooseFlip') {
      let best = -1e9, bestG = null;
      for (const f of g.pending.choices) { const x = S.cloneGame(g); x._act('p' + me, { type: 'chooseFlip', floorCard: f }); const v = resolveAndEval(x, me, rand, depth + 1, base); if (v > best) { best = v; bestG = x; } }
      return best;
    }
    if (g.phase === 'gukjin') {
      const a = S.cloneGame(g); a._act('p' + me, { type: 'gukjin', asYeol: false });
      const b = S.cloneGame(g); b._act('p' + me, { type: 'gukjin', asYeol: true });
      return Math.max(resolveAndEval(a, me, rand, depth + 1, base), resolveAndEval(b, me, rand, depth + 1, base));
    }
    if (g.phase === 'goStop') {
      const pay = stopPay(g, me);
      const ev = evalGreedy(g, base);
      return goStopHard(g, me) === 'stop' ? ev + pay * 3 : ev + pay * 2;
    }
    break; // 보너스패 낸 뒤 같은 차례 등은 그대로 평가
  }
  return evalGreedy(g, base);
}

function scoreActionHard(view, a, rand, flipSamples) {
  const me = view.mySeat;
  const base = makeBase(view);
  const unseen = S.unseenOf(view);
  const flips = flipSamples || unseen;
  if (!flips.length || view.deckCount === 0) {
    const g = S.determinize(view, rand);
    try { g._act('p' + me, a); } catch (e) { return -1e9; }
    return resolveAndEval(g, me, rand, 0, base);
  }
  let sum = 0, n = 0;
  for (const F of flips) {
    const g = S.determinize(view, rand, F);
    try { g._act('p' + me, a); } catch (e) { return -1e9; }
    sum += resolveAndEval(g, me, rand, 0, base); n++;
  }
  return sum / n;
}

// 1수 앞보기만 (뒤집을 패 기대값 + 정적 평가) — 몬테카를로 후보 고르기·사전 점수로 씀
function decideGreedy1(view, rand) {
  const o = view.options;
  if (!o) return null;
  const me = view.mySeat;
  const cands = candidates(view);
  if (cands.length === 1) return cands[0];
  if (o.phase === 'goStop') {
    const g = S.determinize(view, S.mulberry32(Math.floor(rand() * 2 ** 31)));
    return { type: goStopHard(g, me) };
  }
  if (o.phase === 'gukjin') return { type: 'gukjin', asYeol: o.asYeol > o.asPi };
  const r = S.mulberry32(Math.floor(rand() * 2 ** 31));
  let best = null, bestV = -1e18;
  for (const a of cands) {
    const v = scoreActionHard(view, a, r) + (rand() - 0.5) * 0.02;
    if (v > bestV) { bestV = v; best = a; }
  }
  return best;
}

// ---------- 고수 · 초고수: 결정화 몬테카를로 (PIMC) ----------
// 안 보인 카드(상대 손패+덱)를 여러 번 무작위로 다시 나눠서, 각 후보 수를 둔 뒤 끝까지 가볍게 진행 → 평균 돈(점)이 가장 큰 수.
// 후보는 1수 앞보기 평가(뒤집을 패 기대값·바닥 노출·족보 막기)로 먼저 추림. 고/스톱도 같은 방식(상대 점수·박·고박 위험이 결과 돈에 그대로 반영).
// 고수: 가볍게 (시뮬레이션 60판), 초고수: 깊게 (900판, 시간 상한 220ms)
const BUDGET = { hard: { budget: 60, keep: 4, maxMs: 120 }, expert: { budget: 900, keep: 6, maxMs: 220, infer: true } };
function decideHard(view, rand, opts = {}) { return decidePimc(view, rand, Object.assign({}, BUDGET.hard, opts.budget ? { budget: opts.budget } : {}, opts.maxMs ? { maxMs: opts.maxMs } : {})); }
function decideExpert(view, rand, opts = {}) { return decidePimc(view, rand, Object.assign({}, BUDGET.expert, opts.budget ? { budget: opts.budget } : {}, opts.maxMs ? { maxMs: opts.maxMs } : {}, opts.policy ? { policy: opts.policy } : {}, opts.infer != null ? { infer: opts.infer } : {})); }
function decidePimc(view, rand, opts = {}) {
  const o = view.options;
  if (!o) return null;
  const me = view.mySeat;
  let cands = candidates(view);
  if (cands.length === 1) return cands[0];
  if (o.phase === 'gukjin' && o.asYeol !== o.asPi) return { type: 'gukjin', asYeol: o.asYeol > o.asPi };
  const r = S.mulberry32(Math.floor(rand() * 2 ** 31));
  // 후보가 많으면 고수 평가로 상위만 남김
  let prior = new Map();
  if (o.phase === 'play' || o.phase === 'chooseFlip') {
    const scored = cands.map((a) => ({ a, v: scoreActionHard(view, a, r) }));
    scored.sort((x, y) => y.v - x.v);
    scored.forEach((x) => prior.set(x.a, x.v));
    cands = scored.slice(0, opts.keep || 5).map((x) => x.a);
    if (cands.length === 1) return cands[0];
  }
  const budget = opts.budget || 720;
  const policy = opts.policy === 'smart' ? S.smartAction : S.fastAction;
  const deadline = Date.now() + (opts.maxMs || 220);
  const sums = new Array(cands.length).fill(0);
  let dets = 0;
  const perDet = cands.length;
  const avoid = opts.infer ? S.inferAvoid(view) : null;
  while (dets * perDet < budget) {
    if ((dets & 7) === 7 && Date.now() > deadline) break;
    const base = S.determinize(view, r, null, avoid);
    const seed = Math.floor(r() * 2 ** 31);
    for (let k = 0; k < cands.length; k++) {
      const g = S.cloneGame(base);
      try { g._act('p' + me, cands[k]); } catch (e) { sums[k] -= 1e6; continue; }
      sums[k] += (S.rollout(g, me, S.mulberry32(seed), 200, policy));
    }
    dets++;
  }
  let best = 0;
  for (let k = 1; k < cands.length; k++) {
    const vk = sums[k] / dets + (prior.size ? (prior.get(cands[k]) || 0) * 0.15 : 0);
    const vb = sums[best] / dets + (prior.size ? (prior.get(cands[best]) || 0) * 0.15 : 0);
    if (vk > vb) best = k;
  }
  return cands[best];
}

module.exports = { decideEasy, decideHard, decideExpert, decideGreedy1, candidates, evalState, goStopHard, BUDGET };
