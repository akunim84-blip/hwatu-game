// 기기 기억 (DEVICE_V2): 기기가 만든 토큰 등록, auth 실패 구분(BAD_TOKEN만 지움), PIN 보호 유지
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hwatu-dev-'));
process.env.ACCOUNTS_FILE = path.join(TMP, 'accounts.json');
process.env.AI_DELAY_SCALE = '0.01';
delete process.env.DATABASE_URL;
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Accounts } = require('../lib/accounts');
const { legacyAccount } = require('./_legacy');
const dev = () => crypto.randomBytes(32).toString('base64url');
const fresh = (n) => new Accounts({ databaseUrl: '', file: path.join(TMP, n + '.json') });

test('입장: 기기가 보낸 토큰(43자 base64url)을 그대로 등록 → 응답이 끊겨도 그 토큰으로 자동 로그인', async () => {
  const A = fresh('dev1');
  const t = dev();
  const r = await A.enter('기기사람', '0000', t);
  assert.strictEqual(r.token, t);
  // 이상한 토큰은 무시하고 서버가 새로 만듦
  for (const bad of ['short', 'x'.repeat(42), 'a'.repeat(43) + '=', '가'.repeat(43), 12345, null]) {
    const r2 = await A.enter('다른' + String(bad).length + typeof bad, '0000', bad);
    assert.notStrictEqual(r2.token, bad);
    assert.match(r2.token, /^[A-Za-z0-9_-]{43}$/);
  }
  await A.idle();
  const B = fresh('dev1'); // 재시작
  assert.strictEqual((await B.byToken(t)).nickname, '기기사람');
});

test('PIN 보호 그대로: 기기 토큰을 보내도 PIN 없이/틀린 PIN으로는 입장·토큰 등록 안 됨, PIN 없는 남의 이름도 안 됨', async () => {
  const A = fresh('dev2');
  await A.enter('핀사람', '1234', dev());
  const t = dev();
  await assert.rejects(A.enter('핀사람', undefined, t), /PIN/);
  await assert.rejects(A.enter('핀사람', '9999', t), /맞지 않/);
  assert.strictEqual(await A.byToken(t), null);
  const ok = await A.enter('핀사람', '1234', t);
  assert.strictEqual(ok.token, t);
  assert.strictEqual((await A.byToken(t)).nickname, '핀사람');
  await legacyAccount(A, '무핀');
  const t2 = dev();
  await assert.rejects(A.enter('무핀', undefined, t2), /이미 누가/);
  assert.strictEqual(await A.byToken(t2), null);
});

test('Postgres (pg-mem): 기기 토큰이 hwatu_tokens에 저장되고 재시작 후에도 로그인', async () => {
  let newDb;
  try { ({ newDb } = require('pg-mem')); } catch (e) { return; }
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const A = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await A.ready;
  const t = dev();
  await A.enter('피지기기', '0000', t);
  const B = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await B.ready;
  assert.strictEqual((await B.byToken(t)).nickname, '피지기기');
  assert.strictEqual(db.public.many('SELECT * FROM hwatu_tokens').length, 1);
});

// ---------- 서버 auth 응답 코드 ----------
const { io: ioc } = require('socket.io-client');
const { server, io, accounts } = require('../server');
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => io.close());
const call = (s, ev, d) => new Promise((res) => s.emit(ev, d, res));

test('auth: 없는 토큰은 BAD_TOKEN(기기에서 지움), 저장소 오류는 RETRY(토큰 유지), 기기 토큰으로 입장 후 새 연결에서 auth 성공', async () => {
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => s.on('connect', r));
  assert.strictEqual((await call(s, 'auth', { token: dev() })).code, 'BAD_TOKEN');
  const t = dev();
  const e = await call(s, 'enter', { pin: '0000', nickname: '소켓기기', device: t });
  assert.ok(e.ok); assert.strictEqual(e.token, t);
  const s2 = ioc(base, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => s2.on('connect', r));
  const a = await call(s2, 'auth', { token: t });
  assert.ok(a.ok); assert.strictEqual(a.account.nickname, '소켓기기');
  const orig = accounts.byToken;
  accounts.byToken = async () => { throw new Error('connection terminated'); };
  try {
    const r = await call(s2, 'auth', { token: t });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'RETRY');
  } finally { accounts.byToken = orig; }
  const kind = accounts.kind; accounts.kind = 'json(fallback)';
  try { assert.strictEqual((await call(s2, 'auth', { token: dev() })).code, 'RETRY'); } finally { accounts.kind = kind; }
  s.close(); s2.close();
});

