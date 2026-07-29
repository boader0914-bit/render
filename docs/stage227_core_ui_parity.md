# Stage 227 V2 핵심 기능 V3 UI parity

작성일: 2026-07-29
기준 V2 commit: `4e4e1906e2967fe58df66f8ad67f832043d2763b`
상태: 구현 완료, 최종 종료 증적은 `docs/stage227_completion_evidence.json` 참조

## 1. 선행 조건

Stage 226 종료 증적 `docs/stage226_completion_evidence.json`을 확인했고 다음 gate가
모두 `pass`인 상태에서 시작했다.

- 신규 auth/account/security test
- MFA, CSRF, Origin/Host, tenant와 IDOR 회귀
- UI build와 flag-off legacy 회귀
- 인증 화면 light/dark × desktop/mobile 시각 QA
- security blocker 0

기존 Stage 222~226 미커밋 변경은 사용자 자산으로 보존했다. commit, branch switch,
reset, staging/production 배포는 수행하지 않았다.

## 2. 구현 경계

| 항목 | Stage 227 계약 |
| --- | --- |
| 기능 flag | `V2_INTEGRATION_PLATFORM_CORE_ENABLED`, 기본 `false` |
| 의존성 | `V2_INTEGRATION_AUTH_ENABLED`; core만 켜면 listen 전 fail closed |
| UI flag | 기존 `V2_UI_V3_ENABLED`, 기본 `false` |
| store | `stage227-provisional-memory`, 기본 빈 상태 |
| populated acceptance | `NODE_ENV=test`와 명시적 fixture mode에서만 허용한 합성 fresh-collection fixture |
| 실제 provider | 호출 0건 |
| 기존 runtime 데이터 | V2·Cluster file, DB, cache, output read/write/copy 0건 |
| durable store/worker | 구현하지 않음; Stage 228 범위 |
| 복구 범위 | 탭 새로고침 후 동일 server process의 `clientRequestId` 조회 |
| process 재시작 복구 | 지원하지 않음; Stage 228 범위로 명시 |

core가 켜지면 기존 `seedOutputsFromRepo()`를 실행하지 않는다. core production 모듈은
legacy output, customer DB, company master, search history, interest, location-card file,
tourism collector와 crawler를 import하거나 호출하지 않는다.

합성 fixture는 `test/fixtures/stage227` 아래 JSON만 읽을 수 있고 다음 검사를 모두
통과해야 한다.

- `synthetic: true`, `source: synthetic-fresh-collection`
- `syn_` company ID namespace
- URL host는 `*.invalid`
- 운영 경로와 legacy data identifier 없음
- production 또는 fixture flag 미설정 시 load 결과 `null`

## 3. additive API

모든 mutation은 Stage 226 session, Host/Origin와 CSRF 검사를 재사용한다. 사업자의
`tenantCompanyId`는 server에서 membership과 대조하며 다른 업체는 `403`이다.

| method | path | 역할 | 동작 |
| --- | --- | --- | --- |
| GET | `/api/integration/core/workspace` | business/admin | 역할별 empty/ready/partial workspace |
| POST | `/api/integration/core/jobs` | kind별 business/admin | 멱등 수집 요청 생성 |
| GET | `/api/integration/core/jobs/:clientRequestId` | 요청 소유자 | 진행률·ETA·상태 복구 |
| POST | `/api/integration/core/jobs/:clientRequestId/cancel` | 요청 소유자 | 멱등 취소 |
| POST | `/api/integration/core/interests` | business | fresh 업체 관심 등록 |
| DELETE | `/api/integration/core/interests/:companyId` | business | 관심 해제 |
| POST | `/api/integration/core/location-card-requests` | business | fresh 업체 입지카드 요청 |
| POST | `/api/integration/core/admin/tourism-requests` | admin | provider를 호출하지 않는 provisional 관광 요청 |

`clientRequestId`와 정규화된 V2 입력 signature가 같으면 기존 작업을 반환한다. 같은
ID로 다른 입력을 보내면 `409`다. 공개 응답에는 actor ID, request signature, token,
secret, raw path와 output 경로가 없다.

## 4. V2 우선 compatibility

`scripts/integration/contracts/core_ui.cjs`는 기존 V2의 다음 의미를 그대로 투영한다.
새 계산식은 추가하지 않았다.

- collection mode: `fast`, `precision`, 기본 `precision`
- product mode: `all`, `lodging`, `campnic`
- detail rank range 기본값: 일반 `1-10`, 내 숙소 `1-5`
- result summary: `exposureSampleCount`, `companyCount`, `revenueSampleCount`,
  `averageRevenue`, `soldOutRate`
