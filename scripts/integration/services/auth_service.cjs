"use strict";

const crypto = require("node:crypto");
const {
  ACCOUNT_STATUSES,
  AUTH_ROLES,
  assertEmail,
  assertLoginId,
  assertPassword,
  cleanText,
  entitlementsForPlan,
  normalizeEmail,
  normalizeLoginId,
  normalizePlan,
  publicAccount,
  publicSession
} = require("../contracts/auth.cjs");
const {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  matchTotpStep,
  opaqueId,
  parseSessionKeyRing,
  randomToken,
  recoveryCodeHash,
  timingSafeTextEqual,
  tokenHash,
  tokenHashCandidates,
  verifyPassword
} = require("./auth_crypto.cjs");
const { createAuthEmailProvider } = require("./auth_email.cjs");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const REAUTH_TTL_MS = 5 * 60 * 1000;
const ANONYMOUS_CSRF_TTL_MS = 15 * 60 * 1000;
const AUTH_AUDIT_MAX_ROWS = 5000;
const EMAIL_OUTBOX_MAX_ROWS = 1000;
const AUTH_CHALLENGE_MAX_ROWS = 2000;
const LOGIN_GUARD_MAX_ROWS = 2000;
const PUBLIC_RATE_POLICIES = Object.freeze({
  bootstrap: Object.freeze({ limit: 10, windowMs: 15 * 60 * 1000 }),
  signup: Object.freeze({ limit: 8, windowMs: 60 * 60 * 1000 }),
  "signup-check": Object.freeze({ limit: 60, windowMs: 10 * 60 * 1000 }),
  "password-reset-request": Object.freeze({ limit: 10, windowMs: 60 * 60 * 1000 }),
  "password-reset-confirm": Object.freeze({ limit: 10, windowMs: 60 * 60 * 1000 }),
  "invite-activate": Object.freeze({ limit: 10, windowMs: 60 * 60 * 1000 })
});

function iso(clock) {
  return new Date(clock()).toISOString();
}

function timeMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("base64url");
}

function commaList(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function productionRuntime(env) {
  return env.NODE_ENV === "production" || Boolean(env.RENDER || env.RENDER_EXTERNAL_URL);
}

function validateConfiguration(env) {
  const production = productionRuntime(env);
  const bootstrapSecret = String(env.V2_AUTH_BOOTSTRAP_SECRET || "");
  if (bootstrapSecret.length < 32) throw new Error("V2_AUTH_BOOTSTRAP_SECRET must contain at least 32 characters");
  if (String(env.V2_AUTH_MFA_ENCRYPTION_KEY || "").length < 32) {
    throw new Error("V2_AUTH_MFA_ENCRYPTION_KEY must contain at least 32 characters");
  }
  const fingerprintSecret = String(env.V2_AUTH_FINGERPRINT_KEY || env.V2_AUTH_MFA_ENCRYPTION_KEY || "");
  if (fingerprintSecret.length < 32) {
    throw new Error("V2_AUTH_FINGERPRINT_KEY or V2_AUTH_MFA_ENCRYPTION_KEY must contain at least 32 characters");
  }
  const allowedHosts = commaList(env.V2_AUTH_ALLOWED_HOSTS);
  const allowedOrigins = commaList(env.V2_AUTH_ALLOWED_ORIGINS);
  if (production && (!allowedHosts.length || !allowedOrigins.length)) {
    throw new Error("V2_AUTH_ALLOWED_HOSTS and V2_AUTH_ALLOWED_ORIGINS are required in production");
  }
  return Object.freeze({
    production,
    bootstrapSecret,
    fingerprintSecret,
    allowedHosts: Object.freeze(allowedHosts),
    allowedOrigins: Object.freeze(allowedOrigins),
    issuer: cleanText(env.V2_AUTH_TOTP_ISSUER || "Glamping Datalab V2", 80),
    mockPreviewEnabled: env.NODE_ENV === "test" && /^(1|true|yes|on)$/i.test(String(env.V2_AUTH_MOCK_PREVIEW_ENABLED || "")),
    sessionTtlMs: Number(env.V2_AUTH_SESSION_TTL_MS || SESSION_TTL_MS),
    inviteTtlMs: Number(env.V2_AUTH_INVITE_TTL_MS || INVITE_TTL_MS),
    resetTtlMs: Number(env.V2_AUTH_RESET_TTL_MS || RESET_TTL_MS),
    loginLockMs: Number(env.V2_AUTH_LOGIN_LOCK_MS || LOGIN_LOCK_MS)
  });
}

function safeAuditMetadata(metadata = {}) {
  const result = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (/(password|token|secret|cookie|authorization|recovery|code|hash|header)/i.test(key)) continue;
    if (["string", "number", "boolean"].includes(typeof value) || value === null) {
      result[key] = typeof value === "string" ? value.slice(0, 240) : value;
    }
  }
  return result;
}

