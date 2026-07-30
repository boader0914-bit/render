"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  FRESH_EXPLORATION_MAX_COMPANIES,
  FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY,
  FRESH_EXPLORATION_SOURCE_ASSET,
  createFreshPlatformService,
  explorationCompanyRef,
  publicCollectionConnectors,
  safeCollectionBlockers,
  verifiedChanges
} = require("./integration/services/fresh_platform_service.cjs");
const {
  createFreshDataHttpHandler
} = require("./integration/http/fresh_data_http.cjs");
const {
  FRESH_MAP_BOUNDARY_SHA256,
  canonicalizeFreshMapBoundaryPayload
} = require("./integration/assets/fresh_map_boundary.cjs");
const {
  ROOT,
  startServer,
  stopServer
} = require("./test_stage227_helpers.cjs");

const NOW = Date.parse("2026-07-30T00:00:00.000Z");
const TENANT_ONE = "tenant_exploration_one";
const TENANT_TWO = "tenant_exploration_two";
const TENANT_RANGE = "tenant_exploration_range";
const TENANT_EMPTY = "tenant_exploration_empty";
const TENANT_HIDDEN = "tenant_exploration_hidden";
const COMPANY_A = "cmp_live_exploration_a";
const COMPANY_B = "cmp_live_exploration_b_private_peer_id";
const COMPANY_OTHER = "cmp_live_exploration_other_tenant";
const COMPANY_SYNTHETIC = "cmp_synthetic_exploration_must_not_leak";
const COMPANY_RANGE = "cmp_live_exploration_out_of_range";
const COMPANY_EMPTY = "cmp_live_exploration_not_collected";
const COMPANY_HIDDEN = "cmp_live_exploration_not_exposed";
const MAP_BOUNDARY_ENDPOINT = "/api/integration/fresh/map-boundary/kostat-2013-v1";

function clone(value) {
  return structuredClone(value);
}

function serviceError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function session(role, tenantCompanyId = "") {
  return {
    accountId: `account_${role}_${tenantCompanyId || "global"}`,
    account: { role: role === "admin" ? "admin" : "b2b" },
    memberships: tenantCompanyId ? [{ companyId: tenantCompanyId, status: "active" }] : []
  };
}

function projection(companyId, tenantCompanyId, name, options = {}) {
  return {
    companyId,
    tenantCompanyId,
    projection: "business-safe",
    synthetic: options.synthetic === true,
    dataMode: options.synthetic === true ? "synthetic-test" : "live",
    name,
    region: options.region || "서울특별시",
    identity: { confidence: options.confidence || "high" }
  };
}

let observationSerial = 0;
function observation(companyId, kind, value, options = {}) {
  const synthetic = options.synthetic === true;
  return {
    observationId: `obs_exploration_${++observationSerial}`,
    companyId,
    observationType: kind,
    kind,
    source: options.source || "v2-live-collection",
    provider: options.source || "v2-live-collection",
    values: clone(value),
    value: clone(value),
    targetDate: options.targetDate || "2026-07-30",
    channel: options.channel || (kind.startsWith("profile.") ? "naver-search" : "direct"),
    productKey: options.productKey || (kind.startsWith("profile.") ? "company" : "room-a"),
    observedAt: options.observedAt || "2026-07-29T12:00:00.000Z",
    synthetic,
    dataMode: synthetic ? "synthetic-test" : "live",
    sourceUrl: options.sourceUrl || "https://provider.example.invalid/private/source",
    rawEvidenceId: "raw_private_evidence_must_not_leak",
    evidenceId: "raw_private_evidence_must_not_leak",
    provenance: {
      sourceUrl: options.sourceUrl || "https://provider.example.invalid/private/source",
      rawPath: "C:\\private\\fresh\\raw-output.json",
      coordinateConfidence: options.coordinateConfidence || "",
      coordinateReviewStatus: options.coordinateReviewStatus || "",
      searchConditionId: options.searchConditionId || ""
    }
  };
}

