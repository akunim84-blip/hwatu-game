// 맞고/고스톱 셔플·한 장씩 돌리기·족보 힌트 헤드리스 검증 + 스크린샷 (390x844)
// 서버를 이 프로세스 안에서 띄워, 힌트 화면 확인용으로 판 상태를 직접 구성한다 (테스트 전용).
// 사용법: node scripts/verify-matgo.js
process.env.AI_DELAY_SCALE = process.env.AI_DELAY_SCALE || '1';
const puppeteer = require('puppeteer-core');
const { io } = require('socket.io-client');
const path = require('path');
const { server, rooms } = require('../server');
const { HWATU } = require('../shared/cards');
const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (m, i) => (m - 1) * 4 + i;

// 판 상태 구성: 지정한 카드 배치 + 나머지는 남은 카드로 채움
function rig(e, spec) {
  const used = new Set();
  const take = (arr) => arr.map((x) => { used.add(x); return x; });
  const fixed = { hands: spec.hands.map(take), caps: spec.caps.map(take), floor: take(spec.floor) };
  if (spec.flip != null) used.add(spec.flip);
  const rest = HWATU.filter((c) => !c.bonus && !used.has(c.id)).map((c) => c.id).sort(() => Math.random() - 0.5);
  e.players.forEach((p, i) => {
    p.hand = fixed.hands[i].slice(); while (p.hand.length < spec.handSize[i]) p.hand.push(rest.pop());
    p.captured = fixed.caps[i].slice();
  });
  e.floor = fixed.floor.slice(); while (e.floor.length < spec.floorSize) e.floor.push(rest.pop());
  e.deck = rest;
  if (spec.flip != null) e.deck.push(spec.flip); // pop() = 다음에 뒤집을 패
  e.turn = 0; e.phase = 'play'; e.pending = null;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const BASE = `http://localhost:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
  const errors = [], report = {};
  const newPage = async (label) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
    p.on('response', (r) => { if (r.status() >= 400) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    return p;
  };
  const shot = async (p, name) => { const f = path.join(OUT, name + '.png'); await p.screenshot({ path: f }); console.log('saved', f); };
  const tap = async (p, sel) => { await p.waitForSelector(sel, { timeout: 10000 }); await p.$eval(sel, (el) => el.click()); };
  const measure = (p) => p.evaluate(() => { const se = document.scrollingElement, app = document.getElementById('app'); return { sh: Math.max(se.scrollHeight, app.scrollHeight), ih: innerHeight, sw: se.scrollWidth, iw: innerWidth }; });

  {
    const p = await newPage('landing');
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await p.evaluate(() => document.fonts.ready);
    await shot(p, 'brand-landing');
    report.brand = await p.evaluate(() => ({ title: document.title, og: document.querySelector('meta[property="og:title"]').content, logoFont: document.fonts.check('42px HyukLogo', '혁게임') }));
    await p.close();
  }
  for (const game of ['matgo', 'gostop']) {
    const p = await newPage(game);
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await p.$eval('#nick', (el) => { el.value = '민수'; });
    await tap(p, `[data-game="${game}"]`);
    await tap(p, '[data-act="solo"]');
    await p.waitForSelector('.floor', { timeout: 10000 });
    const t0 = Date.now();
    await sleep(430);
    await shot(p, `shuffle-${game}`);
    const piles = await p.evaluate(() => document.querySelectorAll('.shuffle-pile .sp').length);
    await sleep(1500);
    await shot(p, `deal-${game}`);
    const midDeal = await p.evaluate(() => ({ flyers: document.querySelectorAll('.flyer').length, hidden: document.querySelectorAll('.fx-hide').length }));
    // 끝까지 기다렸다가 전부 보이는지
    await p.waitForFunction(() => !document.querySelector('.fx-hide') && !document.querySelector('.shuffle-pile'), { timeout: 6000 });
    const dealMs = Date.now() - t0;
    // 두 번째 판에서 탭으로 건너뛰기 검증은 아래에서
    // --- 힌트 상태 구성 ---
    const code = await p.evaluate(() => localStorage.getItem('hw_room'));
    const myPid = await p.evaluate(() => localStorage.getItem('hw_pid'));
    const room = rooms.get(code);
    const e = room.engine;
    if (game === 'matgo') {
      rig(e, {
        handSize: [7, 7], floorSize: 6,
        // 나: 홍단 2장(1·2월 띠) + 광 1 + 피, 손에 3월 띠(홍단 완성용), 10월 열끗(상대 청단 막기용)
        caps: [[id(1, 1), id(2, 1), id(1, 0), id(1, 2), id(2, 2), id(5, 2), id(5, 3), id(6, 2)], [id(6, 1), id(9, 1), id(3, 0), id(8, 0), id(4, 2), id(4, 3), id(12, 3), id(7, 0), id(2, 0)]],
        hands: [[id(3, 1), id(10, 0), id(4, 0)], []],
        floor: [id(10, 1), id(3, 2), id(8, 1)],
        flip: id(10, 2), // 뒤집은 패로 10월 띠(청단)도 먹음
      });
    } else {
      rig(e, {
        handSize: [5, 5, 5], floorSize: 5,
        caps: [[id(1, 1), id(2, 1), id(1, 2), id(5, 2)], [id(6, 1), id(9, 1), id(7, 2)], [id(2, 0), id(4, 0), id(11, 0), id(3, 0), id(12, 3)]],
        hands: [[id(3, 1), id(10, 0), id(8, 1)], [], []],
        floor: [id(10, 1), id(3, 2), id(8, 2)],
        flip: id(10, 2),
      });
    }
    // 같은 pid로 소켓 하나 더 붙여서 상태 방송 유도
    const s = io(BASE, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.on('connect', r));
    await new Promise((r) => s.emit('joinRoom', { code, pid: myPid, name: '민수' }, r));
    await sleep(700);
    const hints = await p.evaluate(() => ({
      badges: [...document.querySelectorAll('.bdg .b')].map((b) => b.textContent + (b.classList.contains('done') ? '✓' : '')),
      handTags: [...document.querySelectorAll('.hand .card .ht')].map((t) => t.textContent),
      warns: [...document.querySelectorAll('.warn')].map((w) => w.textContent),
      blockFloor: document.querySelectorAll('.floor .card.blk').length,
    }));
    report[game] = { shufflePileCards: piles, midDeal, dealDoneMs: dealMs, hints };
    await p.evaluate(() => { const c = document.querySelector('.hand .card .ht.near'); if (c) c.closest('.card').click(); });
    await sleep(250);
    await shot(p, `hints-${game}`);
    report[game].layout = {};
    for (const [w, h] of [[360, 640], [390, 700], [390, 844], [412, 915], [844, 390]]) {
      await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await sleep(450);
      const m = await measure(p);
      report[game].layout[`${w}x${h}`] = m.sh <= m.ih && m.sw <= m.iw ? 'OK' : `OVERFLOW ${JSON.stringify(m)}`;
      if (game === 'matgo' && (w === 360 || w === 844)) await shot(p, `hints-${game}-${w}x${h}`);
    }
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await sleep(450);
    // 3월 띠를 내서 홍단 완성 → 토스트
    await p.evaluate(() => { const c = [...document.querySelectorAll('.hand .card')].find((x) => x.querySelector('.ht.near')); if (c) { c.click(); setTimeout(() => { const s = document.querySelector('.hand .card.sel'); if (s) s.click(); }, 60); } });
    if (process.env.DBG_AI) { const tl = await p.evaluate(() => new Promise((res) => { const out = []; const t0 = performance.now(); const iv = setInterval(() => { out.push(Math.round(performance.now() - t0) + ':' + document.querySelectorAll('.flyer').length + '/' + document.querySelectorAll('.flyer.ghostc').length + '/' + document.querySelectorAll('[data-cap].fx-hide').length); if (out.length > 26) { clearInterval(iv); res(out.join(' ')); } }, 100); })); console.log('TL', tl); }
    await sleep(1230);
    await shot(p, `capture-anim-${game}`);
    report[game].captureMid = await p.evaluate(() => ({ ghosts: document.querySelectorAll('.flyer.ghostc').length, glow: document.querySelectorAll('.flyer.cap-glow').length, hiddenCaps: document.querySelectorAll('[data-cap].fx-hide').length }));
    await sleep(500);
    report[game].toasts = await p.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
    await shot(p, `settoast-${game}`);
    report[game].captureDone = await p.evaluate(() => ({ ghosts: document.querySelectorAll('.flyer.ghostc').length, hiddenCaps: document.querySelectorAll('[data-cap].fx-hide').length }));
    if (game === 'matgo') {
      await sleep(1500);
      const mm = await p.$('[data-gs]'); if (mm) { await p.$eval('[data-gs="go"]', (el) => el.click()); await sleep(300); }
      // 쪽 → 피 뺏기
      rig(e, {
        handSize: [5, 5], floorSize: 5,
        caps: [[id(1, 1), id(2, 1)], [id(9, 2), id(9, 3), id(11, 1), id(6, 1)]],
        hands: [[id(5, 0), id(6, 2), id(7, 2)], []],
        floor: [id(1, 2), id(2, 2), id(4, 3)],
        flip: id(5, 2),
      });
      await new Promise((r) => s.emit('joinRoom', { code, pid: myPid, name: '민수' }, r));
      await sleep(600);
      await shot(p, 'brand-mat-matgo');
      await p.evaluate(() => { const c = document.querySelector('.hand [data-hand="16"]'); c.click(); setTimeout(() => { const x = document.querySelector('.hand .card.sel'); if (x) x.click(); }, 60); });
      await sleep(1620);
      await shot(p, 'steal-anim-matgo');
      report.steal = await p.evaluate(() => ({ ghostT: [...document.querySelectorAll('.flyer')].map((e) => e.className + ' ' + e.title), stealGlow: document.querySelectorAll('.flyer.steal-glow').length, hiddenCaps: document.querySelectorAll('[data-cap].fx-hide').length }));
      await sleep(900);
      report.stealDone = await p.evaluate(() => ({ ghostT: [...document.querySelectorAll('.flyer.ghostc')].map((e) => e.title + '@' + e.style.transform + '|' + e.getAnimations().map((a) => a.playState).join(',')), hid: [...document.querySelectorAll('[data-cap].fx-hide')].map((e) => e.dataset.cap), ghosts: document.querySelectorAll('.flyer.ghostc').length, hiddenCaps: document.querySelectorAll('[data-cap].fx-hide').length, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }));
    }
    s.close();
    await p.close();
  }

  // 탭으로 돌리기 건너뛰기 + AI가 돌리기 끝날 때까지 기다리는지
  {
    const p = await newPage('skip');
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await p.$eval('#nick', (el) => { el.value = '민수'; });
    await tap(p, '[data-game="matgo"]');
    await tap(p, '[data-act="solo"]');
    await p.waitForSelector('.floor');
    await sleep(800);
    await p.touchscreen.tap(200, 400);
    await sleep(150);
    report.skip = await p.evaluate(() => ({ hidden: document.querySelectorAll('.fx-hide').length, pile: !!document.querySelector('.shuffle-pile'), flyers: document.querySelectorAll('.flyer').length, sel: !!document.querySelector('.hand .card.sel') }));
    await p.close();
  }
  await browser.close();
  console.log(JSON.stringify(report, null, 1));
  console.log('ERRORS:', errors.length ? errors : 'none');
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
