# Stage 226 신규 계정·인증·보안 구현 기록

## 실행 경계

- 구현 기준 V2 commit: `4e4e190` 위의 미커밋 Stage 222~225 작업을 보존했다.
- Cluster 읽기 전용 기준: `57a6c561496812126e2ff2e8a61bff51099b2423`.
- V3 UI 읽기 전용 기준: `2bcdc7c0843358bb3cbb8a2025ffe873d3bf5154`.
- Stage 225 선행 gate: `docs/stage225_completion_evidence.json`의 build, flag-off,
  desktop/mobile × light/dark 시각 QA를 다시 통과한 뒤 시작했다.
- 배포, branch switch, commit, Cluster merge/cherry-pick, 기존 인증 데이터 import는
  수행하지 않았다. Stage 227 업무 기능도 연결하지 않았다.

Stage 226은 V2의 `/api/login`, `/api/session`, `/api/logout` 응답 의미와
`glamping_datalab_session` cookie 이름을 유지하면서 저장 경계만 새 통합 auth store로
전환한다. `V2_INTEGRATION_AUTH_ENABLED`는 명시적으로 true일 때만 동작하며 기본값은
false다. false이면 기존 V2 코드 경로와 UI가 그대로 선택된다.

## 구현 구성

| 경계 | 파일 | 책임 |
| --- | --- | --- |
| 계약 | `scripts/integration/contracts/auth.cjs` | role, 상태, V2 session projection, free/basic/pro entitlement |
| 저장소 | `scripts/integration/repositories/auth_store.cjs` | 빈 schema, marker 검사, lock, atomic replace, mode 0600 |
| 암호 | `scripts/integration/services/auth_crypto.cjs` | PBKDF2, HMAC token hash, TOTP counter, AES-256-GCM, recovery hash |
| 서비스 | `scripts/integration/services/auth_service.cjs` | bootstrap, signup, invite, reset, MFA, session, tenant, audit |
| 메일 | `scripts/integration/services/auth_email.cjs` | mock outbox만 제공; raw activation/reset token 저장 금지 |
| HTTP | `scripts/integration/http/auth_http.cjs` | V2 route shape, cookie, CSRF, Origin/Host, 403/429/503 의미 |
| bootstrap | `scripts/integration/bootstrap/auth_runtime.cjs` | 명시 store/repository/service/server 조립 |
| UI | `apps/web/src/auth`, `apps/web/src/apiClient.ts` | V3형 실제 login/signup/activate/reset/MFA 흐름 |

V3의 인증 panel 비율과 Stage 225 공통 UI를 재사용했다. V3 업무 API, fixture, 인증 저장
모델은 복사하지 않았다. Cluster에서는 더 엄격한 MFA·CSRF·Origin/Host·잠금·감사
요구만 계약 단위로 이식했고 server/DB/auth file은 복사하지 않았다.

## 빈 store schema와 bootstrap

`V2_INTEGRATION_AUTH_STORE_PATH`가 가리키는 JSON은
`storeKind=glamping-datalab-v2-integration-auth`, `schemaVersion=1` marker가 없으면
거부한다. schema는 다음 최소 collection을 가진다.

| collection | 최소 책임 | 저장 금지 |
| --- | --- | --- |
| accounts | username/email, role/status, PBKDF2 hash, `authVersion` | 평문 password, legacy member id |
| companies | 통합 auth에서 새로 생성한 platform/business company | 기존 company payload |
| memberships | account-company ownership, plan, status | Cluster 임시 companyId mapping |
| sessions | HMAC token hash/key version, CSRF hash, 만료·폐기, fingerprint | raw token/cookie |
| invites | 단일 사용 hash token, 만료·취소·재발급 | raw activation token |
| passwordResets | 단일 사용 hash token, 만료·supersede | raw reset token |
| mfaFactors | AES-GCM TOTP envelope, hash recovery code, last TOTP counter | raw recovery code |
| authChallenges | hash challenge, `authVersion`, 만료·consume | raw challenge token |
| loginGuards | account/IP별 지속형 window와 잠금 | raw IP, raw identity |
| authAudit | actor/outcome/시간과 secret 제거 metadata | password/token/secret/header/hash |
| emailOutbox | mock delivery metadata | mail 본문의 raw token |

