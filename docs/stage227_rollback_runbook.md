# Stage 227 rollback runbook

작성일: 2026-07-29
정책: Stage 226과 동일한 안전 재로그인 정책

## 1. 적용 범위

이 절차는 Stage 227 platform core API와 V3 핵심 기능 화면을 되돌린다. 실제 provider,
worker, durable integration data store는 Stage 227에 없으므로 삭제·복구할 신규 운영
데이터는 없다. 기존 V2·Cluster data path를 통합 runtime에 연결하거나 두 원천에
dual-write하는 권한을 포함하지 않는다.

다음 중 하나면 rollback을 시작한다.

- tenant escape, CSRF/Origin/Host 우회 또는 역할별 데이터 노출
- 기존 runtime file, DB, cache, output 접근
- 동일 `clientRequestId`의 중복 작업 또는 다른 payload 재사용
- V2 업무 값 parity 실패
- 핵심 route 반복 오류, 접근성 또는 asset cache 회귀

## 2. 준비 확인

1. 대상 환경, 현재 artifact와 승인된 이전 V2 artifact ID를 기록한다.
2. `V2_UI_V3_ENABLED`, `V2_INTEGRATION_AUTH_ENABLED`와
   `V2_INTEGRATION_PLATFORM_CORE_ENABLED`의 현재 값을 기록한다.
3. session 정책을 확인한다. Stage 226 integration session을 legacy auth가 해석할 수
   없으므로 전체 legacy artifact 복귀 시 안전 재로그인이 필요하다.
4. 기존 V2 데이터는 읽기 전용 rollback 경계로만 유지하고 복사·restore·backfill하지
   않는다.

## 3. rollback 순서

1. `V2_INTEGRATION_PLATFORM_CORE_ENABLED=false`로 바꾸고 새 artifact/process를
   재시작한다. `/api/integration/core/*`가 `404`인지 확인한다.
2. Stage 227에는 worker가 없지만 향후 운영 절차와 순서를 맞추기 위해 신규 요청 접수를
   중단했음을 기록한다. provider 중단 작업은 0건이어야 한다.
3. V3 화면도 되돌려야 하면 `V2_UI_V3_ENABLED=false`로 바꾸고 승인된 이전 V2
   artifact를 재선택한다. server가 `web` legacy asset을 제공하는지 확인한다.
4. 전체 legacy API routing 복구가 필요하면 승인된 Stage 225 이전 환경 snapshot에 따라
   `V2_INTEGRATION_AUTH_ENABLED=false`로 전환한다. 임의 fallback credential을 만들지
   말고 기존 승인된 legacy 인증 설정만 사용한다.
5. V3 asset/service-worker cache를 폐기한다. Stage 225의 V2 cache key와
   `purgeV2UiCaches()` 경로를 사용하고 HTML, manifest, service worker를 다시 요청한다.
6. integration auth cookie가 남아 있거나 legacy session으로 검증되지 않으면 cookie를
   안전하게 만료한 뒤 로그인 화면으로 이동시킨다. 사용자에게 재로그인 필요성을
   알리고 기존 password hash/session을 새 auth store로 복사하지 않는다.

## 4. 검증

- legacy `/admin` 또는 `/b2b` HTML이 승인된 cache-buster 변환 외에는 이전 V2와 동일
- `/manifest.webmanifest`, `/sw.js`, `/offline.html`, `/favicon.svg` byte parity
- `/api/integration/core/workspace` `404`
- legacy health/session/login 계약 통과
- 역할별 `/admin`, `/b2b`, `/view` routing 통과
- 기존 data read-only 경계와 신규 write 0건 확인
- 브라우저 오류와 stale V3 asset 요청 0건 확인

자동 drill은 `scripts/test_stage227_core_server.cjs`에서 다음을 검증한다.

- core flag off legacy asset/UI/API parity
- auth on/core off에서 기존 integration session 유지
- 동일 auth store로 core on 재시작 후 session 유지
- core flag를 auth 없이 단독 활성화하면 listen 전 fail closed

## 5. 복구 후 기록

rollback 시각, 원인, artifact ID, flag 전후 값, cache 폐기 결과, 재로그인 사용자 수와
검증 명령을 release evidence에 기록한다. Stage 227 provisional memory store는 process와
함께 사라지며 별도 파일 삭제를 수행하지 않는다. 실제 durable snapshot과 worker resume는
Stage 228에서 별도 설계한다.
