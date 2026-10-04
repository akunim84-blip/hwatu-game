// AI 플레이어 의사결정 (서버 측). 오직 해당 AI의 view(pid) — 자기 패 + 공개 정보 — 만 보고 결정한다 (부정행위 없음).
const { HWATU, effCard } = require('../shared/cards');
const { evalHand } = require('./seotda');
const GS = require('./ai-gostop');
const SD = require('./ai-seotda');

const AI_NAMES = ['화투봇', '타짜봇', '고니봇', '짝귀봇', '평경장봇', '아귀봇', '정마담봇'];
// 난이도: 쉬움 / 보통 / 고수 / 초고수 (방 설정, 기본 보통)
const LEVELS = { easy: '쉬움', normal: '보통', hard: '고수', expert: '초고수' };
const LEVEL_KEYS = Object.keys(LEVELS);
const normLevel = (lv) => (LEVELS[lv] ? lv : 'normal');

// ---------- 맞고 / 고스톱 ----------
const C = (id) => effCard(id, false); // 국진은 기본 쌍피로 평가
const DAN_OF = (c) => c.dan;

// 카드 한 장의 기본 가치
function cardValue(id) {
  const c = C(id);
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

// 내가 먹었을 때 추가 가치: 내 족보 완성에 다가가거나, 상대 족보를 막음
function contextBonus(id, mine, opps) {
  const c = C(id);
  let b = 0;
  const near = (cnt, need) => (cnt >= need - 1 ? 7 : cnt >= need - 2 ? 3 : 0);
  if (c.type === 'gwang') { b += near(mine.gwang, 3); for (const o of opps) b += o.gwang >= 2 ? 6 : 0; }
  if (c.godori) { b += near(mine.godori, 3) * 1.3; for (const o of opps) b += o.godori >= 2 ? 8 : 0; }
  if (c.dan) { b += near(mine[c.dan], 3) * 1.3; for (const o of opps) b += o[c.dan] >= 2 ? 8 : 0; }
  if (c.piValue) { b += mine.pi >= 7 && mine.pi < 10 ? 3 : 0; for (const o of opps) b += o.pi >= 8 ? 2 : 0; }
  if (c.type === 'yeol') b += mine.yeol >= 4 ? 3 : 0;
  if (c.type === 'tti') b += mine.tti >= 4 ? 3 : 0;
  return b;
}

// view(pid) 기반으로 한 수 결정. rand: () => [0,1)
function decideGostop(view, opts = {}) {
  const rand = opts.rand || Math.random;
  const level = normLevel(opts.level);
  const o = view.options;
  if (!o) return null;
  if (level === 'easy') return GS.decideEasy(view, rand);
  if (level === 'hard') return GS.decideHard(view, rand, opts);
  if (level === 'expert') return GS.decideExpert(view, rand, opts);
  const me = view.mySeat;
  const my = view.players[me];
  const mine = setCounts(my.captured, my.gukYeol);
  const opps = view.players.filter((p, i) => i !== me).map((p) => setCounts(p.captured, p.gukYeol));

  // 국진: 점수가 더 높아지는 쪽 (같으면 쌍피)
  if (o.phase === 'gukjin') return { type: 'gukjin', asYeol: o.asYeol > o.asPi };
  const noise = () => (level === 'easy' ? (rand() - 0.5) * 14 : (rand() - 0.5) * 2);

  if (o.phase === 'chooseFlip') {
    const best = o.choices.slice().sort((a, b) => (cardValue(b) + contextBonus(b, mine, opps)) - (cardValue(a) + contextBonus(a, mine, opps)))[0];
    return { type: 'chooseFlip', floorCard: best };
  }

  if (o.phase === 'goStop') {
    const score = o.score;
    const target = view.target;
    const oppMax = Math.max(0, ...view.players.filter((p, i) => i !== me).map((p) => p.score));
    const handLeft = my.handCount;
    const deck = view.deckCount;
    // 상대가 거의 났거나 남은 패가 적으면 스톱. 점수가 크면 욕심 덜 냄.
    let goP = 0.75;
    if (oppMax >= target - 1) goP = 0.08;
    else if (oppMax >= target - 3) goP = 0.35;
    if (handLeft <= 1 || deck <= 3) goP = Math.min(goP, 0.05);
    else if (handLeft <= 3) goP *= 0.6;
    if (my.go >= 2) goP *= 0.55;
    if (score >= target + 5) goP *= 0.6;
    if (view.players.length === 2 && oppMax >= 3) goP *= 0.7; // 맞고: 고박 위험
    if (level === 'easy') goP = 0.5;
    return { type: rand() < goP ? 'go' : 'stop' };
  }

  if (o.phase !== 'play') return null;
  if (!o.cards.length) return { type: 'flipOnly' };
  // 공개된 카드(바닥 + 모든 먹은 패)로 월별 '안전도' 계산: 같은 달이 다 보였으면 버려도 안전
  const seen = {};
  const count = (id) => { const m = C(id).m; seen[m] = (seen[m] || 0) + 1; };
  view.floor.forEach(count);
  view.players.forEach((p) => p.captured.forEach(count));
  (my.hand || []).forEach(count);
  const handCnt = {};
  (my.hand || []).forEach((id) => { const m = C(id).m; handCnt[m] = (handCnt[m] || 0) + 1; });

  const scored = o.cards.map((oc) => {
    const c = C(oc.id);
    let s, floorCard, shake = false;
    if (oc.bonus) s = 14; // 보너스 쌍피: 바로 먹고 한 장 더
    else if (oc.bomb) {
      const same = (my.hand || []).filter((id) => C(id).m === c.m);
      s = [...same, ...oc.matches].reduce((a, id) => a + cardValue(id) + contextBonus(id, mine, opps), 0) + 12;
    } else if (oc.matches.length) {
      const ranked = oc.matches.slice().sort((a, b) => (cardValue(b) + contextBonus(b, mine, opps)) - (cardValue(a) + contextBonus(a, mine, opps)));
      floorCard = ranked[0];
      if (oc.matches.length === 3) s = oc.matches.reduce((a, id) => a + cardValue(id), 0) + cardValue(oc.id) + 10; // 뻑 먹기(피 뺏기)
      else s = cardValue(oc.id) + contextBonus(oc.id, mine, opps) + cardValue(floorCard) + contextBonus(floorCard, mine, opps);
      // 같은 달 두 장 들고 있고 바닥 한 장 → 나중에 먹을 수 있으니 약간 아낌 (뻑 위험도 있음)
      if (oc.matches.length === 1 && handCnt[c.m] === 2) s -= 2;
    } else {
      // 맞는 패 없음: 바닥에 내려놓으면 상대가 먹을 수 있음 → 싼 패, 이미 다 보인 달 위주
      const exposed = cardValue(oc.id) + Math.max(0, ...opps.map((x) => contextBonus(oc.id, x, []))) * 0.5;
      const remainingUnseen = 4 - (seen[c.m] || 0);
      s = -exposed * (remainingUnseen <= 0 ? 0.1 : 0.7);
      if (handCnt[c.m] >= 2) s -= 3; // 같은 달을 더 들고 있으면 나중에 먹을 기회 → 지금 버리지 않기
      if (oc.canShake) { shake = level === 'easy' ? rand() < 0.5 : true; s += 1; }
    }
    return { oc, s: s + noise(), floorCard, shake };
  });
  scored.sort((a, b) => b.s - a.s);
  let pick = scored[0];
  if (level === 'easy' && rand() < 0.25) pick = scored[Math.floor(rand() * scored.length)];
  if (o.canFlipOnly && pick.s < -4 && rand() < 0.8) return { type: 'flipOnly' };
  return { type: 'play', card: pick.oc.id, floorCard: pick.floorCard, shake: pick.shake };
}

// ---------- 섯다 ----------
// 족보 → 0~1 강도
function handStrength(hand) {
  const r = hand.rank;
  if (r >= 1000) return 1;
  if (r >= 900) return 0.97;
  if (r >= 801) return 0.8 + (r - 801) * 0.016; // 1땡 .8 ~ 장땡 .944
  if (r >= 710) return 0.6 + (r - 710) / 50 * 0.12; // 세륙 .6 ~ 알리 .72
  if (hand.special === 'gusa' || hand.special === 'mgusa') return 0.45;
  if (hand.special === 'amhaeng') return 0.3;
  if (hand.special === 'ddaeng') return 0.32;
  const k = r - 600; // 망통 0 ~ 갑오 9
  return k * 0.058; // 갑오 .52
}

function decideSeotda(view, opts = {}) {
  const rand = opts.rand || Math.random;
  const level = normLevel(opts.level);
  const o = view.options || [];
  if (!o.length) return null;
  if (level === 'easy') return SD.decideEasy(view, rand);
  if (level === 'hard' || level === 'expert') return SD.decidePro(view, rand, level, opts.memory);
  const me = view.mySeat;
  const cards = view.seats[me].cards;
  const hand = evalHand(cards[0], cards[1]);
  const active = view.seats.filter((s) => !s.folded).length;
  // 상대가 많을수록 요구 강도 상승
  let s = handStrength(hand) - (active - 2) * 0.04;
  s += (rand() - 0.5) * (level === 'easy' ? 0.3 : 0.1);
  const has = (t) => o.find((x) => x.type === t);
  const call = has('call');
  const toCall = call ? call.amount : 0;
  const potOdds = toCall / Math.max(1, view.pot + toCall);
  const bluff = rand() < (level === 'easy' ? 0.04 : 0.09);
  const raise = () => (has('ddadang') && (s > 0.9 || rand() < 0.3) ? { type: 'ddadang' } : has('half') ? { type: 'half' } : call ? { type: 'call' } : has('bbing') ? { type: 'bbing' } : { type: 'check' });
  const passive = () => (has('check') ? { type: 'check' } : call ? { type: 'call' } : { type: 'die' });

  if (level === 'easy') {
    // 쉬움: 잘 안 죽고 따라가기만 하는 스타일 (이기기 쉬움)
    if (s >= 0.85 && rand() < 0.5) return raise();
    if (has('check')) return rand() < 0.2 ? { type: 'bbing' } : { type: 'check' };
    return s >= 0.2 || rand() < 0.6 ? { type: 'call' } : { type: 'die' };
  }
  if (s >= 0.82) return rand() < 0.75 ? raise() : passive();
  if (s >= 0.6) {
    if (rand() < 0.3) return raise();
    if (has('check') && rand() < 0.5) return { type: 'bbing' };
    return passive();
  }
  if (bluff && (has('half') || has('bbing'))) return has('half') ? { type: 'half' } : { type: 'bbing' };
  if (s >= 0.35) {
    if (has('check')) return rand() < 0.3 ? { type: 'bbing' } : { type: 'check' };
    return potOdds < 0.34 || rand() < 0.2 ? { type: 'call' } : { type: 'die' };
  }
  if (has('check')) return { type: 'check' };
  return potOdds < 0.15 && rand() < 0.4 ? { type: 'call' } : { type: 'die' };
}

function decide(view, opts) {
  if (!view) return null;
  return view.kind === 'seotda' ? decideSeotda(view, opts) : decideGostop(view, opts);
}

// 판이 끝난 뒤 공개된 결과만 기억 (섯다 초고수의 상대 성향 파악용). 맞고/고스톱은 기억할 것 없음 (공개 정보는 view에 다 있음)
function observe(view, opts = {}) {
  if (!view || view.kind !== 'seotda' || !opts.memory) return;
  if (normLevel(opts.level) !== 'expert' && normLevel(opts.level) !== 'hard') return;
  observeSeotda(view, opts.memory);
}
const observeSeotda = (view, mem) => SD.observe(view, mem);

module.exports = { observe, decide, decideGostop, decideSeotda, handStrength, cardValue, setCounts, AI_NAMES, LEVELS, LEVEL_KEYS, normLevel };
