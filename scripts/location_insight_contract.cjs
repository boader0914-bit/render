"use strict";

const crypto = require("node:crypto");

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

const CONTRACT_VERSIONS = deepFreeze({
  observation: "location-insight.observation.v2",
  leadTimeObservation: "location-insight.lead-time-observation.v1",
  maintenanceFeatureFrame: "location-insight.maintenance-feature-frame.v1",
  regionalRevenueTarget: "location-insight.regional-revenue-target.v1"
});

const OBSERVATION_STATUSES = deepFreeze([
  "ready",
  "zero",
  "missing",
  "partial",
  "stale",
  "conflict"
]);

const CONFIDENCE_GRADES = deepFreeze(["A", "B", "C", "D", "U"]);
const OBSERVATION_ROLES = deepFreeze(["feature", "target", "descriptive"]);
const REVENUE_BASES = deepFreeze(["settled_actual", "booked_to_date_estimate", "adjusted_estimate"]);
const REVENUE_MODEL_ROLES = deepFreeze(["target", "proxy_target", "descriptive"]);

const SOURCE_CATALOG = deepFreeze({
  "kto.visitors": {
    key: "kto.visitors",
    provider: "korea_tourism_data_lab",
    datasetId: "data.go.kr:15101972",
    operation: "regionalVisitorCounts",
    label: "지역별 방문자 수",
    authority: "한국관광공사",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15101972/openapi.do",
    license: "public-data-portal-terms",
    domains: ["visitors", "demand"],
    metricSemantics: "daily_mobile_presence_count",
    limitations: ["not_a_unique_trip_count", "province_and_sigungu_counts_not_additive"]
  },
  "kto.resource_demand": {
    key: "kto.resource_demand",
    provider: "korea_tourism_data_lab",
    datasetId: "data.go.kr:15152138",
    operation: "regionalTourismResourceDemand",
    label: "지역별 관광 자원 수요",
    authority: "한국관광공사",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15152138/openapi.do",
    license: "public-data-portal-terms",
    domains: ["social_mentions", "tourism_consumption", "navigation_search"],
    metricSemantics: "provider_aggregated_regional_indices",
    limitations: ["not_raw_social_posts", "unknown_denominator_requires_partial"]
  },
  "kto.demand_intensity": {
    key: "kto.demand_intensity",
    provider: "korea_tourism_data_lab",
    datasetId: "data.go.kr:15151868",
    operation: "regionalTourismDemandIntensity",
    label: "지역별 관광 수요 강도",
    authority: "한국관광공사",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15151868/openapi.do",
    license: "public-data-portal-terms",
    domains: ["overnight_demand", "nonresident_consumption", "stay_intensity"]
  },
  "kto.diversity": {
    key: "kto.diversity",
    provider: "korea_tourism_data_lab",
    datasetId: "data.go.kr:15151365",
    operation: "regionalTourismDiversity",
    label: "지역별 관광 다양성",
    authority: "한국관광공사",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15151365/openapi.do",
    license: "public-data-portal-terms",
    domains: ["tourism_diversity"]
  },
  "kto.tour_info": {
    key: "kto.tour_info",
    provider: "korea_tourism_organization",
    datasetId: "data.go.kr:15101578",
    operation: "areaBasedList2",
    label: "국문 관광정보",
    authority: "한국관광공사",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15101578/openapi.do",
    license: "public-data-portal-terms",
    domains: ["tourist_attraction", "festival", "event", "coordinates"]
  },
  "kto.camping": {
    key: "kto.camping",
    provider: "korea_tourism_organization",
    datasetId: "data.go.kr:15101933",
    operation: "basedList",
    label: "고캠핑 정보",
    authority: "한국관광공사",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15101933/openapi.do",
    license: "public-data-portal-terms",
    domains: ["camping_inventory", "facilities", "safety", "amenities"]
  },
  "kto.pet": {
    key: "kto.pet",
    provider: "korea_tourism_organization",
    datasetId: "data.go.kr:15135102",
    operation: "petTravelInformation",
    label: "반려동물 동반여행 정보",
    authority: "한국관광공사",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15135102/openapi.do",
    license: "public-data-portal-terms",
    domains: ["pet_friendly_tourism", "pet_facilities"]
  },
  "mois.legal_dong": {
    key: "mois.legal_dong",
    provider: "ministry_of_the_interior_and_safety",
    datasetId: "data.go.kr:15077871",
    operation: "legalDongCodeList",
    label: "법정동 코드",
    authority: "행정안전부",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15077871/openapi.do",
    license: "public-data-portal-terms",
    domains: ["region_registry", "legal_region_code"]
  },
  sgis: {
    key: "sgis",
    provider: "statistics_korea_sgis",
    datasetId: "sgis.openapi",
    operation: "regionalStatistics",
    label: "SGIS 통계지리정보",
    authority: "통계청",
    accessClass: "public_api",
    sourceUrl: "https://sgis.mods.go.kr/developer/html/openApi/api/intro.html",
    license: "sgis-api-terms",
    domains: ["population", "households", "administrative_boundary"]
  },
  "sgis.boundary_snapshot": {
    key: "sgis.boundary_snapshot",
    provider: "statistics_korea_sgis",
    datasetId: "data.go.kr:15129688",
    operation: "administrativeStatisticsBoundaryFile",
    label: "SGIS administrative statistics and boundary snapshot",
    authority: "Statistics Korea",
    accessClass: "public_file",
    sourceUrl: "https://www.data.go.kr/data/15129688/fileData.do",
    license: "public-data-portal-terms",
    domains: ["population", "business", "administrative_boundary"]
  },
  kosis: {
    key: "kosis",
    provider: "statistics_korea_kosis",
    datasetId: "kosis.openapi",
    operation: "statisticsData",
    label: "KOSIS 국가통계",
    authority: "통계청",
    accessClass: "public_api",
    sourceUrl: "https://kosis.kr/openapi/index/index.jsp",
    license: "kosis-openapi-terms",
    domains: ["population", "economy", "regional_statistics"]
  },
  forest: {
    key: "forest",
    provider: "korea_forest_service",
    datasetId: "data.go.kr:15058662",
    operation: "mountainInformation",
    label: "산림청 산정보",
    authority: "산림청",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15058662/openapi.do",
    license: "public-data-portal-terms",
    domains: ["mountain", "forest", "trail"]
  },
  "forest.trail": {
    key: "forest.trail",
    provider: "korea_forest_service",
    datasetId: "data.go.kr:15158970",
    operation: "hikingTrailInformation",
    label: "Korea Forest Service hiking trail information",
    authority: "Korea Forest Service",
    accessClass: "public_api",
    sourceUrl: "https://www.data.go.kr/data/15158970/openapi.do",
    license: "public-data-portal-terms",
    domains: ["trail", "distance", "duration", "difficulty", "facilities"]
  },
  "forest.stand_snapshot": {
    key: "forest.stand_snapshot",
    provider: "korea_forest_service",
    datasetId: "data.go.kr:15093362",
    operation: "forestStandMapFile",
    label: "1:5,000 forest stand map snapshot",
    authority: "Korea Forest Service",
    accessClass: "public_file",
    sourceUrl: "https://www.data.go.kr/data/15093362/fileData.do",
    license: "public-data-portal-terms",
    domains: ["forest_type", "tree_species", "stand_age", "canopy_density"],
    limitations: ["historical_snapshot", "stale_until_current_source_verified"]
  },
  vworld: {
    key: "vworld",
    provider: "molit_vworld",
    datasetId: "vworld.openapi",
    operation: "spatialData",
    label: "VWorld 공간정보",
    authority: "국토교통부",
    accessClass: "public_api",
    sourceUrl: "https://www.vworld.kr/dev/v4dv_2ddataguide2_s001.do",
    license: "vworld-api-terms",
    domains: ["geospatial", "administrative_boundary", "land"]
  },
  "vworld.geocoder": {
    key: "vworld.geocoder",
    provider: "molit_vworld",
    datasetId: "data.go.kr:15101106",
    operation: "addressGeocode",
    label: "VWorld address geocoder",
    authority: "Ministry of Land, Infrastructure and Transport",
    accessClass: "public_api_transient_only",
    sourceUrl: "https://www.data.go.kr/data/15101106/openapi.do",
    license: "vworld-api-terms",
    storagePolicy: "transient_only_no_persistence",
    domains: ["address_resolution", "coordinates"]
  },
  "molit.road_network": {
    key: "molit.road_network",
    provider: "ministry_of_land_infrastructure_and_transport",
    datasetId: "data.go.kr:15025526",
    operation: "standardNodeLinkFile",
    label: "National standard road node-link snapshot",
    authority: "Ministry of Land, Infrastructure and Transport",
    accessClass: "public_file",
    sourceUrl: "https://www.data.go.kr/data/15025526/fileData.do",
    license: "public-data-portal-terms",
    domains: ["road_access", "network_distance", "static_connectivity"]
  },
  "naver.trend": {
    key: "naver.trend",
    provider: "naver_datalab",
    datasetId: "naver:datalab-search-trend",
    operation: "searchTrend",
    label: "네이버 데이터랩 검색어 트렌드",
    authority: "NAVER",
    accessClass: "registered_api",
    sourceUrl: "https://developers.naver.com/docs/serviceapi/datalab/search/search.md",
    license: "naver-openapi-terms",
    domains: ["relative_search_trend"],
    metricSemantics: "relative_ratio_max_100_within_request_group",
    limitations: ["not_absolute_search_volume", "not_social_media", "request_groups_not_directly_comparable"]
  },
  "naver.search_volume": {
    key: "naver.search_volume",
    provider: "naver_searchad",
    datasetId: "naver-searchad:keywordstool",
    operation: "keywordstool",
    label: "네이버 검색광고 키워드 검색량",
    authority: "NAVER",
    accessClass: "account_authorized_api",
    sourceUrl: "https://naver.github.io/searchad-apidoc/#/operations/GET/~2keywordstool",
    license: "naver-searchad-api-terms",
    domains: ["absolute_search_volume"],
    metricSemantics: "provider_monthly_keyword_volume",
    limitations: ["less_than_10_is_censored", "related_keyword_fallback_is_partial"]
  },
  ota: {
    key: "ota",
    provider: "authorized_ota_partner",
    datasetId: "ota:authorized-partner-contract",
    operation: "lodgingAvailability",
    label: "OTA 예약·재고 관측",
    authority: "계약된 OTA 또는 승인 수집 경계",
    accessClass: "licensed_only",
    sourceUrl: "urn:lodging-datalab:source:ota",
    license: "contract-restricted",
    domains: ["availability", "price", "booking", "lead_time"],
    limitations: ["missing_when_not_licensed", "public_web_scraping_not_equivalent_to_partner_api"]
  },
  "lodging.inventory": {
    key: "lodging.inventory",
    provider: "lodging_datalab",
    datasetId: "lodging-datalab:inventory-observation",
    operation: "inventoryObservation",
    label: "숙박 재고 반복 관측",
    authority: "숙박 데이터랩",
    accessClass: "internal",
    sourceUrl: "urn:lodging-datalab:source:inventory",
    license: "internal-confidential",
    domains: ["availability", "inventory", "lead_time"]
  },
  "lodging.revenue": {
    key: "lodging.revenue",
    provider: "lodging_datalab",
    datasetId: "lodging-datalab:regional-revenue",
    operation: "regionalRevenueAggregate",
    label: "지역 숙박 매출",
    authority: "숙박 데이터랩",
    accessClass: "internal",
    sourceUrl: "urn:lodging-datalab:source:revenue",
    license: "internal-confidential",
    domains: ["revenue", "regional_average_revenue", "model_target"],
    limitations: ["estimated_revenue_is_proxy_only", "only_final_settled_actual_is_target_eligible"]
  }
});

