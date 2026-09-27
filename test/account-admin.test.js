// 계정 삭제 (본인) + 관리자 페이지 (/admin: 키 인증·세션 쿠키·틀린 키 제한·계정 관리·방 닫기)
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hwatu-adm-'));
process.env.ACCOUNTS_FILE = path.join(TMP, 'server-accounts.json');
process.env.AI_DELAY_SCALE = '0.01';
process.env.ADMIN_KEY = 'TestKey23456789abcdefghj';
delete process.env.DATABASE_URL;
const test = require('node:test');
const assert = require('node:assert');
const { Accounts } = require('../lib/accounts');
const { legacyAccount } = require('./_legacy');
const fresh = (name) => new Accounts({ databaseUrl: '', file: path.join(TMP, name + '.json') });

test('계정 삭제: 이름 확인·PIN 필요, 삭제 후 토큰 무효·이름 다시 쓸 수 있음·재시작해도 없음', async () => {
  const A = fresh('del');
  const r = await legacyAccount(A, '지울사람'); // PIN 없는 옛 계정: 이름 확인만으로 삭제
  await A.settle('지울사람', 500000);
  await assert.rejects(A.remove('지울사람', '다른이름'), (e) => e.code === 'CONFIRM');
  await assert.rejects(A.remove('지울사람', ''), (e) => e.code === 'CONFIRM');
  await assert.rejects(A.remove('없음', '없음'), (e) => e.code === 'NO_ACCOUNT');
  const out = await A.remove('지울사람', ' 지울사람 ');
  assert.strictEqual(out.nickname, '지울사람');
  assert.strictEqual(await A.byToken(r.token), null, '기기 토큰으로 더는 못 들어옴');
  assert.ok(!(await A.top(10)).some((x) => x.nickname === '지울사람'), '순위에서 빠짐');
  await A.settle('지울사람', 1000); // 지운 계정 정산 시도 → 다시 생기지 않음
  const again = await A.enter('지울사람', '0000');
  assert.strictEqual(again.created, true); assert.strictEqual(again.account.balance, 1000000, '같은 이름 새 계정은 새 돈');
  // PIN 계정
  await A.enter('핀계정', '1234');
  await assert.rejects(A.remove('핀계정', '핀계정'), (e) => e.code === 'NEED_PIN');
  await assert.rejects(A.remove('핀계정', '핀계정', '9999'), (e) => e.code === 'BAD_PIN');
  await A.remove('핀계정', '핀계정', '1234');
  await A.idle();
  const B = fresh('del');
  assert.strictEqual(await B.byToken(r.token), null);
  assert.strictEqual((await B.byToken(again.token)).balance, 1000000);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(TMP, 'del.json'), 'utf8')).accounts['핀계정']);
});

test('계정 삭제 (pg-mem): 계정 행·토큰 행을 트랜잭션으로 삭제', async () => {
  let newDb;
  try { ({ newDb } = require('pg-mem')); } catch (e) { return; }
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const A = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await A.ready;
  const r = await A.enter('피지', '4444');
  await A.enter('피지', '4444'); // 토큰 2개
  assert.strictEqual(db.public.many("SELECT * FROM hwatu_tokens WHERE nick_key='피지'").length, 2);
  await A.remove('피지', '피지', '4444');
  assert.strictEqual(db.public.many("SELECT * FROM hwatu_tokens WHERE nick_key='피지'").length, 0);
  assert.strictEqual(db.public.many("SELECT * FROM hwatu_accounts WHERE nick_key='피지'").length, 0);
  const B = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await B.ready;
  assert.strictEqual(await B.byToken(r.token), null);
  assert.strictEqual((await B.enter('피지', '0000')).created, true);
  // 관리자 목록·잔액·PIN 재설정도 Postgres에서
  await B.adminSetBalance('피지', 777);
  await B.adminSetPin('피지', '0101');
  const C = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await C.ready;
  const l = await C.adminList('피');
  assert.strictEqual(l[0].balance, 777); assert.strictEqual(l[0].hasPin, true); assert.ok(l[0].createdAt > 0);
  assert.strictEqual((await C.enter('피지', '0101')).created, false);
});

