"use strict";

const net = require("node:net");
const path = require("node:path");

const V2_PREVIEW_SERVICE_NAME = "lodging-datalab-preview";
const V2_PREVIEW_HOSTNAME = "sa-labs-datalab-v4-preview.onrender.com";
const RENDER_DISK_ROOT = "/var/data";

const B2B_PUBLIC_TOP_LEVEL_FIELDS = new Set([
  "run",
  "stats",
  "datalabTrend",
  "demandStructure",
  "regions",
  "ranking",
  "availability",
  "platform",
  "companyPlatforms",
  "items"
]);

// This list deliberately describes data the B2B UI can display. A newly added
// server field is private until it is reviewed and added here.
const B2B_PUBLIC_NESTED_FIELDS = new Set([
  "id", "companyId", "companyProfile", "key", "label", "name", "title", "summary", "headline", "description", "note", "reason", "direction",
  "status", "statusLabel", "statusKey", "tone", "source", "sourceLabel", "sourceVersion", "configured", "collectable",
  "keyword", "keywordType", "searchMode", "searchModeLabel", "collectionMode", "collectionModeLabel", "collectionPurpose",
  "collectionPurposeLabel", "collectionProfile", "collectionProfileLabel", "collectionProfileNote", "collectionProfileFlags",
  "collectRegional", "collectOta", "collectBookingStock", "collectWeeklyRange",
  "collectionDbRoute", "targets", "appliesHistory", "appliesInventory", "appliesDemandLocation", "appliesMasterBasic",
  "detailRankRanges", "province", "provinceLabel", "mapBounds", "minLat", "maxLat", "minLon", "maxLon",
  "checkIn", "checkOut", "adults", "productMode", "productModeLabel", "bookingRangeDays", "bookingRangePlaceLimit", "counts",
  "completedAt", "endedAt", "createdAt", "startedAt", "updatedAt", "collectedAt", "requestedAt", "observedAt", "startDate",
  "endDate", "timeUnit", "month", "monthLabel", "period", "periodLabel", "season", "series", "ratio", "value", "score",
  "change", "metrics", "radar", "topSegments", "recommendedOperations", "contentKeywords", "risks", "priceStrategy",
  "interpretation", "aiSignals", "group", "priority", "operation", "caution", "message", "keywords", "frequency",
  "totalRegionalRows", "maxRegionCount", "avgPrice", "traffic", "keywordCount", "collectableCount", "monthlyPc",
  "monthlyMobile", "totalSearchVolume", "totalClicks", "combinedCtr", "datalabTrend", "cache", "hit", "policy",
  "observationCount", "firstCollectedAt", "lastCollectedAt", "lastUsedAt", "region", "regionKey", "regionLabel", "regions", "addresses", "primary",
  "secondary", "resources", "target", "lat", "lon", "count", "adCount", "dualCount", "organicCount", "averagePrice",
  "dominantPrice", "dominantType", "dominantAd", "trafficKeyword", "places", "rank", "category", "address", "location",
  "price", "roomName", "roomNamePreview", "roomNames", "type", "ad", "productTypeSummary", "nightItemCount", "dayUseItemCount",
  "countedItemCount", "availableRooms", "totalRooms", "availabilityRate", "nightAvailableStock", "nightTotalStock",
  "dayUseAvailableStock", "dayUseTotalStock", "inventoryScope", "inventoryMemo", "availabilityBasis", "searchKeyword",
  "searchCluster", "searchRegion", "addressRegion", "regionBoundaryStatus", "regionBoundaryLabel", "regionBoundaryDetail",
  "outsideSearchRegion", "overallRank", "regionalRank", "adRank", "rankingSource", "rankingSourceLabel", "bookingStatus",
  "naverCouponStatus", "naverCouponNames", "naverCouponChannel", "naverCouponDetail", "total", "inventoryLinkedCount",
  "hasInventory", "availabilityIndex", "inventoryRank", "regionalKeyword", "regionalCluster", "listType", "itemDetails",
  "weeklyProductDetails", "soldOutRooms", "soldOutRate", "rate", "basis", "availabilityUnit", "rawAvailableStock",
  "rawTotalStock", "groupedRoomCount", "weeklyDays", "weeklySummary", "weeklyAvgAvailable", "weeklyMinAvailable",
  "weeklySoldOutDays", "weeklyTotalSoldOut", "weeklyTotalStock", "weeklyBasisTotal", "weeklyOperatingTotal",
  "weeklyOperatingTotalDays", "weeklyStructuralBlockedTotal", "weeklyStockBasisType", "weeklyMinTotal", "weeklyMaxTotal",
  "weeklyMaxTotalDays", "weeklyTotalVarianceGap", "weeklyOfflineReservedTotal", "weeklyBasisRule", "weeklyRawStockVariance",
  "weeklyDetail", "weeklyAvgReservationRate", "weeklyReservationRateDetail", "weeklyEstimatedRevenue", "weeklyAdjustedRevenue",
  "weeklyMissingPriceEstimatedRevenue", "weeklyRevenuePrecisionRate", "weeklyPricedSoldOut", "weeklyMissingPriceSoldOut",
  "weeklyAvgSoldUnitPrice", "weeklyRevenueDetail", "weeklyRevenueByDayType", "weeklyOfflineReservationDetail",
  "dayUseWeeklyDays", "dayUseWeeklySummary", "dayUseWeeklyAvgAvailable", "dayUseWeeklyMinAvailable", "dayUseWeeklySoldOutDays",
  "dayUseWeeklyTotalSoldOut", "dayUseWeeklyTotalStock", "dayUseWeeklyBasisTotal", "dayUseWeeklyOperatingTotal",
  "dayUseWeeklyOperatingTotalDays", "dayUseWeeklyStructuralBlockedTotal", "dayUseWeeklyStockBasisType", "dayUseWeeklyMinTotal",
  "dayUseWeeklyMaxTotal", "dayUseWeeklyMaxTotalDays", "dayUseWeeklyTotalVarianceGap", "dayUseWeeklyOfflineReservedTotal",
  "dayUseWeeklyBasisRule", "dayUseWeeklyEstimatedRevenue", "dayUseWeeklyAdjustedRevenue", "dayUseWeeklyMissingPriceEstimatedRevenue",
  "dayUseWeeklyRevenuePrecisionRate", "dayUseWeeklyPricedSoldOut", "dayUseWeeklyMissingPriceSoldOut", "dayUseWeeklyAvgSoldUnitPrice",
  "dayUseWeeklyRevenueDetail", "dayUseWeeklyRevenueByDayType", "dayUseWeeklyOfflineReservationDetail", "dayUseWeeklyRawStockVariance",
  "dayUseWeeklyDetail", "dayUseWeeklyAvgReservationRate", "dayUseWeeklyReservationRateDetail", "basisLodgingRevenue",
  "basisLodgingAdjustedRevenue", "basisLodgingMissingPriceEstimatedRevenue", "basisLodgingRevenuePrecisionRate",
  "basisLodgingPricedSoldOut", "basisLodgingMissingPriceSoldOut", "basisLodgingAvgSoldUnitPrice", "basisDayUseRevenue",
  "basisDayUseAdjustedRevenue", "basisDayUseMissingPriceEstimatedRevenue", "basisDayUseRevenuePrecisionRate",
  "basisDayUsePricedSoldOut", "basisDayUseMissingPriceSoldOut", "basisDayUseAvgSoldUnitPrice", "inventoryConfidence",
  "inventoryStructure", "inventoryStructureType", "inventoryStructureLabel", "inventoryStructureTone", "inventoryStructureSummary",
  "inventoryStructureFlags", "inventoryStructureNotes", "inventoryStructureAction", "inventoryConfidenceGrade",
  "inventoryConfidenceLabel", "inventoryConfidenceScore", "inventoryConfidenceSummary", "inventoryConfidenceReasons", "inventoryAlerts",
  "checkedPlaces", "totalAvailableRooms", "totalSoldOutRooms", "totalRooms", "totalEstimatedRevenue",
  "totalAdjustedEstimatedRevenue", "totalMissingPriceEstimatedRevenue", "totalPricedSoldOut", "totalMissingPriceSoldOut",
  "revenuePrecisionRate", "avgSoldUnitPrice", "dayUseEstimatedRevenue", "dayUseAdjustedEstimatedRevenue",
  "dayUseMissingPriceEstimatedRevenue", "combinedEstimatedRevenue", "combinedAdjustedEstimatedRevenue", "averageEstimatedRevenue",
  "averageAdjustedEstimatedRevenue", "revenueSampleCount", "revenueCoverageRate", "weightedRate", "weightedSoldOutRate",
  "lowAvailabilityCount", "lowConfidenceCount", "stockVarianceCount", "dayUseMixedCount", "bookingIdReusedCount",
  "naverCouponVisibleCount", "platform", "ads", "organic", "manual", "failed", "other", "samples", "samplesByStatus",
  "coreRole", "inventoryNote", "roomCountStatus", "channelCountStatus", "naverSplitStatus", "adFlag", "bestRank", "platforms",
  "stock", "dayUseWeeklyStockText", "primaryName", "primaryCategoryKey", "primaryCategoryLabel", "categoryTags", "categoryLabels",
  "categoryConfidence", "categoryEvidenceSummary", "categoryKey", "categoryLabel", "confidence", "sourcePlatforms",
  "manualCategoryOverride", "duplicateReviewStatus", "companyName", "facilities", "facilityTags", "channels", "otaChannels",
  "roomCount", "naverPlaceUrl", "naverBookingUrl", "bookingUrl", "reservationUrl", "items", "stats", "sourcePlatformLabels",
  "sampleRegionCount",
  "productName", "productLabel", "saleType", "bizItemSubType", "bizItemId", "capacity", "quantity", "stock", "available",
  "bookingCount", "occupiedBookingCount", "date", "day", "unit", "amount", "segment", "collectionRunId",
  "collectionSource", "collectionStatus", "collectionPrecisionGrade", "collectionPrecisionLabel",
  "collectionPrecisionTone", "collectionPrecisionScore", "collectionPrecisionReasons", "collectionPrecisionWarnings",
  "collectionBasis", "verifiedCorrectionApplied", "verifiedLodgingBasisTotal", "verifiedDayUseBasisTotal",
  "verifiedCorrectionLabel", "verifiedCorrectionSource", "verifiedCorrectionNote", "verifiedCorrectionUpdatedAt",
  "verifiedRoomSegments", "manualAdjusted", "manualAdjustedAt", "roomSegments", "roomType", "weekdayPrice",
  "fridayPrice", "saturdayPrice", "sundayPrice"
]);