test('새 이름은 PIN 필수 (PIN_REQUIRED_V1): PIN 없음 NEED_NEW_PIN, 확인 단계 CONFIRM_PIN/PIN_MISMATCH(계정 안 만듦), 성공하면 해시 저장', async () => {
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => s.on('connect', r));
  const a = await call(s, 'enter', { nickname: '핀필수' });
  assert.strictEqual(a.code, 'NEED_NEW_PIN'); assert.strictEqual(a.error, '처음 만드는 이름은 PIN 숫자 4자리가 필요해요');
  assert.strictEqual((await call(s, 'enter', { nickname: '핀필수', pin: '12' })).code, 'PIN_FORMAT');
  const c = await call(s, 'enter', { nickname: '핀필수', pin: '4826', confirmNew: true });
  assert.strictEqual(c.code, 'CONFIRM_PIN');
  assert.strictEqual((await call(s, 'enter', { nickname: '핀필수', pin: '4826', pin2: '4827', confirmNew: true })).code, 'PIN_MISMATCH');
  assert.strictEqual(await accounts.load('핀필수'), null, '확인 전에는 계정을 만들지 않음');
  const t = dev();
  const ok = await call(s, 'enter', { nickname: '핀필수', pin: '4826', pin2: '4826', confirmNew: true, device: t });
  assert.ok(ok.ok && ok.created); assert.strictEqual(ok.account.hasPin, true); assert.strictEqual(ok.token, t);
  const acc = await accounts.load('핀필수');
  assert.match(acc.pinHash, /^scrypt\$/); assert.ok(!JSON.stringify(acc).includes('4826'));
  // 이미 있는 이름: confirmNew여도 확인 없이 PIN만 맞으면 입장, 기기 토큰은 PIN 없이 자동 입장
  const s2 = ioc(base, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => s2.on('connect', r));
  assert.strictEqual((await call(s2, 'enter', { nickname: '핀필수', confirmNew: true })).code, 'NEED_PIN');
  assert.strictEqual((await call(s2, 'enter', { nickname: '핀필수', pin: '0000', confirmNew: true })).code, 'BAD_PIN');
  assert.ok((await call(s2, 'enter', { nickname: '핀필수', pin: '4826', confirmNew: true })).ok);
  assert.ok((await call(s2, 'auth', { token: t })).ok);
  s.close(); s2.close();
});

test('PIN 없는 옛 계정: 기기 토큰으로는 그대로 자동 입장(hasPin=false → 화면에서 PIN 설정 안내), 새 기기에서 이름만/아무 PIN은 TAKEN', async () => {
  const old = await legacyAccount(accounts, '옛무핀');
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => s.on('connect', r));
  const au = await call(s, 'auth', { token: old.token });
  assert.ok(au.ok); assert.strictEqual(au.account.hasPin, false);
  for (const d of [{}, { pin: '1234' }, { pin: '1234', pin2: '1234', confirmNew: true }]) {
    assert.strictEqual((await call(s, 'enter', Object.assign({ nickname: '옛무핀' }, d))).code, 'TAKEN');
  }
  const sp = await call(s, 'setPin', { pin: '7777' }); // 로그인한 기기에서 PIN 설정 (지금 PIN 없음)
  assert.ok(sp.ok); assert.strictEqual(sp.account.hasPin, true);
  const s2 = ioc(base, { transports: ['websocket'], forceNew: true });
  await new Promise((r) => s2.on('connect', r));
  assert.ok((await call(s2, 'enter', { nickname: '옛무핀', pin: '7777', confirmNew: true })).ok, '이제 새 기기에서 이름+PIN');
  s.close(); s2.close();
});
