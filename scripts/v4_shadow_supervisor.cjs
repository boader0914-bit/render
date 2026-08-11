const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  JOB_SCHEMA,
  OFFLINE_NETWORK_BLOCKER,
  ensureDedicatedDataRoot,
  verifyOriginalCollector
} = require("./v4_worker_once.cjs");
const {
  TRANSPORT_SCHEMA,
  TransportError,
  claimNext,
  enqueueFixture,
  finishClaim,
  initializeTransport,
  recoverClaimsWithoutRetry,
  renewLease,
  safeFileId,
  writeJsonAtomic
} = require("./v4_shadow_transport.cjs");

const ROOT = path.resolve(__dirname, "..");
const ONE_SHOT_WORKER = path.join(__dirname, "v4_worker_once.cjs");
const HEARTBEAT_SCHEMA = "datalab-v4-shadow-heartbeat.v1";
const SUPERVISOR_LOCK_SCHEMA = "datalab-v4-shadow-supervisor-lock.v1";
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const REQUIRED_DISABLED_GATES = [
  "V4_EXTERNAL_CALLS_ENABLED",
  "V4_OPERATIONAL_PUBLISH_ENABLED",
  "V4_WEB_IMPORT_ENABLED"
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
  constructor(code, message) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
  }
}

function configuredInteger(name, fallback, min, max) {
  const source = process.env[name];
  if (source === undefined || source === "") return fallback;
  const number = Number(source);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new SupervisorError("SHADOW_ENV_INVALID", `${name} is outside its allowed range.`);
  }
  return number;
}

function validateShadowGates() {
  if (process.env.V4_SHADOW_MODE !== "fixture") {
    throw new SupervisorError("SHADOW_MODE_INVALID", "V4_SHADOW_MODE must be fixture.");
  }
  for (const name of REQUIRED_DISABLED_GATES) {
    if (process.env[name] !== "0") {
      throw new SupervisorError("SHADOW_GATE_NOT_DISABLED", `${name} must be exactly 0.`);
    }
  }
  if (globalThis.__DATALAB_V4_NETWORK_BLOCKED__ !== true) {
    throw new SupervisorError("SHADOW_NETWORK_BLOCKER_REQUIRED", "Supervisor must start with the offline network blocker.");
  }
}

function loadConfig() {
  validateShadowGates();
  const heartbeatMs = configuredInteger("V4_SHADOW_HEARTBEAT_MS", 5000, 50, 60000);
  const leaseMs = configuredInteger("V4_SHADOW_LEASE_MS", 30000, 250, 300000);
  if (leaseMs < heartbeatMs * 2) {
    throw new SupervisorError("SHADOW_ENV_INVALID", "V4_SHADOW_LEASE_MS must be at least twice V4_SHADOW_HEARTBEAT_MS.");
  }
  const bootstrap = process.env.V4_SHADOW_BOOTSTRAP_FIXTURE || "0";
  if (!/^[01]$/.test(bootstrap)) {
    throw new SupervisorError("SHADOW_ENV_INVALID", "V4_SHADOW_BOOTSTRAP_FIXTURE must be 0 or 1.");
  }
  return {
    pollMs: configuredInteger("V4_SHADOW_POLL_MS", 1000, 25, 60000),
    heartbeatMs,
    leaseMs,
    shutdownGraceMs: configuredInteger("V4_SHADOW_SHUTDOWN_GRACE_MS", 30000, 100, 240000),
    bootstrap: bootstrap === "1",
    bootstrapId: process.env.V4_SHADOW_BOOTSTRAP_ID || "phase3-shadow-001",
    bootstrapScenario: process.env.V4_SHADOW_BOOTSTRAP_SCENARIO || "success"
  };
}

function sensitiveValues() {
  return Object.entries(process.env)
    .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)/i.test(name) && String(value || "").length >= 4)
    .map(([, value]) => String(value))
    .sort((a, b) => b.length - a.length);
}

