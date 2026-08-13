# V2 네이버 예약업체 식별 계약

기준 커밋: `b1ba55993ef104a698ebafa54c2309f6dc820a05`
실행 소스 기준: `b5de9c40199f40a4409f93b1b66f0b9ccea17a83`
collector blob: `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`
Phase 2 live pair SHA-256: `1f06f3fa167f9bf3f5bc2cf67445e42d49bb9d45357efbf29cfd934b083251ab`

이 문서는 UI가 아니라 동결된 V2 collector와 bounded transport 코드를 기준으로 한다. Phase 3
live pair는 승인된 요청 예산 2회를 재시도 없이 실행했으며, 원형 성공과 replay exact parity는
확인했지만 해시 복제본의 독립 live 요청이 HTTP 405로 차단되어 independent live parity는 실패했다.

## 1. 입력과 실행 경로

Phase 3 입력은 Phase 2 live 자연순위 1위에서 이미 확보한 Place ID다. 따라서 Phase 3 pair는
Place 목록 GET을 다시 호출하지 않는다.

```text
Phase 2 natural Place ID
  -> getNaverBookingBusiness(placeId, companyOrdinal=1)
  -> executeBoundedInventoryGraphql(naver_booking_business)
  -> createNaverBoundedInventoryLiveTransport
  -> POST pcmap-api.place.naver.com/graphql
  -> V2 parser
  -> normalized booking identity audit
```

원형 collector에서 변경 없이 추출해 실행하는 함수는 다음 네 개다.

- `assertNaverTransportAvailable`
- `throwIfNaverAccessBlocked`
- `executeBoundedInventoryGraphql`
- `getNaverBookingBusiness`

추출한 함수의 결합 SHA-256은 오프라인 증거에서
`ec8c6e50732adba8720d5f43e5cd25fe36d79623f3bc3728196d69743e40340f`다.
해시 복제본은 Phase 1 source manifest의 20개 파일을 byte hash와 Git blob으로 검증한 뒤 별도
디렉터리에 복사한다.

## 2. GraphQL 요청 계약

| 항목 | 고정값 |
|---|---|
| method | `POST` |
| origin | `https://pcmap-api.place.naver.com` |
| path | `/graphql` |
| redirect | `manual` |
| operation | `naver_booking_business` |
| operationName | `naverBookingBusiness` |
| variables | `id`, `isNx` |
| `id` | 입력 Place ID와 정확히 동일한 문자열 |
| `isNx` | `false` |
| company ordinal | `1` |
| concurrency | `1` |
| target request budget | `1` |
| pair external request budget | `2` |
| timeout | live target별 25초 |
| response upper bound | live target별 2 MiB |
| retry / fallback | `0 / 0` |

GraphQL document는 `placeDetail`의 `base.id`, `base.name`과 `naverBooking`의
`bookingBusinessId`, `naverBookingUrl`, `naverBookingHubUrl`만 요청한다. query 본문과 SHA-256
`b248d4911391626ace0a2c7499e3a9be0b0af89dfd0e86fe3ef2c2ae2450d942`도 고정한다.

endpoint, method, redirect, operationName, query 또는 변수 집합이 달라지면 요청 전에
fail-closed한다. 두 번째 요청, 예약 상품 `searchBizItem`, 날짜별 `dailySchedule`, booking HTML,
과거 ID fallback은 허용하지 않는다.

## 3. 응답 분류 계약

| Provider 응답 | 정규화 분류 |
|---|---|
| 유효한 1~30자리 숫자 `bookingBusinessId` | `resolved` |
| `business.naverBooking === null` | `zero` |
| recovery probe에서 `naverBooking` 필드 없음 | `zero` |
| GraphQL `errors` | `unavailable` |
| data/business 누락 또는 malformed booking | `unavailable` |
| malformed JSON, HTTP 5xx, timeout, oversized | `unavailable` |
| `business === null` | `failed / COLLECTION_FAILED` |
| HTTP 403, 429 또는 challenge HTML | `failed / NAVER_ACCESS_BLOCKED` |

`zero`는 Provider가 예약 노출 없음 상태를 명시한 경우에만 사용한다. 통신·parse·schema 오류를
`zero`로 바꾸지 않는다. live 원형 결과가 `resolved` 또는 `zero`가 아니면 복제본 live 호출 전에
중단한다.

