# DataLab Rebuild Phase 3 D6 Fresh Run Identity

## Scope

The approved D4 Render execution atomically claimed
`rebuild-phase3-booking-business-render-live-001` before its child-process
contract failed. D5 intentionally preserved that claim, so reusing the same run
identity would stop at `render_diagnostic_duplicate_blocked` before any child or
Provider request.

D6 gives a future separately approved diagnostic a fresh immutable identity:

- run ID: `rebuild-phase3-booking-business-render-live-002`;
- job canonical SHA-256:
  `dc5fe2afa8e9b90fc601375597ec597930f2910a50749b0a4978ebb07b0de5b4`;
- live approval token: `N3-D6-Live`.

The run ID, job digest, and approval token are checked together. The prior run
directory is never deleted, renamed, overwritten, or treated as retryable.

## Unchanged Boundaries

The copied dependency closure, target Place identity, GraphQL operation and
request envelope, request budget, timeout, parser, child framing diagnostics,
retry/fallback policy, operational-write policy, and redaction contract are
unchanged. This local phase performs no Provider request and no Render change.

## Offline Verification

The one-shot suite pre-creates a failed `render-live-001` claim, then requires
`render-live-002` to run once through the fixture transport while preserving the
old evidence. A second `render-live-002` attempt must still be duplicate-blocked.
All existing child framing, concurrency, process lifetime, network isolation,
and secret leakage scenarios remain required.

The shallow-checkout contract pins the reviewed D5 commit as the sole parent and
attests exactly the seven D6 files. A complete proposed-tree depth-1 checkout must
pass the same Node 26.5.0 suites before commit approval is requested.

Verified results:

- full-history one-shot suite: 278 assertions passed;
- full-history environment suite: 60 assertions passed;
- full-history booking-business suite: 557 assertions passed;
- synthetic depth-1 one-shot suite: 278 assertions passed;
- synthetic depth-1 environment suite: 60 assertions passed;
- synthetic depth-1 booking-business suite: 557 assertions passed;
- prior `render-live-001` failure evidence remained byte-equivalent;
- fresh `render-live-002` fixture invocation: exactly one;
- duplicate `render-live-002` invocation: blocked before child execution;
- actual Provider requests, retries, fallbacks, and operational writes: zero;
- secret scan: passed;
- V2 collector blob: `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`;
- frozen reference collector blob:
  `bcbe229998da3afa6f31ee04375fb0766019e56f`;
- lockfile SHA-256:
  `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2`.

Commit, push, Render changes, fixture deployment, and Provider calls require
separate approvals.
