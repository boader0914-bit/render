"use strict";

// This integration fixture uses output created by the actual crawler child
// and its CSV, manifest, and detail exporters. Parent and child transports
// both fail closed outside of registered fixture responses.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  buildCollectionArtifactBundle,
  classifyCollectionArtifactSensitiveContent,
  verifyCollectionArtifactBundle
} = require("./collection_artifact_contract.cjs");
const {
  auditV2Top20ArtifactFiles,
  buildV2Top20FinalArtifactFiles,
  verifyV2Top20ArtifactContents
} = require("./collection_worker_v2_top20_artifact.cjs");
const {
  buildV2Top20CollectorEnvironment,
  executeV2Top20Collector,
  findSingleFinalOutput,
  runCollectorChild
} = require("./collection_worker_v2_top20_collector.cjs");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(__dirname, "naver_legacy_inventory_fixture_preload.cjs");
const NETWORK_GUARD_PRELOAD = path.join(__dirname, "fixture_network_guard_preload.cjs");
const guard = installFixtureNetworkGuard({ label: "production Top20 artifact fixtures" });
const CONTRACT_HASH = "a".repeat(64);
const EXECUTION_IDENTITY_HASH = "b".repeat(64);
const TOP20_CONTRACT_HASH = "c".repeat(64);

function assertSystemTempFixtureRoot(root) {
  const resolvedRoot = path.resolve(root);
  const resolvedTemp = path.resolve(os.tmpdir());
  const relative = path.relative(resolvedTemp, resolvedRoot);
  assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
  return resolvedRoot;
}

function contract() {
  return {
    keyword: "Synthetic regional lodging",
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn: "2026-08-21",
    checkOut: "2026-08-21",
    rankStart: 1,
    rankEnd: 50,
    detailRankStart: 1,
    detailRankEnd: 20
  };
}

function fixtureEnvironment(root, auditFile, mode) {
  return {
    ...process.env,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      "--require=" + NETWORK_GUARD_PRELOAD.replace(/\\/gu, "/"),
      "--require=" + PRELOAD.replace(/\\/gu, "/")
    ].filter(Boolean).join(" "),
    NODE_ENV: "test",
    NAVER_INVENTORY_FIXTURE_ROOT: root,
    NAVER_INVENTORY_FIXTURE_MODE: mode,
    NAVER_INVENTORY_FIXTURE_AUDIT_FILE: auditFile,
    SEARCH_INTENT: "",
    SEARCH_INTENT_CONFIDENCE: "0"
  };
}

function identity() {
  return {
    jobId: "job-top20-aaaaaaaaaaaa-bbbbbbbbbbbb",
    attemptId: "attempt:top20-production-artifact-fixture",
    workerId: "collector_worker_preview_top20_01",
    workerPoolId: "collector_pool_preview_top20_01",
    runtimeId: "runtime:production-artifact-fixture",
    contractHash: CONTRACT_HASH,
    executionIdentityHash: EXECUTION_IDENTITY_HASH
  };
}

function safeRejectedAudit(audit) {
  const rejected = audit.find((entry) => entry.accepted !== true);
  if (!rejected) return null;
  return {
    failureCode: "COLLECTION_ARTIFACT_SENSITIVE_CONTENT",
    detector: rejected.detector,
    fileRole: rejected.fileRole,
    safeFilePath: rejected.safePath,
    filePathHashPrefix: rejected.filePathHashPrefix,
    contentHashPrefix: rejected.sha256Prefix,
    contentLength: rejected.byteLength,
    contentLogged: false
  };
}

async function firstActualRawArtifactDetection(root) {
  const outputRoot = path.join(root, "raw-artifact-output");
  const auditFile = path.join(root, "raw-artifact-provider-audit.json");
  const environment = buildV2Top20CollectorEnvironment({
    contract: contract(),
    outputRoot,
    runStamp: "20260821_000000_aaaaaaaa",
    baseEnvironment: fixtureEnvironment(root, auditFile, "success")
  });
  await runCollectorChild({
    scriptPath: path.join(__dirname, "gyeongnam_glamping_crawl.cjs"),
    cwd: ROOT,
    keyword: contract().keyword,
    environment,
    authorizeProviderCall: async () => {},
    onProviderCall: async () => {},
    maxRuntimeMs: 120_000
  });
  const outputDir = await findSingleFinalOutput(outputRoot);
  const manifestContent = await fs.readFile(path.join(outputDir, "manifest.json"));
  const manifest = JSON.parse(manifestContent.toString("utf8"));
  const candidates = [
    { sourcePath: "manifest.json", artifactPath: "run/manifest.json", fileRole: "manifest" },
    ...["platform", "overall", "ads", "regional", "ddnayo"].map((role) => ({
      sourcePath: manifest.fileRoles?.[role],
      artifactPath: `run/${role}.csv`,
      fileRole: `${role}_csv`
    }))
  ];
  for (const candidate of candidates) {
    const content = await fs.readFile(path.join(outputDir, candidate.sourcePath));
    const classified = classifyCollectionArtifactSensitiveContent(candidate.artifactPath, content);
    if (classified) {
      return Object.freeze({
        detector: classified.detector,
        fileRole: candidate.fileRole,
        safeFilePath: classified.safeFilePath,
        contentLength: classified.contentLength
      });
    }
  }
  for (const [index, sourcePath] of (manifest.detailJsonFiles || []).entries()) {
    const artifactPath = `run/details/detail-${String(index + 1).padStart(2, "0")}.json`;
    const classified = classifyCollectionArtifactSensitiveContent(artifactPath, await fs.readFile(path.join(outputDir, sourcePath)));
    if (classified) {
      return Object.freeze({
        detector: classified.detector,
        fileRole: "detail_json",
        safeFilePath: classified.safeFilePath,
        contentLength: classified.contentLength
      });
    }
  }
  return null;
}

