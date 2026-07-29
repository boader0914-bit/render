# V2 + Cluster 기능 통합 및 V3 UI 전환 단계별 개발 프롬프트

작성일: 2026-07-29
대상 저장소: C:\Users\USER\Documents\Codex\2026-06-09\019ea156-4303-77a3-84bf-5fbb17f63201
실행 기준: docs/v2_cluster_v3_ui_master_plan.md

## 사용 방법

1. Stage 224부터 순서대로 한 단계씩 실행한다.
2. 한 프롬프트를 새 작업에 그대로 붙여 넣는다.
3. 이전 단계의 종료 조건과 테스트가 모두 통과한 경우에만 다음 프롬프트를 실행한다.
4. 각 프롬프트는 구현까지 요구한다. 조사나 계획만 작성하고 종료하면 미완료다.
5. staging 배포와 production 전환은 해당 프롬프트 안의 승인 지점에서 반드시 멈춘다.

단계 의존성 보정:

- Stage 227의 신규 결과 UI parity는 합성 fresh-collection fixture를 사용하는 provisional gate다.
  실제 신규 store 결과 acceptance는 Stage 228에서 수행한다.
- Stage 229는 관광·신호 계약과 fixture adapter를 사용한다. 실제 provider, credential,
  scheduler와 quota 운영은 Stage 231에서 구현한다.
- 현재 Stage 222·223 변경이 미커밋 상태이므로 branch switch, commit 또는 기존 변경 분리는
  자동 수행하지 말고 정확한 범위를 보고한 뒤 사용자 지시를 따른다.

## 공통 실행 계약

모든 단계 프롬프트는 아래 계약을 따른다.

### 필수 사전 확인

- 대상 저장소, 현재 브랜치, HEAD, git status를 먼저 보고한다.
- 다음 문서를 완전히 읽고 상충 시 최신 마스터 플랜을 우선한다.
  - docs/v2_cluster_v3_ui_master_plan.md
  - docs/stage221_v2_integration_baseline.md
  - docs/stage222_contract_freeze.md
  - docs/stage223_company_observation_preview.md
- V2 기준 커밋은 4e4e1906e2967fe58df66f8ad67f832043d2763b다.
- Cluster 참조 커밋은 57a6c561496812126e2ff2e8a61bff51099b2423이다.
- V3 UI 참조 저장소는 C:\Users\USER\Documents\lodging-datalab-v3,
  참조 커밋은 2bcdc7c0843358bb3cbb8a2025ffe873d3bf5154다.
- 현재 worktree의 기존 수정은 사용자 자산이다. 덮어쓰기, 삭제, reset, checkout 복구를 하지 않는다.
- 현재 integration branch의 upstream은 production source branch일 수 있으므로
  명시적으로 확인하지 않은 push를 금지한다.

### 영구 고정 원칙

- 중복 기능은 V2의 API, 입력, 계산, 상태 전이, 오류 처리와 companyId 규칙을 우선한다.
- Cluster 고유 기능만 V2 경계에 맞춰 모듈로 이식한다.
- UI 외형, 로그인 화면, 역할별 shell, light/dark와 반응형은 V3를 기준으로 한다.
- V2와 Cluster의 기존 company payload, 관측, run/output, 검색 이력, 관광 cache,
  신호, 리포트와 전략 이력은 통합 store에 복사·projection·dual-write·backfill하지 않는다.
- 통합 store는 빈 schema로 시작하며 통합 수집기가 만든 신규 데이터만 사용한다.
- 기존 password hash, session, token과 secret을 복사하지 않는다.
- 기존 소스 데이터는 합성 fixture와 계약 검증 참고 외에는 runtime에서 읽지 않는다.
- Stage 223의 V2_INTEGRATION_COMPANY_ENABLED와 V2_INTEGRATION_OBSERVATION_ENABLED는
  test-only preview flag다. 신규 운영 수집 flag로 재사용하지 않는다.
- Cluster 브랜치 merge, 대형 commit cherry-pick, 거대 서버·HTML·JS·CSS 통째 복사를 금지한다.
- 자동 병합, 자동 공개, 재귀 SLA, calibration, 자동승인과 자동 정책 학습을 만들지 않는다.
- 기능 플래그는 기본 false이며 off 경로가 기존 V2 동작을 보존해야 한다.

### 작업 안전

- 파일 수정에는 apply_patch를 사용한다.
- 관련 없는 dirty file을 수정하지 않는다.
- 파괴적 Git 명령과 운영 데이터 삭제를 금지한다.
- 새 외부 credential, 유료 API 호출, staging 배포, production 배포가 필요하면
  준비와 로컬 검증까지 완료한 후 실행 직전에 사용자 승인을 요청한다.
- 테스트 실패, 원천 데이터 read/copy 탐지, companyId 충돌, 권한 우회 또는
  rollback 부재가 있으면 다음 단계로 진행하지 않는다.
