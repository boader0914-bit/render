"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { createSecureJsonStore } = require("./secure_json_store.cjs");
const { sha256Hex, stableSerialize } = require("./collection_artifact_contract.cjs");
const {
  CONTENT_RECEIPT_PATH: V2_TOP20_CONTENT_RECEIPT_PATH,
  MANIFEST_PATH: V2_TOP20_MANIFEST_PATH,
  REQUIRED_CSV_ROLES: V2_TOP20_REQUIRED_CSV_ROLES,
  SUMMARY_PATH: V2_TOP20_SUMMARY_PATH,
  V2_TOP20_ARTIFACT_SCHEMA_VERSION,
  verifyV2Top20ArtifactContents,
} = require("./collection_worker_v2_top20_artifact.cjs");
const {
  DETAIL_STATUSES: RESILIENT_DETAIL_STATUSES,
  summarizeResilientTop20Collection,
} = require("./collection_worker_v2_top20_resilience.cjs");

const COLLECTION_WORKER_TOP20_RESULT_SCHEMA_VERSION = "collection-worker-top20-result.v1";
const COLLECTION_WORKER_RUN_TRANSACTION_SCHEMA_VERSION = "collection-worker-run-transaction.v1";
const COLLECTION_WORKER_RUN_TRANSACTION_DOCUMENT_TYPE = "lodging-collection-worker-run-transaction";
const COLLECTION_WORKER_RUN_OUTPUT_TRANSACTION_SCHEMA_VERSION = "collection-worker-run-output-transaction.v2";
const COLLECTION_WORKER_RUN_OUTPUT_TRANSACTION_DOCUMENT_TYPE = "lodging-collection-worker-run-output-transaction";
const COLLECTION_WORKER_V2_TOP20_PROJECTION_SCHEMA_VERSION_V1 = "collection-worker-v2-top20-derived-projections.v1";
const COLLECTION_WORKER_V2_TOP20_PROJECTION_SCHEMA_VERSION = "collection-worker-v2-top20-derived-projections.v2";
const COLLECTION_WORKER_TOP20_RESULT_PATH = "top20-result.json";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._:@-]{0,127}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_OUTPUT_RELATIVE_PATH_PATTERN = /^(?:manifest\.json|(?:platform|overall|ads|regional|ddnayo)\.csv|details\/detail-\d{2}\.json)$/u;
const FORBIDDEN_WORKER_STORAGE_KEY = /^(?:outputDir|runId|transactionId|stagingDir|finalDir|absolutePath)$/iu;
const RAW_HTML_PATTERN = /<(?:!doctype\s+html|html|head|body|script)\b|window\.__APOLLO_STATE__/iu;
const URL_PATTERN = /(?:https?|wss?):\/\/|(?:^|[\s"'=])www\./iu;
const SENSITIVE_TEXT_PATTERN = /\bbearer\s+[A-Za-z0-9._~-]+|(?:client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]/iu;
const LEGACY_TERMINAL_RESULT_STATUSES = new Set(["ready", "zero"]);
const RESILIENT_COLLECTION_STATUSES = new Set(["complete", "partial", "rank_only"]);
const PROJECTION_FAILURE_REASONS = new Set([
  "csv_quoting_invalid",
  "csv_header_invalid",
  "csv_row_invalid",
  "ranking_incomplete",
  "ranking_duplicate",
  "company_identity_mismatch",
  "unsupported_target_status",
  "ready_product_observation_missing",
  "ready_revenue_observation_incomplete",
  "zero_contains_nonzero_observation",
  "projection_count_mismatch",
  "projection_reference_mismatch",
  "projection_schema_invalid",
  "unknown_projection_failure",
]);
const SAFE_PROJECTION_META_FIELDS = new Set([
  "stage",
  "reason",
  "collectionStatus",
  "targetStatus",
  "companyOrdinal",
  "field",
  "expectedKind",
  "observedKind",
  "providerAttemptCount",
  "executedCallCount",
]);
const STAGE_REVISION = 1;
const COMMIT_REVISION = 2;
const sharedSecureStore = createSecureJsonStore();
const runOutputQueues = new Map();

class CollectionWorkerRunTransactionError extends Error {
  constructor(code, message, statusCode = 409, safeMeta = null) {
    super(message);
    this.name = "CollectionWorkerRunTransactionError";
    this.code = code;
    this.statusCode = statusCode;
    this.safeMeta = safeMeta;
  }
}

function fail(code, message, statusCode = 409) {
  throw new CollectionWorkerRunTransactionError(code, message, statusCode);
}

function safeProjectionMeta(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const normalized = {};
  for (const key of SAFE_PROJECTION_META_FIELDS) {
    if (!Object.hasOwn(source, key)) continue;
    const candidate = source[key];
    if (key === "companyOrdinal" || key === "providerAttemptCount" || key === "executedCallCount") {
      if (Number.isSafeInteger(candidate) && candidate >= 0) normalized[key] = candidate;
      continue;
    }
    if (typeof candidate === "string" && candidate.length <= 96 && !/[\u0000-\u001f\u007f]/u.test(candidate)) {
      normalized[key] = candidate;
    }
  }
  normalized.stage = "run_projection";
  return Object.freeze(normalized);
}

function projectionFail(reason, message, safeMeta = {}) {
  const normalizedReason = PROJECTION_FAILURE_REASONS.has(reason) ? reason : "unknown_projection_failure";
  throw new CollectionWorkerRunTransactionError(
    "COLLECTION_RUN_OUTPUT_PROJECTION_INVALID",
    message,
    409,
    safeProjectionMeta({ ...safeMeta, reason: normalizedReason }),
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", `${label} must be an object`, 400);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", `${label} fields are invalid`, 400);
  }
}

function expectedText(value, pattern, label) {
  const text = String(value ?? "").trim();
  if (!pattern.test(text)) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", `${label} is invalid`, 400);
  }
  return text;
}

function displayText(value, label) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 160 || /[\u0000-\u001f\u007f]/u.test(text)) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", `${label} is invalid`, 400);
  }
  return text;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", `${label} is invalid`, 400);
  }
  return number;
}

function positiveInteger(value, label) {
  const number = nonNegativeInteger(value, label);
  if (number < 1) fail("COLLECTION_RUN_ARTIFACT_INVALID", `${label} is invalid`, 400);
  return number;
}

function instant(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", `${label} is invalid`, 400);
  }
  return date.toISOString();
}

function dateOnly(value, label) {
  const text = String(value || "");
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (
    !DATE_PATTERN.test(text)
    || !Number.isFinite(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== text
  ) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", `${label} is invalid`, 400);
  }
  return text;
}

function clone(value) {
  return structuredClone(value);
}

function enqueueRunOutput(transactionId, task) {
  const prior = runOutputQueues.get(transactionId) || Promise.resolve();
  const current = prior.catch(() => {}).then(task);
  runOutputQueues.set(transactionId, current);
  return current.finally(() => {
    if (runOutputQueues.get(transactionId) === current) runOutputQueues.delete(transactionId);
  });
}

function resolveRuntimePath(runtimeRoot, ...segments) {
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
    throw new TypeError("collection run transaction requires an absolute runtime root");
  }
  const root = path.resolve(runtimeRoot);
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new TypeError("collection run transaction path must stay inside the runtime root");
  }
  return target;
}

function normalizeMeasurementPeriod(value) {
  assertExactKeys(value, ["start", "end"], "measurementPeriod");
  const start = dateOnly(value.start, "measurementPeriod.start");
  const end = dateOnly(value.end, "measurementPeriod.end");
  if (end < start) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", "measurementPeriod is invalid", 400);
  }
  return Object.freeze({ start, end });
}

function normalizeCompany(value, ordinal) {
  assertExactKeys(value, ["companyKey", "displayName", "regionKey"], `results[${ordinal - 1}].company`);
  return Object.freeze({
    companyKey: expectedText(value.companyKey, KEY_PATTERN, "companyKey"),
    displayName: displayText(value.displayName, "displayName"),
    regionKey: expectedText(value.regionKey, KEY_PATTERN, "regionKey"),
  });
}

function normalizeProduct(value, ordinal, productIndex) {
  assertExactKeys(
    value,
    ["productKey", "displayName", "stayType", "price", "availableUnits", "status"],
    `results[${ordinal - 1}].products[${productIndex}]`,
  );
  const stayType = String(value.stayType || "");
  if (!new Set(["overnight", "day_use"]).has(stayType) || value.status !== "ready") {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", "product status is invalid", 400);
  }
  return Object.freeze({
    productKey: expectedText(value.productKey, KEY_PATTERN, "productKey"),
    displayName: displayText(value.displayName, "product.displayName"),
    stayType,
    price: nonNegativeInteger(value.price, "product.price"),
    availableUnits: nonNegativeInteger(value.availableUnits, "product.availableUnits"),
    status: "ready",
  });
}

function normalizeRevenue(value, resultStatus) {
  assertExactKeys(
    value,
    ["status", "estimatedRevenue", "estimatedSoldUnits", "currency"],
    "revenue",
  );
  if (value.status !== resultStatus || value.currency !== "KRW") {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", "revenue status is invalid", 400);
  }
  const estimatedRevenue = nonNegativeInteger(value.estimatedRevenue, "estimatedRevenue");
  const estimatedSoldUnits = nonNegativeInteger(value.estimatedSoldUnits, "estimatedSoldUnits");
  if (resultStatus === "zero" && (estimatedRevenue !== 0 || estimatedSoldUnits !== 0)) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", "zero revenue observation is invalid", 400);
  }
  return Object.freeze({
    status: resultStatus,
    estimatedRevenue,
    estimatedSoldUnits,
    currency: "KRW",
  });
}

function normalizeProvenance(value) {
  assertExactKeys(value, ["source", "observedAt"], "provenance");
  return Object.freeze({
    source: expectedText(value.source, KEY_PATTERN, "provenance.source"),
    observedAt: instant(value.observedAt, "provenance.observedAt"),
  });
}

function normalizeTop20Payload(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "status", "resultCount", "measurementPeriod", "collectedAt", "results"],
    "top20 result",
  );
  if (value.schemaVersion !== COLLECTION_WORKER_TOP20_RESULT_SCHEMA_VERSION || value.status !== "ready") {
    fail("COLLECTION_RUN_ARTIFACT_NOT_READY", "only a ready top-20 artifact may be committed", 409);
  }
  if (value.resultCount !== 20 || !Array.isArray(value.results) || value.results.length !== 20) {
    fail("COLLECTION_RUN_ARTIFACT_INCOMPLETE", "exactly 20 ordered results are required", 409);
  }
  const companyKeys = new Set();
  const productKeys = new Set();
  const results = value.results.map((entry, index) => {
    const ordinal = index + 1;
    assertExactKeys(
      entry,
      ["ordinal", "rank", "status", "company", "products", "revenue", "provenance"],
      `results[${index}]`,
    );
    if (entry.ordinal !== ordinal || entry.rank !== ordinal) {
      fail("COLLECTION_RUN_ARTIFACT_ORDER_INVALID", "top-20 results must be ordered ranks 1 through 20", 409);
    }
    const status = String(entry.status || "");
    if (!LEGACY_TERMINAL_RESULT_STATUSES.has(status)) {
      fail("COLLECTION_RUN_ARTIFACT_NOT_READY", "all top-20 results must be terminal ready or zero", 409);
    }
    const company = normalizeCompany(entry.company, ordinal);
    if (companyKeys.has(company.companyKey)) {
      fail("COLLECTION_RUN_ARTIFACT_DUPLICATE", "top-20 company identity is duplicated", 409);
    }
    companyKeys.add(company.companyKey);
    if (!Array.isArray(entry.products)) {
      fail("COLLECTION_RUN_ARTIFACT_INVALID", "products must be an array", 400);
    }
    if (status === "zero" && entry.products.length !== 0) {
      fail("COLLECTION_RUN_ARTIFACT_INVALID", "zero result cannot contain products", 400);
    }
    if (status === "ready" && entry.products.length < 1) {
      fail("COLLECTION_RUN_ARTIFACT_NOT_READY", "ready result requires a product observation", 409);
    }
    const products = entry.products.map((product, productIndex) => {
      const normalized = normalizeProduct(product, ordinal, productIndex);
      if (productKeys.has(normalized.productKey)) {
        fail("COLLECTION_RUN_ARTIFACT_DUPLICATE", "top-20 product identity is duplicated", 409);
      }
      productKeys.add(normalized.productKey);
      return normalized;
    });
    return Object.freeze({
      ordinal,
      rank: ordinal,
      status,
      company,
      products: Object.freeze(products),
      revenue: normalizeRevenue(entry.revenue, status),
      provenance: normalizeProvenance(entry.provenance),
    });
  });
  return Object.freeze({
    schemaVersion: COLLECTION_WORKER_TOP20_RESULT_SCHEMA_VERSION,
    status: "ready",
    resultCount: 20,
    measurementPeriod: normalizeMeasurementPeriod(value.measurementPeriod),
    collectedAt: instant(value.collectedAt, "collectedAt"),
    results: Object.freeze(results),
  });
}

