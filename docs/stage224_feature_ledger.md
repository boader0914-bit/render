# Stage 224 기능·API·화면 원장 동결

- 상태: 구현 및 자동 검증 동결
- 대상 앱: `glamping-datalab-v2`
- V2 기준: `4e4e1906e2967fe58df66f8ad67f832043d2763b`
- Cluster 읽기 전용 기준: `57a6c561496812126e2ff2e8a61bff51099b2423`
- V3 조사 자산 기준: `2bcdc7c0843358bb3cbb8a2025ffe873d3bf5154`
- 기계 판독 정본: `docs/stage224_feature_ledger.json`
- 재실행기: `scripts/stage224_inventory.cjs`
- 검증기: `scripts/test_stage224_inventory.cjs`

이 문서는 V2·Cluster의 기능, API, 동적 handler와 화면/file surface를 하나의 생성
원장으로 고정한다. JSON의 962개 record는 서로 다른 조사 관점의 중복 증거를 일부
포함한다. 따라서 962는 제품 기능 수가 아니라 누락 검사를 위한 원장 행 수다.

## 1. 원장 범위

| source | 업무 기능 | Stage 221 literal | method+handler | V3 survey surface | 원장 합계 |
|---|---:|---:|---:|---:|---:|
| V2 | 52 | 43 | 47 | 45 | 187 |
| Cluster | 77 | 228 | 256 | 214 | 775 |
| 합계 | 129 | 271 | 303 | 259 | 962 |

각 행은 최소 필드 `id`, `domain`, `source`, `sourceCommit`, `sourcePath`, `role`,
`routeOrScreen`, `v2Conflict`, `decision`, `decisionRationale`, `v2PriorityReason`,
`targetStage`, `featureFlag`, `freshDataInputs`, `tests`, `releaseGate`, `notes`,
`owner`, `approver`를 갖는다. Cluster 775개 행의 미분류 수는 0이다.

업무 기능만 집계하면 V2는 keep 49, exclude 3이고 Cluster는 port 60, defer 7,
exclude 10이다. A/B `CL-X01`~`CL-X07`만 post-234 defer다. `CL-C10`과
`CL-Z01`~`CL-Z08`의 calibration, SLA, 자동학습·자동승인·재검수·재귀 품질 기능은
모두 Stage 224 exclude다.

## 2. 45/214와 43/228의 정합화

두 숫자는 같은 단위를 다른 시점에 센 값이 아니다.

- Stage 221 scanner는 single/double quote의 정적 `/api/` literal을 원형 그대로
  센다. bare `/api/` sentinel과 backtick template은 실행 endpoint 수에서 제외한다.
- V3 scanner는 server와 `web/app.js`에서 `/api`, `/outputs`, `/admin`, `/app`,
  `/b2b`, `/view`를 backtick template까지 찾고 끝 `/`를 제거한다.
- Stage 224 handler scanner는 실제 `req.method` 조건, `pathname ===`,
  `startsWith`+`endsWith`와 정규식 route를 method/path 계약으로 별도 정규화한다.

| source | Stage 221 raw | 끝 `/` 정규화 | V3에만 있는 surface | V3 조사 | 실제 path pattern | method+path | 동적 path |
|---|---:|---:|---:|---:|---:|---:|---:|
| V2 | 43 | 40 | 5 | 45 | 41 | 47 | 4 |
| Cluster | 228 | 207 | 7 | 214 | 232 | 256 | 28 |

V2 정합식은 `43 raw - 3 trailing-slash collision = 40 canonical`, 여기에
`/admin`, `/b2b`, `/outputs`, `/outputs/*`, `/view` 5개가 더해져 45다.

Cluster 정합식은 `228 raw - 21 trailing-slash collision = 207 canonical`, 여기에
`/admin`, `/app`, `/view`, `/outputs`, bare `/api`,
``/api/admin/auth/invitations/${action}``,
``/api/admin/master-db/companies${query}`` 7개가 더해져 214다. 마지막 두 항목은
template 관측치이며 `${query}`는 새 endpoint가 아니라 query 조립 증거다.

V2 동적 handler 4개는 다음과 같다.

- `POST /api/account-delete-requests/:id/status`
- `POST /api/b2b-members/:id/policy`
- `GET /api/member/runs/:id`
- `GET /api/runs/:id`

Cluster는 `startsWith` condition family 23개와 정규식 family 1개를
approve/reject suffix별로 전개해 28개다. 전 목록과 source line은 JSON의
`inventoryReconciliation.cluster.dynamicRoutes` 및 `dynamic-handler` 행에 있다.
검증기는 43/228, 40/207, 45/214, 41/47, 232/256, 4/28을 모두 다시 계산하고 하나라도
달라지면 실패한다.

## 3. 기능 결정 규칙

