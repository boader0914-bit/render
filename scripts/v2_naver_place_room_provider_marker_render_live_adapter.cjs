"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  JOB_CANONICAL_SHA256,
  JOB_RUN_ID,
  RENDER_STATE_ROOT,
  gitBlobSha,
  holdUntilSignal,
  readFreshJob,
  verifyIntegrity
} = require("./v2_naver_place_room_provider_marker_render_readiness.cjs");
const {
  LIVE_APPROVAL_NAME: INNER_LIVE_APPROVAL_NAME,
  REQUEST_ORIGIN,
  runRoomProviderMarkerLiveOneShot,
  serializeTerminalError
} = require("./v2_naver_place_room_provider_marker_live_one_shot.cjs");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_COMMIT = "b4a20ddcbe60f7159242fece7ffd791aa62f57be";
const D4_READINESS_BLOB = "ca99bbceede09da2d7ea138fe13ae6c8afc53a60";
const D4_READINESS_PATH = path.join(ROOT, "scripts", "v2_naver_place_room_provider_marker_render_readiness.cjs");
const LOCAL_STATE_ROOT = path.join(ROOT, "outputs", "rebuild-n5-d5");
const LIVE_APPROVAL_NAME = "N5-D5-Live";
const RESULT_SCHEMA_VERSION = "v2-naver-room-provider-marker-render-live-result.v1";
const REPLAY_SCHEMA_VERSION = "v2-naver-room-provider-marker-render-live-replay.v1";
const ERROR_SCHEMA_VERSION = "v2-naver-room-provider-marker-render-live-error.v1";
const TERMINAL_RECORD_SCHEMA_VERSION = "v2-naver-room-provider-marker-render-terminal-record.v1";
const TERMINAL_SCHEMA_VERSION = "v2-naver-room-provider-marker-render-terminal.v1";
const SUCCESS_SCHEMA_VERSION = "v2-naver-room-provider-marker-render-success.v1";
const FAILURE_SCHEMA_VERSION = "v2-naver-room-provider-marker-render-failure.v1";
const TERMINAL_EVENT = "n5_room_provider_marker_render_terminal";
const DUPLICATE_EVENT = "n5_room_provider_marker_render_duplicate_replay";
const LIVE_GATE_NAMES = Object.freeze([
  "V2_N5_RENDER_LIVE_APPROVED",
  "V2_N5_RENDER_APPROVED_JOB_SHA256"
]);
const INNER_GATE_NAMES = Object.freeze([
  "V2_NAVER_ROOM_MARKER_LIVE_APPROVED",
  "V2_NAVER_ROOM_MARKER_REQUEST_BUDGET",
  "V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256"
]);
const SAFE_PROVIDER_ERROR_CODES = new Set([
  "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED",
  "V2_NAVER_ROOM_MARKER_AMBIGUOUS",
  "V2_NAVER_ROOM_MARKER_CONTENT_TYPE_INVALID",
  "V2_NAVER_ROOM_MARKER_DOM_AMBIGUOUS",
  "V2_NAVER_ROOM_MARKER_HTML_INVALID",
  "V2_NAVER_ROOM_MARKER_HTTP_ERROR",
  "V2_NAVER_ROOM_MARKER_INPUT_INVALID",
  "V2_NAVER_ROOM_MARKER_LIVE_FAILED",
  "V2_NAVER_ROOM_MARKER_REDIRECTED",
  "V2_NAVER_ROOM_MARKER_REQUEST_BUDGET_EXCEEDED",
  "V2_NAVER_ROOM_MARKER_RESPONSE_INVALID",
  "V2_NAVER_ROOM_MARKER_RESPONSE_MISMATCH",
  "V2_NAVER_ROOM_MARKER_RESPONSE_TOO_LARGE",
  "V2_NAVER_ROOM_HEADING_INVALID",
  "V2_NAVER_ROOM_PROVIDER_MARKER_INVALID",
  "V2_NAVER_ROOM_MARKER_SELECTOR_MISMATCH",
  "V2_NAVER_ROOM_MARKER_TIMEOUT"
]);
const SAFE_ADAPTER_ERROR_CODES = new Set([
  "V2_N5_RENDER_COMMAND_INVALID",
  "V2_N5_RENDER_DEPLOY_COMMIT_MISMATCH",
  "V2_N5_RENDER_INTEGRITY_MISMATCH",
  "V2_N5_RENDER_JOB_INVALID",
  "V2_N5_RENDER_LIVE_GATE_INVALID",
  "V2_N5_RENDER_RESULT_UNCERTAIN",
  "V2_N5_RENDER_STATE_INVALID",
  "V2_N5_RENDER_STORAGE_FAILED",
  "V2_N5_RENDER_TERMINAL_INVALID"
]);
const SAFE_ERROR_STAGES = new Set([
  "adapter",
  "claim-commit",
  "command",
  "duplicate-replay",
  "integrity",
  "job",
  "live-gate",
  "projection",
  "state",
  "state-initialize",
  "terminal-commit",
  "terminal-precondition"
]);