const SOURCE_KEYS = deepFreeze(Object.keys(SOURCE_CATALOG));

const SENSITIVE_PARAMETER_NAMES = new Set([
  "apikey",
  "accesskey",
  "servicekey",
  "secretkey",
  "clientsecret",
  "clientid",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "password",
  "passwd",
  "signature",
  "token",
  "secret",
  "key"
]);

function boundedText(value, max = 320) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizedParameterName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveParameterName(value) {
  const name = normalizedParameterName(value);
  return SENSITIVE_PARAMETER_NAMES.has(name)
    || name.endsWith("apikey")
    || name.endsWith("servicekey")
    || name.endsWith("accesstoken")
    || name.endsWith("clientsecret");
}

function redactQueryText(value) {
  return String(value ?? "").replace(/([?&#])([^=&#]+)=([^&#]*)/g, (match, separator, name, rawValue) => {
    let decodedName = name;
    try {
      decodedName = decodeURIComponent(name.replace(/\+/g, " "));
    } catch {
      decodedName = name;
    }
    return isSensitiveParameterName(decodedName) ? `${separator}${name}=REDACTED` : `${separator}${name}=${rawValue}`;
  });
}

function redactSensitiveUrl(value) {
  const raw = boundedText(value, 4096);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    for (const name of [...parsed.searchParams.keys()]) {
      if (isSensitiveParameterName(name)) parsed.searchParams.set(name, "REDACTED");
    }
    parsed.hash = redactQueryText(parsed.hash);
    return parsed.toString();
  } catch {
    return redactQueryText(raw.replace(/\/\/[^/@\s]+@/g, "//REDACTED@"));
  }
}

function cloneSerializable(value, key = "") {
  if (isSensitiveParameterName(key)) return "REDACTED";
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  if (Array.isArray(value)) return value.map((entry) => cloneSerializable(entry));
  if (typeof value === "object") {
    const output = {};
    for (const [childKey, child] of Object.entries(value)) {
      output[childKey] = cloneSerializable(child, childKey);
    }
    return output;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string" && /url$/i.test(key)) return redactSensitiveUrl(value);
  return value;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function fingerprintRequest(value = {}) {
  return sha256Hex(stableStringify(cloneSerializable(value)));
}

function payloadHash(value) {
  return sha256Hex(stableStringify(cloneSerializable(value)));
}

function normalizedHash(value) {
  const hash = boundedText(value, 128).toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value) {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function temporalText(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "";
  return boundedText(value, 48);
}

function dateText(value) {
  const raw = temporalText(value);
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : raw;
}

function parsedTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

function durationHours(from, to) {
  const fromTime = parsedTime(from);
  const toTime = parsedTime(to);
  if (fromTime === null || toTime === null) return null;
  return Math.round(((toTime - fromTime) / 3600000) * 1e6) / 1e6;
}

function durationDays(from, to) {
  const hours = durationHours(from, to);
  return hours === null ? null : Math.round((hours / 24) * 1e6) / 1e6;
}

function addHours(value, hours) {
  const time = parsedTime(value);
  return time === null || !Number.isFinite(hours) ? "" : new Date(time + hours * 3600000).toISOString();
}

function calendarDateInTimeZone(value, timeZone = "Asia/Seoul") {
  const raw = temporalText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const time = parsedTime(raw);
  if (time === null) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date(time));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return "";
  }
}

function calendarDayNumber(value, timeZone = "Asia/Seoul") {
  const key = calendarDateInTimeZone(value, timeZone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const time = Date.parse(`${key}T00:00:00.000Z`);
  return Number.isFinite(time) ? Math.floor(time / 86400000) : null;
}

function calendarDayDifference(from, to, timeZone = "Asia/Seoul") {
  const left = calendarDayNumber(from, timeZone);
  const right = calendarDayNumber(to, timeZone);
  return left === null || right === null ? null : right - left;
}

function leadTimeBucketFor(value) {
  const days = nonNegativeInteger(value);
  if (days === null) return "";
  if (days === 0) return "same_day";
  if (days <= 3) return "d01_03";
  if (days <= 7) return "d04_07";
  if (days <= 14) return "d08_14";
  if (days <= 30) return "d15_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d91_plus";
}

function sourceDefinition(sourceKey) {
  return SOURCE_CATALOG[boundedText(sourceKey, 80)] || null;
}

function normalizeNormalization(value) {
  if (typeof value === "string") {
    return { method: boundedText(value, 80), version: "", parameters: {} };
  }
  const input = value && typeof value === "object" ? value : {};
  return {
    method: boundedText(input.method || input.type, 80),
    version: boundedText(input.version || input.modelVersion || input.transformVersion, 80),
    parameters: cloneSerializable(input.parameters || input.params || {})
  };
}

function normalizeGeo(value = {}, fallback = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    codeSystem: boundedText(input.codeSystem || input.system || fallback.geoCodeSystem, 80),
    code: boundedText(input.code || fallback.geoCode || fallback.regionKey, 120),
    level: boundedText(input.level || fallback.geoLevel, 40).toLowerCase(),
    name: boundedText(input.name || fallback.geoName, 160)
  };
}

function normalizeSample(value = {}, fallback = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    n: nonNegativeInteger(input.n ?? input.sampleN ?? fallback.sampleN),
    populationN: nonNegativeInteger(input.populationN ?? fallback.populationN),
    unit: boundedText(input.unit || fallback.sampleUnit, 80)
  };
}

