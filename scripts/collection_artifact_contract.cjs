"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const COLLECTION_ARTIFACT_SCHEMA_VERSION = "collection-artifact-bundle.v1";
const COLLECTION_ARTIFACT_SIGNATURE_DOMAIN = "lodging-datalab.collection-artifact.v1";
const COLLECTION_ARTIFACT_LIMITS = Object.freeze({
  maxFiles: 32,
  maxFileBytes: 4 * 1024 * 1024,
  maxBundleBytes: 16 * 1024 * 1024,
  maxPathBytes: 240,
  maxPathSegmentBytes: 100,
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64URL_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const FORBIDDEN_PATH_TOKEN_PATTERN = /(?:^|[._-])(?:raw[._-]?(?:html|body|response)|html?|urls?|uris?|headers?|cookies?|credentials?|authorization|secrets?|tokens?|passwords?|api[._-]?keys?)(?:[._-]|$)/i;
const RAW_HTML_PATTERN = /<(?:!doctype\s+html|html|head|body|script)\b|window\.__APOLLO_STATE__/i;
const URL_PATTERN = /(?:https?|wss?):\/\/|(?:^|[\s"'=])www\./i;
const SENSITIVE_CONTENT_PATTERN = /(?:^|[\s"',])(?:raw[._-]?(?:html|body|response)|urls?|uris?|headers?|cookies?|credentials?|authorization|proxy-authorization|secrets?|client[._-]?secret|api[._-]?key|access[._-]?token|refresh[._-]?token|passwords?)["']?\s*[:,=]|\bbearer\s+[A-Za-z0-9._~-]+/im;

class CollectionArtifactContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CollectionArtifactContractError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CollectionArtifactContractError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value) {
  if (!isPlainObject(value)) {
    fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact object is invalid.");
  }
}

function assertExactKeys(value, expectedKeys) {
  assertPlainObject(value);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact fields are invalid.");
  }
}

function stableSerialize(value) {
  const seen = new Set();

  function normalize(current) {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact contains an invalid number.");
      }
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact contains a cycle.");
      }
      seen.add(current);
      const normalized = current.map(normalize);
      seen.delete(current);
      return normalized;
    }
    if (!isPlainObject(current)) {
      fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact contains an unsupported value.");
    }
    if (seen.has(current)) {
      fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact contains a cycle.");
    }
    seen.add(current);
    const normalized = {};
    for (const key of Object.keys(current).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact contains an unsafe field.");
      }
      if (typeof current[key] === "undefined" || typeof current[key] === "function" || typeof current[key] === "symbol") {
        fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact contains an unsupported value.");
      }
      normalized[key] = normalize(current[key]);
    }
    seen.delete(current);
    return normalized;
  }

  return JSON.stringify(normalize(value));
}

function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function validateIdentifier(value) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER_PATTERN.test(value)) {
    fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact identity is invalid.");
  }
  return value;
}

function validateSha256Identity(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact identity hash is invalid.");
  }
  return value;
}

function normalizeIdentity(identity) {
  assertExactKeys(identity, [
    "jobId",
    "attemptId",
    "workerId",
    "workerPoolId",
    "runtimeId",
    "contractHash",
    "executionIdentityHash",
  ]);
  return Object.freeze({
    jobId: validateIdentifier(identity.jobId),
    attemptId: validateIdentifier(identity.attemptId),
    workerId: validateIdentifier(identity.workerId),
    workerPoolId: validateIdentifier(identity.workerPoolId),
    runtimeId: validateIdentifier(identity.runtimeId),
    contractHash: validateSha256Identity(identity.contractHash),
    executionIdentityHash: validateSha256Identity(identity.executionIdentityHash),
  });
}

function validateArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("COLLECTION_ARTIFACT_PATH_INVALID", "Collection artifact path is invalid.");
  }
  if (value !== value.normalize("NFC") || Buffer.byteLength(value, "utf8") > COLLECTION_ARTIFACT_LIMITS.maxPathBytes) {
    fail("COLLECTION_ARTIFACT_PATH_INVALID", "Collection artifact path is invalid.");
  }
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    /%(?:2e|2f|5c)/i.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    path.posix.normalize(value) !== value
  ) {
    fail("COLLECTION_ARTIFACT_PATH_INVALID", "Collection artifact path is invalid.");
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > COLLECTION_ARTIFACT_LIMITS.maxPathSegmentBytes,
    )
  ) {
    fail("COLLECTION_ARTIFACT_PATH_INVALID", "Collection artifact path is invalid.");
  }
  if (FORBIDDEN_PATH_TOKEN_PATTERN.test(value)) {
    fail("COLLECTION_ARTIFACT_SENSITIVE_CONTENT", "Collection artifact contains prohibited material.");
  }
  return value;
}

function toContentBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact file content is invalid.");
}

function rejectSensitiveContent(filePath, content) {
  const text = content.toString("utf8");
  if (
    /\.html?$/i.test(filePath) ||
    RAW_HTML_PATTERN.test(text) ||
    URL_PATTERN.test(text) ||
    SENSITIVE_CONTENT_PATTERN.test(text)
  ) {
    fail("COLLECTION_ARTIFACT_SENSITIVE_CONTENT", "Collection artifact contains prohibited material.");
  }
}

