"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  ADMIN_ENTITLEMENTS,
  AUTH_SCHEMA_VERSION,
  PLAN_ENTITLEMENTS,
  entitlementsForPlan,
  entitlementsForRole
} = require("./integration/contracts/auth.cjs");
const {
  AUTH_STORE_KIND,
  createAuthRepository,
  resolveAuthStorePath
} = require("./integration/repositories/auth_store.cjs");
const { totp } = require("./integration/services/auth_crypto.cjs");
const {
  CHALLENGE_TTL_MS,
  LOGIN_FAILURE_LIMIT,
  createAuthService
} = require("./integration/services/auth_service.cjs");

const ADMIN_PASSWORD = "Stage226-Admin-Password!41";
const BUSINESS_PASSWORD = "Stage226-Business-Password!42";
const BUSINESS_PASSWORD_NEXT = "Stage226-Business-Password!43";
const INVITED_PASSWORD = "Stage226-Invited-Password!44";
const BOOTSTRAP_SECRET = "stage226-bootstrap-secret-with-more-than-32-characters";
const MFA_ENCRYPTION_KEY = "stage226-mfa-encryption-key-with-more-than-32-characters";
const SESSION_KEY_V1 = "stage226-session-hash-key-version-one-with-32-chars";
const SESSION_KEY_V2 = "stage226-session-hash-key-version-two-with-32-chars";
const ALLOWED_HOST = "auth.stage226.test";
const ALLOWED_ORIGIN = "https://auth.stage226.test";
const LOCK_MS = 60_000;
const INVITE_TTL_MS = 60_000;
const PUBLIC_SIGNUP_LIMIT = 8;
const PUBLIC_RESET_LIMIT = 10;

const ADMIN_CONTEXT = Object.freeze({
  host: ALLOWED_HOST,
  origin: ALLOWED_ORIGIN,
  ipHash: "test-ip-admin",
  userAgentHash: "test-ua-admin"
});
const BUSINESS_CONTEXT = Object.freeze({
  host: ALLOWED_HOST,
  origin: ALLOWED_ORIGIN,
  ipHash: "test-ip-business",
  userAgentHash: "test-ua-business"
});

function expectedEntitlements() {
  return {
    free: {
      plan: "free",
      dailySearchLimit: 2,
      searchUnlimited: false,
      searchWindowDays: 7,
      monthlyExportLimit: 0,
      concurrentExportLimit: 0,
      expandedSearchAllowed: false
    },
    basic: {
      plan: "basic",
      dailySearchLimit: 20,
      searchUnlimited: false,
      searchWindowDays: 14,
      monthlyExportLimit: 5,
      concurrentExportLimit: 1,
      expandedSearchAllowed: true
    },
    pro: {
      plan: "pro",
      dailySearchLimit: 100,
      searchUnlimited: false,
      searchWindowDays: 30,
      monthlyExportLimit: 30,
      concurrentExportLimit: 2,
      expandedSearchAllowed: true
    }
  };
}

async function rejectsStatus(operation, statusCode, label) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.statusCode, statusCode, `${label}: statusCode`);
    return true;
  }, label);
}

async function rejectsStatusAndCode(operation, statusCode, code, label) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.statusCode, statusCode, `${label}: statusCode`);
    assert.equal(error?.code, code, `${label}: code`);
    return true;
  }, label);
}

function assertThrowsStatus(operation, statusCode, label) {
  assert.throws(operation, (error) => {
    assert.equal(error?.statusCode, statusCode, `${label}: statusCode`);
    return true;
  }, label);
}

function assertEmptySchema(store) {
  assert.equal(store.storeKind, AUTH_STORE_KIND);
  assert.equal(store.schemaVersion, AUTH_SCHEMA_VERSION);
  assert.match(store.storeId, /^authstore_/);
  assert.equal(store.revision, 0);
  assert.deepEqual(store.security, {
    bootstrapCompletedAt: "",
    bootstrapAccountId: "",
    mfaResetPendingAccountId: "",
    mfaResetPendingAt: ""
  });
  for (const field of [
    "accounts",
    "companies",
    "memberships",
    "sessions",
    "invites",
    "passwordResets",
    "mfaFactors",
    "authChallenges",
    "loginGuards",
    "authAudit",
    "emailOutbox"
  ]) {
    assert.ok(Array.isArray(store[field]), `${field} must be an array`);
    assert.equal(store[field].length, 0, `${field} must start empty`);
  }
}

