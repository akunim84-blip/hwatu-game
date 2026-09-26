// 연출(SHOW_V1) 헤드리스 검증 + 스크린샷: 선 정하기/판 시작 · 콜아웃 도장(고도리·고) · 승리 배너/돈 올라가기 · 섯다 조이기/공개 · 배경음악 토글
// 사용법: node scripts/verify-show.js  (서버를 이 프로세스 안에서 띄움 — 판 상태를 직접 구성하는 테스트 전용)
process.env.AI_DELAY_SCALE = process.env.AI_DELAY_SCALE || '1';
if (!process.env.ACCOUNTS_FILE) process.env.ACCOUNTS_FILE = require('path').join(require('os').tmpdir(), 'hwatu-verify-show-' + Date.now() + '.json');
const puppeteer = require('puppeteer-core');
const { login, authAs } = require('./_login');
const { io } = require('socket.io-client');
const path = require('path');
const { server, rooms } = require('../server');
const { HWATU, SEOTDA } = require('../shared/cards');
const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const card = (m, type) => HWATU.find((c) => c.m === m && c.type === type && !c.bonus).id;
const cards = (m, type) => HWATU.filter((c) => c.m === m && c.type === type && !c.bonus).map((c) => c.id);
function rig(e, spec) {
  const used = new Set();
  const take = (arr) => arr.map((x) => { used.add(x); return x; });
  const fixed = { hands: spec.hands.map(take), caps: spec.caps.map(take), floor: take(spec.floor) };
  if (spec.flip != null) used.add(spec.flip);
  const rest = HWATU.filter((c) => !c.bonus && !used.has(c.id) && !(spec.avoidM || []).includes(c.m)).map((c) => c.id).sort(() => Math.random() - 0.5);
  e.players.forEach((p, i) => { p.hand = fixed.hands[i].slice(); while (p.hand.length < spec.handSize[i]) p.hand.push(rest.pop()); p.captured = fixed.caps[i].slice(); });
  e.floor = fixed.floor.slice(); while (e.floor.length < spec.floorSize) e.floor.push(rest.pop());
  e.deck = rest; if (spec.flip != null) e.deck.push(spec.flip);
  e.turn = 0; e.phase = 'play'; e.pending = null; e.lastPlay = null; e.lastFlip = null;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const BASE = `http://localhost:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR', '--autoplay-policy=no-user-gesture-required'] });
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
  const noScroll = (p) => p.evaluate(() => { const se = document.scrollingElement; return se.scrollHeight <= innerHeight && se.scrollWidth <= innerWidth; });
  const sizes = [[360, 640], [390, 700], [390, 844], [412, 915], [844, 390]];

  // ---- 1) 맞고: 선 정하기 → 판 시작 → 패 돌리기 / 배경음악 ----
  {
    const p = await newPage('start');
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await login(p, '민수');
    report.bgmDefault = await p.evaluate(() => HwatuFX.isBgmOn());
    await p.tap('[data-game="matgo"]'); // 진짜 터치 → 오디오 잠금 해제
    await sleep(300);
    report.bgmLobby = await p.evaluate(() => HwatuFX._bgm());
    await p.tap('[data-act="solo"]');
    await p.waitForSelector('.seon', { timeout: 5000 });
    await sleep(1500);
    report.seon = await p.evaluate(() => ({
      title: document.querySelector('.seon-t').innerText,
      names: [...document.querySelectorAll('.seon-nm')].map((e) => e.innerText),
      flipped: document.querySelectorAll('.seon-p.flip').length,
      winner: (document.querySelector('.seon-p.win .seon-nm') || {}).innerText,
      handHidden: [...document.querySelectorAll('.hand .card')].every((e) => e.classList.contains('fx-hide')),
    }));
    const code = await p.evaluate(() => localStorage.getItem('hw_room'));
    const e = rooms.get(code).engine;
    report.seonServer = { reason: e.seon.reason, seat: e.seon.seat, turn: e.turn, draws: e.seon.draws.map((d) => HWATU[d.card].m + '월') };
    await shot(p, 'start-seon');
    await p.waitForSelector('.stamp.s-start', { timeout: 4000 });
    await sleep(250);
    await shot(p, 'start-stamp');
    report.bgmGame = await p.evaluate(() => HwatuFX._bgm());
    await p.waitForFunction(() => { const v = HwatuFX._voice(); return v.total && v.loaded + v.failed >= v.total; }, { timeout: 15000 }).catch(() => {});
    report.voice = await p.evaluate(() => ({ st: HwatuFX._voice(), godori: HwatuFX.say('고도리'), go7: HwatuFX.voiceKey('7고'), unknown: HwatuFX.say('없는말') }));
    await sleep(4200);
    report.afterDeal = await p.evaluate(() => ({ seon: !!document.querySelector('.seon'), hand: document.querySelectorAll('.hand .card').length, hidden: document.querySelectorAll('.fx-hide').length }));
    // 배경음악 토글 → 저장
    await p.tap('[data-act="bgm"]'); await sleep(400);
    report.bgmOff = await p.evaluate(() => ({ on: HwatuFX.isBgmOn(), ls: localStorage.getItem('hw_bgm'), st: HwatuFX._bgm(), btnOff: document.querySelector('[data-act="bgm"]').classList.contains('off') }));
    await p.reload({ waitUntil: 'networkidle0' }); await sleep(1500);
    report.bgmPersist = await p.evaluate(() => HwatuFX.isBgmOn());
    await p.tap('[data-act="bgm"]'); await sleep(300);
    report.bgmBackOn = await p.evaluate(() => HwatuFX._bgm());
    const fits = {};
    for (const [w, h] of sizes) { await p.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(400); fits[`${w}x${h}`] = await noScroll(p); }
    report.gameFits = fits;
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(300);

    // ---- 2) 콜아웃: 고도리 완성 도장 ----
    const s = io(BASE, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.on('connect', r));
    await authAs(s, p);
    const bump = () => new Promise((r) => s.emit('joinRoom', { code }, r));
    if (rooms.get(code).timer) { clearTimeout(rooms.get(code).timer); rooms.get(code).timer = null; }
    rig(e, {
      handSize: [5, 5], floorSize: 4, avoidM: [8],
      caps: [[card(2, 'yeol'), card(4, 'yeol')], []],
      hands: [[card(8, 'yeol'), card(11, 'gwang')], []],
      floor: [cards(8, 'pi')[0], card(1, 'gwang'), card(10, 'yeol'), card(12, 'tti')],
      flip: cards(9, 'pi')[0],
    });
    await bump(); await sleep(600);
    await p.$eval(`.hand [data-hand=\"${card(8, 'yeol')}\"]`, (el) => el.click()); await sleep(150); await tap(p, '[data-act=\"playSel\"]');
    await p.waitForFunction(() => [...document.querySelectorAll('.stamp .st-txt')].some((x) => x.textContent === '고도리'), { timeout: 5000 }).catch(() => {});
    await sleep(350);
    report.godoriStamp = await p.evaluate(() => [...document.querySelectorAll('.stamp')].map((x) => x.innerText.replace(/\s+/g, ' ')));
    await shot(p, 'callout-godori');
    await sleep(1500);

    // ---- 3) 콜아웃: 7점 → 고! ----
    if (rooms.get(code).timer) { clearTimeout(rooms.get(code).timer); rooms.get(code).timer = null; }
    rig(e, {
      handSize: [4, 4], floorSize: 4, avoidM: [3],
      caps: [[card(1, 'gwang'), card(8, 'gwang'), card(1, 'tti'), card(2, 'tti'), card(4, 'tti'), card(5, 'tti')], [cards(6, 'pi')[0]]],
      hands: [[card(3, 'tti')], []],
      floor: [card(3, 'gwang'), card(10, 'yeol'), card(12, 'yeol'), card(6, 'tti')],
      flip: cards(9, 'pi')[1],
    });
    await bump(); await sleep(600);
    await p.$eval(`.hand [data-hand=\"${card(3, 'tti')}\"]`, (el) => el.click()); await sleep(150); await tap(p, '[data-act=\"playSel\"]');
    await p.waitForSelector('[data-gs="go"]', { timeout: 6000 });
    await sleep(900);
    await tap(p, '[data-gs="go"]');
    await p.waitForFunction(() => [...document.querySelectorAll('.stamp .st-txt')].some((x) => x.textContent === '1고!'), { timeout: 5000 }).catch(() => {});
    await sleep(300);
    report.goStamp = await p.evaluate(() => [...document.querySelectorAll('.stamp')].map((x) => x.innerText.replace(/\s+/g, ' ')));
    await shot(p, 'callout-go');
    await sleep(1500);

    // ---- 4) 승리: 마지막 패로 나기 (광박) → 판 끝 → 승리 배너 + 꽃가루 → 돈 올라가기 ----
    if (rooms.get(code).timer) { clearTimeout(rooms.get(code).timer); rooms.get(code).timer = null; }
    rig(e, {
      handSize: [1, 0], floorSize: 4, avoidM: [3],
      caps: [[card(1, 'gwang'), card(3, 'gwang'), card(8, 'gwang'), card(1, 'tti'), card(2, 'tti'), card(4, 'tti'), card(5, 'tti')], [cards(6, 'pi')[0], card(9, 'yeol')]],
      hands: [[card(3, 'tti')], []],
      floor: [cards(3, 'pi')[0], card(10, 'yeol'), card(12, 'yeol'), card(6, 'tti')],
      flip: card(7, 'yeol'),
    });
    e.players.forEach((q) => { q.go = 0; q.lastGoScore = 0; });
    await bump(); await sleep(600);
    await p.$eval(`.hand [data-hand=\"${card(3, 'tti')}\"]`, (el) => el.click()); await sleep(150); await tap(p, '[data-act=\"playSel\"]');
    await p.waitForSelector('.res-ov', { timeout: 8000 });
    await p.evaluate(() => { window.__cs = []; [300, 1100, 1400, 2100].forEach((t) => setTimeout(() => window.__cs.push(t + 'ms ' + [...document.querySelectorAll('.rm-d')].map((x) => x.textContent).join(' / ')), t)); });
    await sleep(450);
    report.winBanner = await p.evaluate(() => ({ banner: (document.querySelector('.end-bn') || {}).innerText, canvas: !!document.querySelector('#show-layer canvas'), intro: document.querySelector('.res-ov').classList.contains('intro') }));
    await shot(p, 'win-banner');
    await sleep(1050);
    report.countSamples = await p.evaluate(() => window.__cs);
    await sleep(1400);
    await shot(p, 'win-result');
    report.countEnd = await p.evaluate(() => ({ shown: [...document.querySelectorAll('.rm-d')].map((x) => x.textContent), baks: [...document.querySelectorAll('.bak')].map((x) => x.innerText) }));
    // 결과 카드는 그대로 (탭해야 닫힘)
    await sleep(2000);
    report.resStays = !!(await p.$('.res-ov'));
    s.close(); await p.close();
  }

  // ---- 5) 섯다: 조이기 → 공개(38광땡 도장) ----
  {
    const p = await newPage('seotda');
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await login(p, '영희');
    await tap(p, '[data-game="seotda"]');
    await tap(p, '[data-aic="2"]');
    await tap(p, '[data-act="solo"]');
    await p.waitForSelector('.sd-me');
    await sleep(3200);
    const code = await p.evaluate(() => localStorage.getItem('hw_room'));
    const room = rooms.get(code);
    const s = io(BASE, { transports: ['websocket'], forceNew: true });
    await new Promise((r) => s.on('connect', r));
    await authAs(s, p);
    const sid = (m, type) => SEOTDA.find((c) => c.m === m && c.type === type).id;
    const e0 = room.engine, me0 = e0.seatOf('u:영희');
    e0.seats[me0].cards = [sid(3, 'gwang'), sid(8, 'gwang')];
    await new Promise((r) => s.emit('joinRoom', { code }, r)); await sleep(500);
    report.sqStart = await p.evaluate(() => ({ sq: !!document.querySelector('.sd-me .sq'), hint: (document.querySelector('.sq-hint') || {}).innerText, hnHidden: !!document.querySelector('.sd-me .hn.hid') }));
    await shot(p, 'seotda-squeeze-start');
    const box = await (await p.$('.sd-me .sq')).boundingBox();
    const cx = box.x + box.width / 2;
    await p.mouse.move(cx, box.y + box.height - 5); await p.mouse.down();
    for (let k = 1; k <= 8; k++) { await p.mouse.move(cx, box.y + box.height - 5 - k * box.height * 0.06); await sleep(30); }
    await sleep(150);
    report.sqMid = await p.evaluate(() => (document.querySelector('.sq-cover') || {}).style && document.querySelector('.sq-cover').style.transform);
    await shot(p, 'seotda-squeeze');
    await p.mouse.up();
    await sleep(200);
    await p.mouse.click(cx, box.y + box.height / 2); // 탭 → 천천히 끝까지
    await sleep(1400);
    report.sqDone = await p.evaluate(() => ({ sq: !!document.querySelector('.sd-me .sq'), hn: document.querySelector('.sd-me .hn').innerText, hnHidden: !!document.querySelector('.sd-me .hn.hid'), stamp: [...document.querySelectorAll('.stamp')].map((x) => x.innerText.replace(/\s+/g, ' ')) }));
    await shot(p, 'seotda-squeeze-done');
    // 공개: 끝까지 체크/콜
    let ok = false;
    for (let tries = 0; tries < 6 && !ok; tries++) {
      const e = room.engine, me = e.seatOf('u:영희');
      e.seats[me].cards = [sid(3, 'gwang'), sid(8, 'gwang')];
      const others = e.seats.map((x, i) => i).filter((i) => i !== me);
      e.seats[others[0]].cards = [sid(4, 'yeol'), sid(5, 'yeol')];
      if (others[1] != null) e.seats[others[1]].cards = [sid(2, 'tti'), sid(7, 'tti')];
      await new Promise((r) => s.emit('joinRoom', { code }, r));
      const t0 = Date.now();
      while (!room.engine.over && Date.now() - t0 < 20000) {
        const en = room.engine;
        if (en.turn === me) { const o = en.options(me); const a = o.find((x) => x.type === 'check') || o.find((x) => x.type === 'call'); await new Promise((r) => s.emit('action', { type: a.type }, r)); }
        await sleep(120);
      }
      if (room.engine.result && room.engine.result.reveal.length >= 2) ok = true;
      else { await p.waitForSelector('.res-ov', { timeout: 8000 }).catch(() => {}); await tap(p, '[data-act="next"]'); await sleep(3500); }
    }
    await p.waitForFunction(() => [...document.querySelectorAll('.stamp .st-txt')].some((x) => /광땡/.test(x.textContent)), { timeout: 5000 }).catch(() => {});
    await sleep(250);
    report.showdown = await p.evaluate(() => ({ stamp: [...document.querySelectorAll('.stamp')].map((x) => x.innerText.replace(/\s+/g, ' ')), flipped: document.querySelectorAll('.sd-seat .card.rv').length }));
    await shot(p, 'seotda-showdown');
    await p.waitForSelector('.res-ov', { timeout: 6000 });
    await sleep(500);
    report.seotdaBanner = await p.evaluate(() => (document.querySelector('.end-bn') || {}).innerText);
    await shot(p, 'seotda-win');
    s.close(); await p.close();
  }

  // ---- 6) 작은 화면/가로 화면에서 선 정하기·도장 ----
  for (const [w, h, nm] of [[360, 640, '작은폰'], [844, 390, '가로폰']]) {
    const p = await newPage('small-' + w, w, h);
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await login(p, nm);
    await tap(p, '[data-game="matgo"]');
    await tap(p, '[data-act="solo"]');
    await p.waitForSelector('.seon', { timeout: 5000 });
    await sleep(1600);
    report['seonBox' + w] = await p.evaluate(() => { const b = document.querySelector('.seon-box').getBoundingClientRect(); return b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; });
    await shot(p, `start-seon-${w}x${h}`);
    await p.waitForSelector('.stamp.s-start', { timeout: 4000 }); await sleep(250);
    report['stampBox' + w] = await p.evaluate(() => { const b = document.querySelector('.stamp .st-txt').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; });
    await shot(p, `start-stamp-${w}x${h}`);
    await p.close();
  }

  await browser.close();
  console.log(JSON.stringify(report, null, 1));
  console.log('ERRORS:', errors.length ? errors : 'none');
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
