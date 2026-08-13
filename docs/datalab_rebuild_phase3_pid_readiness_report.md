# DataLab Phase 3 Place Identity Readiness Preparation

## Purpose

This local-only change prepares the existing isolated Render diagnostic worker to
recognize commit `690f577e1c86d3fa7f8d3f00f9ade6a87c444b14` as the reviewed Place primary
identity baseline. It does not deploy, resume a service, or call a Provider.

## Integrity Contract

- Full-history and depth-1 verification both require the readiness commit to
  have `690f577...` as its sole parent.
- The protected baseline tree contains 342 entries with SHA-256
  `ac9351bda4c757fb38cfa59dd1844fefaf2d4de1f81b1f779d79650207a72f2e`.
- Only the eight readiness preparation files are mutable and individually
  attested in a shallow checkout.
- The V2 collector blob, frozen collector blob, lockfile, Place ID hash, request
  envelope, request budget, and D6 fresh run ID remain unchanged.
- `serve` readiness now verifies the same full-history or shallow lineage contract
  used by the build suites.
- Historical environment evidence remains tied to its D1 source blobs and
  canonical evidence digest instead of the current mutable report blob.

## Runtime Boundary

Readiness uses `V2_RENDER_DIAGNOSTIC_RUN_ENABLED=0` and
`V2_RENDER_DIAGNOSTIC_REQUEST_BUDGET=0`. Live approval variables must be absent;
retry, fallback, and operational writes remain disabled. Provider execution and
Render changes require separate approvals.

## Local Validation

- Runtime: Node `26.5.0`.
- A disposable proposed commit was verified as the direct single child of the
  Place identity baseline with exactly the eight approved changed paths.
- Full-history checkout: render one-shot `282`, environment diagnostics `62`,
  and harness `558` assertions passed.
- Depth-1 checkout: the same `282`, `62`, and `558` assertions passed using the
  pinned HEAD, recorded parent, protected tree, and source-blob fallback.
- Readiness returned `render_diagnostic_ready` in both checkout forms with
  `runEnabled=false`, request budget `0`, external requests `0`, and operational
  writes `0`.
- Test-only loopback probes remained local. Provider requests, retries,
  fallbacks, Render mutations, and operational writes were zero.

No commit, push, deployment, service resume, fixture run, or Provider call was
performed by this preparation step.
