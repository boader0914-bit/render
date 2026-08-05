"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REQUEST_DESCRIPTOR_SCHEMA_VERSION = "location-api-request-descriptor.v1";
const DEFAULT_REGION_REGISTRY_FILE = path.join(__dirname, "..", "web", "data", "location_region_registry.json");
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_PAGE_CEILING = 50;

class LocationApiRequestBuilderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocationApiRequestBuilderError";
    this.code = code;
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const SOURCE_DEFINITIONS = deepFreeze({
  "kto.tour_info.resources": {
    provider: "korea_tourism_organization",
    datasetId: "data.go.kr:15101578",
    operation: "areaBasedList2",
    selectionStatus: "selected",
    connectionStage: "needs_mapping_decision",
    method: "GET",
    endpoint: "https://apis.data.go.kr/B551011/KorService2/areaBasedList2",
    endpointStatus: "official_documentation_verified",
    authorizationProfile: "public-data-portal",
    pagination: true,
    observationTarget: "tourism_resource_snapshot",
    watermarkRule: "modifiedtime+contentid",
    duplicateKeyRule: "regionKey+contentid+modifiedtime"
  },
  "kto.tour_info.events": {
    provider: "korea_tourism_organization",
    datasetId: "data.go.kr:15101578",
    operation: "searchFestival2",
    selectionStatus: "selected",
    connectionStage: "needs_mapping_decision",
    method: "GET",
    endpoint: "https://apis.data.go.kr/B551011/KorService2/searchFestival2",
    endpointStatus: "official_documentation_verified",
    authorizationProfile: "public-data-portal",
    pagination: true,
    observationTarget: "festival_event_snapshot",
    watermarkRule: "modifiedtime+contentid+eventenddate",
    duplicateKeyRule: "regionKey+contentid+eventstartdate+eventenddate"
  },
  "kto.gocamping.inventory": {
    provider: "korea_tourism_organization",
    datasetId: "data.go.kr:15101933",
    operation: "basedList",
    selectionStatus: "selected",
    connectionStage: "ready_for_credentials",
    method: "GET",
    endpoint: "https://apis.data.go.kr/B551011/GoCamping/basedList",
    endpointStatus: "official_documentation_verified",
    authorizationProfile: "public-data-portal",
    pagination: true,
    observationTarget: "camping_supply_snapshot",
    watermarkRule: "modifiedtime+contentId",
    duplicateKeyRule: "contentId+modifiedtime"
  },
  "kto.tour_info.lodging": {
    provider: "korea_tourism_organization",
    datasetId: "data.go.kr:15101578",
    operation: "searchStay2",
    selectionStatus: "selected",
    connectionStage: "needs_mapping_decision",
    method: "GET",
    endpoint: "https://apis.data.go.kr/B551011/KorService2/searchStay2",
    endpointStatus: "official_documentation_verified",
    authorizationProfile: "public-data-portal",
    pagination: true,
    observationTarget: "registered_lodging_supply_snapshot",
    watermarkRule: "modifiedtime+contentid",
    duplicateKeyRule: "regionKey+contentid+modifiedtime"
  },
  "kto.bigdata.visitors": {
    provider: "korea_tourism_data_lab",
    datasetId: "data.go.kr:15101972",
    operation: "regionalVisitorCounts",
    selectionStatus: "selected",
    connectionStage: "needs_subscription",
    method: "GET",
    endpoint: null,
    endpointStatus: "operation_path_unverified",
    authorizationProfile: "public-data-portal-production-review",
    pagination: true,
    observationTarget: "regional_visitor_daily_series",
    watermarkRule: "SGG_CD+BASE_YMD",
    duplicateKeyRule: "regionKey+BASE_YMD+metricKey"
  },
  "kto.bigdata.resource_demand": {
    provider: "korea_tourism_data_lab",
    datasetId: "data.go.kr:15152138",
    operation: "regionalTourismResourceDemand",
    selectionStatus: "selected",
    connectionStage: "needs_subscription",
    method: "GET",
    endpoint: null,
    endpointStatus: "catalog_operation_is_logical_name",
    authorizationProfile: "public-data-portal-production-review",
    pagination: true,
    observationTarget: "regional_tourism_resource_demand_series",
    watermarkRule: "SGG_CD+BASE_YM+providerResourceId",
    duplicateKeyRule: "regionKey+BASE_YM+providerResourceId+metricKey"
  },
  "kma.asos.daily_weather": {
    provider: "korea_meteorological_administration",
    datasetId: "data.go.kr:15059093",
    operation: "getWthrDataList",
    selectionStatus: "candidate",
    connectionStage: "needs_mapping_decision",
    method: "GET",
    endpoint: "https://apis.data.go.kr/1360000/AsosDalyInfoService/getWthrDataList",
    endpointStatus: "official_documentation_verified",
    authorizationProfile: "public-data-portal",
    pagination: true,
    observationTarget: "daily_weather_seasonality",
    watermarkRule: "stationId+observationDate",
    duplicateKeyRule: "stationId+observationDate+metricKey"
  },
  "kosis.population.sigungu": {
    provider: "statistics_korea_kosis",
    datasetId: "kosis.openapi:statisticsData",
    operation: "statisticsData",
    selectionStatus: "candidate",
    connectionStage: "needs_mapping_decision",
    method: "GET",
    endpoint: null,
    endpointStatus: "table_and_operation_path_unverified",
    authorizationProfile: "kosis-registered-application",
    pagination: false,
    observationTarget: "sigungu_population_series",
    watermarkRule: "tableId+itemId+regionCode+period",
    duplicateKeyRule: "tableId+itemId+regionKey+period+unit"
  },
  "molit.traffic_volume.statistics": {
    provider: "ministry_of_land_infrastructure_and_transport",
    datasetId: "data.go.kr:15097077",
    operation: "trafficVolumeStatistics",
    selectionStatus: "candidate",
    connectionStage: "needs_mapping_decision",
    method: "GET",
    endpoint: null,
    endpointStatus: "operation_path_unverified",
    authorizationProfile: "public-data-portal",
    pagination: true,
    observationTarget: "traffic_demand_series",
    watermarkRule: "countStationId+measurementPeriod",
    duplicateKeyRule: "countStationId+measurementPeriod+direction+metricKey"
  },
  "naver.datalab.search_trend": {
    provider: "naver_datalab",
    datasetId: "naver:datalab-search-trend",
    operation: "searchTrend",
    selectionStatus: "candidate",
    connectionStage: "needs_terms_approval",
    method: "POST",
    endpoint: "https://openapi.naver.com/v1/datalab/search",
    endpointStatus: "existing_adapter_endpoint_verified",
    authorizationProfile: "naver-registered-application",
    pagination: false,
    observationTarget: "relative_search_interest_series",
    watermarkRule: "keywordGroupVersion+period",
    duplicateKeyRule: "regionKey+keywordGroupVersion+period+timeUnit"
  },
  "naver.searchad.keyword_volume": {
    provider: "naver_searchad",
    datasetId: "naver-searchad:keywordstool",
    operation: "keywordstool",
    selectionStatus: "candidate",
    connectionStage: "needs_terms_approval",
    method: "GET",
    endpoint: "https://api.searchad.naver.com/keywordstool",
    endpointStatus: "existing_adapter_endpoint_verified",
    authorizationProfile: "naver-searchad-account",
    pagination: false,
    observationTarget: "absolute_keyword_volume_snapshot",
    watermarkRule: "keywordDictionaryVersion+providerMonth",
    duplicateKeyRule: "regionKey+exactKeyword+providerMonth+device"
  }
});