// Location metadata is intentionally scoped to a `location` object. Keeping
// these names out of the generic nested allowlist prevents a future object
// with a coincidentally named field from becoming public without review.
const B2B_PUBLIC_LOCATION_FIELDS = new Set([
  "status", "statusLabel", "source", "precision", "confidence", "crs",
  "lat", "lon", "resolvedAddress", "displayAddress", "geocodedAt"
]);

const B2B_PUBLIC_NUMERIC_MAP_FIELDS = new Set([
  "counts",
  "byCore",
  "byType",
  "byPrice",
  "byAd",
  "statusCounts",
  "confidenceCounts",
  "inventoryStructureCounts",
  "priceBuckets",
  "typeBuckets",
  "adBuckets"
]);

// Numeric summary maps are a special case: their keys are data rather than
// object-property names. Keep each map closed over the values produced by the
// current collectors so a future field (or a sensitive key hidden under a
// numeric value) is private until it is reviewed here.
const B2B_PUBLIC_NUMERIC_MAP_KEYS = new Map([
  ["counts", new Set([
    "total", "all", "unknown", "glamping", "campground", "caravan", "pension", "poolVilla", "privateStay",
    "naver", "nol", "ddnayo", "yeogi_manual", "tourism_public", "manual",
    "naverOverall", "naverAds", "naverRegional", "naverBookingStockChecked", "naverBookingStockSucceeded",
    "naverBookingStockSkippedByMode", "naverBookingStockSkippedByRank", "nolFirstPage", "nolRawFirstPage",
    "nolFilteredOut", "detailJsonFiles", "yeogiManual"
  ])],
  ["byCore", new Set(["복합형", "생활권·도심 수요형", "자연 관광자원형", "인접 관광 흡수형", "메인 관광지형"])],
  ["byType", new Set(["glamping", "campground", "caravan", "pension", "poolVilla", "privateStay", "unknown", "글램핑", "카라반", "캠핑장", "펜션형", "펜션형 글램핑", "풀빌라/리조트형", "키즈/가족형", "반려견 동반형", "확인필요"])],
  ["typeBuckets", new Set(["glamping", "campground", "caravan", "pension", "poolVilla", "privateStay", "unknown", "글램핑", "카라반", "캠핑장", "펜션형", "펜션형 글램핑", "풀빌라/리조트형", "키즈/가족형", "반려견 동반형", "확인필요"])],
  ["byPrice", new Set(["저가형", "중가형", "고가형", "프리미엄", "프리미엄형", "확인불가"])],
  ["priceBuckets", new Set(["저가형", "중가형", "고가형", "프리미엄", "프리미엄형", "확인불가"])],
  ["byAd", new Set(["광고 집행", "비광고 상위 노출", "광고+비광고 동시 노출", "확인불가"])],
  ["adBuckets", new Set(["광고 집행", "비광고 상위 노출", "광고+비광고 동시 노출", "확인불가"])],
  ["statusCounts", new Set(["광고", "비광고", "수동", "실패", "기타"])],
  ["confidenceCounts", new Set(["A", "B", "C", "D", "E", "unknown"])],
  ["inventoryStructureCounts", new Set(["객실별 노출형", "종류별 수량형", "묶음·범위형", "재고 합산형", "당일상품 중심", "구조 확인필요"])]
]);

