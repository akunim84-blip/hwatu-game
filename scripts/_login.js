// verify 스크립트 공용: 첫 화면 입장(이름만, PIN 걸린 이름이면 PIN) · 보조 소켓을 같은 계정으로 인증
// 같은 이름으로 다른 브라우저(컨텍스트)에서 다시 들어갈 때는 처음 받은 기기 토큰을 그대로 넣어 '같은 기기'처럼 자동 로그인
// (PIN 없는 이름은 새 기기에서 '이미 쓰는 이름'으로 막히므로)
const tokenCache = {};
async function login(p, nick, pin = '1234') {
  await p.waitForSelector('#nick', { timeout: 10000 });
  if (tokenCache[nick]) {
    await p.evaluate((t, n) => { localStorage.setItem('hw_token', t); localStorage.setItem('hw_name', n); }, tokenCache[nick], nick);
    await p.reload({ waitUntil: 'networkidle0' });
    await p.waitForFunction(() => document.querySelector('[data-act="solo"]') || document.querySelector('.hdr'), { timeout: 10000 });
    return;
  }
  await p.$eval('#nick', (el, v) => { el.value = v; }, nick);
  await p.$eval('[data-act="enter"]', (el) => el.click());
  // 결과: 첫 화면(로비 목록) / 초대받은 방 / PIN 요청
  await p.waitForFunction(() => document.querySelector('[data-act="solo"]') || document.querySelector('.hdr') || document.getElementById('pin') || document.querySelector('.login-msg.err'), { timeout: 10000 });
  if (await p.$('#pin')) {
    await p.$eval('#pin', (el, v) => { el.value = v; }, pin);
    await p.$eval('[data-act="enter"]', (el) => el.click());
  }
  await p.waitForFunction(() => document.querySelector('[data-act="solo"]') || document.querySelector('.hdr'), { timeout: 10000 });
  tokenCache[nick] = await p.evaluate(() => localStorage.getItem('hw_token'));
}
// 브라우저와 같은 계정으로 소켓 인증 (계정 플레이어 id = 'u:' + 닉네임 소문자)
async function authAs(s, p) {
  const token = await p.evaluate(() => localStorage.getItem('hw_token'));
  const r = await new Promise((res) => s.emit('auth', { token }, res));
  if (!r || !r.ok) throw new Error('auth 실패');
  return r.account;
}
const pidOf = (p) => p.evaluate(() => 'u:' + (localStorage.getItem('hw_name') || '').toLowerCase());
module.exports = { login, authAs, pidOf };