// ---------- 서버 ----------
const { io: ioc } = require('socket.io-client');
const { server, io, rooms, accounts, admin } = require('../server');
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => { for (const r of rooms.values()) if (r.timer) clearTimeout(r.timer); io.close(); });
function client() {
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  const c = { s, st: null, me: null, events: [], waiters: [] };
  s.on('state', (st) => { c.st = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  s.on('me', (m) => { c.me = m; });
  s.on('accountDeleted', (m) => c.events.push(['deleted', m.text]));
  s.on('kicked', (m) => c.events.push(['kicked', m && m.text]));
  c.emit = (ev, d) => new Promise((res) => s.emit(ev, d || {}, res));
  c.until = (pred, ms = 20000) => new Promise((res, rej) => {
    if (c.st && pred(c.st)) return res(c.st);
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); res(st); return true; } return false; });
  });
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('서버: 본인 계정 삭제 → 대기방에서 빠짐, 다른 기기 로그아웃 알림, 토큰 무효, 게임 중엔 거부', async () => {
  const H = client(); const G = client();
  const e1 = await H.emit('enter', { pin: '0000', nickname: '떠날사람' });
  await G.emit('enter', { pin: '0000', nickname: '남는사람' });
  const cr = await H.emit('createRoom', { game: 'gostop' });
  await G.emit('joinRoom', { code: cr.code });
  await G.until((s) => s.room.players.length === 2);
  const H2 = client(); // 같은 계정 다른 기기
  assert.ok((await H2.emit('auth', { token: e1.token })).ok);
  const N = client();
  assert.strictEqual((await N.emit('deleteAccount', { confirmName: '떠날사람' })).ok, false, '입장 안 한 소켓은 삭제 불가');
  const bad = await H.emit('deleteAccount', { confirmName: '떠날살암', currentPin: '0000' });
  assert.strictEqual(bad.code, 'CONFIRM');
  const ok = await H.emit('deleteAccount', { confirmName: '떠날사람', currentPin: '0000' });
  assert.ok(ok.ok, ok.error);
  const st = await G.until((s) => !s.room.players.some((p) => p.name === '떠날사람'));
  assert.strictEqual(st.room.hostId, 'u:남는사람', '방장 넘어감');
  await wait(50);
  assert.deepStrictEqual(H2.events, [['deleted', '다른 기기에서 이 계정을 삭제했어요']]);
  assert.strictEqual((await H2.emit('auth', { token: e1.token })).ok, false, '토큰 무효');
  assert.strictEqual((await H.emit('createRoom', { game: 'matgo' })).ok, false, '삭제 후 소켓은 로그인 안 된 상태');
  const rk = await G.emit('ranking');
  assert.ok(!rk.list.some((x) => x.nickname === '떠날사람'));
  const re = await H.emit('enter', { pin: '0000', nickname: '떠날사람' });
  assert.ok(re.ok && re.created, '이름 다시 쓸 수 있음');
  // 진행 중인 판에 앉아 있으면 거부
  const P = client();
  await P.emit('enter', { pin: '0000', nickname: '게임중', pin: '3333' });
  const pr = await P.emit('createRoom', { game: 'matgo', ai: true, level: 'easy' });
  await P.until((s) => s.room.status === 'playing');
  const np = await P.emit('deleteAccount', { confirmName: '게임중' });
  assert.strictEqual(np.code, 'IN_GAME', '판 진행 중이면 먼저 안내');
  const ig = await P.emit('deleteAccount', { confirmName: '게임중', currentPin: '3333' });
  assert.strictEqual(ig.code, 'IN_GAME'); assert.ok(/나간 뒤/.test(ig.error));
  assert.ok(await accounts.load('게임중'), '거부되면 계정 그대로');
  assert.ok(rooms.get(pr.code));
  [H, G, H2, N, P].forEach((c) => c.s.close());
});

async function req(method, url, body, cookie, extra) {
  const headers = Object.assign({ 'content-type': 'application/json', 'x-admin-req': '1' }, extra || {});
  if (cookie) headers.cookie = cookie;
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: r.status, json, text, setCookie: r.headers.get('set-cookie') };
}