- 계약 snapshot은 테스트 통과만을 위해 갱신하지 않는다. UPDATE_CONTRACT_SNAPSHOTS를
  사용하려면 변경 이유를 보고하고 의도적 승인을 받은 뒤 환경변수를 해제한다.
- legacy UI 전환만으로 rollback 완료로 간주하지 않는다. 이전 V2 artifact, API routing,
  auth/session 재로그인 정책과 read-only legacy data 경계를 함께 검증한다.

### 모든 단계의 필수 종료 보고

1. 대상 저장소, 브랜치와 HEAD
2. 구현한 단계와 기능
3. 변경 파일 목록
4. 기존 데이터 read/write/copy 여부
5. 새 통합 store 영향
6. 실행한 명령과 테스트 결과
7. light/dark·desktop/mobile 검증 결과
8. 배포 여부
9. 남은 위험과 blocker
10. 다음 단계 프롬프트 번호

---

## Prompt 01 — Stage 224 요구·기능 원장과 신규 수집 예산 동결

~~~text
Stage 224를 실제로 수행하라. 계획만 제시하지 말고 원장, 수집 예산, 명칭 정합화와
검증 자산을 저장소에 구현하라.

먼저 docs/v2_cluster_v3_ui_stage_prompts.md의 공통 실행 계약과
docs/v2_cluster_v3_ui_master_plan.md를 완전히 읽고 따른다.

목표:
1. V2와 Cluster의 모든 기능·API·화면을 한 원장으로 확정한다.
2. V2 우선, Cluster 이식, 후속 보류, 제외 결정을 기능별로 기록한다.
3. 기존 데이터 무이관과 빈 통합 store 신규 수집 원칙을 모든 항목에 연결한다.
4. 전체 신규 수집의 provider별 요청량, 쿼터, 비용, 예상 시간과 재시작 정책을 산정한다.
5. package, README, 서비스명과 문서의 대상 앱 명칭 불일치를 정리한다.

필수 작업:
- 현재 dirty worktree를 먼저 감사하고 기존 Stage 222·223 변경을 보존한다.
- 기존 미커밋 변경을 자동 commit하거나 다른 branch로 이동하지 않는다. 단계 격리에
  commit 또는 branch switch가 필요하면 변경 범위와 선택지를 보고하고 사용자 지시를 받는다.
- npm test를 기준선으로 실행한다.
- V3 조사치 V2 45개/Cluster 214개와 Stage 221 literal 추출치
  V2 43개/Cluster 228개의 차이를 동적 route까지 포함해 설명한다.
- 재실행 가능한 route/feature inventory script를 작성하거나 기존 분석을 검증한다.
- 기능 원장에는 최소한 다음 필드를 둔다:
  id, domain, source, sourceCommit, sourcePath, role, routeOrScreen,
  v2Conflict, decision, v2PriorityReason, targetStage, featureFlag,
  freshDataInputs, tests, releaseGate, notes.
- 모든 Cluster 기능에 keep/port/defer/exclude 중 하나와 근거를 부여한다.
- A/B 기능은 표본 확보 후 defer, 재귀 SLA·자동승인은 exclude로 고정한다.
- 신규 수집 예산에는 quick/detail/OTA/leadtime/tourism/search-volume/SNS별
  대상 수, 예상 호출 수, rate limit, quota, 비용, 실패 재시도, 중단·재개 방식을 기록한다.
- 신규 수집 예산에 acceptance 식과 숫자 기준을 동결한다. 최소한 coverage, 성공률,
  결측률, 논리 중복률, freshness, API p95, worker 처리량, provider별 비용을 포함하고
  각 지표의 분자·분모, 측정 창, 표본 최소치, 경고선, 중단선과 승인자를 적는다.
  논리 중복, quota 초과와 companyId 충돌의 허용치는 0으로 둔다.
- 행정구역 코드·경계 GeoJSON처럼 수집 대상이 아닌 정적 자산은 출처, 버전, license,
  checksum이 있는 allowlist로만 허용한다. V2·Cluster의 기존 수집 파일, DB, cache와
  산출물은 정확한 경로·식별자를 적은 denylist로 만들고 runtime 접근 검사를 붙인다.
- 모든 feature flag에 owner, approver, dependsOn, 기본값, 대상 역할, rollout 순서,
  관찰 지표와 rollback 동작을 기록한다. 단계별 Responsible/Accountable/Consulted/Informed를
  역할 단위로 확정하고 승인자가 미정인 항목은 blocker로 처리한다.
- 현재 package name과 README가 대상 서비스명과 다른 원인을 확인하고
  안전한 범위에서 glamping-datalab-v2로 정합화한다.
- Stage 223 preview는 계약 테스트 자산만 유지하고 runtime migration 경로가 아님을 검증한다.

권장 산출물:
- docs/stage224_feature_ledger.md
- docs/stage224_feature_ledger.json
- docs/stage224_fresh_collection_budget.md
- 재실행 가능한 inventory 검사 script와 test

