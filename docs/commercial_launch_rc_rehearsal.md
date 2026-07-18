# Commercial Launch RC Rehearsal

## Scope

The RC rehearsal is an administrator-only evidence collection layer for the existing commercial launch gate. It runs existing backup, restore rehearsal, authentication key, connector, MFA recovery, and deployment smoke functions in an explicit order. It does not approve a release, apply a security key automatically, or create a new quality-management loop.

Persistence: `DATA_DIR/db/commercial_launch_rc_rehearsals.json` using schema `commercial_launch_rc_rehearsals_v1`.

## Environment isolation

Each rehearsal records both the environment selected by the operator and the environment detected by the running process.

- `local`: useful for functional rehearsal only. Local evidence never satisfies staging or Render launch evidence.
- `staging`: requires `RC_RUNTIME_ENVIRONMENT=staging` or `APP_ENVIRONMENT=staging` on the running process and an HTTPS target URL.
- `render`: requires Render runtime detection and an HTTPS target URL.

An environment mismatch or invalid target URL blocks that rehearsal. Do not copy local run IDs into a staging or Render gate record.

## Required operating order

1. Confirm the running environment and target route.
2. Enter the tested Git commit and confirm that it matches the running `RENDER_GIT_COMMIT` or `APP_RELEASE_COMMIT`.
3. Create a fresh backup of `db`, `config`, and, when required, `outputs`.
4. Perform an isolated restore rehearsal and record the result against that backup.
5. Run authentication key preflight.
6. Apply the current key manually in the Authentication and Security panel. Applying a key can revoke active sessions and is intentionally excluded from the RC action API.
7. Sign in again and run the authentication post-rotation smoke suite.
8. Record `mock` or `real` for every external connector. A real selection is blocked unless its adapter is ready; a mock selection requires an operator note.
9. Verify administrator MFA step-up and the offline recovery procedure without storing MFA secrets or recovery codes.
10. Run the full deployment smoke suite in the same environment and commit.
11. Assign release, rollback, smoke-test, customer-support, and incident-communication owners.
12. Copy only ready evidence into the launch gate, review it, and make a separate manual Go/No-Go decision.

## APIs

- `GET /api/admin/master-db/commercial-launch-rc-rehearsals`
- `POST /api/admin/master-db/commercial-launch-rc-rehearsals`
- `POST /api/admin/master-db/commercial-launch-rc-rehearsals/:rehearsalId/actions/create_backup`
- `POST /api/admin/master-db/commercial-launch-rc-rehearsals/:rehearsalId/actions/record_restore`
- `POST /api/admin/master-db/commercial-launch-rc-rehearsals/:rehearsalId/actions/auth_preflight`
- `POST /api/admin/master-db/commercial-launch-rc-rehearsals/:rehearsalId/actions/auth_smoke`
- `POST /api/admin/master-db/commercial-launch-rc-rehearsals/:rehearsalId/actions/deployment_smoke`
- `POST /api/admin/master-db/commercial-launch-rc-rehearsals/:rehearsalId/actions/sync_current`

All write and action routes are administrator-only and require MFA step-up when administrator MFA enforcement is enabled.

## Final approval boundary

The rehearsal can reach `ready_for_final_review` only in matching staging or Render runtime with no pending, blocked, or warning step. Local completion is labeled `local_rehearsal_complete`. The release decision remains exclusively in `POST /api/admin/master-db/commercial-launch-gate`; no RC action changes it.

RC records, owner evidence, target routes, backup and restore IDs, key status, connector cutover choices, smoke results, and action history must never be returned by business APIs or rendered in `/app`.

The latest observed operational rehearsal result is recorded in `docs/commercial_launch_rc_stage218_result.md`.
