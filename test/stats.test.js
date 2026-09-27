// 전적 (승·무·패): 계정별·게임별 + 전체, 잔액과 같은 저장, 백필 없음(0부터)
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hwatu-stats-'));
process.env.ACCOUNTS_FILE = path.join(TMP, 'accounts.json');
process.env.AI_DELAY_SCALE = '0.01';
process.env.TURN_MS = '300';
delete process.env.DATABASE_URL;
delete process.env.AUTO_MS;
const test = require('node:test');
const assert = require('node:assert');
const { Accounts, statsTotal, cleanStats, hashPin } = require('../lib/accounts');
const fresh = (name) => new Accounts({ databaseUrl: '', file: path.join(TMP, name + '.json') });
const PG = 'postgres://u:p@db.example.com/x';

test('새 계정·옛 계정: 전적 0부터 (지어내지 않음), 이상한 값은 정리', async () => {
  const A = fresh('zero');
  const r = await A.enter('새사람', '1234');
  assert.deepStrictEqual(r.account.stats.total, { w: 0, d: 0, l: 0, rate: 0 });
  for (const g of ['gostop', 'matgo', 'seotda']) assert.deepStrictEqual(r.account.stats[g], { w: 0, d: 0, l: 0 });
  assert.deepStrictEqual(cleanStats({ gostop: { w: -3, d: 'x', l: 2.7 }, poker: { w: 9 } }).gostop, { w: 0, d: 0, l: 2 });
  assert.strictEqual(cleanStats({ poker: { w: 9 } }).poker, undefined);
  // stats 없는 옛 JSON 파일
  fs.writeFileSync(path.join(TMP, 'old.json'), JSON.stringify({ accounts: { 옛날: { key: '옛날', nickname: '옛날', pinHash: '', balance: 5, bankruptCount: 0, tokens: [] } } }));
  const B = fresh('old');
  await B.ready;
  assert.deepStrictEqual((await B.adminList(''))[0].stats.total, { w: 0, d: 0, l: 0, rate: 0 });
});

test('정산: 잔액과 전적을 한 번에 저장 (JSON), 이름 바꿔도 유지, 삭제하면 사라짐, 랭킹·관리자 목록에 표시', async () => {
  const A = fresh('settle');
  await A.enter('선수', '1111');
  await A.settle('선수', 1000, { game: 'gostop', res: 'w' });
  await A.settle('선수', -500, { game: 'gostop', res: 'l' });
  await A.settle('선수', 0, { game: 'seotda', res: 'd' });
  await A.settle('선수', 200, { game: 'matgo', res: 'w' });
  await A.settle('선수', 10, { game: 'poker', res: 'w' }); // 모르는 게임: 잔액만
  await A.settle('선수', 10); // 결과 없음: 잔액만
  await A.idle();
  const B = fresh('settle');
  await B.ready;
  const a = (await B.adminList('선수'))[0];
  assert.strictEqual(a.balance, 1000000 + 1000 - 500 + 200 + 20);
  assert.deepStrictEqual(a.stats.gostop, { w: 1, d: 0, l: 1 });
  assert.deepStrictEqual(a.stats.matgo, { w: 1, d: 0, l: 0 });
  assert.deepStrictEqual(a.stats.seotda, { w: 0, d: 1, l: 0 });
  assert.deepStrictEqual(a.stats.total, { w: 2, d: 1, l: 1, rate: 50 });
  const top = await B.top(5);
  assert.deepStrictEqual(top[0].rec, { w: 2, d: 1, l: 1, rate: 50 });
  await B.rename('선수', '새이름', '1111');
  await B.idle();
  const C = fresh('settle');
  await C.ready;
  assert.deepStrictEqual((await C.adminList('새이름'))[0].stats.total, { w: 2, d: 1, l: 1, rate: 50 });
  await C.remove('새이름', '새이름', '1111');
  await C.idle();
  const D = fresh('settle');
  await D.ready;
  assert.strictEqual((await D.enter('새이름', '2222')).account.stats.total.w, 0, '삭제 뒤 같은 이름 새 계정은 0부터');
});

test('Postgres (pg-mem): 옛 DB에 stats 컬럼 추가, 잔액·전적 같은 UPDATE로 저장, 재시작 후 유지', async () => {
  let newDb;
  try { ({ newDb } = require('pg-mem')); } catch (e) { return; }
  const db = newDb();
  db.public.none(`CREATE TABLE hwatu_accounts (nick_key TEXT PRIMARY KEY, nickname TEXT UNIQUE NOT NULL, pin_hash TEXT NOT NULL, balance BIGINT NOT NULL DEFAULT 1000000, bankrupt_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE TABLE hwatu_tokens (token_hash TEXT PRIMARY KEY, nick_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO hwatu_accounts (nick_key, nickname, pin_hash, balance) VALUES ('옛손님', '옛손님', '${hashPin('9999')}', 4321);`);
  const { Pool } = db.adapters.createPg();
  const A = new Accounts({ databaseUrl: PG, Pool });
  await A.ready;
  assert.strictEqual(A.kind, 'postgres');
  const old = (await A.adminList('옛손님'))[0];
  assert.strictEqual(old.balance, 4321);
  assert.deepStrictEqual(old.stats.total, { w: 0, d: 0, l: 0, rate: 0 }, '과거 판 기록이 없으니 0');
  await A.enter('옛손님', '9999');
  await A.settle('옛손님', 100, { game: 'seotda', res: 'w' });
  await A.settle('옛손님', -50, { game: 'seotda', res: 'l' });
  await A.settle('옛손님', -50, { game: 'gostop', res: 'd' });
  const row = db.public.one("SELECT balance, stats FROM hwatu_accounts WHERE nick_key='옛손님'");
  assert.strictEqual(Number(row.balance), 4321);
  assert.deepStrictEqual(JSON.parse(row.stats).seotda, { w: 1, d: 0, l: 1 });
  const B = new Accounts({ databaseUrl: PG, Pool });
  await B.ready;
  const b = (await B.adminList('옛손님'))[0];
  assert.deepStrictEqual(b.stats.total, { w: 1, d: 1, l: 1, rate: 33 });
  assert.deepStrictEqual((await B.top(3)).find((x) => x.nickname === '옛손님').rec, b.stats.total);
  await B.rename('옛손님', '새손님', '9999');
  const C = new Accounts({ databaseUrl: PG, Pool });
  await C.ready;
  assert.deepStrictEqual((await C.adminList('새손님'))[0].stats.seotda, { w: 1, d: 0, l: 1 });
  assert.strictEqual(statsTotal(cleanStats(null)).rate, 0);
});