const B2B_FORBIDDEN_PUBLIC_KEY = /(?:password|passphrase|token|cookie|headers?|authorization|secret|credential|session|sourcekey|memberid|filepath|filename|storagepath|configpath|internalpath|__proto__|prototype|constructor)/i;
const B2B_LOCAL_PATH_VALUE = /(?:^|[\s"'(])(?:[a-z]:[\\/]|\\\\|\/(?:var|home|users?|etc|proc|sys|run|tmp)(?:\/|$)|file:\/\/)/i;

function enabledFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}

function normalizedHostname(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isRenderRuntime(env = {}) {
  const renderFlag = String(env.RENDER || "").trim();
  const serviceName = String(env.RENDER_SERVICE_NAME || "").trim().toLowerCase();
  const externalHostname = normalizedHostname(env.RENDER_EXTERNAL_HOSTNAME || env.RENDER_EXTERNAL_URL);
  const exactPreviewIdentity = serviceName === V2_PREVIEW_SERVICE_NAME || externalHostname === V2_PREVIEW_HOSTNAME;
  // Render sets RENDER=true. Explicit false/0 alone must not turn a local
  // process into a proxy-trusting runtime. Exact Preview service/host metadata
  // is nevertheless authoritative so a contradictory flag cannot disable the
  // Preview startup boundary checks.
  if (exactPreviewIdentity) return true;
  if (renderFlag && !enabledFlag(renderFlag)) return false;
  return enabledFlag(renderFlag);
}

function isV2PreviewRuntime(env = {}) {
  if (!isRenderRuntime(env)) return false;
  const serviceName = String(env.RENDER_SERVICE_NAME || "").trim().toLowerCase();
  const externalHostname = normalizedHostname(env.RENDER_EXTERNAL_HOSTNAME || env.RENDER_EXTERNAL_URL);
  return serviceName === V2_PREVIEW_SERVICE_NAME || externalHostname === V2_PREVIEW_HOSTNAME;
}

function disabledFlag(value) {
  return /^(?:0|false|off)$/i.test(String(value || "").trim());
}

function assertV2PreviewRuntimeEnv(env = {}) {
  if (!isV2PreviewRuntime(env)) return { preview: false };

  const rawRoot = String(env.V2_PREVIEW_DATA_ROOT || "").trim().replace(/\\/g, "/");
  if (!rawRoot) throw new Error("Preview V2 requires V2_PREVIEW_DATA_ROOT");
  if (!path.posix.isAbsolute(rawRoot)) throw new Error("V2_PREVIEW_DATA_ROOT must be an absolute path");
  const resolvedRoot = path.posix.resolve(rawRoot);
  const relative = path.posix.relative(RENDER_DISK_ROOT, resolvedRoot);
  if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative)) {
    throw new Error("V2_PREVIEW_DATA_ROOT must be a dedicated child of /var/data");
  }

  const adminUser = String(env.GLAMPING_ADMIN_USER || "").trim();
  const adminPassword = String(env.GLAMPING_ADMIN_PASSWORD || "").trim();
  if (!adminUser || adminPassword.length < 12) {
    throw new Error("Preview V2 requires explicit GLAMPING_ADMIN_USER and a 12+ character GLAMPING_ADMIN_PASSWORD");
  }
  if (!disabledFlag(env.GLAMPING_B2B_ENABLED)) {
    throw new Error("Preview V2 requires GLAMPING_B2B_ENABLED=0");
  }

  return { preview: true, dataRoot: resolvedRoot };
}

