// 기기 기억 확인 (DEVICE_V2): 한 번 입장 → 새로고침·브라우저 닫았다 열기에도 자동 입장, 응답 끊김(토큰 먼저 저장) 복구,
// localStorage만 지워져도 쿠키로 복구, 없는 토큰이면 이름 미리 채운 입장 화면. 사용: URL=http://localhost:3300 node scripts/verify-device.js
// ⚠️ 운영 주소에 돌리면 테스트 계정(확인…)이 생깁니다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3300';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {}, errors = [];
const state = (p) => p.evaluate(() => ({ login: !!document.getElementById('nick'), nick: (document.getElementById('nick') || {}).value || '', acct: (document.querySelector('.acct-name b') || {}).textContent || null, token: localStorage.getItem('hw_token'), cookie: /hw_token=/.test(document.cookie), warn: !!document.querySelector('.login-warn') }));
const until = async (p, pred, ms = 10000) => { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await state(p); if (pred(s)) return s; await sleep(200); } return s; };
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-dev-prof-'));
  const launch = () => puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', userDataDir: dir, args: ['--no-sandbox', '--lang=ko-KR'] });
  const name = '확인' + Date.now().toString(36).slice(-5);
  let b;
  try {
    b = await launch(); let p = (await b.pages())[0];
    p.on('pageerror', (e) => errors.push('pageerror ' + e.message));
    await p.setViewport({ width: 1280, height: 900 });
    await p.goto(URL, { waitUntil: 'networkidle2' });
    let s = await until(p, (x) => x.login);
    out.storage_ok = !s.warn;
    await p.$eval('#nick', (el, v) => { el.value = v; }, name);
    await p.$eval('[data-act="enter"]', (el) => el.click());
    s = await until(p, (x) => x.acct === name);
    out.enter = s.acct === name && !!s.token && s.cookie;
    await p.reload({ waitUntil: 'networkidle2' });
    out.reload_auto = (await until(p, (x) => x.acct === name)).acct === name;
    await b.close();
    b = await launch(); p = (await b.pages())[0];
    await p.goto(URL, { waitUntil: 'networkidle2' });
    out.reopen_auto = (await until(p, (x) => x.acct === name)).acct === name;
    // localStorage만 지워짐 → 쿠키에서 복구
    await p.evaluate(() => localStorage.clear());
    await p.reload({ waitUntil: 'networkidle2' });
    out.cookie_restore = (await until(p, (x) => x.acct === name)).acct === name;
    // 응답이 끊긴 입장: 기기 토큰을 먼저 저장해 두고, 서버에는 (다른 연결로) 그 토큰으로 입장만 됨 → 다음 방문에 자동 입장
    const name2 = name + 'b';
    const t = crypto.randomBytes(32).toString('base64url');
    await p.evaluate((t, n) => { localStorage.clear(); document.cookie = 'hw_token=; Max-Age=0; Path=/'; localStorage.setItem('hw_token', t); localStorage.setItem('hw_pend', n); localStorage.setItem('hw_name', n); }, t, name2);
    const sock = io(URL, { transports: ['websocket'], forceNew: true });
    const r = await new Promise((res) => sock.emit('enter', { nickname: name2, device: t }, res));
    sock.close();
    await p.reload({ waitUntil: 'networkidle2' });
    out.lost_ack_recovered = r.ok && (await until(p, (x) => x.acct === name2)).acct === name2;
    // 없는 토큰 → 입장 화면, 이름 미리 채움, 토큰은 지움
    await p.evaluate(() => { localStorage.setItem('hw_token', 'A'.repeat(43)); });
    await p.reload({ waitUntil: 'networkidle2' });
    s = await until(p, (x) => x.login);
    out.bad_token_prefill = s.login && s.nick === name2 && !s.token && !s.cookie;
  } catch (e) { errors.push(e.stack || String(e)); }
  if (b) await b.close();
  console.log(JSON.stringify(out, null, 1));
  const bad = Object.entries(out).filter(([, v]) => v !== true).map(([k]) => k);
  console.log('ERRORS:', errors.concat(bad).join(' | ') || 'none');
  process.exit(errors.length || bad.length ? 1 : 0);
})();
