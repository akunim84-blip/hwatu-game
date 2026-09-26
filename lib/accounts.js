// 계정 저장소: 닉네임 + 4자리 PIN (scrypt + salt 해시), 가상 머니 잔액 영구 저장
// DATABASE_URL 이 있으면 Postgres(pg), 없으면 JSON 파일(data/accounts.json)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const START_MONEY = 1000000; // 처음 시작 1,000,000원 (가상 머니)
const BANKRUPT_MONEY = 300000; // 파산(0원 이하) 시 300,000원으로 다시 시작
const MAX_TOKENS = 8; // 기기별 로그인 토큰 (카톡 인앱 브라우저 + 일반 브라우저 등)
const SCRYPT = { N: 16384, r: 8, p: 1 };

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

// ---------- 저장 백엔드 ----------
class JsonStore {
  constructor(file) { this.file = file; this.data = {}; this.writing = null; this.dirty = false; }
  async init() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')).accounts || {}; } catch (e) { this.data = {}; }
  }
  async all() { return Object.values(this.data); }
  async get(key) { return this.data[key] || null; }
  async insert(a) { if (this.data[a.key]) return false; this.data[a.key] = a; await this.flush(); return true; }
  async save(a) { this.data[a.key] = a; await this.flush(); }
  async byTokenHash(th) { return Object.values(this.data).find((a) => (a.tokens || []).includes(th)) || null; }
  async addToken(a) { await this.save(a); } // 토큰 해시는 계정 레코드(a.tokens)에 함께 저장
  async removeToken(a) { await this.save(a); }
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
          await fs.promises.writeFile(tmp, JSON.stringify({ accounts: this.data }));
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
      pin_hash TEXT NOT NULL,
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
  }
  row(r) { return r && { key: r.nick_key, nickname: r.nickname, pinHash: r.pin_hash, balance: Number(r.balance), bankruptCount: r.bankrupt_count, tokens: [] }; }
  async get(key) { const q = await this.pool.query('SELECT * FROM hwatu_accounts WHERE nick_key=$1', [key]); return this.row(q.rows[0]); }
  async insert(a) {
    const q = await this.pool.query('INSERT INTO hwatu_accounts (nick_key,nickname,pin_hash,balance,bankrupt_count) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [a.key, a.nickname, a.pinHash, a.balance, a.bankruptCount]);
    if (q.rowCount !== 1) return false;
    await this.addToken(a);
    return true;
  }
  async save(a) {
    await this.pool.query('UPDATE hwatu_accounts SET balance=$2, bankrupt_count=$3, updated_at=now() WHERE nick_key=$1',
      [a.key, a.balance, a.bankruptCount]);
  }
  async byTokenHash(th) {
    const q = await this.pool.query('SELECT a.* FROM hwatu_tokens t JOIN hwatu_accounts a ON a.nick_key = t.nick_key WHERE t.token_hash=$1', [th]);
    const a = this.row(q.rows[0]);
    if (a) a.tokens = [th];
    return a;
  }
  async addToken(a) { if (a.tokens[0]) await this.pool.query('INSERT INTO hwatu_tokens (token_hash, nick_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a.tokens[0], a.key]); }
  async removeToken(a, th) { await this.pool.query('DELETE FROM hwatu_tokens WHERE token_hash=$1', [th]); }
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
    this.ready = this.store.init().then(() => console.log(`[accounts] 저장소: ${this.kind}`)).catch((err) => {
      // DB 연결/테이블 생성 실패 → JSON 파일로 대체 (게임은 계속 가능, 로그 남김)
      console.error(`[accounts] ${this.kind} 초기화 실패 → JSON 파일로 대체:`, err.message);
      this.store = new JsonStore(opts.file || process.env.ACCOUNTS_FILE || path.join(__dirname, '..', 'data', 'accounts.json'));
      this.kind = 'json(fallback)';
      return this.store.init();
    });
  }
  pub(a) { return { nickname: a.nickname, balance: a.balance, bankruptCount: a.bankruptCount || 0 }; }
  async load(key) {
    await this.ready;
    if (this.cache.has(key)) return this.cache.get(key);
    const a = await this.store.get(key);
    if (a && !this.cache.has(key)) this.cache.set(key, a);
    return this.cache.get(key) || null;
  }
  issueToken(a) {
    const token = crypto.randomBytes(24).toString('hex');
    a.tokens = [sha(token)].concat(a.tokens || []).slice(0, MAX_TOKENS);
    return token;
  }
  // 처음 온 닉네임이면 계정 생성, 이미 있으면 PIN 확인 후 로그인
  async enter(nickname, pin) {
    const nick = cleanNick(nickname);
    if (!nick) throw new Error('닉네임을 입력하세요');
    if (!/^\d{4}$/.test(String(pin == null ? '' : pin))) throw new Error('PIN은 숫자 4자리입니다');
    const key = keyOf(nick);
    let a = await this.load(key);
    if (a) {
      if (!verifyPin(pin, a.pinHash)) throw new Error('PIN이 맞지 않습니다');
      const token = this.issueToken(a);
      await this.store.addToken(a);
      return { token, account: this.pub(a), created: false, key };
    }
    a = { key, nickname: nick, pinHash: hashPin(pin), balance: START_MONEY, bankruptCount: 0, tokens: [] };
    const token = this.issueToken(a);
    if (!(await this.store.insert(a))) throw new Error('잠시 후 다시 시도하세요');
    this.cache.set(key, a);
    return { token, account: this.pub(a), created: true, key };
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
  settleCached(a, delta) {
    a.balance += Math.round(Number(delta) || 0);
    let bankrupt = false;
    if (a.balance <= 0) { a.balance = BANKRUPT_MONEY; a.bankruptCount = (a.bankruptCount || 0) + 1; bankrupt = true; }
    const saved = this.store.save(a);
    this.pending = Promise.all([this.pending, saved]).catch(() => {});
    return { balance: a.balance, bankrupt, saved };
  }
  async settle(key, delta) {
    const a = await this.load(key);
    if (!a) return null;
    const r = this.settleCached(a, delta);
    await r.saved;
    return { balance: r.balance, bankrupt: r.bankrupt };
  }
  // 대기 중인 저장이 모두 끝날 때까지
  async idle() { await this.ready; await this.pending; if (this.store.writing) await this.store.writing; }
  async top(n = 10) {
    await this.ready;
    let list = this.store.top ? await this.store.top(n) : (await this.store.all()).slice();
    list = list.map((a) => this.cache.get(a.key) || a); // 메모리의 최신 값 우선
    for (const a of this.cache.values()) if (!list.some((x) => x.key === a.key)) list.push(a);
    return list.sort((x, y) => y.balance - x.balance).slice(0, n).map((a) => ({ nickname: a.nickname, balance: a.balance }));
  }
}

module.exports = { Accounts, START_MONEY, BANKRUPT_MONEY, hashPin, verifyPin, cleanNick };