function normalizeIpAddress(value = "") {
  let text = String(value || "").trim().replace(/^"|"$/g, "");
  if (!text) return "";

  const bracketed = text.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) text = bracketed[1];
  const ipv4WithPort = text.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort) text = ipv4WithPort[1];
  text = text.replace(/%.+$/, "").toLowerCase();

  const mappedIpv4 = text.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mappedIpv4 && net.isIP(mappedIpv4[1]) === 4) return mappedIpv4[1];
  const family = net.isIP(text);
  if (family === 4) return text;
  if (family !== 6) return "";

  try {
    return new URL(`http://[${text}]/`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return text;
  }
}

function trustedClientAddress(req = {}, options = {}) {
  const socketAddress = normalizeIpAddress(req.socket?.remoteAddress || "");
  if (options.isRenderRuntime === false) return socketAddress;
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  const renderFlag = String(env.RENDER || "").trim();
  const serviceName = String(env.RENDER_SERVICE_NAME || "").trim().toLowerCase();
  const externalHostname = normalizedHostname(env.RENDER_EXTERNAL_HOSTNAME || env.RENDER_EXTERNAL_URL);
  const exactPreviewIdentity = serviceName === V2_PREVIEW_SERVICE_NAME || externalHostname === V2_PREVIEW_HOSTNAME;
  const completeRenderIdentity = enabledFlag(env.RENDER)
    && Boolean(serviceName)
    && externalHostname.endsWith(".onrender.com");
  if (!exactPreviewIdentity && ((renderFlag && !enabledFlag(renderFlag)) || !completeRenderIdentity)) return socketAddress;

  // Conservative Render assumption: only after exact runtime metadata has
  // established the trusted proxy boundary do we use the last valid address
  // in Render's X-Forwarded-For chain. No unverified proprietary header is
  // invented, and an attacker-controlled first entry cannot change the key.
  const forwarded = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((entry) => normalizeIpAddress(entry))
    .filter(Boolean);
  return forwarded.at(-1) || socketAddress;
}

