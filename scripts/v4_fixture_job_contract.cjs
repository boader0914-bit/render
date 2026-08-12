const crypto = require("node:crypto");
const {
  EXPECTED_COLLECTOR_BLOB,
  JOB_SCHEMA,
  normalizeJob
} = require("./v4_worker_once.cjs");

const CONTRACT_BASELINE_COMMIT = "7f6aba22cd5819fedf3f53c480fec92dfe8b56c2";
const SIGNED_JOB_SCHEMA = "datalab-v4-fixture-signed-job.v1";
const RESULT_SCHEMA = "datalab-v4-fixture-result.v1";
const SIGNATURE_VERSION = "hmac-sha256-v1";
const PURPOSE = "parity_fixture";
const FIXTURE_JOB_POLICY = Object.freeze({
  keyword: "Gyeongnam glamping offline parity fixture",
  searchMode: "keyword",
  productMode: "all",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  detailRankRanges: "1-10",
  bookingRangeDays: 7,
  bookingRangePlaceLimit: 10
});
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 30 * 1000;
const FIXTURE_SCENARIOS = new Set([
  "success",
  "empty",
  "duplicate",
  "missing-field",
  "booking",
  "provider-error",
  "timeout"
]);
const SIGNED_JOB_FIELDS = new Set([
  "schemaVersion",
  "jobId",
  "idempotencyKey",
  "nonce",
  "issuedAt",
  "expiresAt",
  "purpose",
  "scenario",
  "requestedCommit",
  "collectorBlob",
  "payloadDigest",
  "keyId",
  "signatureVersion",
  "job",
  "signature"
]);
const RESULT_FIELDS = new Set([
  "schemaVersion",
  "jobId",
  "idempotencyKey",
  "attemptId",
  "status",
  "stage",
  "code",
  "matched",
  "actualExternalRequests",
  "operationalWrites",
  "collectorInvocations",
  "exitCode",
  "artifactManifestDigest",
  "startedAt",
  "completedAt",
  "retryable",
  "scenario"
]);

class ContractError extends Error {
  constructor(code, stage, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.stage = stage;
    this.retryable = false;
  }
}

function stableJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ContractError("FIXTURE_CANONICAL_VALUE_INVALID", "contract", "Canonical JSON requires plain objects.");
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ContractError("FIXTURE_CANONICAL_VALUE_INVALID", "contract", "Canonical JSON rejects non-finite numbers.");
  }
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw new ContractError("FIXTURE_CANONICAL_VALUE_INVALID", "contract", "Canonical JSON contains an unsupported value.");
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeIdentifier(value, field, minLength = 1, maxLength = 120) {
  const text = String(value || "").trim();
  if (text.length < minLength || text.length > maxLength || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(text)) {
    throw new ContractError("FIXTURE_IDENTIFIER_INVALID", "contract", `${field} is invalid.`);
  }
  return text;
}

function isoTimestamp(value, field) {
  const text = String(value || "").trim();
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new ContractError("FIXTURE_TIMESTAMP_INVALID", "contract", `${field} must be an exact ISO timestamp.`);
  }
  return { text, milliseconds: parsed };
}

function secretBytes(secret) {
  const bytes = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(String(secret || ""), "utf8");
  if (bytes.length < 32) {
    throw new ContractError("FIXTURE_SIGNING_KEY_INVALID", "signature", "Signing key must contain at least 32 bytes.");
  }
  return bytes;
}

function signaturePayload(envelope) {
  const unsigned = {};
  for (const field of SIGNED_JOB_FIELDS) {
    if (field !== "signature") unsigned[field] = envelope[field];
  }
  return stableJson(unsigned);
}

function computeSignature(envelope, secret) {
  return crypto.createHmac("sha256", secretBytes(secret)).update(signaturePayload(envelope)).digest("hex");
}

