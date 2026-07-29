# Stage 229 입지·예측·월간 리포트 계약

## 범위

Stage 229는 Stage 228 신규 통합 store의 관측과 합성 signal fixture만 사용해 다음 기능을 제공한다.

- 입지카드 요청, 초안, 검수, 공개 생명주기
- 관광·검색량·트렌드·SNS signal 계약
- 관광·산업·생활권·접근성·관심도·OTA·리드타임 지역 구조 점수
- 지역·업종·규모·가격대·OTA 수준의 비식별 cohort snapshot
- 다음 달 수요 forecast와 booking pace
- 전국, 지역, 내 숙소, 익명 비교군의 4범위 월간 리포트

전략 추천, 실행계획, KPI, 회고, 후보 자동 생성은 Stage 230 범위이며 이 단계에는 포함하지 않는다. 실제 signal provider, credential, scheduler, quota 운영은 Stage 231 범위다.

## 데이터 경계

허용 입력은 다음 두 종류뿐이다.

1. Stage 228 신규 수집 store가 기록한 fresh company, quick, detail, OTA, lead-time 관측
2. `stage229-deterministic-signal-fixture`가 반환한 명시적 합성 관광·검색량·트렌드·SNS signal

V2·Cluster의 company payload, 관광 cache, 신호, run/output, 리포트 또는 전략 이력을 읽거나 복사하지 않는다. migration, backfill, projection, dual-write를 수행하지 않으며 결측을 기존 값으로 채우지 않는다. fixture adapter의 계약은 `externalRequests=0`, `credentialReads=0`, `legacyRuntimeReads=0`, `legacyRuntimeCopies=0`, `productionMutations=0`이다.

고정 fixture는 다음 파일에 있다.

- `test/fixtures/stage229/signal_contract_v1.json`
- `test/fixtures/stage229/location_forecast_cases_v1.json`

provider ID는 `stage229-deterministic-signal-fixture`, fixture version은 `stage229-deterministic-signals-v1`, algorithm version은 `v2-stage229-location-forecast-v1`로 고정한다. 내부 durable record에는 evidence snapshot ID와 algorithm version을 보관한다. 관리자·사업자 public projection에는 snapshot ID, observation/signal ID를 노출하지 않고 입력 기간, 관측·signal 개수, algorithm/fixture version과 source boundary 요약만 제공한다.

## 기능 플래그

모든 플래그는 기본값 `false`이며 의존성이 충족되지 않으면 fail-closed 한다.

| 기능 | 환경 변수 | 의존성 |
| --- | --- | --- |
| 신뢰도 | `V2_INTEGRATION_RELIABILITY_ENABLED` | `V2_INTEGRATION_FRESH_OBSERVATION_ENABLED` |
| 입지카드 | `V2_INTEGRATION_LOCATION_CARD_ENABLED` | 신뢰도 |
| 월간 리포트 | `V2_INTEGRATION_BUSINESS_REPORT_ENABLED` | `V2_INTEGRATION_FRESH_OBSERVATION_ENABLED` |

플래그가 꺼져 있으면 additive API와 UI가 노출되지 않고 기존 V2 응답, 세션과 정적 자산을 그대로 유지한다.

## 최소 표본과 readiness

forecast와 booking pace가 `ready`가 되려면 모두 충족해야 한다.

- D14, D7, D1 관측을 모두 가진 complete stock series 최소 3개
- stock pair point 최소 9개
- 전국, 지역, 익명 비교군 각각 k-anonymity 최소 3개
- complete D14·D7·D1 lead-time 시계열의 최신 관측점과 실제 점수 계산에 사용한 OTA 최신 관측점이 각각 기준일로부터 24시간 이내
- signal 관측이 기준일로부터 168시간 이내

경계값보다 하나라도 부족하면 수치, 신뢰구간 또는 booking pace를 공개하지 않고 구조화된 부족 사유와 다음 수집 CTA를 반환한다. `not-collected`, `collecting`, `insufficient-data`, `not-published`, `ready`를 서로 다른 상태로 유지한다. 수집 중인 값을 미수집으로, 공개되지 않은 값을 0으로 표시하지 않는다.

## 계산·공개 계약

입지 점수는 관광, 산업, 생활권, 접근성, 관심도, OTA, 리드타임의 7개 차원을 유지한다. forecast와 월간 리포트의 대상 월은 기준일의 정확한 다음 달이어야 하며, signal fixture의 수집 기간은 예측 대상 월이 아니라 기준일이 속한 현재 월이어야 한다. forecast는 다음 달, 입력 기간, 기준일, 표본 수, 하한·상한 신뢰구간과 confidence 원인을 포함한다. 계산에 사용한 evidence snapshot과 algorithm version은 동일 요청의 재실행에서 결정적으로 같아야 한다.

사업자 월간 리포트는 다음 4개 범위만 제공한다.

- `national`: 전국 집계
- `region`: 사업자 숙소가 속한 지역 집계
- `own`: 로그인한 tenant의 숙소
- `anonymous-cohort`: k-anonymity를 통과한 비교군 집계

사업자 응답에서 다른 업체 ID, 원천 key, source URL, evidence/raw ID, 내부 수식·가중치, 절대 파일 경로와 내부 오류를 제거한다. 관리자는 draft와 audit을 볼 수 있지만 사업자는 자신의 tenant에 속한 공개 결과만 볼 수 있다.

## 생명주기와 감사

입지카드 상태는 `requested → draft → in-review → changes-requested|reviewed → published` 순서를 따른다. 허용되지 않은 전이는 실패하며, 수정·검수·공개는 actor, 시각, 이전/이후 상태가 있는 append-only audit event를 만든다. 공개된 결과를 제자리에서 덮어쓰지 않는다. rollback 단위는 개별 card/report revision이 아니라 관리자 step-up으로 생성한 Stage 229 insights store snapshot이며, 복원 뒤에도 `insights.snapshot.rolled-back` audit event를 append한다.

## API와 UI

API prefix는 `/api/integration/insights`다.

- `GET /workspace?view=business-report|business-location|admin-location`
- `GET /location-cards?companyId=...`
- `GET /monthly-reports?companyId=...&month=YYYY-MM`
- 관리자용 `POST /admin/location-cards`
- 관리자용 `POST|PATCH /admin/location-cards/:id/draft`
- 관리자용 `POST /admin/location-cards/:id/review`
- 관리자용 `POST /admin/location-cards/:id/publish`
- 관리자용 `GET|POST /admin/snapshots`
- 관리자용 `POST /admin/snapshots/:id/rollback`

card/report 단위 rollback API나 UI는 제공하지 않는다. 복원은 checksum을 검증한 동일 store snapshot에만 허용한다.

사업자 route는 `/app/report`, `/app/location`, 관리자 route는 `/admin/location`이다. 월간 리포트의 입지 보기 링크는 정확히 `/app/location`만 허용한다.

## 검증

Stage 229 검증은 다음 독립 validator로 구성한다.

- `node scripts/test_stage229_contracts.cjs`
- `node scripts/test_stage229_service.cjs`
- `node scripts/test_stage229_server.cjs`
- `node scripts/test_stage229_security.cjs`
- `node scripts/test_stage229_ui_contracts.cjs`
- `node scripts/test_stage229_visual.cjs`
- `node scripts/test_stage229_evidence.cjs`

visual validator는 기본적으로 OS 임시 디렉터리에만 결과를 쓰며, 검토자가 명시적으로 `--write-evidence`를 전달할 때만 `test/results/stage229_visual_qa.json`을 갱신한다.