## 4. 비교와 저장 계약

동일 정제 응답 replay는 분류, ID hash, URL 존재 여부, Provider 상태, 오류 코드, query·요청 계약이
exact parity여야 한다. 독립 원형·복제본 live도 같은 항목이 모두 일치해야 통과한다. ID 원문 대신
SHA-256을 pair 결과에 저장한다.

허용하는 comparison-only 파일은 정규화 audit, sanitized replay와 `pair-result.json`이다. header,
cookie, credential, full request URL, raw Provider response 전체는 저장하지 않는다. 이 파일은 V2
native artifact가 아니다. `네이버예약사업자ID`와 `네이버예약URL`을 기존 CSV/XLSX writer에
통합하는 작업도 이번 identity-only 단계에는 포함하지 않는다.

## 5. live 승인 경계와 실행 결과

승인 대상 job은 `docs/v2_booking_business_live_job.proposal.json`이며 canonical digest는
`6494f3f05642bf59613ceb3a7414b7c459aef2cd69c7bcb9b3023f9be31277bb`다. 다음 세 gate가 모두
정확히 일치해야 live pair가 열린다.

- `V2_BOOKING_BUSINESS_LIVE_APPROVED=N3-Live`
- `V2_BOOKING_BUSINESS_LIVE_PAIR_BUDGET=2`
- `V2_BOOKING_BUSINESS_APPROVED_JOB_SHA256=6494f3f...277bb`

원형 1회가 terminal일 때만 해시 복제본 1회를 실행한다. replay는 외부 요청 0이다. 승인 전 live
호출, commit, push, Render 변경은 실행하지 않는다.

`승인 N3-Live` 실행 결과는 다음과 같다.

| 대상 | 외부 요청 | HTTP | 분류 | identity hash | 결과 |
|---|---:|---:|---|---|---|
| 원형 | 1 | 200 | `resolved` | 생성됨 | 성공 |
| 원형 정제 replay | 0 | 200 | `resolved` | 원형과 일치 | exact parity |
| 해시 복제본 | 1 | 405 | `failed / NAVER_ACCESS_BLOCKED` | 없음 | 실패 |

세 실행의 source function digest, query digest, method, origin, path, operationName과 변수 이름은
동일했다. 승인된 외부 요청 2회를 모두 소진했으며 재시도하지 않았다. 원형과 replay는 같은 예약업체
ID hash와 URL 존재 여부를 반환했으므로 parser/copy replay 계약은 확인됐다. 두 번째 독립 요청의
HTTP 405 원인은 저장된 정규화 audit만으로 확정할 수 없으며 Provider 원문은 저장하지 않았다.

따라서 현재 판정은 `offline exact parity PASS`, `same-response replay exact parity PASS`,
`independent live parity FAIL`이다. 이 상태에서는 Phase 3 변경을 구현 완료로 선언하거나
`N3-Commit`으로 진행하지 않는다.
# N3-D1 Diagnostic Addendum

The original-plus-copy live pair is closed after the copied request returned HTTP 405. The current live-capable command can execute only the hash-copied source closure, exactly once, after a separately committed and approved diagnostic change.

Before `fetch`, the child validates and hashes the controlled application request envelope. The frozen envelope is `v2-booking-business-fetch-envelope.v1` with SHA-256 `2078ad1e1f436f524058822079837a8ab222eea7e54b375a7ad7fc2bba378d1d`. It covers the method, endpoint path, redirect mode, exact controlled header names and value hashes, body byte count and hash, operation, variables, Place ID hash, and query hash. It is not a packet capture; Node 26.5.0 and bundled Undici 8.7.0 are pinned separately for transport runtime parity.

Safe response diagnostics store only status, content-type class, response-header timing, bounded fetch failure class, bounded block subtype/status, and numeric retry-after for HTTP 429. Raw request values, response headers, Provider bodies, cookies, and credentials are never stored.

The copy-only proposal digest is `35875d7b67f83deff6abe46e8deb606cb6f8506fdd641030f9a829cf51fdc308`. It permits one `naverBookingBusiness` POST from the copied source only. It permits no original execution, replay, Place GET, booking-item or schedule request, retry, fallback, or operational write.
