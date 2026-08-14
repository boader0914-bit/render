# 데이터랩 재구축 N5-D5 Render live adapter 보고서

## 1. 목적과 결론

N5-D4 readiness 경로는 수정하지 않고, 별도 `live-and-hold` 진입점에서만
Place ID `35644668`의 네이버 Place 객실 공급자 표식 경로를 정확히 한 번
실행할 수 있는 Render 어댑터를 로컬 구현했다.

오프라인 mock 검증 결과는 통과했다. durable claim이 Provider 호출보다 먼저
생성되고, 성공과 안전 진단 실패 모두 terminal로 기록된다. 같은 job digest가
다시 시작되면 Provider를 호출하지 않고 기존 terminal을 재생한다. claim 이후
terminal 확정이 불가능하면 `result-uncertain`으로 중단하며 자동 retry와
fallback은 없다.

이번 단계에서 실제 Provider 호출, Render 변경, 운영 쓰기, commit, push는
실행하지 않았다.

## 2. 기준 무결성

| 항목 | 검증값 |
| --- | --- |
| 로컬 브랜치 | `recovery/v2-room-provider-render-live-adapter` |
| 기준 커밋 | `b4a20ddcbe60f7159242fece7ffd791aa62f57be` |
| D4 readiness blob | `ca99bbceede09da2d7ea138fe13ae6c8afc53a60` |
| 현재 collector blob | `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3` |
| 동결 collector blob | `bcbe229998da3afa6f31ee04375fb0766019e56f` |
| D3 live runner blob | `70eb4024b8c623569d13666a0757738c447df214` |
| marker contract blob | `0098a89d940fb4436ac7fa9810e7e6582870d7c2` |
| package-lock Git blob | `dabce1c6a80a4541af98f521e9596ddc4c8f9c69` |
| package-lock SHA-256 | `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2` |
| Node | `26.5.0` |

작업 전후 collector, 동결 collector, D3 runner, marker contract, D4 readiness,
package-lock의 identity는 변하지 않았다.

## 3. 고정 live 작업

| 항목 | 값 |
| --- | --- |
| run ID | `n5-room-marker-render-live-20260814-001` |
| Place ID | `35644668` |
| canonical job digest | `bb00fd2a3fadc8c9644f8b28932f6bf2bb0ad2b96b55de0573eb0a4214e32ef7` |
| method | `GET` |
| origin | `https://pcmap.place.naver.com` |
| path | `/accommodation/35644668/home` |
| request budget | `1` |
| retry | `0` |
| fallback | `0` |
| operational writes | `0` |

## 4. 실행 계약

1. outer gate, 배포 commit, Node, job digest, source blob, lockfile와 전용 디스크
   경로를 검증한다.
2. 전용 디스크의 `claims/<job-digest>.json`을 `wx`로 생성한다.
3. claim 성공 후 terminal 선행 파일이 없는지 확인한다.
4. D3 runner에 필요한 inner gate는 메모리에서만 만든다.
5. 고정 GET을 최대 한 번 실행한다.
6. raw HTML, header value, cookie를 버리고 허용된 객실 수, 표준 공급자 표식,
   응답 분류와 안전 오류 진단만 terminal에 기록한다.
7. terminal은 임시 파일을 완성한 뒤 전용 terminal 경로로 원자적으로 이동한다.
8. 같은 digest 재실행은 기존 terminal digest와 내용을 검증해 재생하며 호출은 0이다.
9. claim만 존재하거나 terminal이 손상됐거나 기록 확정이 실패하면
   `result-uncertain` 또는 terminal invalid로 중단한다.
10. `live-and-hold`는 결과를 JSON 한 줄로 출력한 뒤 SIGTERM까지 유지되어
    Render의 의도하지 않은 process restart를 막는다.

diagnostic claim과 terminal만 전용 디스크에 쓴다. 이 쓰기는 운영 데이터 쓰기가
아니며 DB, Redis, Web import, 기존 V2 artifact 경로에는 연결되지 않는다.

## 5. 생성 및 수정 파일

| 파일 | 이유 |
| --- | --- |
| `scripts/v2_naver_place_room_provider_marker_render_live_adapter.cjs` | live gate, durable claim, terminal commit, duplicate replay, hold 구현 |
| `scripts/test_v2_naver_place_room_provider_marker_render_live_adapter.cjs` | 정상, 차단, timeout, 중복, 동시 실행, 손상, 부분 실패 검증 |
| `package.json` | D5 test 및 live start 명령 추가 |
| `render.v2-room-provider-marker-live-adapter.proposal.yaml` | readiness 최초 배포와 별도 live 전환 제안 |
| `docs/datalab_rebuild_n5_d5_render_live_adapter_report.md` | 증거와 승인 경계 기록 |

수정하지 않은 핵심 파일은 collector 2개, D3 live runner, marker contract,
D4 readiness wrapper, `package-lock.json`이다.

## 6. 오프라인 테스트

로컬 dependency 설치는 캐시만 사용했다.

```text
npm ci --offline --ignore-scripts --audit=false --fund=false
added 2 packages
```

| 테스트 | 결과 | 핵심 증거 |
| --- | --- | --- |
| marker contract D1 | 통과, 67 assertions | 객실 6, `campingtalk`, 외부 요청 0 |
| live runner D3 | 통과, 160 assertions | 403/429/challenge 분류, 외부 요청 0 |
| Render readiness D4 | 통과, 112 assertions | live unavailable, collector 0, 외부 요청 0 |
| Render live adapter D5 | 통과, 195 assertions | mock invocation 9, duplicate replay 4, uncertain 3 |
| N5 합계 | 통과, 534 assertions | retry/fallback/운영 쓰기 0 |
| Provider resilience E2E | 통과 | localhost fixture만 사용 |
| V2 full pipeline E2E | 통과 | actual child fixture, golden master, transaction, projection 통과 |

