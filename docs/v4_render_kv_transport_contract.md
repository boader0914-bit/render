# Datalab V4 Render Key Value Transport Contract

## Scope

This is an offline implementation candidate for a dedicated Render Key Value queue.
It carries only the signed Phase 9 fixture contract and does not connect Web 2, call a
Provider, publish to an operational endpoint, or claim exactly-once execution.

| Item | Fixed value |
| --- | --- |
| Baseline commit | `b12cee12b941c54aa81233cc809ba90f9f99fbbf` |
| Frozen collector blob | `bcbe229998da3afa6f31ee04375fb0766019e56f` |
| Signed job schema | `datalab-v4-fixture-signed-job.v1` |
| Result schema | `datalab-v4-fixture-result.v1` |
| Transport interface | `datalab-v4-transport.v1` |
| Queue record schema | `datalab-v4-render-kv-job.v1` |
| Queue library candidate | `bullmq@5.81.2` |
| Runtime | Node `26.5.0` |

`bullmq@5.81.2` must be present in `package-lock.json` and its installed package
metadata must report the same version before a shadow deployment is eligible. The
fake adapter test does not prove compatibility with a real Redis or Valkey server.

## Delivery Semantics

The guarantee is **at-least-once delivery with application idempotency**. The system
does not claim exactly-once execution.

```text
accepted -> queued -> active -> succeeded
                             -> failed
                             -> quarantined
```

- `accepted` means the envelope, time window, fixture allowlist, payload digest, and
  HMAC are valid.
- `queued` is a BullMQ job with a deterministic ID derived from the idempotency key.
- `active` is one manually claimed job with a BullMQ lock and application heartbeat.
- `succeeded` stores the normalized result as the completed job return value.
- `failed` stores a normalized terminal result in the failed reason.
- `quarantined` is a failed job without a runnable result, used for invalid queue
  records or invalid signatures found at claim time.

Automatic retry and fallback are zero: `attempts: 1`, no backoff, concurrency `1`,
manual claim, and `maxStalledCount: 0`. A first detected stall becomes failed rather
than returning to the wait list. A lookup maps that state to
`FIXTURE_STALE_CLAIM_NO_AUTO_RETRY`.

## Idempotency And Replay

The queue job ID is `job-<sha256(idempotencyKey)>`; the raw key is not used in the
Redis key name. The record retains the signed envelope and a payload identity derived
from the signed payload digest, scenario, requested commit, and collector blob.

| Request | Response before runner |
| --- | --- |
| Same key and same payload, pending | `FIXTURE_IDEMPOTENCY_PENDING` |
| Same key and same payload, terminal | Existing result, `collectorInvocations: 0` |
| Same key and different payload | `FIXTURE_IDEMPOTENCY_CONFLICT` |
| Reused nonce | `FIXTURE_NONCE_REPLAY` |
| Unknown key, bad signature, changed payload, expired/future job | Rejected |

Nonce deduplication uses a SHA-256-derived BullMQ deduplication ID and a bounded TTL.
The nonce TTL must be at least the terminal result retention period. Idempotency and
nonce protection end when their retained BullMQ records expire; callers must not
assume an unlimited ledger.

Concurrent duplicate insertion and nonce behavior depend on BullMQ's server-side
scripts. The in-memory contract test covers the expected behavior, but a real Redis or
Valkey integration test remains required.

## Failure Model

| Failure | Defined behavior | Remaining risk |
| --- | --- | --- |
| Producer enqueue response lost | Retry by idempotency key or call `getResult`; never invent a new key | Pending lookup is not exposed through Web 2 |
| Completion/failure acknowledgement lost | Read terminal state with `getResult` | Transport outage can leave the commit outcome temporarily unknown |
| Worker crash with lock | BullMQ stall detection fails the first stall; no redelivery | Actual server timing is integration-unverified |
| Queue unavailable at enqueue | Fail closed with `V4_QUEUE_UNAVAILABLE`; no local fallback | Caller must reconcile later |
| Queue unavailable at claim | Supervisor exits or remains unready; no fixture runner starts | Render restart policy is not exercised offline |
| Invalid job discovered after claim | Move to failed quarantine before runner | Quarantine requires operator inspection |
| Partial artifact | Existing isolated attempt directory remains unpublished | Cleanup is manual |
| SIGTERM while idle | Stop new claims, close worker and queue | Render grace value must be configured separately |
| SIGTERM while active | Stop intake, terminate child, commit terminal shutdown result, then close | If Key Value is unavailable, terminal commit can be uncertain |
| Result retention exceeded | BullMQ may remove the job and its idempotency identity | A future durable ledger would be required for longer guarantees |

