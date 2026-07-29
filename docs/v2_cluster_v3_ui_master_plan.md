# V2 + Cluster 기능 통합 및 V3 UI 전환 마스터 플랜

작성일: 2026-07-29
개정: 2026-07-29 신규 수집 원칙 반영
상태: 실행 기준
대상 제품: `glamping-datalab-v2`

이 문서는 다음 세 가지 요구를 하나의 실행 기준으로 고정한다.

1. 운영 제품, 기능 계약과 업체 식별 규칙의 정본은 V2다.
2. 클러스터 앱의 유효한 분석·SaaS·보안·운영 기능을 V2에 선별 이식한다.
3. 로그인부터 관리자·사업자 전 화면까지 V3의 UI 구조와 디자인 시스템으로 전환한다.
4. 현재 V2·Cluster에 저장된 수집 데이터는 합치거나 이관하지 않고 통합 앱에서 새로 수집한다.

이 문서와 `stage221_v2_integration_baseline.md`가 충돌하면 기능·API·식별 규칙은
Stage 221의 V2 우선 원칙을 유지한다. UI는 이 문서의 “V3 UI 전환” 결정을,
운영 데이터는 이 문서의 “기존 데이터 무이관·신규 수집” 결정을 우선한다.

## 0. 데이터 전략 개정 결정

- V2와 Cluster의 기존 company payload, 관측, run/output, 검색 이력, 관광 cache,
  신호, 리포트, 전략·실행 이력은 통합 저장소로 복사하지 않는다.
- 통합 저장소는 빈 schema로 시작하고 통합 수집 기능이 새 raw evidence와 관측을 만든다.
- 기존 원천 데이터는 계약·fixture 검증을 위한 읽기 전용 참고 자료일 뿐 운영 계산 입력이 아니다.
- 비밀번호 hash, session, token과 secret은 수집 대상이 아니며 복사하지 않는다.
  필요한 계정은 초대·활성화 또는 관리자 bootstrap으로 새로 발급한다.
- `companyId` 값은 사업 관측 데이터가 아니라 호환용 identity metadata로 취급한다.
  기존 ID를 재사용하지 않아도 V2의 발급·매칭·중복 판정 규칙은 그대로 적용한다.

## 1. 고정 기준

| 항목 | 기준 |
| --- | --- |
| 대상 저장소 | `C:\Users\USER\Documents\Codex\2026-06-09\019ea156-4303-77a3-84bf-5fbb17f63201` |
| V2 운영 브랜치 | `codex/glamping-datalab-v2` |
| 통합 브랜치 | `integration/glamping-datalab-v2-stage221` 또는 단계별 자식 브랜치 |
| V2 기준 커밋 | `4e4e1906e2967fe58df66f8ad67f832043d2763b` |
| Cluster 참조 커밋 | `57a6c561496812126e2ff2e8a61bff51099b2423` (`rc-stage219.1-20260719`) |
| V3 UI 참조 저장소 | `C:\Users\USER\Documents\lodging-datalab-v3` |
| V3 UI 참조 커밋 | `2bcdc7c0843358bb3cbb8a2025ffe873d3bf5154` |
| 운영 서비스 | `glamping-datalab-v2` |
| 기본 테마 | light |
| 선택 테마 | dark, 사용자 브라우저에 저장 |

클러스터 커밋은 기능 명세와 검증 근거일 뿐 병합 부모가 아니다. 브랜치 merge,
대형 commit cherry-pick, 서버·HTML·JS·CSS 전체 파일 교체는 하지 않는다.

## 2. 중복 기능 판정 규칙

모든 기능은 구현 전에 기능 원장에 아래 규칙으로 한 번만 판정한다.