function normalizeCoverage(value = {}, fallback = {}) {
  const input = value && typeof value === "object" ? value : {};
  const numerator = nonNegativeInteger(input.numerator ?? fallback.coverageNumerator);
  const denominator = nonNegativeInteger(input.denominator ?? fallback.coverageDenominator);
  const suppliedRatio = finiteNumber(input.ratio ?? fallback.coverageRatio);
  const ratio = suppliedRatio !== null
    ? suppliedRatio
    : denominator !== null && denominator > 0 && numerator !== null
      ? numerator / denominator
      : null;
  return {
    numerator,
    denominator,
    ratio,
    note: boundedText(input.note || fallback.coverageNote, 500)
  };
}

function normalizePenalty(value) {
  if (typeof value === "string") {
    return { code: boundedText(value, 100).toLowerCase(), message: "", severity: "warning" };
  }
  const input = value && typeof value === "object" ? value : {};
  return {
    code: boundedText(input.code || input.reason, 100).toLowerCase(),
    message: boundedText(input.message || input.detail, 500),
    severity: boundedText(input.severity || "warning", 40).toLowerCase()
  };
}

function normalizeConfidence(value = {}, fallback = {}) {
  const input = value && typeof value === "object" ? value : {};
  const rawPenalties = input.penalties || input.penaltyReasons || fallback.penaltyReasons || [];
  return {
    grade: boundedText(input.grade || fallback.confidenceGrade || "U", 4).toUpperCase(),
    score: finiteNumber(input.score ?? fallback.confidenceScore),
    penalties: (Array.isArray(rawPenalties) ? rawPenalties : [rawPenalties]).filter(Boolean).map(normalizePenalty)
  };
}

function normalizeLicenseSnapshot(value = {}, definition = null, fetchedAt = "") {
  const input = typeof value === "string" ? { license: value } : value && typeof value === "object" ? value : {};
  return {
    license: boundedText(input.license || input.id || definition?.license, 120),
    termsUrl: redactSensitiveUrl(input.termsUrl || input.url || definition?.sourceUrl || ""),
    capturedAt: temporalText(input.capturedAt || input.observedAt || fetchedAt),
    attribution: boundedText(input.attribution || definition?.authority, 240),
    commercialUse: input.commercialUse === true ? true : input.commercialUse === false ? false : null,
    redistribution: input.redistribution === true ? true : input.redistribution === false ? false : null
  };
}

function normalizeMetricValue(value) {
  return cloneSerializable(value);
}

function normalizeObservation(input = {}) {
  const definition = sourceDefinition(input.sourceKey);
  const status = boundedText(input.status, 24).toLowerCase();
  const fetchedAt = temporalText(input.fetchedAt);
  const availableAt = temporalText(input.availableAt || fetchedAt);
  let value = input.value === undefined ? null : normalizeMetricValue(input.value);
  if (status === "missing") value = null;
  if (status === "zero" && value === null) value = 0;

  const sourceUrl = redactSensitiveUrl(input.sourceUrl || definition?.sourceUrl || "");
  const requestDescriptor = input.request || {
    sourceKey: input.sourceKey || "",
    provider: input.provider || definition?.provider || "",
    datasetId: input.datasetId || definition?.datasetId || "",
    operation: input.operation || definition?.operation || "",
    sourceUrl,
    geo: input.geo || {
      codeSystem: input.geoCodeSystem,
      code: input.geoCode || input.regionKey,
      level: input.geoLevel
    },
    observedFrom: input.observedFrom,
    observedTo: input.observedTo
  };
  const directFingerprint = normalizedHash(input.requestFingerprint);
  const directPayloadHash = normalizedHash(input.rawPayloadHash);
  const hasRawPayload = Object.prototype.hasOwnProperty.call(input, "rawPayload");

  return {
    schemaVersion: boundedText(input.schemaVersion || CONTRACT_VERSIONS.observation, 80),
    contractType: "observation",
    observationType: boundedText(input.observationType || "metric", 40).toLowerCase(),
    role: boundedText(input.role || "descriptive", 24).toLowerCase(),
    sourceKey: boundedText(input.sourceKey || definition?.key, 80),
    provider: boundedText(input.provider || definition?.provider, 120),
    datasetId: boundedText(input.datasetId || definition?.datasetId, 160),
    operation: boundedText(input.operation || definition?.operation, 120),
    sourceUrl,
    metricKey: boundedText(input.metricKey, 160),
    value,
    unit: boundedText(input.unit, 80),
    normalization: normalizeNormalization(input.normalization),
    geo: normalizeGeo(input.geo, input),
    observedFrom: temporalText(input.observedFrom),
    observedTo: temporalText(input.observedTo),
    sourceUpdatedAt: temporalText(input.sourceUpdatedAt),
    fetchedAt,
    availableAt,
    featureAsOf: temporalText(input.featureAsOf),
    sample: normalizeSample(input.sample, input),
    coverage: normalizeCoverage(input.coverage, input),
    status,
    confidence: normalizeConfidence(input.confidence, input),
    requestFingerprint: directFingerprint || fingerprintRequest(requestDescriptor),
    rawPayloadHash: directPayloadHash || (hasRawPayload ? payloadHash(input.rawPayload) : ""),
    licenseSnapshot: normalizeLicenseSnapshot(input.licenseSnapshot, definition, fetchedAt)
  };
}

function validationResult(errors) {
  return { valid: errors.length === 0, errors };
}

function addError(errors, path, code, message) {
  errors.push({ path, code, message });
}

function isValidTemporal(value) {
  return parsedTime(value) !== null;
}

