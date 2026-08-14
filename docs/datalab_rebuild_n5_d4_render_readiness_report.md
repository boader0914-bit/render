# DataLab Rebuild N5-D4: Isolated Render Readiness Preparation

## Objective

N5-D3 commit을 변경하지 않고 fresh live identity와 격리 Render 실행 환경을 준비했다.
이번 단계의 wrapper는 `readiness`와 장기 실행 `serve`만 제공하며 live 실행 명령이나
Provider transport를 포함하지 않는다. 실제 Render 생성·배포와 Provider 호출은
수행하지 않았다.

## Baseline

- repository: `boader0914-bit/render`
- baseline branch: `recovery/v2-room-provider-access-diagnostics`
- baseline commit: `a977872f8f3de20775a3e2dab92f9161cb69515e`
- local D4 branch: `recovery/v2-room-provider-render-readiness`
- frozen collector blob: `bcbe229998da3afa6f31ee04375fb0766019e56f`
- current collector blob: `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`
- N5 live runner blob: `70eb4024b8c623569d13666a0757738c447df214`
- N5 marker contract blob: `0098a89d940fb4436ac7fa9810e7e6582870d7c2`
- package-lock SHA-256: `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2`

## Fresh Job Identity

- proposal: `docs/v2_naver_place_room_provider_marker_render_live_job.proposal.json`
- run ID: `n5-room-marker-render-live-20260814-001`
- Place ID: `35644668`
- canonical job digest:
  `bb00fd2a3fadc8c9644f8b28932f6bf2bb0ad2b96b55de0573eb0a4214e32ef7`
- proposal file SHA-256:
  `8abdc782268d7cafe70057097787e08e3aad42e31f4f96f4dda771e8a111b4a1`
- future request budget: `1`
- automatic retry / fallback: `0 / 0`

proposal은 readiness에서 identity만 검증된다. D4 wrapper에는 job을 실행하는 명령이
없으므로 이 파일이 존재해도 외부 요청을 만들 수 없다.

## Readiness Contract

Entrypoint:

`scripts/v2_naver_place_room_provider_marker_render_readiness.cjs`

허용 명령:

- `readiness`: structured readiness 한 줄을 출력하고 종료
- `serve`: structured readiness 한 줄을 출력하고 SIGTERM/SIGINT까지 대기

금지된 명령:

- live
- live-and-hold
- fixture-once
- collector 또는 child process 실행

정상 readiness event:

- schema: `v2-naver-room-provider-marker-render-readiness.v1`
- event: `n5_room_provider_marker_render_ready`
- mode: `readiness-only`
- `runEnabled=false`
- `requestBudget=0`
- `externalRequests=0`
- `collectorInvocations=0`
- `operationalWrites=0`
- `diagnosticStateWrites=0`
- `liveExecutionAvailable=false`

## Integrity Checks

readiness 전에 다음을 fail-closed 검증한다.

- Node `26.5.0`
- fresh job run ID와 canonical digest
- N5 runner와 marker contract의 Git blob
- current collector와 frozen collector의 Git blob
- package-lock SHA-256
- Render에서는 `RENDER_GIT_COMMIT`과 승인된
  `V2_N5_RENDER_EXPECTED_DEPLOY_COMMIT`의 정확한 일치
- 전용 디스크 경로 `/var/data/v2-room-provider-marker-diagnostic`

Windows CRLF와 Render/Linux LF가 같은 Git blob으로 검증되도록 canonical Git text
bytes를 사용한다. source 파일 자체를 변경해서 hash를 맞추지 않는다.

## Required Readiness Environment Names

| 이름 | readiness 값 |
| --- | --- |
| `NODE_VERSION` | `26.5.0` |
| `V2_N5_RENDER_EXPECTED_DEPLOY_COMMIT` | commit 이후 승인된 SHA |
| `V2_N5_RENDER_RUN_ENABLED` | `0` |
| `V2_N5_RENDER_REQUEST_BUDGET` | `0` |
| `V2_N5_RENDER_AUTOMATIC_RETRY` | `0` |
| `V2_N5_RENDER_FALLBACK` | `0` |
| `V2_N5_RENDER_OPERATIONAL_WRITES` | `0` |
| `V2_N5_RENDER_STATE_DIR` | `/var/data/v2-room-provider-marker-diagnostic` |

다음 live gate는 readiness 환경에 존재하면 안 된다.

- `V2_N5_RENDER_LIVE_APPROVED`
- `V2_N5_RENDER_APPROVED_JOB_SHA256`
- `V2_NAVER_ROOM_MARKER_LIVE_APPROVED`
- `V2_NAVER_ROOM_MARKER_REQUEST_BUDGET`
- `V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256`

## Render Proposal

- file: `render.v2-room-provider-marker-readiness.proposal.yaml`
- service type: Background Worker
- Auto Deploy: Off
- plan: Starter
- instances: 1
- disk: 1 GB
- mount path: `/var/data/v2-room-provider-marker-diagnostic`

Build Command:

```text
npm ci --ignore-scripts --audit=false --fund=false && npm run test:v2-naver-place-room-provider-marker && npm run test:v2-naver-place-room-provider-marker-live && npm run test:v2-naver-place-room-provider-marker-render-readiness
```

