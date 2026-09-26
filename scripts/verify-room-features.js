// 나가기 예약 · 턴 타이머 · 채팅 화면 확인 + 스크린샷 (localhost:3300)
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { login } = require('./_login');
const URL = process.env.URL || 'http://localhost:3300';
const SHOTS = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const errors = [], out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VP = { width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const noScroll = (p) => p.evaluate(() => { const d = document.documentElement; const h = document.querySelector('.hdr'); return d.scrollHeight <= innerHeight + 1 && d.scrollWidth <= innerWidth + 1 && (!h || h.scrollWidth <= h.clientWidth + 1); });

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const n = String(Date.now()).slice(-4);
    // 1) 턴 타이머: 혼자 + AI 맞고
    const s = await browser.newPage();
    s.on('pageerror', (e) => errors.push('pageerror ' + e.message));
    await s.setViewport(VP);
    await s.goto(URL, { waitUntil: 'networkidle0' });
    await login(s, '타이머' + n);
    await s.click('[data-game="matgo"]');
    await s.click('[data-act="solo"]');
    await s.waitForSelector('.tt-me', { timeout: 20000 });
    await sleep(6500); // 7초 남짓 → 조금 더 기다려 빨간색(3초 이하) 전 단계
    out.timerNum = await s.$eval('[data-tt]', (el) => Number(el.textContent));
    out.timerBarMine = !!(await s.$('.mine .tt-bar'));
    await s.screenshot({ path: path.join(SHOTS, 'turn-timer.png') });
    await s.waitForSelector('.tt-me.hot', { timeout: 12000 });
    out.hotShown = true;
    await s.screenshot({ path: path.join(SHOTS, 'turn-timer-hot.png') });
    await s.waitForFunction(() => /시간 초과/.test(document.body.innerText), { timeout: 8000 });
    out.timeoutToast = true;
    out.gameNoScroll360 = await noScroll(s);
    for (const [w, h] of [[390, 700], [412, 915], [844, 390]]) { await s.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: true, hasTouch: true }); await sleep(300); out[`gameNoScroll${w}x${h}`] = await noScroll(s); }
    await s.setViewport(VP);
    // 판이 아닐 때(=판 중이지만 여기선 예약 토글 확인 후 취소)
    await s.close();

    // 2) 두 사람 섯다: 나가기 예약 + 채팅
    const A = await (await browser.createBrowserContext()).newPage(); const B = await (await browser.createBrowserContext()).newPage();
    for (const p of [A, B]) { p.on('pageerror', (e) => errors.push('pageerror ' + e.stack)); await p.setViewport(VP); await p.goto(URL, { waitUntil: 'networkidle0' }); }
    await login(A, '방장' + n); await login(B, '손님' + n);
    await A.click('[data-game="seotda"]');
    await A.click('[data-act="create"]');
    await A.waitForSelector('.code-big');
    const code = await A.$eval('.code-big', (el) => el.textContent.trim());
    await B.$eval('#code', (el, v) => { el.value = v; }, code);
    await B.click('[data-act="join"]');
    await A.waitForFunction(() => document.querySelectorAll('.plist li').length === 2, { timeout: 10000 });
    out.info_waitingRoomNoScroll = await noScroll(A); // (대기실은 원래 360x640에서 세로로 조금 김 — 정보용)
    // 대기실 채팅 + 말풍선
    await B.waitForSelector('.chat-btn', { timeout: 10000 });
    await B.click('[data-act="chat"]');
    await B.waitForSelector('.chat-drawer');
    await B.click('[data-quick="한 판 더?"]');
    await A.waitForSelector('.chat-bubble', { timeout: 5000 });
    out.bubbleLobby = true;
    await A.waitForFunction(() => document.querySelector('.chat-btn .badge'), { timeout: 5000 });
    out.unreadBadge = await A.$eval('.chat-btn .badge', (el) => el.textContent);
    await B.click('[data-chat="close"]');
    await A.click('[data-act="start"]');
    await A.waitForSelector('.sd-me', { timeout: 10000 }); await B.waitForSelector('.sd-me', { timeout: 10000 });
    await sleep(1500);
    // 나가기 예약 (판 중)
    await A.click('[data-act="exitRoom"]');
    await A.waitForFunction(() => { const b = document.querySelector('.exit-btn'); return b && b.classList.contains('on') && b.textContent.includes('예약됨'); }, { timeout: 5000 });
    await B.waitForSelector('.resv-tag', { timeout: 5000 });
    out.reserveShownToOther = true;
    await sleep(1600);
    await A.screenshot({ path: path.join(SHOTS, 'exit-reserved.png') });
    await B.screenshot({ path: path.join(SHOTS, 'exit-reserved-other.png') });
    out.gameHeaderFits = await noScroll(A);
    // 게임 중 채팅: 말풍선이 A 자리 위에
    await A.click('[data-act="chat"]');
    await A.waitForSelector('#chat-text');
    await A.type('#chat-text', '<b>잘 쳤다!</b> 이번 판만 하고 갈게요');
    await A.click('.chat-in button');
    await B.waitForSelector('.chat-bubble', { timeout: 5000 });
    await sleep(350);
    await B.screenshot({ path: path.join(SHOTS, 'chat-bubble.png') });
    await A.click('[data-quick="감사합니다"]');
    await A.click('[data-quick="👍"]');
    await sleep(400);
    out.chatEscaped = await A.evaluate(() => !document.querySelector('.chat-list b b') && [...document.querySelectorAll('.chat-list .cl span')].some((x) => x.textContent.includes('＜b＞잘 쳤다!')));
    await A.screenshot({ path: path.join(SHOTS, 'chat.png') });
    await A.click('[data-chat="close"]');
    // 판이 끝나면 A는 자동으로 첫 화면으로
    await A.waitForFunction(() => /예약한 대로 방에서 나왔어요/.test(document.body.innerText), { timeout: 60000 });
    await A.waitForSelector('[data-act="solo"]', { timeout: 10000 });
    out.autoLeft = true;
    await B.waitForFunction(() => !document.querySelector('.resv-tag') && [...document.querySelectorAll('.plist li, .sd-seat')].some((x) => x.textContent.includes('🤖')), { timeout: 15000 }).catch(() => {});
    out.info_bSeesAIafterLeave = await B.evaluate(() => document.body.innerText.includes('🤖'));
    for (const [k, v] of Object.entries(out)) if (v === false && !k.startsWith('info_')) errors.push('check failed: ' + k);
  } catch (e) { errors.push(String(e.stack || e)); }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  process.exit(errors.length ? 1 : 0);
})();