금지:
- Cluster branch merge 또는 whole-file copy
- 실제 외부 수집
- 기존 V2·Cluster 데이터 읽기 결과를 새 원장 데이터로 저장
- staging/production 배포

필수 검증:
- 작업 시작과 종료 시 npm run test:contracts, npm run test:integration-preview, npm test
- 기능 원장의 모든 항목에 decision과 targetStage가 있는지 자동 검사
- 두 route 인벤토리 수 차이가 누락 없이 설명되는지 검사
- 기존 데이터 migration/backfill/dual-write 항목이 0인지 검사
- 정적 자산 allowlist 밖의 파일과 기존 데이터 denylist에 대한 runtime 접근이 0인지 검사
- acceptance 기준에 정성 표현이나 미정 숫자가 남지 않았는지 검사
- git diff --check

종료 조건:
- 모든 기능에 owner, 결정, 단계, 테스트와 신규 데이터 입력이 연결된다.
- 수집 예산과 provider 승인 필요 항목이 명확하다.
- blocker가 0이다.
- 다음 Stage 225 작업은 수행하지 말고 종료 보고만 작성한다.
~~~

## Prompt 02 — Stage 225 V3 UI 기반과 병행 운영

~~~text
Stage 225를 실제로 구현하라. Stage 224 종료 증적이 없거나 blocker가 남아 있으면
구현을 시작하지 말고 그 사실을 보고하라.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

목표:
- 기존 web 디렉터리를 rollback 가능한 legacy UI로 유지한다.
- React 19 + Vite 기반 새 UI와 V3형 공통 디자인 시스템을 별도 경계로 만든다.
- V3형 로그인 shell, 관리자 shell, 사업자 shell, light/dark와 역할 navigation을 구현한다.
- 새 UI 전체를 기본 false feature flag 뒤에 둔다.

필수 구현:
- package manager는 기존 npm 명령 체계로 고정하고 npm workspaces와 package-lock.json을
  단일 의존성 기준으로 사용한다. 다른 lockfile이나 중복 React 설치를 만들지 않는다.
- apps/web에 React/Vite 애플리케이션을 만들고 packages/ui에 V2용 공통 UI를 둔다.
- V3 참조의 token, theme boot, AppShell 외형, PageHeader, StatusBadge,
  MetricCard, EmptyState, 버튼과 인증 panel을 필요한 범위로 이식한다.
- V3의 거대 App.tsx와 app.css는 통째로 복사하지 않고 출처를 문서화한다.
- AppShell의 브랜드, 상태 문구, 홈 경로와 link renderer를 props로 분리한다.
- route와 navigation은 단일 registry에서 생성한다.
- 공통 API/CSRF/session client를 한 곳에 만든다.
- 새 CSS는 layer 또는 새 UI root로 scope하여 legacy CSS와 충돌하지 않게 한다.
- 첫 방문 light, 사용자 선택 dark, localStorage key lodging-v2-theme,
  React 실행 전 data-theme 적용을 구현한다.
- 인증 전 경로 /login, /signup, /activate, /reset-password의 기본 shell을 만든다.
- 로그인 후 사업자 9개, 관리자 13개 V3형 navigation과 빈 상태 화면을 만든다.
- 기존 /admin, /b2b, /view deep link의 compatibility 전략을 구현한다.
- V2_UI_V3_ENABLED 또는 동등한 명확한 flag를 기본 false로 추가한다.
- server가 새 build를 flag가 켜진 경우에만 제공하고 off 시 legacy UI를 그대로 제공하게 한다.
- PWA 이름, start URL, cache key와 사용자 cache 폐기를 V2 기준으로 설계한다.
- rollback runbook에는 이전 V2 artifact 재선택, API routing 복원, 새 asset cache 폐기와
  기존 session을 보존할 수 없는 경우의 안전한 재로그인 절차를 포함한다.

시각 기준:
- desktop 1440×900, mobile 390×844
- light/dark 네 조합
- 320px 최소폭, 200% 확대, keyboard focus, WCAG AA
- 로그인 panel은 V3의 폭·입력·버튼 비율을 따른다.

테스트:
- npm test
- 새 UI typecheck와 production build
- flag off legacy 회귀
- theme boot와 저장·전환 test
- route registry와 role navigation test
- login/admin/business shell의 네 조건 screenshot test
- CSS leakage test
- git diff --check

금지:
- 기존 web 파일 삭제
- Cluster UI 복사
- 기존 운영 데이터 표시
- 인증 저장 모델 교체
- staging/production 배포

종료 조건:
- V3형 로그인과 빈 관리자/사업자 shell이 네 조건 QA를 통과한다.
- feature flag off에서 기존 V2 응답과 UI가 변하지 않는다.
- Stage 226은 수행하지 않는다.
~~~

