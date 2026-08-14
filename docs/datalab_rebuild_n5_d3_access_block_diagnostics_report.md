# DataLab Rebuild N5-D3: Safe Access-Block Diagnostics

## Objective

N5-Live의 단일 요청이 `V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED`로 종료됐지만 기존
terminal 오류가 세부 판정 결과를 버린 문제를 수정했다. 실제 Provider를 다시
호출하지 않고, 원문과 헤더 값을 노출하지 않는 allowlist 진단 계약을 구현하고
오프라인 fixture로 검증했다.

## Result

- 상태: `PASS (offline only)`
- 실제 Provider 요청: `0`
- 운영 쓰기: `0`
- raw Provider 응답 저장: `0`
- retry / fallback: `0 / 0`
- commit / push / Render 변경: `0 / 0 / 0`
- 기존 `N5-Live` 승인은 재사용할 수 없도록 live gate를 `N5-D3-Live`로 변경했다.

## Diagnostic Contract

차단 오류만 다음 두 schema를 사용한다.

- terminal error: `v2-naver-place-room-provider-marker-live-error.v2`
- safe diagnostic: `v2-naver-place-room-provider-marker-access-diagnostic.v1`

허용되는 diagnostic 필드는 다음 13개뿐이다.

| 필드 | 허용 범위 |
| --- | --- |
| `schemaVersion` | 고정 schema 문자열 |
| `blockSubtype` | `http_403`, `http_429`, `challenge_html`, `unknown_access_block` |
| `httpStatusClass` | `1xx`부터 `5xx` 또는 `unknown` |
| `contentTypeClass` | `html`, `xhtml`, `other` |
| `responseBytes` | `0..1048576` 정수 |
| `retryAfterPresent` | boolean; header 값은 기록하지 않음 |
| `requestAttempts` | `0..1` |
| `fixtureRequests` | `0..1` |
| `actualExternalRequests` | `0..1` |
| `automaticRetries` | 항상 `0` |
| `automaticFallbacks` | 항상 `0` |
| `operationalWrites` | 항상 `0` |
| `rawProviderResponseStored` | 항상 `false` |

필드가 하나라도 추가되거나 타입·범위를 벗어나거나 쓰기 값이 0이 아니면 terminal
serializer는 diagnostic 전체를 폐기한다. 오류 message, Provider body, header 이름과
값, cookie, 인증 정보, URL query는 terminal 결과에 포함하지 않는다.

## Changes

| 파일 | 변경 이유 |
| --- | --- |
| `scripts/v2_naver_place_room_provider_marker_live_one_shot.cjs` | 차단 subtype·안전 metadata 생성, allowlist serializer, error schema v2, 새 승인 gate |
| `scripts/test_v2_naver_place_room_provider_marker_live_one_shot.cjs` | 403·429·challenge 및 비밀 유출·임의 필드 주입 회귀 테스트 |
| `docs/datalab_rebuild_n5_d3_access_block_diagnostics_report.md` | 실행 결과와 다음 승인 경계 기록 |

N5-D1/D2에서 만든 runner와 test를 수정했으며 `package.json`, `package-lock.json`,
collector는 N5-D3에서 변경하지 않았다.

## Offline Verification

Node `26.5.0`에서 실행했다.

| 검증 | 결과 | Assertions |
| --- | --- | ---: |
| N5-D3 room marker live runner | PASS | 160 |
| N5-D1 marker contract | PASS | 67 |
| V2 full-product one-shot | PASS | 67 |
| V2 full-product inventory | PASS | 38 |
| V2 weekly channel contract | PASS | 64 |
| V2 weekly channel one-shot | PASS | 75 |
| Company master facility contract | PASS | 45 |
| Fresh company master builder | PASS | 21 |
| 합계 | PASS | 537 |

공통 `NAVER provider resilience localhost E2E` fixture도 통과했다. 모든 테스트는
network guard 아래 실행됐으며 실제 외부 요청과 운영 쓰기는 각각 0이다.

