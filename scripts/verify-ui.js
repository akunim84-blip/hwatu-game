// 폰 화면 검증: 한 화면 맞춤(스크롤 없음) + 패 돌리기/패 내기 애니메이션 스크린샷 + 콘솔 에러 확인
// 사용법: node scripts/verify-ui.js [baseUrl] [파일이름 접두어]
const puppeteer = require('puppeteer-core');
const { login, authAs, pidOf } = require('./_login');
const { io } = require('socket.io-client');
const path = require('path');
const fs = require('fs');
const BASE = process.argv[2] || 'http://localhost:3300';
const PREFIX = process.argv[3] || '';
const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZES = [[360, 640], [390, 844], [412, 915], [390, 700], [844, 390]]; // 390x700 ≈ 카톡 인앱 상/하단 바 제외 높이

function socketBot(name) {
  const b = { pid: 'vbot-' + name + Math.random().toString(36).slice(2, 6), name, lastSeq: -1, lastRound: -1 };
  b.sock = io(BASE, { transports: ['websocket'], forceNew: true });
  b.emit = (e, d) => new Promise((r) => b.sock.emit(e, d, r));
  b.paused = false;
  b.sock.on('state', (st) => {
    const g = st.game;
    if (!g || g.result || st.room.actSeq === b.lastSeq) return;
    let a = null;
    if (g.kind === 'seotda') {
      const o = g.options || [];
      if (o.length) a = { type: (o.find((x) => x.type === 'call') || o.find((x) => x.type === 'check') || o.find((x) => x.type === 'bbing')).type };
    } else if (g.options) {
      const o = g.options;
      if (o.phase === 'play') {
        const c = o.cards.find((x) => x.matches && x.matches.length) || o.cards[0];
        a = c ? { type: 'play', card: c.id, floorCard: c.matches && c.matches[0] } : { type: 'flipOnly' };
      } else if (o.phase === 'chooseFlip') a = { type: 'chooseFlip', floorCard: o.choices[0] };
      else if (o.phase === 'goStop') a = { type: 'go' };
    }
    if (!a) return;
    b.lastSeq = st.room.actSeq;
    const first = st.room.round !== b.lastRound; b.lastRound = st.room.round;
    setTimeout(() => b.emit('action', a), first ? 3000 : 350);
  });
  return b;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR', '--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  const report = { layout: [], shots: [], errors };
  const newPage = async (label) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    p.on('response', (r) => { if (r.status() >= 400) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
    p.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.0');
    return p;
  };
  const shot = async (p, name) => { const f = path.join(OUT, PREFIX + name + '.png'); await p.screenshot({ path: f }); report.shots.push(f); console.log('saved', f); };
  const tap = async (p, sel) => { await p.waitForSelector(sel, { timeout: 8000 }); await p.$eval(sel, (el) => el.click()); };
  const myTurn = (p) => p.evaluate(() => !!(document.querySelector('.turnbar') && !document.querySelector('.turnbar.wait') && (document.querySelector('.hand .card') || document.querySelector('[data-bet]'))));
  async function autoplay(page, onlyModal) {
    return page.evaluate(async (onlyModal) => {
      const q = (s) => document.querySelector(s);
      if (q('[data-gs]')) { q('[data-gs="go"]').click(); return 'gs'; }
      if (q('[data-flipc]')) { q('[data-flipc]').click(); return 'flip'; }
      if (q('[data-choose]')) { q('[data-choose]').click(); return 'choose'; }
      if (q('[data-shake="0"]')) { q('[data-shake="0"]').click(); return 'shake'; }
      if (onlyModal) return null;
      const bet = q('[data-bet="call"]') || q('[data-bet="check"]') || q('[data-bet="bbing"]');
      if (bet) { bet.click(); return 'bet'; }
      if (q('.turnbar') && !q('.turnbar.wait')) {
        const c = q('.hand .card.hl') || q('.hand .card');
        if (c) { c.click(); await new Promise((r) => setTimeout(r, 80)); const again = q('.hand .card.sel'); if (again) again.click(); return 'play'; }
        const f = q('[data-act="flipOnly"]'); if (f) { f.click(); return 'flipOnly'; }
      }
      return null;
    }, onlyModal);
  }
  const measure = (p) => p.evaluate(() => { const se = document.scrollingElement; const app = document.getElementById('app'); return { sh: Math.max(se.scrollHeight, app.scrollHeight + app.getBoundingClientRect().top), ih: innerHeight, sw: se.scrollWidth, iw: innerWidth, u: getComputedStyle(document.getElementById('app')).getPropertyValue('--u').trim(), caps: document.querySelectorAll('.caps .card').length }; });

  for (const [game, n] of [['seotda', 5], ['matgo', 2], ['gostop', 3]]) {
    const p = await newPage(game);
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await login(p, '민수');
    await tap(p, `[data-game="${game}"]`);
    await tap(p, '[data-act="create"]');
    await p.waitForSelector('.code-big');
    const code = await p.$eval('.code-big', (el) => el.textContent.trim());
    const bots = [];
    const names = ['지영', '철수', '영희', '동훈'];
    for (let i = 0; i < n - 1; i++) {
      const b = socketBot(names[i]);
      await new Promise((r) => b.sock.on('connect', r));
      await b.emit('joinRoom', { code, pid: b.pid, name: names[i] });
      bots.push(b);
    }
    await sleep(300);
    await p.evaluate(() => document.body.click()); // 첫 탭 → 오디오 unlock
    await tap(p, '[data-act="start"]');
    await sleep(game === 'seotda' ? 700 : 900);
    await shot(p, `deal-anim-${game}`);
    await sleep(2200);
    async function measureAll(phase, shots) {
      for (const [w, h] of SIZES) {
        await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await sleep(450);
        const m = await measure(p);
        const ok = m.sh <= m.ih && m.sw <= m.iw;
        report.layout.push({ game, phase, size: `${w}x${h}`, ...m, ok });
        console.log(game, phase, `${w}x${h}`, JSON.stringify(m), ok ? 'OK' : 'OVERFLOW');
        if (shots) await shot(p, `layout-${game}-${w}x${h}`);
        else if (w === 390 && h === 844) await shot(p, `layout-${game}-early-390x844`);
      }
      await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await sleep(450);
    }
    await measureAll('early', false);
    // 바쁜 중반 상태까지 진행
    let found = false;
    for (let k = 0; k < 600 && !found; k++) {
      if (await p.$('.modal .delta')) { await tap(p, '[data-act="next"]'); await sleep(3200); continue; }
      if (await myTurn(p)) {
        if (game === 'seotda') { found = true; break; }
        const caps = await p.evaluate(() => document.querySelectorAll('.caps .card').length);
        const hand = await p.evaluate(() => document.querySelectorAll('.hand .card').length);
        if (caps >= (game === 'matgo' ? 16 : 18) && hand >= 2) { found = true; break; }
        await autoplay(p);
      } else await autoplay(p, true);
      await sleep(250);
    }
    await sleep(900);
    // 카드 하나 선택 (매칭 하이라이트)
    await p.evaluate(() => { const c = document.querySelector('.hand .card.hl') || document.querySelector('.hand .card'); if (c) c.click(); });
    await sleep(200);
    await measureAll('busy', true);
    if (game !== 'seotda' && found) {
      // 패 내기: 비행 중 + 착지 후
      await p.evaluate(() => { const c = document.querySelector('.hand .card.sel'); if (c) c.click(); else { const d = document.querySelector('.hand .card'); if (d) { d.click(); setTimeout(() => { const e = document.querySelector('.hand .card.sel'); if (e) e.click(); }, 50); } } });
      await sleep(170);
      await shot(p, `play-anim-${game}`);
      await sleep(1000);
      await autoplay(p, true);
      await sleep(300);
      await shot(p, `after-play-${game}`);
    }
    bots.forEach((b) => b.sock.disconnect());
    await p.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT, PREFIX + 'verify-report.json'), JSON.stringify(report, null, 1));
  console.log('ERRORS:', errors.length ? errors : 'none');
  console.log('LAYOUT_ALL_OK:', report.layout.filter((x) => !x.size.startsWith('844')).every((x) => x.ok));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
