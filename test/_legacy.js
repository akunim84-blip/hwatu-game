// 테스트 도우미: PIN 없는 옛 계정(PIN_REQUIRED_V1 이전에 이름만으로 만든 계정)을 저장소에 직접 만듦
const crypto = require('crypto');
const { keyOf, cleanNick, START_MONEY } = require('../lib/accounts');
async function legacyAccount(A, nick) {
  await A.ready;
  const token = crypto.randomBytes(32).toString('base64url');
  const key = keyOf(nick);
  const a = { key, nickname: cleanNick(nick), pinHash: null, balance: START_MONEY, bankruptCount: 0, tokens: [crypto.createHash('sha256').update(token).digest('hex')], createdAt: Date.now(), lastSeen: Date.now() };
  if (!(await A.store.insert(a))) throw new Error('이미 있는 이름');
  A.cache.set(key, a);
  return { token, account: A.pub(a), created: true, key };
}
module.exports = { legacyAccount };
