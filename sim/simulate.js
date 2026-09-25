// Socket.IO 통합 시뮬레이션: 봇들이 실제 서버에 접속해 게임을 끝까지 진행
// 사용법: node sim/simulate.js [roundsPerGame=200] [url]
const { io } = require('socket.io-client');
const ROUNDS = Number(process.argv[2] || 200);
let URL = process.argv[3];
let ROOMS = null;
const REMOTE = !!URL;
const START = 10000;

function bot(name, url) {
  const b = { pid: 'bot-' + name + '-' + Math.random().toString(36).slice(2, 8), name, state: null, lastSeq: -1, errors: 0, leaks: 0 };
  b.connect = () => {
    b.sock = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    b.sock.on('state', (st) => { b.state = st; b.onState && b.onState(st); });
    return new Promise((res) => b.sock.on('connect', res));
  };
  b.emit = (ev, d) => new Promise((res) => b.sock.timeout(3000).emit(ev, d, (err, r) => res(err ? { ok: false, error: 'timeout', timeout: true } : r || {})));
  return b;
}
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

function checkPrivacy(b, st) {
  const g = st.game;
  if (!g) return;
  if (g.kind === 'seotda') {
    g.seats.forEach((s, i) => { if (i !== g.mySeat && !g.result && s.cards.some((c) => c != null)) b.leaks++; });
  } else {
    g.players.forEach((p, i) => { if (i !== g.mySeat && p.hand != null) b.leaks++; });
    if (g.deck) b.leaks++;
  }
}

function decide(g) {
  const o = g.options;
  if (g.kind === 'seotda') {
    if (!o || !o.length) return null;
    // 너무 자주 죽지 않게 가중치
    const w = o.flatMap((x) => (x.type === 'die' ? [x] : [x, x, x]));
    return { type: rnd(w).type };
  }
  if (!o) return null;
  if (o.phase === 'play') {
    if (!o.cards.length || (o.canFlipOnly && Math.random() < 0.3)) return { type: 'flipOnly' };
    const withMatch = o.cards.filter((c) => c.matches && c.matches.length);
    const c = withMatch.length && Math.random() < 0.8 ? rnd(withMatch) : rnd(o.cards);
    return { type: 'play', card: c.id, floorCard: c.matches && c.matches.length ? rnd(c.matches) : undefined, shake: !!c.canShake && Math.random() < 0.5 };
  }
  if (o.phase === 'chooseFlip') return { type: 'chooseFlip', floorCard: rnd(o.choices) };
  if (o.phase === 'goStop') return { type: Math.random() < 0.4 ? 'go' : 'stop' };
  return null;
}

async function runRoom(game, nPlayers, rounds, label, opts = {}) {
  const bots = Array.from({ length: nPlayers }, (_, i) => bot(`${label}${i}`, URL));
  for (const b of bots) await b.connect();
  const host = bots[0];
  const cr = await host.emit('createRoom', { game, perPoint: 10 + Math.floor(Math.random() * 90), pid: host.pid, name: host.name, bonus: opts.bonus !== false });
  if (!cr.ok) throw new Error('create failed ' + cr.error);
  const code = cr.code;
  for (const b of bots.slice(1)) { const r = await b.emit('joinRoom', { code, pid: b.pid, name: b.name }); if (!r.ok) throw new Error('join ' + r.error); }
  // 잘못된 요청 검증
  const bad = await bots[1].emit('start');
  if (bad.ok) throw new Error('non-host start should fail');
  const stats = { rounds: 0, results: {}, reconnects: 0, conservationFail: 0, invalidRejected: 0, chipSnapshots: [] };
  let lastProgress = Date.now();
  let lastSeqSeen = -1;
  let done = false;
  let resolveDone;
  const finished = new Promise((r) => (resolveDone = r));
  let handledRound = 0;

  const attachHandlers = (b) => {
    b.onState = (st) => {
      if (st.room.actSeq !== lastSeqSeen) { lastSeqSeen = st.room.actSeq; lastProgress = Date.now(); }
      checkPrivacy(b, st);
      const r = st.room, g = st.game;
      if (b === host && r.status === 'result' && r.round > handledRound) {
        handledRound = r.round;
        stats.rounds++;
        const res = g.result;
        const key = res.nagari ? '나가리' : res.game === 'seotda' && res.reason ? '다이승' : '승부';
        stats.results[key] = (stats.results[key] || 0) + 1;
        const sum = r.players.reduce((s, p) => s + p.chips, 0);
        if (sum !== START * r.players.length) stats.conservationFail++;
        const dsum = Object.values(res.chipDelta).reduce((a, x) => a + x, 0);
        if (dsum !== 0) stats.conservationFail++;
        if (stats.rounds >= rounds) { done = true; resolveDone(); return; }
        setImmediate(() => host.emit('start').then((x) => { if (!x.ok) console.error(label, 'start err', x.error); }));
        return;
      }
      if (!g || g.result || r.actSeq === b.lastSeq) return;
      const a = decide(g);
      if (!a) return;
      b.lastSeq = r.actSeq;
      setImmediate(async () => {
        // 가끔 차례가 아닌 봇이 끼어들기 시도 → 거부되어야 함
        const other = bots.find((x) => x !== b);
        const eng = ROOMS && ROOMS.get(code) && ROOMS.get(code).engine;
        const actorId = eng && !eng.over ? (eng.kind === 'seotda' ? eng.seats[eng.turn] : eng.players[eng.turn]) : null;
        if (Math.random() < 0.02 && actorId && actorId.id !== other.pid && other.sock.connected) {
          const rr = await other.emit('action', a);
          if (rr.timeout) {} else if (!rr.ok) stats.invalidRejected++;
          else { stats.invalidAccepted = (stats.invalidAccepted || 0) + 1; console.error(label, 'INVALID ACTION ACCEPTED', JSON.stringify(a), actorId.id, other.pid, b.pid); }
        }
        const res = await b.emit('action', a);
        if (!res.ok) { b.errors++; b.lastSeq = -1; b.onState(b.state); }
      });
    };
  };
  bots.forEach(attachHandlers);
  await host.emit('start');

  // 재접속 테스트: 주기적으로 한 봇을 끊고 같은 pid로 다시 접속
  if (opts.abandon) {
    // 한 명이 완전히 나가버려도(연결 끊김) 자동 진행으로 판이 끝나야 함
    setTimeout(() => { bots[nPlayers - 1].sock.disconnect(); bots[nPlayers - 1].abandoned = true; }, 30);
  }
  let reconnecting = false;
  const reconnTimer = setInterval(async () => {
    if (done || opts.abandon || reconnecting) return;
    reconnecting = true;
    const b = rnd(bots.slice(1));
    b.sock.disconnect();
    await new Promise((r) => setTimeout(r, 20));
    await b.connect();
    const r = await b.emit('joinRoom', { code, pid: b.pid, name: b.name });
    if (r.ok) stats.reconnects++;
    b.lastSeq = -1;
    reconnecting = false;
  }, REMOTE ? 2500 : 60);
  const watchdog = setInterval(() => {
    if (Date.now() - lastProgress > (REMOTE ? 40000 : 8000)) { console.error(label, 'STUCK', JSON.stringify(host.state && { status: host.state.room.status, players: host.state.room.players.map((p) => [p.name, p.connected]), g: host.state.game && { phase: host.state.game.phase, turn: host.state.game.turn, opts: host.state.game.options } })); done = true; stats.stuck = true; resolveDone(); }
  }, 1000);
  await finished;
  clearInterval(reconnTimer); clearInterval(watchdog);
  stats.errors = bots.reduce((s, b) => s + b.errors, 0);
  stats.leaks = bots.reduce((s, b) => s + b.leaks, 0);
  stats.finalChips = host.state.room.players.map((p) => p.chips);
  stats.chipTotal = stats.finalChips.reduce((a, b) => a + b, 0);
  stats.expectedTotal = START * nPlayers;
  bots.forEach((b) => b.sock.disconnect());
  return stats;
}

