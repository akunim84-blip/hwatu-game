// AI 난이도 사다리: 레벨끼리 많이 붙여서 승률·평균 돈(점) 비교 (CPU 코어 수만큼 나눠서 병렬)
//   node scripts/ai-ladder.js [matgo|gostop|seotda|all] [판 수]   (기본: all, 맞고 1000 / 고스톱 600 / 섯다 20000)
// 맞고: 이웃 레벨끼리 1:1 (자리·선 번갈아), 고스톱: 3인 혼합(자리·선 돌림), 섯다: 1:1 헤즈업 + 4인 혼합
// 모든 AI는 자기 view(pid)만 보고 결정 (엔진의 숨은 덱·상대 손패는 안 봄)
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const { GoStopGame } = require('../lib/gostop');
const { SeotdaGame } = require('../lib/seotda');
const AI = require('../lib/ai');

function playGostop(levels, first, st) {
  const ps = levels.map((lv, k) => ({ id: 's' + k, name: lv }));
  const g = new GoStopGame(ps, { bonus: true, perPoint: 1, first });
  let steps = 0;
  while (!g.over) {
    if (++steps > 600) throw new Error('stuck');
    const i = g.turn, pid = ps[i].id;
    const t = Date.now();
    const a = AI.decide(g.view(pid), { level: levels[i] });
    const dt = Date.now() - t;
    st.maxMs[levels[i]] = Math.max(st.maxMs[levels[i]] || 0, dt);
    st.ms[levels[i]] = (st.ms[levels[i]] || 0) + dt; st.calls[levels[i]] = (st.calls[levels[i]] || 0) + 1;
    try { g.act(pid, a); } catch (e) { st.errors++; g.autoAction(pid); }
  }
  return g.result;
}
function playSeotda(levels, ids, dealer, mems, st) {
  const ps = levels.map((lv, k) => ({ id: ids[k], name: lv }));
  const g = new SeotdaGame(ps, { ante: 1, dealer });
  let steps = 0;
  while (!g.over) {
    if (++steps > 300) throw new Error('stuck');
    const i = g.turn, pid = ps[i].id;
    const t = Date.now();
    const a = AI.decide(g.view(pid), { level: levels[i], memory: mems[i] });
    st.maxMs[levels[i]] = Math.max(st.maxMs[levels[i]] || 0, Date.now() - t);
    try { g.act(pid, a); } catch (e) { st.errors++; g.autoAction(pid); }
  }
  // 판이 끝나면 각 AI가 공개된 결과만 기억 (초고수: 상대 성향)
  ps.forEach((p, i) => AI.observe(g.view(p.id), { level: levels[i], memory: mems[i] }));
  return g.result;
}
const SESSION = 200; // 섯다: 같은 상대와 연속 200판 (초고수의 상대 성향 기억은 이 안에서만)
const newStats = () => ({ maxMs: {}, ms: {}, calls: {}, errors: 0 });