| 상황 | 결정 |
| --- | --- |
| V2와 Cluster에 같은 기능이 있고 V2가 운영 중 | V2의 입력, 출력, API, 계산, 오류 처리 규칙이 정본이다. 실제 값은 통합 기능으로 새로 수집한다. |
| 이름은 같지만 계약이 다름 | V2 계약을 깨지 않고 additive 필드 또는 새 subresource로 Cluster 기능을 추가한다. |
| Cluster에만 존재 | V2의 `companyId` 발급·매칭 규칙, 역할과 새 통합 저장 경계에 맞게 모듈로 이식한다. |
| Cluster 보안이 V2보다 엄격함 | 로그인 동작은 V2 호환을 유지하고 MFA·CSRF·감사 같은 보안 조건은 추가한다. |
| V3에도 같은 업무 기능이 있음 | V3는 UI·상호작용·접근성의 기준만 제공한다. 업무 값과 계산은 V2 우선 규칙을 따른다. |
| 자동 병합·자동 공개·자동 정책 변경 | 운영자 승인과 rollback이 있는 수동 흐름으로 제한한다. |

중복 판정의 필수 비교 단위는 화면 이름이 아니라 다음 여섯 가지다.

- 요청 입력과 기본값
- API 경로와 응답 계약
- 데이터 식별자 규칙과 새 통합 저장 위치
- 계산식과 상태 전이
- 역할·테넌트 권한
- 실패·재시도·취소·복구 동작

## 3. 기능 범위

### 3.1 V2에서 보존할 기능·계약 정본

- V2 `companyId` 발급·매칭·중복 판정 규칙과 기존 ID 호환성
- 빠른검색, 상세검색, 리드타임 반복 관측, OTA 판정과 관광 데이터 수집 동작
- 수집 대상·preset·provider·parser·재시도·진행률·취소·run 계약
- B2B 로그인·세션·로그아웃 API, 회원 정책, 검색 한도와 허용 업체 범위 규칙
- 검색 이력, 관심 숙소, 내 숙소 수집과 입지카드 제작 요청의 사용자 흐름
- 지역 정규화·관광권 매핑 규칙과 지도·순위·가격·재고·예약률 계산식
- PWA 동작, production URL과 Render 서비스 경계

기존 company record의 상세 payload는 옮기지 않는다. 동일 업체가 신규 수집으로
다시 발견되면 기존 ID와 신뢰성 있게 매칭되는 경우에만 호환 ID를 재사용하고,
그 외에는 V2 신규 ID 발급 규칙을 적용한다. 이 identity link는 관측 데이터 이관이
아니라 deep link와 업체 소유권을 보존하기 위한 최소 metadata다.

V2 API는 기존 사용자를 위해 유지한다. 특히 `/api/login`, `/api/session`,
`/api/logout`, 회사 마스터, 수집과 B2B API는 새 UI 도입만을 이유로 삭제하거나
의미를 바꾸지 않는다. API shape과 동작은 호환하되 업무 응답 값은 새 통합 store의
신규 수집 결과에서 제공한다.

### 3.2 V2에 이식할 Cluster 기능

#### 데이터와 신뢰도

- 표준 관측 계약과 append-only 관측 projection
- 자동 관측값과 검수값의 분리, resolved profile과 변경 전후 감사
- 리드타임 booking pace, 관심도 신호, 데이터 완전도·신뢰도와 보강 CTA
- 업체 중복·충돌 검수 큐와 수동 승인·rollback

#### 입지, 예측과 리포트

- 입지카드 `요청 → 초안 → 검수 → 공개` 생명주기
- 지역 구조 점수, 비교군 snapshot, 다음달 수요 예측과 신뢰구간
- 전국·지역·내 숙소·비교군을 분리한 business-safe 월간 리포트
- 원천 키, 파일 경로, 내부 수식과 다른 업체 식별자를 제거한 공개 projection

#### 전략과 월간 운영

- 가격·채널·상품·콘텐츠·리드타임 전략 추천과 근거
- 난이도·효과·시점·체크리스트·KPI가 있는 전략 카드
- 담당자·목표일·상태·메모가 있는 실행계획과 운영보드
- KPI 추적, 월간 회고, 이월·반복·신규 다음달 후보와 lineage

#### 계정, 상품과 보안

- free/basic/pro entitlement, 기능·검색·export 한도
- 초대·활성화, 비밀번호 재설정, 관리자 MFA·복구 코드
- CSRF, Origin/Host 검사, 보안 헤더, 로그인 잠금과 인증 감사
- 이메일 전달·재시도·반송 webhook·멱등성, 보안 키 회전
- 권한형 PDF/CSV export와 export 이력