function normalizeUnsignedJob(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractError("FIXTURE_JOB_ENVELOPE_INVALID", "contract", "Signed job envelope must be an object.");
  }
  const unknown = Object.keys(input).filter((key) => !SIGNED_JOB_FIELDS.has(key));
  if (unknown.length) {
    throw new ContractError("FIXTURE_JOB_ENVELOPE_INVALID", "contract", `Unknown signed job field: ${unknown.sort()[0]}`);
  }
  if (input.schemaVersion !== SIGNED_JOB_SCHEMA) {
    throw new ContractError("FIXTURE_JOB_SCHEMA_INVALID", "contract", `schemaVersion must be ${SIGNED_JOB_SCHEMA}.`);
  }
  if (input.signatureVersion !== SIGNATURE_VERSION) {
    throw new ContractError("FIXTURE_SIGNATURE_VERSION_INVALID", "signature", "signatureVersion is not supported.");
  }
  if (input.purpose !== PURPOSE) {
    throw new ContractError("FIXTURE_PURPOSE_FORBIDDEN", "contract", "Only parity_fixture jobs are accepted.");
  }
  const scenario = String(input.scenario || "");
  if (!FIXTURE_SCENARIOS.has(scenario)) {
    throw new ContractError("FIXTURE_SCENARIO_FORBIDDEN", "contract", "scenario is not in the fixture allowlist.");
  }
  if (input.requestedCommit !== CONTRACT_BASELINE_COMMIT) {
    throw new ContractError("FIXTURE_COMMIT_MISMATCH", "baseline", "requestedCommit does not match the approved contract baseline.");
  }
  if (input.collectorBlob !== EXPECTED_COLLECTOR_BLOB) {
    throw new ContractError("FIXTURE_COLLECTOR_BLOB_MISMATCH", "baseline", "collectorBlob does not match the frozen collector.");
  }

  const job = normalizeJob(input.job);
  const jobId = safeIdentifier(input.jobId, "jobId");
  const idempotencyKey = safeIdentifier(input.idempotencyKey, "idempotencyKey");
  if (job.jobId !== jobId || job.idempotencyKey !== idempotencyKey) {
    throw new ContractError("FIXTURE_JOB_IDENTITY_MISMATCH", "contract", "Envelope and worker job identities differ.");
  }
  const payloadDigest = sha256(stableJson(job));
  if (input.payloadDigest !== payloadDigest) {
    throw new ContractError("FIXTURE_PAYLOAD_DIGEST_MISMATCH", "signature", "payloadDigest does not match the canonical job.");
  }
  for (const [field, expected] of Object.entries(FIXTURE_JOB_POLICY)) {
    if (job[field] !== expected) {
      throw new ContractError("FIXTURE_JOB_POLICY_FORBIDDEN", "contract", `${field} is outside the synthetic fixture policy.`);
    }
  }

  const issuedAt = isoTimestamp(input.issuedAt, "issuedAt");
  const expiresAt = isoTimestamp(input.expiresAt, "expiresAt");
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const maxClockSkewMs = Number.isInteger(options.maxClockSkewMs) ? options.maxClockSkewMs : DEFAULT_CLOCK_SKEW_MS;
  const maxTtlMs = Number.isInteger(options.maxTtlMs) ? options.maxTtlMs : MAX_TTL_MS;
  if (issuedAt.milliseconds > nowMs + maxClockSkewMs) {
    throw new ContractError("FIXTURE_JOB_FROM_FUTURE", "time", "issuedAt exceeds the allowed clock skew.");
  }
  if (expiresAt.milliseconds < nowMs - maxClockSkewMs) {
    throw new ContractError("FIXTURE_JOB_EXPIRED", "time", "The signed job has expired.");
  }
  const ttlMs = expiresAt.milliseconds - issuedAt.milliseconds;
  if (ttlMs <= 0 || ttlMs > maxTtlMs) {
    throw new ContractError("FIXTURE_JOB_TTL_INVALID", "time", "Signed job TTL is outside the allowed range.");
  }

  return {
    schemaVersion: SIGNED_JOB_SCHEMA,
    jobId,
    idempotencyKey,
    nonce: safeIdentifier(input.nonce, "nonce", 16, 120),
    issuedAt: issuedAt.text,
    expiresAt: expiresAt.text,
    purpose: PURPOSE,
    scenario,
    requestedCommit: CONTRACT_BASELINE_COMMIT,
    collectorBlob: EXPECTED_COLLECTOR_BLOB,
    payloadDigest,
    keyId: safeIdentifier(input.keyId, "keyId", 1, 64),
    signatureVersion: SIGNATURE_VERSION,
    job,
    signature: String(input.signature || "")
  };
}