class V2N5RenderLiveAdapterError extends Error {
  constructor(code, message, evidence = {}) {
    super(message);
    this.name = "V2N5RenderLiveAdapterError";
    this.code = code;
    this.retryable = false;
    this.stage = String(evidence.stage || "adapter");
    this.externalRequestAttempts = evidence.externalRequestAttempts === 1 ? 1 : 0;
    this.collectorInvocations = evidence.collectorInvocations === 1 ? 1 : 0;
    this.diagnosticStateWrites = Number.isInteger(evidence.diagnosticStateWrites)
      ? Math.max(0, Math.min(2, evidence.diagnosticStateWrites))
      : 0;
  }
}

function fail(code, message, evidence = {}) {
  throw new V2N5RenderLiveAdapterError(code, message, evidence);
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8")).digest("hex");
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeText(value, maximum) {
  const text = String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return text.slice(0, maximum);
}

function safeInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function assertLiveGates(env = process.env) {
  if (
    String(env.V2_N5_RENDER_RUN_ENABLED || "") !== "1"
    || String(env.V2_N5_RENDER_REQUEST_BUDGET || "") !== "1"
    || String(env.V2_N5_RENDER_AUTOMATIC_RETRY || "") !== "0"
    || String(env.V2_N5_RENDER_FALLBACK || "") !== "0"
    || String(env.V2_N5_RENDER_OPERATIONAL_WRITES || "") !== "0"
    || String(env.V2_N5_RENDER_LIVE_APPROVED || "") !== LIVE_APPROVAL_NAME
    || String(env.V2_N5_RENDER_APPROVED_JOB_SHA256 || "") !== JOB_CANONICAL_SHA256
  ) fail("V2_N5_RENDER_LIVE_GATE_INVALID", "The exact N5-D5 live approval gates are required", { stage: "live-gate" });
  if (INNER_GATE_NAMES.some((name) => String(env[name] || "").trim())) {
    fail("V2_N5_RENDER_LIVE_GATE_INVALID", "Direct collector live gates must not be supplied", { stage: "live-gate" });
  }
  return true;
}

function liveStateRoot(env = process.env) {
  const configured = String(env.V2_N5_RENDER_STATE_DIR || "").trim();
  if (!configured || !path.isAbsolute(configured)) {
    fail("V2_N5_RENDER_STATE_INVALID", "An absolute isolated state path is required", { stage: "state" });
  }
  if (String(env.RENDER_SERVICE_ID || "").trim()) {
    if (configured.replace(/\\/gu, "/") !== RENDER_STATE_ROOT) {
      fail("V2_N5_RENDER_STATE_INVALID", "Render state must use the dedicated N5 disk", { stage: "state" });
    }
    return RENDER_STATE_ROOT;
  }
  const root = path.resolve(LOCAL_STATE_ROOT);
  const resolved = path.resolve(configured);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("V2_N5_RENDER_STATE_INVALID", "Local state must be an isolated child of the N5-D5 output root", { stage: "state" });
  }
  return resolved;
}

async function verifyD4ReadinessIdentity(fsApi = fs) {
  let bytes;
  try {
    bytes = await fsApi.readFile(D4_READINESS_PATH);
  } catch {
    fail("V2_N5_RENDER_INTEGRITY_MISMATCH", "The D4 readiness source is unavailable", { stage: "integrity" });
  }
  if (gitBlobSha(bytes) !== D4_READINESS_BLOB) {
    fail("V2_N5_RENDER_INTEGRITY_MISMATCH", "The D4 readiness source identity changed", { stage: "integrity" });
  }
  return D4_READINESS_BLOB;
}

