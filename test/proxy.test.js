// 셀프 호스팅(Docker + 역방향 프록시): /healthz, TRUST_PROXY=1 일 때 진짜 IP로 틀린 키 제한·HTTPS 뒤 Secure 쿠키
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const KEY = 'ProxyTestKey23456789abc';
function start(extraEnv) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hwatu-proxy-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), ADMIN_KEY: KEY, ACCOUNTS_FILE: path.join(TMP, 'a.json'), ...extraEnv };
  delete env.DATABASE_URL;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (b) => { if (String(b).includes('localhost:')) resolve(); });
    child.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  return { base: `http://127.0.0.1:${port}`, child, ready };
}
const login = (base, key, headers = {}) => fetch(base + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-req': '1', ...headers }, body: JSON.stringify({ key }) });

test('TRUST_PROXY=1: /healthz 200, 프록시 뒤 Secure 쿠키, X-Forwarded-For 앞부분 위조로 제한 못 피함, SIGTERM 으로 종료', async () => {
  const s = start({ TRUST_PROXY: '1' });
  try {
    await s.ready;
    const h = await fetch(s.base + '/healthz');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(await h.text(), 'ok');

    const ok = await login(s.base, KEY, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.7' });
    assert.strictEqual(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /; Secure/);
    const plain = await login(s.base, KEY);
    assert.doesNotMatch(plain.headers.get('set-cookie'), /Secure/, 'HTTP 직접 접속이면 Secure 없음');

    // 공격자가 XFF 첫 값을 매번 바꿔도, 프록시가 붙인 마지막 값(진짜 IP) 기준으로 5번 제한
    for (let i = 0; i < 5; i++) {
      const r = await login(s.base, 'wrong-key-' + i, { 'x-forwarded-for': `10.0.0.${i}, 198.51.100.9` });
      assert.strictEqual(r.status, 401);
    }
    const blocked = await login(s.base, KEY, { 'x-forwarded-for': '10.9.9.9, 198.51.100.9' });
    assert.strictEqual(blocked.status, 429);
    const other = await login(s.base, KEY, { 'x-forwarded-for': '198.51.100.10' });
    assert.strictEqual(other.status, 200, '다른 진짜 IP 는 영향 없음');

    const exited = new Promise((r) => s.child.on('exit', (code) => r(code)));
    s.child.kill('SIGTERM');
    assert.strictEqual(await exited, 0);
  } finally { if (s.child.exitCode === null) s.child.kill('SIGKILL'); }
});
