"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  BASELINE_COMMIT,
  ERROR_SCHEMA_VERSION,
  EXPECTED_NODE_VERSION,
  FILE_IDENTITIES,
  JOB_CANONICAL_SHA256,
  JOB_RUN_ID,
  LOCAL_STATE_ROOT,
  PROCESS_KEEPALIVE_INTERVAL_MS,
  READINESS_EVENT,
  READINESS_SCHEMA_VERSION,
  RENDER_STATE_ROOT,
  assertReadinessGates,
  canonicalGitTextBytes,
  canonicalTextSha256,
  fileIdentityDigest,
  gitBlobSha,
  holdUntilSignal,
  readFreshJob,
  readiness,
  safeErrorProjection,
  sha256,
  stateRoot,
  verifyFileIdentities,
  verifyIntegrity,
  verifyRenderDeployIdentity
} = require("./v2_naver_place_room_provider_marker_render_readiness.cjs");

const ROOT = path.resolve(__dirname, "..");
let assertions = 0;

function equal(actual, expected, message) {
  assertions += 1;
  if (message === undefined) assert.equal(actual, expected);
  else assert.equal(actual, expected, message);
}

function deepEqual(actual, expected, message) {
  assertions += 1;
  if (message === undefined) assert.deepEqual(actual, expected);
  else assert.deepEqual(actual, expected, message);
}

function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function throws(fn, validator) {
  assertions += 1;
  assert.throws(fn, validator);
}

async function rejects(fn, validator) {
  assertions += 1;
  await assert.rejects(fn, validator);
}

function localEnv(suffix = "readiness") {
  return {
    V2_N5_RENDER_RUN_ENABLED: "0",
    V2_N5_RENDER_REQUEST_BUDGET: "0",
    V2_N5_RENDER_AUTOMATIC_RETRY: "0",
    V2_N5_RENDER_FALLBACK: "0",
    V2_N5_RENDER_OPERATIONAL_WRITES: "0",
    V2_N5_RENDER_STATE_DIR: path.join(LOCAL_STATE_ROOT, suffix)
  };
}

function renderEnv(commit = "b".repeat(40)) {
  return {
    ...localEnv("ignored-for-render"),
    RENDER_SERVICE_ID: "srv-n5-readiness-fixture",
    RENDER_GIT_COMMIT: commit,
    V2_N5_RENDER_EXPECTED_DEPLOY_COMMIT: commit,
    V2_N5_RENDER_STATE_DIR: RENDER_STATE_ROOT
  };
}

function exerciseServeProcess(env) {
  return new Promise((resolve, reject) => {
    const runner = path.join(__dirname, "v2_naver_place_room_provider_marker_render_readiness.cjs");
    const preload = path.join(__dirname, "fixture_network_guard_preload.cjs");
    const secret = "n5-render-readiness-secret-sentinel";
    const child = spawn(process.execPath, ["--require", preload, runner, "serve"], {
      cwd: ROOT,
      env: { ...process.env, ...env, N5_TEST_SECRET: secret },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let ready = null;
    let settled = false;
    let survived = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error("serve process did not finish within the test timeout"));
      }
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.trim().split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === READINESS_EVENT && !ready) {
            ready = parsed;
            setTimeout(() => {
              survived = child.exitCode === null;
              child.kill("SIGTERM");
            }, 1_250);
          }
        } catch {
          // Final framing assertions report malformed output after exit.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ code, signal, stdout, stderr, ready, survived, secret });
    });
  });
}

