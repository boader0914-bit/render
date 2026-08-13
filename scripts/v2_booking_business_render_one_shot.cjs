"use strict";

const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  COLLECTOR_BLOB,
  COPY_ONLY_APPROVED_JOB_SHA256,
  COPY_ONLY_EXPECTED_ENVELOPE_SHA256,
  LIVE_PLACE_ID_HASH,
  LOCKFILE_SHA256,
  readCopyOnlyJob,
  sha256,
  stableJson,
  verifyRuntime
} = require("./v2_booking_business_harness.cjs");
const { runtimeFingerprint } = require("./v2_booking_business_env_diagnostics.cjs");

const ROOT = path.resolve(__dirname, "..");
const D2_COMMIT = "dce4c88c8e7d5846f39ac49a40512d1d1363c971";
const REFERENCE_COLLECTOR_BLOB = "bcbe229998da3afa6f31ee04375fb0766019e56f";
const REFERENCE_COLLECTOR_SHA256 = "b114dd542169f45034bef3a13266b3c6c9aa4cead1de7b8eed39cf675b22e786";
const SOURCE_MANIFEST_DIGEST = "89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40";
const PREVIOUS_LIVE_EVIDENCE_DIGEST = "da4cb9697ed195d54ef62f3c7e15563efbad41a0baa7dbee0b2ebef1e55e3ebf";
const RENDER_JOB_SCHEMA_VERSION = "v2-booking-business-render-diagnostic-job.v1";
const RENDER_JOB_CANONICAL_SHA256 = "598cb85cbddef5338e1b7d67ed0aa4b16ba7713f85b16bbb28925d0f481d2bd0";
const RENDER_RUN_ID = "rebuild-phase3-booking-business-render-live-001";
const LIVE_APPROVAL = "N3-D3-Live";
const RENDER_STATE_ROOT = "/var/data/v2-booking-business-render-diagnostic";
const JOB_PATH = path.join(ROOT, "docs", "v2_booking_business_render_diagnostic_job.proposal.json");
const SOURCE_JOB_PATH = path.join(ROOT, "docs", "v2_booking_business_copy_only_live_job.proposal.json");
const SOURCE_MANIFEST_PATH = path.join(ROOT, "docs", "v2_native_main_place_source_manifest.json");
const PREVIOUS_LIVE_EVIDENCE_PATH = path.join(ROOT, "docs", "v2_booking_business_n3_live_evidence_manifest.json");
const CHILD_PATH = path.join(ROOT, "scripts", "v2_booking_business_child.cjs");
const NETWORK_PRELOAD = path.join(ROOT, "scripts", "fixture_network_guard_preload.cjs");
const LOCAL_STATE_ROOT = path.join(ROOT, "outputs", "rebuild-phase3-d3");
const NETWORK_EVENT_NAMES = new Set([
  "undici:request:create",
  "undici:client:beforeConnect",
  "undici:client:connected",
  "undici:request:headers",
  "undici:request:trailers",
  "undici:request:error"
]);

class V2BookingBusinessRenderDiagnosticError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "V2BookingBusinessRenderDiagnosticError";
    this.code = code;
    this.retryable = false;
  }
}

