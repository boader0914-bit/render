const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const HISTORY_LIMIT = 500;
const EVIDENCE_LIMIT = 100;

const AUTH_SECURITY_V1_LOCK = Object.freeze({
  status: "locked",
  version: "1.0",
  lockedAtStage: 215,
  module: "authentication_security",
  frozenScope: [
    "account, session, and tenant authorization",
    "rate limits and authentication audit",
    "invitation, reset, and email delivery",
    "administrator MFA and recovery codes",
    "CSRF, origin, proxy, and response-header boundary",
    "versioned key rotation, preflight, and post-rotation smoke evidence"
  ],
  allowedOperations: [
    "run key-rotation preflight",
    "apply an approved current key version",
    "run post-rotation security smoke checks",
    "inspect sanitized evidence and recovery guidance",
    "remove previous keys after checklist completion"
  ],
  extensionRule: "Do not add recursive security-quality approval loops after v1.0. Future changes require a concrete vulnerability, compliance requirement, provider migration, or production incident."
});

const RECOVERY_PROCEDURE = Object.freeze([
  { id: "preserve_previous", label: "Keep the previous key ring", action: "Do not remove previous keys or shorten the active transition window while any record is unreadable or a smoke step is failing." },
  { id: "stop_retries", label: "Pause risky retries", action: "Pause manual email retry execution when queue decryption is blocked; keep the encrypted queue file unchanged." },
  { id: "inspect_evidence", label: "Inspect sanitized evidence", action: "Review the latest preflight, rotation history, and post-rotation smoke failure classification without copying key values into notes or logs." },
  { id: "restore_configuration", label: "Restore the last known configuration", action: "Restore the prior current version and secret set from the managed secret store, restart one instance, and rerun preflight." },
  { id: "restore_data_only_if_needed", label: "Restore data only for unreadable envelopes", action: "Use the latest verified DATA_DIR backup only when MFA or retry envelopes remain unreadable with the correct current and previous key ring." },
  { id: "retest_before_resume", label: "Prove recovery", action: "Rerun login, MFA, CSRF, invitation, retry-queue, and webhook smoke checks before resuming provider retries or removing previous keys." }
]);

class AuthKeyRotationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "AuthKeyRotationError";
    this.code = code;
    this.statusCode = statusCode;
    this.publicMessage = message;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeVersion(value, fallback = "") {
  const normalized = String(value || "").trim();
  return /^[a-zA-Z0-9._-]{1,80}$/.test(normalized) ? normalized : fallback;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

async function readState(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      version: Number(parsed.version || 1),
      name: "auth_key_rotation_history",
      activeVersion: safeVersion(parsed.activeVersion),
      appliedAt: String(parsed.appliedAt || ""),
      updatedAt: String(parsed.updatedAt || ""),
      items: Array.isArray(parsed.items) ? parsed.items : [],
      preflightRuns: Array.isArray(parsed.preflightRuns) ? parsed.preflightRuns : [],
      smokeRuns: Array.isArray(parsed.smokeRuns) ? parsed.smokeRuns : []
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: 1, name: "auth_key_rotation_history", activeVersion: "", appliedAt: "", updatedAt: "", items: [], preflightRuns: [], smokeRuns: [] };
    }
    throw error;
  }
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const next = {
    ...state,
    updatedAt: nowIso(),
    items: (state.items || []).slice(-HISTORY_LIMIT),
    preflightRuns: (state.preflightRuns || []).slice(-EVIDENCE_LIMIT),
    smokeRuns: (state.smokeRuns || []).slice(-EVIDENCE_LIMIT)
  };
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
  return next;
}

