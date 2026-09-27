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
const dev = () => crypto.randomBytes(32).toString('base64url');
const fresh = (n) => new Accounts({ databaseUrl: '', file: path.join(TMP, n + '.json') });

test('입장: 기기가 보낸 토큰(43자 base64url)을 그대로 등록 → 응답이 끊겨도 그 토큰으로 자동 로그인', async () => {
  const A = fresh('dev1');
  const t = dev();
  const r = await A.enter('기기사람', undefined, t);
  assert.strictEqual(r.token, t);
  // 이상한 토큰은 무시하고 서버가 새로 만듦
  for (const bad of ['short', 'x'.repeat(42), 'a'.repeat(43) + '=', '가'.repeat(43), 12345, null]) {
    const r2 = await A.enter('다른' + String(bad).length + typeof bad, undefined, bad);
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
  await A.enter('무핀', undefined, dev());
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
  await A.enter('피지기기', undefined, t);
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
  const e = await call(s, 'enter', { nickname: '소켓기기', device: t });
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