function fail(code, message) {
  throw new V2BookingBusinessRenderDiagnosticError(code, message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("V2_RENDER_DIAGNOSTIC_JOB_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("V2_RENDER_DIAGNOSTIC_JOB_INVALID", `${label} keys are invalid`);
  }
}

function normalizeRenderJob(value) {
  exactKeys(value, ["schemaVersion", "runId", "mode", "source", "request", "execution"], "job");
  exactKeys(value.source, ["kind", "sourceJobCanonicalSha256", "sourceManifestSha256", "collectorBlob", "rank", "placeIdHash"], "source");
  exactKeys(value.request, ["operationName", "method", "endpointClass", "expectedEnvelopeSha256", "requestBudget", "timeoutMs", "responseSizeLimitBytes"], "request");
  exactKeys(value.execution, ["concurrency", "automaticRetry", "fallback", "operationalWrites", "rawProviderResponseStored"], "execution");
  if (
    value.schemaVersion !== RENDER_JOB_SCHEMA_VERSION
    || value.runId !== RENDER_RUN_ID
    || value.mode !== "render-copy-only-diagnostic"
    || value.source.kind !== "phase2-live-natural-rank-copy"
    || value.source.sourceJobCanonicalSha256 !== COPY_ONLY_APPROVED_JOB_SHA256
    || value.source.sourceManifestSha256 !== "89ed646cc3ad57bb38da577cd177d6827aeb3f008553b2c1c8a8df242e642b40"
    || value.source.collectorBlob !== COLLECTOR_BLOB
    || value.source.rank !== 1
    || value.source.placeIdHash !== LIVE_PLACE_ID_HASH
    || value.request.operationName !== "naverBookingBusiness"
    || value.request.method !== "POST"
    || value.request.endpointClass !== "naver-place-graphql"
    || value.request.expectedEnvelopeSha256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
    || value.request.requestBudget !== 1
    || value.request.timeoutMs !== 25_000
    || value.request.responseSizeLimitBytes !== 2 * 1024 * 1024
    || value.execution.concurrency !== 1
    || value.execution.automaticRetry !== false
    || value.execution.fallback !== false
    || value.execution.operationalWrites !== false
    || value.execution.rawProviderResponseStored !== false
  ) fail("V2_RENDER_DIAGNOSTIC_JOB_INVALID", "render diagnostic job contract changed");
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}

async function readRenderJob(jobPath = JOB_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(path.resolve(jobPath), "utf8"));
  } catch {
    fail("V2_RENDER_DIAGNOSTIC_JOB_INVALID", "render diagnostic job JSON is invalid");
  }
  const job = normalizeRenderJob(parsed);
  const digest = sha256(stableJson(job));
  if (digest !== RENDER_JOB_CANONICAL_SHA256) {
    fail("V2_RENDER_DIAGNOSTIC_JOB_MISMATCH", "render diagnostic job digest changed");
  }
  return Object.freeze({ job, digest });
}

function verifyRenderDeployIdentity(env = process.env) {
  if (!env.RENDER_SERVICE_ID) return Object.freeze({ render: false, deployedCommit: null });
  const deployedCommit = String(env.RENDER_GIT_COMMIT || "").trim().toLowerCase();
  const expectedCommit = String(env.V2_RENDER_DIAGNOSTIC_EXPECTED_DEPLOY_COMMIT || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(deployedCommit) || !/^[a-f0-9]{40}$/u.test(expectedCommit) || deployedCommit !== expectedCommit) {
    fail("V2_RENDER_DIAGNOSTIC_DEPLOY_COMMIT_MISMATCH", "Render deploy commit does not match the approved expected SHA");
  }
  return Object.freeze({ render: true, deployedCommit });
}

async function verifySourceManifest() {
  const manifest = JSON.parse(await fs.readFile(SOURCE_MANIFEST_PATH, "utf8"));
  if (
    sha256(stableJson(manifest)) !== SOURCE_MANIFEST_DIGEST
    || manifest.baselineCollectorBlob !== COLLECTOR_BLOB
    || manifest.lockfileSha256 !== LOCKFILE_SHA256
    || manifest.files?.length !== 20
  ) fail("V2_RENDER_DIAGNOSTIC_SOURCE_MISMATCH", "source manifest identity changed");
  for (const entry of manifest.files) {
    const content = await fs.readFile(path.join(ROOT, entry.path));
    if (content.length !== entry.bytes || sha256(content) !== entry.sha256) {
      fail("V2_RENDER_DIAGNOSTIC_SOURCE_MISMATCH", "source closure file hash changed");
    }
  }
  return manifest;
}

async function verifyPreviousEvidence() {
  const value = JSON.parse(await fs.readFile(PREVIOUS_LIVE_EVIDENCE_PATH, "utf8"));
  if (
    sha256(stableJson(value)) !== PREVIOUS_LIVE_EVIDENCE_DIGEST
    || value.schemaVersion !== "v2-booking-business-n3-live-evidence.v1"
    || value.original?.providerStatus !== 200
    || value.original?.actualExternalRequests !== 1
    || value.copied?.providerStatus !== 405
    || value.copied?.actualExternalRequests !== 1
    || value.totalExternalRequests !== 2
    || value.retries !== 0
    || value.fallbacks !== 0
    || value.operationalWrites !== 0
    || value.rawProviderResponsesStored !== false
  ) fail("V2_RENDER_DIAGNOSTIC_EVIDENCE_MISMATCH", "previous live evidence contract changed");
  return Object.freeze({ canonicalSha256: PREVIOUS_LIVE_EVIDENCE_DIGEST });
}

