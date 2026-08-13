# DataLab Rebuild Phase 3 D5 Child Framing Diagnostics

## Scope

This local-only change diagnoses the child-process contract failure observed on
the approved N3-D4 Render one-shot. The first live process ended with
`V2_RENDER_DIAGNOSTIC_CHILD_INVALID`; the existing parent collapsed stdout
framing, JSON parsing, process exit, signal, timeout, and stderr failures into the
same code and discarded the safe error code emitted by the child.

The V2 collector, copied dependency closure, GraphQL request envelope, Provider
transport, parser, job contract, request budget, and operational integration are
unchanged. No Render resource or Provider was accessed in this phase.

## Diagnostic contract

The parent still fails closed under the existing
`V2_RENDER_DIAGNOSTIC_CHILD_INVALID` code. It now adds a bounded
`childProcessDiagnostic` containing only:

- failed check enums;
- process exit code and an allowlisted signal class;
- timeout and stdout truncation booleans;
- stdout line and byte counts plus stderr byte count;
- JSON parse, expected schema, and child status classifications;
- an explicit allowlist of child error codes;
- child-reported call counts restricted to zero or one and marked untrusted.

Raw stdout, raw stderr, Provider bodies, header values, identifiers, URLs,
messages, stacks, and unknown fields are never projected. Diagnostics are
allowlisted again before being written to `failure.json` or the one-line process
result, so a forged error object cannot add arbitrary fields.

## Offline verification

The test suite covers:

- a valid one-line child result;
- structured child failure with a non-zero exit;
- empty or multiple-line stdout framing;
- invalid JSON, unexpected schema, and invalid result status;
- known and unknown signals, timeout, stderr, and stdout truncation;
- allowlisted and unknown child error codes;
- forged diagnostic fields and secret-sentinel injection;
- atomic failure evidence, durable duplicate blocking, and no retry;
- the real offline fixture child and the readiness process lifetime contract.

Every scenario requires zero actual Provider requests, zero operational writes,
zero retries, zero fallbacks, no raw Provider response storage, and no secret or
raw identifier leakage.

Verified on Node 26.5.0 with bundled Undici 8.7.0:

- Render one-shot diagnostics: 269 assertions passed;
- environment diagnostics: 60 assertions passed;
- V2 booking-business recovery: 557 assertions passed;
- real child preflight failure: one structured line, exit code 1,
  `V2_BOOKING_BUSINESS_SOURCE_INVALID`, and zero reported requests;
- actual Provider requests, retries, fallbacks, and operational writes: zero;
- V2 collector blob: `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`;
- frozen reference collector blob:
  `bcbe229998da3afa6f31ee04375fb0766019e56f`;
- lockfile SHA-256:
  `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2`.

## Evidence interpretation

The live N3-D4 evidence is not reclassified. Its first-run external request count
remains unknown within the approved bound of zero or one because the old failure
artifact did not contain this diagnostic. A future live execution requires a
separate approval and must use a fresh run identity; D5 itself performs no live
call and makes no claim about the prior root cause.

## Deployment boundary

Commit, push, Render configuration, Resume, deployment, fixture execution, and
Provider calls remain prohibited until separately approved.
