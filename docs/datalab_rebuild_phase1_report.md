# 데이터랩 재구축 Phase 1 기준선 보고서

작성 시각: 2026-08-13 KST
조사·구현 범위: 읽기 전용 Render 조사, 로컬 baseline, 오프라인 fixture, 승인된 N1-Live pair
실제 Provider 호출: 2 (원형 1, 해시 복제본 1)
Render·운영 데이터 변경: 0

## 1. 결론

V2의 마지막 정상 네이버 실행 기준은 커밋
`b5de9c40199f40a4409f93b1b66f0b9ccea17a83`으로 확인됐다. 확인된 정상 실행은
네이버 Place 숙박 목록 `main_place` 1회와 예약업체 식별
`booking_business_graphql` 1회를 실행하고 committed 상태로 끝났다.

첫 복제 대상은 호출과 결과 범위가 가장 작은 `main_place` 전용 경로로 선정했다.
이 경로는 네이버 Place 숙박 목록 첫 응답만 처리하고, 예약·가격·재고·지역 반복·OTA·저장을
실행하지 않는다. 기준 소스 20개를 해시 manifest로 고정했으며, 원본과 그 해시 복제본을
synthetic Apollo 응답으로 각각 1회 실행했다. 두 실행의 결과 구조, 50개 Place ID, 순위,
필드 존재 계약이 일치했고 실제 외부 요청과 운영 쓰기는 모두 0이었다.

`Approval N1-Live`에 따라 동일한 `경남 글램핑` 입력으로 원형과 해시 복제본을 각각
1회 실행했다. 두 요청은 모두 HTTP 200이었고 각각 자연 결과 50개, 광고 집계 18개를
반환했다. 안정 ID 50개가 모두 일치했으며 순위와 허용 필드 존재 차이는 0이었다.
총 외부 요청은 2, retry·fallback·운영 쓰기는 모두 0이었다.

## 2. 기준 무결성

| 항목 | 확인값 | 상태 |
|---|---|---|
| 저장소 | `boader0914-bit/render` | 확인 |
| 로컬 브랜치 | `recovery/v2-native-collector-baseline` | 로컬 전용 |
| worktree | `work/v2-native-collector-baseline` | 독립 |
| HEAD | `b5de9c40199f40a4409f93b1b66f0b9ccea17a83` | 확인 |
| V2 기준 collector blob | `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3` | 확인 |
| 참고 원형 commit | `4e4e1906e2967fe58df66f8ad67f832043d2763b` | 참고만 함 |
| 참고 원형 collector blob | `bcbe229998da3afa6f31ee04375fb0766019e56f` | 변경 없음 |
| package-lock SHA-256 | `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2` | 확인 |
| Node | `26.5.0` | 확인 |
| source manifest | `docs/v2_native_main_place_source_manifest.json` | 20개 파일 |
| source manifest digest | `89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40` | 확인 |

`4e4e190...` collector는 원형 참고점이고, 확인된 V2 정상 실행은 `b5de9c...`의
collector를 사용한다. 두 blob을 동일 파일로 간주하지 않았다.

## 3. Render 정상 실행 증거

### 배포

| 서비스 | 성공 시 활성 배포 | commit | 근거 |
|---|---|---|---|
| 2번 Web `srv-d9jf91v41pts73cj9bu0` | `dep-d9t1dffqj5pc73dlh20g` | `b5de9c...` | 03:23 KST Live, 다음 배포는 12:12 KST |
| 3번 Worker `srv-d9q6mrfavr4c73atllf0` | `dep-d9t61augekts73can9ig` | `b5de9c...` | 08:37 KST Live, 다음 환경 배포는 08:48 KST |

### 실행 타임라인

| KST | UTC 로그 시각 | 서비스 | 증거 |
|---|---|---|---|
| 08:44:56 | `2026-08-10T23:44:56.538Z` | Web | `/api/crawl`, operator/admin, `v2_collector_single_source.v2`, execution hash prefix `bab7688bd76b`, queued |
| 08:44:57 | `2026-08-10T23:44:57.141Z` | Worker | `main_place`, request ordinal 1, authorized |
| 08:44:57 | `2026-08-10T23:44:57.173Z` | Worker | `main_place`, request ordinal 1, started |
| 08:44:58 | `2026-08-10T23:44:58.564Z` | Worker | `booking_business_graphql`, request ordinal 2, authorized |
| 08:44:58 | `2026-08-10T23:44:58.588Z` | Worker | `booking_business_graphql`, request ordinal 2, started |
| 08:45:00 | `2026-08-10T23:45:00.134Z` | Web | payload retained, terminal committed |
| 08:45:00 | 동일 실행 | Worker | status ready, committed, resultStored true, writeCount 6 |