async function verifyIntegrity(env = process.env) {
  const [{ job, digest }, { job: sourceJob, digest: sourceJobDigest }, sourceManifest, previousEvidence] = await Promise.all([
    readRenderJob(),
    readCopyOnlyJob(SOURCE_JOB_PATH),
    verifySourceManifest(),
    verifyPreviousEvidence()
  ]);
  const deploy = verifyRenderDeployIdentity(env);
  const collectorBytes = await fs.readFile(path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs"));
  const referenceCollectorBytes = await fs.readFile(path.join(ROOT, "scripts", "frozen_v2_4e4e190", "gyeongnam_glamping_crawl.cjs"));
  const lockfileBytes = await fs.readFile(path.join(ROOT, "package-lock.json"));
  if (
    sha256(collectorBytes) !== sourceManifest.files.find((entry) => entry.path === "scripts/gyeongnam_glamping_crawl.cjs")?.sha256
    || sha256(referenceCollectorBytes) !== REFERENCE_COLLECTOR_SHA256
    || sha256(lockfileBytes) !== LOCKFILE_SHA256
    || sourceJobDigest !== COPY_ONLY_APPROVED_JOB_SHA256
    || sha256(sourceJob.placeId) !== job.source.placeIdHash
  ) fail("V2_RENDER_DIAGNOSTIC_BASELINE_MISMATCH", "source, collector, lockfile, or target identity changed");
  const runtime = verifyRuntime();
  return Object.freeze({
    job,
    jobDigest: digest,
    sourceJob,
    baselineCommit: D2_COMMIT,
    deployedCommit: deploy.deployedCommit,
    collectorBlob: COLLECTOR_BLOB,
    referenceCollectorBlob: REFERENCE_COLLECTOR_BLOB,
    lockfileSha256: LOCKFILE_SHA256,
    sourceManifestDigest: SOURCE_MANIFEST_DIGEST,
    previousEvidence,
    runtime
  });
}

function stateRoot(env = process.env) {
  const configured = String(env.V2_RENDER_DIAGNOSTIC_STATE_DIR || "").trim();
  if (!configured || !path.isAbsolute(configured)) {
    fail("V2_RENDER_DIAGNOSTIC_STATE_INVALID", "an absolute diagnostic state directory is required");
  }
  const resolved = path.resolve(configured);
  if (env.RENDER_SERVICE_ID) {
    if (configured.replace(/\\/gu, "/") !== RENDER_STATE_ROOT) {
      fail("V2_RENDER_DIAGNOSTIC_STATE_INVALID", "Render diagnostic state must use the dedicated disk path");
    }
  } else {
    const relative = path.relative(LOCAL_STATE_ROOT, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      fail("V2_RENDER_DIAGNOSTIC_STATE_INVALID", "local diagnostic state must be an isolated child of the D3 output root");
    }
  }
  return resolved;
}

function assertReadinessGates(env = process.env) {
  const forbidden = [
    "V2_RENDER_DIAGNOSTIC_LIVE_APPROVED",
    "V2_RENDER_DIAGNOSTIC_APPROVED_JOB_SHA256",
    "V2_RENDER_DIAGNOSTIC_EXPECTED_ENVELOPE_SHA256"
  ];
  if (env.V2_RENDER_DIAGNOSTIC_RUN_ENABLED === "1" || forbidden.some((name) => String(env[name] || "").trim())) {
    fail("V2_RENDER_DIAGNOSTIC_READINESS_GATE_INVALID", "readiness mode must not contain live execution gates");
  }
  if (String(env.V2_RENDER_DIAGNOSTIC_REQUEST_BUDGET || "0") !== "0") {
    fail("V2_RENDER_DIAGNOSTIC_READINESS_GATE_INVALID", "readiness request budget must be zero");
  }
  for (const name of ["V2_RENDER_DIAGNOSTIC_AUTOMATIC_RETRY", "V2_RENDER_DIAGNOSTIC_FALLBACK", "V2_RENDER_DIAGNOSTIC_OPERATIONAL_WRITES"]) {
    if (String(env[name] || "0") !== "0") {
      fail("V2_RENDER_DIAGNOSTIC_READINESS_GATE_INVALID", "readiness safety gates must remain disabled");
    }
  }
}

function assertFixtureGates(env = process.env) {
  assertReadinessGates(env);
  if (env.V2_RENDER_DIAGNOSTIC_OFFLINE_APPROVED !== "1") {
    fail("V2_RENDER_DIAGNOSTIC_FIXTURE_NOT_APPROVED", "offline fixture execution is not approved");
  }
}

function assertLiveGates(env = process.env) {
  if (
    env.V2_RENDER_DIAGNOSTIC_RUN_ENABLED !== "1"
    || env.V2_RENDER_DIAGNOSTIC_LIVE_APPROVED !== LIVE_APPROVAL
    || env.V2_RENDER_DIAGNOSTIC_REQUEST_BUDGET !== "1"
    || env.V2_RENDER_DIAGNOSTIC_APPROVED_JOB_SHA256 !== RENDER_JOB_CANONICAL_SHA256
    || env.V2_RENDER_DIAGNOSTIC_EXPECTED_ENVELOPE_SHA256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
    || String(env.V2_RENDER_DIAGNOSTIC_AUTOMATIC_RETRY || "0") !== "0"
    || String(env.V2_RENDER_DIAGNOSTIC_FALLBACK || "0") !== "0"
    || String(env.V2_RENDER_DIAGNOSTIC_OPERATIONAL_WRITES || "0") !== "0"
  ) fail("V2_RENDER_DIAGNOSTIC_LIVE_NOT_APPROVED", "live diagnostic gates do not match the frozen one-shot contract");
}

function safeChildEnvironment(env, { sourceRoot, sourceJob, mode }) {
  const child = {};
  const retained = [
    "SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "TMPDIR", "HOME",
    "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ"
  ];
  for (const name of retained) if (env[name]) child[name] = env[name];
  Object.assign(child, {
    NODE_ENV: mode === "live" ? "production" : "test",
    NODE_OPTIONS: mode === "live" ? "" : `--require=${NETWORK_PRELOAD.replace(/\\/gu, "/")}`,
    V2_BOOKING_BUSINESS_SOURCE_ROOT: sourceRoot,
    V2_BOOKING_BUSINESS_PLACE_ID: sourceJob.placeId,
    V2_BOOKING_BUSINESS_CHECK_IN: sourceJob.checkIn,
    V2_BOOKING_BUSINESS_ADULTS: String(sourceJob.adults),
    V2_BOOKING_BUSINESS_TIMEOUT_MS: String(sourceJob.timeoutMs),
    V2_BOOKING_BUSINESS_RESPONSE_LIMIT_BYTES: String(sourceJob.responseSizeLimitBytes),
    V2_BOOKING_BUSINESS_TRANSPORT_MODE: mode,
    V2_BOOKING_BUSINESS_FIXTURE_SCENARIO: "success",
    V2_BOOKING_BUSINESS_REPLAY_FILE: "",
    V2_BOOKING_BUSINESS_LIVE_APPROVED: mode === "live" ? "N3-Copy-Only-Live" : "",
    V2_BOOKING_BUSINESS_APPROVED_JOB_SHA256: mode === "live" ? COPY_ONLY_APPROVED_JOB_SHA256 : "",
    V2_BOOKING_BUSINESS_EXPECTED_ENVELOPE_SHA256: mode === "live" ? COPY_ONLY_EXPECTED_ENVELOPE_SHA256 : "",
    V2_BOOKING_BUSINESS_NETWORK_DIAGNOSTICS: "1",
    NAVER_AUTOMATIC_RETRY: "0",
    NAVER_AUTOMATIC_FALLBACK: "0",
    NAVER_BOOKING_ID_FALLBACK: "0",
    NAVER_COUPON_PAGE_FALLBACK: "0"
  });
  return child;
}

async function materializeCopy(targetRoot) {
  const manifest = JSON.parse(await fs.readFile(SOURCE_MANIFEST_PATH, "utf8"));
  for (const entry of manifest.files) {
    const target = path.join(targetRoot, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(ROOT, entry.path), target);
    if (sha256(await fs.readFile(target)) !== entry.sha256) {
      fail("V2_RENDER_DIAGNOSTIC_COPY_MISMATCH", "source copy hash mismatch");
    }
  }
}

function spawnDiagnosticChild({ env, sourceRoot, sourceJob, mode }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD_PATH], {
      cwd: sourceRoot,
      env: safeChildEnvironment(env, { sourceRoot, sourceJob, mode }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderrBytes = 0;
    let timedOut = false;
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-500_000); });
    child.stderr.on("data", (chunk) => { stderrBytes += Buffer.byteLength(chunk); });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(sourceJob.timeoutMs + 5_000, 7_500));
    timer.unref?.();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderrBytes });
    });
  });
}

