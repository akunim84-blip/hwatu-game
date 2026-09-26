// 계정: 닉네임 + PIN, 가상 머니 잔액 영구 저장 (JSON 파일 백엔드), 파산 리셋, 판 정산 저장
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hwatu-acct-'));
process.env.ACCOUNTS_FILE = path.join(TMP, 'server-accounts.json');
process.env.AI_DELAY_SCALE = '0.01';
delete process.env.DATABASE_URL;
const test = require('node:test');
const assert = require('node:assert');
const { Accounts, START_MONEY, BANKRUPT_MONEY, verifyPin } = require('../lib/accounts');

const fresh = (name) => new Accounts({ databaseUrl: '', file: path.join(TMP, name + '.json') });

test('계정 생성: 1,000,000원 시작, PIN은 scrypt 해시로만 저장', async () => {
  const A = fresh('create');
  const r = await A.enter('민수', '1234');
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.account.balance, START_MONEY);
  assert.strictEqual(START_MONEY, 1000000);
  assert.ok(r.token && r.token.length >= 32);
  await A.idle();
  const raw = fs.readFileSync(path.join(TMP, 'create.json'), 'utf8');
  assert.ok(!raw.includes('1234'), 'PIN 평문 저장 금지');
  assert.ok(!raw.includes(r.token), '토큰 평문 저장 금지');
  const stored = JSON.parse(raw).accounts['민수'];
  assert.match(stored.pinHash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(verifyPin('1234', stored.pinHash));
});

test('로그인: 맞는 PIN이면 같은 계정, 토큰으로 자동 로그인, 틀린 PIN 거부', async () => {
  const A = fresh('login');
  const r1 = await A.enter('영희', '0000');
  await assert.rejects(A.enter('영희', '1111'), /PIN이 맞지 않습니다/);
  await assert.rejects(A.enter('영희', '12a4'), /4자리/);
  await assert.rejects(A.enter('', '1234'), /이름/);
  const r2 = await A.enter('영희', '0000');
  assert.strictEqual(r2.created, false);
  // 다른 프로세스(재시작)에서도 토큰·PIN 유지
  await A.idle();
  const B = fresh('login');
  assert.strictEqual((await B.byToken(r1.token)).nickname, '영희', '예전 기기 토큰도 유효');
  assert.strictEqual((await B.byToken(r2.token)).nickname, '영희');
  assert.strictEqual(await B.byToken('nope'), null);
  await assert.rejects(B.enter('영희', '9999'), /PIN/);
  await B.logout(r1.token);
  assert.strictEqual(await B.byToken(r1.token), null);
});

test('PIN 5번 틀리면 잠시 잠금 (맞는 PIN도 거부)', async () => {
  const A = fresh('lock');
  await A.enter('잠금이', '1111');
  for (let i = 0; i < 5; i++) await assert.rejects(A.enter('잠금이', '2222'), /PIN이 맞지 않습니다/);
  await assert.rejects(A.enter('잠금이', '1111'), /5분 뒤/);
  A.fails.get('잠금이').until = Date.now() - 1; // 시간 경과
  assert.strictEqual((await A.enter('잠금이', '1111')).created, false);
});

test('파산: 0원 이하 → 300,000원으로 다시 시작, 파산 횟수 기록·저장', async () => {
  const A = fresh('bankrupt');
  await A.enter('철수', '4321');
  let r = await A.settle('철수', -250000);
  assert.deepStrictEqual(r, { balance: 750000, bankrupt: false });
  r = await A.settle('철수', -750000); // 딱 0원도 파산
  assert.deepStrictEqual(r, { balance: BANKRUPT_MONEY, bankrupt: true });
  r = await A.settle('철수', -5000000);
  assert.strictEqual(r.balance, 300000);
  const B = fresh('bankrupt');
  const a = await B.load('철수');
  assert.strictEqual(a.balance, 300000);
  assert.strictEqual(a.bankruptCount, 2);
});

test('순위: 잔액 많은 순 top 10', async () => {
  const A = fresh('rank');
  for (let i = 0; i < 12; i++) { await A.enter('u' + i, '1111'); await A.settle('u' + i, i * 1000); }
  const top = await A.top(10);
  assert.strictEqual(top.length, 10);
  assert.strictEqual(top[0].nickname, 'u11');
  assert.strictEqual(top[0].balance, START_MONEY + 11000);
  assert.ok(top.every((x, k) => k === 0 || top[k - 1].balance >= x.balance));
  assert.ok(!('pinHash' in top[0]));
});