깨끗한 경로에서 `initialize()`를 반복해도 동일 store를 반환하고, 최초 관리자
bootstrap도 같은 username/email이면 account/company/membership을 중복 생성하지 않는다.
관리자와 active MFA가 모두 준비되기 전에는 capabilities/CSRF/bootstrap/MFA 등록 외
signup/login/reset/activate/check-username을 `503 AUTH_BOOTSTRAP_REQUIRED`로 닫는다.
전체 account identity와 platform company 충돌도 bootstrap transaction 안에서 거부한다.

## 인증 수명주기

1. bootstrap secret으로 최초 admin을 `mfa_pending` 상태로 한 번 생성한다.
2. TOTP secret은 AES-256-GCM envelope로 저장하고, 최초 code의 실제 30초 counter를
   기록한다. recovery code 8개는 한 번만 반환하고 keyed hash만 저장한다.
3. 관리자 login은 password 확인 후 10분 challenge를 발급하며 TOTP 또는 미사용 recovery
   code 확인 뒤에만 MFA session을 만든다.
4. 공개 signup과 invite activation은 새 business account/company/membership을 만든다.
   invite create/cancel/reissue/activate는 단일 사용·만료 계약이며 reissue는 한 transaction이다.
5. reset은 password hash와 `authVersion`을 갱신하고 기존 session을 폐기하며 미사용
   challenge와 account lock을 정리한다. reset 전 검증 결과로 뒤늦은 session을 만들 수 없다.
6. logout, admin force logout, key version retire는 durable revocation을 기록한다.
7. 민감 관리자 작업은 5분 이내 password+새 TOTP counter 재확인을 요구한다.

동일 TOTP counter는 enrollment, login MFA, reauthentication 전체에서 재사용할 수 없다.
MFA와 login 실패는 account-only와 socket-IP-only guard를 함께 증가시킨다. 관리자는 최근
재확인 후 `POST /api/auth/accounts/:accountId/unlock-login`으로 account lock을 해제할 수
있다. 해당 계정의 실패가 연결된 IP guard도 함께 해제하되, 이 작업 자체가 감사된다.

## HTTP와 보안 계약

| 항목 | 동결값 |
| --- | --- |
| login input | `{ username, password }`; username 자리에 아이디 또는 이메일 허용 |
| login/session/logout | 기존 V2 route와 authenticated/role/memberId/accountType/profile 의미 유지 |
| session cookie | `glamping_datalab_session`, HttpOnly, SameSite=Lax, production Secure |
| session 저장 | raw token이 아닌 versioned HMAC hash; 기본 TTL 12시간 |
| CSRF | anonymous `lodging_v2_anon_csrf`와 session `lodging_v2_csrf` 분리 |
| session CSRF 복구 | `GET /api/auth/csrf`가 server hash와 cookie/header를 함께 rotate |
| Origin/Host | mutation Origin과 모든 auth Host allowlist 검사; production 값 필수 |
| fingerprint | session key와 독립된 stable HMAC; socket peer와 User-Agent만 사용 |
| proxy | 신뢰 CIDR 계약이 없는 Stage 226에서는 `X-Forwarded-For`를 사용하지 않음 |
| 보안 header | CSP, nosniff, frame deny, referrer, permissions; production HSTS |
| tenant | admin 또는 active membership만 허용; 다른 `companyId`는 server 403 |

공개 mutation도 먼저 발급한 서명 CSRF header가 없으면 403이다. 요청 budget은 store에
지속되며 첫 초과 응답부터 429와 `Retry-After`를 반환한다.

| scope | limit | window | key |
| --- | ---: | ---: | --- |
| bootstrap | 10 | 15분 | IP + username |
| signup | 8 | 60분 | IP + username/email |
| username check | 60 | 10분 | IP + username |
| reset request | 10 | 60분 | IP + identity |
| reset confirm | 10 | 60분 | IP + token fingerprint |
| invite activate | 10 | 60분 | IP + token fingerprint |
| login/MFA/reauth 실패 | 5 | 15분, lock 10분 | account/identity + IP |

