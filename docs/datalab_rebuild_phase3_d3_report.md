# DataLab Rebuild Phase 3 D3 Local Preparation

## Result

N3-D3 adds a dedicated Render Linux one-shot diagnostic path without changing or
calling the Provider. The default `serve` command validates integrity, reports one
redacted readiness event, and holds with request budget zero. A future live path is
unreachable unless every frozen approval gate is supplied together.

No Render service was created or changed. No Provider, Place list, booking-item,
schedule, HTML fallback, historical fallback, operational database, Redis, or Web
import endpoint was contacted.

## Safety Contract

| Boundary | Contract |
|---|---|
| Default start | `node scripts/v2_booking_business_render_one_shot.cjs serve` |
| Default mode | readiness-only; `runEnabled=false`; request budget 0 |
| Approved operation | copied `naverBookingBusiness` path only |
| Maximum future live requests | one POST in one durable run ID |
| Durable state | `/var/data/v2-booking-business-render-diagnostic/runs/<run-id>` |
| Duplicate/restart behavior | existing run directory blocks execution before child invocation |
| Concurrency | atomic run-directory claim allows one child invocation |
| Retry/fallback | always zero |
| Operational writes | always zero; diagnostic disk only |
| Raw values | no Place ID, booking ID, URL, Provider body, header value, host, IP, or secret |

The persistent claim is created before the copied child starts. A partial child
failure remains claimed, so a restart cannot retry the Provider call. The runner
does not delete or recycle a claim automatically.

## Diagnostic Evidence

The child records only safe Undici event projections:

- request method, protocol, body length, and header names
- response status and response header names
- address family without the address
- TLS protocol, cipher name, ALPN, authorization state, and reuse state
- coarse DNS, timeout, TLS, connection, or network failure class

Hostnames, IP addresses, DNS answers, SNI values, certificates, request targets,
header values, request bodies, response bodies, and error text are not retained.

## Local Commands

```text
node --check scripts/v2_booking_business_child.cjs
node --check scripts/v2_booking_business_render_network_diagnostics.cjs
node --check scripts/v2_booking_business_render_one_shot.cjs
node --check scripts/test_v2_booking_business_render_one_shot.cjs
node scripts/test_v2_booking_business_render_one_shot.cjs
node scripts/test_v2_booking_business_env_diagnostics.cjs
node scripts/v2_booking_business_env_diagnostics.cjs offline
node scripts/test_v2_booking_business_harness.cjs
```

All commands must use Node 26.5.0. The D3 suite preloads or installs the fixture
network blocker and must report `actualProviderExternalRequests=0`.

Final local results:

- D3 one-shot safety: PASS, 127 assertions
- D2 environment diagnostics: PASS, 60 assertions
- D1 booking-business regression: PASS, 544 assertions across 15 scenarios
- CLI readiness smoke test: PASS, request budget 0 and external requests 0
- actual Provider requests: 0
- retries, fallbacks, and operational writes: 0

## Render Proposal

The unexecuted proposal is
`render.v2-booking-business-render-diagnostic.proposal.yaml`.

- service type: Background Worker
- Auto Deploy: Off
- instance count: 1
- disk: 1 GB at `/var/data/v2-booking-business-render-diagnostic`
- Start Command: `node scripts/v2_booking_business_render_one_shot.cjs serve`
- no database, Redis, Web import, API credential, or existing-service link
- `V2_RENDER_DIAGNOSTIC_EXPECTED_DEPLOY_COMMIT` must be replaced with the approved
  40-character commit SHA; readiness fails if it differs from `RENDER_GIT_COMMIT`

The proposal contains readiness variables only. It deliberately omits every live
approval variable.

## Next Gates

First request commit and push approval:

```text
Approval N3-D3-Commit:
V2 booking-business Render one-shot diagnostic preparation changes are committed
and pushed to recovery/v2-booking-business-render-diagnostics.
```

After that, a separate approval may create an isolated Worker and deploy it only in
readiness mode. A live Provider request needs another approval after readiness is
verified. The live variables and command must not be enabled during the readiness
deployment.

HANDOFF_REBUILD_PHASE_3_D3
- baseline_commit: dce4c88c8e7d5846f39ac49a40512d1d1363c971
- local_branch: recovery/v2-booking-business-render-diagnostics
- collector_blob_before: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- collector_blob_after: c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3
- reference_collector_blob: bcbe229998da3afa6f31ee04375fb0766019e56f
- lockfile_sha256: ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2
- render_job_canonical_sha256: 598cb85cbddef5338e1b7d67ed0aa4b16ba7713f85b16bbb28925d0f481d2bd0
- request_envelope_sha256: 2078ad1e1f436f524058822079837a8ab222eea7e54b375a7ad7fc2bba378d1d
- runner: scripts/v2_booking_business_render_one_shot.cjs
- network_diagnostics: scripts/v2_booking_business_render_network_diagnostics.cjs
- default_start_command: node scripts/v2_booking_business_render_one_shot.cjs serve
- default_request_budget: 0
- future_live_request_budget: 1
- durable_duplicate_guard: atomic run-directory claim on dedicated disk
- external_provider_requests: 0
- operational_writes: 0
- render_changes: 0
- commit_or_push: 0
- blockers: Render Linux/TLS/egress/Provider behavior remains unverified until separately approved deployment and one-shot
- approval_n3_d3_commit_required: true
END_HANDOFF_REBUILD_PHASE_3_D3
