const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const {
  buildOtpAuthUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp
} = require("./auth_mfa.cjs");

const scrypt = promisify(crypto.scrypt);
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 256;
const SESSION_TOKEN_BYTES = 32;
const RESET_TOKEN_BYTES = 32;
const INVITE_TOKEN_BYTES = 32;
const AUDIT_LOG_LIMIT = 5000;
const SECURITY_STATE_LIMIT = 1000;

class AuthError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = statusCode;
    this.publicMessage = message;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase() === "admin" ? "admin" : "business";
}

function normalizeCompanyIds(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)))
    .slice(0, 200);
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function auditText(value, maxLength = 160) {
  return String(value || "").trim().slice(0, maxLength);
}

function safeAuditDetails(value = {}) {
  const result = {};
  Object.entries(value || {}).slice(0, 20).forEach(([key, item]) => {
    if (/password|token|secret|cookie|authorization|raw/i.test(key)) return;
    if (["string", "number", "boolean"].includes(typeof item)) result[auditText(key, 60)] = typeof item === "string" ? auditText(item, 240) : item;
    else if (Array.isArray(item)) result[auditText(key, 60)] = item.slice(0, 30).map((entry) => auditText(entry, 120));
  });
  return result;
}

function secureHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < PASSWORD_MIN_LENGTH) {
    throw new AuthError("AUTH_PASSWORD_TOO_SHORT", `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    throw new AuthError("AUTH_PASSWORD_TOO_LONG", `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  return value;
}

async function hashPassword(password, options = {}) {
  const value = options.allowLegacy ? String(password || "") : validatePassword(password);
  if (!value) throw new AuthError("AUTH_PASSWORD_REQUIRED", "A password is required.");
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(value, salt, 64, { N: 16384, r: 8, p: 1 });
  return {
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    hash: Buffer.from(derived).toString("base64"),
    keyLength: 64,
    cost: 16384,
    blockSize: 8,
    parallelization: 1
  };
}

async function verifyPassword(password, passwordHash = {}) {
  if (passwordHash.algorithm !== "scrypt" || !passwordHash.salt || !passwordHash.hash) return false;
  try {
    const expected = Buffer.from(passwordHash.hash, "base64");
    const derived = await scrypt(String(password || ""), Buffer.from(passwordHash.salt, "base64"), expected.length, {
      N: Number(passwordHash.cost || 16384),
      r: Number(passwordHash.blockSize || 8),
      p: Number(passwordHash.parallelization || 1)
    });
    const actual = Buffer.from(derived);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function publicAccount(account = {}) {
  const mfa = account.mfa || {};
  return {
    userId: account.userId || "",
    username: account.username || "",
    displayName: account.displayName || account.username || "",
    role: account.role || "business",
    companyIds: normalizeCompanyIds(account.companyIds),
    status: account.status || "active",
    mustResetPassword: Boolean(account.mustResetPassword),
    passwordChangedAt: account.passwordChangedAt || "",
    lastLoginAt: account.lastLoginAt || "",
    createdAt: account.createdAt || "",
    updatedAt: account.updatedAt || "",
    mfa: {
      status: mfa.status === "enabled" ? "enabled" : mfa.status === "pending" ? "pending" : "disabled",
      enabled: mfa.status === "enabled",
      recoveryCodesRemaining: Array.isArray(mfa.recoveryCodeHashes) ? mfa.recoveryCodeHashes.length : 0,
      enrolledAt: mfa.enrolledAt || "",
      lastVerifiedAt: mfa.lastVerifiedAt || "",
      updatedAt: mfa.updatedAt || ""
    }
  };
}

function invitationStatus(invite = {}, now = Date.now()) {
  if (invite.acceptedAt) return "accepted";
  if (invite.activationFailedAt) return "activation_failed";
  if (invite.cancelledAt) return "cancelled";
  if (invite.supersededAt) return "superseded";
  if (invite.consumedAt || invite.processingAt) return "processing";
  if (Date.parse(invite.expiresAt || "") <= now) return "expired";
  return "pending";
}

function maskEmail(value) {
  const [local = "", domain = ""] = String(value || "").split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, Math.min(8, local.length - 2)))}@${domain}`;
}

function publicInvitation(invite = {}, options = {}) {
  return {
    inviteId: invite.inviteId || "",
    username: options.maskUsername ? maskEmail(invite.username) : invite.username || "",
    displayName: invite.displayName || "",
    role: invite.role || "business",
    companyIds: normalizeCompanyIds(invite.companyIds),
    status: invitationStatus(invite),
    issuedAt: invite.issuedAt || "",
    expiresAt: invite.expiresAt || "",
    acceptedAt: invite.acceptedAt || "",
    cancelledAt: invite.cancelledAt || "",
    supersededAt: invite.supersededAt || "",
    activationFailedAt: invite.activationFailedAt || "",
    reissuedFromInviteId: invite.reissuedFromInviteId || "",
    reissueCount: Number(invite.reissueCount || 0),
    deliveryStatus: invite.deliveryStatus || "pending",
    deliveryMode: invite.deliveryMode || "",
    deliveryProvider: invite.deliveryProvider || "",
    deliveryId: invite.deliveryId || "",
    providerDeliveryId: invite.providerDeliveryId || "",
    deliveryQueueStatus: invite.deliveryQueueStatus || "",
    lastDeliveryAt: invite.lastDeliveryAt || ""
  };
}

function defaultStore(name) {
  return { version: 1, name, updatedAt: "", items: [] };
}

async function readStore(filePath, name) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      version: Number(parsed.version || 1),
      name: parsed.name || name,
      updatedAt: parsed.updatedAt || "",
      items: Array.isArray(parsed.items) ? parsed.items : []
    };
  } catch (error) {
    if (error?.code === "ENOENT") return defaultStore(name);
    throw error;
  }
}

async function writeStore(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const next = { ...payload, updatedAt: nowIso() };
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
  return next;
}

function createAuthService(options = {}) {
  const accountsFile = path.resolve(options.accountsFile);
  const sessionsFile = path.resolve(options.sessionsFile);
  const resetsFile = path.resolve(options.resetsFile);
  const invitesFile = path.resolve(options.invitesFile || path.join(path.dirname(accountsFile), "account_invitations.json"));
  const auditFile = path.resolve(options.auditFile || path.join(path.dirname(accountsFile), "auth_audit_logs.json"));
  const securityFile = path.resolve(options.securityFile || path.join(path.dirname(accountsFile), "auth_security_state.json"));
  const sessionTtlMs = Math.max(50, Number(options.sessionTtlMs || 8 * 60 * 60 * 1000));
  const csrfSecret = String(options.csrfSecret || "");
  const previousCsrfSecret = String(options.previousCsrfSecret || "");
  const keyTransitionActive = Boolean(options.keyTransitionActive);
  const resetTtlMs = Math.max(50, Number(options.resetTtlMs || 30 * 60 * 1000));
  const inviteTtlMs = Math.max(1000, Number(options.inviteTtlMs || 72 * 60 * 60 * 1000));
  const mfaEncryptionKey = String(options.mfaEncryptionKey || "");
  const previousMfaEncryptionKey = String(options.previousMfaEncryptionKey || "");
  const mfaKeyVersion = auditText(options.mfaKeyVersion || "v1", 80) || "v1";
  const previousMfaKeyVersion = auditText(options.previousMfaKeyVersion || "", 80);
  const mfaEncryptionConfigured = mfaEncryptionKey.length >= 24;
  const mfaIssuer = String(options.mfaIssuer || "Lodging Data Lab").trim() || "Lodging Data Lab";
  const mfaEnforced = Boolean(options.mfaEnforced);
  const mfaSessionTtlMs = Math.max(50, Number(options.mfaSessionTtlMs || 30 * 60 * 1000));
  const policies = {
    login: {
      account: {
        maxAttempts: boundedInteger(options.loginAccountMaxAttempts, 5, 2, 100),
        windowMs: boundedInteger(options.loginWindowMs, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.loginLockMs, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      },
      ip: {
        maxAttempts: boundedInteger(options.loginIpMaxAttempts, 20, 2, 500),
        windowMs: boundedInteger(options.loginWindowMs, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.loginLockMs, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      }
    },
    password_reset: {
      account: {
        maxAttempts: boundedInteger(options.resetAccountMaxAttempts, 5, 2, 100),
        windowMs: boundedInteger(options.resetWindowMs, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.resetLockMs, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      },
      ip: {
        maxAttempts: boundedInteger(options.resetIpMaxAttempts, 20, 2, 500),
        windowMs: boundedInteger(options.resetWindowMs, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.resetLockMs, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      }
    },
    invitation_delivery: {
      account: {
        maxAttempts: boundedInteger(options.inviteAccountMaxAttempts, 5, 2, 100),
        windowMs: boundedInteger(options.inviteWindowMs, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.inviteLockMs, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      },
      ip: {
        maxAttempts: boundedInteger(options.inviteIpMaxAttempts, 50, 2, 500),
        windowMs: boundedInteger(options.inviteWindowMs, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.inviteLockMs, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      }
    },
    invitation_activation: {
      account: {
        maxAttempts: boundedInteger(options.activationTokenMaxAttempts, 10, 2, 100),
        windowMs: boundedInteger(options.activationWindowMs, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.activationLockMs, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      },
      ip: {
        maxAttempts: boundedInteger(options.activationIpMaxAttempts, 30, 2, 500),
        windowMs: boundedInteger(options.activationWindowMs, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.activationLockMs, 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      }
    },
    mfa_challenge: {
      account: {
        maxAttempts: boundedInteger(options.mfaAccountMaxAttempts, 5, 2, 100),
        windowMs: boundedInteger(options.mfaWindowMs, 10 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.mfaLockMs, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      },
      ip: {
        maxAttempts: boundedInteger(options.mfaIpMaxAttempts, 20, 2, 500),
        windowMs: boundedInteger(options.mfaWindowMs, 10 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
        lockMs: boundedInteger(options.mfaLockMs, 15 * 60 * 1000, 1000, 24 * 60 * 60 * 1000)
      }
    }
  };
  let mutationQueue = Promise.resolve();
  let auditQueue = Promise.resolve();
  let securityQueue = Promise.resolve();
  const dummyPasswordHash = hashPassword(crypto.randomBytes(24).toString("base64url"));

  function csrfTokenForSession(token) {
    if (!token || csrfSecret.length < 24) return "";
    return crypto.createHmac("sha256", csrfSecret)
      .update(`lodging-session-csrf:${String(token)}`)
      .digest("base64url");
  }

  function verifyCsrfToken(token, submittedToken) {
    const submitted = String(submittedToken || "").trim();
    if (!token || !submitted || submitted.length > 256) return false;
    const secrets = [csrfSecret, ...(keyTransitionActive ? [previousCsrfSecret] : [])]
      .filter((item, index, values) => item.length >= 24 && values.indexOf(item) === index);
    return secrets.some((secret) => {
      const expected = crypto.createHmac("sha256", secret)
        .update(`lodging-session-csrf:${String(token)}`)
        .digest("base64url");
      const expectedBuffer = Buffer.from(expected);
      const submittedBuffer = Buffer.from(submitted);
      return expectedBuffer.length === submittedBuffer.length
        && crypto.timingSafeEqual(expectedBuffer, submittedBuffer);
    });
  }

  function decryptStoredMfaSecret(payload = {}) {
    const payloadVersion = auditText(payload.keyVersion || "", 80);
    const candidates = [
      { keyVersion: mfaKeyVersion, key: mfaEncryptionKey, source: "current" },
      ...(keyTransitionActive ? [{ keyVersion: previousMfaKeyVersion, key: previousMfaEncryptionKey, source: "previous" }] : [])
    ]
      .filter((item) => item.key.length >= 24)
      .sort((left, right) => Number(right.keyVersion === payloadVersion) - Number(left.keyVersion === payloadVersion));
    for (const candidate of candidates) {
      try {
        return {
          secret: decryptMfaSecret(payload, candidate.key),
          keyVersion: candidate.keyVersion,
          source: candidate.source
        };
      } catch {}
    }
    throw new AuthError("AUTH_MFA_SECRET_UNAVAILABLE", "The stored MFA setup cannot be decrypted with an active key.", 409);
  }

  function encryptCurrentMfaSecret(secret) {
    return encryptMfaSecret(secret, mfaEncryptionKey, { keyVersion: mfaKeyVersion });
  }

  function mutate(task) {
    const next = mutationQueue.then(task, task);
    mutationQueue = next.catch(() => {});
    return next;
  }

  function queueAudit(task) {
    const next = auditQueue.then(task, task);
    auditQueue = next.catch(() => {});
    return next;
  }

  function queueSecurity(task) {
    const next = securityQueue.then(task, task);
    securityQueue = next.catch(() => {});
    return next;
  }

  async function appendAudit(event = {}, metadata = {}) {
    const item = {
      auditId: randomId("aud"),
      occurredAt: nowIso(),
      eventType: auditText(event.eventType || "auth_event", 80),
      outcome: auditText(event.outcome || "recorded", 40),
      actorUserId: auditText(event.actorUserId, 120),
      actorUsername: auditText(event.actorUsername, 120),
      actorRole: auditText(event.actorRole, 40),
      targetUserId: auditText(event.targetUserId, 120),
      targetUsername: auditText(event.targetUsername, 120),
      companyId: auditText(event.companyId, 160),
      reasonCode: auditText(event.reasonCode, 100),
      authType: auditText(event.authType || metadata.authType, 40),
      requestPath: auditText(event.requestPath || metadata.requestPath, 200),
      ipHash: metadata.ip ? secureHash(metadata.ip) : "",
      userAgentHash: metadata.userAgent ? secureHash(metadata.userAgent) : "",
      details: safeAuditDetails(event.details)
    };
    await queueAudit(async () => {
      const store = await readStore(auditFile, "auth_audit_logs");
      store.items.push(item);
      if (store.items.length > AUDIT_LOG_LIMIT) store.items = store.items.slice(-AUDIT_LOG_LIMIT);
      await writeStore(auditFile, store);
    });
    return item;
  }

  function rateIdentities(username, ip) {
    const result = [];
    const account = normalizeUsername(username);
    if (account) result.push({ scope: "account", value: account, label: account });
    const ipValue = String(ip || "").trim();
    if (ipValue) result.push({ scope: "ip", value: ipValue, label: `IP ${secureHash(ipValue).slice(0, 12)}` });
    return result;
  }

  function rateKey(action, scope, value) {
    return `lock_${secureHash(`${action}:${scope}:${value}`).slice(0, 32)}`;
  }

  async function currentRateBlock(action, identities) {
    const store = await readStore(securityFile, "auth_security_state");
    const now = Date.now();
    const blocked = identities
      .map((identity) => store.items.find((item) => item.lockId === rateKey(action, identity.scope, identity.value)))
      .filter((item) => item && Date.parse(item.lockedUntil || "") > now)
      .sort((a, b) => Date.parse(b.lockedUntil) - Date.parse(a.lockedUntil))[0];
    if (!blocked) return null;
    return {
      ...blocked,
      retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(blocked.lockedUntil) - now) / 1000))
    };
  }

  async function registerRateAttempt(action, identities) {
    return queueSecurity(async () => {
      const store = await readStore(securityFile, "auth_security_state");
      const now = new Date();
      let blocked = null;
      identities.forEach((identity) => {
        const policy = policies[action]?.[identity.scope];
        if (!policy) return;
        const lockId = rateKey(action, identity.scope, identity.value);
        const index = store.items.findIndex((item) => item.lockId === lockId);
        const previous = index >= 0 ? store.items[index] : {};
        const recentAttempts = (previous.attempts || []).filter((timestamp) => now.getTime() - Date.parse(timestamp) <= policy.windowMs);
        recentAttempts.push(now.toISOString());
        const shouldLock = Date.parse(previous.lockedUntil || "") > now.getTime() || recentAttempts.length >= policy.maxAttempts;
        const next = {
          ...previous,
          lockId,
          action,
          scope: identity.scope,
          label: identity.label,
          subjectHash: secureHash(identity.value),
          attempts: recentAttempts.slice(-policy.maxAttempts),
          failureCount: recentAttempts.length,
          firstAttemptAt: recentAttempts[0] || now.toISOString(),
          lastAttemptAt: now.toISOString(),
          lockedUntil: shouldLock
            ? (Date.parse(previous.lockedUntil || "") > now.getTime() ? previous.lockedUntil : new Date(now.getTime() + policy.lockMs).toISOString())
            : "",
          unlockedAt: "",
          unlockedBy: ""
        };
        if (index >= 0) store.items[index] = next;
        else store.items.push(next);
        if (shouldLock && (!blocked || Date.parse(next.lockedUntil) > Date.parse(blocked.lockedUntil))) blocked = next;
      });
      store.items = store.items
        .filter((item) => Date.parse(item.lockedUntil || "") > now.getTime() || now.getTime() - Date.parse(item.lastAttemptAt || 0) <= 7 * 24 * 60 * 60 * 1000)
        .slice(-SECURITY_STATE_LIMIT);
      await writeStore(securityFile, store);
      if (!blocked) return null;
      return {
        ...blocked,
        retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(blocked.lockedUntil) - now.getTime()) / 1000))
      };
    });
  }

  async function clearAccountRate(action, username) {
    const normalized = normalizeUsername(username);
    if (!normalized) return;
    await queueSecurity(async () => {
      const store = await readStore(securityFile, "auth_security_state");
      const lockId = rateKey(action, "account", normalized);
      const index = store.items.findIndex((item) => item.lockId === lockId);
      if (index < 0) return;
      store.items[index] = {
        ...store.items[index],
        attempts: [],
        failureCount: 0,
        lockedUntil: "",
        resolvedAt: nowIso()
      };
      await writeStore(securityFile, store);
    });
  }

  async function initializeBootstrap({ username, password, displayName } = {}) {
    const normalized = normalizeUsername(username);
    if (!normalized || !password) return { created: false };
    const result = await mutate(async () => {
      const store = await readStore(accountsFile, "user_accounts");
      const existing = store.items.find((item) => item.username === normalized);
      if (existing) return { created: false, account: publicAccount(existing) };
      const now = nowIso();
      const account = {
        userId: randomId("usr"),
        username: normalized,
        displayName: String(displayName || normalized).trim() || normalized,
        role: "admin",
        companyIds: [],
        status: "active",
        passwordHash: await hashPassword(password, { allowLegacy: true }),
        mustResetPassword: String(password).length < PASSWORD_MIN_LENGTH,
        passwordChangedAt: now,
        lastLoginAt: "",
        createdAt: now,
        updatedAt: now,
        createdBy: "bootstrap"
      };
      store.items.push(account);
      await writeStore(accountsFile, store);
      return { created: true, account: publicAccount(account) };
    });
    if (result.created) {
      await appendAudit({
        eventType: "account_created",
        outcome: "succeeded",
        actorUserId: "bootstrap",
        actorUsername: "bootstrap",
        actorRole: "system",
        targetUserId: result.account.userId,
        targetUsername: result.account.username,
        details: { targetRole: "admin", targetStatus: "active" }
      });
    }
    return result;
  }

  async function hasActiveAccounts() {
    const store = await readStore(accountsFile, "user_accounts");
    return store.items.some((item) => item.status === "active");
  }

  async function verifyCredentials(username, password) {
    const normalized = normalizeUsername(username);
    const store = await readStore(accountsFile, "user_accounts");
    const account = store.items.find((item) => item.username === normalized && item.status === "active");
    const valid = await verifyPassword(password, account?.passwordHash || await dummyPasswordHash);
    if (!account || !valid) return null;
    return account;
  }

  async function login(username, password, metadata = {}) {
    const normalized = normalizeUsername(username);
    const identities = rateIdentities(normalized, metadata.ip);
    const existingBlock = await currentRateBlock("login", identities);
    if (existingBlock) {
      await appendAudit({
        eventType: "login_blocked",
        outcome: "blocked",
        targetUsername: normalized,
        reasonCode: "AUTH_LOGIN_LOCKED",
        details: { scope: existingBlock.scope, retryAfterSeconds: existingBlock.retryAfterSeconds }
      }, metadata);
      const error = new AuthError("AUTH_LOGIN_LOCKED", "Too many sign-in attempts. Try again later.", 429);
      error.retryAfterSeconds = existingBlock.retryAfterSeconds;
      throw error;
    }

    const account = await verifyCredentials(normalized, password);
    if (!account) {
      const newBlock = await registerRateAttempt("login", identities);
      await appendAudit({
        eventType: newBlock ? "login_blocked" : "login_failed",
        outcome: newBlock ? "blocked" : "failed",
        targetUsername: normalized,
        reasonCode: newBlock ? "AUTH_LOGIN_LOCKED" : "AUTH_INVALID_CREDENTIALS",
        details: newBlock ? { scope: newBlock.scope, retryAfterSeconds: newBlock.retryAfterSeconds } : {}
      }, metadata);
      if (newBlock) {
        const error = new AuthError("AUTH_LOGIN_LOCKED", "Too many sign-in attempts. Try again later.", 429);
        error.retryAfterSeconds = newBlock.retryAfterSeconds;
        throw error;
      }
      throw new AuthError("AUTH_INVALID_CREDENTIALS", "The username or password is incorrect.", 401);
    }
    const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + sessionTtlMs).toISOString();
    const mfaEnabled = account.role === "admin" && account.mfa?.status === "enabled";
    const mfaEnrollmentRequired = account.role === "admin" && mfaEnforced && !mfaEnabled;
    const mfaChallengeRequired = Boolean(mfaEnforced && mfaEnabled);
    let replacedSession = false;

    await mutate(async () => {
      const [accounts, sessions] = await Promise.all([
        readStore(accountsFile, "user_accounts"),
        readStore(sessionsFile, "auth_sessions")
      ]);
      const accountIndex = accounts.items.findIndex((item) => item.userId === account.userId);
      if (accountIndex >= 0) {
        accounts.items[accountIndex] = { ...accounts.items[accountIndex], lastLoginAt: now.toISOString(), updatedAt: now.toISOString() };
        await writeStore(accountsFile, accounts);
      }
      const replaceTokenHash = metadata.replaceToken ? secureHash(metadata.replaceToken) : "";
      if (replaceTokenHash) {
        sessions.items = sessions.items.map((item) => {
          if (item.tokenHash !== replaceTokenHash || item.revokedAt) return item;
          replacedSession = true;
          return { ...item, revokedAt: now.toISOString(), revokeReason: "session_rotated" };
        });
      }
      sessions.items = sessions.items.filter((item) => Date.parse(item.expiresAt || "") > now.getTime());
      sessions.items.push({
        sessionId: randomId("ses"),
        tokenHash: secureHash(token),
        userId: account.userId,
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt,
        mfaChallengeRequired,
        mfaEnrollmentRequired,
        mfaVerifiedAt: "",
        mfaExpiresAt: "",
        revokedAt: "",
        ipHash: metadata.ip ? secureHash(metadata.ip) : "",
        userAgentHash: metadata.userAgent ? secureHash(metadata.userAgent) : ""
      });
      await writeStore(sessionsFile, sessions);
    });

    await clearAccountRate("login", normalized);
    await appendAudit({
      eventType: mfaChallengeRequired || mfaEnrollmentRequired ? "login_password_succeeded" : "login_succeeded",
      outcome: mfaChallengeRequired ? "mfa_required" : mfaEnrollmentRequired ? "mfa_enrollment_required" : "succeeded",
      actorUserId: account.userId,
      actorUsername: account.username,
      actorRole: account.role,
      authType: "session",
      details: { sessionRotated: replacedSession, mfaChallengeRequired, mfaEnrollmentRequired }
    }, metadata);

    return {
      token,
      csrfToken: csrfTokenForSession(token),
      expiresAt,
      expiresInSeconds: Math.floor(sessionTtlMs / 1000),
      mfaChallengeRequired,
      mfaEnrollmentRequired,
      account: publicAccount({ ...account, lastLoginAt: now.toISOString() })
    };
  }

  async function resolveSession(token) {
    if (!token) return null;
    const tokenHash = secureHash(token);
    const now = Date.now();
    const [accounts, sessions] = await Promise.all([
      readStore(accountsFile, "user_accounts"),
      readStore(sessionsFile, "auth_sessions")
    ]);
    const session = sessions.items.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
    if (!session || Date.parse(session.expiresAt || "") <= now) return null;
    const account = accounts.items.find((item) => item.userId === session.userId && item.status === "active");
    if (!account) return null;
    return { session, account: publicAccount(account) };
  }

  function assertMfaEncryptionReady() {
    if (!mfaEncryptionConfigured) {
      throw new AuthError("AUTH_MFA_ENCRYPTION_NOT_CONFIGURED", "MFA encryption is not configured.", 503);
    }
  }

  function publicMfaSession(account = {}, session = {}) {
    const enabled = account.mfa?.status === "enabled";
    const verified = enabled && Date.parse(session.mfaExpiresAt || "") > Date.now();
    return {
      status: enabled ? "enabled" : account.mfa?.status === "pending" ? "pending" : "disabled",
      enabled,
      encryptionConfigured: mfaEncryptionConfigured,
      enforcementEnabled: mfaEnforced,
      enrollmentRequired: Boolean(session.mfaEnrollmentRequired),
      challengeRequired: Boolean(mfaEnforced && enabled && (session.mfaChallengeRequired || !verified)),
      verified,
      verifiedAt: verified ? session.mfaVerifiedAt || "" : "",
      expiresAt: verified ? session.mfaExpiresAt || "" : "",
      recoveryCodesRemaining: Array.isArray(account.mfa?.recoveryCodeHashes) ? account.mfa.recoveryCodeHashes.length : 0,
      enrolledAt: account.mfa?.enrolledAt || ""
    };
  }

  async function getMfaStatus(userId, token = "") {
    const [accounts, sessions] = await Promise.all([
      readStore(accountsFile, "user_accounts"),
      readStore(sessionsFile, "auth_sessions")
    ]);
    const account = accounts.items.find((item) => item.userId === userId && item.status === "active");
    if (!account || account.role !== "admin") throw new AuthError("AUTH_MFA_ADMIN_REQUIRED", "MFA is available to administrators only.", 403);
    const tokenHash = token ? secureHash(token) : "";
    const session = sessions.items.find((item) => item.userId === userId && item.tokenHash === tokenHash && !item.revokedAt) || {};
    return {
      mfa: publicMfaSession(account, session),
      policy: {
        sessionMinutes: Math.max(1, Math.round(mfaSessionTtlMs / 60000)),
        accountMaxFailures: policies.mfa_challenge.account.maxAttempts,
        ipMaxFailures: policies.mfa_challenge.ip.maxAttempts
      }
    };
  }

  async function startMfaEnrollment(userId, actor = {}, metadata = {}) {
    assertMfaEncryptionReady();
    const secret = generateMfaSecret();
    const result = await mutate(async () => {
      const store = await readStore(accountsFile, "user_accounts");
      const index = store.items.findIndex((item) => item.userId === userId && item.status === "active");
      const account = store.items[index];
      if (!account || account.role !== "admin") throw new AuthError("AUTH_MFA_ADMIN_REQUIRED", "MFA is available to administrators only.", 403);
      if (account.mfa?.status === "enabled") throw new AuthError("AUTH_MFA_ALREADY_ENABLED", "MFA is already enabled.", 409);
      const now = nowIso();
      account.mfa = {
        status: "pending",
        encryptedSecret: encryptCurrentMfaSecret(secret),
        recoveryCodeHashes: [],
        pendingStartedAt: now,
        enrolledAt: "",
        lastVerifiedAt: "",
        updatedAt: now
      };
      account.updatedAt = now;
      account.updatedBy = actor.userId || userId;
      store.items[index] = account;
      await writeStore(accountsFile, store);
      return publicAccount(account);
    });
    await appendAudit({
      eventType: "mfa_enrollment_started",
      outcome: "pending_confirmation",
      actorUserId: actor.userId || userId,
      actorUsername: actor.username,
      actorRole: actor.role || "admin",
      targetUserId: userId,
      details: { issuer: mfaIssuer }
    }, metadata);
    return {
      account: result,
      secret,
      otpauthUri: buildOtpAuthUri({ issuer: mfaIssuer, accountName: result.username, secret }),
      message: "Scan the setup key and confirm a current six-digit code."
    };
  }

  async function registerMfaFailure(account, metadata = {}, reasonCode = "AUTH_MFA_CODE_INVALID") {
    const identities = rateIdentities(account.username, metadata.ip);
    const block = await registerRateAttempt("mfa_challenge", identities);
    await appendAudit({
      eventType: block ? "mfa_challenge_blocked" : "mfa_challenge_failed",
      outcome: block ? "blocked" : "failed",
      actorUserId: account.userId,
      actorUsername: account.username,
      actorRole: account.role,
      targetUserId: account.userId,
      reasonCode: block ? "AUTH_MFA_LOCKED" : reasonCode,
      details: block ? { scope: block.scope, retryAfterSeconds: block.retryAfterSeconds } : {}
    }, metadata);
    if (block) {
      const error = new AuthError("AUTH_MFA_LOCKED", "Too many MFA attempts. Try again later or ask another administrator to unlock the account.", 429);
      error.retryAfterSeconds = block.retryAfterSeconds;
      throw error;
    }
    throw new AuthError(reasonCode, "The authentication code is not valid.", 401);
  }

  async function assertMfaAttemptAllowed(account, metadata = {}) {
    const block = await currentRateBlock("mfa_challenge", rateIdentities(account.username, metadata.ip));
    if (!block) return;
    await appendAudit({
      eventType: "mfa_challenge_blocked",
      outcome: "blocked",
      actorUserId: account.userId,
      actorUsername: account.username,
      actorRole: account.role,
      targetUserId: account.userId,
      reasonCode: "AUTH_MFA_LOCKED",
      details: { scope: block.scope, retryAfterSeconds: block.retryAfterSeconds }
    }, metadata);
    const error = new AuthError("AUTH_MFA_LOCKED", "Too many MFA attempts. Try again later or ask another administrator to unlock the account.", 429);
    error.retryAfterSeconds = block.retryAfterSeconds;
    throw error;
  }

  async function confirmMfaEnrollment(userId, token, code, actor = {}, metadata = {}) {
    assertMfaEncryptionReady();
    const accounts = await readStore(accountsFile, "user_accounts");
    const account = accounts.items.find((item) => item.userId === userId && item.status === "active");
    if (!account || account.role !== "admin" || account.mfa?.status !== "pending") {
      throw new AuthError("AUTH_MFA_ENROLLMENT_NOT_PENDING", "No MFA enrollment is waiting for confirmation.", 409);
    }
    await assertMfaAttemptAllowed(account, metadata);
    let valid = false;
    try {
      valid = verifyTotp(decryptStoredMfaSecret(account.mfa.encryptedSecret).secret, code);
    } catch {
      throw new AuthError("AUTH_MFA_SECRET_UNAVAILABLE", "The stored MFA setup cannot be verified. Start enrollment again.", 409);
    }
    if (!valid) return registerMfaFailure(account, metadata);

    const recoveryCodes = generateRecoveryCodes();
    const expectedCiphertext = account.mfa.encryptedSecret?.ciphertext || "";
    const now = new Date();
    const result = await mutate(async () => {
      const [accountStore, sessionStore] = await Promise.all([
        readStore(accountsFile, "user_accounts"),
        readStore(sessionsFile, "auth_sessions")
      ]);
      const accountIndex = accountStore.items.findIndex((item) => item.userId === userId && item.mfa?.status === "pending");
      const sessionIndex = sessionStore.items.findIndex((item) => item.userId === userId && item.tokenHash === secureHash(token) && !item.revokedAt);
      if (accountIndex < 0 || sessionIndex < 0) throw new AuthError("AUTH_SESSION_REQUIRED", "A current administrator session is required.", 401);
      const current = accountStore.items[accountIndex];
      if (!expectedCiphertext || current.mfa.encryptedSecret?.ciphertext !== expectedCiphertext) {
        throw new AuthError("AUTH_MFA_ENROLLMENT_CHANGED", "The MFA enrollment changed. Confirm the latest setup key.", 409);
      }
      current.mfa = {
        ...current.mfa,
        status: "enabled",
        recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
        pendingStartedAt: "",
        enrolledAt: now.toISOString(),
        lastVerifiedAt: now.toISOString(),
        recoveryCodesGeneratedAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      current.updatedAt = now.toISOString();
      accountStore.items[accountIndex] = current;
      sessionStore.items[sessionIndex] = {
        ...sessionStore.items[sessionIndex],
        mfaChallengeRequired: false,
        mfaEnrollmentRequired: false,
        mfaVerifiedAt: now.toISOString(),
        mfaExpiresAt: new Date(now.getTime() + mfaSessionTtlMs).toISOString()
      };
      await Promise.all([writeStore(accountsFile, accountStore), writeStore(sessionsFile, sessionStore)]);
      return { account: publicAccount(current), rawAccount: current, session: sessionStore.items[sessionIndex] };
    });
    await clearAccountRate("mfa_challenge", account.username);
    await appendAudit({
      eventType: "mfa_enabled",
      outcome: "succeeded",
      actorUserId: actor.userId || userId,
      actorUsername: actor.username || account.username,
      actorRole: actor.role || "admin",
      targetUserId: userId,
      details: { recoveryCodeCount: recoveryCodes.length }
    }, metadata);
    return { account: result.account, mfa: publicMfaSession(result.rawAccount, result.session), recoveryCodes };
  }

  async function verifyMfaChallenge(token, input = {}, metadata = {}) {
    assertMfaEncryptionReady();
    const tokenHash = secureHash(token);
    const [accounts, sessions] = await Promise.all([
      readStore(accountsFile, "user_accounts"),
      readStore(sessionsFile, "auth_sessions")
    ]);
    const session = sessions.items.find((item) => item.tokenHash === tokenHash && !item.revokedAt && Date.parse(item.expiresAt || "") > Date.now());
    const account = accounts.items.find((item) => item.userId === session?.userId && item.status === "active");
    if (!session || !account) throw new AuthError("AUTH_SESSION_REQUIRED", "A current administrator session is required.", 401);
    if (account.role !== "admin" || account.mfa?.status !== "enabled") throw new AuthError("AUTH_MFA_NOT_ENABLED", "MFA is not enabled for this account.", 409);
    await assertMfaAttemptAllowed(account, metadata);

    const submitted = String(input.code || input.recoveryCode || "").trim();
    const recoveryHash = hashRecoveryCode(submitted);
    const recoveryIndex = (account.mfa.recoveryCodeHashes || []).indexOf(recoveryHash);
    let totpValid = false;
    try {
      totpValid = verifyTotp(decryptStoredMfaSecret(account.mfa.encryptedSecret).secret, submitted);
    } catch {
      throw new AuthError("AUTH_MFA_SECRET_UNAVAILABLE", "The stored MFA setup cannot be verified.", 409);
    }
    if (!totpValid && recoveryIndex < 0) return registerMfaFailure(account, metadata);

    const now = new Date();
    const result = await mutate(async () => {
      const [accountStore, sessionStore] = await Promise.all([
        readStore(accountsFile, "user_accounts"),
        readStore(sessionsFile, "auth_sessions")
      ]);
      const accountIndex = accountStore.items.findIndex((item) => item.userId === account.userId && item.mfa?.status === "enabled");
      const sessionIndex = sessionStore.items.findIndex((item) => item.tokenHash === tokenHash && !item.revokedAt);
      if (accountIndex < 0 || sessionIndex < 0) throw new AuthError("AUTH_SESSION_REQUIRED", "The administrator session is no longer active.", 401);
      const current = accountStore.items[accountIndex];
      if (recoveryIndex >= 0) {
        const currentIndex = (current.mfa.recoveryCodeHashes || []).indexOf(recoveryHash);
        if (currentIndex < 0) throw new AuthError("AUTH_MFA_RECOVERY_CODE_USED", "That recovery code has already been used.", 401);
        current.mfa.recoveryCodeHashes.splice(currentIndex, 1);
      }
      current.mfa.lastVerifiedAt = now.toISOString();
      current.mfa.updatedAt = now.toISOString();
      accountStore.items[accountIndex] = current;
      sessionStore.items[sessionIndex] = {
        ...sessionStore.items[sessionIndex],
        mfaChallengeRequired: false,
        mfaEnrollmentRequired: false,
        mfaVerifiedAt: now.toISOString(),
        mfaExpiresAt: new Date(now.getTime() + mfaSessionTtlMs).toISOString()
      };
      await Promise.all([writeStore(accountsFile, accountStore), writeStore(sessionsFile, sessionStore)]);
      return { account: current, session: sessionStore.items[sessionIndex] };
    });
    await clearAccountRate("mfa_challenge", account.username);
    await appendAudit({
      eventType: recoveryIndex >= 0 ? "mfa_recovery_code_used" : "mfa_challenge_succeeded",
      outcome: "succeeded",
      actorUserId: account.userId,
      actorUsername: account.username,
      actorRole: account.role,
      targetUserId: account.userId,
      authType: recoveryIndex >= 0 ? "recovery_code" : "totp",
      details: { recoveryCodesRemaining: result.account.mfa.recoveryCodeHashes.length }
    }, metadata);
    if (session.mfaChallengeRequired) {
      await appendAudit({
        eventType: "login_succeeded",
        outcome: "succeeded",
        actorUserId: account.userId,
        actorUsername: account.username,
        actorRole: account.role,
        authType: "session_mfa",
        details: { mfaVerified: true }
      }, metadata);
    }
    return { authenticated: true, account: publicAccount(result.account), mfa: publicMfaSession(result.account, result.session) };
  }

  async function regenerateMfaRecoveryCodes(userId, actor = {}, metadata = {}) {
    const recoveryCodes = generateRecoveryCodes();
    const account = await mutate(async () => {
      const store = await readStore(accountsFile, "user_accounts");
      const index = store.items.findIndex((item) => item.userId === userId && item.status === "active" && item.mfa?.status === "enabled");
      if (index < 0) throw new AuthError("AUTH_MFA_NOT_ENABLED", "MFA is not enabled for this account.", 409);
      const now = nowIso();
      store.items[index].mfa.recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);
      store.items[index].mfa.recoveryCodesGeneratedAt = now;
      store.items[index].mfa.updatedAt = now;
      store.items[index].updatedAt = now;
      await writeStore(accountsFile, store);
      return publicAccount(store.items[index]);
    });
    await appendAudit({
      eventType: "mfa_recovery_codes_regenerated",
      outcome: "succeeded",
      actorUserId: actor.userId || userId,
      actorUsername: actor.username,
      actorRole: actor.role || "admin",
      targetUserId: userId,
      details: { recoveryCodeCount: recoveryCodes.length }
    }, metadata);
    return { account, recoveryCodes };
  }

  async function disableMfa(userId, password, code, actor = {}, metadata = {}) {
    assertMfaEncryptionReady();
    const accounts = await readStore(accountsFile, "user_accounts");
    const account = accounts.items.find((item) => item.userId === userId && item.status === "active");
    if (!account || account.role !== "admin" || account.mfa?.status !== "enabled") throw new AuthError("AUTH_MFA_NOT_ENABLED", "MFA is not enabled for this account.", 409);
    await assertMfaAttemptAllowed(account, metadata);
    const passwordValid = await verifyPassword(password, account.passwordHash);
    let codeValid = false;
    try {
      codeValid = verifyTotp(decryptStoredMfaSecret(account.mfa.encryptedSecret).secret, code)
        || (account.mfa.recoveryCodeHashes || []).includes(hashRecoveryCode(code));
    } catch {}
    if (!passwordValid || !codeValid) return registerMfaFailure(account, metadata, "AUTH_MFA_DISABLE_CONFIRMATION_INVALID");

    const revokedSessions = await mutate(async () => {
      const [accountStore, sessionStore] = await Promise.all([
        readStore(accountsFile, "user_accounts"),
        readStore(sessionsFile, "auth_sessions")
      ]);
      const index = accountStore.items.findIndex((item) => item.userId === userId);
      if (index < 0) throw new AuthError("AUTH_ACCOUNT_NOT_FOUND", "The account was not found.", 404);
      const now = nowIso();
      accountStore.items[index].mfa = { status: "disabled", updatedAt: now };
      accountStore.items[index].updatedAt = now;
      let count = 0;
      sessionStore.items = sessionStore.items.map((item) => {
        if (item.userId !== userId || item.revokedAt) return item;
        count += 1;
        return { ...item, revokedAt: now, revokeReason: "mfa_disabled" };
      });
      await Promise.all([writeStore(accountsFile, accountStore), writeStore(sessionsFile, sessionStore)]);
      return count;
    });
    await clearAccountRate("mfa_challenge", account.username);
    await appendAudit({
      eventType: "mfa_disabled",
      outcome: "succeeded",
      actorUserId: actor.userId || userId,
      actorUsername: actor.username || account.username,
      actorRole: actor.role || "admin",
      targetUserId: userId,
      details: { revokedSessions }
    }, metadata);
    return { disabled: true, revokedSessions };
  }

  async function recordMfaStepUpDenied(context = {}, metadata = {}, reasonCode = "AUTH_MFA_REQUIRED") {
    return appendAudit({
      eventType: "mfa_step_up_denied",
      outcome: "denied",
      actorUserId: context.userId,
      actorUsername: context.username,
      actorRole: context.role,
      targetUserId: context.userId,
      reasonCode,
      details: { method: metadata.method || "", sensitiveOperation: true }
    }, metadata);
  }

  async function logout(token, metadata = {}) {
    if (!token) return { revoked: false };
    const result = await mutate(async () => {
      const [store, accounts] = await Promise.all([
        readStore(sessionsFile, "auth_sessions"),
        readStore(accountsFile, "user_accounts")
      ]);
      const tokenHash = secureHash(token);
      const index = store.items.findIndex((item) => item.tokenHash === tokenHash && !item.revokedAt);
      if (index < 0) return { revoked: false };
      const session = store.items[index];
      const account = accounts.items.find((item) => item.userId === session.userId);
      store.items[index] = { ...session, revokedAt: nowIso(), revokeReason: "logout" };
      await writeStore(sessionsFile, store);
      return { revoked: true, account: account ? publicAccount(account) : null };
    });
    if (result.revoked) {
      await appendAudit({
        eventType: "logout",
        outcome: "succeeded",
        actorUserId: result.account?.userId,
        actorUsername: result.account?.username,
        actorRole: result.account?.role,
        authType: "session"
      }, metadata);
    }
    return { revoked: result.revoked };
  }

  async function listAccounts() {
    const store = await readStore(accountsFile, "user_accounts");
    const items = store.items.map(publicAccount).sort((a, b) => a.username.localeCompare(b.username));
    return {
      version: store.version,
      name: store.name,
      updatedAt: store.updatedAt,
      items,
      summary: {
        total: items.length,
        active: items.filter((item) => item.status === "active").length,
        admins: items.filter((item) => item.role === "admin" && item.status === "active").length,
        businesses: items.filter((item) => item.role === "business" && item.status === "active").length
      }
    };
  }

  async function upsertAccount(payload = {}, actor = {}) {
    const result = await mutate(async () => {
      const store = await readStore(accountsFile, "user_accounts");
      const username = normalizeUsername(payload.username);
      if (!username || !/^[a-z0-9][a-z0-9._@+-]{2,119}$/.test(username)) {
        throw new AuthError("AUTH_USERNAME_INVALID", "Enter a valid username.");
      }
      const requestedId = String(payload.userId || "").trim();
      let index = requestedId
        ? store.items.findIndex((item) => item.userId === requestedId)
        : store.items.findIndex((item) => item.username === username);
      const existing = index >= 0 ? store.items[index] : null;
      if (payload.createOnly && existing) {
        throw new AuthError("AUTH_INVITE_ACCOUNT_EXISTS", "An account already exists for this invitation.", 409);
      }
      if (store.items.some((item, itemIndex) => itemIndex !== index && item.username === username)) {
        throw new AuthError("AUTH_USERNAME_EXISTS", "That username is already in use.", 409);
      }
      if (!existing && !payload.password) throw new AuthError("AUTH_PASSWORD_REQUIRED", "A password is required for a new account.");
      const now = nowIso();
      const role = normalizeRole(payload.role || existing?.role);
      const status = ["active", "disabled"].includes(payload.status) ? payload.status : existing?.status || "active";
      const next = {
        ...(existing || {}),
        userId: existing?.userId || randomId("usr"),
        username,
        displayName: String(payload.displayName ?? existing?.displayName ?? username).trim() || username,
        role,
        companyIds: role === "admin" ? [] : normalizeCompanyIds(payload.companyIds ?? existing?.companyIds),
        status,
        createdAt: existing?.createdAt || now,
        createdBy: existing?.createdBy || actor.userId || "admin",
        updatedAt: now,
        updatedBy: actor.userId || "admin"
      };
      if (payload.password) {
        next.passwordHash = await hashPassword(payload.password);
        next.passwordChangedAt = now;
        next.mustResetPassword = false;
      }

      const activeAdmins = store.items.filter((item) => item.role === "admin" && item.status === "active").length;
      const removesActiveAdmin = existing?.role === "admin" && existing?.status === "active" && (next.role !== "admin" || next.status !== "active");
      if (removesActiveAdmin && activeAdmins <= 1) {
        throw new AuthError("AUTH_LAST_ADMIN_REQUIRED", "At least one active administrator account must remain.", 409);
      }
      if (!existing && activeAdmins === 0 && !(next.role === "admin" && next.status === "active")) {
        throw new AuthError("AUTH_FIRST_ACCOUNT_ADMIN_REQUIRED", "Create an active administrator account first.", 409);
      }

      const changedFields = existing
        ? ["username", "displayName", "role", "companyIds", "status"]
          .filter((field) => JSON.stringify(existing[field] ?? null) !== JSON.stringify(next[field] ?? null))
        : ["username", "displayName", "role", "companyIds", "status"];
      if (payload.password) changedFields.push("password");
      const permissionChanged = !existing || changedFields.some((field) => ["role", "companyIds", "status"].includes(field));
      const revokeForSecurityChange = Boolean(existing) && changedFields.some((field) => ["username", "role", "companyIds", "status", "password"].includes(field));

      if (index >= 0) store.items[index] = next;
      else {
        index = store.items.length;
        store.items.push(next);
      }
      await writeStore(accountsFile, store);
      const revokedSessions = revokeForSecurityChange
        ? await revokeAccountSessions(next.userId, next.status === "disabled" ? "account_disabled" : "account_security_updated")
        : 0;
      return {
        account: publicAccount(next),
        created: !existing,
        changedFields,
        permissionChanged,
        passwordChanged: Boolean(payload.password),
        revokedSessions
      };
    });

    const auditBase = {
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: actor.role,
      targetUserId: result.account.userId,
      targetUsername: result.account.username,
      outcome: "succeeded",
      details: {
        changedFields: result.changedFields,
        targetRole: result.account.role,
        targetStatus: result.account.status,
        companyCount: result.account.companyIds.length,
        revokedSessions: result.revokedSessions
      }
    };
    await appendAudit({ ...auditBase, eventType: result.created ? "account_created" : "account_updated" }, actor);
    if (result.permissionChanged) await appendAudit({ ...auditBase, eventType: "permission_changed" }, actor);
    if (result.passwordChanged) await appendAudit({ ...auditBase, eventType: "password_changed", reasonCode: "admin_change" }, actor);
    return { account: result.account, created: result.created };
  }

  async function revokeAccountSessions(userId, reason = "revoked") {
    const store = await readStore(sessionsFile, "auth_sessions");
    let count = 0;
    store.items = store.items.map((item) => {
      if (item.userId !== userId || item.revokedAt) return item;
      count += 1;
      return { ...item, revokedAt: nowIso(), revokeReason: reason };
    });
    if (count) await writeStore(sessionsFile, store);
    return count;
  }

  async function requestPasswordReset(username, metadata = {}) {
    const normalized = normalizeUsername(username);
    const selfService = !metadata.requestedBy || metadata.requestedBy === "self_service";
    if (selfService) {
      const identities = rateIdentities(normalized, metadata.ip);
      const existingBlock = await currentRateBlock("password_reset", identities);
      const newBlock = existingBlock || await registerRateAttempt("password_reset", identities);
      if (newBlock) {
        await appendAudit({
          eventType: "password_reset_blocked",
          outcome: "blocked",
          targetUsername: normalized,
          reasonCode: "AUTH_RESET_RATE_LIMITED",
          details: { scope: newBlock.scope, retryAfterSeconds: newBlock.retryAfterSeconds }
        }, metadata);
        return { accepted: true, rateLimited: true, token: "", request: null };
      }
    }
    const accounts = await readStore(accountsFile, "user_accounts");
    const account = accounts.items.find((item) => item.username === normalized && item.status === "active");
    if (!account) {
      await appendAudit({
        eventType: "password_reset_requested",
        outcome: "accepted",
        actorUserId: metadata.requestedBy === "self_service" ? "" : metadata.requestedBy,
        actorUsername: metadata.actorUsername,
        actorRole: metadata.actorRole,
        targetUsername: normalized,
        reasonCode: "account_not_found_or_inactive"
      }, metadata);
      return { accepted: true, token: "", request: null };
    }
    const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString("base64url");
    const now = new Date();
    const request = {
      resetId: randomId("rst"),
      tokenHash: secureHash(token),
      userId: account.userId,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + resetTtlMs).toISOString(),
      usedAt: "",
      cancelledAt: "",
      requestedBy: metadata.requestedBy || "self_service"
    };
    await mutate(async () => {
      const store = await readStore(resetsFile, "password_reset_requests");
      store.items = store.items
        .filter((item) => Date.parse(item.expiresAt || "") > now.getTime() || item.usedAt)
        .map((item) => item.userId === account.userId && !item.usedAt ? { ...item, cancelledAt: now.toISOString() } : item);
      store.items.push(request);
      await writeStore(resetsFile, store);
    });
    await appendAudit({
      eventType: "password_reset_requested",
      outcome: "accepted",
      actorUserId: metadata.requestedBy === "self_service" ? "" : metadata.requestedBy,
      actorUsername: metadata.actorUsername,
      actorRole: metadata.actorRole,
      targetUserId: account.userId,
      targetUsername: account.username,
      reasonCode: selfService ? "self_service" : "administrator_issued"
    }, metadata);
    return {
      accepted: true,
      token,
      request: {
        resetId: request.resetId,
        userId: request.userId,
        username: account.username,
        requestedAt: request.requestedAt,
        expiresAt: request.expiresAt,
        status: "pending"
      }
    };
  }

  async function confirmPasswordReset(token, newPassword, metadata = {}) {
    validatePassword(newPassword);
    try {
      const result = await mutate(async () => {
        const [resets, accounts] = await Promise.all([
          readStore(resetsFile, "password_reset_requests"),
          readStore(accountsFile, "user_accounts")
        ]);
        const now = new Date();
        const resetIndex = resets.items.findIndex((item) =>
          item.tokenHash === secureHash(token) &&
          !item.usedAt &&
          !item.cancelledAt &&
          Date.parse(item.expiresAt || "") > now.getTime()
        );
        if (resetIndex < 0) throw new AuthError("AUTH_RESET_INVALID", "The reset link is invalid or expired.", 400);
        const reset = resets.items[resetIndex];
        const accountIndex = accounts.items.findIndex((item) => item.userId === reset.userId && item.status === "active");
        if (accountIndex < 0) throw new AuthError("AUTH_RESET_INVALID", "The reset link is invalid or expired.", 400);
        accounts.items[accountIndex] = {
          ...accounts.items[accountIndex],
          passwordHash: await hashPassword(newPassword),
          passwordChangedAt: now.toISOString(),
          mustResetPassword: false,
          updatedAt: now.toISOString(),
          updatedBy: "password_reset"
        };
        resets.items[resetIndex] = { ...reset, usedAt: now.toISOString() };
        await Promise.all([writeStore(accountsFile, accounts), writeStore(resetsFile, resets)]);
        const revokedSessions = await revokeAccountSessions(reset.userId, "password_reset");
        return { reset: true, account: publicAccount(accounts.items[accountIndex]), revokedSessions };
      });
      await clearAccountRate("login", result.account.username);
      await appendAudit({
        eventType: "password_changed",
        outcome: "succeeded",
        targetUserId: result.account.userId,
        targetUsername: result.account.username,
        reasonCode: "password_reset",
        details: { revokedSessions: result.revokedSessions }
      }, metadata);
      return { reset: true, account: result.account };
    } catch (error) {
      await appendAudit({
        eventType: "password_change_failed",
        outcome: "failed",
        reasonCode: error.code || "AUTH_RESET_INVALID"
      }, metadata);
      throw error;
    }
  }

  async function listPasswordResetRequests() {
    const [resets, accounts] = await Promise.all([
      readStore(resetsFile, "password_reset_requests"),
      readStore(accountsFile, "user_accounts")
    ]);
    const accountById = new Map(accounts.items.map((item) => [item.userId, item]));
    const now = Date.now();
    const items = resets.items.map((item) => ({
      resetId: item.resetId,
      userId: item.userId,
      username: accountById.get(item.userId)?.username || "",
      requestedAt: item.requestedAt,
      expiresAt: item.expiresAt,
      usedAt: item.usedAt || "",
      cancelledAt: item.cancelledAt || "",
      status: item.usedAt ? "used" : item.cancelledAt ? "cancelled" : Date.parse(item.expiresAt || "") <= now ? "expired" : "pending",
      requestedBy: item.requestedBy || "",
      deliveryStatus: item.deliveryStatus || "pending",
      deliveryMode: item.deliveryMode || "",
      deliveryProvider: item.deliveryProvider || "",
      deliveryId: item.deliveryId || "",
      providerDeliveryId: item.providerDeliveryId || "",
      deliveryQueueStatus: item.deliveryQueueStatus || "",
      lastDeliveryAt: item.lastDeliveryAt || ""
    }));
    return { items: items.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt))) };
  }

  async function recordPasswordResetDelivery(resetId, delivery = {}) {
    return mutate(async () => {
      const store = await readStore(resetsFile, "password_reset_requests");
      const index = store.items.findIndex((item) => item.resetId === String(resetId || ""));
      if (index < 0) return { updated: false };
      store.items[index] = {
        ...store.items[index],
        deliveryStatus: auditText(delivery.status || "pending", 40),
        deliveryMode: auditText(delivery.mode, 20),
        deliveryProvider: auditText(delivery.provider, 80),
        deliveryId: auditText(delivery.deliveryId, 120),
        providerDeliveryId: auditText(delivery.providerDeliveryId, 180),
        deliveryQueueStatus: auditText(delivery.queueStatus, 40),
        deliveryErrorCode: auditText(delivery.errorCode, 100),
        lastDeliveryAt: delivery.completedAt || nowIso()
      };
      await writeStore(resetsFile, store);
      return { updated: true };
    });
  }

  function invitationIdentities(token, username, ip) {
    const subject = normalizeUsername(username) || `invite_${secureHash(token).slice(0, 32)}`;
    return rateIdentities(subject, ip);
  }

  function assertInviteEmail(username) {
    const normalized = normalizeUsername(username);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 160) {
      throw new AuthError("AUTH_INVITE_EMAIL_INVALID", "Enter a valid email address for the invitation.");
    }
    return normalized;
  }

  async function issueInvitation(payload = {}, actor = {}, metadata = {}, internal = {}) {
    const username = assertInviteEmail(payload.username);
    const role = normalizeRole(payload.role);
    const companyIds = role === "admin" ? [] : normalizeCompanyIds(payload.companyIds);
    if (role === "business" && !companyIds.length) {
      throw new AuthError("AUTH_INVITE_COMPANY_REQUIRED", "Assign at least one company_id to a business invitation.");
    }
    const identities = rateIdentities(username, metadata.ip);
    const existingBlock = await currentRateBlock("invitation_delivery", identities);
    const newBlock = existingBlock || await registerRateAttempt("invitation_delivery", identities);
    if (newBlock) {
      await appendAudit({
        eventType: "invitation_delivery_blocked",
        outcome: "blocked",
        actorUserId: actor.userId,
        actorUsername: actor.username,
        actorRole: actor.role,
        targetUsername: username,
        reasonCode: "AUTH_INVITE_RATE_LIMITED",
        details: { scope: newBlock.scope, retryAfterSeconds: newBlock.retryAfterSeconds }
      }, metadata);
      const error = new AuthError("AUTH_INVITE_RATE_LIMITED", "Too many invitations were issued for this target. Try again later.", 429);
      error.retryAfterSeconds = newBlock.retryAfterSeconds;
      throw error;
    }

    const token = crypto.randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
    const result = await mutate(async () => {
      const [accounts, invites] = await Promise.all([
        readStore(accountsFile, "user_accounts"),
        readStore(invitesFile, "account_invitations")
      ]);
      if (accounts.items.some((item) => item.username === username)) {
        throw new AuthError("AUTH_INVITE_ACCOUNT_EXISTS", "An account already exists for this email address.", 409);
      }
      const now = new Date();
      const pending = invites.items.filter((item) => item.username === username && invitationStatus(item, now.getTime()) === "pending");
      if (pending.length && !internal.reissueOf) {
        throw new AuthError("AUTH_INVITE_PENDING_EXISTS", "A pending invitation already exists for this email address.", 409);
      }
      if (internal.reissueOf) {
        invites.items = invites.items.map((item) => {
          if (item.username !== username || invitationStatus(item, now.getTime()) !== "pending") return item;
          return { ...item, supersededAt: now.toISOString(), supersededBy: actor.userId || "admin" };
        });
      }
      const invite = {
        inviteId: randomId("inv"),
        tokenHash: secureHash(token),
        username,
        displayName: auditText(payload.displayName || username, 160) || username,
        role,
        companyIds,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + inviteTtlMs).toISOString(),
        issuedBy: actor.userId || "admin",
        acceptedAt: "",
        cancelledAt: "",
        supersededAt: "",
        consumedAt: "",
        processingAt: "",
        activationFailedAt: "",
        reissuedFromInviteId: internal.reissueOf || "",
        reissueCount: Number(internal.reissueCount || 0),
        deliveryStatus: "pending",
        deliveryMode: "",
        deliveryProvider: "",
        lastDeliveryAt: ""
      };
      invites.items.push(invite);
      await writeStore(invitesFile, invites);
      return invite;
    });
    await appendAudit({
      eventType: internal.reissueOf ? "invitation_reissued" : "invitation_issued",
      outcome: "succeeded",
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: actor.role,
      targetUsername: result.username,
      reasonCode: internal.reissueOf ? "administrator_reissue" : "administrator_issue",
      details: { inviteId: result.inviteId, targetRole: result.role, companyCount: result.companyIds.length }
    }, metadata);
    return { invitation: publicInvitation(result), token };
  }

  async function reissueInvitation(inviteId, actor = {}, metadata = {}) {
    const store = await readStore(invitesFile, "account_invitations");
    const source = store.items.find((item) => item.inviteId === String(inviteId || ""));
    if (!source) throw new AuthError("AUTH_INVITE_NOT_FOUND", "The invitation was not found.", 404);
    if (source.acceptedAt) throw new AuthError("AUTH_INVITE_ALREADY_ACCEPTED", "An accepted invitation cannot be reissued.", 409);
    return issueInvitation({
      username: source.username,
      displayName: source.displayName,
      role: source.role,
      companyIds: source.companyIds
    }, actor, metadata, {
      reissueOf: source.inviteId,
      reissueCount: Number(source.reissueCount || 0) + 1
    });
  }

  async function cancelInvitation(inviteId, actor = {}, metadata = {}) {
    const result = await mutate(async () => {
      const store = await readStore(invitesFile, "account_invitations");
      const index = store.items.findIndex((item) => item.inviteId === String(inviteId || ""));
      if (index < 0) throw new AuthError("AUTH_INVITE_NOT_FOUND", "The invitation was not found.", 404);
      const current = store.items[index];
      if (["accepted", "cancelled", "superseded"].includes(invitationStatus(current))) {
        throw new AuthError("AUTH_INVITE_NOT_CANCELLABLE", "This invitation can no longer be cancelled.", 409);
      }
      store.items[index] = { ...current, cancelledAt: nowIso(), cancelledBy: actor.userId || "admin" };
      await writeStore(invitesFile, store);
      return store.items[index];
    });
    await appendAudit({
      eventType: "invitation_cancelled",
      outcome: "succeeded",
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: actor.role,
      targetUsername: result.username,
      details: { inviteId: result.inviteId }
    }, metadata);
    return { invitation: publicInvitation(result) };
  }

  async function recordInvitationDelivery(inviteId, delivery = {}) {
    return mutate(async () => {
      const store = await readStore(invitesFile, "account_invitations");
      const index = store.items.findIndex((item) => item.inviteId === String(inviteId || ""));
      if (index < 0) return { updated: false };
      store.items[index] = {
        ...store.items[index],
        deliveryStatus: auditText(delivery.status || "pending", 40),
        deliveryMode: auditText(delivery.mode, 20),
        deliveryProvider: auditText(delivery.provider, 80),
        deliveryId: auditText(delivery.deliveryId, 120),
        providerDeliveryId: auditText(delivery.providerDeliveryId, 180),
        deliveryQueueStatus: auditText(delivery.queueStatus, 40),
        deliveryErrorCode: auditText(delivery.errorCode, 100),
        lastDeliveryAt: delivery.completedAt || nowIso()
      };
      await writeStore(invitesFile, store);
      return { updated: true, invitation: publicInvitation(store.items[index]) };
    });
  }

  async function listInvitations(filters = {}) {
    const store = await readStore(invitesFile, "account_invitations");
    const status = auditText(filters.status, 40);
    const search = normalizeUsername(filters.search);
    const limit = boundedInteger(filters.limit, 200, 1, 500);
    const items = store.items
      .map((item) => publicInvitation(item))
      .filter((item) => !status || item.status === status)
      .filter((item) => !search || [item.username, item.displayName, ...item.companyIds].some((value) => String(value || "").toLowerCase().includes(search)))
      .sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)))
      .slice(0, limit);
    return {
      items,
      summary: {
        total: store.items.length,
        pending: store.items.filter((item) => invitationStatus(item) === "pending").length,
        accepted: store.items.filter((item) => invitationStatus(item) === "accepted").length,
        expired: store.items.filter((item) => invitationStatus(item) === "expired").length,
        cancelled: store.items.filter((item) => ["cancelled", "superseded"].includes(invitationStatus(item))).length,
        deliveryAttention: store.items.filter((item) => ["failed", "retry_required", "review_required", "bounced", "complained"].includes(item.deliveryStatus)).length
      }
    };
  }

  async function inspectInvitation(token, metadata = {}) {
    const tokenValue = String(token || "");
    const store = await readStore(invitesFile, "account_invitations");
    const invite = store.items.find((item) => item.tokenHash === secureHash(tokenValue));
    const identities = invitationIdentities(tokenValue, invite?.username, metadata.ip);
    const existingBlock = await currentRateBlock("invitation_activation", identities);
    if (existingBlock) {
      const error = new AuthError("AUTH_INVITE_ACTIVATION_LOCKED", "Too many activation attempts. Try again later.", 429);
      error.retryAfterSeconds = existingBlock.retryAfterSeconds;
      throw error;
    }
    if (!invite || invitationStatus(invite) !== "pending") {
      const newBlock = await registerRateAttempt("invitation_activation", identities);
      await appendAudit({
        eventType: "invitation_activation_failed",
        outcome: newBlock ? "blocked" : "failed",
        targetUsername: invite?.username || "",
        reasonCode: newBlock ? "AUTH_INVITE_ACTIVATION_LOCKED" : "AUTH_INVITE_INVALID"
      }, metadata);
      if (newBlock) {
        const error = new AuthError("AUTH_INVITE_ACTIVATION_LOCKED", "Too many activation attempts. Try again later.", 429);
        error.retryAfterSeconds = newBlock.retryAfterSeconds;
        throw error;
      }
      throw new AuthError("AUTH_INVITE_INVALID", "The invitation link is invalid, expired, or already used.", 400);
    }
    return { invitation: publicInvitation(invite, { maskUsername: true }) };
  }

  async function acceptInvitation(token, newPassword, metadata = {}) {
    validatePassword(newPassword);
    const tokenValue = String(token || "");
    await inspectInvitation(tokenValue, metadata);
    const consumed = await mutate(async () => {
      const [invites, accounts] = await Promise.all([
        readStore(invitesFile, "account_invitations"),
        readStore(accountsFile, "user_accounts")
      ]);
      const index = invites.items.findIndex((item) => item.tokenHash === secureHash(tokenValue) && invitationStatus(item) === "pending");
      if (index < 0) throw new AuthError("AUTH_INVITE_INVALID", "The invitation link is invalid, expired, or already used.", 400);
      const current = invites.items[index];
      if (accounts.items.some((item) => item.username === current.username)) {
        throw new AuthError("AUTH_INVITE_ACCOUNT_EXISTS", "An account already exists for this invitation.", 409);
      }
      const now = nowIso();
      invites.items[index] = { ...current, consumedAt: now, processingAt: now };
      await writeStore(invitesFile, invites);
      return invites.items[index];
    });

    try {
      const created = await upsertAccount({
        username: consumed.username,
        displayName: consumed.displayName,
        password: newPassword,
        role: consumed.role,
        status: "active",
        companyIds: consumed.companyIds,
        createOnly: true
      }, {
        userId: "invitation_activation",
        username: consumed.username,
        role: "system",
        ip: metadata.ip,
        userAgent: metadata.userAgent,
        requestPath: metadata.requestPath
      });
      const finalized = await mutate(async () => {
        const invites = await readStore(invitesFile, "account_invitations");
        const index = invites.items.findIndex((item) => item.inviteId === consumed.inviteId);
        if (index < 0) throw new AuthError("AUTH_INVITE_NOT_FOUND", "The invitation was not found.", 404);
        invites.items[index] = {
          ...invites.items[index],
          acceptedAt: nowIso(),
          activatedUserId: created.account.userId,
          processingAt: ""
        };
        await writeStore(invitesFile, invites);
        return invites.items[index];
      });
      await clearAccountRate("invitation_activation", consumed.username);
      await appendAudit({
        eventType: "invitation_accepted",
        outcome: "succeeded",
        targetUserId: created.account.userId,
        targetUsername: created.account.username,
        reasonCode: "account_activated",
        details: { inviteId: consumed.inviteId, targetRole: created.account.role, companyCount: created.account.companyIds.length }
      }, metadata);
      return { activated: true, account: created.account, invitation: publicInvitation(finalized) };
    } catch (error) {
      await mutate(async () => {
        const invites = await readStore(invitesFile, "account_invitations");
        const index = invites.items.findIndex((item) => item.inviteId === consumed.inviteId);
        if (index >= 0) {
          invites.items[index] = {
            ...invites.items[index],
            activationFailedAt: nowIso(),
            activationFailureCode: auditText(error.code || "AUTH_INVITE_ACTIVATION_FAILED", 100),
            processingAt: ""
          };
          await writeStore(invitesFile, invites);
        }
      });
      await appendAudit({
        eventType: "invitation_activation_failed",
        outcome: "failed",
        targetUsername: consumed.username,
        reasonCode: error.code || "AUTH_INVITE_ACTIVATION_FAILED",
        details: { inviteId: consumed.inviteId }
      }, metadata);
      throw error;
    }
  }

  async function listSecurityReport(filters = {}) {
    const [audit, security] = await Promise.all([
      readStore(auditFile, "auth_audit_logs"),
      readStore(securityFile, "auth_security_state")
    ]);
    const days = boundedInteger(filters.days, 30, 1, 365);
    const limit = boundedInteger(filters.limit, 100, 1, 500);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const eventType = auditText(filters.eventType, 80);
    const outcome = auditText(filters.outcome, 40);
    const search = normalizeUsername(filters.search);
    const events = audit.items
      .filter((item) => Date.parse(item.occurredAt || "") >= cutoff)
      .filter((item) => !eventType || item.eventType === eventType)
      .filter((item) => !outcome || item.outcome === outcome)
      .filter((item) => !search || [item.actorUsername, item.targetUsername, item.companyId].some((value) => String(value || "").toLowerCase().includes(search)))
      .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)));
    const activeLocks = security.items
      .filter((item) => Date.parse(item.lockedUntil || "") > Date.now())
      .sort((a, b) => String(a.lockedUntil).localeCompare(String(b.lockedUntil)))
      .map((item) => ({
        lockId: item.lockId,
        action: item.action,
        scope: item.scope,
        label: item.label,
        failureCount: Number(item.failureCount || 0),
        firstAttemptAt: item.firstAttemptAt || "",
        lastAttemptAt: item.lastAttemptAt || "",
        lockedUntil: item.lockedUntil || ""
      }));
    const count = (predicate) => events.filter(predicate).length;
    const eventTypeCounts = events.reduce((result, item) => {
      result[item.eventType] = (result[item.eventType] || 0) + 1;
      return result;
    }, {});
    return {
      generatedAt: nowIso(),
      range: { days, from: new Date(cutoff).toISOString() },
      summary: {
        totalEvents: events.length,
        loginSuccesses: count((item) => item.eventType === "login_succeeded"),
        loginFailures: count((item) => ["login_failed", "login_blocked"].includes(item.eventType)),
        blockedEvents: count((item) => item.outcome === "blocked"),
        tenantDenials: count((item) => item.eventType === "tenant_access_denied"),
        accountChanges: count((item) => ["account_created", "account_updated", "permission_changed"].includes(item.eventType)),
        passwordChanges: count((item) => item.eventType === "password_changed"),
        activeLocks: activeLocks.length
      },
      eventTypeCounts,
      policies: {
        login: {
          accountMaxAttempts: policies.login.account.maxAttempts,
          ipMaxAttempts: policies.login.ip.maxAttempts,
          windowMinutes: Math.round(policies.login.account.windowMs / 60000),
          lockMinutes: Math.round(policies.login.account.lockMs / 60000)
        },
        passwordReset: {
          accountMaxRequests: policies.password_reset.account.maxAttempts,
          ipMaxRequests: policies.password_reset.ip.maxAttempts,
          windowMinutes: Math.round(policies.password_reset.account.windowMs / 60000),
          lockMinutes: Math.round(policies.password_reset.account.lockMs / 60000)
        },
        invitation: {
          accountMaxDeliveries: policies.invitation_delivery.account.maxAttempts,
          ipMaxDeliveries: policies.invitation_delivery.ip.maxAttempts,
          activationIpMaxAttempts: policies.invitation_activation.ip.maxAttempts,
          windowMinutes: Math.round(policies.invitation_delivery.account.windowMs / 60000),
          lockMinutes: Math.round(policies.invitation_delivery.account.lockMs / 60000)
        },
        mfa: {
          enforced: mfaEnforced,
          encryptionConfigured: mfaEncryptionConfigured,
          accountMaxAttempts: policies.mfa_challenge.account.maxAttempts,
          ipMaxAttempts: policies.mfa_challenge.ip.maxAttempts,
          sessionMinutes: Math.max(1, Math.round(mfaSessionTtlMs / 60000)),
          windowMinutes: Math.round(policies.mfa_challenge.account.windowMs / 60000),
          lockMinutes: Math.round(policies.mfa_challenge.account.lockMs / 60000)
        }
      },
      locks: activeLocks,
      items: events.slice(0, limit).map((item) => ({
        ...item,
        ipHash: item.ipHash ? item.ipHash.slice(0, 12) : "",
        userAgentHash: item.userAgentHash ? item.userAgentHash.slice(0, 12) : ""
      }))
    };
  }

  async function unlockSecurityLock(lockId, actor = {}, metadata = {}) {
    const normalizedId = auditText(lockId, 120);
    const result = await queueSecurity(async () => {
      const store = await readStore(securityFile, "auth_security_state");
      const index = store.items.findIndex((item) => item.lockId === normalizedId && Date.parse(item.lockedUntil || "") > Date.now());
      if (index < 0) throw new AuthError("AUTH_LOCK_NOT_FOUND", "The active authentication lock was not found.", 404);
      const previous = store.items[index];
      store.items[index] = {
        ...previous,
        attempts: [],
        failureCount: 0,
        lockedUntil: "",
        unlockedAt: nowIso(),
        unlockedBy: actor.userId || "admin"
      };
      await writeStore(securityFile, store);
      return previous;
    });
    await appendAudit({
      eventType: "security_lock_released",
      outcome: "succeeded",
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: actor.role,
      reasonCode: result.action,
      details: { scope: result.scope, label: result.label }
    }, metadata);
    return { unlocked: true, lockId: normalizedId };
  }

  async function recordAudit(event = {}, metadata = {}) {
    return appendAudit(event, metadata);
  }

  async function keyRotationStatus() {
    const [accounts, sessions] = await Promise.all([
      readStore(accountsFile, "user_accounts"),
      readStore(sessionsFile, "auth_sessions")
    ]);
    const encryptedAccounts = accounts.items.filter((item) => item.mfa?.encryptedSecret);
    const mfa = { total: encryptedAccounts.length, current: 0, previous: 0, legacy: 0, unreadable: 0 };
    encryptedAccounts.forEach((account) => {
      const payload = account.mfa.encryptedSecret || {};
      try {
        const decrypted = decryptStoredMfaSecret(payload);
        if (!payload.keyVersion) mfa.legacy += 1;
        if (decrypted.source === "previous") mfa.previous += 1;
        else mfa.current += 1;
      } catch {
        mfa.unreadable += 1;
      }
    });
    return {
      generatedAt: nowIso(),
      csrf: {
        currentConfigured: csrfSecret.length >= 24,
        previousConfigured: previousCsrfSecret.length >= 24,
        previousVerificationActive: keyTransitionActive && previousCsrfSecret.length >= 24
      },
      mfa: {
        ...mfa,
        currentVersion: mfaKeyVersion,
        previousVersion: previousMfaKeyVersion,
        currentConfigured: mfaEncryptionKey.length >= 24,
        previousConfigured: previousMfaEncryptionKey.length >= 24,
        reencryptRequired: mfa.previous + mfa.legacy > 0,
        reencryptBlocked: mfa.unreadable > 0
      },
      sessions: {
        active: sessions.items.filter((item) => !item.revokedAt && Date.parse(item.expiresAt || "") > Date.now()).length,
        total: sessions.items.length
      }
    };
  }

  async function reencryptMfaSecrets(actor = {}, metadata = {}) {
    assertMfaEncryptionReady();
    const result = await mutate(async () => {
      const store = await readStore(accountsFile, "user_accounts");
      let reencrypted = 0;
      let alreadyCurrent = 0;
      const failures = [];
      const nextItems = store.items.map((account) => {
        const payload = account.mfa?.encryptedSecret;
        if (!payload) return account;
        try {
          const decrypted = decryptStoredMfaSecret(payload);
          if (payload.keyVersion === mfaKeyVersion && decrypted.source === "current") {
            alreadyCurrent += 1;
            return account;
          }
          reencrypted += 1;
          return {
            ...account,
            mfa: {
              ...account.mfa,
              encryptedSecret: encryptCurrentMfaSecret(decrypted.secret),
              updatedAt: nowIso()
            },
            updatedAt: nowIso(),
            updatedBy: actor.userId || "key_rotation"
          };
        } catch {
          failures.push(account.userId || "unknown");
          return account;
        }
      });
      if (failures.length) {
        throw new AuthError("AUTH_MFA_KEY_ROTATION_BLOCKED", "One or more MFA records cannot be decrypted with the active key ring.", 409);
      }
      store.items = nextItems;
      if (reencrypted) await writeStore(accountsFile, store);
      return { total: reencrypted + alreadyCurrent, reencrypted, alreadyCurrent, failed: 0, keyVersion: mfaKeyVersion };
    });
    await appendAudit({
      eventType: "security_key_mfa_reencrypted",
      outcome: "succeeded",
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: actor.role,
      details: result
    }, metadata);
    return result;
  }

  async function revokeAllSessions(reason = "security_key_rotated", actor = {}, metadata = {}) {
    const result = await mutate(async () => {
      const store = await readStore(sessionsFile, "auth_sessions");
      const now = nowIso();
      let revoked = 0;
      store.items = store.items.map((item) => {
        if (item.revokedAt || Date.parse(item.expiresAt || "") <= Date.now()) return item;
        revoked += 1;
        return { ...item, revokedAt: now, revokeReason: auditText(reason, 120) || "security_key_rotated" };
      });
      if (revoked) await writeStore(sessionsFile, store);
      return { revoked, revokedAt: now };
    });
    await appendAudit({
      eventType: "security_key_sessions_revoked",
      outcome: "succeeded",
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: actor.role,
      details: { revokedSessions: result.revoked, reason: auditText(reason, 120) }
    }, metadata);
    return result;
  }

  async function securitySmokeStatus(options = {}) {
    const rotationAppliedAt = String(options.rotationAppliedAt || "");
    const actorUserId = String(options.actorUserId || "");
    const rotationAppliedAtMs = Date.parse(rotationAppliedAt);
    const [accounts, sessions, invitations, rotation] = await Promise.all([
      readStore(accountsFile, "user_accounts"),
      readStore(sessionsFile, "auth_sessions"),
      readStore(invitesFile, "account_invitations"),
      keyRotationStatus()
    ]);
    const activeAdmins = accounts.items.filter((item) => item.role === "admin" && item.status === "active");
    const malformedPasswordHashes = accounts.items.filter((item) => {
      const stored = item.passwordHash || {};
      return stored.algorithm !== "scrypt" || !stored.salt || !stored.hash;
    }).length;
    const activeSessions = sessions.items.filter((item) => !item.revokedAt && Date.parse(item.expiresAt || "") > Date.now());
    const preRotationActiveSessions = Number.isFinite(rotationAppliedAtMs)
      ? activeSessions.filter((item) => Date.parse(item.createdAt || "") <= rotationAppliedAtMs).length
      : 0;
    const actorPostRotationSession = Boolean(actorUserId && activeSessions.some((item) => item.userId === actorUserId
      && (!Number.isFinite(rotationAppliedAtMs) || Date.parse(item.createdAt || "") > rotationAppliedAtMs)));
    const csrfFixtureToken = crypto.randomBytes(32).toString("base64url");
    const csrfFixture = csrfTokenForSession(csrfFixtureToken);
    const csrfCurrentVerified = Boolean(csrfFixture) && verifyCsrfToken(csrfFixtureToken, csrfFixture);
    const malformedInvitationHashes = invitations.items.filter((item) => !/^[a-f0-9]{64}$/i.test(String(item.tokenHash || ""))).length;
    const plaintextInvitationCredentials = invitations.items.filter((item) => ["token", "link", "password", "rawToken"]
      .some((key) => Object.prototype.hasOwnProperty.call(item, key) && Boolean(item[key]))).length;
    const invitationFixture = crypto.randomBytes(32).toString("base64url");
    const invitationFixtureHash = secureHash(invitationFixture);
    const invitationHashVerified = /^[a-f0-9]{64}$/i.test(invitationFixtureHash)
      && invitationFixtureHash !== invitationFixture
      && invitationFixtureHash === secureHash(invitationFixture);
    return {
      generatedAt: nowIso(),
      login: {
        passed: activeAdmins.length > 0
          && malformedPasswordHashes === 0
          && preRotationActiveSessions === 0
          && (!actorUserId || actorPostRotationSession),
        activeAdmins: activeAdmins.length,
        malformedPasswordHashes,
        activeSessions: activeSessions.length,
        preRotationActiveSessions,
        actorPostRotationSession,
        rotationAppliedAt
      },
      mfa: {
        passed: rotation.mfa.unreadable === 0 && rotation.mfa.previous === 0 && rotation.mfa.legacy === 0,
        total: rotation.mfa.total,
        current: rotation.mfa.current,
        previous: rotation.mfa.previous,
        legacy: rotation.mfa.legacy,
        unreadable: rotation.mfa.unreadable,
        currentVersion: rotation.mfa.currentVersion
      },
      csrf: {
        passed: csrfCurrentVerified,
        currentConfigured: rotation.csrf.currentConfigured,
        currentSignatureVerified: csrfCurrentVerified,
        previousVerificationActive: rotation.csrf.previousVerificationActive
      },
      invitation: {
        passed: invitationHashVerified && malformedInvitationHashes === 0 && plaintextInvitationCredentials === 0,
        total: invitations.items.length,
        hashPrimitiveVerified: invitationHashVerified,
        malformedTokenHashes: malformedInvitationHashes,
        plaintextCredentialRows: plaintextInvitationCredentials
      }
    };
  }

  return {
    acceptInvitation,
    cancelInvitation,
    confirmMfaEnrollment,
    confirmPasswordReset,
    disableMfa,
    getMfaStatus,
    hasActiveAccounts,
    initializeBootstrap,
    inspectInvitation,
    issueInvitation,
    listAccounts,
    listInvitations,
    listPasswordResetRequests,
    listSecurityReport,
    login,
    logout,
    recordAudit,
    recordMfaStepUpDenied,
    recordInvitationDelivery,
    recordPasswordResetDelivery,
    reissueInvitation,
    regenerateMfaRecoveryCodes,
    requestPasswordReset,
    resolveSession,
    csrfTokenForSession,
    keyRotationStatus,
    reencryptMfaSecrets,
    sessionTtlMs,
    securitySmokeStatus,
    startMfaEnrollment,
    unlockSecurityLock,
    revokeAllSessions,
    upsertAccount,
    verifyCsrfToken,
    verifyMfaChallenge,
    verifyCredentials
  };
}

module.exports = {
  AuthError,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  createAuthService,
  normalizeCompanyIds,
  normalizeUsername,
  publicAccount
};
