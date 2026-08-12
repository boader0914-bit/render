const crypto = require("node:crypto");
const {
  RESULT_SCHEMA,
  normalizeResult,
  safeIdentifier,
  sha256,
  stableJson,
  verifySignedJob
} = require("./v4_fixture_job_contract.cjs");
const {
  TRANSPORT_INTERFACE_VERSION,
  assertTransportInterface
} = require("./v4_fixture_transport.cjs");

const BULLMQ_VERSION = "5.81.2";
const KV_JOB_SCHEMA = "datalab-v4-render-kv-job.v1";
const KV_JOB_NAME = "fixture-parity";
const TERMINAL_RESULT_PREFIX = "DATALAB_V4_RESULT:";
const QUARANTINE_PREFIX = "DATALAB_V4_QUARANTINE:";
const DEFAULT_QUEUE_NAME = "fixture-jobs";
const DEFAULT_QUEUE_PREFIX = "datalab-v4-kv-v1";
const DEFAULT_READY_TIMEOUT_MS = 15 * 1000;
const DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_COMPLETED_COUNT = 1000;
const DEFAULT_FAILED_COUNT = 5000;
const DEFAULT_NONCE_RETENTION_MS = DEFAULT_RETENTION_SECONDS * 1000;

class KeyValueTransportError extends Error {
  constructor(code, stage, message, options = {}) {
    super(message);
    this.name = "KeyValueTransportError";
    this.code = code;
    this.stage = stage;
    this.retryable = options.retryable === true;
  }
}

function configuredInteger(value, name, fallback, min, max) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new KeyValueTransportError("V4_QUEUE_CONFIG_INVALID", "environment", `${name} is invalid.`);
  }
  return parsed;
}

function namespacePart(value, name, fallback) {
  const text = String(value || fallback || "").trim();
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(text)) {
    throw new KeyValueTransportError("V4_QUEUE_NAMESPACE_INVALID", "environment", `${name} is invalid.`);
  }
  return text;
}

