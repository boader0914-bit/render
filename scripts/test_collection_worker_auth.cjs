"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  buildSignedWorkerRequest,
  createWorkerNonceRegistry,
  sha256Hex,
  verifySignedWorkerRequest
} = require("./collection_worker_auth.cjs");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const body = Buffer.from('{"jobId":"job-synthetic-0001"}', "utf8");
const base = {
  audience: "lodging-datalab-preview.internal-worker",
  workerId: "worker-a",
  workerPoolId: "v2-runtime-worker",
  keyId: "worker-key-1",
  method: "POST",
  path: "/api/internal/collection-worker/jobs/claim",
  scope: "collection:claim",
  issuedAt: "2026-08-06T03:00:00.000Z",
  nonce: "fixture-nonce-00000001",
  bodySha256: sha256Hex(body)
};

function verify(value, overrides = {}) {
  return verifySignedWorkerRequest(value, {
    publicKey,
    expectedWorkerId: "worker-a",
    expectedWorkerPoolId: "v2-runtime-worker",
    expectedKeyId: "worker-key-1",
    body,
    now: "2026-08-06T03:00:10.000Z",
    nonceRegistry: createWorkerNonceRegistry({ now: () => Date.parse("2026-08-06T03:00:10.000Z") }),
    ...overrides
  });
}

const signed = buildSignedWorkerRequest(base, { privateKey });
assert.equal(verify(signed).scope, "collection:claim");

assert.throws(
  () => buildSignedWorkerRequest({ ...base, path: "/api/runs", scope: "collection:claim" }, { privateKey }),
  { code: "COLLECTION_WORKER_AUTH_SCOPE_INVALID", statusCode: 403 }
);
assert.throws(
  () => buildSignedWorkerRequest({ ...base, scope: "collection:artifact:write" }, { privateKey }),
  { code: "COLLECTION_WORKER_AUTH_SCOPE_INVALID", statusCode: 403 }
);

const tampered = structuredClone(signed);
tampered.request.bodySha256 = "f".repeat(64);
assert.throws(() => verify(tampered), { code: "COLLECTION_WORKER_AUTH_SIGNATURE_INVALID", statusCode: 401 });
assert.throws(
  () => verify(signed, { now: "2026-08-06T03:02:00.000Z" }),
  { code: "COLLECTION_WORKER_AUTH_EXPIRED", statusCode: 401 }
);
assert.throws(
  () => verify(signed, { expectedWorkerId: "worker-b" }),
  { code: "COLLECTION_WORKER_AUTH_IDENTITY_INVALID", statusCode: 403 }
);
assert.throws(
  () => verify(signed, { body: Buffer.from("different") }),
  { code: "COLLECTION_WORKER_AUTH_BODY_MISMATCH", statusCode: 409 }
);

const nonceRegistry = createWorkerNonceRegistry({ now: () => Date.parse("2026-08-06T03:00:10.000Z") });
verify(signed, { nonceRegistry });
assert.throws(
  () => verify(signed, { nonceRegistry }),
  { code: "COLLECTION_WORKER_AUTH_REPLAY", statusCode: 409 }
);

assert.equal(Object.prototype.hasOwnProperty.call(signed.request, "cookie"), false);
assert.equal(Object.prototype.hasOwnProperty.call(signed.request, "session"), false);
assert.equal(Object.prototype.hasOwnProperty.call(signed.request, "credential"), false);
console.log("Collection worker signed service-auth fixture checks passed");
