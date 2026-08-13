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
  CHILD_PROCESS_DIAGNOSTIC_SCHEMA_VERSION,
  CHILD_RESULT_SCHEMA_VERSION,
  CHILD_STDOUT_LIMIT_BYTES,
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
  parseChildResult,
  readRenderJob,
  readiness,
  runOneShot,
  safeChildEnvironment,
  safeChildProjection,
  safeNetworkProjection,
  safeRunnerErrorProjection,
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
    schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
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
  const stdout = `${JSON.stringify(syntheticChildResult(mode))}\n`;
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderrBytes: 0,
    stdout,
    stdoutBytes: Buffer.byteLength(stdout),
    stdoutRetainedBytes: Buffer.byteLength(stdout),
    stdoutTruncated: false
  };
}

function exerciseRealChildPreflightFailure(sourceJob) {
  const preload = path.join(ROOT, "scripts", "fixture_network_guard_preload.cjs");
  const missingSourceRoot = path.join(OUTPUT_ROOT, "missing-child-source");
  const sentinel = "phase3-d5-real-child-secret-sentinel";
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: "test",
    NODE_OPTIONS: `--require=${preload.replace(/\\/gu, "/")}`,
    V2_BOOKING_BUSINESS_SOURCE_ROOT: missingSourceRoot,
    V2_BOOKING_BUSINESS_PLACE_ID: sourceJob.placeId,
    V2_BOOKING_BUSINESS_CHECK_IN: sourceJob.checkIn,
    V2_BOOKING_BUSINESS_ADULTS: String(sourceJob.adults),
    V2_BOOKING_BUSINESS_TIMEOUT_MS: String(sourceJob.timeoutMs),
    V2_BOOKING_BUSINESS_RESPONSE_LIMIT_BYTES: String(sourceJob.responseSizeLimitBytes),
    V2_BOOKING_BUSINESS_TRANSPORT_MODE: "fixture",
    V2_BOOKING_BUSINESS_FIXTURE_SCENARIO: "success",
    V2_BOOKING_BUSINESS_NETWORK_DIAGNOSTICS: "1",
    V2_RENDER_DIAGNOSTIC_SECRET_SENTINEL: sentinel
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "v2_booking_business_child.cjs")], {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("real child preflight failure timed out"));
    }, 5_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderrBytes += Buffer.byteLength(chunk); });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve(Object.freeze({
        exitCode,
        signal,
        timedOut: false,
        stdout,
        stdoutBytes: Buffer.byteLength(stdout),
        stdoutRetainedBytes: Buffer.byteLength(stdout),
        stdoutTruncated: false,
        stderrBytes,
        secretLeaked: stdout.includes(sentinel)
      }));
    });
  });
}