function createHarness() {
  const definitions = [
    projection(COMPANY_A, TENANT_ONE, "캐시 합성 이름 A", { confidence: "certain" }),
    projection(COMPANY_B, TENANT_ONE, "동일 tenant 숙소 B", { confidence: "medium" }),
    projection(COMPANY_OTHER, TENANT_TWO, "다른 tenant 숙소"),
    projection(COMPANY_SYNTHETIC, TENANT_ONE, "합성 숙소", { synthetic: true }),
    projection(COMPANY_RANGE, TENANT_RANGE, "범위 밖 숙소"),
    projection(COMPANY_EMPTY, TENANT_EMPTY, "미수집 숙소"),
    projection(COMPANY_HIDDEN, TENANT_HIDDEN, "미노출 숙소")
  ];
  const rows = new Map(definitions.map((row) => [row.companyId, []]));
  rows.get(COMPANY_A).push(
    observation(COMPANY_A, "profile.company-name", "내 숙소 A"),
    observation(COMPANY_A, "profile.region", "서울특별시"),
    observation(COMPANY_A, "profile.category", "glamping"),
    observation(COMPANY_A, "profile.location", { latitude: 37.5665, longitude: 126.978 }, { coordinateConfidence: "certain" }),
    observation(COMPANY_A, "profile.rank", 3, { searchConditionId: "query-digest-common-001" }),
    observation(COMPANY_A, "profile.rank", 4, { channel: "partner-platform", searchConditionId: "query-digest-common-001" }),
    observation(COMPANY_A, "product.price", 100000),
    observation(COMPANY_A, "product.price", 140000, { productKey: "room-b" }),
    observation(COMPANY_A, "product.total-stock", 10),
    observation(COMPANY_A, "product.total-stock", 6, { productKey: "room-b" }),
    observation(COMPANY_A, "product.available-stock", 4),
    observation(COMPANY_A, "product.available-stock", 3, { productKey: "room-b" }),
    observation(COMPANY_A, "product.total-stock", 10, { observedAt: "2026-07-16T00:00:00.000Z" }),
    observation(COMPANY_A, "product.available-stock", 8, { observedAt: "2026-07-16T00:00:00.000Z" }),
    observation(COMPANY_A, "product.total-stock", 10, { observedAt: "2026-07-23T00:00:00.000Z" }),
    observation(COMPANY_A, "product.available-stock", 6, { observedAt: "2026-07-23T00:00:00.000Z" }),
    observation(COMPANY_A, "ota.exposure", false, { channel: "ota-a" }),
    observation(COMPANY_A, "ota.exposure", true, { targetDate: "2026-07-31", channel: "ota-b" }),
    observation(COMPANY_A, "product.price", 999999, { targetDate: "2026-06-01" }),
    observation(COMPANY_A, "profile.location", { latitude: 0, longitude: 0 }, { synthetic: true, observedAt: "2026-07-30T23:00:00.000Z" }),
    observation(COMPANY_A, "profile.rank", 1, { synthetic: true, observedAt: "2026-07-30T23:00:00.000Z" })
  );
  rows.get(COMPANY_B).push(
    observation(COMPANY_B, "profile.company-name", "동일 tenant 숙소 B"),
    observation(COMPANY_B, "profile.region", "서울특별시"),
    observation(COMPANY_B, "profile.category", "glamping"),
    observation(COMPANY_B, "profile.location", { latitude: 35.1796, longitude: 129.0756 }),
    observation(COMPANY_B, "profile.rank", 5, { searchConditionId: "query-digest-common-001" }),
    observation(COMPANY_B, "profile.rank", 8, { channel: "partner-platform", searchConditionId: "query-digest-common-001" }),
    observation(COMPANY_B, "profile.rank", 1, { targetDate: "2026-07-31", searchConditionId: "query-digest-common-001" })
  );
  rows.get(COMPANY_OTHER).push(
    observation(COMPANY_OTHER, "profile.company-name", "다른 tenant 숙소"),
    observation(COMPANY_OTHER, "profile.region", "제주특별자치도"),
    observation(COMPANY_OTHER, "profile.location", { latitude: 33.4996, longitude: 126.5312 }),
    observation(COMPANY_OTHER, "profile.rank", 2, { searchConditionId: "query-digest-common-001" })
  );
  rows.get(COMPANY_SYNTHETIC).push(
    observation(COMPANY_SYNTHETIC, "profile.location", { latitude: 37.1, longitude: 127.1 }, { synthetic: true }),
    observation(COMPANY_SYNTHETIC, "profile.rank", 1, { synthetic: true })
  );
  rows.get(COMPANY_RANGE).push(
    observation(COMPANY_RANGE, "profile.company-name", "범위 밖 숙소"),
    observation(COMPANY_RANGE, "profile.region", "범위 밖"),
    observation(COMPANY_RANGE, "profile.location", { latitude: 10, longitude: 10 }),
    observation(COMPANY_RANGE, "profile.rank", -1, { searchConditionId: "query-digest-range-001" }),
    observation(COMPANY_RANGE, "product.price", 123000, { targetDate: "2027-01-01" })
  );
  rows.get(COMPANY_HIDDEN).push(
    observation(COMPANY_HIDDEN, "profile.location", {}),
    observation(COMPANY_HIDDEN, "profile.rank", null),
    observation(COMPANY_HIDDEN, "ota.exposure", false, { channel: "ota-hidden" })
  );

  const record = (companyId) => definitions.find((row) => row.companyId === companyId) || null;
  function accessible(company, tenantCompanyId) {
    return !tenantCompanyId || company.tenantCompanyId === tenantCompanyId;
  }
  const repository = {
    async listCompanies(options = {}) {
      return clone(definitions.filter((row) => accessible(row, options.tenantCompanyId)));
    },
    async getCompany(companyId, options = {}) {
      const company = record(companyId);
      if (!company) throw serviceError("company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      if (!accessible(company, options.tenantCompanyId)) {
        throw serviceError("tenant forbidden", "FRESH_TENANT_FORBIDDEN", 403);
      }
      return clone(company);
    },
    async listBusinessSafeCompanies(tenantCompanyId) {
      return clone(definitions.filter((row) => row.tenantCompanyId === tenantCompanyId));
    },
    async getBusinessSafeCompany(companyId, tenantCompanyId) {
      const company = record(companyId);
      if (!company) throw serviceError("company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      if (company.tenantCompanyId !== tenantCompanyId) {
        throw serviceError("tenant forbidden", "FRESH_TENANT_FORBIDDEN", 403);
      }
      return clone(company);
    },
    async listObservations(filter = {}) {
      return clone(rows.get(filter.companyId) || []);
    },
    async listAudit() {
      return [];
    }
  };
  const authService = {
    assertCompanyAccess(currentSession, requestedTenantCompanyId) {
      if (currentSession?.account?.role === "admin") return { company: { companyId: requestedTenantCompanyId } };
      if (currentSession?.memberships?.[0]?.companyId !== requestedTenantCompanyId) {
        throw serviceError("tenant forbidden", "FRESH_TENANT_FORBIDDEN", 403);
      }
      return { company: { companyId: requestedTenantCompanyId } };
    },
    assertRequestBoundary() {
      return true;
    }
  };
  const worker = {
    diagnostics() {
      return {
        providerId: "v2-live-test-provider",
        providerKind: "live",
        providerEnabled: true,
        provider: { externalNetworkCalls: 0, syntheticCalls: 0 }
      };
    }
  };
  const collectionService = { projectStage227Job: (value) => clone(value) };
  const service = createFreshPlatformService({
    repository,
    authService,
    worker,
    collectionService,
    clock: () => NOW
  });
  return { service, authService };
}

