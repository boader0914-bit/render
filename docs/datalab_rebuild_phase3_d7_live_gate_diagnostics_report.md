# DataLab Phase 3 D7 Live-Gate Diagnostics

## Purpose

The approved D6 Render attempt stopped before its child process and before any
Provider request with `V2_RENDER_DIAGNOSTIC_LIVE_NOT_APPROVED`. D7 adds a
local-only, fail-closed diagnostic that identifies which of the eight live
authorization checks matched without retaining any environment value.

## Diagnostic Contract

The diagnostic exposes boolean results for only these semantic checks:

- run enabled;
- live approval token matched;
- request budget equals one;
- approved job digest matched;
- expected request-envelope digest matched;
- automatic retry disabled;
- fallback disabled;
- operational writes disabled.

It never stores an actual value, value length, value digest, raw environment,
secret, identifier, request, or Provider response. A second allowlist rebuilds
the diagnostic before stdout projection. Unknown fields, unknown check names,
non-boolean results, and inconsistent aggregate status are discarded.

The dedicated `gate-check-and-hold` command verifies code/deploy integrity,
prints only the boolean matrix and zero-side-effect counters, and then holds for
inspection. Even when every gate matches, it has no path to claim a run, spawn
the copied child, or contact the Provider.

## Integrity Boundary

- reviewed parent: `b7a88ed124adb00e7310ebf60ff1a1be886b9fbd`;
- protected tree: 346 entries;
- protected tree SHA-256:
  `239aae66eecd6d8955357894cfc1d1b474dc1ac6fcd28bd54aed95765720a377`;
- D7 change allowlist: this report, runner, runner test, harness, and harness test;
- collector blob, frozen collector blob, lockfile, Place ID hash, job digest,
  request-envelope digest, request budget, and fresh run ID remain unchanged.

Both full-history and depth-1 verification require the eventual D7 commit to be
the direct single child of the reviewed parent. No Render setting, service,
disk, Provider, operational store, branch on the remote, or deployment is
changed by this local phase.

## Required Offline Verification

- every single missing or enabled gate is classified independently;
- multiple secret-valued mismatches expose booleans only;
- forged diagnostic fields are rejected or reconstructed from the allowlist;
- rejected gates create no run claim and no child invocation;
- existing fixture, duplicate, concurrency, process-lifetime, network-isolation,
  output-redaction, and source-integrity suites continue to pass;
- full-history and synthetic depth-1 checkouts pass under Node 26.5.0;
- actual Provider requests, retries, fallbacks, and operational writes remain zero.

## Offline Verification Result

Node 26.5.0 verification passed in both a full-history proposed commit and a
synthetic depth-1 checkout of that same commit. The proposed commit was a
direct single child of the reviewed parent and contained exactly the five
allowlisted paths.

| Suite | Full history | Depth 1 |
| --- | ---: | ---: |
| Render one-shot diagnostics | 353 passed | 353 passed |
| Environment diagnostics | 62 passed | 62 passed |
| Booking-business harness | 559 passed | 559 passed |

The one-shot suite confirmed that all eight individual gate mismatches are
classified independently, a rejected gate creates no run directory, and the
copied child is never invoked. Secret sentinels and expected approval values
were absent from the safe diagnostic projection. Both checkout modes reported
zero actual Provider requests, zero retries, zero fallbacks, zero operational
writes, and no stored raw Provider response. The environment suite used six
loopback-only requests, and the harness used fixtures only.

## Interpretation

The previous D6 result proves only that one or more live gates did not match at
runtime. It does not contain enough evidence to identify which gate differed.
This change does not infer or reconstruct that missing value. After a separate
commit and readiness deployment approval, a readiness-only process can expose
the boolean gate matrix before any future one-shot Provider approval is used.

Commit, push, Render changes, fixture execution, and Provider calls require
separate approvals.
