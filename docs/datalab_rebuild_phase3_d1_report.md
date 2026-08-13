# DataLab Rebuild Phase 3 D1 Report

Date: 2026-08-13 KST

## Result

N3-D1 added a fail-closed application request-envelope and safe response diagnostics around the frozen V2 `naverBookingBusiness` path. The frozen collector and its 20-file dependency closure were not modified. No Provider request, Render change, operational write, retry, fallback, commit, or push was performed.

The prior N3 live pair remains evidence, not a successful parity result. Its original request returned HTTP 200 and resolved the expected booking-business identity; the copied request returned HTTP 405 and `NAVER_ACCESS_BLOCKED`. The old original-plus-copy live command is now permanently closed. D1 does not claim to know whether that HTTP 405 was caused by request throttling, a challenge response, or another Provider policy.

## Integrity

| Item | Verified value |
|---|---|
| Phase 2 baseline commit | `b1ba55993ef104a698ebafa54c2309f6dc820a05` |
| Source baseline commit | `b5de9c40199f40a4409f93b1b66f0b9ccea17a83` |
| Frozen collector blob | `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3` |
| Lockfile SHA-256 | `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2` |
| Source manifest digest | `89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40` |
| Prior original audit SHA-256 | `bc526c061660f958903e145ecc093dae50ff211b70c44bb91dbc7524629d540e` |
| Prior copied audit SHA-256 | `56e9e67221478e51c9c767fae826e2eb17a77a3219a1b397bc35c9bc7b417708` |
| Runtime | Node `26.5.0`, bundled Undici `8.7.0` |

## Request Envelope

The envelope records the values supplied by this application to `fetch`, not an independently captured wire representation. Node or Undici can add transport-level headers after this boundary. Runtime identity is therefore pinned separately.

The envelope contains method, origin, path, redirect mode, header names, hashes of controlled header values, request-body byte count and hash, operation name, variable names, Place ID hash, and GraphQL query hash. It never stores raw header values, the raw request body, cookies, credentials, or the full URL.

| Item | Value |
|---|---|
| Envelope schema | `v2-booking-business-fetch-envelope.v1` |
| Method and endpoint | `POST https://pcmap-api.place.naver.com/graphql` |
| Operation | `naverBookingBusiness` |
| Header names | `accept`, `accept-language`, `content-type`, `origin`, `referer`, `user-agent` |
| Application envelope SHA-256 | `2078ad1e1f436f524058822079837a8ab222eea7e54b375a7ad7fc2bba378d1d` |
| Original/copy offline parity | exact |
| External requests | `0` |

Offline parity evidence is stored in the ignored path `outputs/rebuild-phase3-d1/rebuild-phase3-booking-business-envelope-offline-001/envelope-parity-result.json`; its final file SHA-256 is `4db9f073a325fab24d3e05c2e4e9549819fb0cf24f6d3a8688d4e305a748c185`.

## Safe Diagnostics

The result projection records only HTTP status, response content-type class (`json`, `html`, `text`, `other`, or `none`), time to response headers, fetch outcome, bounded fetch-failure class, bounded Provider subtype, bounded retry-after seconds for HTTP 429, and the Node/Undici runtime identity. Raw response bodies and response headers are not persisted.

Fixtures distinguish plain HTTP 405 from HTTP 405 challenge HTML. Plain 405 follows the frozen V2 non-blocked failure path and becomes `unavailable`; challenge HTML becomes `failed / NAVER_ACCESS_BLOCKED / challenge_html`. This distinction is ready for a future one-call observation but does not retroactively classify the prior 405 because the prior audit did not preserve that safe subtype.

## Offline Regression

| Check | Result |
|---|---|
| Syntax checks | PASS |
| Fixture scenarios | PASS, 15 |
| Assertions | PASS, 544 |
| Original/copy application-envelope parity | PASS, exact |
| Previous N3 evidence integrity | PASS |
| Old live pair command | closed |
| Copy-only live command without exact approval gates | rejected before run directory/network |
| Existing bounded transport/classifier tests | PASS |
| External requests | `0` |
| Operational writes | `0` |
| Retry / fallback | `0 / 0` |
| Secret/raw HTML scan | PASS |

