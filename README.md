# 🎴 혁게임 — 고스톱 · 맞고 · 섯다

카카오톡 단톡방에 링크를 공유해서 친구들과 실시간으로 즐기는 모바일용 화투 웹게임입니다.

> ⚠️ **게임 안에서만 쓰는 가상 머니(원)입니다. 충전·환전 없음.** 실제 돈, 결제, 현금 정산 기능이 없습니다.

- 섯다 (2~5명), 맞고 (2명), 고스톱 (3명)
- 서버가 셔플·딜·규칙 판정·점수 계산을 모두 처리 (각자 자기 패만 받음 → 치팅 방지)
- 방 코드 / 초대 링크(`?room=코드`), "카톡으로 공유" 버튼, 새로고침해도 자리 복귀
- 계정: 닉네임 + PIN 4자리 (scrypt+salt 해시), 기기별 토큰으로 자동 로그인, 잔액은 방·방문이 바뀌어도 유지
- 가상 머니: 처음 1,000,000원, 0원 이하가 되면 '파산! 300,000원으로 다시 시작'. 섯다 기본 판돈 10,000원(5천~10만), 맞고/고스톱 점당 1,000원(500~1만). AI는 조용히 충전
- 저장소: 환경변수 `DATABASE_URL`이 있으면 Postgres(`hwatu_accounts`, `hwatu_tokens` 테이블 자동 생성, 실패 시 로그 남기고 JSON으로 대체), 없으면 `data/accounts.json` (gitignore). 판 정산마다 저장
- 첫 화면: 진행 중인 방 목록(실시간, 눌러서 참여/관전), 내 돈, 순위 Top 10. 게임 중인 방에 들어가면 관전 후 다음 판부터 AI 자리를 넘겨받음

## 파일 설명

| 경로 | 설명 |
|---|---|
| `server.js` | Express + Socket.IO 서버 (방 관리, 게임 진행, 칩 정산). `PORT` 환경변수 사용, 기본 3300 |
| `lib/seotda.js` | 섯다 엔진: 족보 판정, 특수패(암행어사·땡잡이·구사), 베팅(다이·체크·삥·콜·하프·따당) |
| `lib/gostop.js` | 맞고/고스톱 엔진: 뻑·쪽·따닥·싹쓸이·폭탄·흔들기·보너스패, 점수/고/박 계산 |
| `lib/ai.js` | AI 상대 의사결정 (자기 패 + 공개 정보만 사용). 맞고/고스톱: 광·띠·쌍피·족보 완성/막기 우선, 고/스톱 판단, 흔들기·폭탄. 섯다: 족보 강도 기반 베팅/다이 + 약간의 블러핑. 난이도 쉬움/보통 |
| `scripts/verify-ai.js` | AI 대전 헤드리스 검증 (게임별 'AI와 바로 하기' 한 판, 로비 AI 추가/빼기, 친구+AI 혼합, 새로고침 재접속) |
| `shared/hints.js` | 족보 진행도/힌트 계산 (고도리·홍단·청단·초단·광·열·띠·피 배지, 손패 태그, 상대 족보 1장 남음 경고와 막을 패). 공개 정보 + 내 손패만 사용, 서버 테스트·브라우저 공용 |
| `scripts/verify-matgo.js` | 맞고/고스톱 셔플·한 장씩 돌리기·족보 힌트 헤드리스 검증과 스크린샷 |
| `lib/util.js` | 셔플 등 유틸 (crypto 난수) |
| `shared/cards.js` | 화투 48장(+보너스 2장)과 섯다 20장 정의 (서버/브라우저 공용) |
| `public/` | 프론트엔드 (`index.html`, `app.js`, `style.css`) — 빌드 과정 없는 순수 JS |
| `public/fx.js` | 효과음(Web Audio API로 직접 합성한 '탁'·'틱' 소리, 오디오 파일 없음)과 카드 날리기 애니메이션 헬퍼. 🔊/🔇 버튼으로 끄기(localStorage 저장) |
| `public/cards/` | 카드 이미지 (`c00.png`~`c47.png`, `back.svg`, `bonus.svg`), 출처 `LICENSE.txt` |
| `assets/hwatu-src/` | 카드 원본 SVG (Wikimedia Commons) |
| `test/` | 족보·점수·엔진 자동 테스트 (`npm test`) |
| `sim/simulate.js` | 봇들이 실제 서버에 접속해 수백 판을 돌리는 시뮬레이션 (`npm run sim`) |
| `scripts/verify-ui.js` | 폰 화면(360x640·390x844·412x915·390x700·가로 844x390)에서 게임 화면이 스크롤 없이 한 화면에 들어오는지 검사 + 패 돌리기/패 내기 애니메이션 스크린샷 |
| `scripts/` | 카드 이미지 빌드, 스크린샷, 콘택트 시트, 서버/터널 시작·중지 스크립트 |
| `render.yaml` | Render 배포 설정 |

## 내 PC에서 실행

1. [Node.js](https://nodejs.org/) (18 이상, LTS 권장) 설치
2. 이 폴더에서 터미널을 열고:
   ```bash
   npm install
   npm start
   ```
3. 브라우저에서 **http://localhost:3300** 접속
4. 같은 와이파이의 휴대폰에서는 `http://<내 PC IP>:3300` 으로 접속 가능

테스트: `npm test` (단위 테스트), `npm run sim` (봇 200판 시뮬레이션)

## Render 배포 방법 (무료)

1. 이 프로젝트를 GitHub 저장소에 올립니다.
2. [Render](https://render.com) 로그인 → **New +** → **Blueprint** 선택 → 저장소 연결
   (`render.yaml` 이 자동으로 인식됩니다: Web Service, Node, Free 플랜,
   빌드 `npm install`, 시작 `npm start`, 헬스체크 `/`)
   - Blueprint 대신 **New + → Web Service** 로 직접 만들어도 됩니다. 이때 Runtime `Node`,
     Build Command `npm install`, Start Command `npm start`, Instance Type `Free` 로 설정하세요.
3. 배포가 끝나면 `https://<서비스이름>.onrender.com` 주소를 카톡방에 공유하면 됩니다.

참고 (무료 플랜):
- 15분 동안 접속이 없으면 서버가 잠들고, 다음 접속 때 깨어나는 데 30초~1분 정도 걸립니다.
- 방 정보는 메모리에만 저장되므로 서버가 재시작되면 방이 사라집니다.

## 카드 이미지 출처와 라이선스

- 카드 앞면 48장: Wikimedia Commons **"SVG Hwatu"** 세트
  (https://commons.wikimedia.org/wiki/Category:SVG_Hwatu)
  — 저작자 Spenĉjo (Louie Mantia, Jr.의 Hanafuda 그래픽 기반, Marcus Richert 제작),
  라이선스 **CC BY-SA 4.0** (https://creativecommons.org/licenses/by-sa/4.0/)
- 변경 사항: SVG를 PNG로 변환했고, 게임 화면에서 월 숫자 배지·쌍피 표시를 덧씌웁니다.
  변환된 이미지도 CC BY-SA 4.0 으로 배포됩니다.
- 카드 뒷면(`back.svg`)과 보너스 쌍피(`bonus.svg`)는 직접 만든 도안 (CC0).
- 파일별 원본 링크는 `public/cards/LICENSE.txt` 참고.