async function verifyLiveIntegrity(env = process.env, options = {}) {
  const integrityVerifier = options.integrityVerifier || verifyIntegrity;
  const [baseline, readinessBlob] = await Promise.all([
    integrityVerifier(env),
    verifyD4ReadinessIdentity(options.fsApi || fs)
  ]);
  return Object.freeze({
    ...baseline,
    liveAdapterBaselineCommit: BASELINE_COMMIT,
    d4ReadinessBlob: readinessBlob
  });
}

function innerLiveEnvironment(job) {
  return Object.freeze({
    V2_NAVER_ROOM_MARKER_LIVE_APPROVED: INNER_LIVE_APPROVAL_NAME,
    V2_NAVER_ROOM_MARKER_REQUEST_BUDGET: "1",
    V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256: JOB_CANONICAL_SHA256
  });
}

function statePaths(root) {
  const claimsRoot = path.join(root, "claims");
  const terminalsRoot = path.join(root, "terminals");
  return Object.freeze({
    claimsRoot,
    terminalsRoot,
    claimPath: path.join(claimsRoot, `${JOB_CANONICAL_SHA256}.json`),
    terminalPath: path.join(terminalsRoot, `${JOB_CANONICAL_SHA256}.json`)
  });
}

async function initializeState(root, fsApi = fs) {
  const paths = statePaths(root);
  try {
    await fsApi.mkdir(paths.claimsRoot, { recursive: true });
    await fsApi.mkdir(paths.terminalsRoot, { recursive: true });
  } catch {
    fail("V2_N5_RENDER_STORAGE_FAILED", "Diagnostic state directories could not be initialized", { stage: "state-initialize" });
  }
  return paths;
}

async function writeExclusiveJson(filePath, value, fsApi = fs) {
  let handle;
  try {
    handle = await fsApi.open(filePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
    if (typeof handle.sync === "function") await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
}

async function atomicJson(filePath, value, fsApi = fs) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await fsApi.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
    if (typeof handle.sync === "function") await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  await fsApi.rename(temporary, filePath);
}

async function acquireClaim(paths, integrity, nowFn = () => new Date(), fsApi = fs) {
  const claim = Object.freeze({
    schemaVersion: "v2-naver-room-provider-marker-render-claim.v1",
    runId: JOB_RUN_ID,
    jobCanonicalSha256: JOB_CANONICAL_SHA256,
    requestMethod: "GET",
    requestOrigin: REQUEST_ORIGIN,
    requestPath: "/accommodation/35644668/home",
    requestBudget: 1,
    claimedAt: nowFn().toISOString(),
    operationalWrites: 0,
    rawProviderResponseStored: false,
    secretValuesStored: false,
    liveAdapterBaselineCommit: BASELINE_COMMIT,
    frozenCollectorBlob: integrity.frozenCollectorBlob,
    runnerBlob: integrity.runnerBlob,
    contractBlob: integrity.contractBlob,
    packageLockSha256: integrity.packageLockSha256,
    deployedCommit: integrity.deployedCommit
  });
  try {
    await writeExclusiveJson(paths.claimPath, claim, fsApi);
    return Object.freeze({ duplicate: false, claim });
  } catch (error) {
    if (error?.code === "EEXIST") return Object.freeze({ duplicate: true, claim: null });
    fail("V2_N5_RENDER_RESULT_UNCERTAIN", "The durable claim could not be committed", {
      stage: "claim-commit",
      diagnosticStateWrites: 0
    });
  }
}

async function assertTerminalAbsent(paths, fsApi = fs) {
  try {
    await fsApi.stat(paths.terminalPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    fail("V2_N5_RENDER_RESULT_UNCERTAIN", "The terminal precondition could not be verified", {
      stage: "terminal-precondition",
      diagnosticStateWrites: 1
    });
  }
  fail("V2_N5_RENDER_RESULT_UNCERTAIN", "A terminal exists without the pre-existing durable claim", {
    stage: "terminal-precondition",
    diagnosticStateWrites: 1
  });
}

function safeProviderMarker(marker) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    fail("V2_N5_RENDER_TERMINAL_INVALID", "Provider marker projection is invalid", { stage: "projection" });
  }
  const mappingStatus = String(marker.mappingStatus || "");
  const standardChannelId = marker.standardChannelId === null ? null : safeText(marker.standardChannelId, 40);
  const standardChannelName = marker.standardChannelName === null ? null : safeText(marker.standardChannelName, 40);
  if (
    typeof marker.observed !== "boolean"
    || !new Set(["mapped", "unmapped", "absent"]).has(mappingStatus)
    || (standardChannelId !== null && !/^[a-z0-9-]{1,40}$/u.test(standardChannelId))
    || (standardChannelName !== null && !standardChannelName)
  ) fail("V2_N5_RENDER_TERMINAL_INVALID", "Provider marker projection is unsafe", { stage: "projection" });
  return Object.freeze({
    observed: marker.observed,
    displayText: safeText(marker.displayText, 80),
    standardChannelId,
    standardChannelName,
    mappingStatus
  });
}