검증된 실패 경계:

- HTTP 403 -> `http_403`, `4xx`
- HTTP 429 + Retry-After -> `http_429`, `4xx`, presence만 `true`
- HTTP 200 XHTML challenge -> `challenge_html`, `2xx`, `xhtml`
- 응답 body·cookie·private header sentinel 유출 없음
- 임의 `rawBody` 필드가 추가된 diagnostic 전체 폐기
- `operationalWrites=1`로 조작된 diagnostic 전체 폐기
- 승인 없는 live CLI는 fetch 전 차단
- 정상 fixture와 simulated live는 요청 1회 상한 유지

## Integrity

- local branch: `recovery/v2-place-company-master-contract`
- baseline HEAD: `690f577e1c86d3fa7f8d3f00f9ade6a87c444b14`
- runner blob after N5-D3: `70eb4024b8c623569d13666a0757738c447df214`
- test blob after N5-D3: `00d5e58a5ba97cc4eb217facb61625b6d900dce4`
- frozen collector blob: `bcbe229998da3afa6f31ee04375fb0766019e56f`
- `package-lock.json` changed: `false`
- collector changed: `false`
- runtime file-write API count: `0`

## Evidence Limits

- 이전 N5-Live 응답은 저장하지 않았으므로 당시 subtype을 소급 복원할 수 없다.
- 새 진단 코드로 실제 환경을 호출하지 않았으므로 현재 차단 subtype은 미확인이다.
- `/accommodation/35644668/home`의 객실 DOM과 공급자 표식도 여전히 미확인이다.
- 접근 차단은 parser 결과가 아니므로 객실 정보 부재나 채널 미사용 증거가 아니다.

## Commit Boundary

현재 worktree에는 N5와 무관한 기존 변경이 함께 존재한다. 따라서 직접 전체 commit을
하면 안 된다. commit 단계에서는 clean worktree를 만들고 N5-D1부터 D3까지 필요한
파일과 `package.json`의 N5 script hunk만 allowlist로 옮긴 뒤 전체 검증을 다시 해야 한다.

다음 실제 호출용 run ID와 job digest는 commit 이후 새로 생성한다. 기존
`n5-room-marker-live-20260814-001`과 기존 승인은 재사용하지 않는다.

## Proposed Commit Approval

```text
승인 N5-D3-Commit:

N5 객실 공급자 표식 D1-D3 변경을 clean worktree에서 allowlist로 재구성하고
commit한 뒤 recovery/v2-room-provider-access-diagnostics 브랜치로 push한다.

기존 unrelated 변경, 동결 collector와 package-lock.json은 포함하거나 변경하지 않는다.
Render 변경, Provider 호출, 운영 쓰기 및 새 live job 실행은 금지한다.
```

HANDOFF_REBUILD_N5_D3
- baseline_head: 690f577e1c86d3fa7f8d3f00f9ade6a87c444b14
- local_branch: recovery/v2-place-company-master-contract
- error_schema: v2-naver-place-room-provider-marker-live-error.v2
- diagnostic_schema: v2-naver-place-room-provider-marker-access-diagnostic.v1
- block_subtypes: http_403,http_429,challenge_html,unknown_access_block
- approval_gate: N5-D3-Live
- runner_blob: 70eb4024b8c623569d13666a0757738c447df214
- test_blob: 00d5e58a5ba97cc4eb217facb61625b6d900dce4
- offline_tests: PASS, 537 assertions plus provider resilience E2E
- actual_external_requests: 0
- operational_writes: 0
- raw_provider_responses_stored: 0
- retries: 0
- fallbacks: 0
- package_lock_changed: false
- collector_changed: false
- commits: 0
- pushes: 0
- render_changes: 0
- previous_block_subtype: unknown_and_not_recoverable
- approval_required: N5-D3-Commit
END_HANDOFF_REBUILD_N5_D3
