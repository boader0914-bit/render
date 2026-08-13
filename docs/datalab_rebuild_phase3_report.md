# 데이터랩 재구축 Phase 3 실행 보고서

작성일: 2026-08-13 KST
범위: V2 Place ID -> 선택적 네이버 예약 연동 ID GraphQL 경로의 로컬 구현·오프라인 및 승인 live 검증
실제 Provider 호출: 2 (원형 1 + 해시 복제본 1)
Render·운영 데이터 변경: 0

## 1. 결론

업체 식별의 기준은 Phase 2에서 수집한 네이버 Place ID다. 이 보고서의 Phase 3 작업은 업체 기본
식별자를 만드는 작업이 아니라, 그 Place ID에 예약 상품·가격·재고 기능을 연결할 수 있는
`bookingBusinessId`를 선택적으로 매핑하는 작업이다. 아래의 Phase 3 실패 판정은 이 예약 매핑에만
적용되며 Phase 2 Place 목록·순위·광고 수집 성공을 취소하지 않는다.

Phase 2에서 확인한 자연순위 1위 Place ID를 입력으로, 동결된 V2 collector의 예약업체 식별 함수와
bounded GraphQL transport를 변경하지 않고 실행하는 독립 harness를 구현했다. 원형 source와
20개 파일 해시 복제본은 각각 예약업체 식별 GraphQL 한 번만 실행한다. Place 목록, 예약 상품,
날짜별 재고, HTML 및 과거 결과 fallback은 호출 경계에서 차단된다.

13개 응답 시나리오와 273개 assertion이 Node 26.5.0에서 통과했다. 정상 fixture의 원형, 정제
replay, 해시 복제본은 exact parity다. 오프라인 외부 요청, 운영 쓰기, retry, fallback, raw Provider
응답 저장은 모두 0이다.

`승인 N3-Live`로 원형과 해시 복제본을 각각 정확히 1회 실행했다. 원형은 HTTP 200으로 예약업체
ID를 식별했고 원형 정제 응답 replay도 exact parity였다. 그러나 해시 복제본의 두 번째 독립 요청은
HTTP 405와 `NAVER_ACCESS_BLOCKED`로 종료됐다. 요청 계약은 동일했지만 독립 live parity는 실패했다.
승인 예산 2회를 모두 소진했으며 retry와 fallback은 실행하지 않았다.

현재 상태는 `오프라인 exact PASS / replay exact PASS / 독립 live FAIL`이다. 선택적 예약 매핑은
Phase 3 구현 완료와 `N3-Commit` 준비 상태로 분류하지 않는다. 기본 Place 업체 식별은 완료 상태다.

## 2. 기준 무결성

| 항목 | 확인값 | 상태 |
|---|---|---|
| Phase 2 기준 commit | `b1ba55993ef104a698ebafa54c2309f6dc820a05` | 일치 |
| source 기준 commit | `b5de9c40199f40a4409f93b1b66f0b9ccea17a83` | manifest와 일치 |
| collector blob 전/후 | `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3` | 동일 |
| package-lock SHA-256 | `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2` | 동일 |
| source manifest digest | `89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40` | 동일 |
| manifest source files | 20 | bytes·SHA-256·Git blob 일치 |
| Phase 2 report SHA-256 | `e4c2e56fc5ec9d778849f74ecb9e6043dc54b29bf8da19bf826a744795cdaec7` | 일치 |
| Phase 2 live pair SHA-256 | `1f06f3fa167f9bf3f5bc2cf67445e42d49bb9d45357efbf29cfd934b083251ab` | 일치 |
| Node | `26.5.0` | bundled runtime 사용 |

기존 V2 source 20개와 package-lock은 수정하지 않았다. 작업 브랜치는
`recovery/v2-booking-business-contract`이며 아직 로컬 전용이다.

## 3. 구현한 경로

상세 계약은 `docs/v2_booking_business_contract.md`에 기록했다.

```text
N2 natural rank 1 Place ID
  -> frozen getNaverBookingBusiness
  -> frozen executeBoundedInventoryGraphql
  -> bounded POST /graphql, operation naverBookingBusiness
  -> resolved / confirmed zero / unavailable / failed
  -> comparison-only normalized audit
```

