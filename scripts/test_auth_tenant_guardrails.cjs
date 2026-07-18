const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createAuthService } = require("./auth_service.cjs");
const { createAuthDeliveryService } = require("./auth_delivery_service.cjs");
const { createAuthKeyRotationService } = require("./auth_key_rotation_service.cjs");
const { generateTotp } = require("./auth_mfa.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const OWNED_COMPANY_ID = "cmp_tenant_owned";
const OTHER_COMPANY_ID = "cmp_tenant_other";
const csrfByCookie = new Map();

function collection(name, items = []) {
  return { version: 1, name, updatedAt: "2026-07-19T00:00:00.000Z", items };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function seedDataDir() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lodging-auth-tenant-"));
  const dbDir = path.join(dataDir, "db");
  const companies = [
    { companyId: OWNED_COMPANY_ID, canonicalName: "Owned Stay", region: "Pocheon", category: "glamping", b2bVisibility: "eligible", autoConfidence: "B" },
    { companyId: OTHER_COMPANY_ID, canonicalName: "Other Stay", region: "Pocheon", category: "glamping", b2bVisibility: "eligible", autoConfidence: "B" }
  ];
  const profiles = companies.map((company) => ({
    companyId: company.companyId,
    canonicalName: company.canonicalName,
    region: company.region,
    category: company.category,
    b2bVisibility: "eligible",
    verifiedStatus: "verified",
    finalConfidence: "B",
    overrides: { roomTotal: 10, channelUrls: [] }
  }));
  await writeJson(path.join(dbDir, "company_master.json"), collection("company_master", companies));
  await writeJson(path.join(dbDir, "company_verified_profile.json"), collection("company_verified_profile", profiles));
  await writeJson(path.join(dbDir, "property_observations.json"), collection("property_observations", []));
  await writeJson(path.join(dbDir, "leadtime_patterns.json"), collection("leadtime_patterns", []));
  await writeJson(path.join(dataDir, "config", "rehearsal.json"), { environment: "integration", secrets: false });
  return dataDir;
}

async function testSessionExpiration(tempDir) {
  const service = createAuthService({
    accountsFile: path.join(tempDir, "unit", "accounts.json"),
    sessionsFile: path.join(tempDir, "unit", "sessions.json"),
    resetsFile: path.join(tempDir, "unit", "resets.json"),
    sessionTtlMs: 60,
    resetTtlMs: 1000
  });
  await service.initializeBootstrap({ username: "expiry-admin", password: "ExpiryPassword!23" });
  const login = await service.login("expiry-admin", "ExpiryPassword!23");
  assert.ok(await service.resolveSession(login.token));
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(await service.resolveSession(login.token), null);
}

async function testAdminMfaService(tempDir) {
  assert.equal(generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", { timestamp: 59000, digits: 8 }), "94287082");
  const unitDir = path.join(tempDir, "mfa-unit");
  const accountsFile = path.join(unitDir, "accounts.json");
  const service = createAuthService({
    accountsFile,
    sessionsFile: path.join(unitDir, "sessions.json"),
    resetsFile: path.join(unitDir, "resets.json"),
    auditFile: path.join(unitDir, "audit.json"),
    securityFile: path.join(unitDir, "security.json"),
    mfaEncryptionKey: "unit-mfa-encryption-key-at-least-32-characters",
    mfaEnforced: true,
    mfaSessionTtlMs: 70,
    mfaAccountMaxAttempts: 3,
    mfaIpMaxAttempts: 20,
    mfaWindowMs: 1000,
    mfaLockMs: 1000
  });
  const bootstrap = await service.initializeBootstrap({ username: "mfa-admin", password: "MfaAdminPassword!23" });
  const firstLogin = await service.login("mfa-admin", "MfaAdminPassword!23", { ip: "127.0.0.1" });
  assert.equal(firstLogin.mfaEnrollmentRequired, true);
  const enrollment = await service.startMfaEnrollment(bootstrap.account.userId, bootstrap.account);
  const firstCode = generateTotp(enrollment.secret);
  const confirmed = await service.confirmMfaEnrollment(bootstrap.account.userId, firstLogin.token, firstCode, bootstrap.account, { ip: "127.0.0.1" });
  assert.equal(confirmed.mfa.enabled, true);
  assert.equal(confirmed.recoveryCodes.length, 10);

  const storedAfterEnrollment = await fs.readFile(accountsFile, "utf8");
  assert.match(storedAfterEnrollment, /aes-256-gcm|ciphertext/);
  assert.doesNotMatch(storedAfterEnrollment, new RegExp(enrollment.secret));
  confirmed.recoveryCodes.forEach((code) => assert.doesNotMatch(storedAfterEnrollment, new RegExp(code)));

  await new Promise((resolve) => setTimeout(resolve, 90));
  const expiredStatus = await service.getMfaStatus(bootstrap.account.userId, firstLogin.token);
  assert.equal(expiredStatus.mfa.verified, false);
  assert.equal(expiredStatus.mfa.challengeRequired, true);

  await service.logout(firstLogin.token);
  const secondLogin = await service.login("mfa-admin", "MfaAdminPassword!23", { ip: "127.0.0.1" });
  assert.equal(secondLogin.mfaChallengeRequired, true);
  const challenged = await service.verifyMfaChallenge(secondLogin.token, { code: generateTotp(enrollment.secret) }, { ip: "127.0.0.1" });
  assert.equal(challenged.mfa.verified, true);
  const regenerated = await service.regenerateMfaRecoveryCodes(bootstrap.account.userId, bootstrap.account);
  assert.equal(regenerated.recoveryCodes.length, 10);

  await service.logout(secondLogin.token);
  const recoveryLogin = await service.login("mfa-admin", "MfaAdminPassword!23", { ip: "127.0.0.1" });
  const recovery = regenerated.recoveryCodes[0];
  const recovered = await service.verifyMfaChallenge(recoveryLogin.token, { recoveryCode: recovery }, { ip: "127.0.0.1" });
  assert.equal(recovered.mfa.recoveryCodesRemaining, 9);
  await service.logout(recoveryLogin.token);
  const replayLogin = await service.login("mfa-admin", "MfaAdminPassword!23", { ip: "127.0.0.1" });
  await assert.rejects(
    () => service.verifyMfaChallenge(replayLogin.token, { recoveryCode: recovery }, { ip: "127.0.0.1" }),
    (error) => error.code === "AUTH_MFA_CODE_INVALID"
  );
  await service.verifyMfaChallenge(replayLogin.token, { code: generateTotp(enrollment.secret) }, { ip: "127.0.0.1" });
  const disabled = await service.disableMfa(bootstrap.account.userId, "MfaAdminPassword!23", generateTotp(enrollment.secret), bootstrap.account, { ip: "127.0.0.1" });
  assert.equal(disabled.disabled, true);
  assert.equal(await service.resolveSession(replayLogin.token), null);

  const lockDir = path.join(tempDir, "mfa-lock-unit");
  const lockService = createAuthService({
    accountsFile: path.join(lockDir, "accounts.json"), sessionsFile: path.join(lockDir, "sessions.json"), resetsFile: path.join(lockDir, "resets.json"),
    auditFile: path.join(lockDir, "audit.json"), securityFile: path.join(lockDir, "security.json"),
    mfaEncryptionKey: "second-unit-mfa-encryption-key-at-least-32-chars", mfaEnforced: true,
    mfaAccountMaxAttempts: 3, mfaIpMaxAttempts: 20, mfaWindowMs: 1000, mfaLockMs: 1000
  });
  const lockAdmin = await lockService.initializeBootstrap({ username: "lock-mfa-admin", password: "LockMfaPassword!23" });
  const lockLogin = await lockService.login("lock-mfa-admin", "LockMfaPassword!23", { ip: "127.0.0.2" });
  const lockEnrollment = await lockService.startMfaEnrollment(lockAdmin.account.userId, lockAdmin.account);
  await lockService.confirmMfaEnrollment(lockAdmin.account.userId, lockLogin.token, generateTotp(lockEnrollment.secret), lockAdmin.account, { ip: "127.0.0.2" });
  await lockService.logout(lockLogin.token);
  const badLogin = await lockService.login("lock-mfa-admin", "LockMfaPassword!23", { ip: "127.0.0.2" });
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(() => lockService.verifyMfaChallenge(badLogin.token, { code: "000000" }, { ip: "127.0.0.2" }), (error) => error.code === "AUTH_MFA_CODE_INVALID");
  }
  await assert.rejects(() => lockService.verifyMfaChallenge(badLogin.token, { code: "000000" }, { ip: "127.0.0.2" }), (error) => error.code === "AUTH_MFA_LOCKED");
}

async function testVersionedAuthKeyRing(tempDir) {
  const unitDir = path.join(tempDir, "key-ring-unit");
  const files = {
    accountsFile: path.join(unitDir, "accounts.json"),
    sessionsFile: path.join(unitDir, "sessions.json"),
    resetsFile: path.join(unitDir, "resets.json"),
    auditFile: path.join(unitDir, "audit.json"),
    securityFile: path.join(unitDir, "security.json")
  };
  const previousCsrfSecret = "previous-csrf-secret-at-least-32-characters";
  const currentCsrfSecret = "current-csrf-secret-at-least-32-characters";
  const previousMfaKey = "previous-mfa-encryption-key-at-least-32-characters";
  const currentMfaKey = "current-mfa-encryption-key-at-least-32-characters";
  const original = createAuthService({
    ...files,
    csrfSecret: previousCsrfSecret,
    mfaEncryptionKey: previousMfaKey,
    mfaKeyVersion: "v1",
    mfaEnforced: true
  });
  const bootstrap = await original.initializeBootstrap({ username: "rotation-admin", password: "RotationPassword!23" });
  const originalLogin = await original.login("rotation-admin", "RotationPassword!23");
  const enrollment = await original.startMfaEnrollment(bootstrap.account.userId, bootstrap.account);
  await original.confirmMfaEnrollment(bootstrap.account.userId, originalLogin.token, generateTotp(enrollment.secret), bootstrap.account);

  const inactive = createAuthService({
    ...files,
    csrfSecret: currentCsrfSecret,
    previousCsrfSecret,
    mfaEncryptionKey: currentMfaKey,
    previousMfaEncryptionKey: previousMfaKey,
    mfaKeyVersion: "v2",
    previousMfaKeyVersion: "v1",
    keyTransitionActive: false
  });
  assert.equal(inactive.verifyCsrfToken(originalLogin.token, originalLogin.csrfToken), false);

  const rotated = createAuthService({
    ...files,
    csrfSecret: currentCsrfSecret,
    previousCsrfSecret,
    mfaEncryptionKey: currentMfaKey,
    previousMfaEncryptionKey: previousMfaKey,
    mfaKeyVersion: "v2",
    previousMfaKeyVersion: "v1",
    keyTransitionActive: true,
    mfaEnforced: true
  });
  assert.equal(rotated.verifyCsrfToken(originalLogin.token, originalLogin.csrfToken), true);
  const before = await rotated.keyRotationStatus();
  assert.equal(before.mfa.previous, 1);
  assert.equal(before.mfa.reencryptRequired, true);
  const migrated = await rotated.reencryptMfaSecrets(bootstrap.account);
  assert.equal(migrated.reencrypted, 1);
  const after = await rotated.keyRotationStatus();
  assert.equal(after.mfa.current, 1);
  assert.equal(after.mfa.previous, 0);
  assert.match(await fs.readFile(files.accountsFile, "utf8"), /"keyVersion": "v2"/);

  await rotated.logout(originalLogin.token);
  const challengedLogin = await rotated.login("rotation-admin", "RotationPassword!23");
  assert.equal(challengedLogin.mfaChallengeRequired, true);
  const challenge = await rotated.verifyMfaChallenge(challengedLogin.token, { code: generateTotp(enrollment.secret) });
  assert.equal(challenge.mfa.verified, true);
  const revoked = await rotated.revokeAllSessions("unit_key_rotation", bootstrap.account);
  assert.ok(revoked.revoked >= 1);
  assert.equal(await rotated.resolveSession(challengedLogin.token), null);
  const securitySmoke = await rotated.securitySmokeStatus({ rotationAppliedAt: revoked.revokedAt });
  assert.equal(securitySmoke.login.passed, true);
  assert.equal(securitySmoke.mfa.passed, true);
  assert.equal(securitySmoke.csrf.passed, true);
  assert.equal(securitySmoke.invitation.passed, true);
}

async function testSerializedKeyRotationApply(tempDir) {
  let mfaRuns = 0;
  let queueRuns = 0;
  let sessionRuns = 0;
  const authService = {
    async keyRotationStatus() {
      return {
        mfa: { total: 0, current: 0, previous: 0, legacy: 0, unreadable: 0, reencryptRequired: false, reencryptBlocked: false },
        sessions: { active: 1, total: 1 }
      };
    },
    async reencryptMfaSecrets() { mfaRuns += 1; return { reencrypted: 0, alreadyCurrent: 0 }; },
    async revokeAllSessions() { sessionRuns += 1; return { revoked: 1 }; },
    async securitySmokeStatus() {
      return {
        login: { passed: true, activeAdmins: 1, preRotationActiveSessions: 0, malformedPasswordHashes: 0 },
        mfa: { passed: true, current: 0, total: 0, previous: 0, legacy: 0, unreadable: 0 },
        csrf: { passed: true, currentConfigured: true, currentSignatureVerified: true },
        invitation: { passed: true, total: 0, malformedTokenHashes: 0, plaintextCredentialRows: 0 }
      };
    },
    async recordAudit() {}
  };
  const deliveryService = {
    async keyRotationStatus() {
      return {
        queue: { total: 0, current: 0, previous: 0, legacy: 0, unreadable: 0, reencryptRequired: false, reencryptBlocked: false },
        webhook: { currentConfigured: true, previousConfigured: false, previousVerificationActive: false }
      };
    },
    async reencryptRetryQueue() { queueRuns += 1; return { reencrypted: 0, alreadyCurrent: 0 }; },
    async securitySmokeStatus() {
      return {
        retryQueue: { passed: true, currentRoundTripVerified: true, current: 0, total: 0, previous: 0, unreadable: 0 },
        webhook: { passed: true, currentSignatureVerified: true, previousSignatureAccepted: true, previousAcceptanceExpected: true }
      };
    }
  };
  const service = createAuthKeyRotationService({
    historyFile: path.join(tempDir, "key-rotation-serialized", "history.json"),
    authService,
    deliveryService,
    currentVersion: "v2",
    previousVersion: "v1",
    transition: { configured: true, active: true, valid: true, maxDays: 30 },
    keyConfig: {
      csrf: { currentConfigured: true, previousConfigured: true },
      mfa: { currentConfigured: true, previousConfigured: true },
      emailQueue: { currentConfigured: true, previousConfigured: true },
      emailWebhook: { currentConfigured: true, previousConfigured: true }
    }
  });
  const preflight = await service.runPreflight({ userId: "admin_1", username: "admin" });
  assert.equal(preflight.run.status, "warning");
  assert.equal(preflight.run.canApply, true);
  assert.equal(preflight.run.summary.blocked, 0);
  const outcomes = await Promise.allSettled([
    service.applyCurrent({ userId: "admin_1", username: "admin" }),
    service.applyCurrent({ userId: "admin_1", username: "admin" })
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected" && item.reason?.code === "AUTH_KEY_ROTATION_NOT_REQUIRED").length, 1);
  assert.equal(mfaRuns, 1);
  assert.equal(queueRuns, 1);
  assert.equal(sessionRuns, 1);
  const smoke = await service.runPostRotationSmoke({ userId: "admin_1", username: "admin" });
  assert.equal(smoke.run.status, "passed");
  assert.equal(smoke.run.summary.failed, 0);
  assert.equal(smoke.report.lock.status, "locked");
}

async function testDeliveryAdapters(tempDir) {
  const mockLogs = path.join(tempDir, "unit", "mock_delivery_logs.json");
  const mock = createAuthDeliveryService({ logsFile: mockLogs, mode: "mock", provider: "test_mock" });
  const mockResult = await mock.deliver({
    kind: "account_invitation",
    targetId: "invite_mock",
    recipient: "mock@example.test",
    link: "https://app.example.test/app#invite=mock-secret-token",
    subject: "Mock invitation",
    text: "Mock"
  });
  assert.equal(mockResult.status, "succeeded");
  assert.match(mockResult.previewLink, /mock-secret-token/);
  assert.doesNotMatch(await fs.readFile(mockLogs, "utf8"), /mock-secret-token|#invite=/);

  const realLogs = path.join(tempDir, "unit", "real_delivery_logs.json");
  const realRetryQueue = path.join(tempDir, "unit", "real_delivery_retry_queue.json");
  const realWebhookEvents = path.join(tempDir, "unit", "real_delivery_webhook_events.json");
  const queueSecret = "unit-test-queue-secret-32-characters";
  const webhookSecret = "unit-test-webhook-secret-32-chars";
  const real = createAuthDeliveryService({
    logsFile: realLogs,
    retryQueueFile: realRetryQueue,
    webhookEventsFile: realWebhookEvents,
    mode: "real",
    provider: "test_real",
    endpoint: "https://mail.example.test/send",
    apiToken: "provider-secret",
    from: "noreply@example.test",
    queueSecret,
    webhookSecret,
    retryBaseSeconds: 1,
    maxAttempts: 3
  });
  const originalFetch = global.fetch;
  let captured = null;
  let fetchCount = 0;
  try {
    global.fetch = async (url, options) => {
      fetchCount += 1;
      captured = { url, options };
      return new Response(JSON.stringify({ id: "provider_message_1", status: "queued" }), { status: 202, headers: { "Content-Type": "application/json" } });
    };
    const realPayload = {
      kind: "password_reset",
      targetId: "reset_real",
      recipient: "real@example.test",
      link: "https://app.example.test/app#reset=real-secret-token",
      subject: "Reset",
      text: "Reset link"
    };
    const realResult = await real.deliver(realPayload);
    assert.equal(realResult.status, "succeeded");
    assert.equal(realResult.providerDeliveryId, "provider_message_1");
    assert.equal(realResult.previewLink, "");
    assert.equal(captured.url, "https://mail.example.test/send");
    assert.equal(captured.options.headers.Authorization, "Bearer provider-secret");
    assert.match(captured.options.headers["Idempotency-Key"], /^[a-f0-9]{64}$/);
    assert.match(captured.options.body, /real@example\.test/);

    const duplicate = await real.deliver(realPayload);
    assert.equal(duplicate.duplicateSuppressed, true);
    assert.equal(fetchCount, 1);

    global.fetch = async () => new Response("", { status: 429 });
    const limited = await real.deliver({
      kind: "password_reset",
      targetId: "reset_limited",
      recipient: "real@example.test",
      link: "https://app.example.test/app#reset=another-secret-token",
      subject: "Reset",
      text: "Reset link"
    });
    assert.equal(limited.status, "retry_required");
    assert.equal(limited.errorCode, "provider_rate_limited");
    assert.equal(limited.queueStatus, "pending");

    global.fetch = async () => new Response(JSON.stringify({ messageId: "provider_retry_2", status: "accepted" }), { status: 202 });
    const retryRun = await real.runRetries({ deliveryId: limited.deliveryId, force: true, requestedBy: "unit-admin" });
    assert.equal(retryRun.attempted, 1);
    assert.equal(retryRun.results[0].status, "succeeded");
    assert.equal(retryRun.results[0].providerDeliveryId, "provider_retry_2");

    global.fetch = async () => new Response("", { status: 503 });
    const unavailable = await real.deliver({
      kind: "account_invitation",
      targetId: "invite_unavailable",
      recipient: "real@example.test",
      link: "https://app.example.test/app#invite=service-secret-token",
      subject: "Invite",
      text: "Invite link"
    });
    assert.equal(unavailable.status, "retry_required");
    assert.equal(unavailable.errorCode, "provider_http_503");
    assert.equal(unavailable.queueStatus, "pending");

    const staleQueue = JSON.parse(await fs.readFile(realRetryQueue, "utf8"));
    const staleItem = staleQueue.items.find((item) => item.lastDeliveryId === unavailable.deliveryId);
    staleItem.status = "running";
    staleItem.claimedAt = "2020-01-01T00:00:00.000Z";
    staleItem.nextAttemptAt = "2020-01-01T00:00:00.000Z";
    await fs.writeFile(realRetryQueue, JSON.stringify(staleQueue, null, 2), "utf8");
    global.fetch = async () => new Response(JSON.stringify({ id: "provider_recovered", status: "accepted" }), { status: 202 });
    const recovered = await real.runRetries({ requestedBy: "recovery-worker" });
    assert.equal(recovered.attempted, 1);
    assert.equal(recovered.results[0].providerDeliveryId, "provider_recovered");

    const webhookBody = JSON.stringify({ eventId: "evt_bounce_1", type: "bounced", messageId: "provider_message_1" });
    const signature = crypto.createHmac("sha256", webhookSecret).update(webhookBody).digest("hex");
    const webhook = await real.processWebhook({ rawBody: webhookBody, signature: `sha256=${signature}` });
    assert.equal(webhook.delivery.status, "bounced");
    assert.equal(webhook.event.matched, true);
    const duplicateWebhook = await real.processWebhook({ rawBody: webhookBody, signature });
    assert.equal(duplicateWebhook.duplicate, true);
    await assert.rejects(
      () => real.processWebhook({ rawBody: webhookBody, signature: "0".repeat(64) }),
      (error) => error.code === "AUTH_DELIVERY_WEBHOOK_SIGNATURE_INVALID"
    );

    const report = await real.listReport({ limit: 100 });
    assert.equal(report.connector.operationalReady, true);
    assert.equal(report.summary.bounced, 1);
    assert.ok(report.summary.providerIdsRecorded >= 2);
    assert.ok(report.summary.webhookEvents >= 1);
  } finally {
    global.fetch = originalFetch;
  }

  const currentQueueSecret = "unit-test-current-queue-secret-32-characters";
  const currentWebhookSecret = "unit-test-current-webhook-secret-32-chars";
  const rotatedDelivery = createAuthDeliveryService({
    logsFile: realLogs,
    retryQueueFile: realRetryQueue,
    webhookEventsFile: realWebhookEvents,
    mode: "real",
    provider: "test_real",
    endpoint: "https://mail.example.test/send",
    apiToken: "provider-secret",
    from: "noreply@example.test",
    queueSecret: currentQueueSecret,
    previousQueueSecret: queueSecret,
    queueKeyVersion: "v2",
    previousQueueKeyVersion: "v1",
    webhookSecret: currentWebhookSecret,
    previousWebhookSecret: webhookSecret,
    webhookKeyVersion: "v2",
    previousWebhookKeyVersion: "v1",
    keyTransitionActive: true
  });
  const rotationBefore = await rotatedDelivery.keyRotationStatus();
  assert.ok(rotationBefore.queue.previous >= 1);
  assert.equal(rotationBefore.queue.reencryptRequired, true);
  assert.equal(rotationBefore.webhook.previousVerificationActive, true);
  const queueMigration = await rotatedDelivery.reencryptRetryQueue();
  assert.ok(queueMigration.reencrypted >= 1);
  const rotationAfter = await rotatedDelivery.keyRotationStatus();
  assert.equal(rotationAfter.queue.previous, 0);
  assert.equal(rotationAfter.queue.current, rotationAfter.queue.total);
  const activeTransitionSmoke = await rotatedDelivery.securitySmokeStatus();
  assert.equal(activeTransitionSmoke.retryQueue.passed, true);
  assert.equal(activeTransitionSmoke.webhook.passed, true);

  const previousSignedBody = JSON.stringify({ eventId: "evt_previous_key_1", type: "delivered", messageId: "provider_retry_2" });
  const previousSignature = crypto.createHmac("sha256", webhookSecret).update(previousSignedBody).digest("hex");
  const previousWebhook = await rotatedDelivery.processWebhook({ rawBody: previousSignedBody, signature: previousSignature });
  assert.equal(previousWebhook.event.signatureKeySource, "previous");
  assert.equal(previousWebhook.event.signatureKeyVersion, "v1");

  const inactiveDelivery = createAuthDeliveryService({
    logsFile: realLogs,
    retryQueueFile: realRetryQueue,
    webhookEventsFile: realWebhookEvents,
    mode: "real",
    provider: "test_real",
    endpoint: "https://mail.example.test/send",
    apiToken: "provider-secret",
    from: "noreply@example.test",
    queueSecret: currentQueueSecret,
    previousQueueSecret: queueSecret,
    queueKeyVersion: "v2",
    previousQueueKeyVersion: "v1",
    webhookSecret: currentWebhookSecret,
    previousWebhookSecret: webhookSecret,
    webhookKeyVersion: "v2",
    previousWebhookKeyVersion: "v1",
    keyTransitionActive: false
  });
  const expiredTransitionBody = JSON.stringify({ eventId: "evt_previous_key_expired", type: "delivered", messageId: "provider_retry_2" });
  const expiredTransitionSignature = crypto.createHmac("sha256", webhookSecret).update(expiredTransitionBody).digest("hex");
  await assert.rejects(
    () => inactiveDelivery.processWebhook({ rawBody: expiredTransitionBody, signature: expiredTransitionSignature }),
    (error) => error.code === "AUTH_DELIVERY_WEBHOOK_SIGNATURE_INVALID"
  );
  const inactiveTransitionSmoke = await inactiveDelivery.securitySmokeStatus();
  assert.equal(inactiveTransitionSmoke.retryQueue.passed, true);
  assert.equal(inactiveTransitionSmoke.webhook.passed, true);

  const realLogText = await fs.readFile(realLogs, "utf8");
  const retryQueueText = await fs.readFile(realRetryQueue, "utf8");
  const webhookText = await fs.readFile(realWebhookEvents, "utf8");
  for (const fileText of [realLogText, retryQueueText, webhookText]) {
    assert.doesNotMatch(fileText, /provider-secret|real-secret-token|another-secret-token|service-secret-token|#reset=|#invite=/);
  }
  assert.match(retryQueueText, /aes-256-gcm|ciphertext/);
  assert.match(retryQueueText, /"keyVersion": "v2"/);
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function startServer(dataDir, envOverrides = {}) {
  const port = 47000 + Math.floor(Math.random() * 8000);
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataDir,
      OUTPUTS_DIR: path.join(dataDir, "outputs"),
      NODE_ENV: "production",
      RENDER: "true",
      RENDER_GIT_COMMIT: "2182182182182182182182182182182182182182",
      RENDER_GIT_BRANCH: "main",
      RENDER_GIT_REPO_SLUG: "example/lodging-datalab",
      APP_PIN: "",
      ADMIN_PIN: "",
      ADMIN_BOOTSTRAP_USER: "operator",
      ADMIN_BOOTSTRAP_PASSWORD: "OperatorPassword!23",
      AUTH_ALLOW_LEGACY_BASIC: "false",
      AUTH_MFA_ENFORCE_ADMIN: "false",
      AUTH_LOGIN_ACCOUNT_MAX_ATTEMPTS: "3",
      AUTH_LOGIN_IP_MAX_ATTEMPTS: "50",
      AUTH_RESET_ACCOUNT_MAX_REQUESTS: "3",
      AUTH_RESET_IP_MAX_REQUESTS: "50",
      AUTH_INVITE_ACCOUNT_MAX_DELIVERIES: "3",
      AUTH_INVITE_IP_MAX_DELIVERIES: "50",
      AUTH_ACTIVATION_TOKEN_MAX_ATTEMPTS: "3",
      AUTH_ACTIVATION_IP_MAX_ATTEMPTS: "50",
      AUTH_EMAIL_MODE: "mock",
      AUTH_EMAIL_QUEUE_SECRET: "integration-queue-secret-32-characters",
      AUTH_EMAIL_WEBHOOK_SECRET: "integration-webhook-secret-32-chars",
      AUTH_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      AUTH_CSRF_SECRET: "integration-csrf-secret-at-least-32-characters",
      AUTH_MFA_ENCRYPTION_KEY: "integration-default-mfa-key-at-least-32-characters",
      AUTH_KEY_CURRENT_VERSION: "integration-v2",
      AUTH_CSRF_ENFORCE: "true",
      AUTH_ORIGIN_ENFORCE: "true",
      AUTH_TRUST_PROXY: "render",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child);
  return {
    baseUrl,
    async stop() {
      if (child.exitCode === null) child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      if (child.exitCode && child.exitCode !== 0) throw new Error(stderr || `server exited with code ${child.exitCode}`);
    }
  };
}

async function request(baseUrl, requestPath, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  const method = String(options.method || "GET").toUpperCase();
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !options.skipOrigin && requestPath !== "/api/auth/email/webhook") {
    headers.Origin = options.origin || new URL(baseUrl).origin;
  }
  if (options.cookie && !options.skipCsrf && csrfByCookie.has(options.cookie)) {
    headers["X-CSRF-Token"] = csrfByCookie.get(options.cookie);
  }
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  const cookie = String(response.headers.get("set-cookie") || "").split(";", 1)[0];
  const csrfToken = body && typeof body === "object" ? String(body.csrfToken || "") : "";
  if (csrfToken && cookie) csrfByCookie.set(cookie, csrfToken);
  if (csrfToken && !cookie && options.cookie) csrfByCookie.set(options.cookie, csrfToken);
  return {
    status: response.status,
    body,
    cookie,
    retryAfter: response.headers.get("retry-after") || "",
    headers: Object.fromEntries(response.headers.entries())
  };
}

async function login(baseUrl, username, password) {
  return request(baseUrl, "/api/auth/login", { method: "POST", body: { username, password } });
}

function tokenFromLink(link, key) {
  const url = new URL(link);
  return new URLSearchParams(url.hash.replace(/^#/, "")).get(key) || "";
}

async function testAccountAndTenantFlow(dataDir) {
  const server = await startServer(dataDir);
  try {
    const anonymous = await request(server.baseUrl, `/api/business/report?companyId=${OWNED_COMPANY_ID}`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers["content-security-policy"] || "", /default-src 'self'/);
    assert.equal(anonymous.headers["x-content-type-options"], "nosniff");
    assert.equal(anonymous.headers["referrer-policy"], "no-referrer");
    assert.match(anonymous.headers["permissions-policy"] || "", /camera=\(\)/);
    assert.match(anonymous.headers["strict-transport-security"] || "", /max-age=31536000/);

    const adminLogin = await login(server.baseUrl, "operator", "OperatorPassword!23");
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.body.account.role, "admin");
    assert.ok(adminLogin.cookie.startsWith("lodging_session="));
    assert.ok(adminLogin.body.csrfToken.length >= 32);

    const missingCsrf = await request(server.baseUrl, "/api/admin/auth/accounts", {
      method: "POST",
      cookie: adminLogin.cookie,
      skipCsrf: true,
      body: {}
    });
    assert.equal(missingCsrf.status, 403);
    assert.equal(missingCsrf.body.code, "AUTH_CSRF_INVALID");

    const crossOrigin = await request(server.baseUrl, "/api/admin/auth/accounts", {
      method: "POST",
      cookie: adminLogin.cookie,
      origin: "https://attacker.example",
      body: {}
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.body.code, "REQUEST_ORIGIN_FORBIDDEN");

    const spoofedHost = await request(server.baseUrl, "/api/admin/auth/accounts", {
      method: "POST",
      cookie: adminLogin.cookie,
      headers: { "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http" },
      body: {}
    });
    assert.equal(spoofedHost.status, 403);
    assert.equal(spoofedHost.body.code, "REQUEST_HOST_FORBIDDEN");

    const legacyBasicDenied = await request(server.baseUrl, "/api/admin/auth/accounts", {
      headers: { Authorization: `Basic ${Buffer.from("operator:OperatorPassword!23").toString("base64")}` }
    });
    assert.equal(legacyBasicDenied.status, 401);

    const lastAdminProtected = await request(server.baseUrl, "/api/admin/auth/accounts", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: {
        userId: adminLogin.body.account.userId,
        username: "operator",
        displayName: "Operator",
        role: "business",
        status: "active",
        companyIds: [OWNED_COMPANY_ID]
      }
    });
    assert.equal(lastAdminProtected.status, 409);
    assert.equal(lastAdminProtected.body.code, "AUTH_LAST_ADMIN_REQUIRED");

    const created = await request(server.baseUrl, "/api/admin/auth/accounts", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: {
        username: "owner@example.test",
        displayName: "Owned Stay Operator",
        password: "BusinessPassword!23",
        role: "business",
        status: "active",
        companyIds: [OWNED_COMPANY_ID]
      }
    });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.account.companyIds, [OWNED_COMPANY_ID]);
    assert.equal("passwordHash" in created.body.account, false);

    const lockTarget = await request(server.baseUrl, "/api/admin/auth/accounts", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: {
        username: "locked@example.test",
        displayName: "Locked Business",
        password: "LockedPassword!23",
        role: "business",
        status: "active",
        companyIds: [OWNED_COMPANY_ID]
      }
    });
    assert.equal(lockTarget.status, 201);

    assert.equal((await login(server.baseUrl, "locked@example.test", "wrong-one")).status, 401);
    assert.equal((await login(server.baseUrl, "locked@example.test", "wrong-two")).status, 401);
    const lockedLogin = await login(server.baseUrl, "locked@example.test", "wrong-three");
    assert.equal(lockedLogin.status, 429);
    assert.equal(lockedLogin.body.code, "AUTH_LOGIN_LOCKED");
    assert.ok(Number(lockedLogin.retryAfter) >= 1);
    assert.equal((await login(server.baseUrl, "locked@example.test", "LockedPassword!23")).status, 429);

    const securityBeforeUnlock = await request(server.baseUrl, "/api/admin/auth/security?days=30", { cookie: adminLogin.cookie });
    assert.equal(securityBeforeUnlock.status, 200);
    const accountLock = securityBeforeUnlock.body.locks.find((item) => item.action === "login" && item.scope === "account" && item.label === "locked@example.test");
    assert.ok(accountLock);
    assert.ok(securityBeforeUnlock.body.summary.loginFailures >= 3);
    assert.equal("subjectHash" in accountLock, false);

    const unlocked = await request(server.baseUrl, "/api/admin/auth/security/unlock", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: { lockId: accountLock.lockId }
    });
    assert.equal(unlocked.status, 200);
    const lockTargetLogin = await login(server.baseUrl, "locked@example.test", "LockedPassword!23");
    assert.equal(lockTargetLogin.status, 200);

    const disabledTarget = await request(server.baseUrl, "/api/admin/auth/accounts", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: {
        userId: lockTarget.body.account.userId,
        username: "locked@example.test",
        displayName: "Locked Business",
        role: "business",
        status: "disabled",
        companyIds: [OWNED_COMPANY_ID]
      }
    });
    assert.equal(disabledTarget.status, 200);
    assert.equal((await request(server.baseUrl, `/api/business/report?companyId=${OWNED_COMPANY_ID}`, { cookie: lockTargetLogin.cookie })).status, 401);

    const issuedInvite = await request(server.baseUrl, "/api/admin/auth/invitations", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: {
        username: "invited@example.test",
        displayName: "Invited Owner",
        role: "business",
        companyIds: [OWNED_COMPANY_ID]
      }
    });
    assert.equal(issuedInvite.status, 201);
    assert.equal(issuedInvite.body.invitation.status, "pending");
    assert.equal(issuedInvite.body.delivery.mode, "mock");
    assert.equal(issuedInvite.body.delivery.status, "succeeded");
    assert.match(issuedInvite.body.delivery.providerDeliveryId, /^mock_dlv_/);
    assert.equal("token" in issuedInvite.body, false);
    const inviteToken = tokenFromLink(issuedInvite.body.delivery.previewLink, "invite");
    assert.ok(inviteToken.length >= 40);

    const webhookPayload = { eventId: "integration_delivered_1", type: "delivered", messageId: issuedInvite.body.delivery.providerDeliveryId };
    const webhookRaw = JSON.stringify(webhookPayload);
    const webhookSignature = crypto.createHmac("sha256", "integration-webhook-secret-32-chars").update(webhookRaw).digest("hex");
    const webhookResult = await request(server.baseUrl, "/api/auth/email/webhook", {
      method: "POST",
      headers: { "X-Auth-Delivery-Signature": `sha256=${webhookSignature}` },
      body: webhookPayload
    });
    assert.equal(webhookResult.status, 202);
    assert.equal(webhookResult.body.state, "delivered");
    assert.equal(webhookResult.body.matched, true);
    assert.equal((await request(server.baseUrl, "/api/auth/email/webhook", {
      method: "POST",
      headers: { "X-Auth-Delivery-Signature": "0".repeat(64) },
      body: webhookPayload
    })).status, 401);

    const inspectedInvite = await request(server.baseUrl, "/api/auth/invitations/inspect", {
      method: "POST",
      body: { token: inviteToken }
    });
    assert.equal(inspectedInvite.status, 200);
    assert.match(inspectedInvite.body.invitation.username, /\*/);
    assert.deepEqual(inspectedInvite.body.invitation.companyIds, [OWNED_COMPANY_ID]);

    const acceptedInvite = await request(server.baseUrl, "/api/auth/invitations/accept", {
      method: "POST",
      body: { token: inviteToken, newPassword: "InvitedPassword!23" }
    });
    assert.equal(acceptedInvite.status, 200);
    assert.equal(acceptedInvite.body.account.role, "business");
    assert.deepEqual(acceptedInvite.body.account.companyIds, [OWNED_COMPANY_ID]);
    assert.equal((await request(server.baseUrl, "/api/auth/invitations/accept", {
      method: "POST",
      body: { token: inviteToken, newPassword: "AnotherPassword!23" }
    })).status, 400);

    const invitedLogin = await login(server.baseUrl, "invited@example.test", "InvitedPassword!23");
    assert.equal(invitedLogin.status, 200);
    const invitedCompanies = await request(server.baseUrl, "/api/business/companies?limit=200", { cookie: invitedLogin.cookie });
    assert.deepEqual(invitedCompanies.body.items.map((item) => item.companyId), [OWNED_COMPANY_ID]);
    assert.equal((await request(server.baseUrl, "/api/admin/auth/invitations", { cookie: invitedLogin.cookie })).status, 403);
    assert.equal((await request(server.baseUrl, "/api/admin/auth/deliveries", { cookie: invitedLogin.cookie })).status, 403);
    assert.equal((await request(server.baseUrl, "/api/admin/auth/deliveries/retries/run", {
      method: "POST", cookie: invitedLogin.cookie, body: { force: true }
    })).status, 403);
    assert.equal((await request(server.baseUrl, "/api/admin/auth/deliveries/resend", {
      method: "POST", cookie: invitedLogin.cookie, body: { deliveryId: issuedInvite.body.delivery.deliveryId }
    })).status, 403);

    const reissueSource = await request(server.baseUrl, "/api/admin/auth/invitations", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: { username: "reissue@example.test", displayName: "Reissue Owner", role: "business", companyIds: [OWNED_COMPANY_ID] }
    });
    const oldReissueToken = tokenFromLink(reissueSource.body.delivery.previewLink, "invite");
    const reissuedInvite = await request(server.baseUrl, "/api/admin/auth/invitations/reissue", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: { inviteId: reissueSource.body.invitation.inviteId }
    });
    assert.equal(reissuedInvite.status, 201);
    const newReissueToken = tokenFromLink(reissuedInvite.body.delivery.previewLink, "invite");
    assert.notEqual(newReissueToken, oldReissueToken);
    assert.equal((await request(server.baseUrl, "/api/auth/invitations/inspect", { method: "POST", body: { token: oldReissueToken } })).status, 400);
    assert.equal((await request(server.baseUrl, "/api/auth/invitations/inspect", { method: "POST", body: { token: newReissueToken } })).status, 200);
    const cancelledInvite = await request(server.baseUrl, "/api/admin/auth/invitations/cancel", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: { inviteId: reissuedInvite.body.invitation.inviteId }
    });
    assert.equal(cancelledInvite.status, 200);
    assert.equal(cancelledInvite.body.invitation.status, "cancelled");
    assert.equal((await request(server.baseUrl, "/api/auth/invitations/inspect", { method: "POST", body: { token: newReissueToken } })).status, 400);

    const resendSource = await request(server.baseUrl, "/api/admin/auth/invitations", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: { username: "manual-resend@example.test", displayName: "Manual Resend", role: "business", companyIds: [OWNED_COMPANY_ID] }
    });
    const resendOldToken = tokenFromLink(resendSource.body.delivery.previewLink, "invite");
    const resent = await request(server.baseUrl, "/api/admin/auth/deliveries/resend", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: { deliveryId: resendSource.body.delivery.deliveryId }
    });
    assert.equal(resent.status, 201);
    const resendNewToken = tokenFromLink(resent.body.delivery.previewLink, "invite");
    assert.notEqual(resendNewToken, resendOldToken);
    assert.equal((await request(server.baseUrl, "/api/auth/invitations/inspect", { method: "POST", body: { token: resendOldToken } })).status, 400);
    assert.equal((await request(server.baseUrl, "/api/auth/invitations/inspect", { method: "POST", body: { token: resendNewToken } })).status, 200);
    assert.equal((await request(server.baseUrl, "/api/admin/auth/invitations/cancel", {
      method: "POST", cookie: adminLogin.cookie, body: { inviteId: resent.body.targetId }
    })).status, 200);

    assert.equal((await request(server.baseUrl, "/api/auth/invitations/inspect", { method: "POST", body: { token: "invalid-repeated-token" } })).status, 400);
    assert.equal((await request(server.baseUrl, "/api/auth/invitations/inspect", { method: "POST", body: { token: "invalid-repeated-token" } })).status, 400);
    const activationLocked = await request(server.baseUrl, "/api/auth/invitations/inspect", { method: "POST", body: { token: "invalid-repeated-token" } });
    assert.equal(activationLocked.status, 429);
    assert.equal(activationLocked.body.code, "AUTH_INVITE_ACTIVATION_LOCKED");

    assert.equal((await request(server.baseUrl, "/api/admin/auth/invitations", {
      method: "POST", cookie: adminLogin.cookie, body: { username: "owner@example.test", displayName: "Exists", role: "business", companyIds: [OWNED_COMPANY_ID] }
    })).status, 409);
    assert.equal((await request(server.baseUrl, "/api/admin/auth/invitations", {
      method: "POST", cookie: adminLogin.cookie, body: { username: "owner@example.test", displayName: "Exists", role: "business", companyIds: [OWNED_COMPANY_ID] }
    })).status, 409);
    const inviteDeliveryLocked = await request(server.baseUrl, "/api/admin/auth/invitations", {
      method: "POST", cookie: adminLogin.cookie, body: { username: "owner@example.test", displayName: "Exists", role: "business", companyIds: [OWNED_COMPANY_ID] }
    });
    assert.equal(inviteDeliveryLocked.status, 429);
    assert.equal(inviteDeliveryLocked.body.code, "AUTH_INVITE_RATE_LIMITED");

    let businessLogin = await login(server.baseUrl, "owner@example.test", "BusinessPassword!23");
    assert.equal(businessLogin.status, 200);
    assert.equal(businessLogin.body.account.role, "business");

    const originalBusinessCookie = businessLogin.cookie;
    const rotatedBusinessLogin = await request(server.baseUrl, "/api/auth/login", {
      method: "POST",
      cookie: originalBusinessCookie,
      body: { username: "owner@example.test", password: "BusinessPassword!23" }
    });
    assert.equal(rotatedBusinessLogin.status, 200);
    assert.notEqual(rotatedBusinessLogin.cookie, originalBusinessCookie);
    assert.equal((await request(server.baseUrl, `/api/business/report?companyId=${OWNED_COMPANY_ID}`, { cookie: originalBusinessCookie })).status, 401);
    businessLogin = rotatedBusinessLogin;
    const businessSession = await request(server.baseUrl, "/api/auth/session", { cookie: businessLogin.cookie });
    assert.equal(businessSession.status, 200);
    assert.equal("mfa" in businessSession.body, false);
    assert.doesNotMatch(JSON.stringify(businessSession.body), /recovery|encryption|security|audit/i);

    const companies = await request(server.baseUrl, "/api/business/companies?limit=200", { cookie: businessLogin.cookie });
    assert.equal(companies.status, 200);
    assert.deepEqual(companies.body.items.map((item) => item.companyId), [OWNED_COMPANY_ID]);

    const ownedReport = await request(server.baseUrl, `/api/business/report?companyId=${OWNED_COMPANY_ID}`, { cookie: businessLogin.cookie });
    assert.equal(ownedReport.status, 200);
    assert.equal(ownedReport.body.company.companyId, OWNED_COMPANY_ID);

    const forbiddenReport = await request(server.baseUrl, `/api/business/report?companyId=${OTHER_COMPANY_ID}`, { cookie: businessLogin.cookie });
    assert.equal(forbiddenReport.status, 403);
    assert.equal(forbiddenReport.body.code, "TENANT_COMPANY_FORBIDDEN");
    assert.doesNotMatch(JSON.stringify(forbiddenReport.body), /Other Stay|cmp_tenant_other/);

    const forbiddenWrite = await request(server.baseUrl, "/api/business/strategy-execution-plans", {
      method: "POST",
      cookie: businessLogin.cookie,
      body: { companyId: OTHER_COMPANY_ID, targetMonth: "2026-08", strategyId: "forbidden" }
    });
    assert.equal(forbiddenWrite.status, 403);
    assert.equal(forbiddenWrite.body.code, "TENANT_COMPANY_FORBIDDEN");

    const adminDenied = await request(server.baseUrl, "/api/admin/auth/accounts", { cookie: businessLogin.cookie });
    assert.equal(adminDenied.status, 403);
    assert.equal(adminDenied.body.code, "AUTH_ROLE_FORBIDDEN");

    const securityDenied = await request(server.baseUrl, "/api/admin/auth/security", { cookie: businessLogin.cookie });
    assert.equal(securityDenied.status, 403);
    assert.equal(securityDenied.body.code, "AUTH_ROLE_FORBIDDEN");

    const securityWithTenantDenial = await request(server.baseUrl, "/api/admin/auth/security?days=30&limit=200", { cookie: adminLogin.cookie });
    assert.ok(securityWithTenantDenial.body.summary.tenantDenials >= 2);
    assert.ok(securityWithTenantDenial.body.items.some((item) => item.eventType === "tenant_access_denied" && item.companyId === OTHER_COMPANY_ID));

    const publicReset = await request(server.baseUrl, "/api/auth/password-reset/request", {
      method: "POST",
      body: { username: "owner@example.test" }
    });
    assert.equal(publicReset.status, 202);
    assert.equal("resetToken" in publicReset.body, false);

    for (let index = 0; index < 3; index += 1) {
      const limitedReset = await request(server.baseUrl, "/api/auth/password-reset/request", {
        method: "POST",
        body: { username: "unknown-reset@example.test" }
      });
      assert.equal(limitedReset.status, 202);
      assert.equal("rateLimited" in limitedReset.body, false);
    }
    const resetSecurity = await request(server.baseUrl, "/api/admin/auth/security?days=30", { cookie: adminLogin.cookie });
    assert.ok(resetSecurity.body.locks.some((item) => item.action === "password_reset" && item.scope === "account" && item.label === "unknown-reset@example.test"));

    const reset = await request(server.baseUrl, "/api/admin/auth/password-reset-requests", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: { username: "owner@example.test" }
    });
    assert.equal(reset.status, 201);
    assert.ok(reset.body.resetToken);

    const confirmed = await request(server.baseUrl, "/api/auth/password-reset/confirm", {
      method: "POST",
      body: { token: reset.body.resetToken, newPassword: "NewBusinessPassword!45" }
    });
    assert.equal(confirmed.status, 200);

    const revokedSession = await request(server.baseUrl, `/api/business/report?companyId=${OWNED_COMPANY_ID}`, { cookie: businessLogin.cookie });
    assert.equal(revokedSession.status, 401);
    assert.equal((await login(server.baseUrl, "owner@example.test", "BusinessPassword!23")).status, 401);

    const newLogin = await login(server.baseUrl, "owner@example.test", "NewBusinessPassword!45");
    assert.equal(newLogin.status, 200);
    const logout = await request(server.baseUrl, "/api/auth/logout", { method: "POST", cookie: newLogin.cookie, body: {} });
    assert.equal(logout.status, 200);
    assert.match(String(logout.cookie), /^lodging_session=$/);
    assert.equal((await request(server.baseUrl, `/api/business/report?companyId=${OWNED_COMPANY_ID}`, { cookie: newLogin.cookie })).status, 401);

    const finalSecurity = await request(server.baseUrl, "/api/admin/auth/security?days=30&limit=500", { cookie: adminLogin.cookie });
    assert.equal(finalSecurity.status, 200);
    assert.ok(finalSecurity.body.items.some((item) => item.eventType === "logout"));
    assert.ok(finalSecurity.body.items.some((item) => item.eventType === "password_changed"));
    assert.ok(finalSecurity.body.items.some((item) => item.eventType === "permission_changed"));
    assert.ok(finalSecurity.body.items.some((item) => item.eventType === "invitation_accepted"));
    assert.ok(finalSecurity.body.items.some((item) => item.eventType === "account_invitation_delivery"));

    const invitationReport = await request(server.baseUrl, "/api/admin/auth/invitations?limit=200", { cookie: adminLogin.cookie });
    assert.equal(invitationReport.status, 200);
    assert.ok(invitationReport.body.items.some((item) => item.username === "invited@example.test" && item.status === "accepted"));
    assert.equal(invitationReport.body.deliveryConnector.activeMode, "mock");

    const deliveryReport = await request(server.baseUrl, "/api/admin/auth/deliveries?limit=200", { cookie: adminLogin.cookie });
    assert.equal(deliveryReport.status, 200);
    assert.equal(deliveryReport.body.connector.queueEncryptionConfigured, true);
    assert.equal(deliveryReport.body.connector.webhookConfigured, true);
    assert.ok(deliveryReport.body.summary.providerIdsRecorded >= 1);
    assert.ok(deliveryReport.body.summary.webhookEvents >= 1);
    assert.ok(deliveryReport.body.items.every((item) => !("providerResponse" in item)));

    const businessLaunchGateDenied = await request(server.baseUrl, "/api/admin/master-db/commercial-launch-gate", { cookie: invitedLogin.cookie });
    assert.equal(businessLaunchGateDenied.status, 403);
    const businessLaunchDecisionDenied = await request(server.baseUrl, "/api/admin/master-db/commercial-launch-gate", {
      method: "POST",
      cookie: invitedLogin.cookie,
      body: { decision: "hold" }
    });
    assert.equal(businessLaunchDecisionDenied.status, 403);
    assert.equal((await request(server.baseUrl, "/api/admin/master-db/commercial-launch-rc-rehearsals", { cookie: invitedLogin.cookie })).status, 403);
    assert.equal((await request(server.baseUrl, "/api/admin/master-db/commercial-launch-rc-rehearsals", {
      method: "POST",
      cookie: invitedLogin.cookie,
      body: { requestedEnvironment: "render" }
    })).status, 403);

    const launchGate = await request(server.baseUrl, "/api/admin/master-db/commercial-launch-gate", { cookie: adminLogin.cookie });
    assert.equal(launchGate.status, 200);
    assert.equal(launchGate.body.role, "admin");
    assert.equal(launchGate.body.automaticChecks.length, 7);
    assert.equal(launchGate.body.requiredEvidence.length, 5);
    assert.equal(launchGate.body.policy.approvalMode, "manual_only");
    assert.equal(launchGate.body.policy.automaticApproval, false);
    assert.ok(["no_go", "pending_review", "hold", "review_required", "go"].includes(launchGate.body.summary.launchDecision));

    const heldLaunch = await request(server.baseUrl, "/api/admin/master-db/commercial-launch-gate", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: {
        decision: "hold",
        finalApprover: "release-owner",
        releaseNote: "Hold until the post-deploy smoke suite and operator evidence are complete.",
        manualEvidence: launchGate.body.requiredEvidence.map((item) => ({
          evidenceId: item.evidenceId,
          confirmed: false,
          reference: ""
        }))
      }
    });
    assert.equal(heldLaunch.status, 201);
    assert.equal(heldLaunch.body.review.finalDecision, "hold");
    assert.equal(heldLaunch.body.report.summary.launchDecision, heldLaunch.body.report.summary.blockerCount ? "no_go" : "hold");
    assert.ok(heldLaunch.body.review.beforeSnapshot.automaticFingerprint);
    assert.ok(heldLaunch.body.review.afterSnapshot.automaticFingerprint);

    const blockedApproval = await request(server.baseUrl, "/api/admin/master-db/commercial-launch-gate", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: {
        decision: "approved",
        finalApprover: "release-owner",
        releaseNote: "This approval must be rejected while automatic blockers remain.",
        manualEvidence: launchGate.body.requiredEvidence.map((item) => ({ evidenceId: item.evidenceId, confirmed: true, reference: `evidence:${item.evidenceId}` }))
      }
    });
    assert.equal(blockedApproval.status, 409);
    const launchGateFile = await fs.readFile(path.join(dataDir, "db", "commercial_launch_gate_reviews.json"), "utf8");
    assert.match(launchGateFile, /commercial_launch_gate_reviews_v1/);
    assert.doesNotMatch(launchGateFile, /integration-csrf-secret|integration-default-mfa-key|integration-queue-secret|integration-webhook-secret/);

    const rcDraft = await request(server.baseUrl, "/api/admin/master-db/commercial-launch-rc-rehearsals?rehearsalId=__new__", { cookie: adminLogin.cookie });
    assert.equal(rcDraft.status, 200);
    assert.equal(rcDraft.body.role, "admin");
    assert.equal(rcDraft.body.runtime.environment, "render");
    assert.equal(rcDraft.body.environmentComparison.localEvidenceCountsForRelease, false);
    assert.equal(rcDraft.body.policy.finalApproval, "manual_only");
    assert.equal(rcDraft.body.policy.automaticApproval, false);
    assert.equal(rcDraft.body.releaseCandidate.status, "blocked");
    assert.equal(rcDraft.body.releaseCandidate.detectedCommit, "2182182182182182182182182182182182182182");
    const createdRc = await request(server.baseUrl, "/api/admin/master-db/commercial-launch-rc-rehearsals", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: {
        requestedEnvironment: "render",
        targetUrl: "https://staging.example.test",
        expectedCommit: "2182182182182182182182182182182182182182",
        owners: {
          releaseOwner: "release-owner",
          rollbackOwner: "rollback-owner",
          smokeTestOwner: "smoke-owner",
          customerSupportOwner: "support-owner",
          incidentCommunicationOwner: "incident-owner"
        },
        confirmations: { mfaRecoveryVerified: true, providerWebhookVerified: true },
        connectorModes: rcDraft.body.rehearsal.connectorModes.map((item) => ({ connectorId: item.connectorId, mode: "mock", notes: "RC mock launch with quota-safe fallback." })),
        notes: "Integration RC rehearsal keeps final approval manual."
      }
    });
    assert.equal(createdRc.status, 201);
    const rcRehearsalId = createdRc.body.rehearsal.rehearsalId;
    assert.ok(rcRehearsalId);
    assert.equal(createdRc.body.environmentComparison.matches, true);
    assert.equal(createdRc.body.environmentComparison.target.valid, true);
    assert.equal(createdRc.body.releaseCandidate.status, "passed");
    assert.equal(createdRc.body.releaseCandidate.matches, true);
    assert.equal(createdRc.body.summary.readyForFinalReview, false);
    assert.equal(createdRc.body.steps.find((item) => item.stepId === "release_source_parity").status, "passed");
    assert.equal(createdRc.body.steps.find((item) => item.stepId === "release_owners").status, "passed");
    assert.ok(createdRc.body.operatorActions.some((item) => item.stepId === "current_backup"));

    const rcBackup = await request(server.baseUrl, `/api/admin/master-db/commercial-launch-rc-rehearsals/${encodeURIComponent(rcRehearsalId)}/actions/create_backup`, {
      method: "POST", cookie: adminLogin.cookie, body: { includeOutputs: false }
    });
    assert.equal(rcBackup.status, 200);
    assert.equal(rcBackup.body.rehearsal.evidence.backup.status, "succeeded");
    const rcRestore = await request(server.baseUrl, `/api/admin/master-db/commercial-launch-rc-rehearsals/${encodeURIComponent(rcRehearsalId)}/actions/record_restore`, {
      method: "POST",
      cookie: adminLogin.cookie,
      body: { status: "passed", notes: "Isolated restore copy was opened, verified, and smoke checked." }
    });
    assert.equal(rcRestore.status, 200);
    assert.equal(rcRestore.body.rehearsal.evidence.restore.status, "passed");
    const rcPreflight = await request(server.baseUrl, `/api/admin/master-db/commercial-launch-rc-rehearsals/${encodeURIComponent(rcRehearsalId)}/actions/auth_preflight`, {
      method: "POST", cookie: adminLogin.cookie, body: {}
    });
    assert.equal(rcPreflight.status, 200);
    assert.notEqual(rcPreflight.body.rehearsal.evidence.authPreflight.status, "blocked");
    assert.doesNotMatch(JSON.stringify(rcPreflight.body), /integration-csrf-secret|integration-default-mfa-key|integration-queue-secret|integration-webhook-secret/);

    const businessRotationDenied = await request(server.baseUrl, "/api/admin/auth/key-rotation", { cookie: invitedLogin.cookie });
    assert.equal(businessRotationDenied.status, 403);
    const businessPreflightDenied = await request(server.baseUrl, "/api/admin/auth/key-rotation/dry-run", { method: "POST", cookie: invitedLogin.cookie, body: {} });
    assert.equal(businessPreflightDenied.status, 403);
    const businessSmokeDenied = await request(server.baseUrl, "/api/admin/auth/key-rotation/smoke-test", { method: "POST", cookie: invitedLogin.cookie, body: {} });
    assert.equal(businessSmokeDenied.status, 403);
    const rotationBefore = await request(server.baseUrl, "/api/admin/auth/key-rotation", { cookie: adminLogin.cookie });
    assert.equal(rotationBefore.status, 200);
    assert.equal(rotationBefore.body.currentVersion, "integration-v2");
    assert.equal(rotationBefore.body.canApply, true);
    assert.doesNotMatch(JSON.stringify(rotationBefore.body), /integration-csrf-secret|integration-default-mfa-key|integration-queue-secret|integration-webhook-secret/);
    const preflight = await request(server.baseUrl, "/api/admin/auth/key-rotation/dry-run", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: {}
    });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.body.run.canApply, true);
    assert.equal(preflight.body.run.summary.blocked, 0);
    assert.equal(preflight.body.report.preflight.latest.runId, preflight.body.run.runId);
    assert.equal(preflight.body.report.lock.status, "locked");
    assert.doesNotMatch(JSON.stringify(preflight.body), /integration-csrf-secret|integration-default-mfa-key|integration-queue-secret|integration-webhook-secret/);
    const rotationApplied = await request(server.baseUrl, "/api/admin/auth/key-rotation/apply", {
      method: "POST",
      cookie: adminLogin.cookie,
      body: { confirmVersion: "integration-v2" }
    });
    assert.equal(rotationApplied.status, 200);
    assert.equal(rotationApplied.body.applied, true);
    assert.ok(rotationApplied.body.sessions.revoked >= 1);
    assert.equal((await request(server.baseUrl, "/api/admin/auth/key-rotation", { cookie: adminLogin.cookie })).status, 401);

    const postRotationLogin = await login(server.baseUrl, "operator", "OperatorPassword!23");
    assert.equal(postRotationLogin.status, 200);
    const postRotationSmoke = await request(server.baseUrl, "/api/admin/auth/key-rotation/smoke-test", {
      method: "POST",
      cookie: postRotationLogin.cookie,
      body: {}
    });
    assert.equal(postRotationSmoke.status, 200);
    assert.equal(postRotationSmoke.body.run.status, "passed");
    assert.equal(postRotationSmoke.body.run.summary.failed, 0);
    assert.equal(postRotationSmoke.body.run.checks.filter((item) => item.status === "passed").length, 7);
    assert.equal(postRotationSmoke.body.report.postRotationSmoke.latest.runId, postRotationSmoke.body.run.runId);
    assert.doesNotMatch(JSON.stringify(postRotationSmoke.body), /integration-csrf-secret|integration-default-mfa-key|integration-queue-secret|integration-webhook-secret/);

    const rcAuthSmoke = await request(server.baseUrl, `/api/admin/master-db/commercial-launch-rc-rehearsals/${encodeURIComponent(rcRehearsalId)}/actions/auth_smoke`, {
      method: "POST", cookie: postRotationLogin.cookie, body: {}
    });
    assert.equal(rcAuthSmoke.status, 200);
    assert.equal(rcAuthSmoke.body.rehearsal.evidence.authSmoke.status, "passed");
    assert.equal(rcAuthSmoke.body.steps.find((item) => item.stepId === "auth_key_activation").status, "passed");
    assert.equal(rcAuthSmoke.body.steps.find((item) => item.stepId === "auth_post_rotation_smoke").status, "passed");
    const rcDeploymentSmoke = await request(server.baseUrl, `/api/admin/master-db/commercial-launch-rc-rehearsals/${encodeURIComponent(rcRehearsalId)}/actions/deployment_smoke`, {
      method: "POST", cookie: postRotationLogin.cookie, body: {}
    });
    assert.equal(rcDeploymentSmoke.status, 200);
    assert.ok(["passed", "warning", "failed"].includes(rcDeploymentSmoke.body.rehearsal.evidence.deploymentSmoke.status));
    assert.equal(rcDeploymentSmoke.body.policy.finalApproval, "manual_only");
    assert.equal(rcDeploymentSmoke.body.policy.automaticApproval, false);
    assert.doesNotMatch(JSON.stringify(rcDeploymentSmoke.body), /integration-csrf-secret|integration-default-mfa-key|integration-queue-secret|integration-webhook-secret/);

    const auditFile = await fs.readFile(path.join(dataDir, "db", "auth_audit_logs.json"), "utf8");
    assert.doesNotMatch(auditFile, /OperatorPassword!23|BusinessPassword!23|NewBusinessPassword!45/);
    assert.doesNotMatch(auditFile, new RegExp(reset.body.resetToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const invitationFile = await fs.readFile(path.join(dataDir, "db", "account_invitations.json"), "utf8");
    const deliveryFile = await fs.readFile(path.join(dataDir, "db", "auth_delivery_logs.json"), "utf8");
    const retryQueueFile = await fs.readFile(path.join(dataDir, "db", "auth_delivery_retry_queue.json"), "utf8").catch(() => "");
    const webhookEventsFile = await fs.readFile(path.join(dataDir, "db", "auth_delivery_webhook_events.json"), "utf8");
    const keyRotationHistoryFile = await fs.readFile(path.join(dataDir, "db", "auth_key_rotation_history.json"), "utf8");
    const rcRehearsalFile = await fs.readFile(path.join(dataDir, "db", "commercial_launch_rc_rehearsals.json"), "utf8");
    assert.match(keyRotationHistoryFile, /security_key_rotation_applied|auth_key_rotation_preflight_v1|auth_security_post_rotation_smoke_v1|integration-v2/);
    assert.doesNotMatch(keyRotationHistoryFile, /integration-csrf-secret|integration-default-mfa-key|integration-queue-secret|integration-webhook-secret/);
    assert.match(rcRehearsalFile, /commercial_launch_rc_rehearsals_v1|release-owner|rollback-owner/);
    assert.doesNotMatch(rcRehearsalFile, /integration-csrf-secret|integration-default-mfa-key|integration-queue-secret|integration-webhook-secret/);
    for (const secret of [inviteToken, oldReissueToken, newReissueToken, resendOldToken, resendNewToken]) {
      const secretPattern = new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      assert.doesNotMatch(invitationFile, secretPattern);
      assert.doesNotMatch(deliveryFile, secretPattern);
      assert.doesNotMatch(retryQueueFile, secretPattern);
      assert.doesNotMatch(webhookEventsFile, secretPattern);
      assert.doesNotMatch(auditFile, secretPattern);
      assert.doesNotMatch(keyRotationHistoryFile, secretPattern);
    }
    assert.doesNotMatch(`${deliveryFile}${retryQueueFile}${webhookEventsFile}`, /#invite=|#reset=/);
  } finally {
    await server.stop();
  }
}

async function testAdminMfaHttpFlow() {
  const dataDir = await seedDataDir();
  const encryptionKey = "integration-mfa-encryption-key-32-characters-minimum";
  const server = await startServer(dataDir, {
    AUTH_MFA_ENFORCE_ADMIN: "true",
    AUTH_MFA_ENCRYPTION_KEY: encryptionKey,
    AUTH_MFA_SESSION_TTL_MINUTES: "30",
    AUTH_MFA_ACCOUNT_MAX_ATTEMPTS: "3"
  });
  try {
    const passwordLogin = await login(server.baseUrl, "operator", "OperatorPassword!23");
    assert.equal(passwordLogin.status, 200);
    assert.equal(passwordLogin.body.mfa.enrollmentRequired, true);
    assert.equal("policy" in passwordLogin.body, false);

    const blockedBeforeEnrollment = await request(server.baseUrl, "/api/admin/auth/accounts", { cookie: passwordLogin.cookie });
    assert.equal(blockedBeforeEnrollment.status, 403);
    assert.equal(blockedBeforeEnrollment.body.code, "AUTH_MFA_ENROLLMENT_REQUIRED");

    const statusBefore = await request(server.baseUrl, "/api/admin/auth/mfa", { cookie: passwordLogin.cookie });
    assert.equal(statusBefore.status, 200);
    assert.equal(statusBefore.body.mfa.enforcementEnabled, true);
    const enrollment = await request(server.baseUrl, "/api/admin/auth/mfa/enroll", { method: "POST", cookie: passwordLogin.cookie, body: {} });
    assert.equal(enrollment.status, 201);
    assert.ok(enrollment.body.secret);
    assert.match(enrollment.body.otpauthUri, /^otpauth:\/\/totp\//);
    const confirmed = await request(server.baseUrl, "/api/admin/auth/mfa/confirm", {
      method: "POST", cookie: passwordLogin.cookie, body: { code: generateTotp(enrollment.body.secret) }
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.recoveryCodes.length, 10);
    assert.equal((await request(server.baseUrl, "/api/admin/auth/accounts", { cookie: passwordLogin.cookie })).status, 200);

    await request(server.baseUrl, "/api/auth/logout", { method: "POST", cookie: passwordLogin.cookie, body: {} });
    const challengedLogin = await login(server.baseUrl, "operator", "OperatorPassword!23");
    assert.equal(challengedLogin.body.mfa.challengeRequired, true);
    const blockedSensitive = await request(server.baseUrl, "/api/admin/auth/accounts", {
      method: "POST",
      cookie: challengedLogin.cookie,
      body: { username: "blocked-before-mfa@example.test", displayName: "Blocked", password: "BlockedPassword!23", role: "business", status: "active", companyIds: [OWNED_COMPANY_ID] }
    });
    assert.equal(blockedSensitive.status, 403);
    assert.equal(blockedSensitive.body.code, "AUTH_MFA_REQUIRED");
    const blockedLaunchApproval = await request(server.baseUrl, "/api/admin/master-db/commercial-launch-gate", {
      method: "POST",
      cookie: challengedLogin.cookie,
      body: { decision: "hold", releaseNote: "MFA must be confirmed first." }
    });
    assert.equal(blockedLaunchApproval.status, 403);
    assert.equal(blockedLaunchApproval.body.code, "AUTH_MFA_REQUIRED");
    assert.equal((await request(server.baseUrl, "/api/admin/auth/accounts", { cookie: challengedLogin.cookie })).status, 403);

    const challenge = await request(server.baseUrl, "/api/auth/mfa/challenge", {
      method: "POST", cookie: challengedLogin.cookie, body: { code: generateTotp(enrollment.body.secret) }
    });
    assert.equal(challenge.status, 200);
    assert.equal(challenge.body.mfa.verified, true);
    const accounts = await request(server.baseUrl, "/api/admin/auth/accounts", { cookie: challengedLogin.cookie });
    assert.equal(accounts.status, 200);
    assert.equal(accounts.body.items.find((item) => item.username === "operator").mfa.enabled, true);

    const security = await request(server.baseUrl, "/api/admin/auth/security?days=30&limit=200", { cookie: challengedLogin.cookie });
    assert.equal(security.status, 200);
    assert.ok(security.body.items.some((item) => item.eventType === "mfa_enabled"));
    assert.ok(security.body.items.some((item) => item.eventType === "mfa_step_up_denied"));

    const session = await request(server.baseUrl, "/api/auth/session", { cookie: challengedLogin.cookie });
    assert.equal(session.body.mfa.verified, true);
    assert.equal("secret" in session.body.mfa, false);
    assert.equal("recoveryCodes" in session.body.mfa, false);

    const accountFile = await fs.readFile(path.join(dataDir, "db", "user_accounts.json"), "utf8");
    assert.doesNotMatch(accountFile, new RegExp(enrollment.body.secret));
    confirmed.body.recoveryCodes.forEach((code) => assert.doesNotMatch(accountFile, new RegExp(code)));
    assert.match(accountFile, /aes-256-gcm|ciphertext/);
  } finally {
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function testTrustedProxyIpBoundary() {
  const untrustedData = await seedDataDir();
  const untrustedServer = await startServer(untrustedData, {
    AUTH_TRUST_PROXY: "none",
    AUTH_LOGIN_ACCOUNT_MAX_ATTEMPTS: "50",
    AUTH_LOGIN_IP_MAX_ATTEMPTS: "2"
  });
  try {
    const first = await request(untrustedServer.baseUrl, "/api/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.10" },
      body: { username: "proxy-a@example.test", password: "wrong-password" }
    });
    const second = await request(untrustedServer.baseUrl, "/api/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.11" },
      body: { username: "proxy-b@example.test", password: "wrong-password" }
    });
    assert.equal(first.status, 401);
    assert.equal(second.status, 429);
  } finally {
    await untrustedServer.stop();
    await fs.rm(untrustedData, { recursive: true, force: true });
  }

  const trustedData = await seedDataDir();
  const trustedServer = await startServer(trustedData, {
    AUTH_TRUST_PROXY: "render",
    AUTH_LOGIN_ACCOUNT_MAX_ATTEMPTS: "50",
    AUTH_LOGIN_IP_MAX_ATTEMPTS: "2"
  });
  try {
    const first = await request(trustedServer.baseUrl, "/api/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.10" },
      body: { username: "proxy-c@example.test", password: "wrong-password" }
    });
    const second = await request(trustedServer.baseUrl, "/api/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "203.0.113.11" },
      body: { username: "proxy-d@example.test", password: "wrong-password" }
    });
    assert.equal(first.status, 401);
    assert.equal(second.status, 401);
  } finally {
    await trustedServer.stop();
    await fs.rm(trustedData, { recursive: true, force: true });
  }
}

(async () => {
  const dataDir = await seedDataDir();
  try {
    await testSessionExpiration(dataDir);
    await testAdminMfaService(dataDir);
    await testVersionedAuthKeyRing(dataDir);
    await testSerializedKeyRotationApply(dataDir);
    await testDeliveryAdapters(dataDir);
    await testAccountAndTenantFlow(dataDir);
    await testAdminMfaHttpFlow();
    await testTrustedProxyIpBoundary();
    console.log("account, session, and tenant guardrail tests passed");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
