# DataLab Rebuild N5-Live: Naver Place Room Provider Marker Result

## Approval

- approval: `N5-Live`
- approved canonical job digest:
  `dae734ce35fa3ed2ae082f51fbcb0c2abea0ab3f590130ceaee3f82e1526fccf`
- run ID: `n5-room-marker-live-20260814-001`
- Place ID: `35644668`
- approved request budget: `1`
- retries: `0`
- fallbacks: `0`

## Execution Result

| 항목 | 결과 |
| --- | --- |
| 결과 확인 시각 | `2026-08-14T13:33:13+09:00` |
| Method | `GET` |
| Endpoint | `https://pcmap.place.naver.com/accommodation/35644668/home` |
| 외부 요청 | 정확히 1회 |
| Process exit code | `1` |
| 결과 | `failed` |
| 오류 코드 | `V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED` |
| Retryable | `false` |
| 추가 호출·재시도 | `0` |
| 운영 쓰기 | `0` |
| Provider 원문 저장 | `0` |
| commit / push / Render 변경 | `0` |

승인된 단일 GET은 응답을 받았으나 공통 네이버 접근 판정기가 차단 응답으로
분류하여 parser 전에 fail-closed 종료했다. 따라서 객실 수와 공급자 표식은 이번
실행에서 관측되지 않았으며, 이를 표식 부재나 채널 미사용으로 해석해서는 안 된다.

## Evidence Boundary

현재 one-shot 오류 framing은 안전한 일반 오류 코드만 출력한다. 공통 판정기는
`HTTP 403`, `HTTP 429`, 또는 Apollo marker가 없고 challenge pattern이 있는 HTML을
차단으로 분류하지만, 이번 terminal 결과에는 subtype, HTTP status, content type,
response byte count가 포함되지 않았다. Provider 원문을 저장하거나 요청을 반복하지
않았으므로 이번 실행만으로 세 원인 중 하나를 확정할 수 없다.

확인된 사실:

- live gate와 승인 job digest가 일치했다.
- 승인 endpoint에 대한 단일 실행만 있었다.
- runner가 `V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED`로 종료했다.
- retry와 fallback은 실행되지 않았다.
- 실행 전후 worktree에 live 산출물이나 Provider 원문 파일이 생기지 않았다.
- `package-lock.json`과 frozen collector blob은 변경되지 않았다.

미확인 항목:

- 정확한 block subtype과 안전한 HTTP status class
- 응답 content type과 크기
- 현재 `/home` 응답에 서버 렌더링된 객실 헤더가 포함되는지 여부
- Place ID `35644668`의 객실 수와 공급자 표식

## Recommended N5-D3 Scope

다음 실제 호출 전에 one-shot 오류 결과에 원문 없이 다음 allowlisted metadata만
포함하는 로컬 진단 수정을 구현해야 한다.

- `blockSubtype`: `http_403`, `http_429`, `challenge_html` 중 하나
- `httpStatusClass`: 정확한 status 또는 허용된 status class
- `contentTypeClass`: `html`, `xhtml`, `other`
- `responseBytes`: 승인된 상한 내 정수
- `retryAfterPresent`: boolean만 기록
- `requestAttempts`, `actualExternalRequests`, `operationalWrites`

Provider body, header 값, cookie, URL query, 비밀값은 계속 저장하거나 출력하지 않는다.
fixture로 세 block subtype과 정상 HTML을 검증한 후 별도 commit 승인을 요청하고,
그 다음 실행 환경을 분리한 단일 canary 여부를 결정한다. 이 단계 전에는 같은 요청을
다시 실행하지 않는다.

HANDOFF_REBUILD_N5_LIVE
- approved_job_digest: dae734ce35fa3ed2ae082f51fbcb0c2abea0ab3f590130ceaee3f82e1526fccf
- run_id: n5-room-marker-live-20260814-001
- place_id: 35644668
- endpoint: GET https://pcmap.place.naver.com/accommodation/35644668/home
- external_requests: 1
- exit_code: 1
- result: failed
- error_code: V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED
- retryable: false
- retries: 0
- fallbacks: 0
- operational_writes: 0
- raw_provider_response_stored: 0
- room_count: unknown
- provider_marker: unknown
- block_subtype: unknown_due_to_current_error_framing
- package_lock_changed: false
- frozen_collector_blob: bcbe229998da3afa6f31ee04375fb0766019e56f
- commits: 0
- pushes: 0
- render_changes: 0
- recommended_next_phase: N5-D3 sanitized access-block diagnostics
END_HANDOFF_REBUILD_N5_LIVE