#### 외부 연동과 운영

- connector adapter, mock/real 전환, 오류·쿼터·429·빈 결과 분류
- 관심도 전용 작업 생명주기, scheduler, quota guard와 실행 감사
- 단일 운영 경고 큐, 백업·검증·격리 복구 rehearsal
- 배포 smoke, 실행 commit 검증과 수동 Go/No-Go
- 안전한 CSV/XLSX dry-run, MIME·크기·행열·수식·timeout 제한

### 3.3 별도 게이트 또는 제외

- A/B 실험과 세그먼트 학습은 기능 원장에 유지하되, 실제 동시 표본과 통계 검증
  기준을 충족한 뒤 후속 릴리스에서 활성화한다.
- 재귀 SLA, calibration, 자동승인, 자동 재검수와 자동 추천 가중치 변경은
  운영 출시 범위에서 제외한다.
- Cluster의 임시 companyId, 계정·세션·비밀번호 hash, 비밀값, 빈 제품 DB와
  32개 run 디렉터리는 V2 데이터에 복사하지 않는다.
- V2의 기존 company payload, 관측 JSONL, output/run, 검색 이력, 관광 cache,
  신호·리포트·전략 이력도 통합 저장소에 복사하거나 backfill하지 않는다.
- raw `/outputs`와 내부 connector 오류·수식을 사업자 API에 노출하지 않는다.
- Cluster의 47K 라인 서버와 단일 HTML/JS/CSS를 V2 파일에 직접 합치지 않는다.

## 4. 도메인별 결합 결정

| 도메인 | V2 우선 부분 | Cluster 추가 부분 | V3 UI 화면 |
| --- | --- | --- | --- |
| 로그인·계정 | V2 로그인 API·회원 정책·역할 규칙 | 새 계정 발급, 초대, reset, MFA, CSRF, 감사, entitlement | 로그인, 가입, 활성화, reset, 계정·요금제 |
| 수집 | V2 빠른/상세/OTA/관광 실행 규칙 | 새 관측 저장, queue 상태, scheduler, connector 진단 | 관리자 수집, 사업자 검색·관심 |
| 업체 DB | V2 companyId·매칭·수동 보정 규칙 | 신규 수집 profile, reliability, 변경 이력 | 업체 DB, 데이터 신뢰도 |
| 입지·지도 | V2 지역 정규화·요청·override 규칙 | 신규 관광·신호 기반 초안/검수/공개, 비교군, 근거 snapshot | 입지카드, 전국/내 숙소 지도 |
| 순위·예약 | V2 순위·가격·재고·예약률 계산식 | 신규 반복 관측 기반 booking pace·신뢰도·30일 projection | 업체 순위와 시계열 |
| 분석·전략 | V2 수요 계산·운영 규칙 | 신규 데이터 기반 월간 리포트, 예측, 전략, 계획, KPI, 회고 | 리포트→전략→실행→회고 |
| 입출력·운영 | V2 import/export/PWA 동작 | 입력 보안, 권한 export, 백업, 경고, release gate | 가져오기, 백업·복구, 운영 품질 |

## 5. 목표 구조

### 5.1 백엔드

V2 서버는 호환 facade로 유지하되 새 기능을 `glamping_app_server.cjs` 안에 계속
누적하지 않는다. 다음 경계로 분리한다.

```text
scripts/integration/
  contracts/       # V2 호환 계약과 Cluster-derived 계약
  repositories/    # 저장소 인터페이스와 새 통합 store adapter
  services/        # 관측, 신뢰도, 카드, 리포트, 전략, 계정, export
  http/            # 역할별 route handler와 response projection
  bootstrap/       # 빈 schema 초기화, 신규 수집 대상·검증·rollback
```

- 기존 V2 route는 facade가 기존 서비스 또는 새 모듈을 호출하도록 점진적으로 바꾼다.
- 새 모듈은 운영 파일 경로를 직접 참조하지 않고 repository만 사용한다.
- 무거운 수집·export·백업은 요청 처리와 분리해 상태·재시도·멱등 키를 갖는다.
- 모든 사업자 응답은 company ownership을 서버에서 검사한 뒤 공개 projection만 반환한다.

