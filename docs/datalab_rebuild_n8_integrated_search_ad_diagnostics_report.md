# DataLab Rebuild N8 Integrated Search Ad Diagnostics

Date: 2026-08-15 (Asia/Seoul)

## 결론

현재 배포된 N7 UI의 Place Live 수집은 네이버 Place 숙박 목록 응답을 읽지만,
네이버 통합검색 화면의 광고 영역은 자동으로 수집하지 않는다. UI의 `광고 캡처`는
광고를 서버에서 실행하는 명령이 아니라, 사용자가 네이버 검색 결과 화면에서 실행할
bookmarklet 코드를 복사하는 기능이다. bookmarklet이 내려받은 정제 JSON을 다시 UI에
가져와야만 광고가 표시된다.

따라서 현재 현상은 광고 parser의 단순 실패로 확정할 수 없다. 자동 수집 경로 자체가
아직 연결되지 않은 것이 직접 원인이다. 다음 단계에서는 먼저 Render와 같은 서버
환경의 단일 HTTP GET이 통합검색 HTML 안에서 명시적 `광고` 표식과 광고주 Place ID를
볼 수 있는지 1회 진단해야 한다.

## 현재 경로와 누락 지점

```text
현재 Place Live:
UI -> Web API -> Naver Place accommodation/list -> organic Place 결과

현재 N7 광고 경로:
UI에서 bookmarklet 복사
-> 사용자가 search.naver.com 결과 화면에서 직접 실행
-> 브라우저 DOM에서 광고 증거 추출
-> 정제 JSON 다운로드
-> UI에서 JSON 수동 import

필요한 자동 경로:
UI -> Web API -> 안전한 통합검색 transport -> 광고 증거 parser
   -> Place ID 기준 병합 -> UI 결과
```

N7은 브라우저에서 보이는 광고를 정제하는 계약과 수동 transport를 검증했지만,
Live Place 버튼과 이 transport를 자동 연결하지 않았다. 그러므로 일반 Place 수집 결과의
광고 수가 0인 것은 현재 구현 계약상 가능한 결과다.

## N8-D1 로컬 변경

| 파일 | 목적 |
| --- | --- |
| `scripts/v2_naver_integrated_search_ad_diagnostic.cjs` | 통합검색 HTML GET 1회와 광고 증거 추출을 위한 fail-closed one-shot 진단기 |
| `scripts/test_v2_naver_integrated_search_ad_diagnostic.cjs` | 요청 envelope, live gate, parser, 오류·timeout·비밀 유출 회귀 검증 |
| `tests/fixtures/v2_naver_integrated_search_visible_ads.sanitized.html` | 광고 4건과 중복 링크를 담은 비밀 없는 양성 fixture |
| `tests/fixtures/v2_naver_integrated_search_empty.sanitized.html` | 광고가 없는 음성 fixture |
| `package.json` | N8 check/test 명령 등록 |

동결 collector와 `package-lock.json`은 변경하지 않았다.

## 진단 계약

- Method: `GET`
- Origin: `https://search.naver.com`
- Path: `/search.naver`
- Query names: `where`, `query`
- Fixed `where`: `nexearch`
- Redirect: `manual`; redirect 수신 시 실패
- Cookie 및 Authorization header: 없음
- Request budget: 정확히 1
- Automatic retry/fallback: 0
- Operational writes: 0
- Raw HTML 및 광고 tracking URL 저장: 0
- 저장 허용 증거: 정제 업체명, Place ID, 광고 순서, 증거 수준, 응답 크기/hash
- 성공 판정: 명시적 `광고` label과 `ader.naver.com` 목적지에서 추출한 숫자 Place ID,
  정제 업체명이 모두 존재

## 오프라인 검증

Node 26.5.0에서 실행했다.

| 검증 | 결과 |
| --- | --- |
| N8 syntax check | 성공 |
| N8 diagnostic tests | 110 assertions 성공 |
| N7 visible-ad tests | 46 + 19 assertions 성공 |
| 기본 Place UI tests | 150 + 69 + 19 assertions 성공 |
| N8 외부 요청 | 0 |
| 운영 쓰기 | 0 |
| Provider 원문 저장 | 0 |
| 광고 tracking URL 저장 | 0 |

추가 검증 항목에는 exact job schema, request budget 1, live approval digest,
광고 4건 추출, Place ID 중복 제거, 광고 없는 응답, HTTP 오류, redirect,
잘못된 content type, 응답 크기 제한, access challenge, timeout, CLI child 실행,
오류 결과의 비밀값 제거가 포함된다.

## 무결성

- 작업 기준 commit: `227c385662f87d6e22e7424bf7343aa82ebac04e`
- 로컬 브랜치: `recovery/v2-naver-integrated-search-ad-diagnostics`
- 동결 원형 collector:
  `scripts/frozen_v2_4e4e190/gyeongnam_glamping_crawl.cjs`
- 동결 collector blob:
  `bcbe229998da3afa6f31ee04375fb0766019e56f`
- `package-lock.json`: 변경 없음
- Render 변경: 0
- 추가 Provider 호출: 0

현재 개발 경로의 `scripts/gyeongnam_glamping_crawl.cjs`는 동결 사본과 별개이며
blob은 `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`이다. 이번 작업에서는 어느 collector도
수정하지 않았다.

## N8-D1 Live 계획

승인 후 사용할 정확한 job은 다음과 같다.

```json
{
  "schemaVersion": "v2-naver-integrated-search-ad-diagnostic-job.v1",
  "runId": "n8-integrated-ad-live-001",
  "mode": "live",
  "keyword": "경남 글램핑",
  "timeoutMs": 15000,
  "responseSizeLimitBytes": 4194304,
  "requestBudget": 1,
  "automaticRetries": 0,
  "automaticFallbacks": 0,
  "fixtureScenario": "none"
}
```

- Job digest:
  `84c5ed5a2035530ca05f8d973bf83f2790f8eb6711fb6b50b8e1c8b2490de053`
- 최대 외부 요청: 1
- 허용 endpoint:
  `GET https://search.naver.com/search.naver?where=nexearch&query=<keyword>`
- 원문 응답 저장: 0
- 운영 쓰기: 0
- retry/fallback: 0

## 판정과 후속 분기

1. `advertisements-observed`이며 정제 업체명과 Place ID가 확인되면, 동일 transport를
   기본 Place UI 서버에 연결하고 Place ID로 organic 결과와 병합한다.
2. HTTP 200이지만 `no-viable-advertisements`이면 광고가 없다고 구현 완료로 선언하지
   않는다. 서버 응답과 실제 브라우저 DOM이 다르므로 headless browser 또는 브라우저
   extension 방식의 독립 transport가 필요하다.
3. redirect, challenge, content type 오류, timeout이면 즉시 중단한다. header/cookie 우회,
   retry, fallback은 추가하지 않는다.
4. 어떤 결과에서도 기존 Render 서비스나 운영 데이터는 변경하지 않는다.

## 승인 순서

먼저 로컬 진단 변경을 commit/push하는 `승인 N8-D1-Commit`이 필요하다. 그 뒤 별도
`승인 N8-D1-Live`에서 위 digest의 요청을 격리 환경에서 정확히 1회 실행한다. Live 결과가
확인되기 전에는 자동 광고 수집을 기본 UI에 연결하지 않는다.
