"use strict";

const V2_MAP_COMPATIBILITY_SCHEMA_VERSION = "v2-map-compatibility.v1";
const V2_MAP_STRATEGY = "v2_legacy_4e4e190";
const MAX_OVERALL_RANK = 50;
const MAX_DETAIL_RANK = 3;
const CURRENT_MARKER_RANK_LIMIT = 20;
const SERVICE_LOCATION_BOUNDS = Object.freeze({ minLat: 32, maxLat: 39.5, minLon: 124, maxLon: 132 });

const LOCATION_STATUSES = new Set([
  "verified",
  "resolved",
  "approximate",
  "ambiguous",
  "not_found",
  "invalid",
  "pending",
  "error"
]);
const LOCATION_PRECISIONS = new Set(["rooftop", "parcel", "street", "locality", "region", "unknown"]);
const LOCATION_SOURCES = new Set(["manual", "provider", "legacy", "none"]);
const MAPPABLE_LOCATION_STATUSES = new Set(["verified", "resolved", "approximate"]);
const BOUNDARY_STATUSES = new Set(["same", "within", "parent", "outside", "unknown"]);
const PRIVATE_MAP_FIELDS = Object.freeze([
  "apiKey",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "headers",
  "providerKey",
  "rawBody",
  "rawHtml",
  "rawResponse",
  "secret"
]);
const LEGACY_COORDINATE_FIELDS = Object.freeze([
  "lat",
  "lon",
  "lng",
  "latitude",
  "longitude",
  "x",
  "y",
  "geo",
  "geocoding"
]);

function boundedText(value, max = 240) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function positiveInteger(value) {
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value.trim())) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizedPlaceId(value = {}) {
  const direct = value.placeId ?? value.place_id ?? value.naverPlaceId;
  const sourceKey = boundedText(value.sourceKey, 160);
  const candidate = direct ?? (/^place:(.+)$/i.exec(sourceKey)?.[1] || "");
  return boundedText(candidate, 120);
}

function normalizedRankingSource(value) {
  const source = boundedText(value, 40).toLowerCase();
  return source === "overall" || source === "naver_overall" ? "naver_overall" : "";
}

function normalizeCanonicalRegionContext(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const requestedStatus = boundedText(input.matchStatus, 32).toLowerCase();
  const regionKey = boundedText(input.regionKey, 120).toLowerCase();
  const validRegionKey = /^kr_[a-z0-9]+(?:_[a-z0-9]+)+$/.test(regionKey);
  const active = input.active !== false && requestedStatus !== "inactive";
  const matched = requestedStatus === "matched" && validRegionKey && active;
  const matchStatus = matched
    ? "matched"
    : requestedStatus === "ambiguous"
      ? "ambiguous"
      : !active
        ? "inactive"
        : "unmatched";

  return {
    matchStatus,
    matched,
    active: matched,
    regionKey: matched ? regionKey : "",
    sido: matched ? boundedText(input.sido, 80) : "",
    sigungu: matched ? boundedText(input.sigungu, 80) : "",
    displayLabel: matched ? boundedText(input.displayLabel || [input.sido, input.sigungu].filter(Boolean).join(" "), 160) : "",
    registryVersion: matched ? boundedText(input.registryVersion, 80) : ""
  };
}

function coordinatePair(latitude, longitude) {
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (
    latitude < SERVICE_LOCATION_BOUNDS.minLat
    || latitude > SERVICE_LOCATION_BOUNDS.maxLat
    || longitude < SERVICE_LOCATION_BOUNDS.minLon
    || longitude > SERVICE_LOCATION_BOUNDS.maxLon
  ) return null;
  return { lat: latitude, lon: longitude };
}

function locationStatusLabel(status) {
  return {
    verified: "검증 위치",
    resolved: "확인 위치",
    approximate: "근사 위치",
    ambiguous: "위치 검토 필요",
    not_found: "좌표 미수집",
    invalid: "좌표 오류",
    pending: "좌표 확인 대기",
    error: "좌표 확인 실패"
  }[status] || "좌표 확인 대기";
}

function rawLocationFromItem(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const companyLocation = value.companyProfile?.location;
  if (companyLocation && typeof companyLocation === "object" && !Array.isArray(companyLocation)) return companyLocation;
  if (value.location && typeof value.location === "object" && !Array.isArray(value.location)) return value.location;
  return null;
}

