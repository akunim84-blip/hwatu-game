# 혁게임을 내 시놀로지 NAS에서 돌리기 (DSM 7.2 · Container Manager)

이 안내대로 하면 혁게임이 **내 NAS에서 24시간** 돌아가고, `https://내이름.synology.me` 같은 **내 주소**로 들어갈 수 있어요.
어려운 명령어 입력은 없어요. 화면에서 누르고, 복사해서 붙여넣기만 하면 됩니다.

> 표시 안내
> - ✅ = Synology 공식 문서나 여러 사용 후기에서 확인한 메뉴 이름
> - ⚠️ = DSM·Container Manager 버전에 따라 이름이나 위치가 조금 다를 수 있음 (비슷한 이름을 찾으세요)

---

## 한눈에 보는 순서

1. 내 NAS가 Container Manager를 쓸 수 있는지 확인
2. Container Manager 설치
3. File Station에 폴더 만들기 (`docker/hwatu-game`)
4. Render에서 `DATABASE_URL` 복사
5. Container Manager에서 '프로젝트' 만들기 → 게임 켜짐 (집 안에서 먼저 확인)
6. DDNS 주소 만들기 (`내이름.synology.me`)
7. Let's Encrypt 인증서 (자물쇠 🔒 HTTPS)
8. 역방향 프록시 (주소 → 게임 연결, WebSocket 켜기)
9. 공유기 포트포워딩 (443, 80)
10. 휴대폰 LTE로 접속 테스트
11. (나중에) 업데이트하는 법
12. 참고: Render는 어떻게? / 카톡 공유 링크 / 포트포워딩이 안 될 때 (Cloudflare Tunnel)

---

## 1. 내 NAS가 Container Manager를 쓸 수 있는지 확인

Container Manager(도커)는 **모든 시놀로지에서 되는 건 아니에요.**

**내 모델 이름과 CPU 보기** ✅
- DSM에 로그인 → **제어판 → 정보 센터 → 일반** 에서 **모델 이름**과 **CPU**를 확인하세요.

**대략적인 기준**
- 모델 이름 끝에 **+** 가 붙은 모델 (예: DS220+, DS224+, DS423+, DS720+, DS920+, DS923+ …) → 대부분 **됩니다** (Intel/AMD = x86_64).
- 일부 **+ 없는 모델**도 됩니다 (예: DS223, DS423, DS124, DS223j 등 ARM64 모델 — 최근 지원 추가).
- **오래된 j 모델·32비트 ARM 모델** (예: DS218j, DS216j 등)은 **안 됩니다.**

**가장 확실한 방법** ✅
- DSM의 **패키지 센터**에서 `Container Manager`를 검색해 보세요. **검색되고 설치 버튼이 있으면 OK**, 안 나오면 이 모델은 지원하지 않는 거예요.
- 또는 Synology 웹사이트의 Container Manager 페이지 → "적용 모델" 목록에서 내 모델을 찾아보세요:
  https://www.synology.com/ko-kr/dsm/packages/ContainerManager

> 💡 혁게임 이미지는 **x86_64(amd64)** 와 **ARM64(arm64)** 둘 다 만들어 두었어요. Container Manager만 설치되면 어느 쪽이든 돌아갑니다.
> 💡 메모리는 1GB 이상이면 충분해요 (게임 서버는 100MB 정도 씀).

---

## 2. Container Manager 설치 ✅

1. DSM → **패키지 센터** 열기
2. 검색창에 `Container Manager` 입력
3. **설치** 클릭 → 설치할 볼륨 고르기(보통 볼륨 1) → 완료

설치가 끝나면 **`docker`라는 공유 폴더**가 자동으로 생깁니다.

---

## 3. File Station에 폴더 만들기 ✅

1. **File Station** 열기
2. 왼쪽에서 **docker** 폴더 클릭
3. 위쪽 **생성 → 폴더 생성** ⚠️ → 이름: `hwatu-game` → 확인

→ 결과: `docker/hwatu-game` 폴더 (보통 실제 경로는 `/volume1/docker/hwatu-game`)

> 게임 데이터(계정·잔액)는 인터넷에 있는 Neon 데이터베이스에 저장되므로, 이 폴더에는 설정 파일만 들어가요.

---

## 4. Render에서 `DATABASE_URL` 복사하기