// ---- 작업 (워커에서 실행): from..to 판 ----
const JOBS = {
  matgoPair({ A, B, from, to }) {
    const st = newStats(); const r = { wa: 0, wb: 0, nag: 0, money: 0, sq: 0, n: 0, st };
    for (let k = from; k < to; k++) {
      const flip = k % 2; // 자리 번갈아
      const levels = flip ? [B, A] : [A, B];
      const res = playGostop(levels, (k >> 1) % 2, st); // 선: 두 판마다 바뀜 → 레벨마다 선 절반씩
      const aId = flip ? 's1' : 's0';
      if (res.nagari) r.nag++; else if (res.winners[0] === aId) r.wa++; else r.wb++;
      const d = res.chipDelta[aId]; r.money += d; r.sq += d * d; r.n++;
    }
    return r;
  },
  gostopMix({ levels, from, to }) {
    const st = newStats(); const by = {}; levels.forEach((lv) => { by[lv] = { wins: 0, money: 0, sq: 0 }; });
    for (let k = from; k < to; k++) {
      const rot = levels.map((_, i) => levels[(i + k) % 3]);
      const res = playGostop(rot, Math.floor(k / 3) % 3, st); // 자리 돌림 × 선 돌림 → 모든 조합 고르게
      rot.forEach((lv, i) => { const d = res.chipDelta['s' + i]; by[lv].money += d; by[lv].sq += d * d; if (!res.nagari && res.winners[0] === 's' + i) by[lv].wins++; });
    }
    return { by, n: to - from, st };
  },
  seotdaPair({ A, B, from, to }) {
    const st = newStats(); let mems = { A: {}, B: {} }; const r = { wa: 0, money: 0, sq: 0, n: 0, st };
    for (let k = from; k < to; k++) {
      if ((k - from) % SESSION === 0) mems = { A: {}, B: {} }; // 한 자리에서 SESSION판마다 새 상대 (기억 초기화)
      const flip = k % 2;
      const ids = flip ? ['B', 'A'] : ['A', 'B'];
      const lv = { A, B };
      const res = playSeotda(ids.map((x) => lv[x]), ids, k, ids.map((x) => mems[x]), st);
      if (res.winners.includes('A')) r.wa++;
      const d = res.chipDelta.A; r.money += d; r.sq += d * d; r.n++;
    }
    return r;
  },
  seotdaMix({ levels, from, to }) {
    const st = newStats(); const by = {}; levels.forEach((lv) => { by[lv] = { wins: 0, money: 0, sq: 0 }; });
    let mems = levels.map(() => ({}));
    for (let k = from; k < to; k++) {
      if ((k - from) % SESSION === 0) mems = levels.map(() => ({}));
      const idx = levels.map((_, i) => (i + k) % levels.length);
      const res = playSeotda(idx.map((i) => levels[i]), idx.map((i) => 'P' + i), k, idx.map((i) => mems[i]), st);
      levels.forEach((lv, i) => { const d = res.chipDelta['P' + i]; by[lv].money += d; by[lv].sq += d * d; if (res.winners.includes('P' + i)) by[lv].wins++; });
    }
    return { by, n: to - from, st };
  },
};