function normalizeMapLocation(value = null, options = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const fallbackAddress = boundedText(options.address, 240);
  if (!raw) {
    return {
      status: "not_found",
      statusLabel: locationStatusLabel("not_found"),
      lat: null,
      lon: null,
      crs: "EPSG:4326",
      precision: "unknown",
      source: "none",
      confidence: null,
      resolvedAddress: "",
      displayAddress: fallbackAddress,
      geocodedAt: ""
    };
  }

  const requestedStatus = boundedText(raw.status, 32).toLowerCase();
  const requestedSource = boundedText(raw.source, 32).toLowerCase();
  const precisionValue = boundedText(raw.precision, 32).toLowerCase();
  const source = LOCATION_SOURCES.has(requestedSource) ? requestedSource : "none";
  const precision = LOCATION_PRECISIONS.has(precisionValue) ? precisionValue : "unknown";
  const crs = boundedText(raw.crs || "EPSG:4326", 32).toUpperCase();
  const latitude = raw.latitude ?? raw.lat;
  const longitude = raw.longitude ?? raw.lon ?? raw.lng;
  const suppliedCoordinate = [latitude, longitude].some((entry) => entry !== null && entry !== undefined && entry !== "");
  const coordinate = crs === "EPSG:4326" ? coordinatePair(latitude, longitude) : null;
  let status = LOCATION_STATUSES.has(requestedStatus)
    ? requestedStatus
    : suppliedCoordinate
      ? "ambiguous"
      : "pending";

  if (suppliedCoordinate && !coordinate) status = "invalid";
  if (coordinate && status === "verified" && source !== "manual") status = "resolved";
  if (coordinate && MAPPABLE_LOCATION_STATUSES.has(status) && source === "none") status = "ambiguous";
  if (coordinate && status === "resolved") {
    status = ["rooftop", "parcel"].includes(precision)
      ? "resolved"
      : precision === "street"
        ? "approximate"
        : "ambiguous";
  }
  if (coordinate && status === "approximate" && !["rooftop", "parcel", "street"].includes(precision)) status = "ambiguous";
  if (!coordinate && MAPPABLE_LOCATION_STATUSES.has(status)) status = suppliedCoordinate ? "invalid" : "not_found";

  const mappable = Boolean(coordinate && MAPPABLE_LOCATION_STATUSES.has(status));
  const confidenceValue = raw.confidence;
  const confidence = typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : null;
  const resolvedAddress = boundedText(raw.resolvedAddress, 240);
  return {
    status,
    statusLabel: locationStatusLabel(status),
    lat: mappable ? coordinate.lat : null,
    lon: mappable ? coordinate.lon : null,
    crs: "EPSG:4326",
    precision,
    source,
    confidence,
    resolvedAddress,
    displayAddress: boundedText(raw.displayAddress || fallbackAddress || resolvedAddress, 240),
    geocodedAt: boundedText(raw.geocodedAt || raw.observedAt, 40)
  };
}

function isMapLocationMappable(location = {}) {
  return Boolean(
    location
    && MAPPABLE_LOCATION_STATUSES.has(location.status)
    && coordinatePair(location.lat, location.lon)
  );
}

function stripUnsafeMapFields(value = {}) {
  const next = { ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}) };
  for (const field of [...PRIVATE_MAP_FIELDS, ...LEGACY_COORDINATE_FIELDS]) delete next[field];
  if (next.companyProfile && typeof next.companyProfile === "object" && !Array.isArray(next.companyProfile)) {
    next.companyProfile = { ...next.companyProfile };
    for (const field of [...PRIVATE_MAP_FIELDS, "geo", "geocoding"]) delete next.companyProfile[field];
  }
  return next;
}

function safeBoundaryStatus(value) {
  const status = boundedText(value, 24).toLowerCase();
  return BOUNDARY_STATUSES.has(status) ? status : "unknown";
}

function normalizeMapItem(value = {}, overrides = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const next = stripUnsafeMapFields(input);
  const placeId = normalizedPlaceId({ ...input, ...overrides });
  const address = boundedText(overrides.address ?? input.address ?? input.companyProfile?.addresses?.[0], 320);
  const location = normalizeMapLocation(rawLocationFromItem(input), { address });
  const boundaryStatus = safeBoundaryStatus(overrides.regionBoundaryStatus ?? input.regionBoundaryStatus);
  next.placeId = placeId;
  next.place_id = placeId;
  next.name = boundedText(overrides.name ?? input.name ?? input.companyName, 240) || "업체명 확인";
  next.address = address;
  next.searchRegion = boundedText(overrides.searchRegion ?? input.searchRegion ?? input.searchCluster, 120);
  next.searchCluster = boundedText(overrides.searchCluster ?? input.searchCluster ?? input.searchRegion, 120);
  next.addressRegion = boundedText(overrides.addressRegion ?? input.addressRegion ?? input.region, 120);
  next.region = boundedText(overrides.region ?? input.region ?? input.addressRegion, 120);
  next.regionBoundaryStatus = boundaryStatus;
  next.regionBoundaryLabel = boundedText(overrides.regionBoundaryLabel ?? input.regionBoundaryLabel, 120);
  next.regionBoundaryDetail = boundedText(overrides.regionBoundaryDetail ?? input.regionBoundaryDetail, 320);
  next.outsideSearchRegion = boundaryStatus === "outside";
  next.location = location;
  if (next.companyProfile && typeof next.companyProfile === "object") next.companyProfile.location = location;
  return next;
}