function decodeVerifiedTop20Artifact(input = {}) {
  if (typeof input.verifier !== "function") {
    fail("COLLECTION_RUN_ARTIFACT_VERIFIER_REQUIRED", "artifact verifier is required", 500);
  }
  let verified;
  try {
    verified = input.verifier(input.signedArtifact);
  } catch {
    fail("COLLECTION_RUN_ARTIFACT_VERIFICATION_FAILED", "artifact verification failed", 403);
  }
  const bundle = verified?.bundle;
  const identity = bundle?.identity;
  if (!isPlainObject(bundle) || !isPlainObject(identity)) {
    fail("COLLECTION_RUN_ARTIFACT_VERIFICATION_FAILED", "artifact verification failed", 403);
  }
  const artifactHash = expectedText(bundle.bundleHash, HASH_PATTERN, "artifactHash");
  const jobId = expectedText(identity.jobId, ID_PATTERN, "jobId");
  const contractHash = expectedText(identity.contractHash, HASH_PATTERN, "contractHash");
  const executionIdentityHash = expectedText(
    identity.executionIdentityHash,
    HASH_PATTERN,
    "executionIdentityHash",
  );
  if (!Array.isArray(bundle.files) || bundle.files.length !== 1) {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", "top-20 artifact must contain one result file", 400);
  }
  const file = bundle.files[0];
  if (file?.path !== COLLECTION_WORKER_TOP20_RESULT_PATH || typeof file.contentBase64 !== "string") {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", "top-20 result file is missing", 400);
  }
  const content = Buffer.from(file.contentBase64, "base64");
  if (content.toString("base64") !== file.contentBase64 || sha256Hex(content) !== file.sha256) {
    fail("COLLECTION_RUN_ARTIFACT_VERIFICATION_FAILED", "artifact verification failed", 403);
  }
  let payload;
  try {
    payload = JSON.parse(content.toString("utf8"));
  } catch {
    fail("COLLECTION_RUN_ARTIFACT_INVALID", "top-20 result JSON is invalid", 400);
  }
  return Object.freeze({
    artifactHash,
    jobId,
    contractHash,
    executionIdentityHash,
    payload: normalizeTop20Payload(payload),
  });
}

function rejectWorkerStorageIdentity(value) {
  const visit = (current) => {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, nested] of Object.entries(current)) {
      if (FORBIDDEN_WORKER_STORAGE_KEY.test(key)) {
        fail(
          "COLLECTION_RUN_OUTPUT_REMOTE_IDENTITY_FORBIDDEN",
          "worker artifact contains a Preview-owned storage identity",
          400,
        );
      }
      visit(nested);
    }
  };
  visit(value);
}

function safeArtifactBundlePath(value) {
  const filePath = String(value || "");
  if (
    !filePath
    || filePath.startsWith("/")
    || filePath.includes("\\")
    || filePath.includes("\0")
    || path.posix.normalize(filePath) !== filePath
    || filePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "worker artifact path is invalid", 400);
  }
  return filePath;
}

function decodeArtifactFile(file) {
  if (!isPlainObject(file) || typeof file.contentBase64 !== "string") {
    fail("COLLECTION_RUN_OUTPUT_ARTIFACT_INVALID", "worker artifact file is invalid", 400);
  }
  const content = Buffer.from(file.contentBase64, "base64");
  if (
    content.toString("base64") !== file.contentBase64
    || !HASH_PATTERN.test(String(file.sha256 || ""))
    || sha256Hex(content) !== file.sha256
    || content.length !== file.size
  ) {
    fail("COLLECTION_RUN_OUTPUT_ARTIFACT_TAMPERED", "worker artifact file integrity check failed", 403);
  }
  const text = content.toString("utf8");
  if (RAW_HTML_PATTERN.test(text) || URL_PATTERN.test(text) || SENSITIVE_TEXT_PATTERN.test(text)) {
    fail("COLLECTION_RUN_OUTPUT_SENSITIVE_CONTENT", "worker artifact contains prohibited content", 403);
  }
  return content;
}

function parseArtifactJson(file, label) {
  let value;
  try {
    value = JSON.parse(decodeArtifactFile(file).toString("utf8"));
  } catch (error) {
    if (error instanceof CollectionWorkerRunTransactionError) throw error;
    fail("COLLECTION_RUN_OUTPUT_ARTIFACT_INVALID", `${label} is invalid`, 400);
  }
  rejectWorkerStorageIdentity(value);
  return value;
}

function decodeVerifiedV2RunArtifact(input = {}) {
  if (typeof input.verifier !== "function") {
    fail("COLLECTION_RUN_ARTIFACT_VERIFIER_REQUIRED", "artifact verifier is required", 500);
  }
  let verifiedArtifact;
  try {
    verifiedArtifact = input.verifier(input.signedArtifact);
  } catch {
    fail("COLLECTION_RUN_ARTIFACT_VERIFICATION_FAILED", "artifact verification failed", 403);
  }
  const bundle = verifiedArtifact?.bundle;
  const identity = bundle?.identity;
  if (!isPlainObject(bundle) || !isPlainObject(identity) || !Array.isArray(bundle.files)) {
    fail("COLLECTION_RUN_ARTIFACT_VERIFICATION_FAILED", "artifact verification failed", 403);
  }
  const artifactHash = expectedText(bundle.bundleHash, HASH_PATTERN, "artifactHash");
  const jobId = expectedText(identity.jobId, ID_PATTERN, "jobId");
  const contractHash = expectedText(identity.contractHash, HASH_PATTERN, "contractHash");
  const executionIdentityHash = expectedText(
    identity.executionIdentityHash,
    HASH_PATTERN,
    "executionIdentityHash",
  );
  let verifiedContents;
  try {
    verifiedContents = verifyV2Top20ArtifactContents(verifiedArtifact, {
      contractHash,
      executionIdentityHash,
    });
  } catch {
    fail("COLLECTION_RUN_OUTPUT_ARTIFACT_INVALID", "V2 top-20 artifact content is invalid", 409);
  }
  rejectWorkerStorageIdentity(verifiedContents.summary);
  rejectWorkerStorageIdentity(verifiedContents.manifest);
  if (verifiedContents.contentReceipt) rejectWorkerStorageIdentity(verifiedContents.contentReceipt);

  const filesByPath = new Map();
  for (const file of bundle.files) {
    const filePath = safeArtifactBundlePath(file.path);
    if (filesByPath.has(filePath)) {
      fail("COLLECTION_RUN_OUTPUT_ARTIFACT_INVALID", "worker artifact path is duplicated", 400);
    }
    filesByPath.set(filePath, file);
  }
  const requiredPaths = new Set([
    V2_TOP20_SUMMARY_PATH,
    ...(verifiedContents.contentReceipt ? [V2_TOP20_CONTENT_RECEIPT_PATH] : []),
    V2_TOP20_MANIFEST_PATH,
    ...V2_TOP20_REQUIRED_CSV_ROLES.map((role) => `run/${role}.csv`),
  ]);
  const detailPaths = [];
  for (const filePath of filesByPath.keys()) {
    if (requiredPaths.has(filePath)) continue;
    if (!/^run\/details\/detail-\d{2}\.json$/u.test(filePath)) {
      fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "worker artifact contains an unapproved path", 400);
    }
    detailPaths.push(filePath);
  }
  if ([...requiredPaths].some((filePath) => !filesByPath.has(filePath)) || detailPaths.length > 24) {
    fail("COLLECTION_RUN_OUTPUT_ARTIFACT_INCOMPLETE", "worker artifact file set is incomplete", 409);
  }
  detailPaths.sort();
  const manifestDetailPaths = Array.isArray(verifiedContents.manifest.detailJsonFiles)
    ? verifiedContents.manifest.detailJsonFiles.map((filePath) => `run/${safeArtifactBundlePath(filePath)}`).sort()
    : [];
  if (stableSerialize(detailPaths) !== stableSerialize(manifestDetailPaths)) {
    fail("COLLECTION_RUN_OUTPUT_ARTIFACT_INVALID", "worker artifact detail file set does not match", 409);
  }
  const expectedContentPaths = [
    V2_TOP20_MANIFEST_PATH,
    ...V2_TOP20_REQUIRED_CSV_ROLES.map((role) => `run/${role}.csv`),
    ...detailPaths,
  ].sort();
  const declaredContentPaths = Object.keys(
    verifiedContents.contentReceipt?.contentHashes || verifiedContents.summary.contentHashes || {},
  ).sort();
  if (stableSerialize(expectedContentPaths) !== stableSerialize(declaredContentPaths)) {
    fail("COLLECTION_RUN_OUTPUT_ARTIFACT_INVALID", "worker artifact content hash set is incomplete", 409);
  }
  for (const filePath of [
    V2_TOP20_SUMMARY_PATH,
    ...(verifiedContents.contentReceipt ? [V2_TOP20_CONTENT_RECEIPT_PATH] : []),
    ...expectedContentPaths,
  ]) {
    const content = decodeArtifactFile(filesByPath.get(filePath));
    if (filePath.endsWith(".json")) {
      let parsed;
      try {
        parsed = JSON.parse(content.toString("utf8"));
      } catch {
        fail("COLLECTION_RUN_OUTPUT_ARTIFACT_INVALID", "worker artifact JSON is invalid", 400);
      }
      rejectWorkerStorageIdentity(parsed);
    }
  }
  return Object.freeze({
    verifiedArtifact,
    verifiedContents,
    artifactHash,
    jobId,
    contractHash,
    executionIdentityHash,
    filesByPath,
    detailPaths: Object.freeze(detailPaths),
  });
}

function parseProjectionCsv(content, label) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : String(content || "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field) projectionFail("csv_quoting_invalid", `${label} CSV quoting is invalid`, { field: label });
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) projectionFail("csv_quoting_invalid", `${label} CSV quoting is incomplete`, { field: label });
  if (field || row.length) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((value) => value === "")) rows.pop();
  if (rows.length < 2) projectionFail("csv_header_invalid", `${label} CSV is empty`, { field: label });
  const headers = rows.shift().map((value, index) => (
    index === 0 ? String(value).replace(/^\uFEFF/u, "") : String(value)
  ));
  if (headers.some((value) => !value) || new Set(headers).size !== headers.length) {
    projectionFail("csv_header_invalid", `${label} CSV headers are invalid`, { field: label });
  }
  return rows.map((values, rowIndex) => {
    if (values.length !== headers.length) {
      projectionFail("csv_row_invalid", `${label} CSV row ${rowIndex + 1} is invalid`, {
        field: label,
        companyOrdinal: rowIndex + 1,
      });
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function projectionInteger(value, label, options = {}) {
  const text = String(value ?? "").trim();
  if (!text && options.optional === true) return null;
  const normalized = text.replaceAll(",", "").replace(/\s*원$/u, "");
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < 0) {
    projectionFail("projection_schema_invalid", `${label} is invalid`, { field: label });
  }
  return number;
}

function projectionDisplayText(value, label, maximum = 240) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    projectionFail("projection_schema_invalid", `${label} is invalid`, { field: label });
  }
  return text;
}

