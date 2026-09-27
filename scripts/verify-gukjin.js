// 국진 선택 창 확인: 임시 서버(포트 3397, 같은 프로세스)에서 AI 맞고 → 내 차례에 9월 피로 바닥 국진을 먹게 패를 맞춰 둠
// → '국진을 어떻게 쓸까요?' 창(360x640 안에 들어오는지) → 5초 뒤 자동 쌍피 → 먹은 패 피 묶음에 '쌍피' 표시
// 스크린샷: screenshots/gukjin-choice.png, screenshots/gukjin-captured.png
const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-gukjin-'));
process.env.ACCOUNTS_FILE = path.join(dir, 'a.json'); process.env.ADMIN_KEY = ''; delete process.env.DATABASE_URL;
const puppeteer = require('puppeteer-core');
const { io: ioc } = require('socket.io-client');
const { server, io, rooms } = require('../server');
const { login, authAs } = require('./_login');
const PORT = 3397, URL = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {}, errors = [];
const GUK = 32, SEP_PI = 34;
(async () => {
  await new Promise((r) => server.listen(PORT, r));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(URL, { waitUntil: 'networkidle0' });
    await login(p, '국진확인', '1234');
    await p.waitForSelector('[data-game="matgo"]'); await p.click('[data-game="matgo"]'); await sleep(200);
    await p.click('[data-act="solo"]');
    await p.waitForSelector('.mine', { timeout: 15000 });
    const room = [...rooms.values()].find((r) => r.players.some((x) => x.id === 'u:국진확인'));
    const e = room.engine;
    const me = e.seatOf('u:국진확인');
    for (let k = 0; k < 200 && !(e.turn === me && e.phase === 'play'); k++) await sleep(100);
    await sleep(1500);
    // 패 맞추기: 국진은 바닥 첫 장 자리로, 9월 피는 내 손 첫 장 자리로 (같은 달 다른 장은 바닥에 없게)
    const arrs = () => [e.floor, e.deck, ...e.players.flatMap((q) => [q.hand, q.captured])];
    const loc = (id) => { for (const a of arrs()) { const i = a.indexOf(id); if (i >= 0) return [a, i]; } return null; };
    const swap = (x, y) => { const [a, i] = loc(x), [b, j] = loc(y); a[i] = y; b[j] = x; };
    swap(GUK, e.floor[0]);
    swap(SEP_PI, e.players[me].hand[0]);
    for (const other of [33, 35]) { const l = loc(other); if (l && l[0] === e.floor) swap(other, e.deck[0]); }
    const s = ioc(URL, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.on('connect', r));
    await authAs(s, p);
    await new Promise((r) => s.emit('joinRoom', { code: room.code }, r));
    await new Promise((r) => s.emit('action', { type: 'play', card: SEP_PI, floorCard: GUK }, r));
    if (e.phase === 'chooseFlip') await new Promise((r) => s.emit('action', { type: 'chooseFlip', floorCard: e.pending.choices[0] }, r));
    out.enginePhase = e.phase === 'gukjin';
    await p.waitForSelector('.gk-modal', { timeout: 4000 });
    await sleep(400);
    out.popupText = await p.$eval('.gk-modal', (m) => m.innerText.includes('국진을 어떻게 쓸까요?') && m.innerText.includes('쌍피로 (기본)') && m.innerText.includes('열끗으로'));
    out.popupFits = await p.$eval('.gk-modal', (m) => { const b = m.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight && b.right <= innerWidth; });
    await p.screenshot({ path: path.join(SHOTS, 'gukjin-choice.png') });
    await p.waitForFunction(() => !document.querySelector('.gk-modal'), { timeout: 8000 });
    out.autoDefaultPi = e.players[me].gukDone === true && e.players[me].gukYeol === false;
    await sleep(800);
    out.capturedBadge = await p.$eval('.mine .card.gukjin .tb.gk', (t) => t.textContent === '쌍피').catch(() => false);
    out.noScroll = await p.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1);
    await p.screenshot({ path: path.join(SHOTS, 'gukjin-captured.png') });
    s.close();
  } catch (err) { errors.push(err.stack || String(err)); }
  if (browser) await browser.close();
  for (const r of rooms.values()) if (r.timer) clearTimeout(r.timer);
  io.close(); server.close();
  console.log(JSON.stringify(out, null, 1));
  const bad = Object.entries(out).filter(([, v]) => v !== true).map(([k]) => k);
  console.log('ERRORS:', errors.concat(bad).join(' | ') || 'none');
  process.exit(errors.length || bad.length ? 1 : 0);
})();