function createReadOnlyExplorationService(definitions, rowsForCompany, diagnostics = {}) {
  const repository = {
    async listCompanies(options = {}) {
      return clone(definitions.filter((row) => !options.tenantCompanyId || row.tenantCompanyId === options.tenantCompanyId));
    },
    async getCompany(companyId, options = {}) {
      const company = definitions.find((row) => row.companyId === companyId);
      if (!company) throw serviceError("company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      if (options.tenantCompanyId && company.tenantCompanyId !== options.tenantCompanyId) {
        throw serviceError("tenant forbidden", "FRESH_TENANT_FORBIDDEN", 403);
      }
      return clone(company);
    },
    async listBusinessSafeCompanies(tenantCompanyId) {
      return clone(definitions.filter((row) => row.tenantCompanyId === tenantCompanyId));
    },
    async getBusinessSafeCompany(companyId, tenantCompanyId) {
      return this.getCompany(companyId, { tenantCompanyId });
    },
    async listObservations(filter = {}) {
      diagnostics.observationReads = Number(diagnostics.observationReads || 0) + 1;
      diagnostics.maximumRequestedLimit = Math.max(Number(diagnostics.maximumRequestedLimit || 0), Number(filter.limit || 0));
      return clone(await rowsForCompany(filter.companyId, filter));
    }
  };
  const authService = {
    assertCompanyAccess(_currentSession, requestedTenantCompanyId) {
      return { company: { companyId: requestedTenantCompanyId } };
    },
    assertRequestBoundary() {
      return true;
    }
  };
  return createFreshPlatformService({
    repository,
    authService,
    worker: {
      diagnostics: () => ({
        providerId: "v2-live-test-provider",
        providerKind: "live",
        providerEnabled: true,
        provider: { externalNetworkCalls: 0, syntheticCalls: 0 }
      })
    },
    collectionService: { projectStage227Job: (value) => clone(value) },
    clock: () => NOW
  });
}

