# Stage 228 신규 통합 store와 수집 경계

## 범위와 전제

Stage 228은 기존 V2·Cluster 수집 데이터의 migration, backfill 또는 dual-write가 아니다.
빈 `glamping-datalab-v2-fresh-integration-store`를 bootstrap하고 승인된 신규 수집만
기록한다. 이 단계의 provider는 deterministic synthetic adapter이며 URL은
`https://*.example.invalid`로 제한된다. 실제 credential, 네트워크 호출과 비용은 없다.

Stage 227의 UI parity와 legacy rollback 증적은 `docs/stage227_completion_evidence.json`,
`docs/stage227_rollback_runbook.md`에 유지한다. Stage 228 flag가 꺼지면 Stage 227 경계와
기존 legacy UI/API routing을 그대로 사용한다.

## 실행 경계

다음 flag는 모두 기본 `false`다.

- `V2_INTEGRATION_FRESH_COMPANY_ENABLED`
- `V2_INTEGRATION_FRESH_OBSERVATION_ENABLED`

Stage 228 runtime은 두 flag를 함께 요구하고 `V2_INTEGRATION_AUTH_ENABLED`,
`V2_INTEGRATION_PLATFORM_CORE_ENABLED`에 의존한다. `V2_INTEGRATION_DATA_DIR`는 명시적인
절대 경로여야 한다. canonical path와 realpath를 검사해 기존 `DATA_DIR`, `OUTPUTS_DIR`,
`CONFIG_DIR`, 알려진 V2·Cluster data/cache/output 경로와 동일하거나 서로 포함하는
경우 bootstrap 전에 종료한다. symlink를 통한 우회도 허용하지 않는다.

Stage 228이 켜질 때 신규 auth store도 fresh data bootstrap보다 먼저 경계를 검사한다.
`V2_INTEGRATION_AUTH_STORE_PATH`가 `DATA_DIR` 내부라면
`DATA_DIR/fresh-integration/<file>` namespace만 허용한다. `DATA_DIR` 밖의 별도 절대
경로도 사용할 수 있지만 config/output/customer_db/history/company_master/tourism_data,
저장소 legacy 경계와 lexical·realpath가 겹치면 auth 파일을 열기 전에 종료한다.

repository 밖의 service, worker와 HTTP 계층은 store 파일을 직접 열지 않는다. 모든
파일 접근은 `scripts/integration/repositories/fresh_store.cjs`를 통하며 repository의
경로 guard와 감사 계수로 검사한다.

## 저장 계층

| 계층 | 저장 내용 | 외부 응답 |
| --- | --- | --- |
| Raw | 합성 provider 원문, content hash와 capture provenance | 금지 |
| Observation | quick/detail/OTA 표준 관측과 evidence 연결 | 내부 관리자 계약만 |
| Verified | 수동 승인·반려된 profile, before/after review | 승인된 필드만 |
| Derived | completeness, freshness, confidence, 보강 상태 | business-safe 투영 경유 |
| Business-safe | 역할·tenant로 제한된 업체 상세 요약 | 관리자/소유 사업자만 |

manifest에는 schema version, store kind, store ID, revision과 생성·갱신 시각을 기록한다.
JSON metadata는 임시 파일 작성·fsync·rename으로 교체하고, 관측·raw·audit는 append-only
JSONL chunk로 보존한다. PID/nonce/만료가 있는 파일 lock과 stale-lock 회수를 사용해
동시 mutation을 직렬화한다. snapshot은 새 store 내부 파일만 checksum과 함께 복제하며
rollback 전에 소유 store ID, schema와 checksum을 다시 검증한다.

## 수집과 identity

target seed는 이름·지역·주소와 synthetic source identity로 시작한다. discovery는 V2의
정규화 우선순위(place ID, booking business ID, name/address, name/region)를 코드로
재현하지만 기존 company master 파일은 읽지 않는다. companyId는 강한 ID가 있으면
`cmp_place_<placeId>`, 그 외에는 정규화 identity의 deterministic hash로 발급한다.
source key가 여러 company에 충돌하거나 동일 loose-name/region 후보가 생기면 자동
merge하지 않고 duplicate candidate로 보관한다. 호환 ID 입력은 identity link만 허용하며
상세값은 반드시 신규 관측에서 생성한다.

