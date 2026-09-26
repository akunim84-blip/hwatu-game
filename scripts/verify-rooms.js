// 진행 중인 방 목록 · 관전 · AI 자리 넘겨받기 헤드리스 검증 + 스크린샷
// 사용법: node scripts/verify-rooms.js   (서버를 이 프로세스 안에서 띄움)
process.env.AI_DELAY_SCALE = process.env.AI_DELAY_SCALE || '0.3';
if (!process.env.ACCOUNTS_FILE) process.env.ACCOUNTS_FILE = require('path').join(require('os').tmpdir(), 'hwatu-verify-accounts.json');
const puppeteer = require('puppeteer-core');
const { login, authAs, pidOf } = require('./_login');
const { io } = require('socket.io-client');
const path = require('path');
const { server, rooms } = require('../server');
const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, r));
  const BASE = `http://localhost:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
  const errors = [], report = {};
  const newPage = async (label, w = 390, h = 844) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
    p.on('response', (r) => { if (r.status() >= 400) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    return p;
  };
  const shot = async (p, name) => { await p.evaluate(() => { const t = document.getElementById('toasts'); if (t) t.innerHTML = ''; }); const f = path.join(OUT, name + '.png'); await p.screenshot({ path: f }); console.log('saved', f); };
  const tap = async (p, sel) => { await p.waitForSelector(sel, { timeout: 10000 }); await p.$eval(sel, (el) => el.click()); };
  const fits = (p) => p.evaluate(() => { const se = document.scrollingElement, app = document.getElementById('app'); return Math.max(se.scrollHeight, app.scrollHeight) <= innerHeight && se.scrollWidth <= innerWidth; });

  // 0) 첫 화면 로그인 (닉네임 + PIN)
  const L = await newPage('L');
  await L.goto(BASE, { waitUntil: 'networkidle0' });
  await L.waitForSelector('#pin');
  await L.$eval('#nick', (el) => { el.value = '새친구'; });
  await shot(L, 'login');
  report.loginFits = await fits(L);
  await login(L, '새친구', '4455');
  report.newAccount = await L.evaluate(() => ({ money: document.querySelector('.mymoney').innerText, token: !!localStorage.getItem('hw_token'), notice: document.querySelector('.notice').innerText.split('\n')[0], rank: !!document.getElementById('rank-list') }));
  // 새로고침 → 토큰으로 자동 로그인 (PIN 다시 안 물어봄)
  await L.reload({ waitUntil: 'networkidle0' });
  await L.waitForSelector('[data-act="solo"]', { timeout: 5000 });
  report.autoLogin = await L.evaluate(() => document.querySelector('.acct').innerText.replace(/\s+/g, ' '));
  // 틀린 PIN
  const W = await newPage('W');
  await W.goto(BASE, { waitUntil: 'networkidle0' });
  await W.waitForSelector('#pin');
  await W.$eval('#nick', (el) => { el.value = '새친구'; }); await W.$eval('#pin', (el) => { el.value = '0000'; });
  await W.$eval('[data-act="enter"]', (el) => el.click());
  await sleep(600);
  report.wrongPin = await W.evaluate(() => ({ stillLogin: !!document.getElementById('pin'), toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|') }));
  await W.close(); await L.close();

  // 1) 방장 A: 맞고 AI와 바로 하기 (공개)
  const A = await newPage('A');
  await A.goto(BASE, { waitUntil: 'networkidle0' });
  await login(A, '민수');
  await tap(A, '[data-game="matgo"]');
  await tap(A, '[data-act="solo"]');
  await A.waitForSelector('.floor');
  const code = await A.evaluate(() => localStorage.getItem('hw_room'));
  const aPid = await pidOf(A);
  // 친구방(대기실)도 하나
  const F = await newPage('F');
  await F.goto(BASE, { waitUntil: 'networkidle0' });
  await login(F, '지수');
  await tap(F, '[data-game="gostop"]');
  await tap(F, '[data-act="create"]');
  await F.waitForSelector('[data-act="addAI"]');
  await tap(F, '[data-act="addAI"]'); await sleep(200);
  await shot(F, 'lobby-money');
  report.lobbyMoney = await F.evaluate(() => ({ mine: document.querySelector('.mymoney').innerText, players: [...document.querySelectorAll('.plist li')].map((e) => e.innerText.replace(/\s+/g, ' ')), stake: document.querySelector('.panel .muted').innerText }));
  report.lobbyFits = await fits(F);

  // 2) 손님 B: 첫 화면에 진행 중인 방 목록 (실시간)
  const B = await newPage('B');
  await B.goto(BASE, { waitUntil: 'networkidle0' });
  await login(B, '영희');
  await B.waitForSelector(`[data-room="${code}"]`, { timeout: 5000 });
  await B.waitForFunction(() => document.querySelectorAll('.room-item').length >= 2, { timeout: 5000 });
  await B.evaluate(() => document.querySelector('.acct').scrollIntoView({ block: 'start' }));
  await sleep(200);
  await shot(B, 'room-list');
  report.list = await B.evaluate(() => [...document.querySelectorAll('.room-item')].map((e) => e.innerText.replace(/\s+/g, ' ')));
  // 실시간: 새 방이 생기면 새로고침 없이 추가되는지
  const n0 = report.list.length;
  const G = await newPage('G');
  await G.goto(BASE, { waitUntil: 'networkidle0' });
  await login(G, '비공개맨');
  await G.$eval('[data-priv="1"]', (el) => el.click());
  await tap(G, '[data-act="solo"]'); // 비공개 → 목록에 안 나와야 함
  await sleep(700);
  report.privateHidden = (await B.$$eval('.room-item', (x) => x.length)) === n0;
  await tap(F, '[data-act="addAI"]'); // 친구방 인원 변화 → 목록 갱신
  await sleep(700);
  report.liveUpdate = await B.evaluate(() => [...document.querySelectorAll('.room-item')].map((e) => e.innerText.replace(/\s+/g, ' ')).find((t) => t.includes('지수')));

  // 3) B가 A의 방을 눌러 참여 → 게임 중이므로 관전 (다음 판부터 참여)
  await B.$eval(`[data-room="${code}"]`, (el) => el.click());
  await B.waitForSelector('.turnbar.spec', { timeout: 5000 });
  await sleep(3200); // 입장 토스트가 사라진 뒤
  await shot(B, 'spectate');
  report.spectate = await B.evaluate(() => ({
    bar: document.querySelector('.turnbar.spec').innerText,
    hand: !!document.querySelector('.hand'), mine: !!document.querySelector('.mine'),
    faceUpHandCards: document.querySelectorAll('[data-hand]').length,
    opps: document.querySelectorAll('.opp').length,
    watermark: getComputedStyle(document.getElementById('app'), '::before').content,
  }));
  report.spectateFits = await fits(B);
  await B.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await sleep(500);
  report.spectateFits360 = await fits(B);
  await B.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const bPid = await pidOf(B);
  const room = rooms.get(code);
  report.serverSpectators = room.spectators.map((x) => ({ name: x.name, waiting: x.waiting }));

  // 4) A 대신 판을 빨리 끝내기 (같은 pid의 보조 소켓이 자동으로 둠) → 결과 때 B가 AI 자리를 넘겨받음
  const s = io(BASE, { transports: ['websocket'] });
  await new Promise((r) => s.on('connect', r));
  await authAs(s, A);
  await new Promise((r) => s.emit('joinRoom', { code, pid: aPid, name: '민수' }, r));
  const cbk = (r) => { if (r && !r.ok) errors.push('helper act: ' + r.error); };
  const step = (st) => {
    const o = st.game && st.game.options;
    if (!o || st.game.result) return;
    if (o.phase === 'play') { const k = o.cards[0]; s.emit('action', k ? { type: 'play', card: k.id, floorCard: k.matches ? k.matches[0] : undefined } : { type: 'flipOnly' }, cbk); }
    else if (o.phase === 'goStop') s.emit('action', { type: 'stop' }, cbk);
    else if (o.phase === 'chooseFlip') s.emit('action', { type: 'chooseFlip', floorCard: o.choices[0] }, cbk);
    else errors.push('helper phase ' + o.phase);
  };
  s.on('state', step);
  step({ game: room.engine.view(aPid) });
  await B.waitForFunction((bp) => !!document.querySelector('.modal-bg') && document.body.innerText.includes('이제 참여'), { timeout: 60000 }, bPid).catch(() => {});
  report.promoted = { players: room.players.map((p) => p.name + (p.ai ? '(AI)' : '')), status: room.status, spectators: room.spectators.length };
  await shot(B, 'spectate-promoted');
  s.close();
  await tap(A, '[data-act="next"]');
  await B.waitForSelector('.hand [data-hand]', { timeout: 8000 }).catch(() => {});
  report.nextRound = { bHasHand: await B.$$eval('.hand [data-hand]', (x) => x.length), engineHasB: room.engine.seatOf(bPid) >= 0 };

  // 5) 사람으로 꽉 찬 방 → C는 관전만
  const C = await newPage('C');
  await C.goto(BASE + '/?room=' + code, { waitUntil: 'networkidle0' });
  await login(C, '철수');
  await tap(C, '[data-act="joinUrl"]');
  await C.waitForSelector('.turnbar.spec', { timeout: 5000 });
  report.watchOnly = await C.evaluate(() => ({ bar: document.querySelector('.turnbar.spec').innerText, hand: document.querySelectorAll('[data-hand]').length }));
  await tap(C, '.actbar [data-act="leave"]');
  await C.waitForSelector('#room-list', { timeout: 5000 });
  report.leftSpectate = room.spectators.length === 0;

  await browser.close();
  console.log(JSON.stringify(report, null, 1));
  console.log('ERRORS:', errors.length ? errors : 'none');
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
