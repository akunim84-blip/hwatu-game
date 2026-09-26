// verify 스크립트 공용: 첫 화면 로그인(닉네임 + PIN) · 보조 소켓을 같은 계정으로 인증
async function login(p, nick, pin = '1234') {
  await p.waitForSelector('#nick', { timeout: 10000 });
  await p.$eval('#nick', (el, v) => { el.value = v; }, nick);
  await p.$eval('#pin', (el, v) => { el.value = v; }, pin);
  await p.$eval('[data-act="enter"]', (el) => el.click());
  await p.waitForSelector('[data-act="solo"]', { timeout: 10000 });
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
