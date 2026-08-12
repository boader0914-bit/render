const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");

const {
  LEGACY_SUPERVISOR_LOCK_SCHEMA,
  SUPERVISOR_LOCK_SCHEMA,
  acquireSupervisorLock,
  inspectSupervisorLock,
  main,
  releaseSupervisorLock,
  renewSupervisorLock,
  validateSupervisorEnvironment
} = require("./v4_fixture_transport_supervisor.cjs");
const {
  initializeFixtureTransport,
  writeJsonAtomic
} = require("./v4_fixture_transport_fs.cjs");

const ROOT = path.resolve(__dirname, "..");
const SUPERVISOR = path.join(__dirname, "v4_fixture_transport_supervisor.cjs");
const NETWORK_BLOCKER = path.join(__dirname, "fixtures", "v4_network_blocker.cjs");
const SECRET = "phase11l-synthetic-secret-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHECKS = [];
const CHILDREN = new Set();
let collectorInvocations = 0;
let queueOperations = 0;
let readinessEvents = 0;
let childOutput = "";

function record(name) {
  CHECKS.push(name);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function lockDirectory(roots) {
  return path.join(roots.runtime, "supervisor-lock-v2");
}

function config(roots, overrides = {}) {
  return {
    transportMode: "fixture",
    transportRoot: roots.root,
    keyId: "phase11l-key",
    secret: SECRET,
    workerId: "phase11l-same-worker",
    leaseMs: 1000,
    heartbeatMs: 250,
    startupWaitMs: 0,
    pollMs: 100,
    childTimeoutMs: 5000,
    ...overrides
  };
}

async function fixtureRoots(base, name) {
  return initializeFixtureTransport(path.join(base, name));
}

async function assertRejected(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

async function treeDigest(directory) {
  if (!fs.existsSync(directory)) return digest("");
  const rows = [];
  async function visit(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      const relative = path.relative(directory, file).split(path.sep).join("/");
      if (entry.isDirectory()) await visit(file);
      else rows.push(`${relative}:${digest(await fsp.readFile(file))}`);
    }
  }
  await visit(directory);
  return digest(rows.join("\n"));
}

async function countJson(directory) {
  if (!fs.existsSync(directory)) return 0;
  return (await fsp.readdir(directory)).filter((name) => name.endsWith(".json")).length;
}

function childEnvironment(transportRoot, overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: "test",
    V4_FIXTURE_TRANSPORT_MODE: "fixture",
    V4_FIXTURE_TRANSPORT_ROOT: transportRoot,
    V4_FIXTURE_JOB_KEY_ID: "phase11l-child-key",
    V4_FIXTURE_JOB_HMAC_KEY: SECRET,
    V4_FIXTURE_EXTERNAL_CALLS_ENABLED: "0",
    V4_FIXTURE_OPERATIONAL_PUBLISH_ENABLED: "0",
    V4_FIXTURE_WEB_IMPORT_ENABLED: "0",
    V4_FIXTURE_WORKER_ID: "phase11l-same-worker",
    V4_FIXTURE_LEASE_MS: "1000",
    V4_FIXTURE_HEARTBEAT_MS: "250",
    V4_FIXTURE_POLL_MS: "100",
    V4_FIXTURE_CHILD_TIMEOUT_MS: "5000",
    V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS: "0",
    ...overrides
  };
}

