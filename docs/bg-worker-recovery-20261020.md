# BG worker control-plane recovery

This release is based on production `1f22801`. It does not include the rejected
company-detail/heavy-work changes from `70e68b8`.

## Persistent service

An idle claim's transient network/timeout/408/429/5xx failure waits with capped
exponential backoff and jitter. This is traffic to our broker only; provider
request pacing and provider block detection are unchanged. A logical claim uses
one UUID through retries. The broker durably reserves this nonce and replays the
same unacknowledged, unexpired lease without extending its expiration. It never
assigns an already used nonce to another job, including after receipt archival.

Authentication/configuration errors, provider-block results and an unconfirmed
terminal ACK enter a live, fail-closed quarantine. No new claim or provider crawl
is attempted there. Resolve the recorded code before an explicit worker restart;
the service does not reset broker protection. Shutdown signals interrupt waits.
Logs contain allowlisted codes/status and retry durations, not secrets or bodies.

## Reconcile a stored completed BG result

`POST /api/collection-rotation/reconcile` requires administrator authentication,
JSON and the normal same-origin boundary. The plan must be disabled and every
collection lane idle. Example fields are `slotId`, `runId`, `dryRun`, optional
`reviewLegacy`, and the preview's `expectedVersion` for application. This endpoint
never crawls, changes original artifacts, clears protection, or enables a plan.

The verifier reads the manifest and a completed broker receipt, checks exact
worker/keyword/scheduled trigger/search/date/day-count/rank/product/day-use/adult
conditions, quality, job and run identity, and all published file hashes. It also
rechecks file metadata and the completed broker job at the end of verification.
Preview/application compare both slot state and evidence digests. Prior scheduling
rows and their error codes remain in a separate reconciliation audit table.

New BG results receive a broker-generated scheduling receipt linking the stored
occurrence ID to the broker job. Worker-supplied receipt text is not trusted.
Older artifacts without occurrence IDs require explicit `reviewLegacy:true`:
one matching scheduled result, exact conditions, a completed broker job, all file
hashes, and an actual start within five minutes after the stored slot acceptance.
This attribution is recorded as administrator-reviewed legacy attribution, not as
an occurrence ID found in the original manifest. Ambiguous/incomplete/blocked or
modified results remain unresolved. This verifier currently supports BG/manual
results only; unsupported web/retired-worker matches fail closed.

## Release and verification

Deploy the web broker first, then the BG worker at the same commit. Before resuming
a suspended worker, verify no queued/leased collection and disabled individual and
shared schedules. Back up the scheduling database through SQLite backup. Preview,
apply once, then read back the matching slot/result and verify source hashes.
Only after the BG connection is current may the existing shared schedule be
enabled with its unchanged conditions. Past observation days are not caught up.

`npm run test:collector-recovery` runs worker/broker/scheduler/verifier checks and
real local HTTP integration with outbound provider access prohibited. Windows
file-symlink checks can be explicitly skipped without elevated privileges;
directory-junction and path-escape checks still run.
