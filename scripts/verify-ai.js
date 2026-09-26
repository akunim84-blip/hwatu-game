// AI 대전 헤드리스 검증 (390x844): 게임별 'AI와 바로 하기' → 한 판 끝까지, 로비 AI 추가, 친구+AI 혼합, 새로고침 재접속
// 사용법: node scripts/verify-ai.js [baseUrl]
const puppeteer = require('puppeteer-core');
const { login, authAs, pidOf } = require('./_login');
const { io } = require('socket.io-client');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3300';
const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
  const errors = [], report = [];
  const newPage = async (label) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
    p.on('response', (r) => { if (r.status() >= 400) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.0');
    return p;
  };
  const shot = async (p, name) => { const f = path.join(OUT, name + '.png'); await p.screenshot({ path: f }); console.log('saved', f); };
  const tap = async (p, sel) => { await p.waitForSelector(sel, { timeout: 10000 }); await p.$eval(sel, (el) => el.click()); };
  const step = (p) => p.evaluate(async () => {
    const q = (s) => document.querySelector(s);
    if (q('.modal .delta')) return 'result';
    if (q('[data-gs]')) { q('[data-gs="stop"]').click(); return 'gs'; }
    if (q('[data-flipc]')) { q('[data-flipc]').click(); return 'flip'; }
    if (q('[data-choose]')) { q('[data-choose]').click(); return 'choose'; }
    if (q('[data-shake]')) { q('[data-shake="1"]').click(); return 'shake'; }
    const bet = q('[data-bet="call"]') || q('[data-bet="check"]') || q('[data-bet="bbing"]');
    if (bet) { bet.click(); return 'bet'; }
    if (q('.turnbar') && !q('.turnbar.wait')) {
      const c = q('.hand .card.hl') || q('.hand .card:not(.dim)');
      if (c) { c.click(); await new Promise((r) => setTimeout(r, 100)); const s = q('.hand .card.sel'); if (s) s.click(); return 'play'; }
      const f = q('[data-act="flipOnly"]'); if (f) { f.click(); return 'flipOnly'; }
    }
    return null;
  });
  const measure = (p) => p.evaluate(() => { const se = document.scrollingElement, app = document.getElementById('app'); return { sh: Math.max(se.scrollHeight, app.scrollHeight), ih: innerHeight, sw: se.scrollWidth, iw: innerWidth }; });

  // 1) 게임별 AI와 바로 하기 → 한 판 끝까지
  for (const game of ['gostop', 'matgo', 'seotda']) {
    const p = await newPage('solo-' + game);
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await login(p, '민수');
    await tap(p, `[data-game="${game}"]`);
    if (game === 'seotda') await tap(p, '[data-aic="3"]');
    if (game === 'seotda') await shot(p, 'ai-landing');
    await tap(p, '[data-act="solo"]');
    await p.waitForSelector(game === 'seotda' ? '.sd-center' : '.floor', { timeout: 10000 });
    const t0 = Date.now();
    let midShot = false, reloaded = false, overflow = 0, steps = 0, aiActs = new Set();
    let lastFloor = '';
    for (let k = 0; k < 1500; k++) {
      const r = await step(p);
      if (r === 'result') break;
      if (r) steps++;
      const m = await measure(p);
      if (m.sh > m.ih || m.sw > m.iw) overflow++;
      // AI가 두는지 확인 (바닥/판돈 변화)
      const sig = await p.evaluate(() => (document.querySelector('.floor') || document.querySelector('.pot') || {}).textContent + document.querySelectorAll('.floor .card').length);
      if (sig !== lastFloor) { aiActs.add(sig); lastFloor = sig; }
      if (!midShot && Date.now() - t0 > (game === 'seotda' ? 4500 : 5500)) { await shot(p, `ai-${game}`); midShot = true; }
      if (!reloaded && Date.now() - t0 > (game === 'seotda' ? 3000 : 7000)) {
        // 새로고침(재접속)해도 이어서 진행되는지
        await p.reload({ waitUntil: 'networkidle0' });
        await p.waitForSelector('.hdr', { timeout: 10000 });
        reloaded = true;
      }
      await sleep(200);
    }
    const done = !!(await p.$('.modal .delta'));
    if (!midShot) await shot(p, `ai-${game}`);
    await sleep(500);
    await shot(p, `ai-${game}-result`);
    const title = await p.evaluate(() => (document.querySelector('.modal h2') || {}).textContent);
    const names = await p.evaluate(() => [...document.querySelectorAll('.modal .delta span:first-child')].map((e) => e.textContent));
    report.push({ game, fullRound: done, secs: Math.round((Date.now() - t0) / 1000), myActions: steps, stateChanges: aiActs.size, overflowSamples: overflow, result: title, players: names });
    console.log(JSON.stringify(report[report.length - 1]));
    // 다음 판도 시작되는지
    if (done) { await tap(p, '[data-act="next"]'); await sleep(1500); report[report.length - 1].nextRoundStarted = !(await p.$('.modal .delta')); }
    await p.close();
  }

  // 2) 로비에서 AI 추가/빼기 + 친구 2명 + AI 1명 고스톱
  const host = await newPage('lobby');
  await host.goto(BASE, { waitUntil: 'networkidle0' });
  await login(host, '민수');
  await tap(host, '[data-game="gostop"]');
  await tap(host, '[data-act="create"]');
  await host.waitForSelector('.code-big');
  const code = await host.$eval('.code-big', (el) => el.textContent.trim());
  await tap(host, '[data-act="addAI"]'); await sleep(300);
  await tap(host, '[data-lv="easy"]'); await tap(host, '[data-act="addAI"]'); await sleep(300);
  const n1 = await host.$$eval('.plist li', (l) => l.length);
  await shot(host, 'ai-lobby');
  await tap(host, '[data-kick][data-ai]'); await sleep(300);
  const n2 = await host.$$eval('.plist li', (l) => l.length);
  // 친구(소켓) 입장 → 2명 + AI 1명
  const friend = io(BASE, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => friend.on('connect', r));
  let fl = -1;
  friend.on('state', (st) => {
    const g = st.game; if (!g || g.result || !g.options || st.room.actSeq === fl) return;
    const o = g.options; let a = null;
    if (o.phase === 'play') { const c = o.cards[0]; a = c ? { type: 'play', card: c.id, floorCard: c.matches && c.matches[0] } : { type: 'flipOnly' }; }
    else if (o.phase === 'chooseFlip') a = { type: 'chooseFlip', floorCard: o.choices[0] };
    else if (o.phase === 'goStop') a = { type: 'stop' };
    if (a) { fl = st.room.actSeq; setTimeout(() => friend.emit('action', a, () => {}), 600); }
  });
  await new Promise((r) => friend.emit('joinRoom', { code, pid: 'friend-' + Date.now(), name: '지영' }, r));
  await sleep(400);
  const n3 = await host.$$eval('.plist li', (l) => l.length);
  await shot(host, 'ai-lobby-mixed');
  await tap(host, '[data-act="start"]');
  let mixedDone = false;
  for (let k = 0; k < 1200; k++) { const r = await step(host); if (r === 'result') { mixedDone = true; break; } await sleep(200); }
  await shot(host, 'ai-gostop-mixed-result');
  report.push({ lobby: { afterAdd2: n1, afterRemove1: n2, afterFriendJoin: n3 }, mixedFullRound: mixedDone });
  friend.close();
  await browser.close();
  console.log(JSON.stringify(report, null, 1));
  console.log('ERRORS:', errors.length ? errors : 'none');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