### 5.2 데이터

- V2 `companyId`는 유일한 canonical company key다.
- 통합 운영 store는 빈 schema로 생성하며 V2·Cluster 데이터 파일을 runtime에 연결하지 않는다.
- 통합 수집 worker가 만든 raw evidence, observation, verified/derived/public 데이터만 저장한다.
- 기존 V2 ID가 필요한 업체는 최소 identity link만 만들고 업체 상세값은 신규 수집 결과로 채운다.
- 큰 이력은 JSONL append 또는 chunk 저장을 사용하고 요청마다 전체 파일을 재작성하지 않는다.
- 모든 쓰기는 atomic replace, lock, schema version, actor, timestamp와 rollback 정보를 갖는다.
- 저장 구현은 repository 뒤에 두어 후속 PostgreSQL 전환이 API/UI를 바꾸지 않게 한다.

신규 데이터 구축 순서는 다음과 같다.

1. 빈 schema와 계정·권한·수집 정책을 초기화한다.
2. 수집 대상 지역·업종·업체 seed를 등록하고 V2 identity 규칙으로 companyId를 확정한다.
3. 빠른검색으로 업체 기본 profile과 source identity를 수집한다.
4. 상세검색·OTA로 상품·가격·재고·예약·노출 관측을 저장한다.
5. 동일 `companyId/productKey/targetDate`를 일정에 따라 반복 수집해 리드타임 series를 만든다.
6. 관광·검색량·트렌드·SNS 신호를 승인된 connector로 새로 수집한다.
7. 신뢰도·입지카드·비교군·예측·리포트·전략을 순서대로 파생한다.
8. 입력별 최소 표본과 최신성 gate를 통과한 화면만 `준비됨`으로 공개한다.

최소 표본을 채우기 전에는 과거 V2·Cluster 값으로 빈칸을 보충하지 않고 `수집 중`,
`데이터 부족` 또는 `미수집`을 명확히 표시한다.

### 5.3 프런트엔드

기존 `web/index.html`, `web/app.js`, `web/styles.css`는 rollback 가능한 legacy UI로
남겨 두고, React/Vite 기반 새 프런트엔드를 별도 빌드한다.

```text
apps/web/           # V2 API를 사용하는 React 화면과 route
packages/ui/        # V3 token과 공통 컴포넌트의 V2용 이식본
web/                # 전환 완료 전까지 legacy fallback
```

V3에서 재사용할 기준은 다음과 같다.

- `AppShell`, `PageHeader`, `StatusBadge`, `MetricCard`, `EmptyState`
- 좌측 sidebar, sticky topbar, 관리자/사업자 역할 분리 navigation
- light/dark 공통 color token, focus ring, 상태색과 공통 spacing
- 로그인 panel, 로딩·빈 상태·오류 상태와 모바일 navigation
- desktop/mobile 반응형, 긴 텍스트 줄바꿈과 가로 scroll 원칙

V3의 업무 API 호출이나 fixture는 복사하지 않는다. 새 UI는 V2 compatibility client를
통해 V2 API와 새 additive API만 사용한다.

- `AppShell`의 브랜드, 상태 문구, 홈 경로와 link renderer는 props로 분리한다.
- route와 navigation은 하나의 registry에서 생성해 화면·서버 메뉴 불일치를 막는다.
- fetch, CSRF, 오류 변환과 세션 만료 처리는 공통 API client 한 곳에만 구현한다.
- V3의 전역 CSS는 CSS layer 또는 V2 새 UI root로 scope해 legacy 화면과 충돌하지 않게 한다.
- PWA 앱명, start URL, cache key와 사용자 cache 폐기는 V2 기준으로 다시 정의한다.
- V3의 3,681행 `App.tsx`와 7,123행 `app.css`는 통째로 복사하지 않는다.

## 6. V3 UI 세부 요구사항

### 6.1 인증 전 화면