function captureChildError(child) {
  try {
    parseChildResult(child);
  } catch (error) {
    return error;
  }
  assert.fail("child process contract unexpectedly passed");
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

  const failedChildResult = {
    schemaVersion: CHILD_RESULT_SCHEMA_VERSION,
    status: "failed",
    classification: "failed",
    error: {
      code: "V2_BOOKING_BUSINESS_SOURCE_INVALID",
      retryable: false,
      forbiddenDetail: sentinel
    },
    calls: {
      bookingBusiness: 0,
      bookingItems: 0,
      dailySchedule: 0,
      total: 0,
      actualExternal: 0,
      fixture: 0
    },
    forbiddenRawIdentifier: "forbidden-raw-id"
  };
  const failedChildStdout = `${JSON.stringify(failedChildResult)}\n`;
  const failedChild = {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stderrBytes: 0,
    stdout: failedChildStdout,
    stdoutBytes: Buffer.byteLength(failedChildStdout),
    stdoutRetainedBytes: Buffer.byteLength(failedChildStdout),
    stdoutTruncated: false
  };
  const failedChildError = captureChildError(failedChild);
  const failedChildProjection = safeRunnerErrorProjection(failedChildError);
  check(failedChildProjection.stage, "child-process-contract", "structured child failure must identify its stage");
  check(failedChildProjection.childProcessDiagnostic.schemaVersion, CHILD_PROCESS_DIAGNOSTIC_SCHEMA_VERSION, "child diagnostic schema must be explicit");
  check(failedChildProjection.childProcessDiagnostic.failedChecks, ["exit_code"], "non-zero child exit must be distinguished");
  check(failedChildProjection.childProcessDiagnostic.childErrorCode, "V2_BOOKING_BUSINESS_SOURCE_INVALID", "an allowlisted child error code may be retained");
  check(failedChildProjection.childProcessDiagnostic.childReportedActualExternalRequests, 0, "child-reported request count may be retained as untrusted evidence");
  check(failedChildProjection.childProcessDiagnostic.childReportedCallCountsTrusted, false, "failed child call counts must never be treated as trusted");
  check(JSON.stringify(failedChildProjection).includes(sentinel), false, "structured child diagnostics must remove child details");
  check(JSON.stringify(failedChildProjection).includes("forbidden-raw-id"), false, "structured child diagnostics must remove raw identifiers");

  const multilineError = captureChildError({
    ...failedChild,
    exitCode: 0,
    stdout: `${sentinel}\n${failedChildStdout}`,
    stdoutBytes: Buffer.byteLength(`${sentinel}\n${failedChildStdout}`),
    stdoutRetainedBytes: Buffer.byteLength(`${sentinel}\n${failedChildStdout}`)
  });
  const multilineProjection = safeRunnerErrorProjection(multilineError);
  check(multilineProjection.childProcessDiagnostic.failedChecks, ["stdout_line_count"], "multiple stdout lines must be distinguished");
  check(multilineProjection.childProcessDiagnostic.stdoutLineCount, 2, "safe diagnostic may retain only the line count");
  check(JSON.stringify(multilineProjection).includes(sentinel), false, "multiple raw stdout lines must not be retained");

  const emptyStdoutError = captureChildError({
    ...failedChild,
    exitCode: 0,
    stdout: "",
    stdoutBytes: 0,
    stdoutRetainedBytes: 0
  });
  check(safeRunnerErrorProjection(emptyStdoutError).childProcessDiagnostic.failedChecks, ["stdout_line_count"], "empty stdout must be distinguished");
  check(safeRunnerErrorProjection(emptyStdoutError).childProcessDiagnostic.stdoutLineCount, 0, "empty stdout must retain only a zero line count");

  const invalidJsonError = captureChildError({
    ...failedChild,
    exitCode: 0,
    stdout: `{${sentinel}`,
    stdoutBytes: Buffer.byteLength(`{${sentinel}`),
    stdoutRetainedBytes: Buffer.byteLength(`{${sentinel}`)
  });
  check(safeRunnerErrorProjection(invalidJsonError).childProcessDiagnostic.failedChecks, ["stdout_json"], "invalid JSON must be distinguished from line framing");
  check(JSON.stringify(safeRunnerErrorProjection(invalidJsonError)).includes(sentinel), false, "invalid raw JSON must not be retained");

  const schemaError = captureChildError({
    ...failedChild,
    exitCode: 0,
    stdout: `${JSON.stringify({ schemaVersion: sentinel, status: "failed", error: { code: sentinel } })}\n`
  });
  const schemaProjection = safeRunnerErrorProjection(schemaError);
  check(schemaProjection.childProcessDiagnostic.failedChecks, ["result_schema"], "unexpected child schema must be distinguished");
  check(schemaProjection.childProcessDiagnostic.childErrorCode, null, "unknown child codes must not enter diagnostics");
  check(JSON.stringify(schemaProjection).includes(sentinel), false, "unexpected child schema values must not be retained");
  const statusError = captureChildError({
    ...failedChild,
    exitCode: 0,
    stdout: `${JSON.stringify({ schemaVersion: CHILD_RESULT_SCHEMA_VERSION, status: sentinel })}\n`
  });
  check(safeRunnerErrorProjection(statusError).childProcessDiagnostic.failedChecks, ["result_status"], "unexpected child status must be distinguished");
  check(JSON.stringify(safeRunnerErrorProjection(statusError)).includes(sentinel), false, "unexpected child status values must not be retained");

  const signalError = captureChildError({ ...syntheticChild(), exitCode: null, signal: "SIGTERM" });
  check(safeRunnerErrorProjection(signalError).childProcessDiagnostic.failedChecks, ["signal"], "signal termination must be distinguished");
  check(safeRunnerErrorProjection(signalError).childProcessDiagnostic.signal, "SIGTERM", "an allowlisted signal may be retained");
  const unknownSignalError = captureChildError({ ...syntheticChild(), exitCode: null, signal: sentinel });
  check(safeRunnerErrorProjection(unknownSignalError).childProcessDiagnostic.signal, "OTHER", "unknown signal values must be reduced to a safe class");
  check(JSON.stringify(safeRunnerErrorProjection(unknownSignalError)).includes(sentinel), false, "unknown signal values must not be retained");

  const timeoutError = captureChildError({ ...syntheticChild(), exitCode: null, signal: "SIGKILL", timedOut: true });
  check(safeRunnerErrorProjection(timeoutError).childProcessDiagnostic.failedChecks, ["signal", "timeout"], "timeout and its kill signal must both be visible");
  const stderrError = captureChildError({ ...syntheticChild(), stderrBytes: 37, forbiddenStderr: sentinel });
  const stderrProjection = safeRunnerErrorProjection(stderrError);
  check(stderrProjection.childProcessDiagnostic.failedChecks, ["stderr"], "stderr output must be distinguished");
  check(stderrProjection.childProcessDiagnostic.stderrBytes, 37, "stderr diagnostics may retain only a byte count");
  check(JSON.stringify(stderrProjection).includes(sentinel), false, "stderr content must not be retained");

  const truncatedError = captureChildError({
    ...syntheticChild(),
    stdoutBytes: CHILD_STDOUT_LIMIT_BYTES + 1,
    stdoutRetainedBytes: CHILD_STDOUT_LIMIT_BYTES,
    stdoutTruncated: true
  });
  const truncatedProjection = safeRunnerErrorProjection(truncatedError);
  check(truncatedProjection.childProcessDiagnostic.failedChecks, ["stdout_truncated"], "truncated stdout must fail closed");
  check(truncatedProjection.childProcessDiagnostic.stdoutTruncated, true, "stdout truncation must be explicit");

  const forgedProjection = safeRunnerErrorProjection({
    code: sentinel,
    childProcessDiagnostic: {
      schemaVersion: CHILD_PROCESS_DIAGNOSTIC_SCHEMA_VERSION,
      failedChecks: ["stderr", sentinel],
      childErrorCode: sentinel,
      signal: sentinel,
      stdoutBytes: -1,
      stdoutRetainedBytes: -1,
      stdoutLineCount: -1,
      stderrBytes: -1,
      forbidden: sentinel
    }
  });
  check(forgedProjection.childProcessDiagnostic.failedChecks, ["stderr"], "persisted diagnostics must re-allowlist failed checks");
  check(forgedProjection.childProcessDiagnostic.childErrorCode, null, "persisted diagnostics must re-allowlist child codes");
  check(forgedProjection.code, "V2_RENDER_DIAGNOSTIC_FAILED", "unknown outer error codes must reduce to the generic runner code");
  check(JSON.stringify(forgedProjection).includes(sentinel), false, "forged diagnostic fields must not cross the output boundary");

  const realChildFailure = await exerciseRealChildPreflightFailure(integrity.sourceJob);
  check(realChildFailure.exitCode, 1, "real child preflight failure must use a non-zero exit code");
  check(realChildFailure.signal, null, "real child preflight failure must not require a signal");
  check(realChildFailure.stderrBytes, 0, "real child preflight failure must keep stderr empty");
  check(realChildFailure.secretLeaked, false, "real child preflight failure must not echo unapproved environment values");
  const realChildError = captureChildError(realChildFailure);
  const realChildProjection = safeRunnerErrorProjection(realChildError);
  check(realChildProjection.childProcessDiagnostic.failedChecks, ["exit_code"], "real one-line child failure must preserve valid framing");
  check(realChildProjection.childProcessDiagnostic.parsedJson, true, "real child failure JSON must remain parseable");
  check(realChildProjection.childProcessDiagnostic.childErrorCode, "V2_BOOKING_BUSINESS_SOURCE_INVALID", "real child preflight code must survive the allowlist");
  check(realChildProjection.childProcessDiagnostic.childReportedActualExternalRequests, 0, "real child preflight failure must report zero requests");
  check(JSON.stringify(realChildProjection).includes(sentinel), false, "real child diagnostic projection must not leak the sentinel");

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

  const framingFailureState = testState("child-framing-failure");
  await rejects(
    () => runOneShot({ mode: "fixture", env: fixtureEnv(framingFailureState), childRunner: async () => failedChild }),
    { code: "V2_RENDER_DIAGNOSTIC_CHILD_INVALID" },
    "a structured child failure must fail without retry"
  );
  const framingFailureText = await fs.readFile(path.join(framingFailureState, "runs", RENDER_RUN_ID, "failure.json"), "utf8");
  const framingFailure = JSON.parse(framingFailureText);
  check(framingFailure.stage, "child-process-contract", "failure artifact must record the safe child stage");
  check(framingFailure.childProcessDiagnostic.childErrorCode, "V2_BOOKING_BUSINESS_SOURCE_INVALID", "failure artifact must retain only the allowlisted child code");
  check(framingFailure.childProcessDiagnostic.childReportedActualExternalRequests, 0, "failure artifact may retain the untrusted child request count");
  check(framingFailure.childProcessDiagnostic.rawStdoutStored, false, "failure artifact must not store raw stdout");
  check(framingFailureText.includes(sentinel), false, "failure artifact must not contain the secret sentinel");
  check(framingFailureText.includes("forbidden-raw-id"), false, "failure artifact must not contain raw identifiers");

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