function buildV2RunProjections(verified, transactionId, runId) {
  const manifest = verified.verifiedContents.manifest;
  const targetResults = verified.verifiedContents.targetResults;
  const artifactSummary = verified.verifiedContents.summary || {};
  const derivedSummary = summarizeResilientTop20Collection({
    mainPlaceStatus: "ready",
    targets: targetResults,
    detailCircuitOpen: targetResults.some((target) => String(target.detailCollectionStatus || target.status || "") === "blocked"),
  });
  const collectionStatus = String(artifactSummary.collectionStatus || derivedSummary.collectionStatus || "");
  const mainPlaceStatus = "ready";
  const detailStatus = String(
    artifactSummary.detailStatus
    || derivedSummary.detailStatus
    || "partial",
  );
  if (!RESILIENT_COLLECTION_STATUSES.has(collectionStatus) || mainPlaceStatus !== "ready") {
    projectionFail("projection_schema_invalid", "top-20 collection summary is invalid", {
      collectionStatus,
      observedKind: mainPlaceStatus,
    });
  }
  const overallRows = parseProjectionCsv(
    decodeArtifactFile(verified.filesByPath.get("run/overall.csv")),
    "overall",
  );
  const byRank = new Map();
  for (const row of overallRows) {
    const rank = projectionInteger(row.overall_rank, "overall_rank", { optional: true });
    if (rank === null || rank < 1 || rank > 20) continue;
    if (byRank.has(rank)) {
      projectionFail("ranking_duplicate", "top-20 rank is duplicated", {
        collectionStatus,
        companyOrdinal: rank,
      });
    }
    byRank.set(rank, row);
  }
  if (byRank.size !== 20 || !Array.isArray(targetResults) || targetResults.length !== 20) {
    projectionFail("ranking_incomplete", "top-20 projection rows are incomplete", {
      collectionStatus,
      expectedKind: "top20",
      observedKind: String(byRank.size),
    });
  }

  const collectedAt = instant(
    manifest.dataAvailableAt || manifest.collectionCompletedAt || manifest.collectionStartedAt,
    "manifest.collectedAt",
  );
  const measurementPeriod = normalizeMeasurementPeriod({
    start: manifest.checkIn,
    end: manifest.checkOut,
  });
  const regionKey = expectedText(
    manifest.searchRegionKey || manifest.regionKey || manifest.provinceKey || manifest.regionSlug || "region:unresolved",
    KEY_PATTERN,
    "manifest.regionKey",
  );
  const resultStatuses = [];
  const companies = [];
  const products = [];
  const revenues = [];
  const history = [];
  const companyKeys = new Set();

  for (let index = 0; index < targetResults.length; index += 1) {
    const ordinal = index + 1;
    const target = targetResults[index];
    const row = byRank.get(ordinal);
    const placeId = expectedText(target.placeId, KEY_PATTERN, `targetResults[${index}].placeId`);
    if (String(row.place_id || "").trim() !== placeId || Number(target.companyOrdinal) !== ordinal) {
      projectionFail("company_identity_mismatch", "top-20 company identity does not match the manifest", {
        collectionStatus,
        companyOrdinal: ordinal,
      });
    }
    const status = String(target.detailCollectionStatus || target.status || "");
    if (!RESILIENT_DETAIL_STATUSES.has(status)) {
      projectionFail("unsupported_target_status", "top-20 company status is invalid", {
        collectionStatus,
        targetStatus: status,
        companyOrdinal: ordinal,
      });
    }
    const companyKey = expectedText(`naver-place:${placeId}`, KEY_PATTERN, "companyKey");
    if (companyKeys.has(companyKey)) {
      projectionFail("ranking_duplicate", "top-20 company identity is duplicated", {
        collectionStatus,
        companyOrdinal: ordinal,
      });
    }
    companyKeys.add(companyKey);
    const company = Object.freeze({
      projectionId: `${runId}:company:${companyKey}`,
      runId,
      artifactHash: verified.artifactHash,
      ordinal,
      rank: ordinal,
      status,
      detailCollectionStatus: status,
      companyKey,
      placeId,
      displayName: projectionDisplayText(row["업체명"], "company.displayName", 160),
      address: String(row["주소"] || "").trim().slice(0, 300),
      regionKey,
      bookingBusinessIdSource: String(target.bookingBusinessIdSource || "none"),
      revenueInputValid: target.revenueInputValid === true,
      collectionStatus,
    });
    companies.push(company);
    resultStatuses.push(Object.freeze({ ordinal, rank: ordinal, companyKey, status }));

    const nightProductCount = projectionInteger(row["숙박상품수"], "nightProductCount", { optional: true });
    const dayUseProductCount = projectionInteger(row["데이유즈상품수"], "dayUseProductCount", { optional: true });
    const nightAvailableUnits = projectionInteger(row["숙박예약가능수"], "nightAvailableUnits", { optional: true });
    const dayUseAvailableUnits = projectionInteger(row["데이유즈예약가능수"], "dayUseAvailableUnits", { optional: true });
    const nightPrice = projectionInteger(row["숙박기준일평균판매단가"] || row["예약최저가"], "nightPrice", { optional: true });
    const dayUsePrice = projectionInteger(row["데이유즈기준일평균판매단가"], "dayUsePrice", { optional: true });
    const productSummaries = [
      { stayType: "overnight", count: nightProductCount, price: nightPrice, availableUnits: nightAvailableUnits },
      { stayType: "day_use", count: dayUseProductCount, price: dayUsePrice, availableUnits: dayUseAvailableUnits },
    ];
    const observedProductCount = productSummaries.reduce((total, item) => total + (item.count ?? 0), 0);
    const hasConfirmedProduct = productSummaries.some((item) => item.count !== null && item.count > 0 && item.price !== null && item.availableUnits !== null);
    if (status === "ready" && !hasConfirmedProduct) {
      projectionFail("ready_product_observation_missing", "ready company has no product observation", {
        collectionStatus,
        targetStatus: status,
        companyOrdinal: ordinal,
      });
    }
    if (status === "zero" && (observedProductCount > 0 || productSummaries.some((item) => (item.availableUnits ?? 0) > 0))) {
      projectionFail("zero_contains_nonzero_observation", "zero company contains product inventory", {
        collectionStatus,
        targetStatus: status,
        companyOrdinal: ordinal,
      });
    }
    const productAllowed = status === "ready" || (status === "partial" && target.revenueInputValid === true);
    for (const summary of productSummaries) {
      if (!productAllowed || !summary.count) continue;
      if (summary.price === null || summary.availableUnits === null) {
        if (status === "ready") {
          projectionFail("ready_product_observation_missing", "ready company product observation is incomplete", {
            collectionStatus,
            targetStatus: status,
            companyOrdinal: ordinal,
          });
        }
        continue;
      }
      const productKey = `${companyKey}:${summary.stayType}:summary`;
      products.push(Object.freeze({
        projectionId: `${runId}:product:${productKey}`,
        runId,
        artifactHash: verified.artifactHash,
        companyKey,
        ordinal,
        rank: ordinal,
        productKey,
        displayName: summary.stayType === "overnight" ? "숙박 공개 재고 요약" : "데이유즈 공개 재고 요약",
        stayType: summary.stayType,
        sourceProductCount: summary.count,
        price: summary.price,
        availableUnits: summary.availableUnits,
        status,
        projectionKind: "inventory_summary",
      }));
    }

    const nightRevenue = projectionInteger(row["숙박기준일예상매출"], "nightRevenue", { optional: true });
    const dayUseRevenue = projectionInteger(row["데이유즈기준일예상매출"], "dayUseRevenue", { optional: true });
    const nightSoldUnits = projectionInteger(row["숙박기준일가격확인판매수량"], "nightSoldUnits", { optional: true });
    const dayUseSoldUnits = projectionInteger(row["데이유즈기준일가격확인판매수량"], "dayUseSoldUnits", { optional: true });
    const revenueFields = [nightRevenue, dayUseRevenue, nightSoldUnits, dayUseSoldUnits];
    const revenueObservationComplete = revenueFields.every((value) => value !== null);
    if (status === "ready" && (target.revenueInputValid !== true || !revenueObservationComplete)) {
      projectionFail("ready_revenue_observation_incomplete", "ready company revenue observation is incomplete", {
        collectionStatus,
        targetStatus: status,
        companyOrdinal: ordinal,
      });
    }
    const estimatedRevenue = (nightRevenue ?? 0) + (dayUseRevenue ?? 0);
    const estimatedSoldUnits = (nightSoldUnits ?? 0) + (dayUseSoldUnits ?? 0);
    if (status === "zero" && revenueObservationComplete && (estimatedRevenue || estimatedSoldUnits)) {
      projectionFail("zero_contains_nonzero_observation", "zero company revenue is invalid", {
        collectionStatus,
        targetStatus: status,
        companyOrdinal: ordinal,
      });
    }
    const revenueAllowed = target.revenueInputValid === true
      && revenueObservationComplete
      && ["ready", "zero", "partial"].includes(status);
    if (revenueAllowed) {
      const revenue = Object.freeze({
        projectionId: `${runId}:revenue:${companyKey}`,
        runId,
        artifactHash: verified.artifactHash,
        companyKey,
        ordinal,
        rank: ordinal,
        status,
        estimatedRevenue,
        estimatedSoldUnits,
        currency: "KRW",
        estimateBasis: String(manifest.revenueEstimateBasis || "public_inventory_estimate"),
      });
      revenues.push(revenue);
      history.push(Object.freeze({
        observationId: sha256Hex(`collection-worker-v2-history.v1\0${runId}\0${companyKey}\0${collectedAt}`),
        runId,
        artifactHash: verified.artifactHash,
        companyKey,
        ordinal,
        rank: ordinal,
        status,
        estimatedRevenue,
        estimatedSoldUnits,
        currency: "KRW",
        source: "naver_booking_public_inventory",
        observedAt: collectedAt,
      }));
    }
  }

  const statusCount = (status) => resultStatuses.filter((result) => result.status === status).length;
  const detailReadyCompanyCount = statusCount("ready") + statusCount("zero");
  const unresolvedCount = 20 - detailReadyCompanyCount;
  if (
    collectionStatus === "complete" && (unresolvedCount !== 0 || detailReadyCompanyCount !== 20)
    || collectionStatus === "partial" && (detailReadyCompanyCount < 1 || unresolvedCount < 1)
    || collectionStatus === "rank_only" && (detailReadyCompanyCount !== 0 || products.length !== 0 || revenues.length !== 0 || history.length !== 0)
  ) {
    projectionFail("projection_count_mismatch", "top-20 collection status does not match target states", {
      collectionStatus,
      expectedKind: collectionStatus,
      observedKind: String(detailReadyCompanyCount),
    });
  }

  const run = Object.freeze({
    runId,
    transactionId,
    artifactHash: verified.artifactHash,
    jobId: verified.jobId,
    contractHash: verified.contractHash,
    executionIdentityHash: verified.executionIdentityHash,
    schemaVersion: COLLECTION_WORKER_V2_TOP20_PROJECTION_SCHEMA_VERSION,
    status: "ready",
    measurementPeriod,
    collectedAt,
    collectionStatus,
    mainPlaceStatus,
    detailStatus,
    resultCount: 20,
    readyCount: statusCount("ready"),
    zeroCount: statusCount("zero"),
    partialCount: statusCount("partial"),
    blockedCount: statusCount("blocked"),
    failedCount: statusCount("failed"),
    notCollectedCount: statusCount("not_collected"),
    missingCount: statusCount("missing"),
    detailReadyCompanyCount,
    revenueReadyCompanyCount: targetResults.filter((target) => target.revenueInputValid === true).length,
    detailCoverageRate: detailReadyCompanyCount / 20,
    revenueCoverageRate: targetResults.filter((target) => target.revenueInputValid === true).length / 20,
    revenueProjectionCount: revenues.length,
    historyProjectionCount: history.length,
    resultStatuses: Object.freeze(resultStatuses),
  });
  return Object.freeze({
    run,
    companies: Object.freeze(companies),
    products: Object.freeze(products),
    revenues: Object.freeze(revenues),
    history: Object.freeze(history),
  });
}

