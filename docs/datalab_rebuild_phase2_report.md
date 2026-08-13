# 데이터랩 재구축 Phase 2 보고서

작성 시각: 2026-08-13 KST  
범위: V2 네이버 Place 목록·자연순위·광고 및 native artifact 계약의 오프라인·제한 live 검증  
실제 Provider 호출: 2 (승인 N2-Live, 원형 1 + 해시 복제본 1)  
Render·운영 데이터 변경: 0

## 1. 결론

Phase 1 기준선에서 원형 collector의 Place-only fast profile을 그대로 실행하면 예약·가격·재고·
지역·OTA 호출 없이 native CSV·report·manifest writer와 성공 시 atomic directory rename까지
도달할 수 있음을 확인했다.

독립 harness는 원형, 원형의 정제 결과를 받는 해시 복제 replay, 해시 복제본 독립 실행을 각각
격리 자식 프로세스로 실행한다. 정상 fixture에서 자연 4행, 광고 3행을 만들었고 세 결과의
canonical artifact digest가 일치했다. 원형·복제본 fixture exact parity, same-response replay
exact parity, schema structural parity가 모두 `true`다.

`승인 N2-Dependencies`에 따라 lockfile을 변경하지 않는 `npm ci`를 정확히 1회 실행했다.
`write-excel-file@4.1.1`과 `fflate@0.8.3` 설치 및 lockfile integrity를 확인했고, 원형·replay·
해시 복제본 모두 실제 XLSX 2개를 생성했다. OOXML archive, sheet·열·행·cell type과 동적 시각을
제외한 semantic digest가 세 target에서 일치했다. 현재 N2-Live 전 dependency blocker는 해소됐다.

`승인 N2-Live`의 고정 job digest로 원형과 해시 복제본을 각각 정확히 1회 호출했다. 두 요청 모두
HTTP 200·parsed, 자연 50행·광고 18행이었고 자연 Place ID 50개와 광고 Place ID 18개의 집합 및
순서가 모두 일치했다. 원형 정제 응답을 복제본에 replay한 canonical artifact 계약은 정확히
일치했고, 독립 live 산출물 구조도 일치했다. 독립 요청 사이에서 6개 광고의 `adId`와
`adDescription`만 변동했으므로 이를 parser/writer 불일치가 아닌 live 동적 관측으로 분리했다.

## 2. 기준 무결성

| 항목 | 확인값 | 상태 |
|---|---|---|
| 기준 HEAD | `8adbb1d10ba0c137130662813ce0f3b2ccca4841` | 일치 |
| source 기준 commit | `b5de9c40199f40a4409f93b1b66f0b9ccea17a83` | manifest와 일치 |
| collector blob 전/후 | `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3` | 동일 |
| package-lock SHA-256 | `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2` | 동일 |
| source manifest digest 전/후 | `89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40` | 동일 |
| manifest source files | 20 | 전부 bytes·SHA-256·Git blob 일치 |
| Phase 1 report SHA-256 | `0ca2e150323623a0e6bf4bba0e694dd44c788064b4541895e6107520470dd016` | 일치 |
| Phase 1 live pair SHA-256 | `a6e3b070dcaec15b6ecde8c736fa6b57d53c4468a49b01f1f28e53e637a7db93` | 로컬 증거 확인 |
| Node | `26.5.0` | bundled runtime 사용 |
| 기준 source diff | 0/20 | 기존 파일 수정 없음 |

Phase 1 source manifest의 `baselineCommit`은 소스 dependency closure를 고정한 부모 commit을
가리킨다. Phase 2 branch HEAD는 Phase 1 산출물이 commit된 `8adbb1d...`다. 두 identity를
혼동하지 않았다.

## 3. Place·순위·광고 계약

상세 계약은 `docs/v2_place_artifact_contract.md`에 코드 근거와 함께 기록했다.