지금 Render에서 돌아가는 게임과 **같은 데이터베이스**를 쓰면 계정·잔액·순위가 그대로 이어져요.

1. 컴퓨터 브라우저로 https://dashboard.render.com 로그인
2. 서비스 목록에서 **hwatu-game** 클릭
3. 왼쪽 메뉴 **Environment** 클릭
4. `DATABASE_URL` 줄에서 값 옆의 **눈 모양(보기)** 또는 **복사** 버튼 ⚠️ 을 눌러 값을 복사
   - `postgresql://...neon.tech/...` 처럼 생긴 긴 글자예요.
5. 메모장에 잠깐 붙여 두세요.

> ⚠️ 이 주소는 **비밀번호가 들어 있는 열쇠**예요. 카톡·게시판·GitHub에 절대 올리지 마세요. NAS 프로젝트 설정 안에만 넣습니다.

(선택) `ADMIN_KEY`
- 관리자 페이지(`/admin`)에서 관리자 키를 한 번이라도 바꿨다면 키가 데이터베이스에 저장돼 있어서 **NAS에서는 비워 둬도 됩니다.**
- 한 번도 안 바꿨다면 Render의 `ADMIN_KEY` 값도 같이 복사해 두세요.

---

## 5. Container Manager에서 '프로젝트' 만들기 ✅

1. **Container Manager** 열기 → 왼쪽 **프로젝트** → **생성**
2. 입력:
   - **프로젝트 이름**: `hwatu-game`
   - **경로**: **설정** 버튼 → 3번에서 만든 `docker/hwatu-game` 선택
   - **원본(소스)**: **docker-compose.yml 만들기** ⚠️ ("compose.yml 생성"처럼 보일 수도 있어요) 선택
3. 아래 큰 입력칸에 **아래 내용을 그대로 붙여넣기**
   (GitHub의 [`docker-compose.yml`](../docker-compose.yml) 파일과 같은 내용이에요)

```yaml
services:
  hwatu-game:
    image: ghcr.io/akunim84-blip/hwatu-game:latest
    container_name: hwatu-game
    restart: unless-stopped
    ports:
      - "3300:3300"
    environment:
      TZ: Asia/Seoul
      PORT: "3300"
      TRUST_PROXY: "1"
      DATABASE_URL: "<여기에 DATABASE_URL 붙여넣기>"
      ADMIN_KEY: ""
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3300/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

4. **`<여기에 DATABASE_URL 붙여넣기>`** 부분을 지우고 4번에서 복사한 값을 붙여넣기
   - 앞뒤 **큰따옴표(")는 남겨 두세요.** 예: `DATABASE_URL: "postgresql://user:비번@ep-xxx.neon.tech/neondb?sslmode=require"`
   - `ADMIN_KEY`가 필요하면 `""` 따옴표 안에 넣기 (필요 없으면 그대로 `""`)
5. **다음** → (웹 포털 / Web Station 설정 화면이 나오면 **설정하지 않고 다음**) ⚠️ → **완료**
   - "프로젝트 생성 후 시작" 같은 체크가 있으면 켜 두세요.
6. 이미지를 내려받고 컨테이너를 만드는 기록이 나옵니다. `Exit Code: 0` 이 보이면 성공이에요.

**집 안에서 먼저 확인**
- 같은 와이파이의 휴대폰/PC 브라우저에서 `http://NAS내부IP:3300` 접속 (예: `http://192.168.0.10:3300`)
  - NAS 내부 IP는 **제어판 → 네트워크 → 네트워크 인터페이스** ✅ 에서 볼 수 있어요.
- 혁게임 첫 화면이 나오면 성공! 🎉
- Container Manager → **컨테이너** 목록에서 `hwatu-game` 상태가 **실행 중 (정상/healthy)** 인지도 볼 수 있어요.

> 안 될 때: 프로젝트 → `hwatu-game` → **컨테이너** → `hwatu-game` → **로그** ⚠️ 를 보면 이유가 적혀 있어요.
> - 정상: `[accounts] 저장소: postgres` 줄이 보여요.
> - `DATABASE_URL`을 잘못 붙여넣었으면 `postgres 초기화 실패 → JSON 파일로 대체` 가 보여요. 이때도 게임은 켜지지만 **계정이 Render와 따로 놀고, 업데이트하면 사라져요** — 꼭 고치세요. 프로젝트를 **중지 → 편집(YAML 수정) → 빌드** 하면 다시 적용돼요.