test('관리자: 키 인증 → httpOnly 서명 쿠키, 틀린 키 5번이면 10분 차단, 쿠키 위조 거부', async () => {
  admin.fails.clear();
  const page = await req('GET', '/admin');
  assert.strictEqual(page.status, 200); assert.ok(page.text.includes('관리자'));
  assert.strictEqual((await req('GET', '/admin/api/accounts')).status, 401, '로그인 전 거부');
  const csrf = await req('POST', '/admin/api/login', { key: process.env.ADMIN_KEY }, null, { 'x-admin-req': '' });
  assert.strictEqual(csrf.status, 403, '사용자 지정 헤더 없으면 거부 (CSRF)');
  const wrong = await req('POST', '/admin/api/login', { key: 'nope' });
  assert.strictEqual(wrong.status, 401); assert.ok(!wrong.setCookie);
  const good = await req('POST', '/admin/api/login', { key: ' ' + process.env.ADMIN_KEY + ' ' });
  assert.strictEqual(good.status, 200);
  assert.ok(/HttpOnly/.test(good.setCookie) && /SameSite=Strict/.test(good.setCookie) && /Max-Age=2592000/.test(good.setCookie));
  const cookie = good.setCookie.split(';')[0];
  assert.strictEqual((await req('GET', '/admin/api/me', null, cookie)).json.authed, true);
  assert.strictEqual((await req('GET', '/admin/api/accounts', null, cookie)).status, 200);
  const forged = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.strictEqual((await req('GET', '/admin/api/accounts', null, forged)).status, 401, '서명 위조 거부');
  const expired = 'hw_admin=' + (Date.now() - 1000) + '.' + cookie.split('.')[1];
  assert.strictEqual((await req('GET', '/admin/api/accounts', null, expired)).status, 401);
  // 틀린 키 제한: 성공으로 초기화된 뒤 5번 틀리면 맞는 키도 429
  for (let i = 0; i < 5; i++) assert.strictEqual((await req('POST', '/admin/api/login', { key: 'x' + i })).status, 401);
  const blocked = await req('POST', '/admin/api/login', { key: process.env.ADMIN_KEY });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual((await req('GET', '/admin/api/me', null, cookie)).json.authed, true, '이미 받은 세션은 그대로');
  admin.fails.clear();
  // ADMIN_KEY 없으면 꺼짐
  const saved = process.env.ADMIN_KEY; delete process.env.ADMIN_KEY;
  const off = await req('GET', '/admin');
  assert.ok(off.text.includes('관리자 기능이 꺼져 있어요'));
  assert.strictEqual((await req('POST', '/admin/api/login', { key: '' })).status, 404);
  assert.strictEqual((await req('GET', '/admin/api/accounts', null, cookie)).status, 404);
  process.env.ADMIN_KEY = saved;
});