| 항목 | 확인된 V2 동작 |
|---|---|
| 자연 목록 | Apollo organic items, 원본 순서 |
| 자연 순위 | `index + 1`, 최대 50행 |
| 광고 목록 | `adBusinesses` item refs, 원본 순서 |
| 광고 순서 | `index + 1`, 별도 최대 행 제한 없음 |
| 안정 ID | writer는 `item.id || ""` 사용 |
| 중복 | 자연 내부, 광고 내부, 자연·광고 교차 중복 모두 보존 |
| 누락·null | 기본 빈 문자열, 리뷰·평점 숫자 0 보존 |
| Provider total | report용 집계이며 실제 저장 행 수와 분리 |
| 재정렬·dedupe key | 없음 |

fixture limit 시 Provider natural total 999, ad total 777을 보존하면서 자연 50행, 광고 55행을
저장했다. UI가 광고에도 50행 상한이나 dedupe가 있다고 가정하면 V2 실동작과 다르다.

## 4. 산출물 계약과 분류

native writer의 role은 platform CSV, report, overall CSV, ads CSV, regional CSV, ddnayo CSV,
전체 workbook, 네이버 workbook이다. 별도로 `manifest.json`을 쓴다. 즉 native 파일 집합은
5 CSV + 2 XLSX + report + manifest, 총 9개다. fast profile에서는 지역과 OTA CSV가
header-only지만 파일 자체는 생성한다.

- CSV: UTF-8 BOM, 선언된 열 순서, comma·quote·newline escaping, formula prefix neutralization
- XLSX 요청: 전체 workbook 6 sheets, 네이버 workbook 4 sheets
- report: markdown, 실행 시각과 집계 포함
- manifest: `lodging-collection-manifest`, schema version 2, file roles와 counts
- native Place-only JSON: 없음
- native content digest: 없음
- comparison-only JSON: sanitized replay, provider/workbook audit, pair result

limited profile은 `.pending-{pid}-{random}`에 먼저 쓰고 manifest 완료 후 최종 디렉터리로 rename한다.
workbook 호출 시 주입 실패 테스트에서 final 0, pending 0으로 확인되어 부분 결과는 공개되지 않았다.

## 5. 생성 파일

| 파일 | 이유 |
|---|---|
| `scripts/v2_place_artifact_preload.cjs` | exact endpoint·budget·write root 차단, sanitized response capture, workbook 호출 감사 |
| `scripts/v2_place_artifact_harness.cjs` | baseline 검증, hash copy, original/replay/copy 실행 및 artifact comparator |
| `scripts/test_v2_place_artifact_harness.cjs` | 7개 시나리오와 보안·실패·parity 회귀 suite |
| `tests/fixtures/v2_place_artifact_job.json` | committed offline job 제안 |
| `docs/v2_place_artifact_live_job.proposal.json` | N2-Live 승인 대상 exact job |
| `docs/v2_place_artifact_contract.md` | Place·순위·광고·artifact 코드 계약 |
| `docs/datalab_rebuild_phase3_prompt_draft.md` | 예약업체 식별만 다룰 Phase 3 초안 |
| `docs/datalab_rebuild_phase2_report.md` | 이 보고서 |

기존 V2 source 20개, collector, package.json, package-lock은 변경하지 않았다.

## 6. 오프라인 검증

