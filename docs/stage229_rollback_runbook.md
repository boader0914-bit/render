# Stage 229 rollback runbook

## 목적과 원칙

이 runbook은 입지카드, forecast 또는 월간 리포트에 잘못된 공개, 권한 경계 위반, 계산 회귀, source-boundary 위반이 확인됐을 때 Stage 228까지의 안전한 동작으로 되돌리기 위한 절차다.

- 기존 V2 데이터와 Stage 228 신규 통합 store를 삭제하거나 수정하지 않는다.
- 공개 snapshot과 audit event를 삭제하지 않는다.
- rollback을 위해 migration, backfill, dual-write 또는 legacy data read를 시작하지 않는다.
- session key와 auth store를 바꾸지 않아 재로그인 강제를 만들지 않는다.
- Render 환경 변수 변경이나 실제 배포는 사용자 승인 후에만 수행한다.

## 즉시 중단 조건

다음 중 하나면 공개를 중단한다.

- 다른 tenant 또는 다른 업체 ID가 사업자 응답에 노출됨
- 원천 key, credential, 내부 수식, raw/evidence ID 또는 절대 경로가 노출됨
- 외부 network/credential read 또는 production mutation이 감지됨
- 최소 표본 전에 forecast, booking pace 또는 report가 `ready`로 공개됨
- audit 없는 수정·공개·rollback 또는 허용되지 않은 lifecycle 전이가 발생함
- flag-off V2 응답, 세션 또는 정적 자산이 달라짐

## 플래그 rollback 순서

1. `V2_INTEGRATION_BUSINESS_REPORT_ENABLED=false`로 바꿔 월간 리포트 공개를 먼저 차단한다.
2. `V2_INTEGRATION_LOCATION_CARD_ENABLED=false`로 바꿔 입지카드 조회·변경을 차단한다.
3. `V2_INTEGRATION_RELIABILITY_ENABLED=false`로 바꿔 Stage 229 신뢰도 projection을 차단한다.
4. Stage 228 플래그와 store 경로, auth/session 설정은 그대로 둔다.
5. 승인된 배포 또는 재시작 후 프로세스가 정상 기동하는지 확인한다.

의존 플래그를 역순으로 끄면 상위 기능이 하위 기능을 참조하는 시간 창을 최소화한다. 긴급 상황에서도 store 파일을 삭제하지 않는다.

## 확인 절차

플래그가 내려간 인스턴스에서 다음을 확인한다.

- `/api/health`가 정상이며 Stage 229 capability를 공개하지 않는다.
- `/api/integration/insights/*`가 `404` 또는 동일한 fail-closed 응답을 반환한다.
- 기존 Stage 228 세션이 유지되고 `/api/session`이 같은 account/company를 반환한다.
- 기존 V2 정적 자산과 대표 legacy route가 rollback 전 flag-off baseline과 동일하다.
- Stage 228 신규 수집 store의 file count와 checksum이 rollback 동작 때문에 변하지 않았다.
- network deny log, provider diagnostics와 audit에서 외부 요청·credential read가 0이다.

## Stage 229 store snapshot 복구

플래그로 전체 공개를 차단한 뒤에만 audited snapshot rollback을 수행한다. 현재 구현은 card/report 단위 revision rollback API나 UI를 제공하지 않는다.

1. 관리자 세션에서 비밀번호와 MFA로 최근 step-up을 완료한다.
2. `GET /api/integration/insights/admin/snapshots`로 동일 Stage 229 store에 속한 snapshot 목록을 확인한다.
3. 대상 snapshot의 store ID, 생성 시각, label, 공개용 checksum 요약과 복구할 store revision을 확인한다. 파일 경로 목록은 API 응답에 노출하지 않는다.
4. `POST /api/integration/insights/admin/snapshots/:snapshotId/rollback`을 한 번 실행한다.
5. repository가 격리된 동일 볼륨 restore 디렉터리에서 `filesHash`, 모든 파일의 checksum·크기·schema와 store 소유권을 먼저 검증했는지 확인한다. 하나라도 실패하면 live state에는 쓰지 않는다.
6. 검증이 끝난 state·index·signal·evidence·manifest만 rename 기반 교체하고, backup journal이 중단된 교체를 재기동 시 복구하며 transaction 디렉터리를 정리했는지 확인한다.
7. `insights.snapshot.rolled-back` append-only audit event에 snapshot ID와 restored revision이 기록됐는지 확인한다.
8. 다른 fresh store, auth store와 Stage 228 관측이 변경되지 않았는지 확인한다.

정상 snapshot이 없거나 checksum, store ID, step-up 또는 audit 저장이 실패하면 card/report를 수동으로 덮어쓰지 않는다. 플래그를 내린 채 blocker로 처리한다.

## 복구와 재공개

원인이 수정된 뒤 contracts, service, server, security, UI-contract, visual, evidence validator와 `npm test`, `git diff --check`를 모두 다시 실행한다. 최소 표본, tenant/IDOR/CSRF, business-safe projection, lifecycle/audit와 flag-off 회귀가 모두 통과한 증거를 검토한 후 플래그를 의존성 순서대로 `reliability → location card → business report`로 올린다.

Stage 230 또는 실제 provider 연결을 우회 복구책으로 사용하지 않는다.
