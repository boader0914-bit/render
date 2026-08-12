# Datalab Recovery Phase 10 Report

## Executive Result

Phase 10 produced an offline implementation candidate for a dedicated Render Key
Value transport. It preserves the Phase 9 signed fixture and idempotency contracts,
keeps the filesystem adapter compatible, and pins `bullmq@5.81.2` for Node `26.5.0`.

The candidate is not production-ready and does not claim exactly-once execution.
All transport tests used an in-memory BullMQ-compatible fake with network sockets
blocked. Real Redis/Valkey Lua behavior, lock timing, reconnects, persistence, and
Render shutdown timing remain `integration-unverified`.

No existing Render service, datastore, remote branch, Provider, operational DB, Web
endpoint, or frozen collector was changed.

## A. Baseline Integrity

| Check | Verified value | Result |
| --- | --- | --- |
| Baseline branch | `recovery/v4-fixture-transport-contract` | verified remotely |
| Baseline commit / local HEAD | `b12cee12b941c54aa81233cc809ba90f9f99fbbf` | match |
| Phase 9 parent | `7f6aba22cd5819fedf3f53c480fec92dfe8b56c2` | verified |
| Collector | `scripts/gyeongnam_glamping_crawl.cjs` | unchanged |
| Collector blob before | `bcbe229998da3afa6f31ee04375fb0766019e56f` | match |
| Collector blob after | `bcbe229998da3afa6f31ee04375fb0766019e56f` | match |
| Lock SHA-256 before | `ec929b3a95d22b80837bd7e59d23ebc61040e5a11344590bfebb23c6880eb123` | Phase 9 baseline |
| Lock SHA-256 after | `c4e2466ca939bef2f79b19151f617fbc7ebceabd997759cba905c54783c1fe79` | BullMQ pinned |
| Local branch | `recovery/v4-render-kv-transport` | local, uncommitted |
| Remote Phase 10 branch | absent | no push performed |

The independent worktree is
`work/v4-render-kv-transport`. Global Git configuration was not changed.

## B. Delivery And Failure Model

The explicit guarantee is **at-least-once delivery plus application idempotency**.
Exactly-once execution is not claimed.

```text
accepted -> queued -> active -> succeeded
                             -> failed
                             -> quarantined
```

| Event | Defined behavior |
| --- | --- |
| Lost enqueue acknowledgement | Retry the same idempotency key or call `getResult` |
| Same key and same payload | Return pending state or retained terminal result |
| Same key and different payload | Reject with an idempotency conflict |
| Reused nonce | Reject before runner execution |
| Worker crash / stalled claim | First stall becomes terminal; no redelivery |
| Queue outage | Fail closed; no filesystem fallback |
| Lost terminal acknowledgement | Recover through retained BullMQ job state |
| Invalid claimed record | Quarantine as failed before runner execution |
| SIGTERM | Stop intake, terminate/drain child, record terminal state, close clients |
| Retention expiry | Result and bounded duplicate identity can be removed |

Automatic retries and fallback are zero: `attempts=1`, no backoff, concurrency `1`,
manual claim, and `maxStalledCount=0`.

## C. Common Transport Interface

`scripts/v4_fixture_transport.cjs` defines the exact adapter interface:

- `enqueue(job)`
- `claim(workerId, leaseMs)`
- `heartbeat(claimId)`
- `complete(claimId, result)`
- `fail(claimId, result)`
- `getResult(idempotencyKey)`
- `releaseOnShutdown(claimId)`
- `close()`

The existing filesystem implementation is wrapped without changing its storage
contract and remains `crossServiceSupported: false`. The Render Key Value adapter is
the only cross-service candidate. The supervisor selects the adapter by transport
mode and keeps Provider, publish, and Web import gates at zero.

## D. Key Value And Signing Contract

The adapter uses a validated isolated queue prefix/name and a deterministic job ID:
`job-<sha256(idempotencyKey)>`. Nonce deduplication also uses a SHA-256 identity and a
seven-day bounded TTL. Terminal results are retained in completed/failed BullMQ job
state; there is no separate result-ledger write.

The producer signs only with the current key. The worker accepts current and optional
previous keys during a bounded rotation overlap. Unknown keys, invalid signatures,
changed payloads, expired/future jobs, and disallowed fixture jobs are rejected before
the parity runner.

Required signing names:

- `V4_FIXTURE_JOB_KEY_ID_CURRENT`
- `V4_FIXTURE_JOB_HMAC_KEY_CURRENT`

Optional overlap names:

- `V4_FIXTURE_JOB_KEY_ID_PREVIOUS`
- `V4_FIXTURE_JOB_HMAC_KEY_PREVIOUS`

Secret values, Redis URLs, signatures, and raw payloads are omitted from logs and this
report.

## E. Files And Dependency Changes

Modified:

- `docs/v4_fixture_transport_contract.md`
- `package.json`
- `package-lock.json`
- `scripts/test_v4_fixture_transport_contract.cjs`
- `scripts/v4_fixture_producer_simulator.cjs`
- `scripts/v4_fixture_transport_shadow_host.cjs`
- `scripts/v4_fixture_transport_supervisor.cjs`