const API_SOURCE_IDS = deepFreeze(Object.keys(SOURCE_DEFINITIONS));
const REFERENCE_ONLY_SOURCE_IDS = deepFreeze(["mois.legal_dong.reference"]);
const FORBIDDEN_REQUEST_KEY = /^(?:servicekey|apikey|secret|signature|authorization|token|customer(?:id)?)$/i;
const FORBIDDEN_HEADER = /^(?:authorization|x-naver-client-id|x-naver-client-secret|x-api-key|x-customer|x-signature|x-timestamp)$/i;

function fail(code, message) {
  throw new LocationApiRequestBuilderError(code, message);
}

function readRegionRegistry(filePath = DEFAULT_REGION_REGISTRY_FILE) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function exactActiveRegion(regionKey, registry = readRegionRegistry()) {
  const normalizedKey = String(regionKey || "").trim();
  const matches = Array.isArray(registry?.regions)
    ? registry.regions.filter((region) => region?.active === true && region.regionKey === normalizedKey)
    : [];
  if (matches.length !== 1) {
    fail("CANONICAL_REGION_NOT_FOUND", `Active canonical region not found: ${normalizedKey || "(empty)"}`);
  }
  return matches[0];
}

function isoDate(value, fieldName) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail("INVALID_MEASUREMENT_PERIOD", `${fieldName} must be YYYY-MM-DD`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    fail("INVALID_MEASUREMENT_PERIOD", `${fieldName} must be a real calendar date`);
  }
  return text;
}

