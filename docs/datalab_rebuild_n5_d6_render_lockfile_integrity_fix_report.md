# DataLab Rebuild N5-D6: Render Lockfile Integrity Fix

## Objective

Repair the readiness-only build failure caused by platform-specific line endings
in `package-lock.json`. This phase changes no collector behavior, performs no
Provider request, and leaves the isolated Render worker suspended.

## Baseline

| Item | Verified value |
| --- | --- |
| Repository | `boader0914-bit/render` |
| Baseline branch | `recovery/v2-room-provider-render-live-adapter` |
| Baseline commit | `583c873bb5ec41e8334ecd910db5393c5991de72` |
| Local D6 branch | `recovery/v2-room-provider-render-lockfile-integrity-fix` |
| Isolated worker | `srv-d9vbl5nlk1mc738isrk0` |
| Failed readiness deploy | `dep-d9vbl5vlk1mc738isshg` |
| Worker state during D6 | `Suspended` |
| Current collector blob | `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3` |
| Frozen collector blob | `bcbe229998da3afa6f31ee04375fb0766019e56f` |
| D3 live runner blob | `70eb4024b8c623569d13666a0757738c447df214` |
| Marker contract blob | `0098a89d940fb4436ac7fa9810e7e6582870d7c2` |
| package-lock Git blob | `dabce1c6a80a4541af98f521e9596ddc4c8f9c69` |
| Node | `26.5.0` |

## Failure Evidence

The failed Render build completed the D1 and D3 tests, then stopped in the D4
readiness test with `V2N5RenderReadinessError: A required source file identity
changed`. Runtime readiness did not start.

The package-lock content was unchanged. The old check hashed raw working-tree
bytes:

- Windows CRLF raw SHA-256:
  `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2`
- Git/Render LF SHA-256:
  `d01ae4741e2472c2830fc1432cd241c04105fc574ea11c250991cec5aa89956e`
- Git blob on both platforms:
  `dabce1c6a80a4541af98f521e9596ddc4c8f9c69`

This proves the failure was a line-ending identity mismatch, not a collector or
Naver Provider failure.

## Fix

The readiness verifier now uses an explicit `canonical-sha256` algorithm for
`package-lock.json`. It validates canonical UTF-8 text, normalizes CRLF to LF,
and then computes SHA-256. LF and CRLF checkouts therefore produce the same
identity while any non-EOL content change still fails closed.

Unknown identity algorithms now fail with
`V2_N5_RENDER_INTEGRITY_MISMATCH` instead of falling through to a raw SHA-256
check. The structured field name `packageLockSha256` remains unchanged for
compatibility, but its value is now the canonical repository-text digest.

The D5 adapter baseline advances to the committed D5 parent, and its pinned D4
readiness blob advances from
`ca99bbceede09da2d7ea138fe13ae6c8afc53a60` to
`1c97c51b3d5dfd99c0a68733252127a4b582fdbe`.

## Files Changed

- `scripts/v2_naver_place_room_provider_marker_render_readiness.cjs`: add the
  platform-neutral lockfile identity and fail-closed algorithm selection.
- `scripts/test_v2_naver_place_room_provider_marker_render_readiness.cjs`: prove
  LF/CRLF parity, raw-byte divergence, content-mutation rejection, and unknown
  algorithm rejection.
- `scripts/v2_naver_place_room_provider_marker_render_live_adapter.cjs`: pin the
  new readiness blob and D5 baseline commit.
- `scripts/test_v2_naver_place_room_provider_marker_render_live_adapter.cjs`:
  update chained integrity expectations.
- `render.v2-room-provider-marker-lockfile-integrity-fix.proposal.yaml`: propose
  a later readiness-only redeploy of the existing suspended worker.
- `docs/datalab_rebuild_n5_d6_render_lockfile_integrity_fix_report.md`: preserve
  root cause, implementation, verification, and handoff evidence.

`package-lock.json`, both collectors, the D3 runner, and the marker contract are
not modified.

## Offline Verification

The approved Node `26.5.0` runtime is used throughout. Dependency installation
is local and offline:

```text
..\tooling\node-v26.5.0-win-x64\npm.cmd ci --offline --ignore-scripts --audit=false --fund=false
```

Validation set:

| Test | Result |
| --- | --- |
| N5 marker parser/contract | Passed, 67 assertions |
| N5 live one-shot gates | Passed, 160 assertions |
| N5 Render readiness | Passed, 120 assertions |
| N5 Render live adapter | Passed, 195 assertions |
| N5 aggregate | Passed, 542 assertions |
| Naver Provider resilience E2E fixtures | Passed |
| V2 full pipeline E2E fixtures | Passed |
| Actual external requests | `0` |
| Collector invocations by readiness | `0` |
| Operational writes | `0` |
| Automatic retry / fallback | `0 / 0` |

## Render Handoff

No Render setting or service state was changed in D6. The worker remains
suspended. After a separately approved commit and push, a later approval may
change only the existing worker branch and expected commit to the D6 values,
then perform one readiness-only Resume/deploy with all execution gates at zero.

HANDOFF_REBUILD_N5_D6
- baseline_commit: 583c873bb5ec41e8334ecd910db5393c5991de72
- local_branch: recovery/v2-room-provider-render-lockfile-integrity-fix
- worker_service_id: srv-d9vbl5nlk1mc738isrk0
- worker_state: Suspended
- failed_deploy_id: dep-d9vbl5vlk1mc738isshg
- root_cause: raw package-lock SHA-256 differed between Windows CRLF and Render LF checkouts
- old_windows_raw_sha256: ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2
- canonical_package_lock_sha256: d01ae4741e2472c2830fc1432cd241c04105fc574ea11c250991cec5aa89956e
- package_lock_git_blob: dabce1c6a80a4541af98f521e9596ddc4c8f9c69
- d4_readiness_blob: 1c97c51b3d5dfd99c0a68733252127a4b582fdbe
- d5_adapter_blob: e2f8dbb9b12562870544c8c3771dd3bc411c72ed
- offline_tests: passed
- external_requests: 0
- operational_writes: 0
- render_changes: 0
- approval_n5_d6_commit_required: true
- recommended_next_scope: commit and push D6 only, then request a separate readiness-only redeploy approval
END_HANDOFF_REBUILD_N5_D6
