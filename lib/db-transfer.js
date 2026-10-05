// Postgres ↔ Postgres / JSON 백업·복원 (계정·PIN·토큰·설정). 숨은 패를 읽지 않음 — DB 테이블만.
// dumpAll(url) → { payload, sql, counts }
// importPayload(poolOrUrl, payload, { mode }) → { imported, counts }
// importFromUrl(destUrl, srcUrl) → 빈 대상에만 한 번
// maybeImportOnBoot(accounts, opts) → IMPORT_FROM_URL 처리
// startDailyBackup(url, dir, { keepDays }) → 타이머
const { Pool } = require('pg');

const TABLES = ['hwatu_accounts', 'hwatu_tokens', 'hwatu_settings'];
const VERSION = 1;

function makePool(url) {
  if (url && typeof url.query === 'function') return url; // already a pool
  const u = String(url || '');
  const forceSsl = /sslmode=require/i.test(u) || (/neon\.tech/i.test(u) && !/sslmode=disable/i.test(u));
  const forceOff = /sslmode=disable/i.test(u) || /@(localhost|127\.0\.0\.1|db|postgres)(:|\/)/i.test(u);
  const ssl = forceSsl && !forceOff ? { rejectUnauthorized: false } : false;
  const pool = new Pool({ connectionString: u, ssl, max: 3 });
  if (pool.on) pool.on('error', (e) => console.error('[db-transfer] pool:', e.message));
  return pool;
}

function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  // pg BIGINT 등은 string 으로 옴 → 순수 숫자면 숫자 리터럴
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return v;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function rowToInsert(table, cols, row) {
  const vals = cols.map((c) => sqlLit(row[c]));
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

async function fetchTable(pool, name) {
  const r = await pool.query(`SELECT * FROM ${name}`);
  return r.rows;
}

async function tableExists(pool, name) {
  const r = await pool.query('SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', ['public', name]);
  return r.rows.length > 0;
}

async function dumpAll(url) {
  const pool = makePool(url);
  const own = !(url && typeof url.query === 'function');
  try {
    const payload = { version: VERSION, exportedAt: new Date().toISOString(), tables: {} };
    const counts = {};
    const sqlParts = [
      '-- 혁게임 Neon/Postgres 논리 백업 (pg_dump 호환 INSERT)',
      `-- exportedAt: ${payload.exportedAt}`,
      'BEGIN;',
      // TRUNCATE so re-import is idempotent when applied to empty-or-replace target
      'TRUNCATE hwatu_tokens, hwatu_accounts, hwatu_settings RESTART IDENTITY CASCADE;',
    ];
    for (const t of TABLES) {
      if (!(await tableExists(pool, t))) { payload.tables[t] = []; counts[t] = 0; continue; }
      const rows = await fetchTable(pool, t);
      payload.tables[t] = rows;
      counts[t] = rows.length;
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      for (const row of rows) sqlParts.push(rowToInsert(t, cols, row));
    }
    sqlParts.push('COMMIT;');
    return { payload, sql: sqlParts.join('\n') + '\n', counts };
  } finally {
    if (own && pool.end) await pool.end().catch(() => {});
  }
}

async function countRows(pool, name) {
  if (!(await tableExists(pool, name))) return 0;
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${name}`);
  return r.rows[0].n;
}

async function isDbEmpty(pool) {
  const a = await countRows(pool, 'hwatu_accounts');
  const t = await countRows(pool, 'hwatu_tokens');
  const s = await countRows(pool, 'hwatu_settings');
  return { empty: a === 0 && t === 0, accounts: a, tokens: t, settings: s };
}

async function insertRows(client, table, rows) {
  if (!rows || !rows.length) return 0;
  const cols = Object.keys(rows[0]);
  let n = 0;
  for (const row of rows) {
    const vals = cols.map((c) => row[c]);
    const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
    // ON CONFLICT DO NOTHING — 안전. replace 모드는 호출 전에 truncate
    await client.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) ON CONFLICT DO NOTHING`,
      vals
    );
    n++;
  }
  return n;
}