function parseChildResult(child) {
  const lines = String(child.stdout || "").trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) fail("V2_RENDER_DIAGNOSTIC_CHILD_INVALID", "child stdout framing is invalid");
  let result;
  try {
    result = JSON.parse(lines[0]);
  } catch {
    fail("V2_RENDER_DIAGNOSTIC_CHILD_INVALID", "child result JSON is invalid");
  }
  if (!result || typeof result !== "object" || child.exitCode !== 0 || child.signal || child.timedOut || child.stderrBytes !== 0) {
    fail("V2_RENDER_DIAGNOSTIC_CHILD_INVALID", "child process contract failed");
  }
  return result;
}

function safeNetworkProjection(value) {
  if (!value || value.schemaVersion !== "v2-booking-business-render-network-diagnostics.v1") {
    fail("V2_RENDER_DIAGNOSTIC_CHILD_AUDIT_INVALID", "network diagnostics are missing");
  }
  if (
    value.dnsAnswersStored !== false
    || value.hostNamesStored !== false
    || value.ipAddressesStored !== false
    || value.requestTargetsStored !== false
    || value.headerValuesStored !== false
    || value.requestBodiesStored !== false
    || value.responseBodiesStored !== false
    || value.certificatesStored !== false
    || !Array.isArray(value.events)
    || value.events.length > 24
  ) fail("V2_RENDER_DIAGNOSTIC_CHILD_AUDIT_INVALID", "network diagnostic privacy contract failed");
  const counts = Object.fromEntries([...NETWORK_EVENT_NAMES].sort().map((name) => [
    name,
    Number.isInteger(value.counts?.[name]) && value.counts[name] >= 0 ? value.counts[name] : 0
  ]));
  const events = value.events.map((entry) => {
    if (!NETWORK_EVENT_NAMES.has(entry?.name)) {
      fail("V2_RENDER_DIAGNOSTIC_CHILD_AUDIT_INVALID", "unknown network diagnostic event");
    }
    if (entry.name === "undici:request:create") {
      return {
        name: entry.name,
        method: String(entry.method || ""),
        protocol: String(entry.protocol || ""),
        contentLength: Number.isInteger(entry.contentLength) ? entry.contentLength : null,
        headerNames: Array.isArray(entry.headerNames) ? entry.headerNames.map(String).sort() : []
      };
    }
    if (entry.name === "undici:client:beforeConnect") {
      return { name: entry.name, protocol: String(entry.protocol || "") };
    }
    if (entry.name === "undici:client:connected") {
      return {
        name: entry.name,
        encrypted: Boolean(entry.encrypted),
        addressFamily: ["IPv4", "IPv6"].includes(entry.addressFamily) ? entry.addressFamily : null,
        alpnProtocol: typeof entry.alpnProtocol === "string" && entry.alpnProtocol ? entry.alpnProtocol : null,
        tlsProtocol: typeof entry.tlsProtocol === "string" && entry.tlsProtocol ? entry.tlsProtocol : null,
        cipherName: typeof entry.cipherName === "string" && entry.cipherName ? entry.cipherName : null,
        tlsAuthorized: typeof entry.tlsAuthorized === "boolean" ? entry.tlsAuthorized : null,
        connectionReused: typeof entry.connectionReused === "boolean" ? entry.connectionReused : null
      };
    }
    if (entry.name === "undici:request:headers") {
      return {
        name: entry.name,
        statusCode: Number.isInteger(entry.statusCode) ? entry.statusCode : null,
        responseHeaderNames: Array.isArray(entry.responseHeaderNames) ? entry.responseHeaderNames.map(String).sort() : []
      };
    }
    if (entry.name === "undici:request:error") {
      return { name: entry.name, failureClass: String(entry.failureClass || "network") };
    }
    return { name: entry.name };
  });
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    counts,
    events,
    truncated: value.truncated === true,
    dnsAnswersStored: false,
    hostNamesStored: false,
    ipAddressesStored: false,
    requestTargetsStored: false,
    headerValuesStored: false,
    requestBodiesStored: false,
    responseBodiesStored: false,
    certificatesStored: false
  });
}

