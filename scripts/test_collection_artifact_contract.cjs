"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  COLLECTION_ARTIFACT_SCHEMA_VERSION,
  COLLECTION_ARTIFACT_SIGNATURE_DOMAIN,
  COLLECTION_ARTIFACT_LIMITS,
  sha256Hex,
  stableSerialize,
  validateArtifactPath,
  buildCollectionArtifactBundle,
  verifyCollectionArtifactBundle,
} = require("./collection_artifact_contract.cjs");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const otherKeys = crypto.generateKeyPairSync("ed25519");
const identity = Object.freeze({
  jobId: "job-collection-0001",
  attemptId: "attempt-0001",
  workerId: "worker-singapore-01",
  workerPoolId: "pool-singapore-v2",
  runtimeId: "runtime-node22-linux-x64",
  contractHash: "a".repeat(64),
  executionIdentityHash: "b".repeat(64),
});
const signingKeyId = "collector-worker-key-v1";

let unexpectedNetworkCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => {
  unexpectedNetworkCalls += 1;
  throw new Error("fixture network is disabled");
};

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error && error.code, code);
    assert.doesNotMatch(String(error && error.message), /job-collection|attempt-0001|worker-singapore/i);
    return true;
  });
}

function createSigned(overrides = {}) {
  return buildCollectionArtifactBundle(
    {
      identity: overrides.identity || identity,
      files:
        overrides.files ||
        [
          { path: "manifest.json", content: JSON.stringify({ status: "ready", count: 3 }) },
          { path: "tables/ranks.csv", content: "rank,place_id\n1,fixture-1\n2,fixture-2\n" },
        ],
    },
    {
      privateKey: overrides.privateKey || privateKey,
      keyId: overrides.keyId || signingKeyId,
    },
  );
}

