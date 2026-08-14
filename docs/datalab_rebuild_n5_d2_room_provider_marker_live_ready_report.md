# DataLab Rebuild N5-D2: Naver Place Room Provider Marker Live-Ready Report

## Objective

N5-D1의 객실 공급자 표식 계약을 변경하지 않고, 네이버 Place 숙박 홈의 객실
헤더를 정확히 한 번 조회할 수 있는 fail-closed one-shot 경로를 구현했다. 이번
단계에서는 fixture와 mock transport만 사용했으며 실제 Provider 호출은 0회다.

## Result

- 상태: `PASS (offline only)`
- live-ready entrypoint: `scripts/v2_naver_place_room_provider_marker_live_one_shot.cjs`
- 양성 fixture: Place ID `1460523479`, `객실6 [캠핑톡]`
- 추출 결과: 객실 수 `6`, 공급자 `캠핑톡`, 표준 채널 ID `campingtalk`, 증거 수준 `high`
- N5-Live 제안 대상: Place ID `35644668` (이번 단계에서는 호출하지 않음)
- 실제 외부 요청: `0`
- 운영 쓰기: `0`
- Provider 원문 저장: `0`
- commit / push / Render 변경: 모두 `0`

## Exact Request Contract

| 항목 | 고정값 |
| --- | --- |
| Method | `GET` |
| Origin | `https://pcmap.place.naver.com` |
| Path | `/accommodation/{placeId}/home` |
| Query parameters | 없음 |
| Redirect | `manual`; redirect 응답은 실패 |
| Request budget | `1` |
| Automatic retries | `0` |
| Automatic fallbacks | `0` |
| Timeout | 승인 job의 `timeoutMs`; 제안값 `15000` |
| Response limit | 승인 job의 `responseSizeLimitBytes`; 제안값 `1048576` |
| Accepted content | HTML 또는 XHTML |
| Room header | `h2.place_section_header` |
| Marker | `.place_section_header_extra` |
| Selector version | `naver-place-room-header.v1` |

응답은 메모리에서만 읽고, 객실 헤더의 가시 텍스트에서 객실 수와 명시적 대괄호
공급자 표식만 추출한다. 원문 HTML, 응답 헤더, 쿠키, 인증값은 파일이나 결과에
기록하지 않는다.

## Provenance Boundary

- fixture 입력은 `sanitized_visible_dom_fixture`로 기록한다.
- 실제 HTML에서 정제된 관측은 `sanitized_live_html_projection`으로 기록한다.
- 두 provenance를 같은 증거로 위장하지 않는다.
- 공급자 표식이 보이지 않는 경우는 `absent` 관측으로 남길 수 있지만, selector가
  사라졌거나 서로 충돌하는 객실 헤더는 구조 변경으로 보고 즉시 실패한다.
- 알 수 없는 공급자 문자열은 원문 표식과 `unmapped` 상태로 반환하되 추측해서
  기존 채널로 매핑하지 않는다.

## Safety Gates

live 실행은 다음 세 환경변수가 승인 job과 정확히 일치할 때만 열린다. 값은 이
보고서에 기록하지 않는다.

- `V2_NAVER_ROOM_MARKER_LIVE_APPROVED`
- `V2_NAVER_ROOM_MARKER_REQUEST_BUDGET`
- `V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256`

허용된 job 필드 외 입력, 다른 host/path/method, query parameter, redirect,
비 HTML 응답, 응답 크기 초과, timeout, 네이버 차단 응답, 다중/충돌 헤더,
요청 예산 불일치가 발생하면 fallback이나 retry 없이 중단한다.

## Offline Verification

Node `26.5.0`에서 다음 검증을 실행했다.

| 검증 | 결과 | Assertions |
| --- | --- | ---: |
| N5-D2 live one-shot 및 mock failure boundaries | PASS | 113 |
| N5-D1 marker contract | PASS | 67 |
| V2 full-product one-shot | PASS | 67 |
| V2 full-product inventory contract | PASS | 38 |
| V2 weekly channel contract | PASS | 64 |
| V2 weekly channel one-shot | PASS | 75 |
| Company master facility contract | PASS | 45 |
| Fresh company master builder | PASS | 21 |
| 합계 | PASS | 490 |

