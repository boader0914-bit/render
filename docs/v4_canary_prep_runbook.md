# V4 Canary Preparation Runbook

This document describes preparation only. It does not authorize a Render change or a live Provider request.

## Frozen Baseline

- Preparation branch base: `37096f9d8ad830fbfbefd3b4d0c85c868f2866da`
- Original collector baseline: `4e4e1906e2967fe58df66f8ad67f832043d2763b`
- Required collector blob: `bcbe229998da3afa6f31ee04375fb0766019e56f`
- Existing shadow Start Command remains `npm run start:v4-shadow`.

## Restart Lock Handoff

The Phase 4 stale archive recorded the old supervisor heartbeat at `2026-08-11T12:36:50.706Z` and expiry at `2026-08-11T12:37:20.706Z`. Successor starts failed at `12:37:02.890Z` and `12:37:05.878Z`. The next start recovered at `12:37:20.857Z` and became ready at `12:37:20.860Z`.

The proximate cause is confirmed: the old process did not remove its lock and recovery depended on the 30 second TTL. The old build did not emit shutdown-stage events, so whether SIGTERM was absent, unhandled, or followed by forced termination remains unknown.

The preparation branch adds:

- bounded startup waiting without retrying a collection job;
- a terminal `SUPERVISOR_LOCK_WAIT_TIMEOUT` error;
- stale lock detection and archive events;
- shutdown, child drain, final heartbeat, lock release, and completion events;
- owner-checked lock release;
- graceful drain followed by SIGTERM and bounded SIGKILL fallback.

## Canary Contract

The canary is separate from the frozen collector. It verifies the approved network and storage boundary, not live parity with the collector.

- Entry point: `scripts/v4_canary_once.cjs`
- Render host: `scripts/v4_canary_host.cjs`
- Provider: exactly `naver-local-search`
- Hostname: exactly `openapi.naver.com`
- Method: HTTPS GET
- Request budget: one
- Keyword budget: one
- Concurrency: one per dedicated root
- Retry: none
- Fallback: none
- Redirects: none
- Raw response storage: none
- Operational publish, Web import, DB, and Redis access: forbidden
- Artifact root: dedicated `/var/data/v4-canary`
- Output: one redacted JSON line from the one-shot process

Required job fields:

- `schemaVersion`
- `approvalId`
- `jobId`
- `idempotencyKey`
- `provider`
- `keyword`

The runtime approval ID must exactly match the job approval ID. A terminal success replays as duplicate without a request. A terminal failure cannot be retried with the same idempotency key.

## Network Boundary

- HTTPS and the default HTTPS port are required.
- URL credentials, fragments, direct IP targets, and unapproved hostnames are rejected.
- DNS results are pinned for the request.
- Loopback, private, carrier-grade NAT, link-local, documentation, benchmark, multicast, reserved, and IPv4-mapped addresses are rejected.
- Redirect responses are rejected without following the `Location` header.
- Proxy environment variables are rejected.
- Timeout and response byte limits are bounded in code.
- A second request is rejected before transport.

## Provider Selection

Recommended first Provider: Naver official Local Search API.

Reasons:

- It is an official, documented API using header credentials.
- It supports one keyword and one result in one request.
- The documented daily Search API quota is much larger than the single canary budget.
- It is closer to the collector's Naver discovery domain than TourAPI.
- The canary stores only counts and response integrity metadata, not returned names or addresses.

This does not establish parity with the collector. The frozen collector uses public Naver pages and GraphQL endpoints, not the official Local Search API.

Official references:

- Naver Local Search API: https://developers.naver.com/docs/serviceapi/search/local/local.md
- Korea Tourism Organization Korean Tourism API: https://www.data.go.kr/data/15101578/openapi.do
- Render One-Off Jobs: https://render.com/docs/one-off-jobs
- Render Persistent Disks: https://render.com/docs/disks

## Render Execution Decision

Do not use an existing V4 One-Off Job for the artifact canary. Render documents that a one-off job cannot access its base service's persistent disk.

Do not temporarily change the existing V4 Start Command. That would alter the approved shadow baseline.

Use a separate temporary Background Worker with:

- branch `recovery/v4-worker-canary-prep` after Approval C;
- Auto Deploy Off;
- one Starter instance;
- a new 1 GB disk at `/var/data/v4-canary`;
- no environment group;
- dry-run Start Command `npm run start:v4-canary-dry-run-host` after Approval D.

The host runs the child once and then remains idle. It does not schedule or retry. A platform restart reaches the terminal idempotency record before any Provider request.

## Environment Variable Names

Dry-run names:

- `NODE_VERSION`
- `NODE_ENV`
- `V4_CANARY_DATA_DIR`
- `V4_CANARY_MODE`
- `V4_CANARY_APPROVAL_ID`
- `V4_CANARY_EXTERNAL_CALLS_ENABLED`
- `V4_CANARY_NETWORK_GATE_ENABLED`
- `V4_CANARY_OPERATIONAL_PUBLISH_ENABLED`
- `V4_CANARY_WEB_IMPORT_ENABLED`
- `V4_CANARY_TIMEOUT_MS`
- `V4_CANARY_MAX_RESPONSE_BYTES`

Live-only names, forbidden before Approval E:

- `V4_CANARY_JOB_JSON`
- `V4_CANARY_NAVER_CLIENT_ID`
- `V4_CANARY_NAVER_CLIENT_SECRET`

Optional supervisor handoff tuning names for a separately approved future V4 shadow deployment:

- `V4_SHADOW_STARTUP_WAIT_MS`
- `V4_SHADOW_FORCE_KILL_MS`

Forbidden operational connection names include DB, Postgres, Redis, Key Value, and Web import URL variables checked by the canary entry point.

## Stop Conditions

Stop without retry when any of these occurs:

- baseline or collector blob mismatch;
- approval ID mismatch;
- Provider, hostname, DNS address, redirect, protocol, proxy, or request-budget violation;
- timeout or response size limit;
- non-success Provider status or invalid response schema;
- any operational connection variable;
- any secret-pattern hit in stdout, logs, idempotency records, or artifacts;
- more than one artifact or more than one Provider request;
- existing V4 or services 1, 2, or 3 show an unexpected event.

Rollback for the isolated canary is to disable or delete only the temporary canary Worker after evidence capture. Do not change services 1, 2, 3, or the existing V4 shadow Worker. Do not delete canary artifacts until hashes and logs are recorded.
