"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  COLLECTOR_BLOB,
  COPY_ONLY_EXPECTED_ENVELOPE_SHA256,
  LIVE_PLACE_ID_HASH,
  LOCKFILE_SHA256,
  canonicalGitTextBytes,
  gitBlobFromBytes,
  manifestRecordedTextBytes,
  stableJson,
  verifyManifestFileBytes,
  sha256
} = require("./v2_booking_business_harness.cjs");
const {
  D2_COMMIT,
  LIVE_APPROVAL,
  PROCESS_KEEPALIVE_INTERVAL_MS,
  RENDER_JOB_CANONICAL_SHA256,
  RENDER_RUN_ID,
  RENDER_STATE_ROOT,
  SOURCE_MANIFEST_DIGEST,
  assertLiveGates,
  assertReadinessGates,
  holdUntilSignal,
  normalizeRenderJob,
  readRenderJob,
  readiness,
  runOneShot,
  safeChildEnvironment,
  safeChildProjection,
  safeNetworkProjection,
  stateRoot,
  verifyRenderDeployIdentity,
  verifyIntegrity
} = require("./v2_booking_business_render_one_shot.cjs");
const {
  EVENT_NAMES,
  createRenderNetworkRecorder,
  headerNames,
  installRenderNetworkRecorderFromEnvironment,
  projectEvent,
  safeNetworkFailureClass,
  safeSocketProjection
} = require("./v2_booking_business_render_network_diagnostics.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_ROOT = path.join(ROOT, "outputs", "rebuild-phase3-d3");
const guard = installFixtureNetworkGuard({ label: "V2 booking-business D3 offline tests" });
let assertions = 0;

function check(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

function throws(action, expected, message) {
  assertions += 1;
  assert.throws(action, expected, message);
}

async function rejects(action, expected, message) {
  assertions += 1;
  await assert.rejects(action, expected, message);
}

async function textFiles(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (/\.(?:json|txt|log)$/iu.test(entry.name)) files.push(full);
    }
  };
  await visit(root);
  return files;
}

function testState(name) {
  return path.join(OUTPUT_ROOT, name);
}

function readinessEnv(state) {
  return {
    V2_RENDER_DIAGNOSTIC_STATE_DIR: state,
    V2_RENDER_DIAGNOSTIC_RUN_ENABLED: "0",
    V2_RENDER_DIAGNOSTIC_REQUEST_BUDGET: "0",
    V2_RENDER_DIAGNOSTIC_AUTOMATIC_RETRY: "0",
    V2_RENDER_DIAGNOSTIC_FALLBACK: "0",
    V2_RENDER_DIAGNOSTIC_OPERATIONAL_WRITES: "0"
  };
}

function fixtureEnv(state) {
  return { ...readinessEnv(state), V2_RENDER_DIAGNOSTIC_OFFLINE_APPROVED: "1" };
}

function liveEnv(state) {
  return {
    V2_RENDER_DIAGNOSTIC_STATE_DIR: state,
    V2_RENDER_DIAGNOSTIC_RUN_ENABLED: "1",
    V2_RENDER_DIAGNOSTIC_LIVE_APPROVED: LIVE_APPROVAL,
    V2_RENDER_DIAGNOSTIC_REQUEST_BUDGET: "1",
    V2_RENDER_DIAGNOSTIC_APPROVED_JOB_SHA256: RENDER_JOB_CANONICAL_SHA256,
    V2_RENDER_DIAGNOSTIC_EXPECTED_ENVELOPE_SHA256: COPY_ONLY_EXPECTED_ENVELOPE_SHA256,
    V2_RENDER_DIAGNOSTIC_AUTOMATIC_RETRY: "0",
    V2_RENDER_DIAGNOSTIC_FALLBACK: "0",
    V2_RENDER_DIAGNOSTIC_OPERATIONAL_WRITES: "0"
  };
}