function assertNoSensitiveProjection(value) {
  const forbiddenKeys = /^(?:sourceUrl|rawEvidenceId|evidenceId|rawPath|runId|observationId|provenance)$/i;
  const seen = new Set();
  function visit(current) {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      assert.equal(forbiddenKeys.test(key), false, `sensitive key leaked: ${key}`);
      visit(child);
    }
  }
  visit(value);
}

async function assertHttpRoute(service, authService, business) {
  let sent = null;
  let currentSession = business;
  const handler = createFreshDataHttpHandler({
    service,
    authService,
    authHttp: {
      requestContext: () => ({ host: "example.test", origin: "https://example.test" }),
      sessionForRequest: () => currentSession
    },
    send(_res, status, body) {
      sent = { status, body };
    },
    parseBody: async () => ({})
  });
  const handled = await handler.handle(
    { method: "GET" },
    {},
    new URL(`https://example.test/api/integration/fresh/exploration?tenantCompanyId=${TENANT_ONE}&companyId=${COMPANY_A}`)
  );
  assert.equal(handled, true);
  assert.equal(sent.status, 400);
  assert.equal(sent.body.code, "FRESH_EXPLORATION_COMPANY_REF_REQUIRED");

  sent = null;
  await handler.handle(
    { method: "GET" },
    {},
    new URL(`https://example.test/api/integration/fresh/exploration?tenantCompanyId=${TENANT_ONE}&companyRef=${explorationCompanyRef(COMPANY_A)}`)
  );
  assert.equal(sent.status, 200);
  assert.deepEqual(Object.keys(sent.body).sort(), ["exploration", "metadata", "ok"]);
  assert.equal(sent.body.ok, true);
  assert.deepEqual(sent.body.metadata.exploration, {
    stage: 231,
    dataBoundary: "fresh-live-only",
    synthetic: false,
    dataMode: "live",
    windowDays: 30,
    axisEveryDays: 7
  });
  assert.equal(Object.hasOwn(sent.body.exploration.scope, "companyId"), false);
  assert.equal(sent.body.exploration.scope.companyRef, explorationCompanyRef(COMPANY_A));

  sent = null;
  await handler.handle(
    { method: "GET" },
    {},
    new URL(`https://example.test/api/integration/fresh/exploration?tenantCompanyId=${TENANT_ONE}&companyRef=${explorationCompanyRef(COMPANY_B)}`)
  );
  assert.equal(sent.status, 200);
  assert.equal(Object.hasOwn(sent.body.exploration.scope, "companyId"), false);
  assert.equal(sent.body.exploration.scope.companyRef, explorationCompanyRef(COMPANY_B));
  assert.equal(sent.body.exploration.timeline.state, "not-collected");
  assert.equal(JSON.stringify(sent.body.exploration).includes(COMPANY_B), false);

  sent = null;
  await handler.handle(
    { method: "GET" },
    {},
    new URL(`https://example.test/api/integration/fresh/exploration?tenantCompanyId=${TENANT_ONE}&companyRef=${explorationCompanyRef(COMPANY_OTHER)}`)
  );
  assert.equal(sent.status, 404);
  assert.equal(sent.body.code, "FRESH_EXPLORATION_SELECTION_NOT_FOUND");

  currentSession = session("admin");
  sent = null;
  await handler.handle(
    { method: "GET" },
    {},
    new URL(`https://example.test/api/integration/fresh/exploration?tenantCompanyId=${TENANT_ONE}&companyId=${COMPANY_A}`)
  );
  assert.equal(sent.status, 200);
  assert.equal(sent.body.exploration.scope.companyId, COMPANY_A);
}