BullMQ stores the terminal payload in the same job state transition; this candidate
does not perform a separate result-ledger write. Retention cleanup therefore removes
both the terminal result and its queue-scoped duplicate identity.

## Adapter Responsibilities

The common interface lives in `scripts/v4_fixture_transport.cjs`.

| Method | Filesystem fixture adapter | Render Key Value adapter |
| --- | --- | --- |
| `enqueue` | Atomic local files and ledgers | Signed BullMQ add with deterministic job and nonce IDs |
| `claim` | Atomic rename and lease file | Manual BullMQ `getNextJob` and lock token |
| `heartbeat` | Rewrite lease record | BullMQ `extendLock` |
| `complete` | Atomic result and ledger files | `moveToCompleted` with normalized return value |
| `fail` | Atomic failure result and ledger files | `moveToFailed` with encoded normalized result |
| `getResult` | Read idempotency ledger | Read retained completed/failed BullMQ job |
| `releaseOnShutdown` | Terminal shutdown result | Terminal failed job; no requeue |
| `close` | Clear process-local claims | Gracefully close BullMQ Worker and Queue |

The filesystem adapter remains `crossServiceSupported: false`. The Key Value adapter
is the only cross-service candidate and uses an isolated queue name and prefix. Code
must never enumerate, read, or delete keys outside that namespace.

## Signing Key Rotation

Required current key names:

- `V4_FIXTURE_JOB_KEY_ID_CURRENT`
- `V4_FIXTURE_JOB_HMAC_KEY_CURRENT`

Optional overlap names, which must be configured as a pair:

- `V4_FIXTURE_JOB_KEY_ID_PREVIOUS`
- `V4_FIXTURE_JOB_HMAC_KEY_PREVIOUS`

The producer signs only with `current`. A worker accepts only the current and optional
previous IDs. Unknown IDs are rejected before the parity runner. Secrets are read from
environment variables and are omitted or redacted from logs, results, fixtures, and
reports.

Rotation procedure:

1. Configure workers with the new key as current and the old key as previous.
2. Verify worker readiness, then switch producers to the new current key.
3. Wait for the maximum signed-job TTL and for all old-key queued/active jobs to drain.
4. Remove both previous-key variables and verify unknown-old-key rejection.

Rollback during overlap restores the old key as current while retaining the new key
as previous. After the previous key is removed, rollback requires a separately
approved secret configuration change.

## Queue Configuration

Required:

- `NODE_ENV=test`
- `V4_FIXTURE_TRANSPORT_MODE=render-key-value`
- `V4_QUEUE_REDIS_URL`
- `V4_QUEUE_NAME`
- `V4_QUEUE_PREFIX`
- `V4_QUEUE_CLAIMS_ENABLED`
- `V4_FIXTURE_TRANSPORT_ROOT`
- current signing key ID and secret names above
- `V4_FIXTURE_EXTERNAL_CALLS_ENABLED=0`
- `V4_FIXTURE_OPERATIONAL_PUBLISH_ENABLED=0`
- `V4_FIXTURE_WEB_IMPORT_ENABLED=0`

Tuning and retention:

- `V4_FIXTURE_WORKER_ID`
- `V4_FIXTURE_LEASE_MS=30000`
- `V4_FIXTURE_HEARTBEAT_MS=5000`
- `V4_FIXTURE_POLL_MS=500`
- `V4_FIXTURE_CHILD_TIMEOUT_MS=120000`
- `V4_QUEUE_STALLED_INTERVAL_MS=30000`
- `V4_QUEUE_RESULT_RETENTION_SECONDS=604800`
- `V4_QUEUE_NONCE_RETENTION_MS=604800000`
- `V4_QUEUE_COMPLETED_RETENTION_COUNT=1000`
- `V4_QUEUE_FAILED_RETENTION_COUNT=5000`