function validateObservation(value = {}) {
  const errors = [];
  if (value.schemaVersion !== CONTRACT_VERSIONS.observation) {
    addError(errors, "schemaVersion", "invalid_schema_version", `Expected ${CONTRACT_VERSIONS.observation}`);
  }
  for (const field of ["provider", "datasetId", "operation", "sourceUrl", "metricKey", "unit"]) {
    if (!boundedText(value[field], 4096)) addError(errors, field, "required", `${field} is required`);
  }
  if (!value.normalization || !boundedText(value.normalization.method, 80)) {
    addError(errors, "normalization.method", "required", "normalization.method is required");
  }
  for (const field of ["codeSystem", "code", "level"]) {
    if (!boundedText(value.geo?.[field], 160)) addError(errors, `geo.${field}`, "required", `geo.${field} is required`);
  }
  if (!isValidTemporal(value.observedFrom)) addError(errors, "observedFrom", "invalid_time", "observedFrom must be an ISO date or timestamp");
  if (!isValidTemporal(value.observedTo)) addError(errors, "observedTo", "invalid_time", "observedTo must be an ISO date or timestamp");
  if (isValidTemporal(value.observedFrom) && isValidTemporal(value.observedTo) && parsedTime(value.observedFrom) > parsedTime(value.observedTo)) {
    addError(errors, "observedTo", "invalid_range", "observedTo must not precede observedFrom");
  }
  if (value.sourceUpdatedAt && !isValidTemporal(value.sourceUpdatedAt)) {
    addError(errors, "sourceUpdatedAt", "invalid_time", "sourceUpdatedAt must be empty or an ISO date or timestamp");
  }
  if (!isValidTemporal(value.fetchedAt)) addError(errors, "fetchedAt", "invalid_time", "fetchedAt must be an ISO date or timestamp");
  if (!isValidTemporal(value.availableAt)) addError(errors, "availableAt", "invalid_time", "availableAt must be an ISO date or timestamp");
  if (!OBSERVATION_ROLES.includes(value.role)) {
    addError(errors, "role", "invalid_role", `role must be one of ${OBSERVATION_ROLES.join(", ")}`);
  }
  if (value.featureAsOf && !isValidTemporal(value.featureAsOf)) {
    addError(errors, "featureAsOf", "invalid_time", "featureAsOf must be empty or an ISO date or timestamp");
  }
  if (value.role === "feature") {
    if (!isValidTemporal(value.featureAsOf)) {
      addError(errors, "featureAsOf", "required", "feature observations require featureAsOf");
    } else {
      if (isValidTemporal(value.availableAt) && parsedTime(value.availableAt) > parsedTime(value.featureAsOf)) {
        addError(errors, "availableAt", "feature_leakage", "availableAt must not be after featureAsOf");
      }
      if (isValidTemporal(value.observedTo) && parsedTime(value.observedTo) > parsedTime(value.featureAsOf)) {
        addError(errors, "observedTo", "feature_leakage", "observedTo must not be after featureAsOf");
      }
    }
  }

  if (!OBSERVATION_STATUSES.includes(value.status)) {
    addError(errors, "status", "invalid_status", `status must be one of ${OBSERVATION_STATUSES.join(", ")}`);
  }
  if (value.status === "missing" && value.value !== null) {
    addError(errors, "value", "missing_requires_null", "missing observations must have a null value");
  }
  if (value.status === "zero" && !(typeof value.value === "number" && value.value === 0)) {
    addError(errors, "value", "zero_requires_numeric_zero", "zero observations must have the numeric value 0");
  }
  if (value.status === "zero" && value.coverage?.ratio !== null && value.coverage.ratio < 1) {
    addError(errors, "status", "zero_requires_complete_coverage", "incomplete coverage must be partial even when the observed value is 0");
  }
  if (value.status === "ready" && value.value === null) {
    addError(errors, "value", "ready_requires_value", "ready observations require a value");
  }
  if (value.status === "ready" && typeof value.value === "number" && value.value === 0) {
    addError(errors, "status", "numeric_zero_requires_zero_status", "a confirmed numeric zero must use zero status");
  }

  if (value.sample?.n !== null && nonNegativeInteger(value.sample?.n) === null) {
    addError(errors, "sample.n", "invalid_count", "sample.n must be a non-negative integer or null");
  }
  if (value.sample?.populationN !== null && nonNegativeInteger(value.sample?.populationN) === null) {
    addError(errors, "sample.populationN", "invalid_count", "sample.populationN must be a non-negative integer or null");
  }
  const numerator = value.coverage?.numerator;
  const denominator = value.coverage?.denominator;
  const ratio = value.coverage?.ratio;
  if (numerator !== null && nonNegativeInteger(numerator) === null) addError(errors, "coverage.numerator", "invalid_count", "coverage numerator must be a non-negative integer or null");
  if (denominator !== null && nonNegativeInteger(denominator) === null) addError(errors, "coverage.denominator", "invalid_count", "coverage denominator must be a non-negative integer or null");
  if (numerator !== null && denominator !== null && numerator > denominator) {
    addError(errors, "coverage", "numerator_exceeds_denominator", "coverage numerator must not exceed denominator");
  }
  if (ratio !== null && (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)) {
    addError(errors, "coverage.ratio", "invalid_rate", "coverage ratio must be between 0 and 1");
  }
  if (numerator !== null && denominator > 0 && ratio !== null && Math.abs(ratio - numerator / denominator) > 1e-9) {
    addError(errors, "coverage.ratio", "inconsistent_ratio", "coverage ratio must equal numerator / denominator");
  }
  if (value.status === "partial" && !(ratio !== null && ratio < 1) && !(value.confidence?.penalties?.length > 0)) {
    addError(errors, "status", "partial_requires_limitation", "partial observations require incomplete coverage or a confidence penalty");
  }

  if (!CONFIDENCE_GRADES.includes(value.confidence?.grade)) {
    addError(errors, "confidence.grade", "invalid_grade", `confidence grade must be one of ${CONFIDENCE_GRADES.join(", ")}`);
  }
  const confidenceScore = value.confidence?.score;
  if (confidenceScore !== null && (!Number.isFinite(confidenceScore) || confidenceScore < 0 || confidenceScore > 100)) {
    addError(errors, "confidence.score", "invalid_score", "confidence score must be between 0 and 100 or null");
  }
  if (value.status !== "missing" && confidenceScore === null) {
    addError(errors, "confidence.score", "required", "non-missing observations require a confidence score");
  }
  for (const [index, penalty] of (value.confidence?.penalties || []).entries()) {
    if (!boundedText(penalty?.code, 100)) addError(errors, `confidence.penalties.${index}.code`, "required", "penalty code is required");
  }

  if (!/^[a-f0-9]{64}$/.test(String(value.requestFingerprint || ""))) {
    addError(errors, "requestFingerprint", "invalid_hash", "requestFingerprint must be a SHA-256 hex digest");
  }
  if (value.status !== "missing" && !/^[a-f0-9]{64}$/.test(String(value.rawPayloadHash || ""))) {
    addError(errors, "rawPayloadHash", "invalid_hash", "non-missing observations require a SHA-256 rawPayloadHash");
  }
  if (!boundedText(value.licenseSnapshot?.license, 120)) {
    addError(errors, "licenseSnapshot.license", "required", "licenseSnapshot.license is required");
  }
  if (!isValidTemporal(value.licenseSnapshot?.capturedAt)) {
    addError(errors, "licenseSnapshot.capturedAt", "invalid_time", "licenseSnapshot.capturedAt must be an ISO date or timestamp");
  }
  const redactedUrl = redactSensitiveUrl(value.sourceUrl);
  if (redactedUrl !== value.sourceUrl) {
    addError(errors, "sourceUrl", "secret_not_redacted", "sourceUrl contains an unredacted credential-like query parameter");
  }
  return validationResult(errors);
}

class ContractValidationError extends Error {
  constructor(contractType, errors) {
    super(`Invalid ${contractType} contract: ${errors.map((error) => `${error.path}:${error.code}`).join(", ")}`);
    this.name = "ContractValidationError";
    this.code = "LOCATION_INSIGHT_CONTRACT_INVALID";
    this.contractType = contractType;
    this.errors = errors;
  }
}

function buildValidated(contractType, normalizeFunction, validateFunction, input) {
  const normalized = normalizeFunction(input);
  const validation = validateFunction(normalized);
  if (!validation.valid) throw new ContractValidationError(contractType, validation.errors);
  return deepFreeze(normalized);
}

function buildObservation(input = {}) {
  return buildValidated("observation", normalizeObservation, validateObservation, input);
}