function assertFileAndBundleSize(size, runningTotal) {
  if (!Number.isSafeInteger(size) || size < 0 || size > COLLECTION_ARTIFACT_LIMITS.maxFileBytes) {
    fail("COLLECTION_ARTIFACT_OVERSIZE", "Collection artifact exceeds the allowed size.");
  }
  const total = runningTotal + size;
  if (!Number.isSafeInteger(total) || total > COLLECTION_ARTIFACT_LIMITS.maxBundleBytes) {
    fail("COLLECTION_ARTIFACT_OVERSIZE", "Collection artifact bundle exceeds the allowed size.");
  }
  return total;
}

function normalizeBuilderFiles(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > COLLECTION_ARTIFACT_LIMITS.maxFiles) {
    fail("COLLECTION_ARTIFACT_OVERSIZE", "Collection artifact file count is invalid.");
  }
  const paths = new Set();
  let totalBytes = 0;
  const normalizedFiles = files.map((file) => {
    assertExactKeys(file, ["path", "content"]);
    const filePath = validateArtifactPath(file.path);
    const duplicateKey = filePath.normalize("NFC").toLocaleLowerCase("en-US");
    if (paths.has(duplicateKey)) {
      fail("COLLECTION_ARTIFACT_DUPLICATE_PATH", "Collection artifact contains a duplicate path.");
    }
    paths.add(duplicateKey);
    const content = toContentBuffer(file.content);
    totalBytes = assertFileAndBundleSize(content.length, totalBytes);
    rejectSensitiveContent(filePath, content);
    return Object.freeze({
      path: filePath,
      size: content.length,
      sha256: sha256Hex(content),
      contentBase64: content.toString("base64"),
    });
  });
  return { files: Object.freeze(normalizedFiles), totalBytes };
}

function decodeCanonicalBase64(value, declaredSize) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((COLLECTION_ARTIFACT_LIMITS.maxFileBytes * 4) / 3) + 4 ||
    !BASE64_PATTERN.test(value)
  ) {
    fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact encoding is invalid.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== declaredSize || decoded.toString("base64") !== value) {
    fail("COLLECTION_ARTIFACT_HASH_MISMATCH", "Collection artifact file integrity check failed.");
  }
  return decoded;
}

function normalizeReceivedFiles(files, declaredFileCount, declaredTotalBytes) {
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > COLLECTION_ARTIFACT_LIMITS.maxFiles ||
    !Number.isSafeInteger(declaredFileCount) ||
    declaredFileCount !== files.length
  ) {
    fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact file count is invalid.");
  }
  const paths = new Set();
  let totalBytes = 0;
  const normalizedFiles = files.map((file) => {
    assertExactKeys(file, ["path", "size", "sha256", "contentBase64"]);
    const filePath = validateArtifactPath(file.path);
    const duplicateKey = filePath.normalize("NFC").toLocaleLowerCase("en-US");
    if (paths.has(duplicateKey)) {
      fail("COLLECTION_ARTIFACT_DUPLICATE_PATH", "Collection artifact contains a duplicate path.");
    }
    paths.add(duplicateKey);
    totalBytes = assertFileAndBundleSize(file.size, totalBytes);
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact file hash is invalid.");
    }
    const content = decodeCanonicalBase64(file.contentBase64, file.size);
    rejectSensitiveContent(filePath, content);
    if (!safeEqualAscii(sha256Hex(content), file.sha256)) {
      fail("COLLECTION_ARTIFACT_HASH_MISMATCH", "Collection artifact file integrity check failed.");
    }
    return Object.freeze({
      path: filePath,
      size: file.size,
      sha256: file.sha256,
      contentBase64: file.contentBase64,
    });
  });
  if (!Number.isSafeInteger(declaredTotalBytes) || declaredTotalBytes !== totalBytes) {
    fail("COLLECTION_ARTIFACT_HASH_MISMATCH", "Collection artifact bundle size check failed.");
  }
  return { files: Object.freeze(normalizedFiles), totalBytes };
}

function safeEqualAscii(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "ascii");
  const rightBytes = Buffer.from(right, "ascii");
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function computeBundleHash(bundleWithoutHash) {
  return sha256Hex(Buffer.from(stableSerialize(bundleWithoutHash), "utf8"));
}

function signaturePayload(bundle) {
  return Buffer.from(`${COLLECTION_ARTIFACT_SIGNATURE_DOMAIN}\n${stableSerialize(bundle)}`, "utf8");
}

function coercePrivateEd25519Key(value) {
  try {
    const key = value instanceof crypto.KeyObject ? value : crypto.createPrivateKey(value);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("invalid key");
    return key;
  } catch {
    fail("COLLECTION_ARTIFACT_KEY_INVALID", "Collection artifact signing key is invalid.");
  }
}

