# Account, Session, and Tenant Security

## Stage 208 scope

Stage 208 replaces the shared-PIN-only product boundary with named administrator and business accounts, expiring server sessions, and server-side `company_id` ownership checks. Legacy Basic Auth remains available only as a migration bridge.

## File-backed stores

All stores are under `DATA_DIR/db` and are included in the existing database backup scope.

| File | Contents | Business exposure |
| --- | --- | --- |
| `user_accounts.json` | Username, role, allowed company IDs, scrypt password hash | Never exposed directly |
| `auth_sessions.json` | SHA-256 session token hashes, expiry, revocation state | Never exposed |
| `password_reset_requests.json` | One-time reset token hashes, expiry and completion state | Never exposed |
| `account_invitations.json` | One-time invitation token hashes, assigned role/company IDs, expiry, cancellation and activation state | Administrator summary only |
| `auth_security_state.json` | Hashed IP/account attempt windows and temporary locks | Never exposed |
| `auth_audit_logs.json` | Authentication, account, permission and tenant-denial events | Administrator only |
| `auth_delivery_logs.json` | Sanitized mock/real email delivery status without links, tokens or provider credentials | Administrator only |
| `auth_delivery_retry_queue.json` | AES-256-GCM encrypted retry envelopes, attempt counts, due times and queue outcome | Administrator only |
| `auth_delivery_webhook_events.json` | Signature-verified, sanitized provider delivery/bounce/failure events | Administrator only |
| `auth_key_rotation_history.json` | Active key version, sanitized rotation outcome, dry-run evidence, and post-rotation smoke evidence | Administrator only |

Plaintext passwords, session tokens, invitation tokens, and reset tokens are not stored. Mock mode returns a one-time preview link only to the issuing administrator response; it is never persisted. Real mode sends the link to the configured email provider and does not return the token to the browser.

## Roles and tenant boundary

- `admin`: may access administrator and business APIs for operational review.
- `business`: may access only `/api/business/*` and only for a `companyId` listed in the signed-in account's `companyIds` array.
- Business company lists are filtered before report data is assembled.
- Business GET and POST requests are rejected before domain logic runs when the requested company is outside the account scope.
- `/outputs`, collection APIs, settings, backup, security, SLA, connector operations, account management, logs, and raw data remain administrator-only.

## Session behavior

- The session identifier is a 256-bit random token.
- Only its SHA-256 hash is stored server-side.
- The browser cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` in production.
- Default lifetime is eight hours and can be changed with `SESSION_TTL_MINUTES`.
- Logout revokes the server session and clears the browser cookie.
- Password changes and account disabling revoke all active sessions for that account.
- A successful sign-in replaces and revokes any session token already presented by the browser.
- Role, allowed-company, status, username, and password changes revoke the affected account's active sessions.
- The last active administrator cannot be disabled or changed to a business role.

## Stage 209 operational controls

- Login failures are limited independently by normalized account name and hashed client IP.
- Password reset requests use separate account and IP windows while keeping the public response generic.
- Lock state survives a process restart and an administrator can release an active lock from the account console.
- Raw IP addresses, passwords, cookies, session tokens, reset tokens, authorization headers, and user-agent strings are not stored in the audit log.
- Audit events cover login success/failure/lock, logout, password reset/change, account and permission changes, tenant access denial, and manual lock release.

## Stage 210 invitation and delivery controls

- Administrators issue an invitation with an email address, role, and explicit `company_id` scope. A business invitation cannot be created without at least one company.
- Invitation and reset links use random one-time tokens whose SHA-256 hashes are stored. Expiry, cancellation, supersession, acceptance, and delivery state are file-backed.
- Reissuing an invitation supersedes every earlier pending token for that target. Cancelling or accepting it makes the token unusable.
- Activation consumes the token before account creation. A partial failure remains fail-closed and requires a fresh invitation instead of reusing the credential.
- Link tokens are carried in the URL fragment (`#invite=` or `#reset=`), so they are not sent in HTTP request lines or `Referer` headers. The app clears the fragment after success.
- Invitation issuance/delivery and activation inspection share the persistent Stage 209 account/IP rate limiter and sanitized audit trail.
- The email adapter has explicit `mock` and `real` modes. Real mode requires an HTTPS endpoint, bearer token, sender, and public application base URL.
- Delivery logs retain recipient/status/provider/error classification but never retain provider tokens, invitation/reset tokens, complete links, passwords, or session cookies.