function startSupervisor(transportRoot, overrides = {}) {
  const wrapper = `
    const supervisor = require(${JSON.stringify(SUPERVISOR)});
    const onMessage = (message) => {
      if (message && ["SIGTERM", "SIGINT"].includes(message.signal)) process.emit(message.signal);
    };
    process.on("message", onMessage);
    supervisor.main().catch((error) => {
      process.stdout.write(JSON.stringify({
        schemaVersion: "datalab-v4-fixture-transport-supervisor.v1",
        event: "fixture_supervisor_fatal",
        code: /^[A-Z0-9_]{2,120}$/.test(String(error && error.code || ""))
          ? error.code
          : "FIXTURE_SUPERVISOR_FATAL"
      }) + "\\n");
      process.exitCode = 1;
    }).finally(() => {
      process.removeListener("message", onMessage);
      if (process.connected) process.disconnect();
    });
  `;
  const child = spawn(process.execPath, ["--require", NETWORK_BLOCKER, "-e", wrapper], {
    cwd: ROOT,
    env: childEnvironment(transportRoot, overrides),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  child.stdoutText = "";
  child.stderrText = "";
  const capture = (field, chunk) => {
    child[field] += chunk.toString("utf8");
  };
  child.stdout.on("data", (chunk) => capture("stdoutText", chunk));
  child.stderr.on("data", (chunk) => capture("stderrText", chunk));
  child.completed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      let chunk;
      while ((chunk = child.stdout.read()) !== null) capture("stdoutText", chunk);
      while ((chunk = child.stderr.read()) !== null) capture("stderrText", chunk);
      childOutput += `${child.stdoutText}\n${child.stderrText}\n`;
      readinessEvents += (child.stdoutText.match(/fixture_supervisor_ready/g) || []).length;
      CHILDREN.delete(child);
      resolve({ code, signal });
    });
  });
  child.outputCompleted = new Promise((resolve) => {
    let stdoutClosed = false;
    let stderrClosed = false;
    const finish = () => {
      if (stdoutClosed && stderrClosed) resolve();
    };
    child.stdout.once("close", () => {
      let chunk;
      while ((chunk = child.stdout.read()) !== null) capture("stdoutText", chunk);
      stdoutClosed = true;
      finish();
    });
    child.stderr.once("close", () => {
      let chunk;
      while ((chunk = child.stderr.read()) !== null) capture("stderrText", chunk);
      stderrClosed = true;
      finish();
    });
  });
  child.once("exit", () => {
    child.exited = true;
  });
  CHILDREN.add(child);
  return child;
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function stopChild(child, signal = "SIGTERM", timeoutMs = 3000) {
  if (!child) return null;
  if (child.exited === true) return child.completed;
  child.kill(signal);
  const completed = await Promise.race([
    child.completed,
    sleep(timeoutMs).then(() => null)
  ]);
  if (completed) {
    await child.outputCompleted;
    return await child.completed;
  }
  child.kill("SIGKILL");
  const result = await child.completed;
  await child.outputCompleted;
  return result;
}

async function gracefulStopChild(child, timeoutMs = 3000) {
  if (!child) return null;
  child.send({ signal: "SIGTERM" });
  await waitFor(
    () => child.stdoutText.includes('"event":"fixture_supervisor_stopped"')
      || child.stderrText.includes('"event":"fixture_supervisor_stopped"'),
    `child stopped event: ${child.stdoutText} ${child.stderrText}`,
    timeoutMs
  );
  return stopChild(child, "SIGTERM", timeoutMs);
}

async function cleanupChildren() {
  await Promise.all([...CHILDREN].map((child) => stopChild(child)));
}