| 검증 | 결과 |
|---|---|
| 새 파일 문법 검사 | PASS |
| baseline 20-file 검증 | PASS |
| 기존 Apollo parser test | PASS |
| 기존 Place live transport fixture | PASS |
| 기존 limited activation contract | PASS |
| 새 regression suite | PASS, 306 assertions |
| 정상 자연+광고 | PASS, 4/3행 |
| 광고 없음 | PASS, 2/0행 |
| 빈 결과 | PASS, 0/0행 header-only |
| 자연·광고 중복 | PASS, dedupe 없이 순서 보존 |
| 누락·null | PASS, empty-cell 계약 보존 |
| 결과 상한 | 자연 50, 광고 55 보존 |
| CSV escaping·formula safety | PASS |
| workbook sheet·열·자료형 projection | PASS |
| 실제 XLSX binary | PASS, 세 target 각 2개 |
| XLSX OOXML archive | PASS |
| XLSX sheet·header·row·cell type | PASS |
| XLSX semantic parity | PASS, 동적 수집시각만 canonicalize |
| 부분 writer 실패 | final 0, pending 0 |
| 같은 run ID | overwrite 차단 |
| 외부 root write | 차단 |
| 예약 endpoint | 차단 |
| 2번째 Place 요청 | budget 초과 차단 |
| 실제 외부 요청 | 0 |
| retry / fallback | 0 / 0 |
| 운영 쓰기 | 0 |
| raw Provider 응답 저장 | 없음 |
| 비밀 패턴 검사 | PASS |

정식 오프라인 증거:

- `outputs/rebuild-phase2/rebuild-phase2-place-artifact-offline-005/pair-result.json`
- pair SHA-256: `040196a3cda87991718f758d2b1f3d36e46afcae44dd87a8c2c1b07bf40894e4`
- offline job digest: `713ea0fdcd59e4979cdf144138a750aef393060ea5695af685c6adaddc560465`
- 전체 workbook semantic digest: `e35ddbf8b75277f8e2b889fcd5d15a564c1320f570282eb956a142ee8ad2210b`
- 네이버 workbook semantic digest: `a2dda3e9425e7e35736753373d58c8b3c2dc92fd2a86311ec522e31472aef542`

재현 명령:

```powershell
..\tooling\node-v26.5.0-win-x64\node.exe scripts/v2_place_artifact_harness.cjs validate --job tests/fixtures/v2_place_artifact_job.json
..\tooling\node-v26.5.0-win-x64\node.exe scripts/test_v2_place_artifact_harness.cjs
..\tooling\node-v26.5.0-win-x64\node.exe scripts/v2_place_artifact_harness.cjs offline-pair --job tests/fixtures/v2_place_artifact_job.json
```

마지막 명령은 run ID overwrite를 금지하므로 새 증거가 필요할 때 review된 새 run ID를 사용한다.

## 7. dependency 승인 실행 결과

lockfile의 exact dependency는 다음과 같다.

- package: `write-excel-file@4.1.1`
- integrity: `sha512-MUnCnNtQrcZek832ZcU24uU0rSphFmKPD1DvIjXOlygVb93CV7Tme6H3jUTkxsMmjB2W7HIzERzjqTi5kui71A==`
- transitive: `fflate@0.8.3`
- fflate integrity: `sha512-tbZNuJrLwGUp3zshBtdy4W+ORxZuIh8a5ilyIEQDC5rY1f3U20JMry0Ll3WBzU58EZKsEuJFXhb5gwv8CsPvgA==`

승인된 명령을 정확히 1회 실행했다.

```powershell
..\tooling\node-v26.5.0-win-x64\npm.cmd ci --ignore-scripts --audit=false --fund=false
```

결과는 `added 2 packages`이며 package script는 `--ignore-scripts`로 실행하지 않았다. 설치 후에도
lockfile SHA-256은 `ba2e05d...`로 동일하고 collector blob과 source 20개 diff는 0이다. 설치된
version과 lockfile version/integrity가 일치하며 실제 XLSX 오프라인 검증도 통과했다.

## 8. LIVE_CALL_PLAN_N2 및 실행 결과

- job: `docs/v2_place_artifact_live_job.proposal.json`
- live job digest: `5514c78ecb7d367c145cf7e0bf099b9096963aec75518c624fb7712442c458bf`
- keyword: `경남 글램핑`
- 원형 1회, 해시 복제본 1회, replay 1회(외부 요청 0)
- 총 외부 요청 상한 2, target별 상한 1
- method/origin/path: `GET`, `https://pcmap.place.naver.com`, `/accommodation/list`
- query parameter 이름: `query`
- redirect: `manual`
- timeout: target별 25초
- response 상한: target별 2 MiB
- retry/fallback: 0/0

