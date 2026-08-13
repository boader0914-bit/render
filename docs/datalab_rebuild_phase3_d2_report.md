# DataLab Rebuild Phase 3 D2 Report

Date: 2026-08-13 KST

## Result

N3-D2 compared the confirmed V2 Render success, the N3 local original success, the
N3 copied failure, and the later N3-D1 copied-only failure. It also added an offline
runtime and transport diagnostic around Node 26.5.0. No Provider request, Render
change, operational write, retry, fallback, commit, or push was performed.

The copied source, extracted functions, GraphQL query, and application request
envelope remain exact. A copied-only call still received HTTP 405 challenge HTML
more than two hours after the N3 pair, so rapid consecutive execution alone does
not explain all observed failures. The Provider-side cause remains unverified.

## Integrity

| Item | Verified value |
|---|---|
| D1 baseline commit | `2daecbb40f351d3916cf30f95bf4435cf58920eb` |
| V2 source baseline | `b5de9c40199f40a4409f93b1b66f0b9ccea17a83` |
| V2 collector blob | `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3` |
| Reference collector blob | `bcbe229998da3afa6f31ee04375fb0766019e56f` |
| Lockfile SHA-256 | `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2` |
| Source manifest digest | `89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40` |
| Application envelope SHA-256 | `2078ad1e1f436f524058822079837a8ab222eea7e54b375a7ad7fc2bba378d1d` |
| Runtime | Node `26.5.0`, Undici `8.7.0`, OpenSSL `3.5.7` |

The V2 collector and reference collector are different files with different roles.
Both blobs were checked before and after D2; neither file was modified.

The D1 manifest verifier was made independent of checkout line endings. It now
checks the committed Git blob and canonical JSON digest instead of the raw working
tree bytes. Source files and the lockfile still use strict byte hashes.

## Evidence Matrix

| Observation | Environment | Execution shape | Result |
|---|---|---|---|
| Confirmed V2 Render run | Linux x64; Node 26.5.0; Undici 8.7.0; OpenSSL 3.5.7 | full collector; main Place then booking business | terminal committed; GraphQL response status not recorded |
| N3 original | Windows x64; Node 26.5.0; Undici 8.7.0 | standalone booking business | HTTP 200; identity resolved |
| N3 copied | same recorded local runtime | standalone booking business in a separate child | HTTP 405; access blocked |
| N3-D1 copied-only | same recorded local runtime; over two hours later | standalone booking business | HTTP 405; `challenge_html` |

The Render log timestamps show that the main Place call began 1,415 ms before the
booking-business call. The local 519 ms and 7,989,869 ms intervals are audit-file
timestamp differences, not packet-level request-start measurements.

## Runtime Fingerprint

The diagnostic records only environment variable names and safe runtime metadata.
It does not store environment values, absolute paths, host names, IP addresses,
request targets, header values, payloads, or Provider responses.

The local D2 fingerprint is Windows x64, Node 26.5.0, Undici 8.7.0, OpenSSL 3.5.7,
ICU 78.3, DNS result order `verbatim`, locale `ko-KR`, and timezone `Asia/Seoul`.
No proxy, custom CA, `NODE_OPTIONS`, or Render environment variable name was present
in the diagnostic child environment.

## Offline Wire Observation

The loopback server received the six controlled GraphQL headers unchanged. Node and
Undici added the following request header names:

- `host`
- `connection`
- `sec-fetch-mode`
- `accept-encoding`
- `content-length`

The standalone GraphQL request and the GraphQL request after a synthetic main Place
request had the same method, HTTP version, header names and order, controlled-value
checks, body size and body hash. The synthetic main Place response issued a
`Set-Cookie`, but Node fetch did not automatically send a Cookie header on the next
GraphQL request. Source inspection found no explicit cookie jar or cookie-state code
in the three V2 transport files.

This does not reproduce Provider TLS or anti-abuse behavior. The probe uses local
HTTP intentionally and therefore cannot establish historical TLS, DNS, egress, or
Provider-side state.

## Hypothesis Assessment

| Hypothesis | D2 status | Evidence |
|---|---|---|
| Copied source or GraphQL query differs | evidence against | source closure, function digest, query digest, and application envelope are fixed |
| Rapid pair execution is the sole cause | evidence against as sole cause | copied-only request remained challenged more than two hours later |
| Main Place creates an automatically carried cookie session | evidence against | no cookie state code; loopback Set-Cookie was not forwarded |
| Main Place is required before every successful GraphQL call | not required for the observed original success | N3 original standalone call returned HTTP 200 without Place GET |
| OS, TLS, DNS, egress, or Provider state explains the difference | unresolved | historical runs lack comparable wire/TLS/egress fingerprints |