function projectB2BPublicValue(value, parentKey = "") {
  if (parentKey === "location") {
    if (value === null || ["number", "boolean"].includes(typeof value)) return value;
    if (typeof value === "string") return B2B_LOCAL_PATH_VALUE.test(value.trim()) ? undefined : value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const location = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (!B2B_PUBLIC_LOCATION_FIELDS.has(key) || B2B_FORBIDDEN_PUBLIC_KEY.test(key)) continue;
      if (entryValue === null || typeof entryValue === "boolean") {
        location[key] = entryValue;
      } else if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
        location[key] = entryValue;
      } else if (typeof entryValue === "string" && !B2B_LOCAL_PATH_VALUE.test(entryValue.trim())) {
        location[key] = entryValue;
      }
    }
    return location;
  }

  if (B2B_PUBLIC_NUMERIC_MAP_FIELDS.has(parentKey)) {
    const allowedKeys = B2B_PUBLIC_NUMERIC_MAP_KEYS.get(parentKey);
    if (!allowedKeys || !value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([key, entryValue]) => (
        allowedKeys.has(key)
        && !B2B_FORBIDDEN_PUBLIC_KEY.test(key)
        && typeof entryValue === "number"
        && Number.isFinite(entryValue)
      )));
  }

  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (typeof value === "string") return B2B_LOCAL_PATH_VALUE.test(value.trim()) ? undefined : value;
  if (Array.isArray(value)) {
    return value
      .map((item) => projectB2BPublicValue(item, parentKey))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;

  const projected = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (B2B_FORBIDDEN_PUBLIC_KEY.test(key)) continue;
    if (!B2B_PUBLIC_NESTED_FIELDS.has(key) && !B2B_PUBLIC_NUMERIC_MAP_FIELDS.has(key)) continue;
    const publicValue = projectB2BPublicValue(entryValue, key);
    if (publicValue !== undefined) projected[key] = publicValue;
  }
  return projected;
}

function projectB2BPublicPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const projected = {};
  for (const [key, value] of Object.entries(payload)) {
    if (B2B_FORBIDDEN_PUBLIC_KEY.test(key)) continue;
    if (!B2B_PUBLIC_TOP_LEVEL_FIELDS.has(key)) continue;
    const publicValue = projectB2BPublicValue(value, key);
    if (publicValue !== undefined) projected[key] = publicValue;
  }
  return projected;
}

module.exports = {
  RENDER_DISK_ROOT,
  V2_PREVIEW_HOSTNAME,
  V2_PREVIEW_SERVICE_NAME,
  assertV2PreviewRuntimeEnv,
  disabledFlag,
  isRenderRuntime,
  isV2PreviewRuntime,
  normalizeIpAddress,
  projectB2BPublicPayload,
  trustedClientAddress
};