Phase 3는 N2의 Place ID 증거를 재사용하므로 Place GET 호출 예산은 0이다. 예약 상품
`searchBizItem`, 날짜별 `dailySchedule`, 가격·재고, 지역, OTA도 0이다.

## 4. 생성 파일

| 파일 | 이유 |
|---|---|
| `scripts/v2_booking_business_child.cjs` | 동결 함수 추출, exact one-shot transport, 응답 정규화 |
| `scripts/v2_booking_business_harness.cjs` | 기준 검증, hash copy, original/replay/copy 실행과 비교 |
| `scripts/test_v2_booking_business_harness.cjs` | 요청 차단, 실패 분류, parity와 보안 회귀 |
| `tests/fixtures/v2_booking_business_job.json` | committed 대상 offline job |
| `docs/v2_booking_business_live_job.proposal.json` | N3-Live 승인 대상 exact job |
| `docs/v2_booking_business_contract.md` | 코드 근거 요청·응답·저장 계약 |
| `docs/datalab_rebuild_phase3_report.md` | 이 준비 보고서 |
| `docs/datalab_rebuild_phase4_prompt_draft.md` | 다음 booking item 단계 초안 |

## 5. 오프라인 검증

| 검증 | 결과 |
|---|---|
| 새 파일 문법 검사 | PASS |
| 기준 commit·collector·lockfile·source 20개 | PASS |
| 정상 ID | PASS, `resolved` |
| 명시적 null / 필드 없음 | PASS, confirmed `zero` |
| GraphQL errors / malformed booking | PASS, `unavailable` |
| business null | PASS, `COLLECTION_FAILED` |
| malformed JSON / HTTP 500 | PASS, `unavailable` |
| timeout / response oversize | PASS, `unavailable` |
| HTTP 403 / 429 / challenge HTML | PASS, `NAVER_ACCESS_BLOCKED` |
| endpoint·operation·variable 변조 | 요청 전 차단 |
| 두 번째 요청 | budget 초과 차단 |
| 같은 run ID 재실행 | overwrite 전 차단 |
| original -> replay exact parity | PASS |
| original -> hash copy exact parity | PASS |
| 기존 bounded inventory transport fixture | PASS |
| 기존 legacy inventory activation contract | PASS |
| 기존 legacy inventory server contract | PASS |
| Phase 3 assertions | PASS, 273 |
| 실제 외부 요청 / 운영 쓰기 | `0 / 0` |
| retry / fallback | `0 / 0` |
| Place / items / schedule 요청 | `0 / 0 / 0` |
| raw 응답·header·full URL 저장 | 없음 |

`scripts/test_naver_crawler_block_propagation.cjs`는 line 126의 Place HTML fallback 기대에서 실패했다.
동일 실패가 변경 전 N2 worktree에서도 재현되므로 Phase 3 회귀로 분류하지 않는다. Phase 3의 exact
bounded GraphQL 경로는 별도 403·429·challenge fixture로 모두 통과했다. 구형 Phase 2 harness는
Phase 1 HEAD만 허용하도록 고정되어 N2 commit에서 baseline mismatch를 반환하며 Phase 3 회귀로
사용할 수 없다. `scripts/test_naver_legacy_inventory_crawler.cjs`도 line 112에서
`NAVER_LEGACY_CANARY_CONTRACT_MISMATCH`로 실패했고 변경 전 N2 worktree에서 동일하게 재현됐다.
이는 전체 3업체·상품·일정 fixture의 기존 기준선 이슈이며, 이번 identity-only 변경에는 포함하지
않는다.

정식 오프라인 증거는 로컬 ignored 경로
`outputs/rebuild-phase3/rebuild-phase3-booking-business-offline-001/pair-result.json`에 있다.
offline job digest는 `8c160c2990aff932460c69d4426e52a8237a8495bf878eac62dcbb47c02998a2`다.
pair-result SHA-256은 `06d320dffdef3a55bedb809061ee1e9472ddb57b1ce505bfc1bb9f0ef76a8be0`다.

재현 명령:

