const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  RESULT_SCHEMA,
  normalizeResult,
  safeIdentifier,
  sha256,
  verifySignedJob
} = require("./v4_fixture_job_contract.cjs");
const {
  initializeFixtureTransport,
  readJson,
  writeJsonAtomic
} = require("./v4_fixture_transport_fs.cjs");
const { createFilesystemTransport } = require("./v4_fixture_transport.cjs");
const { loadSigningKeyring } = require("./v4_fixture_signing_keys.cjs");

const ROOT = path.resolve(__dirname, "..");
const PARITY_RUNNER = path.join(__dirname, "v4_collector_parity.cjs");
const NETWORK_BLOCKER = path.join(__dirname, "fixtures", "v4_network_blocker.cjs");
const SUPERVISOR_SCHEMA = "datalab-v4-fixture-transport-supervisor.v1";
const LEGACY_SUPERVISOR_LOCK_SCHEMA = "datalab-v4-fixture-supervisor-lock.v1";
const SUPERVISOR_LOCK_SCHEMA = "datalab-v4-fixture-supervisor-lock.v2";
const SUPERVISOR_LEASE_SCHEMA = "datalab-v4-fixture-supervisor-lease.v2";
const SUPERVISOR_RELEASE_SCHEMA = "datalab-v4-fixture-supervisor-release.v2";
const OWNER_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const GENERATION_FILE_PATTERN = /^owner-(\d{12})\.json$/;
const RELEASE_FILE_PATTERN = /^release-(\d{12})\.json$/;
const MAX_CHILD_OUTPUT_BYTES = 128 * 1024;
const DISABLED_GATES = [
  "V4_FIXTURE_EXTERNAL_CALLS_ENABLED",
  "V4_FIXTURE_OPERATIONAL_PUBLISH_ENABLED",
  "V4_FIXTURE_WEB_IMPORT_ENABLED"
];
const BASE_ENV_NAMES = [
  "PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_PATH"
];

class SupervisorError extends Error {
  constructor(code, stage, message, options = {}) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
    this.stage = stage;
    this.retryable = options.retryable === true;
    this.collectorInvocations = Number.isInteger(options.collectorInvocations) ? options.collectorInvocations : 0;
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
  }
}

function configuredInteger(env, name, fallback, min, max) {
  const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_CONFIG_INVALID", "environment", `${name} is invalid.`);
  }
  return value;
}