No header mutation, proxy rotation, browser-stealth behavior, challenge bypass, or
retry was implemented or recommended.

## Files

| File | Reason |
|---|---|
| `docs/v2_booking_business_environment_evidence.json` | normalized, redacted comparison of four confirmed observations |
| `scripts/v2_booking_business_env_diagnostics.cjs` | runtime fingerprint, diagnostics-channel events, loopback request observation, hypothesis report |
| `scripts/test_v2_booking_business_env_diagnostics.cjs` | privacy, isolation, wire-shape, session, integrity, and overwrite tests |
| `scripts/v2_booking_business_harness.cjs` | line-ending-independent verification and D2 allowlist only |
| `docs/datalab_rebuild_phase3_d2_report.md` | durable result and handoff |

No collector, transport, query, package file, lockfile, live job, UI, Worker, or
Render configuration was changed.

## Offline Regression

| Check | Result |
|---|---|
| D2 syntax checks | PASS |
| D2 environment diagnostics | PASS |
| D2 assertions | PASS, 60 |
| Existing D1 scenarios | PASS, 15 |
| Existing D1 assertions | PASS, 544 |
| Application-envelope parity | PASS, exact |
| Loopback requests | 9 total across test and official reproduction |
| Actual Provider requests | 0 |
| Operational writes | 0 |
| Retry / fallback | 0 / 0 |
| Secret, raw HTML, Provider host and IP scan | PASS |

Reproduction:

```powershell
..\tooling\node-v26.5.0-win-x64\node.exe --check scripts/v2_booking_business_env_diagnostics.cjs
..\tooling\node-v26.5.0-win-x64\node.exe --check scripts/test_v2_booking_business_env_diagnostics.cjs
..\tooling\node-v26.5.0-win-x64\node.exe scripts/test_v2_booking_business_env_diagnostics.cjs
..\tooling\node-v26.5.0-win-x64\node.exe scripts/v2_booking_business_env_diagnostics.cjs offline
..\tooling\node-v26.5.0-win-x64\node.exe scripts/test_v2_booking_business_harness.cjs
```

The D2 test removes its own ignored output before the official reproduction. The
official command writes one immutable result at
`outputs/rebuild-phase3-d2/rebuild-phase3-booking-business-environment-offline-001/environment-diagnostics.json`.

## Next Gate

Commit and push require:

```text
Approval N3-D2-Commit:
V2 booking-business environment diagnostics changes are committed and pushed to
recovery/v2-booking-business-env-diagnostics.
```

After that commit is approved and pushed, the highest-value live comparison is a
separately approved, isolated Render Linux one-shot containing exactly one copied
booking-business GraphQL request. It must not modify services 1, 2, or 3 and must
not call main Place, booking items, schedule, HTML fallback, historical fallback,
or any operational store. No Render service or Provider request was created by D2.

HANDOFF_REBUILD_PHASE_3_D2
- baseline_commit: 2daecbb40f351d3916cf30f95bf4435cf58920eb
- v2_collector_blob_before: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- v2_collector_blob_after: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- reference_collector_blob_before: bcbe229998da3afa6f31ee04375fb0766019e56f
- reference_collector_blob_after: bcbe229998da3afa6f31ee04375fb0766019e56f
- lockfile_sha256: ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2
- local_branch: recovery/v2-booking-business-env-diagnostics; local only
- evidence_matrix: Render full-path committed; local original HTTP 200 resolved; local copy HTTP 405; delayed copy HTTP 405 challenge_html
- runtime_fingerprint: local win32 x64; Node 26.5.0; Undici 8.7.0; OpenSSL 3.5.7; DNS verbatim
- implicit_header_names: host; connection; sec-fetch-mode; accept-encoding; content-length
- sequence_wire_parity: PASS; standalone GraphQL equals post-main-place GraphQL in loopback observation
- cookie_session_result: no explicit cookie state; Node fetch did not automatically forward Set-Cookie
- offline_tests: PASS; D2 60 assertions; D1 544 assertions and 15 scenarios
- external_provider_requests: 0
- loopback_requests: 9 across final test and official diagnostic commands
- operational_writes: 0
- retries: 0
- fallbacks: 0
- render_changes: 0
- matched_evidence: source/function/query/application envelope/runtime versions
- ruled_down_hypotheses: copied source difference; rapid-only cause; automatic cookie session; mandatory Place warm-up for observed original success
- unknowns: historical wire headers; DNS; TLS/ALPN/cipher; Render egress; Provider challenge reason and duration
- blockers: execution environment and Provider-side state cannot be separated offline
- approval_n3_d2_commit_required: true
- recommended_live_scope_after_commit: isolated Render Linux copied-source booking-business one-shot; exactly one approved POST; no existing-service change
END_HANDOFF_REBUILD_PHASE_3_D2
