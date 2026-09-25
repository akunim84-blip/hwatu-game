// public/cards/src 의 원본(SVG/PNG, Wikimedia Commons CC BY-SA 4.0)을 모바일용 PNG로 변환 + 매핑
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'assets', 'hwatu-src');
const OUT = path.join(__dirname, '..', 'public', 'cards');
const M = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// 우리 카드 id 순서((월-1)*4+i)에 맞춘 원본 파일 이름
const NAMES = {
  1: ['Hikari', 'Tanzaku', 'Kasu 1', 'Kasu 2'],
  2: ['Tane', 'Tanzaku', 'Kasu 1', 'Kasu 2'],
  3: ['Hikari', 'Tanzaku', 'Kasu 1', 'Kasu 2'],
  4: ['Tane', 'Tanzaku', 'Kasu 1', 'Kasu 2'],
  5: ['Tane', 'Tanzaku', 'Kasu 1', 'Kasu 2'],
  6: ['Tane', 'Tanzaku', 'Kasu 1', 'Kasu 2'],
  7: ['Tane', 'Tanzaku', 'Kasu 1', 'Kasu 2'],
  8: ['Hikari', 'Tane', 'Kasu 1', 'Kasu 2'],
  9: ['Tane', 'Tanzaku', 'Kasu 1', 'Kasu 2'],
  10: ['Tane', 'Tanzaku', 'Kasu 1', 'Kasu 2'],
  11: ['Hikari', process.env.NOV_SSANG || 'Kasu 2', 'Kasu 1', 'Kasu 3'],
  12: ['Hikari', 'Tane', 'Tanzaku', 'Kasu'],
};
function srcFile(m, n) {
  const base = `Hwatu_${M[m - 1]}_${n.replace(/ /g, '_')}`;
  for (const ext of ['.svg', '.png']) if (fs.existsSync(path.join(SRC, base + ext))) return base + ext;
  throw new Error('missing ' + base);
}
(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 103, height: 168, deviceScaleFactor: 2 });
  const map = {};
  for (let m = 1; m <= 12; m++) {
    for (let i = 0; i < 4; i++) {
      const id = (m - 1) * 4 + i;
      const f = srcFile(m, NAMES[m][i]);
      const tmp = path.join(SRC, '_render.html');
      fs.writeFileSync(tmp, `<html><body style="margin:0;background:transparent"><img id="c" src="${f}" style="display:block;width:103px;height:168px"></body></html>`);
      await page.goto('file://' + tmp, { waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('c').complete);
      const out = `c${String(id).padStart(2, '0')}.png`;
      await page.screenshot({ path: path.join(OUT, out), omitBackground: true, clip: { x: 0, y: 0, width: 103, height: 168 } });
      map[id] = { file: out, source: f };
    }
  }
  fs.unlinkSync(path.join(SRC, '_render.html'));
  fs.writeFileSync(path.join(OUT, 'map.json'), JSON.stringify(map, null, 1));
  await browser.close();
  console.log('built', Object.keys(map).length);
})();