/**
 * payload: { version, tables: { hwatu_accounts, hwatu_tokens, hwatu_settings } }
 * mode: 'empty-only' (기본, 대상에 계정 있으면 거부) | 'replace' (truncate 후 넣기)
 */
async function importPayload(urlOrPool, payload, opts = {}) {
  if (!payload || payload.version !== VERSION || !payload.tables) {
    throw Object.assign(new Error('알 수 없는 백업 형식이에요 (version 1 JSON이 필요해요)'), { code: 'BAD_FORMAT' });
  }
  const pool = makePool(urlOrPool);
  const own = !(urlOrPool && typeof urlOrPool.query === 'function');
  const mode = opts.mode || 'empty-only';
  const client = pool.connect ? await pool.connect() : pool;
  try {
    // 스키마는 Accounts/PgStore.init 이 이미 만들어 둔 상태를 가정. 없으면 최소 생성.
    await ensureSchema(client);
    const state = await isDbEmpty(client);
    if (mode === 'empty-only' && !state.empty) {
      throw Object.assign(new Error(`대상 DB가 비어 있지 않아요 (계정 ${state.accounts}개). 덮어쓰려면 mode=replace`), { code: 'NOT_EMPTY' });
    }
    await client.query('BEGIN');
    if (mode === 'replace') {
      try { await client.query('TRUNCATE hwatu_tokens, hwatu_accounts, hwatu_settings RESTART IDENTITY CASCADE'); }
    catch (e) {
      await client.query('DELETE FROM hwatu_tokens');
      await client.query('DELETE FROM hwatu_accounts');
      await client.query('DELETE FROM hwatu_settings');
    }
    }
    const counts = {};
    // 계정 → 설정 → 토큰 순 (FK 없음이지만 논리적 순서)
    counts.hwatu_accounts = await insertRows(client, 'hwatu_accounts', payload.tables.hwatu_accounts || []);
    counts.hwatu_settings = await insertRows(client, 'hwatu_settings', payload.tables.hwatu_settings || []);
    counts.hwatu_tokens = await insertRows(client, 'hwatu_tokens', payload.tables.hwatu_tokens || []);
    await client.query(
      `INSERT INTO hwatu_settings (key, value) VALUES ('import_done', $1)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [JSON.stringify({ at: new Date().toISOString(), counts, source: opts.source || 'payload' })]
    );
    await client.query('COMMIT');
    return { imported: true, counts, mode };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (x) {}
    throw e;
  } finally {
    if (client && client.release) client.release();
    if (own && pool.end) await pool.end().catch(() => {});
  }
}

async function ensureSchema(client) {
  const have = async (t) => (await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1", [t]
  )).rows.length > 0;
  if (!(await have('hwatu_accounts'))) {
    await client.query(`CREATE TABLE hwatu_accounts (
      nick_key TEXT PRIMARY KEY,
      nickname TEXT UNIQUE NOT NULL,
      pin_hash TEXT,
      balance BIGINT NOT NULL DEFAULT 1000000,
      bankrupt_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  }
  if (!(await have('hwatu_tokens'))) {
    await client.query(`CREATE TABLE hwatu_tokens (
      token_hash TEXT PRIMARY KEY,
      nick_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  }
  if (!(await have('hwatu_settings'))) {
    await client.query('CREATE TABLE hwatu_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  }
  // 이미 있는 DB용 컬럼 (실패해도 무시 — pg-mem·구버전 호환)
  for (const sql of [
    'ALTER TABLE hwatu_accounts ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ',
    'ALTER TABLE hwatu_accounts ADD COLUMN IF NOT EXISTS stats TEXT',
    'ALTER TABLE hwatu_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ',
    'CREATE INDEX IF NOT EXISTS hwatu_accounts_balance ON hwatu_accounts (balance DESC)',
    'CREATE INDEX IF NOT EXISTS hwatu_tokens_nick ON hwatu_tokens (nick_key)',
  ]) {
    try { await client.query(sql); } catch (e) { /* ignore */ }
  }
}

async function importFromUrl(destUrl, srcUrl, opts = {}) {
  const dumped = await dumpAll(srcUrl);
  return importPayload(destUrl, dumped.payload, Object.assign({ source: 'IMPORT_FROM_URL' }, opts));
}

/** SQL 파일에서 우리가 만든 INSERT/TRUNCATE 백업만 안전하게 적용 (임의 SQL 실행 안 함) */
function parseOurSqlDump(text) {
  const tables = { hwatu_accounts: [], hwatu_tokens: [], hwatu_settings: [] };
  const re = /^INSERT INTO (hwatu_accounts|hwatu_tokens|hwatu_settings) \(([^)]+)\) VALUES \((.*)\);$/gm;
  let m;
  while ((m = re.exec(text))) {
    const table = m[1];
    const cols = m[2].split(',').map((s) => s.trim());
    const vals = splitSqlValues(m[3]);
    if (cols.length !== vals.length) continue;
    const row = {};
    for (let i = 0; i < cols.length; i++) row[cols[i]] = vals[i];
    tables[table].push(row);
  }
  return { version: VERSION, exportedAt: null, tables };
}

function splitSqlValues(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s.startsWith('NULL', i) && (i + 4 === s.length || s[i + 4] === ',')) { out.push(null); i += 4; if (s[i] === ',') i++; continue; }
    if (s.startsWith('TRUE', i) && (i + 4 === s.length || s[i + 4] === ',')) { out.push(true); i += 4; if (s[i] === ',') i++; continue; }
    if (s.startsWith('FALSE', i) && (i + 5 === s.length || s[i + 5] === ',')) { out.push(false); i += 5; if (s[i] === ',') i++; continue; }
    if (s[i] === "'") {
      let j = i + 1, str = '';
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") { str += "'"; j += 2; continue; }
        if (s[j] === "'") { j++; break; }
        str += s[j++];
      }
      out.push(str); i = j; if (s[i] === ',') i++; continue;
    }
    // number
    let j = i;
    while (j < s.length && s[j] !== ',') j++;
    const raw = s.slice(i, j).trim();
    out.push(/^-?\d+(\.\d+)?$/.test(raw) ? (raw.includes('.') ? Number(raw) : raw) : raw);
    i = j + 1;
  }
  return out;
}

async function maybeImportOnBoot(accounts, opts = {}) {
  const src = String(process.env.IMPORT_FROM_URL || opts.importFromUrl || '').trim();
  if (!src) return { skipped: true, reason: 'no IMPORT_FROM_URL' };
  if (accounts.kind !== 'postgres') return { skipped: true, reason: 'dest not postgres' };
  await accounts.ready;
  const destUrl = opts.databaseUrl || process.env.DATABASE_URL;
  if (!destUrl) return { skipped: true, reason: 'no DATABASE_URL' };
  const pool = accounts.store.pool;
  const done = await accounts.getSetting('import_done');
  if (done) return { skipped: true, reason: 'already imported', done };
  const state = await isDbEmpty(pool);
  if (!state.empty) {
    console.log('[db-transfer] IMPORT_FROM_URL 무시: 대상에 이미 계정', state.accounts, '개');
    return { skipped: true, reason: 'not empty', state };
  }
  console.log('[db-transfer] IMPORT_FROM_URL → 빈 DB로 복사 시작…');
  const r = await importFromUrl(destUrl, src, { mode: 'empty-only' });
  console.log('[db-transfer] 가져오기 완료', r.counts);
  return r;
}

function startDailyBackup(url, dir, opts = {}) {
  const fs = require('fs');
  const path = require('path');
  const keepDays = opts.keepDays || 14;
  const everyMs = opts.everyMs || 24 * 3600 * 1000;
  if (!url || !dir) return { stop() {} };
  fs.mkdirSync(dir, { recursive: true });
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      const data = await dumpAll(url);
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const kst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
      const tag = `${kst.getFullYear()}${pad(kst.getMonth() + 1)}${pad(kst.getDate())}-${pad(kst.getHours())}${pad(kst.getMinutes())}`;
      const sqlPath = path.join(dir, `hwatu-${tag}.sql`);
      const jsonPath = path.join(dir, `hwatu-${tag}.json`);
      fs.writeFileSync(sqlPath, data.sql);
      fs.writeFileSync(jsonPath, JSON.stringify(data.payload));
      console.log('[db-transfer] 일일 백업', sqlPath, data.counts);
      // 14일 지난 파일 삭제
      const cutoff = Date.now() - keepDays * 86400000;
      for (const f of fs.readdirSync(dir)) {
        if (!/^hwatu-.*\.(sql|json)$/.test(f)) continue;
        const p = path.join(dir, f);
        try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) {}
      }
    } catch (e) { console.error('[db-transfer] 일일 백업 실패:', e.message); }
  };
  // 첫 백업은 기동 후 5분, 이후 everyMs
  const first = setTimeout(() => { run(); }, opts.firstDelayMs != null ? opts.firstDelayMs : 5 * 60000);
  const iv = setInterval(run, everyMs);
  return { stop() { stopped = true; clearTimeout(first); clearInterval(iv); }, run };
}


/** Accounts 인스턴스에서 백업 (postgres 풀 또는 JSON 파일 저장소) */
async function dumpFromAccounts(accounts) {
  await accounts.ready;
  if (accounts.store && accounts.store.pool) return dumpAll(accounts.store.pool);
  // JSON 저장소
  const all = await accounts.store.all();
  const settings = accounts.store.settings || {};
  const accountsRows = all.map((a) => ({
    nick_key: a.key,
    nickname: a.nickname,
    pin_hash: a.pinHash || null,
    balance: a.balance,
    bankrupt_count: a.bankruptCount || 0,
    created_at: a.createdAt ? new Date(a.createdAt).toISOString() : new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_seen_at: a.lastSeen ? new Date(a.lastSeen).toISOString() : null,
    stats: a.stats ? JSON.stringify(a.stats) : null,
  }));
  const tokenRows = [];
  for (const a of all) for (const th of (a.tokens || [])) {
    tokenRows.push({ token_hash: th, nick_key: a.key, created_at: new Date().toISOString(), last_used_at: null });
  }
  const settingRows = Object.keys(settings).map((k) => ({ key: k, value: settings[k], updated_at: new Date().toISOString() }));
  const payload = { version: VERSION, exportedAt: new Date().toISOString(), tables: {
    hwatu_accounts: accountsRows, hwatu_tokens: tokenRows, hwatu_settings: settingRows,
  } };
  const counts = { hwatu_accounts: accountsRows.length, hwatu_tokens: tokenRows.length, hwatu_settings: settingRows.length };
  // SQL 은 dumpAll 경로와 동일하게 단순 생성
  const sqlParts = ['BEGIN;', 'TRUNCATE hwatu_tokens, hwatu_accounts, hwatu_settings RESTART IDENTITY CASCADE;'];
  for (const t of TABLES) {
    const rows = payload.tables[t];
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    for (const row of rows) sqlParts.push(rowToInsert(t, cols, row));
  }
  sqlParts.push('COMMIT;');
  return { payload, sql: sqlParts.join('\n') + '\n', counts };
}

module.exports = {
  VERSION, TABLES, makePool, dumpAll, dumpFromAccounts, importPayload, importFromUrl, maybeImportOnBoot,
  startDailyBackup, isDbEmpty, parseOurSqlDump, ensureSchema, countRows,
};
