# DataLab Phase 11-L Supervisor Lock Handoff Report

## Scope and integrity

This phase changed local code only. It did not connect to Render, Render Key
Value, a provider, an operational database, or a Web import endpoint. No
commit, push, PR, deploy, restart, suspend, resume, enqueue, claim, or queue
maintenance action was performed.

| Check | Result |
| --- | --- |
| Baseline commit | `ecb3d81cc4219f3ae2a0cd7ae089e5dc3a88ff2a` |
| Local branch | `recovery/v4-supervisor-lock-handoff` |
| Collector blob before and after | `bcbe229998da3afa6f31ee04375fb0766019e56f` |
| Lockfile SHA-256 before and after | `c4e2466ca939bef2f79b19151f617fbc7ebceabd997759cba905c54783c1fe79` |
| Runtime | Node `26.5.0` |
| Baseline dependency install | Offline, production dependencies only |

## Failure reproduction

The baseline code was run in two local child processes with the same fixture
transport root and worker ID. The first process reached readiness and held the
v1 lock. The second process was configured with a 2,000 ms startup wait but
exited after 189 ms with `FIXTURE_SUPERVISOR_ALREADY_RUNNING`. The lock digest
did not change. There were no fixture jobs, collector invocations, queue
operations, external requests, operational writes, or secret disclosures.

This reproduces the Approval K failure mechanism: the baseline supervisor
checked an active lock once and failed immediately. Its identity was only the
shared worker ID, so the lock also could not fence late operations from an old
process after a successor using the same worker ID started.

## Lock lifecycle contract

The v2 lock uses an append-only generation ledger under
`runtime/supervisor-lock-v2`. Each process receives a random 256-bit owner
token. Ownership is the tuple `(generation, ownerToken)`, not `workerId`.

1. A contender reads and validates every existing generation.
2. An active, unreleased lease is never deleted, renamed, or overwritten.
3. A contender waits using a bounded 100 ms poll without creating a transport,
   connecting to a queue, claiming work, or emitting readiness.
4. A contender atomically hard-links exactly one immutable next-generation
   owner record. Concurrent contenders for that generation produce one winner.
5. The owner starts heartbeat renewal before transport initialization.
6. Renew succeeds only while the owner generation and token are still current.
7. Graceful release appends a token-bound release record; it does not delete the
   owner record. A successor then atomically appends the next generation.
8. A late release or renew from an older generation cannot modify the current
   generation.

Malformed, incomplete, non-contiguous, symlinked, or unsupported lock records
fail closed. A hard-killed owner is not overtaken before its verified lease
expiry. Evidence remains in the immutable generation record.

### v1 transition

An active v1 lock remains authoritative. A valid v1 lock is moved to the stale
evidence directory only after its parsed `expiresAt` is no later than the local
clock, then v2 generation 1 is acquired atomically. Malformed, unsupported, and
future-expiry v1 records fail closed without modification.

The remaining transition risk is that v1 has no owner fencing and mutates its
single lock file during renewal. Phase 11-M must therefore start from
`claims=0`, retain the bounded wait, and stop if the old deployment does not
gracefully release or clearly expire. It must not manually remove the v1 lock.

## Startup wait

`V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS` accepts integers from `0` through
`300000`. The code default remains `0`, preserving fail-closed behavior unless
an operator explicitly opts into handoff waiting.

For Phase 11-M, the proposed Render value is `65000` ms. The current approved
contract has a 30,000 ms fixture lease and a 60-second maximum shutdown delay;
65 seconds covers the declared shutdown window plus polling margin while
remaining bounded. This value is a proposal, not an applied setting.

## Shutdown order

On `SIGTERM` or `SIGINT`, intake stops immediately. Any active child follows the
existing terminal shutdown contract, then the transport closes. The supervisor
appends its fenced release record and logs `fixture_supervisor_stopped` with
`lockAcquired` and `lockReleased`. A signal received during startup wait aborts
the wait before transport creation. There is no automatic retry or fallback.

## Offline verification

Reproduce the dedicated checks with:

```text
npm run check:v4-supervisor-lock-handoff
npm run test:v4-supervisor-lock-handoff
```

The 18 dedicated checks cover wait bounds, immediate failure, bounded waiting,
graceful handoff, hard kill and expiry, signal cancellation, late release and
renew fencing, three-way successor competition, malformed and unsupported
records, missing current lease, future expiry, v1 transition, and isolation.
They completed with:

- collector invocations: 0
- queue operations: 0
- actual external requests and DNS/socket attempts: 0
- operational writes and Web imports: 0
- outside-root writes: 0
- automatic retries: 0
- secret and owner-token leaks: 0

The existing fixture contract includes active-child shutdown terminal coverage.
The existing fixture transport suite (15 checks), Render Key Value transport
suite (22 checks), and full V4 recovery suite must all pass before Approval L.

## Phase 11-M preview

Phase 11-M should be a separately approved, `claims=0` Render shadow rollout:

- verify commit, collector blob, lockfile, gates, instance count, and queue idle
  state read-only;
- add only `V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS=65000` while suspended;
- deploy the approved Phase 11-L commit once in readiness-only mode;
- perform one controlled restart and observe old shutdown, one successor
  acquisition, one readiness event, and no jobs or provider activity;
