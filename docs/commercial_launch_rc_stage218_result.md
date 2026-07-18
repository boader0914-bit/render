# Stage 218 RC Operational Rehearsal Result

## Decision

Status: `NO-GO` on 2026-07-19 KST.

This is an operational readiness result, not a release approval. The application keeps final approval as a separate administrator-only manual action.

## Verified remotely

Repeatable command:

```powershell
$env:RC_TARGET_URL = "https://glamping-cluster-app.onrender.com"
$env:RC_EXPECTED_COMMIT = "<tested-commit>"
npm run rc:preflight
```

For the authenticated RC contract probe, set `RC_PREFLIGHT_AUTHORIZATION` only in the current operator process. The command records only whether authorization was provided and never writes its value. Add `-- --strict` when CI should fail on `NO-GO`.

Default evidence output: `artifacts/rc-stage218/render-rc-preflight.json`.

| Check | Result | Evidence |
| --- | --- | --- |
| Render service target | Passed | `https://glamping-cluster-app.onrender.com` responds from Render/Cloudflare. |
| Public health route | Passed | `GET /api/health` returned HTTP 200 and `{"ok":true,"authRequired":true}`. |
| HTTPS | Passed | The service is served over HTTPS with HSTS. |
| Protected application routes | Passed | `/` and `/admin` returned HTTP 401 without credentials. |
| RC release source deployed | Blocked | GitHub/Render source does not include the local Stage 217/218 RC implementation. |
| Expected/running commit parity | Blocked | No Stage 218 admin report is deployed yet to compare the expected commit with Render's `RENDER_GIT_COMMIT`. |

The obsolete URL `https://ab-v2.onrender.com` returned HTTP 404 and must not be used as launch evidence.

## Current source state

- Local base commit: `0188073` plus the uncommitted product work from the later stages.
- GitHub `origin/main` observed head: `642a968`.
- The RC implementation is present only in the local working tree at the time of this rehearsal.
- Deploying before committing and reviewing the complete working tree would produce unverifiable source evidence.

## Blocking evidence

1. Commit, review, and deploy the complete RC source to a staging or Render release candidate.
2. Confirm the running `RENDER_GIT_COMMIT` matches the expected tested commit in the RC panel.
3. Configure the required authentication, MFA, CSRF, email queue, and webhook secrets in Render without exposing their values.
4. Sign in again after explicit key activation and run the authentication/MFA/CSRF smoke suite.
5. Create a current persistent-disk backup and complete an isolated restore rehearsal against that backup.
6. Record mock or real mode for Naver Trend, Naver SearchAd, SNS mentions, and OTA exposure. Mock mode requires an operator limitation note.
7. Run the full post-deploy smoke suite in the same Render environment and commit.
8. Assign release, rollback, smoke-test, customer-support, and incident-communication owners.
9. Copy only server-marked ready evidence into the Go/No-Go form. A named administrator must make the final decision manually.

## Render configuration boundary

`render.yaml` and `render.persistent.yaml` declare secret values with `sync: false`. Operators provide values in Render. Render supplies deployment identity through its default `RENDER_GIT_COMMIT`, `RENDER_GIT_BRANCH`, `RENDER_GIT_REPO_SLUG`, and runtime URL variables.

References:

- https://render.com/docs/environment-variables
- https://render.com/docs/configure-environment-variables
- https://render.com/docs/deploys

## Stop conditions

Stop the rehearsal and keep `NO-GO` when any of these is true:

- expected and running commit do not match;
- the rehearsal environment and target route do not match;
- security keys are inactive or post-rotation smoke failed;
- backup or restore evidence is missing or stale;
- a real connector is selected without a ready adapter;
- any required owner is unassigned;
- deployment smoke is not passed;
- the only available evidence was generated locally.
