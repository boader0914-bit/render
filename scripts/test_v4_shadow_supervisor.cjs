const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const {
  EXPECTED_COLLECTOR_BLOB,
  JOB_SCHEMA,
  OFFLINE_NETWORK_BLOCKER,
  ensureDedicatedDataRoot,
  gitBlobSha
} = require("./v4_worker_once.cjs");
const { bootstrapEnvelope, main: runSupervisor } = require("./v4_shadow_supervisor.cjs");
const {
  TRANSPORT_SCHEMA,
  claimNext,
  enqueueFixture,
  initializeTransport,
  recordPath
} = require("./v4_shadow_transport.cjs");

const ROOT = path.resolve(__dirname, "..");
const SUPERVISOR = path.join(__dirname, "v4_shadow_supervisor.cjs");
const ENQUEUE = path.join(__dirname, "v4_shadow_enqueue_fixture.cjs");
const COLLECTOR = path.join(__dirname, "gyeongnam_glamping_crawl.cjs");
const TEST_SECRET = "phase3-shadow-private-secret-value";

function baseJob(suffix) {
  return {
    schemaVersion: JOB_SCHEMA,
    jobId: `shadow-${suffix}`,
    idempotencyKey: `shadow-key-${suffix}`,
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
  };
}

function envelope(transportId, job, fixtureScenario = "success") {
  return { schemaVersion: TRANSPORT_SCHEMA, transportId, fixtureScenario, job };
}

async function waitFor(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function readJsonWhenReady(filePath) {
  return waitFor(async () => {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  }, path.basename(filePath));
}

function waitForExit(child, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for child exit")), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function runEnqueue(dataRoot, input) {
  const result = spawnSync(process.execPath, ["--require", OFFLINE_NETWORK_BLOCKER, ENQUEUE], {
    cwd: ROOT,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, V4_WORKER_DATA_DIR: dataRoot }
  });
  const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `enqueue output was invalid: ${result.stdout}`);
  assert.equal(String(result.stdout).includes(TEST_SECRET), false);
  assert.equal(String(result.stderr).includes(TEST_SECRET), false);
  return { status: result.status, result: JSON.parse(lines[0]) };
}

async function scanForSecret(root, secret) {
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        const bytes = await fsp.readFile(target);
        assert.equal(bytes.includes(Buffer.from(secret)), false, `secret leaked into ${target}`);
      }
    }
  }
  await visit(root);
}

