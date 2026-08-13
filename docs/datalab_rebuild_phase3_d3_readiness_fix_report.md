# DataLab Rebuild Phase 3 D3 Readiness Fix

## Result

The first isolated Render readiness deployment failed closed before startup because
the historical source manifest recorded Windows CRLF byte hashes while Render
checked out the same Git blobs with LF line endings. The new Worker was suspended
immediately. No retry, additional deploy, fixture execution, Provider request, or
operational write followed the failure.

The local fix preserves the historical manifest and all frozen collector files. It
verifies source identity using both representations already recorded by that
manifest:

- the historical CRLF byte length and SHA-256
- the canonical LF Git blob ID

Only CRLF/LF representation differences are accepted. A non-line-ending byte
change still fails closed. Copied source files retain the current checkout's byte
representation so runtime function digests remain equal between the original and
copy on both Windows and Linux checkouts.

## Render Failure Evidence

| Field | Evidence |
|---|---|
| Worker | `srv-d9un3pnlk1mc73e42qlg` |
| Deploy | `dep-d9un3pvlk1mc73e42rf0` |
| Commit | `c50e2c5a90128b1eb7255923feda7ee1d6df01e2` |
| Runtime | Node.js 26.5.0 |
| Failure time | 2026-08-13 16:27:48 KST |
| Failure code | `V2_RENDER_DIAGNOSTIC_SOURCE_MISMATCH` |
| Failure stage | build-time D3 offline test, before Start Command |
| Worker state after failure | Suspended |
| Additional deploys | 0 |

All 20 manifest files are LF in the Git index and CRLF in the original Windows
worktree. Their canonical LF bytes match all 20 recorded Git blob IDs. This proves
that the failed comparison was caused by checkout line-ending representation, not
by a source-content change.

## Files Changed

| File | Reason |
|---|---|
| `scripts/v2_booking_business_harness.cjs` | Add platform-independent manifest verification and preserve checkout bytes when copying source files. |
| `scripts/v2_booking_business_render_one_shot.cjs` | Reuse the same verifier for readiness integrity, collectors, lockfile, and copied source. |
| `scripts/test_v2_booking_business_render_one_shot.cjs` | Test all 20 files as LF and CRLF and prove non-EOL mutation rejection. |
| `scripts/v2_booking_business_env_diagnostics.cjs` | Consume the already verified lockfile identity instead of hashing platform-specific checkout bytes again. |
| `docs/datalab_rebuild_phase3_d3_readiness_fix_report.md` | Preserve failure and recovery evidence. |

The collector, source manifest, lockfile, job contracts, Provider transport,
request envelope, and Render proposal are unchanged.

## Offline Verification

All commands used Node 26.5.0 with bundled Undici 8.7.0.

| Suite | Windows CRLF checkout | Linux-style LF checkout |
|---|---:|---:|
| D3 Render one-shot | PASS, 189 assertions | PASS, 189 assertions |
| D2 environment diagnostics | PASS, 60 assertions | PASS, 60 assertions |
| D1 booking-business regression | PASS, 544 assertions | PASS, 544 assertions |
| Readiness smoke | PASS | PASS |

Safety totals across executable test results remain:

- actual Provider requests: 0
- Place list requests: 0
- booking item and daily schedule requests: 0
- retries and fallbacks: 0
- operational writes: 0
- raw Provider responses stored: false
- secret scan: passed

## Next Gate

Commit and push require a separate approval. After that, the existing suspended
Worker may be updated to the approved fix branch and commit and given exactly one
new readiness-only deployment. `RUN_ENABLED=0`, request budget 0, and all retry,
fallback, and operational-write gates must remain 0. The expected deploy commit
must be changed to the new approved fix commit before resume.

If build tests, commit identity, or the structured readiness event fail, suspend
only `srv-d9un3pnlk1mc73e42qlg` and do not retry or deploy again.

HANDOFF_REBUILD_PHASE_3_D3_FIX
- baseline_commit: c50e2c5a90128b1eb7255923feda7ee1d6df01e2
- local_branch: recovery/v2-booking-business-render-readiness-fix
- failed_worker: srv-d9un3pnlk1mc73e42qlg
- failed_deploy: dep-d9un3pvlk1mc73e42rf0
- failure_code: V2_RENDER_DIAGNOSTIC_SOURCE_MISMATCH
- root_cause: historical CRLF manifest bytes versus Render LF checkout bytes
- collector_blob_before: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- reference_collector_blob_before: bcbe229998da3afa6f31ee04375fb0766019e56f
- source_manifest_digest: 89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40
- lockfile_sha256: ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2
- platform_parity: Windows CRLF and Linux-style LF passed
- external_provider_requests: 0
- retries: 0
- fallbacks: 0
- operational_writes: 0
- render_changes_after_failure: Worker suspension only
- approval_n3_d3_fix_commit_required: true
END_HANDOFF_REBUILD_PHASE_3_D3_FIX