function safeSuccessProjection(result) {
  const responseStatus = safeInteger(result?.response?.status, 200, 299);
  const responseBytes = safeInteger(result?.response?.responseBytes, 0, 1048576);
  const roomCount = safeInteger(result?.observation?.roomCount, 1, 1000);
  const duplicateObservationCount = safeInteger(result?.observation?.evidence?.duplicateObservationCount, 1, 10);
  const contentTypeClass = String(result?.response?.contentTypeClass || "");
  const evidenceLevel = String(result?.observation?.evidence?.level || "");
  const evidenceType = String(result?.observation?.evidence?.type || "");
  const captureKind = String(result?.observation?.evidence?.captureKind || "");
  if (
    result?.runId !== JOB_RUN_ID
    || result?.mode !== "live"
    || result?.placeId !== "35644668"
    || result?.jobDigestSha256 !== JOB_CANONICAL_SHA256
    || result?.request?.method !== "GET"
    || result?.request?.origin !== REQUEST_ORIGIN
    || result?.request?.path !== "/accommodation/35644668/home"
    || result?.request?.selectorVersion !== "naver-place-room-header.v1"
    || responseStatus === null
    || responseBytes === null
    || !new Set(["html", "xhtml"]).has(contentTypeClass)
    || result?.response?.parseStatus !== "parsed"
    || roomCount === null
    || !new Set(["high", "medium"]).has(evidenceLevel)
    || !new Set([
      "explicit_room_header_provider_marker",
      "explicit_unmapped_room_header_provider_marker",
      "explicit_room_header_count_only"
    ]).has(evidenceType)
    || captureKind !== "sanitized_live_html_projection"
    || duplicateObservationCount === null
    || result?.audit?.requestBudget !== 1
    || result?.audit?.requestAttempts !== 1
    || result?.audit?.fixtureRequests !== 0
    || result?.audit?.actualExternalRequests !== 1
    || result?.audit?.automaticRetries !== 0
    || result?.audit?.automaticFallbacks !== 0
    || result?.audit?.operationalWrites !== 0
    || result?.audit?.rawProviderResponseStored !== false
  ) fail("V2_N5_RENDER_TERMINAL_INVALID", "Collector result escaped the approved live contract", { stage: "projection" });
  return Object.freeze({
    schemaVersion: SUCCESS_SCHEMA_VERSION,
    placeId: "35644668",
    request: Object.freeze({
      method: "GET",
      origin: REQUEST_ORIGIN,
      path: "/accommodation/35644668/home",
      selectorVersion: "naver-place-room-header.v1"
    }),
    response: Object.freeze({
      statusClass: "2xx",
      contentTypeClass,
      responseBytes,
      parseStatus: "parsed"
    }),
    roomCount,
    providerMarker: safeProviderMarker(result.observation.providerMarker),
    evidence: Object.freeze({
      level: evidenceLevel,
      type: evidenceType,
      source: "naver_place_room_section_header",
      captureKind,
      duplicateObservationCount
    })
  });
}