function normalizeLeadTimeObservation(input = {}) {
  const observation = normalizeObservation({ ...input, observationType: "lead_time" });
  const observedAt = temporalText(input.observedAt || input.fetchedAt);
  const checkIn = dateText(input.checkIn);
  const checkOut = dateText(input.checkOut);
  const targetDate = dateText(input.targetDate || checkIn);
  const timezone = boundedText(input.timezone || "Asia/Seoul", 80);
  const calculatedLeadTime = calendarDayDifference(observedAt, targetDate, timezone);
  const suppliedLeadTime = nonNegativeInteger(input.leadTimeDays);
  const leadTimeDays = suppliedLeadTime === null ? calculatedLeadTime : suppliedLeadTime;
  const leadTimeBucket = boundedText(input.leadTimeBucket || input.bucket, 40).toLowerCase() || leadTimeBucketFor(leadTimeDays);
  return {
    ...observation,
    contractType: "lead_time_observation",
    seriesSchemaVersion: boundedText(input.seriesSchemaVersion || CONTRACT_VERSIONS.leadTimeObservation, 80),
    observedAt,
    timezone,
    targetDate,
    checkIn,
    checkOut,
    leadTimeDays,
    leadTimeBucket,
    bucket: leadTimeBucket,
    seriesKey: boundedText(input.seriesKey, 160),
    runId: boundedText(input.runId, 160),
    propertyId: boundedText(input.propertyId, 160),
    regionKey: boundedText(input.regionKey || observation.geo.code, 160)
  };
}

function validateLeadTimeObservation(value = {}) {
  const errors = [...validateObservation(value).errors];
  if (value.seriesSchemaVersion !== CONTRACT_VERSIONS.leadTimeObservation) {
    addError(errors, "seriesSchemaVersion", "invalid_schema_version", `Expected ${CONTRACT_VERSIONS.leadTimeObservation}`);
  }
  if (!isValidTemporal(value.observedAt)) addError(errors, "observedAt", "invalid_time", "observedAt must be an ISO date or timestamp");
  if (value.timezone !== "Asia/Seoul") addError(errors, "timezone", "invalid_timezone", "lead-time observations must use Asia/Seoul business dates");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.targetDate || "") || !isValidTemporal(value.targetDate)) {
    addError(errors, "targetDate", "invalid_date", "targetDate or checkIn must provide an ISO date");
  }
  if (value.checkIn && (!/^\d{4}-\d{2}-\d{2}$/.test(value.checkIn) || !isValidTemporal(value.checkIn))) {
    addError(errors, "checkIn", "invalid_date", "checkIn must be empty or an ISO date");
  }
  if (value.checkOut && (!/^\d{4}-\d{2}-\d{2}$/.test(value.checkOut) || !isValidTemporal(value.checkOut))) {
    addError(errors, "checkOut", "invalid_date", "checkOut must be empty or an ISO date");
  }
  if (value.checkOut && !value.checkIn) addError(errors, "checkIn", "required", "checkIn is required when checkOut is present");
  if (value.checkIn && value.checkOut && calendarDayDifference(value.checkIn, value.checkOut) <= 0) {
    addError(errors, "checkOut", "invalid_range", "checkOut must be after checkIn");
  }
  const calculatedLeadTime = calendarDayDifference(value.observedAt, value.targetDate, value.timezone);
  if (nonNegativeInteger(value.leadTimeDays) === null) {
    addError(errors, "leadTimeDays", "invalid_lead_time", "leadTimeDays must be a non-negative integer");
  } else if (calculatedLeadTime !== value.leadTimeDays) {
    addError(errors, "leadTimeDays", "inconsistent_lead_time", "leadTimeDays must match observedAt and targetDate");
  }
  const expectedBucket = leadTimeBucketFor(value.leadTimeDays);
  if (!expectedBucket || value.leadTimeBucket !== expectedBucket || value.bucket !== expectedBucket) {
    addError(errors, "leadTimeBucket", "inconsistent_bucket", "lead-time bucket must match leadTimeDays");
  }
  for (const field of ["seriesKey", "runId", "regionKey"]) {
    if (!boundedText(value[field], 160)) addError(errors, field, "required", `${field} is required`);
  }
  if (value.targetDate && value.checkIn && value.targetDate !== value.checkIn) {
    addError(errors, "targetDate", "target_checkin_conflict", "targetDate must equal checkIn when both are supplied");
  }
  return validationResult(errors);
}

function buildLeadTimeObservation(input = {}) {
  return buildValidated("lead_time_observation", normalizeLeadTimeObservation, validateLeadTimeObservation, input);
}

function normalizeMaintenanceFeatureFrame(input = {}) {
  const featureAsOf = temporalText(input.featureAsOf);
  const freshnessInput = input.freshness && typeof input.freshness === "object" ? input.freshness : {};
  const failureInput = input.failureStreak && typeof input.failureStreak === "object"
    ? input.failureStreak
    : { current: input.failureStreak };
  const ratesInput = input.rates && typeof input.rates === "object" ? input.rates : {};
  const volatilityInput = input.volatility && typeof input.volatility === "object"
    ? input.volatility
    : { value: input.volatility };
  const publicationInput = input.publicationAge && typeof input.publicationAge === "object"
    ? input.publicationAge
    : {};
  const scheduleInput = input.schedule && typeof input.schedule === "object" ? input.schedule : {};
  const latencyInput = input.latency && typeof input.latency === "object" ? input.latency : {};
  const latestObservedAt = temporalText(freshnessInput.latestObservedAt || input.latestObservedAt);
  const publishedAt = temporalText(publicationInput.publishedAt || input.publishedAt);
  const calculatedFreshness = durationHours(latestObservedAt, featureAsOf);
  const calculatedPublicationAge = durationDays(publishedAt, featureAsOf);
  const cadenceHours = finiteNumber(scheduleInput.cadenceHours ?? input.cadenceHours);
  const lastAttemptAt = temporalText(scheduleInput.lastAttemptAt || input.lastAttemptAt);
  const expectedNextAt = temporalText(scheduleInput.expectedNextAt || input.expectedNextAt) || addHours(lastAttemptAt, cadenceHours);
  const calculatedOverdueHours = durationHours(expectedNextAt, featureAsOf);
  return {
    schemaVersion: boundedText(input.schemaVersion || CONTRACT_VERSIONS.maintenanceFeatureFrame, 80),
    contractType: "region_maintenance_feature",
    regionKey: boundedText(input.regionKey, 160),
    sourceKeys: (Array.isArray(input.sourceKeys) ? input.sourceKeys : [input.sourceKey]).filter(Boolean).map((value) => boundedText(value, 80)),
    featureAsOf,
    window: {
      from: temporalText(input.window?.from || input.observedFrom),
      to: temporalText(input.window?.to || input.observedTo),
      observationCount: nonNegativeInteger(input.window?.observationCount ?? input.observationCount),
      runCount: nonNegativeInteger(input.window?.runCount ?? input.runCount)
    },
    freshness: {
      latestObservedAt,
      ageHours: finiteNumber(freshnessInput.ageHours ?? input.freshnessHours) ?? calculatedFreshness
    },
    failureStreak: {
      current: nonNegativeInteger(failureInput.current),
      max: nonNegativeInteger(failureInput.max),
      lastFailureAt: temporalText(failureInput.lastFailureAt),
      lastSuccessAt: temporalText(failureInput.lastSuccessAt)
    },
    schedule: {
      cadenceHours,
      lastAttemptAt,
      expectedNextAt,
      overdueHours: finiteNumber(scheduleInput.overdueHours ?? input.overdueHours)
        ?? (calculatedOverdueHours === null ? null : Math.max(0, calculatedOverdueHours))
    },
    latency: {
      p50Ms: finiteNumber(latencyInput.p50Ms),
      p95Ms: finiteNumber(latencyInput.p95Ms),
      sampleN: nonNegativeInteger(latencyInput.sampleN)
    },
    rates: {
      missing: finiteNumber(ratesInput.missing ?? input.missingRate),
      partial: finiteNumber(ratesInput.partial ?? input.partialRate),
      conflict: finiteNumber(ratesInput.conflict ?? input.conflictRate),
      requestFailure: finiteNumber(ratesInput.requestFailure ?? input.requestFailureRate)
    },
    coverage: normalizeCoverage(input.coverage, input),
    volatility: {
      value: finiteNumber(volatilityInput.value),
      method: boundedText(volatilityInput.method || "coefficient_of_variation", 100),
      sampleN: nonNegativeInteger(volatilityInput.sampleN)
    },
    publicationAge: {
      publicationId: boundedText(publicationInput.publicationId || input.publicationId, 160),
      publishedAt,
      ageDays: finiteNumber(publicationInput.ageDays ?? input.publicationAgeDays) ?? calculatedPublicationAge
    }
  };
}