Added:

- `docs/datalab_phase10_render_kv_transport_report.md`
- `docs/v4_phase11_render_kv_shadow_prompt.md`
- `docs/v4_render_kv_transport_contract.md`
- `render.v4-render-kv-transport.proposal.yaml`
- `scripts/test_v4_render_kv_transport.cjs`
- `scripts/v4_fixture_signing_keys.cjs`
- `scripts/v4_fixture_transport.cjs`
- `scripts/v4_render_kv_producer_simulator.cjs`
- `scripts/v4_render_kv_shadow_host.cjs`
- `scripts/v4_render_kv_supervisor.cjs`
- `scripts/v4_render_kv_transport.cjs`

`bullmq` is pinned exactly to `5.81.2`. The approved install added 20 packages and
reported a transitive deprecation warning for `cron-parser@4.9.0`; it did not block
installation. A fresh offline `npm ci` subsequently installed 29 packages and package
metadata again reported BullMQ `5.81.2`.

## F. Offline Verification

Node `26.5.0` results:

| Suite | Result | Evidence |
| --- | --- | --- |
| Fresh `npm ci --offline --omit=dev` | pass | lock is locally reproducible |
| Filesystem transport regression | pass | 15 contract checks |
| Render Key Value fake-adapter suite | pass | 18 contract checks |
| Full `npm run test:v4-recovery` | pass | all V4 recovery suites passed |
| Collector integrity | pass | before/after blob identical |
| Test network isolation | pass | external request count `0`, Redis sockets `0` |
| Operational isolation | pass | operational writes `0` |
| Retry/fallback controls | pass | automatic retries `0`, fallback absent |

The Key Value tests cover signed enqueue, two-consumer single claim, heartbeat,
terminal replay, concurrent duplicate producers, nonce replay, payload conflict,
invalid/unknown/rotated keys, expiry, future timestamps, stalls, lost acknowledgements,
partial artifacts, SIGTERM drain, namespace separation, outage fail-closed behavior,
and secret-output scanning.

One full-suite attempt encountered a transient Windows `EPERM` rename in the existing
shadow filesystem test. The standalone rerun and final full-suite run passed. This is
a residual local filesystem test flake, not evidence of Redis behavior.

## G. Verified Boundary And Blockers

Verified offline:

- common interface compatibility and unchanged filesystem behavior
- signed envelope and current/previous key verification
- deterministic idempotency identity and bounded nonce replay contract
- single claim, heartbeat, terminal replay, drain, and fail-closed behavior in the fake
- zero Provider calls and zero operational writes during tests

Integration-unverified:

- real BullMQ Lua atomicity under concurrent producers
- Redis/Valkey lock renewal and stalled-job timing
- connection loss and reconnect behavior around terminal transitions
- Render Key Value persistence, restore, memory pressure, and retention cleanup
- real SIGTERM behavior inside Render's shutdown grace period

No local `redis-server`, `valkey-server`, Docker, or Podman runtime was available.
No external or existing Redis instance was used. These items must remain blockers
until a separately approved isolated Key Value shadow test.

## H. Render Preview Only

`render.v4-render-kv-transport.proposal.yaml` is a proposal and was not synced.

Dedicated Key Value preview:

- name `datalab-v4-render-kv-queue`, Singapore, paid `starter`
- private access only, `ipAllowList: []`
- `maxmemoryPolicy: noeviction`
- paid `Journal + Snapshot` persistence
- no connection to any existing datastore

Worker preview:

- name `datalab-v4-render-kv-shadow`, one Singapore `starter` instance
- branch `recovery/v4-render-kv-transport`, Auto Deploy Off, Node `26.5.0`
- dedicated 1 GB disk at `/var/data/v4-render-kv-worker`
- initial readiness-only deployment with claims disabled and no bootstrap job
- Provider, operational publish, and Web import gates fixed to `0`