worker는 하나의 `clientRequestId`에 대해 멱등 run을 만들고 다음 순서로 처리한다.

1. target seed와 company discovery
2. quick raw/observation
3. detail raw/observation
4. OTA raw/observation
5. derived/business-safe projection 갱신

각 관측에는 `source`, `runId`, `observedAt`, `targetDate`, `channel`, `productKey`,
`evidenceId`와 provenance를 필수로 둔다. 동일 company/product/targetDate의 후속 run은
덮어쓰지 않고 별도 observation으로 보존한다. lease 소유권·만료, bounded retry/backoff,
cancel-requested/cancelled, checkpoint와 resume를 durable run 상태로 기록한다.

HTTP submit은 전체 수집을 기다리지 않고 durable queued job을 `202`로 반환한다. single-flight
background pump가 기본 한 stage씩 처리하고 stage 사이에 event loop를 양보하므로 진행 조회와
취소가 실제로 개입할 수 있다. 동일 worker는 자신이 가진 활성 lease를 다음 tick에 재사용하고,
다른 worker의 만료 lease만 takeover한다. 시작 시 due retry와 만료 lease를 복구하며, backoff
도래 시 unref timer가 pump를 깨운다. runtime close는 예약 timer와 진행 중 pump를 정리한다.

## 검수·권한·API

신규 HTTP 경계는 `/api/integration/fresh` 아래 additive route로만 제공된다.

- `GET /metadata`, `GET /companies`, `GET /companies/:companyId`
- `POST /runs`, `GET /runs/:clientRequestId`
- `POST /runs/:clientRequestId/cancel`, `POST /runs/:clientRequestId/resume`
- `POST /companies/:companyId/review`
- `GET|POST /snapshots`, `POST /snapshots/:snapshotId/rollback`

모든 route는 신규 auth session, Host/Origin, CSRF 정책을 재사용한다. 사업자는 server에서
자신의 company ownership을 검사하며 다른 tenant는 403이다. review와 snapshot mutation은
관리자 전용이고 민감 작업 재확인(step-up)을 요구한다. business-safe 응답에는 raw
payload, source URL, evidence ID, 내부 경로, lock/checkpoint 또는 다른 tenant 식별자를
포함하지 않는다.

fresh runtime에서는 `/outputs`, `/data`, `/db`, `/history`, `/config`, `/customer_db`,
`/company_master`, `/tourism_data` 등 legacy 파일 route를 URL 정규화 후 GET/HEAD 404로
차단한다. 두 fresh flag가 꺼진 명시적 rollback에서만 기존 route 동작을 복원한다.

V3 업체 상세은 PageHeader→completeness/freshness/confidence metrics→검수값→provenance
요약→변경 이력→반복 관측→보강 CTA 구조다. 수집 완료와 수동 검수 완료를 구분하며,
관측이 없거나 일부인 경우 값을 추정하지 않고 empty/partial 상태를 표시한다.

## 검증과 rollback

`npm run test:stage228`은 fresh bootstrap, legacy 경로 차단, 10,000건 append/replay,
quick→detail→OTA vertical slice, idempotency/retry/cancel/resume, review audit/snapshot
rollback, auth/CSRF/tenant/business-safe API, legacy 파일·auth path 차단, 중단 후 자동
재개와 관리자·사업자 네 조건 시각 QA를 실행한다.

runtime rollback 순서는 다음과 같다.

1. 두 Stage 228 fresh flag를 함께 `false`로 되돌린다.
2. server를 재시작해 Stage 227 platform-core 또는 `V2_UI_V3_ENABLED=false`의 legacy
   artifact/API routing을 재선택한다.
3. 신규 store는 삭제·이관하지 않고 격리 보존한다. 신규 asset cache는 Stage 225
   runbook에 따라 폐기한다.
4. store 내부 데이터 rollback이 필요한 경우 관리자 step-up 후 승인된 snapshot ID로
   복구하고 audit revision을 확인한다.
5. auth artifact가 함께 바뀐 경우 기존 session을 억지로 변환하지 않고 Stage 226의
   안전 재로그인 절차를 사용한다.

배포와 실제 provider 호출은 이 단계에서 수행하지 않는다.