// ---------- 서버 ----------
const { io: ioc } = require('socket.io-client');
const { server, io, rooms, accounts, roundOutcomes } = require('../server');
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => { for (const r of rooms.values()) if (r.timer) clearTimeout(r.timer); io.close(); });
function client() {
  const s = ioc(base, { transports: ['websocket'], forceNew: true });
  const c = { s, st: null, waiters: [] };
  s.on('state', (st) => { c.st = st; c.waiters = c.waiters.filter((w) => !w(st)); });
  c.emit = (ev, d) => new Promise((res) => s.emit(ev, d || {}, res));
  c.until = (pred, ms = 20000) => new Promise((res, rej) => {
    if (c.st && pred(c.st)) return res(c.st);
    const t = setTimeout(() => rej(new Error('timeout waiting state')), ms);
    c.waiters.push((st) => { if (pred(st)) { clearTimeout(t); res(st); return true; } return false; });
  });
  return c;
}

test('판 결과 → 승/무/패: 이긴 사람 승, 나머지 패, 나가리 전원 무, 섯다 동점은 이긴 사람들 무', () => {
  const res = (e) => Object.fromEntries(roundOutcomes(e).map((o) => [o.pid, o.res]));
  assert.deepStrictEqual(res({ kind: 'gostop', players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], result: { winners: ['b'], chipDelta: { a: -1, b: 2, c: -1 } } }), { a: 'l', b: 'w', c: 'l' });
  assert.deepStrictEqual(res({ kind: 'matgo', players: [{ id: 'a' }, { id: 'b' }], result: { nagari: true, winners: [], chipDelta: {} } }), { a: 'd', b: 'd' });
  assert.deepStrictEqual(res({ kind: 'seotda', seats: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], result: { winners: ['a', 'c'], chipDelta: { a: 5, b: -10, c: 5 } } }), { a: 'd', b: 'l', c: 'd' });
  assert.deepStrictEqual(res({ kind: 'seotda', seats: [{ id: 'a' }, { id: 'b' }], result: { winners: ['b'], chipDelta: { a: -3, b: 3 } } }), { a: 'l', b: 'w' });
});

test('실제 판 (섯다 2명): 두 계정 모두 한 판 기록, 결과와 일치, 방 상태에 전적 표시', async () => {
  const H = client(); const G = client();
  await H.emit('enter', { nickname: '전적1' }); await G.emit('enter', { nickname: '전적2' });
  const cr = await H.emit('createRoom', { game: 'seotda' });
  await G.emit('joinRoom', { code: cr.code });
  await H.until((s) => s.room.players.length === 2);
  assert.ok((await H.emit('start')).ok);
  const st = await H.until((s) => s.room.status === 'result', 20000);
  await accounts.idle();
  const result = st.game.result;
  const byName = { 전적1: accounts.cache.get('전적1'), 전적2: accounts.cache.get('전적2') };
  for (const p of st.room.players) {
    const s = accounts.statsOf(byName[p.name]).seotda;
    assert.strictEqual(s.w + s.d + s.l, 1, p.name + ' 한 판');
    const exp = result.nagari ? 'd' : result.winners.includes(p.id) ? (result.winners.length > 1 ? 'd' : 'w') : 'l';
    assert.strictEqual(s[exp], 1, p.name + ' 결과 ' + exp);
    assert.deepStrictEqual(p.rec.g, s, '방 상태에 이 게임 전적');
    assert.strictEqual(p.rec.t.w + p.rec.t.d + p.rec.t.l, 1);
    assert.strictEqual(accounts.statsOf(byName[p.name]).gostop.w + accounts.statsOf(byName[p.name]).gostop.l, 0);
  }
  [H, G].forEach((c) => c.s.close());
});

test('AI 방: 사람 계정만 기록, AI는 전적 없음', async () => {
  const S = client();
  await S.emit('enter', { nickname: '혼자전적' });
  await S.emit('createRoom', { game: 'seotda', ai: true, level: 'easy' });
  const st = await S.until((s) => s.room.status === 'result', 30000);
  await accounts.idle();
  const t = accounts.statsOf(accounts.cache.get('혼자전적')).total;
  assert.strictEqual(t.w + t.d + t.l, 1);
  for (const p of st.room.players.filter((x) => x.ai)) assert.strictEqual(p.rec, undefined);
  assert.ok(st.room.players.find((x) => !x.ai).rec);
  S.s.close();
});