function safeFailureProjection(error) {
  const serialized = serializeTerminalError(error);
  const code = SAFE_PROVIDER_ERROR_CODES.has(serialized.code)
    ? serialized.code
    : "V2_NAVER_ROOM_MARKER_LIVE_FAILED";
  return Object.freeze({
    schemaVersion: FAILURE_SCHEMA_VERSION,
    code,
    retryable: false,
    diagnostic: code === "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED" && serialized.diagnostic
      ? serialized.diagnostic
      : null
  });
}

function terminalRecord({ status, result = null, error = null }) {
  const terminal = Object.freeze({
    schemaVersion: TERMINAL_SCHEMA_VERSION,
    event: TERMINAL_EVENT,
    status,
    runId: JOB_RUN_ID,
    mode: "live",
    jobCanonicalSha256: JOB_CANONICAL_SHA256,
    result,
    error,
    externalRequestAttempts: 1,
    collectorInvocations: 1,
    automaticRetry: false,
    fallbacks: 0,
    operationalWrites: 0,
    diagnosticStateWrites: 2,
    rawProviderResponseStored: false,
    secretValuesStored: false
  });
  return Object.freeze({
    schemaVersion: TERMINAL_RECORD_SCHEMA_VERSION,
    runId: JOB_RUN_ID,
    jobCanonicalSha256: JOB_CANONICAL_SHA256,
    terminal,
    terminalSha256: sha256(stableJson(terminal))
  });
}

function validateSuccessProjection(value) {
  if (!exactKeys(value, [
    "schemaVersion", "placeId", "request", "response", "roomCount", "providerMarker", "evidence"
  ])) return false;
  if (
    value.schemaVersion !== SUCCESS_SCHEMA_VERSION
    || value.placeId !== "35644668"
    || safeInteger(value.roomCount, 1, 1000) === null
    || !exactKeys(value.request, ["method", "origin", "path", "selectorVersion"])
    || value.request.method !== "GET"
    || value.request.origin !== REQUEST_ORIGIN
    || value.request.path !== "/accommodation/35644668/home"
    || value.request.selectorVersion !== "naver-place-room-header.v1"
    || !exactKeys(value.response, ["statusClass", "contentTypeClass", "responseBytes", "parseStatus"])
    || value.response.statusClass !== "2xx"
    || !new Set(["html", "xhtml"]).has(value.response.contentTypeClass)
    || safeInteger(value.response.responseBytes, 0, 1048576) === null
    || value.response.parseStatus !== "parsed"
    || !exactKeys(value.providerMarker, ["observed", "displayText", "standardChannelId", "standardChannelName", "mappingStatus"])
    || typeof value.providerMarker.observed !== "boolean"
    || typeof value.providerMarker.displayText !== "string"
    || value.providerMarker.displayText.length > 80
    || !new Set(["mapped", "unmapped", "absent"]).has(value.providerMarker.mappingStatus)
    || !exactKeys(value.evidence, ["level", "type", "source", "captureKind", "duplicateObservationCount"])
    || !new Set(["high", "medium"]).has(value.evidence.level)
    || !new Set([
      "explicit_room_header_provider_marker",
      "explicit_unmapped_room_header_provider_marker",
      "explicit_room_header_count_only"
    ]).has(value.evidence.type)
    || value.evidence.source !== "naver_place_room_section_header"
    || value.evidence.captureKind !== "sanitized_live_html_projection"
    || safeInteger(value.evidence.duplicateObservationCount, 1, 10) === null
  ) return false;
  return true;
}

function validateFailureProjection(value) {
  if (!exactKeys(value, ["schemaVersion", "code", "retryable", "diagnostic"])) return false;
  if (
    value.schemaVersion !== FAILURE_SCHEMA_VERSION
    || !SAFE_PROVIDER_ERROR_CODES.has(value.code)
    || value.retryable !== false
  ) return false;
  if (value.diagnostic === null) return true;
  const sanitized = serializeTerminalError({ code: value.code, diagnostic: value.diagnostic });
  return value.code === "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED"
    && sanitized.diagnostic
    && stableJson(sanitized.diagnostic) === stableJson(value.diagnostic);
}

