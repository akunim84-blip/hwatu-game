// 이름 바꾸기 · 계정 삭제 · 관리자 페이지 확인 + 스크린샷 (localhost:3300, ADMIN_KEY는 .admin-key)
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { login } = require('./_login');
const URL = process.env.URL || 'http://localhost:3300';
const SHOTS = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [];
const out = {};
const fits = (p) => p.evaluate(() => { const m = document.querySelector('.modal, #mbox'); const r = m.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1; });

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
  try {
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push('pageerror ' + e.message));
    await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(URL, { waitUntil: 'networkidle0' });
    const n = String(Date.now()).slice(-5);
    const name = '혁이' + n, name2 = '혁이왕' + n;
    await login(p, name);
    await new Promise((r) => setTimeout(r, 3500)); // 환영 알림이 사라진 뒤
    await p.screenshot({ path: path.join(SHOTS, 'account-panel.png') });
    // 이름 바꾸기
    await p.click('[data-act="renameForm"]');
    await p.waitForSelector('#rn-new');
    await p.$eval('#rn-new', (el, v) => { el.value = ''; }, '');
    await p.type('#rn-new', name2);
    out.renameFits360 = await fits(p);
    await p.screenshot({ path: path.join(SHOTS, 'rename.png') });
    for (const [w, h] of [[390, 700], [412, 915], [844, 390]]) { await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); out[`renameFits${w}x${h}`] = await fits(p); }
    await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.click('[data-act="saveRename"]');
    await p.waitForFunction((v) => !document.querySelector('#rn-new') && document.querySelector('.acct b') && document.querySelector('.acct b').textContent === v, { timeout: 8000 }, name2);
    out.renamed = await p.evaluate(() => ({ shown: document.querySelector('.acct b').textContent, lsName: localStorage.getItem('hw_name') }));
    if (out.renamed.lsName !== name2) errors.push('hw_name not updated');
    // 새로고침 → 기기 토큰으로 새 이름 자동 입장
    await p.reload({ waitUntil: 'networkidle0' });
    await p.waitForSelector('.acct b');
    out.afterReload = await p.$eval('.acct b', (el) => el.textContent);
    if (out.afterReload !== name2) errors.push('token login after rename failed');
    // 계정 삭제
    await p.click('[data-act="delForm"]');
    await p.waitForSelector('#del-name');
    await p.type('#del-name', '틀린이름');
    await p.click('[data-act="doDelete"]');
    await p.waitForSelector('.del-form .login-msg.err');
    out.mismatchMsg = await p.$eval('.del-form .login-msg.err', (el) => el.textContent);
    await p.$eval('#del-name', (el) => { el.value = ''; });
    await p.type('#del-name', name2);
    await p.evaluate(() => { const e = document.querySelector('.del-form .login-msg.err'); if (e) e.remove(); });
    out.deleteFits360 = await fits(p);
    await p.screenshot({ path: path.join(SHOTS, 'delete-account.png') });
    for (const [w, h] of [[390, 700], [844, 390]]) { await p.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); out[`deleteFits${w}x${h}`] = await fits(p); }
    await p.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.click('[data-act="doDelete"]');
    await p.waitForSelector('#nick', { timeout: 8000 });
    out.afterDelete = await p.evaluate(() => ({ token: localStorage.getItem('hw_token'), name: localStorage.getItem('hw_name'), nick: document.getElementById('nick').value }));
    if (out.afterDelete.token || out.afterDelete.name || out.afterDelete.nick) errors.push('local data not cleared');
    // 관리자 페이지
    const key = fs.readFileSync(path.join(__dirname, '..', '.admin-key'), 'utf8').trim();
    const a = await browser.newPage();
    a.on('pageerror', (e) => errors.push('admin pageerror ' + e.message));
    await a.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await a.goto(URL + '/admin', { waitUntil: 'networkidle0' });
    await a.waitForSelector('#key');
    await a.type('#key', 'wrong-key');
    await a.click('#lf button');
    await a.waitForFunction(() => document.getElementById('lerr').textContent.length > 0);
    out.adminWrong = await a.$eval('#lerr', (el) => el.textContent);
    await a.$eval('#key', (el) => { el.value = ''; });
    await a.type('#key', key);
    await a.click('#lf button');
    await a.waitForSelector('.card', { timeout: 8000 });
    await a.reload({ waitUntil: 'networkidle0' });
    await a.waitForSelector('.card', { timeout: 8000 }); // 쿠키로 기억
    out.adminCards = await a.$$eval('.card', (x) => x.length);
    await a.screenshot({ path: path.join(SHOTS, 'admin.png') });
    await a.click('[data-a="del"]');
    await a.waitForSelector('#mv');
    await a.screenshot({ path: path.join(SHOTS, 'admin-delete.png') });
    await a.click('#mno');
    await a.click('[data-tab="room"]');
    await a.waitForSelector('#rf');
    await a.screenshot({ path: path.join(SHOTS, 'admin-rooms.png') });
    await a.setViewport({ width: 360, height: 640, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    out.adminNoHScroll = await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    for (const [k, v] of Object.entries(out)) if (v === false) errors.push('check failed: ' + k);
  } catch (e) { errors.push(String(e.stack || e)); }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  process.exit(errors.length ? 1 : 0);
})();
