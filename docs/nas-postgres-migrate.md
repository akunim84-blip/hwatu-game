# Neon → NAS Postgres 이전 (DS718+ · 레거시 Docker)

Render는 끄기 전에 데이터만 옮깁니다. **이 문서는 NAS에서 File Station / 텍스트 편집기로 할 일만** 적습니다.

실비밀번호는 저장소에 없습니다. 박스에 생성된 `.nas-pg-password`(gitignore)와 Neon 덤프(`/workspace/hwatu-backup/`)를 참고하세요.

## 선택: 왜 Postgres인가

앱의 JSON 저장소(`/app/data`)도 계정·PIN·토큰을 지원하지만, 지금 운영 데이터가 Neon(Postgres)에 있고, 동시 쓰기·백업·Render와 동일한 스키마가 필요하므로 **같은 compose 안에 `postgres:16-alpine`** 을 둡니다. 호스트에 5432를 열지 않습니다.

## NAS에서 할 일 (순서 그대로)

### 1) 폴더 만들기 (File Station)

경로: `docker/hwatu-game` (= `/volume1/docker/hwatu-game`)

없으면 만들고, 그 안에 다음을 **빈 폴더로** 생성:

- `pgdata` — Postgres 데이터 (절대 지우지 말 것)
- `backups` — 일일 백업 SQL/JSON

### 2) `docker-compose.yml` 교체

같은 폴더의 `docker-compose.yml`을 텍스트 편집기로 열고, GitHub `main`의 내용으로 **통째로 교체**한 뒤 아래만 바꿉니다.

| 자리표시자 | 넣을 값 |
|---|---|
| `<NAS_PG_PASSWORD>` (3곳: `db.POSTGRES_PASSWORD`, `hwatu-game.DATABASE_URL`, `pg-backup.PGPASSWORD`) | `.nas-pg-password` 파일 한 줄 |
| `# IMPORT_FROM_URL: "<NEON_DATABASE_URL>"` | **최초 1회만** 주석 `#` 을 지우고 Neon URL을 넣음. 가져오기 끝난 뒤 다시 주석 처리하거나 줄 삭제 |

`ADMIN_KEY`는 비워 두세요. Neon에서 `hwatu_settings.admin_key`가 같이 옵니다.

### 3) 덤프 파일 올려 두기 (IMPORT_FROM_URL을 안 쓸 때)

File Station으로 `backups/` 또는 알기 쉬운 곳에  
`neon-YYYYMMDD-HHMM.json` (또는 `.sql`) 을 복사해 둡니다.  
관리자 페이지 → **💾 데이터** → 가져오기로 올립니다.

### 4) Task Scheduler `hyukgame_start` 실행

기존과 같이 `hyukgame_start` 작업을 실행합니다  
(보통 `cd /volume1/docker/hwatu-game && docker-compose pull && docker-compose up -d`).

스크립트가 `docker-compose` 대신 `docker compose` 를 쓰면 그대로 두세요.

### 5) 확인

1. 컨테이너 로그 `hwatu-game`:
   - `[accounts] 저장소: postgres`
   - `IMPORT_FROM_URL`을 썼다면 `[db-transfer] 가져오기 완료 …`
2. 브라우저 `http://NAS내부IP:3300` — 기존 닉네임+PIN으로 로그인, 잔액·전적 확인
3. `/admin` — 계정 수·잔액이 Neon과 같은지, **💾 데이터** 탭에서보내기/상태 확인
4. `backups/`에 `hwatu-*.sql` / `pgdump-*.sql`이 생기는지 (기동 직후 pg-backup은 바로 1회, 앱 백업은 약 5분 후)

### 6) 가져오기 후 정리

- compose에서 `IMPORT_FROM_URL` 줄을 제거·주석 처리하고 `hyukgame_start` 한 번 더
- Render 서비스는 사용자가 직접 종료 (이 작업에서는 Render를 건드리지 않음)

## 가져오기가 동작하는 방식

1. **기동 시 `IMPORT_FROM_URL`** (권장, Neon이 아직 살아 있을 때)  
   대상 DB에 계정이 0개이고 `import_done` 설정이 없을 때만 Neon → NAS로 테이블 복사. 끝나면 `hwatu_settings.import_done` 기록 → 다시는 안 함.
2. **관리자 페이지 업로드**  
   `/admin` → 💾 데이터 → JSON/SQL 파일 선택 → 가져오기.  
   기본은 빈 DB만. 덮어쓰기는 체크 + 확인 문구 `REPLACE`.

보존: 계정, PIN 해시, 기기 토큰, 잔액, 전적, 관리자 키 설정.

## 일일 백업

- 앱: `BACKUP_DIR=/app/backups` → `hwatu-YYYYMMDD-HHMM.sql` + `.json`, 14일 보관
- 사이드카 `pg-backup`: `pgdump-*.sql`, 24시간마다, 14일 보관

## 롤백

`pgdata`를 다른 이름으로 옮기고 빈 `pgdata`를 만든 뒤, `backups`의 최근 SQL을 관리자 가져오기 또는 `psql`로 넣습니다.