function safeText(value) {
  let text = String(value || "");
  for (const secret of sensitiveValues()) text = text.split(secret).join("[REDACTED]");
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function logEvent(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: HEARTBEAT_SCHEMA,
    timestamp: new Date().toISOString(),
    event,
    ...fields
  })}\n`);
}

async function acquireSupervisorLock(roots, workerId, leaseMs) {
  const lockFile = path.join(roots.runtime, "supervisor.lock");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await fsp.open(lockFile, "wx", 0o600);
      const now = Date.now();
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: SUPERVISOR_LOCK_SCHEMA,
        workerId,
        pid: process.pid,
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + leaseMs).toISOString()
      }, null, 2)}\n`, "utf8");
      await handle.close();
      return lockFile;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(await fsp.readFile(lockFile, "utf8"));
      } catch {
        throw new SupervisorError("SUPERVISOR_LOCK_INVALID", "Existing supervisor lock cannot be verified.");
      }
      const fresh = Date.parse(existing.expiresAt || "") > Date.now();
      if (fresh) {
        throw new SupervisorError("SUPERVISOR_ALREADY_RUNNING", "Another V4 shadow supervisor owns the worker root.");
      }
      const stale = path.join(
        roots.runtime,
        `stale-supervisor-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`
      );
      try {
        await fsp.rename(lockFile, stale);
      } catch (renameError) {
        if (renameError.code === "ENOENT") continue;
        throw renameError;
      }
    }
  }
  throw new SupervisorError("SUPERVISOR_LOCK_RACE", "Supervisor lock could not be acquired.");
}

async function releaseSupervisorLock(lockFile, workerId) {
  try {
    const record = JSON.parse(await fsp.readFile(lockFile, "utf8"));
    if (record.workerId === workerId) await fsp.unlink(lockFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function bootstrapEnvelope(config) {
  const id = safeFileId(config.bootstrapId, "V4_SHADOW_BOOTSTRAP_ID");
  if (id.length > 80) throw new SupervisorError("SHADOW_ENV_INVALID", "V4_SHADOW_BOOTSTRAP_ID is too long.");
  return {
    schemaVersion: TRANSPORT_SCHEMA,
    transportId: `bootstrap-${id}`,
    fixtureScenario: config.bootstrapScenario,
    job: {
      schemaVersion: JOB_SCHEMA,
      jobId: `shadow-${id}`,
      idempotencyKey: `shadow-${id}`,
      keyword: "Gyeongnam glamping shadow fixture",
      checkIn: "2026-08-12",
      checkOut: "2026-08-18",
      adults: 2,
      searchMode: "keyword",
      productMode: "all",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      detailRankRanges: "1-10",
      bookingRangeDays: 7,
      bookingRangePlaceLimit: 10
    }
  };
}

function minimalChildEnv(dataRoot) {
  const env = {};
  for (const name of BASE_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    NODE_ENV: "test",
    V4_WORKER_ALLOW_OFFLINE_FIXTURE: "1",
    V4_WORKER_OFFLINE_NETWORK_BLOCKER: "1",
    V4_WORKER_DATA_DIR: dataRoot
  });
  for (const name of ["V4_WORKER_TIMEOUT_MS", "V4_WORKER_MAX_ARTIFACT_BYTES"]) {
    if (process.env[name] !== undefined && process.env[name] !== "") env[name] = process.env[name];
  }
  return env;
}

function runOneShot(claim, dataRoot, onChild) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--require",
      OFFLINE_NETWORK_BLOCKER,
      ONE_SHOT_WORKER,
      `--offline-fixture=${claim.envelope.fixtureScenario}`
    ], {
      cwd: ROOT,
      env: minimalChildEnv(dataRoot),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    onChild(child);
    let stdout = "";
    let stderr = "";
    let tooLarge = false;
    const collect = (target, chunk) => {
      const next = target + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
        tooLarge = true;
        child.kill("SIGTERM");
        return target;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    child.once("error", (error) => {
      resolve({
        code: null,
        result: { status: "failed", code: "SHADOW_CHILD_SPAWN_FAILED", stage: "supervisor", message: safeText(error.message), retryable: false }
      });
    });
    child.once("close", (code) => {
      if (tooLarge) {
        resolve({ code, result: { status: "failed", code: "SHADOW_CHILD_OUTPUT_TOO_LARGE", stage: "supervisor", retryable: false } });
        return;
      }
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) {
        resolve({
          code,
          result: {
            status: "failed",
            code: "SHADOW_CHILD_PROTOCOL_INVALID",
            stage: "supervisor",
            message: safeText(stderr || "One-shot worker did not return exactly one JSON line."),
            retryable: false
          }
        });
        return;
      }
      try {
        resolve({ code, result: JSON.parse(lines[0]) });
      } catch {
        resolve({
          code,
          result: { status: "failed", code: "SHADOW_CHILD_PROTOCOL_INVALID", stage: "supervisor", retryable: false }
        });
      }
    });
    child.stdin.end(JSON.stringify(claim.envelope.job));
  });
}