function createAuthService(options = {}) {
  const repository = options.repository;
  if (!repository) throw new Error("Auth repository is required");
  const env = options.env || process.env;
  const clock = options.clock || Date.now;
  const config = validateConfiguration(env);
  const keyRing = parseSessionKeyRing(env);
  const email = createAuthEmailProvider(env);
  const dummyPasswordHash = hashPassword(randomToken(24));

  function nowIso() {
    return iso(clock);
  }

  function audit(store, event, context = {}, metadata = {}) {
    store.authAudit.push({
      auditId: opaqueId("audit"),
      event,
      outcome: metadata.outcome || "success",
      accountId: context.accountId || metadata.accountId || "",
      companyId: context.companyId || metadata.companyId || "",
      actorAccountId: context.actorAccountId || context.accountId || "",
      ipHash: context.ipHash || "",
      userAgentHash: context.userAgentHash || "",
      occurredAt: nowIso(),
      metadata: safeAuditMetadata(metadata)
    });
    if (store.authAudit.length > AUTH_AUDIT_MAX_ROWS) {
      store.authAudit.splice(0, store.authAudit.length - AUTH_AUDIT_MAX_ROWS);
    }
  }

  function prune(store) {
    const now = clock();
    store.sessions = store.sessions.filter((row) => !row.revokedAt && timeMs(row.expiresAt) > now - 7 * 24 * 60 * 60 * 1000);
    store.authChallenges = store.authChallenges.filter((row) => !row.consumedAt && timeMs(row.expiresAt) > now - 24 * 60 * 60 * 1000);
    store.passwordResets = store.passwordResets.filter((row) => timeMs(row.expiresAt) > now - 7 * 24 * 60 * 60 * 1000);
    store.loginGuards = store.loginGuards.filter((row) => Math.max(timeMs(row.lockedUntil), timeMs(row.lastFailedAt)) > now - 7 * 24 * 60 * 60 * 1000);
    store.authChallenges = store.authChallenges.slice(-AUTH_CHALLENGE_MAX_ROWS);
    store.loginGuards = store.loginGuards.slice(-LOGIN_GUARD_MAX_ROWS);
    store.authAudit = store.authAudit.slice(-AUTH_AUDIT_MAX_ROWS);
    store.emailOutbox = store.emailOutbox.slice(-EMAIL_OUTBOX_MAX_ROWS);
  }

  function membershipRows(store, accountId) {
    return store.memberships
      .filter((row) => row.accountId === accountId && row.status === "active")
      .map((row) => ({
        ...row,
        companyName: store.companies.find((company) => company.companyId === row.companyId)?.name || ""
      }));
  }

  function accountByIdentity(store, identity) {
    const normalized = normalizeLoginId(identity);
    return store.accounts.find((row) => row.username === normalized || row.email === normalizeEmail(identity));
  }

  function sessionRecordFromToken(store, rawToken) {
    if (!rawToken) return null;
    const candidates = tokenHashCandidates(rawToken, keyRing);
    return store.sessions.find((row) => candidates.some((candidate) => (
      candidate.version === row.keyVersion && timingSafeTextEqual(candidate.hash, row.tokenHash)
    ))) || null;
  }

  function challengeFromToken(store, rawToken, type) {
    const candidates = tokenHashCandidates(rawToken, keyRing);
    return store.authChallenges.find((row) => (
      row.type === type
      && !row.consumedAt
      && timeMs(row.expiresAt) > clock()
      && candidates.some((candidate) => candidate.version === row.keyVersion && timingSafeTextEqual(candidate.hash, row.tokenHash))
    )) || null;
  }

  function storedTokenMatches(row, rawToken) {
    return tokenHashCandidates(rawToken, keyRing).some((candidate) => (
      candidate.version === row.keyVersion && timingSafeTextEqual(candidate.hash, row.tokenHash)
    ));
  }

  function appendChallenge(store, accountId, type, ttlMs = CHALLENGE_TTL_MS, suppliedToken = "") {
    const rawToken = suppliedToken || randomToken(32);
    const createdAt = nowIso();
    const expiresAt = iso(() => clock() + ttlMs);
    const account = store.accounts.find((row) => row.accountId === accountId);
    store.authChallenges.push({
      challengeId: opaqueId("challenge"),
      accountId,
      authVersion: Math.max(1, Number(account?.authVersion) || 1),
      type,
      tokenHash: tokenHash(rawToken, keyRing),
      keyVersion: keyRing.currentVersion,
      createdAt,
      expiresAt,
      consumedAt: ""
    });
    return { rawToken, expiresAt };
  }

  function bootstrapEnrollmentToken(accountId) {
    return crypto.createHmac("sha256", config.bootstrapSecret).update(`stage226:mfa:${accountId}`).digest("base64url");
  }

  async function initialize() {
    return repository.initialize();
  }

  function bootstrapReady(store = repository.currentUnsafe()) {
    const accountId = store.security?.bootstrapAccountId || "";
    const account = store.accounts.find((row) => (
      row.accountId === accountId
      && row.role === AUTH_ROLES.admin
      && row.status === ACCOUNT_STATUSES.active
    ));
    const factor = account && store.mfaFactors.find((row) => row.accountId === account.accountId && row.status === "active");
    return Boolean(account && factor && store.security?.bootstrapCompletedAt);
  }

  function assertBootstrapReady() {
    if (bootstrapReady()) return true;
    const error = new Error("최초 관리자와 MFA bootstrap을 먼저 완료하세요.");
    error.statusCode = 503;
    error.code = "AUTH_BOOTSTRAP_REQUIRED";
    throw error;
  }

  function hashRequestFingerprint(kind, value) {
    return crypto.createHmac("sha256", config.fingerprintSecret)
      .update(`${String(kind || "request")}:${String(value || "")}`)
      .digest("base64url");
  }

  function capabilities() {
    const ready = bootstrapReady();
    return {
      enabled: true,
      accountStore: "stage226-fresh-only",
      emailProvider: email.mode,
      usernameOrEmail: true,
      bootstrapRequired: !ready,
      signup: ready,
      invitationActivation: ready,
      passwordReset: ready,
      adminMfaRequired: true,
      plans: Object.fromEntries(["free", "basic", "pro"].map((plan) => [plan, entitlementsForPlan(plan)]))
    };
  }

  function createAnonymousCsrfToken() {
    const timestamp = String(clock());
    const nonce = randomToken(16);
    const payload = `${timestamp}.${nonce}`;
    const signature = tokenHash(`anonymous-csrf:${payload}`, keyRing);
    return `${payload}.${keyRing.currentVersion}.${signature}`;
  }

  function verifyAnonymousCsrfToken(value) {
    const [timestamp, nonce, version, signature] = String(value || "").split(".");
    if (!timestamp || !nonce || !version || !signature) return false;
    const issuedAt = Number(timestamp);
    if (!Number.isFinite(issuedAt) || issuedAt > clock() + 30000 || clock() - issuedAt > ANONYMOUS_CSRF_TTL_MS) return false;
    const expected = tokenHash(`anonymous-csrf:${timestamp}.${nonce}`, keyRing, version);
    return Boolean(expected) && timingSafeTextEqual(expected, signature);
  }

  function assertRequestBoundary(context = {}, options = {}) {
    const host = String(context.host || "").toLowerCase();
    const origin = String(context.origin || "").replace(/\/$/, "").toLowerCase();
    const allowedHosts = config.allowedHosts.map((value) => value.toLowerCase());
    const allowedOrigins = config.allowedOrigins.map((value) => value.replace(/\/$/, "").toLowerCase());
    if (allowedHosts.length && !allowedHosts.includes(host)) {
      const error = new Error("허용되지 않은 Host입니다.");
      error.statusCode = 403;
      throw error;
    }
    if (options.mutation !== false) {
      if (!origin || (allowedOrigins.length && !allowedOrigins.includes(origin))) {
        const error = new Error("허용되지 않은 Origin입니다.");
        error.statusCode = 403;
        throw error;
      }
    }
    if (options.requireCsrf) {
      const session = options.session;
      const supplied = String(context.csrfToken || "");
      const expected = session ? tokenHash(supplied, keyRing, session.csrfKeyVersion) : "";
      if (!session || !supplied || !expected || !timingSafeTextEqual(expected, session.csrfHash)) {
        const error = new Error("CSRF token이 올바르지 않습니다.");
        error.statusCode = 403;
        throw error;
      }
    }
    if (options.requireAnonymousCsrf && !verifyAnonymousCsrfToken(context.csrfToken)) {
      const error = new Error("CSRF token이 올바르지 않습니다.");
      error.statusCode = 403;
      throw error;
    }
    return true;
  }

  function rateLimitError(row, message) {
    const error = new Error(message || "요청이 너무 많습니다. 잠시 후 다시 시도하세요.");
    error.statusCode = 429;
    error.code = "AUTH_RATE_LIMITED";
    error.retryAfterSeconds = Math.max(1, Math.ceil((timeMs(row.lockedUntil) - clock()) / 1000));
    return error;
  }

  async function consumePublicRateLimit(scope, context = {}, principal = "") {
    const policy = PUBLIC_RATE_POLICIES[scope];
    if (!policy) throw new Error(`Unknown auth rate-limit scope: ${scope}`);
    const descriptors = [
      {
        guardKey: sha256(`public-rate|${scope}|ip|${context.ipHash || "unknown"}`),
        scope: `public-rate:${scope}:ip`,
        accountId: "",
        ipHash: context.ipHash || ""
      },
      ...(principal ? [{
        guardKey: sha256(`public-rate|${scope}|principal|${principal}`),
        scope: `public-rate:${scope}:principal`,
        accountId: "",
        ipHash: ""
      }] : [])
    ];
    const existing = descriptors
      .map((descriptor) => repository.currentUnsafe().loginGuards.find((row) => row.guardKey === descriptor.guardKey))
      .filter((row) => row && timeMs(row.lockedUntil) > clock())
      .sort((left, right) => timeMs(right.lockedUntil) - timeMs(left.lockedUntil))[0];
    if (existing) throw rateLimitError(existing);
    const result = await repository.transaction(`public-rate-${scope}`, (store) => {
      prune(store);
      const now = clock();
      const rows = [];
      for (const descriptor of descriptors) {
        let row = store.loginGuards.find((item) => item.guardKey === descriptor.guardKey);
        if (!row || now - timeMs(row.windowStartedAt) >= policy.windowMs) {
          row = { ...descriptor, count: 0, windowStartedAt: nowIso(), lastFailedAt: "", lockedUntil: "" };
          store.loginGuards = store.loginGuards.filter((item) => item.guardKey !== descriptor.guardKey);
          store.loginGuards.push(row);
        }
        rows.push(row);
      }
      const exhausted = rows.find((row) => row.count >= policy.limit);
      if (exhausted) {
        for (const row of rows) {
          row.lockedUntil = iso(() => Math.max(clock() + 1000, timeMs(row.windowStartedAt) + policy.windowMs));
          row.lastFailedAt = nowIso();
        }
        audit(store, `rate.${scope}.blocked`, context, { outcome: "failure", limit: policy.limit });
        return { allowed: false, row: { ...exhausted, lockedUntil: rows[0].lockedUntil } };
      }
      for (const row of rows) {
        row.count += 1;
        row.lastFailedAt = nowIso();
      }
      return { allowed: true, row: { ...rows[0] } };
    });
    if (!result.allowed) throw rateLimitError(result.row);
    return true;
  }

  async function bootstrapAdmin(payload = {}, context = {}) {
    await consumePublicRateLimit("bootstrap", context, normalizeLoginId(payload.username));
    if (!timingSafeTextEqual(payload.bootstrapSecret, config.bootstrapSecret)) {
      const error = new Error("Bootstrap authorization failed");
      error.statusCode = 403;
      throw error;
    }
    const username = assertLoginId(payload.username);
    const emailAddress = assertEmail(payload.email);
    const password = assertPassword(payload.password);
    const displayName = cleanText(payload.displayName || "최초 관리자", 120);
    return repository.transaction("bootstrap-admin", (store) => {
      prune(store);
      const admins = store.accounts.filter((row) => row.role === AUTH_ROLES.admin);
      if (admins.length) {
        const account = admins[0];
        if (account.username !== username || account.email !== emailAddress) {
          const error = new Error("Bootstrap administrator already exists");
          error.statusCode = 409;
          throw error;
        }
        const result = { created: false, account: publicAccount(account), mfaEnrollmentRequired: account.status === ACCOUNT_STATUSES.mfaPending };
        if (result.mfaEnrollmentRequired) {
          result.enrollmentToken = bootstrapEnrollmentToken(account.accountId);
          if (!challengeFromToken(store, result.enrollmentToken, "mfa-enrollment")) {
            appendChallenge(store, account.accountId, "mfa-enrollment", 24 * 60 * 60 * 1000, result.enrollmentToken);
          }
        }
        return result;
      }
      if (store.accounts.some((row) => row.username === username || row.email === emailAddress)) {
        const error = new Error("Bootstrap administrator identity conflicts with an existing account");
        error.statusCode = 409;
        throw error;
      }
      if (store.companies.some((row) => row.companyId === "v2-platform")) {
        const error = new Error("Bootstrap platform company already exists without an administrator");
        error.statusCode = 409;
        throw error;
      }
      const now = nowIso();
      const company = {
        companyId: "v2-platform",
        name: "숙박업 데이터랩 V2",
        kind: "platform",
        createdAt: now,
        updatedAt: now
      };
      const account = {
        accountId: opaqueId("acct"),
        username,
        email: emailAddress,
        displayName,
        passwordHash: hashPassword(password),
        role: AUTH_ROLES.admin,
        status: ACCOUNT_STATUSES.mfaPending,
        authVersion: 1,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: "",
        passwordChangedAt: now
      };
      const membership = {
        membershipId: opaqueId("member"),
        accountId: account.accountId,
        companyId: company.companyId,
        role: "owner",
        plan: "pro",
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      store.companies.push(company);
      store.accounts.push(account);
      store.memberships.push(membership);
      store.security.bootstrapCompletedAt = "";
      store.security.bootstrapAccountId = account.accountId;
      const enrollmentToken = bootstrapEnrollmentToken(account.accountId);
      appendChallenge(store, account.accountId, "mfa-enrollment", 24 * 60 * 60 * 1000, enrollmentToken);
      audit(store, "admin.bootstrap.created", context, { accountId: account.accountId });
      return {
        created: true,
        account: publicAccount(account),
        mfaEnrollmentRequired: true,
        enrollmentToken
      };
    });
  }

  async function checkUsernameAvailability(value, context = {}) {
    assertBootstrapReady();
    await consumePublicRateLimit("signup-check", context, normalizeLoginId(value));
    const username = assertLoginId(value);
    const store = repository.currentUnsafe();
    const exists = store.accounts.some((row) => row.username === username);
    return {
      username,
      available: !exists,
      checked: true,
      message: exists ? "이미 가입된 아이디입니다." : "사용 가능한 아이디입니다."
    };
  }

  async function signup(payload = {}, context = {}) {
    assertBootstrapReady();
    await consumePublicRateLimit("signup", context, `${normalizeLoginId(payload.username || payload.loginId)}|${normalizeEmail(payload.email)}`);
    const username = assertLoginId(payload.username || payload.loginId);
    const emailAddress = assertEmail(payload.email);
    const password = assertPassword(payload.password);
    if (password !== String(payload.passwordConfirm || payload.confirmPassword || "")) {
      const error = new Error("비밀번호 확인이 일치하지 않습니다.");
      error.statusCode = 400;
      throw error;
    }
    if (!/^(1|true|on|yes|agree|accepted)$/i.test(String(payload.agreeTerms || ""))) {
      const error = new Error("이용약관 동의가 필요합니다."); error.statusCode = 400; throw error;
    }
    if (!/^(1|true|on|yes|agree|accepted)$/i.test(String(payload.agreePrivacy || ""))) {
      const error = new Error("개인정보 수집 및 이용 동의가 필요합니다."); error.statusCode = 400; throw error;
    }
    if (!/^(1|true|on|yes|agree|accepted)$/i.test(String(payload.confirmAge || ""))) {
      const error = new Error("만 14세 이상 확인이 필요합니다."); error.statusCode = 400; throw error;
    }
    const phone = cleanText(payload.phone, 40);
    if (!phone) { const error = new Error("연락처를 입력하세요."); error.statusCode = 400; throw error; }
    const companyName = cleanText(payload.companyName || "신규 사업자", 120);
    return repository.transaction("public-signup", (store) => {
      prune(store);
      if (store.accounts.some((row) => row.username === username || row.email === emailAddress)) {
        const error = new Error("이미 가입된 아이디 또는 이메일입니다."); error.statusCode = 409; throw error;
      }
      const now = nowIso();
      const company = {
        companyId: opaqueId("company"),
        name: companyName,
        kind: "business",
        createdAt: now,
        updatedAt: now
      };
      const account = {
        accountId: opaqueId("acct"),
        username,
        email: emailAddress,
        displayName: cleanText(payload.displayName || username, 120),
        phone,
        passwordHash: hashPassword(password),
        role: AUTH_ROLES.business,
        status: ACCOUNT_STATUSES.active,
        authVersion: 1,
        ownershipStatus: cleanText(payload.ownershipStatus || payload.hasGlamping || "none", 40),
        createdAt: now,
        updatedAt: now,
        lastLoginAt: "",
        passwordChangedAt: now,
        consents: {
          termsAccepted: true,
          privacyAccepted: true,
          marketingAccepted: /^(1|true|on|yes|agree|accepted)$/i.test(String(payload.agreeMarketing || "")),
          ageConfirmed: true,
          acceptedAt: now
        }
      };
      const membership = {
        membershipId: opaqueId("member"),
        accountId: account.accountId,
        companyId: company.companyId,
        role: "owner",
        plan: "free",
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      store.companies.push(company);
      store.accounts.push(account);
      store.memberships.push(membership);
      audit(store, "account.signup.created", context, { accountId: account.accountId, companyId: company.companyId });
      return { account: publicAccount(account), company, membership };
    });
  }

  function securityGuardKey(scope, principal) {
    return sha256(`${scope}|${principal || "unknown"}`);
  }

  function securityGuardDescriptors(scope, accountId, identity, context = {}) {
    const principal = accountId ? `account:${accountId}` : `identity:${normalizeLoginId(identity) || "unknown"}`;
    return [
      {
        guardKey: securityGuardKey(`${scope}:account`, principal),
        scope: `${scope}:account`,
        accountId: accountId || "",
        ipHash: ""
      },
      {
        guardKey: securityGuardKey(`${scope}:ip`, context.ipHash || "unknown"),
        scope: `${scope}:ip`,
        accountId: "",
        ipHash: context.ipHash || "",
        relatedAccountIds: accountId ? [accountId] : []
      }
    ];
  }

  function assertSecurityGuardsAvailable(descriptors, message, store = repository.currentUnsafe()) {
    const locked = descriptors
      .map((descriptor) => store.loginGuards.find((item) => item.guardKey === descriptor.guardKey))
      .filter((row) => row && timeMs(row.lockedUntil) > clock())
      .sort((left, right) => timeMs(right.lockedUntil) - timeMs(left.lockedUntil))[0];
    if (locked) throw rateLimitError(locked, message);
  }

  async function recordSecurityFailures(descriptors, context, event, metadata = {}) {
    return repository.transaction(`${descriptors[0]?.scope || "auth"}-failure`, (store) => {
      prune(store);
      const now = clock();
      const failures = [];
      for (const descriptor of descriptors) {
        let row = store.loginGuards.find((item) => item.guardKey === descriptor.guardKey);
        if (!row || now - timeMs(row.windowStartedAt) >= LOGIN_FAILURE_WINDOW_MS) {
          row = {
            ...descriptor,
            count: 0,
            windowStartedAt: nowIso(),
            lastFailedAt: "",
            lockedUntil: ""
          };
          store.loginGuards = store.loginGuards.filter((item) => item.guardKey !== descriptor.guardKey);
          store.loginGuards.push(row);
        }
        if (Array.isArray(descriptor.relatedAccountIds)) {
          row.relatedAccountIds = [...new Set([
            ...(Array.isArray(row.relatedAccountIds) ? row.relatedAccountIds : []),
            ...descriptor.relatedAccountIds
          ])].slice(-20);
        }
        row.count += 1;
        row.lastFailedAt = nowIso();
        if (row.count >= LOGIN_FAILURE_LIMIT) row.lockedUntil = iso(() => clock() + config.loginLockMs);
        failures.push({ count: row.count, lockedUntil: row.lockedUntil });
      }
      const accountId = descriptors.find((item) => item.accountId)?.accountId || "";
      audit(store, event, { ...context, accountId }, {
        ...metadata,
        accountId,
        outcome: "failure",
        locked: failures.some((row) => timeMs(row.lockedUntil) > clock())
      });
      return failures.sort((left, right) => timeMs(right.lockedUntil) - timeMs(left.lockedUntil))[0];
    });
  }

  function securityFailureError(failure, invalidMessage, lockedMessage) {
    const locked = timeMs(failure.lockedUntil) > clock();
    const error = new Error(locked ? lockedMessage : invalidMessage);
    error.statusCode = locked ? 429 : 401;
    if (locked) error.retryAfterSeconds = Math.max(1, Math.ceil((timeMs(failure.lockedUntil) - clock()) / 1000));
    return error;
  }

  async function authenticate(identity, password, context = {}) {
    assertBootstrapReady();
    const snapshot = repository.currentUnsafe();
    const account = accountByIdentity(snapshot, identity);
    const descriptors = securityGuardDescriptors("login", account?.accountId || "", identity, context);
    assertSecurityGuardsAvailable(descriptors, "로그인 시도가 많습니다. 잠시 후 다시 시도하세요.", snapshot);
    const verified = verifyPassword(String(password || ""), account?.passwordHash || dummyPasswordHash);
    if (!account || !verified || account.status === ACCOUNT_STATUSES.disabled) {
      const failure = await recordSecurityFailures(descriptors, context, "login.failed", {
        identityFingerprint: sha256(normalizeLoginId(identity)).slice(0, 16)
      });
      throw securityFailureError(failure, "아이디 또는 비밀번호가 올바르지 않습니다.", "로그인 시도가 많습니다. 잠시 후 다시 시도하세요.");
    }
    const result = await repository.transaction("login-success", (store) => {
      prune(store);
      const current = store.accounts.find((row) => row.accountId === account.accountId);
      const currentDescriptors = securityGuardDescriptors("login", current?.accountId || "", identity, context);
      assertSecurityGuardsAvailable(currentDescriptors, "로그인 시도가 많습니다. 잠시 후 다시 시도하세요.", store);
      if (!current || current.status === ACCOUNT_STATUSES.disabled || !verifyPassword(String(password || ""), current.passwordHash)) {
        return { rejected: true };
      }
      const clearKeys = new Set(currentDescriptors.map((item) => item.guardKey));
      store.loginGuards = store.loginGuards.filter((row) => !clearKeys.has(row.guardKey));
      current.lastLoginAt = nowIso();
      current.updatedAt = nowIso();
      const factor = store.mfaFactors.find((row) => row.accountId === current.accountId && row.status === "active");
      audit(store, "login.password.verified", { ...context, accountId: current.accountId }, { accountId: current.accountId });
      if (current.role === AUTH_ROLES.admin && !factor) {
        current.status = ACCOUNT_STATUSES.mfaPending;
        const challenge = appendChallenge(store, current.accountId, "mfa-enrollment", CHALLENGE_TTL_MS);
        return {
          account: publicAccount(current),
          mfaEnrollmentRequired: true,
          enrollmentToken: challenge.rawToken,
          expiresAt: challenge.expiresAt
        };
      }
      if (current.role === AUTH_ROLES.admin) {
        for (const row of store.authChallenges.filter((item) => item.accountId === current.accountId && item.type === "mfa-login" && !item.consumedAt)) {
          row.consumedAt = nowIso();
          row.consumeReason = "superseded-by-new-login";
        }
        const challenge = appendChallenge(store, current.accountId, "mfa-login", CHALLENGE_TTL_MS);
        return {
          account: publicAccount(current),
          mfaRequired: true,
          challengeToken: challenge.rawToken,
          expiresAt: challenge.expiresAt
        };
      }
      return { account: publicAccount(current), mfaRequired: false };
    });
    if (result.rejected) {
      const error = new Error("아이디 또는 비밀번호가 올바르지 않습니다.");
      error.statusCode = 401;
      throw error;
    }
    return result;
  }

  async function beginMfaEnrollment(enrollmentToken, context = {}) {
    return repository.transaction("mfa-enrollment-begin", (store) => {
      prune(store);
      const challenge = challengeFromToken(store, enrollmentToken, "mfa-enrollment");
      if (!challenge) { const error = new Error("MFA 등록 요청이 만료되었거나 올바르지 않습니다."); error.statusCode = 400; throw error; }
      const account = store.accounts.find((row) => row.accountId === challenge.accountId);
      if (!account || account.role !== AUTH_ROLES.admin) { const error = new Error("관리자 MFA 등록만 허용됩니다."); error.statusCode = 403; throw error; }
      if (challenge.authVersion !== Math.max(1, Number(account.authVersion) || 1)) {
        const error = new Error("MFA 등록 요청이 더 이상 유효하지 않습니다."); error.statusCode = 401; throw error;
      }
      if (store.mfaFactors.some((row) => row.accountId === account.accountId && row.status === "active")) {
        const error = new Error("이미 활성화된 MFA가 있습니다."); error.statusCode = 409; throw error;
      }
      let factor = store.mfaFactors.find((row) => row.accountId === account.accountId && row.status === "pending");
      if (!factor) {
        const secret = generateTotpSecret();
        factor = {
          factorId: opaqueId("mfa"),
          accountId: account.accountId,
          type: "totp",
          status: "pending",
          secretEnvelope: encryptSecret(secret, env),
          recoveryCodeHashes: [],
          createdAt: nowIso(),
          confirmedAt: "",
          lastVerifiedStep: -1
        };
        store.mfaFactors.push(factor);
      }
      const secret = decryptSecret(factor.secretEnvelope, env);
      const label = encodeURIComponent(`${config.issuer}:${account.email || account.username}`);
      const issuer = encodeURIComponent(config.issuer);
      audit(store, "mfa.enrollment.started", { ...context, accountId: account.accountId }, { accountId: account.accountId });
      return {
        enrollmentToken,
        secret,
        otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
        expiresAt: challenge.expiresAt
      };
    });
  }

  async function confirmMfaEnrollment(enrollmentToken, code, context = {}) {
    const snapshot = repository.currentUnsafe();
    const challengeSnapshot = challengeFromToken(snapshot, enrollmentToken, "mfa-enrollment");
    if (!challengeSnapshot) { const error = new Error("MFA 등록 요청이 만료되었거나 올바르지 않습니다."); error.statusCode = 400; throw error; }
    const accountSnapshot = snapshot.accounts.find((row) => row.accountId === challengeSnapshot.accountId);
    const factorSnapshot = snapshot.mfaFactors.find((row) => row.accountId === challengeSnapshot.accountId && row.status === "pending");
    const descriptors = securityGuardDescriptors("mfa-enrollment", challengeSnapshot.accountId, "", context);
    assertSecurityGuardsAvailable(descriptors, "MFA 등록 확인 시도가 많습니다. 잠시 후 다시 시도하세요.", snapshot);
    const matchedStep = factorSnapshot ? matchTotpStep(decryptSecret(factorSnapshot.secretEnvelope, env), code, clock()) : null;
    const versionMatches = accountSnapshot && challengeSnapshot.authVersion === Math.max(1, Number(accountSnapshot.authVersion) || 1);
    if (matchedStep === null || !versionMatches) {
      const failure = await recordSecurityFailures(descriptors, context, "mfa.enrollment.failed");
      const error = securityFailureError(failure, "인증 앱의 6자리 코드가 올바르지 않습니다.", "MFA 등록 확인 시도가 많습니다. 잠시 후 다시 시도하세요.");
      if (error.statusCode === 401) error.statusCode = 400;
      throw error;
    }
    return repository.transaction("mfa-enrollment-confirm", (store) => {
      prune(store);
      const challenge = challengeFromToken(store, enrollmentToken, "mfa-enrollment");
      if (!challenge) { const error = new Error("MFA 등록 요청이 만료되었거나 올바르지 않습니다."); error.statusCode = 400; throw error; }
      const factor = store.mfaFactors.find((row) => row.accountId === challenge.accountId && row.status === "pending");
      if (!factor) { const error = new Error("MFA 등록 상태를 찾을 수 없습니다."); error.statusCode = 409; throw error; }
      const account = store.accounts.find((row) => row.accountId === challenge.accountId);
      if (!account || challenge.authVersion !== Math.max(1, Number(account.authVersion) || 1)) {
        const error = new Error("MFA 등록 요청이 더 이상 유효하지 않습니다."); error.statusCode = 401; throw error;
      }
      if (store.mfaFactors.some((row) => row.accountId === account.accountId && row.status === "active")) {
        const error = new Error("이미 활성화된 MFA가 있습니다."); error.statusCode = 409; throw error;
      }
      const committedStep = matchTotpStep(decryptSecret(factor.secretEnvelope, env), code, clock());
      if (committedStep === null || committedStep !== matchedStep) {
        const error = new Error("인증 앱의 6자리 코드가 올바르지 않습니다."); error.statusCode = 400; throw error;
      }
      const codes = generateRecoveryCodes(8);
      factor.status = "active";
      factor.confirmedAt = nowIso();
      factor.lastVerifiedStep = committedStep;
      factor.recoveryCodeHashes = codes.map((value) => ({ hash: recoveryCodeHash(value, env), usedAt: "" }));
      for (const row of store.authChallenges.filter((item) => item.accountId === account.accountId && item.type === "mfa-enrollment" && !item.consumedAt)) {
        row.consumedAt = nowIso();
        row.consumeReason = "mfa-enrollment-confirmed";
      }
      account.status = ACCOUNT_STATUSES.active;
      account.updatedAt = nowIso();
      if (store.security.bootstrapAccountId === account.accountId) store.security.bootstrapCompletedAt = nowIso();
      const clearKeys = new Set(descriptors.map((item) => item.guardKey));
      store.loginGuards = store.loginGuards.filter((row) => !clearKeys.has(row.guardKey));
      audit(store, "mfa.enrollment.confirmed", { ...context, accountId: account.accountId }, { accountId: account.accountId });
      return { account: publicAccount(account), recoveryCodes: codes };
    });
  }

  async function verifyMfaLogin(challengeToken, code, context = {}) {
    assertBootstrapReady();
    const snapshot = repository.currentUnsafe();
    const challengeSnapshot = challengeFromToken(snapshot, challengeToken, "mfa-login");
    if (!challengeSnapshot) { const error = new Error("MFA 확인 요청이 만료되었거나 올바르지 않습니다."); error.statusCode = 401; throw error; }
    const accountSnapshot = snapshot.accounts.find((row) => row.accountId === challengeSnapshot.accountId && row.status === ACCOUNT_STATUSES.active);
    const factorSnapshot = snapshot.mfaFactors.find((row) => row.accountId === challengeSnapshot.accountId && row.status === "active");
    if (!accountSnapshot || !factorSnapshot || challengeSnapshot.authVersion !== Math.max(1, Number(accountSnapshot.authVersion) || 1)) {
      const error = new Error("MFA가 준비되지 않았습니다."); error.statusCode = 403; throw error;
    }
    const descriptors = securityGuardDescriptors("mfa-login", accountSnapshot.accountId, "", context);
    assertSecurityGuardsAvailable(descriptors, "MFA 확인 시도가 많습니다. 잠시 후 다시 시도하세요.", snapshot);
    const numericCode = /^\d{6}$/.test(String(code || "").replace(/\s+/g, ""));
    const normalizedRecovery = String(code || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const matchedStep = numericCode
      ? matchTotpStep(decryptSecret(factorSnapshot.secretEnvelope, env), code, clock())
      : null;
    const recoveryHash = numericCode ? "" : recoveryCodeHash(normalizedRecovery, env);
    const recoveryMatch = !numericCode && factorSnapshot.recoveryCodeHashes.some((row) => !row.usedAt && timingSafeTextEqual(row.hash, recoveryHash));
    const verified = numericCode
      ? matchedStep !== null && matchedStep > Number(factorSnapshot.lastVerifiedStep ?? -1)
      : recoveryMatch;
    const method = numericCode ? "totp" : "recovery";
    if (!verified) {
      const failure = await recordSecurityFailures(descriptors, context, "mfa.login.failed", { method });
      throw securityFailureError(failure, "MFA 코드가 올바르지 않습니다.", "MFA 확인 시도가 많습니다. 잠시 후 다시 시도하세요.");
    }
    return repository.transaction("mfa-login-verify", (store) => {
      prune(store);
      const challenge = challengeFromToken(store, challengeToken, "mfa-login");
      if (!challenge) { const error = new Error("MFA 확인 요청이 만료되었거나 올바르지 않습니다."); error.statusCode = 401; throw error; }
      const account = store.accounts.find((row) => row.accountId === challenge.accountId && row.status === ACCOUNT_STATUSES.active);
      const factor = store.mfaFactors.find((row) => row.accountId === challenge.accountId && row.status === "active");
      if (!account || !factor || challenge.authVersion !== Math.max(1, Number(account.authVersion) || 1)) {
        const error = new Error("MFA가 준비되지 않았습니다."); error.statusCode = 403; throw error;
      }
      if (method === "totp") {
        const committedStep = matchTotpStep(decryptSecret(factor.secretEnvelope, env), code, clock());
        if (committedStep === null || committedStep !== matchedStep || committedStep <= Number(factor.lastVerifiedStep ?? -1)) {
          const error = new Error("이미 사용했거나 올바르지 않은 MFA 코드입니다."); error.statusCode = 401; throw error;
        }
        factor.lastVerifiedStep = committedStep;
      } else {
        const recovery = factor.recoveryCodeHashes.find((row) => !row.usedAt && timingSafeTextEqual(row.hash, recoveryHash));
        if (!recovery) { const error = new Error("이미 사용했거나 올바르지 않은 복구 코드입니다."); error.statusCode = 401; throw error; }
        recovery.usedAt = nowIso();
      }
      challenge.consumedAt = nowIso();
      const clearKeys = new Set(descriptors.map((item) => item.guardKey));
      store.loginGuards = store.loginGuards.filter((row) => !clearKeys.has(row.guardKey));
      audit(store, "mfa.login.verified", { ...context, accountId: account.accountId }, { accountId: account.accountId, method });
      return { account: publicAccount(account), mfaVerified: true };
    });
  }

  async function createSession(accountLike, context = {}, options = {}) {
    const accountId = accountLike.accountId;
    const verifiedAuthVersion = Math.max(1, Number(accountLike.authVersion) || 1);
    const rawToken = randomToken(32);
    const csrfToken = randomToken(24);
    const result = await repository.transaction("session-create", (store) => {
      prune(store);
      const account = store.accounts.find((row) => row.accountId === accountId && row.status === ACCOUNT_STATUSES.active);
      if (!account) { const error = new Error("활성 계정을 찾을 수 없습니다."); error.statusCode = 403; throw error; }
      if (Math.max(1, Number(account.authVersion) || 1) !== verifiedAuthVersion) {
        const error = new Error("인증 정보가 변경되었습니다. 다시 로그인하세요.");
        error.statusCode = 401;
        error.code = "AUTH_VERSION_CHANGED";
        throw error;
      }
      const createdAt = nowIso();
      const expiresAt = iso(() => clock() + config.sessionTtlMs);
      const session = {
        sessionId: opaqueId("session"),
        accountId,
        authVersion: verifiedAuthVersion,
        tokenHash: tokenHash(rawToken, keyRing),
        keyVersion: keyRing.currentVersion,
        csrfHash: tokenHash(csrfToken, keyRing),
        csrfKeyVersion: keyRing.currentVersion,
        createdAt,
        expiresAt,
        revokedAt: "",
        revokeReason: "",
        mfaVerifiedAt: options.mfaVerified ? createdAt : "",
        reauthenticatedAt: "",
        userAgentHash: context.userAgentHash || "",
        ipHash: context.ipHash || ""
      };
      store.sessions.push(session);
      audit(store, "session.created", { ...context, accountId }, { accountId, sessionId: session.sessionId, keyVersion: session.keyVersion });
      return { session, account, memberships: membershipRows(store, accountId) };
    });
    return {
      token: rawToken,
      csrfToken,
      session: result.session,
      public: publicSession(result.session, result.account, result.memberships)
    };
  }

  function getSession(rawToken, context = {}) {
    const store = repository.currentUnsafe();
    const session = sessionRecordFromToken(store, rawToken);
    if (!session || session.revokedAt || timeMs(session.expiresAt) <= clock()) return null;
    if (session.userAgentHash && !timingSafeTextEqual(session.userAgentHash, context.userAgentHash)) return null;
    const account = store.accounts.find((row) => row.accountId === session.accountId && row.status === ACCOUNT_STATUSES.active);
    if (!account) return null;
    if (Math.max(1, Number(session.authVersion) || 1) !== Math.max(1, Number(account.authVersion) || 1)) return null;
    return {
      ...session,
      account,
      memberships: membershipRows(store, account.accountId),
      username: account.username,
      role: account.role,
      memberId: account.accountId,
      accountType: account.role === AUTH_ROLES.admin ? "master" : "member"
    };
  }

  function projectSession(session) {
    if (!session) return publicSession();
    return publicSession(session, session.account, session.memberships);
  }

  async function rotateSessionCsrf(session, context = {}) {
    if (!session) { const error = new Error("로그인이 필요합니다."); error.statusCode = 401; throw error; }
    const csrfToken = randomToken(24);
    const result = await repository.transaction("session-csrf-rotate", (store) => {
      const row = store.sessions.find((item) => (
        item.sessionId === session.sessionId
        && !item.revokedAt
        && timeMs(item.expiresAt) > clock()
      ));
      const account = row && store.accounts.find((item) => item.accountId === row.accountId && item.status === ACCOUNT_STATUSES.active);
      if (!row || !account || Math.max(1, Number(row.authVersion) || 1) !== Math.max(1, Number(account.authVersion) || 1)) {
        const error = new Error("세션이 만료되었습니다."); error.statusCode = 401; throw error;
      }
      row.csrfHash = tokenHash(csrfToken, keyRing);
      row.csrfKeyVersion = keyRing.currentVersion;
      row.updatedAt = nowIso();
      audit(store, "session.csrf.rotated", { ...context, accountId: row.accountId }, { accountId: row.accountId, sessionId: row.sessionId });
      return { expiresAt: row.expiresAt };
    });
    return { csrfToken, expiresAt: result.expiresAt };
  }

  async function logout(session, context = {}) {
    if (!session) return { ok: true };
    await repository.transaction("session-logout", (store) => {
      const row = store.sessions.find((item) => item.sessionId === session.sessionId);
      if (row && !row.revokedAt) { row.revokedAt = nowIso(); row.revokeReason = "logout"; }
      audit(store, "session.logout", { ...context, accountId: session.accountId }, { accountId: session.accountId, sessionId: session.sessionId });
    });
    return { ok: true };
  }

  async function reauthenticate(session, payload = {}, context = {}) {
    if (!session) { const error = new Error("로그인이 필요합니다."); error.statusCode = 401; throw error; }
    const snapshot = repository.currentUnsafe();
    const account = snapshot.accounts.find((row) => row.accountId === session.accountId);
    const factor = account?.role === AUTH_ROLES.admin
      ? snapshot.mfaFactors.find((row) => row.accountId === account.accountId && row.status === "active")
      : null;
    const descriptors = securityGuardDescriptors("reauth", account?.accountId || session.accountId, "", context);
    assertSecurityGuardsAvailable(descriptors, "민감 작업 재확인 시도가 많습니다. 잠시 후 다시 시도하세요.", snapshot);
    const passwordVerified = Boolean(account && verifyPassword(payload.password, account.passwordHash));
    const matchedStep = account?.role === AUTH_ROLES.admin && factor
      ? matchTotpStep(decryptSecret(factor.secretEnvelope, env), payload.code, clock())
      : null;
    const mfaVerified = account?.role !== AUTH_ROLES.admin
      || (matchedStep !== null && matchedStep > Number(factor?.lastVerifiedStep ?? -1));
    if (!passwordVerified || !mfaVerified) {
      const failure = await recordSecurityFailures(descriptors, context, "session.reauthentication.failed", {
        method: account?.role === AUTH_ROLES.admin ? "password+totp" : "password"
      });
      throw securityFailureError(failure, "비밀번호 또는 MFA 코드가 올바르지 않습니다.", "민감 작업 재확인 시도가 많습니다. 잠시 후 다시 시도하세요.");
    }
    return repository.transaction("session-reauthenticate", (store) => {
      const row = store.sessions.find((item) => item.sessionId === session.sessionId && !item.revokedAt);
      if (!row) { const error = new Error("세션이 만료되었습니다."); error.statusCode = 401; throw error; }
      const currentAccount = store.accounts.find((item) => item.accountId === row.accountId && item.status === ACCOUNT_STATUSES.active);
      if (!currentAccount || !verifyPassword(payload.password, currentAccount.passwordHash)) {
        const error = new Error("인증 정보가 변경되었습니다. 다시 로그인하세요."); error.statusCode = 401; throw error;
      }
      if (currentAccount.role === AUTH_ROLES.admin) {
        const currentFactor = store.mfaFactors.find((item) => item.accountId === currentAccount.accountId && item.status === "active");
        const committedStep = currentFactor
          ? matchTotpStep(decryptSecret(currentFactor.secretEnvelope, env), payload.code, clock())
          : null;
        if (committedStep === null || committedStep !== matchedStep || committedStep <= Number(currentFactor.lastVerifiedStep ?? -1)) {
          const error = new Error("이미 사용했거나 올바르지 않은 MFA 코드입니다."); error.statusCode = 401; throw error;
        }
        currentFactor.lastVerifiedStep = committedStep;
      }
      row.reauthenticatedAt = nowIso();
      const clearKeys = new Set(descriptors.map((item) => item.guardKey));
      store.loginGuards = store.loginGuards.filter((item) => !clearKeys.has(item.guardKey));
      audit(store, "session.reauthenticated", { ...context, accountId: account.accountId }, { accountId: account.accountId, sessionId: row.sessionId });
      return { ok: true, reauthenticatedAt: row.reauthenticatedAt };
    });
  }

  function assertAdmin(session) {
    if (!session || session.account?.role !== AUTH_ROLES.admin || !session.mfaVerifiedAt) {
      const error = new Error("MFA를 완료한 관리자 권한이 필요합니다."); error.statusCode = 403; throw error;
    }
  }

  function assertRecentReauthentication(session) {
    assertAdmin(session);
    if (clock() - timeMs(session.reauthenticatedAt) > REAUTH_TTL_MS) {
      const error = new Error("민감 작업을 위해 비밀번호와 MFA를 다시 확인하세요."); error.statusCode = 403; error.reauthenticationRequired = true; throw error;
    }
  }

  async function createInvite(session, payload = {}, context = {}) {
    assertRecentReauthentication(session);
    const emailAddress = assertEmail(payload.email);
    const username = assertLoginId(payload.username || emailAddress.split("@")[0]);
    const plan = normalizePlan(payload.plan || "free");
    const rawToken = randomToken(32);
    return repository.transaction("invite-create", (store) => {
      prune(store);
      if (store.accounts.some((row) => row.email === emailAddress || row.username === username)) {
        const error = new Error("이미 발급된 계정입니다."); error.statusCode = 409; throw error;
      }
      if (store.invites.some((row) => (
        row.status === "pending"
        && timeMs(row.expiresAt) > clock()
        && (row.email === emailAddress || row.username === username)
      ))) {
        const error = new Error("동일 계정에 활성 초대가 이미 있습니다."); error.statusCode = 409; throw error;
      }
      let company = store.companies.find((row) => row.companyId === cleanText(payload.companyId, 120));
      if (!company) {
        const name = cleanText(payload.companyName, 120);
        if (!name) { const error = new Error("초대할 업체명 또는 companyId가 필요합니다."); error.statusCode = 400; throw error; }
        company = { companyId: opaqueId("company"), name, kind: "business", createdAt: nowIso(), updatedAt: nowIso() };
        store.companies.push(company);
      }
      const now = nowIso();
      const invite = {
        inviteId: opaqueId("invite"),
        email: emailAddress,
        username,
        companyId: company.companyId,
        role: "owner",
        plan,
        tokenHash: tokenHash(rawToken, keyRing),
        keyVersion: keyRing.currentVersion,
        status: "pending",
        createdBy: session.accountId,
        createdAt: now,
        expiresAt: iso(() => clock() + config.inviteTtlMs),
        usedAt: "",
        cancelledAt: "",
        supersededBy: ""
      };
      store.invites.push(invite);
      email.record(store, { messageId: opaqueId("mail"), type: "invite", recipient: emailAddress, relatedId: invite.inviteId }, now);
      audit(store, "invite.created", { ...context, actorAccountId: session.accountId, companyId: company.companyId }, { companyId: company.companyId, inviteId: invite.inviteId, plan });
      return { invite: { ...invite, tokenHash: undefined, keyVersion: undefined }, previewToken: email.mode === "mock" && config.mockPreviewEnabled ? rawToken : undefined };
    });
  }

  async function cancelInvite(session, inviteId, context = {}) {
    assertRecentReauthentication(session);
    return repository.transaction("invite-cancel", (store) => {
      const invite = store.invites.find((row) => row.inviteId === inviteId);
      if (!invite) { const error = new Error("초대를 찾을 수 없습니다."); error.statusCode = 404; throw error; }
      if (invite.status === "used") { const error = new Error("이미 사용된 초대입니다."); error.statusCode = 409; throw error; }
      invite.status = "cancelled";
      invite.cancelledAt = nowIso();
      audit(store, "invite.cancelled", { ...context, actorAccountId: session.accountId, companyId: invite.companyId }, { inviteId });
      return { ok: true, inviteId, status: invite.status };
    });
  }

  async function reissueInvite(session, inviteId, context = {}) {
    assertRecentReauthentication(session);
    const rawToken = randomToken(32);
    return repository.transaction("invite-reissue", (store) => {
      prune(store);
      const old = store.invites.find((row) => row.inviteId === inviteId);
      if (!old) { const error = new Error("초대를 찾을 수 없습니다."); error.statusCode = 404; throw error; }
      if (old.status === "used") { const error = new Error("이미 사용된 초대입니다."); error.statusCode = 409; throw error; }
      if (store.accounts.some((row) => row.email === old.email || row.username === old.username)) {
        const error = new Error("이미 발급된 계정입니다."); error.statusCode = 409; throw error;
      }
      const company = store.companies.find((row) => row.companyId === old.companyId);
      if (!company) { const error = new Error("초대 업체를 찾을 수 없습니다."); error.statusCode = 409; throw error; }
      if (store.invites.some((row) => row.inviteId !== old.inviteId && row.email === old.email && row.status === "pending" && timeMs(row.expiresAt) > clock())) {
        const error = new Error("동일 이메일에 활성 초대가 이미 있습니다."); error.statusCode = 409; throw error;
      }
      const now = nowIso();
      const invite = {
        ...old,
        inviteId: opaqueId("invite"),
        tokenHash: tokenHash(rawToken, keyRing),
        keyVersion: keyRing.currentVersion,
        status: "pending",
        createdBy: session.accountId,
        createdAt: now,
        expiresAt: iso(() => clock() + config.inviteTtlMs),
        usedAt: "",
        cancelledAt: "",
        supersededBy: ""
      };
      delete invite.accountId;
      store.invites.push(invite);
      old.status = "superseded";
      old.supersededBy = invite.inviteId;
      old.cancelledAt = now;
      email.record(store, { messageId: opaqueId("mail"), type: "invite", recipient: invite.email, relatedId: invite.inviteId }, now);
      audit(store, "invite.reissued", { ...context, actorAccountId: session.accountId, companyId: invite.companyId }, { inviteId: invite.inviteId, supersedesInviteId: old.inviteId, plan: invite.plan });
      return {
        invite: { ...invite, tokenHash: undefined, keyVersion: undefined },
        previewToken: email.mode === "mock" && config.mockPreviewEnabled ? rawToken : undefined
      };
    });
  }

  async function activateInvite(payload = {}, context = {}) {
    assertBootstrapReady();
    await consumePublicRateLimit("invite-activate", context, sha256(String(payload.token || "")).slice(0, 24));
    const password = assertPassword(payload.password);
    if (password !== String(payload.passwordConfirm || payload.confirmPassword || "")) {
      const error = new Error("비밀번호 확인이 일치하지 않습니다."); error.statusCode = 400; throw error;
    }
    return repository.transaction("invite-activate", (store) => {
      prune(store);
      const invite = store.invites.find((row) => (
        row.status === "pending" && timeMs(row.expiresAt) > clock() && storedTokenMatches(row, payload.token)
      ));
      if (!invite) { const error = new Error("초대가 만료되었거나 사용할 수 없습니다."); error.statusCode = 400; throw error; }
      if (store.accounts.some((row) => row.email === invite.email || row.username === invite.username)) {
        const error = new Error("이미 활성화된 계정입니다."); error.statusCode = 409; throw error;
      }
      const now = nowIso();
      const account = {
        accountId: opaqueId("acct"),
        username: invite.username,
        email: invite.email,
        displayName: cleanText(payload.displayName || invite.username, 120),
        passwordHash: hashPassword(password),
        role: AUTH_ROLES.business,
        status: ACCOUNT_STATUSES.active,
        authVersion: 1,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: "",
        passwordChangedAt: now
      };
      store.accounts.push(account);
      store.memberships.push({
        membershipId: opaqueId("member"), accountId: account.accountId, companyId: invite.companyId,
        role: invite.role, plan: invite.plan, status: "active", createdAt: now, updatedAt: now
      });
      invite.status = "used";
      invite.usedAt = now;
      invite.accountId = account.accountId;
      audit(store, "invite.activated", { ...context, accountId: account.accountId, companyId: invite.companyId }, { inviteId: invite.inviteId });
      return { ok: true, account: publicAccount(account), companyId: invite.companyId, plan: invite.plan };
    });
  }

  async function requestPasswordReset(identity, context = {}) {
    assertBootstrapReady();
    await consumePublicRateLimit("password-reset-request", context, normalizeLoginId(identity));
    const rawToken = randomToken(32);
    const result = await repository.transaction("password-reset-request", (store) => {
      prune(store);
      const account = accountByIdentity(store, identity);
      if (!account || account.status === ACCOUNT_STATUSES.disabled) {
        audit(store, "password.reset.requested", context, { outcome: "accepted", accountFound: false });
        return { previewToken: undefined };
      }
      for (const row of store.passwordResets.filter((item) => item.accountId === account.accountId && item.status === "pending")) {
        row.status = "superseded";
        row.supersededAt = nowIso();
      }
      const now = nowIso();
      const reset = {
        resetId: opaqueId("reset"), accountId: account.accountId,
        tokenHash: tokenHash(rawToken, keyRing), keyVersion: keyRing.currentVersion,
        status: "pending", createdAt: now, expiresAt: iso(() => clock() + config.resetTtlMs), usedAt: ""
      };
      store.passwordResets.push(reset);
      email.record(store, { messageId: opaqueId("mail"), type: "password-reset", recipient: account.email, relatedId: reset.resetId }, now);
      audit(store, "password.reset.requested", { ...context, accountId: account.accountId }, { accountId: account.accountId, outcome: "accepted", accountFound: true });
      return { previewToken: email.mode === "mock" && config.mockPreviewEnabled ? rawToken : undefined };
    });
    return {
      ok: true,
      message: "계정이 존재하면 비밀번호 재설정 안내를 발송했습니다.",
      previewToken: result.previewToken
    };
  }

  async function confirmPasswordReset(payload = {}, context = {}) {
    assertBootstrapReady();
    await consumePublicRateLimit("password-reset-confirm", context, sha256(String(payload.token || "")).slice(0, 24));
    const password = assertPassword(payload.password);
    if (password !== String(payload.passwordConfirm || payload.confirmPassword || "")) {
      const error = new Error("비밀번호 확인이 일치하지 않습니다."); error.statusCode = 400; throw error;
    }
    return repository.transaction("password-reset-confirm", (store) => {
      prune(store);
      const reset = store.passwordResets.find((row) => (
        row.status === "pending" && timeMs(row.expiresAt) > clock() && storedTokenMatches(row, payload.token)
      ));
      if (!reset) { const error = new Error("재설정 요청이 만료되었거나 올바르지 않습니다."); error.statusCode = 400; throw error; }
      const account = store.accounts.find((row) => row.accountId === reset.accountId);
      if (!account) { const error = new Error("계정을 찾을 수 없습니다."); error.statusCode = 400; throw error; }
      account.passwordHash = hashPassword(password);
      account.authVersion = Math.max(1, Number(account.authVersion) || 1) + 1;
      account.passwordChangedAt = nowIso();
      account.updatedAt = nowIso();
      reset.status = "used";
      reset.usedAt = nowIso();
      for (const row of store.passwordResets.filter((item) => item.accountId === account.accountId && item.resetId !== reset.resetId && item.status === "pending")) {
        row.status = "superseded";
        row.supersededAt = nowIso();
      }
      for (const session of store.sessions.filter((row) => row.accountId === account.accountId && !row.revokedAt)) {
        session.revokedAt = nowIso();
        session.revokeReason = "password-reset";
      }
      for (const challenge of store.authChallenges.filter((row) => row.accountId === account.accountId && !row.consumedAt)) {
        challenge.consumedAt = nowIso();
        challenge.consumeReason = "password-reset";
      }
      store.loginGuards = store.loginGuards.filter((row) => row.accountId !== account.accountId);
      audit(store, "password.reset.completed", { ...context, accountId: account.accountId }, { accountId: account.accountId });
      return { ok: true };
    });
  }

  async function forceLogout(session, targetAccountId, context = {}) {
    assertRecentReauthentication(session);
    return repository.transaction("session-force-logout", (store) => {
      let revoked = 0;
      for (const row of store.sessions.filter((item) => item.accountId === targetAccountId && !item.revokedAt)) {
        row.revokedAt = nowIso(); row.revokeReason = "admin-force-logout"; revoked += 1;
      }
      audit(store, "session.force_logout", { ...context, actorAccountId: session.accountId, accountId: targetAccountId }, { accountId: targetAccountId, revoked });
      return { ok: true, revoked };
    });
  }

  async function unlockLoginGuards(session, targetAccountId, context = {}) {
    assertRecentReauthentication(session);
    return repository.transaction("login-guard-admin-unlock", (store) => {
      const account = store.accounts.find((row) => row.accountId === targetAccountId);
      if (!account) { const error = new Error("계정을 찾을 수 없습니다."); error.statusCode = 404; throw error; }
      const before = store.loginGuards.length;
      store.loginGuards = store.loginGuards.filter((row) => (
        row.accountId !== targetAccountId
        && !(Array.isArray(row.relatedAccountIds) && row.relatedAccountIds.includes(targetAccountId))
      ));
      const unlocked = before - store.loginGuards.length;
      audit(store, "login.guard.unlocked", { ...context, actorAccountId: session.accountId, accountId: targetAccountId }, { accountId: targetAccountId, unlocked });
      return { ok: true, accountId: targetAccountId, unlocked };
    });
  }

  async function retireSessionKeyVersion(session, version, context = {}) {
    assertRecentReauthentication(session);
    if (!keyRing.keys.has(version) || version === keyRing.currentVersion) {
      const error = new Error("현재 key 또는 알 수 없는 key는 retire할 수 없습니다."); error.statusCode = 400; throw error;
    }
    return repository.transaction("session-key-retire", (store) => {
      let revoked = 0;
      for (const row of store.sessions.filter((item) => item.keyVersion === version && !item.revokedAt)) {
        row.revokedAt = nowIso(); row.revokeReason = "key-retired"; revoked += 1;
      }
      audit(store, "session.key.retired", { ...context, actorAccountId: session.accountId }, { keyVersion: version, revoked });
      return { ok: true, keyVersion: version, revoked };
    });
  }

  async function assertCompanyAccess(session, companyId, context = {}) {
    const requested = cleanText(companyId, 160);
    const store = repository.currentUnsafe();
    const exists = store.companies.some((row) => row.companyId === requested);
    const allowed = Boolean(session && exists && (
      session.account?.role === AUTH_ROLES.admin
      || session.memberships.some((row) => row.companyId === requested)
    ));
    if (!allowed) {
      await repository.transaction("tenant-denied", (next) => {
        audit(next, "tenant.access.denied", { ...context, actorAccountId: session?.accountId || "", companyId: requested }, { companyId: requested, outcome: "failure" });
      });
      const error = new Error("다른 업체의 companyId에는 접근할 수 없습니다."); error.statusCode = 403; throw error;
    }
    const company = store.companies.find((row) => row.companyId === requested);
    const membership = session.memberships.find((row) => row.companyId === requested) || null;
    return { company: { ...company }, membership, entitlements: entitlementsForPlan(membership?.plan || (session.account.role === AUTH_ROLES.admin ? "pro" : "free")) };
  }

  function snapshotForTests() {
    return repository.snapshot();
  }

  return Object.freeze({
    config,
    keyRing,
    emailMode: email.mode,
    initialize,
    capabilities,
    bootstrapReady,
    assertBootstrapReady,
    hashRequestFingerprint,
    createAnonymousCsrfToken,
    verifyAnonymousCsrfToken,
    assertRequestBoundary,
    bootstrapAdmin,
    checkUsernameAvailability,
    signup,
    authenticate,
    beginMfaEnrollment,
    confirmMfaEnrollment,
    verifyMfaLogin,
    createSession,
    getSession,
    projectSession,
    rotateSessionCsrf,
    logout,
    reauthenticate,
    assertRecentReauthentication,
    createInvite,
    cancelInvite,
    reissueInvite,
    activateInvite,
    requestPasswordReset,
    confirmPasswordReset,
    forceLogout,
    unlockLoginGuards,
    retireSessionKeyVersion,
    assertCompanyAccess,
    snapshotForTests
  });
}

module.exports = {
  ANONYMOUS_CSRF_TTL_MS,
  CHALLENGE_TTL_MS,
  INVITE_TTL_MS,
  LOGIN_FAILURE_LIMIT,
  RESET_TTL_MS,
  SESSION_TTL_MS,
  createAuthService,
  safeAuditMetadata,
  validateConfiguration
};
