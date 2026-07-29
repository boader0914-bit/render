# glamping-datalab-v2

글램핑 업체·지역·예약·관광 데이터를 수집하고 분석하는 V2 정본 앱입니다.
V2와 Cluster 기능 통합에서도 기존 V2 기능과 API 계약을 우선하며, 화면은
V3 UI 기준으로 단계적으로 전환합니다.

## 배포 정본과 참조 경계

| 파일 | 용도 | 배포 상태 |
| --- | --- | --- |
| `render.v2.yaml` | 임시 저장공간을 사용하는 V2 사양 | V2 정본 |
| `render.v2.persistent.yaml` | Persistent Disk를 사용하는 V2 사양 | V2 정본 |
| `render.yaml` | 기존 `glamping-cluster-app` 사양 | legacy/reference-only, 배포 금지 |
| `render.persistent.yaml` | 기존 Cluster Persistent Disk 사양 | legacy/reference-only, 배포 금지 |

루트의 두 legacy manifest는 top-level `services`가 없는 `x-legacy-cluster-services`
감사 자료라 Render가 서비스를 만들 수 없습니다. V2 서비스 설정의 기준은 반드시
`render.v2.yaml` 또는 `render.v2.persistent.yaml`이어야 합니다. 기존 Cluster
리소스명과 디스크명은 참조 식별자를 보존하기 위해 그대로 두었으며, V2 대상으로
재사용하거나 이름만 바꿔 배포해서는 안 됩니다.

배포·서비스 생성·디스크 연결은 명시적인 운영 승인 후에만 수행합니다. 자세한
안전 절차는 `RENDER_DEPLOY.md`를 확인하세요.

## 로컬 실행과 검사

```powershell
npm install
npm test
npm start
```

기본 health check 경로는 `/api/health`입니다.

Stage 225의 React 19/Vite UI는 `apps/web`, 공통 UI는 `packages/ui`에 있으며 기존
`web`은 rollback 가능한 legacy UI로 유지됩니다. 새 UI는 기본적으로 꺼져 있습니다.

```powershell
npm run typecheck:ui
npm run build:ui
$env:V2_UI_V3_ENABLED = "true" # 로컬 QA에서만 명시적으로 사용
npm start
```

flag가 없거나 `false`이면 server는 기존 V2 UI만 제공합니다. 전환·cache·session
복구 절차는 `docs/stage225_ui_rollback_runbook.md`를 따릅니다.

Stage 226의 신규 계정·인증 저장소도 기본적으로 꺼져 있습니다. 로컬 격리 QA에서는
기존 `config/b2b_members.json`, `customer_db/b2b_members.json` 또는 기존 session 경로가
아닌 빈 경로와 새 secret을 명시해야 합니다.

```powershell
$env:V2_INTEGRATION_AUTH_ENABLED = "true"
$env:V2_INTEGRATION_AUTH_STORE_PATH = "<fresh-auth-store-absolute-path>"
$env:V2_AUTH_BOOTSTRAP_SECRET = "<32자 이상 신규 secret>"
$env:V2_AUTH_SESSION_KEY_VERSION = "v1"
$env:V2_AUTH_SESSION_HASH_KEY_CURRENT = "<32자 이상 신규 HMAC key>"
$env:V2_AUTH_MFA_ENCRYPTION_KEY = "<32자 이상 신규 MFA key>"
$env:V2_AUTH_ALLOWED_HOSTS = "127.0.0.1:3210"
$env:V2_AUTH_ALLOWED_ORIGINS = "http://127.0.0.1:3210"
npm run test:stage226
```

운영에서는 store 또는 Host/Origin allowlist가 없으면 server가 listen 전에 종료합니다.
기존 password hash/session/token은 가져오지 않으며 초대·활성화 또는 가입으로 계정을
새로 발급합니다. 상세 계약과 안전 재로그인 rollback은
`docs/stage226_auth_account_security.md`, `docs/stage226_auth_rollback_runbook.md`를
따릅니다.

Stage 227의 핵심 사용자 여정은 별도 platform-core flag 뒤에서만 동작합니다.
이 flag는 Stage 226 신규 인증에 의존하며 단독으로 켜면 server가 listen 전에
fail closed합니다. 기본 store는 빈 메모리 store이고, 합성 결과는 `NODE_ENV=test`와
명시적 fixture mode에서만 `test/fixtures/stage227` allowlist를 읽습니다. 실제 provider나
기존 V2·Cluster runtime 데이터는 사용하지 않습니다.

```powershell
npm run test:stage227
$env:V2_UI_V3_ENABLED = "true"
$env:V2_INTEGRATION_AUTH_ENABLED = "true"
$env:V2_INTEGRATION_PLATFORM_CORE_ENABLED = "true"
# 인증 store와 신규 secret/Host/Origin 설정은 위 Stage 226 예시와 동일하게 필요합니다.
npm start
```

프로세스 재시작을 넘는 작업 복구와 실제 신규 수집 store·worker acceptance는 Stage 228
범위입니다. Stage 227은 브라우저 새로고침 시 `clientRequestId`로 동일 프로세스의
provisional 작업을 복구하는 UI/API 계약까지만 제공합니다.