DoS에 의한 무한 file 성장을 막기 위해 audit 5,000행, mock outbox 1,000행,
challenge/login guard 각 2,000행으로 상한을 고정했다.

## entitlement 기본 계약

| plan | 일 검색 | 검색 기간 | 월 export | 동시 export | 확장 검색 |
| --- | ---: | ---: | ---: | ---: | --- |
| free | 2 | 7일 | 0 | 0 | 불가 |
| basic | 20 | 14일 | 5 | 1 | 가능 |
| pro | 100 | 30일 | 30 | 2 | 가능 |

Stage 226에서는 계약과 session projection만 제공한다. 실제 검색·export 집행은 Stage 227
이후 각 server action에서 같은 entitlement를 다시 검사해야 하며 이번 단계에서는 기존
업무 API를 auth-on 상태에서 404로 닫았다.

## 환경 변수와 fail-closed 규칙

| 변수 | 규칙 |
| --- | --- |
| `V2_INTEGRATION_AUTH_ENABLED` | 기본 false; 명시 true만 신규 auth 활성화 |
| `V2_INTEGRATION_AUTH_STORE_PATH` | auth-on에서 필수; production 누락 시 server listen 전 종료 |
| `V2_AUTH_BOOTSTRAP_SECRET` | 최소 32자 |
| `V2_AUTH_SESSION_KEY_VERSION` | current hash key version |
| `V2_AUTH_SESSION_HASH_KEY_CURRENT` | 최소 32자 current HMAC key |
| `V2_AUTH_SESSION_HASH_KEYS_PREVIOUS` | 이전 version→key JSON; retire 전 검증 가능 |
| `V2_AUTH_MFA_ENCRYPTION_KEY` | 최소 32자, MFA envelope/recovery hash |
| `V2_AUTH_FINGERPRINT_KEY` | 선택; 미지정 시 MFA key를 stable fingerprint key로 사용 |
| `V2_AUTH_ALLOWED_HOSTS`, `V2_AUTH_ALLOWED_ORIGINS` | production에서 비어 있으면 시작 거부 |
| `V2_AUTH_EMAIL_PROVIDER` | 기본/허용값 `mock` |
| `V2_AUTH_REAL_EMAIL_APPROVED` | 승인 표시만으로 발송하지 않음; Stage 226 real provider 미구현 |
| `V2_AUTH_MOCK_PREVIEW_ENABLED` | `NODE_ENV=test`와 명시 true가 모두 있어야 test token 반환 |

## 무이관 증적 경계

신규 runtime 모듈은 `config/b2b_members.json`, `customer_db/b2b_members.json`, legacy
session memory/file, V2/Cluster password hash/token/cache/output을 읽지 않는다. auth-on에서는
신규 auth handler에 없는 `/api/*`와 모든 미처리 mutation을 404로 종료해 기존 auth/data
handler까지 도달하지 못하게 한다. store resolver도 legacy basename, `config/b2b_*`,
`customer_db/b2b_*`, Stage 221~223 fixture를 거부한다.

Stage 226 test는 raw password, session/CSRF/invite/reset/challenge token, TOTP secret과
recovery code가 직렬화된 store에 없는지 검사하며 기존 auth data copy 기대값은 0이다.

## 검증 명령

```powershell
npm run test:auth-security
npm run test:auth-visual
npm run test:stage226
npm test
git diff --check
```

시각 QA는 login/signup/activate/reset/MFA 5상태를 1440×900 및 390×844,
light/dark로 조합한 20장과 320px, 200% 확대, focus/label/overflow 조건을 검사한다.

## RACI와 출시 gate

| 작업 | Responsible | Accountable | Consulted | Informed |
| --- | --- | --- | --- | --- |
| auth schema/repository | backend engineer | security owner | operations owner | product owner |
| login/MFA/CSRF/tenant | security engineer | security owner | backend engineer | product owner |
| V3 auth UI | frontend engineer | frontend owner | accessibility owner | product owner |
| auth flag/rollback | operations engineer | operations owner | security owner | support owner |

출시 승인자는 security owner와 operations owner다. test 전체, legacy flag-off, 20조건
시각 QA, 무이관·secret scan, production fail-closed 중 하나라도 실패하면 flag를 켤 수 없다.