Worker 최종 로그의 실행 해시는
`bab7688bd76b09d1fd2d31b11fb5ef626cf14f3ed2b6c01af68bd64e808fe643`,
transaction receipt는
`4e062f4154ffc8bfaf31504f5e60a1044c4985d9e2dee04a120fed2025a03bff`다.
런타임은 Node `26.5.0`, undici `8.7.0`, OpenSSL `3.5.7`, Linux x64였고,
`providerAttemptCount=1`, `executedCallCount=2`, retry 0, fallback 0이었다.

Web provenance에는 `jobId`가 비어 있고 `jobStoreWrite=false`로 기록됐지만 Worker 최종
로그에는 `resultStored=true`, `writeCount=6`이 기록됐다. 따라서 Provider 실행과 Worker
transaction 저장은 확인됐지만, 일반 Web job store와 동일한 영속화 의미인지는 미확인이다.
로그에는 정확한 입력 keyword와 artifact 파일명이 없으므로 복원하지 않았다.

현재 3번 Worker는 `43e23ac...`에서 약 30초마다
`COLLECTION_WORKER_V2_TOP20_RUNTIME_INVALID`로 실패하며, Provider 시도와 실행 호출은
모두 0이다. 이번 로컬 baseline 작업에서는 이를 수정하지 않았다.

## 4. 실제 실행 경로

```text
POST /api/crawl
  -> trustedPreviewAdminCrawlPayload
  -> queueV2SingleSourceWorkerCollection
  -> collectionWorkerV2Top20Orchestrator.prepareTrustedAdmin(singleSource=true)
  -> Worker claim / preflight / heartbeat
  -> collection_worker_v2_top20_worker.cjs
  -> executeV2CollectorSingleSource
  -> executeV2Top20Collector
  -> runCollectorChild (child process exactly once)
  -> scripts/gyeongnam_glamping_crawl.cjs
  -> collectNaverMain / getNaverState
  -> createNaverLegacyCanaryLiveTransport
  -> GET https://pcmap.place.naver.com/accommodation/list?query=...
  -> extractApolloState / selectNaverOrganicResult / mapNaverItem
  -> CSV/XLSX/JSON/report/manifest creation in the full path
  -> signed artifact / transaction finalization
```

선정한 `main_place` probe는 같은 collector에서 Place 응답 직후 종료한다. 따라서 full path의
예약 상세, 가격, 재고, 파일 생성과 저장은 이 첫 검증에 포함되지 않는다.

## 5. V2 capability matrix

분류는 UI 존재가 아니라 코드, 실호출 로그, 산출물 증거를 기준으로 했다.

| 기능 | 분류 | 증거와 제한 |
|---|---|---|
| 네이버 Place 숙박 목록 snapshot | 실호출 확인 | `main_place` ordinal 1과 committed terminal 확인 |
| Place 안정 ID·자연순위 parsing | 실호출 동등성 확인 | 원형·복제본 각각 50개, 공통 안정 ID 50개, 순위·필드 존재 차이 0 |
| 네이버 광고 목록·광고 순서 | 집계 실호출 확인, 행·순서 미확인 | 두 실행 모두 aggregate `adCount=18`; 광고 원문 행은 저장하지 않아 목록·순서는 미확인 |
| 네이버 예약업체 식별 | 실호출 확인, 결과 미확인 | `booking_business_graphql` ordinal 2 실행 확인. 반환된 ID/zero/error 의미는 로그에 없음 |
| 예약 상품 | code/fixture만 확인 | `booking_items` 구현과 fixture 있음. 정상 실행 로그에 실제 호출 없음 |
| 일자별 가격·재고 | code/fixture만 확인 | `daily_schedule` 구현과 fixture 있음. 정상 실행 로그에 실제 호출 없음 |
| 네이버 지역 반복 수집 | code만 확인, V2 baseline 비활성 | `collectNaverRegional` 존재. 확인된 V2 profile은 `collectRegional=false` |
| 네이버 Search Ads keyword tool | code만 확인 | `/keywordstool` 호출 코드 존재. Render 7일 로그에 성공 증거 없음 |
| 네이버 DataLab 검색 트렌드 | code만 확인 | `/v1/datalab/search` 호출 코드 존재. Render 7일 로그에 성공 증거 없음 |
| 네이버 지역검색 공식 API | UI/future 범위, V2 미구현 | 실행 endpoint 증거 없음. V2 기능으로 분류하지 않음 |
| 공공데이터 API | 준비 코드/fixture, V2 미구현 | request builder·catalog·transport fixture는 있으나 V2 실호출·산출물 증거 없음 |
| NOL·떠나요·여기어때·ONDA | 이번 단계 제외 | 네이버 안정화 후 Provider별 후속 범위 |