function signJob(jobInput, options = {}) {
  const job = normalizeJob(jobInput);
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const ttlMs = Number.isInteger(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  if (ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new ContractError("FIXTURE_JOB_TTL_INVALID", "time", "Signed job TTL is outside the allowed range.");
  }
  const envelope = {
    schemaVersion: SIGNED_JOB_SCHEMA,
    jobId: job.jobId,
    idempotencyKey: job.idempotencyKey,
    nonce: options.nonce || crypto.randomBytes(18).toString("base64url"),
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    purpose: options.purpose || PURPOSE,
    scenario: options.scenario || "success",
    requestedCommit: options.requestedCommit || CONTRACT_BASELINE_COMMIT,
    collectorBlob: options.collectorBlob || EXPECTED_COLLECTOR_BLOB,
    payloadDigest: sha256(stableJson(job)),
    keyId: safeIdentifier(options.keyId, "keyId", 1, 64),
    signatureVersion: SIGNATURE_VERSION,
    job,
    signature: ""
  };
  const normalized = normalizeUnsignedJob(envelope, { nowMs });
  normalized.signature = computeSignature(normalized, options.secret);
  return normalized;
}

function verifySignedJob(input, options = {}) {
  const envelope = normalizeUnsignedJob(input, options);
  if (!/^[a-f0-9]{64}$/.test(envelope.signature)) {
    throw new ContractError("FIXTURE_SIGNATURE_INVALID", "signature", "signature has an invalid format.");
  }
  if (typeof options.resolveKey !== "function") {
    throw new ContractError("FIXTURE_KEY_RESOLVER_REQUIRED", "signature", "A signing key resolver is required.");
  }
  const secret = options.resolveKey(envelope.keyId);
  if (secret === undefined || secret === null || secret === "") {
    throw new ContractError("FIXTURE_KEY_ID_UNKNOWN", "signature", "keyId is not recognized.");
  }
  const expected = Buffer.from(computeSignature(envelope, secret), "hex");
  const actual = Buffer.from(envelope.signature, "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new ContractError("FIXTURE_SIGNATURE_INVALID", "signature", "signature verification failed.");
  }
  return envelope;
}

function normalizeResult(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractError("FIXTURE_RESULT_INVALID", "result", "Result envelope must be an object.");
  }
  const unknown = Object.keys(input).filter((key) => !RESULT_FIELDS.has(key));
  if (unknown.length) {
    throw new ContractError("FIXTURE_RESULT_INVALID", "result", `Unknown result field: ${unknown.sort()[0]}`);
  }
  if (input.schemaVersion !== RESULT_SCHEMA) {
    throw new ContractError("FIXTURE_RESULT_SCHEMA_INVALID", "result", `schemaVersion must be ${RESULT_SCHEMA}.`);
  }
  const status = String(input.status || "");
  if (!["succeeded", "failed", "rejected", "duplicate"].includes(status)) {
    throw new ContractError("FIXTURE_RESULT_STATUS_INVALID", "result", "Result status is invalid.");
  }
  const digest = input.artifactManifestDigest;
  if (digest !== null && !/^[a-f0-9]{64}$/.test(String(digest || ""))) {
    throw new ContractError("FIXTURE_RESULT_DIGEST_INVALID", "result", "artifactManifestDigest is invalid.");
  }
  const actualExternalRequests = Number(input.actualExternalRequests);
  const collectorInvocations = Number(input.collectorInvocations);
  if (!Number.isInteger(actualExternalRequests) || actualExternalRequests < 0) {
    throw new ContractError("FIXTURE_RESULT_EXTERNAL_COUNT_INVALID", "result", "actualExternalRequests is invalid.");
  }
  if (!Number.isInteger(collectorInvocations) || collectorInvocations < 0 || collectorInvocations > 1) {
    throw new ContractError("FIXTURE_RESULT_INVOCATION_COUNT_INVALID", "result", "collectorInvocations is invalid.");
  }
  const exitCode = input.exitCode;
  if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)) {
    throw new ContractError("FIXTURE_RESULT_EXIT_CODE_INVALID", "result", "exitCode is invalid.");
  }
  const startedAt = isoTimestamp(input.startedAt, "startedAt");
  const completedAt = isoTimestamp(input.completedAt, "completedAt");
  if (completedAt.milliseconds < startedAt.milliseconds) {
    throw new ContractError("FIXTURE_RESULT_TIME_INVALID", "result", "completedAt precedes startedAt.");
  }
  const scenario = String(input.scenario || "");
  if (!FIXTURE_SCENARIOS.has(scenario)) {
    throw new ContractError("FIXTURE_RESULT_SCENARIO_INVALID", "result", "Result scenario is invalid.");
  }
  const matched = input.matched === true;
  const operationalWrites = input.operationalWrites === true;
  const retryable = input.retryable === true;
  if (
    status === "succeeded"
    && (!matched || actualExternalRequests !== 0 || operationalWrites || collectorInvocations !== 1
      || exitCode !== 0 || digest === null || retryable)
  ) {
    throw new ContractError("FIXTURE_RESULT_SUCCESS_INVARIANT_INVALID", "result", "Succeeded result violates the fixture safety contract.");
  }
  if (status === "failed" && (matched || digest !== null)) {
    throw new ContractError("FIXTURE_RESULT_FAILURE_INVARIANT_INVALID", "result", "Failed result violates the fixture safety contract.");
  }
  if (status === "rejected" && collectorInvocations !== 0) {
    throw new ContractError("FIXTURE_RESULT_REJECTION_INVARIANT_INVALID", "result", "Rejected result cannot invoke the collector.");
  }
  return {
    schemaVersion: RESULT_SCHEMA,
    jobId: safeIdentifier(input.jobId, "jobId"),
    idempotencyKey: safeIdentifier(input.idempotencyKey, "idempotencyKey"),
    attemptId: safeIdentifier(input.attemptId, "attemptId"),
    status,
    stage: safeIdentifier(input.stage, "stage"),
    code: safeIdentifier(input.code, "code"),
    matched,
    actualExternalRequests,
    operationalWrites,
    collectorInvocations,
    exitCode,
    artifactManifestDigest: digest === null ? null : String(digest),
    startedAt: startedAt.text,
    completedAt: completedAt.text,
    retryable,
    scenario
  };
}

function resultDigest(result) {
  return sha256(stableJson(normalizeResult(result)));
}

module.exports = {
  CONTRACT_BASELINE_COMMIT,
  ContractError,
  DEFAULT_CLOCK_SKEW_MS,
  DEFAULT_TTL_MS,
  EXPECTED_COLLECTOR_BLOB,
  FIXTURE_JOB_POLICY,
  FIXTURE_SCENARIOS,
  JOB_SCHEMA,
  MAX_TTL_MS,
  PURPOSE,
  RESULT_SCHEMA,
  SIGNATURE_VERSION,
  SIGNED_JOB_SCHEMA,
  computeSignature,
  normalizeResult,
  resultDigest,
  safeIdentifier,
  sha256,
  signJob,
  stableJson,
  verifySignedJob
};