// ---- 서버 통합: 로그인 → AI 맞고 한 판 → 정산 잔액 저장 → 다른 방/재접속에서도 유지 ----
const { io: ioc } = require('socket.io-client');
const { server, io, rooms, accounts, settlePlayer } = require('../server');
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => { for (const r of rooms.values()) if (r.timer) clearTimeout(r.timer); io.close(); });
function client() {
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  const c = { s, st: null, me: null, notices: [], waiters: [] };
  s.on('state', (st) => { c.st = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  s.on('me', (m) => { c.me = m; });
  s.on('notice', (n) => c.notices.push(n));
  c.emit = (ev, d) => new Promise((res) => s.emit(ev, d || {}, res));
  c.until = (pred, ms = 30000) => new Promise((res, rej) => {
    if (c.st && pred(c.st)) return res(c.st);
    const t = setTimeout(() => rej(new Error('timeout')), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); res(st); return true; } return false; });
  });
  return c;
}
function autoPlay(c) {
  const step = (st) => {
    const o = st.game && st.game.options;
    if (!o || st.game.result) return;
    if (o.phase === 'play') { const k = o.cards[0]; c.s.emit('action', k ? { type: 'play', card: k.id, floorCard: k.matches ? k.matches[0] : undefined } : { type: 'flipOnly' }, () => {}); }
    else if (o.phase === 'goStop') c.s.emit('action', { type: 'stop' }, () => {});
    else if (o.phase === 'chooseFlip') c.s.emit('action', { type: 'chooseFlip', floorCard: o.choices[0] }, () => {});
  };
  c.s.on('state', step);
  if (c.st) step(c.st);
}

test('서버: 로그인한 계정으로 한 판 → 판 정산이 저장되고 새 방·재접속에서도 잔액 유지', async () => {
  const A = client();
  const bad = await A.emit('createRoom', { game: 'matgo', pid: 'u:해커', name: 'x', ai: true });
  assert.strictEqual(bad.ok, false, '계정 id 사칭 금지');
  const e = await A.emit('enter', { nickname: '길동', pin: '2580' });
  assert.ok(e.ok); assert.strictEqual(e.account.balance, 1000000);
  const cr = await A.emit('createRoom', { game: 'matgo', ai: true, level: 'easy' });
  assert.ok(cr.ok);
  const room = rooms.get(cr.code);
  assert.strictEqual(room.perPoint, 1000, '맞고 기본 점당 1,000원');
  const st0 = await A.until((st) => !!st.game);
  const meP = st0.room.players.find((p) => p.id === st0.me);
  assert.strictEqual(st0.me, 'u:길동'); assert.strictEqual(meP.name, '길동'); assert.strictEqual(meP.chips, 1000000);
  autoPlay(A);
  const sr = await A.until((st) => st.room.status === 'result');
  const d = sr.game.result.chipDelta['u:길동'];
  const expected = 1000000 + d <= 0 ? 300000 : 1000000 + d;
  assert.strictEqual(sr.room.players.find((p) => p.id === 'u:길동').chips, expected);
  await accounts.idle();
  const disk = JSON.parse(fs.readFileSync(process.env.ACCOUNTS_FILE, 'utf8')).accounts['길동'];
  assert.strictEqual(disk.balance, expected, '판 정산 직후 저장');
  // 다른 기기(새 소켓)에서 토큰으로 자동 로그인 → 같은 잔액
  const B = client();
  const au = await B.emit('auth', { token: e.token });
  assert.ok(au.ok); assert.strictEqual(au.account.balance, expected);
  const bad2 = await B.emit('auth', { token: 'x' });
  assert.strictEqual(bad2.ok, false);
  await B.emit('auth', { token: e.token });
  const cr2 = await B.emit('createRoom', { game: 'seotda' });
  assert.strictEqual(rooms.get(cr2.code).perPoint, 10000, '섯다 기본 판돈 10,000원');
  const st2 = await B.until((st) => st.room.code === cr2.code);
  assert.strictEqual(st2.room.players[0].chips, expected, '새 방에서도 같은 잔액');
  const rk = await B.emit('ranking');
  assert.ok(rk.list.some((x) => x.nickname === '길동' && x.balance === expected));
  [A, B].forEach((c) => c.s.close());
});