function coercePublicEd25519Key(value) {
  try {
    const key =
      value instanceof crypto.KeyObject && value.type === "public" ? value : crypto.createPublicKey(value);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("invalid key");
    return key;
  } catch {
    fail("COLLECTION_ARTIFACT_KEY_INVALID", "Collection artifact verification key is invalid.");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function buildCollectionArtifactBundle(input, options = {}) {
  assertExactKeys(input, ["identity", "files"]);
  assertExactKeys(options, ["privateKey", "keyId"]);
  const identity = normalizeIdentity(input.identity);
  const signingKeyId = validateIdentifier(options.keyId);
  const privateKey = coercePrivateEd25519Key(options.privateKey);
  const normalized = normalizeBuilderFiles(input.files);
  const baseBundle = {
    schemaVersion: COLLECTION_ARTIFACT_SCHEMA_VERSION,
    identity,
    signingKeyId,
    files: normalized.files,
    fileCount: normalized.files.length,
    totalBytes: normalized.totalBytes,
  };
  const bundle = {
    ...baseBundle,
    bundleHash: computeBundleHash(baseBundle),
  };
  const signature = crypto.sign(null, signaturePayload(bundle), privateKey).toString("base64url");
  return deepFreeze({ bundle, signature });
}

function normalizeReceivedBundle(value) {
  assertExactKeys(value, [
    "schemaVersion",
    "identity",
    "signingKeyId",
    "files",
    "fileCount",
    "totalBytes",
    "bundleHash",
  ]);
  if (value.schemaVersion !== COLLECTION_ARTIFACT_SCHEMA_VERSION) {
    fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact schema is unsupported.");
  }
  const identity = normalizeIdentity(value.identity);
  const signingKeyId = validateIdentifier(value.signingKeyId);
  const normalized = normalizeReceivedFiles(value.files, value.fileCount, value.totalBytes);
  if (typeof value.bundleHash !== "string" || !SHA256_PATTERN.test(value.bundleHash)) {
    fail("COLLECTION_ARTIFACT_CONTRACT_INVALID", "Collection artifact bundle hash is invalid.");
  }
  const baseBundle = {
    schemaVersion: value.schemaVersion,
    identity,
    signingKeyId,
    files: normalized.files,
    fileCount: value.fileCount,
    totalBytes: normalized.totalBytes,
  };
  if (!safeEqualAscii(computeBundleHash(baseBundle), value.bundleHash)) {
    fail("COLLECTION_ARTIFACT_HASH_MISMATCH", "Collection artifact bundle integrity check failed.");
  }
  return {
    ...baseBundle,
    bundleHash: value.bundleHash,
  };
}

function decodeDetachedSignature(value) {
  if (typeof value !== "string" || !BASE64URL_SIGNATURE_PATTERN.test(value)) {
    fail("COLLECTION_ARTIFACT_SIGNATURE_INVALID", "Collection artifact signature is invalid.");
  }
  const signature = Buffer.from(value, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== value) {
    fail("COLLECTION_ARTIFACT_SIGNATURE_INVALID", "Collection artifact signature is invalid.");
  }
  return signature;
}

function verifyExpectedIdentity(actual, expected) {
  const normalizedExpected = normalizeIdentity(expected);
  for (const field of [
    "jobId",
    "attemptId",
    "workerId",
    "workerPoolId",
    "runtimeId",
    "contractHash",
    "executionIdentityHash",
  ]) {
    if (actual[field] !== normalizedExpected[field]) {
      fail("COLLECTION_ARTIFACT_IDENTITY_MISMATCH", "Collection artifact execution identity does not match.");
    }
  }
}

function verifyCollectionArtifactBundle(signedArtifact, options = {}) {
  assertExactKeys(signedArtifact, ["bundle", "signature"]);
  assertExactKeys(options, ["publicKey", "expectedIdentity", "expectedSigningKeyId"]);
  const bundle = normalizeReceivedBundle(signedArtifact.bundle);
  const signature = decodeDetachedSignature(signedArtifact.signature);
  const publicKey = coercePublicEd25519Key(options.publicKey);
  if (!crypto.verify(null, signaturePayload(bundle), publicKey, signature)) {
    fail("COLLECTION_ARTIFACT_SIGNATURE_INVALID", "Collection artifact signature verification failed.");
  }
  const expectedSigningKeyId = validateIdentifier(options.expectedSigningKeyId);
  if (bundle.signingKeyId !== expectedSigningKeyId) {
    fail("COLLECTION_ARTIFACT_IDENTITY_MISMATCH", "Collection artifact signing identity does not match.");
  }
  verifyExpectedIdentity(bundle.identity, options.expectedIdentity);
  return deepFreeze({ bundle, signature: signedArtifact.signature });
}

module.exports = {
  COLLECTION_ARTIFACT_SCHEMA_VERSION,
  COLLECTION_ARTIFACT_SIGNATURE_DOMAIN,
  COLLECTION_ARTIFACT_LIMITS,
  CollectionArtifactContractError,
  sha256Hex,
  stableSerialize,
  validateArtifactPath,
  buildCollectionArtifactBundle,
  verifyCollectionArtifactBundle,
};