test('관리자: 목록·검색, 접속 중인 계정 삭제(방에서 빠지고 로그아웃 알림), PIN 재설정, 잔액, 이름, 방 닫기', async () => {
  admin.fails.clear();
  const cookie = (await req('POST', '/admin/api/login', { key: process.env.ADMIN_KEY })).setCookie.split(';')[0];
  const V = client(); const W = client();
  const ev = await V.emit('enter', { pin: '0000', nickname: '문제손님', pin: '1212' });
  await W.emit('enter', { pin: '0000', nickname: '착한손님' });
  const cr = await W.emit('createRoom', { game: 'seotda' });
  await V.emit('joinRoom', { code: cr.code });
  await W.until((s) => s.room.players.length === 2);
  const ls = await req('GET', '/admin/api/accounts?q=' + encodeURIComponent('문제'), null, cookie);
  assert.strictEqual(ls.json.list.length, 1);
  const row = ls.json.list[0];
  assert.strictEqual(row.nickname, '문제손님'); assert.strictEqual(row.hasPin, true); assert.strictEqual(row.online, true); assert.strictEqual(row.room, cr.code);
  assert.strictEqual(row.balance, 1000000); assert.ok(row.createdAt > 0 && row.lastSeen > 0);
  // 잔액: 설정·증감
  assert.strictEqual((await req('POST', '/admin/api/account/balance', { key: '착한손님', balance: 2500000 }, cookie)).json.account.balance, 2500000);
  assert.strictEqual((await req('POST', '/admin/api/account/balance', { key: '착한손님', delta: -500000 }, cookie)).json.account.balance, 2000000);
  assert.strictEqual((await req('POST', '/admin/api/account/balance', { key: '착한손님', balance: 'abc' }, cookie)).status, 400);
  await W.until((s) => s.room.players.some((p) => p.name === '착한손님' && p.chips === 2000000));
  // PIN 재설정 (잊어버린 사람 복구)
  const pin = await req('POST', '/admin/api/account/pin', { key: '문제손님', pin: '8642' }, cookie);
  assert.strictEqual(pin.json.pin, '8642');
  const X = client();
  assert.ok((await X.emit('enter', { pin: '0000', nickname: '문제손님', pin: '8642' })).ok);
  const auto = await req('POST', '/admin/api/account/pin', { key: '착한손님' }, cookie);
  assert.ok(/^\d{4}$/.test(auto.json.pin)); assert.strictEqual(auto.json.account.hasPin, true);
  // 이름 변경 (관리자는 PIN·10분 제한 없이) → 방에도 반영
  const rn = await req('POST', '/admin/api/account/rename', { key: '착한손님', nickname: '착한손님2' }, cookie);
  assert.strictEqual(rn.json.account.nickname, '착한손님2');
  await V.until((s) => s.room.players.some((p) => p.name === '착한손님2'));
  assert.strictEqual((await req('POST', '/admin/api/account/rename', { key: '착한손님2', nickname: '문제손님' }, cookie)).json.code, 'TAKEN');
  // 삭제: 접속 중 → 방에서 빠지고, 모든 기기 로그아웃 알림
  const del = await req('POST', '/admin/api/account/delete', { key: '문제손님' }, cookie);
  assert.strictEqual(del.json.deleted, '문제손님');
  await W.until((s) => !s.room.players.some((p) => p.name === '문제손님'));
  await wait(50);
  assert.deepStrictEqual(V.events, [['deleted', '관리자가 이 계정을 삭제했어요']]);
  assert.deepStrictEqual(X.events, [['deleted', '관리자가 이 계정을 삭제했어요']]);
  assert.strictEqual((await V.emit('auth', { token: ev.token })).ok, false);
  assert.strictEqual((await req('POST', '/admin/api/account/delete', { key: '문제손님' }, cookie)).status, 404);
  assert.ok((await V.emit('enter', { pin: '0000', nickname: '문제손님' })).created, '이름 다시 쓸 수 있음');
  // 방 목록·닫기
  const rl = await req('GET', '/admin/api/rooms', null, cookie);
  assert.ok(rl.json.list.some((r) => r.code === cr.code && r.host === '착한손님2'));
  const cl = await req('POST', '/admin/api/room/close', { code: cr.code }, cookie);
  assert.strictEqual(cl.json.closed, cr.code);
  assert.ok(!rooms.has(cr.code));
  await wait(50);
  assert.ok(W.events.some((e) => e[0] === 'kicked' && e[1] === '관리자가 방을 닫았어요'));
  assert.ok((await W.emit('createRoom', { game: 'matgo' })).ok, '닫힌 뒤에도 계정은 그대로 새 방 가능');
  // 로그인 없이 관리 요청 → 401
  assert.strictEqual((await req('POST', '/admin/api/account/delete', { key: '착한손님2' })).status, 401);
  [V, W, X].forEach((c) => c.s.close());
});