function verify(signed, overrides = {}) {
  return verifyCollectionArtifactBundle(signed, {
    publicKey: overrides.publicKey || publicKey,
    expectedIdentity: overrides.expectedIdentity || identity,
    expectedSigningKeyId: overrides.expectedSigningKeyId || signingKeyId,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

try {
  assert.equal(COLLECTION_ARTIFACT_SCHEMA_VERSION, "collection-artifact-bundle.v1");
  assert.equal(COLLECTION_ARTIFACT_SIGNATURE_DOMAIN, "lodging-datalab.collection-artifact.v1");
  assert.deepEqual(
    stableSerialize({ z: 1, a: { y: true, b: "fixture" } }),
    stableSerialize({ a: { b: "fixture", y: true }, z: 1 }),
  );
  assert.equal(sha256Hex(Buffer.from("fixture")), crypto.createHash("sha256").update("fixture").digest("hex"));
  assert.equal(validateArtifactPath("tables/ranks.csv"), "tables/ranks.csv");

  const signed = createSigned();
  assert.deepEqual(Object.keys(signed).sort(), ["bundle", "signature"]);
  assert.equal(signed.bundle.schemaVersion, COLLECTION_ARTIFACT_SCHEMA_VERSION);
  assert.deepEqual(signed.bundle.identity, identity);
  assert.equal(signed.bundle.fileCount, 2);
  assert.equal(signed.bundle.totalBytes, signed.bundle.files.reduce((sum, file) => sum + file.size, 0));
  assert.match(signed.bundle.bundleHash, /^[a-f0-9]{64}$/);
  assert.match(signed.signature, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(Object.isFrozen(signed), true);
  assert.equal(Object.isFrozen(signed.bundle.files), true);

  const verified = verify(signed);
  assert.deepEqual(verified, signed);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.bundle.identity), true);
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(`${COLLECTION_ARTIFACT_SIGNATURE_DOMAIN}\n${stableSerialize(signed.bundle)}`, "utf8"),
      publicKey,
      Buffer.from(signed.signature, "base64url"),
    ),
    true,
    "the signature must be detached Ed25519 over the canonical bundle",
  );

  for (const field of [
    "jobId",
    "attemptId",
    "workerId",
    "workerPoolId",
    "runtimeId",
    "contractHash",
    "executionIdentityHash",
  ]) {
    const mismatchedIdentity = {
      ...identity,
      [field]: field.endsWith("Hash") ? "c".repeat(64) : `${identity[field]}-other`,
    };
    const mismatched = createSigned({ identity: mismatchedIdentity });
    expectCode(() => verify(mismatched), "COLLECTION_ARTIFACT_IDENTITY_MISMATCH");
  }
  expectCode(
    () => verify(createSigned({ keyId: "collector-worker-key-v2" })),
    "COLLECTION_ARTIFACT_IDENTITY_MISMATCH",
  );
  expectCode(
    () => verify(signed, { publicKey: otherKeys.publicKey }),
    "COLLECTION_ARTIFACT_SIGNATURE_INVALID",
  );

  for (const unsafePath of [
    "../secret.json",
    "/absolute.json",
    "C:\\absolute.json",
    "tables\\ranks.csv",
    "tables/../secret.json",
    "tables/%2e%2e/secret.json",
    "tables//ranks.csv",
  ]) {
    expectCode(
      () => createSigned({ files: [{ path: unsafePath, content: "fixture" }] }),
      "COLLECTION_ARTIFACT_PATH_INVALID",
    );
  }
  for (const sensitivePath of [
    "raw_response.json",
    "provider.html",
    "request-headers.json",
    "session_cookie.txt",
    "credentials.json",
    "source_urls.csv",
  ]) {
    expectCode(
      () => createSigned({ files: [{ path: sensitivePath, content: "fixture" }] }),
      "COLLECTION_ARTIFACT_SENSITIVE_CONTENT",
    );
  }
  expectCode(
    () =>
      createSigned({
        files: [
          { path: "tables/ranks.csv", content: "fixture" },
          { path: "TABLES/RANKS.CSV", content: "fixture" },
        ],
      }),
    "COLLECTION_ARTIFACT_DUPLICATE_PATH",
  );

  const sensitiveContents = [
    "<!doctype html><html><body>challenge</body></html>",
    "source=https://provider.invalid/result",
    JSON.stringify({ headers: { accept: "fixture" } }),
    "Cookie: session=fixture",
    JSON.stringify({ credential: "fixture" }),
    "Authorization: Bearer fixture-token",
  ];
  for (const content of sensitiveContents) {
    expectCode(
      () => createSigned({ files: [{ path: "result.json", content }] }),
      "COLLECTION_ARTIFACT_SENSITIVE_CONTENT",
    );
  }

  expectCode(
    () =>
      createSigned({
        files: [
          {
            path: "large.bin",
            content: Buffer.alloc(COLLECTION_ARTIFACT_LIMITS.maxFileBytes + 1),
          },
        ],
      }),
    "COLLECTION_ARTIFACT_OVERSIZE",
  );
  const maximumFile = Buffer.alloc(COLLECTION_ARTIFACT_LIMITS.maxFileBytes, 1);
  expectCode(
    () =>
      createSigned({
        files: Array.from({ length: 5 }, (_, index) => ({
          path: `tables/part-${index}.bin`,
          content: maximumFile,
        })),
      }),
    "COLLECTION_ARTIFACT_OVERSIZE",
  );
  expectCode(
    () =>
      createSigned({
        files: Array.from({ length: COLLECTION_ARTIFACT_LIMITS.maxFiles + 1 }, (_, index) => ({
          path: `tables/part-${index}.json`,
          content: "{}",
        })),
      }),
    "COLLECTION_ARTIFACT_OVERSIZE",
  );

  const tamperedContent = clone(signed);
  tamperedContent.bundle.files[0].contentBase64 = Buffer.from("tampered").toString("base64");
  expectCode(() => verify(tamperedContent), "COLLECTION_ARTIFACT_HASH_MISMATCH");

  const tamperedFileHash = clone(signed);
  tamperedFileHash.bundle.files[0].sha256 = "0".repeat(64);
  expectCode(() => verify(tamperedFileHash), "COLLECTION_ARTIFACT_HASH_MISMATCH");

  const tamperedBundleHash = clone(signed);
  tamperedBundleHash.bundle.bundleHash = "0".repeat(64);
  expectCode(() => verify(tamperedBundleHash), "COLLECTION_ARTIFACT_HASH_MISMATCH");

  const tamperedSignature = clone(signed);
  tamperedSignature.signature = `${signed.signature[0] === "A" ? "B" : "A"}${signed.signature.slice(1)}`;
  expectCode(() => verify(tamperedSignature), "COLLECTION_ARTIFACT_SIGNATURE_INVALID");

  const injectedTopLevel = clone(signed);
  injectedTopLevel.headers = { authorization: "fixture" };
  expectCode(() => verify(injectedTopLevel), "COLLECTION_ARTIFACT_CONTRACT_INVALID");

  const injectedBundle = clone(signed);
  injectedBundle.bundle.cookie = "fixture";
  expectCode(() => verify(injectedBundle), "COLLECTION_ARTIFACT_CONTRACT_INVALID");

  const injectedFile = clone(signed);
  injectedFile.bundle.files[0].credential = "fixture";
  expectCode(() => verify(injectedFile), "COLLECTION_ARTIFACT_CONTRACT_INVALID");

  const malformedEncoding = clone(signed);
  malformedEncoding.bundle.files[0].contentBase64 = "not=canonical=";
  expectCode(() => verify(malformedEncoding), "COLLECTION_ARTIFACT_CONTRACT_INVALID");

  const malformedSignature = clone(signed);
  malformedSignature.signature = "not-a-signature";
  expectCode(() => verify(malformedSignature), "COLLECTION_ARTIFACT_SIGNATURE_INVALID");

  const rsaKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  expectCode(
    () => createSigned({ privateKey: rsaKeys.privateKey }),
    "COLLECTION_ARTIFACT_KEY_INVALID",
  );

  assert.equal(unexpectedNetworkCalls, 0, "artifact fixtures must never access the network");
  console.log(
    JSON.stringify({
      ok: true,
      schemaVersion: COLLECTION_ARTIFACT_SCHEMA_VERSION,
      signature: "ed25519-detached",
      filesVerified: signed.bundle.fileCount,
      networkCalls: unexpectedNetworkCalls,
    }),
  );
} finally {
  global.fetch = originalFetch;
}