## Prompt 03 — Stage 226 인증·계정·보안

~~~text
Stage 226을 실제로 구현하라. Stage 225의 UI build, flag-off 회귀와 네 조건
시각 QA가 통과하지 않았으면 시작하지 않는다.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

목표:
- V2 로그인 UX와 API 계약을 보존하면서 새 통합 계정 저장소와 Cluster의 보안 기능을 추가한다.
- 기존 password hash, session과 token을 복사하지 않고 계정을 새로 발급한다.
- V3형 인증 화면을 실제 인증 API와 연결한다.

필수 구현:
- 운영 모드에서 명시적 새 auth store가 없으면 fail closed한다.
- Stage 228의 빈 통합 store가 의존할 account, company, membership, session, invite,
  MFA와 auth audit의 최소 schema·repository·bootstrap을 이 단계에서 구현한다.
  깨끗한 임시 저장소에서 bootstrap을 반복해도 결과가 같은지 검증한다.
- 최초 관리자 bootstrap, 신규 가입, 초대·활성화, 비밀번호 reset을 구현한다.
- 관리자 MFA/TOTP, 복구 코드와 민감 작업 재확인을 구현한다.
- session token은 hash로 저장하고 만료·폐기·강제 로그아웃·키 회전을 지원한다.
- CSRF token, Origin/Host allowlist, secure cookie, 보안 header를 구현한다.
- 로그인 실패 rate limit, 계정 잠금, tenant 거부와 계정 변경 audit를 구현한다.
- fallback credential을 안전한 bootstrap이 준비된 뒤 제거한다.
- 기존 /api/login, /api/session, /api/logout의 shape와 오류 의미를 호환한다.
- 새 UI의 아이디 또는 이메일 입력을 V2 호환 login client에 연결한다.
- 관리자와 사업자의 company ownership을 server에서 강제한다.
- free/basic/pro entitlement와 검색·export 한도의 기본 계약을 추가한다.
- 이메일은 mock provider를 기본으로 하고 real provider는 명시적 승인 전 사용하지 않는다.
- V2_INTEGRATION_AUTH_ENABLED는 기본 false로 유지한다.

데이터 경계:
- 기존 b2b member, password hash, session 파일을 가져오지 않는다.
- 필요한 사용자는 초대·활성화로 신규 생성한다.
- 다른 업체 companyId 접근은 UI 숨김이 아니라 server 403으로 차단한다.

필수 테스트:
- npm test
- 신규 auth/account/security test group
- bootstrap→MFA→로그인→session→logout end-to-end
- invite 단일 사용·만료·취소·재발급
- password reset 후 기존 session 폐기
- CSRF, Origin, Host, IDOR와 tenant escape
- brute force와 lock 해제
- feature flag off 회귀
- legacy artifact/API routing으로 rollback했을 때 기존 session 호환 또는 명시적
  안전 재로그인 중 선택한 정책이 실제로 동작하는지 검증
- light/dark × desktop/mobile 인증 화면 screenshot
- git diff --check

종료 조건:
- 신규 발급 계정에서 V2 login/session/logout 계약이 통과한다.
- 기존 auth 데이터 copy가 0건이다.
- tenant·MFA·CSRF blocker가 0이다.
- Stage 227은 수행하지 않는다.
~~~

## Prompt 04 — Stage 227 V2 핵심 기능 UI parity

~~~text
Stage 227을 실제로 구현하라. Stage 226 보안 회귀가 모두 통과해야 한다.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

목표:
- V2 핵심 사용자 여정을 V3형 화면으로 다시 구현한다.
- 데이터가 없는 상태와 신규 수집 결과 상태를 모두 완성한다.
- legacy UI를 즉시 복귀 가능한 상태로 유지한다.
- 이 단계의 신규 수집 결과는 합성 fresh-collection fixture를 사용한 provisional UI acceptance다.
  실제 통합 store와 worker acceptance는 Stage 228에서 수행한다.

대상 사업자 기능:
- 시작 안내
- 업체 검색과 내 숙소 수집 요청
- 진행률·예상시간·취소·새로고침 후 복구
- 신규 검색 이력·run 조회
- 관심 숙소
- 입지카드 제작 요청

대상 관리자 기능:
- 운영 홈 기본 상태
- 업체 DB shell과 상세 panel
- 수집 계획·실행·진행·취소
- 관광 수집 요청
- traffic/connector 설정 상태
- role-safe empty/loading/error/partial-data 화면

필수 구현:
- 화면은 V3 PageHeader→metrics→data section 구조를 따른다.
- 기존 V2 API shape와 계산 계약을 compatibility client로 유지한다.
- 신규 통합 API가 필요하면 additive route 또는 subresource로 만든다.
- 신규 이력과 관심 데이터는 새 통합 store만 사용한다.
- 통합 store가 비어 있으면 과거 값을 표시하지 않고 수집 전 상태를 안내한다.
- 작업 상태는 멱등 clientRequestId로 복구 가능해야 한다.
- 기존 /admin, /b2b deep link를 새 route로 안전하게 연결한다.
- 기능 flag off에서는 legacy UI와 API 동작이 동일해야 한다.