function normalizeMeasurementPeriod(period = {}) {
  const from = isoDate(period.from, "measurementPeriod.from");
  const to = isoDate(period.to, "measurementPeriod.to");
  if (from > to) fail("INVALID_MEASUREMENT_PERIOD", "measurementPeriod.from must not follow measurementPeriod.to");
  return { from, to };
}

function dateDigits(value) {
  return value.replaceAll("-", "");
}

function closedMonth(period) {
  return period.to.slice(0, 7).replace("-", "");
}

function positiveInteger(value, fallback, fieldName) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1) fail("INVALID_PAGINATION", `${fieldName} must be a positive integer`);
  return number;
}

function assertSanitizedMap(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_REQUEST_KEY.test(key)) fail("AUTH_MATERIAL_FORBIDDEN", `${kind} contains forbidden key ${key}`);
    if (kind === "headers" && FORBIDDEN_HEADER.test(key)) fail("AUTH_MATERIAL_FORBIDDEN", `headers contain forbidden key ${key}`);
    if (child && typeof child === "object") assertSanitizedMap(child, kind);
  }
}

function sanitizedUrl(endpoint, query = {}) {
  if (!endpoint) return null;
  assertSanitizedMap(query, "query");
  const url = new URL(endpoint);
  if (url.protocol !== "https:") fail("HTTPS_REQUIRED", "Request descriptors require HTTPS endpoints");
  for (const key of [...url.searchParams.keys()]) {
    if (FORBIDDEN_REQUEST_KEY.test(key)) fail("AUTH_MATERIAL_FORBIDDEN", `endpoint contains forbidden query key ${key}`);
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function tourismCommonQuery(pageNumber, pageSize) {
  return {
    _type: "json",
    MobileOS: "ETC",
    MobileApp: "lodging-datalab",
    pageNo: pageNumber,
    numOfRows: pageSize
  };
}

function regionStem(region = {}) {
  return String(region.sigungu || "").replace(/[시군구]$/, "");
}

function keywordProposal(region = {}) {
  const stem = regionStem(region);
  return {
    proposalVersion: "pilot-keyword-groups.2026-08-05.v1",
    approvalStatus: "pending",
    groupName: `${stem} lodging demand`,
    keywords: [
      `${stem}글램핑`,
      `${stem} 글램핑`,
      `${stem}펜션`,
      `${stem} 펜션`,
      `${stem}캠핑`,
      `${stem} 캠핑`
    ]
  };
}

function baseBlockers(definition) {
  const blockers = ["external_api_execution_not_approved"];
  if (definition.selectionStatus === "candidate") blockers.push("candidate_source_not_approved");
  if (!definition.endpoint) blockers.push("official_operation_path_unverified");
  return blockers;
}

function sourceRequestParts(sourceId, definition, region, period, pageNumber, pageSize, options = {}) {
  const blockers = baseBlockers(definition);
  let query = {};
  let headers = { Accept: "application/json" };
  let body = null;
  let regionSelection = {
    mode: "canonical_region_exact",
    regionKey: region.regionKey,
    fuzzyFallback: false
  };
  let requestScope = "region";

  if (["kto.tour_info.resources", "kto.tour_info.events", "kto.tour_info.lodging"].includes(sourceId)) {
    query = tourismCommonQuery(pageNumber, pageSize);
    if (sourceId === "kto.tour_info.events") {
      query.eventStartDate = dateDigits(period.from);
      query.eventEndDate = dateDigits(period.to);
    }
    regionSelection = {
      mode: "official_tourapi_crosswalk_required",
      regionKey: region.regionKey,
      requestRegionParametersIncluded: false,
      forbiddenDerivedCodeSystem: "KTO_DATALAB_SGG_CD",
      fuzzyFallback: false
    };
    blockers.push("tourapi_region_code_crosswalk_unverified");
  } else if (sourceId === "kto.gocamping.inventory") {
    query = tourismCommonQuery(pageNumber, pageSize);
    requestScope = "national_shared_snapshot";
    regionSelection = {
      mode: "response_post_filter_exact",
      targetRegions: Array.isArray(options.targetRegions)
        ? options.targetRegions.map((target) => ({
          regionKey: target.regionKey,
          sidoNames: [...new Set([target.sido, target.sidoFull].filter(Boolean))],
          sigunguName: target.sigungu
        }))
        : [{
          regionKey: region.regionKey,
          sidoNames: [...new Set([region.sido, region.sidoFull].filter(Boolean))],
          sigunguName: region.sigungu
        }],
      responseFields: ["doNm", "sigunguNm"],
      fuzzyFallback: false
    };
  } else if (["kto.bigdata.visitors", "kto.bigdata.resource_demand"].includes(sourceId)) {
    const code = String(region.ktoSggCd || "").trim();
    if (!code || region.ktoSggCdStatus !== "mapped") blockers.push("kto_sgg_cd_unverified");
    query = sourceId === "kto.bigdata.visitors"
      ? { SGG_CD: code || null, YM: closedMonth(period), pageNo: pageNumber, numOfRows: pageSize }
      : { SGG_CD: code || null, BASE_YM: closedMonth(period), pageNo: pageNumber, numOfRows: pageSize };
    regionSelection = {
      mode: "kto_datalab_sgg_cd_exact",
      regionKey: region.regionKey,
      codeSystem: "KTO_DATALAB_SGG_CD",
      codeStatus: region.ktoSggCdStatus || "unverified",
      fuzzyFallback: false
    };
    blockers.push("production_subscription_review_required");
    if (sourceId === "kto.bigdata.resource_demand") blockers.push("catalog_operation_must_be_mapped_to_official_operation");
  } else if (sourceId === "kma.asos.daily_weather") {
    query = {
      dataType: "JSON",
      dataCd: "ASOS",
      dateCd: "DAY",
      startDt: dateDigits(period.from),
      endDt: dateDigits(period.to),
      pageNo: pageNumber,
      numOfRows: pageSize
    };
    regionSelection = {
      mode: "weather_station_crosswalk_required",
      regionKey: region.regionKey,
      stationParameterIncluded: false,
      fuzzyFallback: false
    };
    blockers.push("weather_station_crosswalk_unverified");
  } else if (sourceId === "kosis.population.sigungu") {
    regionSelection = {
      mode: "kosis_table_region_crosswalk_required",
      regionKey: region.regionKey,
      requestRegionParametersIncluded: false,
      fuzzyFallback: false
    };
    blockers.push("kosis_table_item_unit_unverified", "kosis_region_code_crosswalk_unverified");
  } else if (sourceId === "molit.traffic_volume.statistics") {
    regionSelection = {
      mode: "traffic_station_or_link_crosswalk_required",
      regionKey: region.regionKey,
      requestRegionParametersIncluded: false,
      fuzzyFallback: false
    };
    blockers.push("traffic_station_region_assignment_unverified");
  } else if (sourceId === "naver.datalab.search_trend") {
    const proposal = keywordProposal(region);
    headers = { Accept: "application/json", "Content-Type": "application/json" };
    body = {
      startDate: period.from,
      endDate: period.to,
      timeUnit: options.timeUnit || "date",
      keywordGroups: [{ groupName: proposal.groupName, keywords: proposal.keywords }]
    };
    regionSelection = {
      mode: "approved_keyword_group_only",
      regionKey: region.regionKey,
      keywordGroupProposal: proposal,
      geographicResponseClaim: false,
      fuzzyFallback: false
    };
    blockers.push("keyword_group_approval_required");
  } else if (sourceId === "naver.searchad.keyword_volume") {
    const proposal = keywordProposal(region);
    query = { hintKeywords: proposal.keywords[0], showDetail: 1 };
    regionSelection = {
      mode: "approved_exact_keyword_dictionary_only",
      regionKey: region.regionKey,
      keywordDictionaryProposal: proposal,
      relatedKeywordRegionFallback: false,
      fuzzyFallback: false
    };
    blockers.push("keyword_dictionary_approval_required", "commercial_terms_review_required");
  }

  return { blockers, query, headers, body, regionSelection, requestScope };
}

function buildRequestDescriptor(input = {}) {
  const sourceId = String(input.sourceId || "").trim();
  if (REFERENCE_ONLY_SOURCE_IDS.includes(sourceId)) {
    fail("REFERENCE_ONLY_SOURCE", `${sourceId} is reference-only and must not create a repeated API request`);
  }
  const definition = SOURCE_DEFINITIONS[sourceId];
  if (!definition) fail("UNSUPPORTED_SOURCE", `Unsupported API source: ${sourceId || "(empty)"}`);

  const registry = input.registry || readRegionRegistry(input.regionRegistryFile);
  const region = exactActiveRegion(input.regionKey, registry);
  const period = normalizeMeasurementPeriod(input.measurementPeriod);
  const pageNumber = positiveInteger(input.pageNumber, 1, "pageNumber");
  const pageSize = positiveInteger(input.pageSize, DEFAULT_PAGE_SIZE, "pageSize");
  const pageCeiling = positiveInteger(input.pageCeiling, definition.pagination ? DEFAULT_PAGE_CEILING : 1, "pageCeiling");
  const callCeiling = positiveInteger(input.callCeiling, definition.pagination ? DEFAULT_PAGE_CEILING : 1, "callCeiling");
  const parts = sourceRequestParts(sourceId, definition, region, period, pageNumber, pageSize, input);

  assertSanitizedMap(parts.query, "query");
  assertSanitizedMap(parts.headers, "headers");
  assertSanitizedMap(parts.body, "body");

  return deepFreeze({
    schemaVersion: REQUEST_DESCRIPTOR_SCHEMA_VERSION,
    sourceId,
    provider: definition.provider,
    datasetId: definition.datasetId,
    operation: definition.operation,
    selectionStatus: definition.selectionStatus,
    connectionStage: definition.connectionStage,
    actualCallsEnabled: false,
    executionState: "blocked",
    approvalRequired: true,
    authorizationProfile: definition.authorizationProfile,
    method: definition.method,
    url: sanitizedUrl(definition.endpoint, parts.query),
    parameters: parts.query,
    headers: parts.headers,
    body: parts.body,
    page: definition.pagination ? { number: pageNumber, size: pageSize } : null,
    paginationPolicy: {
      enabled: definition.pagination,
      pageCeiling,
      callCeiling,
      estimatedPageCount: null,
      estimatedCallCount: null,
      estimateReason: "No provider totalCount was requested during fixture-only preparation"
    },
    requestScope: parts.requestScope,
    regionKey: region.regionKey,
    measurementPeriod: period,
    regionSelection: parts.regionSelection,
    observationTarget: definition.observationTarget,
    watermarkRule: definition.watermarkRule,
    duplicateKeyRule: definition.duplicateKeyRule,
    endpointStatus: definition.endpointStatus,
    blockers: [...new Set(parts.blockers)]
  });
}

module.exports = {
  API_SOURCE_IDS,
  DEFAULT_PAGE_CEILING,
  DEFAULT_PAGE_SIZE,
  DEFAULT_REGION_REGISTRY_FILE,
  LocationApiRequestBuilderError,
  REFERENCE_ONLY_SOURCE_IDS,
  REQUEST_DESCRIPTOR_SCHEMA_VERSION,
  SOURCE_DEFINITIONS,
  buildLocationApiRequestDescriptor: buildRequestDescriptor,
  buildRequestDescriptor,
  exactActiveRegion,
  keywordProposal,
  normalizeMeasurementPeriod,
  readRegionRegistry
};