async function assertInternalErrorRedaction(authService, business) {
  let sent = null;
  const service = {
    metadata: () => ({ dataBoundary: "fresh-integration-only" }),
    explorationMetadata: () => ({ dataBoundary: "fresh-live-only" }),
    async getExploration() {
      throw new Error("ENOENT: C:\\private\\fresh\\raw-output.json");
    }
  };
  const handler = createFreshDataHttpHandler({
    service,
    authService,
    authHttp: {
      requestContext: () => ({ host: "example.test", origin: "https://example.test" }),
      sessionForRequest: () => business
    },
    send(_res, status, body) {
      sent = { status, body };
    },
    parseBody: async () => ({})
  });
  await handler.handle(
    { method: "GET" },
    {},
    new URL("https://example.test/api/integration/fresh/exploration")
  );
  assert.equal(sent.status, 500);
  assert.equal(sent.body.code, "FRESH_INTERNAL_ERROR");
  assert.equal(sent.body.error, "통합 데이터를 처리하지 못했습니다.");
  assert.equal(JSON.stringify(sent.body).includes("C:\\private\\fresh"), false);
}

async function assertBoundedExplorationReads() {
  const companyDiagnostics = {};
  const companies = Array.from({ length: FRESH_EXPLORATION_MAX_COMPANIES + 3 }, (_unused, index) => (
    projection(`cmp_cap_${String(index).padStart(4, "0")}`, "tenant_cap", `공개 숙소 ${index}`, { region: "서울특별시" })
  ));
  const companyService = createReadOnlyExplorationService(
    companies,
    async (companyId) => [
      observation(companyId, "profile.company-name", `실수집 ${companyId}`),
      observation(companyId, "profile.region", "서울특별시"),
      observation(companyId, "profile.location", { latitude: 37.5, longitude: 127.0 }, { coordinateConfidence: "medium" })
    ],
    companyDiagnostics
  );
  const cappedCompanies = await companyService.getExploration(session("admin"));
  assert.equal(companyDiagnostics.observationReads, FRESH_EXPLORATION_MAX_COMPANIES);
  assert.equal(cappedCompanies.scope.companyCount, FRESH_EXPLORATION_MAX_COMPANIES);
  assert.equal(cappedCompanies.scope.companyLimitReached, true);
  assert.equal(cappedCompanies.map.state, "partial");

  const observationDiagnostics = {};
  const oneCompany = projection("cmp_observation_cap", "tenant_observation_cap", "cached identity", { region: "cached region" });
  const fillerCount = FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY - 3;
  const manyRows = [
    observation(oneCompany.companyId, "product.price", 100_000, { targetDate: "2026-07-30" }),
    ...Array.from({ length: fillerCount }, (_unused, index) => observation(
      oneCompany.companyId,
      "product.price",
      100_001 + index,
      { targetDate: "2026-07-30", productKey: `room-${index}` }
    )),
    observation(oneCompany.companyId, "profile.company-name", "실수집 관측 제한 숙소"),
    observation(oneCompany.companyId, "profile.region", "서울특별시"),
    observation(oneCompany.companyId, "profile.location", { latitude: 37.5, longitude: 127.0 }, { coordinateReviewStatus: "approved" })
  ];
  assert.equal(manyRows.length, FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY + 1);
  const observationService = createReadOnlyExplorationService(
    [oneCompany],
    async () => manyRows,
    observationDiagnostics
  );
  const cappedObservations = await observationService.getExploration(session("admin"), "", oneCompany.companyId);
  assert.equal(observationDiagnostics.maximumRequestedLimit, FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY + 1);
  assert.equal(cappedObservations.scope.observationCount, FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY);
  assert.equal(cappedObservations.scope.observationLimitReached, true);
  assert.equal(cappedObservations.map.state, "partial");
  assert.equal(cappedObservations.map.markers[0].coordinateConfidence, "verified");

  const noConditionCompany = projection("cmp_rank_without_condition", "tenant_rank_without_condition", "cached rank identity");
  const noConditionService = createReadOnlyExplorationService(
    [noConditionCompany],
    async () => [
      observation(noConditionCompany.companyId, "profile.company-name", "조건 없는 실수집 숙소"),
      observation(noConditionCompany.companyId, "profile.region", "서울특별시"),
      observation(noConditionCompany.companyId, "profile.rank", 1)
    ]
  );
  const noCondition = await noConditionService.getExploration(session("admin"), "", noConditionCompany.companyId);
  assert.equal(noCondition.ranking.state, "not-collected");
  assert.equal(noCondition.ranking.condition.searchCondition, "required");
  assert.deepEqual(noCondition.ranking.rows, []);
}

