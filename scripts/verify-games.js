// 🎮 다른 게임 메뉴 (LINKS_V1) 헤드리스 확인: 버튼 위치(다른 버튼과 안 겹침)·스크롤 없음·메뉴·판 중 확인창·같은 탭 이동
// 외부 주소(itf84.synology.me)는 가로채서 실제로 나가지 않음. 사용: node scripts/verify-games.js (localhost:3300)
const path = require('path');
const puppeteer = require('puppeteer-core');
const { login } = require('./_login');
const URL = process.env.URL || 'http://localhost:3300';
const SHOTS = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {}, errors = [];
const overlaps = (p, sel) => p.evaluate((sel) => {
  const g = document.querySelector('.games-btn').getBoundingClientRect();
  // 제목은 실제 글자 줄 영역(getClientRects)만
  const boxes = (e) => { if (e.matches('.title, .brand, h1')) { const r = document.createRange(); r.selectNodeContents(e); return [...r.getClientRects()]; } return [e.getBoundingClientRect()]; };
  const hit = [...document.querySelectorAll(sel)].filter((e) => !e.classList.contains('games-btn')).filter((e) => boxes(e).some((b) => b.width && !(b.right <= g.left || b.left >= g.right || b.bottom <= g.top || b.top >= g.bottom)));
  return { inView: g.left >= 0 && g.top >= 0 && g.right <= innerWidth && g.bottom <= innerHeight, hits: hit.map((e) => e.className || e.tagName) };
}, sel);
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
  try {
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push('pageerror ' + e.message));
    const navs = [];
    await p.setRequestInterception(true);
    p.on('request', (r) => { if (/itf84\.synology\.me/.test(r.url())) { navs.push(r.url()); r.respond({ status: 200, contentType: 'text/html', body: '<title>ext</title>ok' }); } else r.continue(); });
    await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(URL, { waitUntil: 'networkidle0' });
    // 1) 입장 화면
    const o1 = await overlaps(p, 'button, h1, .title, .brand');
    out.login_button = o1.inView && !o1.hits.length ? true : o1;
    await p.screenshot({ path: path.join(SHOTS, 'games-login-360.png') });
    // 2) 첫 화면 (로그인 후): 버튼, 스크롤 전 위치, 메뉴 → 판 아님 → 바로 이동
    await login(p, '게임메뉴' + String(Date.now()).slice(-4));
    await sleep(3300);
    for (const [w, h] of [[360, 640], [390, 844], [844, 390]]) {
      await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); await sleep(200);
      await p.evaluate(() => window.scrollTo(0, 0));
      const o = await overlaps(p, 'button, .acct, .title, .brand');
      out[`landing_${w}x${h}`] = o.inView && !o.hits.length ? true : o;
    }
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(200);
    await p.click('.games-btn'); await p.waitForSelector('.games-menu');
    out.menu_items = await p.$$eval('.games-menu button', (b) => b.map((x) => x.textContent.trim()));
    await p.screenshot({ path: path.join(SHOTS, 'games-menu.png') });
    await p.click('.games-menu [data-act="close"]'); await sleep(150);
    out.menu_closes = !(await p.$('.games-menu'));
    await p.click('.games-btn'); await p.waitForSelector('.games-menu');
    await Promise.all([p.waitForNavigation({ timeout: 5000 }).catch(() => {}), p.click('[data-act="goGame"][data-gi="0"]')]);
    out.lobby_nav_no_confirm = navs[0] === 'https://game.itf84.synology.me/' && p.url() === 'https://game.itf84.synology.me/';
    // 3) AI 판 중: 머리줄 버튼, 확인창, 취소, 이동
    await p.goto(URL, { waitUntil: 'networkidle0' });
    await p.waitForSelector('[data-act="solo"]', { timeout: 10000 });
    await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.click('[data-act="solo"]');
    await p.waitForFunction(() => document.querySelector('.hdr .games-btn') && document.querySelector('.hand, .sd-me, .mine'), { timeout: 15000 });
    await sleep(2500);
    const oh = await overlaps(p, '.hdr button, .hdr .t');
    out.game_header_button = oh.inView && !oh.hits.length ? true : oh;
    out.game_header_no_overflow = await p.$eval('.hdr', (h) => h.scrollWidth <= h.clientWidth + 1);
    out.game_no_scroll = await p.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1);
    await p.click('.hdr .games-btn'); await p.waitForSelector('.games-menu');
    await p.click('[data-act="goGame"][data-gi="1"]');
    await p.waitForSelector('.games-confirm', { timeout: 3000 });
    out.confirm_text = await p.$eval('.games-confirm p', (e) => e.textContent.trim() === '판이 진행 중이에요. 나가면 AI가 대신 칩니다. 이동할까요?');
    await p.screenshot({ path: path.join(SHOTS, 'games-confirm.png') });
    await p.click('.games-confirm [data-act="games"]'); await sleep(150);
    out.cancel_back_to_menu = !!(await p.$('.games-menu')) && !navs.some((u) => u.includes('ofo.'));
    await p.click('[data-act="goGame"][data-gi="1"]');
    await p.waitForSelector('.games-confirm', { timeout: 3000 });
    await Promise.all([p.waitForNavigation({ timeout: 5000 }).catch(() => {}), p.click('[data-act="goGameNow"]')]);
    out.dungeon_nav_after_confirm = p.url() === 'https://ofo.itf84.synology.me/';
  } catch (e) { errors.push(e.stack || String(e)); }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
  const bad = Object.entries(out).filter(([k, v]) => k !== 'menu_items' && v !== true).map(([k]) => k);
  if (JSON.stringify(out.menu_items) !== JSON.stringify(['🏠 게임 로비', '⚔️ 던전 앤 던전', '닫기'])) bad.push('menu_items');
  console.log('ERRORS:', errors.concat(bad).join(' | ') || 'none');
  process.exit(errors.length || bad.length ? 1 : 0);
})();