function validateRate(errors, path, value, nullable = false) {
  if (nullable && value === null) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) addError(errors, path, "invalid_rate", `${path} must be between 0 and 1`);
}

function validateNotAfter(errors, path, value, boundary, code = "feature_leakage") {
  if (value && isValidTemporal(value) && isValidTemporal(boundary) && parsedTime(value) > parsedTime(boundary)) {
    addError(errors, path, code, `${path} must not be after featureAsOf`);
  }
}

function validateMaintenanceFeatureFrame(value = {}) {
  const errors = [];
  if (value.schemaVersion !== CONTRACT_VERSIONS.maintenanceFeatureFrame) {
    addError(errors, "schemaVersion", "invalid_schema_version", `Expected ${CONTRACT_VERSIONS.maintenanceFeatureFrame}`);
  }
  if (!boundedText(value.regionKey, 160)) addError(errors, "regionKey", "required", "regionKey is required");
  if (!Array.isArray(value.sourceKeys) || !value.sourceKeys.length) addError(errors, "sourceKeys", "required", "at least one sourceKey is required");
  for (const [index, sourceKey] of (value.sourceKeys || []).entries()) {
    if (!boundedText(sourceKey, 80)) addError(errors, `sourceKeys.${index}`, "required", "sourceKey must not be empty");
  }
  if (!isValidTemporal(value.featureAsOf)) addError(errors, "featureAsOf", "invalid_time", "featureAsOf must be an ISO date or timestamp");
  if (!isValidTemporal(value.window?.from)) addError(errors, "window.from", "invalid_time", "window.from must be an ISO date or timestamp");
  if (!isValidTemporal(value.window?.to)) addError(errors, "window.to", "invalid_time", "window.to must be an ISO date or timestamp");
  if (isValidTemporal(value.window?.from) && isValidTemporal(value.window?.to) && parsedTime(value.window.from) > parsedTime(value.window.to)) {
    addError(errors, "window.to", "invalid_range", "window.to must not precede window.from");
  }
  for (const field of ["observationCount", "runCount"]) {
    if (nonNegativeInteger(value.window?.[field]) === null) addError(errors, `window.${field}`, "invalid_count", `${field} must be a non-negative integer`);
  }
  if (!isValidTemporal(value.freshness?.latestObservedAt)) {
    addError(errors, "freshness.latestObservedAt", "invalid_time", "latestObservedAt must be an ISO date or timestamp");
  }
  if (!Number.isFinite(value.freshness?.ageHours) || value.freshness.ageHours < 0) {
    addError(errors, "freshness.ageHours", "invalid_duration", "freshness ageHours must be non-negative");
  }
  const expectedFreshness = durationHours(value.freshness?.latestObservedAt, value.featureAsOf);
  if (expectedFreshness !== null && Number.isFinite(value.freshness?.ageHours) && Math.abs(expectedFreshness - value.freshness.ageHours) > 1e-6) {
    addError(errors, "freshness.ageHours", "inconsistent_duration", "freshness ageHours must match latestObservedAt and featureAsOf");
  }
  if (nonNegativeInteger(value.failureStreak?.current) === null) addError(errors, "failureStreak.current", "invalid_count", "current failure streak must be a non-negative integer");
  if (value.failureStreak?.max !== null && nonNegativeInteger(value.failureStreak.max) === null) addError(errors, "failureStreak.max", "invalid_count", "max failure streak must be a non-negative integer or null");
  if (value.failureStreak?.max !== null && value.failureStreak.max < value.failureStreak.current) addError(errors, "failureStreak.max", "invalid_max", "max failure streak must be at least current");
  if (!Number.isFinite(value.schedule?.cadenceHours) || value.schedule.cadenceHours <= 0) addError(errors, "schedule.cadenceHours", "invalid_duration", "cadenceHours must be positive");
  if (!isValidTemporal(value.schedule?.lastAttemptAt)) addError(errors, "schedule.lastAttemptAt", "invalid_time", "lastAttemptAt must be an ISO date or timestamp");
  if (!isValidTemporal(value.schedule?.expectedNextAt)) addError(errors, "schedule.expectedNextAt", "invalid_time", "expectedNextAt must be an ISO date or timestamp");
  if (!Number.isFinite(value.schedule?.overdueHours) || value.schedule.overdueHours < 0) addError(errors, "schedule.overdueHours", "invalid_duration", "overdueHours must be non-negative");
  const expectedOverdue = durationHours(value.schedule?.expectedNextAt, value.featureAsOf);
  if (expectedOverdue !== null && Number.isFinite(value.schedule?.overdueHours) && Math.abs(Math.max(0, expectedOverdue) - value.schedule.overdueHours) > 1e-6) {
    addError(errors, "schedule.overdueHours", "inconsistent_duration", "overdueHours must match expectedNextAt and featureAsOf");
  }
  for (const field of ["p50Ms", "p95Ms"]) {
    if (value.latency?.[field] !== null && (!Number.isFinite(value.latency[field]) || value.latency[field] < 0)) addError(errors, `latency.${field}`, "invalid_duration", `${field} must be non-negative or null`);
  }
  if (value.latency?.p50Ms !== null && value.latency?.p95Ms !== null && value.latency.p95Ms < value.latency.p50Ms) addError(errors, "latency.p95Ms", "invalid_percentile", "p95Ms must be at least p50Ms");
  if (value.latency?.sampleN !== null && nonNegativeInteger(value.latency.sampleN) === null) addError(errors, "latency.sampleN", "invalid_count", "latency sampleN must be a non-negative integer or null");
  for (const field of ["missing", "partial", "conflict", "requestFailure"]) validateRate(errors, `rates.${field}`, value.rates?.[field], field === "requestFailure");
  validateRate(errors, "coverage.ratio", value.coverage?.ratio);
  if (nonNegativeInteger(value.coverage?.numerator) === null || nonNegativeInteger(value.coverage?.denominator) === null) {
    addError(errors, "coverage", "invalid_count", "coverage numerator and denominator must be non-negative integers");
  } else if (value.coverage.numerator > value.coverage.denominator) {
    addError(errors, "coverage", "numerator_exceeds_denominator", "coverage numerator must not exceed denominator");
  } else if (value.coverage.denominator > 0 && Math.abs(value.coverage.ratio - value.coverage.numerator / value.coverage.denominator) > 1e-9) {
    addError(errors, "coverage.ratio", "inconsistent_ratio", "coverage ratio must equal numerator / denominator");
  }
  if (value.volatility?.value !== null && (!Number.isFinite(value.volatility.value) || value.volatility.value < 0)) {
    addError(errors, "volatility.value", "invalid_value", "volatility must be non-negative or null");
  }
  if (value.volatility?.value !== null && !boundedText(value.volatility.method, 100)) addError(errors, "volatility.method", "required", "volatility method is required");
  if (value.volatility?.sampleN !== null && nonNegativeInteger(value.volatility.sampleN) === null) addError(errors, "volatility.sampleN", "invalid_count", "volatility sampleN must be a non-negative integer or null");
  if (value.publicationAge?.publishedAt) {
    if (!isValidTemporal(value.publicationAge.publishedAt)) addError(errors, "publicationAge.publishedAt", "invalid_time", "publishedAt must be empty or an ISO date or timestamp");
    if (!Number.isFinite(value.publicationAge.ageDays) || value.publicationAge.ageDays < 0) addError(errors, "publicationAge.ageDays", "invalid_duration", "publication ageDays must be non-negative");
    const expectedAge = durationDays(value.publicationAge.publishedAt, value.featureAsOf);
    if (expectedAge !== null && Number.isFinite(value.publicationAge.ageDays) && Math.abs(expectedAge - value.publicationAge.ageDays) > 1e-6) {
      addError(errors, "publicationAge.ageDays", "inconsistent_duration", "publication ageDays must match publishedAt and featureAsOf");
    }
  } else if (value.publicationAge?.ageDays !== null) {
    addError(errors, "publicationAge.publishedAt", "required", "publishedAt is required when publication ageDays is present");
  }
  validateNotAfter(errors, "window.to", value.window?.to, value.featureAsOf);
  validateNotAfter(errors, "freshness.latestObservedAt", value.freshness?.latestObservedAt, value.featureAsOf);
  validateNotAfter(errors, "failureStreak.lastFailureAt", value.failureStreak?.lastFailureAt, value.featureAsOf);
  validateNotAfter(errors, "failureStreak.lastSuccessAt", value.failureStreak?.lastSuccessAt, value.featureAsOf);
  validateNotAfter(errors, "schedule.lastAttemptAt", value.schedule?.lastAttemptAt, value.featureAsOf);
  validateNotAfter(errors, "publicationAge.publishedAt", value.publicationAge?.publishedAt, value.featureAsOf);
  return validationResult(errors);
}