금지:
- 기존 V2·Cluster runtime 데이터 읽기
- raw output 경로 노출
- 새 계산식으로 V2 결과 의미 변경
- map, forecast, 전략 기능 선행 구현
- 실제 provider 호출 또는 Stage 228 store 구현 선행

필수 테스트:
- npm test
- 합성 fixture 기반 V2 계산·표시 parity
- business/admin role route test
- 검색→진행→취소→복구 UI flow
- empty/loading/error/permission denied visual test
- 모든 대상 화면 light/dark × desktop/mobile
- legacy/new UI flag 전환 test
- git diff --check

종료 조건:
- 신규 계정과 빈 통합 store에서 전체 핵심 여정이 깨지지 않는다.
- 합성 신규 수집 결과를 두 UI가 같은 업무 값으로 표시한다.
- Stage 228은 수행하지 않는다.
~~~

## Prompt 05 — Stage 228 빈 store·신규 업체·관측·신뢰도

~~~text
Stage 228을 실제로 구현하라. Stage 227 UI parity와 legacy rollback이 검증되어야 한다.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

목표:
- 빈 통합 store와 계층형 데이터 경계를 만든다.
- 통합 수집기로 업체 1개를 처음부터 새로 수집해 V3형 업체 상세에 표시한다.
- companyId, 관측, 검수값, 신뢰도와 변경 이력을 구현한다.

필수 구조:
- 명시적 V2_INTEGRATION_DATA_DIR 또는 동등한 새 경로를 요구한다.
- 운영 모드에서 새 경로가 없거나 legacy data path와 같으면 fail closed한다.
- Raw, Observation, Verified, Derived, Business-safe 계층을 분리한다.
- repository 밖에서 파일 경로를 직접 읽지 않는다.
- schema version, atomic write, lock, append/chunk, audit와 snapshot rollback을 구현한다.

필수 기능:
- 수집 target seed와 company discovery
- V2 규칙 기반 companyId 발급·외부 source identity·중복 후보
- 기존 호환 ID를 쓸 경우 최소 identity link만 저장하고 상세값은 신규 수집
- quick/detail/OTA 표준 observation
- source, runId, observedAt, targetDate, channel, productKey와 provenance
- 동일 요청 멱등성, retry, lease, cancel과 resume
- verified profile, 수동 승인·반려, 변경 전후 audit
- data completeness, freshness, confidence와 보강 CTA
- 동일 company/product/targetDate 반복 관측 보존

개발 중 외부 호출:
- 기본은 합성 provider와 example.invalid fixture다.
- 실제 provider credential이나 비용이 필요하면 호출 직전에 사용자 승인을 요청한다.

필수 검증:
- npm test
- fresh bootstrap과 빈 schema test
- legacy V2·Cluster data path read/copy 0건 검사
- 신규 업체 1개 quick→detail→OTA vertical slice
- companyId 충돌·중복 0건
- 10,000건 관측 멱등·append 성능
- worker retry/cancel/resume
- verified 변경 audit와 rollback
- 관리자/사업자 business-safe 경계
- 업체 상세 네 조건 visual QA
- git diff --check

종료 조건:
- 신규 수집 provenance 100%
- 기존 데이터 read/copy 0건
- companyId 충돌 0건
- source store hash가 아니라 새 store snapshot만 생성
- Stage 229는 수행하지 않는다.
~~~

## Prompt 06 — Stage 229 입지·예측·월간 리포트

~~~text
Stage 229를 실제로 구현하라. Stage 228 신규 수집 store와 관측 계약이 안정적이어야 한다.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

목표:
- 새로 수집한 관광·신호·OTA·리드타임 관측만 사용해 입지카드, 비교군,
  다음달 예측과 월간 리포트를 만든다.
- 표본이 부족할 때 값을 꾸며내지 않고 데이터 부족 상태를 반환한다.
- 관광·신호는 이 단계에서 contract와 deterministic fixture adapter로 제공한다.
  실제 provider 연결·scheduler·quota 운영은 Stage 231에 남긴다.

필수 구현:
- 입지카드 요청→초안→수정→검수→공개 생명주기
- 관광·검색량·트렌드·SNS signal contract와 deterministic fixture adapter
- evidence snapshot과 algorithm version
- 관광·산업·생활권·접근성·관심도·OTA·리드타임 지역 구조 점수
- 지역·업종·규모·가격대·OTA 수준 기반 cohort snapshot
- 다음달 수요 forecast, 입력 기간, 표본 수, 기준일, 신뢰구간과 부족 사유
- 전국·지역·내 숙소·익명 비교군의 4범위 business-safe monthly report
- 원천 키, 내부 수식, 다른 업체 ID, 파일 경로와 오류 제거
- confidence 원인과 다음 수집 CTA
- 관리자 draft/review/publish와 사업자 published-only API