Start Command:

```text
npm run start:v2-naver-place-room-provider-marker-render-readiness
```

제안서는 Blueprint sync 또는 Render 생성에 사용하지 않았다.

## Files Changed

| 파일 | 이유 |
| --- | --- |
| `docs/v2_naver_place_room_provider_marker_render_live_job.proposal.json` | 기존 N5-Live와 분리된 fresh identity |
| `scripts/v2_naver_place_room_provider_marker_render_readiness.cjs` | zero-call readiness와 장기 process lifetime |
| `scripts/test_v2_naver_place_room_provider_marker_render_readiness.cjs` | gate, integrity, no-write, serve/SIGTERM 검증 |
| `render.v2-room-provider-marker-readiness.proposal.yaml` | 승인 전 Render 설정 제안 |
| `package.json` | D4 test/start 명령 두 개 추가 |
| `docs/datalab_rebuild_n5_d4_render_readiness_report.md` | 결과와 승인 경계 기록 |

## Offline Verification

Node `26.5.0`에서 다음을 확인했다.

bundled npm `11.17.0`으로 다음 설치 명령도 외부 네트워크 없이 통과했다.

```text
npm ci --offline --ignore-scripts --audit=false --fund=false
```

| 검증 | 결과 | Assertions |
| --- | --- | ---: |
| N5-D1 marker contract | PASS | 67 |
| N5-D3 live runner diagnostics | PASS | 160 |
| N5-D4 Render readiness | PASS | 112 |
| 합계 | PASS | 339 |

추가로 NAVER provider resilience localhost E2E가 통과했다. `serve` process는 readiness
출력 후 생존했고 controlled SIGTERM으로 종료했다. readiness 전후 상태 디렉터리는
생성되지 않았다.

- actual external requests: `0`
- collector invocations: `0`
- operational writes: `0`
- diagnostic state writes: `0`
- raw Provider responses stored: `0`
- retries / fallbacks: `0 / 0`
- offline npm ci: `PASS`

## Local File Identities

- D4 wrapper blob: `ca99bbceede09da2d7ea138fe13ae6c8afc53a60`
- D4 test blob: `d41fbd15a75180ee88da8087218de336ffb9b20a`
- Render proposal SHA-256:
  `07205e5a22060cc3175efcdd66a1ba53941b52fcc219a288e83f4410277e0ee2`

## Unknowns And Next Gates

- D4 변경은 아직 commit 또는 push하지 않았다.
- 실제 Render Node/runtime, shallow checkout, 디스크 mount는 미검증이다.
- Render 전체 자원에서 제안 서비스 이름의 충돌 여부는 생성 승인 전 읽기 전용으로
  확인해야 한다.
- wrapper에는 live 실행 기능이 없으므로 readiness 성공만으로 Provider 호출은
  실행할 수 없다.
- N5-Live의 과거 block subtype은 여전히 복원할 수 없다.

승인 순서:

1. `N5-D4-Commit`: D4 변경 commit과 branch push
2. `N5-D4-Readiness`: 격리 신규 Worker 생성과 readiness-only 최초 배포
3. readiness 성공 후 별도 로컬 단계에서 exactly-once live adapter와 durable claim 구현
4. 새 승인 아래 단일 Provider canary 실행

## Proposed Commit Approval

```text
승인 N5-D4-Commit:

N5 Render readiness-only 준비 변경을 commit하고
recovery/v2-room-provider-render-readiness 브랜치로 push한다.

동결 collector와 package-lock.json은 변경하지 않는다.
Render 생성·배포, Provider 호출, 운영 쓰기 및 live gate 설정은 실행하지 않는다.
```

HANDOFF_REBUILD_N5_D4
- baseline_commit: a977872f8f3de20775a3e2dab92f9161cb69515e
- local_branch: recovery/v2-room-provider-render-readiness
- fresh_run_id: n5-room-marker-render-live-20260814-001
- fresh_job_digest: bb00fd2a3fadc8c9644f8b28932f6bf2bb0ad2b96b55de0573eb0a4214e32ef7
- wrapper_entrypoint: scripts/v2_naver_place_room_provider_marker_render_readiness.cjs
- commands: readiness,serve
- live_execution_available: false
- build_command: npm ci --ignore-scripts --audit=false --fund=false && npm run test:v2-naver-place-room-provider-marker && npm run test:v2-naver-place-room-provider-marker-live && npm run test:v2-naver-place-room-provider-marker-render-readiness
- start_command: npm run start:v2-naver-place-room-provider-marker-render-readiness
- disk_path: /var/data/v2-room-provider-marker-diagnostic
- disk_size_gb: 1
- offline_tests: PASS, 339 assertions plus provider resilience E2E
- external_requests: 0
- collector_invocations: 0
- operational_writes: 0
- diagnostic_state_writes: 0
- collector_changed: false
- package_lock_changed: false
- commits: 0
- pushes: 0
- render_changes: 0
- approval_required: N5-D4-Commit
END_HANDOFF_REBUILD_N5_D4
