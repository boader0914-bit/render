# 데이터랩 재구축 N5-D1 보고서

작성일: 2026-08-14
범위: 네이버 Place 광고 표식 관측 정리 및 객실 공급자 표식 fixture 수집기 구현

## 1. 경남 글램핑 광고 표식 관측

동일 브라우저 검색 세션에서 `경남 글램핑` 결과를 2페이지까지 확인했다. 업체 카드에
실제로 표시된 `광고` 버튼만 광고로 분류했으며, 같은 업체가 광고 표식 없이 다시 나타난
자연 노출은 광고로 집계하지 않았다.

### 1페이지 광고 노출 순서

| 광고 순서 | 업체명 | Naver Place ID |
|---:|---|---:|
| 1 | 합천H글램핑 | `1000421329` |
| 2 | 럭셔리 비토섬 제이글램핑 | `1995649140` |
| 3 | 노랑카라반 | `1763628760` |
| 4 | 블루모어 글램핑 리조트 | `2082850577` |
| 5 | 시선글램핑 | `1037385737` |
| 6 | 오스테이 글램핑n한옥펜션 | `1054241746` |
| 7 | 아르비토 글램핑 | `2000486899` |
| 8 | 옥돌캠핑장 | `2092090019` |
| 9 | 솔솔리조트 | `1641495459` |

2페이지는 목록 끝까지 로딩한 27개 업체 카드에서 `광고` 표식이 0개였다. `솔솔리조트`,
`옥돌캠핑장`처럼 1페이지에서 광고였던 업체가 2페이지에 광고 표식 없이 나타날 수 있으므로,
광고 여부는 업체의 고정 속성이 아니라 `검색어 + 관측 시각 + 페이지 + 노출 위치`에 결합된
관측값으로 저장해야 한다.

첫 화면에 보이는 상단 카드만 읽으면 하단 광고를 누락한다. 페이지의 목록을 끝까지 로딩한 뒤
각 업체 카드 내부의 명시적 `광고` 표식을 판별해야 한다. 광고 결과와 순서는 시각, 위치 및
세션에 따라 바뀔 수 있다.

## 2. N5-D1 객실 공급자 표식 계약

양성 fixture는 Place ID `1460523479`에서 브라우저로 확인한 객실 섹션의 최소 정제 관측값만
보존한다.

| 항목 | 정제 fixture 값 | 결과 |
|---|---|---|
| 객실 헤더 | `객실6` | `roomCount=6` |
| 헤더 보조 표식 | `[캠핑톡]` | 명시적 공급자 표식 |
| 표준 채널 ID | - | `campingtalk` |
| 표준 채널명 | - | `캠핑톡` |
| 증거 수준 | - | `high` |
| 증거 유형 | - | `explicit_room_header_provider_marker` |

`high`는 관측 당시 객실 헤더에 해당 표식이 직접 표시됐다는 증거 수준이다. 캠핑톡의 계약 상태,
실제 재고 연동 또는 결제 완료를 독립적으로 증명한다는 의미는 아니다.

양성 fixture SHA-256:
`176356a72dd090d61cad7dd18656ddd2529ce9bf6511d245cb864a9d574c4b3b`

## 3. 구현 경계

- fixture 입력은 정확한 JSON key와 `sanitized_visible_dom_fixture` capture kind만 허용한다.
- 객실 헤더는 `객실 + 양의 정수` 형식만 허용한다.
- 공급자 표식은 `[채널명]` 또는 `【채널명】`처럼 명시적으로 괄호가 있는 경우만 인정한다.
- 알려진 별칭은 `campingtalk`, `naver`, `nol`, `yeogi`, `ddnayo`, `onda`로 표준화한다.
- 알 수 없는 표식은 추측하지 않고 `mappingStatus=unmapped`, 증거 수준 `medium`으로 남긴다.
- 표식이 없으면 객실 수만 채택하고 채널은 `absent`로 남긴다.
- 중복 DOM 관측은 값이 같을 때만 허용하며 객실 수 또는 표식이 충돌하면 실패한다.
- raw HTML, Provider 원문, URL, header, cookie 및 인증값을 입력 구조에 저장할 수 없다.
- one-shot은 `tests/fixtures` 아래 JSON 읽기만 허용하며 live mode와 출력 파일 쓰기가 없다.

## 4. 오프라인 검증

Node `26.5.0` 실행 파일로 `scripts/test_v2_naver_place_room_provider_marker.cjs`를 실행했다.

| 검증 | 결과 |
|---|---|
| 양성 fixture 객실 수 | PASS, `6` |
| 공급자 표식 | PASS, `[캠핑톡]` |
| 표준 채널 | PASS, `campingtalk` / `캠핑톡` |
| 증거 수준 | PASS, `high` |
| 표식 없음 | PASS, `absent`, 채널 추론 없음 |
| 미등록 표식 | PASS, `unmapped`, 채널 추론 없음 |
| 중복 동일 관측 | PASS |
| 객실 수·공급자 충돌 | PASS, fail-closed |
| 원문·추가 key 입력 | PASS, 거부 |
| fixture 디렉터리 외부 읽기 | PASS, 거부 |
| one-shot 단일 JSON 출력 | PASS |
| 비밀 패턴 출력 검사 | PASS |
| 전체 assertions | PASS, `65` |
| 외부 요청 | `0` |
| 운영 쓰기 | `0` |

## 5. 미구현 및 다음 승인 경계

- 실제 Place 페이지에서 객실 헤더를 가져오는 live transport는 구현하거나 실행하지 않았다.
- DOM selector 변화에 대한 실제 페이지 검증은 아직 수행하지 않았다.
- Place ID `35644668` 월명 글램핑은 호출하지 않았다.
- 결과를 회사 master나 운영 DB에 반영하지 않았다.
- commit, push, PR 및 Render 변경을 실행하지 않았다.

다음 N5-Live에서는 별도 승인된 Place ID와 요청 예산으로 실제 페이지를 정확히 1회 읽고,
정제된 `headingText`와 `extraText`만 parser에 전달해야 한다. raw HTML과 Provider 원문은 저장하지
않으며, selector 불일치나 표식 모호성이 발생하면 fallback 없이 중단해야 한다.

HANDOFF_REBUILD_N5_D1
- positive_fixture_place_id: 1460523479
- positive_fixture_digest: 176356a72dd090d61cad7dd18656ddd2529ce9bf6511d245cb864a9d574c4b3b
- observed_room_count: 6
- observed_provider_marker: [캠핑톡]
- standard_channel_id: campingtalk
- standard_channel_name: 캠핑톡
- evidence_level: high
- evidence_type: explicit_room_header_provider_marker
- offline_tests: PASS, 65 assertions
- external_requests: 0
- operational_writes: 0
- raw_provider_responses_stored: 0
- wolmyeong_place_35644668_calls: 0
- commits: 0
- pushes: 0
- render_changes: 0
- blockers: live DOM selector and current marker remain unverified for the N5 target
- next_approval_required: N5-Live
END_HANDOFF_REBUILD_N5_D1
