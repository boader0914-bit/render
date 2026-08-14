# DataLab Rebuild N6-D1: Place Advertisement Response Diagnostics

## Purpose

The same bounded Naver Place search returned 18 advertisement rows in the local
live run and 0 advertisement rows in the first Render live canary. This phase
adds evidence that can distinguish a missing advertisement operation, a filtered
candidate, an empty matched result, and a changed result container without
storing the Provider response.

## Baseline

- Baseline commit: `651263caf4ccf9349a252754a015348dd23739ab`
- Local branch: `recovery/v2-place-ad-response-diagnostics`
- Existing isolated Worker: `srv-d9vgpqtg1s2s73ffj52g`
- Frozen collector blob: `bcbe229998da3afa6f31ee04375fb0766019e56f`
- Current V2 collector blob: `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`
- Package lock canonical identity: `d01ae4741e2472c2830fc1432cd241c04105fc574ea11c250991cec5aa89956e`
- Provider endpoint remains `GET https://pcmap.place.naver.com/accommodation/list?query=<keyword>`.

No existing service, Render setting, operational store, or Provider was accessed
or changed during N6-D1.

## Diagnostic Contract

`provider-diagnostics.json` contains only bounded structural evidence:

- response byte count and SHA-256 digest;
- Apollo entity and root-key counts;
- counts for `accommodationSearch`, `placeList`, and `adBusinesses` operations;
- advertisement candidate and current-filter match counts;
- query-match, business-type, and opening-place classifications;
- direct, `business`, and `businesses` item-container shapes and counts;
- counts of resolved IDs, names, and advertisement IDs;
- a digest of each candidate key instead of the raw key.

It does not contain the raw response, raw root key, query value, item value,
header value, cookie, authorization value, or Provider payload.

The terminal status is one of:

| Status | Meaning |
| --- | --- |
| `ad-operation-absent` | No parseable `adBusinesses` operation exists. |
| `ad-candidates-filtered` | Advertisement operations exist but none pass the current filter. |
| `current-filter-matched-with-items` | The current contract matches and direct items exist. |
| `current-filter-matched-empty` | The current contract matches a direct empty item array. |
| `current-filter-matched-root-shape-mismatch` | Items exist under a different known container. |
| `current-filter-matched-root-unrecognized` | A key matches but its result container is not recognized. |

## Files

| File | Change |
| --- | --- |
| `scripts/v2_place_ad_response_diagnostics.cjs` | New sanitized response-shape classifier. |
| `scripts/test_v2_place_ad_response_diagnostics.cjs` | Offline fixtures for present, empty, filtered, opening-only, nested, and absent advertisement responses. |
| `scripts/v2_live_basic_place_collector.cjs` | Writes sanitized diagnostics and returns bounded digest/count evidence. |
| `scripts/test_v2_live_basic_place_collector.cjs` | Verifies diagnostic artifacts, no-ad integration, and secret exclusion. |
| `scripts/v2_live_basic_place_render_worker.cjs` | Uses a fresh job and projects only validated diagnostic fields to the terminal. |
| `scripts/test_v2_live_basic_place_render_worker.cjs` | Verifies terminal projection and integrity allowlist. |
| `docs/v2_place_ad_diagnostic_render_job.json` | Fresh one-shot Render job identity. |
| `package.json` | Adds diagnostic check and test commands to the existing Render build path. |

Source identities used by the Render integrity gate:

- basic collector: `1583533ebd92188c6a377464a881468cd7f2ea06`
- diagnostics module: `7bb18cedecf94d8816239254389abf2cf5490c2d`

## Offline Verification

Node version: `v26.5.0`

| Test | Result |
| --- | --- |
| Basic collector integration | PASS, 58 assertions |
| Advertisement diagnostic fixtures | PASS, 48 assertions |
| Render Worker contract | PASS, 39 assertions |
| Existing Naver Apollo parser | PASS |
| Existing bounded live transport fixtures | PASS |
| External Provider requests | 0 |
| Operational writes | 0 |
| Raw Provider responses stored | 0 |
| Retry and fallback | 0 |

## Proposed One-Shot Live Contract

- Run ID: `rebuild-render-place-ad-diagnostic-20260814-001`
- Job SHA-256: `fa699573e9ae23fc9d238f6d0f72c9fe2c29ff6fb4d974cb9476c9d0a75f7334`
- Keyword: `경남 글램핑`
- Provider request budget: exactly 1 GET
- Retry: 0
- Fallback: 0
- Operational writes: 0
- Raw response storage: 0
- Outer live approval token: `N6-Ad-Diagnostic-Live`

The next live run must first deploy the committed N6 branch in readiness-only
mode. A separate live approval must then allow the fresh job exactly once. The
Worker must be restored to readiness-only after the terminal result, regardless
of diagnostic status.

## Current Stop Point

N6-D1 is implemented and verified locally only. No commit, push, Render change,
or Provider request has been performed.

HANDOFF_REBUILD_N6_D1
- baseline_commit: 651263caf4ccf9349a252754a015348dd23739ab
- local_branch: recovery/v2-place-ad-response-diagnostics
- frozen_collector_blob: bcbe229998da3afa6f31ee04375fb0766019e56f
- current_v2_collector_blob: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- diagnostic_module: scripts/v2_place_ad_response_diagnostics.cjs
- diagnostic_artifact: provider-diagnostics.json
- fresh_run_id: rebuild-render-place-ad-diagnostic-20260814-001
- approved_job_digest_preview: fa699573e9ae23fc9d238f6d0f72c9fe2c29ff6fb4d974cb9476c9d0a75f7334
- offline_tests: 58 + 48 + 39 assertions, parser PASS, transport PASS
- external_requests: 0
- operational_writes: 0
- raw_provider_responses_stored: 0
- render_changes: 0
- approval_n6_d1_commit_required: true
- recommended_next_scope: commit and push, readiness-only deploy, then separately approved one-request Render diagnostic
END_HANDOFF_REBUILD_N6_D1