## 6. 선택 경로와 dependency closure

선정 기능: 네이버 Place 숙박 목록 `main_place` 1회
선정 이유: 정상 로그가 있고, 호출 예산 1이며, 예약·가격·재고·OTA·운영 저장에 진입하기
전에 종료할 수 있는 가장 작은 수직 경로다.

manifest는 다음 root에서 정적 local `require` closure를 계산한다.

- `scripts/collection_worker_v2_top20_collector.cjs`
- `scripts/gyeongnam_glamping_crawl.cjs`

결과는 package와 lockfile을 포함해 20개 파일이다. 각 파일에 작업트리 SHA-256과 Git blob을
모두 기록했다. Windows CRLF 작업 파일과 Git의 LF 정규화 차이를 혼동하지 않도록 두 값을
분리했다.

외부 package는 `write-excel-file@4.1.1` 하나다. main-place probe에서는 workbook 경로가
도달 불가능하고 preload가 호출 시 즉시 실패시키므로 오프라인·live probe에 package가
필요하지 않다. full V2 산출물 검증에는 실제 package 설치가 필요하다.

## 7. 새 로컬 파일

| 파일 | 목적 |
|---|---|
| `scripts/v2_native_main_place_harness.cjs` | manifest 검증, exact copy 생성, 원본/복제 pair 실행, comparator, live 승인 gate |
| `scripts/v2_native_main_place_preload.cjs` | 허용 request 경계 검증, raw 미저장 sanitized capture, workbook write 차단 |
| `scripts/test_v2_native_main_place_harness.cjs` | 입력·경로·중복·비밀·네트워크·원본/복제 회귀 테스트 |
| `tests/fixtures/v2_native_main_place_job.json` | committed offline job |
| `docs/v2_native_main_place_source_manifest.json` | baseline dependency closure와 hash |
| `docs/v2_native_main_place_live_job.proposal.json` | 승인 대상 live job 명세 |
| `docs/datalab_rebuild_phase1_report.md` | 이 보고서 |

기준 collector와 기존 V2 파일은 수정하지 않았다.

## 8. 오프라인 검증

| 검증 | 결과 |
|---|---|
| Node 문법 검사 | PASS |
| source manifest 재계산·비교 | PASS, 20 files |
| Apollo parser 기존 test | PASS |
| Naver live transport 기존 fixture test | PASS |
| 새 harness 정상 pair | PASS |
| 원본 child fixture 호출 | 1, `main_place` only |
| 복제 child fixture 호출 | 1, `main_place` only |
| 실제 외부 요청 | 0 |
| 원본/복제 결과 exact parity | PASS |
| copied parser sanitized replay | PASS, 50 stable IDs |
| 잘못된 필드·줄바꿈·날짜 범위 | 차단 |
| 같은 run ID 재실행 | 차단 |
| 허용 root 외부 출력 | 차단 |
| live 승인 gate 없는 실행 | 차단 |
| secret scan | PASS |
| retry / fallback | 0 / 0 |
| 운영 쓰기 | 0 |

재현 명령:

```powershell
..\tooling\node-v26.5.0-win-x64\node.exe scripts/v2_native_main_place_harness.cjs manifest
..\tooling\node-v26.5.0-win-x64\node.exe scripts/test_v2_native_main_place_harness.cjs
..\tooling\node-v26.5.0-win-x64\node.exe scripts/v2_native_main_place_harness.cjs offline-pair --job tests/fixtures/v2_native_main_place_job.json
```

정식 오프라인 증거는
`outputs/rebuild-phase1/rebuild-phase1-main-place-offline-003/pair-result.json`에 생성된다.
`outputs/`는 Git ignore이며 운영 경로가 아니다.