function validateTerminalRecord(value) {
  if (!exactKeys(value, ["schemaVersion", "runId", "jobCanonicalSha256", "terminal", "terminalSha256"])) return false;
  const terminal = value.terminal;
  if (
    value.schemaVersion !== TERMINAL_RECORD_SCHEMA_VERSION
    || value.runId !== JOB_RUN_ID
    || value.jobCanonicalSha256 !== JOB_CANONICAL_SHA256
    || !/^[a-f0-9]{64}$/u.test(String(value.terminalSha256 || ""))
    || !exactKeys(terminal, [
      "schemaVersion", "event", "status", "runId", "mode", "jobCanonicalSha256", "result", "error",
      "externalRequestAttempts", "collectorInvocations", "automaticRetry", "fallbacks", "operationalWrites",
      "diagnosticStateWrites", "rawProviderResponseStored", "secretValuesStored"
    ])
    || terminal.schemaVersion !== TERMINAL_SCHEMA_VERSION
    || terminal.event !== TERMINAL_EVENT
    || !new Set(["succeeded", "failed"]).has(terminal.status)
    || terminal.runId !== JOB_RUN_ID
    || terminal.mode !== "live"
    || terminal.jobCanonicalSha256 !== JOB_CANONICAL_SHA256
    || terminal.externalRequestAttempts !== 1
    || terminal.collectorInvocations !== 1
    || terminal.automaticRetry !== false
    || terminal.fallbacks !== 0
    || terminal.operationalWrites !== 0
    || terminal.diagnosticStateWrites !== 2
    || terminal.rawProviderResponseStored !== false
    || terminal.secretValuesStored !== false
    || value.terminalSha256 !== sha256(stableJson(terminal))
  ) return false;
  if (terminal.status === "succeeded") return terminal.error === null && validateSuccessProjection(terminal.result);
  return terminal.result === null && validateFailureProjection(terminal.error);
}

async function readTerminal(paths, fsApi = fs) {
  let parsed;
  try {
    parsed = JSON.parse(await fsApi.readFile(paths.terminalPath, "utf8"));
  } catch {
    fail("V2_N5_RENDER_RESULT_UNCERTAIN", "A claim exists without a readable terminal", {
      stage: "duplicate-replay",
      diagnosticStateWrites: 1
    });
  }
  if (!validateTerminalRecord(parsed)) {
    fail("V2_N5_RENDER_TERMINAL_INVALID", "The persisted terminal failed validation", {
      stage: "duplicate-replay",
      diagnosticStateWrites: 1
    });
  }
  return Object.freeze(parsed);
}

function committedProjection(record) {
  return Object.freeze({
    schemaVersion: RESULT_SCHEMA_VERSION,
    event: "n5_room_provider_marker_render_terminal_committed",
    status: "terminal-committed",
    runId: JOB_RUN_ID,
    jobCanonicalSha256: JOB_CANONICAL_SHA256,
    terminalStatus: record.terminal.status,
    terminalSha256: record.terminalSha256,
    terminal: record.terminal,
    currentInvocation: Object.freeze({
      externalRequestAttempts: 1,
      collectorInvocations: 1,
      diagnosticStateWrites: 2,
      operationalWrites: 0
    })
  });
}

function replayProjection(record) {
  return Object.freeze({
    schemaVersion: REPLAY_SCHEMA_VERSION,
    event: DUPLICATE_EVENT,
    status: "duplicate-replayed",
    runId: JOB_RUN_ID,
    jobCanonicalSha256: JOB_CANONICAL_SHA256,
    terminalStatus: record.terminal.status,
    terminalSha256: record.terminalSha256,
    terminal: record.terminal,
    currentInvocation: Object.freeze({
      externalRequestAttempts: 0,
      collectorInvocations: 0,
      diagnosticStateWrites: 0,
      operationalWrites: 0
    })
  });
}

