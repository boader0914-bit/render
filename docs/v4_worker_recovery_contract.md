# Datalab V4 Recovery Worker Contract

## Baseline

- Commit: `4e4e1906e2967fe58df66f8ad67f832043d2763b`
- Frozen collector: `scripts/gyeongnam_glamping_crawl.cjs`
- Collector Git blob: `bcbe229998da3afa6f31ee04375fb0766019e56f`
- Job schema: `datalab-v4-worker-job.v1`
- Result schema: `datalab-v4-worker-result.v1`

The frozen collector remains unchanged. `scripts/v4_worker_once.cjs` validates a job,
creates an isolated staging tree, runs the collector once, validates its manifest,
and atomically promotes one successful artifact directory.

## Commands

- Build Command: `npm ci --omit=dev --ignore-scripts --audit=false --fund=false`
- One-shot Start Command: `npm run start:v4-worker`
- Offline test: `npm run test:v4-worker`
- Target Node version: `26.5.0`

The one-shot command reads one JSON job from stdin. It also accepts
`--job-file <path>`. A persistent Render Background Worker still needs a job
transport or supervisor in Phase 3; deploying this one-shot command alone would
not provide a durable polling service.

## Environment

Required production variable names:

- `V4_WORKER_DATA_DIR`

Optional production variable names:

- `V4_WORKER_TIMEOUT_MS`
- `V4_WORKER_MAX_ARTIFACT_BYTES`
- `REGIONAL_LIMIT`
- `REGIONAL_SEARCH_CONCURRENCY`
- `NAVER_BOOKING_STOCK_LIMIT`
- `NAVER_BOOKING_DETAIL_CONCURRENCY`
- `NAVER_SCHEDULE_CONCURRENCY`
- `NAVER_SCHEDULE_DELAY_MS`
- `NAVER_BOOKING_ID_FALLBACK`
- `NAVER_COUPON_PAGE_FALLBACK`

Test-only variable names:

- `V4_WORKER_ALLOW_OFFLINE_FIXTURE`
- `V4_WORKER_PRIVATE_SECRET`

The adapter does not consume the ambient `DATA_DIR`, `OUTPUTS_DIR`, or
`CONFIG_DIR`. It creates private child values under `V4_WORKER_DATA_DIR/work`.
The root must be empty on first use or already contain the matching worker marker.
Use a dedicated path such as `/var/data/v4-worker`, not `/var/data` itself.

## Storage

```text
V4_WORKER_DATA_DIR/
  .v4-worker-root.json
  work/          temporary per-execution trees
  artifacts/     atomically promoted successful runs
  idempotency/   terminal success or failure records
  locks/         exclusive per-key execution locks
```

Artifacts and work directories remain on one filesystem so promotion uses an
atomic rename. One process executes one child at a time. A duplicate successful
idempotency key returns the existing artifact. A failed key is terminal and does
not retry automatically.

## Job Input

Required fields are `schemaVersion`, `jobId`, `idempotencyKey`, `keyword`,
`checkIn`, and `checkOut`. Optional fields are `adults`, `searchMode`,
`productMode`, `collectionMode`, `collectionPurpose`, `detailRankRanges`,
`bookingRangeDays`, and `bookingRangePlaceLimit`. Unknown fields are rejected,
so callers cannot inject storage paths or arbitrary child environment values.

## Readiness And Limits

- Success is a zero process exit and one `succeeded` or `duplicate` JSON line.
- Failure is a non-zero process exit and one redacted `failed` JSON line.
- Default execution timeout: 30 minutes.
- Default artifact limit: 500 MiB.
- Automatic retry: disabled.
- Automatic fallback: disabled.
- HTTP health endpoint: not implemented for the one-shot adapter.

Phase 3 adds an unsigned, fixture-only file transport and persistent shadow
supervisor. The signed Web-to-Worker contract and all live collection remain
future work; see `docs/v4_shadow_phase3_runbook.md`.
