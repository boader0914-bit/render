const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CANARY = path.join(__dirname, "v4_canary_once.cjs");
const BLOCKER = path.join(__dirname, "fixtures", "v4_network_blocker.cjs");
const FIXTURE_JOB = path.join(ROOT, "tests", "fixtures", "v4_canary_job.json");
const HOST_SCHEMA = "datalab-v4-canary-host.v1";
const MAX_CHILD_OUTPUT_BYTES = 64 * 1024;

function logEvent(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: HOST_SCHEMA,
    timestamp: new Date().toISOString(),
    event,
    ...fields
  })}\n`);
}

function parseArgs(argv) {
  if (argv.length !== 1 || !["--offline-fixture", "--approved-live"].includes(argv[0])) {
    const error = new Error("Canary host requires exactly one approved mode.");
    error.code = "CANARY_HOST_ARGUMENT_INVALID";
    throw error;
  }
  return argv[0] === "--offline-fixture" ? "offline" : "live";
}

function childArgs(mode) {
  if (mode === "offline") {
    return [
      "--require",
      BLOCKER,
      CANARY,
      "--offline-fixture=success",
      `--job-file=${FIXTURE_JOB}`
    ];
  }
  return [CANARY, "--approved-live", "--job-env"];
}

function runCanaryOnce(mode, onChild) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, childArgs(mode), {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    onChild(child);
    let stdout = "";
    let stderr = "";
    let tooLarge = false;
    const collect = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
        tooLarge = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    child.once("error", () => resolve({ status: "failed", code: "CANARY_HOST_CHILD_SPAWN_FAILED" }));
    child.once("close", (exitCode) => {
      if (tooLarge) {
        resolve({ status: "failed", code: "CANARY_HOST_CHILD_OUTPUT_TOO_LARGE", exitCode });
        return;
      }
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length !== 1) {
        resolve({ status: "failed", code: "CANARY_HOST_CHILD_PROTOCOL_INVALID", exitCode, stderrPresent: Boolean(stderr) });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(lines[0]);
      } catch {
        resolve({ status: "failed", code: "CANARY_HOST_CHILD_PROTOCOL_INVALID", exitCode });
        return;
      }
      resolve({
        status: ["succeeded", "duplicate", "failed"].includes(parsed?.status) ? parsed.status : "failed",
        code: /^[A-Z0-9_]{2,80}$/.test(String(parsed?.code || "")) ? parsed.code : "CANARY_HOST_CHILD_PROTOCOL_INVALID",
        jobId: /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(String(parsed?.jobId || "")) ? parsed.jobId : "",
        provider: parsed?.provider === "naver-local-search" ? parsed.provider : null,
        artifactId: /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,160}$/.test(String(parsed?.artifactId || "")) ? parsed.artifactId : null,
        requestCount: Number.isInteger(parsed?.requestCount) ? parsed.requestCount : null,
        duplicate: parsed?.duplicate === true,
        operationalWrites: parsed?.operationalWrites === true,
        exitCode
      });
    });
  });
}

async function main() {
  const mode = parseArgs(process.argv.slice(2));
  if (mode === "offline" && globalThis.__DATALAB_V4_NETWORK_BLOCKED__ !== true) {
    const error = new Error("Offline canary host requires the network blocker.");
    error.code = "CANARY_HOST_BLOCKER_REQUIRED";
    throw error;
  }
  let currentChild = null;
  let stopping = false;
  let stopResolve = null;
  let killTimer = null;
  let idleTimer = null;
  const stopped = new Promise((resolve) => { stopResolve = resolve; });
  const requestStop = (signal) => {
    if (stopping) return;
    stopping = true;
    logEvent("canary_host_shutdown_requested", { signal, childActive: Boolean(currentChild) });
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
    logEvent("canary_host_started", { mode, automaticRetry: false, concurrency: 1 });
    const result = await runCanaryOnce(mode, (child) => { currentChild = child; });
    currentChild = null;
    if (killTimer) clearTimeout(killTimer);
    killTimer = null;
    logEvent("canary_run_terminal", result);
    logEvent("canary_host_idle", { mode, runCount: 1, automaticRetry: false });
    idleTimer = setInterval(() => {}, 60000);
    await stopped;
  } finally {
    if (idleTimer) clearInterval(idleTimer);
    if (killTimer) clearTimeout(killTimer);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    logEvent("canary_host_stopped", { mode });
  }
}

if (require.main === module) {
  main().catch((error) => {
    logEvent("canary_host_fatal", {
      code: /^[A-Z0-9_]{2,80}$/.test(String(error?.code || "")) ? error.code : "CANARY_HOST_FATAL"
    });
    process.exitCode = 1;
  });
}