Stage 228의 durable 통합 store와 수집 worker도 두 개의 별도 flag 뒤에서 기본적으로
꺼져 있습니다. 실행 시에는 기존 `DATA_DIR`, `OUTPUTS_DIR`, `CONFIG_DIR`, V2·Cluster
runtime 데이터 경로와 겹치지 않는 **새 절대 경로**를 반드시 지정해야 합니다. 두 flag
중 하나만 켜거나 경로가 누락·중복되면 server는 listen 전에 fail closed합니다.
Stage 228에서 auth store가 `DATA_DIR` 내부라면 새
`DATA_DIR/fresh-integration/<file>` namespace만 허용하며 legacy 경로 alias는 차단합니다.

```powershell
npm run test:stage228
$env:V2_UI_V3_ENABLED = "true"
$env:V2_INTEGRATION_AUTH_ENABLED = "true"
$env:V2_INTEGRATION_PLATFORM_CORE_ENABLED = "true"
$env:V2_INTEGRATION_FRESH_COMPANY_ENABLED = "true"
$env:V2_INTEGRATION_FRESH_OBSERVATION_ENABLED = "true"
$env:V2_INTEGRATION_DATA_DIR = "<fresh-integration-store-absolute-path>"
$env:V2_INTEGRATION_FRESH_PROVIDER = "synthetic"
# Stage 226의 새 auth store, secret, Host/Origin 설정도 함께 필요합니다.
npm start
```

Stage 228에서는 `synthetic` provider와 `https://*.example.invalid` fixture만 허용합니다.
기존 데이터를 이관·복사·backfill하지 않으며, 실제 provider는 후속 승인 전 실행할 수
없습니다. 계층·API·snapshot rollback 계약은
`docs/stage228_fresh_integration_store.md`를 따릅니다.

Stage 229의 입지카드·예측·월간 리포트는 Stage 228 이후 새로 저장된 관측과
`stage229-deterministic-signal-fixture`만 사용합니다. 세 플래그는 모두 기본값이 `false`이며,
실제 관광·검색량·trend·SNS provider, credential, scheduler와 quota 트래픽은 Stage 231 전까지
금지됩니다. 최소 반복 관측이나 익명 peer 표본이 부족하면 결과를 만들지 않고
`insufficient-data`와 다음 수집 CTA를 반환합니다.

```powershell
npm run test:stage229
$env:V2_INTEGRATION_RELIABILITY_ENABLED = "true"
$env:V2_INTEGRATION_LOCATION_CARD_ENABLED = "true"
$env:V2_INTEGRATION_BUSINESS_REPORT_ENABLED = "true"
$env:V2_INTEGRATION_INSIGHTS_PROVIDER = "deterministic-fixture"
# Stage 226~228의 auth, UI, platform core, fresh-store 설정도 함께 필요합니다.
npm start
```

알고리즘·business-safe 공개 계약은 `docs/stage229_location_forecast_monthly_report.md`,
기능 차단과 snapshot 복구 순서는 `docs/stage229_rollback_runbook.md`를 따릅니다.

Stage 224 기능 원장과 신규 수집 예산을 고정 commit에서 다시 생성·검증하려면 다음을
실행합니다.

```powershell
npm run stage224:inventory
npm run test:stage224
```

## 데이터 통합 원칙

- 기존 V2·Cluster 수집 파일, DB, cache, output은 통합 store로 이관하지 않습니다.
- 통합 store는 빈 상태에서 시작하며 승인된 provider를 통해 새로 수집합니다.
- Cluster는 기능·계약·검증 규칙의 참조 원천이지 배포 또는 runtime data 원천이
  아닙니다.
- 외부 API 자격증명은 승인된 V2 환경에 별도로 설정하며 Cluster 환경에서
  복사하지 않습니다.

## 주요 선택 환경변수

- `NAVER_CLIENT_ID`
- `NAVER_CLIENT_SECRET`
- `NAVER_SEARCHAD_API_KEY`
- `NAVER_SEARCHAD_SECRET_KEY`
- `NAVER_SEARCHAD_CUSTOMER_ID`
- `V2_UI_V3_ENABLED` (기본 `false`)
- `V2_INTEGRATION_AUTH_ENABLED` (기본 `false`)
- `V2_INTEGRATION_PLATFORM_CORE_ENABLED` (기본 `false`, auth 의존)
- `V2_INTEGRATION_FRESH_COMPANY_ENABLED` (기본 `false`, auth·platform core 의존)
- `V2_INTEGRATION_FRESH_OBSERVATION_ENABLED` (기본 `false`, fresh company 의존)
- `V2_INTEGRATION_DATA_DIR` (Stage 228 활성화 시 필수인 신규 절대 경로)
- `V2_INTEGRATION_FRESH_PROVIDER` (Stage 228에서는 `synthetic`만 허용)
- `V2_INTEGRATION_RELIABILITY_ENABLED` (기본 `false`, fresh observation 의존)
- `V2_INTEGRATION_LOCATION_CARD_ENABLED` (기본 `false`, reliability 의존)
- `V2_INTEGRATION_BUSINESS_REPORT_ENABLED` (기본 `false`, fresh observation 의존)
- `V2_INTEGRATION_INSIGHTS_PROVIDER` (Stage 229에서는 `deterministic-fixture`만 허용)

실제 값은 저장소에 기록하지 않습니다. 데이터 경로와 인스턴스 유형은 선택한
V2 정본 manifest를 따릅니다.