function exerciseServeProcess(state) {
  const survivalMs = 10_000;
  const startupTimeoutMs = 15_000;
  const shutdownTimeoutMs = 5_000;
  const preload = path.join(ROOT, "scripts", "fixture_network_guard_preload.cjs");
  const secretSentinel = "phase3-d4-child-secret-sentinel";
  const env = {
    ...process.env,
    ...readinessEnv(state),
    NODE_OPTIONS: `--require=${preload.replace(/\\/gu, "/")}`,
    RENDER_SERVICE_ID: "",
    RENDER_GIT_COMMIT: "",
    V2_RENDER_DIAGNOSTIC_LIVE_APPROVED: "",
    V2_RENDER_DIAGNOSTIC_APPROVED_JOB_SHA256: "",
    V2_RENDER_DIAGNOSTIC_EXPECTED_ENVELOPE_SHA256: "",
    V2_RENDER_DIAGNOSTIC_SECRET_SENTINEL: secretSentinel
  };

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [
      path.join(ROOT, "scripts", "v2_booking_business_render_one_shot.cjs"),
      "serve"
    ], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let readinessEvent = null;
    let shutdownRequested = false;
    let survivalTimer = null;
    let shutdownTimer = null;

    const startupTimer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("serve child did not emit readiness before the startup timeout"));
    }, startupTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (readinessEvent) return;
      for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.event !== "render_diagnostic_ready") continue;
          readinessEvent = parsed;
          clearTimeout(startupTimer);
          survivalTimer = setTimeout(() => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            shutdownRequested = true;
            child.kill("SIGTERM");
            shutdownTimer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("serve child did not stop after SIGTERM"));
            }, shutdownTimeoutMs);
          }, survivalMs);
          break;
        } catch {
          // Ignore an incomplete line until the next stdout chunk arrives.
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(startupTimer);
      clearTimeout(survivalTimer);
      clearTimeout(shutdownTimer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(startupTimer);
      clearTimeout(survivalTimer);
      clearTimeout(shutdownTimer);
      if (!readinessEvent) {
        reject(new Error("serve child exited before readiness"));
        return;
      }
      if (!shutdownRequested) {
        reject(new Error("serve child exited before the approved shutdown signal"));
        return;
      }
      resolve(Object.freeze({
        readinessEvent,
        survivedMs: Date.now() - startedAt,
        exitCode,
        signal,
        stderrBytes: Buffer.byteLength(stderr),
        secretLeaked: stdout.includes(secretSentinel) || stderr.includes(secretSentinel)
      }));
    });
  });
}

function networkDiagnosticFixture() {
  return {
    schemaVersion: "v2-booking-business-render-network-diagnostics.v1",
    counts: Object.fromEntries(EVENT_NAMES.map((name) => [name, 0])),
    events: [],
    truncated: false,
    dnsAnswersStored: false,
    hostNamesStored: false,
    ipAddressesStored: false,
    requestTargetsStored: false,
    headerValuesStored: false,
    requestBodiesStored: false,
    responseBodiesStored: false,
    certificatesStored: false
  };
}

function syntheticChildResult(mode = "fixture") {
  const result = {
    status: "succeeded",
    classification: "resolved",
    placeId: "forbidden-raw-id",
    placeIdHash: LIVE_PLACE_ID_HASH,
    bookingBusinessId: "forbidden-booking-id",
    bookingBusinessIdHash: sha256("fixture-booking-business"),
    bookingUrl: "https://forbidden.invalid/raw",
    bookingUrlPresent: true,
    providerConfirmedZero: false,
    providerStatus: 200,
    responseDiagnostic: {
      status: 200,
      contentTypeClass: "json",
      fetchHeadersElapsedMs: 25,
      fetchOutcome: mode === "live" ? "response" : "fixture_response",
      fetchFailureClass: null,
      retryAfterSeconds: null,
      rawBodyStored: false,
      responseHeadersStored: false
    },
    error: null,
    runtime: { nodeVersion: "v26.5.0", undiciVersion: "8.7.0", platform: "linux", architecture: "x64" },
    sourceFunctionDigest: "a".repeat(64),
    querySha256: "b".repeat(64),
    request: { fetchEnvelope: { envelopeSha256: COPY_ONLY_EXPECTED_ENVELOPE_SHA256 } },
    networkDiagnostic: networkDiagnosticFixture(),
    calls: {
      bookingBusiness: 1,
      bookingItems: 0,
      dailySchedule: 0,
      total: 1,
      actualExternal: mode === "live" ? 1 : 0,
      fixture: mode === "fixture" ? 1 : 0
    },
    concurrency: 1,
    retries: 0,
    fallbacks: 0,
    htmlFallbackCalls: 0,
    historicalFallbackReads: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false,
    headersStored: false,
    fullRequestUrlStored: false
  };
  return result;
}

