// 모바일 UI 스크린샷 (390x844). 사용법: node scripts/screenshots.js [baseUrl]
const puppeteer = require('puppeteer-core');
const { io } = require('socket.io-client');
const path = require('path');
const BASE = process.argv[2] || 'http://localhost:3300';
const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function socketBot(name, strategy) {
  const b = { pid: 'shot-' + name + Math.random().toString(36).slice(2, 6), name, lastSeq: -1 };
  b.sock = io(BASE, { transports: ['websocket'], forceNew: true });
  b.emit = (e, d) => new Promise((r) => b.sock.emit(e, d, r));
  b.sock.on('state', (st) => {
    const g = st.game;
    if (!g || g.result || st.room.actSeq === b.lastSeq) return;
    let a = null;
    if (g.kind === 'seotda') {
      const o = g.options || [];
      if (o.length) a = { type: (o.find((x) => x.type === 'call') || o.find((x) => x.type === 'bbing') || o.find((x) => x.type === 'check')).type };
    } else if (g.options) {
      const o = g.options;
      if (o.phase === 'play') {
        const c = o.cards.find((x) => x.matches && x.matches.length) || o.cards[0];
        a = c ? { type: 'play', card: c.id, floorCard: c.matches && c.matches[0] } : { type: 'flipOnly' };
      } else if (o.phase === 'chooseFlip') a = { type: 'chooseFlip', floorCard: o.choices[0] };
      else if (o.phase === 'goStop') a = { type: strategy === 'go' ? 'go' : 'stop' };
    }
    if (!a) return;
    b.lastSeq = st.room.actSeq;
    setTimeout(() => b.emit('action', a), 150);
  });
  return b;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR', '--font-render-hinting=none'] });
  const shots = [];
  const newPage = async () => {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.0');
    return p;
  };
  const shot = async (p, name) => { const f = path.join(OUT, name + '.png'); await sleep(400); await p.screenshot({ path: f }); shots.push(f); console.log('saved', f); };
  const tap = async (p, sel) => { await p.waitForSelector(sel, { timeout: 8000 }); await p.$eval(sel, (el) => el.click()); };

  async function hostRoom(game, nick) {
    const p = await newPage();
    await p.goto(BASE, { waitUntil: 'networkidle0' });
    await p.$eval('#nick', (el, v) => { el.value = v; }, nick);
    await tap(p, `[data-game="${game}"]`);
    if (game === 'seotda') await tap(p, '[data-pp="100"]');
    else await tap(p, '[data-pp="10"]');
    return p;
  }

  // 1) 랜딩
  const land = await newPage();
  await land.goto(BASE, { waitUntil: 'networkidle0' });
  await land.$eval('#nick', (el) => { el.value = '민수'; });
  await shot(land, '00_landing');

  for (const [game, n, label] of [['seotda', 4, 'seotda'], ['matgo', 2, 'matgo'], ['gostop', 3, 'gostop']]) {
    const p = await hostRoom(game, '민수');
    await tap(p, '[data-act="create"]');
    await p.waitForSelector('.code-big');
    const code = await p.$eval('.code-big', (el) => el.textContent.trim());
    // 초대 링크로 들어온 친구 1명은 실제 브라우저
    const friend = await newPage();
    await friend.goto(`${BASE}/?room=${code}`, { waitUntil: 'networkidle0' });
    if (game === 'seotda') await shot(friend, `${label}_00_invite_landing`);
    await friend.$eval('#nick', (el) => { el.value = '지영'; });
    await tap(friend, '[data-act="joinUrl"]');
    await friend.waitForSelector('.code-big');
    const bots = [];
    const names = ['철수', '영희', '동훈'];
    for (let i = 0; i < n - 2; i++) {
      const b = socketBot(names[i], 'stop');
      await new Promise((r) => b.sock.on('connect', r));
      await b.emit('joinRoom', { code, pid: b.pid, name: names[i] });
      bots.push(b);
    }
    await sleep(300);
    await shot(p, `${label}_01_lobby`);
    await tap(p, '[data-act="start"]');
    await sleep(500);

    // 브라우저 두 명의 자동 조작 (카드 두 번 탭 방식)
    async function autoplay(page, strategy) {
      return page.evaluate(async (strategy) => {
        const q = (s) => document.querySelector(s);
        if (q('[data-gs]')) { q(`[data-gs="${strategy}"]`).click(); return 'gs'; }
        if (q('[data-flipc]')) { q('[data-flipc]').click(); return 'flip'; }
        if (q('[data-choose]')) { q('[data-choose]').click(); return 'choose'; }
        if (q('[data-shake="0"]')) { q('[data-shake="0"]').click(); return 'shake'; }
        const bet = q('[data-bet="call"]') || q('[data-bet="bbing"]') || q('[data-bet="check"]');
        if (bet) { bet.click(); return 'bet'; }
        const turn = q('.turnbar') && !q('.turnbar.wait');
        if (turn) {
          const c = q('.hand .card.hl') || q('.hand .card');
          if (c) { c.click(); await new Promise((r) => setTimeout(r, 120)); const again = q('.hand .card.sel'); if (again) again.click(); return 'play'; }
          const f = q('[data-act="flipOnly"]'); if (f) { f.click(); return 'flipOnly'; }
        }
        return null;
      }, strategy);
    }
    const isMyTurn = (page) => page.evaluate(() => !!(document.querySelector('.turnbar') && !document.querySelector('.turnbar.wait')));

    if (game === 'seotda') {
      // 지영 차례/민수 차례까지 진행, 베팅 버튼이 보이는 상태 캡처
      for (let k = 0; k < 40; k++) {
        if (await isMyTurn(p)) break;
        await autoplay(friend, 'stop');
        await sleep(250);
      }
      await shot(p, `${label}_02_midgame_betting`);
      await tap(p, '[data-act="rules"]');
      await shot(p, `${label}_03_rules`);
      await tap(p, '.modal [data-act="close"]');
      for (let k = 0; k < 60; k++) {
        if (await p.$('.modal .delta')) break;
        await autoplay(p, 'stop'); await autoplay(friend, 'stop');
        await sleep(250);
      }
      await shot(p, `${label}_04_result`);
    } else {
      // 몇 턴 진행 후 내 차례에서 캡처
      let turns = 0;
      for (let k = 0; k < 200 && turns < (game === 'matgo' ? 5 : 3); k++) {
        if (await p.$('.modal .delta')) break;
        if (await isMyTurn(p)) { if (await autoplay(p, 'go')) turns++; }
        await autoplay(friend, 'go');
        await sleep(250);
      }
      for (let k = 0; k < 40 && !(await isMyTurn(p)); k++) { await autoplay(friend, 'go'); await sleep(250); }
      // 카드 하나 선택한 상태 (매칭 하이라이트 보이게)
      await p.evaluate(() => { const c = document.querySelector('.hand .card.hl') || document.querySelector('.hand .card'); if (c && !document.querySelector('.hand .card.sel')) c.click(); });
      await shot(p, `${label}_02_midgame_myturn`);
      await shot(friend, `${label}_03_midgame_opponent_view`);
      for (let k = 0; k < 400; k++) {
        if (await p.$('.modal .delta')) break;
        await autoplay(p, 'stop'); await autoplay(friend, 'stop');
        await sleep(200);
      }
      await shot(p, `${label}_04_result`);
      if (game === 'gostop') { await tap(p, '.modal [data-act="board"]'); await shot(p, `${label}_05_scoreboard`); }
    }
    bots.forEach((b) => b.sock.disconnect());
    await p.evaluate(() => 0);
  }
  await browser.close();
  console.log(JSON.stringify(shots, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