Cold-start 규칙:
- 최소 반복 관측 전 forecast와 booking pace를 ready로 표시하지 않는다.
- 수집 중, 데이터 부족, 미수집과 미노출을 구분한다.
- 기존 V2·Cluster 값으로 결측을 채우지 않는다.
- 실제 external provider나 credential을 사용하지 않는다.

필수 테스트:
- npm test
- 알고리즘 고정 fixture와 version test
- 결측·최소 표본·신뢰구간 test
- backtest는 합성 또는 신규 수집 snapshot만 사용
- tenant와 business-safe projection test
- card lifecycle과 audit rollback
- report→location navigation
- 관리자/사업자 light/dark × desktop/mobile screenshot
- git diff --check

종료 조건:
- 최소 표본 전에는 데이터 부족, 충족 후에만 결과가 공개된다.
- 관리자와 사업자 데이터 노출 경계가 통과한다.
- Stage 230은 수행하지 않는다.
~~~

## Prompt 07 — Stage 230 전략·실행계획·KPI·회고

~~~text
Stage 230을 실제로 구현하라. Stage 229의 published report와 confidence 계약이 필요하다.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

목표:
- 새 월간 리포트에서 전략 추천→실행계획→KPI→회고→다음달 후보 흐름을 완성한다.

필수 구현:
- 가격·채널·상품·콘텐츠·리드타임 deterministic 전략 rule
- rule version, 근거 지표, confidence, 난이도, 기대 효과와 실행 시점
- 체크리스트와 추적 KPI가 있는 전략 카드
- 담당자·목표일·상태·메모가 있는 monthly action plan/item
- 상태·담당자·목표일 filter, 지연·이번 주 운영보드
- KPI 목표값·현재값·입력 여부와 변경 audit
- 실행률·KPI 달성률·미완료 원인과 월간 회고
- 이월·반복·신규 다음달 후보
- 추천→후보→계획의 source lineage, 적용자, 시각과 중복 결과
- tenant ownership과 entitlement 제한

금지:
- 자동 추천 가중치 학습
- A/B 자동 승자 결정
- calibration, 자동승인, 재귀 재검수
- 표본 부족 리포트에서 전략 생성

필수 테스트:
- npm test
- deterministic rule fixture와 version 비교
- 계획 CRUD, checklist, KPI와 audit
- retrospective와 다음달 후보 멱등성
- lineage 누락 0건
- tenant/entitlement 경계
- report→strategy→execution→retrospective end-to-end
- 모든 대상 화면 네 조건 visual QA
- git diff --check

종료 조건:
- 신규 수집 근거에서 실행 가능한 월간 흐름이 완성된다.
- 중복 후보와 권한 우회가 0건이다.
- Stage 231은 수행하지 않는다.
~~~

## Prompt 08 — Stage 231 지도·순위·신호·Connector

~~~text
Stage 231을 실제로 구현하라. Stage 224 수집 예산과 Stage 228 관측 계약을 준수한다.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

목표:
- 신규 수집 데이터로 전국/사업자 지도, 업체 순위, 30일 시계열과 관심도 신호를 제공한다.
- connector를 mock/real 경계, quota 보호, 재시도와 수동 중단이 있는 운영 기능으로 만든다.

필수 구현:
- Stage 229에서 확정한 관광·검색량·trend·SNS signal 계약과 deterministic fixture adapter를
  그대로 확장한다. 같은 개념의 두 번째 signal 계약이나 별도 fixture 체계를 만들지 않는다.
- 승인된 행정경계·GeoJSON과 신규 업체 좌표의 출처·버전·license 기록
- 전국 지도, 내 숙소 지도, marker, cluster, layer와 filter
- 좌표 confidence와 관리자 검수
- 동일 조건 기반 업체·플랫폼 순위
- 가격·재고·예약률·OTA·booking pace 30일 시계열과 7일 날짜 축
- 미수집, 미노출, 범위 밖을 서로 다르게 표시
- 관심도 signal job lifecycle과 검색량·trend·SNS 표준화
- connector adapter의 mock/real mode
- 429, 인증, quota, 빈 결과, schema 오류와 timeout 분류
- scheduler, daily limit, retry/backoff, resume, audit와 kill switch
- provider별 freshness·coverage·성공률 운영 화면

외부 호출 승인:
- credential, 비용 또는 실제 API 트래픽이 필요하면 mock/fixture 구현과 테스트를 먼저 끝낸다.
- 실제 호출 직전에 provider, 요청 수, 비용, quota와 target을 제시하고 사용자 승인을 기다린다.
- 승인 없이 Cluster secret을 복사하거나 browser에 키를 저장하지 않는다.