- search history 공개 key와 빈 값 기본값

`apps/web/src/core/coreClient.ts`는 transport field를 화면 view model로 이름만
정규화한다. 순위, 가격, 매출, 매진율, review 수, progress와 ETA는 server가 준 값을
문자열로 표시하며 브라우저에서 재계산하지 않는다. 합성 fixture의 V2 summary와
compatibility projection을 deep equality로 검증한다.

## 5. V3형 대상 화면

모든 대상 화면은 `PageHeader → metrics → data section` 순서를 사용한다. 기존 9개
사업자·13개 관리자 navigation registry와 `/admin`, `/b2b`, `/view` compatibility
경로는 유지한다.

| 역할 | route | Stage 227 기능 |
| --- | --- | --- |
| business | `/app/onboarding` | 시작 안내, 신규 수집 순서와 경계 |
| business | `/app/activity` | 업체 검색, 내 숙소 수집, 진행·ETA·취소·복구, 신규 이력·관심 |
| business | `/app/location` | fresh 업체 입지카드 제작 요청과 신규 요청 이력 |
| admin | `/admin/overview` | 운영 홈, recent run과 connector 요약 |
| admin | `/admin/companies` | fresh 업체 DB shell과 master/detail panel |
| admin | `/admin/collection` | 수집 계획·실행·진행·취소와 관광 요청 |
| admin | `/admin/settings` | traffic/connector 공개 상태와 안전 기준 |

map, forecast, ranking 확장, 전략, 실제 connector와 provider 호출은 선행하지 않았다.
후속 route에는 임의 값 대신 범위 보류 empty state를 표시한다.

## 6. 상태·역할 안전

| 상태 | 표시 규칙 |
| --- | --- |
| loading | session과 fresh-only 경계를 확인 중이라고 표시 |
| empty | 과거 값을 대체 표시하지 않고 첫 신규 수집 CTA 표시 |
| error | fail closed; legacy 값으로 채우지 않음 |
| permission denied | UI 안내와 별도로 server `403` 강제 |
| partial | 있는 fresh 값과 누락 경고를 함께 표시 |
| unavailable | core flag가 꺼진 상태를 안전하게 안내 |

사업자 history, interest, location-card request와 job은 account/tenant별로 격리한다.
관리자 전용 tourism과 connector 응답은 사업자에게 공개하지 않는다. 브라우저 저장소에는
업무 데이터가 아니라 tab-scoped `clientRequestId`만 기록한다.

## 7. flag·RACI

| flag | owner | approver | dependsOn | 기본값 | 대상 | rollout | 관찰 지표 | rollback |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- |
| `V2_INTEGRATION_PLATFORM_CORE_ENABLED` | BE | PO | Stage 227 runtime에서 integration auth와 Stage 226 security gate 추가 | false | business, admin | 185 | read-api-p95, write-api-p95, security rejection | false, 신규 작업 drain, V2 route 보존 |
| `V2_UI_V3_ENABLED` | FE | PO | UI build와 visual gate | false | business, admin | 10 | ui-error-rate, api-p95 | false, legacy artifact와 cache 복구 |

Stage 224 원장의 platform-core flag는 `dependsOn: []`였지만 Stage 226 신규 account/session을
실제 사용하게 된 Stage 227 runtime은 더 엄격하게 auth dependency를 추가했다. flag 이름,
owner `BE`, approver `PO`, rollout order 185와 관찰 지표는 동결 원장을 유지한다. Stage 225에서
정합화한 실제 UI 환경변수 이름은 `V2_UI_V3_ENABLED`다.

| 활동 | Responsible | Accountable | Consulted | Informed |
| --- | --- | --- | --- | --- |
| Stage 227 구현 전체 | FE, BE | PO | QA, SE, DE | SRE, RM |
| V2 parity·API | BE | PO | QA, SE, DE | SRE, RM |
| V3 화면·접근성 | FE | PO | QA, SE | SRE, RM |
| fixture·legacy deny 검증 | QA | PO | BE, SE, DE | SRE, RM |

역할 이름은 모두 정의돼 있다. 실제 담당자가 배정되지 않은 환경에서는 두 flag를
`false`로 유지한다.

## 8. 검증 명령

```powershell
npm run test:core-parity
npm run test:core-server
npm run test:core-visual
npm run test:stage227
npm test
git diff --check
```

세부 시각 결과는 `test/results/stage227_visual_qa.json`, rollback 절차는
`docs/stage227_rollback_runbook.md`, 최종 판정은
`docs/stage227_completion_evidence.json`에 기록한다.
