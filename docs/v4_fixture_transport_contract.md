# Datalab V4 Fixture Transport Contract

## Scope And Baselines

This contract is for signed, offline fixture jobs only. It does not connect Web 2 to a
worker, call a Provider, publish artifacts to an operational service, or establish
production exactly-once delivery.

| Item | Fixed value |
| --- | --- |
| Contract baseline commit | `7f6aba22cd5819fedf3f53c480fec92dfe8b56c2` |
| Frozen collector baseline | `4e4e1906e2967fe58df66f8ad67f832043d2763b` |
| Frozen collector blob | `bcbe229998da3afa6f31ee04375fb0766019e56f` |
| Signed job schema | `datalab-v4-fixture-signed-job.v1` |
| Result schema | `datalab-v4-fixture-result.v1` |
| Purpose | `parity_fixture` |
| Node runtime | `26.5.0` |

The executable schemas are in `schemas/v4_fixture_signed_job.schema.json` and
`schemas/v4_fixture_result.schema.json`. Runtime validation is implemented without a
third-party schema or queue dependency.

## Threat Model

| Failure or attack | Control | Remaining limitation |
| --- | --- | --- |
| Forged or modified job | HMAC-SHA256 over canonical normalized JSON | Secret distribution remains an operator responsibility |
| Unknown signing key | Exact current/previous `keyId` allowlist | The overlap window must be bounded and removed after drain |
| Expired or future job | 5-minute default TTL, 10-minute maximum, 30-second skew | Clock synchronization remains an operator dependency |
| Nonce replay | Atomic nonce ledger | A lost enqueue response is recovered through idempotency/result lookup, not nonce reuse |
| Same key, different payload | Payload identity conflict is terminal | No operator conflict-resolution command |
| Duplicate completed request | Stored terminal result is returned with zero runner invocations | This is application idempotency, not transport exactly-once |
| Two consumers claim one job | Atomic queue rename plus exclusive claim lock | Filesystem locking is validated only on one host |
| Worker crash after claim | Lease expires; claim is quarantined and terminally failed | Automatic retry is intentionally disabled |
| Partial artifact | Attempt remains under its isolated run directory; no manifest digest is published | Operator cleanup is manual |
| Result acknowledgement loss | `getResult(idempotencyKey)` reconstructs the terminal response | Caller polling is not implemented in Web 2 |
| Path traversal or symlink | Absolute root, containment checks, regular-file checks, symlink rejection | Host filesystem permissions remain a deployment control |
| Secret or signature in logs | Minimal one-line output and secret redaction/omission | Queue records necessarily contain the signature until claimed |
| Fixture-mode bypass | Exact mode and three exact-zero safety gates plus mandatory network preload | This is defense in depth, not a network policy boundary |

## Signed Job Envelope

The envelope contains the normalized worker `job` and these signed metadata fields:

- `schemaVersion`, `jobId`, `idempotencyKey`, `nonce`
- `issuedAt`, `expiresAt`, `purpose`, `scenario`
- `requestedCommit`, `collectorBlob`, `payloadDigest`
- `keyId`, `signatureVersion`, `job`, `signature`

Only the seven parity scenarios are accepted: `success`, `empty`, `duplicate`,
`missing-field`, `booking`, `provider-error`, and `timeout`. The purpose, commit, and
collector blob must exactly match this contract. The normalized job must also use the
committed synthetic keyword and fixed parity collection policy (`keyword`, `all`,
`precision`, `revenue_detail`, rank `1-10`, seven booking days, and ten places).

Canonicalization recursively sorts object keys, preserves array order, rejects
non-finite numbers and non-JSON values, and signs the normalized envelope excluding
`signature`. `signatureVersion` is `hmac-sha256-v1`. Verification uses
`crypto.timingSafeEqual`. The HMAC key must contain at least 32 bytes.

## Result Envelope

Every accepted claim finishes with a terminal result containing:

- identity: `jobId`, `idempotencyKey`, `attemptId`, `scenario`
- outcome: `status`, `stage`, `code`, `matched`, `retryable`
- safety evidence: `actualExternalRequests`, `operationalWrites`
- execution evidence: `collectorInvocations`, nullable `exitCode`
- artifact evidence: nullable `artifactManifestDigest`
- timing: `startedAt`, `completedAt`