async function main() {
  assert.equal(globalThis.__DATALAB_V4_NETWORK_BLOCKED__, true);
  assert.throws(() => require("node:http").get("http://127.0.0.1:9"), { code: "V4_OFFLINE_NETWORK_BLOCKED" });
  assert.throws(() => fetch("https://example.invalid"), { code: "V4_OFFLINE_NETWORK_BLOCKED" });
  assert.equal(await gitBlobSha(COLLECTOR), EXPECTED_COLLECTOR_BLOB);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "datalab-v4-shadow-"));
  const dataRoot = path.join(tmp, "worker-root");
  const envNames = [
    "NODE_ENV",
    "V4_WORKER_DATA_DIR",
    "V4_SHADOW_MODE",
    "V4_EXTERNAL_CALLS_ENABLED",
    "V4_OPERATIONAL_PUBLISH_ENABLED",
    "V4_WEB_IMPORT_ENABLED",
    "V4_SHADOW_POLL_MS",
    "V4_SHADOW_HEARTBEAT_MS",
    "V4_SHADOW_LEASE_MS",
    "V4_SHADOW_STARTUP_WAIT_MS",
    "V4_SHADOW_SHUTDOWN_GRACE_MS",
    "V4_SHADOW_FORCE_KILL_MS",
    "V4_SHADOW_BOOTSTRAP_FIXTURE",
    "V4_SHADOW_BOOTSTRAP_ID",
    "V4_SHADOW_BOOTSTRAP_SCENARIO",
    "V4_SHADOW_PRIVATE_SECRET"
  ];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const originalWrite = process.stdout.write.bind(process.stdout);
  let capturedOutput = "";
  const activeControllers = [];
  const activeSupervisors = [];
  const startTrackedSupervisor = (controller) => {
    activeControllers.push(controller);
    const supervisor = runSupervisor({ signal: controller.signal });
    supervisor.catch(() => {});
    activeSupervisors.push(supervisor);
    return supervisor;
  };
  process.stdout.write = function capture(chunk, ...args) {
    capturedOutput += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return originalWrite(chunk, ...args);
  };

  Object.assign(process.env, {
    NODE_ENV: "production",
    V4_WORKER_DATA_DIR: dataRoot,
    V4_SHADOW_MODE: "fixture",
    V4_EXTERNAL_CALLS_ENABLED: "0",
    V4_OPERATIONAL_PUBLISH_ENABLED: "0",
    V4_WEB_IMPORT_ENABLED: "0",
    V4_SHADOW_POLL_MS: "25",
    V4_SHADOW_HEARTBEAT_MS: "50",
    V4_SHADOW_LEASE_MS: "500",
    V4_SHADOW_STARTUP_WAIT_MS: "100",
    V4_SHADOW_SHUTDOWN_GRACE_MS: "2000",
    V4_SHADOW_FORCE_KILL_MS: "100",
    V4_SHADOW_BOOTSTRAP_FIXTURE: "1",
    V4_SHADOW_BOOTSTRAP_ID: "phase3-test",
    V4_SHADOW_BOOTSTRAP_SCENARIO: "slow",
    V4_SHADOW_PRIVATE_SECRET: TEST_SECRET
  });

  try {
    const noBlocker = spawnSync(process.execPath, [SUPERVISOR], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, V4_WORKER_DATA_DIR: path.join(tmp, "no-blocker-root") }
    });
    assert.notEqual(noBlocker.status, 0);
    assert.match(noBlocker.stdout, /SHADOW_NETWORK_BLOCKER_REQUIRED/);
    assert.equal(noBlocker.stdout.includes(TEST_SECRET), false);
    assert.equal(noBlocker.stderr.includes(TEST_SECRET), false);

    const firstController = new AbortController();
    const firstPromise = startTrackedSupervisor(firstController);
    const transportBase = path.join(dataRoot, "shadow-transport");
    const leaseFile = path.join(transportBase, "leases", "bootstrap-phase3-test.json");
    const heartbeatFile = path.join(transportBase, "runtime", "supervisor-heartbeat.json");
    const firstLease = await readJsonWhenReady(leaseFile);
    const renewedLease = await waitFor(async () => {
      const lease = JSON.parse(await fsp.readFile(leaseFile, "utf8"));
      return Date.parse(lease.heartbeatAt) > Date.parse(firstLease.heartbeatAt) ? lease : null;
    }, "lease heartbeat renewal");
    assert.ok(Date.parse(renewedLease.heartbeatAt) > Date.parse(firstLease.heartbeatAt));
    assert.ok(Date.parse(renewedLease.expiresAt) > Date.parse(firstLease.expiresAt));

    const second = spawnSync(process.execPath, ["--require", OFFLINE_NETWORK_BLOCKER, SUPERVISOR], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, V4_SHADOW_BOOTSTRAP_FIXTURE: "0" },
      timeout: 3000
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stdout, /SUPERVISOR_LOCK_WAIT_TIMEOUT/);
    assert.equal(second.stdout.includes(TEST_SECRET), false);
    assert.equal(second.stderr.includes(TEST_SECRET), false);

    const bootstrapTerminal = path.join(transportBase, "completed", "bootstrap-phase3-test.json");
    const firstTerminal = await readJsonWhenReady(bootstrapTerminal);
    assert.equal(firstTerminal.status, "completed");
    assert.equal(firstTerminal.result.status, "succeeded");
    assert.equal((await fsp.readdir(path.join(dataRoot, "artifacts"))).length, 1);
    const firstHeartbeat = JSON.parse(await fsp.readFile(heartbeatFile, "utf8"));
    firstController.abort();
    await firstPromise;
    assert.equal((await readJsonWhenReady(heartbeatFile)).state, "stopped");
    assert.equal(fs.existsSync(path.join(transportBase, "runtime", "supervisor.lock")), false);
    assert.match(capturedOutput, /"event":"shutdown_requested"/);
    assert.match(capturedOutput, /"event":"heartbeat_finalized"/);
    assert.match(capturedOutput, /"event":"supervisor_lock_released"/);
    assert.match(capturedOutput, /"event":"shutdown_completed"/);

    const restartController = new AbortController();
    const restartPromise = startTrackedSupervisor(restartController);
    await waitFor(async () => {
      const heartbeat = await readJsonWhenReady(heartbeatFile);
      return heartbeat.workerId !== firstHeartbeat.workerId && heartbeat.state === "idle";
    }, "duplicate bootstrap restart");
    restartController.abort();
    await restartPromise;
    assert.equal((await fsp.readdir(path.join(dataRoot, "artifacts"))).length, 1);
    assert.equal((await fsp.readdir(path.join(transportBase, "completed"))).length, 1);

    const bootstrapJob = bootstrapEnvelope({ bootstrapId: "phase3-test", bootstrapScenario: "success" }).job;
    const replay = runEnqueue(dataRoot, envelope("replay-phase3-test", bootstrapJob));
    assert.equal(replay.status, 0);
    assert.equal(replay.result.status, "enqueued");

    process.env.V4_SHADOW_BOOTSTRAP_FIXTURE = "0";
    const drainController = new AbortController();
    const drainPromise = startTrackedSupervisor(drainController);
    const replayTerminal = await readJsonWhenReady(path.join(transportBase, "completed", "replay-phase3-test.json"));
    assert.equal(replayTerminal.result.status, "duplicate");
    assert.equal(replayTerminal.result.code, "IDEMPOTENT_REPLAY");
    assert.equal((await fsp.readdir(path.join(dataRoot, "artifacts"))).length, 1);

    const drainJob = baseJob("drain");
    const drainEnqueue = runEnqueue(dataRoot, envelope("drain-signal", drainJob, "slow"));
    assert.equal(drainEnqueue.status, 0);
    await readJsonWhenReady(path.join(transportBase, "leases", "drain-signal.json"));
    drainController.abort();
    await drainPromise;
    const drained = await readJsonWhenReady(path.join(transportBase, "completed", "drain-signal.json"));
    assert.equal(drained.status, "completed");
    assert.equal(drained.result.status, "succeeded");
    assert.equal((await fsp.readdir(path.join(dataRoot, "artifacts"))).length, 2);
    assert.equal((await readJsonWhenReady(heartbeatFile)).state, "stopped");
    assert.match(capturedOutput, /"event":"child_drain_started"/);
    assert.match(capturedOutput, /"event":"child_drain_completed"/);

    const forcedJob = baseJob("forced");
    const forcedEnqueue = runEnqueue(dataRoot, envelope("forced-signal", forcedJob, "slow"));
    assert.equal(forcedEnqueue.status, 0);
    process.env.V4_SHADOW_SHUTDOWN_GRACE_MS = "100";
    process.env.V4_SHADOW_FORCE_KILL_MS = "100";
    const forcedController = new AbortController();
    const forcedPromise = startTrackedSupervisor(forcedController);
    await readJsonWhenReady(path.join(transportBase, "leases", "forced-signal.json"));
    forcedController.abort();
    await forcedPromise;
    const forced = await readJsonWhenReady(path.join(transportBase, "failed", "forced-signal.json"));
    assert.equal(forced.status, "failed");
    assert.equal(forced.retryable, false);
    assert.match(capturedOutput, /"event":"child_drain_completed"[^\n]*"escalation":"sig(?:term|kill)"/);
    assert.equal(fs.existsSync(path.join(transportBase, "runtime", "supervisor.lock")), false);
    process.env.V4_SHADOW_SHUTDOWN_GRACE_MS = "2000";

    const workerRoots = await ensureDedicatedDataRoot(dataRoot);
    const roots = await initializeTransport(workerRoots);
    await enqueueFixture(roots, envelope("abandoned-lease", baseJob("abandoned"), "slow"));
    const abandonedClaim = await claimNext(roots, "abandoned-worker", 500);
    await fsp.link(abandonedClaim.claimFile, recordPath(roots, "inbox", "abandoned-lease"));
    assert.equal(fs.existsSync(recordPath(roots, "leases", "abandoned-lease")), true);
    await fsp.writeFile(path.join(roots.runtime, "supervisor.lock"), `${JSON.stringify({
      schemaVersion: "datalab-v4-shadow-supervisor-lock.v1",
      workerId: "stale-worker",
      pid: process.pid,
      heartbeatAt: new Date(Date.now() - 2000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString()
    })}\n`, { encoding: "utf8", flag: "wx" });
    const recoveryController = new AbortController();
    const recoveryPromise = startTrackedSupervisor(recoveryController);
    await waitFor(
      async () => fs.existsSync(recordPath(roots, "failed", "abandoned-lease")),
      "abandoned lease recovery"
    );
    const recovered = JSON.parse(await fsp.readFile(recordPath(roots, "failed", "abandoned-lease"), "utf8"));
    assert.equal(recovered.code, "LEASE_RECOVERY_NO_RETRY");
    assert.equal(recovered.retryable, false);
    assert.equal(fs.existsSync(recordPath(roots, "inbox", "abandoned-lease")), false);
    recoveryController.abort();
    await recoveryPromise;
    assert.equal((await fsp.readdir(path.join(dataRoot, "artifacts"))).length, 2);

    process.env.V4_SHADOW_BOOTSTRAP_FIXTURE = "0";
    const killed = spawn(process.execPath, ["--require", OFFLINE_NETWORK_BLOCKER, SUPERVISOR], {
      cwd: ROOT,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const killedExit = waitForExit(killed);
    const killedLock = await readJsonWhenReady(path.join(roots.runtime, "supervisor.lock"));
    assert.ok(killedLock.workerId);
    killed.kill("SIGKILL");
    await killedExit;
    assert.equal(fs.existsSync(path.join(roots.runtime, "supervisor.lock")), true);
    await new Promise((resolve) => setTimeout(resolve, 600));

    const staleRecoveryController = new AbortController();
    const staleRecoveryPromise = startTrackedSupervisor(staleRecoveryController);
    const recoveredHeartbeat = await waitFor(async () => {
      const heartbeat = await readJsonWhenReady(heartbeatFile);
      return heartbeat.workerId !== killedLock.workerId && heartbeat.state === "idle" ? heartbeat : null;
    }, "hard-kill stale lock recovery");
    const recoveredLock = await readJsonWhenReady(path.join(roots.runtime, "supervisor.lock"));
    assert.equal(recoveredHeartbeat.workerId, recoveredLock.workerId);
    staleRecoveryController.abort();
    await staleRecoveryPromise;
    assert.match(capturedOutput, /"event":"stale_lock_detected"/);
    assert.match(capturedOutput, /"event":"stale_lock_recovered"/);

    assert.equal(capturedOutput.includes(TEST_SECRET), false);
    await scanForSecret(dataRoot, TEST_SECRET);
    assert.equal(await gitBlobSha(COLLECTOR), EXPECTED_COLLECTOR_BLOB);
    process.stdout.write("V4 shadow supervisor offline tests passed\n");
  } finally {
    for (const controller of activeControllers) controller.abort();
    await Promise.allSettled(activeSupervisors);
    process.stdout.write = originalWrite;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
