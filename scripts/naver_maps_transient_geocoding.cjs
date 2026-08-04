"use strict";

const {
  MAPPABLE_LOCATION_STATUSES,
  geocodeAddress,
  normalizeAddress,
  publicCompanyLocationSummary
} = require("./lodging_geocoding_contract.cjs");
const {
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

function displayLocationProjection(location = {}) {
  const latitude = typeof location.latitude === "number" ? location.latitude : location.lat;
  const longitude = typeof location.longitude === "number" ? location.longitude : location.lon;
  const hasCoordinatePair = Number.isFinite(latitude) && Number.isFinite(longitude);
  const requestedStatus = String(location.status || (hasCoordinatePair ? "resolved" : "invalid")).trim().toLowerCase();
  const precision = String(location.precision || "unknown").trim().toLowerCase();
  let status = requestedStatus;
  if (!hasCoordinatePair && MAPPABLE_LOCATION_STATUSES.has(status)) {
    status = "invalid";
  } else if (hasCoordinatePair && status === "resolved") {
    status = ["rooftop", "parcel"].includes(precision)
      ? "resolved"
      : precision === "street"
        ? "approximate"
        : "ambiguous";
  } else if (hasCoordinatePair && status === "approximate" && !["rooftop", "parcel", "street"].includes(precision)) {
    status = "ambiguous";
  }
  const mappable = hasCoordinatePair && MAPPABLE_LOCATION_STATUSES.has(status);
  return Object.freeze({
    status,
    lat: mappable ? latitude : null,
    lon: mappable ? longitude : null,
    precision,
    mappable
  });
}

function isExistingMappable(location = {}) {
  return displayLocationProjection(location).mappable;
}

function publicTransientLocation(location = {}) {
  const projection = displayLocationProjection(location);
  return Object.freeze({
    status: projection.status || "error",
    lat: projection.lat,
    lon: projection.lon,
    crs: "EPSG:4326",
    precision: projection.precision,
    source: projection.mappable ? "naver-transient" : "none",
    errorCode: String(location.errorCode || ""),
    transient: true,
    cacheable: false,
    persistable: false
  });
}

function existingLocationResult(itemIndex, location) {
  const projection = displayLocationProjection(location);
  return Object.freeze({
    itemIndex,
    location: Object.freeze({
      status: projection.status,
      lat: projection.lat,
      lon: projection.lon,
      crs: "EPSG:4326",
      precision: projection.precision,
      source: location.source || "legacy",
      transient: false,
      cacheable: false,
      persistable: true
    })
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
    for (const itemIndex of indexes) {
      const item = items[itemIndex];
      if (!item || typeof item !== "object") {
        results.push(Object.freeze({
          itemIndex,
          location: publicTransientLocation({ status: "invalid" })
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
          location: publicTransientLocation({ status: "invalid" })
        }));
        continue;
      }

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
        location: publicTransientLocation(location)
      }));
    }

    return Object.freeze({
      version: TRANSIENT_DISPLAY_VERSION,
      usage: "single-display",
      cacheable: false,
      persistable: false,
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