저장 허용 필드는 Place ID/name/category/address/review/rating/booking, room name·min/max,
promotion/micro review/ad ID·description과 이들로 원형 V2 writer가 만드는 정규화 필드다. request는
origin/path/parameter names/query hash만 보존한다. raw HTML, full URL, header, cookie, credential은
저장하지 않는다.

예상 native 파일은 6 CSV, 2 XLSX, report, manifest다. 비교는 HTTP·parse, natural/ad row 수, ID와 순서,
rank/order, overlap, 전체 CSV header/row, workbook sheet/type, report/manifest structure, 파일 집합,
exit와 digest를 포함한다.

원형 응답을 copied writer에 replay한 exact parity를 parser/writer 기준으로 사용한다. 원형과 복제본
독립 live 요청의 ID·순위·광고 변화는 `liveDynamicObservation`에 분리하며, 구조 계약이 같더라도
동적 값이 같다고 추측하지 않는다.

즉시 중단 조건은 baseline/job/dependency 불일치, target 1회 또는 pair 2회 초과, 승인 endpoint
이탈, 403/429/challenge/timeout/oversize/parse failure, 예약·가격·지역·OTA 접근, raw·secret 유출,
외부 root write, 운영 연결, retry 또는 fallback이다. 원형이 실패하면 복제 live 호출을 시작하지 않는다.

승인된 live pair를 재시도 없이 정확히 1회 실행했다.

| 항목 | 원형 | replay | 해시 복제본 |
|---|---:|---:|---:|
| 외부 요청 | 1 | 0 | 1 |
| HTTP / parse | 200 / parsed | 200 / parsed | 200 / parsed |
| 자연 결과 | 50 | 50 | 50 |
| 광고 결과 | 18 | 18 | 18 |
| 종료 코드 | 0 | 0 | 0 |
| native artifact 완전성 | PASS | PASS | PASS |

- Provider natural total: 원형·복제본 모두 401
- Provider ad total: 원형·복제본 모두 18
- 자연 Place ID: 공통 50, 원형 전용 0, 복제본 전용 0, 순서 일치
- 광고 Place ID: 공통 18, 순서 일치
- 중복 처리: 자연 내부 0, 광고 내부 0, 자연·광고 교차 7; 세 target에서 삭제 없이 동일 보존
- same-response replay: canonical artifact digest 정확히 일치
- 독립 live 구조: CSV/XLSX schema, sheet, 열, 자료형, 행 수, manifest key와 파일 role 일치
- 동적 관측: 6개 광고의 Place ID·순서는 유지되고 `adId`·`adDescription`만 변동
- pair result: `outputs/rebuild-phase2/rebuild-phase2-place-artifact-live-001/pair-result.json`
- pair SHA-256: `1f06f3fa167f9bf3f5bc2cf67445e42d49bb9d45357efbf29cfd934b083251ab`

사후 감사에서 request는 동일한 query hash의 `GET /accommodation/list`만 기록됐다. 예약·가격·재고·
지역·OTA 요청, retry, fallback, 운영 쓰기는 모두 0이다. 34개 text evidence에서 raw HTML,
cookie·authorization header, private key 및 credential 패턴은 발견되지 않았고 audit/capture의 raw,
header, full URL 저장 flag도 모두 `false`였다.

## 9. 현재 분류와 다음 단계

| 항목 | 분류 |
|---|---|
| Place 목록 parser | Phase 1·2 live + Phase 2 replay 확인 |
| 자연순위 writer | live native 50행, ID·순서 동등성 확인 |
| 광고 목록·순서 writer | live native 18행, Place ID·순서 동등성 확인 |
| 광고 메타데이터 | 독립 요청 6행의 `adId`·설명 변동을 동적 데이터로 분류 |
| CSV/report/manifest | replay canonical exact + 독립 live structural parity 확인 |
| XLSX 호출 계약 | native 호출·binary 생성 확인 |
| XLSX binary | replay semantic exact + 독립 live structural parity 확인 |
| Place-only native JSON | V2에 없음 |
| 예약업체 식별 | Phase 3 범위 |

