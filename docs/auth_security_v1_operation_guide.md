# Authentication Security v1.0 Operations

## Locked scope

Authentication security v1.0 includes named accounts, tenant ownership, expiring sessions, rate limits, sanitized audit, invitations and reset delivery, administrator MFA, CSRF/origin/proxy/response headers, and versioned security-key rotation.

Allowed operations are preflight, apply, post-rotation smoke, recovery, and previous-key removal. Do not add recursive security-quality approval, auto-approval, reassessment, recommendation, or SLA layers. Reopen engineering scope only for a concrete vulnerability, compliance requirement, provider migration, or production incident.

## Rotation sequence

1. Back up `DATA_DIR/db` and verify the backup before changing Render secrets.
2. Copy the currently deployed version label and each current secret to its matching previous variable in the managed secret store.
3. Generate four independent current secrets and increment `AUTH_KEY_CURRENT_VERSION`.
4. Set `AUTH_KEY_PREVIOUS_VERSION`, `AUTH_KEY_TRANSITION_STARTED_AT`, and `AUTH_KEY_TRANSITION_UNTIL`. Keep the window at or below 30 days.
5. Deploy one application instance and run **Preflight** in the administrator account console.
6. Do not apply while a preflight check is blocked. Warnings are expected for sessions that will be revoked or records that will be re-encrypted.
7. Apply the current version. MFA and retry envelopes are re-encrypted before all active sessions are revoked.
8. Sign in again and run **Security smoke**. Retain a passing result for the active version.
9. Confirm the email provider signs a real sandbox webhook with the current secret.
10. Complete the previous-key removal checklist, remove every previous key and transition timestamp, then redeploy.
11. Rerun security smoke and verify old CSRF and webhook signatures are rejected.

## Dry-run evidence

The dry-run stores only version labels, counts, status, actor identity, and sanitized detail. It checks:

- all four current keys are configured;
- known version changes point `AUTH_KEY_PREVIOUS_VERSION` at the active version;
- the transition window is valid, active, and bounded;
- all four previous keys exist for a known version transition;
- the number of sessions that will be revoked;
- MFA and retry-envelope migration and unreadable counts;
- current webhook configuration and previous-signature transition status.

No key value, session token, invitation token, queue payload, provider response, or webhook body is stored.

## Post-rotation smoke evidence

| Check | Passing condition |
| --- | --- |
| Login/session | At least one active administrator, valid scrypt password hashes, and no active session created before the recorded rotation time |
| MFA | Every encrypted MFA secret is current-version readable with no previous, legacy, or unreadable row |
| CSRF | A memory-only token signs and verifies with the current key |
| Invitation | Stored invitation credentials use SHA-256 token hashes and contain no plaintext token/link/password fields |
| Email retry | A memory-only envelope encrypts and decrypts with the current queue key; persisted rows are current-only and readable |
| Webhook | A memory-only current signature verifies, while previous-signature acceptance exactly matches the active transition policy |
| Rotation state | The stored active version equals the deployed current version and has an application timestamp |

The smoke test does not send email, issue invitations, create sessions, execute retries, or write webhook events.

## Failure recovery

1. Keep the previous key ring and transition window. Do not delete secrets while evidence is failing.
2. Pause manual email retries if a queue row is unreadable.
3. Inspect the latest dry-run, rotation history, and smoke failure classification. Never paste secret values into notes or logs.
4. Restore the last known version and secret configuration from the managed secret store, restart one instance, and rerun preflight.
5. Restore `DATA_DIR/db` only when the correct current/previous ring still cannot decrypt MFA or queue envelopes.
6. Rerun all post-rotation smoke checks before resuming retries or cleanup.

## Previous-key removal

Do not remove previous keys until the administrator checklist shows:

- current version active;
- passing post-rotation smoke for that version;
- no previous, legacy, or unreadable MFA envelope;
- no previous, legacy, or unreadable retry envelope;
- manual confirmation that the provider sends the current webhook signature.

After removal, redeploy with no previous-key variables or transition timestamps, verify the transition is closed, and rerun smoke. Actual secret generation, protected Render delivery, emergency revocation, and managed KMS integration remain operational responsibilities outside this file-backed v1.0 implementation.