(async () => {
  const guard = installFixtureNetworkGuard({ label: "N5-D4 Render readiness tests" });
  try {
    equal(process.version, EXPECTED_NODE_VERSION);
    equal(BASELINE_COMMIT, "a977872f8f3de20775a3e2dab92f9161cb69515e");
    equal(JOB_RUN_ID, "n5-room-marker-render-live-20260814-001");
    equal(JOB_CANONICAL_SHA256, "bb00fd2a3fadc8c9644f8b28932f6bf2bb0ad2b96b55de0573eb0a4214e32ef7");
    equal(PROCESS_KEEPALIVE_INTERVAL_MS, 60_000);

    const jobIdentity = await readFreshJob();
    equal(jobIdentity.job.runId, JOB_RUN_ID);
    equal(jobIdentity.job.placeId, "35644668");
    equal(jobIdentity.job.mode, "live");
    equal(jobIdentity.job.requestBudget, 1);
    equal(jobIdentity.job.automaticRetries, 0);
    equal(jobIdentity.job.automaticFallbacks, 0);
    equal(jobIdentity.digest, JOB_CANONICAL_SHA256);

    const fileIdentities = await verifyFileIdentities();
    equal(Object.keys(fileIdentities).length, FILE_IDENTITIES.length);
    for (const identity of FILE_IDENTITIES) {
      equal(fileIdentities[identity.key], identity.expected, `${identity.key} must match`);
    }
    const runnerBytes = fs.readFileSync(path.join(ROOT, "scripts", "v2_naver_place_room_provider_marker_live_one_shot.cjs"));
    equal(gitBlobSha(runnerBytes), "70eb4024b8c623569d13666a0757738c447df214");
    equal(sha256(Buffer.from("fixture", "utf8")), "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d");
    const packageLockBytes = fs.readFileSync(path.join(ROOT, "package-lock.json"));
    const packageLockLfBytes = canonicalGitTextBytes(packageLockBytes);
    const packageLockCrlfBytes = Buffer.from(
      packageLockLfBytes.toString("utf8").replace(/\n/gu, "\r\n"),
      "utf8"
    );
    const packageLockIdentity = "d01ae4741e2472c2830fc1432cd241c04105fc574ea11c250991cec5aa89956e";
    equal(canonicalTextSha256(packageLockBytes), packageLockIdentity);
    equal(canonicalTextSha256(packageLockLfBytes), packageLockIdentity);
    equal(canonicalTextSha256(packageLockCrlfBytes), packageLockIdentity);
    equal(sha256(packageLockBytes), "ba2e05d58f16cff4d8bffbe76d6f0b48faec5aa1c9444b90917dce155b7fc5e2");
    ok(sha256(packageLockLfBytes) !== sha256(packageLockCrlfBytes), "raw LF and CRLF bytes must differ");
    ok(
      canonicalTextSha256(Buffer.concat([packageLockLfBytes, Buffer.from("x", "utf8")])) !== packageLockIdentity,
      "a non-EOL package-lock mutation must fail closed"
    );
    equal(
      fileIdentityDigest({ algorithm: "canonical-sha256" }, packageLockCrlfBytes),
      packageLockIdentity
    );
    throws(
      () => fileIdentityDigest({ algorithm: "unsupported" }, packageLockLfBytes),
      (error) => error?.code === "V2_N5_RENDER_INTEGRITY_MISMATCH"
    );

    const readinessPath = path.join(LOCAL_STATE_ROOT, "readiness-no-write");
    equal(fs.existsSync(readinessPath), false);
    const readyEnv = { ...localEnv("readiness-no-write") };
    equal(assertReadinessGates(readyEnv), true);
    equal(stateRoot(readyEnv), path.resolve(readinessPath));
    equal(fs.existsSync(readinessPath), false);

    const forbiddenGates = [
      "V2_N5_RENDER_LIVE_APPROVED",
      "V2_N5_RENDER_APPROVED_JOB_SHA256",
      "V2_NAVER_ROOM_MARKER_LIVE_APPROVED",
      "V2_NAVER_ROOM_MARKER_REQUEST_BUDGET",
      "V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256"
    ];
    for (const name of forbiddenGates) {
      throws(
        () => assertReadinessGates({ ...readyEnv, [name]: "forbidden" }),
        (error) => error?.code === "V2_N5_RENDER_READINESS_GATE_INVALID"
      );
    }
    for (const name of [
      "V2_N5_RENDER_RUN_ENABLED",
      "V2_N5_RENDER_REQUEST_BUDGET",
      "V2_N5_RENDER_AUTOMATIC_RETRY",
      "V2_N5_RENDER_FALLBACK",
      "V2_N5_RENDER_OPERATIONAL_WRITES"
    ]) {
      throws(
        () => assertReadinessGates({ ...readyEnv, [name]: "1" }),
        (error) => error?.code === "V2_N5_RENDER_READINESS_GATE_INVALID"
      );
      const missing = { ...readyEnv };
      delete missing[name];
      throws(
        () => assertReadinessGates(missing),
        (error) => error?.code === "V2_N5_RENDER_READINESS_GATE_INVALID"
      );
    }

    equal(verifyRenderDeployIdentity({}).render, false);
    throws(
      () => verifyRenderDeployIdentity({ RENDER_SERVICE_ID: "srv-fixture" }),
      (error) => error?.code === "V2_N5_RENDER_DEPLOY_COMMIT_MISMATCH"
    );
    throws(
      () => verifyRenderDeployIdentity({
        RENDER_SERVICE_ID: "srv-fixture",
        RENDER_GIT_COMMIT: "a".repeat(40),
        V2_N5_RENDER_EXPECTED_DEPLOY_COMMIT: "b".repeat(40)
      }),
      (error) => error?.code === "V2_N5_RENDER_DEPLOY_COMMIT_MISMATCH"
    );
    const deployed = verifyRenderDeployIdentity(renderEnv());
    equal(deployed.render, true);
    equal(deployed.deployedCommit, "b".repeat(40));
    equal(stateRoot(renderEnv()), RENDER_STATE_ROOT);
    throws(
      () => stateRoot({ ...renderEnv(), V2_N5_RENDER_STATE_DIR: "/var/data/other" }),
      (error) => error?.code === "V2_N5_RENDER_STATE_INVALID"
    );
    throws(
      () => stateRoot({ ...readyEnv, V2_N5_RENDER_STATE_DIR: LOCAL_STATE_ROOT }),
      (error) => error?.code === "V2_N5_RENDER_STATE_INVALID"
    );
    throws(
      () => stateRoot({ ...readyEnv, V2_N5_RENDER_STATE_DIR: path.resolve(ROOT, "outside-n5-d4") }),
      (error) => error?.code === "V2_N5_RENDER_STATE_INVALID"
    );
    throws(
      () => stateRoot({ ...readyEnv, V2_N5_RENDER_STATE_DIR: "relative-state" }),
      (error) => error?.code === "V2_N5_RENDER_STATE_INVALID"
    );

    const integrity = await verifyIntegrity(readyEnv);
    equal(integrity.baselineCommit, BASELINE_COMMIT);
    equal(integrity.deployedCommit, null);
    equal(integrity.render, false);
    equal(integrity.nodeVersion, EXPECTED_NODE_VERSION);
    equal(integrity.jobRunId, JOB_RUN_ID);
    equal(integrity.jobCanonicalSha256, JOB_CANONICAL_SHA256);
    equal(integrity.runnerBlob, "70eb4024b8c623569d13666a0757738c447df214");
    equal(integrity.contractBlob, "0098a89d940fb4436ac7fa9810e7e6582870d7c2");
    equal(integrity.currentCollectorBlob, "c91c8a4339d573dab2f1ac267ffcc251a5f4b2a3");
    equal(integrity.frozenCollectorBlob, "bcbe229998da3afa6f31ee04375fb0766019e56f");
    equal(integrity.packageLockSha256, "d01ae4741e2472c2830fc1432cd241c04105fc574ea11c250991cec5aa89956e");

    const ready = await readiness(readyEnv);
    equal(ready.schemaVersion, READINESS_SCHEMA_VERSION);
    equal(ready.event, READINESS_EVENT);
    equal(ready.status, "ready");
    equal(ready.mode, "readiness-only");
    equal(ready.runEnabled, false);
    equal(ready.requestBudget, 0);
    equal(ready.externalRequests, 0);
    equal(ready.collectorInvocations, 0);
    equal(ready.operationalWrites, 0);
    equal(ready.diagnosticStateWrites, 0);
    equal(ready.rawProviderResponseStored, false);
    equal(ready.automaticRetry, false);
    equal(ready.fallback, false);
    equal(ready.liveExecutionAvailable, false);
    equal(ready.jobRunId, JOB_RUN_ID);
    equal(ready.jobCanonicalSha256, JOB_CANONICAL_SHA256);
    equal(fs.existsSync(readinessPath), false);

    const simulatedRenderReady = await readiness(renderEnv());
    equal(simulatedRenderReady.status, "ready");
    equal(simulatedRenderReady.deployedCommit, "b".repeat(40));
    equal(simulatedRenderReady.externalRequests, 0);
    equal(simulatedRenderReady.operationalWrites, 0);

    const signalTarget = new EventEmitter();
    let scheduledInterval = null;
    let clearedToken = null;
    const keepaliveToken = { id: "keepalive" };
    const held = holdUntilSignal({
      signalTarget,
      setIntervalFn: (_callback, intervalMs) => {
        scheduledInterval = intervalMs;
        return keepaliveToken;
      },
      clearIntervalFn: (token) => {
        clearedToken = token;
      }
    });
    equal(scheduledInterval, PROCESS_KEEPALIVE_INTERVAL_MS);
    equal(signalTarget.listenerCount("SIGTERM"), 1);
    equal(signalTarget.listenerCount("SIGINT"), 1);
    signalTarget.emit("SIGTERM");
    const signalResult = await held;
    equal(signalResult.signal, "SIGTERM");
    equal(clearedToken, keepaliveToken);
    equal(signalTarget.listenerCount("SIGTERM"), 0);
    equal(signalTarget.listenerCount("SIGINT"), 0);

    const secret = "n5-secret-value-must-not-leak";
    const safeError = safeErrorProjection(new Error(secret));
    equal(safeError.schemaVersion, ERROR_SCHEMA_VERSION);
    equal(safeError.code, "V2_N5_RENDER_FAILED");
    equal(safeError.externalRequests, 0);
    equal(safeError.collectorInvocations, 0);
    equal(safeError.operationalWrites, 0);
    equal(JSON.stringify(safeError).includes(secret), false);

    const source = fs.readFileSync(path.join(__dirname, "v2_naver_place_room_provider_marker_render_readiness.cjs"), "utf8");
    equal(/\bfetch\s*\(/u.test(source), false);
    equal(/globalThis\.fetch|node:https|node:http|undici/iu.test(source), false);
    equal(/writeFile|appendFile|createWriteStream|rename\(|mkdir\(|rm\(|unlink\(/u.test(source), false);

    const servePath = path.join(LOCAL_STATE_ROOT, "serve-no-write");
    equal(fs.existsSync(servePath), false);
    const serve = await exerciseServeProcess(localEnv("serve-no-write"));
    ok(serve.ready, "serve must emit readiness");
    equal(serve.ready.status, "ready");
    equal(serve.ready.mode, "readiness-only");
    equal(serve.ready.externalRequests, 0);
    equal(serve.ready.collectorInvocations, 0);
    equal(serve.ready.operationalWrites, 0);
    equal(serve.ready.liveExecutionAvailable, false);
    equal(serve.survived, true);
    equal(serve.code === 0 || serve.signal === "SIGTERM", true);
    equal(serve.stderr, "");
    equal(serve.stdout.trim().split(/\r?\n/u).length, 1);
    equal(serve.stdout.includes(serve.secret), false);
    equal(fs.existsSync(servePath), false);

    equal(guard.blockedAttempts(), 0);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "v2-naver-room-provider-marker-render-readiness-test.v1",
      status: "passed",
      assertions,
      jobRunId: JOB_RUN_ID,
      jobCanonicalSha256: JOB_CANONICAL_SHA256,
      serveSurvivalMs: 1250,
      serveControlledShutdown: true,
      liveExecutionAvailable: false,
      actualExternalRequests: 0,
      collectorInvocations: 0,
      operationalWrites: 0
    })}\n`);
  } finally {
    guard.restore();
  }
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