## Stage 211 delivery operations

- Every real provider request carries an `Idempotency-Key` and the internal `deliveryId` in metadata. A prior successful or in-flight row with the same key suppresses a duplicate fetch.
- Successful provider responses retain only a sanitized provider delivery/message ID, provider status, HTTP code, and completion time. Raw response bodies and provider credentials are discarded.
- HTTP 429, HTTP 5xx, timeout, and network failures enter a file-backed retry queue. The email body and one-time link are stored only inside an AES-256-GCM envelope derived from `AUTH_EMAIL_QUEUE_SECRET`.
- Queue rows are atomically claimed as `running`. The real-mode worker processes due rows with exponential backoff, and an administrator can force one row or all due rows from the account console.
- Retry exhaustion, queue decryption failure, authentication failure, and permanent 4xx responses remain visible for administrator review instead of looping indefinitely.
- The public webhook endpoint requires an HMAC-SHA256 signature and supports an optional timestamp tolerance. Duplicate event IDs are accepted once without applying the state twice.
- Provider `delivered`, `bounced`, `complained`, and `failed` events update the matched delivery and its invitation/reset summary without storing the raw webhook payload.
- Manual resend creates a fresh invitation or reset token and supersedes/cancels the older credential. It does not replay a stale link after a permanent failure or bounce.
- Delivery diagnostics, recipient list, provider IDs, retry queue, webhook events, internal errors, and resend controls remain administrator-only.

## Stage 212 administrator MFA and recovery

- Administrator MFA uses RFC 6238 TOTP with a 30-second period, six digits, and a one-period clock-skew window.
- `user_accounts.json` stores the TOTP secret only in an AES-256-GCM envelope derived from `AUTH_MFA_ENCRYPTION_KEY`. Recovery codes are stored only as SHA-256 hashes.
- Recovery codes are displayed once when MFA is confirmed or regenerated. Each code is removed atomically after one successful use.
- An enrolled administrator receives a password-authenticated session in `challengeRequired` state and cannot open administrator APIs until TOTP or recovery-code verification succeeds.
- When enforcement is active, an administrator without MFA can reach only the MFA status, enrollment, confirmation, logout, and challenge flow.
- MFA verification has a separate session expiry. Expired sessions require a fresh step-up before administrator work continues.
- Account/permission changes, invitation issuance and reissue, email retries/resend, password-reset issuance, security unlock, recovery-code regeneration, and MFA disable require a currently verified MFA session.
- MFA failures are limited independently by account and hashed client IP. The existing administrator security console can release the resulting lock.
- Disabling MFA requires the current password plus a current TOTP or unused recovery code, clears the encrypted secret and hashes, and revokes every session for that administrator.
- Audit events cover enrollment, enable/disable, challenge success/failure/lock, recovery-code use/regeneration, and denied step-up operations. Secrets and submitted codes are excluded by the audit sanitizer.

## Stage 213 request security boundary

- State-changing requests with a session cookie require `X-CSRF-Token`. The value is an HMAC derived from the current session token and is returned only by login and the same-origin session endpoint; it is not persisted.
- Production POST/PUT/PATCH/DELETE requests must present a valid `Origin`, and the effective Host must match `AUTH_PUBLIC_BASE_URL`, `RENDER_EXTERNAL_URL`, or an explicitly allowed origin.
- Login, invitation activation, and password-reset entry points do not require a CSRF token because they do not depend on an authenticated session, but they still require the origin/host check.
- `/api/auth/email/webhook` is the only signed public webhook exception. It bypasses browser-origin and CSRF checks and remains protected by its raw-body HMAC, timestamp tolerance, and duplicate-event guard.
- Forwarded IP, host, and protocol headers are read only when the direct socket peer matches Render's private/loopback proxy boundary or an explicit trusted proxy CIDR. Untrusted forwarded headers are ignored.
- Every response receives CSP, HSTS in production, `nosniff`, no-referrer, permissions, frame, opener, and resource isolation headers. Request-boundary rejections are sanitized and recorded only in the administrator authentication audit.

## Stage 214 versioned security-key rotation