function runOutputTransactionIdentity(verified) {
  const transactionId = sha256Hex(`collection-worker-run-output.v1\0${verified.jobId}`);
  return Object.freeze({
    transactionId,
    runId: `preview-worker-run-${transactionId.slice(0, 20)}`,
  });
}

function buildRunOutputFiles(verified, transactionId, runId, finalRelativePath) {
  const outputFiles = [];
  for (const role of V2_TOP20_REQUIRED_CSV_ROLES) {
    const artifactPath = `run/${role}.csv`;
    outputFiles.push({
      path: `${role}.csv`,
      content: decodeArtifactFile(verified.filesByPath.get(artifactPath)),
    });
  }
  for (const artifactPath of verified.detailPaths) {
    outputFiles.push({
      path: artifactPath.slice("run/".length),
      content: decodeArtifactFile(verified.filesByPath.get(artifactPath)),
    });
  }
  const previewManifest = clone(verified.verifiedContents.manifest);
  rejectWorkerStorageIdentity(previewManifest);
  previewManifest.runId = runId;
  previewManifest.outputDir = finalRelativePath;
  previewManifest.transactionId = transactionId;
  previewManifest.previewOwnedStorageIdentity = true;
  previewManifest.workerArtifactHash = verified.artifactHash;
  previewManifest.workerArtifactSchemaVersion = V2_TOP20_ARTIFACT_SCHEMA_VERSION;
  outputFiles.unshift({
    path: "manifest.json",
    content: Buffer.from(`${JSON.stringify(previewManifest, null, 2)}\n`, "utf8"),
  });
  return outputFiles.map((file) => {
    if (!SAFE_OUTPUT_RELATIVE_PATH_PATTERN.test(file.path)) {
      fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "Preview output path is invalid", 500);
    }
    return Object.freeze({
      path: file.path,
      content: Buffer.from(file.content),
      size: file.content.length,
      sha256: sha256Hex(file.content),
    });
  });
}

function buildRunOutputStageRecord(verified, now) {
  const { transactionId, runId } = runOutputTransactionIdentity(verified);
  const finalRelativePath = `outputs/${runId}`;
  const outputFiles = buildRunOutputFiles(verified, transactionId, runId, finalRelativePath);
  const fileEntries = outputFiles.map(({ path: filePath, size, sha256 }) => Object.freeze({
    path: filePath,
    size,
    sha256,
  }));
  const outputTreeHash = sha256Hex(stableSerialize(fileEntries));
  const projections = buildV2RunProjections(verified, transactionId, runId);
  const projectionsHash = sha256Hex(stableSerialize(projections));
  const stageHash = sha256Hex(stableSerialize({
    transactionId,
    artifactHash: verified.artifactHash,
    jobId: verified.jobId,
    contractHash: verified.contractHash,
    executionIdentityHash: verified.executionIdentityHash,
    runId,
    finalRelativePath,
    outputTreeHash,
    projectionsHash,
  }));
  return Object.freeze({
    record: Object.freeze({
      documentType: COLLECTION_WORKER_RUN_OUTPUT_TRANSACTION_DOCUMENT_TYPE,
      schemaVersion: COLLECTION_WORKER_RUN_OUTPUT_TRANSACTION_SCHEMA_VERSION,
      state: "staged",
      transactionId,
      transactionRevision: STAGE_REVISION,
      artifactHash: verified.artifactHash,
      jobId: verified.jobId,
      contractHash: verified.contractHash,
      executionIdentityHash: verified.executionIdentityHash,
      runId,
      finalRelativePath,
      stageHash,
      outputTreeHash,
      projectionsHash,
      fileEntries: Object.freeze(fileEntries),
      projections,
      createdAt: now,
    }),
    outputFiles: Object.freeze(outputFiles),
  });
}

