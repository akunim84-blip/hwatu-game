// 사람 목소리 외침(VOICE_V1): 엔진이 내는 모든 외침/족보 이름 → public/voice 클립이 있는지, 용량 제한
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { SEOTDA } = require('../shared/cards');
const { evalHand } = require('../lib/seotda');
const DIR = path.join(__dirname, '..', 'public', 'voice');

function loadFX() {
  const noop = () => {};
  const win = {};
  const ctx = { window: win, document: { addEventListener: noop, removeEventListener: noop, hidden: false }, localStorage: { getItem: () => null, setItem: noop }, Element: { prototype: {} }, setTimeout, clearTimeout, setInterval, clearInterval, console };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'fx.js'), 'utf8'), ctx);
  return win.HwatuFX;
}

test('모든 외침·족보 이름에 목소리 클립(mp3+webm)이 있고, 전체 1.5MB 이하', () => {
  const FX = loadFX();
  const man = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const names = new Set(['스톱', '뻑', '뻑 먹기', '삼뻑', '따닥', '쪽', '싹쓸이', '흔들기', '폭탄', '고도리', '홍단', '청단', '초단', '삼광', '비삼광', '사광', '오광', '광박!', '피박!', '고박!', '나가리', '선', '시작', '승리', '패배']);
  for (let n = 1; n <= 8; n++) names.add(n + '고');
  for (let i = 0; i < SEOTDA.length; i++) for (let j = i + 1; j < SEOTDA.length; j++) names.add(evalHand(SEOTDA[i].id, SEOTDA[j].id).name);
  for (const n of names) {
    const k = FX.voiceKey(n);
    assert.ok(k, '키 없음: ' + n);
    assert.ok(man.clips[k], 'manifest에 없음: ' + n + ' → ' + k);
  }
  assert.strictEqual(FX.voiceKey('7고'), 'go');
  assert.strictEqual(FX.voiceKey('38광땡'), 'sd_38');
  let total = 0;
  for (const k of Object.keys(man.clips)) for (const ext of ['mp3', 'webm']) {
    const f = path.join(DIR, k + '.' + ext);
    assert.ok(fs.existsSync(f), '파일 없음: ' + f);
    total += fs.statSync(f).size;
  }
  assert.ok(total < 1.5 * 1024 * 1024, '용량 ' + total);
});