- CSRF signing, MFA encryption, email retry-queue encryption, and email webhook verification use one operational key version label while retaining separate secret values per purpose.
- A bounded transition window may expose a current and previous version to the server. Previous keys are accepted only when both transition timestamps are valid, the versions differ, and the window is active and no longer than `AUTH_KEY_TRANSITION_MAX_DAYS`.
- CSRF verification and provider webhook verification try the current key first and the previous key only during that window. New tokens, encrypted records, and signatures always use the current key.
- Applying a rotation re-encrypts readable MFA and retry-queue envelopes with the current key, then revokes every active session. Unreadable records block the operation instead of being skipped.
- The administrator report exposes only configured booleans, version labels, transition state, record counts, blockers, and sanitized history. It never returns current or previous key values.
- A successful rotation records the active version and affected counts. A failed rotation records only its error classification. MFA enrollment secrets, queue contents, session tokens, and webhook secrets are excluded.
- After migration and provider verification, remove all `*_PREVIOUS_*` variables and transition timestamps. Expired transition keys are never accepted even if the old environment variables remain present.

## Stage 215 authentication security v1.0 lock

- Authentication security is locked at v1.0 after account/session authorization, tenant ownership, throttling, audit, invitation/reset delivery, administrator MFA, request integrity, and versioned key rotation.
- `POST /api/admin/auth/key-rotation/dry-run` stores a secret-free preflight record. It checks all four current keys, version lineage, the bounded transition window, all four previous keys for a known version transition, session revocation impact, MFA/queue migration counts, unreadable records, and webhook transition readiness.
- Dry-run is non-destructive. It never creates a session, invitation, email, retry row, or webhook event and never returns key material.
- After apply revokes every old session, an administrator signs in again and runs `POST /api/admin/auth/key-rotation/smoke-test`.
- The post-rotation smoke test stores seven checks: active-admin/password-hash and pre-rotation-session integrity, MFA current-key decryption, in-memory CSRF current-key verification, invitation token-hash/plaintext scan, in-memory retry-envelope round trip, in-memory webhook current/previous signature behavior, and active-version evidence.
- The administrator console shows the latest preflight and smoke evidence, a fixed recovery procedure, and a dynamic previous-key removal checklist. Business APIs and `/app` receive none of these fields.
- Recursive security-quality approval, auto-approval, reassessment, and recommendation loops are prohibited after this lock. A future security change requires a concrete vulnerability, compliance need, provider migration, or production incident.
- The complete operator runbook is in `docs/auth_security_v1_operation_guide.md`.

## Authentication APIs

| Method and path | Access | Purpose |
| --- | --- | --- |
| `POST /api/auth/login` | Public | Create a role-bearing session |
| `GET /api/auth/session` | Public | Return current public-safe session state |
| `POST /api/auth/logout` | Public | Revoke current session |
| `POST /api/auth/mfa/challenge` | Password-authenticated admin session | Confirm TOTP or consume one recovery code |
| `POST /api/auth/password-reset/request` | Public | Record a generic reset request without account enumeration |
| `POST /api/auth/password-reset/confirm` | Public | Consume a one-time token and set a new password |
| `POST /api/auth/invitations/inspect` | Public | Validate an invitation token and return masked activation context |
| `POST /api/auth/invitations/accept` | Public | Consume an invitation, create the scoped account, and activate it |
| `POST /api/auth/email/webhook` | Signed provider | Apply a verified delivery/bounce/failure event |
| `GET/POST /api/admin/auth/accounts` | Admin | List and create/update named accounts |
| `GET/POST /api/admin/auth/invitations` | Admin | List invitation status or issue a new invitation |
| `POST /api/admin/auth/invitations/reissue` | Admin | Supersede a pending invitation and issue a fresh one-time link |
| `POST /api/admin/auth/invitations/cancel` | Admin | Cancel an unused invitation |
| `GET /api/admin/auth/deliveries` | Admin | View sanitized invitation/reset delivery outcomes |
| `POST /api/admin/auth/deliveries/retries/run` | Admin | Run one forced retry or the currently due queue |
| `POST /api/admin/auth/deliveries/resend` | Admin | Issue a fresh one-time credential and resend it |
| `GET/POST /api/admin/auth/password-reset-requests` | Admin | Review requests and issue one-time manual-delivery tokens |
| `GET /api/admin/auth/security` | Admin | View authentication summary, active locks and sanitized audit events |
| `POST /api/admin/auth/security/unlock` | Admin | Release one active login or reset lock |
| `GET /api/admin/auth/mfa` | Admin session | View safe MFA status, remaining-code count, and session verification state |
| `POST /api/admin/auth/mfa/enroll` | Admin session | Generate and encrypted-store a pending TOTP setup secret |
| `POST /api/admin/auth/mfa/confirm` | Admin session | Confirm enrollment and return recovery codes once |
| `POST /api/admin/auth/mfa/recovery-codes/regenerate` | MFA-verified admin | Invalidate old recovery codes and return a fresh set once |
| `POST /api/admin/auth/mfa/disable` | MFA-verified admin | Confirm password and code, disable MFA, and revoke sessions |
| `GET /api/admin/auth/key-rotation` | Admin | View secret-free key versions, transition readiness, migration impact and history |
| `POST /api/admin/auth/key-rotation/dry-run` | MFA-verified admin | Store a non-destructive rotation preflight and impact report |
| `POST /api/admin/auth/key-rotation/apply` | MFA-verified admin | Re-encrypt current records, activate the current version and revoke all sessions |
| `POST /api/admin/auth/key-rotation/smoke-test` | MFA-verified admin | Store post-rotation authentication boundary evidence after re-login |