function buildMaintenanceFeatureFrame(input = {}) {
  return buildValidated("region_maintenance_feature", normalizeMaintenanceFeatureFrame, validateMaintenanceFeatureFrame, input);
}

function normalizeRegionalRevenueTargetFrame(input = {}) {
  const status = boundedText(input.status || (input.totalRevenue === null || input.totalRevenue === undefined ? "missing" : Number(input.totalRevenue) === 0 ? "zero" : "ready"), 24).toLowerCase();
  const totalRevenue = status === "missing" ? null : finiteNumber(input.totalRevenue);
  const propertyCount = nonNegativeInteger(input.sample?.propertyCount ?? input.propertyCount);
  const propertyDays = nonNegativeInteger(input.sample?.propertyDays ?? input.propertyDays);
  const suppliedPerProperty = finiteNumber(input.averageRevenuePerProperty);
  const suppliedPerPropertyDay = finiteNumber(input.averageRevenuePerPropertyDay);
  const averageRevenuePerProperty = suppliedPerProperty !== null
    ? suppliedPerProperty
    : totalRevenue !== null && propertyCount > 0
      ? totalRevenue / propertyCount
      : null;
  const averageRevenuePerPropertyDay = suppliedPerPropertyDay !== null
    ? suppliedPerPropertyDay
    : totalRevenue !== null && propertyDays > 0
      ? totalRevenue / propertyDays
      : null;
  return {
    schemaVersion: boundedText(input.schemaVersion || CONTRACT_VERSIONS.regionalRevenueTarget, 80),
    contractType: "regional_revenue_target",
    targetKey: "regional_average_revenue",
    regionKey: boundedText(input.regionKey, 160),
    status,
    revenueBasis: boundedText(input.revenueBasis, 48).toLowerCase(),
    modelRole: boundedText(input.modelRole, 32).toLowerCase(),
    isFinal: input.isFinal === true,
    targetEligible: boundedText(input.modelRole, 32).toLowerCase() === "target"
      && boundedText(input.revenueBasis, 48).toLowerCase() === "settled_actual"
      && input.isFinal === true,
    currency: boundedText(input.currency || "KRW", 12).toUpperCase(),
    period: {
      from: dateText(input.period?.from || input.observedFrom),
      to: dateText(input.period?.to || input.observedTo)
    },
    featureAsOf: temporalText(input.featureAsOf),
    featureWindow: {
      from: temporalText(input.featureWindow?.from),
      to: temporalText(input.featureWindow?.to)
    },
    targetComputedAt: temporalText(input.targetComputedAt),
    totalRevenue,
    averageRevenuePerProperty,
    averageRevenuePerPropertyDay,
    sample: {
      propertyCount,
      propertyDays,
      revenueObservationCount: nonNegativeInteger(input.sample?.revenueObservationCount ?? input.revenueObservationCount),
      coverage: normalizeCoverage(input.sample?.coverage || input.coverage, input)
    }
  };
}

