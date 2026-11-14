# 롤토체스 덱 메이커 — 작업 안내서 (Claude용)

오우찬(GitHub: Ginmil)의 대학 프로젝트. 2026년 11월 말 **시연** 예정.
사이트: https://ginmil.github.io/tft-deck-maker/ (GitHub Pages, main 브랜치 루트)
사용자와는 **한국어**로 대화한다. 사용자는 롤토체스를 잘 알기 때문에, 게임 감각에 대한 지적(역할·아이템·배치)은 대체로 옳다고 보고 데이터로 확인한다.

## 사용자 정의 (발표 논리)
- 메타를 편하게 보고 싶은 유저 → 메타 덱, 챔피언 3신기, 배치툴
- 게임 상황에 맞게 추천받고 싶은 유저 → 상징 팀 메이커(핵심 차별점), 아이템으로 찾기(완성/재료), 내 보드 기반 다음 수 추천(배치툴)

## 구조
- `index.html` + `css/style.css` + `js/` — 빌드 도구 없는 정적 사이트. **`js/bundle.js` 로 동작**하므로 `js/` 원본을 고친 뒤 반드시 `node build.mjs` 실행 (모듈들을 하나의 IIFE로 합침 → 파일 간 최상위 이름이 겹치면 안 됨).
- `js/adapters/cdragon.js` — Community Dragon JSON → 공통 형식. 시즌이 바뀌면 여기만 수정. 변환 규칙을 바꾸면 `ADAPTER_VERSION` 을 올려야 브라우저 캐시(localStorage)가 갱신됨.
  - 재료 아이템: `data.components`(완성 아이템·상징 조합식에 나오는 재료, 대검→활→… 순), 완성 아이템·상징에 `recipe: [재료1, 재료2]`.
  - Set 18은 `DA_` 접두사, 상징↔시너지 연결 정보가 없어 이름으로 매칭, 아이템 스탯이 비어 있어 `ITEM_ROLES` 표 + 재료로 역할 추정.
  - 특수 규칙은 시너지 설명 문장에서 자동 감지(`applySpecialRules`): "중첩 2개로 간주"(화신 럭스 → 시너지 2명분, `special` 기물), "N개의 팀 슬롯"(장로 드래곤 2칸), "OO 특성을 +N".
  - 챔피언 역할: 원거리=피해 유형, 근접은 마나 ≤50 & 방어 계수 없음 → 근접 딜러, 마나 ≥80 또는 방어·체력 계수 → 탱커. 보호막은 판단에 쓰지 않음(케넨 사례). 통계가 있으면 실제 장착 아이템으로 보정(`app.js applyWeights`).
- `js/engine/scorer.js` — 팀 평가(시너지 점수, 통계 가중치, 상징 배정·낭비 상징 감점·부적합 상징 감점).
- `js/engine/roles.js` — 핵심 캐리/메인 탱커, 상징 어울림(통계 장착 비율 우선, 없으면 전방/후방·물리/마법·사거리·코스트).
- `js/engine/search.js` — 빔 서치. 옵션: `required`, `exclude`(특수 기물 제외), `max5`(5코스트 개수 제한), `prefer`(되도록 유지, 가산점), `minDiff`(결과끼리 최소 차이).
  - `craftPlans`/`recipeBook` — 재료 → 조합 추천. 재료를 짝짓는 모든 최대 매칭을 보고(짝 있는 재료는 남기지 않음), 캐리 1명(딜템 3칸)+탱커 1명(탱템 3칸) 기준 점수 → 캐리 유형(물리/마법/전사형)별 최고 조합 우선 최대 3개 → `decksForItems(carryId 고정)`. 결과에 `d.craft = { made: [{ result, from }], left }`.
  - `distributeItems` — 캐리 가산점은 그 캐리에게 맞는 아이템일 때만(물리 캐리에 대천사 X).
  - `decksFromBoard`/`readBoard` — 배치툴 보드 → 다음 수 추천. 보드 챔피언 = required("바꿔도 돼요"면 아이템·3성·캐리만 required, 나머지 prefer), 낀 상징 = emblems, 딜 아이템 최다 챔피언 = 핵심 캐리. 목표 레벨 0 = 보드+1. 결과에 `d.board = { added, removed }`.
