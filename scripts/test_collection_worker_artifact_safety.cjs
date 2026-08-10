"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  CollectionArtifactContractError,
  buildCollectionArtifactBundle,
  classifyCollectionArtifactSensitiveContent,
  verifyCollectionArtifactBundle
} = require("./collection_artifact_contract.cjs");
const {
  auditV2Top20ArtifactFiles,
  sanitizeArtifactString
} = require("./collection_worker_v2_top20_artifact.cjs");

const HASH = "a".repeat(64);
const identity = Object.freeze({
  jobId: "job-top20-aaaaaaaaaaaa-bbbbbbbbbbbb",
  attemptId: "attempt:top20-artifact-fixture",
  workerId: "collector_worker_preview_top20_01",
  workerPoolId: "collector_pool_preview_top20_01",
  runtimeId: "runtime:fixture",
  contractHash: HASH,
  executionIdentityHash: "b".repeat(64)
});

function expectSensitive(path, content, detector) {
  const meta = classifyCollectionArtifactSensitiveContent(path, content);
  assert.equal(meta?.detector, detector);
  assert.equal(meta?.contentHashPrefix?.length, 12);
  assert.equal(meta?.filePathHashPrefix?.length, 12);
  assert.equal(typeof meta?.contentLength, "number");
  assert.doesNotMatch(JSON.stringify(meta), /https?:\/\/|Bearer |client_secret|api_key|<html/i);
  assert.throws(
    () => buildCollectionArtifactBundle({ identity, files: [{ path, content }] }, { privateKey, keyId: "artifact_fixture" }),
    (error) => error instanceof CollectionArtifactContractError && error.code === "COLLECTION_ARTIFACT_SENSITIVE_CONTENT" && error.safeMeta?.detector === detector
  );
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const normalFiles = [
  { path: "top20-summary.json", content: JSON.stringify({ status: "ready", note: "public description" }) },
  { path: "top20-content-receipt.json", content: JSON.stringify({ schemaVersion: "fixture" }) },
  { path: "run/manifest.json", content: JSON.stringify({ documentType: "lodging-collection-manifest" }) },
  { path: "run/platform.csv", content: "rank,name\n1,fixture\n" },
  { path: "run/overall.csv", content: "rank,name\n1,fixture\n" },
  { path: "run/ads.csv", content: "rank,name\n" },
  { path: "run/regional.csv", content: "rank,name\n" },
  { path: "run/ddnayo.csv", content: "rank,name\n" },
  { path: "run/details/detail-01.json", content: JSON.stringify({ placeId: "123", sourceAvailable: true, sourceType: "naver_place", sourceId: "123" }) }
];

const audit = auditV2Top20ArtifactFiles(normalFiles);
assert.equal(audit.every((entry) => entry.accepted), true);
assert.equal(audit.length, normalFiles.length);
const signed = buildCollectionArtifactBundle({ identity, files: normalFiles }, { privateKey, keyId: "artifact_fixture" });
assert.equal(verifyCollectionArtifactBundle(signed, { publicKey, expectedIdentity: identity, expectedSigningKeyId: "artifact_fixture" }).bundle.fileCount, normalFiles.length);
assert.equal(sanitizeArtifactString("See https://public.example/path reference", "fixture"), "See  reference");

expectSensitive("run/manifest.json", "<html>fixture</html>", "raw_html");
expectSensitive("run/manifest.json", "https://public.example/path", "url_literal");
expectSensitive("run/manifest.json", "www.public.example/path", "url_literal");
expectSensitive("run/manifest.json", "Authorization: Bearer token-value", "bearer_token");
expectSensitive("run/manifest.json", "client_secret=value", "sensitive_key");
expectSensitive("run/raw-response.json", "safe", "forbidden_path_token");
expectSensitive("run/details/detail-01.html", "safe", "html_extension");
const rejectedAudit = auditV2Top20ArtifactFiles([{ path: "run/manifest.json", content: "www.public.example/path" }])[0];
assert.equal(rejectedAudit.accepted, false);
assert.equal(rejectedAudit.detector, "url_literal");
assert.equal(rejectedAudit.filePathHashPrefix.length, 12);
assert.throws(() => sanitizeArtifactString("window.__APOLLO_STATE__", "fixture"), (error) => error.code === "V2_TOP20_ARTIFACT_SENSITIVE");

console.log(JSON.stringify({
  ok: true,
  normalFullArtifactPass: true,
  sensitiveContentStillBlocked: true,
  detectorCount: 6,
  externalNetworkCalls: 0
}));