async function assertVersionedBoundaryEndpoint() {
  const assetPath = path.join(ROOT, "web", "assets", "korea_municipalities.geojson");
  const sourcePayload = fs.readFileSync(assetPath);
  const allowlistedPayload = canonicalizeFreshMapBoundaryPayload(sourcePayload);
  const lfPayload = Buffer.from(sourcePayload.toString("utf8").replace(/\r\n|\r|\n/g, "\n"), "utf8");
  assert.deepEqual(
    canonicalizeFreshMapBoundaryPayload(lfPayload),
    allowlistedPayload,
    "boundary checksum bytes must be identical on Linux and Windows checkouts"
  );
  assert.equal(crypto.createHash("sha256").update(allowlistedPayload).digest("hex"), FRESH_MAP_BOUNDARY_SHA256);

  let enabledServer;
  let disabledServer;
  try {
    enabledServer = await startServer({
      authFlag: true,
      coreFlag: true,
      freshCompanyFlag: true,
      freshObservationFlag: true,
      extraEnv: { V2_INTEGRATION_MAP_RANKING_ENABLED: "true" }
    });
    const response = await fetch(`${enabledServer.baseUrl}${MAP_BOUNDARY_ENDPOINT}`);
    const payload = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/geo+json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(response.headers.get("content-length"), String(allowlistedPayload.length));
    assert.equal(response.headers.get("etag"), `"sha256-${FRESH_MAP_BOUNDARY_SHA256}"`);
    assert.equal(crypto.createHash("sha256").update(payload).digest("hex"), FRESH_MAP_BOUNDARY_SHA256);
    const parsed = JSON.parse(payload.toString("utf8"));
    assert.equal(parsed.type, "FeatureCollection");
    assert.ok(parsed.features.length > 200);
    assert.deepEqual([...new Set(parsed.features.map((feature) => feature.geometry?.type))].sort(), ["MultiPolygon", "Polygon"]);
    assert.equal(payload.includes(Buffer.from(ROOT, "utf8")), false, "boundary response exposed a repository path");

    const head = await fetch(`${enabledServer.baseUrl}${MAP_BOUNDARY_ENDPOINT}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "application/geo+json; charset=utf-8");
    assert.equal(head.headers.get("content-length"), String(allowlistedPayload.length));
    assert.equal(await head.text(), "");

    const cached = await fetch(`${enabledServer.baseUrl}${MAP_BOUNDARY_ENDPOINT}`, {
      headers: { "If-None-Match": `"sha256-${FRESH_MAP_BOUNDARY_SHA256}"` }
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");

    const rejectedMethod = await fetch(`${enabledServer.baseUrl}${MAP_BOUNDARY_ENDPOINT}`, { method: "POST" });
    assert.equal(rejectedMethod.status, 405);
    assert.equal(rejectedMethod.headers.get("allow"), "GET, HEAD");

    disabledServer = await startServer({
      authFlag: true,
      coreFlag: true,
      freshCompanyFlag: true,
      freshObservationFlag: true
    });
    const disabled = await fetch(`${disabledServer.baseUrl}${MAP_BOUNDARY_ENDPOINT}`);
    assert.equal(disabled.status, 404, "map boundary must not exist while the effective map/ranking flag is off");
    assert.equal(JSON.stringify(await disabled.json()).includes(assetPath), false);
  } finally {
    await stopServer(disabledServer);
    await stopServer(enabledServer);
  }
}

async function main() {
  const coordinateAudits = [{
    event: "coordinates.rejected",
    auditId: "audit_coordinate_rejected",
    at: "2026-07-30T00:00:00.000Z",
    details: {
      before: { approvedCoordinates: { latitude: 35.1, longitude: 129.1 } },
      after: { candidate: { latitude: 35.2, longitude: 129.2 } }
    }
  }];
  assert.deepEqual(verifiedChanges(coordinateAudits), [], "business projection must hide rejected coordinate candidates");
  assert.deepEqual(new Set(verifiedChanges(coordinateAudits, { admin: true }).map((row) => row.fieldLabel)), new Set(["위도", "경도"]));

  assert.deepEqual(safeCollectionBlockers([
    "approval-manifest-invalid",
    "kill-switch-open:naver-search",
    "secret=must-not-leak"
  ]), [
    "승인 manifest가 없거나 올바르지 않습니다.",
    "provider 중단 스위치가 켜져 있습니다."
  ]);
  const connectorRows = publicCollectionConnectors({
    requiredProviders: ["naver-search"],
    killSwitches: { "naver-search": false },
    reasons: [],
    apiKey: "must-not-leak",
    clientSecret: "must-not-leak"
  }, "live", true);
  assert.deepEqual(connectorRows.find((row) => row.id === "naver-search"), {
    id: "naver-search",
    label: "NAVER 업체 검색",
    status: "ready",
    configured: true,
    detail: "승인 범위·quota·중단 스위치를 확인했습니다."
  });
  assert.equal(JSON.stringify(connectorRows).includes("must-not-leak"), false, "connector projection must never expose credentials");

  const { service, authService } = createHarness();
  const business = session("business", TENANT_ONE);
  const admin = session("admin");
  const exploration = await service.getExploration(business, TENANT_ONE, COMPANY_A);

  assert.equal(exploration.state, "partial");
  assert.deepEqual(exploration.scope, {
    role: "b2b",
    tenantCompanyId: TENANT_ONE,
    companyId: COMPANY_A,
    companyRef: explorationCompanyRef(COMPANY_A),
    companyCount: 2,
    observationCount: 26,
    quarantinedCompanyCount: 0,
    uncollectedCompanyCount: 0,
    companyLimitReached: false,
    observationLimitReached: false,
    dataMode: "live",
    synthetic: false,
    windowDays: 30
  });
  assert.equal(exploration.map.state, "ready");
  assert.equal(exploration.map.markers.length, 2);
  assert.equal(exploration.map.markers[0].coordinateConfidence, "certain");
  assert.equal(exploration.map.markers[1].coordinateConfidence, "unverified");
  assert.equal(exploration.map.markers[0].companyRef, explorationCompanyRef(COMPANY_A));
  assert.deepEqual(exploration.map.sourceAsset, FRESH_EXPLORATION_SOURCE_ASSET);
  assert.deepEqual(Object.keys(exploration.map.sourceAsset).sort(), ["checksum", "license", "source", "version"]);
  assert.equal(exploration.ranking.state, "ready");
  assert.deepEqual(exploration.ranking.condition, {
    metric: "profile.rank",
    targetDate: "2026-07-30",
    channel: "naver-search",
    comparison: "same-targetDate-and-channel",
    meaning: "v2-observed-rank-preserved",
    recalculated: false,
    searchCondition: "matched"
  });
  assert.deepEqual(exploration.ranking.rows.map((row) => row.rank), [3, 5]);
  assert.deepEqual(exploration.ranking.rows.map((row) => row.observedRank), [3, 5]);
  assert.deepEqual(exploration.ranking.rows.map((row) => row.position), [1, 2]);
  assert.equal(exploration.ranking.rows.some((row) => row.rank === 1), false, "different targetDate rank must not enter the comparison");
  assert.deepEqual(exploration.ranking.platforms.map((row) => row.channel), ["naver-search", "partner-platform"]);
  assert.deepEqual(exploration.ranking.platforms[0].rows.map((row) => row.observedRank), [3, 5]);
  assert.deepEqual(exploration.ranking.platforms[1].rows.map((row) => row.observedRank), [4, 8]);
  assert.equal(exploration.timeline.state, "partial");
  assert.equal(exploration.timeline.from, "2026-07-30");
  assert.equal(exploration.timeline.to, "2026-08-28");
  assert.equal(exploration.timeline.axisEveryDays, 7);
  assert.equal(exploration.timeline.points.length, 30);
  assert.equal(exploration.timeline.points[0].price.value, 120000);
  assert.equal(exploration.timeline.points[0].totalStock.value, 16);
  assert.equal(exploration.timeline.points[0].availableStock.value, 7);
  assert.deepEqual(exploration.timeline.points[0].reservationRate, {
    state: "ready",
    value: 0.5625,
    unit: "ratio",
    soldStock: 9,
    totalStock: 16,
    sampleCount: 2
  });
  assert.deepEqual(exploration.timeline.points[0].bookingPace, {
    state: "ready",
    value: 3.08,
    unit: "percentage-point-per-day",
    sampleCount: 1,
    requiredLeadDays: [14, 7, 1]
  });
  assert.equal(exploration.timeline.points[1].bookingPace.state, "not-collected");
  assert.equal(exploration.timeline.points[0].ota.state, "not-exposed");
  assert.equal(exploration.timeline.points[1].ota.state, "ready");

  const businessJson = JSON.stringify(exploration);
  assert.equal(businessJson.includes(COMPANY_B), false, "other company internal id must be anonymous for business");
  assert.equal(businessJson.includes(COMPANY_OTHER), false, "other tenant company must not be present");
  assert.equal(businessJson.includes(COMPANY_SYNTHETIC), false, "synthetic company must not be present");
  assert.equal(businessJson.includes("raw_private_evidence_must_not_leak"), false);
  assert.equal(businessJson.includes("C:\\private\\fresh"), false);
  assertNoSensitiveProjection(exploration);

  const publicCompanies = await service.listCompanies(business, TENANT_ONE);
  assert.deepEqual(publicCompanies.map((row) => row.companyName).sort(), ["내 숙소 A", "동일 tenant 숙소 B"].sort());
  assert.equal(JSON.stringify(publicCompanies).includes("캐시 합성 이름 A"), false);
  assert.equal(publicCompanies.every((row) => row.category === "glamping" && row.sourceLabel === "V2 신규 실수집"), true);

  const adminScoped = await service.getExploration(admin, TENANT_ONE, COMPANY_A);
  assert.equal(JSON.stringify(adminScoped).includes(COMPANY_B), true, "admin may receive authorized company ids");
  assert.equal(JSON.stringify(adminScoped).includes(COMPANY_OTHER), false, "admin tenant scope must be enforced");

  await assert.rejects(
    service.getExploration(business, TENANT_ONE, COMPANY_OTHER),
    (error) => error.statusCode === 403 && error.code === "FRESH_TENANT_FORBIDDEN"
  );

  const syntheticTarget = await service.getExploration(business, TENANT_ONE, COMPANY_SYNTHETIC);
  assert.equal(JSON.stringify(syntheticTarget).includes(COMPANY_SYNTHETIC), false);
  assert.equal(syntheticTarget.scope.companyId, "");
  assert.equal(syntheticTarget.timeline.state, "not-exposed");

  const outside = await service.getExploration(session("business", TENANT_RANGE), TENANT_RANGE, COMPANY_RANGE);
  assert.equal(outside.map.state, "out-of-range");
  assert.equal(outside.ranking.state, "out-of-range");
  assert.equal(outside.timeline.state, "out-of-range");
  assert.equal(outside.state, "out-of-range");

  const empty = await service.getExploration(session("business", TENANT_EMPTY), TENANT_EMPTY, COMPANY_EMPTY);
  assert.equal(empty.map.state, "not-collected");
  assert.equal(empty.ranking.state, "not-collected");
  assert.equal(empty.timeline.state, "not-collected");
  assert.equal(empty.state, "not-collected");

  const hidden = await service.getExploration(session("business", TENANT_HIDDEN), TENANT_HIDDEN, COMPANY_HIDDEN);
  assert.equal(hidden.map.state, "not-exposed");
  assert.equal(hidden.ranking.state, "not-exposed");
  assert.equal(hidden.timeline.state, "not-exposed");
  assert.equal(hidden.state, "not-exposed");
  assert.equal(hidden.scope.quarantinedCompanyCount, 1);
  assert.equal(JSON.stringify(hidden).includes("미노출 숙소"), false, "cached identity must remain quarantined without live profile identity observations");
  assert.deepEqual(await service.listCompanies(session("business", TENANT_HIDDEN), TENANT_HIDDEN), []);
  await assert.rejects(
    service.getCompany(session("business", TENANT_HIDDEN), COMPANY_HIDDEN, TENANT_HIDDEN),
    (error) => error.statusCode === 404 && error.code === "FRESH_COMPANY_IDENTITY_QUARANTINED"
  );

  await assertHttpRoute(service, authService, business);
  await assertInternalErrorRedaction(authService, business);
  await assertBoundedExplorationReads();
  await assertVersionedBoundaryEndpoint();
  assert.equal(service.metadata().providerCalls, 0);
  assert.equal(service.metadata().syntheticProviderCalls, 0);
  process.stdout.write("Fresh live-only exploration map, ranking, 30-day timeline, tenant and business-safe tests passed\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