- `/login`: V3 panel 형태를 사용하되 V2 호환을 위해 입력은 `아이디 또는 이메일`로 받는다.
- `/signup`: V2 회원가입 정책과 중복 확인을 유지하고 V3 form·오류·완료 상태를 사용한다.
- `/activate`, `/reset-password`, 관리자 MFA 등록·확인을 같은 auth shell로 통일한다.
- `/terms`, `/privacy`, 탈퇴 요청도 같은 token과 typography를 사용한다.
- JS 실패 시 기존 로그인 또는 안전한 서버 응답으로 돌아갈 수 있어야 한다.
- 세션 조회가 실패하면 인증 불필요로 간주하지 않고 로그인 또는 재시도 상태로 닫는다.

### 6.2 로그인 후 정보구조

사업자 navigation:

1. 시작 안내
2. 검색·관심
3. 리포트
4. 입지카드
5. 지역 지도
6. 업체 순위
7. 전략 추천
8. 실행계획
9. 월간 회고

관리자 navigation:

1. 운영 홈
2. 업체 DB
3. 수집
4. 입지카드
5. 전국 지도
6. 업체 순위
7. 데이터 신뢰도
8. 데이터 가져오기
9. 백업·복구
10. 운영 품질
11. 계정·요금제
12. 단계 검토
13. 설정

기존 `/admin`, `/b2b`, `/view` deep link는 전환 기간에 redirect 또는 compatibility
route로 유지한다. 사업자가 관리자 route나 다른 companyId를 요청하면 UI 숨김이
아니라 서버에서 `403`으로 차단한다.

### 6.3 테마와 접근성

- 첫 방문은 light, 사용자가 선택하면 dark를 `lodging-v2-theme`에 저장한다.
- 첫 paint 전에 `data-theme`을 적용해 화면 깜박임을 방지한다.
- 색상은 V3 공통 token만 사용하고 화면별 light/dark 색상 하드코딩을 금지한다.
- 모든 핵심 화면을 light/dark × desktop/mobile 네 조건으로 screenshot 검증한다.
- WCAG AA 대비, keyboard focus, label, 오류 announce, 320px 폭, 숫자·가격·날짜
  잘림과 200% 확대를 검증한다.

## 7. 단계별 실행 계획

현재 Stage 221 기준선과 Stage 222 계약 동결, Stage 223 읽기 전용 preview 자산은
새 계획의 선행 작업으로 재검증한다. 작업 트리가 깨끗하지 않으므로 기존 변경을
분리 검토·테스트한 뒤 다음 단계로 진행한다. Stage 223 preview는 계약 검증에만
사용한다. 기존 파일을 읽는 preview 구현은 신규 수집 fixture 기반으로 재작성하거나
제거하며 통합 runtime의 데이터 입력이나 migration 경로로 승격하지 않는다.