async function main(options = {}) {
  const config = loadConfig();
  await verifyOriginalCollector();
  const workerRoots = await ensureDedicatedDataRoot(process.env.V4_WORKER_DATA_DIR);
  const roots = await initializeTransport(workerRoots);
  const workerId = `shadow-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const lockFile = await acquireSupervisorLock(roots, workerId, config.leaseMs);
  let state = "starting";
  let currentClaim = null;
  let currentChild = null;
  let stopRequested = false;
  let shutdownSignal = "";
  let wakeSleep = null;
  let shutdownTimer = null;
  let killTimer = null;
  let heartbeatQueue = Promise.resolve();
  let leaseError = null;
  let heartbeatFailure = null;
  let leaseRenewalEnabled = false;

  const heartbeatValue = () => {
    const now = Date.now();
    return {
      schemaVersion: HEARTBEAT_SCHEMA,
      workerId,
      pid: process.pid,
      state,
      currentTransportId: currentClaim?.envelope.transportId || null,
      heartbeatAt: new Date(now).toISOString(),
      expiresAt: new Date(now + config.leaseMs).toISOString(),
      concurrency: 1,
      shadowMode: "fixture",
      outboundNetworkBlocked: true,
      operationalPublishEnabled: false,
      webImportEnabled: false,
      stopRequested
    };
  };

  const scheduleHeartbeat = () => {
    heartbeatQueue = heartbeatQueue.then(async () => {
      const heartbeat = heartbeatValue();
      const currentLock = JSON.parse(await fsp.readFile(lockFile, "utf8"));
      if (currentLock.workerId !== workerId) {
        throw new SupervisorError("SUPERVISOR_LOCK_LOST", "Supervisor no longer owns the worker root.");
      }
      await writeJsonAtomic(lockFile, {
        schemaVersion: SUPERVISOR_LOCK_SCHEMA,
        workerId,
        pid: process.pid,
        heartbeatAt: heartbeat.heartbeatAt,
        expiresAt: heartbeat.expiresAt
      }, true);
      const heartbeatFile = path.join(roots.runtime, "supervisor-heartbeat.json");
      await writeJsonAtomic(heartbeatFile, heartbeat, fs.existsSync(heartbeatFile));
      if (currentClaim && leaseRenewalEnabled) {
        await renewLease(roots, currentClaim, workerId, config.leaseMs, false);
      }
    }).catch((error) => {
      leaseError = error;
      if (!heartbeatFailure) {
        heartbeatFailure = error;
        stopRequested = true;
        state = "failed";
        logEvent("heartbeat_failed", { code: error?.code || "SHADOW_HEARTBEAT_FAILED", message: safeText(error?.message) });
        if (wakeSleep) wakeSleep();
      }
      if (currentChild) currentChild.kill("SIGTERM");
    });
    return heartbeatQueue;
  };

  const requestStop = (signal) => {
    if (stopRequested) return;
    stopRequested = true;
    shutdownSignal = signal;
    state = currentClaim ? "draining" : "stopping";
    scheduleHeartbeat();
    if (wakeSleep) wakeSleep();
    if (currentChild) {
      shutdownTimer = setTimeout(() => {
        currentChild?.kill("SIGTERM");
        killTimer = setTimeout(() => currentChild?.kill("SIGKILL"), 5000);
        killTimer.unref();
      }, config.shutdownGraceMs);
      shutdownTimer.unref();
    }
  };

  const onSigterm = () => requestStop("SIGTERM");
  const onSigint = () => requestStop("SIGINT");
  const onAbort = () => requestStop("ABORT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener?.("abort", onAbort, { once: true });
  const heartbeatTimer = setInterval(scheduleHeartbeat, config.heartbeatMs);
  heartbeatTimer.unref();

  try {
    const recovered = await recoverClaimsWithoutRetry(roots);
    if (recovered.length) logEvent("claims_recovered_without_retry", { count: recovered.length });
    if (config.bootstrap) {
      try {
        await enqueueFixture(roots, bootstrapEnvelope(config));
        logEvent("bootstrap_enqueued", { transportId: `bootstrap-${config.bootstrapId}` });
      } catch (error) {
        if (!(error instanceof TransportError) || error.code !== "TRANSPORT_DUPLICATE") throw error;
        logEvent("bootstrap_duplicate", { transportId: `bootstrap-${config.bootstrapId}` });
      }
    }
    state = "idle";
    await scheduleHeartbeat();
    logEvent("supervisor_ready", { workerId, concurrency: 1, shadowMode: "fixture" });

    while (!stopRequested) {
      currentClaim = await claimNext(roots, workerId, config.leaseMs);
      if (!currentClaim) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            wakeSleep = null;
            resolve();
          }, config.pollMs);
          wakeSleep = () => {
            clearTimeout(timer);
            wakeSleep = null;
            resolve();
          };
        });
        continue;
      }

      leaseError = null;
      leaseRenewalEnabled = true;
      state = "running";
      await scheduleHeartbeat();
      logEvent("job_claimed", {
        transportId: currentClaim.envelope.transportId,
        jobId: currentClaim.envelope.job.jobId,
        fixtureScenario: currentClaim.envelope.fixtureScenario
      });
      const childRun = await runOneShot(currentClaim, workerRoots.root, (child) => { currentChild = child; });
      currentChild = null;
      leaseRenewalEnabled = false;
      await heartbeatQueue;
      if (shutdownTimer) clearTimeout(shutdownTimer);
      if (killTimer) clearTimeout(killTimer);
      shutdownTimer = null;
      killTimer = null;

      let result = childRun.result;
      if (leaseError) {
        result = {
          status: "failed",
          code: "LEASE_HEARTBEAT_FAILED",
          stage: "lease",
          message: safeText(leaseError.message),
          retryable: false
        };
      }
      const completed = childRun.code === 0 && ["succeeded", "duplicate"].includes(result?.status);
      const terminal = await finishClaim(roots, currentClaim, completed ? "completed" : "failed", result);
      logEvent(completed ? "job_completed" : "job_failed", {
        transportId: terminal.transportId,
        jobId: terminal.jobId,
        code: terminal.code
      });
      currentClaim = null;
      leaseRenewalEnabled = false;
      state = stopRequested ? "stopping" : "idle";
      await scheduleHeartbeat();
    }
    if (heartbeatFailure) {
      throw new SupervisorError("SHADOW_HEARTBEAT_FAILED", safeText(heartbeatFailure.message));
    }
    state = "stopped";
    await scheduleHeartbeat();
    logEvent("supervisor_stopped", { workerId, signal: shutdownSignal || null });
  } finally {
    clearInterval(heartbeatTimer);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    if (killTimer) clearTimeout(killTimer);
    await heartbeatQueue.catch(() => {});
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    options.signal?.removeEventListener?.("abort", onAbort);
    await releaseSupervisorLock(lockFile, workerId).catch(() => {});
  }
}

module.exports = {
  HEARTBEAT_SCHEMA,
  SupervisorError,
  bootstrapEnvelope,
  loadConfig,
  main
};

if (require.main === module) {
  main().catch((error) => {
    logEvent("supervisor_fatal", {
      code: error?.code || "SHADOW_SUPERVISOR_FATAL",
      message: safeText(error?.message || error)
    });
    process.exitCode = 1;
  });
}