function validateSupervisorEnvironment(env = process.env) {
  const transportMode = String(env.V4_FIXTURE_TRANSPORT_MODE || "");
  if (env.NODE_ENV !== "test" || !["fixture", "render-key-value"].includes(transportMode)) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_MODE_INVALID", "environment", "Supervisor requires test fixture mode.");
  }
  for (const name of DISABLED_GATES) {
    if (env[name] !== "0") {
      throw new SupervisorError("FIXTURE_SUPERVISOR_GATE_NOT_DISABLED", "environment", `${name} must be exactly 0.`);
    }
  }
  if (transportMode === "fixture" && globalThis.__DATALAB_V4_NETWORK_BLOCKED__ !== true) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_NETWORK_BLOCKER_REQUIRED", "environment", "Supervisor requires the network blocker preload.");
  }
  const transportRoot = String(env.V4_FIXTURE_TRANSPORT_ROOT || "");
  if (!path.isAbsolute(transportRoot)) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_ROOT_INVALID", "environment", "V4_FIXTURE_TRANSPORT_ROOT must be absolute.");
  }
  let keyring;
  try {
    keyring = loadSigningKeyring(env, { allowLegacy: transportMode === "fixture" });
  } catch (error) {
    throw new SupervisorError(error.code || "FIXTURE_SUPERVISOR_SIGNING_CONFIG_MISSING", "environment", "Fixture signing configuration is invalid.");
  }
  const leaseMs = configuredInteger(env, "V4_FIXTURE_LEASE_MS", 5000, 1000, 10 * 60 * 1000);
  const heartbeatMs = configuredInteger(env, "V4_FIXTURE_HEARTBEAT_MS", 1000, 250, 60 * 1000);
  if (heartbeatMs * 2 >= leaseMs) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_HEARTBEAT_INVALID", "environment", "Heartbeat interval must be less than half the lease.");
  }
  return {
    transportMode,
    transportRoot: path.resolve(transportRoot),
    keyId: keyring.current.keyId,
    secret: keyring.current.secret,
    keyring,
    resolveKey: keyring.resolveKey,
    leaseMs,
    heartbeatMs,
    startupWaitMs: configuredInteger(
      env,
      "V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS",
      0,
      0,
      5 * 60 * 1000
    ),
    pollMs: configuredInteger(env, "V4_FIXTURE_POLL_MS", 500, 100, 60 * 1000),
    childTimeoutMs: configuredInteger(env, "V4_FIXTURE_CHILD_TIMEOUT_MS", 60 * 1000, 1000, 30 * 60 * 1000),
    workerId: safeIdentifier(
      env.V4_FIXTURE_WORKER_ID || `fixture-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
      "workerId"
    )
  };
}

function sensitiveValues(env = process.env) {
  return Object.entries(env)
    .filter(([name, value]) => (/(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)/i.test(name)
      || name === "V4_QUEUE_REDIS_URL")
      && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

function sanitizedJson(value, secrets = sensitiveValues()) {
  let text = JSON.stringify(value);
  for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
  return text;
}

function logEvent(event, fields = {}) {
  process.stdout.write(`${sanitizedJson({
    schemaVersion: SUPERVISOR_SCHEMA,
    timestamp: new Date().toISOString(),
    event,
    ...fields
  })}\n`);
}

function isContained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function minimalChildEnvironment() {
  const env = {};
  for (const name of BASE_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.NODE_ENV = "test";
  return env;
}

async function regularFileDigest(root, filePath) {
  if (!isContained(root, filePath)) {
    throw new SupervisorError("FIXTURE_ARTIFACT_PATH_INVALID", "artifact", "Parity report path is outside the attempt root.", { collectorInvocations: 1 });
  }
  const stat = await fsp.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new SupervisorError("FIXTURE_ARTIFACT_INVALID", "artifact", "Parity report is missing or symbolic.", { collectorInvocations: 1 });
  }
  return sha256(await fsp.readFile(filePath));
}

function failedResult(envelope, attemptId, startedAt, error, completedAt = new Date().toISOString()) {
  return normalizeResult({
    schemaVersion: RESULT_SCHEMA,
    jobId: envelope.jobId,
    idempotencyKey: envelope.idempotencyKey,
    attemptId,
    status: "failed",
    stage: /^[a-zA-Z0-9._:-]{1,120}$/.test(String(error?.stage || "")) ? error.stage : "supervisor",
    code: /^[A-Z0-9_]{2,120}$/.test(String(error?.code || "")) ? error.code : "FIXTURE_SUPERVISOR_FAILED",
    matched: false,
    actualExternalRequests: Number.isInteger(error?.actualExternalRequests) ? error.actualExternalRequests : 0,
    operationalWrites: error?.operationalWrites === true,
    collectorInvocations: Number.isInteger(error?.collectorInvocations) ? error.collectorInvocations : 0,
    exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : null,
    artifactManifestDigest: null,
    startedAt,
    completedAt,
    retryable: error?.retryable === true,
    scenario: envelope.scenario
  });
}

async function runParityChild(envelope, roots, claimRecord, config, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const attemptId = options.attemptId || `attempt-${nowMs}-${crypto.randomBytes(5).toString("hex")}`;
  const attemptRoot = path.join(roots.runs, attemptId);
  if (!isContained(roots.runs, attemptRoot)) {
    throw new SupervisorError("FIXTURE_ATTEMPT_PATH_INVALID", "storage", "Attempt path is outside the runs root.");
  }
  await fsp.mkdir(attemptRoot, { recursive: false });
  const jobFile = path.join(attemptRoot, "job.json");
  const parityRoot = path.join(attemptRoot, "parity");
  await fsp.writeFile(jobFile, `${JSON.stringify(envelope.job, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const startedAt = new Date(nowMs).toISOString();
  let child = null;
  let timeout = null;
  let heartbeatTimer = null;
  let abortHandler = null;
  let leaseFailure = null;
  let timedOut = false;
  let aborted = false;
  const output = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [
      "--require",
      NETWORK_BLOCKER,
      PARITY_RUNNER,
      "--job-file",
      jobFile,
      "--root",
      parityRoot,
      "--scenario",
      envelope.scenario
    ], {
      cwd: ROOT,
      env: minimalChildEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (typeof options.onSpawn === "function") options.onSpawn(child);
    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;
    const collect = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    child.once("error", (error) => reject(new SupervisorError(
      "FIXTURE_CHILD_SPAWN_FAILED",
      "execute",
      "Parity runner could not start.",
      { retryable: true, collectorInvocations: 0 }
    )));
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr, outputTooLarge }));
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child?.kill("SIGKILL"), 1000).unref();
    }, config.childTimeoutMs);
    timeout.unref();
    heartbeatTimer = setInterval(() => {
      const renew = typeof options.heartbeat === "function"
        ? options.heartbeat
        : () => Promise.reject(new SupervisorError("FIXTURE_HEARTBEAT_MISSING", "lease", "Transport heartbeat is unavailable."));
      renew().catch((error) => {
        leaseFailure = error;
        child?.kill("SIGTERM");
      });
    }, config.heartbeatMs);
    heartbeatTimer.unref();
    if (options.signal) {
      abortHandler = () => {
        aborted = true;
        child?.kill("SIGTERM");
        setTimeout(() => child?.kill("SIGKILL"), 1000).unref();
      };
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
  });

  if (leaseFailure) {
    throw new SupervisorError("FIXTURE_LEASE_HEARTBEAT_FAILED", "lease", "Lease heartbeat failed.", {
      retryable: true,
      collectorInvocations: 1,
      exitCode: output.exitCode
    });
  }
  if (aborted) {
    throw new SupervisorError("FIXTURE_CHILD_ABORTED", "shutdown", "Parity runner was stopped for shutdown.", {
      retryable: true,
      collectorInvocations: 1,
      exitCode: output.exitCode
    });
  }
  if (timedOut) {
    throw new SupervisorError("FIXTURE_CHILD_TIMEOUT", "execute", "Parity runner exceeded the configured timeout.", {
      retryable: true,
      collectorInvocations: 1,
      exitCode: output.exitCode
    });
  }
  if (output.outputTooLarge) {
    throw new SupervisorError("FIXTURE_CHILD_OUTPUT_TOO_LARGE", "execute", "Parity runner output exceeded the limit.", {
      collectorInvocations: 1,
      exitCode: output.exitCode
    });
  }
  const lines = output.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new SupervisorError("FIXTURE_CHILD_PROTOCOL_INVALID", "execute", "Parity runner did not emit one JSON result.", {
      collectorInvocations: 1,
      exitCode: output.exitCode
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(lines[0]);
  } catch {
    throw new SupervisorError("FIXTURE_CHILD_PROTOCOL_INVALID", "execute", "Parity runner emitted invalid JSON.", {
      collectorInvocations: 1,
      exitCode: output.exitCode
    });
  }
  const completedAt = new Date().toISOString();
  if (
    output.exitCode !== 0
    || parsed.status !== "succeeded"
    || parsed.matched !== true
    || parsed.actualExternalRequests !== 0
    || parsed.operationalWrites !== false
  ) {
    const failure = new SupervisorError(
      parsed.actualExternalRequests > 0 ? "FIXTURE_EXTERNAL_REQUEST_DETECTED" : "FIXTURE_PARITY_RUN_FAILED",
      parsed.actualExternalRequests > 0 ? "network" : "execute",
      "Parity runner did not satisfy the fixture safety contract.",
      { collectorInvocations: 1 }
    );
    failure.actualExternalRequests = Number.isInteger(parsed.actualExternalRequests) ? parsed.actualExternalRequests : 0;
    failure.operationalWrites = parsed.operationalWrites === true;
    failure.exitCode = Number.isInteger(output.exitCode) ? output.exitCode : null;
    return failedResult(envelope, attemptId, startedAt, failure, completedAt);
  }
  const reportFile = path.resolve(String(parsed.reportFile || ""));
  const artifactManifestDigest = await regularFileDigest(parityRoot, reportFile);
  return normalizeResult({
    schemaVersion: RESULT_SCHEMA,
    jobId: envelope.jobId,
    idempotencyKey: envelope.idempotencyKey,
    attemptId,
    status: "succeeded",
    stage: "complete",
    code: "OK",
    matched: true,
    actualExternalRequests: 0,
    operationalWrites: false,
    collectorInvocations: 1,
    exitCode: 0,
    artifactManifestDigest,
    startedAt,
    completedAt,
    retryable: false,
    scenario: envelope.scenario
  });
}