function assertNoPlainSecretKeys(value, prefix = "store") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPlainSecretKeys(item, `${prefix}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(
      /^(password|token|rawToken|csrfToken|inviteToken|resetToken|recoveryCode|recoveryCodes|totpSecret|secret)$/i.test(key),
      false,
      `${prefix}.${key} stores a plaintext secret field`
    );
    assertNoPlainSecretKeys(child, `${prefix}.${key}`);
  }
}

async function main() {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "stage226-auth-service-"));
  const storePath = path.join(tempRoot, "fresh-integration-auth-store.json");
  let now = Date.UTC(2026, 6, 29, 0, 0, 0);
  const clock = () => now;
  const advance = (milliseconds) => { now += milliseconds; };
  const rawSecrets = new Set([
    ADMIN_PASSWORD,
    BUSINESS_PASSWORD,
    BUSINESS_PASSWORD_NEXT,
    INVITED_PASSWORD,
    BOOTSTRAP_SECRET,
    MFA_ENCRYPTION_KEY,
    SESSION_KEY_V1,
    SESSION_KEY_V2
  ]);

  const commonEnv = {
    NODE_ENV: "test",
    V2_INTEGRATION_AUTH_STORE_PATH: storePath,
    V2_AUTH_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
    V2_AUTH_MFA_ENCRYPTION_KEY: MFA_ENCRYPTION_KEY,
    V2_AUTH_ALLOWED_HOSTS: ALLOWED_HOST,
    V2_AUTH_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    V2_AUTH_EMAIL_PROVIDER: "mock",
    V2_AUTH_MOCK_PREVIEW_ENABLED: "true",
    V2_AUTH_LOGIN_LOCK_MS: String(LOCK_MS),
    V2_AUTH_INVITE_TTL_MS: String(INVITE_TTL_MS),
    V2_AUTH_RESET_TTL_MS: "60000",
    V2_AUTH_SESSION_TTL_MS: String(12 * 60 * 60 * 1000)
  };
  const envV1 = {
    ...commonEnv,
    V2_AUTH_SESSION_KEY_VERSION: "v1",
    V2_AUTH_SESSION_HASH_KEY_CURRENT: SESSION_KEY_V1,
    V2_AUTH_SESSION_HASH_KEYS_PREVIOUS: ""
  };
  const envV2 = {
    ...commonEnv,
    V2_AUTH_SESSION_KEY_VERSION: "v2",
    V2_AUTH_SESSION_HASH_KEY_CURRENT: SESSION_KEY_V2,
    V2_AUTH_SESSION_HASH_KEYS_PREVIOUS: JSON.stringify({ v1: SESSION_KEY_V1 })
  };

  async function openService(env, targetStorePath = storePath) {
    const repository = createAuthRepository({ filePath: targetStorePath, clock });
    const service = createAuthService({ repository, env, clock });
    const initialized = await service.initialize();
    return { repository, service, initialized };
  }

  try {
    for (const basename of ["b2b_members.json", "b2b_session.json", "sessions.json", "members.json", "users.json"]) {
      assert.throws(
        () => resolveAuthStorePath(path.join(tempRoot, basename)),
        /Refusing legacy or ambiguous auth store path/,
        `${basename} must be rejected`
      );
    }
    for (const legacyPath of [
      path.join(tempRoot, "config", "b2b_fresh_auth.json"),
      path.join(tempRoot, "customer_db", "b2b_fresh_auth.json"),
      path.join(tempRoot, "test", "fixtures", "stage221", "fresh-auth.json")
    ]) {
      assert.throws(
        () => resolveAuthStorePath(legacyPath),
        /Refusing an existing V2\/Cluster auth data or contract-fixture path/,
        `${legacyPath} must be rejected`
      );
    }
    assert.equal(resolveAuthStorePath(storePath), path.resolve(storePath));

    const unreadyStorePath = path.join(tempRoot, "unready-integration-auth-store.json");
    const unreadyEnv = { ...envV2, V2_INTEGRATION_AUTH_STORE_PATH: unreadyStorePath };
    const unready = await openService(unreadyEnv, unreadyStorePath);
    const validUnreadySignup = {
      username: "before-bootstrap",
      email: "before-bootstrap@example.test",
      displayName: "Before Bootstrap",
      companyName: "Before Bootstrap Company",
      phone: "010-0000-0099",
      password: BUSINESS_PASSWORD,
      passwordConfirm: BUSINESS_PASSWORD,
      agreeTerms: true,
      agreePrivacy: true,
      confirmAge: true
    };
    for (const [label, operation] of [
      ["username check", () => unready.service.checkUsernameAvailability(validUnreadySignup.username, BUSINESS_CONTEXT)],
      ["signup", () => unready.service.signup(validUnreadySignup, BUSINESS_CONTEXT)],
      ["login", () => unready.service.authenticate(validUnreadySignup.username, BUSINESS_PASSWORD, BUSINESS_CONTEXT)],
      ["password reset", () => unready.service.requestPasswordReset(validUnreadySignup.email, BUSINESS_CONTEXT)],
      ["invite activation", () => unready.service.activateInvite({
        token: "pre-bootstrap-invite-token",
        password: INVITED_PASSWORD,
        passwordConfirm: INVITED_PASSWORD
      }, BUSINESS_CONTEXT)]
    ]) {
      await rejectsStatusAndCode(
        operation,
        503,
        "AUTH_BOOTSTRAP_REQUIRED",
        `${label} must fail closed before bootstrap is ready`
      );
    }
    assert.equal(unready.service.capabilities().enabled, true, "capabilities must remain available before bootstrap");
    assert.equal(unready.service.verifyAnonymousCsrfToken(unready.service.createAnonymousCsrfToken()), true);
    const unreadyBootstrap = await unready.service.bootstrapAdmin({
      bootstrapSecret: BOOTSTRAP_SECRET,
      username: "unready-admin",
      email: "unready-admin@example.test",
      displayName: "Unready Admin",
      password: ADMIN_PASSWORD
    }, ADMIN_CONTEXT);
    assert.equal(unreadyBootstrap.created, true);
    await rejectsStatus(
      () => unready.service.bootstrapAdmin({
        bootstrapSecret: BOOTSTRAP_SECRET,
        username: "conflicting-admin",
        email: "conflicting-admin@example.test",
        displayName: "Conflicting Admin",
        password: ADMIN_PASSWORD
      }, ADMIN_CONTEXT),
      409,
      "bootstrap must reject a different administrator identity"
    );
    assert.equal(unready.service.snapshotForTests().accounts.length, 1);
    assert.equal(unready.service.snapshotForTests().companies.length, 1);
    assert.equal(unready.service.snapshotForTests().memberships.length, 1);

    let active = await openService(envV1);
    assertEmptySchema(active.initialized);
    assert.deepEqual(
      Object.fromEntries(Object.keys(expectedEntitlements()).map((plan) => [plan, entitlementsForPlan(plan)])),
      expectedEntitlements()
    );
    assert.deepEqual(JSON.parse(JSON.stringify(PLAN_ENTITLEMENTS)), expectedEntitlements());
    assert.deepEqual(entitlementsForRole("admin", "free"), {
      ...expectedEntitlements().pro,
      dailySearchLimit: 0,
      searchUnlimited: true
    });
    assert.deepEqual(JSON.parse(JSON.stringify(ADMIN_ENTITLEMENTS)), entitlementsForRole("admin", "pro"));

    const bootstrapPayload = {
      bootstrapSecret: BOOTSTRAP_SECRET,
      username: "stage226-admin",
      email: "stage226-admin@example.test",
      displayName: "Stage 226 Admin",
      password: ADMIN_PASSWORD
    };
    const bootstrap = await active.service.bootstrapAdmin(bootstrapPayload, ADMIN_CONTEXT);
    assert.equal(bootstrap.created, true);
    assert.equal(bootstrap.mfaEnrollmentRequired, true);
    assert.ok(bootstrap.enrollmentToken);
    rawSecrets.add(bootstrap.enrollmentToken);

    const bootstrapAgain = await active.service.bootstrapAdmin(bootstrapPayload, ADMIN_CONTEXT);
    assert.equal(bootstrapAgain.created, false);
    assert.equal(bootstrapAgain.account.accountId, bootstrap.account.accountId);
    const bootstrappedStore = active.service.snapshotForTests();
    assert.equal(bootstrappedStore.accounts.length, 1, "bootstrap account must be idempotent");
    assert.equal(bootstrappedStore.companies.length, 1, "bootstrap company must be idempotent");
    assert.equal(bootstrappedStore.memberships.length, 1, "bootstrap membership must be idempotent");

    const enrollment = await active.service.beginMfaEnrollment(bootstrap.enrollmentToken, ADMIN_CONTEXT);
    rawSecrets.add(enrollment.secret);
    const enrollmentCode = totp(enrollment.secret, clock());
    const enrollmentConfirmation = await active.service.confirmMfaEnrollment(
      bootstrap.enrollmentToken,
      enrollmentCode,
      ADMIN_CONTEXT
    );
    assert.equal(enrollmentConfirmation.account.status, "active");
    assert.equal(enrollmentConfirmation.recoveryCodes.length, 8);
    enrollmentConfirmation.recoveryCodes.forEach((code) => rawSecrets.add(code));

    const bootstrapAfterMfa = await active.service.bootstrapAdmin(bootstrapPayload, ADMIN_CONTEXT);
    assert.equal(bootstrapAfterMfa.created, false);
    assert.equal(bootstrapAfterMfa.mfaEnrollmentRequired, false);
    assert.equal(active.service.snapshotForTests().accounts.length, 1);

    advance(31_000);
    const passwordLogin = await active.service.authenticate(
      bootstrapPayload.username,
      ADMIN_PASSWORD,
      ADMIN_CONTEXT
    );
    assert.equal(passwordLogin.mfaRequired, true);
    assert.ok(passwordLogin.challengeToken);
    rawSecrets.add(passwordLogin.challengeToken);
    const mfaLogin = await active.service.verifyMfaLogin(
      passwordLogin.challengeToken,
      totp(enrollment.secret, clock()),
      ADMIN_CONTEXT
    );
    assert.equal(mfaLogin.mfaVerified, true);
    const previousKeySession = await active.service.createSession(
      mfaLogin.account,
      ADMIN_CONTEXT,
      { mfaVerified: true }
    );
    rawSecrets.add(previousKeySession.token);
    rawSecrets.add(previousKeySession.csrfToken);
    assert.equal(previousKeySession.public.authenticated, true);
    assert.equal(previousKeySession.public.role, "admin");
    assert.equal(previousKeySession.public.entitlements.searchUnlimited, true);
    assert.equal(previousKeySession.public.entitlements.dailySearchLimit, 0);
    const v1StoredSession = active.service.snapshotForTests().sessions.find(
      (row) => row.sessionId === previousKeySession.session.sessionId
    );
    assert.equal(v1StoredSession.keyVersion, "v1");
    assert.notEqual(v1StoredSession.tokenHash, previousKeySession.token);
    assert.equal(JSON.stringify(active.service.snapshotForTests()).includes(previousKeySession.token), false);

    active = await openService(envV2);
    assert.ok(
      active.service.getSession(previousKeySession.token, ADMIN_CONTEXT),
      "a v1 session must validate after restart with v1 configured as a previous key"
    );
    const currentAdminSessionResult = await active.service.createSession(
      mfaLogin.account,
      ADMIN_CONTEXT,
      { mfaVerified: true }
    );
    const durableLogoutSessionResult = await active.service.createSession(
      mfaLogin.account,
      ADMIN_CONTEXT,
      { mfaVerified: true }
    );
    for (const result of [currentAdminSessionResult, durableLogoutSessionResult]) {
      rawSecrets.add(result.token);
      rawSecrets.add(result.csrfToken);
      assert.equal(result.session.keyVersion, "v2");
    }

    advance(31_000);
    let adminSession = active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT);
    await active.service.reauthenticate(adminSession, {
      password: ADMIN_PASSWORD,
      code: totp(enrollment.secret, clock())
    }, ADMIN_CONTEXT);
    adminSession = active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT);
    assert.ok(adminSession.reauthenticatedAt);
    const retirement = await active.service.retireSessionKeyVersion(adminSession, "v1", ADMIN_CONTEXT);
    assert.equal(retirement.keyVersion, "v1");
    assert.ok(retirement.revoked >= 1);
    assert.equal(active.service.getSession(previousKeySession.token, ADMIN_CONTEXT), null);
    assert.ok(active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT));

    active = await openService(envV2);
    assert.ok(active.service.getSession(durableLogoutSessionResult.token, ADMIN_CONTEXT));
    await active.service.logout(
      active.service.getSession(durableLogoutSessionResult.token, ADMIN_CONTEXT),
      ADMIN_CONTEXT
    );
    active = await openService(envV2);
    assert.equal(active.service.getSession(durableLogoutSessionResult.token, ADMIN_CONTEXT), null);
    assert.ok(active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT));
    adminSession = active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT);

    advance(31_000);
    const totpReplayLoginOne = await active.service.authenticate(
      bootstrapPayload.username,
      ADMIN_PASSWORD,
      ADMIN_CONTEXT
    );
    rawSecrets.add(totpReplayLoginOne.challengeToken);
    const sameStepCode = totp(enrollment.secret, clock());
    assert.equal((await active.service.verifyMfaLogin(
      totpReplayLoginOne.challengeToken,
      sameStepCode,
      ADMIN_CONTEXT
    )).mfaVerified, true);
    const totpReplayLoginTwo = await active.service.authenticate(
      bootstrapPayload.email,
      ADMIN_PASSWORD,
      ADMIN_CONTEXT
    );
    rawSecrets.add(totpReplayLoginTwo.challengeToken);
    await rejectsStatus(
      () => active.service.verifyMfaLogin(
        totpReplayLoginTwo.challengeToken,
        sameStepCode,
        ADMIN_CONTEXT
      ),
      401,
      "a TOTP code must not be accepted twice in the same time step"
    );

    advance(31_000);
    const persistentMfaContext = {
      ...ADMIN_CONTEXT,
      ipHash: "test-ip-persistent-mfa-lock",
      userAgentHash: "test-ua-persistent-mfa-lock"
    };
    const persistentMfaLogin = await active.service.authenticate(
      bootstrapPayload.username,
      ADMIN_PASSWORD,
      persistentMfaContext
    );
    rawSecrets.add(persistentMfaLogin.challengeToken);
    const currentMfaCode = totp(enrollment.secret, clock());
    const invalidMfaCode = currentMfaCode === "000000" ? "000001" : "000000";
    // The rejected same-step replay above is the first persistent account-level
    // MFA failure, so four additional failures must reach the five-attempt lock.
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT - 1; attempt += 1) {
      await rejectsStatus(
        () => active.service.verifyMfaLogin(
          persistentMfaLogin.challengeToken,
          invalidMfaCode,
          persistentMfaContext
        ),
        attempt === LOGIN_FAILURE_LIMIT - 2 ? 429 : 401,
        `persistent MFA failure ${attempt + 1}`
      );
    }
    active = await openService(envV2);
    await rejectsStatus(
      () => active.service.verifyMfaLogin(
        persistentMfaLogin.challengeToken,
        totp(enrollment.secret, clock()),
        persistentMfaContext
      ),
      429,
      "the MFA rate lock must survive a service restart"
    );
    advance(LOCK_MS + 1);
    assert.equal((await active.service.verifyMfaLogin(
      persistentMfaLogin.challengeToken,
      totp(enrollment.secret, clock()),
      persistentMfaContext
    )).mfaVerified, true);
    adminSession = active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT);

    const recoveryLogin = await active.service.authenticate(
      bootstrapPayload.email,
      ADMIN_PASSWORD,
      ADMIN_CONTEXT
    );
    rawSecrets.add(recoveryLogin.challengeToken);
    const recoveryVerified = await active.service.verifyMfaLogin(
      recoveryLogin.challengeToken,
      enrollmentConfirmation.recoveryCodes[0],
      ADMIN_CONTEXT
    );
    assert.equal(recoveryVerified.mfaVerified, true);
    const recoveryReplayLogin = await active.service.authenticate(
      bootstrapPayload.username,
      ADMIN_PASSWORD,
      ADMIN_CONTEXT
    );
    rawSecrets.add(recoveryReplayLogin.challengeToken);
    await rejectsStatus(
      () => active.service.verifyMfaLogin(
        recoveryReplayLogin.challengeToken,
        enrollmentConfirmation.recoveryCodes[0],
        ADMIN_CONTEXT
      ),
      401,
      "a recovery code must be single-use"
    );

    const businessOnePayload = {
      username: "stage226-owner-one",
      email: "owner-one@example.test",
      displayName: "Owner One",
      companyName: "Owner One Company",
      phone: "010-0000-0001",
      password: BUSINESS_PASSWORD,
      passwordConfirm: BUSINESS_PASSWORD,
      agreeTerms: true,
      agreePrivacy: true,
      confirmAge: true
    };
    const businessOne = await active.service.signup(businessOnePayload, BUSINESS_CONTEXT);
    assert.equal(businessOne.membership.plan, "free");
    const loginByUsername = await active.service.authenticate(
      businessOnePayload.username,
      BUSINESS_PASSWORD,
      BUSINESS_CONTEXT
    );
    assert.equal(loginByUsername.mfaRequired, false);
    const loginByEmail = await active.service.authenticate(
      businessOnePayload.email,
      BUSINESS_PASSWORD,
      BUSINESS_CONTEXT
    );
    assert.equal(loginByEmail.account.accountId, loginByUsername.account.accountId);
    const businessOneSessionResult = await active.service.createSession(
      loginByEmail.account,
      BUSINESS_CONTEXT
    );
    rawSecrets.add(businessOneSessionResult.token);
    rawSecrets.add(businessOneSessionResult.csrfToken);

    const businessTwoPayload = {
      username: "stage226-owner-two",
      email: "owner-two@example.test",
      displayName: "Owner Two",
      companyName: "Owner Two Company",
      phone: "010-0000-0002",
      password: BUSINESS_PASSWORD,
      passwordConfirm: BUSINESS_PASSWORD,
      agreeTerms: "true",
      agreePrivacy: "true",
      confirmAge: "true"
    };
    const businessTwo = await active.service.signup(businessTwoPayload, {
      ...BUSINESS_CONTEXT,
      ipHash: "test-ip-business-two"
    });

    advance(31_000);
    adminSession = active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT);
    await active.service.reauthenticate(adminSession, {
      password: ADMIN_PASSWORD,
      code: totp(enrollment.secret, clock())
    }, ADMIN_CONTEXT);
    adminSession = active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT);

    const usedInvite = await active.service.createInvite(adminSession, {
      email: "invite-used@example.test",
      username: "invite-used",
      companyName: "Invite Used Company",
      plan: "basic"
    }, ADMIN_CONTEXT);
    rawSecrets.add(usedInvite.previewToken);
    assert.equal(usedInvite.invite.plan, "basic");
    const activatedInvite = await active.service.activateInvite({
      token: usedInvite.previewToken,
      displayName: "Invited User",
      password: INVITED_PASSWORD,
      passwordConfirm: INVITED_PASSWORD
    }, BUSINESS_CONTEXT);
    assert.equal(activatedInvite.ok, true);
    assert.equal(activatedInvite.plan, "basic");
    await rejectsStatus(
      () => active.service.activateInvite({
        token: usedInvite.previewToken,
        password: INVITED_PASSWORD,
        passwordConfirm: INVITED_PASSWORD
      }, BUSINESS_CONTEXT),
      400,
      "an invite token must be single-use"
    );

    const expiringInvite = await active.service.createInvite(adminSession, {
      email: "invite-expired@example.test",
      username: "invite-expired",
      companyName: "Invite Expired Company",
      plan: "free"
    }, ADMIN_CONTEXT);
    rawSecrets.add(expiringInvite.previewToken);
    advance(INVITE_TTL_MS + 1);
    await rejectsStatus(
      () => active.service.activateInvite({
        token: expiringInvite.previewToken,
        password: INVITED_PASSWORD,
        passwordConfirm: INVITED_PASSWORD
      }, BUSINESS_CONTEXT),
      400,
      "an expired invite must be rejected"
    );

    const cancelledInvite = await active.service.createInvite(adminSession, {
      email: "invite-cancelled@example.test",
      username: "invite-cancelled",
      companyName: "Invite Cancelled Company",
      plan: "pro"
    }, ADMIN_CONTEXT);
    rawSecrets.add(cancelledInvite.previewToken);
    const cancellation = await active.service.cancelInvite(
      adminSession,
      cancelledInvite.invite.inviteId,
      ADMIN_CONTEXT
    );
    assert.equal(cancellation.status, "cancelled");
    await rejectsStatus(
      () => active.service.activateInvite({
        token: cancelledInvite.previewToken,
        password: INVITED_PASSWORD,
        passwordConfirm: INVITED_PASSWORD
      }, BUSINESS_CONTEXT),
      400,
      "a cancelled invite must be rejected"
    );
    const reissuedInvite = await active.service.reissueInvite(
      adminSession,
      cancelledInvite.invite.inviteId,
      ADMIN_CONTEXT
    );
    rawSecrets.add(reissuedInvite.previewToken);
    assert.notEqual(reissuedInvite.invite.inviteId, cancelledInvite.invite.inviteId);
    const reissueSnapshot = active.service.snapshotForTests();
    assert.equal(
      reissueSnapshot.invites.find((row) => row.inviteId === cancelledInvite.invite.inviteId).status,
      "superseded"
    );
    await rejectsStatus(
      () => active.service.activateInvite({
        token: cancelledInvite.previewToken,
        password: INVITED_PASSWORD,
        passwordConfirm: INVITED_PASSWORD
      }, BUSINESS_CONTEXT),
      400,
      "a superseded invite must be rejected"
    );
    assert.equal((await active.service.activateInvite({
      token: reissuedInvite.previewToken,
      displayName: "Reissued User",
      password: INVITED_PASSWORD,
      passwordConfirm: INVITED_PASSWORD
    }, BUSINESS_CONTEXT)).ok, true);

    const resetSessionBefore = active.service.getSession(
      businessOneSessionResult.token,
      BUSINESS_CONTEXT
    );
    assert.ok(resetSessionBefore);
    const knownReset = await active.service.requestPasswordReset(
      businessOnePayload.email,
      BUSINESS_CONTEXT
    );
    const unknownReset = await active.service.requestPasswordReset(
      "absent-account@example.test",
      { ...BUSINESS_CONTEXT, ipHash: "test-ip-unknown-reset" }
    );
    assert.deepEqual(
      { ok: knownReset.ok, message: knownReset.message },
      { ok: unknownReset.ok, message: unknownReset.message },
      "known and unknown reset requests must have the same public response"
    );
    assert.ok(knownReset.previewToken);
    assert.equal(unknownReset.previewToken, undefined);
    rawSecrets.add(knownReset.previewToken);
    assert.equal((await active.service.confirmPasswordReset({
      token: knownReset.previewToken,
      password: BUSINESS_PASSWORD_NEXT,
      passwordConfirm: BUSINESS_PASSWORD_NEXT
    }, BUSINESS_CONTEXT)).ok, true);
    assert.equal(active.service.getSession(businessOneSessionResult.token, BUSINESS_CONTEXT), null);
    await rejectsStatus(
      () => active.service.confirmPasswordReset({
        token: knownReset.previewToken,
        password: BUSINESS_PASSWORD_NEXT,
        passwordConfirm: BUSINESS_PASSWORD_NEXT
      }, BUSINESS_CONTEXT),
      400,
      "a reset token must be single-use"
    );
    await rejectsStatus(
      () => active.service.authenticate(
        businessOnePayload.username,
        BUSINESS_PASSWORD,
        { ...BUSINESS_CONTEXT, ipHash: "test-ip-old-password" }
      ),
      401,
      "the old password must be rejected after reset"
    );
    const loginAfterReset = await active.service.authenticate(
      businessOnePayload.email,
      BUSINESS_PASSWORD_NEXT,
      BUSINESS_CONTEXT
    );
    const businessSessionAfterReset = await active.service.createSession(
      loginAfterReset.account,
      BUSINESS_CONTEXT
    );
    rawSecrets.add(businessSessionAfterReset.token);
    rawSecrets.add(businessSessionAfterReset.csrfToken);

    const anonymousCsrf = active.service.createAnonymousCsrfToken();
    rawSecrets.add(anonymousCsrf);
    assert.equal(active.service.verifyAnonymousCsrfToken(anonymousCsrf), true);
    assert.doesNotThrow(() => active.service.assertRequestBoundary({
      host: ALLOWED_HOST,
      origin: `${ALLOWED_ORIGIN}/`,
      csrfToken: anonymousCsrf
    }, { requireAnonymousCsrf: true }));
    assertThrowsStatus(
      () => active.service.assertRequestBoundary({
        host: "attacker.stage226.test",
        origin: ALLOWED_ORIGIN,
        csrfToken: anonymousCsrf
      }, { requireAnonymousCsrf: true }),
      403,
      "an unapproved Host must fail closed"
    );
    assertThrowsStatus(
      () => active.service.assertRequestBoundary({
        host: ALLOWED_HOST,
        origin: "https://attacker.stage226.test",
        csrfToken: anonymousCsrf
      }, { requireAnonymousCsrf: true }),
      403,
      "an unapproved Origin must fail closed"
    );
    assertThrowsStatus(
      () => active.service.assertRequestBoundary({
        host: ALLOWED_HOST,
        origin: ALLOWED_ORIGIN,
        csrfToken: "invalid-csrf"
      }, { requireAnonymousCsrf: true }),
      403,
      "an invalid anonymous CSRF token must fail closed"
    );

    const businessSession = active.service.getSession(
      businessSessionAfterReset.token,
      BUSINESS_CONTEXT
    );
    assert.doesNotThrow(() => active.service.assertRequestBoundary({
      host: ALLOWED_HOST,
      origin: ALLOWED_ORIGIN,
      csrfToken: businessSessionAfterReset.csrfToken
    }, { requireCsrf: true, session: businessSession }));
    assertThrowsStatus(
      () => active.service.assertRequestBoundary({
        host: ALLOWED_HOST,
        origin: ALLOWED_ORIGIN,
        csrfToken: "wrong-session-csrf"
      }, { requireCsrf: true, session: businessSession }),
      403,
      "an invalid session CSRF token must fail closed"
    );
    assert.doesNotThrow(() => active.service.assertRequestBoundary(
      { host: ALLOWED_HOST, origin: "" },
      { mutation: false }
    ));

    const ownCompanyAccess = await active.service.assertCompanyAccess(
      businessSession,
      businessOne.company.companyId,
      BUSINESS_CONTEXT
    );
    assert.equal(ownCompanyAccess.company.companyId, businessOne.company.companyId);
    assert.deepEqual(ownCompanyAccess.entitlements, expectedEntitlements().free);
    await rejectsStatus(
      () => active.service.assertCompanyAccess(
        businessSession,
        businessTwo.company.companyId,
        BUSINESS_CONTEXT
      ),
      403,
      "a business account must not cross a company boundary"
    );
    const adminCompanyAccess = await active.service.assertCompanyAccess(
      active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT),
      businessTwo.company.companyId,
      ADMIN_CONTEXT
    );
    assert.equal(adminCompanyAccess.company.companyId, businessTwo.company.companyId);
    assert.deepEqual(adminCompanyAccess.entitlements, entitlementsForRole("admin", "pro"));

    const accountLockContext = {
      ...BUSINESS_CONTEXT,
      ipHash: "test-ip-account-lock-a",
      userAgentHash: "test-ua-account-lock"
    };
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      await rejectsStatus(
        () => active.service.authenticate(
          businessTwoPayload.username,
          "Definitely-Wrong-Password!99",
          accountLockContext
        ),
        attempt === LOGIN_FAILURE_LIMIT - 1 ? 429 : 401,
        `account brute-force failure ${attempt + 1}`
      );
    }
    assert.equal(active.service.snapshotForTests().loginGuards.length >= 1, true);
    active = await openService(envV2);
    const changedIpContext = {
      ...accountLockContext,
      ipHash: "test-ip-account-lock-b"
    };
    await rejectsStatus(
      () => active.service.authenticate(
        businessTwoPayload.email,
        BUSINESS_PASSWORD,
        changedIpContext
      ),
      429,
      "an account-only lock must survive restart and block an IP/identity-alias change"
    );

    advance(31_000);
    adminSession = active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT);
    await active.service.reauthenticate(adminSession, {
      password: ADMIN_PASSWORD,
      code: totp(enrollment.secret, clock())
    }, ADMIN_CONTEXT);
    adminSession = active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT);
    const adminUnlock = await active.service.unlockLoginGuards(
      adminSession,
      businessTwo.account.accountId,
      ADMIN_CONTEXT
    );
    assert.equal(adminUnlock.ok, true);
    assert.ok(adminUnlock.unlocked >= 1);
    const adminUnlockedLogin = await active.service.authenticate(
      businessTwoPayload.email,
      BUSINESS_PASSWORD,
      changedIpContext
    );
    assert.equal(adminUnlockedLogin.account.accountId, businessTwo.account.accountId);

    const ipOnlyContext = {
      ...BUSINESS_CONTEXT,
      ipHash: "test-ip-only-lock",
      userAgentHash: "test-ua-ip-only-lock"
    };
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMIT; attempt += 1) {
      await rejectsStatus(
        () => active.service.authenticate(
          `unknown-ip-guard-${attempt}`,
          "Definitely-Wrong-Password!98",
          ipOnlyContext
        ),
        attempt === LOGIN_FAILURE_LIMIT - 1 ? 429 : 401,
        `IP-only brute-force failure ${attempt + 1}`
      );
    }
    await rejectsStatus(
      () => active.service.authenticate(
        businessTwoPayload.username,
        BUSINESS_PASSWORD,
        ipOnlyContext
      ),
      429,
      "an IP-only lock must aggregate identity changes"
    );
    advance(LOCK_MS + 1);
    assert.equal((await active.service.authenticate(
      businessTwoPayload.username,
      BUSINESS_PASSWORD,
      ipOnlyContext
    )).account.accountId, businessTwo.account.accountId);

    const publicRateStorePath = path.join(tempRoot, "public-rate-integration-auth-store.json");
    const publicRateEnv = { ...envV2, V2_INTEGRATION_AUTH_STORE_PATH: publicRateStorePath };
    let publicRate = await openService(publicRateEnv, publicRateStorePath);
    const publicRateBootstrap = await publicRate.service.bootstrapAdmin({
      bootstrapSecret: BOOTSTRAP_SECRET,
      username: "public-rate-admin",
      email: "public-rate-admin@example.test",
      displayName: "Public Rate Admin",
      password: ADMIN_PASSWORD
    }, ADMIN_CONTEXT);
    const publicRateEnrollment = await publicRate.service.beginMfaEnrollment(
      publicRateBootstrap.enrollmentToken,
      ADMIN_CONTEXT
    );
    await publicRate.service.confirmMfaEnrollment(
      publicRateBootstrap.enrollmentToken,
      totp(publicRateEnrollment.secret, clock()),
      ADMIN_CONTEXT
    );
    const signupRateContext = {
      ...BUSINESS_CONTEXT,
      ipHash: "test-ip-persistent-signup-rate",
      userAgentHash: "test-ua-persistent-signup-rate"
    };
    const rateSignupPayload = (index) => ({
      username: `rate-signup-${index}`,
      email: `rate-signup-${index}@example.test`,
      displayName: `Rate Signup ${index}`,
      companyName: `Rate Signup Company ${index}`,
      phone: `010-9000-${String(index).padStart(4, "0")}`,
      password: BUSINESS_PASSWORD,
      passwordConfirm: BUSINESS_PASSWORD,
      agreeTerms: true,
      agreePrivacy: true,
      confirmAge: true
    });
    for (let index = 0; index < PUBLIC_SIGNUP_LIMIT; index += 1) {
      assert.equal((await publicRate.service.signup(
        rateSignupPayload(index),
        signupRateContext
      )).membership.plan, "free");
    }
    publicRate = await openService(publicRateEnv, publicRateStorePath);
    await rejectsStatus(
      () => publicRate.service.signup(
        rateSignupPayload(PUBLIC_SIGNUP_LIMIT),
        signupRateContext
      ),
      429,
      "the 8-per-60-minute signup limit must survive a service restart"
    );

    const resetRateContext = {
      ...BUSINESS_CONTEXT,
      ipHash: "test-ip-persistent-reset-rate",
      userAgentHash: "test-ua-persistent-reset-rate"
    };
    for (let index = 0; index < PUBLIC_RESET_LIMIT; index += 1) {
      const response = await publicRate.service.requestPasswordReset(
        `unknown-reset-rate-${index}@example.test`,
        resetRateContext
      );
      assert.equal(response.ok, true);
    }
    publicRate = await openService(publicRateEnv, publicRateStorePath);
    await rejectsStatus(
      () => publicRate.service.requestPasswordReset(
        "unknown-reset-rate-blocked@example.test",
        resetRateContext
      ),
      429,
      "the 10-per-60-minute reset limit must survive a service restart"
    );

    const resetAdminSession = active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT);
    assert.ok(resetAdminSession?.mfaVerifiedAt, "MFA reset requires the current verified administrator session");
    const resetBusinessSession = active.service.getSession(businessSessionAfterReset.token, BUSINESS_CONTEXT);
    assert.ok(resetBusinessSession, "the business control session must be active");
    await rejectsStatus(
      () => active.service.resetMfa(resetBusinessSession, {
        currentPassword: BUSINESS_PASSWORD_NEXT,
        confirmation: "RESET_MFA"
      }, BUSINESS_CONTEXT),
      403,
      "a business account must not reset administrator MFA"
    );
    await rejectsStatusAndCode(
      () => active.service.resetMfa(resetAdminSession, {
        currentPassword: ADMIN_PASSWORD,
        confirmation: "reset_mfa"
      }, ADMIN_CONTEXT),
      400,
      "MFA_RESET_CONFIRMATION_REQUIRED",
      "MFA reset requires the exact destructive-action confirmation"
    );
    await rejectsStatus(
      () => active.service.resetMfa(resetAdminSession, {
        currentPassword: "Wrong-Admin-Password!99",
        confirmation: "RESET_MFA"
      }, ADMIN_CONTEXT),
      401,
      "MFA reset must reject an incorrect current password"
    );
    assert.ok(
      active.service.snapshotForTests().authAudit.some((row) => row.event === "mfa.reset.failed" && row.outcome === "failure"),
      "an incorrect MFA reset password must leave a secret-free failure audit"
    );

    const preResetLogin = await active.service.authenticate(
      bootstrapPayload.username,
      ADMIN_PASSWORD,
      ADMIN_CONTEXT
    );
    rawSecrets.add(preResetLogin.challengeToken);
    const authVersionBeforeMfaReset = resetAdminSession.account.authVersion;
    const resetResult = await active.service.resetMfa(resetAdminSession, {
      currentPassword: ADMIN_PASSWORD,
      confirmation: "RESET_MFA"
    }, ADMIN_CONTEXT);
    assert.equal(resetResult.mfaEnrollmentRequired, true);
    assert.ok(resetResult.enrollmentToken);
    assert.ok(Date.parse(resetResult.expiresAt) > clock());
    rawSecrets.add(resetResult.enrollmentToken);

    const resetSnapshot = active.service.snapshotForTests();
    const resetAccount = resetSnapshot.accounts.find((row) => row.accountId === resetAdminSession.accountId);
    assert.equal(resetAccount.status, "mfa_pending");
    assert.equal(resetAccount.authVersion, authVersionBeforeMfaReset + 1);
    assert.equal(resetSnapshot.security.mfaResetPendingAccountId, resetAccount.accountId);
    assert.ok(resetSnapshot.security.mfaResetPendingAt);
    assert.ok(resetSnapshot.security.bootstrapCompletedAt, "MFA reset must keep the completed-bootstrap latch intact");
    assert.equal(
      resetSnapshot.mfaFactors.filter((row) => row.accountId === resetAccount.accountId && ["active", "pending"].includes(row.status)).length,
      0,
      "all prior active and pending MFA factors must be revoked"
    );
    assert.equal(
      resetSnapshot.sessions.filter((row) => row.accountId === resetAccount.accountId && !row.revokedAt).length,
      0,
      "MFA reset must revoke every administrator session"
    );
    assert.equal(
      resetSnapshot.authChallenges.filter((row) => row.accountId === resetAccount.accountId && !row.consumedAt && row.type !== "mfa-enrollment").length,
      0,
      "all prior MFA challenges must be consumed"
    );
    assert.equal(active.service.getSession(currentAdminSessionResult.token, ADMIN_CONTEXT), null);
    const resetEnrollmentChallengeCount = resetSnapshot.authChallenges.filter((row) => (
      row.accountId === resetAccount.accountId && row.type === "mfa-enrollment" && !row.consumedAt
    )).length;
    await rejectsStatusAndCode(
      () => active.service.bootstrapAdmin(bootstrapPayload, ADMIN_CONTEXT),
      409,
      "MFA_RESET_IN_PROGRESS",
      "the bootstrap secret must not mint an enrollment token during self-service MFA reset"
    );
    assert.equal(
      active.service.snapshotForTests().authChallenges.filter((row) => (
        row.accountId === resetAccount.accountId && row.type === "mfa-enrollment" && !row.consumedAt
      )).length,
      resetEnrollmentChallengeCount,
      "rejected bootstrap recovery must not mint an additional enrollment challenge"
    );
    const completedResetAudit = resetSnapshot.authAudit.findLast((row) => row.event === "mfa.reset.completed");
    assert.ok(completedResetAudit, "MFA reset must be audited");
    assert.equal(completedResetAudit.metadata.authVersionBefore, authVersionBeforeMfaReset);
    assert.equal(completedResetAudit.metadata.authVersionAfter, authVersionBeforeMfaReset + 1);
    assert.equal(completedResetAudit.metadata.activeSessionCountAfter, 0);
    assert.equal(/password|token|secret|recovery|code|hash/i.test(JSON.stringify(completedResetAudit.metadata)), false);
    await rejectsStatus(
      () => active.service.resetMfa(resetAdminSession, {
        currentPassword: ADMIN_PASSWORD,
        confirmation: "RESET_MFA"
      }, ADMIN_CONTEXT),
      401,
      "a revoked session must not issue a second enrollment token"
    );

    advance(CHALLENGE_TTL_MS + 1);
    const resumedResetLogin = await active.service.authenticate(
      bootstrapPayload.email,
      ADMIN_PASSWORD,
      ADMIN_CONTEXT
    );
    assert.equal(resumedResetLogin.mfaEnrollmentRequired, true, "the reset-pending bootstrap admin may resume with its current password");
    assert.ok(resumedResetLogin.enrollmentToken);
    assert.notEqual(resumedResetLogin.enrollmentToken, resetResult.enrollmentToken);
    rawSecrets.add(resumedResetLogin.enrollmentToken);
    await rejectsStatus(
      () => active.service.beginMfaEnrollment(resetResult.enrollmentToken, ADMIN_CONTEXT),
      400,
      "an expired reset enrollment token must stay invalid after password-authenticated resume"
    );
    const replacementEnrollment = await active.service.beginMfaEnrollment(resumedResetLogin.enrollmentToken, ADMIN_CONTEXT);
    rawSecrets.add(replacementEnrollment.secret);
    const replacementConfirmation = await active.service.confirmMfaEnrollment(
      resumedResetLogin.enrollmentToken,
      totp(replacementEnrollment.secret, clock()),
      ADMIN_CONTEXT
    );
    const completedReplacementSnapshot = active.service.snapshotForTests();
    assert.equal(completedReplacementSnapshot.security.mfaResetPendingAccountId, "");
    assert.equal(completedReplacementSnapshot.security.mfaResetPendingAt, "");
    replacementConfirmation.recoveryCodes.forEach((code) => rawSecrets.add(code));
    await rejectsStatus(
      () => active.service.verifyMfaLogin(
        preResetLogin.challengeToken,
        enrollmentConfirmation.recoveryCodes[1],
        ADMIN_CONTEXT
      ),
      401,
      "a pre-reset MFA login challenge must stay invalid after re-enrollment"
    );
    const postResetLogin = await active.service.authenticate(
      bootstrapPayload.username,
      ADMIN_PASSWORD,
      ADMIN_CONTEXT
    );
    rawSecrets.add(postResetLogin.challengeToken);
    await rejectsStatus(
      () => active.service.verifyMfaLogin(
        postResetLogin.challengeToken,
        enrollmentConfirmation.recoveryCodes[1],
        ADMIN_CONTEXT
      ),
      401,
      "a recovery code from the revoked factor must not verify the replacement factor"
    );
    const replacementMfa = await active.service.verifyMfaLogin(
      postResetLogin.challengeToken,
      replacementConfirmation.recoveryCodes[0],
      ADMIN_CONTEXT
    );
    assert.equal(replacementMfa.mfaVerified, true, "the replacement recovery code must complete login");

    const finalStore = active.service.snapshotForTests();
    assertNoPlainSecretKeys(finalStore);
    const serializedStore = await fsp.readFile(storePath, "utf8");
    for (const secret of rawSecrets) {
      if (!secret) continue;
      assert.equal(
        serializedStore.includes(secret),
        false,
        `fresh auth store leaked raw secret ${String(secret).slice(0, 8)}...`
      );
    }
    for (const session of finalStore.sessions) {
      assert.match(session.tokenHash, /^[A-Za-z0-9_-]{40,}$/);
      assert.match(session.csrfHash, /^[A-Za-z0-9_-]{40,}$/);
      assert.ok(["v1", "v2"].includes(session.keyVersion));
    }
    for (const invite of finalStore.invites) assert.match(invite.tokenHash, /^[A-Za-z0-9_-]{40,}$/);
    for (const reset of finalStore.passwordResets) assert.match(reset.tokenHash, /^[A-Za-z0-9_-]{40,}$/);
    for (const factor of finalStore.mfaFactors) {
      if (factor.status === "revoked") {
        assert.equal(factor.secretEnvelope, null, "a revoked MFA factor must not retain its encrypted TOTP secret");
        assert.deepEqual(factor.recoveryCodeHashes, [], "a revoked MFA factor must not retain recovery-code hashes");
      } else {
        assert.equal(typeof factor.secretEnvelope?.ciphertext, "string");
      }
      assert.equal(Array.isArray(factor.recoveryCodeHashes), true);
      factor.recoveryCodeHashes.forEach((row) => assert.match(row.hash, /^[A-Za-z0-9_-]{40,}$/));
    }

    console.log("Stage 226 direct auth service, durable security, tenant, entitlement, and secret-storage checks passed");
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
