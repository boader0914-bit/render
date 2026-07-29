# Stage 230 전략·실행계획·KPI·회고 계약

## 범위

Stage 230은 Stage 229에서 공개된 준비 완료 월간 리포트만 입력으로 받아 다음 월간 흐름을 제공한다.

1. 결정적 전략 추천
2. 월간 실행계획과 체크리스트
3. KPI 목표·현재값 추적
4. 상태·담당자·목표일 기준 운영보드
5. 월간 회고
6. 이월·반복·신규 다음 달 후보

지도, 순위, 30일 시계열, 실제 signal provider, connector, scheduler와 quota 운영은 Stage 231 범위이며 Stage 230에서 구현하거나 호출하지 않는다.

## 입력 gate와 데이터 경계

전략 생성 입력은 다음 조건을 모두 만족해야 한다.

- Stage 229 월간 리포트의 `lifecycle`이 `published`
- 리포트 `state`가 `ready`이고 `resultAvailable=true`
- forecast가 `ready`
- 전국·지역·내 숙소·익명 비교군의 정확히 네 범위가 모두 `ready`
- readiness confidence가 `medium` 또는 `high`이고 원인이 기록됨
- 요청 companyId와 tenant ownership이 서버에서 다시 검증됨

하나라도 충족하지 않으면 추천을 만들지 않는다. 미공개·표본 부족 리포트는 `STRATEGY_REPORT_NOT_PUBLISHED`, confidence 계약 미충족은 `STRATEGY_REPORT_CONFIDENCE_REQUIRED`로 닫는다. 기존 V2·Cluster 리포트, 전략, 실행계획 또는 KPI 이력을 읽거나 복사해 gate를 우회하지 않는다.

허용 입력은 Stage 229가 공개한 business-safe 수치와 lineage metadata뿐이다. 원천 관측 ID, signal ID, evidence snapshot ID, 원천 key, 다른 업체 ID, raw 파일 경로와 내부 오류는 사업자 API 또는 화면에 노출하지 않는다.

## 결정적 전략 rule

rule version은 `v2-stage230-deterministic-strategy-v1`로 고정한다. 같은 report ID·version·algorithm version과 같은 rule version은 순서와 내용을 포함해 같은 결과를 만든다.

| domain | 사용 가능한 공개 근거 | 결과의 필수 내용 |
| --- | --- | --- |
| price | 내 숙소와 익명 비교군의 가격·판매율 차이 | 난이도, 기대 효과, 실행 시점, 가격 체크리스트, KPI |
| channel | OTA 노출과 범위별 판매율 | 채널 점검 순서, 기대 효과, 노출 KPI |
| product | 판매율·가격대·forecast | 상품 구성 점검, 실행 시점, 상품 KPI |
| content | 공개 입지·관심도 요약 | 콘텐츠 메시지 점검, 난이도, 콘텐츠 KPI |
| leadtime | 공개 forecast와 booking pace | D14·D7·D1 시점별 실행 항목과 리드타임 KPI |

추천 가중치 학습, A/B 자동 승자 결정, calibration, 자동승인, 자동 재검수와 재귀 실행은 금지한다. 전략은 운영자가 실행계획에 채택해야만 실행 항목이 된다.

## lineage와 멱등성

추천에는 최소한 report ID, report version, Stage 229 algorithm version, report published 시각, rule version과 적용 actor·시각을 보관한다. 후보와 계획 항목은 원본 추천 ID를 따라갈 수 있어야 한다. 사업자 projection에는 자신의 report·strategy·plan ID만 허용하고 내부 evidence 식별자는 제거한다.

모든 생성 요청은 tenant 범위의 `clientRequestId`로 멱등하다. 같은 key와 같은 의미의 payload는 기존 결과를 반환하고, 다른 payload 재사용은 `STRATEGY_IDEMPOTENCY_CONFLICT`로 거부한다. 같은 source strategy가 같은 대상 월·후보 종류로 두 번 생성되지 않아야 한다.

## 실행계획·KPI·운영보드

- plan은 월, 제목, 담당자, 목표일, 상태와 메모를 가진다.
- item은 source strategy, 담당자, 목표일, 상태, 메모와 체크리스트를 가진다.
- KPI는 이름·단위·목표값·현재값·입력 여부를 구분한다. 현재값 `0`과 미입력을 같은 값으로 취급하지 않는다.
- plan, item, checklist와 KPI 변경은 actor, 시각, 이전·이후 값이 있는 append-only audit를 남긴다.
- 운영보드는 상태, 담당자와 목표일 filter를 조합할 수 있고, 기준일보다 지난 미완료 항목을 `overdue`, 기준 주간에 속한 항목을 `thisWeek`으로 분리한다.

## 회고와 다음 달 후보

회고는 계획의 실행률, KPI 입력률·달성률, 미완료 원인을 저장한다. 값은 저장된 plan/item/KPI 상태에서 결정적으로 계산하며 미입력 KPI를 달성으로 꾸미지 않는다.

후보는 다음 세 종류를 구분한다.

- `carryover`: 미완료 실행 항목
- `repeat`: 완료했지만 다음 달 반복하기로 명시한 항목
- `new`: 새 published report와 rule version에서 새로 나온 추천

동일 회고와 동일 `clientRequestId` 재실행은 같은 후보를 반환하며 source lineage 중복은 0건이어야 한다. 후보를 자동 계획으로 승인하거나 공개하지 않는다.

계획 CRUD의 삭제 의미는 hard delete가 아니라 `status=cancelled` soft-cancel이다. 취소된 계획과 하위 항목, lineage와 audit는 그대로 보존하며 새 item·KPI 추가를 거부한다. Stage 230은 `DELETE` API를 제공하지 않는다.

## 기능 flag와 UI

모든 flag는 기본 `false`이고 상위 의존성이 꺼지면 fail-closed 한다.

| 기능 | 환경 변수 | 의존성 |
| --- | --- | --- |
| 전략 추천 | `V2_INTEGRATION_STRATEGY_ENABLED` | Stage 229 business report |
| 실행계획 | `V2_INTEGRATION_EXECUTION_ENABLED` | 전략 추천 |
| 월간 회고 | `V2_INTEGRATION_RETROSPECTIVE_ENABLED` | 실행계획 |

API prefix는 `/api/integration/strategy`다. 사업자 route는 `/app/strategy`, `/app/execution`, `/app/retrospective`이고 기존 단일 route registry의 9개 사업자 navigation을 유지한다. 화면은 PageHeader → metrics → data section 순서와 명시적 loading/empty/error/permission 상태를 따른다.

## 검증

- `node scripts/test_stage230_contracts.cjs`
- `node scripts/test_stage230_service.cjs`
- `node scripts/test_stage230_server.cjs`
- `node scripts/test_stage230_security.cjs`
- `node scripts/test_stage230_ui_contracts.cjs`
- `node scripts/test_stage230_visual.cjs`
- `node scripts/test_stage230_evidence.cjs`

visual validator는 기본적으로 OS 임시 경로에만 screenshot과 결과를 만들고, 명시적 `--write-evidence`에서만 `test/results/stage230_visual_qa.json`을 갱신한다.
