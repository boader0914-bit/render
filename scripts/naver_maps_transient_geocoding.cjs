"use strict";

const {
  MAPPABLE_LOCATION_STATUSES,
  geocodeAddress,
  normalizeAddress,
  publicCompanyLocationSummary
} = require("./lodging_geocoding_contract.cjs");
const {
  NAVER_MAPS_PROVIDER_KEY,
  TRANSIENT_DISPLAY_VERSION,
  createNaverMapsTransientGeocodingAdapter
} = require("./naver_maps_geocoding_adapter.cjs");

const MAX_TRANSIENT_BATCH = 25;
const DEFAULT_TRANSIENT_TIMEOUT_MS = 5000;

function serviceError(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function candidateItems(runData = {}) {
  const ranking = Array.isArray(runData?.ranking?.items) ? runData.ranking.items : [];
  if (ranking.length) return ranking;
  return Array.isArray(runData?.availability?.items) ? runData.availability.items : [];
}

function requestedIndexes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TRANSIENT_BATCH) {
    throw serviceError(
      "NAVER_GEOCODING_INVALID_BATCH",
      400,
      `NAVER map display lookup requires 1-${MAX_TRANSIENT_BATCH} item indexes`
    );
  }
  const rows = value.map((entry) => Number(entry));
  if (rows.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 9999)) {
    throw serviceError("NAVER_GEOCODING_INVALID_ITEM_INDEX", 400, "NAVER map display item index invalid");
  }
  if (new Set(rows).size !== rows.length) {
    throw serviceError("NAVER_GEOCODING_DUPLICATE_ITEM_INDEX", 400, "NAVER map display item indexes must be unique");
  }
  return rows;
}

function itemAddress(item = {}) {
  const candidates = [
    item.address,
    item.displayAddress,
    item.addressRegion,
    item.companyProfile?.address,
    ...(Array.isArray(item.companyProfile?.addresses) ? [...item.companyProfile.addresses].reverse() : []),
    ...(Array.isArray(item.addresses) ? [...item.addresses].reverse() : [])
  ];
  for (const candidate of candidates) {
    const address = normalizeAddress(candidate);
    if (address.normalizedAddress && address.specificity === "address") return address;
  }
  return null;
}

function isExistingMappable(location = {}) {
  return MAPPABLE_LOCATION_STATUSES.has(location.status)
    && typeof location.lat === "number"
    && Number.isFinite(location.lat)
    && typeof location.lon === "number"
    && Number.isFinite(location.lon);
}

function publicTransientLocation(location = {}) {
  const mappable = ["verified", "resolved", "approximate"].includes(location.status)
    && typeof location.latitude === "number"
    && Number.isFinite(location.latitude)
    && typeof location.longitude === "number"
    && Number.isFinite(location.longitude);
  return Object.freeze({
    status: String(location.status || "error"),
    lat: mappable ? location.latitude : null,
    lon: mappable ? location.longitude : null,
    crs: "EPSG:4326",
    precision: String(location.precision || "unknown"),
    source: mappable ? "naver-transient" : "none",
    providerKey: mappable ? NAVER_MAPS_PROVIDER_KEY : "",
    errorCode: String(location.errorCode || ""),
    transient: true,
    cacheable: false,
    persistable: false
  });
}

function existingLocationResult(itemIndex, location) {
  return Object.freeze({
    itemIndex,
    location: Object.freeze({
      status: location.status,
      lat: location.lat,
      lon: location.lon,
      crs: "EPSG:4326",
      precision: location.precision || "unknown",
      source: location.source || "legacy",
      providerKey: location.providerKey || "",
      transient: false,
      cacheable: false,
      persistable: true
    }),
    providerCall: false
  });
}

function createNaverMapsTransientGeocodingService(options = {}) {
  const adapter = options.adapter || createNaverMapsTransientGeocodingAdapter(options);
  const timeoutMs = Math.max(
    100,
    Math.min(30000, Number(options.timeoutMs) || DEFAULT_TRANSIENT_TIMEOUT_MS)
  );

  const configuration = () => Object.freeze({
    ...adapter.configuration(),
    maxBatchSize: MAX_TRANSIENT_BATCH,
    storage: "none",
    browserCache: "forbidden"
  });

  const resolveRunItemsForDisplay = async ({ runData, itemIndexes, signal } = {}) => {
    if (!adapter.enabled) {
      throw serviceError("NAVER_GEOCODING_DISABLED", 503, "NAVER map display lookup is disabled");
    }
    const indexes = requestedIndexes(itemIndexes);
    const items = candidateItems(runData);
    if (!items.length) {
      throw serviceError("NAVER_GEOCODING_RUN_ITEMS_MISSING", 404, "NAVER map display source items not found");
    }

    const results = [];
    let providerCalls = 0;
    for (const itemIndex of indexes) {
      const item = items[itemIndex];
      if (!item || typeof item !== "object") {
        results.push(Object.freeze({
          itemIndex,
          location: publicTransientLocation({ status: "invalid" }),
          providerCall: false
        }));
        continue;
      }

      const existing = publicCompanyLocationSummary(item);
      if (isExistingMappable(existing)) {
        results.push(existingLocationResult(itemIndex, existing));
        continue;
      }

      const address = itemAddress(item);
      if (!address) {
        results.push(Object.freeze({
          itemIndex,
          location: publicTransientLocation({ status: "invalid" }),
          providerCall: false
        }));
        continue;
      }

      providerCalls += 1;
      const location = await geocodeAddress({
        originalAddress: address.originalAddress,
        requestId: `display-${itemIndex}`
      }, {
        enabled: true,
        adapter,
        timeoutMs,
        signal
      });
      results.push(Object.freeze({
        itemIndex,
        location: publicTransientLocation(location),
        providerCall: true
      }));
    }

    return Object.freeze({
      version: TRANSIENT_DISPLAY_VERSION,
      usage: "single-display",
      cacheable: false,
      persistable: false,
      providerKey: NAVER_MAPS_PROVIDER_KEY,
      providerCalls,
      items: Object.freeze(results)
    });
  };

  return Object.freeze({
    enabled: adapter.enabled,
    configuration,
    resolveRunItemsForDisplay
  });
}

module.exports = {
  DEFAULT_TRANSIENT_TIMEOUT_MS,
  MAX_TRANSIENT_BATCH,
  candidateItems,
  createNaverMapsTransientGeocodingService,
  itemAddress,
  publicTransientLocation,
  requestedIndexes
};
