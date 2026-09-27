#!/usr/bin/env bash
# 관리자(마스터) 키 변경 — 키 값은 절대 출력하지 않음, 명령줄 인자(ps에 보임)로도 넘기지 않음
#   지금 키: /workspace/hwatu-game/.admin-key (또는 ADMIN_KEY_FILE)
#   새 키:   환경변수 HWATU_NEW_ADMIN_KEY (8자 이상)
# 사용: HWATU_NEW_ADMIN_KEY=... scripts/change-admin-key.sh https://<서비스>.onrender.com
#   성공하면 .admin-key 파일도 새 키로 바꿈 (KEEP_KEY_FILE=1 이면 그대로 둠)
set -euo pipefail
BASE="${1:-}"
KEY_FILE="${ADMIN_KEY_FILE:-/workspace/hwatu-game/.admin-key}"
if [ -z "$BASE" ]; then echo "실패: 서버 주소가 필요해요. 예) $0 https://example.onrender.com" >&2; exit 2; fi
if [ -z "${HWATU_NEW_ADMIN_KEY:-}" ]; then echo "실패: 환경변수 HWATU_NEW_ADMIN_KEY 가 없어요 (새 키, 8자 이상)" >&2; exit 2; fi
if [ ! -r "$KEY_FILE" ]; then echo "실패: 지금 키 파일을 읽을 수 없어요: $KEY_FILE" >&2; exit 2; fi
export HW_BASE="$BASE" HW_KEY_FILE="$KEY_FILE" HW_KEEP="${KEEP_KEY_FILE:-}"
exec node - <<'JS'
const fs = require('fs');
const base = process.env.HW_BASE.replace(/\/+$/, '');
const file = process.env.HW_KEY_FILE;
const current = fs.readFileSync(file, 'utf8').trim();
const next = String(process.env.HWATU_NEW_ADMIN_KEY || '').trim();
const fail = (m) => { console.error('실패: ' + m); process.exit(1); };
if (!current) fail('지금 키 파일이 비어 있어요');
if (next.length < 8) fail('새 키가 너무 짧아요 (8자 이상)');
if (next === current) fail('새 키가 지금 키와 같아요');
(async () => {
  let r, j = {};
  try {
    r = await fetch(base + '/admin/api/change-key', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-req': '1' }, body: JSON.stringify({ current, next, next2: next }) });
    j = await r.json().catch(() => ({}));
  } catch (e) { fail('서버에 연결하지 못했어요 (' + base + ')'); }
  if (!r.ok || !j.ok) fail(`HTTP ${r.status}${j.error ? ' — ' + j.error : ''}`);
  if (!process.env.HW_KEEP) { fs.writeFileSync(file + '.tmp', next + '\n', { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
  console.log(`성공: 관리자 키를 바꿨어요 (버전 ${j.version}). 기존 관리자 세션은 모두 풀렸어요.${process.env.HW_KEEP ? '' : ' .admin-key 파일도 새 키로 갱신했어요.'}`);
})();
JS
