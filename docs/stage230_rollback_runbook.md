# Stage 230 rollback runbook

## 원칙

Stage 230 전략·실행·회고에 계산, 권한, 중복 또는 공개 경계 문제가 생기면 Stage 229의 공개 리포트까지 되돌린다.

- Stage 229 월간 리포트와 fresh 통합 store를 삭제·수정하지 않는다.
- Stage 230 store의 전략, 계획, KPI, 회고, 후보와 audit를 삭제하지 않고 격리·보존한다.
- rollback을 위해 기존 V2·Cluster 전략 이력을 읽거나 migration, backfill, dual-write를 시작하지 않는다.
- auth/session key와 store를 바꾸지 않아 기존 session을 보존한다.
- Render 환경변수 변경과 배포는 실행 직전에 사용자 승인을 받아야 한다.

## 즉시 중단 조건

- 미공개 또는 데이터 부족 Stage 229 리포트에서 전략이 생성됨
- 다른 tenant의 report, strategy, plan, KPI 또는 후보가 조회·변경됨
- lineage 누락, 동일 후보 중복, audit 없는 변경이 발견됨
- 사업자 응답에 raw/evidence ID, 내부 수식, 다른 업체 ID 또는 파일 경로가 노출됨
- 실제 provider/network/credential 접근, legacy data read/copy 또는 production mutation이 감지됨
- feature flag off에서 Stage 229 API·UI·session이 달라짐

## flag rollback 순서

1. `V2_INTEGRATION_RETROSPECTIVE_ENABLED=false`로 회고와 후보 생성을 차단한다.
2. `V2_INTEGRATION_EXECUTION_ENABLED=false`로 계획·item·KPI 변경을 차단한다.
3. `V2_INTEGRATION_STRATEGY_ENABLED=false`로 전략 조회·생성을 차단한다.
4. Stage 229의 report/location/reliability flag, Stage 228 fresh store와 auth/session 설정은 유지한다.
5. 승인된 재시작 또는 배포 후 `/api/health`, `/api/session`, Stage 229 업체 상세·입지카드·리포트를 smoke test한다.

의존성의 역순으로 flag를 내리며 store 파일이나 disk를 삭제·초기화하지 않는다. flag off에서 `/api/integration/strategy/*`는 404 또는 동일한 fail-closed 응답이어야 한다.

## 검증과 재활성화

Stage 230 contracts, service, server, security, UI-contract, visual, evidence validator와 전체 `npm test`, typecheck, production UI build, `git diff --check`를 다시 실행한다. published/confidence gate, tenant/IDOR, entitlement, 멱등성, lineage, audit, business-safe projection과 실제 network 0건을 확인한 뒤 `strategy → execution → retrospective` 순서로 다시 연다.

Stage 231 connector, scheduler 또는 실제 provider를 우회 복구책으로 사용하지 않는다. Stage 230 store의 개별 record를 직접 파일 편집으로 되돌리지 않는다. 저장소 정합성이 손상되면 모든 Stage 230 flag를 내린 채 blocker로 보고하고, 승인된 checkpoint artifact를 재선택한다.