async function processNext(roots, config, options = {}) {
  const resolveKey = resolverFor(config);
  const transport = options.transport || createFilesystemTransport(roots, {
    verifyOptions: { resolveKey }
  });
  const claimRecord = await transport.claim(config.workerId, config.leaseMs, { nowMs: options.nowMs });
  if (!claimRecord) return null;
  if (claimRecord.rejected) return claimRecord.rejection;
  let envelope;
  try {
    envelope = verifySignedJob(claimRecord.envelope, {
      nowMs: options.nowMs,
      resolveKey
    });
  } catch (error) {
    if (typeof transport.reject === "function") return transport.reject(claimRecord.claimId, error);
    throw error;
  }
  const startedAt = new Date(Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now()).toISOString();
  const runParity = options.runParity || runParityChild;
  try {
    const result = await runParity(envelope, roots, claimRecord, config, {
      ...options,
      heartbeat: () => transport.heartbeat(claimRecord.claimId)
    });
    if (result.status === "succeeded") return transport.complete(claimRecord.claimId, result);
    return transport.fail(claimRecord.claimId, result);
  } catch (error) {
    if (options.signal?.aborted || error.code === "FIXTURE_CHILD_ABORTED") {
      return transport.releaseOnShutdown(claimRecord.claimId, {
        startedAt,
        attemptId: options.attemptId || claimRecord.claimId,
        collectorInvocations: error.collectorInvocations,
        exitCode: error.exitCode,
        retryable: true
      });
    }
    const result = failedResult(
      envelope,
      options.attemptId || claimRecord.claimId,
      startedAt,
      error
    );
    return transport.fail(claimRecord.claimId, result);
  }
}