function normalizeOverallRankingItems(rows = [], source = "") {
  if (normalizedRankingSource(source) !== "naver_overall") return [];
  const byPlaceId = new Map();
  for (const input of Array.isArray(rows) ? rows : []) {
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    if (input.rankingSource && normalizedRankingSource(input.rankingSource) !== "naver_overall") continue;
    const overallRank = positiveInteger(input.overallRank);
    const placeId = normalizedPlaceId(input);
    if (!overallRank || overallRank > MAX_OVERALL_RANK || !placeId) continue;
    const current = byPlaceId.get(placeId);
    if (current && current.overallRank <= overallRank) continue;
    const item = normalizeMapItem(input);
    byPlaceId.set(placeId, {
      ...item,
      overallRank,
      rank: overallRank,
      rankingSource: "naver_overall",
      rankingSourceLabel: "네이버 전체 순위",
      hasInventory: false,
      availabilityIndex: -1,
      inventoryRank: null
    });
  }
  return [...byPlaceId.values()]
    .sort((left, right) => left.overallRank - right.overallRank || left.placeId.localeCompare(right.placeId))
    .slice(0, MAX_OVERALL_RANK);
}

function uniqueDetailItems(rows = []) {
  const unique = new Map();
  const duplicates = new Set();
  for (const input of Array.isArray(rows) ? rows : []) {
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    const placeId = normalizedPlaceId(input);
    if (!placeId) continue;
    if (unique.has(placeId)) {
      duplicates.add(placeId);
      continue;
    }
    unique.set(placeId, input);
  }
  for (const placeId of duplicates) unique.delete(placeId);
  return unique;
}

function isCurrentMapMarkerEligible(item = {}) {
  const rank = positiveInteger(item.overallRank);
  return Boolean(
    rank
    && rank <= CURRENT_MARKER_RANK_LIMIT
    && normalizedRankingSource(item.rankingSource) === "naver_overall"
    && isMapLocationMappable(item.location)
  );
}

function normalizeV2MapCompatibility(value = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rankingInput = input.ranking && typeof input.ranking === "object" && !Array.isArray(input.ranking)
    ? input.ranking
    : {};
  const rankingRows = Array.isArray(rankingInput.items)
    ? rankingInput.items
    : Array.isArray(input.overallRankingItems)
      ? input.overallRankingItems
      : [];
  const detailRows = Array.isArray(input.availability?.items)
    ? input.availability.items
    : Array.isArray(input.detailItems)
      ? input.detailItems
      : [];
  const rankingSource = rankingInput.source ?? input.rankingSource;
  const regionContext = normalizeCanonicalRegionContext(input.regionContext);
  const rankingItems = normalizeOverallRankingItems(rankingRows, rankingSource);
  const detailByPlaceId = uniqueDetailItems(detailRows);
  const availabilityItems = [];

  const linkedRankingItems = rankingItems.map((rankingItem) => {
    const detail = rankingItem.overallRank <= MAX_DETAIL_RANK
      ? detailByPlaceId.get(rankingItem.placeId)
      : null;
    if (!detail) return rankingItem;
    const detailItem = normalizeMapItem(detail, {
      placeId: rankingItem.placeId,
      name: detail.name || rankingItem.name,
      address: detail.address || rankingItem.address,
      searchRegion: detail.searchRegion || rankingItem.searchRegion,
      searchCluster: detail.searchCluster || rankingItem.searchCluster,
      addressRegion: detail.addressRegion || rankingItem.addressRegion,
      region: detail.region || rankingItem.region,
      regionBoundaryStatus: detail.regionBoundaryStatus || rankingItem.regionBoundaryStatus,
      regionBoundaryLabel: detail.regionBoundaryLabel || rankingItem.regionBoundaryLabel,
      regionBoundaryDetail: detail.regionBoundaryDetail || rankingItem.regionBoundaryDetail
    });
    const linkedLocation = rawLocationFromItem(detail) ? detailItem.location : rankingItem.location;
    const linkedCompanyProfileSource = detailItem.companyProfile || rankingItem.companyProfile;
    const linkedCompanyProfile = linkedCompanyProfileSource && typeof linkedCompanyProfileSource === "object"
      ? { ...linkedCompanyProfileSource, location: linkedLocation }
      : null;
    const availabilityIndex = availabilityItems.length;
    availabilityItems.push({
      ...detailItem,
      ...(linkedCompanyProfile ? { companyProfile: linkedCompanyProfile } : {}),
      location: linkedLocation,
      rank: rankingItem.overallRank,
      overallRank: rankingItem.overallRank,
      rankingSource: "naver_overall",
      availabilityIndex,
      hasInventory: true
    });
    return {
      ...detailItem,
      ...rankingItem,
      ...(linkedCompanyProfile ? { companyProfile: linkedCompanyProfile } : {}),
      location: linkedLocation,
      hasInventory: true,
      availabilityIndex,
      inventoryRank: rankingItem.overallRank
    };
  });

  const overallSource = normalizedRankingSource(rankingSource);
  const markerCandidateCount = linkedRankingItems.filter(isCurrentMapMarkerEligible).length;
  const mappableCount = linkedRankingItems.filter((item) => isMapLocationMappable(item.location)).length;
  const status = !overallSource
    ? "blocked"
    : linkedRankingItems.length
      ? "ready"
      : "missing";
  return {
    schemaVersion: V2_MAP_COMPATIBILITY_SCHEMA_VERSION,
    strategy: V2_MAP_STRATEGY,
    status,
    blocker: !overallSource ? "ranking_source_not_overall" : "",
    regionContext,
    ranking: {
      source: overallSource,
      total: linkedRankingItems.length,
      inventoryLinkedCount: linkedRankingItems.filter((item) => item.hasInventory).length,
      items: linkedRankingItems
    },
    availability: {
      items: availabilityItems
    },
    mapCompatibility: {
      overallRankLimit: MAX_OVERALL_RANK,
      detailRankLimit: MAX_DETAIL_RANK,
      currentMarkerRankLimit: CURRENT_MARKER_RANK_LIMIT,
      exactRegionMatched: regionContext.matchStatus === "matched",
      markerCandidateCount,
      mappableCount,
      unresolvedLocationCount: linkedRankingItems.length - mappableCount,
      arbitraryRegionFallback: false,
      generatedCompanyCoordinates: false
    }
  };
}

