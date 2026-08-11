const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  DEFAULT_SUITE,
  PARITY_SOURCE_BASELINE_COMMIT,
  PARITY_SUITE_SCHEMA,
  ensureParityRoot
} = require("./v4_collector_parity.cjs");
const {
  BASELINE_COMMIT,
  EXPECTED_COLLECTOR_BLOB
} = require("./v4_worker_once.cjs");

const ROOT = path.resolve(__dirname, "..");
const PARITY_RUNNER = path.join(__dirname, "v4_collector_parity.cjs");
const NETWORK_BLOCKER = path.join(__dirname, "fixtures", "v4_network_blocker.cjs");
const FIXTURE_JOB = path.join(ROOT, "tests", "fixtures", "v4_collector_parity_job.json");
const HOST_SCHEMA = "datalab-v4-parity-shadow-host.v1";
const ATTEMPT_SCHEMA = "datalab-v4-parity-shadow-attempt.v1";
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;
const REQUIRED_DISABLED_GATES = [
  "V4_PARITY_EXTERNAL_CALLS_ENABLED",
  "V4_PARITY_OPERATIONAL_PUBLISH_ENABLED",
  "V4_PARITY_WEB_IMPORT_ENABLED"
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

class HostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

function logEvent(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: HOST_SCHEMA,
    timestamp: new Date().toISOString(),
    event,
    ...fields
  })}\n`);
}

function validateEnvironment() {
  if (process.env.NODE_ENV !== "test" || process.env.V4_PARITY_MODE !== "fixture") {
    throw new HostError("PARITY_HOST_MODE_INVALID", "Parity shadow host requires test fixture mode.");
  }
  for (const name of REQUIRED_DISABLED_GATES) {
    if (process.env[name] !== "0") {
      throw new HostError("PARITY_HOST_GATE_NOT_DISABLED", `${name} must be exactly 0.`);
    }
  }
  if (globalThis.__DATALAB_V4_NETWORK_BLOCKED__ !== true) {
    throw new HostError("PARITY_HOST_BLOCKER_REQUIRED", "Parity shadow host requires the network blocker preload.");
  }
  const dataRoot = String(process.env.V4_PARITY_DATA_DIR || "");
  if (!path.isAbsolute(dataRoot)) {
    throw new HostError("PARITY_HOST_DATA_ROOT_INVALID", "V4_PARITY_DATA_DIR must be an absolute path.");
  }
  return path.resolve(dataRoot);
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fsp.rename(temporary, filePath);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new HostError("PARITY_HOST_STATE_INVALID", "Parity shadow state is not valid JSON.");
  }
}

function validateSuiteReport(report) {
  const scenariosValid = Array.isArray(report?.scenarios)
    && report.scenarios.length === DEFAULT_SUITE.length
    && report.scenarios.every((item, index) => item?.scenario === DEFAULT_SUITE[index]
      && item.matched === true
      && item.actualExternalRequests === 0);
  const replayValid = report?.idempotencyReplay?.status === "duplicate"
    && report.idempotencyReplay.code === "IDEMPOTENT_REPLAY"
    && report.idempotencyReplay.duplicate === true;
  if (
    report?.schemaVersion !== PARITY_SUITE_SCHEMA
    || report.baselineCommit !== PARITY_SOURCE_BASELINE_COMMIT
    || report.collectorBaselineCommit !== BASELINE_COMMIT
    || report.collectorBlobBefore !== EXPECTED_COLLECTOR_BLOB
    || report.collectorBlobAfter !== EXPECTED_COLLECTOR_BLOB
    || report.allBehavioralComparisonsMatched !== true
    || report.actualExternalRequests !== 0
    || report.operationalWrites !== false
    || !scenariosValid
    || !replayValid
  ) {
    throw new HostError("PARITY_HOST_REPORT_INVALID", "Existing parity suite report did not pass the offline safety contract.");
  }
  return {
    matched: true,
    actualExternalRequests: 0,
    operationalWrites: false,
    scenarioCount: Array.isArray(report.scenarios) ? report.scenarios.length : 0
  };
}

function childEnvironment() {
  const env = {};
  for (const name of BASE_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.NODE_ENV = "test";
  return env;
}

function runParitySuite(dataRoot, onChild) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--require",
      NETWORK_BLOCKER,
      PARITY_RUNNER,
      "--suite",
      "--job-file",
      FIXTURE_JOB,
      "--root",
      dataRoot
    ], {
      cwd: ROOT,
      env: childEnvironment(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    onChild(child);
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
    child.once("error", () => resolve({ status: "failed", code: "PARITY_HOST_CHILD_SPAWN_FAILED" }));
    child.once("close", (exitCode) => {
      if (outputTooLarge) {
        resolve({ status: "failed", code: "PARITY_HOST_CHILD_OUTPUT_TOO_LARGE", exitCode });
        return;
      }
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) {
        resolve({ status: "failed", code: "PARITY_HOST_CHILD_PROTOCOL_INVALID", exitCode, stderrPresent: Boolean(stderr) });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(lines[0]);
      } catch {
        resolve({ status: "failed", code: "PARITY_HOST_CHILD_PROTOCOL_INVALID", exitCode });
        return;
      }
      const succeeded = exitCode === 0
        && parsed.status === "succeeded"
        && parsed.matched === true
        && parsed.actualExternalRequests === 0
        && parsed.operationalWrites === false;
      resolve({
        status: succeeded ? "succeeded" : "failed",
        code: succeeded ? "OK" : "PARITY_HOST_SUITE_FAILED",
        matched: parsed.matched === true,
        actualExternalRequests: Number.isInteger(parsed.actualExternalRequests) ? parsed.actualExternalRequests : null,
        operationalWrites: parsed.operationalWrites === true,
        exitCode
      });
    });
  });
}

async function main() {
  const dataRoot = validateEnvironment();
  const roots = await ensureParityRoot(dataRoot);
  const attemptFile = path.join(roots.root, "parity-shadow-attempt.json");
  const suiteFile = path.join(roots.reports, "parity-suite.json");
  let currentChild = null;
  let stopping = false;
  let stopResolve;
  let killTimer = null;
  let idleTimer = null;
  const stopped = new Promise((resolve) => { stopResolve = resolve; });
  const requestStop = (signal) => {
    if (stopping) return;
    stopping = true;
    logEvent("parity_host_shutdown_requested", { signal, childActive: Boolean(currentChild) });
    if (currentChild) {
      currentChild.kill("SIGTERM");
      killTimer = setTimeout(() => currentChild?.kill("SIGKILL"), 5000);
      killTimer.unref();
    }
    stopResolve();
  };
  const onSigterm = () => requestStop("SIGTERM");
  const onSigint = () => requestStop("SIGINT");
  process.once("SIGTERM", onSigterm);
  process.once("SIGINT", onSigint);

  try {
    logEvent("parity_host_started", { mode: "fixture", concurrency: 1, automaticRetry: false });
    const existingAttempt = await readJson(attemptFile);
    const existingSuite = await readJson(suiteFile);
    if (existingSuite) {
      const summary = validateSuiteReport(existingSuite);
      logEvent("parity_suite_reused", { ...summary, collectorInvocations: 0 });
    } else if (existingAttempt) {
      logEvent("parity_suite_blocked", {
        code: "PARITY_HOST_PREVIOUS_ATTEMPT_NO_VALID_REPORT",
        automaticRetry: false,
        collectorInvocations: 0
      });
    } else {
      await writeJsonAtomic(attemptFile, {
        schemaVersion: ATTEMPT_SCHEMA,
        status: "started",
        startedAt: new Date().toISOString(),
        baselineCommit: BASELINE_COMMIT,
        collectorBlob: EXPECTED_COLLECTOR_BLOB
      });
      const result = await runParitySuite(dataRoot, (child) => { currentChild = child; });
      currentChild = null;
      if (killTimer) clearTimeout(killTimer);
      killTimer = null;
      await writeJsonAtomic(attemptFile, {
        schemaVersion: ATTEMPT_SCHEMA,
        status: result.status,
        completedAt: new Date().toISOString(),
        baselineCommit: BASELINE_COMMIT,
        collectorBlob: EXPECTED_COLLECTOR_BLOB,
        code: result.code
      });
      logEvent("parity_suite_terminal", result);
    }
    logEvent("parity_host_idle", { automaticRetry: false });
    idleTimer = setInterval(() => {}, 60000);
    await stopped;
  } finally {
    if (idleTimer) clearInterval(idleTimer);
    if (killTimer) clearTimeout(killTimer);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    logEvent("parity_host_stopped", { mode: "fixture" });
  }
}

if (require.main === module) {
  main().catch((error) => {
    logEvent("parity_host_fatal", {
      code: /^[A-Z0-9_]{2,100}$/.test(String(error?.code || "")) ? error.code : "PARITY_HOST_FATAL"
    });
    process.exitCode = 1;
  });
}

module.exports = {
  ATTEMPT_SCHEMA,
  HOST_SCHEMA,
  HostError,
  runParitySuite,
  validateEnvironment,
  validateSuiteReport
};