Approval N2-Live는 완료했다. N2-Commit은 실행하지 않았다. 현재 다음 허용 단계는 변경 allowlist를
검토한 뒤 별도 `승인 N2-Commit`으로 local 변경을 commit·push하는 것이다.

HANDOFF_REBUILD_PHASE_2
- baseline_commit: 8adbb1d10ba0c137130662813ce0f3b2ccca4841
- baseline_parent: b5de9c40199f40a4409f93b1b66f0b9ccea17a83
- collector_blob_before: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- collector_blob_after: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- lockfile_sha256: ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2
- source_manifest_digest_before: 89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40
- source_manifest_digest_after: 89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40
- local_branch: recovery/v2-place-artifact-contract; local only; no commit/push
- place_contract: item.id; source order; optional fields empty; natural cap 50; ad array uncapped
- natural_rank_contract: overall_rank=index+1; no sort; no dedupe
- advertisement_contract: ad_order=index+1; adId/adDescription; overlap classified but rows preserved
- artifact_contract: native 5 CSV + 2 XLSX + report + schema v2 manifest (9 files); no native Place-only JSON; no native content digest
- native_writer_reused: yes for CSV/XLSX/report/manifest/atomic rename; XLSX OOXML semantics verified
- files_changed: 7 new files plus this report; existing V2 source 20 unchanged
- offline_tests: PASS; 306 assertions; 7 scenarios; original/replay/copy exact fixture and native XLSX semantic parity
- dependency_status: PASS; approved npm ci exactly once; write-excel-file@4.1.1 + fflate@0.8.3; lockfile unchanged
- live_job_digest: 5514c78ecb7d367c145cf7e0bf099b9096963aec75518c624fb7712442c458bf
- original_live_call: PASS; exactly 1 GET Place request; HTTP 200; parsed; natural 50; ads 18; exit 0
- copied_live_call: PASS; exactly 1 GET Place request; HTTP 200; parsed; natural 50; ads 18; exit 0
- replay_parity: PASS; 0 external requests; canonical CSV/XLSX/report/manifest contract exact after allowed time/output canonicalization
- live_structural_parity: PASS; natural Place IDs 50/50 and ad Place IDs 18/18 shared in exact order; schema/sheets/headers/types/rows/file roles match
- native_artifact_parity: all targets complete 9-file native set; replay canonical exact; independent live structural PASS; independent raw exact not asserted because 6 adId/adDescription pairs changed dynamically
- comparison_only_artifacts: sanitized replay, provider/workbook audits, pair-result.json
- external_request_count: 2 (original 1, replay 0, copied 1)
- booking_requests: 0
- price_inventory_requests: 0
- regional_requests: 0
- ota_requests: 0
- retries: 0
- fallbacks: 0
- operational_writes: 0
- raw_provider_responses_stored: false
- secret_scan: PASS; 34 text evidence files, 0 forbidden patterns; raw/header/full URL storage flags false
- mismatches: no Place-only native JSON/content digest; ad list has no 50-row cap; structured providerCallCounts is null in limited manifest; independent live changed adId/adDescription on 6 ads while Place IDs/order stayed equal
- unknowns: independent live byte-exact equality is intentionally unclaimed; booking-business identification and later capabilities remain outside Phase 2
- blockers: none for N2-Commit; commit/push remains separately approval-gated
- approval_n2_commit_required: yes
- recommended_phase_3_scope: after Phase 2 live/commit, isolate Place-to-booking-business-ID GraphQL only; no items/price/stock
END_HANDOFF_REBUILD_PHASE_2