test('서버: 판 정산으로 0원 이하 → 파산 알림 + 300,000원 저장, AI는 조용히 충전', async () => {
  const C = client();
  const e = await C.emit('enter', { nickname: '빈털터리', pin: '1357' });
  const cr = await C.emit('createRoom', { game: 'matgo' });
  const room = rooms.get(cr.code);
  const p = room.players[0];
  await C.until((st) => st.room.code === cr.code);
  settlePlayer(room, p, -1500000);
  assert.strictEqual(p.chips, 300000);
  await accounts.idle();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(C.notices.map((n) => n.text), ['파산! 300,000원으로 다시 시작']);
  assert.strictEqual(C.me.balance, 300000);
  const disk = JSON.parse(fs.readFileSync(process.env.ACCOUNTS_FILE, 'utf8')).accounts['빈털터리'];
  assert.strictEqual(disk.balance, 300000); assert.strictEqual(disk.bankruptCount, 1);
  const bot = { id: 'ai-x', ai: true, chips: 1000, sockets: new Set() };
  settlePlayer(room, bot, -5000);
  assert.strictEqual(bot.chips, 1000000);
  assert.ok(e.ok);
  C.s.close();
});

test('Postgres 백엔드 (pg-mem): 테이블 생성·가입·로그인·정산·순위', async () => {
  let newDb;
  try { ({ newDb } = require('pg-mem')); } catch (e) { return; } // devDependency 없으면 건너뜀
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const A = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await A.ready;
  assert.strictEqual(A.kind, 'postgres');
  const r = await A.enter('박사장', '9876');
  await assert.rejects(A.enter('박사장', '0000'), /PIN/);
  await A.settle('박사장', -1200000);
  const B = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool }); // 같은 DB, 새 프로세스처럼
  await B.ready; // CREATE TABLE IF NOT EXISTS 재실행 OK
  const a = await B.byToken(r.token);
  assert.strictEqual(a.nickname, '박사장');
  assert.strictEqual(a.balance, 300000);
  assert.strictEqual(a.bankruptCount, 1);
  assert.strictEqual((await B.top(10))[0].nickname, '박사장');
  const cols = db.public.many("SELECT column_name FROM information_schema.columns WHERE table_name='hwatu_accounts'").map((x) => x.column_name);
  for (const c of ['nickname', 'pin_hash', 'balance', 'bankrupt_count', 'updated_at']) assert.ok(cols.includes(c), c);
});

test('이름만으로 입장: PIN 없이 계정 생성·기기 토큰, 같은 이름은 남이 못 씀, PIN 설정 후 다른 기기에서 PIN으로', async () => {
  const A = fresh('nameonly');
  const r = await A.enter('다은');
  assert.strictEqual(r.created, true);
  assert.strictEqual(r.account.hasPin, false);
  assert.ok(r.token.length >= 40, '긴 무작위 기기 토큰');
  assert.strictEqual((await A.byToken(r.token)).nickname, '다은');
  // 다른 사람이 같은 이름만 치면 → 이미 쓰는 이름 (돈을 가져갈 수 없음)
  await assert.rejects(A.enter('다은'), (e) => e.code === 'TAKEN' && /이미/.test(e.message));
  await assert.rejects(A.enter('다은', '1234'), (e) => e.code === 'TAKEN', 'PIN 없는 계정은 아무 PIN으로도 못 들어감');
  await assert.rejects(A.enter(' 다은 '), (e) => e.code === 'TAKEN', '공백 붙여도 같은 이름');
  // PIN 설정 (기기에서)
  const a = await A.byToken(r.token);
  await assert.rejects(A.setPin(a.key, '12'), /4자리/);
  const pub = await A.setPin(a.key, '2468');
  assert.strictEqual(pub.hasPin, true);
  await assert.rejects(A.enter('다은'), (e) => e.code === 'NEED_PIN');
  await assert.rejects(A.enter('다은', '1111'), (e) => e.code === 'BAD_PIN');
  const r2 = await A.enter('다은', '2468');
  assert.strictEqual(r2.created, false);
  assert.notStrictEqual(r2.token, r.token);
  assert.strictEqual((await A.byToken(r.token)).nickname, '다은', '원래 기기 토큰도 계속 유효');
  // PIN 변경은 지금 PIN 필요
  await assert.rejects(A.setPin(a.key, '1357', '0000'), (e) => e.code === 'BAD_PIN');
  await A.setPin(a.key, '1357', '2468');
  await A.idle();
  const B = fresh('nameonly'); // 재시작 후에도 유지
  await assert.rejects(B.enter('다은', '2468'), (e) => e.code === 'BAD_PIN');
  assert.strictEqual((await B.enter('다은', '1357')).account.nickname, '다은');
  // 기존 PIN 계정(예전 방식)도 그대로
  const old = await B.enter('옛날사람', '9090');
  assert.strictEqual(old.account.hasPin, true);
  await assert.rejects(B.enter('옛날사람'), (e) => e.code === 'NEED_PIN');
  const raw = fs.readFileSync(path.join(TMP, 'nameonly.json'), 'utf8');
  assert.ok(!raw.includes(r.token) && !raw.includes(r2.token), '토큰 평문 저장 금지');
});

