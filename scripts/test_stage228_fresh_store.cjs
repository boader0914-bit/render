"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  FRESH_DATA_IDENTITY_RULE,
  FRESH_DATA_LAYERS,
  FRESH_DATA_SCHEMA_VERSION,
  FRESH_DATA_STORE_KIND,
  deriveCompanyQuality,
  deterministicCompanyId,
  normalizeCompanyIdentity,
  normalizeVerifiedCoordinates
} = require("./integration/contracts/fresh_data.cjs");
const {
  assertFreshAuthStoreBoundary,
  createFreshIntegrationRepository,
  resolveFreshIntegrationDataDir
} = require("./integration/repositories/fresh_store.cjs");
const {
  assertFreshDataConfiguration,
  createFreshDataRuntime
} = require("./integration/bootstrap/fresh_data_runtime.cjs");

const ROOT = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stage228-fresh-store-"));
const legacyDir = path.join(tempRoot, "legacy-runtime");
const freshDir = path.join(tempRoot, "fresh-integration");
fs.mkdirSync(legacyDir, { recursive: true });
fs.writeFileSync(path.join(legacyDir, "must-not-read.json"), JSON.stringify({ secretLegacySentinel: true }), "utf8");

function safeRemove(target) {
  const resolved = path.resolve(target);
  const requiredPrefix = path.resolve(os.tmpdir(), "stage228-fresh-store-");
  assert.ok(resolved.startsWith(requiredPrefix), `refusing unsafe test cleanup: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function testEnv(dataDir = freshDir) {
  return {
    NODE_ENV: "test",
    V2_INTEGRATION_DATA_DIR: dataDir,
    DATA_DIR: legacyDir,
    CONFIG_DIR: path.join(tempRoot, "legacy-config"),
    OUTPUTS_DIR: path.join(tempRoot, "legacy-outputs")
  };
}

function errorCode(error) {
  return error?.code || "";
}

function testNullObservationsDoNotSatisfyCompleteness() {
  const quality = deriveCompanyQuality({}, [
    { kind: "profile.company-name", value: "null guard lodging", mode: "quick" },
    { kind: "profile.region", value: "test region", mode: "quick" },
    { kind: "profile.category", value: "glamping", mode: "quick" },
    { kind: "profile.location", value: { latitude: null, longitude: 127.1 }, mode: "quick" },
    { kind: "product.price", value: 120000, companyId: "company-null", targetDate: "2026-08-01", channel: "direct", productKey: "room-1" },
    { kind: "product.total-stock", value: null, companyId: "company-null", targetDate: "2026-08-01", channel: "direct", productKey: "room-1" },
    { kind: "product.available-stock", value: null, companyId: "company-null", targetDate: "2026-08-01", channel: "direct", productKey: "room-1" },
    { kind: "ota.exposure", value: null, mode: "ota" }
  ], null, Date.parse("2026-07-30T00:00:00.000Z"));
  assert.deepEqual(quality.dataCompleteness.collectedModes, []);
  assert.deepEqual(quality.dataCompleteness.missingModes, ["quick", "detail", "ota"]);
  assert.equal(quality.dataCompleteness.score, 0);
}

function authBoundaryOptions(authStorePath) {
  return {
    authStorePath,
    env: testEnv(),
    projectRoot: ROOT,
    legacyDataDir: legacyDir,
    legacyPaths: [
      legacyDir,
      path.join(tempRoot, "legacy-config"),
      path.join(tempRoot, "legacy-outputs"),
      path.join(legacyDir, "customer_db"),
      path.join(legacyDir, "history"),
      path.join(legacyDir, "company_master"),
      path.join(legacyDir, "tourism_data")
    ]
  };
}

let tick = Date.parse("2026-07-29T00:00:00.000Z");
const clock = () => tick;
let serial = 0;
const idFactory = () => `test${String(++serial).padStart(8, "0")}`;

function sourceUrl(stage, suffix = "one") {
  return `https://collector.example.invalid/${stage}/${suffix}`;
}

function rawRow(runId, companyId, stage, observedAt) {
  return {
    rawEvidenceId: `raw_${stage}_${observedAt.replace(/\D/g, "")}`,
    runId,
    companyId,
    stage,
    source: "stage228-synthetic-fresh-collection",
    sourceUrl: sourceUrl(stage, companyId),
    observedAt,
    synthetic: true,
    payload: { stage, source: sourceUrl(stage, companyId), newlyCollected: true }
  };
}

function observationRow(runId, companyId, mode, sequence, overrides = {}) {
  const observedAt = overrides.observedAt || new Date(Date.parse("2026-07-29T01:00:00.000Z") + sequence).toISOString();
  const evidenceId = overrides.evidenceId || `raw_${mode}_${companyId.replace(/[^a-z0-9]/gi, "")}`;
  return {
    observationId: overrides.observationId || `obs_${mode}_${String(sequence).padStart(8, "0")}`,
    kind: overrides.kind || `${mode}.availability`,
    mode,
    runId,
    companyId,
    source: "stage228-synthetic-fresh-collection",
    observedAt,
    targetDate: overrides.targetDate || "2026-08-01",
    channel: overrides.channel || (mode === "ota" ? "naver" : "direct"),
    productKey: overrides.productKey || "lodging-standard",
    rawEvidenceId: evidenceId,
    sourceUrl: sourceUrl(mode, companyId),
    synthetic: true,
    value: overrides.value ?? { available: sequence % 2 === 0 },
    unit: overrides.unit || "availability"
  };
}

async function main() {
  testNullObservationsDoNotSatisfyCompleteness();
  assert.deepEqual(normalizeVerifiedCoordinates({ latitude: 35.1796, longitude: 129.0756 }), { latitude: 35.1796, longitude: 129.0756 });
  assert.throws(
    () => normalizeVerifiedCoordinates({ latitude: 0, longitude: 0 }),
    (error) => errorCode(error) === "FRESH_COORDINATE_REVIEW_OUT_OF_RANGE",
    "repository coordinate contract must enforce the supported Korea boundary"
  );
  const completeQualityRows = [
    { kind: "profile.company-name", value: "검수 업체", observedAt: "2026-07-30T00:00:00.000Z" },
    { kind: "profile.region", value: "경남", observedAt: "2026-07-30T00:00:00.000Z" },
    { kind: "profile.category", value: "glamping", observedAt: "2026-07-30T00:00:00.000Z" },
    { kind: "profile.location", value: { latitude: 35.1, longitude: 128.1 }, observedAt: "2026-07-30T00:00:00.000Z" },
    { kind: "product.price", value: 100000, companyId: "cmp_quality", productKey: "room", targetDate: "2026-08-01", observedAt: "2026-07-30T00:00:00.000Z" },
    { kind: "product.total-stock", value: 3, companyId: "cmp_quality", productKey: "room", targetDate: "2026-08-01", observedAt: "2026-07-30T00:00:00.000Z" },
    { kind: "product.available-stock", value: 2, companyId: "cmp_quality", productKey: "room", targetDate: "2026-08-01", observedAt: "2026-07-30T00:00:00.000Z" },
    { kind: "ota.exposure", value: true, observedAt: "2026-07-30T00:00:00.000Z" }
  ];
  const coordinateOnlyQuality = deriveCompanyQuality({}, completeQualityRows, {
    status: "approved",
    profile: { latitude: 35.1, longitude: 128.1, coordinateConfidence: "verified" }
  }, Date.parse("2026-07-30T01:00:00.000Z"));
  assert.equal(coordinateOnlyQuality.confidence.verified, false, "coordinate approval alone must not mark the full profile verified");
  assert.equal(coordinateOnlyQuality.confidence.score, 80);
  const fullProfileQuality = deriveCompanyQuality({}, completeQualityRows, {
    status: "approved",
    profile: { primaryName: "검수 업체", latitude: 35.1, longitude: 128.1 }
  }, Date.parse("2026-07-30T01:00:00.000Z"));
  assert.equal(fullProfileQuality.confidence.verified, true);
  assert.equal(fullProfileQuality.confidence.score, 100);
  for (const manifestName of ["render.v2.yaml", "render.v2.persistent.yaml"]) {
    const manifestSource = fs.readFileSync(path.join(ROOT, manifestName), "utf8");
    for (const flag of ["V2_INTEGRATION_FRESH_COMPANY_ENABLED", "V2_INTEGRATION_FRESH_OBSERVATION_ENABLED"]) {
      assert.match(
        manifestSource,
        new RegExp(`- key: ${flag}\\r?\\n\\s+value: [\"']false[\"']`),
        `${manifestName} must keep ${flag} disabled by default`
      );
    }
    assert.doesNotMatch(
      manifestSource,
      /- key: V2_INTEGRATION_DATA_DIR\b/,
      `${manifestName} must not invent an unapproved production fresh path`
    );
  }
  assert.throws(
    () => assertFreshDataConfiguration({ env: {}, projectRoot: ROOT }),
    (error) => errorCode(error) === "FRESH_DATA_DIR_REQUIRED",
    "missing V2_INTEGRATION_DATA_DIR must fail closed"
  );
  assert.throws(
    () => assertFreshAuthStoreBoundary(authBoundaryOptions("")),
    (error) => errorCode(error) === "FRESH_AUTH_STORE_PATH_REQUIRED",
    "missing V2_INTEGRATION_AUTH_STORE_PATH must fail closed in Stage 228"
  );
  assert.throws(
    () => assertFreshAuthStoreBoundary(authBoundaryOptions(path.join("fresh-integration", "auth-store.json"))),
    (error) => errorCode(error) === "FRESH_AUTH_STORE_PATH_ABSOLUTE_REQUIRED",
    "relative Stage 228 auth store paths must fail closed"
  );

  const allowedAuthStore = path.join(legacyDir, "fresh-integration", "auth-store.json");
  const allowedAuthBoundary = assertFreshAuthStoreBoundary(authBoundaryOptions(allowedAuthStore));
  assert.equal(allowedAuthBoundary.configured, path.resolve(allowedAuthStore));
  assert.equal(allowedAuthBoundary.allowedNamespace, path.join(legacyDir, "fresh-integration"));
  const externalAuthStore = path.join(tempRoot, "separate-auth-store", "auth-store.json");
  assert.equal(
    assertFreshAuthStoreBoundary(authBoundaryOptions(externalAuthStore)).configured,
    path.resolve(externalAuthStore),
    "a separate absolute auth path outside legacy boundaries must remain allowed"
  );

  for (const unsafeAuthStore of [
    tempRoot,
    path.join(legacyDir, "auth", "auth-store.json"),
    path.join(legacyDir, "config", "traffic_api_keys.local.json"),
    path.join(legacyDir, "outputs", "manifest.json"),
    path.join(legacyDir, "customer_db", "b2b_members.json"),
    path.join(legacyDir, "history", "crawl_timings.json"),
    path.join(legacyDir, "company_master", "companies.json"),
    path.join(legacyDir, "tourism_data", "collections.jsonl"),
    path.join(ROOT, "config", "auth-store.json"),
    path.join(ROOT, "outputs", "auth-store.json")
  ]) {
    assert.throws(
      () => assertFreshAuthStoreBoundary(authBoundaryOptions(unsafeAuthStore)),
      (error) => ["FRESH_AUTH_STORE_NAMESPACE_REQUIRED", "FRESH_AUTH_STORE_PATH_OVERLAP"].includes(errorCode(error)),
      `legacy auth store boundary must be rejected: ${unsafeAuthStore}`
    );
  }

  const authLegacyHistory = path.join(legacyDir, "history");
  const authAllowedNamespace = path.join(legacyDir, "fresh-integration");
  fs.mkdirSync(authLegacyHistory, { recursive: true });
  fs.mkdirSync(authAllowedNamespace, { recursive: true });
  const authEscapeLink = path.join(authAllowedNamespace, "history-link");
  const externalLegacyLink = path.join(tempRoot, "external-history-link");
  try {
    fs.symlinkSync(authLegacyHistory, authEscapeLink, process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(authLegacyHistory, externalLegacyLink, process.platform === "win32" ? "junction" : "dir");
    for (const linkedAuthStore of [
      path.join(authEscapeLink, "auth-store.json"),
      path.join(externalLegacyLink, "auth-store.json")
    ]) {
      assert.throws(
        () => assertFreshAuthStoreBoundary(authBoundaryOptions(linkedAuthStore)),
        (error) => ["FRESH_AUTH_STORE_NAMESPACE_REQUIRED", "FRESH_AUTH_STORE_PATH_OVERLAP"].includes(errorCode(error)),
        `auth store symlink/junction overlap must be rejected: ${linkedAuthStore}`
      );
    }
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) throw error;
  }
  for (const unsafe of [legacyDir, path.join(legacyDir, "nested"), tempRoot]) {
    assert.throws(
      () => resolveFreshIntegrationDataDir({ env: testEnv(unsafe), projectRoot: ROOT }),
      (error) => errorCode(error) === "FRESH_DATA_PATH_OVERLAP",
      `legacy equal/child/parent relation must be rejected: ${unsafe}`
    );
  }
  assert.throws(
    () => resolveFreshIntegrationDataDir({
      env: testEnv(path.join(ROOT, "web", "data", "fresh")),
      projectRoot: ROOT
    }),
    (error) => errorCode(error) === "FRESH_DATA_PATH_OVERLAP",
    "repository web/data boundary must be rejected"
  );

  const linkPath = path.join(tempRoot, "legacy-junction");
  try {
    fs.symlinkSync(legacyDir, linkPath, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => resolveFreshIntegrationDataDir({ env: testEnv(path.join(linkPath, "fresh")), projectRoot: ROOT }),
      (error) => errorCode(error) === "FRESH_DATA_PATH_OVERLAP",
      "realpath through a symlink/junction to a legacy boundary must be rejected"
    );
  } catch (error) {
    if (!["EPERM", "EACCES", "UNKNOWN"].includes(error.code)) throw error;
  }

  const runtime = createFreshDataRuntime({ env: testEnv(), projectRoot: ROOT, clock, idFactory });
  const repository = runtime.repository;
  const firstBootstrap = await runtime.initialize();
  const secondBootstrap = await runtime.initialize();
  assert.deepEqual(secondBootstrap, firstBootstrap, "fresh bootstrap must be idempotent");
  assert.equal(firstBootstrap.schemaVersion, FRESH_DATA_SCHEMA_VERSION);
  assert.equal(firstBootstrap.storeKind, FRESH_DATA_STORE_KIND);
  assert.deepEqual(firstBootstrap.layers, FRESH_DATA_LAYERS);
  assert.deepEqual(firstBootstrap.counts, {
    targets: 0,
    companies: 0,
    rawEvidence: 0,
    observations: 0,
    verifiedProfiles: 0,
    runs: 0
  });
  assert.deepEqual(runtime.contract, {
    stage: 228,
    provisional: false,
    source: "synthetic-fresh-integration",
    dataBoundary: "fresh-integration-only",
    providerCalls: 0,
    legacyRuntimeReads: 0,
    legacyRuntimeCopies: 0,
    processRestartRecovery: true
  });

  const nestedLinkStore = path.join(tempRoot, "fresh-nested-link-guard");
  const nestedLinkOutside = path.join(tempRoot, "nested-link-outside");
  const nestedLinkRepository = createFreshIntegrationRepository({
    env: testEnv(nestedLinkStore),
    projectRoot: ROOT,
    clock,
    idFactory
  });
  await nestedLinkRepository.initialize();
  fs.mkdirSync(nestedLinkOutside, { recursive: true });
  const nestedChunks = path.join(nestedLinkStore, "raw", "chunks");
  fs.rmSync(nestedChunks, { recursive: true, force: true });
  try {
    fs.symlinkSync(nestedLinkOutside, nestedChunks, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      nestedLinkRepository.appendRawEvidence([
        rawRow("run_nested_link_guard", "cmp_nested_link_guard", "quick", "2026-07-29T00:00:00.000Z")
      ], { actor: "worker_nested_link_guard" }),
      (error) => errorCode(error) === "FRESH_REPOSITORY_SYMLINK_FORBIDDEN",
      "a managed child symlink/junction must not escape repository I/O"
    );
    assert.deepEqual(fs.readdirSync(nestedLinkOutside), [], "nested junction target must remain untouched");
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
  }

  const targetPayload = {
    targetId: "target_stage228_one",
    targetName: "새봄 글램핑",
    regionCode: "gapyeong",
    regionLabel: "경기 가평",
    source: "stage228-user-seed",
    sourceUrl: sourceUrl("seed"),
    synthetic: true
  };
  const seeded = await repository.seedTarget(targetPayload, { type: "account", id: "admin_stage228", role: "admin" });
  assert.equal(seeded.idempotent, false);
  assert.equal((await repository.seedTarget(targetPayload, "admin_stage228")).idempotent, true);

  const runPayload = {
    runId: "run_stage228_vertical_0001",
    clientRequestId: "stage228-client-0001",
    requestSignature: "a".repeat(64),
    kind: "business-my-lodge",
    collectionKind: "fresh-company-vertical-slice",
    actorAccountId: "account_stage228_business",
    actorRole: "b2b",
    targetId: seeded.target.targetId,
    sourceUrl: sourceUrl("run"),
    provider: "synthetic-stage228",
    synthetic: true,
    input: {
      targetName: "새봄 글램핑",
      regionCode: "gapyeong",
      regionLabel: "경기 가평",
      targetDate: "2026-08-01",
      tenantCompanyId: "tenant_stage228_business"
    },
    currentStage: "discovery",
    checkpoint: { nextStage: "discovery", completedStages: ["target-seed"], attempts: {} }
  };
  const createdRun = await repository.createRun(runPayload, { type: "account", id: runPayload.actorAccountId, role: "b2b" });
  assert.equal(createdRun.idempotent, false);
  assert.equal(createdRun.run.input.tenantCompanyId, "tenant_stage228_business");
  assert.equal((await repository.createRun(runPayload, runPayload.actorAccountId)).idempotent, true);
  assert.equal((await repository.listRuns({ clientRequestId: runPayload.clientRequestId, actorAccountId: runPayload.actorAccountId })).length, 1);

  const candidate = {
    companyName: "새봄 글램핑",
    regionLabel: "경기 가평",
    address: "경기 가평군 신규수집로 1",
    placeId: "syn2280001",
    bookingBusinessId: "syn-booking-2280001"
  };
  const expectedCompanyId = deterministicCompanyId(normalizeCompanyIdentity(candidate));
  assert.equal(expectedCompanyId, "cmp_place_syn2280001", "V2 placeId-first companyId rule");
  const discoveryPayload = {
    companyId: expectedCompanyId,
    discoveryId: "discovery_stage228_0001",
    runId: runPayload.runId,
    targetId: targetPayload.targetId,
    tenantCompanyId: "tenant_stage228_business",
    actorAccountId: runPayload.actorAccountId,
    ...candidate,
    source: "stage228-synthetic-fresh-collection",
    sourceUrl: sourceUrl("discovery"),
    observedAt: "2026-07-29T00:10:00.000Z",
    synthetic: true
  };
  const discovered = await repository.discoverCompany(discoveryPayload, { type: "worker", id: "worker_stage228" });
  assert.equal(discovered.company.companyId, expectedCompanyId);
  assert.equal(discovered.company.identityRule, FRESH_DATA_IDENTITY_RULE);
  assert.deepEqual(discovered.company.tenantCompanyIds, ["tenant_stage228_business"]);
  assert.equal((await repository.discoverCompany(discoveryPayload, "worker_stage228")).idempotent, true);
  const identityLink = await repository.linkCompatibleIdentity({
    companyId: expectedCompanyId,
    compatibleCompanyId: "cmp_legacy_identity_228"
  }, { type: "account", id: "admin_stage228", role: "admin" });
  assert.equal(identityLink.identityLink.linkKind, "identity-metadata-only");
  assert.equal(identityLink.identityLink.importsCompanyDetails, false);
  assert.equal(identityLink.identityLink.importsObservations, false);
  assert.equal((await repository.linkCompatibleIdentity({
    companyId: expectedCompanyId,
    compatibleCompanyId: "cmp_legacy_identity_228"
  }, "admin_stage228")).idempotent, true);
  await assert.rejects(
    repository.discoverCompany({ ...discoveryPayload, discoveryId: "discovery_collision_0001", companyId: "cmp_place_wrong" }),
    (error) => errorCode(error) === "FRESH_COMPANY_ID_COLLISION"
  );

  const fallbackIdentity = normalizeCompanyIdentity({
    companyName: "해솔 캠프",
    regionLabel: "강원 홍천",
    address: "강원 홍천군 새길 2",
    bookingBusinessId: "booking-stage228-2"
  });
  const expectedFallback = `cmp_${require("node:crypto").createHash("sha1").update([
    fallbackIdentity.nameKey,
    fallbackIdentity.addressKey,
    fallbackIdentity.regionKey,
    fallbackIdentity.bookingBusinessId
  ].filter(Boolean).join("|")).digest("hex").slice(0, 16)}`;
  assert.equal(deterministicCompanyId(fallbackIdentity), expectedFallback, "V2 fallback SHA-1 16 companyId rule");
  const duplicateDiscovery = await repository.discoverCompany({
    discoveryId: "discovery_stage228_duplicate_0001",
    companyName: "새봄 캠핑장",
    regionLabel: "경기 가평",
    address: "경기 가평군 신규수집로 99",
    source: "stage228-synthetic-fresh-collection",
    sourceUrl: sourceUrl("discovery", "duplicate"),
    observedAt: "2026-07-29T00:11:00.000Z",
    synthetic: true
  }, { type: "worker", id: "worker_stage228" });
  assert.notEqual(duplicateDiscovery.company.companyId, expectedCompanyId);
  assert.ok((await repository.diagnostics()).duplicateCandidateCount >= 1, "similar loose name + region must create a manual duplicate candidate");

  const lease = await repository.acquireRunLease(runPayload.runId, { workerId: "worker_stage228", leaseSeconds: 60 }, { type: "worker", id: "worker_stage228" });
  assert.equal(lease.run.status, "running");
  assert.ok(lease.lease.leaseId);
  const heartbeat = await repository.heartbeatRun(runPayload.runId, {
    leaseId: lease.lease.leaseId,
    leaseSeconds: 60,
    companyId: expectedCompanyId,
    progress: 15,
    currentStage: "quick",
    checkpoint: { nextStage: "quick", companyId: expectedCompanyId, completedStages: ["target-seed", "discovery"], attempts: { discovery: 1 } }
  }, { type: "worker", id: "worker_stage228" });
  assert.equal(heartbeat.run.companyId, expectedCompanyId);
  assert.equal(heartbeat.run.checkpoint.nextStage, "quick");

  const rawRows = [
    rawRow(runPayload.runId, expectedCompanyId, "quick", "2026-07-29T01:00:00.000Z"),
    rawRow(runPayload.runId, expectedCompanyId, "detail", "2026-07-29T01:01:00.000Z"),
    rawRow(runPayload.runId, expectedCompanyId, "ota", "2026-07-29T01:02:00.000Z")
  ];
  const rawWrite = await repository.appendRawEvidence(rawRows, { actor: { type: "worker", id: "worker_stage228" }, runId: runPayload.runId });
  assert.equal(rawWrite.inserted, 3);
  assert.equal(rawWrite.evidence[0].rawEvidenceId, rawWrite.evidence[0].evidenceId, "raw ID aliases must be preserved");
  assert.equal((await repository.appendRawEvidence(rawRows, { actor: "worker_stage228", runId: runPayload.runId })).duplicates, 3);
  await assert.rejects(
    repository.appendRawEvidence([{ ...rawRows[0], evidenceId: "raw_forbidden_path", rawEvidenceId: "raw_forbidden_path", payload: { path: "C:\\legacy\\outputs\\one.json" } }], { actor: "worker_stage228" }),
    (error) => errorCode(error) === "FRESH_RAW_PATH_FORBIDDEN"
  );

  const observations = [
    observationRow(runPayload.runId, expectedCompanyId, "quick", 1, { evidenceId: rawRows[0].rawEvidenceId, kind: "profile.company-name", value: "새봄 글램핑" }),
    observationRow(runPayload.runId, expectedCompanyId, "quick", 2, { evidenceId: rawRows[0].rawEvidenceId, kind: "profile.region", value: "test-region" }),
    observationRow(runPayload.runId, expectedCompanyId, "quick", 3, { evidenceId: rawRows[0].rawEvidenceId, kind: "profile.category", value: "glamping" }),
    observationRow(runPayload.runId, expectedCompanyId, "quick", 4, { evidenceId: rawRows[0].rawEvidenceId, kind: "profile.location", value: { latitude: 35.1, longitude: 127.1 } }),
    observationRow(runPayload.runId, expectedCompanyId, "detail", 5, { evidenceId: rawRows[1].rawEvidenceId, kind: "product.price", value: 145000 }),
    observationRow(runPayload.runId, expectedCompanyId, "detail", 6, { evidenceId: rawRows[1].rawEvidenceId, kind: "product.total-stock", value: 5 }),
    observationRow(runPayload.runId, expectedCompanyId, "detail", 7, { evidenceId: rawRows[1].rawEvidenceId, kind: "product.available-stock", value: 2 }),
    observationRow(runPayload.runId, expectedCompanyId, "ota", 8, { evidenceId: rawRows[2].rawEvidenceId, kind: "ota.exposure", channel: "naver", value: true }),
    observationRow(runPayload.runId, expectedCompanyId, "detail", 9, { evidenceId: rawRows[1].rawEvidenceId, kind: "product.price", value: 149000, observedAt: "2026-07-29T02:00:00.000Z" })
  ];
  const observationWrite = await repository.appendObservations(observations, { actor: { type: "worker", id: "worker_stage228" }, runId: runPayload.runId });
  assert.equal(observationWrite.inserted, 9);
  assert.equal(observationWrite.observations[0].kind, "profile.company-name");
  assert.equal(observationWrite.observations[0].rawEvidenceId, rawRows[0].rawEvidenceId);
  assert.equal(observationWrite.observations[0].provenance.source, "stage228-synthetic-fresh-collection");
  assert.equal((await repository.listObservations({ companyId: expectedCompanyId, targetDate: "2026-08-01" })).length, 9);
  assert.equal((await repository.appendObservations(observations, { actor: "worker_stage228" })).duplicates, 9);

  const bulk = [];
  for (let index = 0; index < 10_000; index += 1) {
    bulk.push(observationRow(runPayload.runId, expectedCompanyId, "detail", index + 10_000, {
      evidenceId: rawRows[1].rawEvidenceId,
      observationId: `obs_bulk_${String(index).padStart(8, "0")}`,
      observedAt: new Date(Date.parse("2026-07-30T00:00:00.000Z") + index).toISOString(),
      productKey: "lodging-repeat",
      value: { price: 100000 + index }
    }));
  }
  const bulkStartedAt = performance.now();
  const bulkWrite = await repository.appendObservations(bulk, { actor: "worker_stage228", runId: runPayload.runId });
  const bulkAppendMs = Math.round((performance.now() - bulkStartedAt) * 100) / 100;
  assert.equal(bulkWrite.inserted, 10_000);
  const replayStartedAt = performance.now();
  const bulkReplay = await repository.appendObservations(bulk, { actor: "worker_stage228", runId: runPayload.runId });
  const bulkReplayMs = Math.round((performance.now() - replayStartedAt) * 100) / 100;
  assert.equal(bulkReplay.inserted, 0);
  assert.equal(bulkReplay.duplicates, 10_000);
  assert.ok(bulkAppendMs < 10_000, `10,000 observation append exceeded 10s: ${bulkAppendMs}ms`);
  assert.ok(bulkReplayMs < 10_000, `10,000 observation idempotent replay exceeded 10s: ${bulkReplayMs}ms`);
  assert.equal((await repository.listObservations({ companyId: expectedCompanyId, productKey: "lodging-repeat", limit: 20_000 })).length, 10_000);

  const approvedOne = await repository.reviewVerifiedProfile({
    companyId: expectedCompanyId,
    reviewRequestId: "review_stage228_0001",
    decision: "approve",
    reason: "신규 합성 evidence와 업체명을 수동 검수함",
    profile: { primaryName: "새봄 글램핑", region: "경기 가평", address: "경기 가평군 신규수집로 1", phone: "010-0000-2280" }
  }, { type: "account", id: "admin_stage228", role: "admin" });
  assert.equal(approvedOne.profile.status, "approved");
  assert.equal(approvedOne.profile.reviewedBy, "admin_stage228");
  assert.equal(approvedOne.profile.reviewedByType, "account");
  const projectionOne = await repository.refreshDerivedProfile(expectedCompanyId, { type: "worker", id: "worker_stage228" });
  assert.equal(projectionOne.derived.dataCompleteness.score, 100);
  assert.equal(projectionOne.businessSafe.state, "ready");
  assert.equal(projectionOne.businessSafe.provenance.summary, "Stage 228 신규 합성 수집 provenance 100%");
  assert.equal(projectionOne.businessSafe.sourceBoundary, "fresh-integration-only");
  assert.match(projectionOne.businessSafe.observations.displayCount, /회$/);
  assert.ok(projectionOne.businessSafe.observations.repeatCount > 1, "same company/product/targetDate repeat observations must be preserved");

  const allowed = await repository.getBusinessSafeCompany(expectedCompanyId, "tenant_stage228_business");
  assert.equal(allowed.companyId, expectedCompanyId);
  assert.equal((await repository.listBusinessSafeCompanies("tenant_stage228_business")).length, 1);
  await assert.rejects(
    repository.getBusinessSafeCompany(expectedCompanyId, "tenant_stage228_other"),
    (error) => error.statusCode === 403 && errorCode(error) === "FRESH_TENANT_FORBIDDEN"
  );
  assert.equal((await repository.listBusinessSafeCompanies("tenant_stage228_other")).length, 0);

  const snapshot = await repository.createSnapshot({ type: "account", id: "admin_stage228", role: "admin" }, "before-second-review");
  assert.equal(snapshot.snapshotKind, "fresh-integration-store-snapshot");
  assert.equal(snapshot.createdBy, "admin_stage228");
  assert.ok(snapshot.fileCount > 5, "snapshot must contain restorable fresh store files, not only a source hash");
  assert.equal(Object.hasOwn(snapshot, "sourceStoreHash"), false);
  assert.equal((await repository.listSnapshots()).length, 1);

  const approvedTwo = await repository.reviewVerifiedProfile({
    companyId: expectedCompanyId,
    reviewRequestId: "review_stage228_0002",
    decision: "approve",
    expectedVersion: 1,
    reason: "표시명 변경을 수동 승인함",
    profile: { primaryName: "새봄 프리미엄 글램핑", region: "경기 가평", address: "경기 가평군 신규수집로 1" }
  }, { type: "account", id: "admin_stage228", role: "admin" });
  assert.equal(approvedTwo.profile.version, 2);
  assert.equal((await repository.getCompany(expectedCompanyId, { projection: "verified" })).profile.primaryName, "새봄 프리미엄 글램핑");
  const rollback = await repository.rollbackSnapshot(snapshot.snapshotId, { type: "account", id: "admin_stage228", role: "admin" });
  assert.equal(rollback.ok, true);
  assert.equal((await repository.getCompany(expectedCompanyId, { projection: "verified" })).profile.primaryName, "새봄 글램핑");
  assert.equal((await repository.listAudit({ event: "snapshot.rolled-back" })).length, 1);
  const rejected = await repository.reviewVerifiedProfile({
    companyId: expectedCompanyId,
    reviewRequestId: "review_stage228_reject_0001",
    decision: "reject",
    expectedVersion: 1,
    reason: "근거가 부족한 표시명 후보를 반려함",
    profile: { primaryName: "근거 없는 표시명" }
  }, { type: "account", id: "admin_stage228", role: "admin" });
  assert.equal(rejected.profile.status, "rejected");
  assert.equal(rejected.review.before.status, "approved");
  assert.equal(rejected.review.after.rejectedCandidate.primaryName, "근거 없는 표시명");
  assert.equal((await repository.listAudit({ event: "verified.rejected" })).length, 1, "rejection before/after must be audited");
  await repository.rollbackSnapshot(snapshot.snapshotId, { type: "account", id: "admin_stage228", role: "admin" });
  assert.equal((await repository.listAudit({ event: "verified.rejected" })).length, 1, "rollback must preserve the append-only audit of the reverted review");

  const failure = await repository.failRun(runPayload.runId, {
    leaseId: lease.lease.leaseId,
    retryable: true,
    code: "SYNTHETIC_TRANSIENT",
    message: "합성 transient",
    nextAttemptAt: "2026-07-29T00:01:00.000Z",
    checkpoint: heartbeat.run.checkpoint,
    currentStage: "quick"
  }, { type: "worker", id: "worker_stage228" });
  assert.equal(failure.run.status, "retry-wait");
  assert.equal(failure.terminal, false);
  assert.equal(failure.run.checkpoint.nextStage, "quick");
  const resumed = await repository.resumeRun(runPayload.runId, { reason: "retry-backoff-elapsed" }, { type: "worker", id: "worker_stage228" });
  assert.equal(resumed.run.status, "queued");
  assert.equal(resumed.run.checkpoint.nextStage, "quick", "resume must preserve checkpoint");
  tick += 120_000;
  const secondLease = await repository.acquireRunLease(runPayload.runId, { workerId: "worker_stage228", leaseSeconds: 60 }, "worker_stage228");
  const completed = await repository.completeRun(runPayload.runId, {
    leaseId: secondLease.lease.leaseId,
    companyId: expectedCompanyId,
    currentStage: "completed",
    checkpoint: { ...resumed.run.checkpoint, nextStage: "completed" },
    result: { companyId: expectedCompanyId, dataBoundary: "fresh-integration-only" }
  }, "worker_stage228");
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.run.progress, 100);

  const restarted = createFreshIntegrationRepository({ env: testEnv(), projectRoot: ROOT, clock, idFactory });
  const restartedSummary = await restarted.initialize();
  assert.equal(restartedSummary.storeId, firstBootstrap.storeId);
  assert.equal(restartedSummary.counts.observations, 10_009);
  assert.equal((await restarted.getRun(runPayload.runId)).status, "completed");
  assert.equal((await restarted.getBusinessSafeCompany(expectedCompanyId, "tenant_stage228_business")).companyId, expectedCompanyId);
  const diagnostics = await restarted.diagnostics();
  assert.equal(diagnostics.companyIdCollisions, 0);
  assert.equal(diagnostics.providerCalls, 0);
  assert.equal(diagnostics.legacyRuntimeReads, 0);
  assert.equal(diagnostics.legacyRuntimeCopies, 0);
  assert.equal(diagnostics.layerCounts.raw, 3);
  assert.equal(diagnostics.layerCounts.observation, 10_009);
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyDir, "must-not-read.json"), "utf8")).secretLegacySentinel, true);

  const audit = await restarted.listAudit({ limit: 10_000 });
  assert.ok(audit.some((row) => row.event === "verified.approved" && row.details.before === null && row.details.after.profile.primaryName === "새봄 글램핑"));
  assert.ok(audit.every((row) => row.actor !== "[object Object]"));
  const provenanceRows = await restarted.listObservations({ companyId: expectedCompanyId, limit: 20_000 });
  assert.equal(provenanceRows.filter((row) => [
    row.provenance.source,
    row.provenance.runId,
    row.provenance.observedAt,
    row.provenance.targetDate,
    row.provenance.channel,
    row.provenance.productKey,
    row.provenance.sourceUrl
  ].every(Boolean)).length, provenanceRows.length, "new collection provenance must be 100%");

  console.log(JSON.stringify({
    ok: true,
    schemaVersion: diagnostics.schemaVersion,
    storeKind: diagnostics.storeKind,
    companyId: expectedCompanyId,
    companyIdCollisions: diagnostics.companyIdCollisions,
    rawEvidence: diagnostics.layerCounts.raw,
    observations: diagnostics.layerCounts.observation,
    provenanceCoverage: 1,
    bulkAppendMs,
    bulkReplayMs,
    snapshots: (await restarted.listSnapshots()).length,
    legacyRuntimeReads: diagnostics.legacyRuntimeReads,
    legacyRuntimeCopies: diagnostics.legacyRuntimeCopies,
    providerCalls: diagnostics.providerCalls
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  safeRemove(tempRoot);
});