if (!isMainThread) {
  parentPort.postMessage(JOBS[workerData.job](workerData.args));
} else {
  const NAMES = AI.LEVELS;
  const game = process.argv[2] || 'all';
  const N = Number(process.argv[3]) || 0;
  const W = Math.max(1, os.cpus().length);
  const fmt = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
  const se = (sum, sq, n) => { const m = sum / n; return Math.sqrt(Math.max(0, sq / n - m * m) / n); };
  // n판을 W개로 나눠 병렬 실행 → 합침
  async function par(job, args, n) {
    const chunk = Math.ceil(n / W);
    const parts = [];
    for (let w = 0; w < W; w++) {
      const from = w * chunk, to = Math.min(n, from + chunk);
      if (from >= to) break;
      parts.push(new Promise((res, rej) => {
        const wk = new Worker(__filename, { workerData: { job, args: Object.assign({}, args, { from, to }) } });
        wk.on('message', res); wk.on('error', rej);
      }));
    }
    return Promise.all(parts);
  }
  const mergeStats = (rs) => { const st = newStats(); for (const r of rs) { for (const k in r.st.maxMs) st.maxMs[k] = Math.max(st.maxMs[k] || 0, r.st.maxMs[k]); for (const k in r.st.ms) { st.ms[k] = (st.ms[k] || 0) + r.st.ms[k]; st.calls[k] = (st.calls[k] || 0) + r.st.calls[k]; } st.errors += r.st.errors; } return st; };
  const timeLine = (st) => Object.keys(st.maxMs).map((k) => `${NAMES[k]} 평균 ${st.calls[k] ? (st.ms[k] / st.calls[k]).toFixed(1) : '-'}ms·최대 ${st.maxMs[k]}ms`).join(', ') + (st.errors ? ` · 불법 수 ${st.errors}` : '');
  const pairs = [['normal', 'easy'], ['hard', 'normal'], ['expert', 'hard']];
  (async () => {
    const t0 = Date.now();
    if (game === 'matgo' || game === 'all') {
      const n = N || 1000;
      console.log(`\n## 맞고 1:1 (${n}판씩, 자리·선 번갈아, 점당 1)`);
      console.log('| 대결 | 윗레벨 승 | 아랫레벨 승 | 나가리 | 윗레벨 승률 (나가리 제외) | 윗레벨 평균 돈/판 (±표준오차) |');
      console.log('|---|---|---|---|---|---|');
      for (const [A, B] of pairs) {
        const rs = await par('matgoPair', { A, B }, n);
        const r = rs.reduce((a, x) => ({ wa: a.wa + x.wa, wb: a.wb + x.wb, nag: a.nag + x.nag, money: a.money + x.money, sq: a.sq + x.sq, n: a.n + x.n }), { wa: 0, wb: 0, nag: 0, money: 0, sq: 0, n: 0 });
        console.log(`| ${NAMES[A]} vs ${NAMES[B]} | ${r.wa} | ${r.wb} | ${r.nag} | ${(r.wa / Math.max(1, r.wa + r.wb) * 100).toFixed(1)}% | ${fmt(r.money / r.n)}점 (±${se(r.money, r.sq, r.n).toFixed(2)}) |`);
        console.error(`  생각 시간: ${timeLine(mergeStats(rs))}`);
      }
    }
    if (game === 'gostop' || game === 'all') {
      const n = N || 600;
      console.log(`\n## 고스톱 3인 혼합 (${n}판씩, 자리·선 돌림, 점당 1)`);
      for (const lv of [['easy', 'normal', 'hard'], ['normal', 'hard', 'expert']]) {
        const rs = await par('gostopMix', { levels: lv }, n);
        console.log(`\n| 레벨 | 난 판 | 승률 | 평균 돈/판 (±표준오차) |`);
        console.log('|---|---|---|---|');
        for (const l of lv) {
          const w = rs.reduce((a, x) => a + x.by[l].wins, 0), m = rs.reduce((a, x) => a + x.by[l].money, 0), sq = rs.reduce((a, x) => a + x.by[l].sq, 0);
          console.log(`| ${NAMES[l]} | ${w} | ${(w / n * 100).toFixed(1)}% | ${fmt(m / n)}점 (±${se(m, sq, n).toFixed(2)}) |`);
        }
        console.error(`  생각 시간: ${timeLine(mergeStats(rs))}`);
      }
    }
    if (game === 'seotda' || game === 'all') {
      const n = N || 20000;
      console.log(`\n## 섯다 1:1 헤즈업 (${n}판씩, 기본 판돈 1, 선 번갈아, 같은 상대와 ${SESSION}판씩 끊어서)`);
      console.log('| 대결 | 윗레벨 이긴 판 | 승률 | 윗레벨 평균 돈/판 (판돈 배수, ±표준오차) |');
      console.log('|---|---|---|---|');
      for (const [A, B] of pairs) {
        const rs = await par('seotdaPair', { A, B }, n);
        const r = rs.reduce((a, x) => ({ wa: a.wa + x.wa, money: a.money + x.money, sq: a.sq + x.sq, n: a.n + x.n }), { wa: 0, money: 0, sq: 0, n: 0 });
        console.log(`| ${NAMES[A]} vs ${NAMES[B]} | ${r.wa} | ${(r.wa / r.n * 100).toFixed(1)}% | ${fmt(r.money / r.n)} (±${se(r.money, r.sq, r.n).toFixed(2)}) |`);
      }
      console.log(`\n## 섯다 4인 혼합 (${n}판, 자리 돌림, ${SESSION}판씩 끊어서)`);
      const lv = ['easy', 'normal', 'hard', 'expert'];
      const rs = await par('seotdaMix', { levels: lv }, n);
      console.log('| 레벨 | 이긴 판 | 승률 | 평균 돈/판 (판돈 배수, ±표준오차) |');
      console.log('|---|---|---|---|');
      for (const l of lv) {
        const w = rs.reduce((a, x) => a + x.by[l].wins, 0), m = rs.reduce((a, x) => a + x.by[l].money, 0), sq = rs.reduce((a, x) => a + x.by[l].sq, 0);
        console.log(`| ${NAMES[l]} | ${w} | ${(w / n * 100).toFixed(1)}% | ${fmt(m / n)} (±${se(m, sq, n).toFixed(2)}) |`);
      }
    }
    console.error(`총 ${((Date.now() - t0) / 1000).toFixed(0)}초 (워커 ${W}개)`);
  })();
}
