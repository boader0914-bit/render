# DataLab Rebuild Phase 3 D3 Shallow Integrity Fix

## Scope

This local-only change addresses the Render build failure recorded for deploy
`dep-d9uocdijobas73bbddb0`. Render checked out the approved commit with shallow
history, so `git merge-base --is-ancestor` could not read the older N2 and D1
commit objects even though the full repository proves the ancestry.

No Render service, Provider endpoint, operational store, remote branch, or UI is
changed in this phase.

## Fail-closed contract

Full-history checkouts continue to require the existing Git ancestry and
Phase 3 allowlist diff checks. A shallow checkout is accepted only when all of
the following evidence matches:

- the checked-out HEAD equals `V2_RENDER_DIAGNOSTIC_EXPECTED_DEPLOY_COMMIT`;
- the HEAD commit object records the reviewed parent commit;
- the protected N2 tree contains exactly 322 entries and matches the frozen
  SHA-256 digest;
- protected worktree files have no diff from HEAD;
- each source file introduced by this fix has a worktree blob equal to its HEAD
  blob;
- the existing source manifest, collector blobs, lockfile, Phase 2 evidence,
  job digest, runtime, and safety gates continue to pass.

Absence of history outside a shallow checkout, an unpinned HEAD, a changed
parent, a protected tree mutation, a source worktree mutation, or any existing
integrity mismatch remains a hard failure.

## Offline verification

- Full-history V2 booking-business regression
- Synthetic depth-1 checkout success
- Wrong shallow HEAD rejection
- Wrong shallow parent rejection
- Protected committed tree mutation rejection
- Protected worktree mutation rejection
- Approved source worktree mutation rejection
- V2 environment diagnostics regression
- V2 Render one-shot regression
- Provider requests, retries, fallbacks, and operational writes remain zero

Verified results on Node 26.5.0:

- booking-business harness: 557 assertions passed;
- environment diagnostics: 60 assertions passed;
- Render one-shot: 189 assertions passed;
- a depth-1 clone of the complete proposed tree passed the same Render build
  command sequence;
- actual Provider requests and operational writes: zero;
- collector blob: `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`;
- frozen reference collector blob: `bcbe229998da3afa6f31ee04375fb0766019e56f`;
- lockfile SHA-256:
  `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2`.

## Deployment boundary

Commit, push, Render Resume, deployment, fixture execution, and Provider calls
remain prohibited until separately approved.
