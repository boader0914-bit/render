# Incremental source checkpoint identity relocation

`scripts/lib/keyword_monthly_source_relocation.cjs` is a host-side helper for a
remounted persistent disk whose kernel device number changed. It never starts
collection, imports the app entry point, changes original sources, or publishes
financial results. Existing analytical-child source guards remain unchanged.

Call `relocateKeywordMonthlySources({dataDir, expectedStateSha256,
expectedPointerSha256, operationId, assertExclusive, admission, outbox, now})`
only while holding the real exclusive incremental worker lease or explicit
maintenance marker, before creating a new child job input. `operationId` is the
owned lease/maintenance UUID. The required `assertExclusive` callback must return
exactly `true` and revalidate that exact owned marker's bytes and identity, plus
the absence of a recovery claim. Collector/analytical idle admission belongs to
the caller; `admission` may throw or return `false` to hold. A new attempt must
use the returned checkpoint SHA in its new input; never reuse an old child input.

The helper returns `unchanged` without original-body reads when both device
numbers still match. This deliberately makes no source freshness claim: normal
same-device edits must still pass the existing immutable delta/stamp chain.

If any device number changed, every source must satisfy all of these conditions:

- Current versus cached and cached versus original bootstrap stamps match in
  inode, size, nanosecond mtime/ctime and single-link count. Only `dev` may differ.
- The complete current outbox ID set exactly equals `state.appliedEvents`; no
  new, missing, duplicate or incomplete event is admitted. Each complete marker,
  full event body SHA/length and content-derived event ID is reread and verified.
- Both exact original paths are streamed to completion with one 1 MiB buffer,
  `O_NOFOLLOW`, pre/post descriptor/path/parent identity checks, a 2 GiB ceiling
  per source, and a total fifteen-minute bound including admission callbacks.
  SHA and exact byte length must equal `bootstrapSources`; size alone is not proof.
- Source/public/checkpoint pointers and outbox evidence remain stable through
  final admission. Any other drift holds; it never authorizes rebootstrap.

Every relocation repeats the full trusted-byte proof, so a later remount is
supported even when cached and original-bootstrap device numbers already differ.
`bootstrapSources` remains historical and is never rewritten. All company/history
references, applied events, dirty state, `lastPublished`, and other state remain
exact. Only `sourceStamps`, generation, update time and controlled
`sourceIdentityRelocation` provenance change. The previous immutable state SHA
provides the audit chain; publication and issued-report files are untouched.

Private immutable evidence is stored at
`keyword_monthly_incremental/source-relocations/<operation UUID>/`:

- `original-pointer.json`: exact original pointer bytes.
- `verification.json`: hashes, stamps, bounds and event proof; no source rows or money.
- `relocation-intent.json`: old identities and expected next state SHA before save.
- `relocation-complete.json`: verified new identities after save.

The return value includes `{status, current:{stateSha256,pointerSha256}, receipt}`;
`receipt` is `{file,sha256,bytes}` for the completion receipt, or `null` when
unchanged. Existing audit directories are never overwritten or deleted.

An error after possible source-checkpoint promotion raises
`KEYWORD_SOURCE_RELOCATION_NEEDS_READBACK` with the operation ID, audit directory
and expected next state SHA. No rollback, deletion, retry or automatic audit
completion occurs. Stop the calling operation and manually inspect the exact
pointer, old blob, intent and completion receipt before proceeding. A later
attempt also requires the previous provenance tag's exact verification SHA and
matching completed audit receipt, including on the same-device fast path. Missing
or malformed prior evidence holds with the same controlled error; it is never
automatically reconciled. Normal later context preparation may advance the state
SHA without invalidating a correctly completed earlier relocation receipt.

Validation: `node --test scripts/test_keyword_monthly_source_relocation.cjs`.