function assertV2MapCompatibilityReady(value = {}) {
  const rankingItems = Array.isArray(value?.ranking?.items) ? value.ranking.items : [];
  const availabilityItems = Array.isArray(value?.availability?.items) ? value.availability.items : [];
  const seenPlaceIds = new Set();
  const completeRanking = rankingItems.length === MAX_OVERALL_RANK
    && Number(value?.ranking?.total) === MAX_OVERALL_RANK
    && rankingItems.every((item, index) => {
      const placeId = normalizedPlaceId(item);
      const valid = positiveInteger(item?.overallRank) === index + 1
        && normalizedRankingSource(item?.rankingSource) === "naver_overall"
        && Boolean(placeId)
        && !seenPlaceIds.has(placeId);
      if (placeId) seenPlaceIds.add(placeId);
      return valid;
    });
  const detailPlaceIds = availabilityItems.map((item) => normalizedPlaceId(item));
  const completeDetails = availabilityItems.length === MAX_DETAIL_RANK
    && Number(value?.ranking?.inventoryLinkedCount) === MAX_DETAIL_RANK
    && availabilityItems.every((item, index) => (
      positiveInteger(item?.overallRank) === index + 1
      && detailPlaceIds[index]
      && detailPlaceIds[index] === normalizedPlaceId(rankingItems[index])
      && rankingItems[index]?.hasInventory === true
      && positiveInteger(rankingItems[index]?.inventoryRank) === index + 1
      && Number(rankingItems[index]?.availabilityIndex) === index
    ));
  if (
    value?.status !== "ready"
    || value?.blocker
    || normalizedRankingSource(value?.ranking?.source) !== "naver_overall"
    || !completeRanking
    || !completeDetails
  ) {
    const error = new Error("V2 map compatibility projection failed closed");
    error.name = "V2MapCompatibilityError";
    error.code = "V2_MAP_COMPATIBILITY_RESULT_INVALID";
    error.statusCode = 502;
    throw error;
  }
  return value;
}

module.exports = {
  CURRENT_MARKER_RANK_LIMIT,
  MAX_DETAIL_RANK,
  MAX_OVERALL_RANK,
  SERVICE_LOCATION_BOUNDS,
  V2_MAP_COMPATIBILITY_SCHEMA_VERSION,
  V2_MAP_STRATEGY,
  assertV2MapCompatibilityReady,
  isCurrentMapMarkerEligible,
  isMapLocationMappable,
  normalizeCanonicalRegionContext,
  normalizeMapLocation,
  normalizeOverallRankingItems,
  normalizeV2MapCompatibility
};