sanitized replay는 원문 HTML 전체를 재생하는 검증이 아니다. 원본 parser가 선택한 Place의
안정 ID·순위·허용 필드 존재 계약만 canonical Apollo fixture로 만들어 copied parser에
재생한다. 따라서 원문 마크업의 모든 비관련 필드에 대한 byte-level 동등성은 미확인이다.

## 9. 발견한 기존 blocker

1. baseline의 기존 `scripts/test_collection_worker_main_place_probe.cjs`는 contract에
   `bookingRangeDays`를 넣지 않아 `top20 collection contract fields are invalid`로 실패한다.
   기준 파일을 수정하지 않았으며 새 harness에서는 올바른 12-field contract를 사용했다.
2. `npm ci --offline`은 `write-excel-file@4.1.1` tarball이 캐시에 없어 `ENOTCACHED`로 실패한다.
   첫 main-place probe는 workbook을 fail-closed 처리해 검증 가능하지만, full artifact 단계 전
   승인된 package 설치 또는 신뢰 가능한 cache가 필요하다.
3. 성공 로그는 Web `jobStoreWrite=false`와 Worker `resultStored=true`를 함께 보여준다.
   full V2 저장 계약은 Phase 3에서 별도 shadow artifact로 재검증해야 한다.
4. 정상 로그의 keyword와 artifact 파일 목록은 출력되지 않았다. 추측하지 않았다.

## 10. LIVE_CALL_PLAN

### 승인 대상

- 기능: 네이버 Place 숙박 목록 main-place snapshot
- job: `docs/v2_native_main_place_live_job.proposal.json`
- job approval digest:
  `9003421b3b7697f38906486ac4d05846fa3f0fc4b4bfb1a6267973906fa7b6e4`
- keyword: `경남 글램핑`
- 기간: `2026-08-13` 하루
- 원본: baseline source 1회
- replay: 원본 sanitized Place ID fixture를 copied parser에 1회, 외부 호출 없음
- 복제본: 해시 검증 후 격리 복제 source 1회
- 총 Provider 요청 상한: 2
- target별 요청 상한: 1
- retry: 0
- fallback: 0

### HTTP 계약

- method: `GET`
- origin: `https://pcmap.place.naver.com`
- path: `/accommodation/list`
- query parameter name: `query`
- redirect: `manual`
- timeout: target당 최대 25초
- response limit: 2 MiB

### 격리 저장

`outputs/rebuild-phase1/rebuild-phase1-main-place-live-001/` 아래에만 저장한다.
저장 대상은 sanitized capture, copied source, pair result다. Provider 원문, header, cookie,
credential은 저장하지 않는다. sanitized capture에는 request hash, status/content type,
Place ID, 순위, 필드 존재 여부만 남긴다.

### 비교 항목

- HTTP status pair와 parser success
- 결과 JSON schema와 key/type
- organic count와 observed rank count
- Place stable ID 수, 교집합, original-only/copy-only 수
- 같은 ID의 순위 이동 수
- name/category/address/review/booking 필드 존재 변화 수
- aggregate ad count
- child exit, Provider call count, retry, fallback
- raw 저장, 운영 쓰기, 비밀 유출 여부

두 호출 사이의 live 데이터 변화는 `liveObservation`에 분리하고, 단순 raw 차이를 구조 실패로
간주하지 않는다. HTTP 계약·schema·parser·호출 예산 위반은 즉시 실패다.

### 즉시 중단 조건

- HEAD, collector blob, lockfile 또는 20-file manifest 불일치
- 승인 job digest 불일치
- target당 1회 또는 pair 2회 초과
- origin/path/method/query parameter 계약 이탈
- 403, 429, challenge, timeout, oversized response 또는 Apollo parse failure
- 예약·가격·재고·지역·OTA endpoint 시도
- outputs 격리 root 외부 쓰기
- 운영 DB, Redis, Web import 또는 Render API 접근
- raw Provider 응답, cookie, header, credential 또는 비밀값 저장·출력
- 자동 retry 또는 fallback 발생

실패 시 두 번째 호출을 시작하지 않거나 즉시 pair를 종료한다. 재시도하지 않는다.

## 11. N1-Live 실행 결과

승인된 job digest
`9003421b3b7697f38906486ac4d05846fa3f0fc4b4bfb1a6267973906fa7b6e4`를 사용해 live pair
명령을 정확히 한 번 실행했다. 원형 또는 복제본에 대한 재시도는 없었다.

