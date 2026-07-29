const crypto = require("node:crypto");

const PREVIEW_CONTRACT_VERSION = 1;
const COLLECTION_MODES = new Set([
  "fast_search",
  "detailed_search",
  "leadtime_observation",
  "ota_exposure"
]);

function text(value) {
  return String(value ?? "").trim();
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

function first(value) {
  return list(value).map(text).find(Boolean) || "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedName(value) {
  return text(value).toLowerCase().replace(/[^0-9a-z\uac00-\ud7a3]+/g, "");
}

function stableId(prefix, parts) {
  const digest = crypto.createHash("sha256").update(parts.map(text).join("|")).digest("hex").slice(0, 14);
  return `${prefix}_${digest}`;
}

function isoDate(value) {
  const candidate = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

function timestampFromRunId(runId) {
  const match = text(runId).match(/(\d{4})(\d{2})(\d{2})(?:_(\d{2})(\d{2})(\d{2}))?/);
  if (!match) return "";
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

function dateDiffDays(start, end) {
  const startTime = Date.parse(`${isoDate(start)}T00:00:00.000Z`);
  const endTime = Date.parse(`${isoDate(end)}T00:00:00.000Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return Math.round((endTime - startTime) / 86400000);
}

function identityKeyForCompany(company = {}) {
  const placeId = first(company.placeIds);
  if (placeId) return `naver_place:${placeId}`;
  const bookingId = first(company.bookingBusinessIds);
  if (bookingId) return `naver_booking:${bookingId}`;
  const name = normalizedName(company.primaryName || company.canonicalName);
  const region = normalizedName(first(company.regions) || company.region);
  return name ? `name_region:${name}:${region}` : "";
}

function automaticConfidenceForCompany(company = {}) {
  const explicit = text(
    company.inventoryConfidenceGrade
      || company.inventory?.latest?.inventoryConfidenceGrade
      || company.inventory?.latest?.confidenceGrade
  ).toUpperCase();
  if (/^[ABCD]$/.test(explicit)) return explicit;
  if ((first(company.placeIds) || first(company.bookingBusinessIds)) && first(company.addresses)) return "B";
  if (text(company.primaryName) && first(company.regions)) return "C";
  return "D";
}

function verifiedStatusForCompany(company = {}) {
  const reviewStatus = text(company.adminReview?.status).toLowerCase();
  if (["verified", "approved", "public_ready", "completed"].includes(reviewStatus)) return "verified";
  if (company.manualCorrection && Object.keys(company.manualCorrection).length) return "reviewed";
  return "unverified";
}

function projectCompanyRecord(company = {}, fallbackCompanyId = "") {
  const companyId = text(company.companyId || fallbackCompanyId);
  const placeId = first(company.placeIds);
  const bookingId = first(company.bookingBusinessIds);
  const bestRank = finiteNumber(company.bestRank ?? company.inventory?.latest?.rank);
  return {
    companyId,
    identityKey: identityKeyForCompany(company),
    canonicalName: text(company.primaryName || company.canonicalName),
    aliases: list(company.aliases).map(text).filter(Boolean),
    region: text(first(company.regions) || company.region),
    address: text(first(company.addresses) || company.address),
    category: text(company.category),
    externalIds: {
      ...(placeId ? { naverPlaceId: placeId } : {}),
      ...(bookingId ? { naverBookingId: bookingId } : {})
    },
    urls: list(company.urls).map(text).filter(Boolean),
    bestRank,
    firstSeenAt: text(company.firstSeenAt),
    lastSeenAt: text(company.lastSeenAt),
    sourceRunIds: list(company.runIds || company.sourceRunIds).map(text).filter(Boolean),
    autoConfidence: automaticConfidenceForCompany(company),
    verifiedStatus: verifiedStatusForCompany(company),
    b2bVisibility: text(company.b2bVisibility) || "eligible"
  };
}

function boundedLimit(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(maximum, Math.floor(number));
}

function projectCompanyMaster(master = {}, options = {}) {
  const sourceEntries = Object.entries(master.companies || {});
  const companyIdFilter = text(options.companyId);
  const limit = boundedLimit(options.limit, 300, 1000);
  const projected = sourceEntries
    .map(([companyId, company]) => projectCompanyRecord(company, companyId))
    .filter((company) => company.companyId)
    .filter((company) => !companyIdFilter || company.companyId === companyIdFilter)
    .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName, "ko") || a.companyId.localeCompare(b.companyId));
  const items = projected.slice(0, limit);
  return {
    version: PREVIEW_CONTRACT_VERSION,
    name: "company_master",
    updatedAt: master.updatedAt || null,
    projection: {
      contract: "rc_company_master_v1",
      mode: "read_only",
      source: "v2_company_master",
      sourceCompanyCount: sourceEntries.length,
      matchedCount: projected.length,
      returnedCount: items.length,
      truncated: projected.length > items.length
    },
    items
  };
}

function companyIndexes(master = {}) {
  const ids = new Set();
  const names = new Map();
  const setName = (name, companyId) => {
    const key = normalizedName(name);
    if (!key) return;
    const current = names.get(key);
    names.set(key, current && current !== companyId ? null : companyId);
  };
  for (const [key, company] of Object.entries(master.companies || {})) {
    const companyId = text(company.companyId || key);
    if (!companyId) continue;
    ids.add(companyId);
    setName(company.primaryName || company.canonicalName, companyId);
    for (const alias of list(company.aliases)) setName(alias, companyId);
  }
  return { ids, names };
}

function resolveCompanyId(candidate, name, indexes) {
  const companyId = text(candidate);
  if (companyId && indexes.ids.has(companyId)) return companyId;
  return indexes.names.get(normalizedName(name)) || "";
}

function normalizedCollectionMode(value, fallback) {
  const mode = text(value);
  return COLLECTION_MODES.has(mode) ? mode : fallback;
}

function collectionModeForHistory(row = {}) {
  const explicit = normalizedCollectionMode(row.collectionMode, "");
  if (explicit) return explicit;
  if (isoDate(row.stayDate || row.targetDate) && finiteNumber(row.leadTimeDays) !== null) return "leadtime_observation";
  if (["basic_db", "rank_probe", "demand_location"].includes(text(row.collectionPurpose))) return "fast_search";
  return "detailed_search";
}

function collectionModeForRun(item = {}, run = {}) {
  const explicit = normalizedCollectionMode(item.collectionMode, "");
  if (explicit) return explicit;
  const hasInventory = finiteNumber(item.totalRooms) !== null
    || finiteNumber(item.availableRooms) !== null
    || finiteNumber(item.reservationRate ?? item.weeklyAvgReservationRate ?? item.soldOutRate) !== null;
  if (hasInventory) return "detailed_search";
  return ["basic_db", "rank_probe", "demand_location"].includes(text(run.collectionPurpose))
    ? "fast_search"
    : "detailed_search";
}

function searchScopeFor(mode, run = {}) {
  if (mode === "leadtime_observation") return "property_date_product";
  if (mode === "ota_exposure") return "ota_channel_presence";
  if (text(run.searchMode) === "company") return "property";
  return text(run.province) && text(run.province) !== "local" ? "metro_category" : "region_category";
}

function channelFor(mode, candidate) {
  const channel = text(candidate);
  if (channel) return channel;
  if (mode === "ota_exposure") return "ota";
  if (["detailed_search", "leadtime_observation"].includes(mode)) return "naver_booking";
  return "naver_place";
}

function confidenceForObservation(source = {}) {
  const explicit = text(source.autoConfidence || source.inventoryConfidenceGrade).toUpperCase();
  if (/^[ABCD]$/.test(explicit)) return explicit;
  const total = finiteNumber(source.totalRooms ?? source.supply);
  if (text(source.url || source.sourceUrl) && total !== null && total > 0) return "C";
  return "D";
}

function createObservationRecord(source = {}, context = {}) {
  const companyId = text(context.companyId);
  const mode = normalizedCollectionMode(context.collectionMode, "fast_search");
  const observedAt = text(context.observedAt);
  const targetDate = isoDate(context.targetDate);
  const productKey = text(context.productKey) || "all";
  const channel = channelFor(mode, context.channel || source.channel);
  const totalRooms = finiteNumber(source.totalRooms ?? source.supply);
  const availableRooms = finiteNumber(source.availableRooms ?? source.available);
  const soldOutRooms = finiteNumber(source.soldOutRooms ?? source.sold);
  const reservationRate = finiteNumber(
    source.reservationRate
      ?? source.weeklyAvgReservationRate
      ?? source.soldOutRate
      ?? source.saleRate
  );
  const record = {
    companyId,
    source: text(context.source),
    runId: text(context.runId),
    observedAt,
    collectionMode: mode,
    searchScope: text(context.searchScope),
    channel,
    targetDate,
    leadTimeDays: finiteNumber(context.leadTimeDays) ?? dateDiffDays(observedAt, targetDate),
    productKey,
    checkIn: isoDate(context.checkIn),
    checkOut: isoDate(context.checkOut),
    productMode: text(context.productMode),
    province: text(context.province),
    provinceLabel: text(context.provinceLabel),
    region: text(source.region),
    rank: finiteNumber(source.rank),
    price: source.price ?? "",
    availableRooms,
    totalRooms,
    soldOutRooms,
    soldOutRate: finiteNumber(source.soldOutRate ?? source.saleRate),
    reservationRate,
    weeklyReservationRateDetail: text(source.weeklyReservationRateDetail),
    weeklyTotalSoldOut: finiteNumber(source.weeklyTotalSoldOut),
    weeklyTotalStock: finiteNumber(source.weeklyTotalStock),
    url: text(source.url || source.sourceUrl),
    autoConfidence: confidenceForObservation(source)
  };
  record.observationGroupKey = stableId("og", [companyId, mode, channel, targetDate, productKey]);
  record.observationId = text(context.observationId) || stableId("obs", [
    record.source,
    record.runId,
    companyId,
    mode,
    channel,
    targetDate,
    productKey,
    record.rank,
    record.url,
    record.price
  ]);
  return record;
}

function projectHistoryObservation(row, indexes) {
  const companyId = resolveCompanyId(row.companyId || row.companyKey, row.companyName, indexes);
  if (!companyId) return null;
  const collectionMode = collectionModeForHistory(row);
  const targetDate = isoDate(row.targetDate || row.stayDate);
  const observedAt = text(row.observedAt || row.collectedAt);
  return createObservationRecord(row, {
    companyId,
    source: "v2_history",
    runId: row.runId,
    observedAt,
    collectionMode,
    searchScope: text(row.searchScope) || searchScopeFor(collectionMode, row),
    channel: row.channel,
    targetDate,
    leadTimeDays: row.leadTimeDays,
    productKey: row.productKey || row.productType || row.productMode || "all",
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    productMode: row.productMode,
    province: row.province,
    provinceLabel: row.provinceLabel,
    observationId: row.observationId
  });
}

function projectRunObservation(item, runEntry, indexes) {
  const run = runEntry.run || {};
  const companyId = resolveCompanyId(item.companyId, item.name, indexes);
  if (!companyId) return null;
  const collectionMode = collectionModeForRun(item, run);
  const observedAt = text(runEntry.observedAt || run.updatedAt || run.createdAt || timestampFromRunId(run.id));
  const targetDate = isoDate(item.targetDate || run.checkIn);
  return createObservationRecord(item, {
    companyId,
    source: "v2_run_output",
    runId: run.id,
    observedAt,
    collectionMode,
    searchScope: text(item.searchScope) || searchScopeFor(collectionMode, run),
    channel: item.channel,
    targetDate,
    productKey: item.productKey || item.productMode || run.productMode || item.availabilityUnit || item.listType || "all",
    checkIn: run.checkIn,
    checkOut: run.checkOut,
    productMode: run.productMode,
    province: run.province,
    provinceLabel: run.provinceLabel
  });
}

function projectPropertyObservations(input = {}, options = {}) {
  const master = input.master || {};
  const indexes = companyIndexes(master);
  const historyRows = list(input.historyObservations);
  const runEntries = list(input.runEntries);
  const projected = [];
  let unresolvedHistoryCount = 0;
  let unresolvedRunCount = 0;

  for (const row of historyRows) {
    const record = projectHistoryObservation(row, indexes);
    if (record) projected.push(record);
    else unresolvedHistoryCount += 1;
  }
  for (const entry of runEntries) {
    const items = list(entry.availability?.items || entry.items);
    for (const item of items) {
      const record = projectRunObservation(item, entry, indexes);
      if (record) projected.push(record);
      else unresolvedRunCount += 1;
    }
  }

  const deduped = new Map();
  for (const record of projected) deduped.set(record.observationId, record);
  const companyId = text(options.companyId);
  const runId = text(options.runId);
  const collectionMode = text(options.collectionMode);
  const limit = boundedLimit(options.limit, 300, 2000);
  const matched = [...deduped.values()]
    .filter((record) => !companyId || record.companyId === companyId)
    .filter((record) => !runId || record.runId === runId)
    .filter((record) => !collectionMode || record.collectionMode === collectionMode)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.observationId.localeCompare(b.observationId));
  const items = matched.slice(0, limit);
  return {
    version: PREVIEW_CONTRACT_VERSION,
    name: "property_observations",
    updatedAt: items.map((item) => item.observedAt).filter(Boolean).sort().at(-1) || null,
    projection: {
      contract: "rc_property_observations_v1",
      mode: "read_only",
      sources: ["v2_history", "v2_run_output"],
      sourceHistoryCount: historyRows.length,
      sourceRunCount: runEntries.length,
      projectedCount: projected.length,
      deduplicatedCount: deduped.size,
      unresolvedHistoryCount,
      unresolvedRunCount,
      matchedCount: matched.length,
      returnedCount: items.length,
      truncated: matched.length > items.length
    },
    items
  };
}

module.exports = {
  PREVIEW_CONTRACT_VERSION,
  projectCompanyMaster,
  projectCompanyRecord,
  projectHistoryObservation,
  projectPropertyObservations,
  projectRunObservation
};