function resolverFor(config) {
  if (typeof config.resolveKey === "function") return config.resolveKey;
  return (keyId) => keyId === config.keyId ? config.secret : null;
}

function supervisorLockFile(roots) {
  return path.join(roots.runtime, "supervisor-lock-v2");
}

function legacySupervisorLockFile(roots) {
  return path.join(roots.runtime, "supervisor-lock.json");
}

function supervisorLeaseFile(roots, ownerToken) {
  if (!OWNER_TOKEN_PATTERN.test(String(ownerToken || ""))) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_OWNER_INVALID", "supervisor_lock", "Supervisor owner identity is invalid.");
  }
  return path.join(roots.runtime, "supervisor-lock-v2-leases", `lease-${ownerToken}.json`);
}

function supervisorOwnerFile(roots, generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 999999999999) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_GENERATION_INVALID", "supervisor_lock", "Supervisor generation is invalid.");
  }
  return path.join(supervisorLockFile(roots), `owner-${String(generation).padStart(12, "0")}.json`);
}

function supervisorReleaseFile(roots, generation) {
  return path.join(supervisorLockFile(roots), `release-${String(generation).padStart(12, "0")}.json`);
}

async function readSupervisorRecord(roots, file, code = "FIXTURE_SUPERVISOR_LOCK_INVALID") {
  if (!fs.existsSync(file)) return null;
  try {
    return await readJson(roots, file);
  } catch (error) {
    if (!fs.existsSync(file)) return null;
    throw new SupervisorError(code, "supervisor_lock", "Supervisor lock record cannot be verified.");
  }
}

