// 효과 글자 글꼴 확인 (FXFONT_V1): 도장·배너·선 정하기를 390x844에서 띄우고
// 크롬 CDP CSS.getPlatformFontsForNode로 실제로 그려진 글꼴을 조사 → 한 글꼴(Black Han Sans)만 쓰였는지.
// 스크린샷: screenshots/stamp-font-*.png. 사용: node scripts/verify-stamp-font.js [URL]
const path = require('path');
const puppeteer = require('puppeteer-core');
const URL = process.argv[2] || 'http://localhost:3300/';
const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CASES = [
  ['godori', 'stamp', '고도리', 'gold'], ['three-go', 'stamp', '쓰리 고', 'go'], ['ppuk', 'stamp', '뻑이다', 'bad'],
  ['38gwang', 'stamp', '38광땡', 'gold'], ['start', 'stamp', '판 시작', 'start'], ['stop', 'stamp', '스톱!', 'stop'],
  ['win', 'banner', '승리!', 'win'], ['lose', 'banner', '패배', 'lose'], ['nagari', 'banner', '나가리', 'draw'], ['seon', 'seon', '선 정하기'],
];
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--lang=ko-KR'] });
  const report = {}; const errors = [];
  try {
    const p = await browser.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.goto(URL, { waitUntil: 'networkidle0' });
    const cdp = await p.target().createCDPSession();
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const fontsOf = async (sel) => {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
      const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: sel });
      const fams = {};
      for (const id of nodeIds) for (const f of (await cdp.send('CSS.getPlatformFontsForNode', { nodeId: id })).fonts) fams[f.familyName] = (fams[f.familyName] || 0) + f.glyphCount;
      return fams;
    };
    report.fontLoaded = await p.evaluate(async () => { await document.fonts.load('400 64px HyukFx', '가'); return document.fonts.check('400 64px HyukFx', '고도리'); });
    for (const [name, type, text, kind] of CASES) {
      await p.evaluate(() => { const S = window.HwatuShow; S.clear(); S.clearSeon && S.clearSeon(); document.querySelectorAll('#show-layer > *:not(canvas)').forEach((e) => e.remove()); });
      await p.evaluate((type, text, kind) => {
        const S = window.HwatuShow;
        if (type === 'stamp') S.stamp(text, kind, { sub: '나', dur: 5000, say: '' });
        else if (type === 'banner') S.endBanner(kind, text, kind === 'lose' ? '민수 승리' : kind === 'draw' ? '다음 판 점수 2배' : '12점');
        else S.seon({ title: text, rows: [] });
      }, type, text, kind);
      const sel = type === 'stamp' ? '.stamp .st-txt span' : type === 'banner' ? '.end-bn .eb-t span' : '.seon-t';
      await p.waitForSelector(sel, { timeout: 5000 });
      await sleep(type === 'seon' ? 150 : 700);
      const fams = await fontsOf(sel);
      const shown = await p.$eval(sel, (e) => e.textContent);
      report[name] = { text: shown, fonts: fams, ok: shown === text && Object.keys(fams).length === 1 && /Black Han Sans/i.test(Object.keys(fams)[0]) };
      await p.screenshot({ path: path.join(OUT, `stamp-font-${name}.png`) });
    }
  } catch (e) { errors.push(e.stack || String(e)); }
  await browser.close();
  console.log(JSON.stringify(report, null, 1));
  const bad = Object.entries(report).filter(([k, v]) => (typeof v === 'object' ? !v.ok : !v)).map(([k]) => k);
  console.log('ERRORS:', errors.concat(bad.map((b) => 'font ' + b)).join(' | ') || 'none');
  process.exit(errors.length || bad.length ? 1 : 0);
})();