필수 테스트:
- npm test
- map source/license/coordinate boundary
- ranking 계산 parity와 동일 조건 보장
- 30일 mobile overflow와 7일 축
- connector 오류 분류·retry·quota·kill switch
- scheduler 중복 실행 0건
- legacy data read 0건
- 지도·순위·신호 화면 네 조건 visual QA
- 성능 benchmark와 git diff --check

종료 조건:
- 미수집/미노출이 정확히 구분된다.
- quota를 넘는 자동 호출이 없다.
- 실제 외부 호출은 승인 증적이 있는 경우에만 수행된다.
- Stage 232는 수행하지 않는다.
~~~

## Prompt 09 — Stage 232 관리자 상용 운영

~~~text
Stage 232를 실제로 구현하라. Stage 231 connector와 신규 store가 안정적이어야 한다.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

목표:
- 안전한 import/export, 통합 store 백업·복구, 운영 경고, smoke와 Go/No-Go를 완성한다.

필수 구현:
- 관리자 전용 CSV/XLSX dry-run, column mapping, 거부 사유 preview
- 파일 size, MIME, row/column, formula, zip bomb와 timeout 제한
- import는 신규 사용자 업로드용이며 V2·Cluster 데이터 migration에 사용하지 않는다.
- import는 자동 company merge나 overwrite를 하지 않고 검수 후보를 만든다.
- 유지보수되는 parser로 교체하되 V2 import 계약 parity를 먼저 검증한다.
- business-safe PDF/CSV export와 entitlement·월 한도
- export job, 서명된 다운로드, 만료와 audit
- 새 통합 store·설정·산식 버전만 대상으로 backup 생성·검증·목록
- 격리 환경 restore rehearsal과 무결성·schema version 검사
- API health, queue, freshness, export, auth, backup의 bounded 운영 경고
- 상태 open/in_progress/resolved/accepted_risk와 담당자·목표일·메모
- 배포 smoke와 수동 Go/No-Go evidence

금지:
- raw output download
- 기존 V2·Cluster 파일 import를 통한 이관
- 경고에서 자동승인·자동 정책 조정·재귀 SLA 생성
- 실제 운영 restore

필수 테스트:
- npm test
- 악성 upload, formula, MIME, size, timeout test
- import dry-run→검수 후보→수동 적용
- tenant/entitlement export와 서명 만료
- backup integrity와 격리 restore rehearsal
- 경고 중복 생성 0건과 audit
- release readiness smoke
- 관리자 화면 네 조건 visual QA
- git diff --check

종료 조건:
- 입력·출력·backup이 권한과 audit 경계를 통과한다.
- 운영 경고는 한 단계 수동 queue로 종료한다.
- Stage 233은 수행하지 않는다.
~~~

## Prompt 10 — Stage 233 통합 RC와 Staging 신규 수집 Rehearsal

~~~text
Stage 233을 준비하고 실행하라. 먼저 Stage 224~232의 종료 증적과 blocker 0을 확인한다.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

중요 승인 규칙:
- 로컬 RC, staging manifest, migration 없는 empty-store bootstrap, 수집 target과
  rollback 계획을 먼저 완성한다.
- 실제 staging 서비스·DB·disk·환경변수 변경 또는 외부 수집을 실행하기 직전에
  변경 대상, 비용, 요청량과 rollback을 사용자에게 제시하고 명시적 승인을 기다린다.
- 승인 전에는 staging을 변경하지 않는다.

목표:
- 빈 staging 통합 store에서 신규 계정과 신규 수집을 처음부터 재현한다.
- 전체 기능, 보안, 성능, 시각 QA와 rollback을 release candidate 수준으로 검증한다.

승인 전 필수 준비:
- exact RC commit과 changed file manifest
- staging 전용 service/data path와 legacy path 비연결 증명
- staging manifest, 환경변수 이름, 실행 명령과 연결 대상에서 production service·DB·disk
  식별자와 credential 참조가 0건임을 자동 검사하고 결과를 증적으로 남긴다.
- 새 secret 목록과 Cluster secret 비복사 증명
- 작은 pilot 지역·업종 target set
- provider별 요청량·quota·비용·예상 시간
- backup, worker kill switch, flag-off와 legacy UI rollback 절차
- 테스트·시각 QA·성능 실행 명령

승인 후 rehearsal:
1. 빈 schema bootstrap
2. 신규 관리자와 pilot 사업자 활성화
3. quick→detail→OTA→관광·신호 신규 수집
4. 반복 leadtime scheduler와 coverage 확인
5. 입지카드→리포트→전략→실행→회고 흐름
6. import/export, backup·격리 restore, smoke
7. feature flag off와 worker stop rollback drill

필수 gate:
- npm test와 모든 stage-specific test
- dependency/security audit
- API p95, worker throughput, duplicate request benchmark
- 최소 27화면 × light/dark × desktop/mobile = 108조건 이상 visual QA
- keyboard, contrast, overflow와 200% 확대
- tenant/IDOR/CSRF/MFA/session/upload security
- legacy data read/copy 0건
- target coverage, 성공률, 결측률, 중복률, freshness와 provenance
- 최소 표본 미달 화면은 데이터 부족
- rollback 시간과 복구 결과 기록