- `js/builder.js` — 배치툴(4×7 육각 보드, 드래그 앤 드롭, 아이템 분류 일반/찬란한/유물/상징, 저장·코드 공유, 덱 카드 → `bdOpenDeck`). `d.board` 가 있는 덱은 기존 배치·아이템을 유지한 채 빼는 챔피언만 빼고 새 챔피언을 빈 칸에 넣음 + "되돌리기".
- `js/app.js` 의 `runBoard`/`metaNearBoard` — 다음 수 추천 화면(`#bdRecs`): 내 보드와 절반 이상 겹치는 메타 덱(최대 3) + 이어서 완성하는 덱(최대 5). `metaDecks(minGames)` 는 메타 덱 탭과 공용.
- `js/app.js` — 화면 로직, 탭: 메타 덱 / 상징 팀 메이커 / 시너지로 찾기 / 아이템으로 찾기 / 챔피언 3신기 / 배치툴. 아이템 조합식 툴팁(`data-item` 속성).
- **세트 데이터 사본** `data/set-snapshot.json` — `tools/snapshot-set.mjs` 가 Community Dragon 을 받아 어댑터로 변환한 결과(`{ adapterVersion, fetchedAt, data }`). `.github/workflows/snapshot.yml` 이 매일 + `cdragon.js` 를 고쳐 푸시할 때마다 갱신(키 불필요). 사이트는 캐시 → 사본 → 원본 순으로 시작하고, "불러오기"가 실패하면 사본으로 대신함(11/14 Community Dragon 장애 대응, 원본 요청은 45초 시간 제한). 어댑터 버전이 다르면 사본을 무시하므로 `ADAPTER_VERSION` 을 올린 뒤에는 snapshot 워크플로가 끝났는지 확인.
  - 아이콘도 같은 워크플로가 `data/icons/*.png` 로 복사하고 `data/icons/map.json`(원본 URL → 사본 경로)을 만듦. `app.js setData → localizeIcons` 가 캐시·사본·원본 어느 데이터든 이 표로 주소를 바꿈 (11/14 Community Dragon 이 아이콘 하나에 20초 걸린 일 대응).
- `tools/collect-stats.mjs` + `tools/stats-lib.mjs` — 라이엇 API(TFT-LEAGUE-V1, TFT-MATCH-V1)로 랭커 경기 수집 → `data/weights.json`, `data/weights.js`. 키는 `tools/config.json`(gitignore) 또는 환경변수 `RIOT_API_KEY`.
  - **패치별 집계**(11/14): 경기의 `game_version` → 패치("16.22"). 오늘 목록 + 캐시에 쌓인 최근 `keepDays`(14)일 경기를 모아 집계. `patchWeights`: 최신 패치 1, 이전 패치는 최신 패치가 600판에 못 미친 만큼만 채움, 더 옛 패치 0 (시너지·챔피언·아이템 통계). 메타 덱은 `blend`: 이번 패치 성적 + 이전 패치 성적을 덱마다 최대 20판어치 사전 정보로만 → 너프된 옛 강덱이 판수로 새 메타를 덮지 않음(`test/patch-test.mjs`). weights.json 에 `patch: { current, prev, prevWeight, matches }`, 덱마다 `now`/`before`(패치별 실제 판수·평균 등수)·`patchGames`. 화면: 메타 탭 위 패치 안내, 덱 카드 ▲▼(이전 패치 대비 평균 등수 변화).
  - 다음 단계(사용자 요청): 패치노트 칸(변경된 기물·시너지·아이템) + 변경 기반 티어 예측 → 자동 티어표.
  - 집계 규칙: 도적의 장갑 보유자는 아이템 통계에서 제외, 전략가 아이템은 3신기에서 제외. 메타 덱 = "주력 시너지 + 핵심 캐리(딜 아이템 최다 → 3성 → 코스트)", 레벨만큼 자리 채움, 3성 비율 표시.
- `.github/workflows/collect.yml` — 매일 UTC 19시(KST 04시, 실제로는 지연됨) 수집 후 통계 파일 커밋. Secret `RIOT_API_KEY` 필요. Actions 캐시로 받은 경기 재사용.
- `test/` — `node test/run.mjs`, `node test/fit-test.mjs`, `node test/patch-test.mjs` (샘플 세트 `data/sample-cdragon.json`, `node test/make-sample.mjs > data/sample-cdragon.json` 로 재생성 후 `node build.mjs`). 샘플은 가상 세트(사슴·곰 등)지만 재료 아이템은 실제와 같은 apiName·조합식.

## 상태 (2026-11-12 기준)
- 완료: 위 탭 전부, 배포, 자동 수집(챌린저 200명 × 20판, 첫 수집 2,349판), 내 보드 기반 다음 수 추천(11/12), 재료 아이템 → 조합·덱 추천(11/14, 아이템 탭의 "재료 아이템").
- 라이엇 **Personal API Key 신청함 (App ID 905527, Pending Review)**. 승인 전에는 24시간 만료 개발 키라 자동 수집이 하루 뒤부터 실패 → 갱신이 필요할 때 키 재발급 후 Secret 교체 + Run workflow.
- 커밋 작성자는 `Ginmil <Ginmil@users.noreply.github.com>` 사용 (공개 저장소라 개인 이메일 노출 방지).

## 남은 일정
- 2주차(11/18~11/24): ~~내 보드 기반 다음 수 추천~~(완료), ~~재료 아이템 → 조합·덱 추천~~(완료), 메타 리스트 필터·상세.
- 3주차(11/25~11/30): 첫 화면·메뉴 정리, 버그 수정, 시연 시나리오(메타 덱 → 배치툴로 보기 → 상징 팀 메이커 → 재료/보드 추천), 발표 자료.
- 후순위: 전적검색(서버리스 프록시 + 만료 없는 키 필요, 메타 덱과 연결하는 방향).

## 작업 습관
- 기능 변경 후 `node build.mjs` → `node test/run.mjs` → Playwright로 화면 확인(샘플 데이터 버튼) → 커밋·푸시.
- 실제 Set 18 데이터 검증은 사용자 컴퓨터의 브라우저나 Community Dragon JSON(`raw.communitydragon.org/latest/cdragon/tft/ko_kr.json`)으로.
- API 키를 대화나 코드에 넣지 않는다.