- suspend the target Worker on any lock timeout, schema error, duplicate
  readiness, queue action, external request, operational write, or secret leak.

No Phase 11-M operation is authorized by this report.

### Phase 11-M prompt draft

```text
You are the senior deployment engineer for DataLab recovery Phase 11-M.

The purpose of this phase is to apply the approved supervisor lock-handoff
commit to the existing V4 Key Value shadow Worker in claims=0 readiness-only
mode, then perform exactly one controlled restart and verify the v1-to-v2 lock
handoff without processing a job.

Confirmed resources:
- repository: boader0914-bit/render
- branch: recovery/v4-supervisor-lock-handoff
- Phase 11-L commit: fill from the approved Approval L handoff
- baseline commit: ecb3d81cc4219f3ae2a0cd7ae089e5dc3a88ff2a
- collector blob: bcbe229998da3afa6f31ee04375fb0766019e56f
- lockfile SHA-256: c4e2466ca939bef2f79b19151f617fbc7ebceabd997759cba905c54783c1fe79
- dedicated Key Value: red-d9u0p9ijobas73e11rgg
- target Worker: srv-d9u11i142hec7399qs9g
- required Start Command: npm run start:v4-render-kv-supervisor
- required startup wait: V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS=65000

Mandatory restrictions:
- Do not change services 1, 2, 3, any other V4 service, or Key Value settings.
- Keep V4_QUEUE_CLAIMS_ENABLED=0 and every provider, publish, and Web import
  gate at 0.
- Do not add bootstrap variables, enqueue a fixture, claim a job, run the
  collector, or contact a provider or operational endpoint.
- Do not print Redis URLs, signing keys, payloads, owner tokens, or signatures.
- Do not delete, rename, overwrite, or manually recover an active lock.
- Do not change code, create a commit, push, open a PR, or run Blueprint sync.
- Before Approval M, do not suspend, resume, deploy, restart, or change Render.

Read-only preflight:
1. Verify the remote branch points to the approved Phase 11-L commit.
2. In a clean checkout, verify HEAD, collector blob, lockfile SHA, and Node
   26.5.0.
3. Run the fixture transport, Render Key Value transport, lock-handoff, and full
   recovery tests offline.
4. Verify the target Worker is Live readiness-only, instance count 1, Auto
   Deploy Off, claims=0, no bootstrap variables, and all safety gates 0.
5. Verify the dedicated Key Value is available, noeviction, Journal + Snapshot,
   and externally blocked. Read counts only; do not print keys or payloads.
6. Verify waiting=0, delayed=0, active=0 and no unexplained terminal change.
7. Verify the existing artifact and terminal digests are unchanged.
8. Request Approval M and stop.

Approval M:
Apply the approved Phase 11-L commit to Worker srv-d9u11i142hec7399qs9g,
add V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS=65000, retain claims=0 and every
safety gate at 0, deploy readiness-only once, perform exactly one controlled
restart, and return to Live readiness-only. On failure, only suspending the
target Worker is additionally authorized.

After Approval M:
1. Suspend only the target Worker.
2. Change its branch to recovery/v4-supervisor-lock-handoff and add only
   V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS=65000.
3. Reconfirm Start Command, instance=1, claims=0, no bootstrap variables, all
   safety gates 0, and the approved commit.
4. Resume once. If Render already creates the intended deployment, do not
   trigger another manual deploy. Allow at most one readiness deployment.
5. Verify Node 26.5.0, all build tests, the approved deployed commit, and one
   structured fixture_supervisor_ready event with claimsEnabled=false.
6. Observe at least five minutes with zero jobs, claims, terminal writes,
   collector invocations, provider calls, operational writes, secret leaks, and
   unexpected restarts.
7. Trigger exactly one controlled restart.
8. Verify the old process reports shutdown requested, stopped, and fenced lock
   release; verify exactly one successor acquires the next generation and emits
   readiness. Do not expose the owner token.
9. Confirm no FIXTURE_SUPERVISOR_ALREADY_RUNNING, lock wait timeout, malformed
   lock, queue outage, duplicate readiness, or v1 lock deletion occurred.
10. Observe at least five more minutes and leave the Worker Live claims=0
    readiness-only.

Immediate stop and suspend conditions:
- integrity, Key Value security, branch, commit, instance, or gate mismatch
- any queue job, claim, terminal change, collector invocation, provider socket,
  operational write, Web import, or secret disclosure
- active v1 lock modification, forced takeover, malformed lock, missing lease,
  non-contiguous generation, duplicate readiness, or owner fencing failure
- readiness timeout, queue unavailable, unexpected restart, or extra deploy

On a stop condition, suspend only the target Worker. Do not delete a lock,
clean a queue, retry, fall back, restart again, or deploy again.

HANDOFF_PHASE_11_M
- integrity:
- phase_11_l_commit:
- resources:
- config_delta:
- readiness_deploy:
- controlled_restart:
- v1_to_v2_transition:
- owner_fencing:
- readiness_events:
- queue_and_collector_activity:
- isolation:
- observation_windows:
- final_worker_state:
- existing_services_changed:
- rollback_performed:
- blockers:
END_HANDOFF_PHASE_11_M

Report and stop.
```