Official references: [Render Key Value](https://render.com/docs/key-value),
[Background Workers](https://render.com/docs/background-workers),
[Blueprint specification](https://render.com/docs/blueprint-spec),
[Persistent disks](https://render.com/docs/disks), and
[Deploy behavior](https://render.com/docs/deploys).

## I. Commands, Environment, And Controls

Build Command:

```text
npm ci --omit=dev --ignore-scripts --audit=false --fund=false && npm run check:v4-render-kv-transport && npm run test:v4-render-kv-transport
```

Initial Start Command:

```text
npm run start:v4-render-kv-supervisor
```

Separately approved fixture Start Command:

```text
npm run start:v4-render-kv-shadow
```

Transport and safety names:

- `NODE_VERSION`, `NODE_ENV`, `V4_FIXTURE_TRANSPORT_MODE`
- `V4_QUEUE_REDIS_URL`, `V4_QUEUE_NAME`, `V4_QUEUE_PREFIX`
- `V4_QUEUE_CLAIMS_ENABLED`, `V4_FIXTURE_TRANSPORT_ROOT`
- current/previous signing names from section D
- `V4_FIXTURE_EXTERNAL_CALLS_ENABLED`
- `V4_FIXTURE_OPERATIONAL_PUBLISH_ENABLED`
- `V4_FIXTURE_WEB_IMPORT_ENABLED`

Tuning names:

- `V4_FIXTURE_WORKER_ID`, `V4_FIXTURE_LEASE_MS`
- `V4_FIXTURE_HEARTBEAT_MS`, `V4_FIXTURE_POLL_MS`
- `V4_FIXTURE_CHILD_TIMEOUT_MS`, `V4_QUEUE_STALLED_INTERVAL_MS`
- `V4_QUEUE_RESULT_RETENTION_SECONDS`, `V4_QUEUE_NONCE_RETENTION_MS`
- `V4_QUEUE_COMPLETED_RETENTION_COUNT`, `V4_QUEUE_FAILED_RETENTION_COUNT`

`V4_QUEUE_CLAIMS_ENABLED=0` is the intake kill switch. Default retention is seven
days, capped at 1,000 completed and 5,000 failed jobs. Readiness requires the Queue
client and, when claims are enabled, the Worker client, plus the singleton lock and
all three safety gates at exact zero.

## J. Phase 8 Shutdown Delay

The authenticated Render dashboard was inspected read-only for
`srv-d9tog1dbedkc739nvm20`, but its Settings UI did not expose
`maxShutdownDelaySeconds`. No authenticated Render CLI or API credential was
available. The observed value is therefore `unknown`; it was not changed.

Proposed diffs only, not executed:

```text
# CLI preview
render services update srv-d9tog1dbedkc739nvm20 --max-shutdown-delay 60 --output json

# API preview
PATCH /v1/services/srv-d9tog1dbedkc739nvm20
{"serviceDetails":{"maxShutdownDelaySeconds":60}}

# Blueprint preview
maxShutdownDelaySeconds: 60
```

The API configuration update and any subsequent deploy are separate operational
events. Changing the existing parity shadow remains outside Phase 10 and requires a
separate approval from the new Key Value shadow.

## K. Phase 11 Draft

The proposed next-stage prompt is
`docs/v4_phase11_render_kv_shadow_prompt.md`. It separates approval to create a
dedicated Key Value plus claims-disabled readiness deployment from approval to run one
committed fixture, perform one controlled restart, verify terminal replay, and restore
claims-disabled readiness.

## External Activity Accounting

Offline test processes opened zero external/Redis sockets and performed zero Provider
or operational calls. Outside the tests, one explicitly approved npm dependency
installation contacted the package registry; official public documentation and the
remote Git branch list were read only. No Render mutation, Redis connection, Provider
request, Git push, PR, or operational write occurred.

```text
HANDOFF_PHASE_10
- baseline_commit: b12cee12b941c54aa81233cc809ba90f9f99fbbf
- collector_blob_before: bcbe229998da3afa6f31ee04375fb0766019e56f
- collector_blob_after: bcbe229998da3afa6f31ee04375fb0766019e56f
- lockfile_sha256_before: ec929b3a95d22b80837bd7e59d23ebc61040e5a11344590bfebb23c6880eb123
- lockfile_sha256_after: c4e2466ca939bef2f79b19151f617fbc7ebceabd997759cba905c54783c1fe79
- local_branch: recovery/v4-render-kv-transport (local only, uncommitted)
- files_changed: 7 modified and 11 added tracked files, including this report
- queue_library: bullmq@5.81.2, exact dependency, Node 26.5.0
- transport_interface: enqueue, claim, heartbeat, complete, fail, getResult, releaseOnShutdown, close
- filesystem_adapter_regression: passed, 15 contract checks
- key_value_adapter: BullMQ manual-claim candidate with deterministic job and nonce identities
- delivery_semantics: at-least-once plus application idempotency; exactly-once not claimed
- retry_policy: attempts=1, no backoff, maxStalledCount=0, no automatic fallback
- key_rotation: producer current-only; worker current plus optional previous overlap
- offline_tests: full v4-recovery pass; Key Value 18 checks; test network sockets 0
- redis_integration_status: integration-unverified; no local or external Redis used
- external_calls: Provider 0, Redis 0, Render mutation 0; approved npm install and read-only research only
- operational_writes: 0
- render_key_value_preview: dedicated Singapore starter, private, noeviction, journal-snapshot
- render_worker_preview: one-instance fixture-only worker, claims=0 first deploy, dedicated 1 GB disk
- max_shutdown_delay_observed: unknown; dashboard did not expose it and no authenticated CLI/API was available
- unknowns: real Lua races, locks/stalls, reconnects, persistence/restore, memory pressure, Render SIGTERM timing
- blockers: isolated real Render Key Value integration and separately approved Phase 11 deployment
- approval_i_required: true
- recommended_phase_11_scope: create isolated Key Value and claims=0 worker, then separately approve one committed fixture/restart/replay/restore cycle
END_HANDOFF_PHASE_10
```