D5 테스트는 다음 상태를 포함한다.

- 정상 terminal commit
- persisted success terminal 재시작 재생
- persisted failure terminal 재생
- HTTP 403, HTTP 429, challenge HTML, timeout
- 임의 오류 코드와 secret sentinel redaction
- terminal write 실패 후 claim-only `result-uncertain`
- terminal 손상 차단
- terminal-without-claim 선행 상태 차단
- 동시 실행 시 실제 runner 한 개만 진입
- 실제 `live-and-hold` duplicate process 1초 생존 및 SIGTERM 종료
- 전용 로컬 상태 경로 밖 쓰기 차단

테스트 전체에서 실제 외부 네트워크 요청 0, 자동 retry 0, fallback 0,
운영 쓰기 0, raw Provider 응답 저장 0이었다.

## 7. Render 제안

제안 파일은 `render.v2-room-provider-marker-live-adapter.proposal.yaml`이다.
Blueprint sync로 실행하지 않는다.

최초 배포는 다음 상태만 허용한다.

- branch: `recovery/v2-room-provider-render-live-adapter`
- Auto Deploy Off
- Starter, instance 1
- disk: `/var/data/v2-room-provider-marker-diagnostic`, 1GB
- Start Command: `npm run start:v2-naver-place-room-provider-marker-render-readiness`
- `RUN_ENABLED=0`
- `REQUEST_BUDGET=0`
- live gate 없음
- retry, fallback, operational writes 모두 0

readiness가 성공한 뒤에만 별도 승인으로 Worker를 Suspend하고 다음 전환을
한 번에 적용한다.

```text
Start Command: npm run start:v2-naver-place-room-provider-marker-render-live
V2_N5_RENDER_RUN_ENABLED=1
V2_N5_RENDER_REQUEST_BUDGET=1
V2_N5_RENDER_LIVE_APPROVED=N5-D5-Live
V2_N5_RENDER_APPROVED_JOB_SHA256=bb00fd2a3fadc8c9644f8b28932f6bf2bb0ad2b96b55de0573eb0a4214e32ef7
```

세 개의 `V2_NAVER_ROOM_MARKER_*` inner gate는 Render 환경변수에 추가하지 않는다.
terminal 또는 `result-uncertain` 확인 후 재시도 없이 Suspend하고 readiness-only로
복원한다.

## 8. 미확인과 중단 조건

오프라인으로 확인되지 않은 항목은 실제 Render outbound 환경에서 해당 네이버
경로가 반환하는 HTTP 분류와 현재 DOM selector 일치 여부다. 이것은 한 번의 live
canary에서만 확인할 수 있다.

다음 조건에서는 호출 전 또는 첫 결과 직후 중단한다.

- 승인 commit, source blob, lockfile, job digest 불일치
- 전용 디스크 경로 또는 instance 1 불일치
- gate 일부만 설정됐거나 direct inner gate가 환경에 존재
- 기존 claim 또는 미확정 terminal 상태
- 요청 수 1 초과, retry 또는 fallback 발생
- Provider 원문, cookie, header value, secret 유출
- 운영 DB, Redis, Web import 또는 기존 artifact 경로 쓰기
- 예상하지 않은 process restart

## 9. 다음 승인 순서

먼저 아래 commit 승인이 필요하다.

```text
승인 N5-D5-Commit:

N5 Render live one-shot adapter 변경을 commit하고
recovery/v2-room-provider-render-live-adapter 브랜치로 push한다.

Render 변경, 배포, Resume 및 Provider 호출은 실행하지 않는다.
```

commit/push 후에는 별도 승인으로 신규 격리 Worker의 readiness-only 최초 배포를
검증한다. readiness가 통과한 경우에만 그 다음 승인에서 Place ID `35644668`의
고정 GET을 정확히 한 번 실행한다. 이 순서는 준비 검증과 실제 결과 확인을 짧은
두 단계로 묶어, 긴 오프라인 개발 후 마지막에 오류가 몰리는 문제를 줄인다.

HANDOFF_REBUILD_N5_D5
- baseline_commit: b4a20ddcbe60f7159242fece7ffd791aa62f57be
- local_branch: recovery/v2-room-provider-render-live-adapter
- collector_blob: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- frozen_collector_blob: bcbe229998da3afa6f31ee04375fb0766019e56f
- d3_runner_blob: 70eb4024b8c623569d13666a0757738c447df214
- d4_readiness_blob: ca99bbceede09da2d7ea138fe13ae6c8afc53a60
- package_lock_sha256: ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2
- job_run_id: n5-room-marker-render-live-20260814-001
- job_digest: bb00fd2a3fadc8c9644f8b28932f6bf2bb0ad2b96b55de0573eb0a4214e32ef7
- live_adapter: scripts/v2_naver_place_room_provider_marker_render_live_adapter.cjs
- readiness_start_command: npm run start:v2-naver-place-room-provider-marker-render-readiness
- live_start_command: npm run start:v2-naver-place-room-provider-marker-render-live
- durable_claim: implemented_and_offline_verified
- terminal_replay: implemented_and_offline_verified
- process_hold: implemented_and_offline_verified
- n5_assertions: 534
- external_provider_calls: 0
- automatic_retries: 0
- fallbacks: 0
- operational_writes: 0
- raw_provider_responses_stored: 0
- render_changes: 0
- commit_created: false
- push_performed: false
- approval_n5_d5_commit_required: true
- recommended_next_scope: commit/push, isolated readiness-only deploy, then separately approved one-call live canary
END_HANDOFF_REBUILD_N5_D5