## Generic provider contract

The real adapter sends JSON to `AUTH_EMAIL_PROVIDER_URL` with bearer authorization and an `Idempotency-Key` header. The body contains `from`, `to`, `subject`, `text`, `html`, and `metadata.deliveryId/kind/targetId/idempotencyKey`. A successful response may return `id`, `messageId`, `message_id`, `data.id`, or an `X-Message-Id` header; only that identifier and a short status are retained.

The webhook endpoint expects `X-Auth-Delivery-Signature: sha256=<hex-hmac>`. Without a timestamp, sign the exact raw JSON body. With `X-Auth-Delivery-Timestamp`, sign `<timestamp>.<raw-json>` and keep the timestamp inside the configured tolerance. Event JSON may provide `eventId`, `type/event/status`, `messageId/providerDeliveryId`, and optionally `metadata.deliveryId`. Vendor-native schemas or signatures should be translated by a thin provider adapter before production cutover.

## Environment variables

| Variable | Default | Operation rule |
| --- | --- | --- |
| `ADMIN_BOOTSTRAP_USER` | `ADMIN_USER` | First administrator username |
| `ADMIN_BOOTSTRAP_PASSWORD` | `ADMIN_PIN` | First administrator password; set explicitly in production |
| `SESSION_TTL_MINUTES` | `480` | Session expiry, 5 to 10,080 minutes |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | One-time reset expiry |
| `AUTH_COOKIE_NAME` | `lodging_session` | Session cookie name |
| `AUTH_ALLOW_LEGACY_BASIC` | `true` | Set to `false` after account migration |
| `AUTH_LOGIN_ACCOUNT_MAX_ATTEMPTS` | `5` | Failed logins per account window |
| `AUTH_LOGIN_IP_MAX_ATTEMPTS` | `20` | Failed logins per hashed IP window |
| `AUTH_LOGIN_WINDOW_MINUTES` | `15` | Login failure observation window |
| `AUTH_LOGIN_LOCK_MINUTES` | `15` | Temporary login lock duration |
| `AUTH_RESET_ACCOUNT_MAX_REQUESTS` | `5` | Reset requests per account window |
| `AUTH_RESET_IP_MAX_REQUESTS` | `20` | Reset requests per hashed IP window |
| `AUTH_RESET_WINDOW_MINUTES` | `60` | Reset request observation window |
| `AUTH_RESET_LOCK_MINUTES` | `60` | Temporary reset lock duration |
| `AUTH_PUBLIC_BASE_URL` | Render external URL/request origin | Public HTTPS base used to build invitation/reset links |
| `AUTH_ALLOWED_ORIGINS` | Empty | Optional comma-separated additional same-origin values; production still requires the effective request origin to match |
| `AUTH_CSRF_SECRET` | Ephemeral process key | Dedicated production HMAC secret of at least 24 characters; set a stable value before cutover |
| `AUTH_CSRF_PREVIOUS_SECRET` | Empty | Prior CSRF secret accepted only inside an active bounded transition window |
| `AUTH_CSRF_ENFORCE` | Production: `true` | Require the session CSRF header for state-changing requests |
| `AUTH_ORIGIN_ENFORCE` | Production: `true` | Require effective Host and browser Origin validation |
| `AUTH_TRUST_PROXY` | Render: `render`; otherwise `none` | Trust forwarded headers only from the selected direct proxy boundary; never use `true` in production |
| `AUTH_TRUSTED_PROXY_CIDRS` | Empty | Optional comma-separated exact IPs or IPv4 CIDRs for non-Render trusted proxies |
| `AUTH_INVITE_TTL_HOURS` | `72` | Invitation validity, 1 to 720 hours |
| `AUTH_INVITE_ACCOUNT_MAX_DELIVERIES` | `5` | Invitation deliveries per target account window |
| `AUTH_INVITE_IP_MAX_DELIVERIES` | `50` | Invitation deliveries per issuing IP window |
| `AUTH_INVITE_WINDOW_MINUTES` | `60` | Invitation delivery observation window |
| `AUTH_INVITE_LOCK_MINUTES` | `60` | Temporary invitation delivery lock |
| `AUTH_ACTIVATION_TOKEN_MAX_ATTEMPTS` | `10` | Activation inspections per token identity window |
| `AUTH_ACTIVATION_IP_MAX_ATTEMPTS` | `30` | Activation inspections per IP window |
| `AUTH_ACTIVATION_WINDOW_MINUTES` | `30` | Activation observation window |
| `AUTH_ACTIVATION_LOCK_MINUTES` | `30` | Temporary activation lock |
| `AUTH_MFA_ENCRYPTION_KEY` | Empty | Dedicated secret of at least 24 characters used only for MFA AES-256-GCM envelopes |
| `AUTH_MFA_PREVIOUS_ENCRYPTION_KEY` | Empty | Prior MFA encryption key used only to read and migrate old envelopes during transition |
| `AUTH_MFA_ENFORCE_ADMIN` | Production with encryption key: `true`; otherwise `false` | Require enrollment and MFA verification for administrator sessions |
| `AUTH_MFA_ISSUER` | `Lodging Data Lab` | Authenticator-app issuer label |
| `AUTH_MFA_SESSION_TTL_MINUTES` | `30` | Duration of a successful MFA step-up, 1 to 720 minutes |
| `AUTH_MFA_ACCOUNT_MAX_ATTEMPTS` | `5` | Failed MFA codes per administrator account window |
| `AUTH_MFA_IP_MAX_ATTEMPTS` | `20` | Failed MFA codes per hashed IP window |
| `AUTH_MFA_WINDOW_MINUTES` | `10` | MFA failure observation window |
| `AUTH_MFA_LOCK_MINUTES` | `15` | Temporary MFA lock duration |
| `AUTH_EMAIL_MODE` | `mock` | Use `real` only after provider validation |
| `AUTH_EMAIL_PROVIDER` | `generic_http` | Provider label written to sanitized delivery logs |
| `AUTH_EMAIL_PROVIDER_URL` | Empty | HTTPS JSON delivery endpoint for real mode |
| `AUTH_EMAIL_PROVIDER_TOKEN` | Empty | Bearer credential; never returned or logged |
| `AUTH_EMAIL_FROM` | Empty | Verified sender address for real mode |
| `AUTH_EMAIL_TIMEOUT_MS` | `8000` | Provider request timeout, 1 to 30 seconds |
| `AUTH_EMAIL_QUEUE_SECRET` | Empty | At least 16 characters; encrypts persisted retry envelopes |
| `AUTH_EMAIL_PREVIOUS_QUEUE_SECRET` | Empty | Prior retry-queue key used only for bounded migration reads |
| `AUTH_EMAIL_WEBHOOK_SECRET` | Empty | At least 16 characters; verifies provider webhook HMAC signatures |
| `AUTH_EMAIL_PREVIOUS_WEBHOOK_SECRET` | Empty | Prior provider webhook secret accepted only during the active transition window |
| `AUTH_KEY_CURRENT_VERSION` | `v1` | Non-secret version label written to new envelopes and rotation history |
| `AUTH_KEY_PREVIOUS_VERSION` | Empty | Non-secret previous version label; required whenever any previous key is configured |
| `AUTH_KEY_TRANSITION_STARTED_AT` | Empty | ISO-8601 transition start; must precede the transition end |
| `AUTH_KEY_TRANSITION_UNTIL` | Empty | ISO-8601 transition end; previous verification stops immediately after this time |
| `AUTH_KEY_TRANSITION_MAX_DAYS` | `30` | Maximum accepted transition duration, capped at 90 days |
| `AUTH_KEY_MAX_AGE_DAYS` | `90` | Administrator replacement reminder threshold, 7 to 365 days |
| `AUTH_EMAIL_WEBHOOK_TOLERANCE_SECONDS` | `300` | Optional signed timestamp acceptance window |
| `AUTH_EMAIL_RETRY_MAX_ATTEMPTS` | `3` | Total delivery attempts before operator review |
| `AUTH_EMAIL_RETRY_BASE_SECONDS` | `60` | Initial exponential-backoff delay |
| `AUTH_EMAIL_RETRY_CLAIM_TIMEOUT_SECONDS` | `300` | Reclaims a retry left running by a stopped process |
| `AUTH_EMAIL_RETRY_WORKER_INTERVAL_SECONDS` | `60` | Real-mode due-queue worker interval; `0` disables it |