(async () => {
  let srv;
  if (!URL) {
    process.env.AUTO_MS = '100';
    const { server, rooms } = require('../server');
    ROOMS = rooms;
    await new Promise((r) => server.listen(0, r));
    URL = `http://localhost:${server.address().port}`;
    srv = server;
  }
  const t0 = Date.now();
  const per = Math.ceil(ROUNDS / 4);
  const jobs = [
    ['섯다 2인', runRoom('seotda', 2, per, 'sd2')],
    ['섯다 3인', runRoom('seotda', 3, per, 'sd3')],
    ['섯다 4인', runRoom('seotda', 4, per, 'sd4')],
    ['섯다 5인', runRoom('seotda', 5, ROUNDS - per * 3, 'sd5')],
    ['맞고 (보너스O)', runRoom('matgo', 2, ROUNDS / 2, 'mg')],
    ['맞고 (보너스X)', runRoom('matgo', 2, ROUNDS / 2, 'mgx', { bonus: false })],
    ['고스톱 (보너스O)', runRoom('gostop', 3, ROUNDS / 2, 'gs')],
    ['고스톱 (보너스X)', runRoom('gostop', 3, ROUNDS / 2, 'gsx', { bonus: false })],
    ['이탈자 자동진행 고스톱', runRoom('gostop', 3, 3, 'ab', { abandon: true })],
    ['이탈자 자동진행 섯다', runRoom('seotda', 4, 5, 'abs', { abandon: true })],
  ];
  let fail = false;
  const summary = {};
  for (const [name, p] of jobs) {
    const s = await p;
    summary[name] = s;
    const ok = !s.stuck && !s.invalidAccepted && s.conservationFail === 0 && s.leaks === 0 && s.chipTotal === s.expectedTotal;
    if (!ok) fail = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${s.rounds}판 완료, 결과 ${JSON.stringify(s.results)}, 칩합계 ${s.chipTotal}/${s.expectedTotal}, 보존실패 ${s.conservationFail}, 정보누출 ${s.leaks}, 재접속 ${s.reconnects}, 거부된 부정행동 ${s.invalidRejected}, 거부된 봇 행동 ${s.errors}${s.stuck ? ', STUCK' : ''}`);
  }
  const tot = (f) => Object.values(summary).reduce((a, s) => a + f(s), 0);
  const sdR = ['섯다 2인', '섯다 3인', '섯다 4인', '섯다 5인'].reduce((a, k) => a + summary[k].rounds, 0);
  const mgR = summary['맞고 (보너스O)'].rounds + summary['맞고 (보너스X)'].rounds;
  const gsR = summary['고스톱 (보너스O)'].rounds + summary['고스톱 (보너스X)'].rounds;
  console.log(`\n총계: 섯다 ${sdR}판, 맞고 ${mgR}판, 고스톱 ${gsR}판 / 재접속 ${tot((s) => s.reconnects)}회 / ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  console.log(fail ? 'SIMULATION FAILED' : 'SIMULATION PASSED');
  if (srv) srv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