산출물:
- RC manifest
- staging evidence
- collection coverage report
- security/performance/visual QA 결과
- rollback rehearsal 결과
- 수동 Go/No-Go 초안

종료 조건:
- staging blocker가 0이어야 한다.
- production 변경은 하지 않는다.
- Stage 234는 수행하지 않고 production Go/No-Go 요청만 보고한다.
~~~

## Prompt 11 — Stage 234 수동 Production 전환

~~~text
Stage 234 production 전환을 준비하라. 자동 배포하지 않는다.

공통 실행 계약과 마스터 플랜을 먼저 읽는다.

최우선 규칙:
- Stage 233 staging evidence, RC commit, coverage, security, performance,
  visual QA와 rollback 증적을 재검증한다.
- 먼저 최종 Go/No-Go 보고서를 작성하고 production 변경 전에 사용자에게 명시적 GO를 요청한다.
- 사용자 GO가 없으면 준비 상태로 종료한다.

GO 요청에 포함할 내용:
- production 대상 service, branch, commit과 build
- 새 통합 data path와 기존 data path 비연결 증명
- 새 계정 bootstrap·초대 계획
- 첫 신규 수집 target과 provider별 요청량·비용·quota
- feature flag 활성화 순서
- backup과 rollback 명령
- pilot 사용자, 관찰 기간과 중단 기준
- 알려진 cold-start 화면과 최소 표본 예상

GO 승인 후 실행:
1. production 현재 상태와 backup을 확인한다.
2. 승인된 RC만 배포한다.
3. 빈 통합 store를 bootstrap하고 기존 V2·Cluster 데이터를 import하지 않는다.
4. 신규 관리자와 pilot 사업자를 활성화한다.
5. 작은 target set부터 신규 수집을 시작한다.
6. 관리자→내부 사업자→제한 pilot 순서로 feature flag를 연다.
7. 오류율, queue, duplicate, coverage, freshness, auth denial과 UI 오류를 관찰한다.
8. gate 미달 화면은 데이터 부족으로 유지한다.
9. 중단 기준 충족 시 worker stop→flag off→legacy UI 순서로 rollback한다.
10. 관찰 기간과 사용자 수동 acceptance가 끝날 때까지 legacy 앱·데이터를 읽기 전용으로 유지한다.

절대 금지:
- 승인되지 않은 production 배포
- 기존 V2·Cluster 데이터 merge/import/backfill
- 기존 disk 삭제
- blocker가 있는 상태의 전체 사용자 flag 활성화
- 자동 Go/No-Go

최종 검증:
- production health/auth/security smoke
- 신규 수집 provenance와 duplicate 0건
- companyId 충돌 0건
- tenant 경계
- 핵심 화면 네 조건 spot visual QA
- backup/rollback readiness
- 실제 commit과 승인 RC 일치

최종 보고:
- 배포 결과와 commit
- 새로 생성한 데이터만의 범위와 coverage
- 기존 데이터 무변경 증명
- 활성화한 사용자 범위
- 모니터링 결과
- 남은 cold-start 항목
- rollback 사용 여부
- 사용자의 최종 acceptance 상태

종료 조건:
- 사용자에게서 이 Stage 234 production 전환을 승인하는 명시적 GO를 받기 전에는
  production service, DB, disk, secret, 외부 provider 또는 feature flag를 변경하지 않는다.
- GO가 없으면 Go/No-Go 보고서와 승인 요청을 남기고 준비 완료 상태로 종료한다.
- GO가 있으면 승인 범위의 pilot 전환, 관찰, acceptance 또는 rollback까지 완료한 뒤 종료한다.
- 승인 범위를 넘어 전체 사용자로 자동 확대하거나 다음 단계 작업을 시작하지 않는다.
~~~

## 권장 실행 순서 요약

| 순서 | 프롬프트 | 핵심 결과 |
| --- | --- | --- |
| 1 | Stage 224 | 기능 원장·신규 수집 예산 |
| 2 | Stage 225 | V3 UI shell·theme·병행 flag |
| 3 | Stage 226 | 신규 계정·인증·보안 |
| 4 | Stage 227 | V2 핵심 기능 V3 UI parity |
| 5 | Stage 228 | 빈 store·신규 업체·관측 |
| 6 | Stage 229 | 입지·예측·월간 리포트 |
| 7 | Stage 230 | 전략·실행·KPI·회고 |
| 8 | Stage 231 | 지도·순위·신호·connector |
| 9 | Stage 232 | import/export·backup·운영 gate |
| 10 | Stage 233 | staging 신규 수집 rehearsal |
| 11 | Stage 234 | 수동 production 전환 |