```powershell
..\tooling\node-v26.5.0-win-x64\node.exe scripts/v2_booking_business_harness.cjs validate --job tests/fixtures/v2_booking_business_job.json
..\tooling\node-v26.5.0-win-x64\node.exe scripts/test_v2_booking_business_harness.cjs
```

## 6. LIVE_CALL_PLAN_N3 및 실행 결과

- job: `docs/v2_booking_business_live_job.proposal.json`
- canonical job digest: `6494f3f05642bf59613ceb3a7414b7c459aef2cd69c7bcb9b3023f9be31277bb`
- target provenance: Phase 2 live 자연순위 1위, Place ID hash `2da4b6a5...b20c`
- 원형 GraphQL 1회, replay 0회, 해시 복제본 GraphQL 1회
- 총 외부 요청 상한 2, target별 상한 1
- request: `POST https://pcmap-api.place.naver.com/graphql`
- operation: `naverBookingBusiness`; variables `id`, `isNx=false`
- timeout·response 상한: target별 25초·2 MiB
- concurrency / retry / fallback: `1 / 0 / 0`
- Place GET, booking item, schedule, HTML, historical, 지역, OTA 요청: 전부 0

원형이 `resolved` 또는 Provider-confirmed `zero`일 때만 복제본을 호출한다. replay와 복제본은
분류, HTTP 상태, ID hash, URL 존재 여부, 오류 코드, query와 요청 계약이 일치해야 한다.

즉시 중단 조건은 기준·job digest 불일치, target 1회 또는 pair 2회 초과, endpoint·operation 이탈,
403·429·challenge·timeout·oversize, 원형 unavailable/failed, identity hash 불일치, 미승인 Provider
호출, raw·secret 유출, 운영 쓰기, retry 또는 fallback이다. 실패 후 자동 재실행하지 않는다.

승인된 live pair를 정확히 1회 실행했다.

| 항목 | 원형 | replay | 해시 복제본 |
|---|---:|---:|---:|
| 실제 외부 요청 | 1 | 0 | 1 |
| HTTP | 200 | 200 | 405 |
| 분류 | `resolved` | `resolved` | `failed` |
| 오류 | 없음 | 없음 | `NAVER_ACCESS_BLOCKED` |
| booking-business ID hash | 생성됨 | 원형과 일치 | 없음 |
| booking URL 존재 | true | true | false |
| 종료 | 성공 | 성공 | 실패 |

세 target의 요청 audit은 모두 다음 항목이 일치했다.

- source function digest: `ec8c6e50732adba8720d5f43e5cd25fe36d79623f3bc3728196d69743e40340f`
- query SHA-256: `b248d4911391626ace0a2c7499e3a9be0b0af89dfd0e86fe3ef2c2ae2450d942`
- `POST https://pcmap-api.place.naver.com/graphql`
- operationName `naverBookingBusiness`, variables `id,isNx`

호출 감사 결과는 booking-business 외부 요청 2, Place 목록 0, booking items 0, dailySchedule 0,
retry 0, fallback 0, 운영 쓰기 0이다. 7개 text evidence에서 credential, authorization, cookie,
private key와 raw HTML 패턴은 0건이었다. Provider 원문은 저장하지 않았다.

두 번째 HTTP 405가 발생한 원인은 정규화 audit만으로 확정할 수 없다. 동일한 요청 계약임은
확인했으나, 일시적 Provider 정책·연속 요청 제한·응답 내용 중 어느 경우인지는 추측하지 않는다.
승인 예산을 모두 사용했으므로 추가 live 호출은 실행하지 않았다.

live 증거:

- run: `outputs/rebuild-phase3/rebuild-phase3-booking-business-live-001`
- 원형 audit SHA-256: `bc526c061660f958903e145ecc093dae50ff211b70c44bb91dbc7524629d540e`
- replay audit SHA-256: `d8861bc8357c473dcf98684f8d6774410f7686106d1a22d87ee522caac65a34f`
- 복제본 audit SHA-256: `56e9e67221478e51c9c767fae826e2eb17a77a3219a1b397bc35c9bc7b417708`
- failure SHA-256: `9ebb944ce5ede010bfed560b2eda5efd67250f68c88c611987f86a0f3cfdccde`
- `pair-result.json`: 생성되지 않음; strict parity failure가 정상적으로 fail-closed 처리됨

