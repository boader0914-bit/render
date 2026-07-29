# Stage 226 인증 rollback runbook

## 선택한 정책

Stage 226 신규 session은 기존 V2 memory session과 의도적으로 호환하지 않는다. raw token,
hash key, password hash를 양쪽으로 복사하거나 dual-validate하지 않는다. 따라서 auth artifact를
rollback하면 모든 사용자는 기존 V2 로그인 화면에서 **안전하게 다시 로그인**한다. 기존
session cookie를 신규/legacy credential로 승격하지 않는다.

이 정책은 기존 V2·Cluster auth data 무이관 원칙과 session fixation 방지보다 사용자 session
연속성을 우선할 수 없다는 결정이다.

## rollback trigger

- login/session/logout V2 shape 또는 오류 의미 회귀
- tenant escape/IDOR, MFA bypass/replay, CSRF/Origin/Host 우회
- auth store marker 불일치, write 실패, key configuration 실패
- 새 UI 인증 흐름 장애율 또는 429/5xx 중단선 초과
- 기존 auth/data path read/copy/write 탐지

## 사전 확인

1. 현재 선택된 V2 artifact, API routing, `V2_INTEGRATION_AUTH_ENABLED`,
   `V2_UI_V3_ENABLED`, PWA cache key를 기록한다.
2. 신규 store 경로와 이전 legacy 경로를 각각 resolve하고 서로 다른지 확인한다.
3. auth store를 삭제·변환·legacy 경로로 이동하지 않는다. 분석용 read-only 보존만 허용한다.
4. 운영 담당자와 security owner가 안전 재로그인 공지를 승인한다.

## 실행 순서

1. `V2_INTEGRATION_AUTH_ENABLED=false`인 직전 검증 V2 artifact를 선택한다.
2. 새 auth routes가 아니라 legacy V2 API routing이 선택되었는지 health/login contract로
   확인한다. 다른 integration flag는 Stage 226 rollback에서 임의 변경하지 않는다.
3. UI 장애도 함께 발생했다면 `V2_UI_V3_ENABLED=false`로 기존 `web` artifact를 선택한다.
4. `glamping_datalab_session`, `lodging_v2_csrf`, `lodging_v2_anon_csrf`는 server에서
   Max-Age=0으로 폐기한다. 브라우저에는 “보안을 위해 다시 로그인하세요”를 표시한다.
5. PWA/service-worker가 신규 인증 asset을 계속 제공하면 Stage 225 runbook의
   `glamping-datalab-v2-v3-*` cache namespace를 폐기하고 legacy artifact를 재요청한다.
6. legacy `/api/login`으로 새 credential을 자동 전달하지 않는다. 사용자가 legacy V2
   credential을 직접 입력해 새 legacy session을 받도록 한다.

## 확인 절차

```powershell
$env:V2_INTEGRATION_AUTH_ENABLED = "false"
npm run test:ui-server
node scripts/test_stage226_auth_server.cjs
```

필수 확인:

- integration session cookie로 rollback된 `/api/session`을 호출하면 401이고 cookie가 폐기된다.
- legacy V2 credential을 직접 입력한 `/api/login`만 200과 legacy session을 만든다.
- auth-off에서 `web`과 기존 V2 response parity가 Stage 225 기준과 같다.
- 신규 auth store는 더 이상 request path에서 읽거나 쓰지 않는다.
- legacy member/session/password 자료를 신규 store로 복사한 건수는 0이다.

## 재활성화

1. 원인을 수정하고 `npm run test:stage226`, `npm test`, `git diff --check`를 통과한다.
2. production 필수 secret/Host/Origin/store marker와 key ring을 별도로 검증한다.
3. 빈 환경 또는 명시적으로 Stage 226에서 새 발급한 계정만 사용한다.
4. 관리자 bootstrap/MFA 준비 상태를 확인한 뒤에만 auth flag를 켠다.
5. rollback 동안 만든 legacy session은 통합 session으로 변환하지 않는다. 다시 로그인해
   신규 session을 발급한다.

## 금지

- 양쪽 password hash/session/token copy 또는 dual-write
- 신규 auth store를 legacy `b2b_members.json` 경로로 rename
- 장애 회피용 fallback `admin/0914`, `b2b/0914` 재활성화
- 승인 없는 real email 발송
- rollback을 이유로 Stage 227 data API를 연결하거나 기존 데이터로 backfill
