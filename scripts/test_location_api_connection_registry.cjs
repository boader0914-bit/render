"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "location API connection registry fixtures" });

try {
  const root = path.join(__dirname, "..");
  const registry = JSON.parse(fs.readFileSync(
    path.join(root, "web", "data", "location_api_connection_registry.json"),
    "utf8"
  ));
  const catalog = JSON.parse(fs.readFileSync(
    path.join(root, "web", "data", "location_public_source_catalog.json"),
    "utf8"
  ));
  const canonicalRegistry = JSON.parse(fs.readFileSync(
    path.join(root, "web", "data", "location_region_registry.json"),
    "utf8"
  ));

  const pilotRegionKeys = [
    "kr_gyeonggi_pocheon",
    "kr_gyeongnam_sancheong",
    "kr_gyeongnam_hadong"
  ];
  const priorityApiSourceIds = [
    "kto.tour_info.resources",
    "kto.tour_info.events",
    "kto.tour_info.lodging",
    "kto.gocamping.inventory",
    "kto.bigdata.visitors",
    "kto.bigdata.resource_demand"
  ];
  const candidateApiSourceIds = [
    "kma.asos.daily_weather",
    "kosis.population.sigungu",
    "molit.traffic_volume.statistics",
    "naver.datalab.search_trend",
    "naver.searchad.keyword_volume"
  ];
  const referenceSourceId = "mois.legal_dong.reference";
  const expectedSourceIds = [...priorityApiSourceIds, referenceSourceId, ...candidateApiSourceIds];
  const excludedSourceIds = [
    "molit.standard_node_link.snapshot",
    "kto.events.snapshot.20230830",
    "public.raw_sns.regional_mentions",
    "public.booking_inventory.lead_time"
  ];
  const qualityStatuses = ["ready", "zero", "missing", "partial", "stale", "conflict"];
  const catalogById = new Map(catalog.sources.map((source) => [source.sourceId, source]));

  assert.equal(registry.schemaVersion, "location-api-connection-registry.v1");
  assert.match(registry.registryVersion, /^pilot-\d{4}-\d{2}-\d{2}\.v\d+$/);
  assert.equal(catalog.catalogVersion, "pilot-2026-08-05.v2");
  assert.equal(registry.preparationBoundary.mode, "fixture-only-connection-readiness");
  assert.equal(registry.preparationBoundary.actualDataEndpointCalls, false);
  assert.equal(registry.preparationBoundary.credentialsRead, false);
  assert.equal(registry.preparationBoundary.previewDataChanged, false);
  assert.equal(registry.actualCallsEnabled, false);
  assert.deepEqual(registry.pilotRegionKeys, pilotRegionKeys);
  assert.deepEqual(registry.qualityStatuses, qualityStatuses);

  assert.equal(registry.canonicalRegionIdentity.primaryField, "regionKey");
  assert.equal(registry.canonicalRegionIdentity.unit, "sigungu");
  assert.equal(registry.canonicalRegionIdentity.fallbackPolicy, "none");
  assert.equal(registry.canonicalRegionIdentity.unmatchedResult, null);
  assert.equal(registry.canonicalRegionIdentity.legalDongRole, "optional_reference_crosswalk");
  assert.equal(registry.canonicalRegionIdentity.legalDongRequiredForSigunguCards, false);
  assert.equal(registry.codeSystemIsolation.derivationPolicy, "independent_exact_crosswalk_only");
  assert.equal(registry.codeSystemIsolation.crossSystemDerivationAllowed, false);
  assert.notEqual(registry.codeSystemIsolation.tourApiRegionCodes, registry.codeSystemIsolation.ktoDataLabSggCd);
  assert.notEqual(registry.codeSystemIsolation.ktoDataLabSggCd, registry.codeSystemIsolation.moisLegalDongCode);

  const activeRegionKeys = canonicalRegistry.regions
    .filter((region) => region.active === true)
    .map((region) => region.regionKey);
  assert.equal(new Set(activeRegionKeys).size, activeRegionKeys.length, "regionKey must be unique in the canonical registry");
  for (const regionKey of pilotRegionKeys) assert.ok(activeRegionKeys.includes(regionKey));

  assert.deepEqual(
    Object.keys(registry.connectionStages).sort(),
    ["ready_for_credentials", "needs_subscription", "needs_mapping_decision", "needs_terms_approval", "reference_only", "unavailable"].sort()
  );
  assert.equal(registry.sources.length, expectedSourceIds.length);
  assert.deepEqual(new Set(registry.sources.map((source) => source.sourceId)), new Set(expectedSourceIds));
  for (const sourceId of excludedSourceIds) {
    assert.equal(registry.sources.some((source) => source.sourceId === sourceId), false, `${sourceId} must not get an API connection`);
  }

  const seenSourceIds = new Set();
  for (const source of registry.sources) {
    assert.match(source.sourceId, /^[a-z0-9][a-z0-9._-]+$/);
    assert.equal(seenSourceIds.has(source.sourceId), false, `duplicate sourceId: ${source.sourceId}`);
    seenSourceIds.add(source.sourceId);

    const catalogSource = catalogById.get(source.sourceId);
    assert.ok(catalogSource, `${source.sourceId} must exist in the source catalog`);
    for (const key of ["provider", "datasetId", "operation", "authenticationType", "spatialGranularity", "temporalGranularity"]) {
      assert.equal(source[key], catalogSource[key], `${source.sourceId}.${key} must match the source catalog`);
    }
    assert.equal(source.sourceCatalogStatus, catalogSource.selectionStatus);
    assert.equal(source.officialDocumentationUrl, catalogSource.officialUrl);
    if (source.operationStatus !== undefined || catalogSource.operationStatus !== undefined) {
      assert.equal(source.operationStatus, catalogSource.operationStatus, `${source.sourceId}.operationStatus must match the source catalog`);
    }
    const documentationUrl = new URL(source.officialDocumentationUrl);
    assert.equal(documentationUrl.protocol, "https:");
    assert.equal([...documentationUrl.searchParams.keys()].some((key) => /key|secret|token|auth/i.test(key)), false);

    assert.equal(source.actualCallsEnabled, false, `${source.sourceId} must remain disabled`);
    assert.ok(Object.hasOwn(registry.connectionStages, source.connectionStage));
    assert.equal(typeof source.apiConnectionRequired, "boolean");
    assert.ok(["observation_source", "canonical_crosswalk"].includes(source.usageRole));
    assert.ok(["authorized_api", "manual_versioned_snapshot"].includes(source.collectionMode));
    assert.ok(Array.isArray(source.credentialEnvNames));
    assert.ok(Array.isArray(source.allowedHosts));
    assert.ok(Array.isArray(source.expectedObservationFields) && source.expectedObservationFields.length > 0);
    assert.ok(Array.isArray(source.remainingBlockers) && source.remainingBlockers.length > 0);
    assert.equal(source.schemaVersion, "location-api-connection.v1");
    assert.deepEqual(Object.keys(source.qualityStatusMapping).sort(), [...qualityStatuses].sort());
    assert.equal(source.commercialUseReview.status, "unknown");
    assert.equal(source.redistributionReview.status, "unknown");

    for (const envName of source.credentialEnvNames) {
      assert.match(envName, /^[A-Z][A-Z0-9_]*$/);
      assert.notEqual(envName, "NAVER_MAPS_API_KEY_ID");
      assert.notEqual(envName, "NAVER_MAPS_API_KEY");
    }
    for (const host of source.allowedHosts) {
      assert.match(host, /^[a-z0-9.-]+$/);
      assert.doesNotMatch(host, /:\/\//);
    }

    if (source.apiConnectionRequired) {
      assert.ok(["GET", "POST"].includes(source.requestMethod));
      assert.ok(source.allowedHosts.length > 0);
      assert.ok(source.credentialEnvNames.length > 0);
      assert.ok(source.timeoutPolicy.connectMs > 0);
      assert.ok(source.timeoutPolicy.responseMs > 0);
      assert.ok(source.maximumResponseBytes > 0);
      assert.ok(source.retryPolicy.maximumAttempts >= 1);
      assert.equal(source.retryPolicy.idempotentReadOnlyRequestsOnly, true);
      assert.equal(source.rateLimitPolicy.maximumConcurrency, 1);
      assert.ok(source.paginationPolicy.maximumCallsPerRun >= 1);
      assert.ok(source.paginationPolicy.maximumCallsPerRun <= 50);
      assert.ok(source.paginationPolicy.maximumPages <= 50);
    }
  }

  for (const sourceId of priorityApiSourceIds) {
    const source = registry.sources.find((candidate) => candidate.sourceId === sourceId);
    assert.equal(source.apiConnectionRequired, true);
    assert.equal(source.sourceCatalogStatus, "selected");
    assert.ok(["ready_for_credentials", "needs_subscription", "needs_mapping_decision"].includes(source.connectionStage));
  }
  for (const sourceId of candidateApiSourceIds) {
    const source = registry.sources.find((candidate) => candidate.sourceId === sourceId);
    assert.equal(source.apiConnectionRequired, true);
    assert.equal(source.sourceCatalogStatus, "candidate");
    assert.ok(["needs_mapping_decision", "needs_terms_approval"].includes(source.connectionStage));
  }

  const legalReference = registry.sources.find((source) => source.sourceId === referenceSourceId);
  assert.equal(legalReference.sourceCatalogStatus, "candidate");
  assert.equal(legalReference.apiConnectionRequired, false);
  assert.equal(legalReference.usageRole, "canonical_crosswalk");
  assert.equal(legalReference.connectionStage, "reference_only");
  assert.equal(legalReference.collectionMode, "manual_versioned_snapshot");
  assert.equal(legalReference.requestMethod, "NONE");
  assert.equal(legalReference.connectionAuthenticationType, "none_for_manual_versioned_snapshot");
  assert.deepEqual(legalReference.credentialEnvNames, []);
  assert.deepEqual(legalReference.allowedHosts, []);
  assert.equal(legalReference.paginationPolicy.maximumPages, 0);
  assert.equal(legalReference.retryPolicy.maximumAttempts, 0);
  assert.match(legalReference.canonicalRegionMappingStrategy, /regionKey/);
  assert.match(legalReference.canonicalRegionMappingStrategy, /선택적/);
  assert.match(legalReference.canonicalRegionMappingStrategy, /null/);
  assert.match(legalReference.canonicalRegionMappingStrategy, /fallback/);

  const catalogLegalReference = catalogById.get(referenceSourceId);
  assert.equal(catalogLegalReference.selectionStatus, "candidate");
  assert.match(catalogLegalReference.selectionReason, /조건부 버전형 참조자료/);
  assert.match(catalogLegalReference.canonicalRegionMapping, /regionKey를 대체하지 않는/);
  assert.match(catalogLegalReference.canonicalRegionMapping, /서로 파생하지 않는다/);

  for (const sourceId of ["kto.tour_info.resources", "kto.tour_info.lodging"]) {
    const source = registry.sources.find((candidate) => candidate.sourceId === sourceId);
    const catalogSource = catalogById.get(sourceId);
    assert.match(source.canonicalRegionMappingStrategy, /선택적/);
    assert.match(source.canonicalRegionMappingStrategy, /fallback/);
    assert.match(catalogSource.canonicalRegionMapping, /상호 파생하지 않는다/);
    const optionalProviderLegalCode = catalogSource.fieldMapping.find((mapping) => (
      mapping.observationField === "provenance.optionalProviderLegalDongCode"
    ));
    assert.ok(optionalProviderLegalCode);
    assert.equal(optionalProviderLegalCode.required, false);
    assert.ok(catalogSource.fieldMapping.some((mapping) => (
      mapping.observationField === "regionKey"
      && mapping.required === true
      && !/lDong/i.test(mapping.sourceField)
    )), "sigungu mapping must not require provider legal-dong codes");
  }
  for (const sourceId of ["kto.tour_info.resources", "kto.tour_info.events", "kto.tour_info.lodging"]) {
    const source = registry.sources.find((candidate) => candidate.sourceId === sourceId);
    assert.ok(source.remainingBlockers.includes("tourapi_code_crosswalk_verification_without_cross_system_derivation"));
  }
  const kosis = registry.sources.find((source) => source.sourceId === "kosis.population.sigungu");
  assert.match(kosis.canonicalRegionMappingStrategy, /공식 시군구 코드/);
  assert.match(kosis.canonicalRegionMappingStrategy, /선택적 검증자료/);
  assert.match(catalogById.get(kosis.sourceId).canonicalRegionMapping, /필수 의존성이 아니며/);

  const resourceDemand = registry.sources.find((source) => source.sourceId === "kto.bigdata.resource_demand");
  assert.ok(resourceDemand.remainingBlockers.includes("official_endpoint_operation_confirmation"));
  assert.equal(resourceDemand.operationStatus, "logical_name_requires_official_endpoint_confirmation");
  assert.equal(catalogById.get(resourceDemand.sourceId).operationStatus, "logical_name_requires_official_endpoint_confirmation");
  for (const sourceId of ["kto.bigdata.visitors", "kosis.population.sigungu", "molit.traffic_volume.statistics"]) {
    const source = registry.sources.find((candidate) => candidate.sourceId === sourceId);
    assert.ok(source.remainingBlockers.includes("official_endpoint_operation_confirmation"));
    assert.match(source.operationStatus, /confirmation/);
  }

  const naverCredentialNames = registry.sources
    .filter((source) => source.provider.startsWith("naver_"))
    .flatMap((source) => source.credentialEnvNames);
  assert.deepEqual(new Set(naverCredentialNames), new Set([
    "NAVER_CLIENT_ID",
    "NAVER_CLIENT_SECRET",
    "NAVER_SEARCHAD_API_KEY",
    "NAVER_SEARCHAD_SECRET_KEY",
    "NAVER_SEARCHAD_CUSTOMER_ID"
  ]));

  const forbiddenValueFields = /^(credentialValue|secretValue|apiKeyValue|authorizationHeader|serviceKeyValue)$/i;
  function assertNoCredentialValueFields(value, pointer = "registry") {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.equal(forbiddenValueFields.test(key), false, `${pointer}.${key} must not store a credential value`);
      assertNoCredentialValueFields(nested, `${pointer}.${key}`);
    }
  }
  assertNoCredentialValueFields(registry);

  assert.equal(guard.blockedAttempts(), 0);
  console.log(`Location API connection registry contract passed (${registry.sources.length} sources, all calls disabled)`);
} finally {
  guard.restore();
}