| 단계 | 범위 | 핵심 산출물 | 종료 조건 | 예상 |
| --- | --- | --- | --- | --- |
| 224 | 요구·기능 원장 동결 | V3 조사치 V2 45개/Cluster 214개 API·화면과 Stage 221 literal 추출치 43개/228개의 차이 및 동적 route를 정규화한 keep/port/defer/exclude 원장; 전체 신규 수집 대상·쿼터·비용·소요시간 예산; package·README·서비스 명칭 정합화; 본 계획과 Stage 221 충돌 해소 | 모든 Cluster 기능에 owner·우선순위·테스트·출시 단계가 있고 두 인벤토리 차이와 수집 예산이 설명됨 | 2~3일 |
| 225 | V3 UI 기반과 병행 운영 | React/Vite, UI package, theme boot, auth shell, AppShell, legacy/new UI flag | 로그인 shell과 빈 관리자/사업자 shell이 4조건 QA 통과; flag off 시 V2 무변경 | 1~2주 |
| 226 | 인증·계정·보안 | V2 login/session 호환 API, 신규 가입·초대·reset·MFA·CSRF·감사·요금제; fallback credential 제거; hash된 durable session과 키 회전 | 신규 발급 계정에서 V2 로그인 UX/API 계약 100%; tenant·MFA·CSRF 회귀 통과; 기존 hash/session 자동 복사 없음 | 2주 |
| 227 | V2 핵심 기능 UI parity | 수집, 검색, 진행·취소·복구, 신규 이력·관심, 업체 DB, 관광·설정의 V3 화면 | 빈 상태와 신규 수집 결과에서 V2 사용자 여정·계산 parity; legacy UI 즉시 복귀 가능 | 2주 |
| 228 | 신규 업체·관측·신뢰도 | 빈 store bootstrap, company discovery, identity link, quick/detail/OTA observation, verified profile, 변경 이력·보강 큐 | 기존 data file read 0건; 신규 수집 provenance 100%; companyId 충돌 0건; 반복 관측·수동 검수 rollback 통과 | 2주 + 표본 수집 |
| 229 | 입지·예측·월간 리포트 | 신규 관광·신호와 반복 관측 기반 카드 생명주기, cohort, forecast, 4범위 report, business-safe API | 최소 표본 전 `데이터 부족`; 충족 후 신뢰구간·비식별·권한 테스트와 고정 fixture backtest 통과 | 2주 + 관측 기간 |
| 230 | 전략·실행·회고 | 전략 카드, 계획·체크리스트·KPI, 운영보드, 회고·다음달 후보 | 추천 근거와 lineage 보존; tenant 격리; 중복 후보 멱등성 통과 | 1~2주 |
| 231 | 지도·순위·신호·connector | 전국/사업자 지도, 순위·30일 시계열, interest job, scheduler, provider 오류 분류 | V2 계산 parity, 미수집/미노출 구분, 쿼터·재시도·수동 중단 검증 | 2주 |
| 232 | 관리자 상용 운영 | 안전한 import/export, 백업·복구, 운영 경고, smoke·Go/No-Go | dry-run, 수식 차단, entitlement, 격리 복구와 감사 증적 통과 | 2주 |
| 233 | 통합 RC와 staging 신규 수집 rehearsal | 전체 회귀, 성능·보안·시각 QA, 빈 store 초기화, 전체 신규 수집과 coverage·rollback 검증 | 기존 데이터 복사 0건, 수집 coverage gate 통과, blocker 0, 모든 route 4조건 QA, 복구 시간 검증 | 1~2주 + 수집 기간 |
| 234 | 수동 production 전환 | 새 통합 store bootstrap, 신규 수집 시작, pilot 확대, legacy UI 유지, 관찰과 승인 | 사용자 수동 GO, 필수 수집 coverage 충족, 권한·ID·관측 중복 오류 없음, rollback window 종료 | 2~3일 + 관찰·수집 기간 |

Stage 227의 신규 결과 parity는 합성 fresh-collection fixture를 사용한 provisional gate다.
실제 새 store와 worker를 사용한 data-backed acceptance는 Stage 228에서 완료한다.
Stage 229는 관광·신호 connector 계약과 fixture adapter로 분석 기능을 완성하고,
실제 provider 연결·scheduler·quota 운영은 Stage 231에서 활성화한다.

2명 개발자와 QA 지원 기준 기능 개발은 약 15~18주다. 기존 데이터 migration은
일정에서 제거되지만 리드타임·30일 시계열·예측은 신규 반복 관측이 쌓이는 실제
시간이 추가로 필요하다. 외부 connector 승인, 표본 coverage 또는 인증 정책 결정이
지연되면 Stage 228~234의 공개 시점만 별도 조정한다.

## 8. 테스트와 품질 게이트

### 8.1 V2 무회귀

- Stage 222 snapshot으로 V2 주요 API의 status, shape, role과 오류 계약을 고정한다.
- V2 수집·순위·가격·재고·예약률 계산 계약은 합성 golden fixture로 전후 비교한다.
- legacy UI와 새 UI가 같은 API에서 같은 업무 값을 표시하는 parity test를 둔다.
- 통합 runtime이 기존 V2·Cluster data path를 읽거나 복사하면 테스트를 실패시킨다.
- 동일 업체 identity가 확인되면 기존 호환 companyId를 유지하고, 충돌·중복 ID는 0건이어야 한다.

