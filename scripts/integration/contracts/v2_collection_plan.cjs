"use strict";

// Bounded pure extraction of the canonical V2 crawlExecutionPlan,
// estimateCrawlCompletion, crawlTimingAdjustment and publicCrawlEstimate
// behavior. This module intentionally has no environment-variable, filesystem or
// network dependency; fresh run timing samples are explicit DTO inputs.

const PRODUCT_MODES = Object.freeze({ all: "전체", lodging: "숙박", campnic: "캠프닉" });
const COLLECTION_MODES = Object.freeze({ precision: "상세 확인", fast: "순위 확인" });
const COLLECTION_PURPOSES = Object.freeze({
  basic_db: "기본정보 수집",
  revenue_detail: "상세정보 수집",
  demand_location: "지역정보 수집"
});

function planError(message, code = "V2_COLLECTION_PLAN_INVALID") {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normalizeProductMode(value) {
  const text = String(value || "").trim();
  if (PRODUCT_MODES[text]) return text;
  if (text === "숙박") return "lodging";
  if (text === "캠프닉" || text === "데이유즈" || text.toLowerCase() === "dayuse") return "campnic";
  return "all";
}

function normalizeCollectionMode(value) {
  const text = String(value || "").trim();
  if (COLLECTION_MODES[text]) return text;
  if (["빠른 순위", "순위 확인"].includes(text) || text.toLowerCase() === "fast") return "fast";
  return "precision";
}

function normalizeCollectionPurpose(value) {
  const text = String(value || "").trim();
  if (COLLECTION_PURPOSES[text]) return text;
  if (/basic|master|db|기본/i.test(text)) return "basic_db";
  if (/demand|location|cluster|입지|수요/i.test(text)) return "demand_location";
  return "revenue_detail";
}

function executionProfile(purposeValue, modeValue) {
  const purpose = normalizeCollectionPurpose(purposeValue);
  const mode = normalizeCollectionMode(modeValue);
  if (mode === "fast") return {
    key: "fast_rank", collectRegional: false, collectOta: false, collectBookingStock: false, collectWeeklyRange: false
  };
  if (purpose === "basic_db") return {
    key: "basic_db_light", collectRegional: false, collectOta: false, collectBookingStock: true, collectWeeklyRange: false
  };
  if (purpose === "demand_location") return {
    key: "demand_location_signal", collectRegional: true, collectOta: false, collectBookingStock: true, collectWeeklyRange: false
  };
  return {
    key: "revenue_detail_deep", collectRegional: true, collectOta: true, collectBookingStock: true, collectWeeklyRange: true
  };
}

function purposeDefaultRange(value) {
  const purpose = normalizeCollectionPurpose(value);
  if (purpose === "basic_db") return "1-50";
  if (purpose === "demand_location") return "1-20";
  return "1-10";
}

function parseRankRanges(value, fallback = "1-10") {
  const text = String(value ?? "").trim();
  const source = (!text || /^(?:none|skip|없음)$/i.test(text)) ? fallback : text;
  if (!source || /^(?:none|skip|없음)$/i.test(source)) return [];
  if (/^(?:all|전체)$/i.test(source)) return [{ from: 1, to: 100 }];
  const ranges = [];
  for (const part of source.split(/[,\s]+/).filter(Boolean)) {
    const match = part.match(/^(\d{1,3})(?:\s*[-~]\s*(\d{1,3}))?$/);
    if (!match) continue;
    const left = Math.max(1, Math.min(100, Math.floor(Number(match[1]))));
    const right = Math.max(1, Math.min(100, Math.floor(Number(match[2] || match[1]))));
    ranges.push({ from: Math.min(left, right), to: Math.max(left, right) });
  }
  return ranges.length || !fallback || source === fallback ? ranges : parseRankRanges(fallback, "");
}

function rankRangeLabel(ranges) {
  return ranges.length
    ? ranges.map(({ from, to }) => from === to ? String(from) : `${from}-${to}`).join(",")
    : "없음";
}

function rankRangePlaceLimit(ranges) {
  const ranks = new Set();
  for (const range of ranges) {
    for (let rank = range.from; rank <= range.to; rank += 1) {
      ranks.add(rank);
      if (ranks.size >= 20) return 20;
    }
  }
  return ranks.size;
}

function requiredDate(value, label) {
  const text = String(value || "").trim();
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  const canonical = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || canonical !== text) {
    throw planError(`${label} must use YYYY-MM-DD`, "V2_COLLECTION_DATE_INVALID");
  }
  return text;
}

function dateDiffDays(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000);
}

function scaleStages(stages, targetSeconds) {
  const rows = stages.map((stage) => ({ ...stage, seconds: Math.max(4, Math.round(stage.seconds || 0)) }));
  const base = rows.reduce((sum, stage) => sum + stage.seconds, 0);
  const target = Math.max(rows.length * 4, Math.round(targetSeconds || base));
  const scaled = rows.map((stage) => ({ ...stage, seconds: Math.max(4, Math.round(stage.seconds / Math.max(1, base) * target)) }));
  scaled[scaled.length - 1].seconds += target - scaled.reduce((sum, stage) => sum + stage.seconds, 0);
  return scaled;
}

