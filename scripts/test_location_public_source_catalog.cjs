"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

let networkAttempts = 0;
function forbidNetwork() {
  networkAttempts += 1;
  throw new Error("External network is forbidden in public source catalog fixtures");
}

const originalNetwork = {
  fetch: globalThis.fetch,
  httpGet: http.get,
  httpRequest: http.request,
  httpsGet: https.get,
  httpsRequest: https.request,
  netConnect: net.connect,
  tlsConnect: tls.connect
};

globalThis.fetch = forbidNetwork;
http.get = forbidNetwork;
http.request = forbidNetwork;
https.get = forbidNetwork;
https.request = forbidNetwork;
net.connect = forbidNetwork;
tls.connect = forbidNetwork;

try {
  const root = path.join(__dirname, "..");
  const catalogPath = path.join(root, "web", "data", "location_public_source_catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const regionRegistry = JSON.parse(fs.readFileSync(
    path.join(root, "web", "data", "location_region_registry.json"),
    "utf8"
  ));

  const expectedPilotRegionKeys = [
    "kr_gyeonggi_pocheon",
    "kr_gyeongnam_sancheong",
    "kr_gyeongnam_hadong"
  ];
  const qualityStatuses = ["ready", "zero", "missing", "partial", "stale", "conflict"];
  const confidenceGrades = ["A", "B", "C", "D", "U"];
  const selectionStatuses = ["selected", "candidate", "rejected", "unavailable"];
  const allowedOfficialHosts = new Set([
    "www.data.go.kr",
    "kosis.kr",
    "developers.naver.com",
    "naver.github.io"
  ]);

  assert.equal(catalog.schemaVersion, "location-public-source-catalog.v1");
  assert.match(catalog.catalogVersion, /^pilot-\d{4}-\d{2}-\d{2}\.v\d+$/);
  assert.equal(catalog.researchBoundary.mode, "official-documentation-only");
  assert.equal(catalog.researchBoundary.actualDataEndpointCalls, false);
  assert.equal(catalog.researchBoundary.credentialsRead, false);
  assert.deepEqual(catalog.pilotRegionKeys, expectedPilotRegionKeys);
  assert.deepEqual(
    catalog.pilotRegions.map((region) => region.regionKey),
    expectedPilotRegionKeys
  );
  const activeCanonicalRegionKeys = new Set(
    regionRegistry.regions
      .filter((region) => region.active === true)
      .map((region) => region.regionKey)
  );
  for (const regionKey of expectedPilotRegionKeys) {
    assert.ok(activeCanonicalRegionKeys.has(regionKey), `pilot region must exist in active canonical registry: ${regionKey}`);
  }
  assert.deepEqual(Object.keys(catalog.selectionStatuses).sort(), [...selectionStatuses].sort());
  assert.deepEqual(Object.keys(catalog.qualityStatusSemantics).sort(), [...qualityStatuses].sort());
  assert.match(catalog.qualityStatusSemantics.zero, /명시적으로 0/);
  assert.match(catalog.qualityStatusSemantics.missing, /0으로 변환하지 않음/);
  assert.notEqual(catalog.qualityStatusSemantics.zero, catalog.qualityStatusSemantics.missing);
  assert.match(catalog.confidenceSemantics, /데이터 품질/);
  assert.match(catalog.confidenceSemantics, /입지점수를 가감하지 않는다/);
  assert.ok(Array.isArray(catalog.sources) && catalog.sources.length >= 14);

  const sourceIds = new Set();
  const datasetIds = new Set();
  const observedSelectionStatuses = new Set();
  const categories = new Set();

  for (const source of catalog.sources) {
    assert.match(source.sourceId, /^[a-z0-9][a-z0-9._-]+$/);
    assert.equal(sourceIds.has(source.sourceId), false, `duplicate sourceId: ${source.sourceId}`);
    sourceIds.add(source.sourceId);

    assert.equal(typeof source.provider, "string", `${source.sourceId} provider`);
    assert.match(source.provider, /^[a-z0-9][a-z0-9_]+$/);
    assert.equal(typeof source.authority, "string");
    assert.ok(source.authority.length > 0);
    assert.equal(typeof source.datasetId, "string");
    assert.ok(source.datasetId.length > 0);
    datasetIds.add(source.datasetId);
    assert.equal(typeof source.dataCategory, "string");
    assert.ok(source.dataCategory.length > 0);
    categories.add(source.dataCategory);
    assert.equal(typeof source.authenticationType, "string");
    assert.ok(selectionStatuses.includes(source.selectionStatus), `${source.sourceId} selectionStatus`);
    observedSelectionStatuses.add(source.selectionStatus);
    assert.equal(typeof source.selectionReason, "string");
    assert.ok(source.selectionReason.length >= 20);

    const officialUrl = new URL(source.officialUrl);
    assert.equal(officialUrl.protocol, "https:", `${source.sourceId} must use HTTPS official documentation`);
    assert.ok(allowedOfficialHosts.has(officialUrl.hostname), `${source.sourceId} has non-official host ${officialUrl.hostname}`);
    assert.notEqual(officialUrl.hostname, "apis.data.go.kr", "catalog must not contain an executable data endpoint");
    assert.notEqual(officialUrl.hostname, "openapi.naver.com", "catalog must link docs, not an executable Naver endpoint");
    assert.equal([...officialUrl.searchParams.keys()].some((key) => /key|secret|token|auth/i.test(key)), false);

    assert.equal(typeof source.spatialGranularity, "string");
    assert.equal(typeof source.temporalGranularity, "string");
    assert.equal(typeof source.updateCadence, "string");
    assert.ok(Object.hasOwn(source, "coverageStart"));
    assert.ok(Object.hasOwn(source, "coverageEnd"));
    assert.deepEqual(source.pilotRegionKeys, expectedPilotRegionKeys, `${source.sourceId} pilot region coverage`);
    assert.equal(typeof source.canonicalRegionMapping, "string");
    assert.ok(source.canonicalRegionMapping.length > 0);

    assert.ok(Array.isArray(source.fieldMapping) && source.fieldMapping.length > 0);
    for (const mapping of source.fieldMapping) {
      assert.equal(typeof mapping.sourceField, "string");
      assert.equal(typeof mapping.observationField, "string");
      assert.equal(typeof mapping.required, "boolean");
    }
    for (const key of ["measurementPeriodRule", "sampleCountRule", "coverageRule", "freshnessRule"]) {
      assert.equal(typeof source[key], "string", `${source.sourceId}.${key}`);
      assert.ok(source[key].length > 0);
    }

    assert.deepEqual(Object.keys(source.statusRules).sort(), [...qualityStatuses].sort(), `${source.sourceId} status rules`);
    assert.notEqual(source.statusRules.zero, source.statusRules.missing, `${source.sourceId} zero and missing must differ`);
    assert.match(source.statusRules.zero, /0/);
    assert.match(source.statusRules.missing, /없|부재|미수집|missing/);
    assert.deepEqual(Object.keys(source.confidenceRules).sort(), [...confidenceGrades].sort(), `${source.sourceId} confidence rules`);
    assert.ok(Array.isArray(source.penalties) && source.penalties.length > 0);
    for (const penalty of source.penalties) {
      assert.match(penalty.code, /^[a-z0-9][a-z0-9_]+$/);
      assert.equal(typeof penalty.appliesWhen, "string");
      assert.equal(typeof penalty.impact, "string");
    }
    assert.equal(typeof source.license, "string");
    assert.ok(source.license.length > 0);
    assert.ok(Array.isArray(source.usageRestrictions) && source.usageRestrictions.length > 0);
    assert.ok(Array.isArray(source.privacyAndRedistribution) && source.privacyAndRedistribution.length > 0);
  }

  assert.equal(sourceIds.size, catalog.sources.length);
  assert.deepEqual([...observedSelectionStatuses].sort(), [...selectionStatuses].sort());
  assert.ok(datasetIds.has("data.go.kr:15101578"));
  assert.ok(datasetIds.has("data.go.kr:15101933"));
  assert.ok(datasetIds.has("data.go.kr:15101972"));
  assert.ok(datasetIds.has("data.go.kr:15152138"));
  assert.ok(datasetIds.has("data.go.kr:15059093"));
  assert.ok(datasetIds.has("kosis.openapi:statisticsData"));
  assert.ok(datasetIds.has("data.go.kr:15097077"));

  for (const requiredCategory of [
    "tourism_culture_natural_resource",
    "festival_event",
    "camping_supply",
    "lodging_supply",
    "visitor_demand",
    "search_sns_tourism_demand_proxy",
    "weather_seasonality",
    "population_demand_base",
    "region_reference",
    "transport_demand",
    "road_access_connectivity",
    "search_interest_trend",
    "absolute_search_volume",
    "raw_sns",
    "booking_inventory_lead_time"
  ]) {
    assert.ok(categories.has(requiredCategory), `missing category ${requiredCategory}`);
  }

  const rawSns = catalog.sources.find((source) => source.sourceId === "public.raw_sns.regional_mentions");
  const bookingInventory = catalog.sources.find((source) => source.sourceId === "public.booking_inventory.lead_time");
  assert.equal(rawSns.selectionStatus, "unavailable");
  assert.equal(bookingInventory.selectionStatus, "unavailable");
  assert.match(rawSns.sampleCountRule, /SNS 언급량 0을 뜻하지 않음/);
  assert.match(bookingInventory.sampleCountRule, /예약·재고 0을 뜻하지 않음/);
  assert.match(rawSns.coverageRule, /denominator=null/);
  assert.match(bookingInventory.coverageRule, /denominator=null/);
  assert.doesNotMatch(JSON.stringify([rawSns, bookingInventory]), /normalizedValue[^\n]*(?:0|50)/i);

  const resourceDemand = catalog.sources.find((source) => source.sourceId === "kto.bigdata.resource_demand");
  assert.equal(resourceDemand.selectionStatus, "selected");
  assert.match(resourceDemand.selectionReason, /raw SNS나 절대 검색량은 아니다/);
  assert.match(resourceDemand.statusRules.partial, /표본·분모/);

  const rejectedEventSnapshot = catalog.sources.find((source) => source.sourceId === "kto.events.snapshot.20230830");
  assert.equal(rejectedEventSnapshot.selectionStatus, "rejected");
  assert.match(rejectedEventSnapshot.selectionReason, /searchFestival2/);

  assert.equal(networkAttempts, 0, "catalog fixtures must not perform external requests");
  console.log(`Public source catalog contract passed (${catalog.sources.length} sources, network disabled)`);
} finally {
  globalThis.fetch = originalNetwork.fetch;
  http.get = originalNetwork.httpGet;
  http.request = originalNetwork.httpRequest;
  https.get = originalNetwork.httpsGet;
  https.request = originalNetwork.httpsRequest;
  net.connect = originalNetwork.netConnect;
  tls.connect = originalNetwork.tlsConnect;
}
