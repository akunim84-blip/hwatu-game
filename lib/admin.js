// 관리자 페이지 (/admin): 게임 주인만. 환경변수 ADMIN_KEY 가 없으면 꺼짐.
// 키를 한 번 입력하면 서명된 httpOnly 쿠키(30일)로 그 기기를 기억. 틀린 키는 IP마다 10분에 5번까지.
const crypto = require('crypto');
const path = require('path');
const express = require('express');

const SESSION_DAYS = 30;
const FAIL_MAX = 5;
const FAIL_WINDOW = 10 * 60000;
const COOKIE = 'hw_admin';

const { hashPin, verifyPin } = require('./accounts');
const KEY_MIN = 8, KEY_MAX = 200;
const SETTING = 'admin_key'; // 설정 값: JSON {hash: scrypt 해시, ver: 버전}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const envKey = () => String(process.env.ADMIN_KEY || '').trim();
// 저장된 키(DB/파일의 scrypt 해시)가 있으면 그게 우선, 없으면 환경변수 ADMIN_KEY (처음 키 / 대체)
const K = { hash: null, ver: 0 };
const enabled = () => !!(K.hash || envKey());
// 세션 서명 비밀: 키(해시)와 버전에서 만듦 → 키를 바꾸면 모든 기존 세션이 무효
const secret = () => sha('hwatu-admin-session|' + (K.hash ? `db:${K.ver}:${K.hash}` : 'env:' + envKey()));
const sign = (exp) => crypto.createHmac('sha256', secret()).update('admin.' + exp).digest('base64url');
function keyMatches(input) {
  const v = String(input == null ? '' : input).trim();
  if (K.hash) return verifyPin(v, K.hash); // scrypt + timingSafeEqual
  return crypto.timingSafeEqual(sha(v), sha(envKey())) && !!envKey();
}
function makeSession(now = Date.now()) { const exp = now + SESSION_DAYS * 86400000; return `${exp}.${sign(exp)}`; }
function validSession(tok, now = Date.now()) {
  if (!enabled() || !tok) return false;
  const [exp, mac] = String(tok).split('.');
  if (!exp || !mac || !(Number(exp) > now)) return false;
  const a = Buffer.from(mac), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
// trust proxy 가 켜져 있으면(도커/역방향 프록시) Express 가 계산한 req.ip (앞 프록시가 붙인 진짜 IP, 위조 불가),
// 아니면 예전처럼 X-Forwarded-For 첫 값 (Render)
const ipOf = (req) => (req.app && req.app.get('trust proxy') ? req.ip : String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

function mountAdmin(app, d) {
  const fails = new Map(); // ip -> [시각...]
  const log = (req, what) => console.log(`[admin] ${new Date().toISOString()} ${ipOf(req)} ${what}`);
  // 저장된 관리자 키 불러오기 (실패하면 환경변수 키로)
  const loaded = d.accounts.getSetting(SETTING).then((v) => {
    if (!v) return;
    const j = JSON.parse(v);
    if (j && j.hash) { K.hash = j.hash; K.ver = Number(j.ver) || 1; console.log('[admin] 저장된 관리자 키 사용 (환경변수 ADMIN_KEY 대신)'); }
  }).catch((e) => console.error('[admin] 저장된 관리자 키를 못 읽음 → 환경변수 키 사용:', e.message));
  const tooMany = (ip, now) => (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW).length >= FAIL_MAX;
  const addFail = (ip, now) => { const list = (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW); list.push(now); fails.set(ip, list); return list.length; };
  const html = path.join(__dirname, '..', 'public-admin', 'admin.html');
  app.get('/admin', (req, res) => {
    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').set('Referrer-Policy', 'no-referrer');
    if (!enabled()) return res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>관리자</title><body style="font-family:sans-serif;background:#12281c;color:#eee;padding:24px"><h2>🔒 관리자 기능이 꺼져 있어요</h2><p>서버 환경변수 <b>ADMIN_KEY</b>가 설정되어 있지 않습니다.</p></body>');
    res.sendFile(html);
  });
  const api = express.Router();
  api.use(express.json({ limit: '10kb' }));
  api.use((req, res, next) => { loaded.then(() => next()); });
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled()) return res.status(404).json({ ok: false, error: '관리자 기능이 꺼져 있어요 (ADMIN_KEY 없음)' });
    // CSRF: 사용자 지정 헤더가 있어야 함 (다른 사이트 폼/이미지로는 못 보냄) + SameSite=Strict 쿠키
    if (req.method !== 'GET' && req.get('x-admin-req') !== '1') return res.status(403).json({ ok: false, error: '잘못된 요청' });
    next();
  });
  api.post('/login', (req, res) => {
    const ip = ipOf(req), now = Date.now();
    const list = (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW);
    if (list.length >= FAIL_MAX) { fails.set(ip, list); log(req, '로그인 차단 (틀린 키 너무 많음)'); return res.status(429).json({ ok: false, error: '틀린 키를 너무 많이 입력했어요. 10분 뒤에 다시 해 주세요' }); }
    if (!keyMatches(req.body && req.body.key)) {
      list.push(now); fails.set(ip, list);
      log(req, `로그인 실패 (${list.length}/${FAIL_MAX})`);
      return res.status(401).json({ ok: false, error: `관리자 키가 맞지 않아요 (${FAIL_MAX - list.length}번 남음)` });
    }
    fails.delete(ip);
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.set('Set-Cookie', `${COOKIE}=${makeSession()}; Path=/admin; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
    log(req, '로그인 성공');
    res.json({ ok: true });
  });
  // 마스터 비밀번호(관리자 키) 변경: 지금 키 + 새 키(8자 이상). 세션 없이도 지금 키로 호출 가능(스크립트용), 틀린 키는 로그인과 같은 제한
  api.post('/change-key', async (req, res) => {
    const ip = ipOf(req), now = Date.now();
    const b = req.body || {};
    if (tooMany(ip, now)) { log(req, '키 변경 차단 (틀린 키 너무 많음)'); return res.status(429).json({ ok: false, error: '틀린 키를 너무 많이 입력했어요. 10분 뒤에 다시 해 주세요' }); }
    if (!keyMatches(b.current)) { const n = addFail(ip, now); log(req, `키 변경 실패: 지금 키 틀림 (${n}/${FAIL_MAX})`); return res.status(401).json({ ok: false, error: '지금 관리자 키가 맞지 않아요', code: 'BAD_KEY' }); }
    const next = String(b.next == null ? '' : b.next).trim();
    if (next.length < KEY_MIN || next.length > KEY_MAX) return res.status(400).json({ ok: false, error: `새 키는 ${KEY_MIN}~${KEY_MAX}자로 해 주세요`, code: 'KEY_FORMAT' });
    if (b.next2 !== undefined && String(b.next2).trim() !== next) return res.status(400).json({ ok: false, error: '새 키 두 번이 서로 달라요', code: 'MISMATCH' });
    if (keyMatches(next)) return res.status(400).json({ ok: false, error: '지금 키와 같아요', code: 'SAME' });
    const rec = { hash: hashPin(next), ver: (K.ver || 0) + 1 };
    try { await d.accounts.setSetting(SETTING, JSON.stringify(rec)); }
    catch (e) { log(req, '키 변경 저장 실패: ' + e.message); return res.status(500).json({ ok: false, error: '저장하지 못했어요 (키는 그대로)' }); }
    K.hash = rec.hash; K.ver = rec.ver; fails.delete(ip);
    log(req, `관리자 키 변경 (버전 ${rec.ver}) — 기존 관리자 세션 모두 무효`);
    const secure = req.secure || req.get('x-forwarded-proto') === 'https';
    res.set('Set-Cookie', `${COOKIE}=${makeSession()}; Path=/admin; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`); // 바꾼 사람은 새 세션
    res.json({ ok: true, version: rec.ver });
  });
  api.post('/logout', (req, res) => { res.set('Set-Cookie', `${COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Strict`); res.json({ ok: true }); });
  api.get('/me', (req, res) => res.json({ ok: true, authed: validSession(cookieOf(req, COOKIE)) }));
  // 이 아래는 로그인한 관리자만
  api.use((req, res, next) => { if (!validSession(cookieOf(req, COOKIE))) return res.status(401).json({ ok: false, error: '관리자 로그인이 필요해요', code: 'AUTH' }); next(); });
  const wrap = (fn) => async (req, res) => {
    try { res.json(Object.assign({ ok: true }, await fn(req.body || {}, req))); }
    catch (e) { res.status(e.code === 'NO_ACCOUNT' || e.code === 'NO_ROOM' ? 404 : 400).json({ ok: false, error: e.message, code: e.code }); }
  };
  const where = () => {
    const online = new Set(), inRoom = new Map();
    for (const s of d.io.sockets.sockets.values()) if (s.data.acct) online.add(s.data.acct);
    for (const r of d.rooms.values()) for (const p of r.players.concat(r.spectators)) if (p.id.startsWith('u:')) inRoom.set(p.id.slice(2), r.code);
    return { online, inRoom };
  };
  api.get('/accounts', wrap(async (b, req) => {
    const list = await d.accounts.adminList(String(req.query.q || ''), 200);
    const w = where();
    return { list: list.map((a) => Object.assign(a, { online: w.online.has(a.key), room: w.inRoom.get(a.key) || null })), storage: d.accounts.kind };
  }));
  const bad = (m) => Object.assign(new Error(m), { code: 'BAD' });
  api.post('/account/delete', wrap(async (b, req) => {
    const r = await d.accounts.adminDelete(String(b.key || ''));
    log(req, `계정 삭제: ${r.nickname}`);
    d.dropAccountEverywhere(r.key, '관리자가 이 계정을 삭제했어요');
    return { deleted: r.nickname };
  }));
  api.post('/account/pin', wrap(async (b, req) => {
    const pin = b.pin ? String(b.pin) : String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const acc = await d.accounts.adminSetPin(String(b.key || ''), pin);
    log(req, `PIN 재설정: ${acc.nickname}`);
    d.io.to('acct:' + String(b.key)).emit('me', acc);
    return { account: acc, pin };
  }));
  api.post('/account/balance', wrap(async (b, req) => {
    const key = String(b.key || '');
    let v = b.balance;
    if (b.delta != null) { const a = await d.accounts.load(key); if (!a) throw Object.assign(new Error('계정을 찾을 수 없습니다'), { code: 'NO_ACCOUNT' }); v = a.balance + Number(b.delta); }
    if (v == null || v === '' || !Number.isFinite(Number(v))) throw bad('금액을 숫자로 입력하세요');
    const before = (await d.accounts.load(key) || {}).balance;
    const acc = await d.accounts.adminSetBalance(key, v);
    log(req, `잔액 변경: ${acc.nickname} ${before} → ${acc.balance}`);
    d.io.to('acct:' + key).emit('me', acc);
    for (const r of d.rooms.values()) { const p = r.players.find((x) => x.id === 'u:' + key); if (p) { if (!d.inRound(r, p.id)) p.chips = acc.balance; d.broadcast(r); } }
    d.pushRanking();
    return { account: acc };
  }));
  api.post('/account/rename', wrap(async (b, req) => {
    const r = await d.accounts.adminRename(String(b.key || ''), b.nickname);
    log(req, `이름 변경: ${r.oldKey} → ${r.account.nickname}`);
    d.applyRename(r);
    return { account: r.account, key: r.newKey };
  }));
  api.get('/rooms', wrap(async () => ({
    list: [...d.rooms.values()].map((r) => ({
      code: r.code, game: d.GAMES[r.game].name, status: r.status, round: r.round, private: !!r.private, solo: !!r.solo,
      host: (r.players.find((p) => p.id === r.hostId) || {}).name || '-', lastActive: r.lastActive || null,
      players: r.players.map((p) => ({ name: p.name, ai: !!p.ai, connected: !!p.connected })), spectators: r.spectators.length,
    })),
  })));
  api.post('/room/close', wrap(async (b, req) => {
    const room = d.rooms.get(String(b.code || '').toUpperCase());
    if (!room) throw Object.assign(new Error('방이 없어요 (이미 끝났을 수 있어요)'), { code: 'NO_ROOM' });
    log(req, `방 닫기: ${room.code} (${d.GAMES[room.game].name}, ${room.players.filter((p) => !p.ai).map((p) => p.name).join(',')})`);
    d.closeRoom(room, '관리자가 방을 닫았어요');
    return { closed: room.code };
  }));
  // 데이터 내보내기/가져오기 (Neon → NAS 이전). 계정·PIN·토큰·관리자 키 설정 포함
  const dbx = require('./db-transfer');
  api.get('/export', wrap(async (b, req) => {
    const fmt = String((req.query && req.query.format) || 'json');
    const data = await dbx.dumpFromAccounts(d.accounts);
    log(req, `데이터 내보내기 (${fmt}, 계정 ${data.counts.hwatu_accounts})`);
    if (fmt === 'sql') {
      return { format: 'sql', sql: data.sql, counts: data.counts, exportedAt: data.payload.exportedAt };
    }
    return { format: 'json', payload: data.payload, counts: data.counts };
  }));
  api.get('/import-status', wrap(async () => {
    const done = await d.accounts.getSetting('import_done');
    let state = null;
    if (d.accounts.store && d.accounts.store.pool) state = await dbx.isDbEmpty(d.accounts.store.pool);
    else {
      const n = (await d.accounts.store.all()).length;
      state = { empty: n === 0, accounts: n, tokens: 0, settings: Object.keys(d.accounts.store.settings || {}).length };
    }
    return { storage: d.accounts.kind, importDone: done ? JSON.parse(done) : null, state };
  }));
  api.post('/import', wrap(async (b, req) => {
    const mode = b.mode === 'replace' ? 'replace' : 'empty-only';
    let payload = b.payload;
    if (!payload && b.sql) payload = dbx.parseOurSqlDump(String(b.sql));
    if (!payload && typeof b.raw === 'string') {
      const t = b.raw.trim();
      if (t[0] === '{') payload = JSON.parse(t);
      else payload = dbx.parseOurSqlDump(t);
    }
    if (!payload) throw bad('payload(JSON) 또는 sql 이 필요해요');
    if (!d.accounts.store || !d.accounts.store.pool) throw bad('Postgres 저장소에서만 가져오기를 지원해요 (DATABASE_URL)');
    const r = await dbx.importPayload(d.accounts.store.pool, payload, { mode, source: 'admin-upload' });
    // 캐시 비우기 → 다음 조회가 DB를 봄
    if (d.accounts.cache && d.accounts.cache.clear) d.accounts.cache.clear();
    // 관리자 키 다시 로드
    try {
      const v = await d.accounts.getSetting(SETTING);
      if (v) { const j = JSON.parse(v); if (j && j.hash) { K.hash = j.hash; K.ver = Number(j.ver) || 1; } }
    } catch (e) {}
    log(req, `데이터 가져오기 완료 mode=${mode} accounts=${r.counts.hwatu_accounts}`);
    return r;
  }));
  app.use('/admin/api', api);
  // 큰 백업 업로드용 (JSON/SQL 텍스트, 20MB)
  app.post('/admin/api/import-raw', express.text({ type: '*/*', limit: '20mb' }), async (req, res) => {
    try {
      await loaded;
      if (!enabled()) return res.status(404).json({ ok: false, error: '관리자 기능이 꺼져 있어요' });
      if (req.get('x-admin-req') !== '1') return res.status(403).json({ ok: false, error: '잘못된 요청' });
      if (!validSession(cookieOf(req, COOKIE))) return res.status(401).json({ ok: false, error: '관리자 로그인이 필요해요', code: 'AUTH' });
      if (!d.accounts.store || !d.accounts.store.pool) return res.status(400).json({ ok: false, error: 'Postgres 저장소에서만 가능해요' });
      const mode = req.query.mode === 'replace' ? 'replace' : 'empty-only';
      const raw = String(req.body || '');
      let payload;
      if (raw.trim()[0] === '{') payload = JSON.parse(raw);
      else payload = dbx.parseOurSqlDump(raw);
      const r = await dbx.importPayload(d.accounts.store.pool, payload, { mode, source: 'admin-upload-raw' });
      if (d.accounts.cache && d.accounts.cache.clear) d.accounts.cache.clear();
      try {
        const v = await d.accounts.getSetting(SETTING);
        if (v) { const j = JSON.parse(v); if (j && j.hash) { K.hash = j.hash; K.ver = Number(j.ver) || 1; } }
      } catch (e) {}
      log(req, `데이터 raw 가져오기 완료 mode=${mode} accounts=${r.counts.hwatu_accounts}`);
      res.json(Object.assign({ ok: true }, r));
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message, code: e.code });
    }
  });
  return { fails, loaded, keyState: K };
}

module.exports = { mountAdmin, makeSession, validSession, keyMatches };