function timingAdjustment(modelSeconds, timingSamples = []) {
  const model = Math.max(1, Math.round(modelSeconds));
  const samples = timingSamples
    .filter((row) => row?.success === true && Number.isFinite(Number(row.durationSeconds)) && Number(row.durationSeconds) > 0)
    .slice(-12);
  if (!samples.length) return {
    source: "cold-start-model",
    sampleCount: 0,
    modelTotalSeconds: model,
    estimatedTotalSeconds: model,
    rangeSeconds: { minimum: Math.max(30, Math.round(model * 0.7)), maximum: Math.round(model * 1.6) }
  };
  const average = Math.round(samples.reduce((sum, row) => sum + Number(row.durationSeconds), 0) / samples.length);
  const blend = samples.length >= 3 ? 0.72 : samples.length === 2 ? 0.62 : 0.52;
  const estimate = Math.max(Math.round(model * 0.45), Math.min(Math.round(model * 2.6), Math.round(model * (1 - blend) + average * blend)));
  return {
    source: "fresh-run-samples",
    sampleCount: samples.length,
    modelTotalSeconds: model,
    averageSeconds: average,
    estimatedTotalSeconds: estimate,
    rangeSeconds: { minimum: Math.max(20, Math.round(estimate * 0.8)), maximum: Math.round(estimate * 1.25) }
  };
}

function createV2CollectionPlan(input = {}, options = {}) {
  const keyword = String(input.keyword || input.targetName || "").normalize("NFKC").trim().slice(0, 180);
  if (!keyword) throw planError("keyword is required", "V2_COLLECTION_KEYWORD_REQUIRED");
  const checkIn = requiredDate(input.checkIn || input.targetDate, "checkIn");
  const requestedCheckOut = input.checkOut || new Date(Date.parse(`${checkIn}T00:00:00.000Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  const checkOut = requiredDate(requestedCheckOut, "checkOut");
  const dayDifference = dateDiffDays(checkIn, checkOut);
  if (dayDifference < 0) throw planError("checkOut must not precede checkIn", "V2_COLLECTION_DATE_RANGE_INVALID");
  const bookingRangeDays = Math.max(1, Math.min(31, dayDifference > 1 ? dayDifference + 1 : 1));
  const productMode = normalizeProductMode(input.productMode);
  const collectionMode = normalizeCollectionMode(input.collectionMode);
  const collectionPurpose = normalizeCollectionPurpose(input.collectionPurpose);
  const profile = executionProfile(collectionPurpose, collectionMode);
  const ranges = collectionMode === "fast" ? [] : parseRankRanges(input.detailRankRanges, purposeDefaultRange(collectionPurpose));
  const detailPlaceLimit = collectionMode === "fast" ? 0 : (rankRangePlaceLimit(ranges) || 10);
  const requestedLimit = Number(input.bookingRangePlaceLimit);
  const bookingRangePlaceLimit = profile.collectWeeklyRange
    ? Math.max(0, Math.min(20, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : detailPlaceLimit))
    : 0;
  const rangeSeconds = profile.collectWeeklyRange
    ? bookingRangePlaceLimit * bookingRangeDays * (productMode === "all" ? 5.5 : 4.2)
    : 0;
  const stages = [
    { key: "discovery", label: "업체 검색", seconds: 95 },
    { key: "quick", label: "순위·기본정보", seconds: collectionPurpose === "demand_location" ? 55 : 25 },
    collectionMode === "fast"
      ? { key: "detail", label: "상세 생략", seconds: 6 }
      : { key: "detail", label: "상품·재고·가격", seconds: (productMode === "all" ? 45 : 26) + rangeSeconds },
    ...(collectionMode !== "fast" && (profile.collectOta || profile.collectRegional)
      ? [{ key: "ota", label: profile.collectOta ? "OTA·지역 신호" : "지역 신호", seconds: (profile.collectOta ? 35 : 0) + (profile.collectRegional ? 80 : 0) }]
      : []),
    { key: "finalize", label: "저장·분석", seconds: collectionMode === "fast" ? 18 : 35 }
  ];
  const modelSeconds = Math.max(collectionMode === "fast" ? 45 : 90, Math.round(stages.reduce((sum, stage) => sum + stage.seconds, 0)));
  const timing = timingAdjustment(modelSeconds, options.timingSamples || input.timingSamples || []);
  const targetCount = Math.max(1, Math.min(100, Math.floor(Number(input.targetCount || 1))));
  const requestEstimate = {
    discovery: targetCount,
    quick: targetCount,
    detail: profile.collectBookingStock ? targetCount * 10 : 0,
    leadtime: profile.collectWeeklyRange ? bookingRangePlaceLimit * bookingRangeDays : 0,
    ota: profile.collectOta ? targetCount * 2 : 0
  };
  requestEstimate.total = Object.values(requestEstimate).reduce((sum, value) => sum + value, 0);
  const now = Number(options.now ?? Date.now());
  return {
    contractVersion: "v2-collection-plan-v1",
    keyword,
    checkIn,
    checkOut,
    productMode,
    collectionMode,
    collectionPurpose,
    collectionProfile: profile.key,
    collectRegional: profile.collectRegional,
    collectOta: profile.collectOta,
    collectBookingStock: profile.collectBookingStock,
    collectWeeklyRange: profile.collectWeeklyRange,
    detailRankRanges: rankRangeLabel(ranges),
    detailPlaceLimit,
    bookingRangeDays,
    bookingRangePlaceLimit,
    targetCount,
    executionStages: [
      "discovery",
      "quick",
      ...(profile.collectBookingStock ? ["detail"] : []),
      ...(profile.collectOta ? ["ota"] : []),
      "finalize"
    ],
    requestEstimate,
    timing,
    estimatedTotalSeconds: timing.estimatedTotalSeconds,
    estimatedCompleteAt: new Date(now + timing.estimatedTotalSeconds * 1000).toISOString(),
    stages: scaleStages(stages, timing.estimatedTotalSeconds)
  };
}

module.exports = {
  COLLECTION_MODES,
  COLLECTION_PURPOSES,
  PRODUCT_MODES,
  createV2CollectionPlan,
  executionProfile,
  normalizeCollectionMode,
  normalizeCollectionPurpose,
  normalizeProductMode,
  parseRankRanges,
  rankRangePlaceLimit,
  timingAdjustment
};