검증 범위에는 정상 fixture, 입력 스키마, live gate 불일치, method/origin/path,
redirect, timeout, content type, 크기 제한, HTTP 오류, 네이버 차단 분류, selector
누락과 충돌, 비밀 유출, raw 응답 비저장, 외부 경로 쓰기 금지, mock fetch 1회
상한이 포함된다. mock live-gate 검증도 실제 네트워크 socket은 열지 않았다.

## Integrity

- live proposal file SHA-256:
  `1036250128e1eac06bcac9c446133483738a9b4431a0e1e6f6782199fa4025ef`
- 승인용 canonical job digest:
  `dae734ce35fa3ed2ae082f51fbcb0c2abea0ab3f590130ceaee3f82e1526fccf`
- offline job fixture SHA-256:
  `e9f9ad07459592af5dad8c0d7e4bbf2d1cfcd17b8a18717504b7768d09a3ed36`
- sanitized HTML fixture SHA-256:
  `c08715a45331a4cdf086fb305c599eb2340856067250230672e402c73865db48`
- frozen collector blob:
  `bcbe229998da3afa6f31ee04375fb0766019e56f`
- `package-lock.json`과 collector 파일은 N5-D2에서 변경하지 않았다.

## Remaining Unknowns

- Place ID `35644668`의 현재 `/home` 응답이 서버 렌더링된 객실 헤더를 제공하는지는
  N5-Live 전까지 미확인이다.
- 현재 DOM이 고정 selector와 일치하는지 미확인이다. 일치하지 않으면 우회 selector,
  browser fallback 또는 추가 호출을 하지 않고 중단해야 한다.
- 월명 글램핑에 명시적 공급자 표식이 실제로 존재하는지 미확인이다. 표식 부재는
  채널 미사용의 확정 증거가 아니라 해당 시점의 `not observed` 증거다.

## Proposed N5-Live Approval

```text
승인 N5-Live:

현재 N5-D2 로컬 기준으로 Place ID 35644668의
GET https://pcmap.place.naver.com/accommodation/35644668/home
요청을 정확히 1회 실행한다.

승인 job digest:
dae734ce35fa3ed2ae082f51fbcb0c2abea0ab3f590130ceaee3f82e1526fccf

응답은 메모리에서만 처리하여 객실 수와 명시적 공급자 표식만 정제한다.
총 외부 요청은 최대 1회이며 retry, fallback, 운영 쓰기는 0으로 유지한다.

redirect, 차단 응답, 비 HTML, 1 MiB 초과, timeout, selector 누락·충돌이
발생하면 즉시 중단하고 추가 호출하지 않는다. Provider 원문, 응답 헤더,
쿠키 및 비밀값은 저장하거나 출력하지 않는다.

commit, push, Render 변경, DB·Web import 및 다른 Provider 호출은 실행하지 않는다.
```

HANDOFF_REBUILD_N5_D2
- live_ready_entrypoint: scripts/v2_naver_place_room_provider_marker_live_one_shot.cjs
- request_method: GET
- request_origin: https://pcmap.place.naver.com
- request_path: /accommodation/{placeId}/home
- room_header_selector: h2.place_section_header
- provider_marker_selector: .place_section_header_extra
- live_job_place_id: 35644668
- live_job_digest: dae734ce35fa3ed2ae082f51fbcb0c2abea0ab3f590130ceaee3f82e1526fccf
- request_budget: 1
- retries: 0
- fallbacks: 0
- offline_tests: PASS, 490 assertions
- actual_external_requests: 0
- operational_writes: 0
- raw_provider_responses_stored: 0
- package_lock_changed: false
- collector_changed: false
- commits: 0
- pushes: 0
- render_changes: 0
- approval_required: N5-Live
END_HANDOFF_REBUILD_N5_D2