| 결정 | 동결 규칙 | 데이터 규칙 |
|---|---|---|
| keep | 중복 기능은 V2 입력·출력·API·계산·companyId를 유지 | 통합 기능이 사용할 값은 새로 수집하며 기존 파일을 seed로 쓰지 않음 |
| port | Cluster 고유 가치를 domain 단위로 V2에 additive 이식 | target stage flag, owner test와 승인 gate 전까지 false |
| defer | A/B, variant, segment/quality learning은 표본 protocol 승인 후 검토 | post-234 전 runtime route와 write 0 |
| exclude | 재귀 quality/SLA/calibration/자동승인, rebuild, legacy output 경로 | runtime route, flag, legacy read/write 0 |

Cluster monolith, HTML, JS, CSS, DB, run output, 인증/session/secret은 기능 원천이
아니며 whole-file copy 대상이 아니다. `keep`인 Cluster route도 Cluster 코드를
유지한다는 뜻이 아니라 같은 계약의 V2 구현을 유지한다는 뜻이다.

## 4. 신규 데이터와 Stage 223 경계

모든 원장 행의 `freshDataInputs`에는 다음 네 금지가 명시돼 있다.

- `legacyRuntimeReadAllowed=false`
- `migrationAllowed=false`
- `backfillAllowed=false`
- `dualWriteAllowed=false`

통합 store의 최초 상태는 empty이고 승인된 provider의 새 응답, 새 bootstrap 계정,
새 사용자 action만 입력이 될 수 있다. 기존 V2·Cluster company, observation, run,
cache, history, auth/session/secret은 통합 store로 이동하지 않는다.

Stage 223의 `V2_INTEGRATION_COMPANY_ENABLED`와
`V2_INTEGRATION_OBSERVATION_ENABLED`는 `NODE_ENV=test`에서만 true가 될 수 있다.
production 또는 `RENDER`/`RENDER_EXTERNAL_URL` runtime 신호가 있으면 값이 true이고
`NODE_ENV=test`로 잘못 설정돼도 false로 fail-closed하며 preview endpoint는 404다.
두 flag와 preview fixture는 계약 검증 자산일 뿐 migration, backfill, seed 또는
production runtime 경로가 아니다.

Test 환경에서도 flag만으로는 부족하다. `contract-preview` purpose, 명시적인 fixture
root와 `integration_data_access_guard.cjs`의 path별 승인이 모두 있어야 하며, 하나라도
없으면 route는 404다. 따라서 임의 `DATA_DIR`·`OUTPUTS_DIR`은 preview 원천이 될 수
없다.

## 5. 소유권, flag와 승인

원장은 역할 코드를 `PO`, `BE`, `DE`, `FE`, `SE`, `SO`, `QA`, `SRE`, `RM`,
`DGO`, `APO`, `PIE`, `SPE`, `ProviderOps`, `Finance`, `Legal`로 고정한다.
Stage 224~234마다 R/A/C/I가 있고 Accountable이 없는 단계는 없다.

31개 flag는 모두 default false이며 owner, approver, 전체 `approvalRoles`,
`dependsOn`, 비-flag 선행 gate, 대상 역할,
rollout 순서, 관찰 지표와 rollback을 갖는다. dependency의 미등록 이름과 순환은
자동 실패다. provider flag는 rate, daily quota, unit cost, real request limit와
approved cap이 모두 숫자로 승인되기 전 계속 false다.

## 6. 명칭과 배포 경계

- package, 서비스 ID와 문서 정본: `glamping-datalab-v2`
- 사용자 표시명: `숙박업 데이터랩 beta`
- V2 manifest 정본: `render.v2.yaml`, `render.v2.persistent.yaml`
- Cluster 참조 전용: `render.yaml`, `render.persistent.yaml`

기존 불일치는 초기 Cluster 배포용 package/README/default manifest가 V2 제품 전환
후에도 남은 것이 원인이다. legacy manifest의 service/disk payload는 감사 식별자를
보존하기 위해 이름만 바꾸지 않았다. 두 파일은 top-level `services`를 제거하고
`x-legacy-cluster-services` 아래에 payload를 둬 구조적으로 배포할 수 없게 했다.
cookie, localStorage와 PWA cache key는 Stage 225 호환성 검사 전까지 변경하지 않는다.

## 7. 재실행과 종료 판정

~~~powershell
npm run stage224:inventory
npm run test:stage224
~~~

검증은 고정 Git object만 읽고 source worktree HEAD와 dirty status가 변하지 않았는지
확인한다. 실제 provider 요청, Cluster merge/cherry-pick, 운영 데이터 읽기, staging
또는 production 배포를 하지 않는다.

- 미분류 Cluster 원장: 0
- migration/backfill/dual-write 허용: 각각 0
- legacy runtime read 허용: 0
- 논리 중복, quota 초과, companyId 충돌 허용: 각각 0
- 승인자 미정: 0
- Stage 224 blocker: 0

Stage 225는 이 단계에서 수행하지 않는다.
