// 48장 매핑 확인용 콘택트 시트 생성 → screenshots/deck_contact_sheet.png
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { HWATU, typeLabel } = require('../shared/cards');
const ROOT = path.join(__dirname, '..');
const MC = ['#999', '#2e7d32', '#c2185b', '#e0457b', '#37474f', '#5e35b1', '#ad1457', '#b71c1c', '#263238', '#d49b00', '#d84315', '#6d4c41', '#1565c0'];
const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/cards/map.json')));
(async () => {
  const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1250, height: 800, deviceScaleFactor: 1 });
  const cells = HWATU.filter((c) => !c.bonus).map((c) => `<div class="cell"><img src="${map[c.id].file}"><div class="card img t-${c.type}" style="background-image:url(${map[c.id].file});--mc:${MC[c.m]}"><span class="mb">${c.m}</span>${c.type === 'ssangpi' ? '<span class="tb">쌍피</span>' : ''}</div><div class="l"><b>${c.m}월 · ${typeLabel(c)}</b><br>id ${c.id}<br><small>${map[c.id].source.replace('Hwatu_', '').replace(/\.(svg|png)$/, '')}</small></div></div>`).join('');
  const extra = `<div class="cell"><img src="back.svg"><div class="l"><b>뒷면</b></div></div><div class="cell"><img src="bonus.svg"><div class="l"><b>보너스 쌍피</b></div></div>`;
  const tmp = path.join(ROOT, 'public/cards/_sheet.html');
  fs.writeFileSync(tmp, `<html><head><link rel="stylesheet" href="../style.css"></head><body style="margin:10px;font-family:'Noto Sans KR',sans-serif;background:#0f3d2e;color:#fff"><h2 style="margin:4px">화투 48장 매핑 확인 (원본 이미지 + 게임 내 표시(월 배지), 4장씩 한 달)</h2><div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px">${cells}${extra}</div>
  <style>.cell .card{align-self:center}.cell{display:flex;align-items:flex-start;gap:6px;background:rgba(0,0,0,.3);padding:5px;border-radius:6px}.cell img{width:62px;height:101px;background:#fff0;border-radius:4px}.l{font-size:12px;line-height:1.35}small{opacity:.7;font-size:10px}</style></body></html>`);
  await p.goto('file://' + tmp, { waitUntil: 'load' });
  fs.unlinkSync(tmp);
  await p.screenshot({ path: path.join(ROOT, 'screenshots/deck_contact_sheet.png'), fullPage: true });
  await b.close();
  console.log('ok');
})();