function runOutputProjectionsV1Valid(record) {
  if (!isPlainObject(record.projections) || !isPlainObject(record.projections.run)) return false;
  const { run, companies, products, revenues, history } = record.projections;
  if (
    run.runId !== record.runId
    || run.transactionId !== record.transactionId
    || run.artifactHash !== record.artifactHash
    || run.jobId !== record.jobId
    || run.contractHash !== record.contractHash
    || run.executionIdentityHash !== record.executionIdentityHash
    || run.schemaVersion !== COLLECTION_WORKER_V2_TOP20_PROJECTION_SCHEMA_VERSION_V1
    || run.status !== "ready"
    || run.resultCount !== 20
    || !Number.isFinite(Date.parse(run.collectedAt))
    || !isPlainObject(run.measurementPeriod)
    || !DATE_PATTERN.test(run.measurementPeriod.start)
    || !DATE_PATTERN.test(run.measurementPeriod.end)
    || run.measurementPeriod.end < run.measurementPeriod.start
    || !Array.isArray(run.resultStatuses)
    || run.resultStatuses.length !== 20
    || !Array.isArray(companies)
    || companies.length !== 20
    || !Array.isArray(products)
    || products.length > 40
    || !Array.isArray(revenues)
    || revenues.length !== 20
    || !Array.isArray(history)
    || history.length !== 20
  ) return false;
  const statuses = new Map();
  for (let index = 0; index < run.resultStatuses.length; index += 1) {
    const ordinal = index + 1;
    const result = run.resultStatuses[index];
    if (
      !isPlainObject(result)
      || result.ordinal !== ordinal
      || result.rank !== ordinal
      || !KEY_PATTERN.test(String(result.companyKey || ""))
      || !LEGACY_TERMINAL_RESULT_STATUSES.has(result.status)
      || statuses.has(result.companyKey)
    ) return false;
    statuses.set(result.companyKey, result.status);
  }
  if (
    run.readyCount !== [...statuses.values()].filter((status) => status === "ready").length
    || run.zeroCount !== [...statuses.values()].filter((status) => status === "zero").length
    || run.readyCount + run.zeroCount !== 20
  ) return false;
  for (let index = 0; index < companies.length; index += 1) {
    const ordinal = index + 1;
    const company = companies[index];
    if (
      !isPlainObject(company)
      || company.runId !== record.runId
      || company.artifactHash !== record.artifactHash
      || company.ordinal !== ordinal
      || company.rank !== ordinal
      || statuses.get(company.companyKey) !== company.status
      || !KEY_PATTERN.test(String(company.companyKey || ""))
      || !KEY_PATTERN.test(String(company.regionKey || ""))
      || !KEY_PATTERN.test(String(company.placeId || ""))
      || typeof company.displayName !== "string"
      || !company.displayName
    ) return false;
  }
  const productCounts = new Map([...statuses.keys()].map((companyKey) => [companyKey, 0]));
  for (const product of products) {
    if (
      !isPlainObject(product)
      || product.runId !== record.runId
      || product.artifactHash !== record.artifactHash
      || statuses.get(product.companyKey) !== "ready"
      || product.status !== "ready"
      || product.projectionKind !== "inventory_summary"
      || !new Set(["overnight", "day_use"]).has(product.stayType)
      || !Number.isInteger(product.ordinal)
      || product.ordinal < 1
      || product.ordinal > 20
      || product.rank !== product.ordinal
      || !Number.isSafeInteger(product.sourceProductCount)
      || product.sourceProductCount < 1
      || !Number.isSafeInteger(product.price)
      || product.price < 0
      || !Number.isSafeInteger(product.availableUnits)
      || product.availableUnits < 0
    ) return false;
    productCounts.set(product.companyKey, productCounts.get(product.companyKey) + 1);
  }
  for (const [companyKey, status] of statuses.entries()) {
    if (status === "ready" && productCounts.get(companyKey) < 1) return false;
    if (status === "zero" && productCounts.get(companyKey) !== 0) return false;
  }
  for (let index = 0; index < revenues.length; index += 1) {
    const ordinal = index + 1;
    const revenue = revenues[index];
    if (
      !isPlainObject(revenue)
      || revenue.runId !== record.runId
      || revenue.artifactHash !== record.artifactHash
      || revenue.ordinal !== ordinal
      || revenue.rank !== ordinal
      || statuses.get(revenue.companyKey) !== revenue.status
      || revenue.currency !== "KRW"
      || !Number.isSafeInteger(revenue.estimatedRevenue)
      || revenue.estimatedRevenue < 0
      || !Number.isSafeInteger(revenue.estimatedSoldUnits)
      || revenue.estimatedSoldUnits < 0
      || revenue.status === "zero" && (revenue.estimatedRevenue !== 0 || revenue.estimatedSoldUnits !== 0)
    ) return false;
  }
  for (let index = 0; index < history.length; index += 1) {
    const ordinal = index + 1;
    const observation = history[index];
    if (
      !isPlainObject(observation)
      || observation.runId !== record.runId
      || observation.artifactHash !== record.artifactHash
      || observation.ordinal !== ordinal
      || observation.rank !== ordinal
      || statuses.get(observation.companyKey) !== observation.status
      || !HASH_PATTERN.test(String(observation.observationId || ""))
      || observation.currency !== "KRW"
      || !Number.isFinite(Date.parse(observation.observedAt))
    ) return false;
  }
  if (new Set(companies.map((entry) => entry.projectionId)).size !== companies.length) return false;
  if (new Set(products.map((entry) => entry.projectionId)).size !== products.length) return false;
  if (new Set(revenues.map((entry) => entry.projectionId)).size !== revenues.length) return false;
  if (new Set(history.map((entry) => entry.observationId)).size !== history.length) return false;
  return sha256Hex(stableSerialize(record.projections)) === record.projectionsHash;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function runOutputProjectionsV2Valid(record) {
  if (!isPlainObject(record.projections) || !isPlainObject(record.projections.run)) return false;
  const { run, companies, products, revenues, history } = record.projections;
  if (
    run.runId !== record.runId
    || run.transactionId !== record.transactionId
    || run.artifactHash !== record.artifactHash
    || run.jobId !== record.jobId
    || run.contractHash !== record.contractHash
    || run.executionIdentityHash !== record.executionIdentityHash
    || run.schemaVersion !== COLLECTION_WORKER_V2_TOP20_PROJECTION_SCHEMA_VERSION
    || run.status !== "ready"
    || !RESILIENT_COLLECTION_STATUSES.has(run.collectionStatus)
    || run.mainPlaceStatus !== "ready"
    || typeof run.detailStatus !== "string"
    || !run.detailStatus
    || run.resultCount !== 20
    || !Number.isFinite(Date.parse(run.collectedAt))
    || !isPlainObject(run.measurementPeriod)
    || !DATE_PATTERN.test(run.measurementPeriod.start)
    || !DATE_PATTERN.test(run.measurementPeriod.end)
    || run.measurementPeriod.end < run.measurementPeriod.start
    || !Array.isArray(run.resultStatuses)
    || run.resultStatuses.length !== 20
    || !Array.isArray(companies)
    || companies.length !== 20
    || !Array.isArray(products)
    || products.length > 40
    || !Array.isArray(revenues)
    || !Array.isArray(history)
    || revenues.length !== run.revenueProjectionCount
    || history.length !== run.historyProjectionCount
    || history.length !== revenues.length
    || !isSafeNonNegativeInteger(run.revenueProjectionCount)
    || !isSafeNonNegativeInteger(run.historyProjectionCount)
    || !isSafeNonNegativeInteger(run.readyCount)
    || !isSafeNonNegativeInteger(run.zeroCount)
    || !isSafeNonNegativeInteger(run.partialCount)
    || !isSafeNonNegativeInteger(run.blockedCount)
    || !isSafeNonNegativeInteger(run.failedCount)
    || !isSafeNonNegativeInteger(run.notCollectedCount)
    || !isSafeNonNegativeInteger(run.missingCount)
    || !isSafeNonNegativeInteger(run.detailReadyCompanyCount)
    || !isSafeNonNegativeInteger(run.revenueReadyCompanyCount)
    || !Number.isFinite(run.detailCoverageRate)
    || run.detailCoverageRate < 0
    || run.detailCoverageRate > 1
    || !Number.isFinite(run.revenueCoverageRate)
    || run.revenueCoverageRate < 0
    || run.revenueCoverageRate > 1
  ) return false;

  const statuses = new Map();
  for (let index = 0; index < run.resultStatuses.length; index += 1) {
    const ordinal = index + 1;
    const result = run.resultStatuses[index];
    if (
      !isPlainObject(result)
      || result.ordinal !== ordinal
      || result.rank !== ordinal
      || !KEY_PATTERN.test(String(result.companyKey || ""))
      || !RESILIENT_DETAIL_STATUSES.has(result.status)
      || statuses.has(result.companyKey)
    ) return false;
    statuses.set(result.companyKey, result.status);
  }
  const statusCount = (status) => [...statuses.values()].filter((value) => value === status).length;
  if (
    run.readyCount !== statusCount("ready")
    || run.zeroCount !== statusCount("zero")
    || run.partialCount !== statusCount("partial")
    || run.blockedCount !== statusCount("blocked")
    || run.failedCount !== statusCount("failed")
    || run.notCollectedCount !== statusCount("not_collected")
    || run.missingCount !== statusCount("missing")
  ) return false;
  const detailReadyCompanyCount = run.readyCount + run.zeroCount;
  if (
    run.detailReadyCompanyCount !== detailReadyCompanyCount
    || run.detailCoverageRate !== detailReadyCompanyCount / 20
  ) return false;

  const companyByKey = new Map();
  for (let index = 0; index < companies.length; index += 1) {
    const ordinal = index + 1;
    const company = companies[index];
    if (
      !isPlainObject(company)
      || company.runId !== record.runId
      || company.artifactHash !== record.artifactHash
      || company.ordinal !== ordinal
      || company.rank !== ordinal
      || company.detailCollectionStatus !== company.status
      || statuses.get(company.companyKey) !== company.status
      || company.collectionStatus !== run.collectionStatus
      || !KEY_PATTERN.test(String(company.companyKey || ""))
      || !KEY_PATTERN.test(String(company.regionKey || ""))
      || !KEY_PATTERN.test(String(company.placeId || ""))
      || typeof company.displayName !== "string"
      || !company.displayName
      || typeof company.bookingBusinessIdSource !== "string"
      || company.bookingBusinessIdSource.length > 64
      || typeof company.revenueInputValid !== "boolean"
      || companyByKey.has(company.companyKey)
    ) return false;
    companyByKey.set(company.companyKey, company);
  }

  const productKeys = new Set();
  const productCounts = new Map([...statuses.keys()].map((companyKey) => [companyKey, 0]));
  for (const product of products) {
    const company = companyByKey.get(product?.companyKey);
    if (
      !isPlainObject(product)
      || product.runId !== record.runId
      || product.artifactHash !== record.artifactHash
      || !company
      || !["ready", "partial"].includes(company.status)
      || product.status !== company.status
      || product.projectionKind !== "inventory_summary"
      || !new Set(["overnight", "day_use"]).has(product.stayType)
      || product.ordinal !== company.ordinal
      || product.rank !== company.rank
      || !KEY_PATTERN.test(String(product.productKey || ""))
      || productKeys.has(product.productKey)
      || !isSafeNonNegativeInteger(product.sourceProductCount)
      || product.sourceProductCount < 1
      || !isSafeNonNegativeInteger(product.price)
      || !isSafeNonNegativeInteger(product.availableUnits)
    ) return false;
    if (company.status === "partial" && company.revenueInputValid !== true) return false;
    productKeys.add(product.productKey);
    productCounts.set(company.companyKey, productCounts.get(company.companyKey) + 1);
  }
  for (const [companyKey, status] of statuses.entries()) {
    if (status === "ready" && productCounts.get(companyKey) < 1) return false;
    if (["zero", "blocked", "failed", "not_collected", "missing"].includes(status) && productCounts.get(companyKey) !== 0) return false;
  }

  const revenueKeys = new Set();
  const revenueByCompany = new Map();
  for (const revenue of revenues) {
    const company = companyByKey.get(revenue?.companyKey);
    if (
      !isPlainObject(revenue)
      || revenue.runId !== record.runId
      || revenue.artifactHash !== record.artifactHash
      || !company
      || company.revenueInputValid !== true
      || !["ready", "zero", "partial"].includes(company.status)
      || revenue.status !== company.status
      || revenue.ordinal !== company.ordinal
      || revenue.rank !== company.rank
      || revenue.currency !== "KRW"
      || !isSafeNonNegativeInteger(revenue.estimatedRevenue)
      || !isSafeNonNegativeInteger(revenue.estimatedSoldUnits)
      || !KEY_PATTERN.test(String(revenue.projectionId || ""))
      || revenueKeys.has(revenue.projectionId)
      || revenueByCompany.has(revenue.companyKey)
      || revenue.status === "zero" && (revenue.estimatedRevenue !== 0 || revenue.estimatedSoldUnits !== 0)
    ) return false;
    revenueKeys.add(revenue.projectionId);
    revenueByCompany.set(revenue.companyKey, revenue);
  }
  if (run.revenueReadyCompanyCount !== [...companyByKey.values()].filter((company) => company.revenueInputValid === true).length) return false;
  if (run.revenueCoverageRate !== run.revenueReadyCompanyCount / 20) return false;

  const observationIds = new Set();
  const historyCompanies = new Set();
  for (const observation of history) {
    const revenue = revenueByCompany.get(observation?.companyKey);
    if (
      !isPlainObject(observation)
      || observation.runId !== record.runId
      || observation.artifactHash !== record.artifactHash
      || !revenue
      || observation.ordinal !== revenue.ordinal
      || observation.rank !== revenue.rank
      || observation.status !== revenue.status
      || !HASH_PATTERN.test(String(observation.observationId || ""))
      || observationIds.has(observation.observationId)
      || historyCompanies.has(observation.companyKey)
      || observation.currency !== "KRW"
      || !Number.isFinite(Date.parse(observation.observedAt))
    ) return false;
    observationIds.add(observation.observationId);
    historyCompanies.add(observation.companyKey);
  }
  if (historyCompanies.size !== revenueByCompany.size) return false;
  if (new Set(companies.map((entry) => entry.projectionId)).size !== companies.length) return false;
  if (
    run.collectionStatus === "complete" && detailReadyCompanyCount !== 20
    || run.collectionStatus === "partial" && (detailReadyCompanyCount < 1 || detailReadyCompanyCount >= 20)
    || run.collectionStatus === "rank_only" && (detailReadyCompanyCount !== 0 || products.length !== 0 || revenues.length !== 0 || history.length !== 0)
  ) return false;
  return sha256Hex(stableSerialize(record.projections)) === record.projectionsHash;
}

function runOutputProjectionsValid(record) {
  const version = record?.projections?.run?.schemaVersion;
  if (version === COLLECTION_WORKER_V2_TOP20_PROJECTION_SCHEMA_VERSION_V1) {
    return runOutputProjectionsV1Valid(record);
  }
  if (version === COLLECTION_WORKER_V2_TOP20_PROJECTION_SCHEMA_VERSION) {
    return runOutputProjectionsV2Valid(record);
  }
  return false;
}

function runOutputRecordValid(record, expectedState) {
  try {
    if (!isPlainObject(record)) return false;
    if (record.documentType !== COLLECTION_WORKER_RUN_OUTPUT_TRANSACTION_DOCUMENT_TYPE) return false;
    if (record.schemaVersion !== COLLECTION_WORKER_RUN_OUTPUT_TRANSACTION_SCHEMA_VERSION) return false;
    if (record.state !== expectedState) return false;
    if (!HASH_PATTERN.test(record.transactionId) || !HASH_PATTERN.test(record.artifactHash)) return false;
    if (!HASH_PATTERN.test(record.contractHash) || !HASH_PATTERN.test(record.executionIdentityHash)) return false;
    if (
      !HASH_PATTERN.test(record.stageHash)
      || !HASH_PATTERN.test(record.outputTreeHash)
      || !HASH_PATTERN.test(record.projectionsHash)
    ) return false;
    if (!ID_PATTERN.test(record.jobId) || !/^preview-worker-run-[a-f0-9]{20}$/u.test(record.runId)) return false;
    if (record.finalRelativePath !== `outputs/${record.runId}`) return false;
    if (!Number.isFinite(Date.parse(record.createdAt))) return false;
    if (!Array.isArray(record.fileEntries)) return false;
    const minimumFiles = 1 + V2_TOP20_REQUIRED_CSV_ROLES.length;
    if (record.fileEntries.length < minimumFiles || record.fileEntries.length > minimumFiles + 24) return false;
    const paths = new Set();
    for (const file of record.fileEntries) {
      if (!isPlainObject(file) || !SAFE_OUTPUT_RELATIVE_PATH_PATTERN.test(file.path)) return false;
      if (paths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) return false;
      if (!HASH_PATTERN.test(file.sha256)) return false;
      paths.add(file.path);
    }
    if (!paths.has("manifest.json")) return false;
    if (V2_TOP20_REQUIRED_CSV_ROLES.some((role) => !paths.has(`${role}.csv`))) return false;
    if (sha256Hex(stableSerialize(record.fileEntries)) !== record.outputTreeHash) return false;
    if (!runOutputProjectionsValid(record)) return false;
    const expectedStageHash = sha256Hex(stableSerialize({
      transactionId: record.transactionId,
      artifactHash: record.artifactHash,
      jobId: record.jobId,
      contractHash: record.contractHash,
      executionIdentityHash: record.executionIdentityHash,
      runId: record.runId,
      finalRelativePath: record.finalRelativePath,
      outputTreeHash: record.outputTreeHash,
      projectionsHash: record.projectionsHash,
    }));
    if (expectedStageHash !== record.stageHash) return false;
    if (expectedState === "staged") return record.transactionRevision === STAGE_REVISION;
    if (record.transactionRevision !== COMMIT_REVISION || !Number.isFinite(Date.parse(record.committedAt))) return false;
    return isPlainObject(record.commitMarker)
      && record.commitMarker.transactionId === record.transactionId
      && record.commitMarker.stageHash === record.stageHash
      && record.commitMarker.outputTreeHash === record.outputTreeHash
      && record.commitMarker.projectionsHash === record.projectionsHash
      && record.commitMarker.runId === record.runId
      && record.commitMarker.committedAt === record.committedAt;
  } catch {
    return false;
  }
}

function validateRunOutputStageRecord(record) {
  return runOutputRecordValid(record, "staged");
}

function validateRunOutputCommitRecord(record) {
  return runOutputRecordValid(record, "committed");
}

function sameRunOutputTransaction(existing, candidate) {
  return existing.transactionId === candidate.transactionId
    && existing.artifactHash === candidate.artifactHash
    && existing.jobId === candidate.jobId
    && existing.contractHash === candidate.contractHash
    && existing.executionIdentityHash === candidate.executionIdentityHash
    && existing.stageHash === candidate.stageHash
    && existing.outputTreeHash === candidate.outputTreeHash
    && existing.projectionsHash === candidate.projectionsHash
    && existing.runId === candidate.runId;
}

function runOutputReceipt(record, reused, outputValid) {
  return Object.freeze({
    transactionId: record.transactionId,
    transactionRevision: record.transactionRevision,
    state: record.state,
    runId: record.runId,
    artifactHash: record.artifactHash,
    stageHash: record.stageHash,
    outputTreeHash: record.outputTreeHash,
    projectionsHash: record.projectionsHash,
    finalRelativePath: record.finalRelativePath,
    fileCount: record.fileEntries.length,
    companyProjectionCount: record.projections.companies.length,
    productProjectionCount: record.projections.products.length,
    revenueProjectionCount: record.projections.revenues.length,
    historyProjectionCount: record.projections.history.length,
    reused: reused === true,
    outputValid: outputValid === true,
  });
}

function buildProjections(verified, transactionId, runId) {
  const payload = verified.payload;
  const resultStatuses = payload.results.map((result) => Object.freeze({
    ordinal: result.ordinal,
    rank: result.rank,
    companyKey: result.company.companyKey,
    status: result.status,
  }));
  const run = Object.freeze({
    runId,
    transactionId,
    artifactHash: verified.artifactHash,
    jobId: verified.jobId,
    contractHash: verified.contractHash,
    executionIdentityHash: verified.executionIdentityHash,
    schemaVersion: payload.schemaVersion,
    status: "ready",
    measurementPeriod: payload.measurementPeriod,
    collectedAt: payload.collectedAt,
    resultCount: 20,
    readyCount: resultStatuses.filter((result) => result.status === "ready").length,
    zeroCount: resultStatuses.filter((result) => result.status === "zero").length,
    resultStatuses,
  });
  const companies = payload.results.map((result) => Object.freeze({
    projectionId: `${runId}:company:${result.company.companyKey}`,
    runId,
    artifactHash: verified.artifactHash,
    ordinal: result.ordinal,
    rank: result.rank,
    status: result.status,
    ...result.company,
  }));
  const products = payload.results.flatMap((result) => result.products.map((product) => Object.freeze({
    projectionId: `${runId}:product:${product.productKey}`,
    runId,
    artifactHash: verified.artifactHash,
    companyKey: result.company.companyKey,
    ordinal: result.ordinal,
    rank: result.rank,
    ...product,
  })));
  const revenues = payload.results.map((result) => Object.freeze({
    projectionId: `${runId}:revenue:${result.company.companyKey}`,
    runId,
    artifactHash: verified.artifactHash,
    companyKey: result.company.companyKey,
    ordinal: result.ordinal,
    rank: result.rank,
    ...result.revenue,
  }));
  const history = payload.results.map((result) => Object.freeze({
    observationId: sha256Hex(
      `collection-worker-history.v1\0${runId}\0${result.company.companyKey}\0${result.provenance.observedAt}`,
    ),
    runId,
    artifactHash: verified.artifactHash,
    companyKey: result.company.companyKey,
    ordinal: result.ordinal,
    rank: result.rank,
    status: result.status,
    estimatedRevenue: result.revenue.estimatedRevenue,
    estimatedSoldUnits: result.revenue.estimatedSoldUnits,
    currency: result.revenue.currency,
    source: result.provenance.source,
    observedAt: result.provenance.observedAt,
  }));
  return Object.freeze({
    run,
    companies: Object.freeze(companies),
    products: Object.freeze(products),
    revenues: Object.freeze(revenues),
    history: Object.freeze(history),
  });
}

function computeTransactionIdentity(verified) {
  const transactionId = sha256Hex(
    `collection-worker-run-transaction.v1\0${verified.jobId}`,
  );
  return Object.freeze({
    transactionId,
    runId: `worker-run-${transactionId.slice(0, 20)}`,
  });
}

function buildStageRecord(verified, now) {
  const { transactionId, runId } = computeTransactionIdentity(verified);
  const projections = buildProjections(verified, transactionId, runId);
  const projectionsHash = sha256Hex(stableSerialize(projections));
  const stageHash = sha256Hex(stableSerialize({
    transactionId,
    artifactHash: verified.artifactHash,
    jobId: verified.jobId,
    contractHash: verified.contractHash,
    executionIdentityHash: verified.executionIdentityHash,
    runId,
    projectionsHash,
  }));
  return Object.freeze({
    documentType: COLLECTION_WORKER_RUN_TRANSACTION_DOCUMENT_TYPE,
    schemaVersion: COLLECTION_WORKER_RUN_TRANSACTION_SCHEMA_VERSION,
    state: "staged",
    transactionId,
    transactionRevision: STAGE_REVISION,
    artifactHash: verified.artifactHash,
    jobId: verified.jobId,
    contractHash: verified.contractHash,
    executionIdentityHash: verified.executionIdentityHash,
    runId,
    stageHash,
    projectionsHash,
    createdAt: now,
    projections,
  });
}

function transactionRecordValid(record, expectedState) {
  try {
    if (!isPlainObject(record)) return false;
    if (record.documentType !== COLLECTION_WORKER_RUN_TRANSACTION_DOCUMENT_TYPE) return false;
    if (record.schemaVersion !== COLLECTION_WORKER_RUN_TRANSACTION_SCHEMA_VERSION) return false;
    if (record.state !== expectedState) return false;
    if (!HASH_PATTERN.test(record.transactionId) || !HASH_PATTERN.test(record.artifactHash)) return false;
    if (!HASH_PATTERN.test(record.contractHash) || !HASH_PATTERN.test(record.executionIdentityHash)) return false;
    if (!HASH_PATTERN.test(record.stageHash) || !HASH_PATTERN.test(record.projectionsHash)) return false;
    if (!ID_PATTERN.test(record.jobId) || !/^worker-run-[a-f0-9]{20}$/u.test(record.runId)) return false;
    if (!Number.isFinite(Date.parse(record.createdAt))) return false;
    if (!isPlainObject(record.projections) || !isPlainObject(record.projections.run)) return false;
    const { run, companies, products, revenues, history } = record.projections;
    if (run.runId !== record.runId || run.transactionId !== record.transactionId) return false;
    if (run.artifactHash !== record.artifactHash || run.resultCount !== 20) return false;
    if (!Array.isArray(run.resultStatuses) || run.resultStatuses.length !== 20) return false;
    if (!Array.isArray(companies) || companies.length !== 20) return false;
    if (!Array.isArray(products) || !Array.isArray(revenues) || revenues.length !== 20) return false;
    if (!Array.isArray(history) || history.length !== 20) return false;
    const statuses = new Map();
    for (let index = 0; index < run.resultStatuses.length; index += 1) {
      const ordinal = index + 1;
      const status = run.resultStatuses[index];
      if (
        status.ordinal !== ordinal
        || status.rank !== ordinal
        || !LEGACY_TERMINAL_RESULT_STATUSES.has(status.status)
        || statuses.has(status.companyKey)
      ) return false;
      statuses.set(status.companyKey, status.status);
    }
    if (
      run.readyCount !== [...statuses.values()].filter((status) => status === "ready").length
      || run.zeroCount !== [...statuses.values()].filter((status) => status === "zero").length
      || run.readyCount + run.zeroCount !== 20
    ) return false;
    for (let index = 0; index < companies.length; index += 1) {
      const ordinal = index + 1;
      const company = companies[index];
      if (
        company.ordinal !== ordinal
        || company.rank !== ordinal
        || statuses.get(company.companyKey) !== company.status
      ) return false;
    }
    for (const product of products) {
      if (
        product.status !== "ready"
        || statuses.get(product.companyKey) !== "ready"
        || !Number.isInteger(product.ordinal)
        || product.ordinal < 1
        || product.ordinal > 20
        || product.rank !== product.ordinal
      ) return false;
    }
    for (let index = 0; index < revenues.length; index += 1) {
      const ordinal = index + 1;
      const revenue = revenues[index];
      if (
        revenue.ordinal !== ordinal
        || revenue.rank !== ordinal
        || statuses.get(revenue.companyKey) !== revenue.status
        || revenue.currency !== "KRW"
      ) return false;
      if (revenue.status === "zero" && (revenue.estimatedRevenue !== 0 || revenue.estimatedSoldUnits !== 0)) {
        return false;
      }
    }
    for (let index = 0; index < history.length; index += 1) {
      const ordinal = index + 1;
      const observation = history[index];
      if (
        observation.ordinal !== ordinal
        || observation.rank !== ordinal
        || statuses.get(observation.companyKey) !== observation.status
        || !HASH_PATTERN.test(observation.observationId)
      ) return false;
    }
    if (new Set(companies.map((entry) => entry.projectionId)).size !== companies.length) return false;
    if (new Set(products.map((entry) => entry.projectionId)).size !== products.length) return false;
    if (new Set(revenues.map((entry) => entry.projectionId)).size !== revenues.length) return false;
    if (new Set(history.map((entry) => entry.observationId)).size !== history.length) return false;
    if ([...companies, ...products, ...revenues, ...history].some((entry) => entry.runId !== record.runId)) return false;
    if (sha256Hex(stableSerialize(record.projections)) !== record.projectionsHash) return false;
    const expectedStageHash = sha256Hex(stableSerialize({
      transactionId: record.transactionId,
      artifactHash: record.artifactHash,
      jobId: record.jobId,
      contractHash: record.contractHash,
      executionIdentityHash: record.executionIdentityHash,
      runId: record.runId,
      projectionsHash: record.projectionsHash,
    }));
    if (expectedStageHash !== record.stageHash) return false;
    if (expectedState === "staged") return record.transactionRevision === STAGE_REVISION;
    if (record.transactionRevision !== COMMIT_REVISION || !Number.isFinite(Date.parse(record.committedAt))) return false;
    if (!isPlainObject(record.commitMarker)) return false;
    return record.commitMarker.transactionId === record.transactionId
      && record.commitMarker.stageHash === record.stageHash
      && record.commitMarker.projectionsHash === record.projectionsHash
      && record.commitMarker.committedAt === record.committedAt;
  } catch {
    return false;
  }
}

function validateStageRecord(record) {
  return transactionRecordValid(record, "staged");
}

function validateCommitRecord(record) {
  return transactionRecordValid(record, "committed");
}

function sameTransaction(existing, candidate) {
  return existing.transactionId === candidate.transactionId
    && existing.artifactHash === candidate.artifactHash
    && existing.jobId === candidate.jobId
    && existing.contractHash === candidate.contractHash
    && existing.executionIdentityHash === candidate.executionIdentityHash
    && existing.stageHash === candidate.stageHash
    && existing.projectionsHash === candidate.projectionsHash;
}

function receipt(record, reused) {
  return Object.freeze({
    transactionId: record.transactionId,
    transactionRevision: record.transactionRevision,
    state: record.state,
    runId: record.runId,
    artifactHash: record.artifactHash,
    stageHash: record.stageHash,
    projectionsHash: record.projectionsHash,
    resultCount: record.projections.run.resultCount,
    companyProjectionCount: record.projections.companies.length,
    productProjectionCount: record.projections.products.length,
    revenueProjectionCount: record.projections.revenues.length,
    historyProjectionCount: record.projections.history.length,
    reused: reused === true,
  });
}

async function readOptionalJson(store, filePath, validator) {
  try {
    return await store.readJsonFile(filePath, { validator });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function listRecords(store, directory, validator) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const records = [];
  for (const fileName of files) {
    records.push(await store.readJsonFile(path.join(directory, fileName), { validator }));
  }
  return records;
}

function createCollectionWorkerRunTransactionStore(options = {}) {
  if (!options.runtimeRoot || !path.isAbsolute(String(options.runtimeRoot))) {
    throw new TypeError("collection run transaction requires an absolute runtime root");
  }
  const runtimeRoot = path.resolve(String(options.runtimeRoot || ""));
  const journalRoot = resolveRuntimePath(runtimeRoot, "collector_worker", "run_transactions");
  const stagedRoot = path.join(journalRoot, "staged");
  const committedRoot = path.join(journalRoot, "committed");
  const runOutputJournalRoot = resolveRuntimePath(runtimeRoot, "collector_worker", "run_output_transactions");
  const runOutputStagedRoot = path.join(runOutputJournalRoot, "staged");
  const runOutputCommittedRoot = path.join(runOutputJournalRoot, "committed");
  const runOutputStagingRoot = resolveRuntimePath(runtimeRoot, "collector_worker", "run_output_staging");
  const outputsRoot = resolveRuntimePath(runtimeRoot, "outputs");
  const store = options.store || sharedSecureStore;
  const faultInjector = typeof options.faultInjector === "function" ? options.faultInjector : null;
  const nowProvider = typeof options.now === "function" ? options.now : () => new Date();

  function stagePath(transactionId) {
    return path.join(stagedRoot, `${expectedText(transactionId, HASH_PATTERN, "transactionId")}.json`);
  }

  function commitPath(transactionId) {
    return path.join(committedRoot, `${expectedText(transactionId, HASH_PATTERN, "transactionId")}.json`);
  }

  function runOutputStageJournalPath(transactionId) {
    return path.join(
      runOutputStagedRoot,
      `${expectedText(transactionId, HASH_PATTERN, "transactionId")}.json`,
    );
  }

  function runOutputCommitMarkerPath(transactionId) {
    return path.join(
      runOutputCommittedRoot,
      `${expectedText(transactionId, HASH_PATTERN, "transactionId")}.json`,
    );
  }

  function runOutputStagingPath(transactionId) {
    return path.join(
      runOutputStagingRoot,
      expectedText(transactionId, HASH_PATTERN, "transactionId"),
    );
  }

  function finalRunOutputPath(runId) {
    const normalizedRunId = expectedText(runId, ID_PATTERN, "runId");
    if (!/^preview-worker-run-[a-f0-9]{20}$/u.test(normalizedRunId)) {
      fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "Preview run identity is invalid", 400);
    }
    return path.join(outputsRoot, normalizedRunId);
  }

  async function inject(point, context) {
    if (faultInjector) await faultInjector(point, clone(context));
  }

  async function pathKind(target) {
    try {
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) return "symlink";
      if (stat.isDirectory()) return "directory";
      if (stat.isFile()) return "file";
      return "other";
    } catch (error) {
      if (error?.code === "ENOENT") return "missing";
      throw error;
    }
  }

  async function listOutputTreeFiles(root) {
    const files = [];
    async function visit(directory) {
      const entries = await fsp.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const target = path.join(directory, entry.name);
        const relative = path.relative(root, target).replaceAll("\\", "/");
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "Preview output escaped its root", 500);
        }
        if (entry.isSymbolicLink()) {
          fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "Preview output cannot contain a symbolic link", 500);
        }
        if (entry.isDirectory()) await visit(target);
        else if (entry.isFile()) files.push(relative);
        else fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "Preview output contains an invalid entry", 500);
      }
    }
    await visit(root);
    return files.sort();
  }

  async function assertRunOutputTree(root, record) {
    if (await pathKind(root) !== "directory") {
      fail("COLLECTION_RUN_OUTPUT_NOT_FOUND", "Preview run output is not available", 404);
    }
    const expectedPaths = record.fileEntries.map((entry) => entry.path).sort();
    const actualPaths = await listOutputTreeFiles(root);
    if (stableSerialize(actualPaths) !== stableSerialize(expectedPaths)) {
      fail("COLLECTION_RUN_OUTPUT_HASH_MISMATCH", "Preview run output file set is invalid", 409);
    }
    for (const entry of record.fileEntries) {
      const target = path.resolve(root, entry.path);
      const relative = path.relative(root, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "Preview run output escaped its root", 500);
      }
      const content = await fsp.readFile(target);
      if (content.length !== entry.size || sha256Hex(content) !== entry.sha256) {
        fail("COLLECTION_RUN_OUTPUT_HASH_MISMATCH", "Preview run output integrity check failed", 409);
      }
    }
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(path.join(root, "manifest.json"), "utf8"));
    } catch {
      fail("COLLECTION_RUN_OUTPUT_HASH_MISMATCH", "Preview run manifest is invalid", 409);
    }
    if (
      manifest.runId !== record.runId
      || manifest.outputDir !== record.finalRelativePath
      || manifest.transactionId !== record.transactionId
      || manifest.previewOwnedStorageIdentity !== true
      || manifest.workerArtifactHash !== record.artifactHash
    ) {
      fail("COLLECTION_RUN_OUTPUT_HASH_MISMATCH", "Preview run manifest identity is invalid", 409);
    }
    return true;
  }

  async function writeRunOutputTree(tempRoot, outputFiles) {
    await fsp.mkdir(tempRoot, { recursive: false, mode: 0o700 });
    for (const file of outputFiles) {
      const target = path.resolve(tempRoot, file.path);
      const relative = path.relative(tempRoot, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "Preview staging path escaped its root", 500);
      }
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await fsp.open(target, "wx", 0o600);
      try {
        await handle.writeFile(file.content);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }

  async function cleanupRunOutputTemps(transactionId) {
    let entries;
    try {
      entries = await fsp.readdir(runOutputStagingRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const prefix = `.${expectedText(transactionId, HASH_PATTERN, "transactionId")}.`;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) continue;
      const target = path.resolve(runOutputStagingRoot, entry.name);
      const relative = path.relative(runOutputStagingRoot, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        fail("COLLECTION_RUN_OUTPUT_PATH_INVALID", "Preview staging cleanup escaped its root", 500);
      }
      await fsp.rm(target, { recursive: true, force: true });
    }
  }

  async function ensureRunOutputStaged(candidate, outputFiles) {
    const record = candidate;
    const finalPath = finalRunOutputPath(record.runId);
    if (await pathKind(finalPath) !== "missing") {
      await assertRunOutputTree(finalPath, record);
      return "renamed_uncommitted";
    }
    const stagingPath = runOutputStagingPath(record.transactionId);
    if (await pathKind(stagingPath) !== "missing") {
      await assertRunOutputTree(stagingPath, record);
      return "staged";
    }
    await fsp.mkdir(runOutputStagingRoot, { recursive: true, mode: 0o700 });
    const tempPath = path.join(
      runOutputStagingRoot,
      `.${record.transactionId}.${crypto.randomBytes(12).toString("hex")}.tmp`,
    );
    await inject("before_run_stage_write", record);
    await writeRunOutputTree(tempPath, outputFiles);
    await inject("after_run_stage_files_before_rename", record);
    try {
      await fsp.rename(tempPath, stagingPath);
    } catch (error) {
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error?.code)) throw error;
      await assertRunOutputTree(stagingPath, record);
      await fsp.rm(tempPath, { recursive: true, force: true }).catch(() => {});
    }
    await assertRunOutputTree(stagingPath, record);
    await inject("after_run_stage_rename_before_journal", record);
    return "staged";
  }

  async function stageVerifiedArtifact(input = {}) {
    const verified = decodeVerifiedTop20Artifact(input);
    const now = instant(input.now || nowProvider(), "now");
    const candidate = buildStageRecord(verified, now);
    const committed = await readOptionalJson(store, commitPath(candidate.transactionId), validateCommitRecord);
    if (committed) {
      if (!sameTransaction(committed, candidate)) {
        fail("COLLECTION_RUN_TRANSACTION_CONFLICT", "execution identity already has a different artifact", 409);
      }
      return receipt(committed, true);
    }
    const existing = await readOptionalJson(store, stagePath(candidate.transactionId), validateStageRecord);
    if (existing) {
      if (!sameTransaction(existing, candidate)) {
        fail("COLLECTION_RUN_TRANSACTION_CONFLICT", "execution identity already has a different artifact", 409);
      }
      return receipt(existing, true);
    }
    await inject("before_stage_write", candidate);
    try {
      await store.atomicWriteJson(stagePath(candidate.transactionId), candidate, {
        validator: validateStageRecord,
        noReplace: true,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const raced = await store.readJsonFile(stagePath(candidate.transactionId), { validator: validateStageRecord });
      if (!sameTransaction(raced, candidate)) {
        fail("COLLECTION_RUN_TRANSACTION_CONFLICT", "execution identity already has a different artifact", 409);
      }
      return receipt(raced, true);
    }
    await inject("after_stage_write_before_response", candidate);
    return receipt(candidate, false);
  }

  async function commitStagedTransaction(input = {}) {
    const transactionId = expectedText(input.transactionId, HASH_PATTERN, "transactionId");
    const artifactHash = expectedText(input.artifactHash, HASH_PATTERN, "artifactHash");
    const expectedTransactionRevision = positiveInteger(
      input.expectedTransactionRevision,
      "expectedTransactionRevision",
    );
    const existingCommit = await readOptionalJson(store, commitPath(transactionId), validateCommitRecord);
    if (existingCommit) {
      if (existingCommit.artifactHash !== artifactHash) {
        fail("COLLECTION_RUN_TRANSACTION_CONFLICT", "transaction already has a different artifact", 409);
      }
      return receipt(existingCommit, true);
    }
    const staged = await readOptionalJson(store, stagePath(transactionId), validateStageRecord);
    if (!staged) fail("COLLECTION_RUN_TRANSACTION_NOT_FOUND", "staged transaction was not found", 404);
    if (staged.artifactHash !== artifactHash) {
      fail("COLLECTION_RUN_TRANSACTION_CONFLICT", "staged transaction has a different artifact", 409);
    }
    if (staged.transactionRevision !== expectedTransactionRevision) {
      fail("COLLECTION_RUN_TRANSACTION_REVISION_CONFLICT", "transaction revision is stale", 409);
    }
    const committedAt = instant(input.now || nowProvider(), "now");
    const committed = Object.freeze({
      ...staged,
      state: "committed",
      transactionRevision: COMMIT_REVISION,
      committedAt,
      commitMarker: Object.freeze({
        transactionId,
        stageHash: staged.stageHash,
        projectionsHash: staged.projectionsHash,
        committedAt,
      }),
    });
    await inject("before_commit_marker", committed);
    try {
      await store.atomicWriteJson(commitPath(transactionId), committed, {
        validator: validateCommitRecord,
        noReplace: true,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const raced = await store.readJsonFile(commitPath(transactionId), { validator: validateCommitRecord });
      if (!sameTransaction(raced, committed)) {
        fail("COLLECTION_RUN_TRANSACTION_CONFLICT", "transaction commit marker conflicts", 409);
      }
      return receipt(raced, true);
    }
    await inject("after_commit_marker_before_response", committed);
    return receipt(committed, false);
  }

  async function finalizeVerifiedArtifact(input = {}) {
    const staged = await stageVerifiedArtifact(input);
    if (staged.state === "committed") return staged;
    return commitStagedTransaction({
      transactionId: staged.transactionId,
      artifactHash: staged.artifactHash,
      expectedTransactionRevision: staged.transactionRevision,
      now: input.now,
    });
  }

  async function stageVerifiedRunBundle(input = {}) {
    const verified = decodeVerifiedV2RunArtifact(input);
    const now = instant(input.now || nowProvider(), "now");
    const built = buildRunOutputStageRecord(verified, now);
    const candidate = built.record;
    return enqueueRunOutput(candidate.transactionId, async () => {
      const committed = await readOptionalJson(
        store,
        runOutputCommitMarkerPath(candidate.transactionId),
        validateRunOutputCommitRecord,
      );
      if (committed) {
        if (!sameRunOutputTransaction(committed, candidate)) {
          fail("COLLECTION_RUN_OUTPUT_TRANSACTION_CONFLICT", "collection job already has a different artifact", 409);
        }
        await assertRunOutputTree(finalRunOutputPath(committed.runId), committed);
        await cleanupRunOutputTemps(committed.transactionId);
        return runOutputReceipt(committed, true, true);
      }

      const existing = await readOptionalJson(
        store,
        runOutputStageJournalPath(candidate.transactionId),
        validateRunOutputStageRecord,
      );
      if (existing && !sameRunOutputTransaction(existing, candidate)) {
        fail("COLLECTION_RUN_OUTPUT_TRANSACTION_CONFLICT", "collection job already has a different artifact", 409);
      }
      const stageRecord = existing || candidate;
      await ensureRunOutputStaged(stageRecord, built.outputFiles);
      let reused = Boolean(existing);
      if (!existing) {
        try {
          await store.atomicWriteJson(runOutputStageJournalPath(candidate.transactionId), candidate, {
            validator: validateRunOutputStageRecord,
            noReplace: true,
          });
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const raced = await store.readJsonFile(runOutputStageJournalPath(candidate.transactionId), {
            validator: validateRunOutputStageRecord,
          });
          if (!sameRunOutputTransaction(raced, candidate)) {
            fail("COLLECTION_RUN_OUTPUT_TRANSACTION_CONFLICT", "collection job already has a different artifact", 409);
          }
          reused = true;
        }
      }
      await inject("after_run_stage_journal_before_response", stageRecord);
      return runOutputReceipt(stageRecord, reused, false);
    });
  }

  async function commitStagedRunBundle(input = {}) {
    const transactionId = expectedText(input.transactionId, HASH_PATTERN, "transactionId");
    const artifactHash = expectedText(input.artifactHash, HASH_PATTERN, "artifactHash");
    const expectedTransactionRevision = positiveInteger(
      input.expectedTransactionRevision,
      "expectedTransactionRevision",
    );
    return enqueueRunOutput(transactionId, async () => {
    const existingCommit = await readOptionalJson(
      store,
      runOutputCommitMarkerPath(transactionId),
      validateRunOutputCommitRecord,
    );
    if (existingCommit) {
      if (existingCommit.artifactHash !== artifactHash) {
        fail("COLLECTION_RUN_OUTPUT_TRANSACTION_CONFLICT", "transaction already has a different artifact", 409);
      }
      await assertRunOutputTree(finalRunOutputPath(existingCommit.runId), existingCommit);
      await cleanupRunOutputTemps(existingCommit.transactionId);
      return runOutputReceipt(existingCommit, true, true);
    }
    const staged = await readOptionalJson(
      store,
      runOutputStageJournalPath(transactionId),
      validateRunOutputStageRecord,
    );
    if (!staged) {
      fail("COLLECTION_RUN_OUTPUT_TRANSACTION_NOT_FOUND", "staged run output transaction was not found", 404);
    }
    if (staged.artifactHash !== artifactHash) {
      fail("COLLECTION_RUN_OUTPUT_TRANSACTION_CONFLICT", "staged transaction has a different artifact", 409);
    }
    if (staged.transactionRevision !== expectedTransactionRevision) {
      fail("COLLECTION_RUN_OUTPUT_TRANSACTION_REVISION_CONFLICT", "run output transaction revision is stale", 409);
    }
    const finalPath = finalRunOutputPath(staged.runId);
    const stagingPath = runOutputStagingPath(transactionId);
    const finalKind = await pathKind(finalPath);
    if (finalKind === "missing") {
      if (await pathKind(stagingPath) !== "directory") {
        fail("COLLECTION_RUN_OUTPUT_NOT_FOUND", "staged Preview run output is missing", 409);
      }
      await assertRunOutputTree(stagingPath, staged);
      await fsp.mkdir(outputsRoot, { recursive: true, mode: 0o700 });
      await inject("before_run_output_rename", staged);
      try {
        await fsp.rename(stagingPath, finalPath);
      } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error?.code)) throw error;
        await assertRunOutputTree(finalPath, staged);
      }
    } else {
      await assertRunOutputTree(finalPath, staged);
    }
    await assertRunOutputTree(finalPath, staged);
    await inject("after_run_output_rename_before_marker", staged);

    const committedAt = instant(input.now || nowProvider(), "now");
    const committed = Object.freeze({
      ...staged,
      state: "committed",
      transactionRevision: COMMIT_REVISION,
      committedAt,
      commitMarker: Object.freeze({
        transactionId,
        stageHash: staged.stageHash,
        outputTreeHash: staged.outputTreeHash,
        projectionsHash: staged.projectionsHash,
        runId: staged.runId,
        committedAt,
      }),
    });
    try {
      await store.atomicWriteJson(runOutputCommitMarkerPath(transactionId), committed, {
        validator: validateRunOutputCommitRecord,
        noReplace: true,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const raced = await store.readJsonFile(runOutputCommitMarkerPath(transactionId), {
        validator: validateRunOutputCommitRecord,
      });
      if (!sameRunOutputTransaction(raced, committed)) {
        fail("COLLECTION_RUN_OUTPUT_TRANSACTION_CONFLICT", "run output commit marker conflicts", 409);
      }
      await assertRunOutputTree(finalPath, raced);
      await cleanupRunOutputTemps(raced.transactionId);
      return runOutputReceipt(raced, true, true);
    }
    await cleanupRunOutputTemps(committed.transactionId);
    await inject("after_run_commit_marker_before_response", committed);
    return runOutputReceipt(committed, false, true);
    });
  }

  async function finalizeVerifiedRunBundle(input = {}) {
    const staged = await stageVerifiedRunBundle(input);
    if (staged.state === "committed") return staged;
    return commitStagedRunBundle({
      transactionId: staged.transactionId,
      artifactHash: staged.artifactHash,
      expectedTransactionRevision: staged.transactionRevision,
      now: input.now,
    });
  }

  async function isRunOutputValid(input = {}) {
    try {
      let marker = null;
      if (input.transactionId) {
        marker = await readOptionalJson(
          store,
          runOutputCommitMarkerPath(input.transactionId),
          validateRunOutputCommitRecord,
        );
      } else if (input.runId) {
        const runId = expectedText(input.runId, ID_PATTERN, "runId");
        const markers = await listRecords(store, runOutputCommittedRoot, validateRunOutputCommitRecord);
        marker = markers.find((candidate) => candidate.runId === runId) || null;
      } else {
        return false;
      }
      if (!marker || input.runId && marker.runId !== input.runId) return false;
      await assertRunOutputTree(finalRunOutputPath(marker.runId), marker);
      return true;
    } catch {
      return false;
    }
  }

  async function readRunOutputJournal() {
    const staged = await listRecords(store, runOutputStagedRoot, validateRunOutputStageRecord);
    const committed = await listRecords(store, runOutputCommittedRoot, validateRunOutputCommitRecord);
    return Object.freeze({ staged: clone(staged), committed: clone(committed) });
  }

  async function readVisibleState() {
    const commits = await listRecords(store, committedRoot, validateCommitRecord);
    const runOutputCommits = await listRecords(
      store,
      runOutputCommittedRoot,
      validateRunOutputCommitRecord,
    );
    const runs = new Map();
    const companies = new Map();
    const products = new Map();
    const revenues = new Map();
    const history = new Map();
    function insert(map, key, value) {
      if (map.has(key)) {
        fail("COLLECTION_RUN_TRANSACTION_STORE_CORRUPT", "committed projection is duplicated", 500);
      }
      map.set(key, value);
    }
    for (const commit of commits) {
      insert(runs, commit.projections.run.runId, commit.projections.run);
      for (const value of commit.projections.companies) insert(companies, value.projectionId, value);
      for (const value of commit.projections.products) insert(products, value.projectionId, value);
      for (const value of commit.projections.revenues) insert(revenues, value.projectionId, value);
      for (const value of commit.projections.history) insert(history, value.observationId, value);
    }
    for (const commit of runOutputCommits) {
      await assertRunOutputTree(finalRunOutputPath(commit.runId), commit);
      insert(runs, commit.projections.run.runId, commit.projections.run);
      for (const value of commit.projections.companies) insert(companies, value.projectionId, value);
      for (const value of commit.projections.products) insert(products, value.projectionId, value);
      for (const value of commit.projections.revenues) insert(revenues, value.projectionId, value);
      for (const value of commit.projections.history) insert(history, value.observationId, value);
    }
    return Object.freeze({
      runs: Object.freeze([...runs.values()].map(clone)),
      companies: Object.freeze([...companies.values()].map(clone)),
      products: Object.freeze([...products.values()].map(clone)),
      revenues: Object.freeze([...revenues.values()].map(clone)),
      history: Object.freeze([...history.values()].map(clone)),
    });
  }

  async function readJournal() {
    const staged = await listRecords(store, stagedRoot, validateStageRecord);
    const committed = await listRecords(store, committedRoot, validateCommitRecord);
    return Object.freeze({ staged: clone(staged), committed: clone(committed) });
  }

  return Object.freeze({
    runtimeRoot,
    journalRoot,
    stagedRoot,
    committedRoot,
    runOutputJournalRoot,
    runOutputStagedRoot,
    runOutputCommittedRoot,
    runOutputStagingRoot,
    outputsRoot,
    stageVerifiedArtifact,
    commitStagedTransaction,
    finalizeVerifiedArtifact,
    stageVerifiedRunBundle,
    commitStagedRunBundle,
    finalizeVerifiedRunBundle,
    isCommittedRunOutputValid: isRunOutputValid,
    readRunOutputJournal,
    readVisibleState,
    readJournal,
  });
}

async function isCommittedRunOutputValid(input = {}) {
  const transactionStore = createCollectionWorkerRunTransactionStore({
    runtimeRoot: input.runtimeRoot,
    store: input.store,
  });
  return transactionStore.isCommittedRunOutputValid({
    transactionId: input.transactionId,
    runId: input.runId,
  });
}

module.exports = {
  COLLECTION_WORKER_RUN_OUTPUT_TRANSACTION_DOCUMENT_TYPE,
  COLLECTION_WORKER_RUN_OUTPUT_TRANSACTION_SCHEMA_VERSION,
  COLLECTION_WORKER_V2_TOP20_PROJECTION_SCHEMA_VERSION,
  COLLECTION_WORKER_RUN_TRANSACTION_DOCUMENT_TYPE,
  COLLECTION_WORKER_RUN_TRANSACTION_SCHEMA_VERSION,
  COLLECTION_WORKER_TOP20_RESULT_PATH,
  COLLECTION_WORKER_TOP20_RESULT_SCHEMA_VERSION,
  CollectionWorkerRunTransactionError,
  buildV2RunProjections,
  createCollectionWorkerRunTransactionStore,
  decodeVerifiedTop20Artifact,
  decodeVerifiedV2RunArtifact,
  isCommittedRunOutputValid,
  normalizeTop20Payload,
  validateRunOutputCommitRecord,
  validateRunOutputStageRecord,
  validateCommitRecord,
  validateStageRecord,
};