async function writeSupervisorRecordAtomic(roots, file, value, replace = false) {
  const relative = path.relative(roots.root, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_PATH_INVALID", "supervisor_lock", "Supervisor record path escapes the transport root.");
  }
  const staging = path.join(
    roots.runtime,
    `.supervisor-record.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  await writeJsonAtomic(roots.root, staging, value);
  try {
    if (!replace) {
      await fsp.link(staging, file);
      return;
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(staging, file);
        return;
      } catch (error) {
        if (!["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(error.code) || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    await fsp.unlink(staging).catch(() => {});
  }
}

function validateV2Lock(record) {
  const acquiredAt = Date.parse(String(record?.acquiredAt || ""));
  const heartbeatAt = Date.parse(String(record?.heartbeatAt || ""));
  const expiresAt = Date.parse(String(record?.expiresAt || ""));
  return record?.schemaVersion === SUPERVISOR_LOCK_SCHEMA
    && typeof record.workerId === "string"
    && OWNER_TOKEN_PATTERN.test(String(record.ownerToken || ""))
    && Number.isSafeInteger(record.generation)
    && record.generation >= 1
    && Number.isFinite(acquiredAt)
    && Number.isFinite(heartbeatAt)
    && Number.isFinite(expiresAt)
    && expiresAt >= heartbeatAt;
}

function validateV2Lease(record, lock) {
  const heartbeatAt = Date.parse(String(record?.heartbeatAt || ""));
  const expiresAt = Date.parse(String(record?.expiresAt || ""));
  return record?.schemaVersion === SUPERVISOR_LEASE_SCHEMA
    && record.ownerToken === lock.ownerToken
    && record.workerId === lock.workerId
    && record.generation === lock.generation
    && Number.isFinite(heartbeatAt)
    && Number.isFinite(expiresAt)
    && expiresAt >= heartbeatAt;
}

function validateLegacyLock(record) {
  const acquiredAt = Date.parse(String(record?.acquiredAt || ""));
  const heartbeatAt = Date.parse(String(record?.heartbeatAt || ""));
  const expiresAt = Date.parse(String(record?.expiresAt || ""));
  return record?.schemaVersion === LEGACY_SUPERVISOR_LOCK_SCHEMA
    && typeof record.workerId === "string"
    && Number.isFinite(acquiredAt)
    && Number.isFinite(heartbeatAt)
    && Number.isFinite(expiresAt)
    && expiresAt >= heartbeatAt;
}

function validateV2Release(record, lock) {
  const releasedAt = Date.parse(String(record?.releasedAt || ""));
  return record?.schemaVersion === SUPERVISOR_RELEASE_SCHEMA
    && record.workerId === lock.workerId
    && record.ownerToken === lock.ownerToken
    && record.generation === lock.generation
    && Number.isFinite(releasedAt);
}

async function inspectSupervisorLock(roots) {
  const directory = supervisorLockFile(roots);
  if (!fs.existsSync(directory)) return { state: "missing", generation: 0 };
  const directoryStat = await fsp.lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!directoryStat) return { state: "missing", generation: 0 };
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_INVALID", "supervisor_lock", "Supervisor lock storage is not a real directory.");
  }
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing", generation: 0 };
    throw error;
  }
  const generations = [];
  const releaseEntries = new Map();
  for (const entry of entries) {
    const match = GENERATION_FILE_PATTERN.exec(entry.name);
    if (!entry.isFile()) {
      throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_INVALID", "supervisor_lock", "Supervisor ownership record is not a regular file.");
    }
    if (match) {
      const generation = Number(match[1]);
      const ownerFile = path.join(directory, entry.name);
      const lock = await readSupervisorRecord(roots, ownerFile);
      if (!validateV2Lock(lock) || lock.generation !== generation) {
        throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_INVALID", "supervisor_lock", "Supervisor lock schema or generation is invalid.");
      }
      generations.push({ generation, ownerFile, lock });
      continue;
    }
    const releaseMatch = RELEASE_FILE_PATTERN.exec(entry.name);
    if (releaseMatch) {
      releaseEntries.set(Number(releaseMatch[1]), path.join(directory, entry.name));
      continue;
    }
    throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_INVALID", "supervisor_lock", "Supervisor lock storage contains an unsupported record.");
  }
  if (generations.length === 0) {
    if (entries.length > 0) {
      throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_INVALID", "supervisor_lock", "Supervisor lock storage contains records without an owner generation.");
    }
    return { state: "missing", generation: 0 };
  }
  generations.sort((left, right) => left.generation - right.generation);
  for (let index = 0; index < generations.length; index += 1) {
    if (generations[index].generation !== index + 1) {
      throw new SupervisorError("FIXTURE_SUPERVISOR_GENERATION_INVALID", "supervisor_lock", "Supervisor ownership generations are not contiguous.");
    }
  }
  for (const [generation, releaseFile] of releaseEntries) {
    const owner = generations[generation - 1];
    const release = await readSupervisorRecord(roots, releaseFile);
    if (!owner || owner.generation !== generation || !validateV2Release(release, owner.lock)) {
      throw new SupervisorError("FIXTURE_SUPERVISOR_RELEASE_INVALID", "supervisor_lock", "Supervisor release is invalid or has no matching owner generation.");
    }
    owner.release = release;
    owner.releaseFile = releaseFile;
  }
  const current = generations[generations.length - 1];
  const leaseFile = supervisorLeaseFile(roots, current.lock.ownerToken);
  const lease = await readSupervisorRecord(roots, leaseFile);
  if (!validateV2Lease(lease, current.lock)) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_LEASE_INVALID", "supervisor_lock", "Current supervisor owner lease is missing or invalid.");
  }
  const releaseFile = current.releaseFile || supervisorReleaseFile(roots, current.generation);
  const release = current.release || null;
  return {
    state: release ? "released" : "owned",
    ...current,
    lease,
    leaseFile,
    release,
    releaseFile,
    expiresAt: Date.parse(lease.expiresAt),
    legacy: false
  };
}

async function createV2Lock(roots, config, ownerToken, generation, nowMs) {
  const directory = supervisorLockFile(roots);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.mkdir(path.dirname(supervisorLeaseFile(roots, ownerToken)), { recursive: true });
  for (const candidate of [directory, path.dirname(supervisorLeaseFile(roots, ownerToken))]) {
    const stat = await fsp.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_INVALID", "supervisor_lock", "Supervisor lock storage is not a real directory.");
    }
  }
  const lock = {
    schemaVersion: SUPERVISOR_LOCK_SCHEMA,
    workerId: config.workerId,
    ownerToken,
    generation,
    acquiredAt: new Date(nowMs).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + config.leaseMs).toISOString()
  };
  const lease = {
    schemaVersion: SUPERVISOR_LEASE_SCHEMA,
    workerId: config.workerId,
    ownerToken,
    generation,
    heartbeatAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + config.leaseMs).toISOString()
  };
  const leaseFile = supervisorLeaseFile(roots, ownerToken);
  const ownerFile = supervisorOwnerFile(roots, generation);
  await writeSupervisorRecordAtomic(roots, leaseFile, lease);
  try {
    await writeSupervisorRecordAtomic(roots, ownerFile, lock);
  } catch (error) {
    await fsp.unlink(leaseFile).catch(() => {});
    if (error.code === "EEXIST") return null;
    throw error;
  }
  return { file: ownerFile, ownerFile, leaseFile, lock, lease, ownerToken, generation };
}

async function inspectLegacySupervisorLock(roots) {
  const file = legacySupervisorLockFile(roots);
  const lock = await readSupervisorRecord(roots, file);
  if (!lock) return { state: "missing", file };
  if (!validateLegacyLock(lock)) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_INVALID", "supervisor_lock", "Legacy supervisor lock is invalid.");
  }
  return {
    state: "owned",
    file,
    lock,
    expiresAt: Date.parse(lock.expiresAt),
    legacy: true
  };
}

async function acquireSupervisorLock(roots, config, options = {}) {
  if (Number.isFinite(options)) options = { nowMs: Number(options) };
  const ownerToken = options.ownerToken || crypto.randomBytes(32).toString("hex");
  if (!OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_OWNER_INVALID", "supervisor_lock", "Supervisor owner identity is invalid.");
  }
  const wallStartedAt = Date.now();
  const startedAt = Number.isFinite(options.nowMs) ? Number(options.nowMs) : wallStartedAt;
  const deadline = startedAt + Number(config.startupWaitMs || 0);
  const signal = options.signal;
  for (;;) {
    if (signal?.aborted) {
      throw new SupervisorError("FIXTURE_SUPERVISOR_STARTUP_ABORTED", "shutdown", "Supervisor startup was stopped before lock acquisition.");
    }
    const nowMs = Number.isFinite(options.nowMs)
      ? startedAt + (Date.now() - wallStartedAt)
      : Date.now();
    const legacy = await inspectLegacySupervisorLock(roots);
    if (legacy.state === "owned") {
      if (legacy.expiresAt <= nowMs) {
        const archived = path.join(roots.stale, `supervisor-v1-${nowMs}-${crypto.randomBytes(4).toString("hex")}.json`);
        try {
          await fsp.rename(legacy.file, archived);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        continue;
      }
    } else {
      const inspected = await inspectSupervisorLock(roots);
      const available = inspected.state === "missing"
        || inspected.state === "released"
        || inspected.expiresAt <= nowMs;
      if (available) {
        const created = await createV2Lock(roots, config, ownerToken, inspected.generation + 1, nowMs);
        if (created) return created;
        continue;
      }
    }
    if (nowMs >= deadline) {
      throw new SupervisorError(
        config.startupWaitMs > 0 ? "FIXTURE_SUPERVISOR_LOCK_WAIT_TIMEOUT" : "FIXTURE_SUPERVISOR_ALREADY_RUNNING",
        "supervisor_lock",
        "Another fixture supervisor owns the active lock."
      );
    }
    const waitMs = Math.min(100, Math.max(1, deadline - nowMs));
    await waitForPoll(waitMs, signal);
  }
}

async function renewSupervisorLock(roots, lockHandle, config, nowMs = Date.now()) {
  const current = await inspectSupervisorLock(roots);
  if (current.state !== "owned"
    || current.generation !== lockHandle.generation
    || current.lock.ownerToken !== lockHandle.ownerToken
    || current.expiresAt <= nowMs) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_LOST", "supervisor_lock", "Supervisor lock ownership was lost.");
  }
  const renewed = {
    ...current.lease,
    heartbeatAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + config.leaseMs).toISOString()
  };
  await writeSupervisorRecordAtomic(roots, lockHandle.leaseFile, renewed, true);
  const after = await inspectSupervisorLock(roots);
  if (after.state !== "owned"
    || after.generation !== lockHandle.generation
    || after.lock.ownerToken !== lockHandle.ownerToken) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_LOST", "supervisor_lock", "Supervisor lock ownership changed during renewal.");
  }
  lockHandle.lease = renewed;
  return renewed;
}

async function releaseSupervisorLock(roots, lockHandle) {
  const current = await inspectSupervisorLock(roots);
  if (current.state !== "owned"
    || current.generation !== lockHandle.generation
    || current.lock.ownerToken !== lockHandle.ownerToken) return false;
  const release = {
    schemaVersion: SUPERVISOR_RELEASE_SCHEMA,
    workerId: current.lock.workerId,
    ownerToken: lockHandle.ownerToken,
    generation: lockHandle.generation,
    releasedAt: new Date().toISOString()
  };
  try {
    await writeSupervisorRecordAtomic(roots, current.releaseFile, release);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readSupervisorRecord(roots, current.releaseFile);
    if (!validateV2Release(existing, current.lock)) return false;
  }
  return true;
}

function waitForPoll(milliseconds, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      finish();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function main(options = {}) {
  const config = options.config || validateSupervisorEnvironment();
  const roots = options.roots || await initializeFixtureTransport(config.transportRoot);
  const resolveKey = resolverFor(config);
  let transport = options.transport || null;
  const controller = new AbortController();
  const requestStop = (signal) => {
    if (controller.signal.aborted) return;
    if (typeof transport?.stopIntake === "function") transport.stopIntake();
    logEvent("fixture_supervisor_shutdown_requested", { signal });
    controller.abort();
  };
  const onSigterm = () => requestStop("SIGTERM");
  const onSigint = () => requestStop("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  let lockHandle = null;
  let lockTimer = null;
  try {
    lockHandle = await acquireSupervisorLock(roots, config, { signal: controller.signal });
    lockTimer = setInterval(() => {
      renewSupervisorLock(roots, lockHandle, config).catch(() => requestStop("LOCK_LOST"));
    }, config.heartbeatMs);
    lockTimer.unref();
    if (controller.signal.aborted) {
      throw new SupervisorError("FIXTURE_SUPERVISOR_STARTUP_ABORTED", "shutdown", "Supervisor startup was stopped before transport initialization.");
    }
    transport = transport || (typeof options.createTransport === "function"
      ? await options.createTransport()
      : createFilesystemTransport(roots, { verifyOptions: { resolveKey } }));
    if (typeof transport.ready === "function") await transport.ready();
    const recovered = typeof transport.recoverStaleClaims === "function"
      ? await transport.recoverStaleClaims({ resolveKey })
      : [];
    const startup = typeof options.beforeReady === "function"
      ? await options.beforeReady({ roots, config, recovered, transport })
      : null;
    const readiness = typeof transport.readiness === "function" ? transport.readiness() : null;
    logEvent("fixture_supervisor_ready", {
      workerId: config.workerId,
      concurrency: 1,
      mode: config.transportMode,
      transport: transport.adapter || null,
      claimsEnabled: readiness?.claimsEnabled ?? true,
      automaticRetry: false,
      recoveredWithoutRetry: recovered.length,
      bootstrapStatus: startup?.status || null,
      bootstrapCollectorInvocations: Number(startup?.collectorInvocations || 0)
    });
    while (!controller.signal.aborted) {
      const result = await processNext(roots, config, { signal: controller.signal, transport });
      if (result) {
        logEvent("fixture_job_terminal", {
          status: result.status,
          code: result.code,
          matched: result.matched === true,
          actualExternalRequests: Number(result.actualExternalRequests || 0),
          operationalWrites: result.operationalWrites === true,
          collectorInvocations: Number(result.collectorInvocations || 0)
        });
      } else {
        await waitForPoll(config.pollMs, controller.signal);
      }
    }
  } finally {
    if (lockTimer) clearInterval(lockTimer);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    if (transport) await transport.close().catch(() => {});
    const released = lockHandle
      ? await releaseSupervisorLock(roots, lockHandle).catch(() => false)
      : false;
    logEvent("fixture_supervisor_stopped", {
      workerId: config.workerId,
      lockAcquired: lockHandle !== null,
      lockReleased: released
    });
  }
}

module.exports = {
  DISABLED_GATES,
  LEGACY_SUPERVISOR_LOCK_SCHEMA,
  SUPERVISOR_LEASE_SCHEMA,
  SUPERVISOR_LOCK_SCHEMA,
  SUPERVISOR_RELEASE_SCHEMA,
  SUPERVISOR_SCHEMA,
  SupervisorError,
  acquireSupervisorLock,
  failedResult,
  main,
  processNext,
  inspectSupervisorLock,
  releaseSupervisorLock,
  resolverFor,
  renewSupervisorLock,
  runParityChild,
  sanitizedJson,
  sensitiveValues,
  validateSupervisorEnvironment
};

if (require.main === module) {
  main().catch((error) => {
    logEvent("fixture_supervisor_fatal", {
      code: /^[A-Z0-9_]{2,120}$/.test(String(error?.code || "")) ? error.code : "FIXTURE_SUPERVISOR_FATAL"
    });
    process.exitCode = 1;
  });
}