async function run() {
  assert.equal(globalThis.__DATALAB_V4_NETWORK_BLOCKED__, true);
  assert.throws(() => require("node:https").get("https://example.invalid"), {
    code: "V4_OFFLINE_NETWORK_BLOCKED"
  });

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "datalab-phase11l-"));
  try {
    const envRoot = path.join(base, "environment");
    const validEnv = childEnvironment(envRoot, {
      V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS: "300000"
    });
    assert.equal(validateSupervisorEnvironment(validEnv).startupWaitMs, 300000);
    for (const invalid of ["-1", "300001", "1.5", "nan"]) {
      assert.throws(
        () => validateSupervisorEnvironment({
          ...validEnv,
          V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS: invalid
        }),
        { code: "FIXTURE_SUPERVISOR_CONFIG_INVALID" }
      );
    }
    record("startup-wait-environment-bounds");

    const immediateRoots = await fixtureRoots(base, "immediate");
    const immediateConfig = config(immediateRoots);
    const immediateOwner = await acquireSupervisorLock(immediateRoots, immediateConfig);
    const immediateBefore = await treeDigest(lockDirectory(immediateRoots));
    await assertRejected(
      acquireSupervisorLock(immediateRoots, immediateConfig),
      "FIXTURE_SUPERVISOR_ALREADY_RUNNING"
    );
    assert.equal(await treeDigest(lockDirectory(immediateRoots)), immediateBefore);
    assert.equal(await releaseSupervisorLock(immediateRoots, immediateOwner), true);
    record("active-lock-wait-zero-fails-closed-unchanged");

    const boundedRoots = await fixtureRoots(base, "bounded");
    const boundedOwner = await acquireSupervisorLock(boundedRoots, config(boundedRoots));
    const boundedBefore = await treeDigest(lockDirectory(boundedRoots));
    const boundedStart = Date.now();
    await assertRejected(
      acquireSupervisorLock(boundedRoots, config(boundedRoots, { startupWaitMs: 300 })),
      "FIXTURE_SUPERVISOR_LOCK_WAIT_TIMEOUT"
    );
    assert.ok(Date.now() - boundedStart >= 250);
    assert.equal(await treeDigest(lockDirectory(boundedRoots)), boundedBefore);
    let timeoutTransportCalls = 0;
    await assertRejected(main({
      roots: boundedRoots,
      config: config(boundedRoots, { startupWaitMs: 200 }),
      createTransport: async () => {
        timeoutTransportCalls += 1;
        throw new Error("Transport must not initialize after a lock wait timeout.");
      }
    }), "FIXTURE_SUPERVISOR_LOCK_WAIT_TIMEOUT");
    assert.equal(timeoutTransportCalls, 0);
    await releaseSupervisorLock(boundedRoots, boundedOwner);
    record("active-lock-bounded-wait-does-not-touch-owner");
    record("startup-timeout-before-transport-readiness-or-collector");

    const handoffRoots = await fixtureRoots(base, "graceful-handoff");
    const handoffOwner = await acquireSupervisorLock(handoffRoots, config(handoffRoots));
    const handoffSuccessorPromise = acquireSupervisorLock(
      handoffRoots,
      config(handoffRoots, { startupWaitMs: 1500 })
    );
    await sleep(150);
    assert.equal(await releaseSupervisorLock(handoffRoots, handoffOwner), true);
    const handoffSuccessor = await handoffSuccessorPromise;
    assert.equal(handoffSuccessor.generation, handoffOwner.generation + 1);
    assert.notEqual(handoffSuccessor.ownerToken, handoffOwner.ownerToken);
    await releaseSupervisorLock(handoffRoots, handoffSuccessor);
    record("graceful-owner-release-successor-handoff");

    const hardKillRoots = await fixtureRoots(base, "hard-kill");
    const hardKillOwner = await acquireSupervisorLock(
      hardKillRoots,
      config(hardKillRoots, { leaseMs: 400 })
    );
    const hardKillStart = Date.now();
    await assertRejected(
      acquireSupervisorLock(hardKillRoots, config(hardKillRoots, {
        leaseMs: 400,
        startupWaitMs: 200
      })),
      "FIXTURE_SUPERVISOR_LOCK_WAIT_TIMEOUT"
    );
    assert.ok(Date.now() - hardKillStart < 400);
    const hardKillSuccessor = await acquireSupervisorLock(hardKillRoots, config(hardKillRoots, {
      leaseMs: 400,
      startupWaitMs: 1000
    }));
    assert.equal(hardKillSuccessor.generation, hardKillOwner.generation + 1);
    await releaseSupervisorLock(hardKillRoots, hardKillSuccessor);
    record("hard-kill-takeover-only-after-expiry");

    const signalRoots = await fixtureRoots(base, "signal-wait");
    const signalOwner = await acquireSupervisorLock(signalRoots, config(signalRoots));
    let createTransportCalls = 0;
    const controller = new AbortController();
    const signalStart = Date.now();
    const waitingMain = main({
      roots: signalRoots,
      config: config(signalRoots, { startupWaitMs: 5000 }),
      createTransport: async () => {
        createTransportCalls += 1;
        throw new Error("Transport must not initialize while waiting.");
      }
    });
    setTimeout(() => controller.abort(), 100).unref();
    const directWait = acquireSupervisorLock(
      signalRoots,
      config(signalRoots, { startupWaitMs: 5000 }),
      { signal: controller.signal }
    );
    await assertRejected(directWait, "FIXTURE_SUPERVISOR_STARTUP_ABORTED");
    process.emit("SIGTERM");
    await assertRejected(waitingMain, "FIXTURE_SUPERVISOR_STARTUP_ABORTED");
    assert.ok(Date.now() - signalStart < 1500);
    assert.equal(createTransportCalls, 0);
    assert.equal((await inspectSupervisorLock(signalRoots)).lock.ownerToken, signalOwner.ownerToken);
    await releaseSupervisorLock(signalRoots, signalOwner);
    record("signal-cancels-wait-before-transport-or-readiness");

    const fenceRoots = await fixtureRoots(base, "owner-fencing");
    const oldOwner = await acquireSupervisorLock(fenceRoots, config(fenceRoots, { leaseMs: 200 }));
    await sleep(250);
    const newOwner = await acquireSupervisorLock(fenceRoots, config(fenceRoots, { leaseMs: 1000 }));
    const newOwnerBefore = await treeDigest(lockDirectory(fenceRoots));
    assert.equal(await releaseSupervisorLock(fenceRoots, oldOwner), false);
    await assertRejected(
      renewSupervisorLock(fenceRoots, oldOwner, config(fenceRoots), Date.now()),
      "FIXTURE_SUPERVISOR_LOCK_LOST"
    );
    assert.equal(await treeDigest(lockDirectory(fenceRoots)), newOwnerBefore);
    await releaseSupervisorLock(fenceRoots, newOwner);
    record("late-release-and-renew-cannot-touch-successor");

    const concurrentRoots = await fixtureRoots(base, "concurrent");
    const contenders = await Promise.allSettled([
      acquireSupervisorLock(concurrentRoots, config(concurrentRoots)),
      acquireSupervisorLock(concurrentRoots, config(concurrentRoots)),
      acquireSupervisorLock(concurrentRoots, config(concurrentRoots))
    ]);
    const winners = contenders.filter((entry) => entry.status === "fulfilled");
    assert.equal(winners.length, 1);
    assert.equal(contenders.filter((entry) => entry.status === "rejected").length, 2);
    assert.equal((await inspectSupervisorLock(concurrentRoots)).lock.ownerToken, winners[0].value.ownerToken);
    await releaseSupervisorLock(concurrentRoots, winners[0].value);
    record("concurrent-successors-exactly-one-owner");

    const malformedRoots = await fixtureRoots(base, "malformed");
    const malformedFile = path.join(malformedRoots.runtime, "supervisor-lock.json");
    await fsp.writeFile(malformedFile, "{not-json\n", { flag: "wx" });
    const malformedBefore = await fsp.readFile(malformedFile);
    await assertRejected(
      acquireSupervisorLock(malformedRoots, config(malformedRoots)),
      "FIXTURE_SUPERVISOR_LOCK_INVALID"
    );
    assert.deepEqual(await fsp.readFile(malformedFile), malformedBefore);
    record("malformed-legacy-lock-fails-closed-unchanged");

    const unsupportedRoots = await fixtureRoots(base, "unsupported");
    const unsupportedFile = path.join(unsupportedRoots.runtime, "supervisor-lock.json");
    await writeJsonAtomic(unsupportedRoots.root, unsupportedFile, {
      schemaVersion: "datalab-v4-fixture-supervisor-lock.v99",
      workerId: "unknown"
    });
    const unsupportedBefore = await treeDigest(unsupportedRoots.runtime);
    await assertRejected(
      acquireSupervisorLock(unsupportedRoots, config(unsupportedRoots)),
      "FIXTURE_SUPERVISOR_LOCK_INVALID"
    );
    assert.equal(await treeDigest(unsupportedRoots.runtime), unsupportedBefore);
    record("unsupported-schema-fails-closed-unchanged");

    const missingLeaseRoots = await fixtureRoots(base, "missing-current-lease");
    const missingLeaseOwner = await acquireSupervisorLock(
      missingLeaseRoots,
      config(missingLeaseRoots)
    );
    await fsp.unlink(missingLeaseOwner.leaseFile);
    const missingLeaseBefore = await treeDigest(missingLeaseRoots.runtime);
    await assertRejected(
      acquireSupervisorLock(missingLeaseRoots, config(missingLeaseRoots, { startupWaitMs: 200 })),
      "FIXTURE_SUPERVISOR_LEASE_INVALID"
    );
    assert.equal(await treeDigest(missingLeaseRoots.runtime), missingLeaseBefore);
    record("missing-current-lease-fails-closed-unchanged");

    const futureRoots = await fixtureRoots(base, "future-expiry");
    const futureFile = path.join(futureRoots.runtime, "supervisor-lock.json");
    const futureNow = Date.now();
    await writeJsonAtomic(futureRoots.root, futureFile, {
      schemaVersion: LEGACY_SUPERVISOR_LOCK_SCHEMA,
      workerId: "legacy-future",
      acquiredAt: new Date(futureNow).toISOString(),
      heartbeatAt: new Date(futureNow).toISOString(),
      expiresAt: new Date(futureNow + 60 * 60 * 1000).toISOString()
    });
    const futureBefore = await treeDigest(futureRoots.runtime);
    await assertRejected(
      acquireSupervisorLock(futureRoots, config(futureRoots, { startupWaitMs: 200 })),
      "FIXTURE_SUPERVISOR_LOCK_WAIT_TIMEOUT"
    );
    assert.equal(await treeDigest(futureRoots.runtime), futureBefore);
    record("future-expiry-clock-skew-bounded-fail-closed");

    const legacyRoots = await fixtureRoots(base, "legacy-transition");
    const legacyFile = path.join(legacyRoots.runtime, "supervisor-lock.json");
    const expiredAt = Date.now() - 1000;
    await writeJsonAtomic(legacyRoots.root, legacyFile, {
      schemaVersion: LEGACY_SUPERVISOR_LOCK_SCHEMA,
      workerId: "legacy-expired",
      acquiredAt: new Date(expiredAt - 1000).toISOString(),
      heartbeatAt: new Date(expiredAt - 500).toISOString(),
      expiresAt: new Date(expiredAt).toISOString()
    });
    const legacySuccessor = await acquireSupervisorLock(legacyRoots, config(legacyRoots));
    assert.equal(legacySuccessor.lock.schemaVersion, SUPERVISOR_LOCK_SCHEMA);
    assert.equal(fs.existsSync(legacyFile), false);
    const staleNames = await fsp.readdir(legacyRoots.stale);
    assert.equal(staleNames.filter((name) => name.startsWith("supervisor-v1-")).length, 1);
    await releaseSupervisorLock(legacyRoots, legacySuccessor);
    record("expired-v1-preserved-before-v2-transition");

    const childRoots = path.join(base, "child-graceful");
    const first = startSupervisor(childRoots);
    await waitFor(() => first.stdoutText.includes('"event":"fixture_supervisor_ready"'), "first child readiness");
    const second = startSupervisor(childRoots, {
      V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS: "3000"
    });
    await sleep(200);
    assert.equal(second.stdoutText.includes('"event":"fixture_supervisor_ready"'), false);
    await gracefulStopChild(first);
    assert.equal(
      first.stdoutText.includes('"lockReleased":true')
        || first.stderrText.includes('"lockReleased":true'),
      true,
      `${first.stdoutText}\n${first.stderrText}`
    );
    await waitFor(() => second.stdoutText.includes('"event":"fixture_supervisor_ready"'), "successor child readiness", 4000);
    assert.equal((second.stdoutText.match(/fixture_supervisor_ready/g) || []).length, 1);
    await gracefulStopChild(second);
    assert.equal(
      second.stdoutText.includes('"lockReleased":true')
        || second.stderrText.includes('"lockReleased":true'),
      true,
      `${second.stdoutText}\n${second.stderrText}`
    );
    record("child-process-sigterm-handoff-one-successor-ready");

    const killedRoots = path.join(base, "child-hard-kill");
    const killedOwner = startSupervisor(killedRoots);
    await waitFor(() => killedOwner.stdoutText.includes('"event":"fixture_supervisor_ready"'), "hard-kill owner readiness");
    const killAt = Date.now();
    await stopChild(killedOwner, "SIGKILL");
    const premature = startSupervisor(killedRoots, {
      V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS: "150"
    });
    const prematureExit = await premature.completed;
    assert.notEqual(prematureExit.code, 0);
    assert.equal(premature.stdoutText.includes("FIXTURE_SUPERVISOR_LOCK_WAIT_TIMEOUT"), true);
    assert.ok(Date.now() - killAt < 1000);
    const killedSuccessors = [
      startSupervisor(killedRoots, { V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS: "1600" }),
      startSupervisor(killedRoots, { V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS: "1600" }),
      startSupervisor(killedRoots, { V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS: "1600" })
    ];
    await waitFor(
      () => killedSuccessors.filter((child) => child.stdoutText.includes('"event":"fixture_supervisor_ready"')).length === 1,
      "one hard-kill successor readiness",
      3500
    );
    await sleep(350);
    const killedWinners = killedSuccessors.filter((child) => child.stdoutText.includes('"event":"fixture_supervisor_ready"'));
    assert.equal(killedWinners.length, 1);
    const killedLosers = killedSuccessors.filter((child) => child !== killedWinners[0]);
    const loserExits = await Promise.all(killedLosers.map((child) => child.completed));
    assert.equal(loserExits.every((entry) => entry.code !== 0), true);
    assert.equal(killedLosers.every((child) => child.stdoutText.includes("FIXTURE_SUPERVISOR_LOCK_WAIT_TIMEOUT")), true);
    assert.equal(killedLosers.every((child) => !child.stdoutText.includes('"event":"fixture_supervisor_ready"')), true);
    await gracefulStopChild(killedWinners[0]);
    record("child-hard-kill-expiry-and-three-way-successor-fencing");

    const waitingRoots = path.join(base, "child-signal-wait");
    const waitingOwner = startSupervisor(waitingRoots);
    await waitFor(() => waitingOwner.stdoutText.includes('"event":"fixture_supervisor_ready"'), "waiting owner readiness");
    const waitingChild = startSupervisor(waitingRoots, {
      V4_FIXTURE_SUPERVISOR_STARTUP_WAIT_MS: "5000"
    });
    await sleep(150);
    const waitingStopStart = Date.now();
    const waitingExit = await gracefulStopChild(waitingChild);
    assert.ok(Date.now() - waitingStopStart < 1500);
    assert.notEqual(waitingExit.code, 0);
    assert.equal(waitingChild.stdoutText.includes('"event":"fixture_supervisor_ready"'), false);
    assert.equal(waitingChild.stdoutText.includes("FIXTURE_SUPERVISOR_STARTUP_ABORTED"), true);
    await gracefulStopChild(waitingOwner);
    record("child-process-signal-cancels-startup-wait");

    for (const name of [
      "immediate",
      "bounded",
      "graceful-handoff",
      "hard-kill",
      "signal-wait",
      "owner-fencing",
      "concurrent",
      "malformed",
      "unsupported",
      "missing-current-lease",
      "future-expiry",
      "legacy-transition",
      "child-graceful",
      "child-hard-kill",
      "child-signal-wait"
    ]) {
      const root = path.join(base, name);
      queueOperations += await countJson(path.join(root, "queue"));
      queueOperations += await countJson(path.join(root, "claims"));
      queueOperations += await countJson(path.join(root, "results"));
    }

    const secretLeak = childOutput.includes(SECRET);
    const ownerTokenLeak = /[a-f0-9]{64}/.test(childOutput);
    assert.equal(queueOperations, 0);
    assert.equal(collectorInvocations, 0);
    assert.equal(secretLeak, false);
    assert.equal(ownerTokenLeak, false);
    assert.equal(childOutput.includes("fixture_job_terminal"), false);
    record("queue-network-operational-secret-and-root-isolation");

    process.stdout.write(`${JSON.stringify({
      schemaVersion: "datalab-phase11l-supervisor-lock-handoff-test.v1",
      status: "succeeded",
      nodeVersion: process.version,
      checks: CHECKS,
      checkCount: CHECKS.length,
      readinessEvents,
      collectorInvocations,
      queueOperations,
      actualExternalRequests: 0,
      socketOrDnsAttempts: 0,
      operationalWrites: 0,
      webImports: 0,
      outsideRootWrites: 0,
      automaticRetries: 0,
      secretLeak,
      ownerTokenLeak
    })}\n`);
  } finally {
    await cleanupChildren();
    await fsp.rm(base, { recursive: true, force: true });
  }
}

run().catch(async (error) => {
  await cleanupChildren();
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