## 7. 현재 분류

| 기능 | 분류 |
|---|---|
| V2 booking-business 요청·parser | 코드 + offline exact parity 확인 |
| 원형 live booking-business | HTTP 200, `resolved` 확인 |
| same-response replay | exact parity 확인 |
| 해시 복제본 독립 live | HTTP 405 `NAVER_ACCESS_BLOCKED`, parity 실패 |
| native CSV/XLSX에 identity 반영 | 이번 단계 미구현 |
| booking items·가격 | 미구현, Phase 4 후보 |
| 날짜별 재고 | 미구현, 이후 별도 단계 |
| HTML·historical fallback | 의도적으로 제외 |

HANDOFF_REBUILD_PHASE_3
- baseline_commit: b1ba55993ef104a698ebafa54c2309f6dc820a05
- source_baseline_commit: b5de9c40199f40a4409f93b1b66f0b9ccea17a83
- collector_blob_before: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- collector_blob_after: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- lockfile_sha256: ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2
- source_manifest_digest: 89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40
- local_branch: recovery/v2-booking-business-contract; local only; no commit/push
- execution_path: N2 Place ID -> frozen getNaverBookingBusiness -> exact bounded GraphQL -> normalized comparison audit
- graphql_contract: POST pcmap-api.place.naver.com/graphql; naverBookingBusiness; id,isNx=false
- source_function_digest: ec8c6e50732adba8720d5f43e5cd25fe36d79623f3bc3728196d69743e40340f
- query_sha256: b248d4911391626ace0a2c7499e3a9be0b0af89dfd0e86fe3ef2c2ae2450d942
- offline_tests: PASS; 13 scenarios; 273 assertions; original/replay/hash-copy exact
- live_job_digest: 6494f3f05642bf59613ceb3a7414b7c459aef2cd69c7bcb9b3023f9be31277bb
- original_live_call: PASS; exactly 1 POST; HTTP 200; resolved; normalized identity hash generated
- replay_parity: PASS; external 0; identity hash and normalized contract exact
- copied_live_call: FAIL; exactly 1 POST; HTTP 405; NAVER_ACCESS_BLOCKED; no identity
- independent_live_parity: FAIL; strict mismatch, pair-result not created
- external_request_count: 2
- place_list_requests: 0
- booking_business_fixture_calls: 16
- booking_items_requests: 0
- daily_schedule_requests: 0
- retries: 0
- fallbacks: 0
- operational_writes: 0
- raw_provider_responses_stored: false
- live_secret_scan: PASS; 7 text evidence files; 0 forbidden patterns
- live_evidence: original bc526c061660f958903e145ecc093dae50ff211b70c44bb91dbc7524629d540e; replay d8861bc8357c473dcf98684f8d6774410f7686106d1a22d87ee522caac65a34f; copied 56e9e67221478e51c9c767fae826e2eb17a77a3219a1b397bc35c9bc7b417708; failure 9ebb944ce5ede010bfed560b2eda5efd67250f68c88c611987f86a0f3cfdccde
- existing_baseline_test_issues: block propagation line 126 and legacy inventory crawler line 112 fail identically on N2 baseline
- unknowns: cause of copied request HTTP 405; native artifact integration
- blockers: independent live parity failed; approved request budget exhausted
- approval_n3_live_required: completed; no additional live call authorized
- approval_n3_commit_required: no; do not request until the HTTP 405 path is investigated and a new live plan is separately approved
- recommended_phase_4_scope: bookingBusinessId -> searchBizItem only; no dailySchedule or OTA
END_HANDOFF_REBUILD_PHASE_3

## N3-D1 status update

The historical result above is preserved as executed: independent live parity failed. The current local follow-up is `recovery/v2-booking-business-diagnostics`; it adds an offline-exact application request envelope, safe response diagnostics, a permanent closure of the old two-call live pair, and a separately gated copied-source-only one-call path. See `docs/datalab_rebuild_phase3_d1_report.md`. No new Provider call, commit, push, or Render change has occurred, and Phase 4 remains blocked.