function safeChildProjection(result, mode) {
  const expectedExternal = mode === "live" ? 1 : 0;
  const expectedFixture = mode === "fixture" ? 1 : 0;
  if (
    result.calls?.bookingBusiness !== 1
    || result.calls?.bookingItems !== 0
    || result.calls?.dailySchedule !== 0
    || result.calls?.total !== 1
    || result.calls?.actualExternal !== expectedExternal
    || result.calls?.fixture !== expectedFixture
    || result.retries !== 0
    || result.fallbacks !== 0
    || result.operationalWrites !== 0
    || result.htmlFallbackCalls !== 0
    || result.historicalFallbackReads !== 0
    || result.rawProviderResponseStored !== false
    || result.headersStored !== false
    || result.fullRequestUrlStored !== false
    || result.request?.fetchEnvelope?.envelopeSha256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
    || result.placeIdHash !== LIVE_PLACE_ID_HASH
  ) fail("V2_RENDER_DIAGNOSTIC_CHILD_AUDIT_INVALID", "child escaped the one-shot booking-business contract");
  return Object.freeze({
    status: result.status === "succeeded" ? "succeeded" : "failed",
    classification: String(result.classification || "failed"),
    placeIdHash: result.placeIdHash,
    bookingBusinessIdHash: result.bookingBusinessIdHash || null,
    bookingUrlPresent: result.bookingUrlPresent === true,
    providerConfirmedZero: result.providerConfirmedZero === true,
    providerStatus: Number.isInteger(result.providerStatus) ? result.providerStatus : null,
    responseDiagnostic: result.responseDiagnostic || null,
    error: result.error ? {
      code: String(result.error.code || "V2_BOOKING_BUSINESS_LOOKUP_FAILED"),
      retryable: false,
      providerFailureSubtype: result.error.providerFailureSubtype || null,
      providerHttpStatus: Number.isInteger(result.error.providerHttpStatus) ? result.error.providerHttpStatus : null,
      retryAfterSeconds: Number.isInteger(result.error.retryAfterSeconds) ? result.error.retryAfterSeconds : null
    } : null,
    runtime: result.runtime || null,
    sourceFunctionDigest: result.sourceFunctionDigest || null,
    querySha256: result.querySha256 || null,
    requestEnvelopeSha256: result.request.fetchEnvelope.envelopeSha256,
    networkDiagnostic: safeNetworkProjection(result.networkDiagnostic),
    calls: { ...result.calls },
    concurrency: result.concurrency,
    retries: 0,
    fallbacks: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false,
    rawIdentifiersStored: false,
    providerHeaderValuesStored: false,
    providerBodiesStored: false
  });
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, filePath);
}

