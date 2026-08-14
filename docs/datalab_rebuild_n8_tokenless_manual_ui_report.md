# DataLab N8 Tokenless Manual UI

Date: 2026-08-15 (Asia/Seoul)

## Objective

Remove the administrator token field from the basic Place collection UI and support an
explicit tokenless manual Live mode without turning the service into an unlimited public
collector.

## Baseline

- Local branch: `recovery/v2-basic-place-tokenless-manual`
- Baseline commit: `f134f9a7cd31aa098d13c7fdcbfd0ba0e029fc4f`
- Frozen reference collector:
  `scripts/frozen_v2_4e4e190/gyeongnam_glamping_crawl.cjs`
- Frozen reference collector blob:
  `bcbe229998da3afa6f31ee04375fb0766019e56f`
- Active collector blob at the baseline:
  `c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3`
- `package-lock.json` SHA-256:
  `ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2`

Neither collector file nor `package-lock.json` is changed by this work.

## Implementation

- Removed the administrator token label, password input, validation, and request header
  from the browser UI.
- Added `V2_BASIC_UI_PUBLIC_MANUAL_LIVE` as an explicit server gate.
- Tokenless Live starts only when all of the following are true:
  - `V2_BASIC_UI_RUN_ENABLED=1`
  - `V2_BASIC_UI_PUBLIC_MANUAL_LIVE=1`
  - `V2_BASIC_UI_DAILY_REQUEST_BUDGET` is a finite integer from 1 through 20
  - `V2_BASIC_UI_OPERATOR_TOKEN_SHA256` is absent
  - retry, fallback, and operational write gates are all 0
- Tokenless Live with `unlimited`, a token digest, a zero budget, or disabled execution
  fails closed during startup.
- The UI disables Live on legacy token-authenticated or inaccessible private deployments,
  because the token input no longer exists.
- Existing token-authenticated server behavior remains available for compatibility, but
  the new browser UI does not expose or transmit a token.

## Offline Verification

Node 26.5.0:

| Check | Result |
| --- | --- |
| Syntax check | passed |
| UI server tests | 181 assertions passed |
| Static UI contract | 79 assertions passed |
| Snapshot handoff contract | 25 assertions passed |
| Browser ad transport | 27 assertions passed |
| External Provider requests | 0 |
| Operational writes | 0 |
| Raw Provider responses stored | 0 |
| Tracking URLs stored | 0 |

## Browser Verification

Local preview: `http://127.0.0.1:4184/`

- Administrator token inputs: 0
- Administrator token visible text: absent
- Live mode: enabled under `tokenless-bounded`
- Daily request display: `0 / 20`
- Desktop and 390 x 844 mobile layouts: no horizontal overflow or control overlap
- Demo submission without a token: completed
- Demo external requests: 0
- New browser log entries during Demo submission: 0
- Live collection was not clicked and no Provider request was made.

## Render Deployment Proposal

Target Web Service: `srv-d9vidce7bikc73dh60eg`

After a separate commit/push approval:

1. Suspend the target Web Service.
2. Change its branch to `recovery/v2-basic-place-tokenless-manual`.
3. Set `V2_BASIC_UI_EXPECTED_DEPLOY_COMMIT` to the approved new commit SHA.
4. Remove `V2_BASIC_UI_OPERATOR_TOKEN_SHA256`.
5. Set `V2_BASIC_UI_PUBLIC_MANUAL_LIVE=1`.
6. Replace `V2_BASIC_UI_DAILY_REQUEST_BUDGET=unlimited` with `20`.
7. Keep `V2_BASIC_UI_RUN_ENABLED=1` and all retry, fallback, and operational write gates at 0.
8. Preserve the existing Build Command, Start Command, disk, plan, instance count, and
   Auto Deploy Off settings.
9. Resume once and verify one automatically created deployment. Do not issue a manual
   deploy when the settings change already created one.
10. Verify `/healthz`, `/api/status`, `authRequired=false`,
    `accessMode=tokenless-bounded`, and zero Provider requests before user interaction.

## Remaining Risk

A tokenless endpoint can be called by anyone who knows the service URL. The finite daily
budget limits total Provider calls but does not identify individual users, so one user can
consume the shared daily budget. Per-user authentication can be added later outside the
collection form, for example at the service or reverse-proxy layer.

No Render service, Provider, remote branch, or operational data was changed in this step.