function createAuthKeyRotationService(options = {}) {
  const historyFile = path.resolve(options.historyFile);
  const authService = options.authService;
  const deliveryService = options.deliveryService;
  const currentVersion = safeVersion(options.currentVersion, "v1");
  const previousVersion = safeVersion(options.previousVersion);
  const transition = {
    configured: Boolean(options.transition?.configured),
    active: Boolean(options.transition?.active),
    valid: Boolean(options.transition?.valid),
    startedAt: String(options.transition?.startedAt || ""),
    until: String(options.transition?.until || ""),
    maxDays: Number(options.transition?.maxDays || 30),
    reason: String(options.transition?.reason || "")
  };
  const maxAgeDays = Math.max(7, Math.min(365, Number(options.maxAgeDays || 90)));
  const keyConfig = Object.fromEntries(Object.entries(options.keyConfig || {}).map(([key, value]) => [key, {
    currentConfigured: Boolean(value?.currentConfigured),
    previousConfigured: Boolean(value?.previousConfigured)
  }]));
  let mutationQueue = Promise.resolve();
  let applyQueue = Promise.resolve();

  function mutate(task) {
    const next = mutationQueue.then(task, task);
    mutationQueue = next.catch(() => {});
    return next;
  }

  async function buildStatus() {
    const [state, auth, delivery] = await Promise.all([
      readState(historyFile),
      authService.keyRotationStatus(),
      deliveryService.keyRotationStatus()
    ]);
    const appliedAtMs = Date.parse(state.appliedAt || "");
    const ageDays = Number.isFinite(appliedAtMs) ? Math.max(0, Math.floor((Date.now() - appliedAtMs) / 86400000)) : null;
    const ageRotationDue = ageDays === null || ageDays >= maxAgeDays;
    const versionChanged = state.activeVersion !== currentVersion;
    const missingCurrentKeys = Object.entries(keyConfig).filter(([, value]) => !value.currentConfigured).map(([key]) => key);
    const previousKeysConfigured = Object.entries(keyConfig).filter(([, value]) => value.previousConfigured).map(([key]) => key);
    const knownVersionTransition = Boolean(state.activeVersion && state.activeVersion !== currentVersion);
    const blockers = [];
    if (missingCurrentKeys.length) blockers.push("current_keys_missing");
    if (transition.configured && !transition.valid) blockers.push("transition_window_invalid");
    if (knownVersionTransition && previousVersion !== state.activeVersion) blockers.push("previous_version_mismatch");
    if (knownVersionTransition && previousKeysConfigured.length !== Object.keys(keyConfig).length) blockers.push("previous_key_ring_incomplete");
    if (knownVersionTransition && !transition.active) blockers.push("transition_window_inactive");
    if (auth.mfa.reencryptBlocked) blockers.push("mfa_record_unreadable");
    if (delivery.queue.reencryptBlocked) blockers.push("retry_queue_unreadable");
    if ((auth.mfa.previous > 0 || delivery.queue.previous > 0) && !transition.active) blockers.push("previous_key_transition_inactive");
    const rotationNeeded = versionChanged || ageRotationDue || auth.mfa.reencryptRequired || delivery.queue.reencryptRequired;
    const preflightRuns = state.preflightRuns.slice().sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
    const smokeRuns = state.smokeRuns.slice().sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
    const latestSmoke = smokeRuns[0] || null;
    const currentSmokePassed = Boolean(latestSmoke
      && latestSmoke.status === "passed"
      && latestSmoke.currentVersion === currentVersion
      && (!state.appliedAt || Date.parse(latestSmoke.generatedAt || "") >= Date.parse(state.appliedAt)));
    const previousRemoved = previousKeysConfigured.length === 0;
    const removalChecklist = [
      { id: "current_version_active", label: "Current version is active", status: state.activeVersion === currentVersion ? "passed" : "pending", detail: `${state.activeVersion || "uninitialized"} -> ${currentVersion}` },
      { id: "post_rotation_smoke", label: "Post-rotation smoke passed", status: currentSmokePassed ? "passed" : "pending", detail: latestSmoke ? `${latestSmoke.status} at ${latestSmoke.generatedAt}` : "No post-rotation smoke evidence." },
      { id: "mfa_current_only", label: "MFA envelopes use the current key", status: auth.mfa.previous + auth.mfa.legacy + auth.mfa.unreadable === 0 ? "passed" : "blocked", detail: `previous ${auth.mfa.previous}, legacy ${auth.mfa.legacy}, unreadable ${auth.mfa.unreadable}` },
      { id: "queue_current_only", label: "Retry envelopes use the current key", status: delivery.queue.previous + delivery.queue.legacy + delivery.queue.unreadable === 0 ? "passed" : "blocked", detail: `previous ${delivery.queue.previous}, legacy ${delivery.queue.legacy}, unreadable ${delivery.queue.unreadable}` },
      { id: "provider_current_signature", label: "Provider sends the current webhook signature", status: "manual_confirmation", detail: "Confirm one provider event signed with the current version before removal." },
      { id: "previous_keys_removed", label: "Previous-key environment variables are removed", status: previousRemoved ? "passed" : "pending", detail: `${previousKeysConfigured.length} previous key(s) remain configured.` },
      { id: "transition_closed", label: "Transition window is closed", status: !transition.active && previousRemoved ? "passed" : "pending", detail: transition.reason || "not_configured" }
    ];
    return {
      role: "admin",
      schema: "auth_key_rotation_v1",
      generatedAt: nowIso(),
      status: blockers.length ? "blocked" : rotationNeeded ? "action_required" : "ready",
      canApply: blockers.length === 0 && rotationNeeded,
      currentVersion,
      previousVersion,
      activeVersion: state.activeVersion,
      rotationNeeded,
      reasons: [
        ...(versionChanged ? ["version_changed"] : []),
        ...(ageRotationDue ? ["maximum_age_reached"] : []),
        ...(auth.mfa.reencryptRequired ? ["mfa_reencryption_required"] : []),
        ...(delivery.queue.reencryptRequired ? ["retry_queue_reencryption_required"] : [])
      ],
      blockers,
      policy: {
        maxAgeDays,
        ageDays,
        transition,
        previousVerificationEnabled: transition.active
      },
      keyConfiguration: Object.fromEntries(Object.entries(keyConfig).map(([key, value]) => [key, {
        ...value,
        currentVersion,
        previousVersion: value.previousConfigured ? previousVersion : "",
        transitionVerificationActive: transition.active && value.previousConfigured
      }])),
      impact: {
        activeSessionsToRevoke: auth.sessions.active,
        mfa: auth.mfa,
        retryQueue: delivery.queue,
        webhook: delivery.webhook
      },
      summary: {
        currentKeysConfigured: Object.values(keyConfig).filter((item) => item.currentConfigured).length,
        requiredCurrentKeys: Object.keys(keyConfig).length,
        previousKeysConfigured: previousKeysConfigured.length,
        activeSessions: auth.sessions.active,
        mfaReencryptRequired: auth.mfa.previous + auth.mfa.legacy,
        queueReencryptRequired: delivery.queue.previous + delivery.queue.legacy,
        unreadableRecords: auth.mfa.unreadable + delivery.queue.unreadable
      },
      preflight: { latest: preflightRuns[0] || null, items: preflightRuns.slice(0, 20) },
      postRotationSmoke: { latest: latestSmoke, items: smokeRuns.slice(0, 20) },
      operations: {
        recoveryProcedure: RECOVERY_PROCEDURE,
        previousKeyRemovalChecklist: removalChecklist,
        previousKeyRemovalReady: removalChecklist.every((item) => ["passed", "manual_confirmation"].includes(item.status))
      },
      lock: AUTH_SECURITY_V1_LOCK,
      history: state.items.slice().sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))).slice(0, 100)
    };
  }

  async function appendEvidence(field, run) {
    return mutate(async () => {
      const state = await readState(historyFile);
      state[field] = [...(state[field] || []), run];
      return writeState(historyFile, state);
    });
  }

  function evidenceSummary(checks = [], blockedStatus = "blocked") {
    const summary = checks.reduce((acc, item) => {
      acc.total += 1;
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, { total: 0, passed: 0, warning: 0, blocked: 0, failed: 0 });
    return {
      ...summary,
      status: summary[blockedStatus] > 0 ? blockedStatus : summary.warning > 0 ? "warning" : "passed"
    };
  }

  async function runPreflight(actor = {}, metadata = {}) {
    const report = await buildStatus();
    const knownVersionTransition = Boolean(report.activeVersion && report.activeVersion !== report.currentVersion);
    const checks = [
      {
        checkId: "current_key_configuration",
        label: "Current key configuration",
        status: report.summary.currentKeysConfigured === report.summary.requiredCurrentKeys ? "passed" : "blocked",
        detail: `${report.summary.currentKeysConfigured}/${report.summary.requiredCurrentKeys} current key(s) configured.`
      },
      {
        checkId: "version_lineage",
        label: "Version lineage",
        status: knownVersionTransition && report.previousVersion !== report.activeVersion ? "blocked" : "passed",
        detail: `${report.activeVersion || "uninitialized"} -> ${report.currentVersion}; previous ${report.previousVersion || "none"}.`
      },
      {
        checkId: "transition_window",
        label: "Bounded transition window",
        status: knownVersionTransition && (!report.policy.transition.valid || !report.policy.transition.active) ? "blocked" : "passed",
        detail: knownVersionTransition ? `Transition ${report.policy.transition.reason}; maximum ${report.policy.transition.maxDays} day(s).` : "Initial activation does not require a previous-key window."
      },
      {
        checkId: "previous_key_configuration",
        label: "Previous key configuration",
        status: knownVersionTransition && report.summary.previousKeysConfigured !== report.summary.requiredCurrentKeys ? "blocked" : "passed",
        detail: `${report.summary.previousKeysConfigured}/${report.summary.requiredCurrentKeys} previous key(s) configured.`
      },
      {
        checkId: "session_invalidation_impact",
        label: "Session invalidation impact",
        status: report.summary.activeSessions > 0 ? "warning" : "passed",
        detail: `${report.summary.activeSessions} active session(s) will be revoked after successful migration.`
      },
      {
        checkId: "mfa_reencryption",
        label: "MFA re-encryption",
        status: report.impact.mfa.unreadable > 0 ? "blocked" : report.summary.mfaReencryptRequired > 0 ? "warning" : "passed",
        detail: `${report.summary.mfaReencryptRequired} migration target(s), ${report.impact.mfa.unreadable} unreadable.`
      },
      {
        checkId: "retry_queue_reencryption",
        label: "Email retry queue re-encryption",
        status: report.impact.retryQueue.unreadable > 0 ? "blocked" : report.summary.queueReencryptRequired > 0 ? "warning" : "passed",
        detail: `${report.summary.queueReencryptRequired} migration target(s), ${report.impact.retryQueue.unreadable} unreadable, ${report.impact.retryQueue.pending} pending.`
      },
      {
        checkId: "webhook_transition",
        label: "Webhook signature transition",
        status: !report.impact.webhook.currentConfigured || (knownVersionTransition && !report.impact.webhook.previousVerificationActive) ? "blocked" : "passed",
        detail: `Current configured ${report.impact.webhook.currentConfigured}; previous verification ${report.impact.webhook.previousVerificationActive}.`
      }
    ];
    const summary = evidenceSummary(checks);
    const run = {
      runId: randomId("keypre"),
      schema: "auth_key_rotation_preflight_v1",
      generatedAt: nowIso(),
      actorUserId: String(actor.userId || "system").slice(0, 120),
      actorUsername: String(actor.username || "").slice(0, 160),
      currentVersion,
      previousVersion,
      activeVersion: report.activeVersion,
      status: summary.status,
      canApply: report.canApply && summary.blocked === 0,
      summary,
      checks
    };
    await appendEvidence("preflightRuns", run);
    await authService.recordAudit({
      eventType: "security_key_rotation_preflight",
      outcome: run.status === "blocked" ? "blocked" : "succeeded",
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: actor.role,
      reasonCode: run.status,
      details: { blocked: summary.blocked, warning: summary.warning, activeSessions: report.summary.activeSessions }
    }, metadata);
    return { role: "admin", run, report: await buildStatus() };
  }

  async function runPostRotationSmoke(actor = {}, metadata = {}) {
    const state = await readState(historyFile);
    const [auth, delivery] = await Promise.all([
      authService.securitySmokeStatus({ rotationAppliedAt: state.appliedAt, actorUserId: actor.userId }),
      deliveryService.securitySmokeStatus()
    ]);
    const checks = [
      { checkId: "login", label: "Login and session boundary", status: auth.login.passed ? "passed" : "failed", detail: `${auth.login.activeAdmins} active admin(s), actor post-rotation session ${auth.login.actorPostRotationSession}, ${auth.login.preRotationActiveSessions} pre-rotation active session(s), ${auth.login.malformedPasswordHashes} malformed password hash row(s).` },
      { checkId: "mfa", label: "MFA current-key decryption", status: auth.mfa.passed ? "passed" : "failed", detail: `${auth.mfa.current}/${auth.mfa.total} current, ${auth.mfa.previous} previous, ${auth.mfa.legacy} legacy, ${auth.mfa.unreadable} unreadable.` },
      { checkId: "csrf", label: "CSRF current-key signature", status: auth.csrf.passed ? "passed" : "failed", detail: `Current configured ${auth.csrf.currentConfigured}; in-memory signature verified ${auth.csrf.currentSignatureVerified}.` },
      { checkId: "invitation", label: "Invitation credential storage", status: auth.invitation.passed ? "passed" : "failed", detail: `Hash primitive ${auth.invitation.hashPrimitiveVerified}; ${auth.invitation.total} invitation row(s), ${auth.invitation.malformedTokenHashes} malformed hash row(s), ${auth.invitation.plaintextCredentialRows} plaintext credential row(s).` },
      { checkId: "email_retry", label: "Email retry current-key round trip", status: delivery.retryQueue.passed ? "passed" : "failed", detail: `Round trip ${delivery.retryQueue.currentRoundTripVerified}; ${delivery.retryQueue.current}/${delivery.retryQueue.total} current, ${delivery.retryQueue.previous} previous, ${delivery.retryQueue.unreadable} unreadable.` },
      { checkId: "webhook", label: "Webhook signature boundary", status: delivery.webhook.passed ? "passed" : "failed", detail: `Current signature ${delivery.webhook.currentSignatureVerified}; previous accepted ${delivery.webhook.previousSignatureAccepted}; expected ${delivery.webhook.previousAcceptanceExpected}.` },
      { checkId: "rotation_state", label: "Applied version evidence", status: state.activeVersion === currentVersion && Boolean(state.appliedAt) ? "passed" : "failed", detail: `Active ${state.activeVersion || "uninitialized"}; expected ${currentVersion}; applied ${state.appliedAt || "not recorded"}.` }
    ];
    const summary = evidenceSummary(checks, "failed");
    const run = {
      runId: randomId("keysmoke"),
      schema: "auth_security_post_rotation_smoke_v1",
      generatedAt: nowIso(),
      actorUserId: String(actor.userId || "system").slice(0, 120),
      actorUsername: String(actor.username || "").slice(0, 160),
      currentVersion,
      activeVersion: state.activeVersion,
      appliedAt: state.appliedAt,
      status: summary.status,
      summary,
      checks
    };
    await appendEvidence("smokeRuns", run);
    await authService.recordAudit({
      eventType: "auth_security_post_rotation_smoke",
      outcome: run.status === "passed" ? "succeeded" : "failed",
      actorUserId: actor.userId,
      actorUsername: actor.username,
      actorRole: actor.role,
      reasonCode: run.status,
      details: { passed: summary.passed, failed: summary.failed }
    }, metadata);
    return { role: "admin", run, report: await buildStatus() };
  }

  async function appendHistory(event) {
    return mutate(async () => {
      const state = await readState(historyFile);
      state.items.push({
        rotationEventId: randomId("keyrot"),
        eventType: String(event.eventType || "rotation_recorded").slice(0, 80),
        outcome: String(event.outcome || "recorded").slice(0, 40),
        fromVersion: safeVersion(event.fromVersion),
        toVersion: safeVersion(event.toVersion),
        actorUserId: String(event.actorUserId || "system").slice(0, 120),
        actorUsername: String(event.actorUsername || "").slice(0, 160),
        occurredAt: nowIso(),
        details: {
          sessionsRevoked: Number(event.details?.sessionsRevoked || 0),
          mfaReencrypted: Number(event.details?.mfaReencrypted || 0),
          queueReencrypted: Number(event.details?.queueReencrypted || 0),
          reasonCode: String(event.details?.reasonCode || "").slice(0, 120)
        }
      });
      if (event.outcome === "succeeded") {
        state.activeVersion = currentVersion;
        state.appliedAt = nowIso();
      }
      return writeState(historyFile, state);
    });
  }

  async function applyCurrentUnsafe(actor = {}, metadata = {}) {
    const before = await buildStatus();
    if (!before.rotationNeeded) throw new AuthKeyRotationError("AUTH_KEY_ROTATION_NOT_REQUIRED", "The active key version is already current.", 409);
    if (!before.canApply) throw new AuthKeyRotationError("AUTH_KEY_ROTATION_BLOCKED", "The key rotation prerequisites are not complete.", 409);
    try {
      const mfa = await authService.reencryptMfaSecrets(actor, metadata);
      const queue = await deliveryService.reencryptRetryQueue();
      const sessions = await authService.revokeAllSessions("security_key_rotated", actor, metadata);
      await appendHistory({
        eventType: "security_key_rotation_applied",
        outcome: "succeeded",
        fromVersion: before.activeVersion || previousVersion,
        toVersion: currentVersion,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        details: {
          sessionsRevoked: sessions.revoked,
          mfaReencrypted: mfa.reencrypted,
          queueReencrypted: queue.reencrypted
        }
      });
      await authService.recordAudit({
        eventType: "security_key_rotation_applied",
        outcome: "succeeded",
        actorUserId: actor.userId,
        actorUsername: actor.username,
        actorRole: actor.role,
        reasonCode: `${before.activeVersion || "uninitialized"}_to_${currentVersion}`,
        details: {
          sessionsRevoked: sessions.revoked,
          mfaReencrypted: mfa.reencrypted,
          queueReencrypted: queue.reencrypted
        }
      }, metadata);
      return {
        applied: true,
        currentVersion,
        previousVersion,
        sessions,
        mfa,
        queue,
        requiresLogin: sessions.revoked > 0,
        nextRequiredAction: "sign_in_again_and_run_post_rotation_smoke"
      };
    } catch (error) {
      await appendHistory({
        eventType: "security_key_rotation_failed",
        outcome: "failed",
        fromVersion: before.activeVersion || previousVersion,
        toVersion: currentVersion,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        details: { reasonCode: error.code || "rotation_failed" }
      }).catch(() => {});
      throw error;
    }
  }

  function applyCurrent(actor = {}, metadata = {}) {
    const next = applyQueue.then(
      () => applyCurrentUnsafe(actor, metadata),
      () => applyCurrentUnsafe(actor, metadata)
    );
    applyQueue = next.catch(() => {});
    return next;
  }

  return { applyCurrent, runPostRotationSmoke, runPreflight, status: buildStatus };
}

module.exports = { AUTH_SECURITY_V1_LOCK, AuthKeyRotationError, createAuthKeyRotationService, safeVersion };