async function claimRun(root, integrity, mode) {
  const runsRoot = path.join(root, "runs");
  const runRoot = path.join(runsRoot, RENDER_RUN_ID);
  await fs.mkdir(runsRoot, { recursive: true });
  try {
    await fs.mkdir(runRoot, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") return Object.freeze({ duplicate: true, runRoot });
    throw error;
  }
  await atomicJson(path.join(runRoot, "claim.json"), {
    schemaVersion: "v2-booking-business-render-diagnostic-claim.v1",
    runId: RENDER_RUN_ID,
    mode,
    jobCanonicalSha256: integrity.jobDigest,
    requestEnvelopeSha256: COPY_ONLY_EXPECTED_ENVELOPE_SHA256,
    collectorBlob: integrity.collectorBlob,
    requestBudget: 1,
    claimedAt: new Date().toISOString(),
    rawIdentifiersStored: false,
    providerValuesStored: false
  });
  return Object.freeze({ duplicate: false, runRoot });
}

async function runOneShot({ mode, env = process.env, childRunner = spawnDiagnosticChild } = {}) {
  if (!["fixture", "live"].includes(mode)) fail("V2_RENDER_DIAGNOSTIC_COMMAND_INVALID", "one-shot mode is invalid");
  const integrity = await verifyIntegrity(env);
  if (mode === "live") assertLiveGates(env); else assertFixtureGates(env);
  const root = stateRoot(env);
  const claim = await claimRun(root, integrity, mode);
  if (claim.duplicate) {
    return Object.freeze({
      schemaVersion: "v2-booking-business-render-diagnostic-result.v1",
      event: "render_diagnostic_duplicate_blocked",
      status: "duplicate-blocked",
      runId: RENDER_RUN_ID,
      externalRequests: 0,
      collectorInvocations: 0,
      automaticRetry: false,
      operationalWrites: 0
    });
  }
  try {
    const copiedRoot = path.join(claim.runRoot, "copied-source");
    await materializeCopy(copiedRoot);
    const child = await childRunner({ env, sourceRoot: copiedRoot, sourceJob: integrity.sourceJob, mode });
    const projection = safeChildProjection(parseChildResult(child), mode);
    const observation = Object.freeze({
      schemaVersion: "v2-booking-business-render-diagnostic-observation.v1",
      event: "render_diagnostic_terminal",
      status: "observed",
      runId: RENDER_RUN_ID,
      mode,
      integrity: {
        baselineCommit: integrity.baselineCommit,
        deployedCommit: integrity.deployedCommit,
        collectorBlob: integrity.collectorBlob,
        referenceCollectorBlob: integrity.referenceCollectorBlob,
        lockfileSha256: integrity.lockfileSha256,
        sourceManifestDigest: integrity.sourceManifestDigest,
        jobCanonicalSha256: integrity.jobDigest
      },
      runtimeFingerprint: runtimeFingerprint(env),
      result: projection,
      requestBudget: 1,
      externalRequests: projection.calls.actualExternal,
      collectorInvocations: 1,
      automaticRetry: false,
      fallbacks: 0,
      operationalWrites: 0,
      rawProviderResponsesStored: false,
      secretValuesStored: false
    });
    const terminal = Object.freeze({
      schemaVersion: "v2-booking-business-render-diagnostic-terminal.v1",
      observation,
      observationSha256: sha256(stableJson(observation))
    });
    await atomicJson(path.join(claim.runRoot, "terminal.json"), terminal);
    return terminal;
  } catch (error) {
    await atomicJson(path.join(claim.runRoot, "failure.json"), {
      schemaVersion: "v2-booking-business-render-diagnostic-failure.v1",
      runId: RENDER_RUN_ID,
      code: String(error?.code || "V2_RENDER_DIAGNOSTIC_FAILED"),
      retryable: false,
      automaticRetry: false,
      rawProviderResponsesStored: false,
      secretValuesStored: false
    }).catch(() => {});
    throw error;
  }
}

async function readiness(env = process.env) {
  assertReadinessGates(env);
  stateRoot(env);
  const integrity = await verifyIntegrity(env);
  return Object.freeze({
    schemaVersion: "v2-booking-business-render-diagnostic-readiness.v1",
    event: "render_diagnostic_ready",
    status: "ready",
    mode: "readiness-only",
    runEnabled: false,
    requestBudget: 0,
    externalRequests: 0,
    operationalWrites: 0,
    automaticRetry: false,
    fallback: false,
    baselineCommit: integrity.baselineCommit,
    deployedCommit: integrity.deployedCommit,
    collectorBlob: integrity.collectorBlob,
    lockfileSha256: integrity.lockfileSha256,
    jobCanonicalSha256: integrity.jobDigest
  });
}

function holdUntilSignal() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !["readiness", "serve", "fixture-once", "live-and-hold"].includes(argv[0])) {
    fail("V2_RENDER_DIAGNOSTIC_COMMAND_INVALID", "usage: readiness|serve|fixture-once|live-and-hold");
  }
  let result;
  if (["readiness", "serve"].includes(argv[0])) result = await readiness(process.env);
  else result = await runOneShot({ mode: argv[0] === "fixture-once" ? "fixture" : "live", env: process.env });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (["serve", "live-and-hold"].includes(argv[0])) await holdUntilSignal();
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "v2-booking-business-render-diagnostic-error.v1",
      status: "failed",
      code: String(error?.code || "V2_RENDER_DIAGNOSTIC_FAILED"),
      retryable: false,
      externalRequestsAfterRestart: 0
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  D2_COMMIT,
  JOB_PATH,
  LIVE_APPROVAL,
  REFERENCE_COLLECTOR_BLOB,
  RENDER_JOB_CANONICAL_SHA256,
  RENDER_JOB_SCHEMA_VERSION,
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
  stateRoot,
  verifyPreviousEvidence,
  verifyRenderDeployIdentity,
  verifySourceManifest,
  verifyIntegrity
};