test('서버: 이름만으로 입장 → 초대 방 정보 → 방 코드로 바로 참여, 남의 이름은 거부', async () => {
  const H = client();
  const e1 = await H.emit('enter', { nickname: '방장님' });
  assert.ok(e1.ok); assert.strictEqual(e1.account.hasPin, false);
  const cr = await H.emit('createRoom', { game: 'gostop' });
  const info = await H.emit('roomInfo', { code: cr.code.toLowerCase() });
  assert.ok(info.ok); assert.strictEqual(info.room.host, '방장님'); assert.strictEqual(info.room.gameName, '고스톱');
  const miss = await H.emit('roomInfo', { code: 'ZZZZZ' });
  assert.strictEqual(miss.code, 'NO_ROOM');
  const G = client();
  const bad = await G.emit('enter', { nickname: '방장님' });
  assert.strictEqual(bad.ok, false); assert.strictEqual(bad.code, 'TAKEN');
  const e2 = await G.emit('enter', { nickname: '초대손님' });
  assert.ok(e2.ok);
  const j = await G.emit('joinRoom', { code: cr.code });
  assert.ok(j.ok);
  const st = await G.until((s) => s.room.players.some((p) => p.id === 'u:초대손님'));
  assert.ok(st);
  const sp = await G.emit('setPin', { pin: '5555' });
  assert.ok(sp.ok); assert.strictEqual(sp.account.hasPin, true);
  const sp2 = await G.emit('setPin', { pin: '6666', currentPin: '1111' });
  assert.strictEqual(sp2.ok, false); assert.strictEqual(sp2.code, 'BAD_PIN');
  const N = client();
  const np = await N.emit('setPin', { pin: '5555' });
  assert.strictEqual(np.ok, false, '입장 안 한 소켓은 PIN 설정 불가');
  [H, G, N].forEach((c) => c.s.close());
});

test('Postgres 마이그레이션: 예전 테이블(pin_hash NOT NULL)에서도 이름만 계정 생성', async () => {
  let newDb;
  try { ({ newDb } = require('pg-mem')); } catch (e) { return; }
  const db = newDb();
  db.public.none(`CREATE TABLE hwatu_accounts (nick_key TEXT PRIMARY KEY, nickname TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL, balance BIGINT NOT NULL DEFAULT 1000000, bankrupt_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE hwatu_tokens (token_hash TEXT PRIMARY KEY, nick_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  const { Pool } = db.adapters.createPg();
  const A = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await A.ready;
  assert.strictEqual(A.kind, 'postgres');
  const r = await A.enter('새이름');
  assert.strictEqual(r.account.hasPin, false);
  const B = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await B.ready;
  assert.strictEqual((await B.byToken(r.token)).nickname, '새이름');
  await assert.rejects(B.enter('새이름'), (e) => e.code === 'TAKEN');
  await B.setPin('새이름', '8080');
  const C = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  await C.ready;
  assert.strictEqual((await C.enter('새이름', '8080')).created, false);
});