The older Phase 1 and Phase 2 standalone harnesses were also invoked from their committed worktrees, but both stop at their own exact-HEAD checks because those checks still require their parent baseline commit rather than the approved descendant commit. This is a pre-existing harness limitation, not a test failure caused by D1. D1 independently revalidates the frozen collector blob, lockfile, source manifest, all 20 source file byte hashes and Git blobs, and the Phase 2 evidence digest before every run.

Reproduction:

```powershell
..\tooling\node-v26.5.0-win-x64\node.exe scripts/v2_booking_business_harness.cjs validate-copy-only --job docs/v2_booking_business_copy_only_live_job.proposal.json
..\tooling\node-v26.5.0-win-x64\node.exe scripts/v2_booking_business_harness.cjs envelope-parity --job docs/v2_booking_business_copy_only_live_job.proposal.json
..\tooling\node-v26.5.0-win-x64\node.exe scripts/test_v2_booking_business_harness.cjs
```

The envelope-parity command uses a single immutable run ID and therefore refuses to overwrite existing evidence. Remove only that ignored local D1 evidence directory when intentionally reproducing the offline run.

## Copy-Only Live Plan

The proposed job is `docs/v2_booking_business_copy_only_live_job.proposal.json`.

- Canonical job digest: `35875d7b67f83deff6abe46e8deb606cb6f8506fdd641030f9a829cf51fdc308`
- File SHA-256: `2d5e659dfea17d9bdf0475e764083768534e81faed27daf311fcbec7475db296`
- `notBefore`: `2026-08-13T03:00:44.069Z`, exactly 30 minutes after the prior copied audit timestamp
- Target: the same Phase 2 natural-rank-1 Place evidence
- Execution: hash-copied dependency closure only; original and replay are structurally unavailable in this command
- External request budget: exactly one booking-business POST
- Expected success: HTTP 200, `resolved`, prior identity hash match, booking URL present
- Forbidden: Place GET, booking items, `dailySchedule`, HTML/historical fallback, retry, operational write

Commit and push require `Approval N3-D1-Commit`. Only after that approved commit is pushed should a separate `Approval N3-Copy-Only-Live` be requested. Phase 4 remains blocked until the copied-only observation passes.

HANDOFF_REBUILD_PHASE_3_D1
- baseline_commit: b1ba55993ef104a698ebafa54c2309f6dc820a05
- collector_blob_before: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- collector_blob_after: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- lockfile_sha256: ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2
- local_branch: recovery/v2-booking-business-diagnostics; local only
- runtime: Node 26.5.0; Undici 8.7.0
- request_envelope_schema: v2-booking-business-fetch-envelope.v1
- request_envelope_sha256: 2078ad1e1f436f524058822079837a8ab222eea7e54b375a7ad7fc2bba378d1d
- offline_envelope_parity: PASS; exact original/copy; external 0
- safe_diagnostics: HTTP status; content-type class; header timing; fetch outcome/failure class; provider subtype/status; bounded 429 retry-after; no raw values
- previous_live_pair: original HTTP 200 resolved; copied HTTP 405 NAVER_ACCESS_BLOCKED; root cause unconfirmed
- previous_live_pair_command: permanently closed
- offline_tests: PASS; 15 scenarios; 544 assertions
- external_requests: 0
- operational_writes: 0
- retries: 0
- fallbacks: 0
- copy_only_job_digest: 35875d7b67f83deff6abe46e8deb606cb6f8506fdd641030f9a829cf51fdc308
- copy_only_not_before: 2026-08-13T03:00:44.069Z
- copy_only_request_budget: 1
- copy_only_gate: exact approval name, job digest, envelope digest, runtime, previous evidence, quiet period, fresh run ID
- unknowns: prior copied HTTP 405 response subtype and Provider-side cause
- approval_n3_d1_commit_required: true
- approval_n3_copy_only_live_required: after approved commit/push only
- phase4_ready: false; requires successful copy-only live result
END_HANDOFF_REBUILD_PHASE_3_D1