### 8.2 Cluster 기능 검증

- 원천 기능마다 unit, repository, API, role/tenant, fresh-bootstrap/collection test 중 필요한 항목을 지정한다.
- 리포트·예측·추천은 고정 fixture, 계산 버전, 결측 처리와 backtest를 갖는다.
- 동일 요청·worker 재실행·network retry에서 중복 쓰기가 없어야 한다.
- 관리자 수정·공개·병합은 변경 전후 감사와 rollback이 있어야 한다.

### 8.3 UI 검증

- 로그인·가입·활성화·reset과 모든 관리자·사업자 route를 Playwright로 검증한다.
- 각 route는 light/dark × desktop/mobile screenshot을 보유한다.
- loading, empty, error, partial-data, permission-denied 상태를 별도로 검증한다.
- keyboard-only, focus order, form label/error, contrast와 mobile overflow를 검사한다.
- V3 UI reference와의 시각 차이는 업무상 필요한 V2 문구·필드 차이만 허용한다.
- V3의 27화면·108조건 증적을 하한으로 삼고, V2 고유 route가 더 많으면 조건을 추가한다.

### 8.4 성능·보안

- 새 UI 초기 bundle과 route chunk 예산은 Stage 225에서 현재 V3와 V2 실측 후 고정한다.
- 모바일 핵심 화면은 일반 네트워크 조건에서 3초 이내 표시를 목표로 한다.
- 일반 조회 p95, 수집 처리량과 외부 중복 요청은 V2 기준보다 악화되면 출시를 막는다.
- tenant escape, IDOR, CSRF, session fixation, brute force, upload formula와 path traversal을
  필수 보안 회귀로 둔다.

## 9. 배포·신규 수집·rollback

모든 도메인은 독립 feature flag를 갖고 기본값은 `false`다.

1. 로컬에서는 합성 fixture로 계약·산식·오류 처리를 검증한다.
2. staging에 빈 통합 schema를 만들고 기존 V2·Cluster data path가 연결되지 않았음을 검사한다.
3. 관리자와 pilot 사업자 계정을 새 bootstrap·초대 흐름으로 발급한다.
4. 작은 지역·업종 target set으로 빠른검색→상세→OTA→관광·신호를 끝까지 새로 수집한다.
5. 반복 관측 scheduler를 실행하고 coverage·freshness·실패 원인 dashboard를 확인한다.
6. 입력 gate를 통과한 화면만 관리자, 내부 사업자, 제한 pilot 순서로 활성화한다.
7. production도 빈 통합 store에서 시작해 동일한 신규 수집 절차를 실행한다.
8. 관찰 기간에는 기존 V2 앱·데이터와 legacy UI를 읽기 전용 rollback 수단으로 유지한다.

신규 수집 공개 gate는 다음을 모두 요구한다.

- target set의 업체가 충돌 없는 canonical companyId를 가진다.
- 필수 collection mode별 성공·실패·미수집 상태와 raw evidence가 추적된다.
- 대상 업체 coverage, 원천별 성공률, 결측률, 중복률과 출처 추적률이 Stage 224에서
  승인한 기준을 충족한다.
- 관광·신호·OTA는 source, collectedAt, runId와 freshness를 가진다.
- 리드타임·30일 시계열·예측은 알고리즘별 최소 반복 표본을 충족한다.
- 표본 미달 화면은 값 대신 `수집 중` 또는 `데이터 부족`을 반환한다.
- 통합 runtime에서 기존 V2·Cluster data read/copy 건수가 0이다.

rollback은 기능 flag off → 새 worker 일시중지 → legacy UI 복귀 순서로 수행한다.
새 통합 store의 신규 수집 데이터는 삭제하지 않고 격리·보존해 원인을 분석한 뒤 멱등하게
재개한다. rollback 중에도 기존 V2·Cluster 데이터에 쓰거나 두 원천 데이터를 합치지 않는다.

## 10. 단계 공통 Definition of Done

