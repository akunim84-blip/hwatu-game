// verify 스크립트 공용: 첫 화면 입장(이름만, PIN 걸린 이름이면 PIN) · 보조 소켓을 같은 계정으로 인증
async function login(p, nick, pin = '1234') {
  await p.waitForSelector('#nick', { timeout: 10000 });
  await p.$eval('#nick', (el, v) => { el.value = v; }, nick);
  await p.$eval('[data-act="enter"]', (el) => el.click());
  // 결과: 첫 화면(로비 목록) / 초대받은 방 / PIN 요청
  await p.waitForFunction(() => document.querySelector('[data-act="solo"]') || document.querySelector('.hdr') || document.getElementById('pin') || document.querySelector('.login-msg.err'), { timeout: 10000 });
  if (await p.$('#pin')) {
    await p.$eval('#pin', (el, v) => { el.value = v; }, pin);
    await p.$eval('[data-act="enter"]', (el) => el.click());
  }
  await p.waitForFunction(() => document.querySelector('[data-act="solo"]') || document.querySelector('.hdr'), { timeout: 10000 });
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
