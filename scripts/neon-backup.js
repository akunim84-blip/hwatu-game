#!/usr/bin/env node
// Neon(또는 아무 Postgres) 논리 백업 → SQL + JSON. 비밀번호는 출력하지 않음.
// 사용: DATABASE_URL=... node scripts/neon-backup.js [/path/prefix]
// 기본: /workspace/hwatu-backup/neon-YYYYMMDD-HHMM
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { dumpAll } = require('../lib/db-transfer');

async function main() {
  const url = process.env.DATABASE_URL || process.env.HWATU_DATABASE_URL;
  if (!url) { console.error('DATABASE_URL (또는 HWATU_DATABASE_URL) 이 없어요'); process.exit(1); }
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(/[: ]/g, (c) => (c === ' ' ? '-' : '')).slice(0, 16).replace(':', '');
  // sv-SE → 2026-10-05 18:27 → need YYYYMMDD-HHMM
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const kst = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const tag = `${kst.getFullYear()}${pad(kst.getMonth() + 1)}${pad(kst.getDate())}-${pad(kst.getHours())}${pad(kst.getMinutes())}`;
  const outBase = process.argv[2] || path.join('/workspace/hwatu-backup', 'neon-' + tag);
  fs.mkdirSync(path.dirname(outBase), { recursive: true });

  const data = await dumpAll(url);
  const sqlPath = outBase + '.sql';
  const jsonPath = outBase + '.json';
  fs.writeFileSync(sqlPath, data.sql);
  fs.writeFileSync(jsonPath, JSON.stringify(data.payload, null, 2));
  console.log('wrote', sqlPath);
  console.log('wrote', jsonPath);
  console.log('row_counts', JSON.stringify(data.counts));
  process.exit(0);
}
main().catch((e) => { console.error('backup failed:', e.message); process.exit(1); });
