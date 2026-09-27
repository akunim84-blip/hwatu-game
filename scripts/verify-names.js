// 긴 이름(최대 12자)이 첫 화면 계정 패널·대기실·게임 자리에서 잘리지 않는지 + 스크린샷 (localhost:3300)
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { io } = require('socket.io-client');
const { login } = require('./_login');
const URL = process.env.URL || 'http://localhost:3300';
const SHOTS = path.join(__dirname, '..', 'screenshots');
const errors = [], out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYL = '가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허';
const longName = () => Array.from({ length: 12 }, () => SYL[Math.floor(Math.random() * SYL.length)]).join('');
const SIZES = [[360, 640], [390, 844], [412, 915], [844, 390]];
// 이름이 들어 있는 요소가 말줄임(…)으로 잘렸는지
const truncated = (p, sel) => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.className + ':' + el.textContent.slice(0, 30)), sel);
async function bot(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const r = await new Promise((res) => s.emit('enter', { nickname: name }, res));
  if (!r.ok) throw new Error('bot enter ' + r.error);
  return s;
}
const emit = (s, ev, d) => new Promise((res) => s.emit(ev, d || {}, res));
const NAME_SEL = '.acct-name, .plist li > div, .opp .nm span:first-child, .sd-seat > div:first-child, .mine .nm span:first-child, .sd-me .muted';

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
  const bots = [];
  try {
    for (const [nm, tag] of [[longName(), 'long'], ['혁', 'short']]) {
      const ctx = await browser.createBrowserContext();
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push('pageerror ' + e.message));
      await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await p.goto(URL, { waitUntil: 'networkidle0' });
      const name = tag === 'short' ? nm + String(Date.now()).slice(-1) : nm;
      await login(p, name);
      await sleep(3300);
      for (const [w, h] of SIZES) {
        await p.setViewport({ width: w, height: h, deviceScaleFactor: w === 390 ? 2 : 1, isMobile: true, hasTouch: true });
        await sleep(200);
        const shown = await p.$eval('.acct-name b', (el) => el.textContent);
        const cut = await truncated(p, '.acct-name, .acct-name b');
        out[`landing_${tag}_${w}x${h}`] = shown === name && !cut.length;
        if (tag === 'long' && w === 390) await p.screenshot({ path: path.join(SHOTS, 'profile-fullname.png') });
        if (tag === 'long' && w === 360) await p.screenshot({ path: path.join(SHOTS, 'profile-fullname-360.png') });
      }
      // 전적 줄 + 게임별 자세히 (STATS_V1)
      out[`rec_line_${tag}`] = await p.$eval('.rec-line', (el) => /전적 (아직 전적 없음|\d+승 \d+무 \d+패 · 승률 \d+%)/.test(el.textContent));
      if (tag === 'long') {
        await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        await p.click('.rec-line'); await p.waitForSelector('.rec-table');
        out.rec_table_rows = await p.$$eval('.rec-table tr', (r) => r.length) === 5;
        await p.screenshot({ path: path.join(SHOTS, 'stats.png') });
        await p.click('.modal [data-act="close"]'); await sleep(200);
      }
      if (tag === 'short') { await ctx.close(); continue; }
      // 방: 섯다 5명 (나 + 긴 이름 4명) 대기실 → 게임
      await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await p.click('[data-game="seotda"]');
      await p.click('[data-act="create"]');
      await p.waitForSelector('.code-big');
      const code = await p.$eval('.code-big', (el) => el.textContent.trim());
      for (let i = 0; i < 4; i++) { const s = await bot(longName()); bots.push(s); await emit(s, 'joinRoom', { code }); }
      await p.waitForFunction(() => document.querySelectorAll('.plist li').length === 5, { timeout: 10000 });
      for (const [w, h] of SIZES) { await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); await sleep(200); const c = await truncated(p, '.plist li > div'); out[`lobby_${w}x${h}`] = c.length ? c : true; }
      await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await p.click('[data-act="start"]');
      await p.waitForSelector('.sd-seat', { timeout: 10000 });
      await sleep(3000);
      for (const [w, h] of SIZES) { await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); await sleep(300); const c = await truncated(p, '.sd-seat > div:first-child, .sd-me .muted'); out[`seotda_${w}x${h}`] = c.length ? c : true; if (w === 360) await p.screenshot({ path: path.join(SHOTS, 'names-seotda.png') }); }
      // 고스톱 3명
      await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await p.click('[data-act="exitRoom"]').catch(() => {});
      await sleep(500);
      if (await p.$('.exit-btn.on')) { await p.click('[data-act="exitRoom"]'); await sleep(300); }
      await emit(bots[0], 'leave'); 
      await p.goto(URL, { waitUntil: 'networkidle0' });
      await p.evaluate(() => localStorage.removeItem('hw_room'));
      await p.goto(URL, { waitUntil: 'networkidle0' });
      await p.waitForSelector('[data-game="gostop"]', { timeout: 10000 });
      await p.click('[data-game="gostop"]');
      await p.click('[data-act="create"]');
      await p.waitForSelector('.code-big');
      const code2 = await p.$eval('.code-big', (el) => el.textContent.trim());
      const g1 = await bot(longName()), g2 = await bot(longName()); bots.push(g1, g2);
      await emit(g1, 'joinRoom', { code: code2 }); await emit(g2, 'joinRoom', { code: code2 });
      await p.waitForFunction(() => document.querySelectorAll('.plist li').length === 3, { timeout: 10000 });
      await p.click('[data-act="start"]');
      await p.waitForSelector('.opp', { timeout: 10000 });
      await sleep(5000);
      for (const [w, h] of SIZES) { await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); await sleep(300); const c = await truncated(p, '.opp .nm span:first-child, .mine .nm span:first-child'); out[`gostop_${w}x${h}`] = c.length ? c : true; if (w === 360) await p.screenshot({ path: path.join(SHOTS, 'names-gostop.png') }); }
      await ctx.close();
    }
    for (const [k, v] of Object.entries(out)) if (v !== true) errors.push('check failed: ' + k + ' ' + JSON.stringify(v));
  } catch (e) { errors.push(String(e.stack || e)); }
  bots.forEach((s) => s.close());
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  process.exit(errors.length ? 1 : 0);
})();