If an existing PIN is shorter than the new ten-character password policy, it is migrated once with `mustResetPassword: true`. New accounts and reset passwords must satisfy the stronger policy.

## Production migration

1. Back up `DATA_DIR/db`.
2. Set `ADMIN_BOOTSTRAP_USER` and a strong `ADMIN_BOOTSTRAP_PASSWORD`.
3. Deploy and sign in through `/admin`.
4. Configure a dedicated `AUTH_MFA_ENCRYPTION_KEY`, set `AUTH_MFA_ENFORCE_ADMIN=true`, and enroll the bootstrap administrator before enrolling every other active administrator.
5. Store every administrator's one-time recovery codes outside the application and complete one recovery-code drill.
6. Configure `AUTH_PUBLIC_BASE_URL`, a dedicated `AUTH_CSRF_SECRET`, `AUTH_TRUST_PROXY=render`, real provider variables, independent queue and webhook secrets, and the provider webhook URL.
7. Verify a real send returns a provider delivery ID and that a repeated identical request is suppressed.
8. Trigger a provider sandbox 429/5xx, verify encrypted queue creation, and run one successful retry.
9. Send signed delivered and bounced webhook fixtures, then confirm duplicate and invalid signatures do not apply twice.
10. Issue one test business invitation, activate it, and confirm the old link cannot be reused.
11. Request and complete one password reset, then verify provider delivery status without token leakage.
12. Assign each business account only its owned `company_id` values and verify cross-company rejection.
13. Set `AUTH_ALLOW_LEGACY_BASIC=false` and redeploy.
14. Verify a same-origin state change succeeds, missing CSRF and foreign Origin requests return 403, spoofed forwarded headers are ignored outside the trusted proxy boundary, and the signed webhook still accepts a valid provider event without browser headers.
15. For a key change, copy the deployed version label and four current secrets into their previous-version variables, generate four independent current secrets, increment `AUTH_KEY_CURRENT_VERSION`, and set an ISO start/end window no longer than 30 days.
16. Deploy, inspect the administrator key-rotation report, confirm zero unreadable records, and test one provider webhook signed by both current and previous secrets during the transition.
17. Apply the current version from an MFA-verified administrator session. Sign in again, confirm MFA still works, verify the retry queue is current-version encrypted, and confirm all pre-rotation sessions are rejected.
18. Run the administrator post-rotation security smoke test and retain a passing result for the active version.
19. After every provider signs with the current secret and the previous-key removal checklist is complete, remove previous keys and transition timestamps, redeploy, and verify an old CSRF token and old webhook signature are rejected.
20. Remove obsolete shared PIN variables after the rollback window closes.

## Remaining constraints

The account, invitation, session, MFA, lock, delivery, retry, webhook, rotation, and audit stores are file-backed and suitable for one Render instance. The Stage 214 rotation is an operator-driven application procedure, not a cloud key-management system: secret generation, protected delivery to Render, dual-deploy coordination, and emergency revocation remain operational responsibilities. The in-process retry worker is intentionally single-instance; horizontal scaling requires a transactional shared database, distributed claim/lease queue, distributed rate limiter, shared session store, and a managed KMS-backed key-rotation procedure. The generic HTTP contract may require a thin provider-specific adapter for vendor-native request fields and webhook signature formats. Reverse-proxy IP headers must be trusted only from the hosting platform.