function validateRegionalRevenueTargetFrame(value = {}) {
  const errors = [];
  if (value.schemaVersion !== CONTRACT_VERSIONS.regionalRevenueTarget) {
    addError(errors, "schemaVersion", "invalid_schema_version", `Expected ${CONTRACT_VERSIONS.regionalRevenueTarget}`);
  }
  if (!boundedText(value.regionKey, 160)) addError(errors, "regionKey", "required", "regionKey is required");
  if (!REVENUE_BASES.includes(value.revenueBasis)) addError(errors, "revenueBasis", "invalid_revenue_basis", `revenueBasis must be one of ${REVENUE_BASES.join(", ")}`);
  if (!REVENUE_MODEL_ROLES.includes(value.modelRole)) addError(errors, "modelRole", "invalid_model_role", `modelRole must be one of ${REVENUE_MODEL_ROLES.join(", ")}`);
  if (value.modelRole === "target" && (value.revenueBasis !== "settled_actual" || value.isFinal !== true)) {
    addError(errors, "modelRole", "estimated_revenue_not_target", "only final settled actual revenue may be used as a model target");
  }
  if (value.targetEligible !== (value.modelRole === "target" && value.revenueBasis === "settled_actual" && value.isFinal === true)) {
    addError(errors, "targetEligible", "inconsistent_target_eligibility", "targetEligible must reflect modelRole, revenueBasis, and isFinal");
  }
  if (!OBSERVATION_STATUSES.includes(value.status)) addError(errors, "status", "invalid_status", `status must be one of ${OBSERVATION_STATUSES.join(", ")}`);
  if (!/^[A-Z]{3}$/.test(value.currency || "")) addError(errors, "currency", "invalid_currency", "currency must be a three-letter code");
  for (const field of ["from", "to"]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.period?.[field] || "") || !isValidTemporal(value.period?.[field])) addError(errors, `period.${field}`, "invalid_date", `period.${field} must be an ISO date`);
  }
  if (isValidTemporal(value.period?.from) && isValidTemporal(value.period?.to) && parsedTime(value.period.from) > parsedTime(value.period.to)) {
    addError(errors, "period.to", "invalid_range", "period.to must not precede period.from");
  }
  if (!isValidTemporal(value.featureAsOf)) addError(errors, "featureAsOf", "invalid_time", "featureAsOf must be an ISO date or timestamp");
  if (isValidTemporal(value.featureAsOf) && isValidTemporal(value.period?.from) && parsedTime(value.featureAsOf) > parsedTime(value.period.from)) {
    addError(errors, "featureAsOf", "target_leakage", "featureAsOf must not be after the revenue target period begins");
  }
  if (value.featureWindow?.from && !isValidTemporal(value.featureWindow.from)) addError(errors, "featureWindow.from", "invalid_time", "featureWindow.from must be empty or an ISO date or timestamp");
  if (value.featureWindow?.to && !isValidTemporal(value.featureWindow.to)) addError(errors, "featureWindow.to", "invalid_time", "featureWindow.to must be empty or an ISO date or timestamp");
  if (value.featureWindow?.from && value.featureWindow?.to && parsedTime(value.featureWindow.from) > parsedTime(value.featureWindow.to)) addError(errors, "featureWindow.to", "invalid_range", "featureWindow.to must not precede featureWindow.from");
  if (value.featureWindow?.to && isValidTemporal(value.featureAsOf) && parsedTime(value.featureWindow.to) > parsedTime(value.featureAsOf)) {
    addError(errors, "featureWindow.to", "feature_leakage", "featureWindow.to must not be after featureAsOf");
  }
  if (value.targetComputedAt && !isValidTemporal(value.targetComputedAt)) addError(errors, "targetComputedAt", "invalid_time", "targetComputedAt must be empty or an ISO date or timestamp");
  if (value.modelRole === "target" && !isValidTemporal(value.targetComputedAt)) {
    addError(errors, "targetComputedAt", "required", "final target revenue requires targetComputedAt");
  }
  if (value.modelRole === "target" && isValidTemporal(value.targetComputedAt) && isValidTemporal(value.period?.to) && parsedTime(value.targetComputedAt) < parsedTime(value.period.to)) {
    addError(errors, "targetComputedAt", "target_not_final", "targetComputedAt must not precede the target period end");
  }

  if (value.status === "missing" && value.totalRevenue !== null) addError(errors, "totalRevenue", "missing_requires_null", "missing targets must have null totalRevenue");
  if (value.status === "zero" && value.totalRevenue !== 0) addError(errors, "totalRevenue", "zero_requires_numeric_zero", "zero targets must have totalRevenue 0");
  if (value.status !== "missing" && (!Number.isFinite(value.totalRevenue) || value.totalRevenue < 0)) addError(errors, "totalRevenue", "invalid_amount", "non-missing totalRevenue must be non-negative");

  const propertyCount = value.sample?.propertyCount;
  const propertyDays = value.sample?.propertyDays;
  const revenueObservationCount = value.sample?.revenueObservationCount;
  for (const [field, count] of [["propertyCount", propertyCount], ["propertyDays", propertyDays], ["revenueObservationCount", revenueObservationCount]]) {
    if (nonNegativeInteger(count) === null) addError(errors, `sample.${field}`, "invalid_count", `${field} must be a non-negative integer`);
  }
  if (value.status !== "missing" && !(propertyCount > 0)) addError(errors, "sample.propertyCount", "empty_sample", "non-missing targets require at least one property");
  if (value.status !== "missing" && !(propertyDays > 0)) addError(errors, "sample.propertyDays", "empty_sample", "non-missing targets require at least one property-day");
  if (value.status === "missing") {
    if (value.averageRevenuePerProperty !== null) addError(errors, "averageRevenuePerProperty", "missing_requires_null", "missing targets must have null averages");
    if (value.averageRevenuePerPropertyDay !== null) addError(errors, "averageRevenuePerPropertyDay", "missing_requires_null", "missing targets must have null averages");
  } else {
    const expectedPerProperty = value.totalRevenue / propertyCount;
    const expectedPerPropertyDay = value.totalRevenue / propertyDays;
    if (!Number.isFinite(value.averageRevenuePerProperty) || Math.abs(value.averageRevenuePerProperty - expectedPerProperty) > 1e-6) addError(errors, "averageRevenuePerProperty", "inconsistent_average", "averageRevenuePerProperty must equal totalRevenue / propertyCount");
    if (!Number.isFinite(value.averageRevenuePerPropertyDay) || Math.abs(value.averageRevenuePerPropertyDay - expectedPerPropertyDay) > 1e-6) addError(errors, "averageRevenuePerPropertyDay", "inconsistent_average", "averageRevenuePerPropertyDay must equal totalRevenue / propertyDays");
  }
  const coverage = value.sample?.coverage || {};
  if (nonNegativeInteger(coverage.numerator) === null || nonNegativeInteger(coverage.denominator) === null) {
    addError(errors, "sample.coverage", "invalid_count", "coverage numerator and denominator must be non-negative integers");
  } else if (coverage.numerator > coverage.denominator) {
    addError(errors, "sample.coverage", "numerator_exceeds_denominator", "coverage numerator must not exceed denominator");
  }
  validateRate(errors, "sample.coverage.ratio", coverage.ratio, value.status === "missing");
  if (coverage.denominator > 0 && coverage.ratio !== null && Math.abs(coverage.ratio - coverage.numerator / coverage.denominator) > 1e-9) addError(errors, "sample.coverage.ratio", "inconsistent_ratio", "coverage ratio must equal numerator / denominator");
  return validationResult(errors);
}

function buildRegionalRevenueTargetFrame(input = {}) {
  return buildValidated("regional_revenue_target", normalizeRegionalRevenueTargetFrame, validateRegionalRevenueTargetFrame, input);
}

function inferContractType(value = {}) {
  const declared = boundedText(value.contractType, 80).toLowerCase();
  if (declared) return declared;
  if (Object.prototype.hasOwnProperty.call(value, "leadTimeDays") || value.seriesKey) return "lead_time_observation";
  if (Object.prototype.hasOwnProperty.call(value, "featureAsOf") && (value.freshness || Object.prototype.hasOwnProperty.call(value, "missingRate"))) return "region_maintenance_feature";
  if (Object.prototype.hasOwnProperty.call(value, "totalRevenue") || value.targetKey === "regional_average_revenue") return "regional_revenue_target";
  return "observation";
}

function contractHandler(type) {
  const normalizedType = boundedText(type, 80).toLowerCase();
  const handlers = {
    observation: [normalizeObservation, validateObservation, buildObservation],
    lead_time_observation: [normalizeLeadTimeObservation, validateLeadTimeObservation, buildLeadTimeObservation],
    region_maintenance_feature: [normalizeMaintenanceFeatureFrame, validateMaintenanceFeatureFrame, buildMaintenanceFeatureFrame],
    regional_revenue_target: [normalizeRegionalRevenueTargetFrame, validateRegionalRevenueTargetFrame, buildRegionalRevenueTargetFrame]
  };
  return handlers[normalizedType] || null;
}

function dispatchInput(typeOrValue, maybeValue) {
  if (typeof typeOrValue === "string") return { type: typeOrValue, value: maybeValue || {} };
  return { type: inferContractType(typeOrValue || {}), value: typeOrValue || {} };
}

function normalize(typeOrValue, maybeValue) {
  const input = dispatchInput(typeOrValue, maybeValue);
  const handler = contractHandler(input.type);
  if (!handler) throw new TypeError(`Unknown location insight contract type: ${input.type}`);
  return handler[0](input.value);
}

function validate(typeOrValue, maybeValue) {
  const input = dispatchInput(typeOrValue, maybeValue);
  const handler = contractHandler(input.type);
  if (!handler) return validationResult([{ path: "contractType", code: "unknown_contract_type", message: `Unknown location insight contract type: ${input.type}` }]);
  return handler[1](input.value);
}

function build(typeOrValue, maybeValue) {
  const input = dispatchInput(typeOrValue, maybeValue);
  const handler = contractHandler(input.type);
  if (!handler) throw new TypeError(`Unknown location insight contract type: ${input.type}`);
  return handler[2](input.value);
}

module.exports = {
  CONFIDENCE_GRADES,
  CONTRACT_VERSIONS,
  ContractValidationError,
  OBSERVATION_ROLES,
  OBSERVATION_STATUSES,
  REVENUE_BASES,
  REVENUE_MODEL_ROLES,
  SOURCE_CATALOG,
  SOURCE_KEYS,
  build,
  buildLeadTimeObservation,
  buildMaintenanceFeatureFrame,
  buildObservation,
  buildRegionalRevenueTargetFrame,
  deepFreeze,
  fingerprintRequest,
  leadTimeBucketFor,
  normalize,
  normalizeLeadTimeObservation,
  normalizeMaintenanceFeatureFrame,
  normalizeObservation,
  normalizeRegionalRevenueTargetFrame,
  payloadHash,
  redactSensitiveUrl,
  validate,
  validateLeadTimeObservation,
  validateMaintenanceFeatureFrame,
  validateObservation,
  validateRegionalRevenueTargetFrame
};