async function runLiveOnce(options = {}) {
  const env = options.env || process.env;
  assertLiveGates(env);
  const root = liveStateRoot(env);
  const integrity = await verifyLiveIntegrity(env, options);
  const jobIdentity = await (options.jobReader || readFreshJob)();
  if (jobIdentity.digest !== JOB_CANONICAL_SHA256 || jobIdentity.job.runId !== JOB_RUN_ID) {
    fail("V2_N5_RENDER_JOB_INVALID", "The fresh live job identity changed", { stage: "job" });
  }
  const fsApi = options.fsApi || fs;
  const paths = await initializeState(root, fsApi);
  const claim = await acquireClaim(paths, integrity, options.nowFn, fsApi);
  if (claim.duplicate) return replayProjection(await readTerminal(paths, fsApi));
  await assertTerminalAbsent(paths, fsApi);

  let record;
  try {
    const runner = options.runner || runRoomProviderMarkerLiveOneShot;
    const result = await runner(jobIdentity.job, {
      environment: innerLiveEnvironment(jobIdentity.job),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    record = terminalRecord({ status: "succeeded", result: safeSuccessProjection(result), error: null });
  } catch (error) {
    record = terminalRecord({ status: "failed", result: null, error: safeFailureProjection(error) });
  }

  try {
    const writer = options.terminalWriter || atomicJson;
    await writer(paths.terminalPath, record, fsApi);
  } catch {
    fail("V2_N5_RENDER_RESULT_UNCERTAIN", "The terminal could not be committed after the one-shot attempt", {
      stage: "terminal-commit",
      externalRequestAttempts: 1,
      collectorInvocations: 1,
      diagnosticStateWrites: 1
    });
  }
  return committedProjection(record);
}

function safeErrorProjection(error) {
  const code = SAFE_ADAPTER_ERROR_CODES.has(error?.code)
    ? error.code
    : "V2_N5_RENDER_STORAGE_FAILED";
  const stage = SAFE_ERROR_STAGES.has(error?.stage) ? error.stage : "adapter";
  return Object.freeze({
    schemaVersion: ERROR_SCHEMA_VERSION,
    event: code === "V2_N5_RENDER_RESULT_UNCERTAIN"
      ? "n5_room_provider_marker_render_result_uncertain"
      : "n5_room_provider_marker_render_live_blocked",
    status: code === "V2_N5_RENDER_RESULT_UNCERTAIN" ? "result-uncertain" : "blocked",
    code,
    stage,
    retryable: false,
    externalRequestAttempts: error?.externalRequestAttempts === 1 ? 1 : 0,
    collectorInvocations: error?.collectorInvocations === 1 ? 1 : 0,
    diagnosticStateWrites: safeInteger(error?.diagnosticStateWrites, 0, 2) ?? 0,
    automaticRetry: false,
    fallbacks: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false,
    secretValuesStored: false
  });
}

async function main(argv = process.argv.slice(2), options = {}) {
  if (argv.length !== 1 || argv[0] !== "live-and-hold") {
    fail("V2_N5_RENDER_COMMAND_INVALID", "usage: live-and-hold", { stage: "command" });
  }
  let output;
  try {
    output = await (options.runLiveOnceFn || runLiveOnce)(options);
  } catch (error) {
    output = safeErrorProjection(error);
  }
  const writeOutput = options.writeOutput || ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  writeOutput(output);
  await (options.holdFn || holdUntilSignal)(options.holdOptions);
  return output;
}

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(safeErrorProjection(error))}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BASELINE_COMMIT,
  D4_READINESS_BLOB,
  D4_READINESS_PATH,
  DUPLICATE_EVENT,
  ERROR_SCHEMA_VERSION,
  FAILURE_SCHEMA_VERSION,
  INNER_GATE_NAMES,
  LIVE_APPROVAL_NAME,
  LIVE_GATE_NAMES,
  LOCAL_STATE_ROOT,
  REPLAY_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  SAFE_PROVIDER_ERROR_CODES,
  SAFE_ERROR_STAGES,
  SUCCESS_SCHEMA_VERSION,
  TERMINAL_EVENT,
  TERMINAL_RECORD_SCHEMA_VERSION,
  TERMINAL_SCHEMA_VERSION,
  V2N5RenderLiveAdapterError,
  acquireClaim,
  assertTerminalAbsent,
  assertLiveGates,
  atomicJson,
  committedProjection,
  innerLiveEnvironment,
  liveStateRoot,
  main,
  readTerminal,
  replayProjection,
  runLiveOnce,
  safeErrorProjection,
  safeFailureProjection,
  safeSuccessProjection,
  sha256,
  stableJson,
  statePaths,
  terminalRecord,
  validateTerminalRecord,
  verifyD4ReadinessIdentity,
  verifyLiveIntegrity,
  writeExclusiveJson
};