Fixture shadow bootstrap, configured only for the separately approved execution
deploy:

- `V4_FIXTURE_BOOTSTRAP_ENABLED=1`
- `V4_FIXTURE_BOOTSTRAP_JOB_FILE=tests/fixtures/v4_collector_parity_job.json`
- `V4_FIXTURE_BOOTSTRAP_SCENARIO=success`

`V4_QUEUE_CLAIMS_ENABLED=0` is the intake kill switch. The initial readiness-only
deployment uses `npm run start:v4-render-kv-supervisor` and enqueues no job. This
avoids staging a signed fixture that can expire before claims are enabled. A later
approved deploy changes the Start Command to `npm run start:v4-render-kv-shadow` and
sets claims and the three bootstrap variables together. Every live/provider/publish
gate remains exactly `0`.

## Render Shadow Candidate

- Dedicated Singapore Key Value, paid plan, public access disabled
- `maxmemoryPolicy: noeviction`
- paid `Journal + Snapshot` persistence
- isolated queue namespace, memory alert, bounded retention, and no connection to an
  existing database or Redis instance
- one Background Worker instance, Auto Deploy Off, Node `26.5.0`
- one 1 GB artifact disk mounted at `/var/data/v4-render-kv-worker`
- `maxShutdownDelaySeconds: 60`
- Build: `npm ci --omit=dev --ignore-scripts --audit=false --fund=false && npm run check:v4-render-kv-transport && npm run test:v4-render-kv-transport`
- First readiness-only Start: `npm run start:v4-render-kv-supervisor`
- Approved fixture-execution Start: `npm run start:v4-render-kv-shadow`

Background Workers do not expose an HTTP health endpoint. Readiness is the structured
`fixture_supervisor_ready` event after the Queue client is ready and, when claims are
enabled, the Worker client is also ready. The local singleton lock must be held, all
safety gates must be zero, and the log must report the expected transport and
claim-switch state. `numInstances` must remain `1`.

The first deployment must use `V4_QUEUE_CLAIMS_ENABLED=0` and no bootstrap variables.
Enabling it and switching to the committed-fixture entrypoint must be one controlled,
approved deploy so the five-minute signed-job lifetime starts only when the consumer
can claim. Restarting or changing a Render resource also requires the next approval.
The proposal is in `render.v4-render-kv-transport.proposal.yaml`; it is not a synced
Blueprint.

## Verification Boundary

Verified without network sockets:

- interface compatibility and unchanged filesystem regression
- signature, time-window, payload, nonce, and idempotency checks
- one of two consumers obtaining a claim
- heartbeat contract, terminal replay, lost acknowledgement reconciliation
- no-auto-retry stall behavior in the fake BullMQ implementation
- key overlap, namespace separation, queue-outage fail-closed behavior, and drain
- zero external Provider calls and zero operational writes

Integration-unverified until a separately approved isolated Redis/Valkey test:

- actual BullMQ Lua scripts and atomic duplicate races
- lock renewal and stalled detection timing
- Render Key Value persistence and reconnect behavior
- memory pressure with `noeviction`, retention cleanup, and restore behavior
- real SIGTERM timing under Render's shutdown grace period

## Sources

- https://render.com/docs/key-value
- https://render.com/docs/background-workers
- https://render.com/docs/blueprint-spec
- https://render.com/docs/disks
- https://render.com/docs/deploys
- https://docs.bullmq.io/patterns/manually-fetching-jobs
- https://docs.bullmq.io/guide/retrying-failing-jobs
- https://docs.bullmq.io/guide/workers/stalled-jobs
- https://docs.bullmq.io/guide/workers/graceful-shutdown
- https://docs.bullmq.io/guide/jobs/job-ids
- https://docs.bullmq.io/guide/jobs/deduplication
- https://docs.bullmq.io/patterns/failing-fast-when-redis-is-down
- https://docs.bullmq.io/guide/connections