---

## 6. DDNS 주소 만들기 (내이름.synology.me) ✅

집 인터넷 IP는 가끔 바뀌니까, 바뀌어도 따라가는 **무료 주소**를 만듭니다.

1. **제어판 → 외부 액세스 → DDNS** 탭 → **추가**
2. **서비스 공급자**: `Synology`
3. **호스트 이름**: 원하는 이름 입력 (예: `hyukgame`) + 뒤쪽에서 `synology.me` 선택
   → 주소는 `hyukgame.synology.me` 가 됩니다.
4. Synology 계정 로그인이 필요하면 로그인 (없으면 여기서 무료 가입)
5. **"Let's Encrypt에서 인증서를 가져오고 기본 인증서로 설정"** ✅ 체크 (다음 7번을 자동으로 해 줌)
6. **연결 테스트** → 상태가 **정상** 이면 **확인**

> 인증서 받기는 외부에서 NAS로 **80번 포트**가 연결돼야 성공해요. 실패하면 9번(포트포워딩)을 먼저 하고 7번을 다시 하세요.

---

## 7. Let's Encrypt 인증서 (HTTPS 자물쇠) ✅

6번에서 체크했다면 이미 됐을 수 있어요. 확인/직접 받기:

1. **제어판 → 보안 → 인증서** 탭
2. `hyukgame.synology.me` 인증서가 목록에 있으면 OK
3. 없으면 **추가 → 새 인증서 추가 → Let's Encrypt에서 인증서 얻기** ⚠️ 선택
   - **도메인 이름**: `hyukgame.synology.me`
   - **이메일**: 내 이메일
   - **주체 대체 이름**: (비워도 됨. 여러 주소를 쓰려면 `*.hyukgame.synology.me` — synology.me 주소는 와일드카드 가능)
   - **기본 인증서로 설정** ✅ 체크
4. 같은 화면의 **설정** 버튼 ⚠️ 에서, 나중에 만들 역방향 프록시 항목(`hyukgame.synology.me:443`)의 인증서가 이 인증서로 되어 있는지 확인하세요 (8번 뒤에).

---

## 8. 역방향 프록시 (내 주소 → 게임 연결) ✅

`https://hyukgame.synology.me` 로 들어오면 NAS 안의 게임(3300번)으로 넘겨 주는 설정이에요.

1. **제어판 → 로그인 포털 → 고급** 탭 → **역방향 프록시** 버튼
2. **생성**
3. **일반** 탭:
   - **역방향 프록시 이름**: `hwatu-game`
   - **소스** (밖에서 들어오는 쪽)
     - 프로토콜: **HTTPS**
     - 호스트 이름: `hyukgame.synology.me`
     - 포트: **443**
     - (HSTS 사용은 켜도 되고 꺼도 됨)
   - **대상** (NAS 안쪽)
     - 프로토콜: **HTTP**
     - 호스트 이름: `localhost`
     - 포트: **3300**
4. **사용자 지정 머리글** 탭 → **생성 ▼ → WebSocket** ✅ 클릭
   - `Upgrade: $http_upgrade`, `Connection: $connection_upgrade` 두 줄이 자동으로 생겨요.
   - ⚠️ **이걸 꼭 해야** 게임이 실시간으로 움직여요. 안 하면 방 목록이 안 뜨거나 "연결 중…"에서 멈춥니다.
5. (선택) **고급 설정** 탭 ⚠️ 의 **프록시 시간 초과**는 기본값 그대로 둬도 됩니다 (게임이 10초마다 신호를 주고받아 끊기지 않아요).
6. **저장**

> 게임 서버는 프록시가 보내 주는 `X-Forwarded-For`/`X-Forwarded-Proto` 를 믿도록 설정되어 있어서 (`TRUST_PROXY=1`), 관리자 로그인 쿠키가 HTTPS에서 안전하게(Secure) 저장되고, 틀린 관리자 키 제한도 접속자별로 제대로 걸립니다.

---

## 9. 공유기 포트포워딩 (443, 80)

밖(LTE, 친구 집)에서 들어오는 요청을 NAS로 보내 주는 설정이에요. **공유기마다 메뉴가 달라요** ⚠️.