function redisConnectionOptions(value) {
  const text = String(value || "");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new KeyValueTransportError("V4_QUEUE_REDIS_URL_INVALID", "environment", "V4_QUEUE_REDIS_URL is invalid.");
  }
  if (!["redis:", "rediss:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new KeyValueTransportError("V4_QUEUE_REDIS_URL_INVALID", "environment", "V4_QUEUE_REDIS_URL must use redis or rediss.");
  }
  const port = parsed.port ? Number(parsed.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new KeyValueTransportError("V4_QUEUE_REDIS_URL_INVALID", "environment", "V4_QUEUE_REDIS_URL port is invalid.");
  }
  const pathname = parsed.pathname.replace(/^\//, "");
  const db = pathname === "" ? 0 : Number(pathname);
  if (!Number.isInteger(db) || db < 0) {
    throw new KeyValueTransportError("V4_QUEUE_REDIS_URL_INVALID", "environment", "V4_QUEUE_REDIS_URL database is invalid.");
  }
  return Object.freeze({
    host: parsed.hostname,
    port,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db,
    tls: parsed.protocol === "rediss:" ? {} : undefined
  });
}

function loadBullMq() {
  let bullmq;
  let metadata;
  try {
    bullmq = require("bullmq");
    metadata = require("bullmq/package.json");
  } catch {
    throw new KeyValueTransportError("V4_QUEUE_LIBRARY_MISSING", "startup", `bullmq ${BULLMQ_VERSION} is required.`);
  }
  if (metadata?.version !== BULLMQ_VERSION) {
    throw new KeyValueTransportError("V4_QUEUE_LIBRARY_VERSION_MISMATCH", "startup", `bullmq must be pinned to ${BULLMQ_VERSION}.`);
  }
  return bullmq;
}

function payloadIdentity(envelope) {
  return sha256(stableJson({
    payloadDigest: envelope.payloadDigest,
    scenario: envelope.scenario,
    requestedCommit: envelope.requestedCommit,
    collectorBlob: envelope.collectorBlob
  }));
}

function deterministicJobId(idempotencyKey) {
  return `job-${sha256(String(idempotencyKey))}`;
}

function nonceIdentity(nonce) {
  return `nonce-${sha256(String(nonce))}`;
}

function terminalError(result) {
  const encoded = Buffer.from(stableJson(normalizeResult(result)), "utf8").toString("base64url");
  return new Error(`${TERMINAL_RESULT_PREFIX}${encoded}`);
}

function terminalResultFromReason(reason) {
  const text = String(reason || "");
  if (!text.startsWith(TERMINAL_RESULT_PREFIX)) return null;
  try {
    return normalizeResult(JSON.parse(Buffer.from(text.slice(TERMINAL_RESULT_PREFIX.length), "base64url").toString("utf8")));
  } catch {
    throw new KeyValueTransportError("V4_QUEUE_RESULT_INVALID", "result", "Stored terminal result is invalid.");
  }
}

function quarantineError(error) {
  const code = /^[A-Z0-9_]{2,120}$/.test(String(error?.code || "")) ? error.code : "FIXTURE_JOB_REJECTED";
  const stage = /^[a-zA-Z0-9._:-]{1,120}$/.test(String(error?.stage || "")) ? error.stage : "contract";
  return new Error(`${QUARANTINE_PREFIX}${code}:${stage}`);
}

function validateStoredJob(job, expectedIdentity) {
  const data = job?.data;
  if (data?.schemaVersion !== KV_JOB_SCHEMA || !data.envelope || data.payloadIdentity !== expectedIdentity) {
    throw new KeyValueTransportError("V4_QUEUE_JOB_RECORD_INVALID", "transport", "Stored queue job does not match the signed payload identity.");
  }
  return data;
}

function validateConfig(options) {
  if (typeof options.resolveKey !== "function") {
    throw new KeyValueTransportError("FIXTURE_KEY_RESOLVER_REQUIRED", "signature", "A signing key resolver is required.");
  }
  const retentionSeconds = configuredInteger(
    options.retentionSeconds,
    "V4_QUEUE_RESULT_RETENTION_SECONDS",
    DEFAULT_RETENTION_SECONDS,
    3600,
    30 * 24 * 60 * 60
  );
  const leaseMs = configuredInteger(options.leaseMs, "V4_FIXTURE_LEASE_MS", 30000, 1000, 10 * 60 * 1000);
  const stalledIntervalMs = configuredInteger(
    options.stalledIntervalMs,
    "V4_QUEUE_STALLED_INTERVAL_MS",
    30000,
    1000,
    10 * 60 * 1000
  );
  const nonceRetentionMs = configuredInteger(
    options.nonceRetentionMs,
    "V4_QUEUE_NONCE_RETENTION_MS",
    retentionSeconds * 1000,
    10 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000
  );
  if (nonceRetentionMs < retentionSeconds * 1000) {
    throw new KeyValueTransportError("V4_QUEUE_CONFIG_INVALID", "environment", "Nonce retention must cover terminal result retention.");
  }
  return Object.freeze({
    connection: redisConnectionOptions(options.redisUrl),
    queueName: namespacePart(options.queueName, "V4_QUEUE_NAME", DEFAULT_QUEUE_NAME),
    prefix: namespacePart(options.prefix, "V4_QUEUE_PREFIX", DEFAULT_QUEUE_PREFIX),
    resolveKey: options.resolveKey,
    claimsEnabled: options.claimsEnabled === true,
    readyTimeoutMs: configuredInteger(
      options.readyTimeoutMs,
      "V4_QUEUE_READY_TIMEOUT_MS",
      DEFAULT_READY_TIMEOUT_MS,
      100,
      2 * 60 * 1000
    ),
    leaseMs,
    stalledIntervalMs,
    retentionSeconds,
    nonceRetentionMs,
    completedCount: configuredInteger(options.completedCount, "V4_QUEUE_COMPLETED_RETENTION_COUNT", DEFAULT_COMPLETED_COUNT, 1, 100000),
    failedCount: configuredInteger(options.failedCount, "V4_QUEUE_FAILED_RETENTION_COUNT", DEFAULT_FAILED_COUNT, 1, 100000)
  });
}

function configFromEnvironment(env, keyring) {
  return {
    redisUrl: env.V4_QUEUE_REDIS_URL,
    queueName: env.V4_QUEUE_NAME,
    prefix: env.V4_QUEUE_PREFIX,
    resolveKey: keyring.resolveKey,
    claimsEnabled: env.V4_QUEUE_CLAIMS_ENABLED === "1",
    readyTimeoutMs: env.V4_QUEUE_READY_TIMEOUT_MS,
    leaseMs: env.V4_FIXTURE_LEASE_MS,
    stalledIntervalMs: env.V4_QUEUE_STALLED_INTERVAL_MS,
    retentionSeconds: env.V4_QUEUE_RESULT_RETENTION_SECONDS,
    nonceRetentionMs: env.V4_QUEUE_NONCE_RETENTION_MS,
    completedCount: env.V4_QUEUE_COMPLETED_RETENTION_COUNT,
    failedCount: env.V4_QUEUE_FAILED_RETENTION_COUNT
  };
}

class RenderKeyValueTransport {
  constructor(options = {}) {
    this.config = validateConfig(options);
    this.bullmq = options.bullmq || loadBullMq();
    if (options.bullmqVersion && options.bullmqVersion !== BULLMQ_VERSION) {
      throw new KeyValueTransportError("V4_QUEUE_LIBRARY_VERSION_MISMATCH", "startup", `bullmq must be pinned to ${BULLMQ_VERSION}.`);
    }
    this.interfaceVersion = TRANSPORT_INTERFACE_VERSION;
    this.adapter = "render-key-value-bullmq";
    this.crossServiceSupported = true;
    this.active = new Map();
    this.closed = false;
    this.readyState = false;
    this.hasBeenReady = false;
    this.readinessAttempt = null;
    this.claimsEnabled = this.config.claimsEnabled;
    this.lastConnectionError = null;
    const queueConnection = {
      ...this.config.connection,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1
    };
    const workerConnection = {
      ...this.config.connection,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null
    };
    const keepCompleted = { age: this.config.retentionSeconds, count: this.config.completedCount };
    const keepFailed = { age: this.config.retentionSeconds, count: this.config.failedCount };
    this.queue = new this.bullmq.Queue(this.config.queueName, {
      connection: queueConnection,
      prefix: this.config.prefix,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: keepCompleted,
        removeOnFail: keepFailed
      }
    });
    this.worker = this.claimsEnabled ? new this.bullmq.Worker(this.config.queueName, null, {
      connection: workerConnection,
      prefix: this.config.prefix,
      autorun: false,
      concurrency: 1,
      lockDuration: this.config.leaseMs,
      maxStalledCount: 0,
      stalledInterval: this.config.stalledIntervalMs,
      removeOnComplete: keepCompleted,
      removeOnFail: keepFailed
    }) : null;
    const onConnectionError = (error) => {
      this.readyState = false;
      this.lastConnectionError = error || new Error("queue connection error");
    };
    const onConnectionClose = () => onConnectionError(new Error("queue connection closed"));
    this.queue.on?.("error", onConnectionError);
    this.queue.on?.("ioredis:close", onConnectionClose);
    this.worker?.on?.("error", onConnectionError);
    this.worker?.on?.("ioredis:close", onConnectionClose);
    this.worker?.on?.("ready", () => { this.lastConnectionError = null; });
    assertTransportInterface(this);
  }

  ensureOpen() {
    if (this.closed) throw new KeyValueTransportError("V4_QUEUE_CLOSED", "transport", "Key Value transport is closed.");
  }

  claimFor(claimId) {
    const record = this.active.get(String(claimId));
    if (!record) throw new KeyValueTransportError("FIXTURE_CLAIM_UNKNOWN", "claim", "Claim is not owned by this transport instance.");
    return record;
  }

  async initializeReadiness() {
    let timeoutHandle;
    try {
      await Promise.race([
        Promise.all([
          this.queue.waitUntilReady(),
          this.worker ? this.worker.waitUntilReady() : Promise.resolve()
        ]),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error("queue readiness timeout")), this.config.readyTimeoutMs);
        })
      ]);
      if (this.closed) throw new Error("queue closed during readiness");
      if (this.worker) await this.worker.startStalledCheckTimer();
      this.readyState = true;
      this.hasBeenReady = true;
      this.lastConnectionError = null;
      return { ready: true, claimsEnabled: this.claimsEnabled };
    } catch {
      this.readyState = false;
      throw new KeyValueTransportError("V4_QUEUE_UNAVAILABLE", "startup", "Dedicated Key Value is unavailable.", { retryable: true });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  ready() {
    this.ensureOpen();
    if (this.readyState) return Promise.resolve({ ready: true, claimsEnabled: this.claimsEnabled });
    if (this.hasBeenReady && this.lastConnectionError) {
      return Promise.reject(new KeyValueTransportError(
        "V4_QUEUE_UNAVAILABLE",
        "startup",
        "Dedicated Key Value is unavailable.",
        { retryable: true }
      ));
    }
    if (!this.readinessAttempt) this.readinessAttempt = this.initializeReadiness();
    return this.readinessAttempt;
  }

  readiness() {
    return {
      ready: this.readyState && !this.closed && !this.lastConnectionError,
      claimsEnabled: this.claimsEnabled,
      activeClaims: this.active.size
    };
  }

  stopIntake() {
    this.claimsEnabled = false;
  }

  async existingResponse(job, identity, idempotencyKey) {
    const data = job?.data;
    if (data?.schemaVersion !== KV_JOB_SCHEMA || !data.envelope) {
      throw new KeyValueTransportError("V4_QUEUE_JOB_RECORD_INVALID", "transport", "Stored queue job is invalid.");
    }
    if (data.payloadIdentity !== identity || data.envelope.idempotencyKey !== idempotencyKey) {
      throw new KeyValueTransportError("FIXTURE_IDEMPOTENCY_CONFLICT", "idempotency", "Idempotency key is bound to a different payload.");
    }
    const state = await job.getState();
    if (["completed", "failed"].includes(state)) {
      const result = await this.getResult(idempotencyKey);
      if (!result) throw new KeyValueTransportError("V4_QUEUE_RESULT_MISSING", "result", "Terminal queue job has no result.");
      return { status: "duplicate", duplicate: true, collectorInvocations: 0, result };
    }
    throw new KeyValueTransportError("FIXTURE_IDEMPOTENCY_PENDING", "idempotency", "Idempotency key already has a pending claim.");
  }

  async enqueue(input, verifyOptions = {}) {
    this.ensureOpen();
    const envelope = verifySignedJob(input, { ...verifyOptions, resolveKey: this.config.resolveKey });
    const identity = payloadIdentity(envelope);
    const jobId = deterministicJobId(envelope.idempotencyKey);
    const deduplicationId = nonceIdentity(envelope.nonce);
    const enqueueAttemptId = crypto.randomUUID();
    try {
      const replayJobId = await this.queue.getDeduplicationJobId(deduplicationId);
      if (replayJobId) {
        throw new KeyValueTransportError("FIXTURE_NONCE_REPLAY", "replay", "nonce was already accepted.");
      }
      const existing = await this.queue.getJob(jobId);
      if (existing) return this.existingResponse(existing, identity, envelope.idempotencyKey);
      const added = await this.queue.add(KV_JOB_NAME, {
        schemaVersion: KV_JOB_SCHEMA,
        payloadIdentity: identity,
        idempotencyKeyHash: sha256(envelope.idempotencyKey),
        nonceHash: sha256(envelope.nonce),
        enqueueAttemptId,
        envelope
      }, {
        jobId,
        attempts: 1,
        deduplication: { id: deduplicationId, ttl: this.config.nonceRetentionMs },
        removeOnComplete: { age: this.config.retentionSeconds, count: this.config.completedCount },
        removeOnFail: { age: this.config.retentionSeconds, count: this.config.failedCount }
      });
      if (String(added?.id || "") !== jobId) {
        throw new KeyValueTransportError("FIXTURE_NONCE_REPLAY", "replay", "nonce was accepted by another producer.");
      }
      const canonical = await this.queue.getJob(jobId);
      if (canonical?.data?.schemaVersion === KV_JOB_SCHEMA && canonical.data.payloadIdentity !== identity) {
        throw new KeyValueTransportError("FIXTURE_IDEMPOTENCY_CONFLICT", "idempotency", "Idempotency key is bound to a different payload.");
      }
      validateStoredJob(canonical, identity);
      if (canonical.data.enqueueAttemptId !== enqueueAttemptId) {
        if (canonical.data.nonceHash === sha256(envelope.nonce)) {
          throw new KeyValueTransportError("FIXTURE_NONCE_REPLAY", "replay", "nonce was accepted by another producer.");
        }
        return this.existingResponse(canonical, identity, envelope.idempotencyKey);
      }
      return {
        status: "queued",
        duplicate: false,
        entryId: jobId,
        jobId: envelope.jobId,
        idempotencyKeyHash: sha256(envelope.idempotencyKey),
        scenario: envelope.scenario,
        collectorInvocations: 0
      };
    } catch (error) {
      if (error instanceof KeyValueTransportError) throw error;
      throw new KeyValueTransportError("V4_QUEUE_UNAVAILABLE", "enqueue", "Dedicated Key Value enqueue failed.", { retryable: true });
    }
  }

  async claim(workerId, leaseMs, options = {}) {
    this.ensureOpen();
    if (!this.claimsEnabled) return null;
    if (this.active.size >= 1) {
      throw new KeyValueTransportError("V4_QUEUE_CONCURRENCY_EXCEEDED", "claim", "This worker already owns one active claim.");
    }
    const owner = safeIdentifier(workerId, "workerId");
    const duration = configuredInteger(leaseMs, "leaseMs", this.config.leaseMs, 1000, 10 * 60 * 1000);
    const token = crypto.randomUUID();
    let job;
    try {
      job = await this.worker.getNextJob(token, { block: false });
    } catch {
      throw new KeyValueTransportError("V4_QUEUE_UNAVAILABLE", "claim", "Dedicated Key Value claim failed.", { retryable: true });
    }
    if (!job) return null;
    const claimedAt = new Date(Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now()).toISOString();
    let envelope;
    try {
      const data = validateStoredJob(job, job.data?.payloadIdentity);
      envelope = verifySignedJob(data.envelope, {
        nowMs: options.nowMs,
        resolveKey: this.config.resolveKey
      });
      if (payloadIdentity(envelope) !== data.payloadIdentity || deterministicJobId(envelope.idempotencyKey) !== String(job.id)) {
        throw new KeyValueTransportError("V4_QUEUE_JOB_RECORD_INVALID", "claim", "Claim identity does not match its deterministic queue identity.");
      }
    } catch (error) {
      await job.moveToFailed(quarantineError(error), token, false);
      return {
        rejected: true,
        entryId: String(job.id || "unknown"),
        claimId: token,
        workerId: owner,
        claimedAt,
        rejection: {
          status: "rejected",
          code: /^[A-Z0-9_]{2,120}$/.test(String(error?.code || "")) ? error.code : "FIXTURE_JOB_REJECTED",
          stage: /^[a-zA-Z0-9._:-]{1,120}$/.test(String(error?.stage || "")) ? error.stage : "contract",
          collectorInvocations: 0
        }
      };
    }
    const claimRecord = {
      entryId: String(job.id),
      envelope,
      claimId: token,
      workerId: owner,
      claimedAt,
      leaseMs: duration,
      job
    };
    this.active.set(token, claimRecord);
    return claimRecord;
  }

  async heartbeat(claimId) {
    this.ensureOpen();
    const claim = this.claimFor(claimId);
    let extended;
    try {
      extended = await claim.job.extendLock(claim.claimId, claim.leaseMs);
    } catch {
      throw new KeyValueTransportError("FIXTURE_LEASE_HEARTBEAT_FAILED", "lease", "BullMQ lock renewal failed.", { retryable: true });
    }
    if (!(Number(extended) > 0)) {
      throw new KeyValueTransportError("FIXTURE_LEASE_OWNERSHIP_LOST", "lease", "BullMQ lock ownership was lost.", { retryable: true });
    }
    return { claimId: claim.claimId, heartbeatAt: new Date().toISOString() };
  }

  validateResultClaim(claim, resultInput) {
    const result = normalizeResult(resultInput);
    if (result.jobId !== claim.envelope.jobId || result.idempotencyKey !== claim.envelope.idempotencyKey) {
      throw new KeyValueTransportError("FIXTURE_RESULT_IDENTITY_MISMATCH", "result", "Result identity does not match the claim.");
    }
    return result;
  }

  async complete(claimId, resultInput) {
    this.ensureOpen();
    const claim = this.claimFor(claimId);
    const result = this.validateResultClaim(claim, resultInput);
    if (result.status !== "succeeded") {
      throw new KeyValueTransportError("FIXTURE_COMPLETE_STATUS_INVALID", "result", "complete requires a succeeded result.");
    }
    try {
      await claim.job.moveToCompleted(result, claim.claimId, false);
      this.active.delete(claim.claimId);
      return result;
    } catch (error) {
      const recovered = await this.getResult(result.idempotencyKey).catch(() => null);
      if (recovered) {
        this.active.delete(claim.claimId);
        return recovered;
      }
      throw new KeyValueTransportError("V4_QUEUE_RESULT_COMMIT_UNCERTAIN", "result", "Completion acknowledgement was lost before terminal state could be confirmed.", { retryable: true });
    }
  }

  async fail(claimId, resultInput) {
    this.ensureOpen();
    const claim = this.claimFor(claimId);
    const result = this.validateResultClaim(claim, resultInput);
    if (result.status !== "failed") {
      throw new KeyValueTransportError("FIXTURE_FAIL_STATUS_INVALID", "result", "fail requires a failed result.");
    }
    try {
      await claim.job.moveToFailed(terminalError(result), claim.claimId, false);
      this.active.delete(claim.claimId);
      return result;
    } catch {
      const recovered = await this.getResult(result.idempotencyKey).catch(() => null);
      if (recovered) {
        this.active.delete(claim.claimId);
        return recovered;
      }
      throw new KeyValueTransportError("V4_QUEUE_RESULT_COMMIT_UNCERTAIN", "result", "Failure acknowledgement was lost before terminal state could be confirmed.", { retryable: true });
    }
  }

  stalledResult(job, envelope) {
    const startedMs = Number(job.processedOn || job.timestamp || Date.now());
    const completedMs = Math.max(startedMs, Number(job.finishedOn || Date.now()));
    return normalizeResult({
      schemaVersion: RESULT_SCHEMA,
      jobId: envelope.jobId,
      idempotencyKey: envelope.idempotencyKey,
      attemptId: `stalled-${String(job.id).slice(-32)}`,
      status: "failed",
      stage: "lease",
      code: "FIXTURE_STALE_CLAIM_NO_AUTO_RETRY",
      matched: false,
      actualExternalRequests: 0,
      operationalWrites: false,
      collectorInvocations: job.processedOn ? 1 : 0,
      exitCode: null,
      artifactManifestDigest: null,
      startedAt: new Date(startedMs).toISOString(),
      completedAt: new Date(completedMs).toISOString(),
      retryable: true,
      scenario: envelope.scenario
    });
  }

  async getResult(idempotencyKey) {
    this.ensureOpen();
    const key = safeIdentifier(idempotencyKey, "idempotencyKey");
    let job;
    try {
      job = await this.queue.getJob(deterministicJobId(key));
    } catch {
      throw new KeyValueTransportError("V4_QUEUE_UNAVAILABLE", "result", "Dedicated Key Value result lookup failed.", { retryable: true });
    }
    if (!job) return null;
    const data = validateStoredJob(job, job.data?.payloadIdentity);
    if (data.envelope.idempotencyKey !== key) {
      throw new KeyValueTransportError("FIXTURE_IDEMPOTENCY_CONFLICT", "idempotency", "Stored job identity does not match the requested key.");
    }
    const state = await job.getState();
    if (state === "completed") return normalizeResult(job.returnvalue);
    if (state !== "failed") return null;
    const terminal = terminalResultFromReason(job.failedReason);
    if (terminal) return terminal;
    const issuedMs = Date.parse(String(data.envelope.issuedAt || ""));
    const envelope = verifySignedJob(data.envelope, {
      nowMs: Number.isFinite(issuedMs) ? issuedMs : undefined,
      resolveKey: this.config.resolveKey
    });
    if (Number(job.stalledCounter || 0) > 0) return this.stalledResult(job, envelope);
    throw new KeyValueTransportError("V4_QUEUE_QUARANTINED", "result", "Failed queue job has no signed terminal result.");
  }

  async releaseOnShutdown(claimId, options = {}) {
    const claim = this.claimFor(claimId);
    const startedAt = options.startedAt || claim.claimedAt;
    const result = normalizeResult({
      schemaVersion: RESULT_SCHEMA,
      jobId: claim.envelope.jobId,
      idempotencyKey: claim.envelope.idempotencyKey,
      attemptId: options.attemptId || claim.claimId,
      status: "failed",
      stage: "shutdown",
      code: "FIXTURE_SHUTDOWN_RELEASED",
      matched: false,
      actualExternalRequests: 0,
      operationalWrites: false,
      collectorInvocations: Number.isInteger(options.collectorInvocations) ? options.collectorInvocations : 0,
      exitCode: Number.isInteger(options.exitCode) ? options.exitCode : null,
      artifactManifestDigest: null,
      startedAt,
      completedAt: new Date().toISOString(),
      retryable: true,
      scenario: claim.envelope.scenario
    });
    return this.fail(claimId, result);
  }

  async reject(claimId, error) {
    const claim = this.claimFor(claimId);
    await claim.job.moveToFailed(quarantineError(error), claim.claimId, false);
    this.active.delete(claim.claimId);
    return {
      status: "rejected",
      code: /^[A-Z0-9_]{2,120}$/.test(String(error?.code || "")) ? error.code : "FIXTURE_JOB_REJECTED",
      stage: /^[a-zA-Z0-9._:-]{1,120}$/.test(String(error?.stage || "")) ? error.stage : "contract",
      collectorInvocations: 0
    };
  }

  async recoverStaleClaims() {
    this.ensureOpen();
    return [];
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stopIntake();
    this.readyState = false;
    if (this.worker) await this.worker.close();
    await this.queue.close();
    this.active.clear();
  }
}

module.exports = {
  BULLMQ_VERSION,
  DEFAULT_COMPLETED_COUNT,
  DEFAULT_FAILED_COUNT,
  DEFAULT_NONCE_RETENTION_MS,
  DEFAULT_QUEUE_NAME,
  DEFAULT_QUEUE_PREFIX,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_RETENTION_SECONDS,
  KV_JOB_NAME,
  KV_JOB_SCHEMA,
  KeyValueTransportError,
  RenderKeyValueTransport,
  configFromEnvironment,
  deterministicJobId,
  nonceIdentity,
  payloadIdentity,
  redisConnectionOptions,
  terminalResultFromReason,
  validateConfig
};
