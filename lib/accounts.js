// 계정 저장소: 닉네임 + 4자리 PIN (scrypt + salt 해시), 가상 머니 잔액 영구 저장
// DATABASE_URL 이 있으면 Postgres(pg), 없으면 JSON 파일(data/accounts.json)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const START_MONEY = 1000000; // 처음 시작 1,000,000원 (가상 머니)
const BANKRUPT_MONEY = 300000; // 파산(0원 이하) 시 300,000원으로 다시 시작
const MAX_TOKENS = 8; // 기기별 로그인 토큰 (카톡 인앱 브라우저 + 일반 브라우저 등)
const SCRYPT = { N: 16384, r: 8, p: 1 };
const RENAME_GAP = 10 * 60000; // 이름 바꾸기: 계정마다 10분에 한 번 (메모리)

// 전적 (STATS_V1): 게임별 승·무·패. 계정 레코드에 함께 저장 → 이름 바꾸기·삭제·잔액 저장과 같이 움직임
const GAMES_REC = ['gostop', 'matgo', 'seotda'];
function cleanStats(x) {
  const o = {};
  for (const g of GAMES_REC) { const v = (x && x[g]) || {}; o[g] = { w: Math.max(0, v.w | 0), d: Math.max(0, v.d | 0), l: Math.max(0, v.l | 0) }; }
  return o;
}
function parseStats(t) { try { return cleanStats(typeof t === 'string' ? JSON.parse(t) : t); } catch (e) { return cleanStats(null); } }
function statsTotal(st) { const t = { w: 0, d: 0, l: 0 }; for (const g of GAMES_REC) { t.w += st[g].w; t.d += st[g].d; t.l += st[g].l; } const n = t.w + t.d + t.l; t.rate = n ? Math.round((t.w / n) * 100) : 0; return t; }
function pubStats(a) { const st = cleanStats(a.stats); return Object.assign({ total: statsTotal(st) }, st); }
const validDeviceToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function hashPin(pin, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), salt, 32, SCRYPT).toString('hex');
  return `scrypt$${salt}$${h}`;
}
function verifyPin(pin, stored) {
  const [alg, salt, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const cand = crypto.scryptSync(String(pin), salt, 32, SCRYPT);
  const ref = Buffer.from(h, 'hex');
  return ref.length === cand.length && crypto.timingSafeEqual(ref, cand);
}
function cleanNick(n) { return String(n || '').trim().replace(/[<>\s]/g, '').slice(0, 12); }
const keyOf = (nick) => cleanNick(nick).toLowerCase();
const err = (msg, code) => Object.assign(new Error(msg), { code });

// ---------- 저장 백엔드 ----------
class JsonStore {
  constructor(file) { this.file = file; this.data = {}; this.settings = {}; this.writing = null; this.dirty = false; }
  async init() {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.data = j.accounts || {}; this.settings = j.settings || {}; } catch (e) { this.data = {}; this.settings = {}; }
  }
  // 설정 (관리자 키 해시 등): 같은 파일의 settings 에 저장
  async getSetting(k) { return Object.prototype.hasOwnProperty.call(this.settings, k) ? this.settings[k] : null; }
  async setSetting(k, v) { this.settings[k] = v; await this.flush(); }
  async all() { return Object.values(this.data); }
  async get(key) { return this.data[key] || null; }
  async insert(a) { if (this.data[a.key]) return false; this.data[a.key] = a; await this.flush(); return true; }
  async save(a) { if (a.deleted) return; this.data[a.key] = a; await this.flush(); }
  async touch(a) { await this.save(a); }
  // 계정 삭제: 레코드(잔액·PIN·기기 토큰 해시 포함)를 통째로 지움
  async remove(key) { if (!this.data[key]) return false; delete this.data[key]; await this.flush(); return true; }
  async list(q, n) { return Object.values(this.data).filter((a) => !q || a.key.includes(q)).sort((x, y) => y.balance - x.balance).slice(0, n); }
  async byTokenHash(th) { return Object.values(this.data).find((a) => (a.tokens || []).includes(th)) || null; }
  async addToken(a) { await this.save(a); }
  async savePin(a) { await this.save(a); } // 토큰 해시는 계정 레코드(a.tokens)에 함께 저장
  async removeToken(a) { await this.save(a); }
  // 이름 바꾸기: 같은 레코드를 새 키로 옮김 (토큰·잔액·PIN 그대로). 이미 있는 키면 false. 동기 확인+이동이라 한 프로세스 안에서 원자적
  async rename(a, oldKey, newKey, nick) {
    if (newKey !== oldKey && this.data[newKey]) return false;
    delete this.data[oldKey];
    a.key = newKey; a.nickname = nick;
    this.data[newKey] = a;
    await this.flush();
    return true;
  }
  flush() {
    // 쓰기 합치기: 저장 요청이 몰려도 파일은 순서대로 원자적으로(tmp → rename) 씀
    this.dirty = true;
    if (this.writing) return this.writing;
    this.writing = (async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          fs.mkdirSync(path.dirname(this.file), { recursive: true });
          const tmp = this.file + '.tmp';
          await fs.promises.writeFile(tmp, JSON.stringify({ accounts: this.data, settings: this.settings }));
          await fs.promises.rename(tmp, this.file);
        }
      } finally { this.writing = null; }
    })();
    return this.writing;
  }
}
class PgStore {
  constructor(url, PoolImpl) {
    const Pool = PoolImpl || require('pg').Pool; // 테스트: pg-mem 어댑터 주입
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
    if (this.pool.on) this.pool.on('error', (e) => console.error('[accounts] pg pool 오류:', e.message)); // 유휴 연결 끊김으로 서버가 죽지 않게
  }
  async init() {
    const have = async (t) => (await this.pool.query('SELECT 1 FROM information_schema.tables WHERE table_name=$1', [t])).rows.length > 0;
    if (!(await have('hwatu_accounts'))) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS hwatu_accounts (
      nick_key TEXT PRIMARY KEY,
      nickname TEXT UNIQUE NOT NULL,
      pin_hash TEXT,
      balance BIGINT NOT NULL DEFAULT ${START_MONEY},
      bankrupt_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await this.pool.query('CREATE INDEX IF NOT EXISTS hwatu_accounts_balance ON hwatu_accounts (balance DESC)');
    }
    if (!(await have('hwatu_tokens'))) {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS hwatu_tokens (
      token_hash TEXT PRIMARY KEY,
      nick_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    }
    // 마이그레이션 (이미 있는 DB): 이름만으로 만든 계정은 PIN 없음 → pin_hash NULL 허용, 기기 토큰 마지막 사용 시각
    await this.migrate('ALTER TABLE hwatu_accounts ALTER COLUMN pin_hash DROP NOT NULL');
    await this.migrate('ALTER TABLE hwatu_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ');
    await this.migrate('CREATE INDEX IF NOT EXISTS hwatu_tokens_nick ON hwatu_tokens (nick_key)');
    await this.migrate('ALTER TABLE hwatu_accounts ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ');
    await this.migrate('ALTER TABLE hwatu_accounts ADD COLUMN IF NOT EXISTS stats TEXT'); // 전적 JSON (STATS_V1)
    await this.inventory();
    // 설정 테이블 (관리자 키 해시 등)
    if (!(await have('hwatu_settings'))) await this.pool.query('CREATE TABLE IF NOT EXISTS hwatu_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  }
  async getSetting(k) { const q = await this.pool.query('SELECT value FROM hwatu_settings WHERE key=$1', [k]); return q.rows[0] ? q.rows[0].value : null; }
  async setSetting(k, v) {
    await this.pool.query('INSERT INTO hwatu_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()', [k, v]);
  }
  // 전적 되살리기(backfill) 조사: 판 기록 테이블이 있는지 확인해서 로그로 남김. 이 게임은 판별 기록을 DB에 저장한 적이 없어서
  //  (방·판 결과는 메모리에만) 되살릴 원본이 없음 → 숫자를 지어내지 않고 0부터 시작. 혹시 기록 테이블이 있으면 이름만 알려 줌
  async inventory() {
    try {
      const t = (await this.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")).rows.map((x) => x.table_name);
      const hist = t.filter((n) => /round|result|history|game|match|record|stat/i.test(n) && n !== 'hwatu_settings');
      console.log(`[accounts] 테이블: ${t.join(', ') || '(없음)'}`);
      console.log(hist.length ? `[accounts] 판 기록으로 보이는 테이블: ${hist.join(', ')} — 형식을 몰라 자동 전적 반영은 안 함` : '[accounts] 판별 기록 테이블 없음 → 예전 전적은 되살릴 수 없어 0부터 기록 (잔액·파산 횟수만 있었음)');
    } catch (e) { console.error('[accounts] 테이블 조사 실패:', e.message); }
  }
  async migrate(sql) { try { await this.pool.query(sql); } catch (e) { console.error('[accounts] 마이그레이션 건너뜀:', sql.slice(0, 60), '-', String(e.message).split('\n')[0]); } }
  row(r) { return r && { key: r.nick_key, nickname: r.nickname, pinHash: r.pin_hash, balance: Number(r.balance), bankruptCount: r.bankrupt_count, tokens: [], stats: parseStats(r.stats),
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null, lastSeen: r.last_seen_at ? new Date(r.last_seen_at).getTime() : null }; }
  async touch(a) { await this.pool.query('UPDATE hwatu_accounts SET last_seen_at=now() WHERE nick_key=$1', [a.key]); }
  async list(q, n) {
    const r = await this.pool.query('SELECT * FROM hwatu_accounts WHERE nick_key LIKE $1 ORDER BY balance DESC LIMIT $2', ['%' + String(q || '').replace(/[%_\\]/g, '') + '%', n]);
    return r.rows.map((x) => this.row(x));
  }
  // 계정 삭제: 토큰 행 + 계정 행을 한 트랜잭션으로 (순위는 계정 테이블에서 계산하므로 같이 사라짐)
  async remove(key) {
    const c = this.pool.connect ? await this.pool.connect() : null;
    const q = (sql, args) => (c || this.pool).query(sql, args);
    try {
      await q('BEGIN');
      await q('DELETE FROM hwatu_tokens WHERE nick_key=$1', [key]);
      const d = await q('DELETE FROM hwatu_accounts WHERE nick_key=$1', [key]);
      if (d.rowCount !== 1) { await q('ROLLBACK'); return false; }
      await q('COMMIT');
      return true;
    } catch (e) {
      try { await q('ROLLBACK'); } catch (x) {}
      throw e;
    } finally { if (c && c.release) c.release(); }
  }
  async get(key) { const q = await this.pool.query('SELECT * FROM hwatu_accounts WHERE nick_key=$1', [key]); return this.row(q.rows[0]); }
  async insert(a) {
    const q = await this.pool.query('INSERT INTO hwatu_accounts (nick_key,nickname,pin_hash,balance,bankrupt_count) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [a.key, a.nickname, a.pinHash, a.balance, a.bankruptCount]);
    if (q.rowCount !== 1) return false;
    await this.addToken(a);
    return true;
  }
  async save(a) {
    // 잔액·파산 횟수·전적을 한 UPDATE로 (판 정산이 원자적으로 저장됨)
    await this.pool.query('UPDATE hwatu_accounts SET balance=$2, bankrupt_count=$3, stats=$4, updated_at=now() WHERE nick_key=$1',
      [a.key, a.balance, a.bankruptCount, JSON.stringify(cleanStats(a.stats))]);
  }
  async savePin(a) { await this.pool.query('UPDATE hwatu_accounts SET pin_hash=$2, updated_at=now() WHERE nick_key=$1', [a.key, a.pinHash]); }
  async byTokenHash(th) {
    const q = await this.pool.query('SELECT a.* FROM hwatu_tokens t JOIN hwatu_accounts a ON a.nick_key = t.nick_key WHERE t.token_hash=$1', [th]);
    const a = this.row(q.rows[0]);
    if (a) { a.tokens = [th]; this.pool.query('UPDATE hwatu_tokens SET last_used_at=now() WHERE token_hash=$1', [th]).catch(() => {}); }
    return a;
  }
  async addToken(a) { if (a.tokens[0]) await this.pool.query('INSERT INTO hwatu_tokens (token_hash, nick_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a.tokens[0], a.key]); }
  async removeToken(a, th) { await this.pool.query('DELETE FROM hwatu_tokens WHERE token_hash=$1', [th]); }
  // 이름 바꾸기: 한 트랜잭션에서 계정 키·닉네임과 기기 토큰의 계정 키를 함께 바꿈. 새 이름이 이미 있으면(PK/UNIQUE 위반) 되돌리고 false
  async rename(a, oldKey, newKey, nick) {
    const c = this.pool.connect ? await this.pool.connect() : null;
    const q = (sql, args) => (c || this.pool).query(sql, args);
    try {
      await q('BEGIN');
      const u = await q('UPDATE hwatu_accounts SET nick_key=$2, nickname=$3, updated_at=now() WHERE nick_key=$1', [oldKey, newKey, nick]);
      if (u.rowCount !== 1) { await q('ROLLBACK'); return false; }
      if (newKey !== oldKey) await q('UPDATE hwatu_tokens SET nick_key=$2 WHERE nick_key=$1', [oldKey, newKey]);
      await q('COMMIT');
    } catch (e) {
      try { await q('ROLLBACK'); } catch (x) {}
      if (e.code === '23505' || /unique|duplicate/i.test(String(e.message))) return false;
      throw e;
    } finally { if (c && c.release) c.release(); }
    a.key = newKey; a.nickname = nick;
    return true;
  }
  async top(n) { const q = await this.pool.query('SELECT * FROM hwatu_accounts ORDER BY balance DESC, updated_at ASC LIMIT $1', [n]); return q.rows.map((r) => this.row(r)); }
}

// ---------- 계정 서비스 (메모리 캐시 + 저장소에 바로 기록) ----------
class Accounts {
  constructor(opts = {}) {
    const url = opts.databaseUrl !== undefined ? opts.databaseUrl : process.env.DATABASE_URL;
    this.store = url ? new PgStore(url, opts.Pool) : new JsonStore(opts.file || process.env.ACCOUNTS_FILE || path.join(__dirname, '..', 'data', 'accounts.json'));
    this.kind = url ? 'postgres' : 'json';
    this.cache = new Map(); // key -> account (한 서버 프로세스 안에서 같은 객체 공유)
    this.pending = Promise.resolve();
    this.fails = new Map(); // key -> {n, until}
    this.renaming = new Set(); // 이름 바꾸는 중인 새 키 (동시에 같은 이름으로 바꾸기 방지)
    this.ready = this.store.init().then(() => console.log(`[accounts] 저장소: ${this.kind}`)).catch((err) => {
      // DB 연결/테이블 생성 실패 → JSON 파일로 대체 (게임은 계속 가능, 로그 남김)
      console.error(`[accounts] ${this.kind} 초기화 실패 → JSON 파일로 대체:`, err.message);
      this.store = new JsonStore(opts.file || process.env.ACCOUNTS_FILE || path.join(__dirname, '..', 'data', 'accounts.json'));
      this.kind = 'json(fallback)';
      return this.store.init();
    });
  }
  // 마지막 접속 시각 (관리자 목록용). 저장은 계정마다 5분에 한 번만
  touch(a) {
    const now = Date.now();
    if (a.lastSeen && now - a.lastSeen < 5 * 60000 && a.lastSeenSaved) { a.lastSeen = now; return; }
    a.lastSeen = now; a.lastSeenSaved = true;
    const saved = this.store.touch(a).catch(() => {});
    this.pending = Promise.all([this.pending, saved]).catch(() => {});
  }
  pub(a) { return { nickname: a.nickname, balance: a.balance, bankruptCount: a.bankruptCount || 0, hasPin: !!a.pinHash, stats: pubStats(a) }; }
  statsOf(a) { return pubStats(a); }
  async load(key) {
    await this.ready;
    if (this.cache.has(key)) return this.cache.get(key);
    const a = await this.store.get(key);
    if (a && !this.cache.has(key)) this.cache.set(key, a);
    return this.cache.get(key) || null;
  }
  // 기기 토큰 (서버에는 sha256 해시만 저장). 기기가 보낸 토큰(32바이트 base64url = 43자)이 있으면 그걸 등록:
  // 기기는 입장 요청을 보내기 '전에' 토큰을 저장해 두므로, 응답이 늦거나 끊겨도(새로고침·느린 DB) 다음 방문에 그 토큰으로 자동 로그인됨.
  // 토큰은 이름·PIN 확인을 통과한 뒤에만 등록되므로 PIN 보호는 그대로
  issueToken(a, deviceToken) {
    const token = validDeviceToken(deviceToken) ? deviceToken : crypto.randomBytes(32).toString('base64url');
    a.tokens = [sha(token)].concat(a.tokens || []).slice(0, MAX_TOKENS);
    return token;
  }
  checkLock(key) {
    const f = this.fails.get(key);
    if (f && f.until > Date.now()) throw err('PIN을 여러 번 틀렸어요. 5분 뒤에 다시 시도하세요', 'LOCKED');
  }
  badPin(key) {
    // PIN 4자리 무차별 대입 방지: 닉네임별 5번 틀리면 5분 잠금 (메모리)
    const f = this.fails.get(key);
    const n = (f && f.until > 0 && f.until <= Date.now() ? 0 : (f ? f.n : 0)) + 1;
    this.fails.set(key, { n: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
  }
  // 입장: 처음 쓰는 이름 → 이름만으로 계정 생성(PIN은 선택). 이미 있는 이름 → 그 계정의 PIN 필요
  //  (PIN 없는 계정이면 '이미 쓰는 이름' — 이름만 쳐서 남의 돈을 가져갈 수 없음). 성공하면 기기 토큰 발급
  async enter(nickname, pin, deviceToken) {
    const nick = cleanNick(nickname);
    if (!nick) throw err('이름을 입력하세요', 'NAME');
    const hasPinInput = pin != null && String(pin) !== '';
    if (hasPinInput && !/^\d{4}$/.test(String(pin))) throw err('PIN은 숫자 4자리입니다', 'PIN_FORMAT');
    const key = keyOf(nick);
    let a = await this.load(key);
    if (a) {
      if (!a.pinHash) throw err(`'${a.nickname}'은(는) 이미 누가 쓰는 이름이에요. 다른 이름을 써 주세요`, 'TAKEN');
      if (!hasPinInput) throw err(`'${a.nickname}' 이름에는 PIN이 걸려 있어요. PIN 4자리를 입력하세요`, 'NEED_PIN');
      this.checkLock(key);
      if (!verifyPin(pin, a.pinHash)) { this.badPin(key); throw err('PIN이 맞지 않습니다', 'BAD_PIN'); }
      this.fails.delete(key);
      const token = this.issueToken(a, deviceToken);
      await this.store.addToken(a);
      this.touch(a);
      return { token, account: this.pub(a), created: false, key };
    }
    a = { key, nickname: nick, pinHash: hasPinInput ? hashPin(pin) : null, balance: START_MONEY, bankruptCount: 0, tokens: [], createdAt: Date.now(), lastSeen: Date.now() };
    const token = this.issueToken(a, deviceToken);
    if (!(await this.store.insert(a))) throw err('잠시 후 다시 시도하세요', 'RETRY');
    this.cache.set(key, a);
    return { token, account: this.pub(a), created: true, key };
  }
  // PIN 설정/변경 (다른 기기에서도 쓰려면). 이미 PIN이 있으면 현재 PIN 확인
  async setPin(key, pin, currentPin) {
    const a = await this.load(key);
    if (!a) throw err('계정을 찾을 수 없습니다', 'NO_ACCOUNT');
    if (!/^\d{4}$/.test(String(pin == null ? '' : pin))) throw err('PIN은 숫자 4자리입니다', 'PIN_FORMAT');
    if (a.pinHash) {
      this.checkLock(key);
      if (!verifyPin(currentPin, a.pinHash)) { this.badPin(key); throw err('지금 PIN이 맞지 않습니다', 'BAD_PIN'); }
    }
    a.pinHash = hashPin(pin);
    await this.store.savePin(a);
    return this.pub(a);
  }
  // 이름 바꾸기 (로그인한 본인만 — 서버가 소켓의 계정 키로 호출). PIN이 있는 계정은 지금 PIN 필요. 10분에 한 번.
  // 잔액·PIN·기기 토큰·통계는 그대로, 옛 이름은 바로 다른 사람이 쓸 수 있게 풀림. 반환 {oldKey, newKey, account}
  async rename(key, newNick, currentPin, now = Date.now()) {
    const a = await this.load(key);
    if (!a) throw err('계정을 찾을 수 없습니다', 'NO_ACCOUNT');
    const nick = cleanNick(newNick);
    if (!nick) throw err('이름을 입력하세요', 'NAME');
    const newKey = keyOf(nick);
    if (nick === a.nickname) throw err('지금 이름과 같아요', 'SAME');
    if (a.renamedAt && now - a.renamedAt < RENAME_GAP) throw err(`이름은 10분에 한 번만 바꿀 수 있어요 (${Math.ceil((RENAME_GAP - (now - a.renamedAt)) / 60000)}분 뒤에 다시)`, 'RATE');
    if (a.pinHash) {
      if (currentPin == null || String(currentPin) === '') throw err('PIN이 걸린 계정이에요. 지금 PIN 4자리를 입력하세요', 'NEED_PIN');
      this.checkLock(key);
      if (!verifyPin(currentPin, a.pinHash)) { this.badPin(key); throw err('PIN이 맞지 않습니다', 'BAD_PIN'); }
      this.fails.delete(key);
    }
    return this.moveName(a, key, nick, newKey, now);
  }
  // 이름 이동 (본인 이름 바꾸기·관리자 공통): 새 키가 비어 있을 때만, 저장소에서 원자적으로
  async moveName(a, key, nick, newKey, now) {
    const taken = () => err(`'${nick}'은(는) 이미 누가 쓰는 이름이에요`, 'TAKEN');
    if (newKey !== key) {
      if (this.renaming.has(newKey) || this.cache.has(newKey) || (await this.store.get(newKey))) throw taken();
      this.renaming.add(newKey);
    }
    try {
      await this.pending; // 진행 중인 잔액 저장이 옛 키로 끝난 뒤에 옮김
      if (!(await this.store.rename(a, key, newKey, nick))) throw taken();
    } finally { this.renaming.delete(newKey); }
    a.key = newKey; a.nickname = nick; a.renamedAt = now;
    // 옮기는 사이에 옛 키로 들어간 정산이 있었어도 새 키로 한 번 더 저장 (잔액 유실 방지)
    if (newKey !== key) { const saved = this.store.save(a).catch((e) => console.error('[accounts] 이름 변경 후 저장 실패:', e.message)); this.pending = Promise.all([this.pending, saved]).catch(() => {}); }
    if (newKey !== key) {
      this.cache.delete(key); this.cache.set(newKey, a);
      if (this.fails.has(key)) { this.fails.set(newKey, this.fails.get(key)); this.fails.delete(key); }
    }
    return { oldKey: key, newKey, account: this.pub(a) };
  }
  // 계정 삭제 (본인만): 지금 이름을 그대로 입력해 확인 + PIN 있는 계정은 지금 PIN. 삭제 후 이름은 다시 쓸 수 있음
  async remove(key, confirmName, currentPin) {
    const a = await this.load(key);
    if (!a) throw err('계정을 찾을 수 없습니다', 'NO_ACCOUNT');
    if (cleanNick(confirmName) !== a.nickname) throw err(`확인을 위해 지금 이름 '${a.nickname}'을(를) 똑같이 입력하세요`, 'CONFIRM');
    if (a.pinHash) {
      if (currentPin == null || String(currentPin) === '') throw err('PIN이 걸린 계정이에요. 지금 PIN 4자리를 입력하세요', 'NEED_PIN');
      this.checkLock(key);
      if (!verifyPin(currentPin, a.pinHash)) { this.badPin(key); throw err('PIN이 맞지 않습니다', 'BAD_PIN'); }
    }
    return this.purge(a, key);
  }
  async purge(a, key) {
    if (this.renaming.has(key)) throw err('잠시 후 다시 시도하세요', 'BUSY');
    await this.pending; // 진행 중인 저장이 끝난 뒤 지움 (지운 뒤 다시 살아나지 않게)
    a.deleted = true;
    try {
      if (!(await this.store.remove(key))) throw err('계정을 찾을 수 없습니다', 'NO_ACCOUNT');
    } catch (e) { a.deleted = false; throw e; }
    a.tokens = [];
    this.cache.delete(key); this.fails.delete(key);
    return { key, nickname: a.nickname };
  }
  // ---------- 관리자 (서버가 관리자 인증 후에만 호출) ----------
  async adminList(q, n = 200) {
    await this.ready;
    const k = keyOf(q || '');
    const list = (await this.store.list(k, n)).map((a) => this.cache.get(a.key) || a);
    for (const a of this.cache.values()) if ((!k || a.key.includes(k)) && !list.some((x) => x.key === a.key)) list.push(a);
    return list.sort((x, y) => y.balance - x.balance).slice(0, n)
      .map((a) => ({ key: a.key, nickname: a.nickname, balance: a.balance, hasPin: !!a.pinHash, bankruptCount: a.bankruptCount || 0, createdAt: a.createdAt || null, lastSeen: a.lastSeen || null, stats: pubStats(a) }));
  }
  async adminDelete(key) { const a = await this.load(key); if (!a) throw err('계정을 찾을 수 없습니다', 'NO_ACCOUNT'); return this.purge(a, key); }
  // PIN 재설정: 새 4자리 PIN (PIN을 잊은 사람 복구용). 잠금도 풂
  async adminSetPin(key, pin) {
    const a = await this.load(key);
    if (!a) throw err('계정을 찾을 수 없습니다', 'NO_ACCOUNT');
    if (!/^\d{4}$/.test(String(pin == null ? '' : pin))) throw err('PIN은 숫자 4자리입니다', 'PIN_FORMAT');
    a.pinHash = hashPin(pin); this.fails.delete(key);
    await this.store.savePin(a);
    return this.pub(a);
  }
  async adminSetBalance(key, balance) {
    const a = await this.load(key);
    if (!a) throw err('계정을 찾을 수 없습니다', 'NO_ACCOUNT');
    const v = Math.round(Number(balance));
    if (!Number.isFinite(v) || v < 0 || v > 1e13) throw err('잔액은 0 ~ 10조 사이 숫자', 'BALANCE');
    a.balance = v;
    const saved = this.store.save(a); this.pending = Promise.all([this.pending, saved]).catch(() => {});
    await saved;
    return this.pub(a);
  }
  async adminRename(key, newNick) {
    const a = await this.load(key);
    if (!a) throw err('계정을 찾을 수 없습니다', 'NO_ACCOUNT');
    const nick = cleanNick(newNick);
    if (!nick) throw err('이름을 입력하세요', 'NAME');
    if (nick === a.nickname) throw err('지금 이름과 같아요', 'SAME');
    const r = await this.moveName(a, key, nick, keyOf(nick), a.renamedAt || 0); // 관리자 변경은 본인 10분 제한에 영향 없음
    return r;
  }
  async byToken(token) {
    await this.ready;
    if (!token || typeof token !== 'string') return null;
    const th = sha(token);
    for (const a of this.cache.values()) if ((a.tokens || []).includes(th)) return a;
    const a = await this.store.byTokenHash(th);
    if (!a) return null;
    if (!this.cache.has(a.key)) this.cache.set(a.key, a);
    const c = this.cache.get(a.key);
    if (!c.tokens.includes(th)) c.tokens.push(th);
    this.touch(c);
    return c;
  }
  async logout(token) {
    const a = await this.byToken(token);
    if (!a) return;
    const th = sha(token);
    a.tokens = a.tokens.filter((x) => x !== th);
    await this.store.removeToken(a, th);
  }
  // 판 정산: 잔액 반영(동기, 캐시된 계정). 0원 이하면 파산 → 300,000원으로 다시 시작. saved: 저장 완료 Promise
  // outcome: {game, res:'w'|'d'|'l'} → 전적도 같은 저장에 포함
  settleCached(a, delta, outcome) {
    if (outcome && GAMES_REC.includes(outcome.game) && ['w', 'd', 'l'].includes(outcome.res)) { a.stats = cleanStats(a.stats); a.stats[outcome.game][outcome.res]++; }
    a.balance += Math.round(Number(delta) || 0);
    let bankrupt = false;
    if (a.balance <= 0) { a.balance = BANKRUPT_MONEY; a.bankruptCount = (a.bankruptCount || 0) + 1; bankrupt = true; }
    const saved = this.store.save(a);
    this.pending = Promise.all([this.pending, saved]).catch(() => {});
    return { balance: a.balance, bankrupt, saved };
  }
  async settle(key, delta, outcome) {
    const a = await this.load(key);
    if (!a) return null;
    const r = this.settleCached(a, delta, outcome);
    await r.saved;
    return { balance: r.balance, bankrupt: r.bankrupt };
  }
  async getSetting(k) { await this.ready; return this.store.getSetting(k); }
  async setSetting(k, v) { await this.ready; return this.store.setSetting(k, String(v)); }
  // 대기 중인 저장이 모두 끝날 때까지
  async idle() { await this.ready; await this.pending; if (this.store.writing) await this.store.writing; }
  async top(n = 10) {
    await this.ready;
    let list = this.store.top ? await this.store.top(n) : (await this.store.all()).slice();
    list = list.map((a) => this.cache.get(a.key) || a); // 메모리의 최신 값 우선
    for (const a of this.cache.values()) if (!list.some((x) => x.key === a.key)) list.push(a);
    return list.sort((x, y) => y.balance - x.balance).slice(0, n).map((a) => ({ nickname: a.nickname, balance: a.balance, rec: statsTotal(cleanStats(a.stats)) }));
  }
}

module.exports = { Accounts, START_MONEY, BANKRUPT_MONEY, hashPin, verifyPin, cleanNick, keyOf, statsTotal, cleanStats };
