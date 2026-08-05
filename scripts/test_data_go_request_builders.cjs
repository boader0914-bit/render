"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "location API request builder fixtures" });

try {
  const {
    API_SOURCE_IDS,
    LocationApiRequestBuilderError,
    SOURCE_DEFINITIONS,
    buildRequestDescriptor,
    readRegionRegistry
  } = require("./location_api_request_builders.cjs");

  const registry = readRegionRegistry();
  const connectionRegistry = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "web", "data", "location_api_connection_registry.json"),
    "utf8"
  ));
  const period = { from: "2026-07-01", to: "2026-07-31" };
  const pilotKeys = [
    "kr_gyeonggi_pocheon",
    "kr_gyeongnam_sancheong",
    "kr_gyeongnam_hadong"
  ];
  const pilotRegions = pilotKeys.map((regionKey) => registry.regions.find((region) => region.regionKey === regionKey));

  assert.equal(API_SOURCE_IDS.length, 11);
  const connectionById = new Map(connectionRegistry.sources.map((source) => [source.sourceId, source]));
  for (const sourceId of API_SOURCE_IDS) {
    const definition = SOURCE_DEFINITIONS[sourceId];
    const connection = connectionById.get(sourceId);
    assert.ok(connection, `${sourceId} must exist in the connection registry`);
    assert.equal(definition.provider, connection.provider, `${sourceId} provider drift`);
    assert.equal(definition.datasetId, connection.datasetId, `${sourceId} dataset drift`);
    assert.equal(definition.operation, connection.operation, `${sourceId} operation drift`);
    assert.equal(definition.selectionStatus, connection.sourceCatalogStatus, `${sourceId} selection drift`);
    assert.equal(definition.connectionStage, connection.connectionStage, `${sourceId} stage drift`);
  }

  const resources = buildRequestDescriptor({
    sourceId: "kto.tour_info.resources",
    regionKey: pilotKeys[0],
    registry,
    measurementPeriod: period
  });
  const resourcesUrl = new URL(resources.url);
  assert.equal(resourcesUrl.origin, "https://apis.data.go.kr");
  assert.equal(resourcesUrl.pathname, "/B551011/KorService2/areaBasedList2");
  assert.equal(resources.parameters.MobileApp, "lodging-datalab");
  assert.equal(resources.parameters.pageNo, 1);
  assert.equal(Object.hasOwn(resources.parameters, "areaCode"), false);
  assert.equal(Object.hasOwn(resources.parameters, "sigunguCode"), false);
  assert.equal(resources.regionSelection.forbiddenDerivedCodeSystem, "KTO_DATALAB_SGG_CD");
  assert.equal(resources.regionSelection.requestRegionParametersIncluded, false);
  assert.ok(resources.blockers.includes("tourapi_region_code_crosswalk_unverified"));

  const events = buildRequestDescriptor({
    sourceId: "kto.tour_info.events",
    regionKey: pilotKeys[1],
    registry,
    measurementPeriod: period
  });
  assert.equal(events.parameters.eventStartDate, "20260701");
  assert.equal(events.parameters.eventEndDate, "20260731");
  assert.equal(new URL(events.url).pathname, "/B551011/KorService2/searchFestival2");

  const lodging = buildRequestDescriptor({
    sourceId: "kto.tour_info.lodging",
    regionKey: pilotKeys[2],
    registry,
    measurementPeriod: period
  });
  assert.equal(new URL(lodging.url).pathname, "/B551011/KorService2/searchStay2");
  assert.equal(Object.hasOwn(lodging.parameters, "areaCode"), false);
  assert.equal(Object.hasOwn(lodging.parameters, "sigunguCode"), false);

  const camping = buildRequestDescriptor({
    sourceId: "kto.gocamping.inventory",
    regionKey: pilotKeys[0],
    registry,
    measurementPeriod: period,
    targetRegions: pilotRegions
  });
  assert.equal(new URL(camping.url).pathname, "/B551011/GoCamping/basedList");
  assert.equal(camping.requestScope, "national_shared_snapshot");
  assert.equal(camping.regionSelection.mode, "response_post_filter_exact");
  assert.equal(camping.regionSelection.targetRegions.length, 3);
  assert.equal(camping.regionSelection.fuzzyFallback, false);
  assert.deepEqual(camping.regionSelection.responseFields, ["doNm", "sigunguNm"]);

  for (const sourceId of ["kto.bigdata.visitors", "kto.bigdata.resource_demand"]) {
    const descriptor = buildRequestDescriptor({
      sourceId,
      regionKey: pilotKeys[0],
      registry,
      measurementPeriod: period
    });
    assert.equal(descriptor.url, null, `${sourceId} operation path must remain unresolved`);
    assert.equal(descriptor.parameters.SGG_CD, "41650");
    assert.equal(descriptor.regionSelection.codeSystem, "KTO_DATALAB_SGG_CD");
    assert.ok(descriptor.blockers.includes("production_subscription_review_required"));
  }

  const weather = buildRequestDescriptor({
    sourceId: "kma.asos.daily_weather",
    regionKey: pilotKeys[0],
    registry,
    measurementPeriod: period
  });
  assert.equal(new URL(weather.url).pathname, "/1360000/AsosDalyInfoService/getWthrDataList");
  assert.equal(Object.hasOwn(weather.parameters, "stnIds"), false);
  assert.equal(weather.regionSelection.stationParameterIncluded, false);
  assert.ok(weather.blockers.includes("weather_station_crosswalk_unverified"));

  const kosis = buildRequestDescriptor({
    sourceId: "kosis.population.sigungu",
    regionKey: pilotKeys[1],
    registry,
    measurementPeriod: period
  });
  assert.equal(kosis.url, null);
  assert.deepEqual(kosis.parameters, {});
  assert.ok(kosis.blockers.includes("kosis_table_item_unit_unverified"));

  const traffic = buildRequestDescriptor({
    sourceId: "molit.traffic_volume.statistics",
    regionKey: pilotKeys[2],
    registry,
    measurementPeriod: period
  });
  assert.equal(traffic.url, null);
  assert.ok(traffic.blockers.includes("traffic_station_region_assignment_unverified"));

  const datalab = buildRequestDescriptor({
    sourceId: "naver.datalab.search_trend",
    regionKey: pilotKeys[0],
    registry,
    measurementPeriod: period
  });
  assert.equal(datalab.url, "https://openapi.naver.com/v1/datalab/search");
  assert.equal(datalab.method, "POST");
  assert.equal(datalab.body.keywordGroups.length, 1);
  assert.equal(datalab.regionSelection.geographicResponseClaim, false);
  assert.ok(datalab.blockers.includes("keyword_group_approval_required"));

  const searchAd = buildRequestDescriptor({
    sourceId: "naver.searchad.keyword_volume",
    regionKey: pilotKeys[0],
    registry,
    measurementPeriod: period
  });
  assert.equal(new URL(searchAd.url).origin, "https://api.searchad.naver.com");
  assert.equal(searchAd.parameters.showDetail, 1);
  assert.equal(searchAd.regionSelection.relatedKeywordRegionFallback, false);

  const everyDescriptor = API_SOURCE_IDS.map((sourceId) => buildRequestDescriptor({
    sourceId,
    regionKey: pilotKeys[0],
    registry,
    measurementPeriod: period
  }));
  for (const descriptor of everyDescriptor) {
    assert.equal(descriptor.actualCallsEnabled, false);
    assert.equal(descriptor.executionState, "blocked");
    assert.equal(descriptor.approvalRequired, true);
    assert.equal(descriptor.paginationPolicy.estimatedPageCount, null);
    assert.equal(descriptor.paginationPolicy.estimatedCallCount, null);
    assert.ok(descriptor.blockers.includes("external_api_execution_not_approved"));
    assert.equal(Object.isFrozen(descriptor), true);
    for (const key of Object.keys(descriptor.parameters)) {
      assert.doesNotMatch(key, /^(?:servicekey|apikey|secret|signature|authorization|token|customer(?:id)?)$/i);
    }
    for (const key of Object.keys(descriptor.headers)) {
      assert.doesNotMatch(key, /^(?:authorization|x-naver-client-id|x-naver-client-secret|x-api-key|x-customer|x-signature|x-timestamp)$/i);
    }
    if (descriptor.url) {
      const url = new URL(descriptor.url);
      for (const key of url.searchParams.keys()) {
        assert.doesNotMatch(key, /^(?:servicekey|apikey|secret|signature|authorization|token|customer(?:id)?)$/i);
      }
    }
  }

  assert.throws(
    () => buildRequestDescriptor({
      sourceId: "mois.legal_dong.reference",
      regionKey: pilotKeys[0],
      registry,
      measurementPeriod: period
    }),
    (error) => error instanceof LocationApiRequestBuilderError && error.code === "REFERENCE_ONLY_SOURCE"
  );
  assert.throws(
    () => buildRequestDescriptor({
      sourceId: "kto.gocamping.inventory",
      regionKey: "kr_gyeonggi_missing",
      registry,
      measurementPeriod: period
    }),
    (error) => error instanceof LocationApiRequestBuilderError && error.code === "CANONICAL_REGION_NOT_FOUND"
  );

  const builderSource = fs.readFileSync(path.join(__dirname, "location_api_request_builders.cjs"), "utf8");
  assert.doesNotMatch(builderSource, /process\.env/);
  assert.equal(networkGuard.blockedAttempts(), 0);
  console.log(`Location API request builder fixtures passed (${everyDescriptor.length} sources, network disabled)`);
} finally {
  networkGuard.restore();
}