| 외부 포트 | 내부 IP | 내부 포트 | 프로토콜 | 용도 |
|---|---|---|---|---|
| 443 | NAS 내부 IP (예: 192.168.0.10) | 443 | TCP | 게임 접속 (HTTPS) |
| 80 | NAS 내부 IP | 80 | TCP | 인증서 발급·갱신용 |

- ipTIME: 관리 페이지(보통 `192.168.0.1`) → **고급 설정 → NAT/라우터 관리 → 포트포워드 설정** ⚠️
- 통신사 공유기(KT/SK/LG): 각 공유기 관리 페이지의 "포트 포워딩" 메뉴 ⚠️
- **3300 포트는 열 필요 없어요.** (밖에서는 443으로만 들어오고, NAS가 안에서 3300으로 넘겨 줌)
- NAS 내부 IP가 바뀌지 않게 공유기에서 **고정 IP(DHCP 예약)** 를 해 두면 좋아요.
- 시놀로지 **제어판 → 보안 → 방화벽** 을 켜 두었다면 443·80 허용 규칙이 있어야 해요 ⚠️.

> 통신사 공유기 뒤에 또 공유기가 있는 "이중 공유기"라면 두 군데 다 설정해야 해요. 너무 어렵거나 안 되면 **12-3 (Cloudflare Tunnel)** 방법을 쓰세요.

---

## 10. 휴대폰 LTE로 테스트

1. 휴대폰 **와이파이를 끄고** (LTE/5G로)
2. 브라우저에서 `https://hyukgame.synology.me` 접속
3. 확인할 것
   - 주소창에 **자물쇠 🔒** 가 보이는지
   - 로그인(이름 입력) → 방 만들기 → 게임 시작이 되는지 (실시간으로 움직이면 WebSocket OK)
   - 관리자 페이지 `https://hyukgame.synology.me/admin` 로그인이 되는지
4. 친구에게 카톡으로 주소를 보내 같이 들어와 보기

---

## 11. 업데이트하는 법 (새 버전이 나왔을 때)

GitHub에 새 코드가 올라가면 새 이미지(`ghcr.io/akunim84-blip/hwatu-game:latest`)가 자동으로 만들어져요. NAS에서 받아오기만 하면 됩니다.

**방법 A (쉬움)** ⚠️ Container Manager 버전에 따라 화면이 조금 다름
1. Container Manager → **이미지** → `ghcr.io/akunim84-blip/hwatu-game` 옆에 **업데이트 가능** 표시가 있으면 클릭 → 업데이트
2. 끝나면 **프로젝트** → `hwatu-game` → **중지** → **작업 → 빌드** (또는 시작)

**방법 B (확실함)**
1. **프로젝트** → `hwatu-game` 선택 → **중지**
2. **작업 → 정리** ⚠️ (설정은 지워지지 않아요)
3. **이미지** 탭에서 `ghcr.io/akunim84-blip/hwatu-game` 이미지를 **삭제**
4. 다시 **프로젝트** → `hwatu-game` → **작업 → 빌드** → 최신 이미지를 새로 받아서 켜짐

> 업데이트해도 계정·잔액은 데이터베이스(Neon)에 있어서 그대로예요. 다만 **진행 중이던 방은 사라지니** 사람들이 게임하지 않을 때 하세요.

---

## 12. 참고

### 12-1. Render는 어떻게 하나요?
- **둘 다 켜 둬도 됩니다.** 같은 데이터베이스를 쓰니까 **계정·잔액·순위는 함께** 쓰여요.
- 하지만 **방(게임 테이블)은 서버마다 따로**예요. NAS 주소로 들어온 사람과 Render 주소로 들어온 사람은 **같은 방에서 만날 수 없어요.** → 친구들에게 **새 주소 하나만** 알려 주세요.
- 같은 사람이 두 서버에서 동시에 게임하면 잔액이 엇갈릴 수 있으니, 한쪽만 쓰는 게 좋아요.
- 추천: NAS가 잘 되면 Render는 **예비용**으로 두거나 (Render 대시보드 → hwatu-game → **Settings → Suspend Web Service** ⚠️) 꺼 두세요. 데이터베이스(Neon)는 NAS가 계속 쓰니 **Neon은 지우면 안 돼요!**

### 12-2. 카톡 공유(초대) 링크
- 게임 안의 "💬 카톡으로 공유" 버튼은 **지금 접속한 주소**(`location.origin`)로 링크를 만들어요.
  → NAS 주소로 들어와서 공유하면 자동으로 `https://hyukgame.synology.me/?room=...` 링크가 나갑니다. 따로 바꿀 것 없어요.