async function runProductionArtifactScenario(root, mode, expectedCollectionStatus) {
  const auditFile = path.join(root, "provider-audit-" + mode + ".json");
  const collected = await executeV2Top20Collector({
    contract: contract(),
    contractHash: CONTRACT_HASH,
    executionIdentityHash: EXECUTION_IDENTITY_HASH,
    tempBase: root,
    cwd: ROOT,
    baseEnvironment: fixtureEnvironment(root, auditFile, mode),
    heartbeat: async () => {},
    onProviderCall: async () => {},
    heartbeatIntervalMs: 1_000,
    maxRuntimeMs: 120_000
  });
  assert.equal(collected.collectionStatus, expectedCollectionStatus, mode + " must retain its real resilient result");
  const finalArtifact = buildV2Top20FinalArtifactFiles({
    files: collected.files,
    contractHash: CONTRACT_HASH,
    executionIdentityHash: EXECUTION_IDENTITY_HASH,
    top20ContractHash: TOP20_CONTRACT_HASH,
    providerWorkflowRevision: 7,
    now: "2026-08-21T00:00:00.000Z"
  });
  const audit = auditV2Top20ArtifactFiles(finalArtifact.files);
  const rejected = safeRejectedAudit(audit);
  assert.equal(rejected, null, JSON.stringify(rejected));

  const keys = crypto.generateKeyPairSync("ed25519");
  const signed = buildCollectionArtifactBundle({ identity: identity(), files: finalArtifact.files }, {
    privateKey: keys.privateKey,
    keyId: "artifact_fixture"
  });
  const verified = verifyCollectionArtifactBundle(signed, {
    publicKey: keys.publicKey,
    expectedIdentity: identity(),
    expectedSigningKeyId: "artifact_fixture"
  });
  const contents = verifyV2Top20ArtifactContents(verified, {
    contractHash: CONTRACT_HASH,
    executionIdentityHash: EXECUTION_IDENTITY_HASH,
    top20ContractHash: TOP20_CONTRACT_HASH
  });
  assert.equal(contents.summary.collectionStatus, expectedCollectionStatus);
  return {
    collectionStatus: contents.summary.collectionStatus,
    providerCallCount: contents.summary.executedCallCount,
    fileCount: verified.bundle.fileCount,
    actualCrawlerChildUsed: true,
    actualExporterUsed: true,
    actualManifestSchemaUsed: true,
    actualCsvHeadersUsed: true,
    actualDetailSchemaUsed: true
  };
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "top20-production-artifact-"));
  try {
    const rawDetection = await firstActualRawArtifactDetection(root);
    assert.deepEqual(rawDetection && {
      detector: rawDetection.detector,
      fileRole: rawDetection.fileRole,
      safeFilePath: rawDetection.safeFilePath
    }, {
      detector: "url_literal",
      fileRole: "platform_csv",
      safeFilePath: "run/platform.csv"
    }, "the actual child output must identify the raw platform URL field without retaining it");
    const complete = await runProductionArtifactScenario(root, "success", "complete");
    const partial = await runProductionArtifactScenario(root, "partial_booking_items_second", "partial");
    const rankOnly = await runProductionArtifactScenario(root, "challenge_daily_schedule", "rank_only");
    assert.equal(guard.blockedAttempts(), 0, "production artifact fixture must not attempt external network");
    console.log(JSON.stringify({
      complete,
      partial,
      rankOnly,
      rawArtifactDetection: {
        detector: rawDetection.detector,
        fileRole: rawDetection.fileRole,
        safeFilePath: rawDetection.safeFilePath,
        contentLength: rawDetection.contentLength
      },
      externalNetworkCalls: 0
    }));
  } finally {
    guard.restore();
    await fs.rm(assertSystemTempFixtureRoot(root), { recursive: true, force: true });
  }
})().catch((error) => {
  guard.restore();
  console.error(error);
  process.exitCode = 1;
});