- 기능 원장에 source, 중복 판정, V2 우선 근거, 구현 파일과 테스트가 연결돼 있다.
- 기존 V2 API 의미, companyId 규칙과 사용자 여정에 승인되지 않은 변화가 없다.
- 기존 V2·Cluster 운영 데이터는 수정·복사·backfill되지 않고 통합 store에는 신규 수집값만 있다.
- 관리자·사업자·worker 권한과 company ownership 검사가 서버에서 통과한다.
- 데이터 쓰기는 schema version, audit, backup과 rollback 경로를 가진다.
- 영향을 받는 모든 화면의 light/dark × desktop/mobile 검증이 통과한다.
- 새 코드가 V2 monolith에 무제한 누적되지 않고 domain boundary를 지킨다.
- 테스트·성능·보안 blocker가 0이고 feature flag off 경로가 검증됐다.
- 배포 commit, 변경 파일, 데이터 영향, 검증 결과와 rollback 명령이 기록됐다.

## 11. 주요 위험과 대응

| 위험 | 대응 |
| --- | --- |
| 635KB 서버와 1.4MB JS, 774KB CSS에 기능이 결합됨 | 새 도메인 모듈과 React UI를 별도 경계로 만들고 facade로 연결 |
| 두 인증 모델 충돌 | V2 login/session compatibility를 먼저 고정하고 명시적 account link만 허용 |
| fallback credential와 메모리 세션 | 환경 필수화, 안전한 초기 관리자 흐름, hash된 durable session과 강제 폐기 구현 |
| 파일 DB 동시성·전체 재작성 | repository, append/chunk, atomic write, lock, worker 분리 |
| 같은 이름의 계산 결과 불일치 | 합성 V2 golden fixture의 계산 계약을 우선하고 Cluster 값은 derived field로 분리 |
| UI 일괄 교체 회귀 | legacy/new UI flag, route별 parity, pilot 순차 전환 |
| 외부 API·쿼터·약관 | provider adapter와 quota guard, 승인된 credential만 staging에서 연결 |
| 취약한 `xlsx` 의존성 | parity·dry-run test 후 유지보수 parser로 교체, 같은 단계에서 무리한 제거 금지 |
| Cluster 재귀 자동화의 운영 복잡도 | bounded 수동 경고와 승인 흐름만 출시 |
| package명·README·서비스명이 서로 다름 | Stage 224에서 canonical 이름을 고정하고 배포·로그·문서를 같은 값으로 검증 |
| V3 최신 CSS의 브라우저 기능 의존 | 지원 브라우저를 고정하고 `color-mix`, `backdrop-filter` fallback을 시각 QA에 포함 |
| 신규 데이터의 cold start | coverage·freshness gate를 두고 표본 전에는 `수집 중/데이터 부족`으로 공개 제한 |
| 리드타임·예측의 실제 시간 필요 | 기능 완료와 데이터 준비 완료를 분리하고 반복 관측 기간을 출시 일정에 반영 |
| 신규 수집 업체의 ID 오매칭 | V2 identity 규칙, 근거 점수, 수동 승인과 merge rollback을 적용 |

## 12. 즉시 착수 순서

1. 현재 worktree의 Stage 222·223 변경을 별도 검토하고 전체 테스트를 재실행한다.
2. Stage 224에서 동적 route를 포함한 V2/Cluster 전체 기능 원장을 생성한다.
3. Stage 221의 데이터 이관·projection 문구를 “빈 store·신규 수집” 결정으로 표시한다.
4. 본 문서와 상충하는 기존 “V2 UI 유지” 문구를 V3 UI 전환 결정으로 표시한다.
5. Stage 225 자식 브랜치에서 V3 token·auth shell·AppShell과 UI feature flag부터 만든다.
6. 새 UI가 V2 `/api/login`·`/api/session` 계약으로 신규 발급 계정에 로그인하는 vertical slice를
   첫 시연 단위로 완료한다.
7. 두 번째 vertical slice로 빈 store에서 업체 1개를 신규 수집해 V3형 업체 상세에 표시한다.

첫 번째 승인 화면은 `V3형 로그인 → 역할 판정 → V3형 관리자/사업자 빈 shell →
light/dark 전환 → 로그아웃 → legacy UI 복귀` 흐름이다.