- 예전에 보냈던 `onrender.com` 링크는 Render 서버로 연결되니, 새 주소를 다시 보내 주세요.

### 12-3. 포트포워딩을 못 할 때: Cloudflare Tunnel
- 시놀로지 **QuickConnect**는 시놀로지 자체 앱(DSM, Photos 등)용이라 **혁게임 같은 직접 만든 앱에는 쓸 수 없어요.**
- 대신 **Cloudflare Tunnel**(무료)을 쓰면 공유기 설정 없이 밖에서 접속할 수 있어요. 단, **내 도메인(예: `mygame.com`)이 Cloudflare에 등록**되어 있어야 해요 (도메인은 1년 1~2만 원 정도). synology.me 주소는 쓸 수 없어요.
- 이 방법을 쓰면 6~9번(DDNS, 인증서, 역방향 프록시, 포트포워딩)은 **안 해도 됩니다.**

순서 ⚠️ (Cloudflare 화면은 자주 바뀜 — 이름이 조금 다를 수 있어요)
1. https://dash.cloudflare.com 가입 → 내 도메인 추가 (도메인 구입처에서 네임서버를 Cloudflare로 변경)
2. **Zero Trust → 네트워크(Networks) → Tunnels → Create a tunnel** → 종류 **Cloudflared** → 이름 `hwatu`
3. 설치 방법에서 **Docker** 를 고르면 나오는 명령어 안의 `--token` 뒤의 긴 글자(**토큰**)만 복사
4. **Public Hostname(공개 호스트 이름)** 추가: 하위 도메인 `game`, 도메인 `mygame.com`, 서비스 유형 **HTTP**, URL **`hwatu-game:3300`**
5. NAS의 Container Manager → **프로젝트** → `hwatu-game` → **중지** → **편집(YAML)** 에서 GitHub의 [`docker-compose.yml`](../docker-compose.yml) 아래쪽 `cloudflared:` 부분을 붙여 넣고
   - `TUNNEL_TOKEN` 에 복사한 토큰 넣기
   - `profiles: ["tunnel"]` 줄 **지우기** (이 줄이 있으면 터널이 켜지지 않아요)
6. **저장 → 빌드** → 잠시 뒤 `https://game.mygame.com` 으로 접속 (HTTPS·WebSocket은 Cloudflare가 알아서 처리)

---

## 문제 해결 요약

| 증상 | 확인할 것 |
|---|---|
| `http://NAS IP:3300` 도 안 열림 | 컨테이너가 실행 중인지, 로그에 오류가 있는지 (5번) |
| 집에선 되는데 LTE에선 안 됨 | 포트포워딩(9번), DDNS 연결 테스트 '정상'(6번), 방화벽 |
| 자물쇠가 없음 / 경고 | 인증서(7번), 역방향 프록시 소스가 HTTPS 443인지 |
| 화면은 뜨는데 "연결 중…"에서 멈춤, 방 목록 안 뜸 | 역방향 프록시 **사용자 지정 머리글 → WebSocket** (8-4번) |
| 계정·잔액이 Render와 다름 | `DATABASE_URL`을 Render와 똑같이 붙여넣었는지 (로그에 `저장소: postgres` 가 있어야 함) |
| 관리자 페이지가 "꺼져 있어요" | 관리자 키를 한 번도 안 바꿨다면 `ADMIN_KEY`에 Render와 같은 키 입력 |

---

### (참고) 기술 정보
- 이미지: `ghcr.io/akunim84-blip/hwatu-game:latest` (linux/amd64, linux/arm64), 커밋별 태그 `sha-xxxxxxx`
- 컨테이너는 root가 아닌 `node` 사용자로 실행, 포트 `3300` (환경변수 `PORT`로 변경 가능)
- 상태 확인: `GET /healthz` → `200 ok` (데이터베이스 사용 안 함)
- `TRUST_PROXY=1` (이미지 기본값): 바로 앞 프록시 1단계를 믿음 → 접속자 IP·HTTPS 여부를 올바르게 인식
- 비밀값(`DATABASE_URL`, `ADMIN_KEY`, `TUNNEL_TOKEN`)은 NAS의 프로젝트 설정에만 넣고 GitHub에는 올리지 않습니다.