The result file and its idempotency ledger digest are written atomically. A successful
duplicate returns the stored result and records zero new collector invocations.

## Common Transport Interface

`scripts/v4_fixture_transport.cjs` defines the transport-neutral interface used by the
producer and supervisor:

- `enqueue(job)`
- `claim(workerId, leaseMs)`
- `heartbeat(claimId)`
- `complete(claimId, result)`
- `fail(claimId, result)`
- `getResult(idempotencyKey)`
- `releaseOnShutdown(claimId)`
- `close()`

The Phase 9 filesystem functions remain unchanged.
`createFilesystemTransport()` only adapts those functions to the common interface, so
the original fixture tests continue to exercise the same storage implementation.

## Filesystem Fixture Adapter

`scripts/v4_fixture_transport_fs.cjs` implements:

- `enqueue(job)`
- `claim(workerId, leaseMs)`
- `heartbeat(claim, leaseMs)`
- `complete(claim, result)`
- `fail(claim, result)`
- `getResult(idempotencyKey)`
- `releaseOnShutdown(claim)`

The transport root contains separate `queue`, `claims`, `leases`, `results`,
`rejected`, `stale`, `idempotency`, `nonces`, `locks`, `runtime`, and `runs`
directories. JSON writes use a private temporary file followed by an atomic link or
rename. The adapter marker explicitly declares `crossServiceSupported: false`.

This adapter is only valid when producer and supervisor share one local filesystem and
host. A Render persistent disk cannot be attached to two services, so this adapter is
not a Web-to-Worker production transport.

## Producer And Supervisor Flow

1. The producer reads one committed fixture job, normalizes it, signs it, and enqueues
   exactly one record.
2. Enqueue verifies the complete signature and fixture allowlist before creating queue
   state.
3. The supervisor holds a singleton lock, recovers stale claims without retry, and
   claims one job at a time.
4. It verifies the signature again, creates an isolated run root, and starts the parity
   runner exactly once with the low-level network blocker preloaded.
5. A heartbeat renews the lease while the child runs. SIGTERM or SIGINT stops intake,
   terminates the child, and writes a terminal retryable result without retrying it.
6. Only a matched result with zero external requests and no operational writes receives
   an artifact manifest digest.

`scripts/v4_fixture_transport_shadow_host.cjs` is a same-process fixture bootstrap for
the proposed shadow only. It accepts exactly
`tests/fixtures/v4_collector_parity_job.json`. A restart gets the existing terminal
result with zero new collector invocations. It does not make the filesystem adapter a
cross-service queue.

## Commands

```text
npm ci --offline --omit=dev --ignore-scripts --audit=false --fund=false
npm run check:v4-fixture-transport
npm run test:v4-fixture-transport
npm run start:v4-fixture-transport-shadow
```

The producer simulator command is:

```text
npm run enqueue:v4-fixture-transport -- --job-file tests/fixtures/v4_collector_parity_job.json --scenario success
```

## Environment Names

Required for the Phase 10 producer and supervisor:

- `NODE_ENV=test`
- `V4_FIXTURE_TRANSPORT_MODE=fixture`
- `V4_FIXTURE_TRANSPORT_ROOT`
- `V4_FIXTURE_JOB_KEY_ID_CURRENT`
- `V4_FIXTURE_JOB_HMAC_KEY_CURRENT`
- `V4_FIXTURE_EXTERNAL_CALLS_ENABLED=0`
- `V4_FIXTURE_OPERATIONAL_PUBLISH_ENABLED=0`
- `V4_FIXTURE_WEB_IMPORT_ENABLED=0`

Optional rotation overlap:

- `V4_FIXTURE_JOB_KEY_ID_PREVIOUS`
- `V4_FIXTURE_JOB_HMAC_KEY_PREVIOUS`

The legacy names `V4_FIXTURE_JOB_KEY_ID` and `V4_FIXTURE_JOB_HMAC_KEY` remain
accepted only in `fixture` mode so the Phase 9 deployment and tests are not broken.
They are rejected in `render-key-value` mode.

Supervisor tuning:

