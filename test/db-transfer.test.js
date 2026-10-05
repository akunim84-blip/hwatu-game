// Neon→NAS 이전: 덤프/가져오기, 빈 DB만, PIN·토큰·설정 보존, IMPORT_FROM_URL 한 번만, SQL 파서
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Accounts } = require('../lib/accounts');
const dbx = require('../lib/db-transfer');

function memAccounts() {
  let newDb;
  try { ({ newDb } = require('pg-mem')); } catch (e) { return null; }
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const A = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool });
  return { A, Pool, db };
}

test('dump → import (empty-only): 계정·PIN·토큰·관리자키·잔액·전적 보존', async () => {
  const src = memAccounts(); if (!src) return;
  await src.A.ready;
  const r = await src.A.enter('이전유저', '4321');
  await src.A.adminSetBalance(r.key, 1050000);
  await src.A.settle(r.key, 0, { game: 'gostop', res: 'w' });
  await src.A.settle(r.key, 0, { game: 'gostop', res: 'w' });
  await src.A.settle(r.key, 0, { game: 'gostop', res: 'w' });
  await src.A.settle(r.key, 0, { game: 'gostop', res: 'l' });
  await src.A.setSetting('admin_key', JSON.stringify({ hash: 'scrypt$salt$deadbeef', ver: 2 }));
  await src.A.idle();

  const dumped = await dbx.dumpFromAccounts(src.A);
  assert.strictEqual(dumped.counts.hwatu_accounts, 1);
  assert.ok(dumped.counts.hwatu_tokens >= 1);
  assert.ok(dumped.counts.hwatu_settings >= 1);
  assert.ok(dumped.sql.includes('INSERT INTO hwatu_accounts'));
  // PIN 평문이 덤프에 없어야 함
  assert.ok(!dumped.sql.includes('4321'));
  assert.ok(!JSON.stringify(dumped.payload).includes('4321'));
  assert.ok(!JSON.stringify(dumped.payload).includes(r.token));

  const dest = memAccounts();
  await dest.A.ready;
  const imp = await dbx.importPayload(dest.A.store.pool, dumped.payload, { mode: 'empty-only', source: 'test' });
  assert.strictEqual(imp.counts.hwatu_accounts, 1);

  const B = new Accounts({ databaseUrl: 'postgres://u:p@db.example.com/x', Pool: dest.Pool });
  await B.ready;
  const acc = await B.load('이전유저');
  assert.ok(acc);
  assert.strictEqual(Number(acc.balance), 1050000);
  assert.strictEqual(acc.stats.gostop.w, 3);
  // PIN 해시로 로그인
  const login = await B.enter('이전유저', '4321');
  assert.strictEqual(login.created, false);
  // 기기 토큰
  assert.strictEqual((await B.byToken(r.token)).nickname, '이전유저');
  // 관리자 키 설정
  const ak = JSON.parse(await B.getSetting('admin_key'));
  assert.strictEqual(ak.ver, 2);
  const done = JSON.parse(await B.getSetting('import_done'));
  assert.ok(done.at);
});

test('empty-only: 대상에 계정이 있으면 거부 / replace 는 덮어씀', async () => {
  const dest = memAccounts(); if (!dest) return;
  await dest.A.enter('이미있음', '1111');
  await dest.A.idle();
  const payload = {
    version: 1, exportedAt: new Date().toISOString(),
    tables: {
      hwatu_accounts: [{ nick_key: '새유저', nickname: '새유저', pin_hash: null, balance: 42, bankrupt_count: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_seen_at: null, stats: null }],
      hwatu_tokens: [],
      hwatu_settings: [],
    },
  };
  await assert.rejects(dbx.importPayload(dest.A.store.pool, payload, { mode: 'empty-only' }), /비어 있지/);
  const r = await dbx.importPayload(dest.A.store.pool, payload, { mode: 'replace' });
  assert.strictEqual(r.counts.hwatu_accounts, 1);
  assert.ok(!(await dest.A.store.get('이미있음')));
  assert.ok(await dest.A.store.get('새유저'));
});

test('SQL 덤프 파서 왕복: parseOurSqlDump(dump.sql) → 같은 행 수', async () => {
  const src = memAccounts(); if (!src) return;
  await src.A.enter('SQL유저', '9999');
  await src.A.setSetting('admin_key', '{"hash":"x","ver":1}');
  const dumped = await dbx.dumpFromAccounts(src.A);
  const parsed = dbx.parseOurSqlDump(dumped.sql);
  assert.strictEqual(parsed.version, 1);
  assert.strictEqual(parsed.tables.hwatu_accounts.length, dumped.counts.hwatu_accounts);
  assert.strictEqual(parsed.tables.hwatu_settings.length, dumped.counts.hwatu_settings);
  assert.strictEqual(parsed.tables.hwatu_accounts[0].nickname, 'SQL유저');
});

test('maybeImportOnBoot: IMPORT_FROM_URL 없으면 스킵, 이미 import_done 이면 스킵', async () => {
  const dest = memAccounts(); if (!dest) return;
  await dest.A.ready;
  delete process.env.IMPORT_FROM_URL;
  const a = await dbx.maybeImportOnBoot(dest.A);
  assert.strictEqual(a.skipped, true);
  await dest.A.setSetting('import_done', JSON.stringify({ at: 'already' }));
  process.env.IMPORT_FROM_URL = 'postgres://x';
  const b = await dbx.maybeImportOnBoot(dest.A, { databaseUrl: 'postgres://dest' });
  assert.strictEqual(b.skipped, true);
  assert.strictEqual(b.reason, 'already imported');
  delete process.env.IMPORT_FROM_URL;
});

test('일일 백업: 디렉터리에 sql+json 쓰고 keepDays 지난 파일 삭제', async () => {
  const src = memAccounts(); if (!src) return;
  await src.A.enter('백업유저', '2222');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwatu-bak-'));
  const old = path.join(dir, 'hwatu-20000101-0000.sql');
  fs.writeFileSync(old, '-- old');
  fs.utimesSync(old, new Date(Date.now() - 20 * 86400000), new Date(Date.now() - 20 * 86400000));
  const ctl = dbx.startDailyBackup(src.A.store.pool, dir, { keepDays: 14, firstDelayMs: 0, everyMs: 60 * 60 * 1000 });
  await new Promise((r) => setTimeout(r, 200));
  await ctl.run();
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => /^hwatu-.*\.sql$/.test(f) && f !== 'hwatu-20000101-0000.sql'));
  assert.ok(files.some((f) => /\.json$/.test(f)));
  assert.ok(!files.includes('hwatu-20000101-0000.sql'), '14일 지난 백업 삭제');
  ctl.stop();
});

test('관리자 export API: 로그인 후 JSON 내보내기', async () => {
  // 서버는 JSON 저장소로 이미 떠 있음 — dumpFromAccounts 경로만 확인
  const os2 = require('os');
  const file = path.join(os2.tmpdir(), 'hwatu-exp-' + Date.now() + '.json');
  const A = new Accounts({ databaseUrl: '', file });
  await A.enter('내보내기', '1212');
  await A.setSetting('admin_key', JSON.stringify({ hash: 'h', ver: 1 }));
  const d = await dbx.dumpFromAccounts(A);
  assert.strictEqual(d.counts.hwatu_accounts, 1);
  assert.strictEqual(d.payload.tables.hwatu_settings[0].key, 'admin_key');
});
