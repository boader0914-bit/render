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
  claim,
  complete,
  fail,
  heartbeat,
  initializeFixtureTransport,
  readJson,
  recoverStaleClaims,
  rejectClaim,
  releaseOnShutdown,
  writeJsonAtomic
} = require("./v4_fixture_transport_fs.cjs");

const ROOT = path.resolve(__dirname, "..");
const PARITY_RUNNER = path.join(__dirname, "v4_collector_parity.cjs");
const NETWORK_BLOCKER = path.join(__dirname, "fixtures", "v4_network_blocker.cjs");
const SUPERVISOR_SCHEMA = "datalab-v4-fixture-transport-supervisor.v1";
const SUPERVISOR_LOCK_SCHEMA = "datalab-v4-fixture-supervisor-lock.v1";
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
  if (env.NODE_ENV !== "test" || env.V4_FIXTURE_TRANSPORT_MODE !== "fixture") {
    throw new SupervisorError("FIXTURE_SUPERVISOR_MODE_INVALID", "environment", "Supervisor requires test fixture mode.");
  }
  for (const name of DISABLED_GATES) {
    if (env[name] !== "0") {
      throw new SupervisorError("FIXTURE_SUPERVISOR_GATE_NOT_DISABLED", "environment", `${name} must be exactly 0.`);
    }
  }
  if (globalThis.__DATALAB_V4_NETWORK_BLOCKED__ !== true) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_NETWORK_BLOCKER_REQUIRED", "environment", "Supervisor requires the network blocker preload.");
  }
  const transportRoot = String(env.V4_FIXTURE_TRANSPORT_ROOT || "");
  if (!path.isAbsolute(transportRoot)) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_ROOT_INVALID", "environment", "V4_FIXTURE_TRANSPORT_ROOT must be absolute.");
  }
  const keyId = String(env.V4_FIXTURE_JOB_KEY_ID || "").trim();
  const secret = String(env.V4_FIXTURE_JOB_HMAC_KEY || "");
  if (!keyId || !secret) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_SIGNING_CONFIG_MISSING", "environment", "Fixture signing configuration is missing.");
  }
  const leaseMs = configuredInteger(env, "V4_FIXTURE_LEASE_MS", 5000, 1000, 10 * 60 * 1000);
  const heartbeatMs = configuredInteger(env, "V4_FIXTURE_HEARTBEAT_MS", 1000, 250, 60 * 1000);
  if (heartbeatMs * 2 >= leaseMs) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_HEARTBEAT_INVALID", "environment", "Heartbeat interval must be less than half the lease.");
  }
  return {
    transportRoot: path.resolve(transportRoot),
    keyId,
    secret,
    leaseMs,
    heartbeatMs,
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
    .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)/i.test(name)
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
      heartbeat(roots, claimRecord, config.leaseMs).catch((error) => {
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
  const claimRecord = await claim(roots, config.workerId, config.leaseMs, { nowMs: options.nowMs });
  if (!claimRecord) return null;
  let envelope;
  try {
    envelope = verifySignedJob(claimRecord.envelope, {
      nowMs: options.nowMs,
      resolveKey: (keyId) => keyId === config.keyId ? config.secret : null
    });
  } catch (error) {
    return rejectClaim(roots, claimRecord, error);
  }
  const startedAt = new Date(Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now()).toISOString();
  const runParity = options.runParity || runParityChild;
  try {
    const result = await runParity(envelope, roots, claimRecord, config, options);
    if (result.status === "succeeded") return complete(roots, claimRecord, result);
    return fail(roots, claimRecord, result);
  } catch (error) {
    if (options.signal?.aborted || error.code === "FIXTURE_CHILD_ABORTED") {
      return releaseOnShutdown(roots, claimRecord, envelope, {
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
    return fail(roots, claimRecord, result);
  }
}

function supervisorLockFile(roots) {
  return path.join(roots.runtime, "supervisor-lock.json");
}

async function acquireSupervisorLock(roots, config, nowMs = Date.now()) {
  const file = supervisorLockFile(roots);
  if (fs.existsSync(file)) {
    const existing = await readJson(roots, file).catch(() => null);
    const expiresAt = Date.parse(String(existing?.expiresAt || ""));
    if (existing?.schemaVersion === SUPERVISOR_LOCK_SCHEMA && Number.isFinite(expiresAt) && expiresAt > nowMs) {
      throw new SupervisorError("FIXTURE_SUPERVISOR_ALREADY_RUNNING", "supervisor_lock", "Another fixture supervisor owns the active lock.");
    }
    const archived = path.join(roots.stale, `supervisor-${nowMs}-${crypto.randomBytes(4).toString("hex")}.json`);
    await fsp.rename(file, archived);
  }
  const lock = {
    schemaVersion: SUPERVISOR_LOCK_SCHEMA,
    workerId: config.workerId,
    acquiredAt: new Date(nowMs).toISOString(),
    heartbeatAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + config.leaseMs).toISOString()
  };
  await writeJsonAtomic(roots.root, file, lock);
  return { file, lock };
}

async function renewSupervisorLock(roots, lockHandle, config, nowMs = Date.now()) {
  const current = await readJson(roots, lockHandle.file);
  if (current?.schemaVersion !== SUPERVISOR_LOCK_SCHEMA || current.workerId !== config.workerId) {
    throw new SupervisorError("FIXTURE_SUPERVISOR_LOCK_LOST", "supervisor_lock", "Supervisor lock ownership was lost.");
  }
  const renewed = {
    ...current,
    heartbeatAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + config.leaseMs).toISOString()
  };
  await writeJsonAtomic(roots.root, lockHandle.file, renewed, true);
  lockHandle.lock = renewed;
  return renewed;
}

async function releaseSupervisorLock(roots, lockHandle, config) {
  if (!fs.existsSync(lockHandle.file)) return false;
  const current = await readJson(roots, lockHandle.file).catch(() => null);
  if (current?.workerId !== config.workerId) return false;
  await fsp.unlink(lockHandle.file);
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
  const controller = new AbortController();
  const requestStop = (signal) => {
    if (controller.signal.aborted) return;
    logEvent("fixture_supervisor_shutdown_requested", { signal });
    controller.abort();
  };
  const onSigterm = () => requestStop("SIGTERM");
  const onSigint = () => requestStop("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  const lockHandle = await acquireSupervisorLock(roots, config);
  let lockTimer = null;
  try {
    const recovered = await recoverStaleClaims(roots, {
      resolveKey: (keyId) => keyId === config.keyId ? config.secret : null
    });
    const startup = typeof options.beforeReady === "function"
      ? await options.beforeReady({ roots, config, recovered })
      : null;
    logEvent("fixture_supervisor_ready", {
      workerId: config.workerId,
      concurrency: 1,
      mode: "fixture",
      automaticRetry: false,
      recoveredWithoutRetry: recovered.length,
      bootstrapStatus: startup?.status || null,
      bootstrapCollectorInvocations: Number(startup?.collectorInvocations || 0)
    });
    lockTimer = setInterval(() => {
      renewSupervisorLock(roots, lockHandle, config).catch(() => requestStop("LOCK_LOST"));
    }, config.heartbeatMs);
    lockTimer.unref();
    while (!controller.signal.aborted) {
      const result = await processNext(roots, config, { signal: controller.signal });
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
    const released = await releaseSupervisorLock(roots, lockHandle, config).catch(() => false);
    logEvent("fixture_supervisor_stopped", { workerId: config.workerId, lockReleased: released });
  }
}

module.exports = {
  DISABLED_GATES,
  SUPERVISOR_LOCK_SCHEMA,
  SUPERVISOR_SCHEMA,
  SupervisorError,
  acquireSupervisorLock,
  failedResult,
  main,
  processNext,
  releaseSupervisorLock,
  renewSupervisorLock,
  runParityChild,
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