function syntheticChild(mode = "fixture") {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderrBytes: 0,
    stdout: `${JSON.stringify(syntheticChildResult(mode))}\n`
  };
}

async function main() {
  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });

  const sourceManifest = JSON.parse(await fs.readFile(path.join(ROOT, "docs", "v2_native_main_place_source_manifest.json"), "utf8"));
  for (const entry of sourceManifest.files) {
    const worktreeBytes = await fs.readFile(path.join(ROOT, entry.path));
    const lfBytes = canonicalGitTextBytes(worktreeBytes);
    const crlfBytes = manifestRecordedTextBytes(lfBytes);
    check(verifyManifestFileBytes(lfBytes, entry).matches, true, `${entry.path} must match from an LF checkout`);
    check(verifyManifestFileBytes(crlfBytes, entry).matches, true, `${entry.path} must match from a CRLF checkout`);
    check(gitBlobFromBytes(lfBytes), entry.gitBlob, `${entry.path} canonical bytes must retain the committed Git blob`);
  }
  const mutatedEntry = sourceManifest.files.find((entry) => entry.path === "package-lock.json");
  const mutatedBytes = Buffer.concat([canonicalGitTextBytes(await fs.readFile(path.join(ROOT, mutatedEntry.path))), Buffer.from("x")]);
  check(verifyManifestFileBytes(mutatedBytes, mutatedEntry).matches, false, "a non-EOL source mutation must fail closed");
  check(sha256(stableJson(sourceManifest)), SOURCE_MANIFEST_DIGEST, "the historical manifest identity must remain frozen");

  const integrity = await verifyIntegrity();
  check(integrity.baselineCommit, D2_COMMIT, "D3 must descend from the committed D2 baseline");
  check(integrity.collectorBlob, COLLECTOR_BLOB, "V2 collector blob must remain exact");
  check(integrity.lockfileSha256, LOCKFILE_SHA256, "lockfile identity must remain exact");
  check(integrity.runtime.nodeVersion, "v26.5.0", "Node runtime must remain exact");
  check(integrity.runtime.undiciVersion, "8.7.0", "Undici runtime must remain exact");
  check(verifyRenderDeployIdentity({}), { render: false, deployedCommit: null }, "local integrity must not claim a Render deploy");
  throws(
    () => verifyRenderDeployIdentity({ RENDER_SERVICE_ID: "srv-offline-fixture" }),
    { code: "V2_RENDER_DIAGNOSTIC_DEPLOY_COMMIT_MISMATCH" },
    "Render integrity must reject a missing deployed commit"
  );
  throws(
    () => verifyRenderDeployIdentity({
      RENDER_SERVICE_ID: "srv-offline-fixture",
      RENDER_GIT_COMMIT: "a".repeat(40),
      V2_RENDER_DIAGNOSTIC_EXPECTED_DEPLOY_COMMIT: "b".repeat(40)
    }),
    { code: "V2_RENDER_DIAGNOSTIC_DEPLOY_COMMIT_MISMATCH" },
    "Render integrity must reject a different expected commit"
  );
  check(
    verifyRenderDeployIdentity({
      RENDER_SERVICE_ID: "srv-offline-fixture",
      RENDER_GIT_COMMIT: "a".repeat(40),
      V2_RENDER_DIAGNOSTIC_EXPECTED_DEPLOY_COMMIT: "a".repeat(40)
    }),
    { render: true, deployedCommit: "a".repeat(40) },
    "Render integrity must accept only an exact deployed commit"
  );

  const { job, digest } = await readRenderJob();
  check(digest, RENDER_JOB_CANONICAL_SHA256, "render diagnostic job digest must remain frozen");
  check(job.runId, RENDER_RUN_ID, "render diagnostic run ID must remain frozen");
  check(job.request.requestBudget, 1, "job request budget must be exactly one");
  check(job.execution, {
    concurrency: 1,
    automaticRetry: false,
    fallback: false,
    operationalWrites: false,
    rawProviderResponseStored: false
  }, "job execution contract must fail closed");
  throws(
    () => normalizeRenderJob({ ...job, request: { ...job.request, requestBudget: 2 } }),
    { code: "V2_RENDER_DIAGNOSTIC_JOB_INVALID" },
    "a request budget above one must be rejected"
  );
  throws(
    () => normalizeRenderJob({ ...job, execution: { ...job.execution, automaticRetry: true } }),
    { code: "V2_RENDER_DIAGNOSTIC_JOB_INVALID" },
    "automatic retry must be rejected"
  );
  throws(
    () => normalizeRenderJob({ ...job, extra: true }),
    { code: "V2_RENDER_DIAGNOSTIC_JOB_INVALID" },
    "unknown job fields must be rejected"
  );

  const readyState = testState("readiness");
  const readyEnv = readinessEnv(readyState);
  assertReadinessGates(readyEnv);
  check(stateRoot(readyEnv), path.resolve(readyState), "local state must remain under the D3 output root");
  throws(
    () => stateRoot({ V2_RENDER_DIAGNOSTIC_STATE_DIR: path.join(ROOT, "outside-d3") }),
    { code: "V2_RENDER_DIAGNOSTIC_STATE_INVALID" },
    "local state outside the D3 root must be rejected"
  );
  check(
    stateRoot({ ...readyEnv, RENDER_SERVICE_ID: "srv-offline-fixture", V2_RENDER_DIAGNOSTIC_STATE_DIR: RENDER_STATE_ROOT }),
    path.resolve(RENDER_STATE_ROOT),
    "Render state must accept only the dedicated disk path"
  );
  throws(
    () => stateRoot({ ...readyEnv, RENDER_SERVICE_ID: "srv-offline-fixture", V2_RENDER_DIAGNOSTIC_STATE_DIR: "/var/data/wrong" }),
    { code: "V2_RENDER_DIAGNOSTIC_STATE_INVALID" },
    "Render state must reject any other disk path"
  );
  for (const mutation of [
    { V2_RENDER_DIAGNOSTIC_RUN_ENABLED: "1" },
    { V2_RENDER_DIAGNOSTIC_REQUEST_BUDGET: "1" },
    { V2_RENDER_DIAGNOSTIC_LIVE_APPROVED: LIVE_APPROVAL },
    { V2_RENDER_DIAGNOSTIC_APPROVED_JOB_SHA256: RENDER_JOB_CANONICAL_SHA256 },
    { V2_RENDER_DIAGNOSTIC_EXPECTED_ENVELOPE_SHA256: COPY_ONLY_EXPECTED_ENVELOPE_SHA256 }
  ]) {
    throws(
      () => assertReadinessGates({ ...readyEnv, ...mutation }),
      { code: "V2_RENDER_DIAGNOSTIC_READINESS_GATE_INVALID" },
      "readiness must reject every live gate"
    );
  }
  for (const name of ["V2_RENDER_DIAGNOSTIC_AUTOMATIC_RETRY", "V2_RENDER_DIAGNOSTIC_FALLBACK", "V2_RENDER_DIAGNOSTIC_OPERATIONAL_WRITES"]) {
    throws(
      () => assertReadinessGates({ ...readyEnv, [name]: "1" }),
      { code: "V2_RENDER_DIAGNOSTIC_READINESS_GATE_INVALID" },
      `readiness must reject enabled ${name}`
    );
  }
  const ready = await readiness(readyEnv);
  check(ready.event, "render_diagnostic_ready", "readiness event must be structured");
  check(ready.runEnabled, false, "readiness must not enable execution");
  check(ready.requestBudget, 0, "readiness request budget must remain zero");
  check(ready.externalRequests, 0, "readiness must make no external request");

  const live = liveEnv(testState("live-gate-only"));
  assertLiveGates(live);
  for (const name of [
    "V2_RENDER_DIAGNOSTIC_RUN_ENABLED",
    "V2_RENDER_DIAGNOSTIC_LIVE_APPROVED",
    "V2_RENDER_DIAGNOSTIC_REQUEST_BUDGET",
    "V2_RENDER_DIAGNOSTIC_APPROVED_JOB_SHA256",
    "V2_RENDER_DIAGNOSTIC_EXPECTED_ENVELOPE_SHA256"
  ]) {
    const mutated = { ...live };
    delete mutated[name];
    throws(
      () => assertLiveGates(mutated),
      { code: "V2_RENDER_DIAGNOSTIC_LIVE_NOT_APPROVED" },
      `live execution must reject a missing ${name}`
    );
  }
  for (const [name, value] of [
    ["V2_RENDER_DIAGNOSTIC_AUTOMATIC_RETRY", "1"],
    ["V2_RENDER_DIAGNOSTIC_FALLBACK", "1"],
    ["V2_RENDER_DIAGNOSTIC_OPERATIONAL_WRITES", "1"]
  ]) {
    throws(
      () => assertLiveGates({ ...live, [name]: value }),
      { code: "V2_RENDER_DIAGNOSTIC_LIVE_NOT_APPROVED" },
      `${name} must remain disabled`
    );
  }

  check(headerNames("accept: */*\r\ncontent-type: application/json\r\n"), ["accept", "content-type"], "wire headers must reduce to names");
  check(safeNetworkFailureClass({ cause: { code: "ENOTFOUND" } }), "dns", "DNS errors must be classified without messages");
  check(safeNetworkFailureClass({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "timeout", "timeouts must be classified without messages");
  const socketProjection = safeSocketProjection({
    encrypted: true,
    remoteFamily: "IPv4",
    remoteAddress: "203.0.113.17",
    servername: "secret.example",
    alpnProtocol: "http/1.1",
    authorized: true,
    getProtocol: () => "TLSv1.3",
    getCipher: () => ({ name: "TLS_AES_256_GCM_SHA384" })
  });
  check(socketProjection.addressFamily, "IPv4", "address family may be retained");
  check(socketProjection.tlsProtocol, "TLSv1.3", "TLS protocol may be retained");
  check(socketProjection.ipAddressStored, false, "IP address must not be retained");
  check(JSON.stringify(socketProjection).includes("203.0.113.17"), false, "IP address must be redacted");
  check(JSON.stringify(socketProjection).includes("secret.example"), false, "server name must be redacted");
  const responseProjection = projectEvent("undici:request:headers", {
    response: { statusCode: 405, headers: ["content-type", "text/html", "set-cookie", "secret-cookie"] }
  });
  check(responseProjection.statusCode, 405, "safe HTTP status may be retained");
  check(responseProjection.responseHeaderNames, ["content-type", "set-cookie"], "only response header names may be retained");
  check(JSON.stringify(responseProjection).includes("secret-cookie"), false, "response header values must be redacted");
  const recorder = createRenderNetworkRecorder();
  const networkSnapshot = recorder.snapshot();
  recorder.close();
  check(networkSnapshot.events.length, 0, "an idle recorder must remain empty");
  check(networkSnapshot.responseBodiesStored, false, "network recorder must never store response bodies");
  check(installRenderNetworkRecorderFromEnvironment({}), null, "network recorder must remain disabled without an explicit child gate");
  const maliciousDiagnostic = {
    ...networkDiagnosticFixture(),
    events: [{
      name: "undici:client:connected",
      encrypted: true,
      addressFamily: "IPv6",
      alpnProtocol: "http/1.1",
      tlsProtocol: "TLSv1.3",
      cipherName: "TLS_AES_256_GCM_SHA384",
      tlsAuthorized: true,
      remoteAddress: "2001:db8::1",
      serverName: "forbidden.example"
    }]
  };
  maliciousDiagnostic.counts["undici:client:connected"] = 1;
  const safeDiagnostic = safeNetworkProjection(maliciousDiagnostic);
  check(JSON.stringify(safeDiagnostic).includes("2001:db8::1"), false, "safe network projection must drop IP values");
  check(JSON.stringify(safeDiagnostic).includes("forbidden.example"), false, "safe network projection must drop host values");

  const sentinel = "phase3-d3-secret-sentinel-41fd";
  const childEnv = safeChildEnvironment({
    ...process.env,
    V2_RENDER_DIAGNOSTIC_SECRET_SENTINEL: sentinel,
    AUTHORIZATION: `Bearer ${sentinel}`,
    HTTPS_PROXY: `http://${sentinel}@proxy.invalid:8080`,
    NODE_EXTRA_CA_CERTS: `/tmp/${sentinel}.pem`
  }, { sourceRoot: ROOT, sourceJob: integrity.sourceJob, mode: "fixture" });
  check(Object.values(childEnv).some((value) => String(value).includes(sentinel)), false, "unapproved environment values must not reach the child");
  check(Object.prototype.hasOwnProperty.call(childEnv, "HTTPS_PROXY"), false, "proxy settings must not reach the diagnostic child");
  check(Object.prototype.hasOwnProperty.call(childEnv, "NODE_EXTRA_CA_CERTS"), false, "custom CA settings must not reach the diagnostic child");
  check(childEnv.NODE_OPTIONS.includes("fixture_network_guard_preload.cjs"), true, "fixture child must preload the network blocker");

  const fixtureState = testState("fixture-real-child");
  const fixture = await runOneShot({ mode: "fixture", env: { ...fixtureEnv(fixtureState), V2_RENDER_DIAGNOSTIC_SECRET_SENTINEL: sentinel } });
  check(fixture.observation.event, "render_diagnostic_terminal", "fixture must create one terminal observation");
  check(fixture.observation.externalRequests, 0, "fixture must make no Provider request");
  check(fixture.observation.collectorInvocations, 1, "fixture must invoke the copied path exactly once");
  check(fixture.observation.result.calls.fixture, 1, "fixture transport must be used exactly once");
  check(fixture.observation.result.networkDiagnostic.events.length, 0, "fixture transport must not open an Undici socket");
  const duplicate = await runOneShot({ mode: "fixture", env: fixtureEnv(fixtureState) });
  check(duplicate.status, "duplicate-blocked", "a restart must fail closed on the durable claim");
  check(duplicate.externalRequests, 0, "duplicate execution must make no request");
  check(duplicate.collectorInvocations, 0, "duplicate execution must not invoke the copied path");

  const concurrentState = testState("concurrent");
  let concurrentInvocations = 0;
  const delayedChild = async () => {
    concurrentInvocations += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return syntheticChild("fixture");
  };
  const concurrent = await Promise.all([
    runOneShot({ mode: "fixture", env: fixtureEnv(concurrentState), childRunner: delayedChild }),
    runOneShot({ mode: "fixture", env: fixtureEnv(concurrentState), childRunner: delayedChild })
  ]);
  check(concurrentInvocations, 1, "concurrent supervisors must invoke only one child");
  check(concurrent.filter((entry) => entry.status === "duplicate-blocked").length, 1, "one concurrent claimant must be blocked");

  const failureState = testState("partial-failure");
  await rejects(
    () => runOneShot({
      mode: "fixture",
      env: fixtureEnv(failureState),
      childRunner: async () => { throw Object.assign(new Error("synthetic child failure"), { code: "SYNTHETIC_CHILD_FAILURE" }); }
    }),
    { code: "SYNTHETIC_CHILD_FAILURE" },
    "a child failure must be surfaced without retry"
  );
  const failureDuplicate = await runOneShot({ mode: "fixture", env: fixtureEnv(failureState), childRunner: async () => syntheticChild("fixture") });
  check(failureDuplicate.status, "duplicate-blocked", "a partial failure must not be retried after restart");
  check(await fs.stat(path.join(failureState, "runs", RENDER_RUN_ID, "failure.json")).then(() => true, () => false), true, "partial failure evidence must be atomic");

  const liveProjection = safeChildProjection(syntheticChildResult("live"), "live");
  check(liveProjection.calls.actualExternal, 1, "synthetic live audit must account for exactly one request");
  check(Object.prototype.hasOwnProperty.call(liveProjection, "placeId"), false, "safe projection must remove the raw Place ID");
  check(Object.prototype.hasOwnProperty.call(liveProjection, "bookingBusinessId"), false, "safe projection must remove the raw booking ID");
  check(Object.prototype.hasOwnProperty.call(liveProjection, "bookingUrl"), false, "safe projection must remove the raw booking URL");

  const signalTarget = new EventEmitter();
  const keepaliveToken = Object.freeze({ kind: "offline-keepalive" });
  let scheduledInterval = null;
  let clearedToken = null;
  const signalPromise = holdUntilSignal({
    signalTarget,
    setIntervalFn: (_callback, intervalMs) => {
      scheduledInterval = intervalMs;
      return keepaliveToken;
    },
    clearIntervalFn: (token) => { clearedToken = token; }
  });
  check(scheduledInterval, PROCESS_KEEPALIVE_INTERVAL_MS, "serve mode must register an active keepalive handle");
  signalTarget.emit("SIGTERM");
  const signalResult = await signalPromise;
  check(signalResult.signal, "SIGTERM", "serve mode must report its termination signal");
  check(clearedToken, keepaliveToken, "serve mode must clear its keepalive handle on shutdown");
  check(signalTarget.listenerCount("SIGTERM"), 0, "serve mode must remove its SIGTERM listener after shutdown");
  check(signalTarget.listenerCount("SIGINT"), 0, "serve mode must remove its SIGINT listener after shutdown");

  const serveOutcome = await exerciseServeProcess(testState("serve-process-lifetime"));
  check(serveOutcome.readinessEvent.status, "ready", "serve child must emit readiness before the survival window");
  check(serveOutcome.readinessEvent.mode, "readiness-only", "serve child must remain in readiness-only mode");
  check(serveOutcome.readinessEvent.runEnabled, false, "serve child must keep collection disabled");
  check(serveOutcome.readinessEvent.requestBudget, 0, "serve child must keep its request budget at zero");
  check(serveOutcome.readinessEvent.externalRequests, 0, "serve child must make no Provider request");
  check(serveOutcome.readinessEvent.operationalWrites, 0, "serve child must make no operational write");
  check(serveOutcome.survivedMs >= 10_000, true, "serve child must remain alive for the full survival window");
  check(serveOutcome.exitCode === 0 || serveOutcome.signal === "SIGTERM", true, "serve child must stop only after controlled SIGTERM");
  check(serveOutcome.stderrBytes, 0, "serve child must not emit stderr during controlled shutdown");
  check(serveOutcome.secretLeaked, false, "serve child must not leak the secret sentinel");

  const files = await textFiles(OUTPUT_ROOT);
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    check(text.includes(sentinel), false, `secret sentinel leaked into ${path.basename(file)}`);
    check(text.includes("forbidden-raw-id"), false, `raw Place ID leaked into ${path.basename(file)}`);
    check(text.includes("forbidden-booking-id"), false, `raw booking ID leaked into ${path.basename(file)}`);
    check(/<!doctype\s+html|<html|<body/iu.test(text), false, `raw HTML leaked into ${path.basename(file)}`);
  }

  check(guard.blockedAttempts(), 0, "offline suite must not attempt Provider networking");
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "v2-booking-business-render-one-shot-test-result.v1",
    status: "passed",
    assertions,
    actualProviderExternalRequests: 0,
    fixtureRequests: 1,
    simulatedLiveAuditRequests: 1,
    duplicateCollectorInvocations: 0,
    concurrentCollectorInvocations: concurrentInvocations,
    serveSurvivalMs: serveOutcome.survivedMs,
    serveControlledShutdown: true,
    retries: 0,
    fallbacks: 0,
    operationalWrites: 0,
    secretScan: "passed",
    rawProviderResponsesStored: false
  })}\n`);

  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    code: error?.code || "V2_RENDER_DIAGNOSTIC_TEST_FAILED",
    message: error?.message || String(error)
  })}\n`);
  process.exitCode = 1;
}).finally(() => guard.restore());