| 항목 | 원형 | 해시 복제본 |
|---|---:|---:|
| Provider 호출 | 1 | 1 |
| HTTP status | 200 | 200 |
| Apollo parse | 성공 | 성공 |
| 자연 결과 | 50 | 50 |
| 관측 순위 | 50 | 50 |
| Provider total | 401 | 401 |
| 광고 집계 | 18 | 18 |

비교 결과는 structural parity `true`, sanitized replay `true`, 공통 안정 ID 50,
원형 전용 ID 0, 복제본 전용 ID 0, 순위 변화 0, 필드 존재 변화 0이다. 두 sanitized capture의
SHA-256은 모두
`f9ef005694b7bb714f18e410166ac2d81a90d8b2f98b095fadcd7b58a8c273b7`로 일치했다.

증거 파일:

- `outputs/rebuild-phase1/rebuild-phase1-main-place-live-001/pair-result.json`
- pair result SHA-256: `a6e3b070dcaec15b6ecde8c736fa6b57d53c4468a49b01f1f28e53e637a7db93`
- 원형·복제본 sanitized capture

사후 검사에서 실제 외부 요청 2, 자동 retry 0, 자동 fallback 0, 운영 쓰기 0,
raw Provider 응답 저장 없음, 비밀 패턴 검출 0, 승인 출력 root 외부 파일 0을 확인했다.
collector blob과 lockfile SHA-256은 실행 전후 동일하다.

## 12. 다음 승인

live 동등성 검증은 완료됐다. commit/push/PR은 실행하지 않았으며, 로컬 변경을 보존하려면
`Approval N1-Commit`이 별도로 필요하다.

HANDOFF_REBUILD_PHASE_1
- verified_successful_commit: b5de9c40199f40a4409f93b1b66f0b9ccea17a83
- render_log_evidence: Web dep-d9t1dffqj5pc73dlh20g; Worker dep-d9t61augekts73can9ig; execution bab7688bd76b09d1fd2d31b11fb5ef626cf14f3ed2b6c01af68bd64e808fe643; main_place ordinal 1; booking_business_graphql ordinal 2; committed/resultStored=true/writeCount=6
- selected_v2_capability: Naver Place accommodation main-place snapshot, exactly one GET
- execution_path: POST /api/crawl -> single-source orchestrator -> V2 Worker -> executeV2CollectorSingleSource -> executeV2Top20Collector -> child collector -> Naver Place transport -> Apollo parser
- dependency_closure: 20 files in docs/v2_native_main_place_source_manifest.json
- source_hash_manifest: digest 89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40
- capability_matrix: Place live-confirmed; booking-business transport live-confirmed/result unknown; booking items, price, stock, Search Ads, DataLab code-only; regional inactive; Local Search/public data not V2; OTA excluded
- live_call_plan: original 1 + copied 1; GET pcmap.place.naver.com/accommodation/list; keyword 경남 글램핑; timeout 25s each; total budget 2; job digest 9003421b3b7697f38906486ac4d05846fa3f0fc4b4bfb1a6267973906fa7b6e4
- original_live_call: PASS; one GET; HTTP 200; organic 50; ranks 50; adCount 18; provider total 401
- copied_live_call: PASS; one GET; HTTP 200; organic 50; ranks 50; adCount 18; provider total 401
- replay_parity: PASS; 50 stable IDs; stable IDs and field presence matched; raw Provider response not used
- live_structural_parity: PASS; shared stable IDs 50; original-only 0; copied-only 0; rank changes 0; field-presence changes 0
- external_request_count: 2 (original 1 + copied 1)
- retries: 0
- fallbacks: 0
- operational_writes: 0
- secret_scan: PASS
- mismatches: existing baseline main-place test omits bookingRangeDays; Web jobStoreWrite=false versus Worker resultStored=true requires later storage-contract verification
- unknowns: live keyword/artifact names of historical run; booking_business response meaning; live ad rows; booking items/price/stock; Search Ads/DataLab live behavior
- blockers: npm ci --offline ENOTCACHED for write-excel-file@4.1.1; full artifact path not yet tested
- approval_n1_commit_required: yes; live parity passed, commit/push not executed
- recommended_phase_2_scope: after Approval N1-Commit, copy Place list/rank/ad output contract, then booking identity, booking items, daily price/stock one capability at a time
END_HANDOFF_REBUILD_PHASE_1
