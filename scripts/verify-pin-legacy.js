// PIN 없는 옛 계정 안내창 확인 (PIN_REQUIRED_V1): 임시 서버(포트 3398, 임시 JSON 저장소)에 옛 계정을 만들어 두고
// 기기 토큰으로 들어오면 PIN 만들기 창 → '나중에'는 이번 탭만 → 새로고침(같은 탭)엔 안 뜸, 새 탭(다음 방문)엔 다시 → 저장하면 안 뜸.
// 360x640 스크린샷: screenshots/pin-legacy.png, screenshots/login-pin.png
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const PORT = 3398, URL = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {}, errors = [];
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-legacy-'));
  const token = crypto.randomBytes(32).toString('base64url');
  const th = crypto.createHash('sha256').update(token).digest('hex');
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ accounts: { 옛사람: { key: '옛사람', nickname: '옛사람', pinHash: null, balance: 1234000, bankruptCount: 0, tokens: [th], createdAt: Date.now() } } }));
  const env = Object.assign({}, process.env, { PORT: String(PORT), ACCOUNTS_FILE: path.join(dir, 'a.json'), ADMIN_KEY: '' }); delete env.DATABASE_URL;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(URL + '/healthz')).ok) break; } catch (e) {} await sleep(100); }
    browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
    const ctx = await browser.createBrowserContext();
    let p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(URL, { waitUntil: 'networkidle0' });
    out.loginNoScrollStart = await p.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1);
    await p.$eval('#nick', (el) => { el.value = '새사람'; }); await p.$eval('#pin', (el) => { el.value = '1234'; });
    await p.$eval('[data-act="enter"]', (el) => el.click()); await p.waitForSelector('#pin2');
    out.loginNoScroll = await p.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1);
    await p.screenshot({ path: path.join(SHOTS, 'login-pin.png') });
    await p.evaluate((t) => { localStorage.clear(); localStorage.setItem('hw_token', t); localStorage.setItem('hw_name', '옛사람'); }, token);
    await p.reload({ waitUntil: 'networkidle0' });
    await p.waitForSelector('.pin-now', { timeout: 8000 });
    out.promptShown = await p.$eval('.pin-now', (e) => e.innerText.includes('옛사람'));
    out.promptFits = await p.$eval('.pin-now', (e) => { const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; });
    await p.screenshot({ path: path.join(SHOTS, 'pin-legacy.png') });
    await p.click('[data-act="pinLater"]'); await sleep(200);
    out.laterCloses = !(await p.$('.pin-now'));
    await p.reload({ waitUntil: 'networkidle0' }); await p.waitForSelector('[data-act="solo"]'); await sleep(500);
    out.laterSameTab = !(await p.$('.pin-now'));
    await p.close();
    p = await ctx.newPage(); // 다음 방문 (새 탭 = 새 세션)
    await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(URL, { waitUntil: 'networkidle0' });
    await p.waitForSelector('.pin-now', { timeout: 8000 }); out.againNextVisit = true;
    await p.type('#pn-new', '1111'); await p.type('#pn-new2', '2222'); await p.click('[data-act="pinNowSave"]'); await sleep(300);
    out.mismatchMsg = await p.$eval('.pin-now .login-msg', (e) => e.innerText.includes('달라요'));
    await p.$eval('#pn-new2', (el) => { el.value = ''; }); await p.type('#pn-new2', '1111'); await p.click('[data-act="pinNowSave"]'); await sleep(600);
    out.saved = !(await p.$('.pin-now')) && (await p.$eval('.acct', (e) => e.innerText.includes('PIN 변경')));
    const p2 = await ctx.newPage(); await p2.goto(URL, { waitUntil: 'networkidle0' }); await p2.waitForSelector('[data-act="solo"]'); await sleep(500);
    out.noPromptAfterSave = !(await p2.$('.pin-now'));
  } catch (e) { errors.push(e.stack || String(e)); }
  if (browser) await browser.close();
  srv.kill();
  console.log(JSON.stringify(out, null, 1));
  const bad = Object.entries(out).filter(([, v]) => v !== true).map(([k]) => k);
  console.log('ERRORS:', errors.concat(bad).join(' | ') || 'none');
  process.exit(errors.length || bad.length ? 1 : 0);
})();