test('관리자 키 변경: 지금 키+새 키(8자 이상), 저장된 해시가 환경변수 키 대신, 기존 세션 모두 무효, 틀린 키 제한', async () => {
  admin.fails.clear();
  const envKey = process.env.ADMIN_KEY;
  const oldCookie = (await req('POST', '/admin/api/login', { key: envKey })).setCookie.split(';')[0];
  assert.strictEqual((await req('GET', '/admin/api/me', null, oldCookie)).json.authed, true);
  const bad = await req('POST', '/admin/api/change-key', { current: 'wrong-key!', next: 'NewKey234567' });
  assert.strictEqual(bad.status, 401); assert.strictEqual(bad.json.code, 'BAD_KEY');
  assert.strictEqual((await req('POST', '/admin/api/change-key', { current: envKey, next: 'short7!' })).json.code, 'KEY_FORMAT', '8자 미만 거부');
  assert.strictEqual((await req('POST', '/admin/api/change-key', { current: envKey, next: 'NewKey234567', next2: 'NewKey234568' })).json.code, 'MISMATCH');
  assert.strictEqual((await req('POST', '/admin/api/change-key', { current: envKey, next: envKey })).json.code, 'SAME');
  assert.strictEqual((await req('POST', '/admin/api/change-key', { current: envKey, next: 'NewKey234567' }, null, { 'x-admin-req': '' })).status, 403, 'CSRF 헤더 필요');
  const ok = await req('POST', '/admin/api/change-key', { current: envKey, next: 'NewKey234567' }); // 스크립트처럼 세션 없이
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.version, 1);
  // 기존 세션 무효, 옛(환경변수) 키로 로그인 불가, 새 키로 가능
  assert.strictEqual((await req('GET', '/admin/api/accounts', null, oldCookie)).status, 401, '키를 바꾸면 기존 세션 무효');
  assert.strictEqual((await req('POST', '/admin/api/login', { key: envKey })).status, 401, '저장된 키가 환경변수 키 대신');
  const nc = (await req('POST', '/admin/api/login', { key: 'NewKey234567' })).setCookie.split(';')[0];
  assert.strictEqual((await req('GET', '/admin/api/accounts', null, nc)).status, 200);
  const changer = ok.setCookie.split(';')[0];
  assert.strictEqual((await req('GET', '/admin/api/me', null, changer)).json.authed, true, '바꾼 사람은 새 세션');
  // 저장: scrypt 해시만 (평문 없음), 재시작해도 유지
  await accounts.idle();
  const raw = fs.readFileSync(process.env.ACCOUNTS_FILE, 'utf8');
  assert.ok(!raw.includes('NewKey234567'), '평문 저장 금지');
  const rec = JSON.parse(JSON.parse(raw).settings.admin_key);
  assert.ok(/^scrypt\$/.test(rec.hash)); assert.strictEqual(rec.ver, 1);
  // 두 번째 변경 → 버전 2, 방금 세션도 무효
  const ok2 = await req('POST', '/admin/api/change-key', { current: 'NewKey234567', next: 'Another-Key-99', next2: 'Another-Key-99' }, nc);
  assert.strictEqual(ok2.json.version, 2);
  assert.strictEqual((await req('GET', '/admin/api/me', null, nc)).json.authed, false);
  // 환경변수가 없어도 저장된 키로 켜져 있음
  delete process.env.ADMIN_KEY;
  assert.ok(!(await req('GET', '/admin')).text.includes('꺼져 있어요'));
  assert.strictEqual((await req('POST', '/admin/api/login', { key: 'Another-Key-99' })).status, 200);
  process.env.ADMIN_KEY = envKey;
  // 틀린 지금 키 5번 → 차단 (로그인과 같은 제한)
  admin.fails.clear();
  for (let i = 0; i < 5; i++) assert.strictEqual((await req('POST', '/admin/api/change-key', { current: 'nope' + i, next: 'Whatever-123' })).status, 401);
  assert.strictEqual((await req('POST', '/admin/api/change-key', { current: 'Another-Key-99', next: 'Whatever-123' })).status, 429);
  admin.fails.clear();
});

test('설정 저장 (pg-mem): hwatu_settings 테이블 자동 생성·덮어쓰기, 옛 DB에도 마이그레이션', async () => {
  let newDb;
  try { ({ newDb } = require('pg-mem')); } catch (e) { return; }
  const db = newDb();
  db.public.none(`CREATE TABLE hwatu_accounts (nick_key TEXT PRIMARY KEY, nickname TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL, balance BIGINT NOT NULL DEFAULT 1000000, bankrupt_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE hwatu_tokens (token_hash TEXT PRIMARY KEY, nick_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  const { Pool } = db.adapters.createPg();
  const A = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await A.ready;
  assert.strictEqual(A.kind, 'postgres');
  assert.strictEqual(await A.getSetting('admin_key'), null);
  await A.setSetting('admin_key', '{"hash":"scrypt$a$b","ver":1}');
  await A.setSetting('admin_key', '{"hash":"scrypt$c$d","ver":2}');
  const B = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await B.ready;
  assert.strictEqual(JSON.parse(await B.getSetting('admin_key')).ver, 2);
  assert.strictEqual(db.public.many('SELECT * FROM hwatu_settings').length, 1);
});