- `V4_FIXTURE_WORKER_ID`
- `V4_FIXTURE_LEASE_MS`
- `V4_FIXTURE_HEARTBEAT_MS`
- `V4_FIXTURE_POLL_MS`
- `V4_FIXTURE_CHILD_TIMEOUT_MS`

Same-process shadow bootstrap:

- `V4_FIXTURE_BOOTSTRAP_ENABLED=1`
- `V4_FIXTURE_BOOTSTRAP_JOB_FILE=tests/fixtures/v4_collector_parity_job.json`
- `V4_FIXTURE_BOOTSTRAP_SCENARIO=success`

Changing the mode, any safety gate, or bootstrap enable value away from its exact
allowlisted value is the fail-closed kill switch.

## Production Transport Decision

| Candidate | Delivery and lease model | Isolation and operations | Decision |
| --- | --- | --- | --- |
| Dedicated Render Key Value | Redis-compatible queue; use application idempotency and visibility/lease semantics | Dedicated instance avoids existing DB writes; set `noeviction` and paid persistence | Recommended for Phase 10 |
| Dedicated Postgres job/outbox | Transactional rows and `FOR UPDATE SKIP LOCKED`; strongest audit history | New schema, migrations, vacuum/retention, and polling; reuse of the operational DB is prohibited | Second choice when transactional outbox is required |
| Render Workflows | Managed queue, run history, on-demand workers, configurable retry | Public beta, TypeScript/Python task model, no Blueprint support, automatic retry semantics need adaptation | Re-evaluate after V4 recovery |

Render documents Key Value as suitable for job queues and recommends `noeviction` for
that use. Paid persistence can still lose approximately the most recent second with
the documented journal setting, so the signed idempotency ledger remains required.
PostgreSQL documents `SKIP LOCKED` as appropriate for avoiding contention among
consumers of a queue-like table. Workflows is attractive operationally but remains in
public beta and currently introduces a larger execution-model change.

References:

- https://render.com/docs/key-value
- https://render.com/docs/background-workers
- https://render.com/docs/workflows
- https://www.postgresql.org/docs/current/sql-select.html

## Shutdown Delay

The Phase 8 report does not prove the live value of `maxShutdownDelaySeconds` for
`srv-d9tog1dbedkc739nvm20`. On 2026-08-12, an authenticated read-only Dashboard
inspection did not expose this field, and no authenticated Render API or CLI token was
available. The observed value therefore remains **unknown**, not 60 seconds.

Render documents a 30-second default when the field is omitted and allows values from
1 through 300 for web, private, and worker services. After a separate approval, use one
of these narrowly scoped changes and then trigger/observe the required deploy
separately:

```text
render services update srv-d9tog1dbedkc739nvm20 --max-shutdown-delay 60 --output json
```

or add this service field to its managed Blueprint:

```yaml
maxShutdownDelaySeconds: 60
```

The equivalent API request body for the background worker is:

```json
{
  "serviceDetails": {
    "maxShutdownDelaySeconds": 60
  }
}
```

It would be sent with `PATCH /v1/services/srv-d9tog1dbedkc739nvm20`. This is a diff
only; it was not sent.

The official Update service documentation states that configuration PATCH changes do
not deploy automatically; a separate deploy call is required. A Blueprint sync does
trigger deployment. Neither action is performed in Phase 9.

References:

- https://render.com/docs/blueprint-spec
- https://render.com/docs/deploys
- https://render.com/docs/cli-reference
- https://api-docs.render.com/reference/update-service

The dedicated Key Value candidate and its additional environment contract are defined
in `docs/v4_render_kv_transport_contract.md`. Its Redis behavior is not proven by the
filesystem tests.

## Known Limits

- No Web 2 producer integration exists.
- No dedicated Key Value, Postgres, Workflow, or other Render resource exists.
- No automatic retry or fallback exists.
- No live Provider call or operational publish path exists.
- HMAC current/previous overlap is implemented offline, but no Render secret rotation
  has been performed.
- Filesystem behavior is not evidence of distributed delivery semantics.
- Exactly-once execution is not claimed; the verified property is terminal idempotent
  result reuse after at most one claimed fixture execution on one host.
