// 판 끝 결과 화면(RESULT_V2) · 같은 달 짝 강조(MATCH_V2) · 새 로고 헤드리스 검증 + 스크린샷
// 사용법: node scripts/verify-result.js   (서버를 이 프로세스 안에서 띄우고, 판 상태를 직접 구성 — 테스트 전용)
process.env.AI_DELAY_SCALE = process.env.AI_DELAY_SCALE || '1';
if (!process.env.ACCOUNTS_FILE) process.env.ACCOUNTS_FILE = require('path').join(require('os').tmpdir(), 'hwatu-verify-' + require('path').basename(__filename, '.js') + '-' + Date.now() + '.json');
const puppeteer = require('puppeteer-core');
const { login, authAs, pidOf } = require('./_login');
const { io } = require('socket.io-client');
const path = require('path');
const { server, rooms } = require('../server');
const { HWATU, SEOTDA } = require('../shared/cards');
const { evalHand } = require('../lib/seotda');
const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const card = (m, type) => HWATU.find((c) => c.m === m && c.type === type && !c.bonus).id;
const cards = (m, type) => HWATU.filter((c) => c.m === m && c.type === type && !c.bonus).map((c) => c.id);

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
  if (spec.flip != null) e.deck.push(spec.flip);
  e.turn = 0; e.phase = 'play'; e.pending = null; e.lastPlay = null; e.lastFlip = null;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const BASE = `http://localhost:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
  const errors = [], report = {};
  const newPage = async (label, w = 390, h = 844) => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    p.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`));
    p.on('response', (r) => { if (r.status() >= 400) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
    await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    return p;
  };
  const shot = async (p, name) => { await p.evaluate(() => { const t = document.getElementById('toasts'); if (t) t.innerHTML = ''; }); const f = path.join(OUT, name + '.png'); await p.screenshot({ path: f }); console.log('saved', f); };
  const tap = async (p, sel) => { await p.waitForSelector(sel, { timeout: 10000 }); await p.$eval(sel, (el) => el.click()); };
  // 결과 카드가 화면 안에 다 들어가는지 (페이지 스크롤 없음 + 결과 본문도 넘치지 않음)
  const resFits = (p) => p.evaluate(() => {
    const se = document.scrollingElement, c = document.querySelector('.res-card'), b = document.querySelector('.res-body');
    if (!c) return 'no-overlay';
    const r = c.getBoundingClientRect();
    const ok = se.scrollHeight <= innerHeight && se.scrollWidth <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 0.5 && b.scrollHeight <= b.clientHeight + 1;
    return ok ? 'OK' : `FAIL card ${Math.round(r.top)}-${Math.round(r.bottom)}/${innerHeight} body ${b.scrollHeight}/${b.clientHeight}`;
  });
  const sizes = [[360, 640], [390, 700], [390, 844], [412, 915], [844, 390]];
  const fitAll = async (p) => { const o = {}; for (const [w, h] of sizes) { await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(250); o[`${w}x${h}`] = await resFits(p); } await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(200); return o; };

  // ---- 1) 새 로고 (얇은 고딕) ----
  {
    const p = await newPage('logo');
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await login(p, '로고확인');
    await p.evaluate(() => document.fonts.ready);
    await shot(p, 'logo-new');
    report.logo = await p.evaluate(() => { const t = getComputedStyle(document.querySelector('.title.brand')); return { weight: t.fontWeight, color: t.color, font: document.fonts.check('600 40px HyukLogo', '혁게임') }; });
    await p.close();
  }

  // ---- 2) 맞고: 짝 강조 + 마지막 패로 나기 → 최종 판 → 결과 화면 ----
  {
    const p = await newPage('matgo');
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await login(p, '민수');
    await tap(p, '[data-game="matgo"]');
    await tap(p, '[data-act="solo"]');
    await p.waitForSelector('.floor');
    const code = await p.evaluate(() => localStorage.getItem('hw_room'));
    const room = rooms.get(code);
    const e = room.engine;
    await sleep(7200); // 선 정하기 + 패 돌리기 끝
    // (a) 짝 강조용 판: 손패 3월·8월은 바닥과 짝, 11월·보너스 없음
    rig(e, {
      handSize: [6, 6], floorSize: 6,
      caps: [[], []],
      hands: [[card(3, 'tti'), card(8, 'yeol'), card(11, 'gwang'), card(5, 'yeol'), card(7, 'tti'), card(12, 'tti')], []],
      floor: [card(3, 'gwang'), cards(8, 'pi')[0], cards(8, 'pi')[1], card(1, 'gwang'), card(4, 'tti'), card(10, 'yeol')],
    });
    const s = io(BASE, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.on('connect', r));
    await authAs(s, p);
    const bump = () => new Promise((r) => s.emit('joinRoom', { code }, r));
    await bump(); await sleep(600);
    report.matchSoft = await p.evaluate(() => {
      const hand = [...document.querySelectorAll('.hand .card.mt')].map((e) => +e.dataset.m);
      const floor = [...document.querySelectorAll('.floor .card.mt')].map((e) => +e.dataset.m);
      return { hand, floor, allPaired: floor.every((m) => hand.includes(m)) && hand.every((m) => floor.includes(m)) };
    });
    // 8월 패 선택 → 8월 손패 + 8월 바닥 2장만 밝게
    await p.$eval(`.hand [data-hand="${card(8, 'yeol')}"]`, (el) => el.click());
    await sleep(700);
    await shot(p, 'match-highlight-matgo');
    const checkSel = () => p.evaluate(() => {
      const on = [...document.querySelectorAll('.card.mt.on')].map((e) => +e.dataset.m);
      const sel = document.querySelector('.hand .card.sel');
      // 크기(scale)가 바뀐 카드가 있는지: 애니메이션/transform 모두 검사
      const scaled = [...document.querySelectorAll('.floor .card, .hand .card')].filter((el) => {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform);
        const anims = el.getAnimations().map((a) => a.animationName);
        return Math.abs(m.a - 1) > 0.001 || Math.abs(m.d - 1) > 0.001 || anims.some((n) => n !== 'mtpulse');
      }).map((el) => el.title);
      return { selM: sel ? +sel.dataset.m : null, on, sameMonth: on.every((m) => sel && m === +sel.dataset.m), scaled };
    });
    report.match8 = await checkSel();
    // 달이 다른 패로 바꿔 고르기 (예전 버그: 마지막 뒤집은 패가 다시 그릴 때마다 커짐)
    e.lastFlip = e.floor[0]; // 바닥의 3월 광을 '뒤집은 패'로 표시
    await bump(); await sleep(300);
    await p.$eval(`.hand [data-hand="${card(11, 'gwang')}"]`, (el) => el.click());
    await sleep(120);
    report.match11 = await checkSel(); // 짝 없음 → 강조 0, 커진 카드 0
    await p.$eval(`.hand [data-hand="${card(3, 'tti')}"]`, (el) => el.click());
    await sleep(120);
    report.match3 = await checkSel();

    // (b) 마지막 패로 7점 → 자동 스톱 → 결과
    rig(e, {
      handSize: [1, 0], floorSize: 4,
      caps: [[card(1, 'gwang'), card(3, 'gwang'), card(8, 'gwang'), card(1, 'tti'), card(2, 'tti'), card(4, 'tti'), card(5, 'tti')], [cards(6, 'pi')[0], card(9, 'yeol')]],
      hands: [[card(3, 'tti')], []],
      floor: [cards(3, 'pi')[0], card(10, 'yeol'), card(12, 'yeol'), card(6, 'tti')],
      flip: card(7, 'yeol'),
    });
    e.players[0].go = 1; e.players[0].lastGoScore = 6; // 1고 상태
    await bump(); await sleep(600);
    await p.$eval(`.hand [data-hand="${card(3, 'tti')}"]`, (el) => { el.click(); setTimeout(() => el.click(), 80); });
    await sleep(700);
    report.matgoHold = await p.evaluate(() => ({ ribbon: !!document.querySelector('.end-ribbon'), overlay: !!document.querySelector('.res-ov'), flyers: document.querySelectorAll('.flyer').length }));
    await shot(p, 'result-hold-matgo');
    await p.waitForSelector('.res-ov', { timeout: 6000 });
    await sleep(500);
    await shot(p, 'result-matgo');
    report.matgoResult = await p.evaluate(() => ({ title: document.querySelector('.res-head h2').innerText, how: (document.querySelector('.res-how') || {}).innerText, chips: [...document.querySelectorAll('.res-chips .rc')].map((e) => e.innerText), bak: [...document.querySelectorAll('.bak')].map((e) => e.innerText), money: [...document.querySelectorAll('.rm-row')].map((e) => e.innerText.replace(/\s+/g, ' ')) }));
    report.matgoFits = await fitAll(p);
    await sleep(3500);
    report.matgoStays = !!(await p.$('.res-ov')); // 저절로 사라지지 않음
    await tap(p, '.res-ov [data-act="closeRes"]');
    await sleep(200);
    report.matgoClosed = await p.evaluate(() => ({ overlay: !!document.querySelector('.res-ov'), bar: (document.querySelector('.res-bar') || {}).innerText }));
    await tap(p, '[data-act="showRes"]');
    report.matgoReopen = !!(await p.$('.res-ov'));
    s.close(); await p.close();
  }

  // ---- 3) 섯다: 38광땡 vs 갑오 → 공개 → 결과 ----
  {
    const p = await newPage('seotda');
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await login(p, '민수');
    await tap(p, '[data-game="seotda"]');
    await tap(p, '[data-aic="2"]');
    await tap(p, '[data-act="solo"]');
    await p.waitForSelector('.sd-me');
    const code = await p.evaluate(() => localStorage.getItem('hw_room'));
    const room = rooms.get(code);
    const s = io(BASE, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.on('connect', r));
    await authAs(s, p);
    const sid = (m, type) => SEOTDA.find((c) => c.m === m && c.type === type).id;
    let ok = false;
    for (let tries = 0; tries < 6 && !ok; tries++) {
      const e = room.engine;
      const me = e.seatOf('u:민수');
      e.seats[me].cards = [sid(3, 'gwang'), sid(8, 'gwang')];
      const others = e.seats.map((x, i) => i).filter((i) => i !== me);
      e.seats[others[0]].cards = [sid(4, 'yeol'), sid(5, 'yeol')]; // 9끗 (갑오)
      if (others[1] != null) e.seats[others[1]].cards = [sid(2, 'tti'), sid(7, 'tti')]; // 9끗
      await new Promise((r) => s.emit('joinRoom', { code }, r));
      // 내 차례마다 체크/콜
      const t0 = Date.now();
      while (!room.engine.over && Date.now() - t0 < 20000) {
        const en = room.engine;
        if (en.turn === me) { const o = en.options(me); const a = o.find((x) => x.type === 'check') || o.find((x) => x.type === 'call'); await new Promise((r) => s.emit('action', { type: a.type }, r)); }
        await sleep(150);
      }
      if (room.engine.result && room.engine.result.reveal.length >= 2) ok = true;
      else { await p.waitForSelector('.res-ov', { timeout: 8000 }).catch(() => {}); await tap(p, '[data-act="next"]'); await sleep(3200); }
    }
    report.seotdaHand = evalHand(sid(3, 'gwang'), sid(8, 'gwang')).name;
    await sleep(600);
    report.seotdaHold = await p.evaluate(() => ({ ribbon: !!document.querySelector('.end-ribbon'), overlay: !!document.querySelector('.res-ov') }));
    await p.waitForSelector('.res-ov', { timeout: 6000 });
    await sleep(500);
    await shot(p, 'result-seotda');
    report.seotdaResult = await p.evaluate(() => ({ title: document.querySelector('.res-head h2').innerText, how: (document.querySelector('.res-how') || {}).innerText, rows: [...document.querySelectorAll('.rs-row')].map((e) => e.innerText.replace(/\s+/g, ' ')), money: [...document.querySelectorAll('.rm-row')].map((e) => e.innerText.replace(/\s+/g, ' ')) }));
    report.seotdaFits = await fitAll(p);
    s.close(); await p.close();
  }

  await browser.close();
  console.log(JSON.stringify(report, null, 1));
  console.log('ERRORS:', errors.length ? errors : 'none');
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
