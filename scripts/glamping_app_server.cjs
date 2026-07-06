const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const yeogiImportParser = require("./yeogi_import_parser.cjs");

const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const REPO_OUTPUTS_DIR = path.join(ROOT, "outputs");
const RENDER_DISK_DIR = "/var/data";
const IS_RENDER_RUNTIME = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
const HAS_RENDER_DISK = IS_RENDER_RUNTIME && fs.existsSync(RENDER_DISK_DIR);
const isTmpDataPath = (value) => /^\/tmp(?:\/|$)/.test(String(value || "").replace(/\\/g, "/"));
const DATA_DIR = path.resolve(
  HAS_RENDER_DISK && (!process.env.DATA_DIR || isTmpDataPath(process.env.DATA_DIR))
    ? RENDER_DISK_DIR
    : (process.env.DATA_DIR || ROOT)
);
const OUTPUTS_DIR = path.resolve(
  HAS_RENDER_DISK && (!process.env.OUTPUTS_DIR || isTmpDataPath(process.env.OUTPUTS_DIR))
    ? path.join(DATA_DIR, "outputs")
    : (process.env.OUTPUTS_DIR || path.join(DATA_DIR, "outputs"))
);
const CONFIG_DIR = path.resolve(
  HAS_RENDER_DISK && (!process.env.CONFIG_DIR || isTmpDataPath(process.env.CONFIG_DIR))
    ? path.join(DATA_DIR, "config")
    : (process.env.CONFIG_DIR || path.join(DATA_DIR, "config"))
);
const CUSTOMER_DB_DIR = path.join(DATA_DIR, "customer_db");
// Stable API key storage policy: releases may replace code, but must keep this file path.
const TRAFFIC_KEYS_FILE = path.join(CONFIG_DIR, "traffic_api_keys.local.json");
const LOCATION_CARD_REQUESTS_FILE = path.join(CONFIG_DIR, "location_card_requests.json");
const LEGACY_B2B_MEMBERS_FILE = path.join(CONFIG_DIR, "b2b_members.json");
const B2B_MEMBERS_FILE = path.join(CUSTOMER_DB_DIR, "b2b_members.json");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const HISTORY_OBSERVATIONS_FILE = path.join(HISTORY_DIR, "observations.jsonl");
const HISTORY_DATALAB_TRENDS_FILE = path.join(HISTORY_DIR, "datalab_trends.json");
const HISTORY_CRAWL_TIMINGS_FILE = path.join(HISTORY_DIR, "crawl_timings.json");
const LEGACY_B2B_SEARCH_HISTORY_FILE = path.join(HISTORY_DIR, "b2b_search_history.json");
const B2B_SEARCH_HISTORY_FILE = path.join(CUSTOMER_DB_DIR, "b2b_search_history.json");
const COMPANY_MASTER_DIR = path.join(DATA_DIR, "company_master");
const COMPANY_MASTER_FILE = path.join(COMPANY_MASTER_DIR, "companies.json");
const TERMS_VERSION = "2026-07-06";
const PRIVACY_VERSION = "2026-07-06";
const SERVICE_OPERATOR_NAME = String(process.env.GLAMPING_OPERATOR_NAME || "글램핑데이터랩").trim();
const PRIVACY_CONTACT_EMAIL = String(process.env.GLAMPING_PRIVACY_EMAIL || "").trim();
const DATALAB_TREND_CACHE_POLICY = "same_keyword_same_date";
const CRAWL_TIMING_MAX_ENTRIES = 240;
const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || (IS_RENDER_RUNTIME ? "0.0.0.0" : "127.0.0.1");
const IS_PRODUCTION_RUNTIME = process.env.NODE_ENV === "production" || IS_RENDER_RUNTIME;
const ADMIN_USERNAME = String(process.env.GLAMPING_ADMIN_USER || process.env.ADMIN_USER || "admin").trim();
const ADMIN_PASSWORD = String(process.env.GLAMPING_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "0914").trim();
const B2B_USERNAME = String(process.env.GLAMPING_B2B_USER || process.env.B2B_USER || "b2b").trim();
const B2B_PASSWORD = String(process.env.GLAMPING_B2B_PASSWORD || process.env.B2B_PASSWORD || "0914").trim();
const B2B_ENABLED = !/^(0|false|off)$/i.test(String(process.env.GLAMPING_B2B_ENABLED || "1").trim())
  && Boolean(B2B_USERNAME && B2B_PASSWORD);
const SESSION_COOKIE_NAME = "glamping_datalab_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PASSWORD_HASH_ITERATIONS = 120000;
const USER_ROLES = {
  admin: "admin",
  b2b: "b2b"
};
const sessions = new Map();
let activeCrawlPromise = null;
let activeCrawlStartedAt = null;
let activeCrawlEstimate = null;
const DEFAULT_NODE_MODULES = path.join(
  process.env.USERPROFILE || "C:\\Users\\User",
  ".cache",
  "codex-runtimes",
  "codex-primary-runtime",
  "dependencies",
  "node",
  "node_modules"
);
const PRODUCT_MODES = {
  all: "전체",
  lodging: "숙박",
  campnic: "캠프닉"
};
const SEARCH_MODES = {
  keyword: "키워드/권역",
  company: "업체명"
};
const COLLECTION_MODES = {
  precision: "정밀 분석",
  fast: "빠른 순위"
};

function kstDate(offsetDays = 0) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  kst.setUTCDate(kst.getUTCDate() + offsetDays);
  return kst.toISOString().slice(0, 10);
}

function normalizeProductMode(value) {
  const text = String(value || "").trim();
  if (PRODUCT_MODES[text]) return text;
  if (text === "숙박") return "lodging";
  if (text === "캠프닉" || text === "데이유즈" || text.toLowerCase() === "dayuse") return "campnic";
  return "all";
}

function normalizeSearchMode(value) {
  const text = String(value || "").trim();
  if (SEARCH_MODES[text]) return text;
  if (text === "업체명" || text.toLowerCase() === "company") return "company";
  return "keyword";
}

function normalizeCollectionMode(value) {
  const text = String(value || "").trim();
  if (COLLECTION_MODES[text]) return text;
  if (text === "빠른 순위" || text.toLowerCase() === "fast") return "fast";
  return "precision";
}

function parseRankRanges(value, fallback = "1-20") {
  const text = String(value ?? "").trim();
  const source = (!text || /^(none|skip|없음)$/i.test(text)) ? fallback : text;
  if (!source || /^(none|skip|없음)$/i.test(source)) return [];
  if (/^(all|전체)$/i.test(source)) return [{ from: 1, to: 50 }];
  const ranges = [];
  for (const part of source.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)) {
    const match = part.match(/^(\d{1,3})(?:\s*[-~]\s*(\d{1,3}))?$/);
    if (!match) continue;
    const left = Math.max(1, Math.min(50, Math.floor(Number(match[1]))));
    const right = Math.max(1, Math.min(50, Math.floor(Number(match[2] || match[1]))));
    if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
    ranges.push({ from: Math.min(left, right), to: Math.max(left, right) });
  }
  return ranges.length || !fallback || source === fallback ? ranges : parseRankRanges(fallback, "");
}

function rankRangeLabel(ranges = []) {
  return ranges.length
    ? ranges.map((range) => (range.from === range.to ? `${range.from}` : `${range.from}-${range.to}`)).join(",")
    : "없음";
}

const REGIONAL_GLAMPING_BASES = new Set([
  "\uACBD\uB0A8", "\uACBD\uC0C1\uB0A8\uB3C4", "\uACBD\uB0A8\uB3C4",
  "\uACBD\uBD81", "\uACBD\uC0C1\uBD81\uB3C4", "\uACBD\uBD81\uB3C4",
  "\uACBD\uAE30", "\uACBD\uAE30\uB3C4", "\uACBD\uAE30\uBD81\uBD80", "\uACBD\uAE30\uB0A8\uBD80", "\uC218\uB3C4\uAD8C", "\uC11C\uC6B8\uADFC\uAD50",
  "\uAC15\uC6D0", "\uAC15\uC6D0\uB3C4", "\uCD98\uCC9C", "\uC6D0\uC8FC", "\uAC15\uB989", "\uB3D9\uD574", "\uD0DC\uBC31", "\uC18D\uCD08", "\uC0BC\uCC99", "\uD64D\uCC9C", "\uD6A1\uC131", "\uC601\uC6D4", "\uD3C9\uCC3D", "\uC815\uC120", "\uCCA0\uC6D0", "\uD654\uCC9C", "\uC591\uAD6C", "\uC778\uC81C", "\uACE0\uC131", "\uC591\uC591",
  "\uC81C\uC8FC", "\uC81C\uC8FC\uB3C4",
  "\uC804\uBD81", "\uC804\uB77C\uBD81\uB3C4", "\uC804\uBD81\uD2B9\uBCC4\uC790\uCE58\uB3C4",
  "\uC804\uB0A8", "\uC804\uB77C\uB0A8\uB3C4",
  "\uCDA9\uB0A8", "\uCDA9\uCCAD\uB0A8\uB3C4", "\uCDA9\uBD81", "\uCDA9\uCCAD\uBD81\uB3C4",
  "\uC11C\uC6B8", "\uBD80\uC0B0", "\uB300\uAD6C", "\uC778\uCC9C", "\uAD11\uC8FC", "\uB300\uC804", "\uC6B8\uC0B0", "\uC138\uC885",
  "\uD3EC\uCC9C", "\uAC00\uD3C9", "\uC591\uD3C9", "\uC5F0\uCC9C", "\uD30C\uC8FC", "\uAE40\uD3EC", "\uAC15\uD654", "\uB0A8\uC591\uC8FC", "\uC591\uC8FC", "\uC758\uC815\uBD80",
  "\uC548\uC131", "\uC774\uCC9C", "\uC6A9\uC778", "\uC5EC\uC8FC", "\uD3C9\uD0DD", "\uD654\uC131", "\uC624\uC0B0", "\uAD11\uC8FC",
  "\uC9C4\uC8FC", "\uC0AC\uCC9C", "\uC0B0\uCCAD", "\uB0A8\uD574", "\uD558\uB3D9", "\uD569\uCC9C", "\uAC70\uCC3D", "\uD568\uC591", "\uBC00\uC591", "\uAE40\uD574", "\uC591\uC0B0", "\uAC70\uC81C", "\uD1B5\uC601", "\uACE0\uC131", "\uCC3D\uB155", "\uD568\uC548", "\uC758\uB839", "\uCC3D\uC6D0",
  "\uACBD\uC8FC", "\uD3EC\uD56D", "\uC548\uB3D9", "\uC601\uCC9C", "\uBB38\uACBD", "\uCCAD\uB3C4", "\uC131\uC8FC", "\uCE60\uACE1", "\uAE40\uCC9C", "\uAD6C\uBBF8", "\uC601\uC8FC", "\uC0C1\uC8FC", "\uC601\uB355", "\uC6B8\uC9C4",
  "\uC804\uC8FC", "\uC644\uC8FC", "\uAD70\uC0B0", "\uC775\uC0B0", "\uBB34\uC8FC", "\uC9C4\uC548", "\uC7A5\uC218", "\uB0A8\uC6D0", "\uC784\uC2E4", "\uC21C\uCC3D", "\uACE0\uCC3D", "\uBD80\uC548", "\uC815\uC74D",
  "\uCC9C\uC548", "\uC544\uC0B0", "\uACF5\uC8FC", "\uBCF4\uB839", "\uC11C\uC0B0", "\uB2F9\uC9C4", "\uBD80\uC5EC", "\uC608\uC0B0", "\uD64D\uC131", "\uD0DC\uC548",
  "\uCCAD\uC8FC", "\uCDA9\uC8FC", "\uC81C\uCC9C", "\uB2E8\uC591", "\uAD34\uC0B0", "\uBCF4\uC740", "\uC625\uCC9C", "\uC601\uB3D9"
]);

function looksLikeRegionalGlampingKeyword(value) {
  const compact = compactKeyword(value).normalize("NFKC");
  const glamping = "\uAE00\uB7A8\uD551";
  if (!compact.endsWith(glamping)) return false;
  const base = compact.slice(0, -glamping.length);
  if (!base || base.length > 10) return false;
  const withoutAdminSuffix = base.replace(/(\uD2B9\uBCC4\uC790\uCE58\uB3C4|\uAD11\uC5ED\uC2DC|\uD2B9\uBCC4\uC2DC|\uD2B9\uBCC4\uC790\uCE58\uC2DC|\uC790\uCE58\uB3C4|\uC790\uCE58\uC2DC|\uC2DC|\uAD70|\uAD6C|\uB3C4)$/u, "");
  return REGIONAL_GLAMPING_BASES.has(base) || REGIONAL_GLAMPING_BASES.has(withoutAdminSuffix);
}

function resolveSearchModeForCrawl(keyword, value) {
  const mode = normalizeSearchMode(value);
  return mode === "company" && looksLikeRegionalGlampingKeyword(keyword) ? "keyword" : mode;
}

function crawlExecutionPlan(payload = {}) {
  const keyword = String(payload.keyword || "").trim();
  const checkIn = payload.checkIn || process.env.CHECK_IN || kstDate(0);
  const checkOut = payload.checkOut || process.env.CHECK_OUT || kstDate(6);
  const rawBookingDays = Number(
    payload.bookingDays ||
    payload.bookingRangeDays ||
    bookingDaysFromRange(checkIn, checkOut) ||
    process.env.BOOKING_RANGE_DAYS ||
    7
  );
  const bookingRangeDays = Math.max(1, Math.min(31, Math.round(Number.isFinite(rawBookingDays) ? rawBookingDays : 7)));
  const bookingRangePlaceLimit = resolveBookingRangePlaceLimit(
    payload.bookingRangePlaceLimit ?? process.env.BOOKING_RANGE_PLACE_LIMIT,
    bookingRangeDays
  );
  const requestedSearchMode = payload.searchMode || process.env.SEARCH_MODE || "keyword";
  const resolvedSearchMode = resolveSearchModeForCrawl(keyword, requestedSearchMode);
  const productMode = normalizeProductMode(payload.productMode || process.env.PRODUCT_MODE || "all");
  const collectionMode = normalizeCollectionMode(payload.collectionMode || process.env.COLLECTION_MODE || "precision");
  const rawDetailRankRanges = collectionMode === "fast"
    ? ""
    : (payload.detailRankRanges || process.env.DETAIL_RANK_RANGES);
  const detailRankRanges = rankRangeLabel(parseRankRanges(
    rawDetailRankRanges,
    collectionMode === "fast" ? "" : "1-10"
  ));
  return {
    keyword,
    checkIn,
    checkOut,
    bookingRangeDays,
    bookingRangePlaceLimit,
    requestedSearchMode,
    resolvedSearchMode,
    productMode,
    collectionMode,
    detailRankRanges
  };
}

function estimateCrawlCompletion(payload = {}, timingStore = null) {
  const plan = crawlExecutionPlan(payload);
  const rangePlaceCount = plan.bookingRangeDays > 1 ? plan.bookingRangePlaceLimit : 0;
  const fast = plan.collectionMode === "fast";
  const searchSeconds = plan.resolvedSearchMode === "company" ? 55 : 95;
  const productSeconds = fast ? 0 : (plan.productMode === "all" ? 45 : 26);
  const trendSeconds = plan.resolvedSearchMode === "keyword" ? 25 : 10;
  const rangeSeconds = !fast && rangePlaceCount
    ? rangePlaceCount * plan.bookingRangeDays * (plan.productMode === "all" ? 5.5 : 4.2)
    : 0;
  const regionalSeconds = fast ? 0 : 80;
  const otaSeconds = fast ? 0 : 35;
  const ioSeconds = fast ? 18 : 35;
  const stages = [
    {
      key: "rank",
      label: "순위 수집",
      seconds: searchSeconds,
      detail: "네이버 플레이스 순위와 업체 기본 정보를 정리합니다."
    },
    {
      key: "trend",
      label: "수요 확인",
      seconds: trendSeconds,
      detail: "검색수요와 트렌드 캐시를 확인합니다."
    },
    fast
      ? {
          key: "inventory",
          label: "상세 생략",
          seconds: 6,
          detail: "빠른 순위 모드라 날짜별 재고와 가격 확인을 건너뜁니다."
        }
      : {
          key: "inventory",
          label: "재고/가격 확인",
          seconds: productSeconds + rangeSeconds,
          detail: `상세 ${plan.detailRankRanges || "1-20"}위의 날짜별 수량과 요일별 가격을 확인합니다.`
        },
    !fast
      ? {
          key: "ota",
          label: "보조 채널",
          seconds: otaSeconds + regionalSeconds,
          detail: "OTA 보조 신호와 지역 수요 데이터를 정리합니다."
        }
      : null,
    {
      key: "save",
      label: "저장/분석",
      seconds: ioSeconds,
      detail: "결과 파일, 누적 DB, 업체 마스터를 갱신합니다."
    }
  ].filter(Boolean).map((stage) => ({
    ...stage,
    seconds: Math.max(4, Math.round(stage.seconds || 0))
  }));
  const stagedSeconds = stages.reduce((sum, stage) => sum + stage.seconds, 0);
  const modelTotalSeconds = Math.max(
    fast ? 45 : 90,
    stagedSeconds
  );
  const timing = crawlTimingAdjustment(plan, modelTotalSeconds, timingStore);
  const recrawlContext = sanitizeRecrawlContext(payload.recrawlContext, plan);
  const estimatedTotalSeconds = timing.estimatedTotalSeconds;
  return {
    ...plan,
    estimatedTotalSeconds,
    recrawlContext,
    stages: scaleCrawlStages(stages, estimatedTotalSeconds),
    basis: {
      searchMode: plan.resolvedSearchMode,
      searchModeLabel: SEARCH_MODES[plan.resolvedSearchMode] || SEARCH_MODES.keyword,
      productMode: plan.productMode,
      productModeLabel: PRODUCT_MODES[plan.productMode] || PRODUCT_MODES.all,
      collectionMode: plan.collectionMode,
      collectionModeLabel: COLLECTION_MODES[plan.collectionMode] || COLLECTION_MODES.precision,
      detailRankRanges: plan.detailRankRanges,
      bookingRangeDays: plan.bookingRangeDays,
      bookingRangePlaceLimit: plan.bookingRangePlaceLimit,
      timing
    }
  };
}

function scaleCrawlStages(stages = [], targetTotalSeconds = 0) {
  const rows = stages.map((stage) => ({ ...stage, seconds: Math.max(4, Math.round(stage.seconds || 0)) }));
  if (!rows.length) return rows;
  const baseTotal = rows.reduce((sum, stage) => sum + stage.seconds, 0);
  const target = Math.max(rows.length * 4, Math.round(Number(targetTotalSeconds) || baseTotal));
  const scaled = rows.map((stage) => ({
    ...stage,
    seconds: Math.max(4, Math.round((stage.seconds / Math.max(1, baseTotal)) * target))
  }));
  const delta = target - scaled.reduce((sum, stage) => sum + stage.seconds, 0);
  scaled[scaled.length - 1].seconds = Math.max(4, scaled[scaled.length - 1].seconds + delta);
  return scaled;
}

function crawlTimingConditions(plan = {}) {
  return {
    searchMode: plan.resolvedSearchMode || plan.searchMode || "keyword",
    requestedSearchMode: normalizeSearchMode(plan.requestedSearchMode || plan.searchMode || "keyword"),
    productMode: normalizeProductMode(plan.productMode),
    collectionMode: normalizeCollectionMode(plan.collectionMode),
    detailRankRanges: plan.detailRankRanges || "없음",
    bookingRangeDays: Math.max(1, Math.min(31, Math.round(Number(plan.bookingRangeDays) || 1))),
    bookingRangePlaceLimit: Math.max(0, Math.min(20, Math.round(Number(plan.bookingRangePlaceLimit) || 0)))
  };
}

function sanitizeRecrawlContext(value = {}, plan = {}) {
  if (!value || typeof value !== "object") return null;
  const type = String(value.type || "").trim();
  if (!["company", "batch"].includes(type)) return null;
  const companyIds = Array.isArray(value.companyIds)
    ? value.companyIds.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 40)
    : [];
  const companyNames = Array.isArray(value.companyNames)
    ? value.companyNames.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 40)
    : [];
  const count = Math.max(companyIds.length, companyNames.length, Math.round(Number(value.count) || 0), type === "company" ? 1 : 0);
  return {
    type,
    key: String(value.key || "").trim().slice(0, 240),
    label: String(value.label || (type === "batch" ? "묶음 재수집" : "개별 재수집")).trim().slice(0, 80),
    count,
    companyIds,
    companyNames,
    keyword: String(plan.keyword || value.keyword || "").trim(),
    range: String(plan.detailRankRanges || value.range || "").trim(),
    checkIn: String(plan.checkIn || value.checkIn || "").trim(),
    checkOut: String(plan.checkOut || value.checkOut || "").trim(),
    savedSeconds: Math.max(0, Math.round(Number(value.savedSeconds) || 0)),
    etaSeconds: Math.max(0, Math.round(Number(value.etaSeconds) || 0)),
    source: String(value.source || "decision_queue").trim().slice(0, 60)
  };
}

function crawlTimingSimilarityScore(plan = {}, entry = {}) {
  if (!entry?.success || !Number.isFinite(Number(entry.durationSeconds))) return 0;
  const left = crawlTimingConditions(plan);
  const right = entry.conditions || {};
  if (right.collectionMode !== left.collectionMode) return 0;
  if (right.searchMode !== left.searchMode) return 0;
  if (right.productMode !== left.productMode) return 0;

  let score = 9;
  const dayDelta = Math.abs(Number(right.bookingRangeDays || 1) - left.bookingRangeDays);
  if (dayDelta === 0) score += 4;
  else if (dayDelta <= 2) score += 3;
  else if (dayDelta <= 7) score += 1;
  else return 0;

  const limitDelta = Math.abs(Number(right.bookingRangePlaceLimit || 0) - left.bookingRangePlaceLimit);
  if (limitDelta === 0) score += 2;
  else if (limitDelta <= 5) score += 1;

  if ((right.detailRankRanges || "없음") === left.detailRankRanges) score += 2;
  return score;
}

function crawlTimingAdjustment(plan = {}, modelTotalSeconds = 0, timingStore = null) {
  const model = Math.max(1, Math.round(Number(modelTotalSeconds) || 1));
  const entries = Array.isArray(timingStore?.entries) ? timingStore.entries : [];
  const matches = entries
    .map((entry) => ({
      entry,
      score: crawlTimingSimilarityScore(plan, entry),
      endedAtMs: Date.parse(entry.endedAt || entry.startedAt || "")
    }))
    .filter((row) => row.score > 0 && Number.isFinite(row.endedAtMs))
    .sort((a, b) => (b.score - a.score) || (b.endedAtMs - a.endedAtMs))
    .slice(0, 12);

  if (!matches.length) {
    return {
      source: "model",
      label: "조건 모델",
      sampleCount: 0,
      modelTotalSeconds: model,
      estimatedTotalSeconds: model,
      averageSeconds: null
    };
  }

  const weighted = matches.reduce((acc, row, index) => {
    const duration = Math.max(1, Number(row.entry.durationSeconds) || 1);
    const recencyWeight = Math.max(0.35, 1 - index * 0.045);
    const weight = row.score * recencyWeight;
    acc.weight += weight;
    acc.seconds += duration * weight;
    return acc;
  }, { weight: 0, seconds: 0 });
  const averageSeconds = Math.round(weighted.seconds / Math.max(1, weighted.weight));
  const blend = matches.length >= 3 ? 0.72 : matches.length === 2 ? 0.62 : 0.52;
  const blended = Math.round(model * (1 - blend) + averageSeconds * blend);
  const estimatedTotalSeconds = Math.max(
    Math.round(model * 0.45),
    Math.min(Math.round(model * 2.6), blended)
  );

  return {
    source: "measured",
    label: "최근 유사 수집",
    sampleCount: matches.length,
    modelTotalSeconds: model,
    estimatedTotalSeconds,
    averageSeconds,
    latestEndedAt: new Date(Math.max(...matches.map((row) => row.endedAtMs))).toISOString()
  };
}

function publicCrawlEstimate(payload = {}, timingStore = null) {
  const estimate = estimateCrawlCompletion(payload, timingStore);
  return {
    keyword: estimate.keyword,
    checkIn: estimate.checkIn,
    checkOut: estimate.checkOut,
    searchMode: estimate.resolvedSearchMode,
    productMode: estimate.productMode,
    collectionMode: estimate.collectionMode,
    detailRankRanges: estimate.detailRankRanges,
    bookingRangeDays: estimate.bookingRangeDays,
    bookingRangePlaceLimit: estimate.bookingRangePlaceLimit,
    estimatedTotalSeconds: estimate.estimatedTotalSeconds,
    estimateBasis: estimate.basis,
    stages: estimate.stages
  };
}

const PROVINCES = {
  gyeongbuk: {
    label: "경북",
    keyword: "경북글램핑",
    mapBounds: { minLon: 127.95, maxLon: 130.95, minLat: 35.55, maxLat: 37.55 },
    profiles: {
      포항: { lat: 36.019, lon: 129.3435, primary: "복합형", secondary: "메인 관광지형, 자연 관광자원형, 생활권·도심 수요형", resources: ["바다"], target: "동해안 관광 수요", note: "동해안 대표 관광지이면서 도심 생활권 수요도 함께 보유" },
      경주: { lat: 35.8562, lon: 129.2247, primary: "복합형", secondary: "메인 관광지형, 자연 관광자원형", resources: ["문화유산", "산"], target: "경주 관광 수요", note: "지역 자체가 강한 여행 목적지" },
      김천: { lat: 36.1398, lon: 128.1136, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["산"], target: "김천·구미 생활권", note: "근거리 주말 수요와 일부 산악형 수요" },
      안동: { lat: 36.5684, lon: 128.7294, primary: "복합형", secondary: "메인 관광지형, 자연 관광자원형", resources: ["문화유산", "강"], target: "안동 관광 수요", note: "문화 관광 목적지와 강변·자연 수요가 결합" },
      구미: { lat: 36.1195, lon: 128.3446, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "산"], target: "구미·칠곡 생활권", note: "인구 기반의 근교 숙박/체험 수요" },
      영주: { lat: 36.8057, lon: 128.6241, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "문화유산"], target: "소백산·부석사 수요", note: "산악 및 역사 관광 수요" },
      영천: { lat: 35.9733, lon: 128.9386, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["강", "근교"], target: "경주·대구·청도", note: "인접 관광지와 대구 근교 수요 흡수" },
      상주: { lat: 36.4109, lon: 128.1591, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["강", "산"], target: "상주·문경 생활권", note: "생활권 기반에 강·산 자연 수요가 보조" },
      문경: { lat: 36.5865, lon: 128.1868, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "계곡"], target: "문경새재·산악 관광 수요", note: "자연 체험형 글램핑과 결합성이 높음" },
      경산: { lat: 35.825, lon: 128.7415, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "대구·청도·경주", note: "대구 생활권과 인접 관광 수요를 함께 흡수" },
      의성: { lat: 36.3526, lon: 128.697, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "농촌"], target: "안동·군위권", note: "자연·농촌 체류형 수요 중심" },
      청송: { lat: 36.4363, lon: 129.057, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "계곡"], target: "주왕산 관광 수요", note: "산악 관광 목적성이 강함" },
      영양: { lat: 36.6667, lon: 129.1125, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "숲"], target: "청송·영덕 인접 수요", note: "저밀도 자연 체류형 수요" },
      영덕: { lat: 36.4151, lon: 129.3657, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다"], target: "영덕 해안 관광 수요", note: "바다 관광 목적 수요가 직접 발생" },
      청도: { lat: 35.6474, lon: 128.734, primary: "인접 관광 흡수형", secondary: "자연 관광자원형, 생활권·도심 수요형", resources: ["산", "근교"], target: "대구·경산·경주", note: "대구 근교와 자연 체험 수요가 결합" },
      고령: { lat: 35.7259, lon: 128.2628, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["강", "문화"], target: "대구·합천·성주", note: "인접 도시권의 근거리 숙박 대체지" },
      성주: { lat: 35.9192, lon: 128.2829, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["산", "계곡"], target: "대구·가야산권", note: "대구 근교와 산악권 수요 흡수" },
      칠곡: { lat: 35.9956, lon: 128.4017, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "대구·구미", note: "대구·구미 사이 생활권 기반 수요" },
      예천: { lat: 36.6577, lon: 128.4529, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "산"], target: "안동·문경", note: "북부권 자연·인접 관광 수요" },
      봉화: { lat: 36.8931, lon: 128.7325, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "숲"], target: "백두대간·숲 관광 수요", note: "산림 체류형 수요가 뚜렷함" },
      울진: { lat: 36.9931, lon: 129.4005, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "온천"], target: "울진 해안·온천 관광 수요", note: "바다와 온천 기반의 목적지 수요" },
      울릉: { lat: 37.4845, lon: 130.9057, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["섬", "바다"], target: "울릉도 관광 수요", note: "섬 목적지형 수요" }
    }
  },
  gyeongnam: {
    label: "경남",
    keyword: "경남글램핑",
    mapBounds: { minLon: 127.55, maxLon: 129.25, minLat: 34.55, maxLat: 35.85 },
    profiles: {
      창원: { lat: 35.227, lon: 128.681, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "바다"], target: "마산·진해·부산근교", note: "대도시 생활권 기반의 근교 체류 수요" },
      진주: { lat: 35.18, lon: 128.108, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["강", "도심"], target: "사천·산청·하동", note: "서부경남 생활권과 주변 관광지 흡수 수요" },
      통영: { lat: 34.854, lon: 128.433, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "섬"], target: "통영 해안·섬 관광 수요", note: "지역 자체가 강한 해양 관광 목적지" },
      사천: { lat: 35.003, lon: 128.064, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["바다", "강"], target: "남해·진주·고성", note: "남해안 관광과 서부경남 생활권을 함께 흡수" },
      김해: { lat: 35.228, lon: 128.889, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "부산·창원·양산", note: "부산권 근교 체험형 수요" },
      밀양: { lat: 35.503, lon: 128.747, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "계곡"], target: "부산·창원·양산", note: "근교 자연 체류형 수요" },
      거제: { lat: 34.881, lon: 128.621, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "섬"], target: "거제 해양 관광 수요", note: "바다와 섬 목적지형 수요가 강함" },
      양산: { lat: 35.335, lon: 129.037, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["산", "근교"], target: "부산·울산 생활권", note: "대도시 근교 휴식 수요" },
      의령: { lat: 35.322, lon: 128.262, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "농촌"], target: "진주·함안·창녕", note: "저밀도 자연 체류형 수요" },
      함안: { lat: 35.272, lon: 128.406, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["강", "근교"], target: "창원·진주", note: "창원 인접 생활권과 근교 숙박 수요" },
      창녕: { lat: 35.544, lon: 128.493, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["습지", "온천"], target: "우포늪·부곡온천 수요", note: "자연 관광자원 중심 수요" },
      고성: { lat: 34.973, lon: 128.322, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["바다"], target: "통영·거제·사천", note: "남해안 주요 관광지 사이의 흡수 입지" },
      남해: { lat: 34.837, lon: 127.893, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "섬"], target: "남해 해안 관광 수요", note: "해양 관광 목적지형 수요" },
      하동: { lat: 35.067, lon: 127.751, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "강"], target: "지리산·섬진강 수요", note: "산과 강 기반의 체류형 관광 수요" },
      산청: { lat: 35.415, lon: 127.873, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "계곡"], target: "지리산 관광 수요", note: "지리산권 자연 체류형 수요" },
      함양: { lat: 35.52, lon: 127.725, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "계곡"], target: "지리산·거창", note: "산악권 자연 수요" },
      거창: { lat: 35.687, lon: 127.909, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "계곡"], target: "함양·합천·지리산권", note: "북서부 산악권 체류 수요" },
      합천: { lat: 35.566, lon: 128.166, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["호수", "산"], target: "합천호·가야산 수요", note: "호수와 산악 관광 수요" }
    }
  },
  jeonbuk: {
    label: "전북",
    keyword: "전북글램핑",
    mapBounds: { minLon: 126.35, maxLon: 127.85, minLat: 35.25, maxLat: 36.15 },
    profiles: {
      전주: { lat: 35.8242, lon: 127.148, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "문화"], target: "전주·완주 생활권", note: "도시 생활권과 한옥마을 관광 수요를 함께 흡수" },
      군산: { lat: 35.9676, lon: 126.736, primary: "메인 관광지형", secondary: "생활권·도심 수요형", resources: ["바다", "근대문화"], target: "군산 관광 수요", note: "서해안과 근대문화 관광 목적성" },
      익산: { lat: 35.9483, lon: 126.957, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "문화"], target: "전주·군산·익산 생활권", note: "전북 서북부 생활권 기반" },
      정읍: { lat: 35.5699, lon: 126.856, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "내장산"], target: "내장산 관광 수요", note: "내장산권 계절 관광 수요" },
      남원: { lat: 35.4164, lon: 127.39, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["지리산", "문화"], target: "지리산·남원 관광 수요", note: "지리산 남부와 문화 관광 수요" },
      김제: { lat: 35.8036, lon: 126.88, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["농촌", "근교"], target: "전주·군산 인접 수요", note: "평야권 체험형·근교 수요" },
      완주: { lat: 35.9047, lon: 127.162, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["산", "계곡"], target: "전주 생활권", note: "전주 수요를 자연 체류형으로 흡수" },
      진안: { lat: 35.7917, lon: 127.424, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산", "마이산"], target: "마이산 관광 수요", note: "산악·자연 관광 목적성" },
      무주: { lat: 36.0068, lon: 127.661, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["산", "리조트"], target: "덕유산·무주 관광 수요", note: "전북 대표 산악 체류 수요" },
      장수: { lat: 35.6474, lon: 127.521, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "농촌"], target: "무주·남원 인접 수요", note: "저밀도 자연 체류형" },
      임실: { lat: 35.6178, lon: 127.289, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["호수", "치즈테마"], target: "전주·남원 인접 수요", note: "체험 관광과 자연 수요" },
      순창: { lat: 35.3745, lon: 127.137, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "산"], target: "남원·담양 인접 수요", note: "남부 내륙 자연 수요" },
      고창: { lat: 35.4358, lon: 126.702, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "고인돌"], target: "고창 관광 수요", note: "서해안과 문화유산 관광" },
      부안: { lat: 35.7318, lon: 126.733, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다", "변산"], target: "변산반도 관광 수요", note: "서해안 목적지형 관광" }
    }
  },
  chungnam: {
    label: "충남",
    keyword: "충남글램핑",
    mapBounds: { minLon: 126.0, maxLon: 127.75, minLat: 35.95, maxLat: 37.05 },
    profiles: {
      천안: { lat: 36.8151, lon: 127.1139, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "천안·아산 생활권", note: "수도권 남부와 충남 생활권 수요" },
      공주: { lat: 36.4465, lon: 127.119, primary: "메인 관광지형", secondary: "인접 관광 흡수형", resources: ["문화유산", "강"], target: "공주 관광 수요", note: "역사문화 관광 목적성" },
      보령: { lat: 36.3334, lon: 126.6128, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다"], target: "대천·서해안 관광 수요", note: "서해안 해양 관광 수요" },
      아산: { lat: 36.7898, lon: 127.0025, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["온천", "도심"], target: "천안·아산 생활권", note: "생활권과 온천 관광 수요" },
      서산: { lat: 36.7845, lon: 126.45, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["바다", "호수"], target: "태안·당진 인접 수요", note: "서해안 자연 체류 수요" },
      논산: { lat: 36.1871, lon: 127.0987, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["농촌", "근교"], target: "대전·공주 인접 수요", note: "대전 인접 근교 수요" },
      계룡: { lat: 36.2746, lon: 127.2486, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["근교"], target: "대전 생활권", note: "대전권 근교 수요" },
      당진: { lat: 36.893, lon: 126.628, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["바다", "도심"], target: "서해안·평택 인접 수요", note: "산업도시 생활권과 해안 수요" },
      금산: { lat: 36.1089, lon: 127.488, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산", "강"], target: "대전·무주 인접 수요", note: "대전 근교 자연 수요" },
      부여: { lat: 36.2757, lon: 126.9098, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["문화유산", "강"], target: "백제문화 관광 수요", note: "역사문화 목적지" },
      서천: { lat: 36.0803, lon: 126.6917, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["바다", "강"], target: "서해안·금강 수요", note: "해안과 금강 자연 수요" },
      청양: { lat: 36.4592, lon: 126.8022, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["산"], target: "공주·부여 인접 수요", note: "칠갑산 자연 체류 수요" },
      홍성: { lat: 36.6013, lon: 126.6608, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["근교", "바다"], target: "충남도청권", note: "내포 생활권과 해안 접근 수요" },
      예산: { lat: 36.6826, lon: 126.848, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["호수", "시장"], target: "내포·아산 인접 수요", note: "예당호와 내포권 수요" },
      태안: { lat: 36.7456, lon: 126.2979, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["바다"], target: "태안 해안 관광 수요", note: "서해안 대표 목적지형 수요" }
    }
  },
  chungbuk: {
    label: "충북",
    keyword: "충북글램핑",
    mapBounds: { minLon: 127.25, maxLon: 128.65, minLat: 36.0, maxLat: 37.25 },
    profiles: {
      청주: { lat: 36.6424, lon: 127.489, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "청주 생활권", note: "충북 최대 생활권 기반" },
      충주: { lat: 36.991, lon: 127.9259, primary: "자연 관광자원형", secondary: "생활권·도심 수요형", resources: ["호수", "산"], target: "충주호 관광 수요", note: "호수·산악 체류형 수요" },
      제천: { lat: 37.1326, lon: 128.191, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["호수", "산"], target: "청풍호·제천 관광 수요", note: "충북 북부 대표 체류형 관광" },
      보은: { lat: 36.4895, lon: 127.7295, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["산"], target: "속리산 관광 수요", note: "속리산권 자연 관광" },
      옥천: { lat: 36.3064, lon: 127.5713, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["강", "근교"], target: "대전 인접 수요", note: "대전 근교 자연 수요" },
      영동: { lat: 36.175, lon: 127.7834, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "산"], target: "대전·무주 인접 수요", note: "남부 산악·강변 수요" },
      증평: { lat: 36.7854, lon: 127.5815, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["근교"], target: "청주·진천 생활권", note: "청주 인접 생활권 수요" },
      진천: { lat: 36.8554, lon: 127.4356, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["근교", "호수"], target: "청주·안성 인접 수요", note: "수도권 남부와 청주 사이 수요" },
      괴산: { lat: 36.8153, lon: 127.7867, primary: "자연 관광자원형", secondary: "메인 관광지형", resources: ["계곡", "산"], target: "괴산 자연 관광 수요", note: "계곡·산악 캠핑 수요" },
      음성: { lat: 36.9402, lon: 127.6905, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["근교"], target: "진천·충주·안성 인접 수요", note: "중부내륙 생활권 수요" },
      단양: { lat: 36.9846, lon: 128.3655, primary: "메인 관광지형", secondary: "자연 관광자원형", resources: ["강", "산"], target: "단양 관광 수요", note: "남한강·산악 목적지형 관광" }
    }
  },
  gyeonggi_south: {
    label: "경기남부",
    keyword: "경기남부글램핑",
    mapBounds: { minLon: 126.8, maxLon: 127.8, minLat: 36.85, maxLat: 37.55 },
    profiles: {
      안성: { lat: 37.008, lon: 127.2797, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["호수", "근교"], target: "평택·용인·천안 인접 수요", note: "수도권 남부와 충남 북부 사이의 흡수 입지" },
      이천: { lat: 37.2721, lon: 127.435, primary: "인접 관광 흡수형", secondary: "생활권·도심 수요형", resources: ["도자", "근교"], target: "서울동남권·여주·용인", note: "수도권 동남부 근교 체류 수요" },
      용인: { lat: 37.2411, lon: 127.1776, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "테마파크"], target: "서울남부·수원 생활권", note: "생활권과 체험형 수요가 결합" },
      여주: { lat: 37.298, lon: 127.637, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["강", "아울렛"], target: "이천·원주·서울동남권", note: "남한강과 쇼핑/근교 수요" },
      평택: { lat: 36.9921, lon: 127.1127, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심", "근교"], target: "평택·안성 생활권", note: "인구 기반 생활형 수요" },
      화성: { lat: 37.1996, lon: 126.831, primary: "생활권·도심 수요형", secondary: "자연 관광자원형", resources: ["바다", "도심"], target: "수원·동탄·서해안 수요", note: "대도시 생활권과 서해안 접근 수요" },
      오산: { lat: 37.1498, lon: 127.0772, primary: "생활권·도심 수요형", secondary: "인접 관광 흡수형", resources: ["도심"], target: "수원·화성·평택 생활권", note: "생활권 기반 근교 수요" },
      경기광주: { lat: 37.4294, lon: 127.255, primary: "인접 관광 흡수형", secondary: "자연 관광자원형", resources: ["산", "계곡"], target: "서울동남권·성남", note: "서울 동남권 근교 자연 수요" },
      양평: { lat: 37.4918, lon: 127.4876, primary: "자연 관광자원형", secondary: "인접 관광 흡수형", resources: ["강", "산"], target: "서울동부·남양주 인접 수요", note: "수도권 자연 체류형 대표 지역" }
    }
  },
  gyeonggi: {
    label: "경기",
    keyword: "경기글램핑",
    mapBounds: { minLon: 126.45, maxLon: 127.95, minLat: 36.85, maxLat: 38.35 },
    profiles: {
      포천: { lat: 37.8949, lon: 127.2003, primary: "자연 관광자원형", secondary: "인접 관광 흡수형, 생활권·도심 수요형", resources: ["산", "계곡", "호수"], target: "서울·의정부·남양주", note: "수도권 근교 자연 체류형 수요와 당일/1박 수요를 함께 흡수" }
    }
  },
  local: {
    label: "지역",
    keyword: "지역글램핑",
    mapBounds: { minLon: 126.5, maxLon: 130.5, minLat: 34.5, maxLat: 38.5 },
    profiles: {}
  }
};

const DEMAND_LEVEL_SCORES = {
  "최상": 100,
  "상": 85,
  "중상": 70,
  "중": 55,
  "중하": 40,
  "하": 25
};

const DEMAND_SEGMENTS = [
  {
    name: "대학생 커플",
    group: "커플형",
    weekend: 4,
    weekday: 5,
    conversion: 5,
    weight: 14,
    priority: 5,
    seasons: ["봄", "가을"],
    keywords: ["장박", "가격민감", "불멍"],
    message: "평일에도 부담 적은 입문형 글램핑",
    operation: "평일특가, 감성사진, 불멍 강조",
    caution: "초등 가족",
    status: "유지"
  },
  {
    name: "직장인 커플",
    group: "커플형",
    weekend: 5,
    weekday: 2,
    conversion: 4,
    weight: 18,
    priority: 3,
    seasons: ["봄", "가을", "연말"],
    keywords: ["기념일", "프라이빗"],
    message: "주말에 쉬기 좋은 프라이빗 글램핑",
    operation: "금·토 집중, 기념일형 상품",
    caution: "평일 유입 약함",
    status: "유지"
  },
  {
    name: "대학생 그룹",
    group: "그룹형",
    weekend: 5,
    weekday: 5,
    conversion: 4,
    weight: 9,
    priority: 4,
    seasons: ["여름", "겨울"],
    keywords: ["가성비", "단체", "추억"],
    message: "친구들과 가볍게 즐기는 단체 글램핑",
    operation: "방학 시즌, 단체 사진 강조",
    caution: "소음 관리 필요",
    status: "유지"
  },
  {
    name: "직장인 그룹",
    group: "그룹형",
    weekend: 5,
    weekday: 2,
    conversion: 3,
    weight: 9,
    priority: 2,
    seasons: ["봄", "가을"],
    keywords: ["워크숍", "모임"],
    message: "소규모 모임에 적합한 글램핑",
    operation: "기업/소모임 제안형",
    caution: "일정 제약 큼",
    status: "검토"
  },
  {
    name: "영유아 가족",
    group: "가족형",
    weekend: 4,
    weekday: 3,
    conversion: 4,
    weight: 8,
    priority: 4,
    seasons: ["봄", "여름", "가을"],
    keywords: ["안전", "편의", "가족"],
    message: "부모가 편한 가족형 글램핑",
    operation: "낮시간 체류, 부모 편의 강조",
    caution: "",
    status: "유지"
  },
  {
    name: "초등 가족",
    group: "가족형",
    weekend: 4,
    weekday: 4,
    conversion: 5,
    weight: 15,
    priority: 5,
    seasons: ["봄", "여름", "가을"],
    keywords: ["체험", "안전", "가족"],
    message: "아이와 함께 즐기는 가족형 글램핑",
    operation: "체험, 야외동선, 부모 편의 강조",
    caution: "우천 변수 큼",
    status: "유지"
  },
  {
    name: "중고등 가족",
    group: "가족형",
    weekend: 5,
    weekday: 1,
    conversion: 2,
    weight: 11,
    priority: 1,
    seasons: ["여름", "연휴"],
    keywords: ["연휴", "단기휴가"],
    message: "방학·연휴 한정 가족형 수요",
    operation: "방학/연휴 특화",
    caution: "평시 반응 약함",
    status: "보완"
  },
  {
    name: "자연체류형",
    group: "평일확장형",
    weekend: 3,
    weekday: 5,
    conversion: 5,
    weight: 10,
    priority: 5,
    seasons: ["가을", "겨울", "연중"],
    keywords: ["조용한 쉼", "자연"],
    message: "조용히 쉬기 좋은 자연형 글램핑",
    operation: "평일쉼, 야간 불멍, 산책 강조",
    caution: "화려한 연출보다 안정감",
    status: "유지"
  },
  {
    name: "프리랜서·원격근무",
    group: "평일확장형",
    weekend: 2,
    weekday: 5,
    conversion: 4,
    weight: 4,
    priority: 4,
    seasons: ["연중"],
    keywords: ["워케이션", "장박"],
    message: "평일에도 머물 수 있는 워케이션형 글램핑",
    operation: "와이파이, 테이블, 조용한 공간",
    caution: "장박 운영 기준 필요",
    status: "검토"
  },
  {
    name: "은퇴 시니어",
    group: "시니어형",
    weekend: 2,
    weekday: 5,
    conversion: 3,
    weight: 2,
    priority: 2,
    seasons: ["봄", "가을"],
    keywords: ["평일", "조용함"],
    message: "전 세그먼트",
    operation: "낮시간, 동선 단순화, 조용함",
    caution: "디지털 예약 불편 가능",
    status: "검토"
  }
];

const MONTHLY_DEMAND_MAP = [
  { month: 1, season: "겨울", level: "중상", weekdaySignal: "중고생 겨울캠프", targets: ["커플", "자연체류형", "대학생 커플"], keywords: ["겨울", "불멍", "온기"], operation: "숨은 성수기 관리", action: "리뷰 축적, 겨울 콘텐츠 확보", price: "보합", content: "야간사진, 불멍, 온기", risks: ["장박"], interpretation: "겨울 감성 후기 유지" },
  { month: 2, season: "겨울", level: "중상", weekdaySignal: "중고생 겨울캠프", targets: ["커플", "가족형"], keywords: ["설날", "겨울마감"], operation: "연휴 대응", action: "연휴형 상품 정리", price: "보합", content: "설 연휴, 가족 모임", risks: ["한파", "연휴 집중"], interpretation: "연휴 집중형 운영 유지검토 필요" },
  { month: 3, season: "봄", level: "중하", weekdaySignal: "초등 가족", targets: ["시니어형", "대학생 커플"], keywords: ["봄 시작", "비수기"], operation: "가격 민감 구간", action: "프로모션, 입문형 상품", price: "한정 할인", content: "봄 전환, 자연 회복", risks: ["날씨 불안정"], interpretation: "평일형 타겟 확장 권장" },
  { month: 4, season: "봄", level: "중", weekdaySignal: "직장인 커플", targets: ["초등 가족", "대학생 커플"], keywords: ["벚꽃", "봄나들이"], operation: "야외활동 회복", action: "봄 사진 교체, 가족형 문구 강화", price: "보합", content: "벚꽃, 산책, 가족 체험", risks: ["비", "미세먼지"], interpretation: "초등 가족 반응 증가" },
  { month: 5, season: "봄", level: "상", weekdaySignal: "가족 단위", targets: ["초등 가족", "영유아 가족"], keywords: ["어린이날", "어버이날"], operation: "가족 중심 달", action: "가족 패키지 강화", price: "연휴 중심 단가 유지", content: "가족 체험, 연휴", risks: ["날씨", "행사 집중"], interpretation: "가족 키워드 강화 권장" },
  { month: 6, season: "여름", level: "중", weekdaySignal: "대학엠티", targets: ["소규모 활동", "커플"], keywords: ["초여름", "활동적인 구간"], operation: "장마 전 구간", action: "단체 어트랙션", price: "보합", content: "어트랙션, 액티비티", risks: ["장마"], interpretation: "평일형 메시지 유효" },
  { month: 7, season: "여름", level: "최상", weekdaySignal: "전 세그먼트", targets: ["가족형", "커플형"], keywords: ["여름휴가 시작"], operation: "성수기 운영", action: "단가 최적화", price: "단가 유지", content: "수영/야외, 휴가", risks: ["장마", "폭염"], interpretation: "성수기 단가 방어 우선" },
  { month: 8, season: "여름", level: "최상", weekdaySignal: "전 세그먼트", targets: ["가족형", "그룹형"], keywords: ["여름휴가 절정"], operation: "성수기 운영", action: "리뷰/사진 최대 확보", price: "단가 유지", content: "활동감, 여름 경험", risks: ["폭염"], interpretation: "후기 축적 최우선" },
  { month: 9, season: "가을", level: "중", weekdaySignal: "커플", targets: ["초등 가족", "자연체류형"], keywords: ["가을 시작", "추석"], operation: "회복 구간", action: "가을 콘텐츠 전환", price: "보합", content: "초가을, 가족/커플", risks: ["태풍", "추석 편차"], interpretation: "가을 전환기 콘텐츠 필요" },
  { month: 10, season: "가을", level: "상", weekdaySignal: "전 세그먼트", targets: ["커플형", "가족형"], keywords: ["단풍", "야외활동"], operation: "가을 성수기", action: "대표 시즌 브랜딩 강화", price: "단가 유지", content: "단풍, 산책, 야외경험", risks: ["주말 몰림"], interpretation: "대표 시즌 키워드 강화" },
  { month: 11, season: "가을", level: "중상", weekdaySignal: "커플", targets: ["자연체류형", "프리랜서형"], keywords: ["늦가을", "불멍", "조용한 쉼"], operation: "감성보다 깊게 쉬는 경험", action: "평일쉼 상품, 불멍 강조", price: "보합/패키지", content: "야간사진, 불멍, 온기", risks: ["한파 시작"], interpretation: "평일 반응은 자연체류형이 강함" },
  { month: 12, season: "겨울", level: "중", weekdaySignal: "직장인 모임", targets: ["커플", "자연체류형"], keywords: ["연말", "소모임"], operation: "송년 시즌", action: "소규모 모임형/커플형 운영", price: "보합", content: "연말 감성, 불멍", risks: ["한파", "예약 편차"], interpretation: "연말 소모임 수요 반영" }
];

const DEMAND_AI_SIGNALS = [
  { keyword: "조용한 쉼", segment: "자연체류형", frequency: 12, signal: "조용함, 불멍, 쉬기 좋음", proposal: "11월~2월 자연체류형 메시지 강화" },
  { keyword: "아이와 함께", segment: "초등 가족", frequency: 8, signal: "체험, 안전", proposal: "4~5월 가족형 키워드 보강" }
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

const trafficKeyFields = [
  "naverClientId",
  "naverClientSecret",
  "searchadApiKey",
  "searchadSecretKey",
  "searchadCustomerId"
];

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 6) return "*".repeat(text.length);
  return `${text.slice(0, 3)}${"*".repeat(Math.max(3, text.length - 6))}${text.slice(-3)}`;
}

function normalizeApiKey(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

async function readTrafficKeys() {
  let saved = {};
  try {
    saved = JSON.parse((await fsp.readFile(TRAFFIC_KEYS_FILE, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    saved = {};
  }

  return {
    naverClientId: normalizeApiKey(process.env.NAVER_CLIENT_ID || saved.naverClientId || ""),
    naverClientSecret: normalizeApiKey(process.env.NAVER_CLIENT_SECRET || saved.naverClientSecret || ""),
    searchadApiKey: normalizeApiKey(process.env.NAVER_SEARCHAD_API_KEY || saved.searchadApiKey || ""),
    searchadSecretKey: normalizeApiKey(process.env.NAVER_SEARCHAD_SECRET_KEY || saved.searchadSecretKey || ""),
    searchadCustomerId: normalizeApiKey(process.env.NAVER_SEARCHAD_CUSTOMER_ID || saved.searchadCustomerId || "")
  };
}

function trafficKeyStatus(keys) {
  const envFields = {
    naverClientId: Boolean(process.env.NAVER_CLIENT_ID),
    naverClientSecret: Boolean(process.env.NAVER_CLIENT_SECRET),
    searchadApiKey: Boolean(process.env.NAVER_SEARCHAD_API_KEY),
    searchadSecretKey: Boolean(process.env.NAVER_SEARCHAD_SECRET_KEY),
    searchadCustomerId: Boolean(process.env.NAVER_SEARCHAD_CUSTOMER_ID)
  };
  return {
    datalabConfigured: Boolean(keys.naverClientId && keys.naverClientSecret),
    searchadConfigured: Boolean(keys.searchadApiKey && keys.searchadSecretKey && keys.searchadCustomerId),
    storage: {
      configDir: CONFIG_DIR,
      file: TRAFFIC_KEYS_FILE,
      persistent: HAS_RENDER_DISK || !isTmpDataPath(CONFIG_DIR),
      envOverride: Object.values(envFields).some(Boolean),
      envFields
    },
    fields: Object.fromEntries(
      trafficKeyFields.map((field) => [
        field,
        {
          configured: Boolean(keys[field]),
          masked: maskSecret(keys[field])
        }
      ])
    )
  };
}

async function saveTrafficKeys(payload) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const current = await readTrafficKeys();
  const next = { ...current };

  for (const field of trafficKeyFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      const value = normalizeApiKey(payload[field]);
      if (value) next[field] = value;
    }
  }

  await fsp.writeFile(TRAFFIC_KEYS_FILE, JSON.stringify(next, null, 2), "utf8");
  return trafficKeyStatus(next);
}

function emptyLocationCardRequests() {
  return {
    schemaVersion: 1,
    updatedAt: "",
    requests: {}
  };
}

async function readLocationCardRequests() {
  try {
    const parsed = JSON.parse((await fsp.readFile(LOCATION_CARD_REQUESTS_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return {
      ...emptyLocationCardRequests(),
      ...parsed,
      requests: parsed.requests || {}
    };
  } catch {
    return emptyLocationCardRequests();
  }
}

function locationCandidateKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function sanitizeLocationRequestText(value, max = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

function sanitizeLocationRequestNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function sanitizeLocationRequestEvidence(value = {}) {
  const sampleCompanies = Array.isArray(value.sampleCompanies)
    ? value.sampleCompanies.map((item) => sanitizeLocationRequestText(item, 80)).filter(Boolean).slice(0, 8)
    : [];
  return {
    itemCount: sanitizeLocationRequestNumber(value.itemCount),
    regionCount: sanitizeLocationRequestNumber(value.regionCount),
    salesSupply: sanitizeLocationRequestNumber(value.salesSupply),
    salesSold: sanitizeLocationRequestNumber(value.salesSold),
    targetCount: sanitizeLocationRequestNumber(value.targetCount),
    searchVolume: sanitizeLocationRequestNumber(value.searchVolume),
    platformGap: sanitizeLocationRequestNumber(value.platformGap),
    sampleCompanies
  };
}

function publicLocationCardRequests(store = emptyLocationCardRequests()) {
  const requests = store.requests || {};
  return {
    schemaVersion: store.schemaVersion || 1,
    updatedAt: store.updatedAt || "",
    requests,
    items: Object.values(requests).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
  };
}

async function saveLocationCardRequest(payload = {}) {
  const allowed = new Set(["requested", "temporary", "ignored", "linked"]);
  const status = allowed.has(payload.status) ? payload.status : "requested";
  const keyword = sanitizeLocationRequestText(payload.keyword || payload.searchKeyword || payload.query, 120);
  const regionBase = sanitizeLocationRequestText(payload.regionBase || payload.region, 80);
  const key = locationCandidateKey(payload.key || regionBase || keyword) || `candidate_${stableHash(keyword || Date.now())}`;
  const now = new Date().toISOString();
  const store = await readLocationCardRequests();
  const current = store.requests[key] || {};
  const history = Array.isArray(current.history) ? current.history.slice(-19) : [];
  const next = {
    ...current,
    key,
    keyword,
    regionBase,
    searchKeyword: sanitizeLocationRequestText(payload.searchKeyword || keyword, 120),
    status,
    relatedRegion: sanitizeLocationRequestText(payload.relatedRegion, 120),
    note: sanitizeLocationRequestText(payload.note, 500),
    runId: sanitizeLocationRequestText(payload.runId, 120),
    activeKeyword: sanitizeLocationRequestText(payload.activeKeyword, 120),
    evidence: sanitizeLocationRequestEvidence(payload.evidence),
    firstSeenAt: current.firstSeenAt || now,
    updatedAt: now,
    history: [
      ...history,
      {
        status,
        relatedRegion: sanitizeLocationRequestText(payload.relatedRegion, 120),
        note: sanitizeLocationRequestText(payload.note, 240),
        at: now
      }
    ]
  };

  store.requests[key] = next;
  store.updatedAt = now;
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const tempPath = `${LOCATION_CARD_REQUESTS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await fsp.rename(tempPath, LOCATION_CARD_REQUESTS_FILE);
  return publicLocationCardRequests(store);
}

function sanitizeMemberText(value, max = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeLoginId(value = "") {
  return sanitizeMemberText(value, 80).toLowerCase();
}

function emptyB2BMemberStore() {
  return {
    schemaVersion: 1,
    updatedAt: "",
    members: []
  };
}

async function readB2BMemberStore() {
  for (const file of [B2B_MEMBERS_FILE, LEGACY_B2B_MEMBERS_FILE]) {
    try {
      const parsed = JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      return {
        ...emptyB2BMemberStore(),
        ...parsed,
        members: Array.isArray(parsed.members) ? parsed.members : []
      };
    } catch {
      // Try the next known location before falling back to an empty store.
    }
  }
  return emptyB2BMemberStore();
}

async function writeB2BMemberStore(store) {
  await fsp.mkdir(CUSTOMER_DB_DIR, { recursive: true });
  const next = {
    ...emptyB2BMemberStore(),
    ...store,
    updatedAt: new Date().toISOString(),
    members: Array.isArray(store.members) ? store.members : []
  };
  const tempPath = `${B2B_MEMBERS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fsp.rename(tempPath, B2B_MEMBERS_FILE);
  return next;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  const digest = crypto.pbkdf2Sync(String(password || ""), salt, PASSWORD_HASH_ITERATIONS, 32, "sha256").toString("base64url");
  return `pbkdf2_sha256$${PASSWORD_HASH_ITERATIONS}$${salt}$${digest}`;
}

function verifyPassword(password, storedHash = "") {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 10000) return false;
  const expected = Buffer.from(parts[3]);
  const actual = Buffer.from(crypto.pbkdf2Sync(String(password || ""), parts[2], iterations, 32, "sha256").toString("base64url"));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeOwnershipStatus(value = "") {
  const text = String(value || "").trim();
  if (["owned", "보유", "own"].includes(text)) return "owned";
  if (["planning", "준비중", "준비 중", "plan"].includes(text)) return "planning";
  if (["agency", "대행사", "컨설턴트"].includes(text)) return "agency";
  return "none";
}

function ownershipStatusLabel(value = "") {
  return {
    owned: "숙박업소 보유",
    planning: "오픈 준비 중",
    none: "미보유/투자 검토",
    agency: "대행사/컨설턴트"
  }[normalizeOwnershipStatus(value)] || "미보유/투자 검토";
}

function memberProfileFromPayload(payload = {}) {
  return {
    displayName: "",
    phone: sanitizeMemberText(payload.phone, 40),
    email: sanitizeMemberText(payload.email, 120),
    companyName: sanitizeMemberText(payload.companyName, 120),
    ownershipStatus: normalizeOwnershipStatus(payload.ownershipStatus || payload.hasGlamping),
    ownershipStatusLabel: ownershipStatusLabel(payload.ownershipStatus || payload.hasGlamping),
    glampingName: "",
    address: "",
    naverPlaceUrl: "",
    naverBookingUrl: "",
    roomCount: 0,
    otaChannels: [],
    note: "",
    adminReviewStatus: "pending",
    adminReviewLabel: "관리자 검토 대기"
  };
}

function publicB2BMember(member = {}) {
  const profile = member.profile || {};
  return {
    memberId: member.memberId || "",
    username: member.username || "",
    role: USER_ROLES.b2b,
    accountType: member.accountType || "member",
    status: member.status || "active",
    createdAt: member.createdAt || "",
    updatedAt: member.updatedAt || "",
    lastLoginAt: member.lastLoginAt || "",
    searchCount: Number(member.searchCount || 0),
    profile: {
      ...profile,
      ownershipStatusLabel: profile.ownershipStatusLabel || ownershipStatusLabel(profile.ownershipStatus)
    }
  };
}

function isConsentAccepted(value) {
  return /^(1|true|on|yes|agree|accepted)$/i.test(String(value || "").trim());
}

function signupUsernameError(username) {
  if (!/^[a-z0-9._@-]{4,80}$/i.test(username)) return "아이디는 영문, 숫자, 이메일 형식으로 4자 이상 입력하세요.";
  if (username === normalizeLoginId(ADMIN_USERNAME) || username === normalizeLoginId(B2B_USERNAME)) return "예약된 아이디는 사용할 수 없습니다.";
  return "";
}

function signupPasswordError(password = "") {
  if (password.length < 8 || password.length > 120) return "비밀번호는 8자 이상 입력하세요.";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password) || !(/[A-Z]/.test(password) || /[^A-Za-z0-9]/.test(password))) {
    return "비밀번호는 영문과 숫자를 포함하고, 대문자 또는 특수문자를 포함해야 합니다.";
  }
  return "";
}

async function checkSignupUsernameAvailability(value = "") {
  const username = normalizeLoginId(value);
  const formatError = signupUsernameError(username);
  if (formatError) return { username, available: false, checked: true, message: formatError };
  const store = await readB2BMemberStore();
  const exists = store.members.some((member) => normalizeLoginId(member.username) === username);
  return {
    username,
    available: !exists,
    checked: true,
    message: exists ? "이미 가입된 아이디입니다." : "사용 가능한 아이디입니다."
  };
}

function validateSignupPayload(payload = {}) {
  const username = normalizeLoginId(payload.username || payload.loginId);
  const password = String(payload.password || "");
  const passwordConfirm = String(payload.passwordConfirm || payload.confirmPassword || "");
  const phone = sanitizeMemberText(payload.phone, 40);
  const email = sanitizeMemberText(payload.email, 120);
  const usernameError = signupUsernameError(username);
  if (usernameError) {
    const error = new Error(usernameError);
    error.statusCode = 400;
    throw error;
  }
  const passwordError = signupPasswordError(password);
  if (passwordError) {
    const error = new Error(passwordError);
    error.statusCode = 400;
    throw error;
  }
  if (password !== passwordConfirm) {
    const error = new Error("비밀번호 확인이 일치하지 않습니다.");
    error.statusCode = 400;
    throw error;
  }
  if (!phone) {
    const error = new Error("연락처를 입력하세요.");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error("이메일을 올바르게 입력하세요.");
    error.statusCode = 400;
    throw error;
  }
  if (!isConsentAccepted(payload.agreeTerms)) {
    const error = new Error("이용약관 동의가 필요합니다.");
    error.statusCode = 400;
    throw error;
  }
  if (!isConsentAccepted(payload.agreePrivacy)) {
    const error = new Error("개인정보 수집 및 이용 동의가 필요합니다.");
    error.statusCode = 400;
    throw error;
  }
  if (!isConsentAccepted(payload.confirmAge)) {
    const error = new Error("만 14세 이상 확인이 필요합니다.");
    error.statusCode = 400;
    throw error;
  }
  return { username, password };
}

function consentRecordFromRequest(req, acceptedAt) {
  const userAgent = String(req?.headers?.["user-agent"] || "");
  return {
    termsAccepted: true,
    termsVersion: TERMS_VERSION,
    privacyAccepted: true,
    privacyVersion: PRIVACY_VERSION,
    ageConfirmed: true,
    acceptedAt,
    ipHash: req ? clientIpHash(req) : "",
    userAgentHash: userAgent ? crypto.createHash("sha256").update(`ua:${userAgent}`).digest("hex") : ""
  };
}

async function registerB2BMember(payload = {}, context = {}) {
  const { username, password } = validateSignupPayload(payload);
  const store = await readB2BMemberStore();
  if (store.members.some((member) => normalizeLoginId(member.username) === username)) {
    const error = new Error("이미 가입된 아이디입니다.");
    error.statusCode = 409;
    throw error;
  }
  const now = new Date().toISOString();
  const member = {
    memberId: `m_${crypto.randomBytes(9).toString("base64url")}`,
    username,
    passwordHash: hashPassword(password),
    role: USER_ROLES.b2b,
    accountType: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastLoginAt: "",
    searchCount: 0,
    consents: consentRecordFromRequest(context.req, now),
    profile: memberProfileFromPayload(payload)
  };
  store.members.push(member);
  await writeB2BMemberStore(store);
  return { ...publicB2BMember(member), passwordHash: member.passwordHash };
}

async function authenticateB2BMember(username, password) {
  const normalized = normalizeLoginId(username);
  if (!normalized) return null;
  const store = await readB2BMemberStore();
  const member = store.members.find((item) => normalizeLoginId(item.username) === normalized);
  if (!member || member.status === "disabled" || !verifyPassword(password, member.passwordHash)) return null;
  member.lastLoginAt = new Date().toISOString();
  member.updatedAt = member.updatedAt || member.lastLoginAt;
  await writeB2BMemberStore(store);
  return {
    ...publicB2BMember(member),
    roleLabel: userRoleLabel(USER_ROLES.b2b)
  };
}

function emptyB2BSearchHistoryStore() {
  return {
    schemaVersion: 1,
    updatedAt: "",
    entries: []
  };
}

async function readB2BSearchHistoryStore() {
  for (const file of [B2B_SEARCH_HISTORY_FILE, LEGACY_B2B_SEARCH_HISTORY_FILE]) {
    try {
      const parsed = JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      return {
        ...emptyB2BSearchHistoryStore(),
        ...parsed,
        entries: Array.isArray(parsed.entries) ? parsed.entries : []
      };
    } catch {
      // Try the next known location before falling back to an empty store.
    }
  }
  return emptyB2BSearchHistoryStore();
}

async function writeB2BSearchHistoryStore(store) {
  await fsp.mkdir(CUSTOMER_DB_DIR, { recursive: true });
  const next = {
    ...emptyB2BSearchHistoryStore(),
    ...store,
    updatedAt: new Date().toISOString(),
    entries: Array.isArray(store.entries) ? store.entries : []
  };
  const tempPath = `${B2B_SEARCH_HISTORY_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fsp.rename(tempPath, B2B_SEARCH_HISTORY_FILE);
  return next;
}

function clientIpHash(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const raw = forwarded || req.socket?.remoteAddress || "";
  return raw ? crypto.createHash("sha256").update(`ip:${raw}`).digest("hex") : "";
}

function publicB2BSearchHistoryEntry(entry = {}) {
  return {
    id: entry.id || "",
    runId: entry.runId || "",
    keyword: entry.keyword || "",
    runLabel: entry.runLabel || "",
    regionLabel: entry.regionLabel || "",
    checkIn: entry.checkIn || "",
    checkOut: entry.checkOut || "",
    detailRankRanges: entry.detailRankRanges || "",
    collectionMode: entry.collectionMode || "",
    collectionModeLabel: entry.collectionModeLabel || "",
    bookingRangeDays: entry.bookingRangeDays || 0,
    status: entry.status || "completed",
    createdAt: entry.createdAt || "",
    completedAt: entry.completedAt || "",
    resultSummary: entry.resultSummary || {}
  };
}

function memberMatchesSession(entry = {}, session = {}) {
  if (!session) return false;
  if (entry.memberId && session.memberId) return entry.memberId === session.memberId;
  return normalizeLoginId(entry.username) === normalizeLoginId(session.username);
}

async function publicB2BSearchHistoryForSession(session, limit = 20) {
  const store = await readB2BSearchHistoryStore();
  const entries = normalizeUserRole(session?.role) === USER_ROLES.admin
    ? store.entries
    : store.entries.filter((entry) => memberMatchesSession(entry, session));
  return {
    entries: entries
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(publicB2BSearchHistoryEntry)
  };
}

function b2bSearchResultSummary(data = {}) {
  const items = data.availability?.items || [];
  const stats = data.availability?.stats || {};
  return {
    exposureSampleCount: Number(data.ranking?.items?.length || data.ranking?.rankedItems?.length || items.length || 0),
    companyCount: Number(items.length || 0),
    revenueSampleCount: Number(stats.revenueSampleCount || 0),
    averageRevenue: Number(stats.averageAdjustedEstimatedRevenue || 0),
    soldOutRate: Number(stats.weightedSoldOutRate || 0)
  };
}

async function appendB2BSearchHistory({ session, req, payload, runId, data, crawlTiming }) {
  const now = new Date().toISOString();
  const store = await readB2BSearchHistoryStore();
  const entry = {
    id: `s_${crypto.randomBytes(9).toString("base64url")}`,
    memberId: session?.memberId || "",
    username: session?.username || "",
    accountType: session?.accountType || (session?.username === B2B_USERNAME ? "demo" : "member"),
    role: USER_ROLES.b2b,
    ipHash: clientIpHash(req),
    sessionHash: session?.id ? crypto.createHash("sha256").update(`session:${session.id}`).digest("hex") : "",
    keyword: payload.keyword || "",
    checkIn: payload.checkIn || "",
    checkOut: payload.checkOut || "",
    detailRankRanges: payload.detailRankRanges || "",
    collectionMode: payload.collectionMode || "",
    collectionModeLabel: COLLECTION_MODES[payload.collectionMode] || "",
    bookingRangeDays: payload.bookingRangeDays || 0,
    bookingRangePlaceLimit: payload.bookingRangePlaceLimit || 0,
    runId,
    runLabel: data?.run?.label || payload.keyword || runId,
    regionLabel: data?.run?.provinceLabel || "",
    status: "completed",
    createdAt: now,
    completedAt: now,
    crawlTiming: crawlTiming || null,
    resultSummary: b2bSearchResultSummary(data)
  };
  store.entries.push(entry);
  await writeB2BSearchHistoryStore(store);

  if (session?.memberId) {
    const memberStore = await readB2BMemberStore();
    const member = memberStore.members.find((item) => item.memberId === session.memberId);
    if (member) {
      member.searchCount = Number(member.searchCount || 0) + 1;
      member.updatedAt = now;
      await writeB2BMemberStore(memberStore);
    }
  }

  return publicB2BSearchHistoryEntry(entry);
}

function summarizeTrafficApiCheck(result, configured) {
  if (!configured) {
    return {
      configured: false,
      ok: false,
      status: null,
      message: "API key is not configured."
    };
  }

  return {
    configured: true,
    ok: Boolean(result?.collectable),
    status: result?.status || null,
    message: result?.collectable
      ? "OK"
      : (result?.reason || result?.message || result?.errorMessage || "API verification failed.")
  };
}

async function verifyTrafficKeys() {
  const keys = await readTrafficKeys();
  const status = trafficKeyStatus(keys);
  const keyword = "글램핑";
  const datalabConfigured = Boolean(keys.naverClientId && keys.naverClientSecret);
  const searchadConfigured = Boolean(keys.searchadApiKey && keys.searchadSecretKey && keys.searchadCustomerId);

  const [datalabResult, searchadResult] = await Promise.all([
    datalabConfigured ? collectDatalabTrend(keyword, keys) : Promise.resolve(null),
    searchadConfigured ? collectSearchAdMetric(keyword, keys) : Promise.resolve(null)
  ]);

  return {
    ...status,
    verification: {
      checkedAt: new Date().toISOString(),
      keyword,
      datalab: summarizeTrafficApiCheck(datalabResult, datalabConfigured),
      searchad: summarizeTrafficApiCheck(searchadResult, searchadConfigured)
    }
  };
}

function timingSafeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index < 0) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function sessionCookie(value, maxAgeSeconds = SESSION_TTL_MS / 1000) {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value || "")}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    IS_PRODUCTION_RUNTIME ? "Secure" : "",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ].filter(Boolean).join("; ");
}

function clearSessionCookie() {
  return sessionCookie("", 0);
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!session || session.expiresAt <= now) sessions.delete(id);
  }
}

function normalizeUserRole(role) {
  return role === USER_ROLES.b2b ? USER_ROLES.b2b : USER_ROLES.admin;
}

function userRoleLabel(role) {
  return normalizeUserRole(role) === USER_ROLES.b2b ? "B2B" : "관리자";
}

function authenticatedUserForCredentials(username, password) {
  if (timingSafeTextEqual(username, ADMIN_USERNAME) && timingSafeTextEqual(password, ADMIN_PASSWORD)) {
    return { username: ADMIN_USERNAME, role: USER_ROLES.admin, roleLabel: userRoleLabel(USER_ROLES.admin) };
  }
  if (
    B2B_ENABLED
    && timingSafeTextEqual(username, B2B_USERNAME)
    && timingSafeTextEqual(password, B2B_PASSWORD)
  ) {
    return { username: B2B_USERNAME, role: USER_ROLES.b2b, roleLabel: userRoleLabel(USER_ROLES.b2b) };
  }
  return null;
}

function createSession(username, role = USER_ROLES.admin) {
  cleanupSessions();
  const id = crypto.randomBytes(32).toString("base64url");
  sessions.set(id, {
    username,
    role: normalizeUserRole(role),
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return id;
}

function getSession(req) {
  cleanupSessions();
  const id = parseCookies(req)[SESSION_COOKIE_NAME];
  if (!id) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { id, ...session };
}

function isAuthenticated(req) {
  return Boolean(getSession(req));
}

function publicSession(session) {
  if (!session) {
    return { authenticated: false, username: "", role: "", roleLabel: "" };
  }
  const role = normalizeUserRole(session.role);
  return {
    authenticated: true,
    username: session.username || "",
    role,
    roleLabel: userRoleLabel(role)
  };
}

function redirectPathForRole(role) {
  return normalizeUserRole(role) === USER_ROLES.b2b ? "/b2b" : "/admin";
}

function userRoleLabel(role) {
  return normalizeUserRole(role) === USER_ROLES.b2b ? "B2B" : "마스터";
}

async function authenticatedUserForCredentials(username, password) {
  if (timingSafeTextEqual(username, ADMIN_USERNAME) && timingSafeTextEqual(password, ADMIN_PASSWORD)) {
    return { username: ADMIN_USERNAME, role: USER_ROLES.admin, roleLabel: userRoleLabel(USER_ROLES.admin), accountType: "master" };
  }
  const member = await authenticateB2BMember(username, password);
  if (member) return member;
  if (
    B2B_ENABLED
    && timingSafeTextEqual(username, B2B_USERNAME)
    && timingSafeTextEqual(password, B2B_PASSWORD)
  ) {
    return { username: B2B_USERNAME, role: USER_ROLES.b2b, roleLabel: userRoleLabel(USER_ROLES.b2b), accountType: "demo" };
  }
  return null;
}

function createSession(username, role = USER_ROLES.admin, meta = {}) {
  cleanupSessions();
  const id = crypto.randomBytes(32).toString("base64url");
  sessions.set(id, {
    username,
    role: normalizeUserRole(role),
    memberId: meta.memberId || "",
    accountType: meta.accountType || (normalizeUserRole(role) === USER_ROLES.admin ? "master" : "member"),
    profile: meta.profile || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return id;
}

function publicSession(session) {
  if (!session) {
    return { authenticated: false, username: "", role: "", roleLabel: "", memberId: "", accountType: "", profile: null };
  }
  const role = normalizeUserRole(session.role);
  return {
    authenticated: true,
    username: session.username || "",
    role,
    roleLabel: userRoleLabel(role),
    memberId: session.memberId || "",
    accountType: session.accountType || (role === USER_ROLES.admin ? "master" : "member"),
    profile: session.profile || null
  };
}

function acceptsHtml(req) {
  return String(req.headers.accept || "").includes("text/html");
}

function escapeHtml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function policyContactHtml() {
  if (!PRIVACY_CONTACT_EMAIL) return "서비스 관리자";
  const escapedEmail = escapeHtml(PRIVACY_CONTACT_EMAIL);
  return `<a href="mailto:${escapedEmail}">${escapedEmail}</a>`;
}

function legalPage(title, eyebrow, sections) {
  const rows = sections.map((section) => `
    <section>
      <h2>${escapeHtml(section.title)}</h2>
      ${section.body}
    </section>`).join("");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Malgun Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f6f8; color: #101828; }
    main { width: min(100% - 32px, 860px); margin: 36px auto; padding: 30px; border: 1px solid #e4e7ec; border-radius: 24px; background: #fff; box-shadow: 0 18px 48px rgba(16, 24, 40, .10); }
    .eyebrow { margin: 0 0 8px; color: #175cd3; font-size: 13px; font-weight: 900; }
    h1 { margin: 0 0 10px; font-size: 30px; line-height: 1.2; letter-spacing: 0; }
    h2 { margin: 26px 0 10px; font-size: 18px; letter-spacing: 0; }
    p, li { color: #344054; font-size: 15px; line-height: 1.7; }
    ul { margin: 8px 0 0; padding-left: 20px; }
    a { color: #175cd3; font-weight: 900; text-decoration: none; }
    .meta { margin: 0 0 18px; color: #667085; font-size: 13px; font-weight: 700; }
    .back { display: inline-grid; place-items: center; min-height: 42px; margin-top: 24px; padding: 0 16px; border-radius: 12px; background: #3182f6; color: #fff; }
    @media (max-width: 560px) { main { margin-block: 18px; padding: 22px; } h1 { font-size: 25px; } }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">${escapeHtml(eyebrow)}</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">시행일 ${PRIVACY_VERSION.replace(/-/g, ".")} · 운영자 ${escapeHtml(SERVICE_OPERATOR_NAME)}</p>
    ${rows}
    <a class="back" href="/signup">회원가입으로 돌아가기</a>
  </main>
</body>
</html>`;
}

function termsPage() {
  return legalPage("글램핑데이터랩 사업자(개인) 이용약관", "필수 동의", [
    {
      title: "목적",
      body: "<p>이 약관은 글램핑데이터랩 사업자(개인) 서비스의 회원가입, 로그인, 경쟁 리포트 조회, 검색 이력 관리 및 관리자 검토 기능 이용 조건을 정합니다.</p>"
    },
    {
      title: "서비스의 성격",
      body: "<p>서비스는 네이버 플레이스 노출, 네이버 예약 표본, 공개 가격·상품 정보, 검색 수요와 내부 보정 데이터를 결합해 지역 경쟁 리포트를 제공합니다. 자동 수집 및 추정 데이터는 의사결정 보조 자료이며 실제 매출, 예약률, 객실 수를 보증하지 않습니다.</p>"
    },
    {
      title: "회원가입과 계정 관리",
      body: "<p>회원은 가입 양식에 따라 계정 정보와 사업 관련 정보를 입력합니다. 회원은 본인 또는 소속 사업자가 관리 권한을 가진 정보만 입력해야 하며, 계정 공유·도용·허위 정보 입력으로 발생한 문제에 대한 책임은 회원에게 있습니다.</p>"
    },
    {
      title: "데이터 보관 구조",
      body: "<ul><li>마스터 DB: 관리자 검토와 보정이 완료된 업체 고유정보, 객실 수, 가격 기준, 채널 정보 등을 저장합니다.</li><li>고객 DB: 회원 계정, 숙소 또는 회사명, 숙박업소 보유 여부, 검색 이력, 동의 이력 등 회원별 이용 정보를 저장합니다.</li><li>가입 단계에서 입력한 정보는 고객 DB에 보관하며, 마스터 DB 보정값과는 분리해 관리합니다.</li></ul>"
    },
    {
      title: "회원의 의무",
      body: "<ul><li>서비스를 무단 자동화, 역분석, 과도한 요청, 제3자 권리 침해 목적으로 사용하지 않아야 합니다.</li><li>수집 결과를 외부에 제공할 때에는 원자료의 한계와 추정값임을 인지해야 합니다.</li><li>계정 정보가 유출되거나 부정 사용이 의심되면 즉시 운영자에게 알려야 합니다.</li></ul>"
    },
    {
      title: "서비스 변경과 제한",
      body: "<p>외부 플랫폼 구조, API 정책, 네트워크 상태, 운영 정책에 따라 일부 수집 항목이나 리포트 항목은 변경·중단될 수 있습니다. 과도한 사용, 부정 사용, 보안 위험이 확인되면 이용을 제한할 수 있습니다.</p>"
    },
    {
      title: "문의와 해지",
      body: `<p>회원은 계정 삭제, 정보 정정, 검색 이력 삭제를 운영자에게 요청할 수 있습니다. 문의: ${policyContactHtml()}</p>`
    }
  ]);
}

function privacyPage() {
  return legalPage("개인정보 수집 및 이용 안내", "필수 동의", [
    {
      title: "수집 목적",
      body: "<ul><li>사업자(개인) 회원 식별, 로그인, 검색 이력 묶음 제공</li><li>지역 경쟁 리포트 생성 및 회원별 최근 분석 관리</li><li>회원이 제출한 숙소 또는 회사 정보의 관리자 검토와 고객 DB 관리</li><li>서비스 안정성 확보, 부정 이용 방지, 문의 대응</li></ul>"
    },
    {
      title: "수집 항목",
      body: "<ul><li>필수: 아이디, 비밀번호 해시, 연락처, 이메일, 만 14세 이상 확인, 약관 및 개인정보 동의 이력</li><li>선택 입력: 숙소 또는 회사명, 숙박업소 보유 여부</li><li>자동 생성: 회원ID, 가입일, 최근 로그인, 검색 횟수, 검색 키워드, 검색 기간, 순위 범위, 실행 리포트 ID, IP 해시, 세션 해시, 브라우저 식별값 해시</li></ul>"
    },
    {
      title: "보관 위치",
      body: "<ul><li>마스터 DB: 운영 서버의 영구 저장소 내 company_master 영역에 보관합니다.</li><li>고객 DB: 운영 서버의 영구 저장소 내 customer_db 영역에 보관합니다.</li><li>로컬 개발 환경에서는 동일한 구조로 프로젝트 데이터 폴더 아래에 보관됩니다.</li></ul>"
    },
    {
      title: "보유 및 이용 기간",
      body: "<p>회원 정보와 검색 이력은 회원 탈퇴, 삭제 요청 또는 수집 목적 달성 시까지 보관합니다. 단, 관계 법령상 보존이 필요한 경우에는 해당 법령에서 정한 기간 동안 보관할 수 있습니다.</p>"
    },
    {
      title: "제3자 제공 및 처리위탁",
      body: "<p>회원 개인정보를 별도 동의 없이 제3자에게 판매하거나 제공하지 않습니다. 다만 서버 호스팅, API 연동, 보안·장애 대응 등 서비스 운영에 필요한 외부 인프라를 사용할 수 있으며, 세부 위탁·국외 처리 내용은 운영 환경 확정 시 최신 처리방침에 반영합니다.</p>"
    },
    {
      title: "정보주체의 권리",
      body: `<p>회원은 개인정보 열람, 정정, 삭제, 처리정지, 동의 철회를 요청할 수 있습니다. 운영자는 본인 확인 후 관련 법령에 따라 처리합니다. 문의: ${policyContactHtml()}</p>`
    },
    {
      title: "안전성 확보 조치",
      body: "<p>비밀번호는 평문이 아니라 PBKDF2-SHA256 해시로 저장합니다. 접속 IP와 브라우저 식별값은 원문 대신 해시로 저장하며, 관리자 권한과 B2B 권한을 분리해 접근 범위를 제한합니다.</p>"
    },
    {
      title: "동의 거부권",
      body: "<p>회원은 개인정보 수집 및 이용에 동의하지 않을 수 있습니다. 다만 필수 항목 동의를 거부하면 회원가입과 리포트 이용이 제한됩니다.</p>"
    }
  ]);
}

function forbiddenPage(message = "") {
  const escapedMessage = String(message || "접근 권한이 없습니다.").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>글램핑데이터랩 권한 없음</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Malgun Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #101828; }
    main { width: min(100% - 32px, 420px); padding: 30px; border: 1px solid #e4e7ec; border-radius: 24px; background: #fff; box-shadow: 0 18px 48px rgba(16, 24, 40, .10); }
    h1 { margin: 0 0 8px; font-size: 28px; font-weight: 900; letter-spacing: 0; }
    p { margin: 0 0 22px; color: #667085; line-height: 1.45; }
    a, button { display: inline-grid; place-items: center; width: 100%; min-height: 50px; border: 0; border-radius: 16px; background: #3182f6; color: #fff; font: inherit; font-weight: 900; text-decoration: none; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>접근 권한 없음</h1>
    <p>${escapedMessage}</p>
    <a href="/">분석 화면으로 이동</a>
  </main>
</body>
</html>`;
}

function loginPage(message = "") {
  const escapedMessage = String(message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>글램핑데이터랩 로그인</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Malgun Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #101828; }
    main { width: min(100% - 32px, 420px); padding: 30px; border: 1px solid #e4e7ec; border-radius: 24px; background: #fff; box-shadow: 0 18px 48px rgba(16, 24, 40, .10); }
    h1 { margin: 0 0 8px; font-size: 28px; font-weight: 900; letter-spacing: 0; }
    p { margin: 0 0 22px; color: #667085; line-height: 1.45; }
    label { display: grid; gap: 8px; margin-top: 14px; font-size: 13px; font-weight: 800; color: #344054; }
    input { width: 100%; min-height: 52px; padding: 0 14px; border: 1px solid #d0d5dd; border-radius: 14px; font: inherit; font-size: 17px; outline: none; }
    input:focus { border-color: #3182f6; box-shadow: 0 0 0 4px rgba(49, 130, 246, .12); }
    button { width: 100%; min-height: 54px; margin-top: 20px; border: 0; border-radius: 16px; background: #3182f6; color: #fff; font: inherit; font-size: 17px; font-weight: 900; cursor: pointer; }
    button:disabled { opacity: .6; cursor: wait; }
    .link { display: block; margin-top: 14px; color: #175cd3; font-size: 13px; font-weight: 900; text-align: center; text-decoration: none; }
    .error { min-height: 20px; margin-top: 14px; color: #f04438; font-size: 13px; font-weight: 800; }
  </style>
</head>
<body>
  <main>
    <h1>글램핑데이터랩</h1>
    <p>계정 정보를 입력하면 분석 화면으로 이동합니다.</p>
    <form method="post" action="/login">
      <label>아이디<input name="username" autocomplete="username" autofocus required></label>
      <label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">로그인</button>
      <div class="error">${escapedMessage}</div>
    </form>
    <a class="link" href="/signup">회원가입</a>
  </main>
</body>
</html>`;
}

function signupPage(message = "", values = {}) {
  const escapedMessage = String(message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const value = (key) => String(values[key] || "").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const selected = (key) => normalizeOwnershipStatus(values.ownershipStatus || values.hasGlamping) === key ? " selected" : "";
  const checked = (key) => isConsentAccepted(values[key]) ? " checked" : "";
  const eyeIcon = `<svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.1 12s3.7-7 9.9-7 9.9 7 9.9 7-3.7 7-9.9 7-9.9-7-9.9-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg><span class="sr-only">누르는 동안 비밀번호 보기</span>`;
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>글램핑데이터랩 회원가입</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Malgun Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #101828; }
    main { width: min(100% - 32px, 640px); padding: 30px; border: 1px solid #e4e7ec; border-radius: 24px; background: #fff; box-shadow: 0 18px 48px rgba(16, 24, 40, .10); }
    h1 { margin: 0 0 20px; font-size: 28px; font-weight: 900; letter-spacing: 0; }
    p { margin: 0 0 18px; color: #667085; line-height: 1.45; }
    form { display: grid; gap: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
    .field-with-action { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .password-control { position: relative; display: block; }
    .password-control input { padding-right: 56px; }
    label { display: grid; gap: 7px; font-size: 13px; font-weight: 850; color: #344054; }
    label > span:first-child { display: flex; min-height: 18px; align-items: center; gap: 3px; }
    input, select, textarea { width: 100%; min-height: 48px; padding: 0 13px; border: 1px solid #d0d5dd; border-radius: 13px; font: inherit; outline: none; }
    input[type="checkbox"] { width: 18px; height: 18px; min-height: 0; margin: 2px 0 0; padding: 0; accent-color: #3182f6; }
    textarea { min-height: 82px; padding-block: 11px; resize: vertical; }
    input:focus, select:focus, textarea:focus { border-color: #3182f6; box-shadow: 0 0 0 4px rgba(49, 130, 246, .12); }
    button { width: 100%; min-height: 54px; border: 0; border-radius: 16px; background: #3182f6; color: #fff; font: inherit; font-size: 17px; font-weight: 900; cursor: pointer; }
    .inline-action { width: auto; min-width: 86px; min-height: 48px; padding: 0 14px; border: 1px solid #d0d5dd; border-radius: 13px; background: #fff; color: #175cd3; font-size: 13px; }
    .inline-action:hover { border-color: #3182f6; background: #eff6ff; }
    .icon-action { position: absolute; top: 4px; right: 5px; display: inline-grid; place-items: center; width: 40px; min-width: 40px; min-height: 40px; padding: 0; border: 0; border-radius: 11px; background: transparent; color: #344054; }
    .icon-action:hover, .icon-action:focus-visible, .icon-action[data-active="true"] { background: #eff6ff; color: #175cd3; }
    .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .error { min-height: 20px; color: #f04438; font-size: 13px; font-weight: 850; }
    .hint, .field-status { min-height: 18px; margin: 0; color: #667085; font-size: 12px; font-weight: 800; line-height: 1.35; }
    .field-status[data-state="ok"], .password-match[data-state="ok"] { color: #067647; }
    .field-status[data-state="error"], .password-match[data-state="error"] { color: #d92d20; }
    .agreements { display: grid; gap: 8px; padding: 14px; border: 1px solid #e4e7ec; border-radius: 16px; background: #f9fafb; }
    .check { display: grid; grid-template-columns: auto 1fr auto; align-items: start; gap: 10px; color: #182230; font-size: 13px; line-height: 1.4; }
    .check a { color: #175cd3; font-weight: 900; text-decoration: none; }
    .password-match { min-height: 18px; color: #667085; font-size: 12px; font-weight: 800; line-height: 1.35; }
    .required { color: #f04438; font-weight: 900; }
    .link { display: block; margin-top: 14px; color: #175cd3; font-size: 13px; font-weight: 900; text-align: center; text-decoration: none; }
    @media (max-width: 560px) {
      main { padding: 22px; }
      .grid { grid-template-columns: 1fr; }
      .field-with-action { grid-template-columns: 1fr; }
      .inline-action { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <h1>회원가입</h1>
    <form method="post" action="/signup" data-signup-form>
      <label>
        <span>아이디 <b class="required">*</b></span>
        <span class="field-with-action">
          <input name="username" autocomplete="username" required value="${value("username")}" data-username>
          <button class="inline-action" type="button" data-check-username>중복 확인</button>
        </span>
        <small class="field-status" data-username-status aria-live="polite"></small>
      </label>
      <div class="grid">
        <label><span>비밀번호 <b class="required">*</b></span><span class="password-control"><input name="password" type="password" autocomplete="new-password" required data-password><button class="icon-action" type="button" data-hold-password aria-label="누르는 동안 비밀번호 보기" title="누르는 동안 보기">${eyeIcon}</button></span><small class="field-status" data-password-status>8자 이상 · 영문+숫자 · 대문자 또는 특수문자</small></label>
        <label><span>비밀번호 확인 <b class="required">*</b></span><input name="passwordConfirm" type="password" autocomplete="new-password" required data-password-confirm><small class="password-match" data-password-match aria-live="polite"></small></label>
      </div>
      <div class="grid">
        <label><span>연락처 <b class="required">*</b></span><input name="phone" autocomplete="tel" required value="${value("phone")}"></label>
        <label><span>이메일 <b class="required">*</b></span><input name="email" type="email" autocomplete="email" required value="${value("email")}" data-email><small class="field-status" data-email-status aria-live="polite"></small></label>
      </div>
      <div class="grid">
        <label>숙소 또는 회사명<input name="companyName" value="${value("companyName")}"></label>
        <label>숙박업소 보유 여부<select name="ownershipStatus">
          <option value="owned"${selected("owned")}>숙박업소 보유</option>
          <option value="planning"${selected("planning")}>오픈 준비 중</option>
          <option value="none"${selected("none")}>미보유 / 투자 검토</option>
          <option value="agency"${selected("agency")}>대행사 / 컨설턴트</option>
        </select></label>
      </div>
      <section class="agreements" aria-label="회원가입 필수 동의">
        <label class="check"><input type="checkbox" name="agreeTerms" value="1" required${checked("agreeTerms")}><span>(필수) 글램핑데이터랩 사업자(개인) 이용약관에 동의합니다.</span><a href="/terms" target="_blank" rel="noopener">보기</a></label>
        <label class="check"><input type="checkbox" name="agreePrivacy" value="1" required${checked("agreePrivacy")}><span>(필수) 개인정보 수집 및 이용에 동의합니다.</span><a href="/privacy" target="_blank" rel="noopener">보기</a></label>
        <label class="check"><input type="checkbox" name="confirmAge" value="1" required${checked("confirmAge")}><span>(필수) 만 14세 이상입니다.</span><span></span></label>
      </section>
      <p class="hint"><b class="required">*</b> 표시 항목은 필수 입력입니다.</p>
      <button type="submit">가입하고 시작</button>
      <div class="error">${escapedMessage}</div>
    </form>
    <a class="link" href="/login">이미 계정이 있습니다</a>
  </main>
  <script src="/signup.js" defer></script>
</body>
</html>`;
}

function signupScript() {
  return `"use strict";
(() => {
  const form = document.querySelector("[data-signup-form]");
  if (!form) return;
  const username = form.querySelector("[data-username]");
  const usernameButton = form.querySelector("[data-check-username]");
  const usernameStatus = form.querySelector("[data-username-status]");
  const password = form.querySelector("[data-password]");
  const confirm = form.querySelector("[data-password-confirm]");
  const passwordStatus = form.querySelector("[data-password-status]");
  const matchStatus = form.querySelector("[data-password-match]");
  const email = form.querySelector("[data-email]");
  const emailStatus = form.querySelector("[data-email-status]");
  if (!username || !password || !confirm || !matchStatus) return;

  let checkedUsername = "";
  let usernameAvailable = false;

  const setStatus = (element, text, state = "") => {
    if (!element) return;
    element.textContent = text;
    element.dataset.state = state;
  };

  const passwordPolicyMessage = (value) => {
    if (!value) return "8자 이상 · 영문+숫자 · 대문자 또는 특수문자";
    if (value.length < 8) return "비밀번호는 8자 이상이어야 합니다.";
    if (!/[A-Za-z]/.test(value) || !/\\d/.test(value)) return "영문과 숫자를 함께 포함해야 합니다.";
    if (!(/[A-Z]/.test(value) || /[^A-Za-z0-9]/.test(value))) return "대문자 또는 특수문자를 포함해야 합니다.";
    return "";
  };

  const updatePassword = () => {
    const left = password.value;
    const right = confirm.value;
    const passwordMessage = passwordPolicyMessage(left);
    if (passwordMessage) {
      setStatus(passwordStatus, passwordMessage, left ? "error" : "");
      password.setCustomValidity(left ? passwordMessage : "");
    } else {
      setStatus(passwordStatus, "사용 가능한 비밀번호입니다.", "ok");
      password.setCustomValidity("");
    }
    if (!left && !right) {
      setStatus(matchStatus, "", "");
      confirm.setCustomValidity("");
      return;
    }
    if (!right) {
      setStatus(matchStatus, "비밀번호를 한 번 더 입력하세요.", "");
      confirm.setCustomValidity("");
      return;
    }
    if (left === right) {
      setStatus(matchStatus, "비밀번호가 일치합니다.", "ok");
      confirm.setCustomValidity("");
      return;
    }
    setStatus(matchStatus, "비밀번호가 일치하지 않습니다.", "error");
    confirm.setCustomValidity("비밀번호 확인이 일치하지 않습니다.");
  };

  const updateEmail = () => {
    if (!email || !emailStatus) return;
    const value = email.value.trim();
    if (!value) {
      setStatus(emailStatus, "", "");
      email.setCustomValidity("");
      return;
    }
    if (/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(value)) {
      setStatus(emailStatus, "올바른 이메일 형식입니다.", "ok");
      email.setCustomValidity("");
      return;
    }
    setStatus(emailStatus, "이메일 형식을 확인하세요.", "error");
    email.setCustomValidity("이메일 형식을 확인하세요.");
  };

  const resetUsernameCheck = () => {
    checkedUsername = "";
    usernameAvailable = false;
    username.setCustomValidity("");
    setStatus(usernameStatus, "아이디 중복 확인을 진행하세요.", "");
  };

  const checkUsername = async () => {
    const value = username.value.trim();
    if (!value) {
      setStatus(usernameStatus, "아이디를 입력하세요.", "error");
      username.setCustomValidity("아이디를 입력하세요.");
      return false;
    }
    if (usernameButton) {
      usernameButton.disabled = true;
      usernameButton.textContent = "확인 중";
    }
    try {
      const response = await fetch("/api/signup/check-username?username=" + encodeURIComponent(value), {
        headers: { Accept: "application/json" }
      });
      const data = await response.json();
      checkedUsername = data.username || value.toLowerCase();
      usernameAvailable = Boolean(data.available);
      setStatus(usernameStatus, data.message || (usernameAvailable ? "사용 가능한 아이디입니다." : "사용할 수 없는 아이디입니다."), usernameAvailable ? "ok" : "error");
      username.setCustomValidity(usernameAvailable ? "" : (data.message || "사용할 수 없는 아이디입니다."));
      return usernameAvailable;
    } catch {
      checkedUsername = "";
      usernameAvailable = false;
      setStatus(usernameStatus, "중복 확인에 실패했습니다. 다시 시도하세요.", "error");
      username.setCustomValidity("아이디 중복 확인이 필요합니다.");
      return false;
    } finally {
      if (usernameButton) {
        usernameButton.disabled = false;
        usernameButton.textContent = "중복 확인";
      }
    }
  };

  form.querySelectorAll("[data-hold-password]").forEach((button) => {
    const setVisible = (visible) => {
      const input = button.parentElement ? button.parentElement.querySelector("input") : null;
      if (!input) return;
      input.type = visible ? "text" : "password";
      button.dataset.active = visible ? "true" : "false";
      button.setAttribute("aria-pressed", visible ? "true" : "false");
    };
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      setVisible(true);
    });
    button.addEventListener("pointerup", () => setVisible(false));
    button.addEventListener("pointercancel", () => setVisible(false));
    button.addEventListener("pointerleave", () => setVisible(false));
    button.addEventListener("blur", () => setVisible(false));
    button.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        setVisible(true);
      }
    });
    button.addEventListener("keyup", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        setVisible(false);
      }
    });
  });

  if (usernameButton) usernameButton.addEventListener("click", checkUsername);
  username.addEventListener("input", resetUsernameCheck);
  password.addEventListener("input", updatePassword);
  confirm.addEventListener("input", updatePassword);
  if (email) email.addEventListener("input", updateEmail);
  form.addEventListener("submit", async (event) => {
    updatePassword();
    updateEmail();
    const normalizedUsername = username.value.trim().toLowerCase();
    if (!usernameAvailable || checkedUsername !== normalizedUsername) {
      event.preventDefault();
      const ok = await checkUsername();
      if (ok && form.reportValidity()) form.requestSubmit();
    }
  });
  updatePassword();
  updateEmail();
  if (username.value.trim()) resetUsernameCheck();
})();`;
}

function sendLogin(res, status = 200, message = "") {
  return send(res, status, loginPage(message), "text/html; charset=utf-8");
}

function requireLogin(req, res, reqUrl) {
  if (isAuthenticated(req)) return true;
  if (req.method === "GET" && acceptsHtml(req)) {
    sendLogin(res, 200);
  } else if (req.method === "HEAD") {
    sendHead(res, 401);
  } else {
    send(res, 401, { error: "로그인이 필요합니다." });
  }
  return false;
}

function sendForbidden(req, res, message = "관리자 권한이 필요합니다.") {
  if (req.method === "HEAD") return sendHead(res, 403);
  if (acceptsHtml(req)) return send(res, 403, forbiddenPage(message), "text/html; charset=utf-8");
  return send(res, 403, { error: message });
}

function requireAdminSession(session, req, res) {
  if (normalizeUserRole(session?.role) === USER_ROLES.admin) return true;
  sendForbidden(req, res);
  return false;
}

function securityHeaders() {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "font-src 'self' data: https://cdn.jsdelivr.net",
      "img-src 'self' data:",
      "connect-src 'self' https://cdn.jsdelivr.net",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ")
  };

  if (IS_PRODUCTION_RUNTIME) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  return headers;
}

function send(res, status, body, contentType = "application/json; charset=utf-8", extraHeaders = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(payload);
}

function sendHead(res, status, contentType = "application/json; charset=utf-8", extraHeaders = {}) {
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end();
}

function notFound(res) {
  send(res, 404, { error: "Not found" });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });
    req.on("end", () => {
      resolve(body);
    });
  });
}

async function parseJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

async function parseLoginBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  if (String(req.headers["content-type"] || "").includes("application/json")) {
    return JSON.parse(body);
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, decoded.replace(/^[/\\]+/, ""));
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function detectProvince(idOrName) {
  if (idOrName.includes("gyeonggi_south")) return "gyeonggi_south";
  if (idOrName.includes("jeonbuk")) return "jeonbuk";
  if (idOrName.includes("chungnam")) return "chungnam";
  if (idOrName.includes("chungbuk")) return "chungbuk";
  if (idOrName.includes("gyeongbuk")) return "gyeongbuk";
  if (idOrName.includes("gyeongnam")) return "gyeongnam";
  if (idOrName.includes("gyeonggi") || idOrName.includes("pocheon")) return "gyeonggi";
  return "local";
}

function provinceKeyForRun(dirName, manifest) {
  return manifest?.provinceKey && PROVINCES[manifest.provinceKey] ? manifest.provinceKey : detectProvince(dirName);
}

function displayNameForRun(dirName, manifest = null) {
  const province = PROVINCES[provinceKeyForRun(dirName, manifest)] || PROVINCES.local;
  const keyword = manifest?.keyword || province.keyword;
  const modePrefix = manifest?.searchMode === "company" || manifest?.keywordType === "company" ? "업체명 · " : "";
  const date = dirName.match(/(\d{8})/)?.[1] || "";
  return `${modePrefix}${keyword}${date ? ` · ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : ""}`;
}

async function readRunConditions(dirPath, manifest, reportFile) {
  const result = {
    checkIn: manifest?.checkIn || "",
    checkOut: manifest?.checkOut || "",
    adults: manifest?.adults || "",
    productMode: manifest?.productMode || ""
  };
  if ((result.checkIn && result.checkOut && result.adults) || !reportFile) return result;

  try {
    const report = await fsp.readFile(path.join(dirPath, reportFile), "utf8");
    const match = report.match(/성인\s*(\d+)명,\s*1박,\s*체크인\s*(\d{4}-\d{2}-\d{2})\s*\/\s*체크아웃\s*(\d{4}-\d{2}-\d{2})/);
    if (match) {
      result.adults ||= Number(match[1]);
      result.checkIn ||= match[2];
      result.checkOut ||= match[3];
    }
  } catch {
    // Older runs may not have a report file; keep form defaults in that case.
  }
  return result;
}

async function readManifest(dirPath) {
  try {
    return JSON.parse(await fsp.readFile(path.join(dirPath, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function manifestFile(manifest, role, files, legacyMatcher) {
  const candidate = manifest?.fileRoles?.[role];
  if (candidate && files.includes(candidate)) return candidate;
  return files.find(legacyMatcher);
}

function safeFilePart(value, fallback = "검색") {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || fallback).slice(0, 80);
}

function downloadLabelForFile(file, manifest = {}) {
  const roles = manifest.fileRoles || {};
  const role = Object.entries(roles).find(([, name]) => name === file)?.[0];
  const labels = {
    platform: "플랫폼 통합 결과",
    report: "수집 리포트",
    overall: "네이버 전체 순위",
    ads: "네이버 광고 순위",
    regional: "네이버 지역별 순위",
    ddnayo: "떠나요 검색 결과",
    workbook: "전체 수집 결과",
    naverWorkbook: "네이버 순위 통합",
    yeogiManual: "여기어때 수동 보완"
  };
  if (role && labels[role]) return labels[role];
  if (/_glamping_crawl_test_report\.md$/i.test(file)) return "수집 리포트";
  if (/_glamping_crawl_test\.csv$/i.test(file)) return "플랫폼 통합 결과";
  if (/_overall_place_rank\.csv$/i.test(file)) return "네이버 전체 순위";
  if (/_ad_place_list\.csv$/i.test(file)) return "네이버 광고 순위";
  if (/_naver_place_glamping_clusters\.csv$/i.test(file)) return "네이버 지역별 순위";
  if (/_ddnayo_search_results\.csv$/i.test(file)) return "떠나요 검색 결과";
  if (/_glamping_crawl_results\.xlsx$/i.test(file)) return "전체 수집 결과";
  if (/_naver_place_glamping_clusters_with_overall\.xlsx$/i.test(file)) return "네이버 순위 통합";
  if (/_yeogi_manual_import\.csv$/i.test(file)) return "여기어때 수동 보완";
  return file;
}

async function listRuns() {
  await fsp.mkdir(OUTPUTS_DIR, { recursive: true });
  const entries = await fsp.readdir(OUTPUTS_DIR, { withFileTypes: true });
  const runs = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !/_glamping_\d{8}(?:_\d{6})?$/.test(entry.name)) continue;
    const dirPath = path.join(OUTPUTS_DIR, entry.name);
    const files = await fsp.readdir(dirPath).catch(() => []);
    const manifest = await readManifest(dirPath);
    if (!manifest && files.length === 0) continue;
    if (manifest && /^\?+$/.test(String(manifest.keyword || "").trim())) continue;
    const stat = await fsp.stat(dirPath);
    const provinceKey = provinceKeyForRun(entry.name, manifest);

    runs.push({
      id: entry.name,
      label: displayNameForRun(entry.name, manifest),
      keyword: manifest?.keyword || (PROVINCES[provinceKey] || PROVINCES.local).keyword || "",
      searchKeyword: manifest?.searchKeyword || "",
      naverKeyword: manifest?.naverKeyword || "",
      keywordType: manifest?.keywordType || "province",
      searchMode: manifest?.searchMode || (manifest?.keywordType === "company" ? "company" : "keyword"),
      searchModeLabel: SEARCH_MODES[manifest?.searchMode] || (manifest?.keywordType === "company" ? SEARCH_MODES.company : SEARCH_MODES.keyword),
      collectionMode: manifest?.collectionMode || "precision",
      collectionModeLabel: manifest?.collectionModeLabel || COLLECTION_MODES[manifest?.collectionMode] || COLLECTION_MODES.precision,
      sourceRole: sourceRoleForCollectionSource(manifest?.collectionSource, manifest?.sourceRole || USER_ROLES.admin),
      collectionSource: normalizeCollectionSource(manifest?.collectionSource, manifest?.sourceRole || USER_ROLES.admin),
      collectionSourceLabel: manifest?.collectionSourceLabel || collectionSourceLabel(normalizeCollectionSource(manifest?.collectionSource, manifest?.sourceRole || USER_ROLES.admin)),
      detailRankRanges: manifest?.detailRankRanges || "",
      bookingRangeDays: manifest?.bookingRangeDays || 1,
      bookingRangePlaceLimit: manifest?.bookingRangePlaceLimit || 0,
      checkIn: manifest?.checkIn || "",
      checkOut: manifest?.checkOut || "",
      province: provinceKey,
      provinceLabel: (PROVINCES[provinceKey] || PROVINCES.local).label,
      updatedAt: stat.mtime.toISOString(),
      counts: manifest?.counts || {},
      files: manifest?.files || files
    });
  }

  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeCollectionSource(value, role = USER_ROLES.admin) {
  const text = String(value || "").trim().toLowerCase();
  if (["b2b_search", "b2b"].includes(text)) return "b2b_search";
  if (["admin_search", "admin", "crawl"].includes(text)) return "admin_search";
  if (["backfill", "master_backfill"].includes(text)) return "master_backfill";
  return normalizeUserRole(role) === USER_ROLES.b2b ? "b2b_search" : "admin_search";
}

function sourceRoleForCollectionSource(collectionSource, role = USER_ROLES.admin) {
  const source = normalizeCollectionSource(collectionSource, role);
  if (source === "b2b_search") return USER_ROLES.b2b;
  return normalizeUserRole(role);
}

function collectionSourceLabel(collectionSource) {
  return {
    admin_search: "관리자 수집",
    b2b_search: "B2B 검색",
    master_backfill: "마스터 백필"
  }[normalizeCollectionSource(collectionSource)] || "관리자 수집";
}

const B2B_PRIVATE_FIELD_KEYS = new Set([
  "sourceKey",
  "placeId",
  "place_id",
  "bookingBusinessId",
  "bookingBusinessIds",
  "placeIds",
  "companyId",
  "companyProfile",
  "companyMaster",
  "companyMasterOverlay",
  "manualCorrection",
  "manualCorrectionHistory",
  "companyManualCorrection",
  "manualCorrectionApplied",
  "adminReview",
  "adminReviewHistory",
  "salesContact",
  "salesContactHistory",
  "duplicateCandidates",
  "sourceIndex",
  "sourceRoles",
  "collectionSources",
  "sourceStats",
  "downloads",
  "files",
  "file",
  "history",
  "urls",
  "url"
]);

function stripB2BPrivateFields(value) {
  if (Array.isArray(value)) {
    value.forEach(stripB2BPrivateFields);
    return value;
  }
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    if (B2B_PRIVATE_FIELD_KEYS.has(key)) {
      delete value[key];
    } else {
      stripB2BPrivateFields(value[key]);
    }
  }
  return value;
}

function publicRunsForRole(runs = [], role = USER_ROLES.admin) {
  if (normalizeUserRole(role) === USER_ROLES.admin) return runs;
  return [];
}

function publicRunForRole(runData, role = USER_ROLES.admin) {
  if (normalizeUserRole(role) === USER_ROLES.admin || !runData) return runData;
  const copy = cloneJson(runData);
  return stripB2BPrivateFields(copy);
}

function b2bSearchPayload(value = {}) {
  const keyword = String(value.keyword || value.query || "").trim();
  if (!keyword) {
    const error = new Error("검색어를 입력해야 합니다.");
    error.statusCode = 400;
    throw error;
  }
  return {
    keyword,
    checkIn: value.checkIn || kstDate(0),
    checkOut: value.checkOut || kstDate(6),
    searchMode: "keyword",
    productMode: normalizeProductMode(value.productMode || "all"),
    collectionMode: normalizeCollectionMode(value.collectionMode || "precision"),
    detailRankRanges: String(value.detailRankRanges || "1-10").trim() || "1-10",
    bookingRangeDays: Number(value.bookingRangeDays) || 7,
    bookingRangePlaceLimit: Number(value.bookingRangePlaceLimit) || 10,
    sourceRole: USER_ROLES.b2b,
    collectionSource: "b2b_search"
  };
}

function b2bMyLodgePayload(value = {}) {
  const lodgingName = String(value.lodgingName || value.companyName || value.keyword || value.query || "").trim();
  if (!lodgingName) {
    const error = new Error("숙소명을 입력해야 수집할 수 있습니다.");
    error.statusCode = 400;
    throw error;
  }
  const rawBookingRangeDays = Number(value.bookingRangeDays);
  const bookingRangeDays = Math.max(1, Math.min(31, Math.round(Number.isFinite(rawBookingRangeDays) ? rawBookingRangeDays : 7)));
  return {
    keyword: lodgingName,
    checkIn: value.checkIn || kstDate(0),
    checkOut: value.checkOut || kstDate(Math.max(1, bookingRangeDays) - 1),
    searchMode: "company",
    productMode: normalizeProductMode(value.productMode || "all"),
    collectionMode: normalizeCollectionMode(value.collectionMode || "precision"),
    detailRankRanges: String(value.detailRankRanges || "1-5").trim() || "1-5",
    bookingRangeDays,
    bookingRangePlaceLimit: Math.max(1, Math.min(5, Math.round(Number(value.bookingRangePlaceLimit) || 3))),
    sourceRole: USER_ROLES.b2b,
    collectionSource: "b2b_search"
  };
}

function b2bMyLodgeMatchScore(item = {}, targetName = "") {
  const name = String(item.name || item.companyName || item["업체명"] || "").trim();
  const candidate = companyPlatformKey(name);
  const target = companyPlatformKey(targetName);
  if (!candidate || !target) return 0;
  if (candidate === target) return 100;
  const looseCandidate = normalizeCompanyLooseName(name);
  const looseTarget = normalizeCompanyLooseName(targetName);
  if (looseCandidate && looseTarget && looseCandidate === looseTarget) return 96;
  if (target.includes(candidate) && candidate.length >= 3) return 90;
  if (candidate.includes(target) && target.length >= 3) return 86;
  if (looseCandidate && looseTarget && looseTarget.includes(looseCandidate) && looseCandidate.length >= 3) return 84;
  if (looseCandidate && looseTarget && looseCandidate.includes(looseTarget) && looseTarget.length >= 3) return 82;
  const tokens = String(targetName || "")
    .normalize("NFKC")
    .split(/\s+/)
    .map(companyPlatformKey)
    .filter((token) => token.length >= 2 && !["글램핑", "캠핑", "카라반", "리조트", "펜션"].includes(token));
  if (tokens.length && tokens.every((token) => candidate.includes(token))) return 72;
  return 0;
}

function b2bMyLodgeCandidateItems(data = {}, targetName = "") {
  const availabilityItems = Array.isArray(data?.availability?.items) ? data.availability.items : [];
  const rankingItems = Array.isArray(data?.ranking?.items) ? data.ranking.items : [];
  const rows = [
    ...availabilityItems.map((item, index) => ({ item, index, source: "availability" })),
    ...rankingItems.map((item, index) => ({ item, index, source: "ranking" }))
  ];
  const byKey = new Map();
  for (const row of rows) {
    const item = row.item || {};
    const key = item.bookingBusinessId || item.placeId || item.sourceKey || companyPlatformKey(item.name || item.companyName || "");
    if (!key) continue;
    const score = b2bMyLodgeMatchScore(item, targetName);
    const rank = Number(item.overallRank || item.rank || row.index + 1);
    const detailBonus = row.source === "availability" || item.hasInventory ? 12 : 0;
    const revenueBonus = Number(item.weeklyEstimatedRevenue || item.weeklyAdjustedRevenue || 0) > 0 ? 5 : 0;
    const rankBonus = Number.isFinite(rank) && rank > 0 ? Math.max(0, 6 - Math.min(5, rank)) : 0;
    const weightedScore = score + detailBonus + revenueBonus + rankBonus;
    const next = {
      item,
      name: item.name || item.companyName || "",
      score: weightedScore,
      matchScore: score,
      source: row.source,
      rank: Number.isFinite(rank) ? rank : null
    };
    const prev = byKey.get(key);
    if (!prev || next.score > prev.score) byKey.set(key, next);
  }
  return [...byKey.values()]
    .filter((row) => row.matchScore > 0 || byKey.size === 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function runB2BSearch(payload = {}, context = {}) {
  const crawlPayload = b2bSearchPayload(payload);
  const result = await runCrawler(crawlPayload);
  const runId = result?.runId || "";
  if (!runId) {
    const error = new Error("검색 결과를 저장하지 못했습니다.");
    error.statusCode = 500;
    throw error;
  }
  const data = await loadRun(runId, { skipCompanyMaster: true, skipHistory: true, applyCompanyMaster: true });
  if (!data) {
    const error = new Error("검색 결과를 불러오지 못했습니다.");
    error.statusCode = 500;
    throw error;
  }
  const searchHistory = context.session
    ? await appendB2BSearchHistory({
        session: context.session,
        req: context.req,
        payload: crawlPayload,
        runId,
        data,
        crawlTiming: result.crawlTiming || null
      })
    : null;
  return {
    ok: true,
    runId,
    data: publicRunForRole(data, USER_ROLES.b2b),
    crawlTiming: result.crawlTiming || null,
    searchHistory
  };
}

async function runB2BMyLodgeCollection(payload = {}) {
  const crawlPayload = b2bMyLodgePayload(payload);
  const result = await runCrawler(crawlPayload);
  const runId = result?.runId || "";
  if (!runId) {
    const error = new Error("관심숙소 수집 결과를 저장하지 못했습니다.");
    error.statusCode = 500;
    throw error;
  }
  const data = await loadRun(runId, { skipCompanyMaster: true, skipHistory: true, applyCompanyMaster: true });
  if (!data) {
    const error = new Error("관심숙소 수집 결과를 불러오지 못했습니다.");
    error.statusCode = 500;
    throw error;
  }
  const candidates = b2bMyLodgeCandidateItems(data, crawlPayload.keyword);
  const publicCandidates = publicRunForRole({ items: candidates.map((row) => row.item) }, USER_ROLES.b2b)?.items || [];
  const candidateItems = publicCandidates.map((item, index) => ({
    ...item,
    matchScore: candidates[index]?.matchScore || 0,
    matchName: candidates[index]?.name || "",
    matchSource: candidates[index]?.source || "",
    matchRank: candidates[index]?.rank || null
  }));
  return {
    ok: true,
    runId,
    keyword: crawlPayload.keyword,
    selectedItem: candidateItems[0] || null,
    candidateItems,
    selectedSummary: candidates[0]
      ? {
          name: candidates[0].name || "",
          matchScore: candidates[0].matchScore || 0,
          rank: candidates[0].rank || null,
          source: candidates[0].source || ""
        }
      : null,
    crawlTiming: result.crawlTiming || null
  };
}

async function seedOutputsFromRepo() {
  const source = path.resolve(REPO_OUTPUTS_DIR);
  const target = path.resolve(OUTPUTS_DIR);
  if (process.env.SEED_OUTPUTS_FROM_REPO === "0" || source === target || !fs.existsSync(source)) return;

  await fsp.mkdir(target, { recursive: true });
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/_glamping_\d{8}(?:_\d{6})?$/.test(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (fs.existsSync(to)) continue;
    await fsp.cp(from, to, { recursive: true });
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function writeCsv(filePath, rows, columns) {
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))
  ];
  await fsp.writeFile(filePath, `\uFEFF${lines.join("\n")}`, "utf8");
}

function csvHeaderLine(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/, 1)[0]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function orderedColumns(rows, preferred = []) {
  const seen = new Set();
  const columns = [];
  for (const column of preferred) {
    if (!seen.has(column)) {
      seen.add(column);
      columns.push(column);
    }
  }
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
  }
  return columns;
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToLines(text) {
  const cleaned = decodeHtmlEntities(String(text || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "\n")
    .replace(/<(br|p|li|div|article|section|a|span|strong|em|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/\r/g, "\n");
  return cleaned
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const YEOGI_CATEGORY_RE = /(?:풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)/i;
const YEOGI_CATEGORY_START_RE = /^(?:풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)\s*/i;
const YEOGI_PRICE_RE = /(?:\d{1,3},)*\d{1,3}\s*원\s*~?|(?:\d{1,3},)+\d{3}/g;

function yeogiTextLines(text) {
  const categoryBreakRe = /(원|개|확인|마감|매진)(풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)(?=[가-힣A-Za-z0-9★\[])/g;
  return htmlToLines(text)
    .flatMap((line) => line.replace(categoryBreakRe, "$1\n$2").split(/\n+/))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function yeogiLowestPrice(text) {
  const matches = String(text || "").match(YEOGI_PRICE_RE) || [];
  const values = matches
    .map((item) => Number(String(item).replace(/[^\d]/g, "")))
    .filter((value) => Number.isFinite(value) && value >= 10000);
  if (!values.length) return matches[0] || "";
  return `${Math.min(...values).toLocaleString("ko-KR")}원`;
}

function yeogiLocationFromText(text) {
  const match = String(text || "").match(/[가-힣]{2,20}(?:시|군|구|읍|면|동)/);
  if (!match) return { value: "", index: -1 };
  const raw = match[0];
  const afterLodgingWord = raw.match(/.*(?:글램핑|캠핑|카라반|펜션|풀빌라|리조트|스파|호텔|빌라)([가-힣]{2,6}(?:시|군|구|읍|면|동))$/)?.[1];
  const suffix = afterLodgingWord || raw.match(/[가-힣]{2,4}(?:시|군|구|읍|면|동)$/)?.[0] || raw;
  return { value: suffix, index: (match.index || 0) + raw.lastIndexOf(suffix) };
}

function cleanYeogiName(value) {
  return String(value || "")
    .replace(YEOGI_CATEGORY_START_RE, "")
    .replace(/^(?:Image|이미지|대표 사진|광고)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseYeogiCompactLine(line) {
  const text = String(line || "").replace(/\s+/g, " ").trim();
  if (!YEOGI_CATEGORY_RE.test(text)) return null;
  if (!/글램핑|캠핑|카라반|펜션|풀빌라|리조트|호텔|스테이|빌리지|캠프|camp|glamp/i.test(text)) return null;

  const category = text.match(YEOGI_CATEGORY_RE)?.[0] || "숙박";
  const body = text.replace(YEOGI_CATEGORY_START_RE, "");
  const locationInfo = yeogiLocationFromText(body);
  const location = locationInfo.value;
  const price = yeogiLowestPrice(text);
  const ratingMatch = text.match(/(\d(?:\.\d)?)(?:\s*)?([\d,]+)명\s*평가/);
  const rating = ratingMatch?.[1] || "";
  const reviews = ratingMatch?.[2] ? `${ratingMatch[2]}명 평가` : "";

  let nameSource = body;
  if (location && locationInfo.index > 0) nameSource = body.slice(0, locationInfo.index);
  else {
    const stop = body.search(/(?:\d(?:\.\d)?\s*[\d,]+명\s*평가|반짝특가|타임특가|쿠폰|숙박|대실|다른 날짜 확인|[\d,]+\s*원)/);
    if (stop > 0) nameSource = body.slice(0, stop);
  }

  const name = cleanYeogiName(nameSource);
  if (!name || name.length < 2 || name.length > 80) return null;

  const soldOut = /예약마감|예약완료|마감|매진|품절|sold\s*out|unavailable|다른 날짜 확인/i.test(text);
  return {
    rank: "",
    name,
    category,
    location,
    rating,
    reviews,
    price,
    url: "",
    section: /^광고$|광고\s|^AD$/i.test(text) ? "광고" : "수동수집",
    adFlag: /^광고$|광고\s|^AD$/i.test(text) ? "Y" : "확인불가",
    reservationAvailable: soldOut ? "N" : price ? "Y" : "확인불가",
    availabilityStatus: soldOut ? "예약마감/매진 문구 감지" : price ? "가격 노출" : "가격/매진 문구 미확인",
    raw: text.slice(0, 500)
  };
}

function findRowValue(row, keys) {
  for (const key of keys) {
    const foundKey = Object.keys(row).find((item) => item.replace(/^\uFEFF/, "").trim().toLowerCase() === key.toLowerCase());
    if (foundKey && String(row[foundKey] || "").trim()) return String(row[foundKey]).trim();
  }
  return "";
}

function normalizeImportedAd(value, section = "") {
  const text = `${value || ""} ${section || ""}`;
  if (/\bY\b|광고/.test(text) && !/비광고/.test(text)) return "Y";
  if (/\bN\b|비광고/.test(text)) return "N";
  return "확인불가";
}

function normalizeImportedSection(value, adFlag) {
  const text = String(value || "");
  if (text.includes("광고") && !text.includes("비광고")) return "광고";
  if (text.includes("비광고")) return "비광고";
  if (adFlag === "Y") return "광고";
  if (adFlag === "N") return "비광고";
  return "수동수집";
}

function normalizeReservationAvailable(value, price = "", raw = "") {
  const text = `${value || ""} ${price || ""} ${raw || ""}`;
  if (/예약마감|예약완료|마감|매진|품절|sold\s*out|unavailable|\bN\b/i.test(text)) return "N";
  if (/예약가능|가능|available|\bY\b/i.test(text)) return "Y";
  if (/[\d,]+\s*원/.test(text) || /\d+/.test(String(price || ""))) return "Y";
  return "확인불가";
}

function parseYeogiCsvImport(text) {
  const rows = parseCsv(String(text || "").replace(/^\uFEFF/, ""));
  return rows
    .map((row, index) => {
      const section = findRowValue(row, ["section", "구분", "상태", "수집상태"]);
      const adFlag = normalizeImportedAd(findRowValue(row, ["ad_flag", "ad", "광고여부", "광고 여부"]), section);
      const price = findRowValue(row, ["price", "가격", "최저가"]);
      const raw = findRowValue(row, ["raw", "원문"]);
      const reservationAvailable = normalizeReservationAvailable(
        findRowValue(row, ["reservation_available", "예약가능", "예약 가능", "예약가능추정"]),
        price,
        raw,
      );
      return {
        rank: findRowValue(row, ["rank", "rank_or_order", "순위"]) || String(index + 1),
        name: findRowValue(row, ["name", "업체명", "숙소명", "상품명", "title"]),
        category: findRowValue(row, ["category", "카테고리", "유형"]),
        location: findRowValue(row, ["location", "주소", "지역"]),
        rating: findRowValue(row, ["rating", "평점"]),
        reviews: findRowValue(row, ["reviews", "리뷰", "후기"]),
        price,
        url: findRowValue(row, ["url", "상품 URL", "링크"]),
        section: normalizeImportedSection(section, adFlag),
        adFlag,
        reservationAvailable,
        availabilityStatus: findRowValue(row, ["availability_status", "예약상태", "예약 상태", "판매상태"]) ||
          (reservationAvailable === "N" ? "예약마감/매진 문구 감지" : reservationAvailable === "Y" ? "가격 노출" : "확인불가"),
        raw
      };
    })
    .filter((row) => row.name);
}

function looksLikeYeogiCsvHeader(line) {
  const cells = String(line || "")
    .split(",")
    .map((cell) => cell.replace(/^\uFEFF/, "").trim().toLowerCase())
    .filter(Boolean);
  if (cells.length < 2) return false;
  const hasName = cells.some((cell) => /^(name|업체명|숙소명|상품명|title)$/.test(cell));
  const hasPrice = cells.some((cell) => /^(price|가격|최저가)$/.test(cell));
  const hasRank = cells.some((cell) => /^(rank|rank_or_order|순위)$/.test(cell));
  const hasUrl = cells.some((cell) => /^(url|상품 url|링크)$/.test(cell));
  return hasName && (hasPrice || hasRank || hasUrl);
}

function isLikelyPlaceName(line) {
  const text = String(line || "").trim();
  if (text.length < 2 || text.length > 70) return false;
  if (!/[가-힣A-Za-z0-9]/.test(text)) return false;
  if (/원|예약|쿠폰|할인|로그인|회원|검색|필터|지도|정렬|성인|아동|입실|퇴실|후기|리뷰|평점|무료취소/.test(text)) return false;
  return /글램핑|캠핑|카라반|펜션|풀빌라|리조트|호텔|스테이|빌리지|캠프|camp|glamp/i.test(text);
}

function parseYeogiTextImport(text) {
  const lines = yeogiTextLines(text);
  const rows = [];
  const seen = new Set();
  const pricePattern = /(?:\d{1,3},)*\d{1,3}\s*원\s*~?|(?:\d{1,3},)+\d{3}/;

  const addRow = (row) => {
    if (!row?.name) return;
    const key = `${row.name}|${row.price || ""}`.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ ...row, rank: row.rank || String(rows.length + 1) });
  };

  lines.forEach((line, index) => {
    const compactRow = parseYeogiCompactLine(line);
    if (compactRow) {
      addRow(compactRow);
      return;
    }

    if (!pricePattern.test(line)) return;
    const start = Math.max(0, index - 8);
    const end = Math.min(lines.length, index + 5);
    const windowLines = lines.slice(start, end);
    const before = lines.slice(start, index).reverse();
    const name = before.find(isLikelyPlaceName) || windowLines.find(isLikelyPlaceName) || "";
    if (!name) return;
    const price = line.match(pricePattern)?.[0] || line;
    const raw = windowLines.join(" / ");
    const adFlag = windowLines.some((item) => /^광고$|광고\s*$|^AD$/i.test(item)) ? "Y" : "확인불가";
    const soldOut = windowLines.some((item) => /예약마감|예약완료|마감|매진|품절|sold\s*out|unavailable/i.test(item));
    addRow({
      rank: String(rows.length + 1),
      name,
      category: "숙박/글램핑",
      location: windowLines.find((item) => /(시|군|구|읍|면|동)\b|경기|강원|충북|충남|전북|전남|경북|경남|제주|부산|울산|대구|인천|서울/.test(item) && !pricePattern.test(item)) || "",
      rating: windowLines.find((item) => /^(\d\.\d|\d점)$/.test(item)) || "",
      reviews: windowLines.find((item) => /후기|리뷰/.test(item)) || "",
      price,
      url: "",
      section: adFlag === "Y" ? "광고" : "수동수집",
      adFlag,
      reservationAvailable: soldOut ? "N" : "Y",
      availabilityStatus: soldOut ? "예약마감/매진 문구 감지" : "가격 노출",
      raw
    });
  });

  if (!rows.length) {
    for (const line of lines) {
      if (!isLikelyPlaceName(line)) continue;
      const key = line;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        rank: String(rows.length + 1),
        name: line,
        category: "숙박/글램핑",
        location: "",
        rating: "",
        reviews: "",
        price: "",
        url: "",
        section: "수동수집",
        adFlag: "확인불가",
        reservationAvailable: "확인불가",
        availabilityStatus: "가격/매진 문구 미확인",
        raw: line
      });
      if (rows.length >= 50) break;
    }
  }

  return rows.slice(0, 80);
}

function parseYeogiImport(text) {
  const source = String(text || "").trim();
  if (!source) return [];
  const firstLine = source.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] || "";
  const csvLike = looksLikeYeogiCsvHeader(firstLine);
  const rows = csvLike ? parseYeogiCsvImport(source) : parseYeogiTextImport(source);
  return rows.filter((row) => row.name);
}

function cleanYeogiManualName(value) {
  return String(value || "")
    .replace(/\s*,\s*[^,]*(?:여기어때|특가).*$/i, "")
    .replace(/\s*[-–—]\s*.*(?:여기어때|특가).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isYeogiManualNoiseName(value) {
  const text = cleanYeogiManualName(value);
  if (!text || text.length < 2) return true;
  return /^(제공용품|서비스|위의 정보|수영장 운영|숙소소개|이용 안내|객실 이용|공지사항|안내사항|환불|취소|예약 안내|추가요금)/.test(text) ||
    /(변경될 수 있습니다|사정에 따라|날씨 또는|부탄가스|그릇세트|무료취소|쿠폰|로그인|회원가입)/.test(text);
}

function normalizeYeogiManualRows(rows) {
  const seen = new Set();
  const normalized = [];
  for (const row of rows) {
    const platform = String(row.channel || row["플랫폼"] || "");
    if (!platform.includes("여기")) {
      normalized.push(row);
      continue;
    }

    const next = { ...row, name: cleanYeogiManualName(row.name || row["업체명"] || "") };
    if (row["업체명"]) next["업체명"] = next.name;
    if (isYeogiManualNoiseName(next.name || next["업체명"] || "")) continue;

    const key = `${platform}:${companyPlatformKey(next.name || next["업체명"] || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

async function importYeogiSupplement(payload) {
  const runId = String(payload.runId || "").trim();
  const sourceText = String(payload.sourceText || "").trim();
  const dirPath = resolveRunDir(runId);
  if (!runId || !dirPath || !fs.existsSync(dirPath)) throw new Error("선택한 실행 결과를 찾을 수 없습니다.");
  if (!sourceText) throw new Error("붙여넣기 데이터가 비어 있습니다.");

  const files = await fsp.readdir(dirPath);
  const manifest = (await readManifest(dirPath)) || {};
  const platformFile = manifestFile(manifest, "platform", files, (file) => file.endsWith("_glamping_crawl_test.csv"));
  if (!platformFile) throw new Error("플랫폼 결과 CSV를 찾을 수 없습니다.");

  const platformPath = path.join(dirPath, platformFile);
  const platformText = (await fsp.readFile(platformPath, "utf8")).replace(/^\uFEFF/, "");
  const originalRows = parseCsv(platformText);
  const originalHeaders = csvHeaderLine(platformText);
  const parsedRows = yeogiImportParser.parseYeogiImport(sourceText);
  if (!parsedRows.length) {
    throw new Error("여기어때 숙소 행을 찾지 못했습니다. CSV 헤더 또는 페이지 텍스트를 다시 확인하세요.");
  }

  const importedAt = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const importedRows = normalizeYeogiManualRows(parsedRows.map((row, index) => ({
    channel: "여기어때",
    section: row.section,
    rank_or_order: row.rank || index + 1,
    name: row.name,
    category: row.category,
    location: row.location,
    rating: row.rating,
    reviews: row.reviews,
    price: row.price,
    ad_flag: row.adFlag,
    url: row.url,
    "실패 원인": "",
    "수집 방향": "사용자 브라우저 세션 또는 수동 가져오기 기반 보완 수집",
    "수집방식": "브라우저/수동 가져오기",
    "수집일시": importedAt,
    "예약가능추정": row.reservationAvailable || "확인불가",
    "예약가능근거": row.availabilityStatus || "",
    "예약가능률대체지표": row.reservationAvailable === "Y" ? 1 : row.reservationAvailable === "N" ? 0 : "",
    "원문": row.raw || ""
  })));
  if (!importedRows.length) {
    throw new Error("여기어때 숙소 행을 찾지 못했습니다. 안내문이 아닌 실제 숙소명/가격이 포함된 결과 텍스트를 붙여넣으세요.");
  }

  const remainingRows = originalRows.filter((row) => String(row.channel || row["플랫폼"] || "") !== "여기어때");
  const mergedRows = [...remainingRows, ...importedRows];
  const columns = orderedColumns(mergedRows, originalHeaders);
  await writeCsv(platformPath, mergedRows, columns);

  const prefix = safeFilePart(manifest.keyword || manifest.searchKeyword || platformFile.replace(/\.[^.]+$/, ""));
  const importFile = `${prefix}_여기어때수동보완.csv`;
  await writeCsv(path.join(dirPath, importFile), importedRows, orderedColumns(importedRows, columns));

  manifest.files = Array.from(new Set([...(manifest.files || []), importFile]));
  manifest.fileRoles = { ...(manifest.fileRoles || {}), yeogiManual: importFile };
  manifest.counts = { ...(manifest.counts || {}), yeogiManual: importedRows.length };
  manifest.yeogiImport = { importedAt, count: importedRows.length, method: "browser_or_manual" };
  await fsp.writeFile(path.join(dirPath, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await appendHistoryForRun(runId).catch((error) => {
    console.warn(`Could not append history for ${runId}: ${error.message || error}`);
  });

  return { importedCount: importedRows.length, data: await loadRun(runId) };
}

function minPrice(value) {
  const match = String(value || "").match(/[\d,]+/);
  if (!match) return null;
  const parsed = Number(match[0].replace(/,/g, ""));
  return parsed > 0 ? parsed : null;
}

function increment(map, key, by = 1) {
  const safeKey = normalizeClusterName(key);
  map[safeKey] = (map[safeKey] || 0) + by;
}

function incrementRaw(map, key, by = 1) {
  const safeKey = String(key || "").trim();
  if (!safeKey) return;
  map[safeKey] = (map[safeKey] || 0) + by;
}

function topKey(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] || "확인불가";
}

function topRawKey(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

function compactKeyword(keyword) {
  return String(keyword || "").replace(/\s+/g, "");
}

const REGIONAL_KEYWORD_ALIASES = {
  gyeongnam: ["경남", "경상남도"],
  gyeongbuk: ["경북", "경상북도"],
  gyeonggi: ["경기", "경기도"],
  jeonbuk: ["전북", "전라북도", "전북특별자치도"],
  jeonnam: ["전남", "전라남도"],
  chungnam: ["충남", "충청남도"],
  chungbuk: ["충북", "충청북도"],
  gangwon: ["강원", "강원도", "강원특별자치도"],
  jeju: ["제주", "제주도", "제주특별자치도"],
  seoul: ["서울", "서울시", "서울특별시"],
  busan: ["부산", "부산시", "부산광역시"],
  daegu: ["대구", "대구시", "대구광역시"],
  incheon: ["인천", "인천시", "인천광역시"],
  gwangju: ["광주", "광주시", "광주광역시"],
  daejeon: ["대전", "대전시", "대전광역시"],
  ulsan: ["울산", "울산시", "울산광역시"],
  sejong: ["세종", "세종시", "세종특별자치시"]
};

const ADMIN_REGION_GROUPS = {
  seoul: { label: "서울", aliases: ["서울", "서울시", "서울특별시"], children: ["종로", "중", "용산", "성동", "광진", "동대문", "중랑", "성북", "강북", "도봉", "노원", "은평", "서대문", "마포", "양천", "강서", "구로", "금천", "영등포", "동작", "관악", "서초", "강남", "송파", "강동"] },
  busan: { label: "부산", aliases: ["부산", "부산시", "부산광역시"], children: ["중", "서", "동", "영도", "부산진", "동래", "남", "북", "해운대", "사하", "금정", "강서", "연제", "수영", "사상", "기장"] },
  daegu: { label: "대구", aliases: ["대구", "대구시", "대구광역시"], children: ["중", "동", "서", "남", "북", "수성", "달서", "달성", "군위"] },
  incheon: { label: "인천", aliases: ["인천", "인천시", "인천광역시"], children: ["중", "동", "미추홀", "연수", "남동", "부평", "계양", "서", "강화", "옹진"] },
  gwangju: { label: "광주", aliases: ["광주", "광주시", "광주광역시"], children: ["동", "서", "남", "북", "광산"] },
  daejeon: { label: "대전", aliases: ["대전", "대전시", "대전광역시"], children: ["동", "중", "서", "유성", "대덕"] },
  ulsan: { label: "울산", aliases: ["울산", "울산시", "울산광역시"], children: ["중", "남", "동", "북", "울주"] },
  sejong: { label: "세종", aliases: ["세종", "세종시", "세종특별자치시"], children: ["세종"] },
  gyeonggi: { label: "경기", aliases: ["경기", "경기도"], children: ["수원", "성남", "의정부", "안양", "부천", "광명", "평택", "동두천", "안산", "고양", "과천", "구리", "남양주", "오산", "시흥", "군포", "의왕", "하남", "용인", "파주", "이천", "안성", "김포", "화성", "광주", "양주", "포천", "여주", "연천", "가평", "양평"] },
  gangwon: { label: "강원", aliases: ["강원", "강원도", "강원특별자치도"], children: ["춘천", "원주", "강릉", "동해", "태백", "속초", "삼척", "홍천", "횡성", "영월", "평창", "정선", "철원", "화천", "양구", "인제", "고성", "양양"] },
  chungbuk: { label: "충북", aliases: ["충북", "충청북도"], children: ["청주", "충주", "제천", "보은", "옥천", "영동", "증평", "진천", "괴산", "음성", "단양"] },
  chungnam: { label: "충남", aliases: ["충남", "충청남도"], children: ["천안", "공주", "보령", "아산", "서산", "논산", "계룡", "당진", "금산", "부여", "서천", "청양", "홍성", "예산", "태안"] },
  jeonbuk: { label: "전북", aliases: ["전북", "전라북도", "전북특별자치도"], children: ["전주", "군산", "익산", "정읍", "남원", "김제", "완주", "진안", "무주", "장수", "임실", "순창", "고창", "부안"] },
  jeonnam: { label: "전남", aliases: ["전남", "전라남도"], children: ["목포", "여수", "순천", "나주", "광양", "담양", "곡성", "구례", "고흥", "보성", "화순", "장흥", "강진", "해남", "영암", "무안", "함평", "영광", "장성", "완도", "진도", "신안"] },
  gyeongbuk: { label: "경북", aliases: ["경북", "경상북도"], children: ["포항", "경주", "김천", "안동", "구미", "영주", "영천", "상주", "문경", "경산", "의성", "청송", "영양", "영덕", "청도", "고령", "성주", "칠곡", "예천", "봉화", "울진", "울릉"] },
  gyeongnam: { label: "경남", aliases: ["경남", "경상남도"], children: ["창원", "진주", "통영", "사천", "김해", "밀양", "거제", "양산", "의령", "함안", "창녕", "고성", "남해", "하동", "산청", "함양", "거창", "합천"] },
  jeju: { label: "제주", aliases: ["제주", "제주도", "제주특별자치도"], children: ["제주", "서귀포"] }
};

function adminRegionToken(value = "") {
  return compactKeyword(value)
    .normalize("NFKC")
    .replace(/(특별자치도|특별자치시|특별시|광역시|자치시|자치구|도|시|군|구)$/u, "");
}

const ADMIN_REGION_ALIAS_TO_KEY = (() => {
  const map = new Map();
  for (const [key, group] of Object.entries(ADMIN_REGION_GROUPS)) {
    map.set(adminRegionToken(group.label), key);
    for (const alias of group.aliases || []) map.set(adminRegionToken(alias), key);
  }
  return map;
})();

const ADMIN_REGION_CHILD_SETS = (() => {
  const map = {};
  for (const [key, group] of Object.entries(ADMIN_REGION_GROUPS)) {
    map[key] = new Set((group.children || []).map(adminRegionToken));
  }
  return map;
})();

function normalizeAdminRegionName(value = "") {
  const token = adminRegionToken(value);
  return ADMIN_REGION_ALIAS_TO_KEY.get(token) || token;
}

function adminRegionContains(parentKey, childName) {
  const childToken = adminRegionToken(childName);
  const childKey = normalizeAdminRegionName(childName);
  if (!parentKey || (!childKey && !childToken)) return false;
  if (parentKey === childKey) return true;
  const children = ADMIN_REGION_CHILD_SETS[parentKey];
  return Boolean(children?.has(childKey) || children?.has(childToken));
}

function topicParticle(value = "") {
  const text = String(value || "").trim();
  const last = text[text.length - 1] || "";
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return "는";
  return ((code - 0xac00) % 28) ? "은" : "는";
}

function regionBoundaryInfo(searchRegion = "", addressRegion = "") {
  const searchLabel = String(searchRegion || "").trim();
  const addressLabel = String(addressRegion || "").trim();
  const searchKey = normalizeAdminRegionName(searchLabel);
  const addressKey = normalizeAdminRegionName(addressLabel);
  if (!searchKey || !addressKey) {
    return { status: "unknown", label: "", detail: "", outside: false };
  }
  if (searchKey === addressKey) {
    return { status: "same", label: "동일지역", detail: `${addressLabel || searchLabel} 소재`, outside: false };
  }
  if (adminRegionContains(searchKey, addressKey)) {
    const parentLabel = ADMIN_REGION_GROUPS[searchKey]?.label || searchLabel;
    return {
      status: "within",
      label: "권역 내 노출",
      detail: `${addressLabel}${topicParticle(addressLabel)} ${parentLabel} 권역에 포함됩니다.`,
      outside: false
    };
  }
  if (adminRegionContains(addressKey, searchKey)) {
    const parentLabel = ADMIN_REGION_GROUPS[addressKey]?.label || addressLabel;
    return {
      status: "parent",
      label: "상위권역 확인",
      detail: `${searchLabel} 검색 결과가 ${parentLabel} 상위권역으로만 확인됩니다.`,
      outside: false
    };
  }
  return {
    status: "outside",
    label: "권역 밖 노출",
    detail: `${searchLabel} 검색권 결과이나 실제 소재지는 ${addressLabel}입니다.`,
    outside: true
  };
}

function keywordLayerCore(keyword) {
  return compactKeyword(keyword)
    .normalize("NFKC")
    .replace(/[·ㆍ|].*$/u, "")
    .replace(/\d{4}-?\d{2}-?\d{2}.*/u, "")
    .replace(/(글램핑|캠핑|카라반|펜션)$/u, "")
    .toLowerCase();
}

function keywordLayerFromRunLike(value = {}) {
  const searchMode = String(value.searchMode || "").trim();
  const keywordType = String(value.keywordType || "").trim();
  if (searchMode === "company" || keywordType === "company") {
    return { type: "company", label: "업체명 확인", note: "업체명 검색 기준" };
  }
  const core = keywordLayerCore(value.keyword || value.label || "");
  if (!core) return { type: "unknown", label: "분류 대기", note: "키워드 확인 필요" };
  for (const aliases of Object.values(REGIONAL_KEYWORD_ALIASES)) {
    if (aliases.map((alias) => keywordLayerCore(alias)).includes(core)) {
      return { type: "regional", label: "광역 노출", note: "권역 키워드 기준" };
    }
  }
  return { type: "local", label: "로컬 노출", note: "지역 키워드 기준" };
}

function companyPlatformKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function normalizeSearchKeyword(keyword) {
  const compact = compactKeyword(keyword);
  if (!compact) return "";
  return compact.endsWith("글램핑") ? compact : `${compact}글램핑`;
}

function uniqueTexts(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function normalizeCompanyIdentityName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\(주\)|㈜|주식회사|유한회사|농업회사법인|영농조합법인|사단법인|재단법인/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function normalizeCompanyLooseName(value) {
  return normalizeCompanyIdentityName(value)
    .replace(/글램핑장|오토캠핑장|카라반캠핑장|야영장|캠핑장|글램핑|카라반|캠핑|펜션|리조트|호텔|스테이|빌리지|지점|본점/gu, "");
}

function normalizeAddressKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function extractNaverPlaceId(value = {}) {
  const explicit = value.placeId || value.place_id || value["place_id"] || value.naverPlaceId;
  if (explicit) return String(explicit).trim();
  const text = `${value.url || ""} ${value["url"] || ""} ${value.naverUrl || ""} ${value["네이버예약URL"] || ""}`;
  return text.match(/\/accommodation\/(\d+)/)?.[1] || text.match(/[?&]entry=pll[^0-9]*(\d+)/)?.[1] || "";
}

function extractBookingBusinessId(value = {}) {
  const explicit = value.bookingBusinessId || value.businessId || value.naverBookingBusinessId;
  if (explicit) return String(explicit).trim();
  const text = `${value.url || ""} ${value["url"] || ""} ${value.naverBookingUrl || ""} ${value["네이버예약URL"] || ""}`;
  return text.match(/\/bizes\/(\d+)/)?.[1] || "";
}

function boundedUnique(values = [], limit = 20) {
  return uniqueTexts(values).slice(0, limit);
}

function datalabKeywordVariants(keyword) {
  const raw = String(keyword || "").trim();
  const compact = compactKeyword(raw);
  return uniqueTexts([
    raw,
    compact,
    compact.replace(/글램핑$/u, " 글램핑")
  ]).slice(0, 5);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function datalabTrendRange(monthCount = 12) {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - Math.max(1, monthCount - 1), 1));
  return { startDate: isoDate(start), endDate: isoDate(end), timeUnit: "month" };
}

function demandKeywordForRun(manifest, conditions, regions) {
  const raw = manifest?.keyword || conditions?.keyword || regions?.[0]?.trafficKeyword || "";
  if (!raw) return "";
  const searchMode = manifest?.searchMode || (manifest?.keywordType === "company" ? "company" : "keyword");
  return searchMode === "company" ? compactKeyword(raw) : normalizeSearchKeyword(raw);
}

function trafficKeywordForRegion(keyword, region) {
  const compact = compactKeyword(keyword);
  const regionName = compactKeyword(region);
  if (regionName && compact.includes(regionName)) return `${regionName}글램핑`;
  return normalizeSearchKeyword(compact || `${regionName}글램핑`);
}

function normalizeClusterName(value) {
  const name = String(value || "").trim();
  if (!name) return "확인불가";
  if (name === "프리미엄") return "프리미엄형";
  return name;
}

function normalizeInventoryMemo(memo, listType = "") {
  const text = String(memo || "");
  if (!text) return "";
  if (!String(listType || "").includes("객실 묶음 상품리스트")) return text;
  return text.replace(
    "객실번호 범위형 묶음 상품은 상품 단위로 계산",
    "객실번호 범위형 묶음 상품은 내부 stock 수량 합산"
  );
}

function inventoryConfidenceLabel(grade) {
  return {
    A: "A 신뢰",
    B: "B 양호",
    C: "C 참고",
    D: "D 검증",
    E: "E 수동확인"
  }[grade] || "C 참고";
}

function inventoryStructureMeta(type) {
  return {
    room_unit: {
      label: "객실별 노출형",
      tone: "good",
      summary: "객실/상품이 개별로 노출되어 기준일 재고 해석이 비교적 단순합니다."
    },
    room_type_stock: {
      label: "종류별 수량형",
      tone: "watch",
      summary: "객실 종류별 stock 합산값입니다. 판매 가능 수량으로 보되 실제 전체 보유 객실수와 구분합니다."
    },
    grouped_stock: {
      label: "묶음·범위형",
      tone: "bad",
      summary: "객실번호 범위나 묶음 상품의 내부 stock 합산값입니다. 상품명 구조 검증이 필요합니다."
    },
    stock_only: {
      label: "재고 합산형",
      tone: "watch",
      summary: "예약 상품의 stock 합산값입니다. 객실 단위인지 상품 단위인지 추가 확인이 필요합니다."
    },
    dayuse_only: {
      label: "당일상품 중심",
      tone: "watch",
      summary: "숙박보다 데이유즈/캠프닉 상품 수량 해석이 중요합니다."
    },
    unknown: {
      label: "구조 확인필요",
      tone: "bad",
      summary: "예약 리스트 구조가 명확하지 않아 수동 검증이 필요합니다."
    }
  }[type] || {
    label: "구조 확인필요",
    tone: "bad",
    summary: "예약 리스트 구조가 명확하지 않아 수동 검증이 필요합니다."
  };
}

function evaluateInventoryStructure(context = {}) {
  const listType = String(context.listType || "");
  const memo = String(context.inventoryMemo || "");
  const flags = [];
  const notes = [];
  let type = "unknown";

  if (listType.includes("객실별")) {
    type = "room_unit";
    notes.push("객실별 예약리스트");
  } else if (listType.includes("객실 종류별")) {
    type = "room_type_stock";
    notes.push("객실 종류별 stock 합산");
  } else if (listType.includes("묶음")) {
    type = "grouped_stock";
    notes.push("객실 범위/묶음 상품");
  } else if (context.totalRooms > 0) {
    type = "stock_only";
    notes.push("예약 stock 합산");
  }

  if (!context.totalRooms && context.dayUseTotalStock > 0) {
    type = "dayuse_only";
  }

  if (context.dayUseTotalStock > 0 || context.dayUseItemCount > 0) {
    flags.push("dayuse_rotation");
    notes.push("데이유즈/캠프닉 별도 분리");
  }

  if (context.weeklyRawStockVariance || context.dayUseWeeklyRawStockVariance) {
    flags.push("dynamic_capacity");
    notes.push("날짜별 총량 변동은 운영 기준과 일시 차단을 분리");
  }

  if (context.rawTotalStock && context.totalRooms && context.rawTotalStock !== context.totalRooms) {
    flags.push("raw_calc_gap");
    notes.push("원시 stock과 계산값 차이");
  }

  if (context.groupedRoomCount > 0 || memo.includes("묶음 상품")) {
    if (!flags.includes("grouped_range")) flags.push("grouped_range");
  }

  if (memo.includes("과거 확인 ID 재사용")) {
    flags.push("booking_id_reused");
    notes.push("예약ID 과거값 재사용");
  }

  if (memo.includes("전체 객실수와 다를 수 있음")) {
    flags.push("not_total_rooms");
  }

  const meta = inventoryStructureMeta(type);
  const action = flags.includes("booking_id_reused")
    ? "네이버 예약ID 재확인"
    : flags.includes("dynamic_capacity")
      ? "전화예약·정비·채널조정 확인"
      : type === "grouped_stock"
        ? "상품명 범위와 stock 대조"
        : type === "room_type_stock"
          ? "종류별 수량과 실제 객실수 구분"
          : "표본 날짜 재검증";

  return {
    type,
    label: meta.label,
    tone: meta.tone,
    summary: meta.summary,
    flags,
    notes: [...new Set(notes)].slice(0, 5),
    action
  };
}

function evaluateInventoryConfidence(context = {}) {
  const reasons = [];
  const alerts = [];
  const structure = evaluateInventoryStructure(context);
  let score = 45;

  if (context.totalRooms > 0 && context.availableRooms >= 0) {
    score += 16;
    reasons.push("기준일 전체/잔여 수량 확인");
  } else {
    score -= 24;
    alerts.push("기준 수량 확인 불가");
  }

  if (context.weeklyDays >= 6 && context.weeklyDetail) {
    score += 22;
    reasons.push("기간 대부분 날짜별 재고 확인");
  } else if (context.weeklyDays >= 2 && context.weeklyDetail) {
    score += 12;
    reasons.push("일부 날짜별 재고 확인");
  } else {
    score -= 12;
    alerts.push("날짜별 상세 부족");
  }

  const weeklyBasisTotal = Number(context.weeklyBasisTotal);
  const weeklyOperatingTotal = Number(context.weeklyOperatingTotal);
  const weeklyStructuralBlockedTotal = Number(context.weeklyStructuralBlockedTotal);
  const weeklyOfflineReservedTotal = Number(context.weeklyOfflineReservedTotal);
  const weeklyMaxTotalDays = Number(context.weeklyMaxTotalDays);
  const weeklyTotalVarianceGap = Number(context.weeklyTotalVarianceGap);
  const weeklyVarianceRatio = Number.isFinite(weeklyBasisTotal) && weeklyBasisTotal > 0 && Number.isFinite(weeklyTotalVarianceGap)
    ? weeklyTotalVarianceGap / weeklyBasisTotal
    : 0;
  if (Number.isFinite(weeklyBasisTotal) && weeklyBasisTotal > 0 && context.weeklyDays >= 2) {
    score += 7;
    reasons.push("날짜별 숙박 총량 최대값을 전체 객실수 후보로 적용");
  }
  if (Number.isFinite(weeklyStructuralBlockedTotal) && weeklyStructuralBlockedTotal > 0) {
    reasons.push("반복 낮은 총량은 상시 차단/운영 축소로 분리");
    score += Number.isFinite(weeklyOperatingTotal) && weeklyOperatingTotal > 0 ? 2 : 0;
  }

  if (context.countedItemCount > 0) {
    score += 6;
    reasons.push("예약 상품 단위 확인");
  }

  const listType = String(context.listType || "");
  if (listType.includes("객실별")) {
    score += 8;
    reasons.push("객실별 노출형");
  } else if (listType.includes("객실 종류별")) {
    score += 3;
    reasons.push("종류별 수량형");
  } else if (listType.includes("묶음")) {
    score -= 7;
    alerts.push("묶음/범위형 상품 해석 필요");
  } else if (!listType) {
    score -= 8;
    alerts.push("예약 리스트 유형 미확인");
  }

  if (context.weeklyRawStockVariance) {
    const hasOfflineEstimate = Number.isFinite(weeklyOfflineReservedTotal) && weeklyOfflineReservedTotal > 0;
    if (hasOfflineEstimate) {
      reasons.push("운영 기준 미만 날짜는 오프라인 예약/일시 차단으로 보정");
      score -= Number.isFinite(weeklyMaxTotalDays) && weeklyMaxTotalDays >= 2 ? 2 : 5;
      alerts.push(Number.isFinite(weeklyMaxTotalDays) && weeklyMaxTotalDays < 2
        ? "최대 총량 반복 확인 부족"
        : "날짜별 총량 변동 재검토");
    } else {
      score -= 8;
      alerts.push("날짜별 총량 변동");
    }
    if (weeklyVarianceRatio >= 0.35) {
      score -= 5;
      if (!alerts.includes("날짜별 총량 변동 큼")) alerts.push("날짜별 총량 변동 큼");
    }
  }

  if (context.rawTotalStock && context.totalRooms && context.rawTotalStock !== context.totalRooms) {
    score -= 4;
    alerts.push("원시 재고와 계산 재고 차이");
  }

  if (context.dayUseTotalStock > 0) {
    reasons.push("당일 회전형 별도 분리");
  }

  if (structure.flags.includes("booking_id_reused")) {
    score -= 8;
    alerts.push("예약ID 과거값 재사용");
  }

  if (structure.flags.includes("dynamic_capacity")) {
    reasons.push("전화예약/정비/채널조정 가능성");
  }

  if (alerts.length) score = Math.min(score, 86);
  if (structure.type === "room_unit" && !alerts.length) score += 3;
  const grade = score >= 88 ? "A" : score >= 74 ? "B" : score >= 58 ? "C" : score >= 42 ? "D" : "E";
  const summary = alerts.length
    ? `${inventoryConfidenceLabel(grade)} · ${alerts[0]}`
    : `${inventoryConfidenceLabel(grade)} · ${structure.label}`;

  return {
    grade,
    score: Math.max(0, Math.min(100, Math.round(score))),
    label: inventoryConfidenceLabel(grade),
    summary,
    structure,
    reasons: reasons.slice(0, 4),
    alerts: alerts.slice(0, 4)
  };
}

function metricNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value || "").replace(/,/g, "").trim();
  if (!text) return 0;
  if (/^<\s*10$/.test(text)) return 5;
  const parsed = Number(text.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function searchAdSignature(timestamp, method, uri, secretKey) {
  return crypto
    .createHmac("sha256", secretKey)
    .update(`${timestamp}.${method}.${uri}`)
    .digest("base64");
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSearchAdRelatedRows(rows = [], baseKeyword = "") {
  const baseCompact = compactKeyword(baseKeyword).toLowerCase();
  const seen = new Set();
  return rows
    .map((row) => {
      const keyword = compactKeyword(row?.relKeyword || "");
      const compact = compactKeyword(keyword).toLowerCase();
      if (!keyword || seen.has(compact)) return null;
      seen.add(compact);
      const monthlyPc = metricNumber(row.monthlyPcQcCnt);
      const monthlyMobile = metricNumber(row.monthlyMobileQcCnt);
      const totalSearchVolume = monthlyPc + monthlyMobile;
      const monthlyPcClicks = metricNumber(row.monthlyAvePcClkCnt);
      const monthlyMobileClicks = metricNumber(row.monthlyAveMobileClkCnt);
      const totalClicks = monthlyPcClicks + monthlyMobileClicks;
      return {
        keyword,
        relKeyword: row.relKeyword || keyword,
        monthlyPc,
        monthlyMobile,
        totalSearchVolume,
        totalClicks,
        combinedCtr: totalSearchVolume ? Number(((totalClicks / totalSearchVolume) * 100).toFixed(2)) : null,
        competition: row.compIdx || "확인불가",
        exact: Boolean(baseCompact && compact === baseCompact)
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.totalSearchVolume - a.totalSearchVolume)
    .slice(0, 20);
}

function normalizeSearchAdRow(keyword, row, status = 200, relatedRows = []) {
  if (!row) {
    return {
      keyword,
      collectable: false,
      status,
      reason: "검색광고 키워드 도구에 일치 데이터가 없습니다."
    };
  }

  const monthlyPc = metricNumber(row.monthlyPcQcCnt);
  const monthlyMobile = metricNumber(row.monthlyMobileQcCnt);
  const monthlyPcClicks = metricNumber(row.monthlyAvePcClkCnt);
  const monthlyMobileClicks = metricNumber(row.monthlyAveMobileClkCnt);
  const totalSearchVolume = monthlyPc + monthlyMobile;
  const totalClicks = monthlyPcClicks + monthlyMobileClicks;

  return {
    keyword,
    relKeyword: row.relKeyword || keyword,
    collectable: true,
    status,
    monthlyPc,
    monthlyMobile,
    totalSearchVolume,
    monthlyPcClicks,
    monthlyMobileClicks,
    totalClicks,
    pcCtr: metricNumber(row.monthlyAvePcCtr),
    mobileCtr: metricNumber(row.monthlyAveMobileCtr),
    combinedCtr: totalSearchVolume ? Number(((totalClicks / totalSearchVolume) * 100).toFixed(2)) : null,
    competition: row.compIdx || "확인불가",
    relatedKeywords: normalizeSearchAdRelatedRows(relatedRows, keyword)
  };
}

async function collectSearchAdMetric(keyword, keys, attempt = 0) {
  if (!keys.searchadApiKey || !keys.searchadSecretKey || !keys.searchadCustomerId) {
    return {
      keyword,
      collectable: false,
      configured: false,
      reason: "검색광고 API 키가 필요합니다."
    };
  }

  const method = "GET";
  const uri = "/keywordstool";
  const timestamp = Date.now().toString();
  const url = `https://api.searchad.naver.com${uri}?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`;
  const result = await requestJson(url, {
    method,
    headers: {
      "X-Timestamp": timestamp,
      "X-API-KEY": keys.searchadApiKey,
      "X-Customer": keys.searchadCustomerId,
      "X-Signature": searchAdSignature(timestamp, method, uri, keys.searchadSecretKey)
    }
  });

  if (result.status === 429 && attempt < 2) {
    await sleep(1200 * (attempt + 1));
    return collectSearchAdMetric(keyword, keys, attempt + 1);
  }

  if (!result.ok) {
    return {
      keyword,
      collectable: false,
      configured: true,
      status: result.status,
      reason: result.data?.message || result.data?.title || result.data?.errorMessage || "검색광고 API 호출 실패"
    };
  }

  const list = Array.isArray(result.data?.keywordList) ? result.data.keywordList : [];
  const exact = list.find((row) => compactKeyword(row.relKeyword) === compactKeyword(keyword));
  const close = exact || list[0] || null;
  return normalizeSearchAdRow(keyword, close, result.status, list);
}

function normalizeDatalabTrend(keyword, result, range) {
  const group = Array.isArray(result?.results) ? result.results[0] : null;
  const rows = Array.isArray(group?.data) ? group.data : [];
  const series = rows.map((row) => {
    const ratio = Number(row.ratio);
    return {
      period: row.period || "",
      month: row.period || "",
      ratio: Number.isFinite(ratio) ? ratio : null,
      value: Number.isFinite(ratio) ? ratio : null
    };
  });

  return {
    source: "naver_datalab_search",
    keyword,
    configured: true,
    collectable: series.some((entry) => Number.isFinite(entry.ratio)),
    status: 200,
    startDate: range.startDate,
    endDate: range.endDate,
    timeUnit: range.timeUnit,
    note: "Naver DataLab returns relative trend ratios, not absolute search volume.",
    series,
    rawTitle: group?.title || keyword,
    collectedAt: new Date().toISOString()
  };
}

function datalabTrendCacheKey(keyword) {
  return compactKeyword(keyword).toLowerCase();
}

async function readDatalabTrendStore() {
  try {
    const parsed = JSON.parse((await fsp.readFile(HISTORY_DATALAB_TRENDS_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return {
      source: "naver_datalab_trend_store",
      version: 1,
      ...parsed,
      keywords: parsed.keywords || {}
    };
  } catch {
    return { source: "naver_datalab_trend_store", version: 1, updatedAt: "", keywords: {} };
  }
}

async function writeDatalabTrendStore(store) {
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  const next = { ...store, updatedAt: new Date().toISOString() };
  const tempPath = `${HISTORY_DATALAB_TRENDS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fsp.rename(tempPath, HISTORY_DATALAB_TRENDS_FILE);
}

function datalabTrendSnapshot(trend = {}) {
  return {
    source: trend.source || "naver_datalab_search",
    keyword: trend.keyword || "",
    configured: Boolean(trend.configured),
    collectable: Boolean(trend.collectable),
    status: trend.status || null,
    startDate: trend.startDate || "",
    endDate: trend.endDate || "",
    timeUnit: trend.timeUnit || "month",
    note: trend.note || "",
    reason: trend.reason || "",
    series: Array.isArray(trend.series) ? trend.series.slice(-24) : [],
    rawTitle: trend.rawTitle || trend.keyword || "",
    collectedAt: trend.collectedAt || new Date().toISOString()
  };
}

function freshDatalabTrendFromStore(entry = {}, range = {}) {
  const latest = entry.latest || null;
  if (!latest?.collectable) return null;
  if (latest.startDate !== range.startDate || latest.endDate !== range.endDate || latest.timeUnit !== range.timeUnit) return null;
  return {
    ...latest,
    cache: datalabTrendCacheMeta(entry, true)
  };
}

function datalabTrendCacheMeta(entry = {}, hit = false) {
  const observations = Array.isArray(entry.observations) ? entry.observations : [];
  return {
    hit: Boolean(hit),
    policy: DATALAB_TREND_CACHE_POLICY,
    file: "history/datalab_trends.json",
    startDate: entry.latest?.startDate || "",
    endDate: entry.latest?.endDate || "",
    timeUnit: entry.latest?.timeUnit || "month",
    observationCount: Number(entry.observationCount || observations.length || (entry.latest ? 1 : 0)),
    firstCollectedAt: entry.firstCollectedAt || entry.firstSeenAt || observations[0]?.collectedAt || "",
    lastCollectedAt: entry.lastCollectedAt || entry.lastSeenAt || entry.latest?.collectedAt || observations[observations.length - 1]?.collectedAt || "",
    lastUsedAt: entry.lastUsedAt || ""
  };
}

async function decorateDatalabTrendWithCache(keyword, trend = {}) {
  if (!trend?.collectable) return trend;
  const key = datalabTrendCacheKey(keyword || trend.keyword);
  if (!key) return trend;
  const store = await readDatalabTrendStore();
  const entry = store.keywords?.[key];
  if (!entry && trend?.configured) return rememberDatalabTrend(keyword || trend.keyword, trend);
  if (!entry) return trend;
  return {
    ...trend,
    cache: {
      ...datalabTrendCacheMeta(entry, Boolean(trend.cache?.hit)),
      ...(trend.cache || {})
    }
  };
}

async function rememberDatalabTrend(keyword, trend = {}, { cacheHit = false } = {}) {
  const key = datalabTrendCacheKey(keyword || trend.keyword);
  if (!key || !trend?.configured) return trend;
  const store = await readDatalabTrendStore();
  const current = store.keywords[key] || {
    keyword: trend.keyword || compactKeyword(keyword),
    keywordKey: key,
    firstCollectedAt: trend.collectedAt || new Date().toISOString(),
    useCount: 0,
    observations: []
  };
  const now = new Date().toISOString();
  current.keyword = current.keyword || trend.keyword || compactKeyword(keyword);
  current.keywordKey = key;
  current.lastUsedAt = now;
  current.useCount = Number(current.useCount || 0) + 1;
  if (!cacheHit) {
    const snapshot = datalabTrendSnapshot(trend);
    current.latest = snapshot;
    current.observations = [
      ...(current.observations || []),
      snapshot
    ].slice(-80);
    current.firstCollectedAt = current.firstCollectedAt || snapshot.collectedAt;
    current.lastCollectedAt = snapshot.collectedAt;
  }
  current.observationCount = (current.observations || []).length;
  store.keywords[key] = current;
  await writeDatalabTrendStore(store);
  return {
    ...trend,
    cache: {
      ...(trend.cache || {}),
      ...datalabTrendCacheMeta(current, cacheHit || Boolean(trend.cache?.hit))
    }
  };
}

async function collectDatalabTrend(keyword, keys, attempt = 0, range = datalabTrendRange(12)) {
  const compact = compactKeyword(keyword);
  if (!compact) return null;

  if (!keys.naverClientId || !keys.naverClientSecret) {
    return {
      source: "naver_datalab_search",
      keyword: compact,
      configured: false,
      collectable: false,
      reason: "Naver DataLab API keys are not configured.",
      series: []
    };
  }

  const result = await requestJson("https://openapi.naver.com/v1/datalab/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Naver-Client-Id": keys.naverClientId,
      "X-Naver-Client-Secret": keys.naverClientSecret
    },
    body: JSON.stringify({
      ...range,
      keywordGroups: [
        {
          groupName: compact,
          keywords: datalabKeywordVariants(compact)
        }
      ]
    })
  });

  if (result.status === 429 && attempt < 2) {
    await sleep(1200 * (attempt + 1));
    return collectDatalabTrend(keyword, keys, attempt + 1, range);
  }

  if (!result.ok) {
    return {
      source: "naver_datalab_search",
      keyword: compact,
      configured: true,
      collectable: false,
      status: result.status,
      startDate: range.startDate,
      endDate: range.endDate,
      timeUnit: range.timeUnit,
      reason: result.data?.errorMessage || result.data?.message || result.data?.title || "Naver DataLab API request failed.",
      series: [],
      collectedAt: new Date().toISOString()
    };
  }

  return normalizeDatalabTrend(compact, result.data, range);
}

async function collectDatalabTrendCached(keyword, keys) {
  const compact = compactKeyword(keyword);
  if (!compact) return null;

  const range = datalabTrendRange(12);
  const store = await readDatalabTrendStore();
  const key = datalabTrendCacheKey(compact);
  const cached = freshDatalabTrendFromStore(store.keywords?.[key], range);
  if (cached) {
    return rememberDatalabTrend(compact, cached, { cacheHit: true });
  }
  if (!keys.naverClientId || !keys.naverClientSecret) return collectDatalabTrend(keyword, keys, 0, range);

  const trend = await collectDatalabTrend(compact, keys, 0, range);
  if (trend) return rememberDatalabTrend(compact, trend);
  return trend;
}

function createTrafficAggregate() {
  return {
    keywordCount: 0,
    collectableCount: 0,
    monthlyPc: 0,
    monthlyMobile: 0,
    totalSearchVolume: 0,
    totalClicks: 0,
    combinedCtr: null
  };
}

function addTrafficMetric(aggregate, metric) {
  aggregate.keywordCount += 1;
  if (!metric?.collectable) return aggregate;
  aggregate.collectableCount += 1;
  aggregate.monthlyPc += metric.monthlyPc || 0;
  aggregate.monthlyMobile += metric.monthlyMobile || 0;
  aggregate.totalSearchVolume += metric.totalSearchVolume || 0;
  aggregate.totalClicks += metric.totalClicks || 0;
  aggregate.combinedCtr = aggregate.totalSearchVolume
    ? Number(((aggregate.totalClicks / aggregate.totalSearchVolume) * 100).toFixed(2))
    : null;
  return aggregate;
}

async function readTrafficCache(cachePath) {
  try {
    return JSON.parse((await fsp.readFile(cachePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return { source: "naver_traffic_sources", metrics: {}, trends: {} };
  }
}

async function enrichRegionsWithTraffic(regions, dirPath, demandKeyword = "") {
  const keys = await readTrafficKeys();
  const cachePath = path.join(dirPath, "traffic_metrics.json");
  const cache = await readTrafficCache(cachePath);
  const metrics = cache.metrics || {};
  const trends = cache.trends || {};
  let changed = false;

  for (const region of regions) {
    const keyword = normalizeSearchKeyword(region.trafficKeyword || region.region);
    region.trafficKeyword = keyword;

    if (!metrics[keyword]?.collectable) {
      const metric = await collectSearchAdMetric(keyword, keys);
      metrics[keyword] = metric;
      changed = true;
      await sleep(350);
    }

    region.traffic = metrics[keyword];
  }

  const datalabKeyword = compactKeyword(demandKeyword || regions[0]?.trafficKeyword || "");
  let datalabTrend = datalabKeyword ? trends[datalabKeyword] : null;
  if (datalabKeyword && datalabTrend?.collectable && !datalabTrend.cache) {
    const decoratedTrend = await decorateDatalabTrendWithCache(datalabKeyword, datalabTrend);
    if (decoratedTrend?.cache) {
      datalabTrend = decoratedTrend;
      trends[datalabKeyword] = datalabTrend;
      changed = true;
    }
  }
  if (datalabKeyword && !datalabTrend?.collectable) {
    datalabTrend = await collectDatalabTrendCached(datalabKeyword, keys);
    if (datalabTrend) {
      trends[datalabKeyword] = datalabTrend;
      changed = true;
      await sleep(350);
    }
  }

  const canPersistTraffic = keys.searchadApiKey && keys.searchadSecretKey && keys.searchadCustomerId;
  const canPersistTrend = keys.naverClientId && keys.naverClientSecret;
  if (changed && (canPersistTraffic || canPersistTrend)) {
    await fsp.writeFile(
      cachePath,
      JSON.stringify({ source: "naver_traffic_sources", updatedAt: new Date().toISOString(), metrics, trends }, null, 2),
      "utf8"
    );
  }

  return datalabTrend || null;
}

function defaultProfile(region, provinceKey, index) {
  const province = PROVINCES[provinceKey] || PROVINCES.local;
  const bounds = province.mapBounds;
  const angle = (index / 12) * Math.PI * 2;
  return {
    lat: (bounds.minLat + bounds.maxLat) / 2 + Math.sin(angle) * 0.3,
    lon: (bounds.minLon + bounds.maxLon) / 2 + Math.cos(angle) * 0.3,
    primary: "복합형",
    secondary: "확인필요",
    resources: ["확인필요"],
    target: "확인필요",
    note: `${region} 지역의 본질 클러스터 기준 보정 필요`
  };
}

function summarizeRegionalRows(rows, provinceKey) {
  const province = PROVINCES[provinceKey] || PROVINCES.local;
  const regions = new Map();
  let unknownIndex = 0;

  for (const row of rows) {
    const region = row["지역"] || row["검색클러스터"] || row["소재지클러스터"] || "기타";
    if (!regions.has(region)) {
      const profile = province.profiles[region] || defaultProfile(region, provinceKey, unknownIndex++);
      regions.set(region, {
        region,
        ...profile,
        count: 0,
        adCount: 0,
        dualCount: 0,
        organicCount: 0,
        priceSum: 0,
        priceCount: 0,
        priceBuckets: {},
        typeBuckets: {},
        adBuckets: {},
        keywordBuckets: {},
        places: []
      });
    }

    const item = regions.get(region);
    item.count += 1;
    incrementRaw(
      item.keywordBuckets,
      trafficKeywordForRegion(row["검색키워드"] || row["기준키워드"] || `${region}글램핑`, region)
    );
    increment(item.priceBuckets, row["가격대클러스터"]);
    increment(item.typeBuckets, row["상품유형클러스터"]);
    increment(item.adBuckets, row["광고집행클러스터"]);

    const adCluster = normalizeClusterName(row["광고집행클러스터"]);
    if (adCluster.includes("광고+비광고")) item.dualCount += 1;
    else if (adCluster.includes("광고")) item.adCount += 1;
    else if (adCluster.includes("비광고")) item.organicCount += 1;

    const price = minPrice(row["금액"] || row["가격"]);
    if (price) {
      item.priceSum += price;
      item.priceCount += 1;
    }

    item.places.push({
      rank: Number(row["순위"] || 999),
      name: row["업체명"] || "",
      category: row["카테고리"] || "",
      address: row["주소"] || row["주소 또는 지역"] || "",
      price: row["금액"] || row["가격"] || "",
      roomNamePreview: row["객실명(일부)"] || row.roomNamePreview || row.roomNames || "",
      ad: normalizeClusterName(row["광고집행클러스터"]),
      type: normalizeClusterName(row["상품유형클러스터"]),
      productTypeSummary: row["네이버상품구성"] || "",
      nightItemCount: row["숙박상품수"] || "",
      dayUseItemCount: row["데이유즈상품수"] || "",
      countedItemCount: row["예약계산대상상품수"] || "",
      availableRooms: row["숙박예약가능수"] || row["예약가능객실수"] || "",
      totalRooms: row["숙박확인재고수"] || row["확인객실수"] || "",
      availabilityRate: row["숙박예약가능률"] || row["예약가능률"] || "",
      nightAvailableStock: row["숙박예약가능수"] || row["예약가능객실수"] || "",
      nightTotalStock: row["숙박확인재고수"] || row["확인객실수"] || "",
      dayUseAvailableStock: row["데이유즈예약가능수"] || "",
      dayUseTotalStock: row["데이유즈확인재고수"] || "",
      inventoryScope: row["네이버재고범위"] || "네이버예약 채널/날짜 기준 재고",
      inventoryMemo: normalizeInventoryMemo(row["객실수검증메모"], row["예약리스트유형"]),
      availabilityBasis: row["예약가능근거"] || row["네이버예약재고수집상태"] || "",
      url: row["url"] || row["상품 URL"] || ""
    });
  }

  return [...regions.values()]
    .map((item) => ({
      ...item,
      avgPrice: item.priceCount ? Math.round(item.priceSum / item.priceCount) : null,
      dominantPrice: topKey(item.priceBuckets),
      dominantType: topKey(item.typeBuckets),
      dominantAd: topKey(item.adBuckets),
      trafficKeyword: normalizeSearchKeyword(topRawKey(item.keywordBuckets) || `${item.region}글램핑`),
      places: item.places.sort((a, b) => a.rank - b.rank).slice(0, 10)
    }))
    .sort((a, b) => a.region.localeCompare(b.region, "ko"));
}

function summarizeStats(regions) {
  const stats = {
    totalRegionalRows: 0,
    byCore: {},
    byType: {},
    byPrice: {},
    byAd: {},
    byCoreTraffic: {},
    traffic: createTrafficAggregate(),
    maxRegionCount: 0,
    avgPrice: null
  };
  let priceSum = 0;
  let priceCount = 0;

  for (const region of regions) {
    stats.totalRegionalRows += region.count;
    stats.maxRegionCount = Math.max(stats.maxRegionCount, region.count);
    increment(stats.byCore, region.primary, region.count);
    if (!stats.byCoreTraffic[region.primary]) stats.byCoreTraffic[region.primary] = createTrafficAggregate();
    addTrafficMetric(stats.byCoreTraffic[region.primary], region.traffic);
    addTrafficMetric(stats.traffic, region.traffic);

    for (const [key, value] of Object.entries(region.typeBuckets)) increment(stats.byType, key, value);
    for (const [key, value] of Object.entries(region.priceBuckets)) increment(stats.byPrice, key, value);
    for (const [key, value] of Object.entries(region.adBuckets)) increment(stats.byAd, key, value);

    if (region.priceCount) {
      priceSum += region.priceSum;
      priceCount += region.priceCount;
    }
  }

  stats.avgPrice = priceCount ? Math.round(priceSum / priceCount) : null;
  return stats;
}

function clampScore(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function demandMonthFromConditions(conditions = {}) {
  const dateText = conditions.checkIn || kstDate(0);
  const match = String(dateText).match(/^\d{4}-(\d{1,2})-/);
  const month = match ? Number(match[1]) : new Date().getMonth() + 1;
  return Number.isFinite(month) && month >= 1 && month <= 12 ? month : new Date().getMonth() + 1;
}

function demandSegmentMatches(segment, monthInfo) {
  const targets = (monthInfo.targets || []).join(" ");
  const keywords = [...(monthInfo.keywords || []), monthInfo.weekdaySignal || "", monthInfo.content || ""].join(" ");
  if (targets.includes(segment.name) || targets.includes(segment.group)) return true;
  if (segment.keywords.some((keyword) => keywords.includes(keyword))) return true;
  if ((monthInfo.season && segment.seasons.includes(monthInfo.season)) && segment.priority >= 4) return true;
  return false;
}

function demandTopSegments(monthInfo, limit = 3) {
  return DEMAND_SEGMENTS
    .map((segment) => ({
      ...segment,
      fitScore:
        (demandSegmentMatches(segment, monthInfo) ? 42 : 0) +
        segment.priority * 8 +
        segment.conversion * 6 +
        segment.weight * 0.8 +
        (segment.seasons.includes(monthInfo.season) || segment.seasons.includes("연중") ? 12 : 0)
    }))
    .sort((a, b) => b.fitScore - a.fitScore)
    .slice(0, limit);
}

function demandTrendMomentum(datalabTrend) {
  const series = (datalabTrend?.series || datalabTrend?.data || [])
    .map((entry) => Number(entry.ratio ?? entry.value ?? entry.score))
    .filter(Number.isFinite);
  if (series.length < 2) return { score: 50, label: "트렌드 확인필요", change: null };
  const first = series[0] || 0;
  const last = series[series.length - 1] || 0;
  const change = first ? (last - first) / first : 0;
  const score = clampScore(55 + change * 100);
  return {
    score,
    change,
    label: change >= 0.15 ? "트렌드 상승" : change <= -0.15 ? "트렌드 하락" : "트렌드 보합"
  };
}

function demandRiskScore(monthInfo, regions = []) {
  const riskCount = (monthInfo.risks || []).length;
  const weatherRisk = (monthInfo.risks || []).some((risk) => /장마|폭염|태풍|한파|날씨|비/.test(risk));
  const naturalShare = regions.length
    ? regions.filter((region) => /자연|메인 관광/.test(region.primary || "")).length / regions.length
    : 0.5;
  const raw = 100 - riskCount * 10 - (weatherRisk ? 8 : 0) + naturalShare * 8;
  return clampScore(raw, 35, 95);
}

function demandContentScore(monthInfo, topSegments, datalabTrend) {
  const aiFrequency = DEMAND_AI_SIGNALS
    .filter((signal) => topSegments.some((segment) => segment.name === signal.segment || segment.group === signal.segment))
    .reduce((sum, signal) => sum + signal.frequency, 0);
  const trend = demandTrendMomentum(datalabTrend);
  return clampScore(58 + Math.min(18, aiFrequency) + (trend.score - 50) * 0.25);
}

function demandPriceDefenseScore(monthInfo, availability) {
  const base = DEMAND_LEVEL_SCORES[monthInfo.level] || 55;
  const soldRate = Number(availability?.stats?.weightedSoldOutRate);
  const saleSignal = Number.isFinite(soldRate) ? soldRate * 22 : 8;
  const priceSignal = /단가 유지|단가 최적화|보합/.test(monthInfo.price || "") ? 9 : -4;
  return clampScore(base * 0.72 + saleSignal + priceSignal);
}

function buildDemandStructure({ manifest, conditions, regions, availability, datalabTrend }) {
  const month = demandMonthFromConditions(conditions);
  const monthInfo = MONTHLY_DEMAND_MAP.find((entry) => entry.month === month) || MONTHLY_DEMAND_MAP[0];
  const topSegments = demandTopSegments(monthInfo, 3);
  const demandScore = DEMAND_LEVEL_SCORES[monthInfo.level] || 55;
  const targetFitScore = clampScore(
    topSegments.reduce((sum, segment) => sum + Math.min(100, segment.fitScore), 0) / Math.max(1, topSegments.length)
  );
  const weekdayScore = clampScore(
    topSegments.reduce((sum, segment) => sum + segment.weekday * 20, 0) / Math.max(1, topSegments.length)
  );
  const priceScore = demandPriceDefenseScore(monthInfo, availability);
  const contentScore = demandContentScore(monthInfo, topSegments, datalabTrend);
  const riskScore = demandRiskScore(monthInfo, regions);
  const aiSignalScore = clampScore(50 + Math.min(30, DEMAND_AI_SIGNALS.reduce((sum, signal) => sum + signal.frequency, 0)));
  const overallScore = clampScore(
    demandScore * 0.25 +
    targetFitScore * 0.20 +
    weekdayScore * 0.15 +
    priceScore * 0.15 +
    contentScore * 0.10 +
    riskScore * 0.10 +
    aiSignalScore * 0.05
  );
  const overallLabel = overallScore >= 82
    ? "강한 수요"
    : overallScore >= 68
      ? "선별 공략"
      : overallScore >= 55
        ? "보통 수요"
        : "주의 필요";
  const targetKeywords = Array.from(new Set([
    ...(monthInfo.keywords || []),
    ...topSegments.flatMap((segment) => segment.keywords || [])
  ])).slice(0, 8);

  return {
    source: "숙박업 메인터넌스",
    sourceVersion: "2026-03-08 사전 기준",
    keyword: manifest?.keyword || conditions?.keyword || "",
    month,
    monthLabel: `${month}월`,
    season: monthInfo.season,
    overallScore,
    overallLabel,
    summary: `${monthInfo.month || month}월은 ${monthInfo.level} 수요 구간이며 ${topSegments.map((item) => item.name).join(", ")} 중심으로 판단합니다.`,
    metrics: [
      { key: "monthlyDemand", label: "월 수요강도", score: demandScore, value: monthInfo.level, note: `${monthInfo.season} · ${monthInfo.operation}` },
      { key: "targetFit", label: "핵심타겟 적합도", score: targetFitScore, value: topSegments.map((item) => item.group).join("·"), note: topSegments.map((item) => item.name).join(" · ") },
      { key: "weekday", label: "평일 확장성", score: weekdayScore, value: weekdayScore >= 70 ? "높음" : weekdayScore >= 50 ? "보통" : "낮음", note: monthInfo.weekdaySignal },
      { key: "price", label: "가격 방어력", score: priceScore, value: priceScore >= 80 ? "높음" : priceScore >= 60 ? "보통" : "낮음", note: monthInfo.price },
      { key: "content", label: "콘텐츠 반응", score: contentScore, value: contentScore >= 75 ? "강함" : contentScore >= 55 ? "보통" : "약함", note: monthInfo.content },
      { key: "risk", label: "운영 리스크 보정", score: riskScore, value: riskScore >= 75 ? "안정" : riskScore >= 55 ? "주의" : "위험", note: (monthInfo.risks || []).join(" · ") || "특이 리스크 없음" },
      { key: "aiSignal", label: "AI 신호 반영", score: aiSignalScore, value: `${DEMAND_AI_SIGNALS.length}개 신호`, note: DEMAND_AI_SIGNALS.map((signal) => signal.keyword).join(" · ") }
    ],
    radar: [
      { label: "월수요", score: demandScore },
      { label: "타겟", score: targetFitScore },
      { label: "평일", score: weekdayScore },
      { label: "가격", score: priceScore },
      { label: "콘텐츠", score: contentScore },
      { label: "리스크", score: riskScore }
    ],
    topSegments: topSegments.map((segment) => ({
      name: segment.name,
      group: segment.group,
      score: clampScore(segment.fitScore),
      priority: segment.priority,
      operation: segment.operation,
      caution: segment.caution,
      message: segment.message,
      keywords: segment.keywords
    })),
    recommendedOperations: [
      monthInfo.action,
      monthInfo.interpretation,
      ...topSegments.map((segment) => segment.operation)
    ].filter(Boolean).slice(0, 5),
    contentKeywords: targetKeywords,
    risks: monthInfo.risks || [],
    priceStrategy: monthInfo.price,
    interpretation: monthInfo.interpretation,
    aiSignals: DEMAND_AI_SIGNALS
  };
}

function numericField(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(String(value).replace(/,/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function jsonArrayField(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) return value;
    const text = String(value || "").trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Older result rows do not carry structured product details.
    }
  }
  return [];
}

function dateDiffDays(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.round((end - start) / 86400000);
}

function bookingDaysFromRange(checkIn, checkOut) {
  const diff = dateDiffDays(checkIn, checkOut);
  return diff > 1 ? Math.min(31, diff + 1) : 1;
}

function resolveBookingRangePlaceLimit(value, bookingRangeDays) {
  const text = String(value ?? "").trim();
  if (!text) return Number(bookingRangeDays) > 1 ? 10 : 0;
  const number = Number(text);
  if (!Number.isFinite(number)) return Number(bookingRangeDays) > 1 ? 10 : 0;
  return Math.max(0, Math.min(20, Math.floor(number)));
}

function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `${Math.round(number * 100)}%`;
}

function parseWeeklyReservationRates(detail) {
  const matches = String(detail || "").matchAll(/(\d{2}\/\d{2})\s+(\d+)\/(\d+)/g);
  const rows = [];
  for (const match of matches) {
    const date = match[1];
    const available = Number(match[2]);
    const total = Number(match[3]);
    if (!Number.isFinite(available) || !Number.isFinite(total) || total <= 0) continue;
    const soldOut = Math.max(0, total - available);
    const rate = soldOut / total;
    rows.push({ date, soldOut, total, rate });
  }
  if (!rows.length) return { average: null, detail: "", totalSoldOut: null, totalStock: null };
  const average = Number((rows.reduce((sum, row) => sum + row.rate, 0) / rows.length).toFixed(3));
  const totalSoldOut = rows.reduce((sum, row) => sum + row.soldOut, 0);
  const totalStock = rows.reduce((sum, row) => sum + row.total, 0);
  const rateDetail = rows.map((row) => `${row.date} ${formatRate(row.rate)}(${row.soldOut}/${row.total})`).join(", ");
  return { average, detail: rateDetail, totalSoldOut, totalStock };
}

function parseStockVarianceDetail(detail) {
  const rows = [];
  const matches = String(detail || "").matchAll(/(\d{1,2}\/\d{1,2}).*?원시\s+(\d+)\/(\d+)(?:.*?오프라인예약\s+(\d+))?/g);
  for (const match of matches) {
    const rawAvailable = Number(match[2]);
    const rawTotal = Number(match[3]);
    const offlineReserved = Number(match[4] || 0);
    if (!Number.isFinite(rawAvailable) || !Number.isFinite(rawTotal) || rawTotal <= 0) continue;
    rows.push({
      label: match[1],
      rawAvailable,
      rawTotal,
      offlineReserved: Number.isFinite(offlineReserved) ? offlineReserved : 0
    });
  }
  const totals = rows.map((row) => row.rawTotal).filter((value) => value > 0);
  const minTotal = totals.length ? Math.min(...totals) : null;
  const maxTotal = totals.length ? Math.max(...totals) : null;
  const maxTotalDays = maxTotal ? totals.filter((value) => value === maxTotal).length : null;
  const normalizedRows = rows.map((row) => ({
    ...row,
    offlineReserved: row.offlineReserved || (maxTotal ? Math.max(0, maxTotal - row.rawTotal) : 0)
  }));
  return {
    rows: normalizedRows,
    minTotal,
    maxTotal,
    maxTotalDays,
    totalVarianceGap: minTotal !== null && maxTotal !== null ? Math.max(0, maxTotal - minTotal) : null,
    totalOfflineReserved: normalizedRows.reduce((sum, row) => sum + Number(row.offlineReserved || 0), 0) || null
  };
}

function maxPositiveNumber(...values) {
  const numbers = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return numbers.length ? Math.max(...numbers) : null;
}

function parseBasisTotalFromRule(rule) {
  const text = String(rule || "");
  const matches = Array.from(text.matchAll(/(?:후보|보정값|기준)[^\d]{0,24}(\d{1,5})/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (matches.length) return Math.max(...matches);
  const equalsMatch = text.match(/=\s*(\d{1,5})\s*(?:개|회)?/);
  const equalsValue = equalsMatch ? Number(equalsMatch[1]) : null;
  return Number.isFinite(equalsValue) && equalsValue > 0 ? equalsValue : null;
}

function basisRuleForTotal(storedRule, basisTotal, fallbackBuilder) {
  const parsedTotal = parseBasisTotalFromRule(storedRule);
  if (storedRule && (!basisTotal || !parsedTotal || parsedTotal === basisTotal)) return storedRule;
  return basisTotal ? fallbackBuilder(basisTotal) : "";
}

function operatingTotalFromVarianceRows(rows = [], basisTotal = null) {
  const total = Number(basisTotal);
  if (!Number.isFinite(total) || total <= 0) return { operatingTotal: null, operatingTotalDays: null };
  const totals = rows
    .map((row) => Number(row.rawTotal))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!totals.length) return { operatingTotal: total, operatingTotalDays: null };
  const frequency = new Map();
  totals.forEach((value) => frequency.set(value, (frequency.get(value) || 0) + 1));
  const maxTotalDays = frequency.get(total) || 0;
  const lower = [...frequency.entries()]
    .filter(([value]) => value > 0 && value < total)
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return right[0] - left[0];
    });
  const stableLower = lower.find(([, count]) => (
    count >= Math.max(2, Math.ceil(totals.length * 0.5)) &&
    count > maxTotalDays
  ));
  if (!stableLower) return { operatingTotal: total, operatingTotalDays: maxTotalDays || null };
  return { operatingTotal: stableLower[0], operatingTotalDays: stableLower[1] };
}

function resolvedStockBasis({ basisTotal, explicitBasisTotal, storedRule, variance, operatingTotal, operatingTotalDays, structuralBlockedTotal, stockBasisType } = {}) {
  const candidateTotal = maxPositiveNumber(basisTotal, parseBasisTotalFromRule(storedRule));
  let resolvedOperating = Number(operatingTotal);
  let resolvedOperatingDays = Number(operatingTotalDays);
  if (!Number.isFinite(resolvedOperating) || resolvedOperating <= 0) {
    const inferred = operatingTotalFromVarianceRows(variance?.rows || [], candidateTotal);
    resolvedOperating = inferred.operatingTotal;
    resolvedOperatingDays = inferred.operatingTotalDays;
  }
  const explicit = Number(explicitBasisTotal);
  if (
    Number.isFinite(explicit) &&
    explicit > 0 &&
    candidateTotal &&
    explicit < candidateTotal &&
    (!resolvedOperating || resolvedOperating >= candidateTotal)
  ) {
    resolvedOperating = explicit;
  }
  if (!Number.isFinite(resolvedOperating) || resolvedOperating <= 0) resolvedOperating = candidateTotal;
  if (!Number.isFinite(resolvedOperatingDays) || resolvedOperatingDays < 0) resolvedOperatingDays = null;
  const resolvedStructural = Number.isFinite(Number(structuralBlockedTotal)) && Number(structuralBlockedTotal) >= 0
    ? Number(structuralBlockedTotal)
    : Math.max(0, Number(candidateTotal || 0) - Number(resolvedOperating || 0));
  return {
    basisTotal: candidateTotal,
    operatingTotal: resolvedOperating || null,
    operatingTotalDays: resolvedOperatingDays,
    structuralBlockedTotal: resolvedStructural || null,
    stockBasisType: stockBasisType || (resolvedStructural > 0 ? "operating_reduced" : candidateTotal ? "max_total" : "")
  };
}

function offlineReservedTotalForOperating(variance = {}, operatingTotal = null) {
  const operating = Number(operatingTotal);
  if (!Number.isFinite(operating) || operating <= 0 || !Array.isArray(variance.rows) || !variance.rows.length) {
    return variance.totalOfflineReserved;
  }
  const total = variance.rows.reduce((sum, row) => {
    const rawTotal = Number(row.rawTotal);
    return sum + (Number.isFinite(rawTotal) ? Math.max(0, operating - rawTotal) : 0);
  }, 0);
  return total || null;
}

function stockBasisRule(storedRule, basisTotal, operatingTotal, structuralBlockedTotal, offlineReservedTotal, unitLabel = "개", totalLabel = "숙박") {
  const parsedTotal = parseBasisTotalFromRule(storedRule);
  if (storedRule && basisTotal && parsedTotal === basisTotal && !structuralBlockedTotal) return storedRule;
  if (!basisTotal) return "";
  return `전체객실수후보=${basisTotal}${unitLabel}(날짜별 ${totalLabel} 총량 최대값)` +
    (structuralBlockedTotal ? ` · 운영판매기준=${operatingTotal}${unitLabel} · 상시차단/운영축소 ${structuralBlockedTotal}${unitLabel}` : "") +
    (offlineReservedTotal ? ` · 운영기준 미만 ${offlineReservedTotal}${unitLabel} 오프라인/차단 추정` : "");
}

function stableHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16);
}

function runDateFromId(runId) {
  const match = String(runId || "").match(/(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

function normalizeObservationNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateFromMonthDay(label, checkIn) {
  const match = String(label || "").match(/(\d{1,2})\/(\d{1,2})/);
  if (!match) return "";
  const base = String(checkIn || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const year = base ? Number(base[1]) : new Date().getFullYear();
  const baseMonth = base ? Number(base[2]) : Number(match[1]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const resolvedYear = month < baseMonth && baseMonth >= 11 ? year + 1 : year;
  return `${resolvedYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseAvailabilityDetail(detail, checkIn) {
  const rows = [];
  const matches = String(detail || "").matchAll(/(\d{1,2}\/\d{1,2})\s+(\d+)\/(\d+)/g);
  for (const match of matches) {
    const available = Number(match[2]);
    const total = Number(match[3]);
    if (!Number.isFinite(available) || !Number.isFinite(total) || total <= 0) continue;
    rows.push({
      stayDate: dateFromMonthDay(match[1], checkIn),
      label: match[1],
      available,
      total
    });
  }
  return rows.filter((row) => row.stayDate);
}

function parseReservationRateDetail(detail, checkIn) {
  const rows = [];
  const matches = String(detail || "").matchAll(/(\d{1,2}\/\d{1,2})\s+\d+%\((\d+)\/(\d+)\)/g);
  for (const match of matches) {
    const sold = Number(match[2]);
    const total = Number(match[3]);
    if (!Number.isFinite(sold) || !Number.isFinite(total) || total <= 0) continue;
    rows.push({
      stayDate: dateFromMonthDay(match[1], checkIn),
      label: match[1],
      available: Math.max(0, total - sold),
      total
    });
  }
  return rows.filter((row) => row.stayDate);
}

function manualCorrectionHasValue(correction = {}) {
  if (!correction || correction.active === false) return false;
  const lodging = Number(correction.lodgingBasisTotal);
  const dayUse = Number(correction.dayUseBasisTotal);
  const note = String(correction.note || "").trim();
  return manualCorrectionHasBasis(correction) || note.length > 0;
}

function manualCorrectionHasBasis(correction = {}) {
  if (!correction || correction.active === false) return false;
  const lodging = Number(correction.lodgingBasisTotal);
  const dayUse = Number(correction.dayUseBasisTotal);
  return (Number.isFinite(lodging) && lodging > 0)
    || (Number.isFinite(dayUse) && dayUse > 0);
}

function hasActiveManualCorrection(item = {}) {
  const correction = item.companyManualCorrection || item.companyProfile?.manualCorrection || item.manualCorrection || null;
  return manualCorrectionHasBasis(correction);
}

function applyOfflineReservationBasis(rows, basisTotal, options = {}) {
  const resolvedBasis = Number(basisTotal);
  if (!Number.isFinite(resolvedBasis) || resolvedBasis <= 0) return rows;
  const authoritative = Boolean(options.authoritative);
  return rows.map((row) => {
    const rawTotal = Number(row.total || 0);
    const rawAvailable = Number(row.available || 0);
    if (!Number.isFinite(rawTotal) || rawTotal <= 0 || !Number.isFinite(rawAvailable)) return row;
    if (!authoritative && rawTotal >= resolvedBasis) return row;
    const correctedTotal = authoritative ? resolvedBasis : Math.max(rawTotal, resolvedBasis);
    if (!Number.isFinite(correctedTotal) || correctedTotal <= 0) return row;
    const rawSold = Math.max(0, rawTotal - Math.max(0, Math.min(rawAvailable, rawTotal)));
    const offlineReserved = Math.max(0, correctedTotal - rawTotal);
    const correctedSold = Math.max(0, Math.min(correctedTotal, rawSold + offlineReserved));
    return {
      ...row,
      rawTotal,
      rawAvailable: Math.max(0, Math.min(rawAvailable, rawTotal)),
      rawSold,
      offlineReserved,
      stockBasisAdjusted: authoritative && rawTotal !== correctedTotal,
      total: correctedTotal,
      available: Math.max(0, correctedTotal - correctedSold)
    };
  });
}

function singleAvailabilityRow(stayDate, available, total) {
  const resolvedAvailable = normalizeObservationNumber(available);
  const resolvedTotal = normalizeObservationNumber(total);
  if (resolvedAvailable === null || resolvedTotal === null || resolvedTotal <= 0) return [];
  return [{
    stayDate,
    label: stayDate,
    available: Math.max(0, resolvedAvailable),
    total: resolvedTotal
  }];
}

function historySeriesForItem(item, productType, checkIn) {
  if (productType === "dayuse") {
    const rows = parseAvailabilityDetail(item.dayUseWeeklyDetail, checkIn)
      .concat(parseReservationRateDetail(item.dayUseWeeklyReservationRateDetail, checkIn))
      .reduce((rows, row) => rows.some((itemRow) => itemRow.stayDate === row.stayDate) ? rows : [...rows, row], [])
      .concat(
        !item.dayUseWeeklyDetail && !item.dayUseWeeklyReservationRateDetail
          ? singleAvailabilityRow(checkIn, item.dayUseAvailableStock, item.dayUseTotalStock)
          : []
      );
    return applyOfflineReservationBasis(rows, item.dayUseWeeklyBasisTotal, { authoritative: hasActiveManualCorrection(item) });
  }

  const rows = parseAvailabilityDetail(item.weeklyDetail, checkIn)
    .concat(parseReservationRateDetail(item.weeklyReservationRateDetail, checkIn))
    .reduce((rows, row) => rows.some((itemRow) => itemRow.stayDate === row.stayDate) ? rows : [...rows, row], [])
    .concat(
      !item.weeklyDetail && !item.weeklyReservationRateDetail
        ? singleAvailabilityRow(checkIn, item.nightAvailableStock ?? item.availableRooms, item.nightTotalStock ?? item.totalRooms)
        : []
    );
  return applyOfflineReservationBasis(rows, item.weeklyBasisTotal, { authoritative: hasActiveManualCorrection(item) });
}

function dayOfWeekFromDate(dateText) {
  const match = String(dateText || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const day = date.getUTCDay();
  return Number.isFinite(day) ? day : null;
}

function toNullableRate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : null;
}

function normalizeSignalRows(rows = []) {
  return rows
    .map((row) => {
      const total = Number(row.total);
      const available = Number(row.available);
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(available)) return null;
      const resolvedAvailable = Math.max(0, Math.min(available, total));
      const sold = Math.max(0, total - resolvedAvailable);
      return {
        stayDate: row.stayDate || "",
        dayOfWeek: dayOfWeekFromDate(row.stayDate),
        total,
        available: resolvedAvailable,
        sold,
        rate: total ? sold / total : 0
      };
    })
    .filter(Boolean);
}

function averageSignalRate(rows = []) {
  const valid = rows.filter((row) => Number.isFinite(row.rate));
  if (!valid.length) return null;
  return toNullableRate(valid.reduce((sum, row) => sum + row.rate, 0) / valid.length);
}

function summarizeProductSalesSignal(rows = []) {
  const normalized = normalizeSignalRows(rows);
  const byDay = (day) => normalized.filter((row) => row.dayOfWeek === day);
  const weekdayRows = normalized.filter((row) => row.dayOfWeek >= 1 && row.dayOfWeek <= 4);
  const totals = normalized.map((row) => row.total).filter((value) => value > 0);
  const minTotal = totals.length ? Math.min(...totals) : null;
  const maxTotal = totals.length ? Math.max(...totals) : null;
  const fridayRate = averageSignalRate(byDay(5));
  const saturdayRate = averageSignalRate(byDay(6));
  const sundayRate = averageSignalRate(byDay(0));
  const weekdayRate = averageSignalRate(weekdayRows);
  const overallRate = averageSignalRate(normalized);
  const anchorRate = saturdayRate ?? overallRate ?? null;
  return {
    days: normalized.length,
    totalSupply: normalized.reduce((sum, row) => sum + row.total, 0),
    totalSold: normalized.reduce((sum, row) => sum + row.sold, 0),
    averageRate: overallRate,
    fridayRate,
    saturdayRate,
    sundayRate,
    weekdayRate,
    fridayWeak: fridayRate !== null && (fridayRate <= 0.25 || (anchorRate !== null && anchorRate >= 0.55 && fridayRate + 0.25 < anchorRate)),
    sundayWeak: sundayRate !== null && (sundayRate <= 0.22 || (anchorRate !== null && anchorRate >= 0.55 && sundayRate + 0.28 < anchorRate)),
    weekdayWeak: weekdayRows.length >= 2 && weekdayRate !== null && (weekdayRate <= 0.22 || (anchorRate !== null && anchorRate >= 0.55 && weekdayRate + 0.30 < anchorRate)),
    stockVariance: minTotal !== null && maxTotal !== null && maxTotal > minTotal,
    stockVarianceRatio: minTotal ? toNullableRate(maxTotal / minTotal) : null,
    minTotal,
    maxTotal
  };
}

function companySalesSignalFromItem(item = {}, run = {}) {
  const checkIn = run.checkIn || runDateFromId(run.id) || kstDate(0);
  const lodging = summarizeProductSalesSignal(historySeriesForItem(item, "lodging", checkIn));
  const dayUse = summarizeProductSalesSignal(historySeriesForItem(item, "dayuse", checkIn));
  const structureFlags = Array.isArray(item.inventoryStructureFlags) ? item.inventoryStructureFlags : [];
  const manualApplied = hasActiveManualCorrection(item);
  const confidenceGrade = String(item.inventoryConfidenceGrade || "").toUpperCase();
  const structureWeak = Boolean(confidenceGrade && !["A", "B"].includes(confidenceGrade));
  const dayUseHasSupply = dayUse.totalSupply > 0 || Number(item.dayUseTotalStock || 0) > 0 || Number(item.dayUseItemCount || 0) > 0;
  const couponSignal = naverCouponSignalFromItem(item);
  return {
    checkIn,
    lodging,
    dayUse,
    lodgingDays: lodging.days,
    dayUseDays: dayUse.days,
    dayUseMissing: !dayUseHasSupply,
    lodgingBasisTotal: snapshotNumber(item.weeklyBasisTotal),
    lodgingOperatingTotal: snapshotNumber(item.weeklyOperatingTotal),
    lodgingStructuralBlockedTotal: snapshotNumber(item.weeklyStructuralBlockedTotal),
    lodgingMaxTotalDays: snapshotNumber(item.weeklyMaxTotalDays),
    lodgingTotalVarianceGap: snapshotNumber(item.weeklyTotalVarianceGap),
    lodgingOfflineReservedTotal: snapshotNumber(item.weeklyOfflineReservedTotal),
    lodgingBasisRule: item.weeklyBasisRule || "",
    dayUseBasisTotal: snapshotNumber(item.dayUseWeeklyBasisTotal),
    dayUseOperatingTotal: snapshotNumber(item.dayUseWeeklyOperatingTotal),
    dayUseStructuralBlockedTotal: snapshotNumber(item.dayUseWeeklyStructuralBlockedTotal),
    dayUseOfflineReservedTotal: snapshotNumber(item.dayUseWeeklyOfflineReservedTotal),
    dayUseBasisRule: item.dayUseWeeklyBasisRule || "",
    structureWeak,
    stockVariance: Boolean(lodging.stockVariance || dayUse.stockVariance || structureFlags.includes("dynamic_capacity")),
    bookingIdReused: structureFlags.includes("booking_id_reused"),
    groupedStock: structureFlags.includes("grouped_range") || ["grouped_stock", "stock_only", "unknown"].includes(String(item.inventoryStructureType || "")),
    manualCorrectionApplied: manualApplied,
    couponSignal,
    naverCouponVisible: couponSignal.visible,
    naverCouponStatus: couponSignal.status,
    naverCouponNames: couponSignal.names,
    naverCouponChannel: couponSignal.channel,
    naverCouponDetail: couponSignal.detail,
    structureFlags: boundedUnique([
      ...structureFlags,
      manualApplied ? "manual_correction" : ""
    ], 10)
  };
}

function naverCouponSignalFromItem(item = {}) {
  const status = String(item.naverCouponStatus || item["네이버쿠폰노출상태"] || "").trim();
  const names = String(item.naverCouponNames || item["네이버쿠폰명"] || "").trim();
  const channel = String(item.naverCouponChannel || item["네이버쿠폰확인채널"] || "").trim();
  const detail = String(item.naverCouponDetail || item["네이버쿠폰상세"] || "").trim();
  const visible = status === "있음" || Boolean(names);
  return {
    visible,
    status: status || (visible ? "있음" : ""),
    names,
    channel: channel || (visible ? "네이버" : ""),
    detail: detail || (visible ? `네이버 공개 노출 쿠폰: ${names || "쿠폰명 확인"}` : "")
  };
}

function snapshotNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function companyRevenueSnapshotPart(item = {}, config = {}) {
  const weeklyRevenue = snapshotNumber(item[config.weeklyRevenue]);
  const basisRevenue = snapshotNumber(item[config.basisRevenue]);
  const weeklyAdjusted = snapshotNumber(item[config.weeklyAdjusted]);
  const basisAdjusted = snapshotNumber(item[config.basisAdjusted]);
  const weeklyGap = snapshotNumber(item[config.weeklyGap]);
  const basisGap = snapshotNumber(item[config.basisGap]);
  const weeklyPrecisionRate = snapshotNumber(item[config.weeklyPrecisionRate]);
  const basisPrecisionRate = snapshotNumber(item[config.basisPrecisionRate]);
  const weeklyPriced = snapshotNumber(item[config.weeklyPriced]);
  const basisPriced = snapshotNumber(item[config.basisPriced]);
  const weeklyMissing = snapshotNumber(item[config.weeklyMissing]);
  const basisMissing = snapshotNumber(item[config.basisMissing]);
  const weeklyAvg = snapshotNumber(item[config.weeklyAvg]);
  const basisAvg = snapshotNumber(item[config.basisAvg]);
  const hasWeekly = [
    weeklyRevenue,
    weeklyAdjusted,
    weeklyGap,
    weeklyPrecisionRate,
    weeklyPriced,
    weeklyMissing,
    weeklyAvg
  ].some((value) => value !== null);
  return {
    revenue: hasWeekly ? weeklyRevenue : basisRevenue,
    adjustedRevenue: hasWeekly ? weeklyAdjusted : basisAdjusted,
    missingPriceEstimatedRevenue: hasWeekly ? weeklyGap : basisGap,
    revenuePrecisionRate: hasWeekly ? weeklyPrecisionRate : basisPrecisionRate,
    pricedSoldOut: hasWeekly ? weeklyPriced : basisPriced,
    missingPriceSoldOut: hasWeekly ? weeklyMissing : basisMissing,
    avgSoldUnitPrice: hasWeekly ? weeklyAvg : basisAvg,
    byDayType: item[config.byDayType] || "",
    detail: item[config.detail] || "",
    offlineDetail: item[config.offlineDetail] || "",
    basis: hasWeekly ? "range" : "basis"
  };
}

function companyRevenueSnapshotFromItem(item = {}) {
  return {
    lodging: companyRevenueSnapshotPart(item, {
      weeklyRevenue: "weeklyEstimatedRevenue",
      basisRevenue: "basisLodgingRevenue",
      weeklyAdjusted: "weeklyAdjustedRevenue",
      basisAdjusted: "basisLodgingAdjustedRevenue",
      weeklyGap: "weeklyMissingPriceEstimatedRevenue",
      basisGap: "basisLodgingMissingPriceEstimatedRevenue",
      weeklyPrecisionRate: "weeklyRevenuePrecisionRate",
      basisPrecisionRate: "basisLodgingRevenuePrecisionRate",
      weeklyPriced: "weeklyPricedSoldOut",
      basisPriced: "basisLodgingPricedSoldOut",
      weeklyMissing: "weeklyMissingPriceSoldOut",
      basisMissing: "basisLodgingMissingPriceSoldOut",
      weeklyAvg: "weeklyAvgSoldUnitPrice",
      basisAvg: "basisLodgingAvgSoldUnitPrice",
      byDayType: "weeklyRevenueByDayType",
      detail: "weeklyRevenueDetail",
      offlineDetail: "weeklyOfflineReservationDetail"
    }),
    dayUse: companyRevenueSnapshotPart(item, {
      weeklyRevenue: "dayUseWeeklyEstimatedRevenue",
      basisRevenue: "basisDayUseRevenue",
      weeklyAdjusted: "dayUseWeeklyAdjustedRevenue",
      basisAdjusted: "basisDayUseAdjustedRevenue",
      weeklyGap: "dayUseWeeklyMissingPriceEstimatedRevenue",
      basisGap: "basisDayUseMissingPriceEstimatedRevenue",
      weeklyPrecisionRate: "dayUseWeeklyRevenuePrecisionRate",
      basisPrecisionRate: "basisDayUseRevenuePrecisionRate",
      weeklyPriced: "dayUseWeeklyPricedSoldOut",
      basisPriced: "basisDayUsePricedSoldOut",
      weeklyMissing: "dayUseWeeklyMissingPriceSoldOut",
      basisMissing: "basisDayUseMissingPriceSoldOut",
      weeklyAvg: "dayUseWeeklyAvgSoldUnitPrice",
      basisAvg: "basisDayUseAvgSoldUnitPrice",
      byDayType: "dayUseWeeklyRevenueByDayType",
      detail: "dayUseWeeklyRevenueDetail",
      offlineDetail: "dayUseWeeklyOfflineReservationDetail"
    })
  };
}

function emptyCompanyMaster() {
  return {
    schemaVersion: 1,
    updatedAt: "",
    companies: {},
    sourceIndex: {},
    duplicateResolutions: {}
  };
}

async function readCompanyMaster() {
  try {
    const parsed = JSON.parse((await fsp.readFile(COMPANY_MASTER_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return {
      ...emptyCompanyMaster(),
      ...parsed,
      companies: parsed.companies || {},
      sourceIndex: parsed.sourceIndex || {},
      duplicateResolutions: parsed.duplicateResolutions || {}
    };
  } catch {
    return emptyCompanyMaster();
  }
}

async function writeCompanyMaster(master) {
  await fsp.mkdir(COMPANY_MASTER_DIR, { recursive: true });
  const next = { ...master, updatedAt: new Date().toISOString() };
  master.updatedAt = next.updatedAt;
  const tempPath = `${COMPANY_MASTER_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fsp.rename(tempPath, COMPANY_MASTER_FILE);
}

function companySourceKeys(entity = {}) {
  const keys = [];
  if (entity.placeId) keys.push(`place:${entity.placeId}`);
  if (entity.bookingBusinessId) keys.push(`booking:${entity.bookingBusinessId}`);
  if (entity.nameKey && entity.addressKey) keys.push(`name_addr:${entity.nameKey}:${entity.addressKey}`);
  if (entity.nameKey && entity.regionKey) keys.push(`name_region:${entity.nameKey}:${entity.regionKey}`);
  return boundedUnique(keys, 10);
}

function companyEntityFromItem(item = {}, run = {}, collectedAt = "") {
  const name = String(item.name || "").trim();
  const region = String(item.region || "").trim();
  const address = String(item.address || "").trim();
  const placeId = extractNaverPlaceId(item);
  const bookingBusinessId = extractBookingBusinessId(item);
  const nameKey = normalizeCompanyIdentityName(name);
  const looseNameKey = normalizeCompanyLooseName(name);
  const addressKey = normalizeAddressKey(address);
  const regionKey = normalizeCompanyIdentityName(region);
  const sourceKeys = companySourceKeys({ placeId, bookingBusinessId, nameKey, addressKey, regionKey });
  const keywordLayer = keywordLayerFromRunLike(run);
  const salesSignal = companySalesSignalFromItem(item, run);
  const couponSignal = salesSignal.couponSignal || naverCouponSignalFromItem(item);
  const revenueSnapshot = companyRevenueSnapshotFromItem(item);
  return {
    name,
    nameKey,
    looseNameKey,
    region,
    regionKey,
    address,
    addressKey,
    placeId,
    bookingBusinessId,
    sourceKeys,
    url: item.url || "",
    rank: item.rank ?? null,
    keyword: run.keyword || run.label || "",
    keywordKey: compactKeyword(run.keyword || run.label || "").toLowerCase(),
    keywordLayer: keywordLayer.type,
    keywordLayerLabel: keywordLayer.label,
    keywordLayerNote: keywordLayer.note,
    provinceKey: run.province || "",
    searchMode: run.searchMode || "",
    productMode: run.productMode || "",
    sourceRole: sourceRoleForCollectionSource(run.collectionSource, run.sourceRole || USER_ROLES.admin),
    collectionSource: normalizeCollectionSource(run.collectionSource, run.sourceRole || USER_ROLES.admin),
    collectionSourceLabel: run.collectionSourceLabel || collectionSourceLabel(normalizeCollectionSource(run.collectionSource, run.sourceRole || USER_ROLES.admin)),
    runId: run.id || "",
    collectedAt,
    collectedDate: String(collectedAt || "").slice(0, 10),
    listType: item.listType || "",
    inventoryStructureType: item.inventoryStructureType || "",
    inventoryStructureLabel: item.inventoryStructureLabel || "",
    inventoryConfidenceGrade: item.inventoryConfidenceGrade || "",
    inventoryStructureFlags: Array.isArray(item.inventoryStructureFlags) ? item.inventoryStructureFlags : [],
    stockBasis: {
      lodgingBasisTotal: snapshotNumber(item.weeklyBasisTotal),
      lodgingOperatingTotal: snapshotNumber(item.weeklyOperatingTotal),
      lodgingOperatingTotalDays: snapshotNumber(item.weeklyOperatingTotalDays),
      lodgingStructuralBlockedTotal: snapshotNumber(item.weeklyStructuralBlockedTotal),
      lodgingStockBasisType: item.weeklyStockBasisType || "",
      lodgingMinTotal: snapshotNumber(item.weeklyMinTotal),
      lodgingMaxTotal: snapshotNumber(item.weeklyMaxTotal),
      lodgingMaxTotalDays: snapshotNumber(item.weeklyMaxTotalDays),
      lodgingTotalVarianceGap: snapshotNumber(item.weeklyTotalVarianceGap),
      lodgingOfflineReservedTotal: snapshotNumber(item.weeklyOfflineReservedTotal),
      lodgingBasisRule: item.weeklyBasisRule || "",
      dayUseBasisTotal: snapshotNumber(item.dayUseWeeklyBasisTotal),
      dayUseOperatingTotal: snapshotNumber(item.dayUseWeeklyOperatingTotal),
      dayUseOperatingTotalDays: snapshotNumber(item.dayUseWeeklyOperatingTotalDays),
      dayUseStructuralBlockedTotal: snapshotNumber(item.dayUseWeeklyStructuralBlockedTotal),
      dayUseStockBasisType: item.dayUseWeeklyStockBasisType || "",
      dayUseMinTotal: snapshotNumber(item.dayUseWeeklyMinTotal),
      dayUseMaxTotal: snapshotNumber(item.dayUseWeeklyMaxTotal),
      dayUseMaxTotalDays: snapshotNumber(item.dayUseWeeklyMaxTotalDays),
      dayUseTotalVarianceGap: snapshotNumber(item.dayUseWeeklyTotalVarianceGap),
      dayUseOfflineReservedTotal: snapshotNumber(item.dayUseWeeklyOfflineReservedTotal),
      dayUseBasisRule: item.dayUseWeeklyBasisRule || ""
    },
    salesSignal,
    couponSignal,
    revenueSnapshot,
    price: item.price || ""
  };
}

function createCompanyRecord(companyId, entity) {
  const now = entity.collectedAt || new Date().toISOString();
  return {
    companyId,
    primaryName: entity.name || "업체명 확인",
    nameKey: entity.nameKey || "",
    looseNameKey: entity.looseNameKey || "",
    aliases: boundedUnique([entity.name]),
    placeIds: boundedUnique([entity.placeId]),
    bookingBusinessIds: boundedUnique([entity.bookingBusinessId]),
    regions: boundedUnique([entity.region]),
    addresses: boundedUnique([entity.address]),
    urls: boundedUnique([entity.url]),
    firstSeenAt: now,
    lastSeenAt: now,
    firstRunId: entity.runId || "",
    lastRunId: entity.runId || "",
    runIds: boundedUnique([entity.runId], 120),
    sourceRoles: boundedUnique([entity.sourceRole], 6),
    collectionSources: boundedUnique([entity.collectionSource], 12),
    sourceStats: {},
    keywords: {},
    inventory: {
      latest: {},
      structureCounts: {},
      confidenceCounts: {}
    },
    manualCorrection: null,
    duplicateNotes: []
  };
}

function mergeCompanyFieldArrays(company, entity) {
  company.aliases = boundedUnique([...(company.aliases || []), entity.name], 30);
  company.placeIds = boundedUnique([...(company.placeIds || []), entity.placeId], 20);
  company.bookingBusinessIds = boundedUnique([...(company.bookingBusinessIds || []), entity.bookingBusinessId], 20);
  company.regions = boundedUnique([...(company.regions || []), entity.region], 20);
  company.addresses = boundedUnique([...(company.addresses || []), entity.address], 20);
  company.urls = boundedUnique([...(company.urls || []), entity.url], 30);
  company.runIds = boundedUnique([...(company.runIds || []), entity.runId], 120);
  if (!company.primaryName || company.primaryName === "업체명 확인") company.primaryName = entity.name || company.primaryName;
  if (!company.nameKey) company.nameKey = entity.nameKey || "";
  if (!company.looseNameKey) company.looseNameKey = entity.looseNameKey || "";
}

function updateCompanySourceStats(company, entity) {
  const collectionSource = normalizeCollectionSource(entity.collectionSource, entity.sourceRole);
  const sourceRole = sourceRoleForCollectionSource(collectionSource, entity.sourceRole);
  const sourceLabel = entity.collectionSourceLabel || collectionSourceLabel(collectionSource);
  company.sourceRoles = boundedUnique([...(company.sourceRoles || []), sourceRole], 6);
  company.collectionSources = boundedUnique([...(company.collectionSources || []), collectionSource], 12);
  company.sourceStats = company.sourceStats || {};
  const stat = company.sourceStats[collectionSource] || {
    collectionSource,
    sourceRole,
    label: sourceLabel,
    firstSeenAt: entity.collectedAt || "",
    lastSeenAt: "",
    lastRunId: "",
    runIds: [],
    keywords: [],
    observationCount: 0,
    runCount: 0
  };
  const alreadySeenRun = entity.runId && (stat.runIds || []).includes(entity.runId);
  stat.sourceRole = sourceRole;
  stat.label = sourceLabel;
  stat.firstSeenAt = [stat.firstSeenAt, entity.collectedAt].filter(Boolean).sort()[0] || entity.collectedAt || "";
  stat.lastSeenAt = [stat.lastSeenAt, entity.collectedAt].filter(Boolean).sort().at(-1) || entity.collectedAt || "";
  stat.lastRunId = entity.runId || stat.lastRunId || "";
  stat.runIds = boundedUnique([...(stat.runIds || []), entity.runId], 80);
  stat.keywords = boundedUnique([...(stat.keywords || []), entity.keyword], 40);
  if (!alreadySeenRun || !entity.runId) stat.observationCount = Number(stat.observationCount || 0) + 1;
  stat.runCount = stat.runIds.length || Number(stat.runCount || 0);
  company.sourceStats[collectionSource] = stat;
}

function upsertCompanyKeywordExposure(company, entity) {
  if (!entity.keywordKey) return;
  const keyword = company.keywords[entity.keywordKey] || {
    keyword: entity.keyword || entity.keywordKey,
    keywordKey: entity.keywordKey,
    firstSeenAt: entity.collectedAt,
    lastSeenAt: entity.collectedAt,
    bestRank: null,
    latestRank: null,
    latestRunId: "",
    runs: []
  };
  const existingIndex = keyword.runs.findIndex((row) => row.runId === entity.runId);
  const exposure = {
    runId: entity.runId,
    collectedAt: entity.collectedAt,
    collectedDate: entity.collectedDate,
    rank: Number(entity.rank) || null,
    searchMode: entity.searchMode || "",
    productMode: entity.productMode || "",
    sourceRole: entity.sourceRole || "",
    collectionSource: entity.collectionSource || "",
    collectionSourceLabel: entity.collectionSourceLabel || "",
    keywordLayer: entity.keywordLayer || "",
    keywordLayerLabel: entity.keywordLayerLabel || "",
    provinceKey: entity.provinceKey || ""
  };
  if (existingIndex >= 0) keyword.runs[existingIndex] = { ...keyword.runs[existingIndex], ...exposure };
  else keyword.runs.push(exposure);
  keyword.runs = keyword.runs
    .filter((row) => row.runId)
    .sort((a, b) => String(b.collectedAt || "").localeCompare(String(a.collectedAt || "")))
    .slice(0, 80);
  keyword.firstSeenAt = [keyword.firstSeenAt, entity.collectedAt].filter(Boolean).sort()[0] || entity.collectedAt;
  keyword.lastSeenAt = [keyword.lastSeenAt, entity.collectedAt].filter(Boolean).sort().at(-1) || entity.collectedAt;
  keyword.latestRank = exposure.rank;
  keyword.latestRunId = entity.runId;
  keyword.keywordLayer = entity.keywordLayer || keyword.keywordLayer || "";
  keyword.keywordLayerLabel = entity.keywordLayerLabel || keyword.keywordLayerLabel || "";
  keyword.provinceKey = entity.provinceKey || keyword.provinceKey || "";
  const ranks = keyword.runs.map((row) => Number(row.rank)).filter((rank) => Number.isFinite(rank) && rank > 0);
  keyword.bestRank = ranks.length ? Math.min(...ranks) : null;
  keyword.runCount = keyword.runs.length;
  company.keywords[entity.keywordKey] = keyword;
}

function updateCompanyInventory(company, entity) {
  const inventory = company.inventory || { latest: {}, structureCounts: {}, confidenceCounts: {}, runIds: [] };
  const alreadyCounted = entity.runId && (inventory.runIds || []).includes(entity.runId);
  const currentLatest = inventory.latest || {};
  const isSameRun = Boolean(entity.runId && currentLatest.runId && entity.runId === currentLatest.runId);
  if ((currentLatest.runId || currentLatest.collectedAt) && !isSameRun) {
    const previousSnapshot = companyInventorySnapshot(currentLatest);
    inventory.previousLatest = previousSnapshot;
    inventory.snapshots = mergeInventorySnapshots([previousSnapshot, ...(inventory.snapshots || [])]);
  }
  inventory.latest = {
    runId: entity.runId,
    collectedAt: entity.collectedAt,
    sourceRole: entity.sourceRole || "",
    collectionSource: entity.collectionSource || "",
    collectionSourceLabel: entity.collectionSourceLabel || "",
    listType: entity.listType,
    structureType: entity.inventoryStructureType,
    structureLabel: entity.inventoryStructureLabel,
    confidenceGrade: entity.inventoryConfidenceGrade,
    structureFlags: boundedUnique(entity.inventoryStructureFlags || [], 10),
    stockBasis: entity.stockBasis || {},
    salesSignal: entity.salesSignal || {},
    couponSignal: entity.couponSignal || entity.salesSignal?.couponSignal || {},
    revenue: entity.revenueSnapshot || {},
    price: entity.price
  };
  if (!alreadyCounted && entity.inventoryStructureLabel) {
    inventory.structureCounts[entity.inventoryStructureLabel] = (inventory.structureCounts[entity.inventoryStructureLabel] || 0) + 1;
  }
  if (!alreadyCounted && entity.inventoryConfidenceGrade) {
    inventory.confidenceCounts[entity.inventoryConfidenceGrade] = (inventory.confidenceCounts[entity.inventoryConfidenceGrade] || 0) + 1;
  }
  inventory.runIds = boundedUnique([...(inventory.runIds || []), entity.runId], 120);
  company.inventory = inventory;
}

function companyInventorySnapshot(latest = {}) {
  return {
    runId: latest.runId || "",
    collectedAt: latest.collectedAt || "",
    sourceRole: latest.sourceRole || "",
    collectionSource: latest.collectionSource || "",
    collectionSourceLabel: latest.collectionSourceLabel || "",
    listType: latest.listType || "",
    structureType: latest.structureType || "",
    structureLabel: latest.structureLabel || "",
    confidenceGrade: latest.confidenceGrade || "",
    structureFlags: Array.isArray(latest.structureFlags) ? boundedUnique(latest.structureFlags, 12) : [],
    stockBasis: latest.stockBasis || {},
    salesSignal: latest.salesSignal || {},
    couponSignal: latest.couponSignal || latest.salesSignal?.couponSignal || {},
    revenue: latest.revenue || {},
    price: latest.price || "",
    manualCorrectionApplied: Boolean(latest.manualCorrectionApplied),
    correctionBasis: latest.correctionBasis || null
  };
}

function mergeInventorySnapshots(rows = []) {
  const byKey = new Map();
  for (const row of rows) {
    if (!row || !(row.runId || row.collectedAt)) continue;
    const snapshot = companyInventorySnapshot(row);
    const key = snapshot.runId || snapshot.collectedAt;
    const current = byKey.get(key);
    if (!current || String(snapshot.collectedAt || "").localeCompare(String(current.collectedAt || "")) > 0) {
      byKey.set(key, snapshot);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => String(b.collectedAt || "").localeCompare(String(a.collectedAt || "")))
    .slice(0, 8);
}

function keywordExposureLayer(keyword = {}) {
  const latestRun = (keyword.runs || [])[0] || {};
  if (keyword.keywordLayer) {
    return {
      type: keyword.keywordLayer,
      label: keyword.keywordLayerLabel || keywordLayerFromRunLike(keyword).label,
      note: keywordLayerFromRunLike(keyword).note
    };
  }
  if (latestRun.keywordLayer) {
    return {
      type: latestRun.keywordLayer,
      label: latestRun.keywordLayerLabel || keywordLayerFromRunLike({ ...keyword, ...latestRun }).label,
      note: keywordLayerFromRunLike({ ...keyword, ...latestRun }).note
    };
  }
  return keywordLayerFromRunLike({
    keyword: keyword.keyword,
    searchMode: latestRun.searchMode || keyword.searchMode || "",
    keywordType: keyword.keywordType || ""
  });
}

function companyExposureLayerFromKeywords(keywords = []) {
  const regional = keywords.filter((row) => row.layer?.type === "regional");
  const local = keywords.filter((row) => row.layer?.type === "local");
  const company = keywords.filter((row) => row.layer?.type === "company");
  if (regional.length && local.length) {
    return {
      type: "regional_local",
      label: "광역+로컬 장악형",
      note: "권역 키워드와 지역 키워드에 동시에 노출"
    };
  }
  if (local.length && !regional.length) {
    return {
      type: "local_only",
      label: "로컬 전용형",
      note: "지역 키워드에는 노출되나 광역 키워드 노출은 미확인"
    };
  }
  if (regional.length && !local.length) {
    return {
      type: "local_match_pending",
      label: "로컬 매칭 대기",
      note: "광역 노출 업체이며, 대응 로컬 키워드 수집/매칭이 필요"
    };
  }
  if (company.length) {
    return {
      type: "company_only",
      label: "업체명 확인형",
      note: "업체명 검색으로 확인, 키워드 노출 구조 검증 필요"
    };
  }
  return {
    type: "unknown",
    label: "분류 대기",
    note: "노출 키워드 추가 수집 필요"
  };
}

function adjustedRateForBasis(rate, rawDailyTotal, basisTotal) {
  const numericRate = Number(rate);
  const rawTotal = Number(rawDailyTotal);
  const basis = Number(basisTotal);
  if (!Number.isFinite(numericRate) || !Number.isFinite(rawTotal) || rawTotal <= 0 || !Number.isFinite(basis) || basis <= 0) return rate ?? null;
  const rawSold = Math.max(0, rawTotal * numericRate);
  const offlineReserved = Math.max(0, basis - rawTotal);
  const correctedSold = Math.max(0, Math.min(basis, rawSold + offlineReserved));
  return toNullableRate(correctedSold / basis);
}

function applyManualBasisToSalesSummary(summary = {}, basisTotal) {
  const basis = Number(basisTotal);
  const days = Number(summary.days || 0);
  const rawTotalSupply = Number(summary.totalSupply || 0);
  const rawTotalSold = Number(summary.totalSold || 0);
  if (!Number.isFinite(basis) || basis <= 0 || !Number.isFinite(days) || days <= 0 || !Number.isFinite(rawTotalSupply) || rawTotalSupply <= 0) {
    return Number.isFinite(basis) && basis > 0
      ? { ...summary, manualBasisTotal: Math.round(basis), manualCorrectionApplied: false }
      : summary;
  }
  const roundedBasis = Math.round(basis);
  const correctedSupply = roundedBasis * days;
  const offlineReserved = Math.max(0, correctedSupply - rawTotalSupply);
  const correctedSold = Math.max(0, Math.min(correctedSupply, rawTotalSold + offlineReserved));
  const rawDailyTotal = rawTotalSupply / days;
  return {
    ...summary,
    rawTotalSupply,
    rawTotalSold,
    rawAverageRate: summary.averageRate ?? null,
    manualBasisTotal: roundedBasis,
    manualOfflineReserved: Math.round(offlineReserved),
    manualCorrectionApplied: true,
    totalSupply: correctedSupply,
    totalSold: Math.round(correctedSold),
    averageRate: toNullableRate(correctedSupply ? correctedSold / correctedSupply : null),
    fridayRate: adjustedRateForBasis(summary.fridayRate, rawDailyTotal, roundedBasis),
    saturdayRate: adjustedRateForBasis(summary.saturdayRate, rawDailyTotal, roundedBasis),
    sundayRate: adjustedRateForBasis(summary.sundayRate, rawDailyTotal, roundedBasis),
    weekdayRate: adjustedRateForBasis(summary.weekdayRate, rawDailyTotal, roundedBasis),
    stockVariance: Boolean(summary.stockVariance || summary.minTotal !== roundedBasis || summary.maxTotal !== roundedBasis),
    stockVarianceRatio: summary.minTotal ? summary.stockVarianceRatio : null,
    minTotal: roundedBasis,
    maxTotal: roundedBasis
  };
}

function salesSignalWithManualCorrection(signal = {}, correction = {}) {
  if (!manualCorrectionHasBasis(correction)) return signal || {};
  const lodging = applyManualBasisToSalesSummary(signal.lodging || {}, correction.lodgingBasisTotal);
  const dayUse = applyManualBasisToSalesSummary(signal.dayUse || {}, correction.dayUseBasisTotal);
  const applied = Boolean(lodging.manualCorrectionApplied || dayUse.manualCorrectionApplied);
  return {
    ...signal,
    lodging,
    dayUse,
    lodgingDays: lodging.days || signal.lodgingDays || 0,
    dayUseDays: dayUse.days || signal.dayUseDays || 0,
    dayUseMissing: dayUse.totalSupply > 0 ? false : signal.dayUseMissing,
    stockVariance: Boolean(signal.stockVariance || lodging.stockVariance || dayUse.stockVariance),
    manualCorrectionApplied: applied,
    manualCorrection: {
      lodgingBasisTotal: correction.lodgingBasisTotal || null,
      dayUseBasisTotal: correction.dayUseBasisTotal || null,
      note: correction.note || "",
      updatedAt: correction.updatedAt || ""
    },
    structureFlags: boundedUnique([
      ...(Array.isArray(signal.structureFlags) ? signal.structureFlags : []),
      "manual_correction"
    ], 12)
  };
}

function companyInventoryWithManualCorrection(company = {}) {
  const inventory = company.inventory || {};
  const correction = company.manualCorrection;
  if (!manualCorrectionHasBasis(correction)) return inventory;
  const latest = inventory.latest || {};
  const correctedSignal = salesSignalWithManualCorrection(latest.salesSignal || {}, correction);
  return {
    ...inventory,
    latest: {
      ...latest,
      salesSignal: correctedSignal,
      manualCorrectionApplied: true,
      correctionBasis: {
        lodgingBasisTotal: correction.lodgingBasisTotal || null,
        dayUseBasisTotal: correction.dayUseBasisTotal || null,
        note: correction.note || "",
        updatedAt: correction.updatedAt || ""
      },
      structureFlags: boundedUnique([
        ...(Array.isArray(latest.structureFlags) ? latest.structureFlags : []),
        "manual_correction"
      ], 12)
    }
  };
}

function companyCorrectionStatus(company = {}, inventory = null) {
  const correction = company.manualCorrection;
  const latest = (inventory || company.inventory || {}).latest || {};
  if (manualCorrectionHasValue(correction)) {
    const parts = [];
    if (correction.lodgingBasisTotal) parts.push(`숙박 운영 ${correction.lodgingBasisTotal}개`);
    if (correction.dayUseBasisTotal) parts.push(`데이유즈 운영 ${correction.dayUseBasisTotal}회`);
    return {
      key: "admin_override",
      label: "관리자 보정",
      detail: parts.join(" · ") || "보정 기준 저장",
      note: correction.note || "관리자 보정값 기준",
      updatedAt: correction.updatedAt || ""
    };
  }
  return {
    key: "auto_estimate",
    label: "자동추정",
    detail: latest.confidenceGrade ? `내부 신뢰도 ${latest.confidenceGrade}` : "추정 대기",
    note: latest.confidenceSummary || "수집값 기반 자동추정",
    updatedAt: latest.collectedAt || ""
  };
}

function companyRecordSummary(company = {}, activeKeywordKey = "") {
  const inventory = companyInventoryWithManualCorrection(company);
  const manualCorrection = manualCorrectionHasValue(company.manualCorrection) ? company.manualCorrection : null;
  const keywords = Object.values(company.keywords || {})
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999) || String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))
    .map((row) => {
      const layer = keywordExposureLayer(row);
      return {
        keyword: row.keyword,
        keywordKey: row.keywordKey,
        runCount: row.runCount || row.runs?.length || 0,
        bestRank: row.bestRank,
        latestRank: row.latestRank,
        lastSeenAt: row.lastSeenAt,
        latestRunId: row.latestRunId,
        layer
      };
    });
  const best = keywords.find((row) => row.bestRank) || keywords[0] || null;
  const activeKeyword = activeKeywordKey ? keywords.find((row) => row.keywordKey === activeKeywordKey) : null;
  const exposureLayer = companyExposureLayerFromKeywords(keywords);
  return {
    companyId: company.companyId,
    primaryName: company.primaryName,
    aliases: (company.aliases || []).slice(0, 6),
    placeIds: company.placeIds || [],
    bookingBusinessIds: company.bookingBusinessIds || [],
    regions: company.regions || [],
    addresses: (company.addresses || []).slice(0, 3),
    firstSeenAt: company.firstSeenAt,
    lastSeenAt: company.lastSeenAt,
    runCount: (company.runIds || []).length,
    sourceRoles: company.sourceRoles || [],
    collectionSources: company.collectionSources || [],
    sourceStats: Object.values(company.sourceStats || {})
      .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))
      .slice(0, 8),
    keywordCount: keywords.length,
    keywords: keywords.slice(0, 8),
    bestRank: best?.bestRank || null,
    bestKeyword: best?.keyword || "",
    latestKeyword: keywords.sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")))[0]?.keyword || "",
    activeKeyword,
    exposureLayer,
    inventory,
    correctionStatus: companyCorrectionStatus(company, inventory),
    manualCorrection,
    manualCorrectionHistory: (company.manualCorrectionHistory || []).slice(-8),
    adminReview: company.adminReview || null,
    adminReviewHistory: (company.adminReviewHistory || []).slice(-8),
    salesContact: company.salesContact || null,
    salesContactHistory: (company.salesContactHistory || []).slice(-12),
    identityConfidence: companyIdentityConfidence(company)
  };
}

function companyIdSetsOverlap(first = [], second = []) {
  const left = new Set((first || []).map((value) => String(value || "").trim()).filter(Boolean));
  return (second || []).some((value) => left.has(String(value || "").trim()));
}

function companiesHaveDistinctStrongIds(companies = [], field = "") {
  if (!companies.length || !companies.every((company) => (company[field] || []).length)) return false;
  for (let i = 0; i < companies.length; i += 1) {
    for (let j = i + 1; j < companies.length; j += 1) {
      if (companyIdSetsOverlap(companies[i][field], companies[j][field])) return false;
    }
  }
  return true;
}

function shouldSuppressDuplicateCandidate(companies = []) {
  return companiesHaveDistinctStrongIds(companies, "placeIds")
    || companiesHaveDistinctStrongIds(companies, "bookingBusinessIds");
}

function findCompanyDuplicateCandidates(master) {
  const buckets = new Map();
  for (const company of Object.values(master.companies || {})) {
    const loose = company.looseNameKey || normalizeCompanyLooseName(company.primaryName);
    const region = normalizeCompanyIdentityName((company.regions || [])[0] || "");
    if (!loose || loose.length < 2) continue;
    const key = `${loose}:${region}`;
    const bucket = buckets.get(key) || [];
    bucket.push(company);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .filter(([key, companies]) => companies.length > 1 && master.duplicateResolutions?.[key] !== "separate")
    .filter(([, companies]) => !shouldSuppressDuplicateCandidate(companies))
    .map(([candidateKey, companies]) => ({
      candidateKey,
      reason: "유사 업체명 + 지역",
      companies: companies.map((company) => companyRecordSummary(company)).slice(0, 6)
    }))
    .slice(0, 20);
}

function summarizeCompanyCrossKeyword(master) {
  const companies = Object.values(master.companies || {}).map((company) => companyRecordSummary(company));
  const byLayer = (type) => companies.filter((company) => company.exposureLayer?.type === type);
  const regionalLocalCompanies = byLayer("regional_local")
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999) || (b.keywordCount || 0) - (a.keywordCount || 0));
  const localOnlyCompanies = byLayer("local_only")
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999) || (b.runCount || 0) - (a.runCount || 0));
  const pendingCompanies = byLayer("local_match_pending")
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999) || (b.runCount || 0) - (a.runCount || 0));
  const companyOnlyCompanies = byLayer("company_only")
    .sort((a, b) => (b.runCount || 0) - (a.runCount || 0));
  const confidenceCounts = companies.reduce((acc, company) => {
    const label = company.identityConfidence?.label || "검토 필요";
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const layerCounts = companies.reduce((acc, company) => {
    const type = company.exposureLayer?.type || "unknown";
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const mapCompany = (company) => ({
    companyId: company.companyId,
    primaryName: company.primaryName,
    runCount: company.runCount,
    keywordCount: company.keywordCount,
    bestRank: company.bestRank,
    bestKeyword: company.bestKeyword,
    exposureLayer: company.exposureLayer,
    identityConfidence: company.identityConfidence,
    keywords: (company.keywords || []).slice(0, 8)
  });
  return {
    totalCompanies: companies.length,
    regionalLocalCompanyCount: regionalLocalCompanies.length,
    localOnlyCompanyCount: localOnlyCompanies.length,
    localMatchPendingCompanyCount: pendingCompanies.length,
    companyOnlyCompanyCount: companyOnlyCompanies.length,
    regionalExposureCompanyCount: companies.filter((company) => (company.keywords || []).some((row) => row.layer?.type === "regional")).length,
    localExposureCompanyCount: companies.filter((company) => (company.keywords || []).some((row) => row.layer?.type === "local")).length,
    keywordLinks: companies.reduce((sum, company) => sum + Number(company.keywordCount || 0), 0),
    confidenceCounts,
    layerCounts,
    regionalLocalCompanies: regionalLocalCompanies.slice(0, 12).map(mapCompany),
    localOnlyCompanies: localOnlyCompanies.slice(0, 12).map(mapCompany),
    localMatchPendingCompanies: pendingCompanies.slice(0, 12).map(mapCompany),
    companyOnlyCompanies: companyOnlyCompanies.slice(0, 12).map(mapCompany),
    reviewNeededCompanies: companies
      .filter((company) => company.identityConfidence?.level === "review" || company.identityConfidence?.level === "medium")
      .sort((a, b) => (b.runCount || 0) - (a.runCount || 0))
      .slice(0, 12)
      .map((company) => ({
        companyId: company.companyId,
        primaryName: company.primaryName,
        runCount: company.runCount,
        keywordCount: company.keywordCount,
        exposureLayer: company.exposureLayer,
        identityConfidence: company.identityConfidence,
        keywords: (company.keywords || []).slice(0, 4)
      }))
  };
}

function salesTargetRankScore(bestRank) {
  const rank = Number(bestRank);
  if (!Number.isFinite(rank) || rank <= 0) return 6;
  if (rank <= 5) return 20;
  if (rank <= 10) return 16;
  if (rank <= 20) return 12;
  return 7;
}

function companySalesTargetSignals(company = {}) {
  const latestInventory = company.inventory?.latest || {};
  const signal = latestInventory.salesSignal || {};
  const lodging = signal.lodging || {};
  const dayUse = signal.dayUse || {};
  const couponSignal = latestInventory.couponSignal || signal.couponSignal || {};
  const latestFlags = Array.isArray(latestInventory.structureFlags) ? latestInventory.structureFlags : [];
  const signalFlags = Array.isArray(signal.structureFlags) ? signal.structureFlags : [];
  const structureFlags = boundedUnique([
    ...latestFlags,
    ...signalFlags
  ], 12);
  const confidenceGrade = String(latestInventory.confidenceGrade || "").toUpperCase();
  const structureWeak = Boolean(
    signal.structureWeak ||
    (confidenceGrade && !["A", "B"].includes(confidenceGrade)) ||
    signal.groupedStock ||
    structureFlags.includes("grouped_range")
  );
  const stockVariance = Boolean(signal.stockVariance || structureFlags.includes("dynamic_capacity"));
  const bookingIdReused = Boolean(signal.bookingIdReused || structureFlags.includes("booking_id_reused"));
  const productNamingReview = Boolean(structureWeak || bookingIdReused || signal.groupedStock);
  const dayUseMissing = Boolean(signal.dayUseMissing && (lodging.totalSupply || lodging.days));
  const otaReviewNeeded = Boolean(structureWeak || stockVariance || bookingIdReused);
  const couponVisible = Boolean(
    signal.naverCouponVisible ||
    couponSignal.visible ||
    couponSignal.status === "있음" ||
    couponSignal.names
  );
  return {
    fridayWeak: Boolean(lodging.fridayWeak),
    sundayWeak: Boolean(lodging.sundayWeak),
    weekdayWeak: Boolean(lodging.weekdayWeak),
    dayUseMissing,
    structureWeak,
    stockVariance,
    bookingIdReused,
    productNamingReview,
    otaReviewNeeded,
    couponVisible,
    couponNames: couponSignal.names || signal.naverCouponNames || "",
    couponStatus: couponSignal.status || signal.naverCouponStatus || "",
    couponChannel: couponSignal.channel || signal.naverCouponChannel || "",
    couponDetail: couponSignal.detail || signal.naverCouponDetail || "",
    lodgingRate: lodging.averageRate ?? null,
    dayUseRate: dayUse.averageRate ?? null,
    fridayRate: lodging.fridayRate ?? null,
    saturdayRate: lodging.saturdayRate ?? null,
    sundayRate: lodging.sundayRate ?? null,
    weekdayRate: lodging.weekdayRate ?? null,
    lodgingDays: lodging.days || 0,
    dayUseDays: dayUse.days || 0
  };
}

function companySalesTargetSignalReasons(signals = {}) {
  const reasons = [];
  const tags = [];
  const scoreParts = [];
  const add = (flag, score, tag, reason) => {
    if (!flag) return;
    scoreParts.push(score);
    tags.push(tag);
    reasons.push(reason);
  };
  add(signals.fridayWeak, 8, "금요일 약함", "토요일 대비 금요일 판매 공백이 보여 금요일 상품/가격 개선 여지");
  add(signals.sundayWeak, 8, "일요일 약함", "주말 이후 일요일 판매가 약해 연박/퇴실일 상품 개선 여지");
  add(signals.weekdayWeak, 5, "평일 약함", "월~목 평균 판매가 낮아 평일 패키지/타깃 보완 여지");
  add(signals.dayUseMissing, 5, "당일상품 공백", "데이유즈/캠프닉 확인 수량이 없어 당일상품 확장 검토");
  add(signals.structureWeak, 6, "수량구조 확인", "객실 수량 구조가 흔들려 총량/상품 단위 검증 필요");
  add(signals.stockVariance, 5, "재고조정 반영", "전체객실수 후보와 운영 판매 기준을 분리하고 운영 기준 미만만 전화예약/차단 가능성");
  add(signals.bookingIdReused, 5, "예약ID 확인", "예약ID 또는 상품 구조 재사용 가능성이 있어 네이버 상품 구조 재확인 필요");
  add(signals.productNamingReview, 4, "상품명 검토", "네이버 예약 상품명/구성이 고객 관점에서 재정리될 여지");
  add(signals.otaReviewNeeded, 4, "OTA 확인", "판단이 흔들리는 업체로 OTA/채널 비교 확인 필요");
  add(signals.couponVisible, 3, "쿠폰 노출", `네이버 쿠폰 노출${signals.couponNames ? `(${signals.couponNames})` : ""}이 있어 가격/프로모션 전략 접근 가능`);
  return {
    score: scoreParts.reduce((sum, value) => sum + Number(value || 0), 0),
    tags: boundedUnique(tags, 8),
    reasons: boundedUnique(reasons, 8)
  };
}

function companyAdminReviewMeta(status) {
  return {
    confirmed: { label: "확인 완료", category: null, scoreDelta: 6, tag: "관리자 확인" },
    check_needed: { label: "확인 필요", category: "verify", scoreFloor: 45, tag: "확인 필요" },
    recrawl_needed: { label: "재수집 필요", category: "verify", scoreFloor: 50, tag: "재수집 필요" },
    contact_ready: { label: "컨택 가능", category: "contact", scoreFloor: 72, tag: "컨택 가능" },
    hold: { label: "보류", category: "observe", scoreCap: 50, tag: "보류" },
    exclude: { label: "제외", category: "exclude", scoreSet: 0, tag: "관리자 제외" },
    manual_needed: { label: "보정 필요", category: "verify", scoreFloor: 55, tag: "보정 필요" }
  }[status] || null;
}

function companySalesContactMeta(status) {
  return {
    not_contacted: { label: "미컨택", tone: "todo", order: 1 },
    first_contacted: { label: "1차 컨택", tone: "progress", order: 2 },
    waiting_reply: { label: "답변 대기", tone: "wait", order: 3 },
    interested: { label: "관심 있음", tone: "good", order: 4 },
    high_potential: { label: "계약 가능성 높음", tone: "strong", order: 5 },
    hold: { label: "보류", tone: "hold", order: 6 },
    excluded: { label: "제외", tone: "bad", order: 7 }
  }[status] || null;
}

function companySalesResponseMeta(status) {
  return {
    not_recorded: { label: "반응 미기록", tone: "todo", score: 0 },
    no_response: { label: "무응답", tone: "wait", score: -8 },
    replied: { label: "답변 있음", tone: "progress", score: 10 },
    requested_materials: { label: "자료 요청", tone: "good", score: 18 },
    meeting_scheduled: { label: "미팅 예정", tone: "strong", score: 28 },
    low_interest: { label: "관심 낮음", tone: "hold", score: -18 },
    price_rejected: { label: "가격 거절", tone: "bad", score: -16 },
    contract_review: { label: "계약 검토", tone: "strong", score: 34 },
    contract_excluded: { label: "계약 제외", tone: "bad", score: -45 }
  }[status] || null;
}

function companySalesResponseReasonMeta(reason) {
  return {
    none: { label: "사유 미기록", tone: "todo" },
    price_issue: { label: "가격 문제", tone: "bad" },
    ops_mismatch: { label: "운영 방식 불일치", tone: "hold" },
    using_ota: { label: "OTA 사용 중", tone: "progress" },
    direct_booking_pref: { label: "직접 예약 선호", tone: "wait" },
    low_room_count: { label: "객실 수 부족", tone: "hold" },
    after_peak: { label: "성수기 이후 재논의", tone: "progress" },
    needs_owner_review: { label: "대표 검토 필요", tone: "good" },
    product_fit: { label: "상품 적합", tone: "strong" },
    offline_booking_high: { label: "오프라인 예약 높음", tone: "good" }
  }[reason] || null;
}

function companyTargetCategoryLabelForServer(category) {
  return {
    contact: "컨택 후보",
    observe: "관찰 후보",
    verify: "검증 후보",
    benchmark: "벤치마크",
    exclude: "제외 후보"
  }[category] || "관찰 후보";
}

function companySalesTargetProfile(company = {}) {
  const layerType = company.exposureLayer?.type || "unknown";
  const scoreParts = [];
  const reasons = [];
  const adminTags = [];
  let category = "exclude";
  let categoryLabel = "제외 후보";

  if (layerType === "local_only") {
    scoreParts.push(48);
    reasons.push("로컬 키워드에는 노출되지만 광역 키워드 노출은 미확인");
    category = "contact";
    categoryLabel = "컨택 후보";
  } else if (layerType === "company_only") {
    scoreParts.push(34);
    reasons.push("업체명 검색으로만 확인되어 키워드 노출 구조 검증 필요");
    category = "observe";
    categoryLabel = "관찰 후보";
  } else if (layerType === "local_match_pending") {
    scoreParts.push(24);
    reasons.push("광역 노출 업체로 로컬 매칭 수집이 먼저 필요");
    category = "verify";
    categoryLabel = "검증 후보";
  } else if (layerType === "regional_local") {
    scoreParts.push(10);
    reasons.push("광역과 로컬에 함께 노출되는 권역 강자");
    category = "benchmark";
    categoryLabel = "벤치마크";
  }

  const rankScore = salesTargetRankScore(company.bestRank);
  scoreParts.push(rankScore);
  if (company.bestRank) reasons.push(`최고 노출 ${company.bestRank}위`);

  const localKeywordCount = (company.keywords || []).filter((row) => row.layer?.type === "local").length;
  const regionalKeywordCount = (company.keywords || []).filter((row) => row.layer?.type === "regional").length;
  if (localKeywordCount) {
    scoreParts.push(Math.min(12, localKeywordCount * 4));
    reasons.push(`로컬 키워드 ${localKeywordCount}개 확인`);
  }
  if (regionalKeywordCount) {
    reasons.push(`광역 키워드 ${regionalKeywordCount}개 확인`);
  }

  if (manualCorrectionHasValue(company.manualCorrection)) {
    scoreParts.push(4);
    reasons.push("수동 보정값 보유");
  }
  if (company.identityConfidence?.level === "certain" || company.identityConfidence?.level === "high") {
    scoreParts.push(6);
    reasons.push(company.identityConfidence.reason || "고유키 신뢰도 높음");
  }

  const latestInventory = company.inventory?.latest || {};
  if (latestInventory.structureLabel) reasons.push(`수량 구조: ${latestInventory.structureLabel}`);
  if (latestInventory.confidenceGrade && !["A", "B"].includes(String(latestInventory.confidenceGrade).toUpperCase())) {
    scoreParts.push(5);
    reasons.push("수량 구조 검증 여지");
  }
  const signals = companySalesTargetSignals(company);
  const signalProfile = companySalesTargetSignalReasons(signals);
  if (signalProfile.score) scoreParts.push(signalProfile.score);
  reasons.push(...signalProfile.reasons);
  const adminReview = company.adminReview || null;
  const adminMeta = companyAdminReviewMeta(adminReview?.status);
  if (adminMeta?.scoreDelta) scoreParts.push(adminMeta.scoreDelta);
  if (adminMeta?.tag) adminTags.push(adminMeta.tag);
  if (adminMeta?.label) reasons.unshift(`관리자 검증: ${adminMeta.label}`);

  let score = Math.min(100, Math.max(0, Math.round(scoreParts.reduce((sum, value) => sum + Number(value || 0), 0))));
  if (category === "contact" && score < 58) {
    category = "observe";
    categoryLabel = "관찰 후보";
  }
  if (category === "benchmark") score = Math.min(score, 45);
  if (category === "verify") score = Math.min(score, 55);
  if (adminMeta?.category) {
    category = adminMeta.category;
    categoryLabel = companyTargetCategoryLabelForServer(category);
  }
  if (Number.isFinite(adminMeta?.scoreSet)) score = adminMeta.scoreSet;
  if (Number.isFinite(adminMeta?.scoreCap)) score = Math.min(score, adminMeta.scoreCap);
  if (Number.isFinite(adminMeta?.scoreFloor)) score = Math.max(score, adminMeta.scoreFloor);

  return {
    ...company,
    salesTarget: {
      score,
      category,
      categoryLabel,
      signals,
      priorityTags: boundedUnique([...adminTags, ...signalProfile.tags], 8),
      reasons: boundedUnique(reasons, 8),
      recommendation: category === "contact"
        ? "광역 진입 여지가 있는 로컬 전용 업체로 우선 컨택"
        : category === "verify"
          ? "주소/지역 기준 로컬 키워드 수집 후 재판정"
          : category === "benchmark"
            ? "상품/리뷰/가격 벤치마크 대상으로 관찰"
            : "추가 수집 후 관찰"
    }
  };
}

function summarizeCompanySalesTargets(companies = []) {
  const profiled = companies.map((company) => company.salesTarget ? company : companySalesTargetProfile(company));
  const byCategory = (category) => profiled
    .filter((company) => company.salesTarget.category === category)
    .sort((a, b) => (b.salesTarget.score || 0) - (a.salesTarget.score || 0) || (a.bestRank || 9999) - (b.bestRank || 9999));
  const contactCandidates = byCategory("contact");
  const observeCandidates = byCategory("observe");
  const verificationQueue = byCategory("verify");
  const benchmarkCompanies = byCategory("benchmark");
  return {
    totalCompanies: profiled.length,
    contactCandidateCount: contactCandidates.length,
    observeCandidateCount: observeCandidates.length,
    verificationQueueCount: verificationQueue.length,
    benchmarkCount: benchmarkCompanies.length,
    topTargets: contactCandidates.slice(0, 20),
    observeCandidates: observeCandidates.slice(0, 12),
    verificationQueue: verificationQueue.slice(0, 12),
    benchmarkCompanies: benchmarkCompanies.slice(0, 12)
  };
}

function findCompanyRecordForEntity(master = {}, entity = {}) {
  const sourceKeys = entity.sourceKeys || [];
  const matchedId = sourceKeys.map((key) => master.sourceIndex?.[key]).find(Boolean);
  if (matchedId && master.companies?.[matchedId]) return master.companies[matchedId];
  const fallbackId = entity.placeId
    ? `cmp_place_${entity.placeId}`
    : `cmp_${stableHash([entity.nameKey, entity.addressKey, entity.regionKey, entity.bookingBusinessId].filter(Boolean).join("|"))}`;
  return master.companies?.[fallbackId] || null;
}

async function applyCompanyMasterOverridesForRun(data, collectedAt = "") {
  const master = await readCompanyMaster();
  const run = data?.run || {};
  const keywordKey = compactKeyword(run.keyword || run.label || "").toLowerCase();
  const items = data?.availability?.items || [];
  let matched = 0;
  let corrected = 0;
  for (let index = 0; index < items.length; index += 1) {
    const entity = companyEntityFromItem(items[index], run, collectedAt);
    if (!entity.nameKey || !entity.sourceKeys.length) continue;
    const company = findCompanyRecordForEntity(master, entity);
    if (!company) continue;
    matched += 1;
    const correctedItem = applyCompanyMasterIdentity(applyCompanyManualCorrection(items[index], company), company);
    if (correctedItem.manualCorrectionApplied) corrected += 1;
    items[index] = {
      ...correctedItem,
      companyId: company.companyId,
      companyProfile: companyRecordSummary(company, keywordKey)
    };
  }
  return {
    applied: matched,
    corrected,
    source: "company_master",
    updatedAt: master.updatedAt || ""
  };
}

function applyCompanyMasterIdentity(item = {}, company = {}) {
  if (!company) return item;
  return {
    ...item,
    name: company.primaryName || item.name || "",
    region: (company.regions || []).find(Boolean) || item.region || "",
    address: (company.addresses || []).find(Boolean) || item.address || ""
  };
}

function applyCompanyManualCorrection(item, company) {
  const correction = company?.manualCorrection;
  if (!manualCorrectionHasValue(correction)) return item;
  const next = {
    ...item,
    companyManualCorrection: correction,
    manualCorrectionApplied: false,
    rawWeeklyBasisTotal: item.weeklyBasisTotal ?? null,
    rawNightTotalStock: item.nightTotalStock ?? item.totalRooms ?? null,
    rawDayUseWeeklyBasisTotal: item.dayUseWeeklyBasisTotal ?? null,
    rawDayUseTotalStock: item.dayUseTotalStock ?? null
  };
  const lodgingBasis = Number(correction.lodgingBasisTotal);
  const dayUseBasis = Number(correction.dayUseBasisTotal);
  if (Number.isFinite(lodgingBasis) && lodgingBasis > 0) {
    const operating = Math.round(lodgingBasis);
    const candidate = maxPositiveNumber(item.weeklyBasisTotal, item.weeklyMaxTotal, operating) || operating;
    const structural = Math.max(0, candidate - operating);
    next.weeklyBasisTotal = candidate;
    next.weeklyOperatingTotal = operating;
    next.weeklyStructuralBlockedTotal = structural || null;
    next.weeklyStockBasisType = structural ? "manual_operating_reduced" : "manual_operating";
    next.weeklyBasisRule = stockBasisRule(item.weeklyBasisRule || "", candidate, operating, structural, item.weeklyOfflineReservedTotal, "개");
    next.nightTotalStock = operating;
    next.manualLodgingBasisTotal = operating;
    next.manualCorrectionApplied = true;
  }
  if (Number.isFinite(dayUseBasis) && dayUseBasis > 0) {
    const operating = Math.round(dayUseBasis);
    const candidate = maxPositiveNumber(item.dayUseWeeklyBasisTotal, item.dayUseWeeklyMaxTotal, operating) || operating;
    const structural = Math.max(0, candidate - operating);
    next.dayUseWeeklyBasisTotal = candidate;
    next.dayUseWeeklyOperatingTotal = operating;
    next.dayUseWeeklyStructuralBlockedTotal = structural || null;
    next.dayUseWeeklyStockBasisType = structural ? "manual_operating_reduced" : "manual_operating";
    next.dayUseWeeklyBasisRule = stockBasisRule(item.dayUseWeeklyBasisRule || "", candidate, operating, structural, item.dayUseWeeklyOfflineReservedTotal, "회", "데이유즈/캠프닉");
    next.dayUseTotalStock = operating;
    next.manualDayUseBasisTotal = operating;
    next.manualCorrectionApplied = true;
  }
  return next;
}

function companyIdentityConfidence(company = {}) {
  if ((company.placeIds || []).length) {
    return { level: "certain", label: "확실", reason: "네이버 place_id 기준" };
  }
  if ((company.bookingBusinessIds || []).length) {
    return { level: "high", label: "높음", reason: "네이버 예약ID 기준" };
  }
  if ((company.addresses || []).length) {
    return { level: "medium", label: "보통", reason: "업체명+주소 기준" };
  }
  return { level: "review", label: "검토 필요", reason: "업체명+지역 보조 기준" };
}

function upsertCompanyRecord(master, entity) {
  const sourceKeys = entity.sourceKeys || [];
  const matchedIds = boundedUnique(sourceKeys.map((key) => master.sourceIndex[key]).filter(Boolean), 10);
  let companyId = matchedIds[0];
  if (!companyId) {
    companyId = entity.placeId
      ? `cmp_place_${entity.placeId}`
      : `cmp_${stableHash([entity.nameKey, entity.addressKey, entity.regionKey, entity.bookingBusinessId].filter(Boolean).join("|"))}`;
  }
  let company = master.companies[companyId];
  if (!company) {
    company = createCompanyRecord(companyId, entity);
    master.companies[companyId] = company;
  }
  if (matchedIds.length > 1) {
    company.duplicateNotes = [
      ...(company.duplicateNotes || []),
      {
        at: entity.collectedAt,
        reason: "하나의 수집 업체가 여러 기존 companyId와 연결됨",
        matchedIds
      }
    ].slice(-20);
  }
  company.lastSeenAt = [company.lastSeenAt, entity.collectedAt].filter(Boolean).sort().at(-1) || entity.collectedAt;
  company.lastRunId = entity.runId || company.lastRunId;
  mergeCompanyFieldArrays(company, entity);
  updateCompanySourceStats(company, entity);
  upsertCompanyKeywordExposure(company, entity);
  updateCompanyInventory(company, entity);
  for (const key of sourceKeys) master.sourceIndex[key] = companyId;
  return company;
}

function mergeCompanyKeyword(targetKeyword = {}, sourceKeyword = {}) {
  const runsById = new Map();
  for (const row of [...(targetKeyword.runs || []), ...(sourceKeyword.runs || [])]) {
    if (!row?.runId) continue;
    runsById.set(row.runId, { ...(runsById.get(row.runId) || {}), ...row });
  }
  const runs = [...runsById.values()]
    .sort((a, b) => String(b.collectedAt || "").localeCompare(String(a.collectedAt || "")))
    .slice(0, 80);
  const ranks = runs.map((row) => Number(row.rank)).filter((rank) => Number.isFinite(rank) && rank > 0);
  const latest = runs[0] || {};
  return {
    ...targetKeyword,
    ...sourceKeyword,
    keyword: targetKeyword.keyword || sourceKeyword.keyword || "",
    keywordKey: targetKeyword.keywordKey || sourceKeyword.keywordKey || "",
    firstSeenAt: [targetKeyword.firstSeenAt, sourceKeyword.firstSeenAt].filter(Boolean).sort()[0] || "",
    lastSeenAt: [targetKeyword.lastSeenAt, sourceKeyword.lastSeenAt].filter(Boolean).sort().at(-1) || "",
    bestRank: ranks.length ? Math.min(...ranks) : null,
    latestRank: latest.rank || null,
    latestRunId: latest.runId || "",
    keywordLayer: targetKeyword.keywordLayer || sourceKeyword.keywordLayer || latest.keywordLayer || "",
    keywordLayerLabel: targetKeyword.keywordLayerLabel || sourceKeyword.keywordLayerLabel || latest.keywordLayerLabel || "",
    provinceKey: targetKeyword.provinceKey || sourceKeyword.provinceKey || latest.provinceKey || "",
    runCount: runs.length,
    runs
  };
}

function mergeCompanyInventory(targetInventory = {}, sourceInventory = {}) {
  const merged = {
    latest: targetInventory.latest || sourceInventory.latest || {},
    structureCounts: { ...(targetInventory.structureCounts || {}) },
    confidenceCounts: { ...(targetInventory.confidenceCounts || {}) },
    runIds: boundedUnique([...(targetInventory.runIds || []), ...(sourceInventory.runIds || [])], 120),
    snapshots: mergeInventorySnapshots([
      targetInventory.latest,
      sourceInventory.latest,
      targetInventory.previousLatest,
      sourceInventory.previousLatest,
      ...(targetInventory.snapshots || []),
      ...(sourceInventory.snapshots || [])
    ])
  };
  for (const [key, count] of Object.entries(sourceInventory.structureCounts || {})) {
    merged.structureCounts[key] = (merged.structureCounts[key] || 0) + Number(count || 0);
  }
  for (const [key, count] of Object.entries(sourceInventory.confidenceCounts || {})) {
    merged.confidenceCounts[key] = (merged.confidenceCounts[key] || 0) + Number(count || 0);
  }
  if (
    sourceInventory.latest?.collectedAt
    && String(sourceInventory.latest.collectedAt).localeCompare(String(merged.latest?.collectedAt || "")) > 0
  ) {
    merged.snapshots = mergeInventorySnapshots([merged.latest, ...merged.snapshots]);
    merged.latest = sourceInventory.latest;
  }
  merged.previousLatest = merged.snapshots.find((row) => (row.runId || row.collectedAt) !== (merged.latest?.runId || merged.latest?.collectedAt)) || null;
  return merged;
}

function mergeCompanyRecords(master, companyIds = [], candidateKey = "") {
  const ids = boundedUnique(companyIds, 20).filter((id) => master.companies?.[id]);
  if (ids.length < 2) {
    const error = new Error("병합할 업체를 2개 이상 선택해야 합니다.");
    error.statusCode = 400;
    throw error;
  }
  const targetId = ids[0];
  const target = master.companies[targetId];
  for (const sourceId of ids.slice(1)) {
    const source = master.companies[sourceId];
    if (!source) continue;
    target.aliases = boundedUnique([...(target.aliases || []), ...(source.aliases || []), source.primaryName], 40);
    target.placeIds = boundedUnique([...(target.placeIds || []), ...(source.placeIds || [])], 30);
    target.bookingBusinessIds = boundedUnique([...(target.bookingBusinessIds || []), ...(source.bookingBusinessIds || [])], 30);
    target.regions = boundedUnique([...(target.regions || []), ...(source.regions || [])], 30);
    target.addresses = boundedUnique([...(target.addresses || []), ...(source.addresses || [])], 30);
    target.urls = boundedUnique([...(target.urls || []), ...(source.urls || [])], 40);
    target.runIds = boundedUnique([...(target.runIds || []), ...(source.runIds || [])], 160);
    target.sourceRoles = boundedUnique([...(target.sourceRoles || []), ...(source.sourceRoles || [])], 8);
    target.collectionSources = boundedUnique([...(target.collectionSources || []), ...(source.collectionSources || [])], 16);
    target.sourceStats = { ...(target.sourceStats || {}) };
    for (const [sourceKey, sourceStat] of Object.entries(source.sourceStats || {})) {
      const currentStat = target.sourceStats[sourceKey] || {};
      const runIds = boundedUnique([...(currentStat.runIds || []), ...(sourceStat.runIds || [])], 120);
      target.sourceStats[sourceKey] = {
        ...currentStat,
        ...sourceStat,
        firstSeenAt: [currentStat.firstSeenAt, sourceStat.firstSeenAt].filter(Boolean).sort()[0] || currentStat.firstSeenAt || sourceStat.firstSeenAt || "",
        lastSeenAt: [currentStat.lastSeenAt, sourceStat.lastSeenAt].filter(Boolean).sort().at(-1) || currentStat.lastSeenAt || sourceStat.lastSeenAt || "",
        runIds,
        runCount: runIds.length,
        observationCount: Number(currentStat.observationCount || 0) + Number(sourceStat.observationCount || 0),
        keywords: boundedUnique([...(currentStat.keywords || []), ...(sourceStat.keywords || [])], 60)
      };
    }
    target.firstSeenAt = [target.firstSeenAt, source.firstSeenAt].filter(Boolean).sort()[0] || target.firstSeenAt || "";
    target.lastSeenAt = [target.lastSeenAt, source.lastSeenAt].filter(Boolean).sort().at(-1) || target.lastSeenAt || "";
    target.keywords = target.keywords || {};
    for (const [keywordKey, sourceKeyword] of Object.entries(source.keywords || {})) {
      target.keywords[keywordKey] = mergeCompanyKeyword(target.keywords[keywordKey], sourceKeyword);
    }
    target.inventory = mergeCompanyInventory(target.inventory || {}, source.inventory || {});
    if (!manualCorrectionHasValue(target.manualCorrection) && manualCorrectionHasValue(source.manualCorrection)) {
      target.manualCorrection = source.manualCorrection;
    }
    target.manualCorrectionHistory = [
      ...(target.manualCorrectionHistory || []),
      ...(source.manualCorrectionHistory || [])
    ]
      .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
      .slice(-50);
    if (!target.adminReview && source.adminReview) {
      target.adminReview = source.adminReview;
    }
    target.adminReviewHistory = [
      ...(target.adminReviewHistory || []),
      ...(source.adminReviewHistory || [])
    ]
      .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
      .slice(-50);
    const latestSalesContact = [target.salesContact, source.salesContact]
      .filter(Boolean)
      .sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")))
      .at(-1);
    if (latestSalesContact) target.salesContact = latestSalesContact;
    target.salesContactHistory = [
      ...(target.salesContactHistory || []),
      ...(source.salesContactHistory || [])
    ]
      .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
      .slice(-80);
    target.duplicateNotes = [
      ...(target.duplicateNotes || []),
      {
        at: new Date().toISOString(),
        reason: "관리자 병합",
        mergedCompanyId: sourceId,
        candidateKey
      },
      ...(source.duplicateNotes || [])
    ].slice(-40);
    for (const [sourceKey, indexedCompanyId] of Object.entries(master.sourceIndex || {})) {
      if (indexedCompanyId === sourceId) master.sourceIndex[sourceKey] = targetId;
    }
    delete master.companies[sourceId];
  }
  if (candidateKey) master.duplicateResolutions[candidateKey] = `merged:${targetId}`;
  return target;
}

async function resolveCompanyMasterDuplicate(payload = {}) {
  const action = String(payload.action || "").trim();
  const candidateKey = String(payload.candidateKey || "").trim();
  const companyIds = Array.isArray(payload.companyIds) ? payload.companyIds.map((value) => String(value || "").trim()) : [];
  const master = await readCompanyMaster();
  if (action === "separate") {
    if (!candidateKey) {
      const error = new Error("분리 유지할 후보 키가 없습니다.");
      error.statusCode = 400;
      throw error;
    }
    master.duplicateResolutions[candidateKey] = "separate";
    await writeCompanyMaster(master);
    return { ...(await summarizeCompanyMaster()), resolved: { action, candidateKey } };
  }
  if (action === "merge") {
    const target = mergeCompanyRecords(master, companyIds, candidateKey);
    await writeCompanyMaster(master);
    return { ...(await summarizeCompanyMaster()), resolved: { action, candidateKey, companyId: target.companyId } };
  }
  const error = new Error("지원하지 않는 중복 처리 방식입니다.");
  error.statusCode = 400;
  throw error;
}

async function saveCompanyManualCorrection(payload = {}) {
  const companyId = String(payload.companyId || "").trim();
  const master = await readCompanyMaster();
  const company = master.companies?.[companyId];
  if (!company) {
    const error = new Error("수동 보정할 업체를 찾지 못했습니다.");
    error.statusCode = 404;
    throw error;
  }
  const savedAt = new Date().toISOString();
  const lodgingBasisTotal = Number(payload.lodgingBasisTotal);
  const dayUseBasisTotal = Number(payload.dayUseBasisTotal);
  const nextCorrection = {
    active: true,
    lodgingBasisTotal: Number.isFinite(lodgingBasisTotal) && lodgingBasisTotal > 0 ? Math.round(lodgingBasisTotal) : null,
    dayUseBasisTotal: Number.isFinite(dayUseBasisTotal) && dayUseBasisTotal > 0 ? Math.round(dayUseBasisTotal) : null,
    note: String(payload.note || "").trim(),
    source: "admin",
    updatedAt: savedAt
  };
  const shouldClear = payload.active === false || !manualCorrectionHasValue(nextCorrection);
  if (shouldClear) {
    company.manualCorrection = null;
  } else {
    company.manualCorrection = nextCorrection;
  }
  company.manualCorrectionHistory = [
    ...(company.manualCorrectionHistory || []),
    {
      at: savedAt,
      action: shouldClear ? "clear" : "save",
      lodgingBasisTotal: company.manualCorrection?.lodgingBasisTotal || null,
      dayUseBasisTotal: company.manualCorrection?.dayUseBasisTotal || null,
      note: company.manualCorrection?.note || ""
    }
  ].slice(-30);
  company.duplicateNotes = [
    ...(company.duplicateNotes || []),
    {
      at: savedAt,
      reason: shouldClear ? "수동 보정 해제" : "수동 보정 저장"
    }
  ].slice(-40);
  await writeCompanyMaster(master);
  return {
    ...(await summarizeCompanyMaster()),
    company: companyRecordSummary(company),
    resolved: { action: shouldClear ? "clearManualCorrection" : "saveManualCorrection", companyId }
  };
}

function sanitizeAdminReviewContext(value = {}) {
  if (!value || typeof value !== "object") return null;
  const text = (input, max = 180) => String(input || "").replace(/\s+/g, " ").trim().slice(0, max);
  const numberOrZero = (input) => {
    const value = Number(input);
    return Number.isFinite(value) ? Math.round(value) : 0;
  };
  const list = (input, limit = 4, max = 180) => Array.isArray(input)
    ? input.map((item) => text(item, max)).filter(Boolean).slice(0, limit)
    : [];
  const recrawlSource = value.recrawlPlan && typeof value.recrawlPlan === "object" ? value.recrawlPlan : {};
  const comparisonSource = value.comparison && typeof value.comparison === "object" ? value.comparison : {};
  const revenueSource = value.revenue && typeof value.revenue === "object" ? value.revenue : {};
  const comparisonCells = Array.isArray(comparisonSource.cells)
    ? comparisonSource.cells.map((cell) => ({
        key: text(cell?.key, 40),
        label: text(cell?.label, 80),
        before: text(cell?.before, 100),
        after: text(cell?.after, 100),
        tone: text(cell?.tone, 20),
        note: text(cell?.note, 120)
      })).filter((cell) => cell.key || cell.label || cell.before || cell.after || cell.note).slice(0, 6)
    : [];
  const context = {
    source: text(value.source, 50),
    appliedStatus: text(value.appliedStatus, 40),
    appliedLabel: text(value.appliedLabel, 80),
    recommendationStatus: text(value.recommendationStatus, 40),
    recommendationLabel: text(value.recommendationLabel, 80),
    recommendationReasons: list(value.recommendationReasons, 4, 220),
    decisionLabel: text(value.decisionLabel, 100),
    decisionSummary: text(value.decisionSummary, 220),
    problemDateText: text(value.problemDateText, 220),
    quantityConfidence: text(value.quantityConfidence, 140),
    gapType: text(value.gapType, 120),
    channelText: text(value.channelText, 180),
    summary: text(value.summary, 260),
    recrawlPlan: {
      keyword: text(recrawlSource.keyword, 120),
      range: text(recrawlSource.range, 40),
      dateText: text(recrawlSource.dateText, 180),
      checkIn: text(recrawlSource.checkIn, 20),
      checkOut: text(recrawlSource.checkOut, 20)
    },
    comparison: {
      hasComparison: Boolean(comparisonSource.hasComparison),
      improved: numberOrZero(comparisonSource.improved),
      worsened: numberOrZero(comparisonSource.worsened),
      tone: text(comparisonSource.tone, 20),
      previousCollectedAt: text(comparisonSource.previousCollectedAt, 40),
      latestCollectedAt: text(comparisonSource.latestCollectedAt, 40),
      cells: comparisonCells
    },
    revenue: {
      totalRevenue: numberOrZero(revenueSource.totalRevenue),
      totalPricedSoldOut: numberOrZero(revenueSource.totalPricedSoldOut),
      totalMissingPriceSoldOut: numberOrZero(revenueSource.totalMissingPriceSoldOut),
      precisionLabel: text(revenueSource.precisionLabel, 80),
      precisionGrade: text(revenueSource.precisionGrade, 20)
    }
  };
  const hasText = [
    context.summary,
    context.recommendationLabel,
    context.decisionLabel,
    context.decisionSummary,
    context.problemDateText,
    context.quantityConfidence,
    context.channelText
  ].some(Boolean);
  const hasMetrics = context.comparison.hasComparison || context.revenue.totalRevenue || context.revenue.totalMissingPriceSoldOut;
  return hasText || hasMetrics ? context : null;
}

async function saveCompanyAdminReview(payload = {}) {
  const companyId = String(payload.companyId || "").trim();
  const status = String(payload.status || "").trim();
  const master = await readCompanyMaster();
  const company = master.companies?.[companyId];
  if (!company) {
    const error = new Error("검증할 업체를 찾지 못했습니다.");
    error.statusCode = 404;
    throw error;
  }
  const meta = companyAdminReviewMeta(status);
  const savedAt = new Date().toISOString();
  const reviewContext = sanitizeAdminReviewContext(payload.reviewContext);
  let historyEntry = null;
  if (!status || status === "clear") {
    historyEntry = {
      at: savedAt,
      action: "clear",
      previousStatus: company.adminReview?.status || "",
      previousLabel: company.adminReview?.label || "",
      label: "검증 해제",
      note: String(payload.note || "").trim(),
      ...(reviewContext ? { context: reviewContext } : {}),
      source: "admin"
    };
    company.adminReview = null;
  } else if (!meta) {
    const error = new Error("지원하지 않는 검증 상태입니다.");
    error.statusCode = 400;
    throw error;
  } else {
    company.adminReview = {
      status,
      label: meta.label,
      note: String(payload.note || "").trim(),
      source: "admin",
      ...(reviewContext ? { context: reviewContext } : {}),
      updatedAt: savedAt
    };
    historyEntry = {
      at: savedAt,
      action: "save",
      status,
      label: meta.label,
      category: meta.category || "",
      note: company.adminReview.note,
      ...(reviewContext ? { context: reviewContext } : {}),
      source: "admin"
    };
  }
  company.adminReviewHistory = [
    ...(company.adminReviewHistory || []),
    historyEntry
  ].filter(Boolean).slice(-50);
  company.duplicateNotes = [
    ...(company.duplicateNotes || []),
    {
      at: savedAt,
      reason: company.adminReview ? `관리자 검증: ${company.adminReview.label}` : "관리자 검증 해제"
    }
  ].slice(-40);
  await writeCompanyMaster(master);
  return {
    ...(await summarizeCompanyMaster()),
    company: companyRecordSummary(company),
    resolved: { action: "saveAdminReview", companyId, status: company.adminReview?.status || "clear" }
  };
}

async function saveCompanySalesContact(payload = {}) {
  const companyId = String(payload.companyId || "").trim();
  const status = String(payload.status || "not_contacted").trim();
  const responseStatus = String(payload.responseStatus || "not_recorded").trim();
  const responseReason = String(payload.responseReason || "none").trim();
  const master = await readCompanyMaster();
  const company = master.companies?.[companyId];
  if (!company) {
    const error = new Error("컨택 상태를 저장할 업체를 찾지 못했습니다.");
    error.statusCode = 404;
    throw error;
  }
  const meta = companySalesContactMeta(status);
  if (!meta) {
    const error = new Error("지원하지 않는 컨택 상태입니다.");
    error.statusCode = 400;
    throw error;
  }
  const responseMeta = companySalesResponseMeta(responseStatus);
  if (!responseMeta) {
    const error = new Error("지원하지 않는 영업 반응 상태입니다.");
    error.statusCode = 400;
    throw error;
  }
  const reasonMeta = companySalesResponseReasonMeta(responseReason);
  if (!reasonMeta) {
    const error = new Error("지원하지 않는 영업 반응 사유입니다.");
    error.statusCode = 400;
    throw error;
  }
  const savedAt = new Date().toISOString();
  const nextContact = {
    status,
    label: meta.label,
    tone: meta.tone,
    responseStatus,
    responseLabel: responseMeta.label,
    responseTone: responseMeta.tone,
    responseReason,
    responseReasonLabel: reasonMeta.label,
    channel: String(payload.channel || "").trim(),
    contactPerson: String(payload.contactPerson || "").trim(),
    proposal: String(payload.proposal || "").trim(),
    nextActionAt: String(payload.nextActionAt || "").trim(),
    note: String(payload.note || "").trim(),
    source: "sales",
    updatedAt: savedAt
  };
  company.salesContact = nextContact;
  company.salesContactHistory = [
    ...(company.salesContactHistory || []),
    {
      at: savedAt,
      action: "save",
      status,
      label: meta.label,
      responseStatus,
      responseLabel: responseMeta.label,
      responseReason,
      responseReasonLabel: reasonMeta.label,
      channel: nextContact.channel,
      contactPerson: nextContact.contactPerson,
      proposal: nextContact.proposal,
      nextActionAt: nextContact.nextActionAt,
      note: nextContact.note,
      source: "sales"
    }
  ].slice(-80);
  company.duplicateNotes = [
    ...(company.duplicateNotes || []),
    {
      at: savedAt,
      reason: responseStatus === "not_recorded" ? `영업 컨택 ${meta.label}` : `영업 컨택 ${meta.label} / 반응 ${responseMeta.label}`
    }
  ].slice(-50);
  await writeCompanyMaster(master);
  return {
    ...(await summarizeCompanyMaster()),
    company: companyRecordSummary(company),
    resolved: { action: "saveSalesContact", companyId, status }
  };
}

async function upsertCompanyMasterForRun(data, collectedAt) {
  const master = await readCompanyMaster();
  const run = data?.run || {};
  const keywordKey = compactKeyword(run.keyword || run.label || "").toLowerCase();
  const items = data?.availability?.items || [];
  const beforeSnapshot = JSON.stringify({
    companies: master.companies,
    sourceIndex: master.sourceIndex,
    duplicateResolutions: master.duplicateResolutions
  });
  let touched = 0;

  for (let index = 0; index < items.length; index += 1) {
    const entity = companyEntityFromItem(items[index], run, collectedAt);
    if (!entity.nameKey || !entity.sourceKeys.length) continue;
    const company = upsertCompanyRecord(master, entity);
    touched += 1;
    const correctedItem = applyCompanyMasterIdentity(applyCompanyManualCorrection(items[index], company), company);
    if (correctedItem.manualCorrectionApplied) {
      const correctedEntity = companyEntityFromItem(correctedItem, run, collectedAt);
      updateCompanyInventory(company, {
        ...correctedEntity,
        inventoryStructureFlags: boundedUnique([
          ...(correctedEntity.inventoryStructureFlags || []),
          "manual_correction"
        ], 12)
      });
    }
    items[index] = {
      ...correctedItem,
      companyId: company.companyId,
      companyProfile: companyRecordSummary(company, keywordKey)
    };
  }

  const afterSnapshot = JSON.stringify({
    companies: master.companies,
    sourceIndex: master.sourceIndex,
    duplicateResolutions: master.duplicateResolutions
  });
  if (touched && beforeSnapshot !== afterSnapshot) await writeCompanyMaster(master);
  const duplicateCandidates = findCompanyDuplicateCandidates(master);
  return {
    file: "company_master/companies.json",
    totalCompanies: Object.keys(master.companies || {}).length,
    currentRunCompanies: touched,
    duplicateCandidateCount: duplicateCandidates.length,
    duplicateCandidates,
    updatedAt: master.updatedAt || "",
    principle: "네이버 place_id/예약ID 우선, 그 다음 업체명+주소/지역으로 동일 업체를 병합"
  };
}

async function summarizeCompanyMaster() {
  const master = await readCompanyMaster();
  const duplicateCandidates = findCompanyDuplicateCandidates(master);
  const companies = Object.values(master.companies || {})
    .map((company) => companyRecordSummary(company))
    .sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
  const profiledCompanies = companies.map(companySalesTargetProfile);
  const collectionSourceCounts = profiledCompanies.reduce((acc, company) => {
    const sources = company.collectionSources?.length ? company.collectionSources : ["admin_search"];
    for (const source of sources) acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});
  const salesTargets = summarizeCompanySalesTargets(profiledCompanies);
  return {
    file: "company_master/companies.json",
    totalCompanies: Object.keys(master.companies || {}).length,
    sourceKeyCount: Object.keys(master.sourceIndex || {}).length,
    duplicateCandidateCount: duplicateCandidates.length,
    duplicateCandidates,
    collectionSourceCounts,
    b2bSearchCompanyCount: collectionSourceCounts.b2b_search || 0,
    crossKeyword: summarizeCompanyCrossKeyword(master),
    salesTargets,
    updatedAt: master.updatedAt || "",
    principle: "네이버 place_id/예약ID 우선, 그 다음 업체명+주소/지역으로 동일 업체를 병합",
    companies: profiledCompanies.slice(0, 300)
  };
}

async function backfillCompanyMasterFromRuns(payload = {}) {
  const requestedRunIds = Array.isArray(payload.runIds)
    ? new Set(payload.runIds.map((value) => String(value || "").trim()).filter(Boolean))
    : null;
  const limit = Number(payload.limit);
  const runs = (await listRuns())
    .filter((run) => !requestedRunIds || requestedRunIds.has(run.id))
    .sort((a, b) => String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")))
    .slice(0, Number.isFinite(limit) && limit > 0 ? Math.min(500, Math.round(limit)) : undefined);
  const startedAt = new Date().toISOString();
  const processed = [];
  const failed = [];
  let touchedCompanies = 0;

  for (const run of runs) {
    try {
      const data = await loadRun(run.id, { skipHistory: true });
      const currentRunCompanies = Number(data?.companyMaster?.currentRunCompanies || 0);
      touchedCompanies += currentRunCompanies;
      processed.push({
        runId: run.id,
        label: run.label || run.id,
        updatedAt: run.updatedAt,
        currentRunCompanies,
        totalCompanies: data?.companyMaster?.totalCompanies || 0
      });
    } catch (error) {
      failed.push({
        runId: run.id,
        label: run.label || run.id,
        message: error.message || String(error)
      });
    }
  }

  return {
    ...(await summarizeCompanyMaster()),
    backfill: {
      startedAt,
      finishedAt: new Date().toISOString(),
      requestedRuns: runs.length,
      processedRuns: processed.length,
      failedRuns: failed.length,
      touchedCompanies,
      runs: processed.slice(-30).reverse(),
      failed
    }
  };
}

function buildHistoryObservations(data, collectedAt) {
  const run = data?.run || {};
  const checkIn = run.checkIn || runDateFromId(run.id) || kstDate(0);
  const collectedDate = String(collectedAt || "").slice(0, 10) || runDateFromId(run.id) || kstDate(0);
  const keyword = run.keyword || run.label || "";
  const keywordKey = compactKeyword(keyword).toLowerCase();
  const items = data?.availability?.items || [];
  const observations = [];

  for (const item of items) {
    const companyKey = item.companyId || compactKeyword(item.name || "").toLowerCase();
    if (!companyKey) continue;

    for (const productType of ["lodging", "dayuse"]) {
      const series = historySeriesForItem(item, productType, checkIn);
      for (const row of series) {
        const total = normalizeObservationNumber(row.total);
        const available = normalizeObservationNumber(row.available);
        if (total === null || available === null || total <= 0) continue;
        const sold = Math.max(0, total - Math.max(0, available));
        const leadTimeDays = dateDiffDays(collectedDate, row.stayDate);
        const observationId = stableHash([
          run.id,
          keywordKey,
          companyKey,
          productType,
          row.stayDate
        ].join("|"));

        observations.push({
          schemaVersion: 1,
          observationId,
          runId: run.id,
          runLabel: run.label || "",
          keyword,
          keywordKey,
          searchMode: run.searchMode || "",
          productMode: run.productMode || "",
          sourceRole: run.sourceRole || "",
          collectionSource: run.collectionSource || "",
          collectionSourceLabel: run.collectionSourceLabel || "",
          collectedAt,
          collectedDate,
          stayDate: row.stayDate,
          leadTimeDays,
          companyName: item.name || "",
          companyKey,
          region: item.region || "",
          rank: item.rank ?? null,
          productType,
          supply: total,
          available: Math.max(0, available),
          sold,
          saleRate: total ? Number((sold / total).toFixed(4)) : null,
          price: item.price || "",
          listType: item.listType || "",
          inventoryScope: item.inventoryScope || "",
          inventoryMemo: item.inventoryMemo || "",
          inventoryConfidenceGrade: item.inventoryConfidenceGrade || "",
          inventoryConfidenceScore: item.inventoryConfidenceScore ?? null,
          inventoryAlerts: item.inventoryAlerts || [],
          sourceUrl: item.url || "",
          rawLabel: row.label || ""
        });
      }
    }
  }

  return observations;
}

async function readHistoryObservations() {
  try {
    const text = await fsp.readFile(HISTORY_OBSERVATIONS_FILE, "utf8");
    const deduped = new Map();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.observationId) deduped.set(row.observationId, row);
      } catch {
        // Keep reading even if one historical line was partially written.
      }
    }
    return [...deduped.values()];
  } catch {
    return [];
  }
}

async function appendHistoryForRun(runId) {
  const dirPath = resolveRunDir(runId);
  if (!dirPath || !fs.existsSync(dirPath)) return { appended: 0, reason: "run_not_found" };
  const stat = await fsp.stat(dirPath);
  const collectedAt = stat.mtime.toISOString();
  const data = await loadRun(runId, { skipHistory: true });
  const observations = buildHistoryObservations(data, collectedAt);
  if (!observations.length) return { appended: 0, reason: "no_observations" };
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  await fsp.appendFile(
    HISTORY_OBSERVATIONS_FILE,
    `${observations.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8"
  );
  return { appended: observations.length, file: "history/observations.jsonl" };
}

function historyDayIndex(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date.getUTCDay();
}

function createHistoryBucket(label = "") {
  return {
    label,
    observations: 0,
    sold: 0,
    supply: 0,
    available: 0,
    runIds: new Set(),
    companyKeys: new Set()
  };
}

function addHistoryObservation(bucket, row) {
  const supply = Number(row.supply || 0);
  if (!Number.isFinite(supply) || supply <= 0) return;
  bucket.observations += 1;
  bucket.sold += Number(row.sold || 0);
  bucket.supply += supply;
  bucket.available += Number(row.available || 0);
  if (row.runId) bucket.runIds.add(row.runId);
  if (row.companyKey) bucket.companyKeys.add(row.companyKey);
}

function finalizeHistoryBucket(bucket) {
  return {
    label: bucket.label,
    observations: bucket.observations,
    sold: bucket.sold,
    supply: bucket.supply,
    available: bucket.available,
    saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null,
    runCount: bucket.runIds.size,
    companyCount: bucket.companyKeys.size
  };
}

function summarizeHistoryBenchmarks(observations) {
  const dayLabels = ["일", "월", "화", "수", "목", "금", "토"];
  const lodgingRows = observations.filter((row) => row.productType === "lodging");
  const weekdayBucket = createHistoryBucket("누적 평일");
  const allBucket = createHistoryBucket("누적 전체");
  const dayBuckets = new Map();
  const companyBuckets = new Map();

  for (const row of lodgingRows) {
    const dayIndex = historyDayIndex(row.stayDate);
    if (dayIndex === null) continue;
    addHistoryObservation(allBucket, row);

    if (!dayBuckets.has(dayIndex)) dayBuckets.set(dayIndex, createHistoryBucket(dayLabels[dayIndex]));
    addHistoryObservation(dayBuckets.get(dayIndex), row);

    if (dayIndex >= 1 && dayIndex <= 4) {
      addHistoryObservation(weekdayBucket, row);
      const key = row.companyKey || "";
      if (key) {
        if (!companyBuckets.has(key)) {
          companyBuckets.set(key, {
            companyName: row.companyName || "",
            weekday: createHistoryBucket("누적 평일"),
            all: createHistoryBucket("누적 전체")
          });
        }
        addHistoryObservation(companyBuckets.get(key).weekday, row);
      }
    }

    const key = row.companyKey || "";
    if (key) {
      if (!companyBuckets.has(key)) {
        companyBuckets.set(key, {
          companyName: row.companyName || "",
          weekday: createHistoryBucket("누적 평일"),
          all: createHistoryBucket("누적 전체")
        });
      }
      addHistoryObservation(companyBuckets.get(key).all, row);
    }
  }

  const companyBenchmarks = {};
  for (const [key, buckets] of companyBuckets.entries()) {
    companyBenchmarks[key] = {
      companyName: buckets.companyName,
      weekday: finalizeHistoryBucket(buckets.weekday),
      all: finalizeHistoryBucket(buckets.all)
    };
  }

  return {
    all: finalizeHistoryBucket(allBucket),
    weekday: finalizeHistoryBucket(weekdayBucket),
    byDay: [...dayBuckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dayIndex, bucket]) => ({
        dayIndex,
        ...finalizeHistoryBucket(bucket)
      })),
    companyBenchmarks
  };
}

function summarizeHistoryTimeline(observations) {
  const dateBuckets = new Map();
  const lodgingRows = observations.filter((row) => row.productType === "lodging");

  for (const row of lodgingRows) {
    const collectedDate = String(row.collectedDate || row.collectedAt || "").slice(0, 10);
    if (!collectedDate) continue;
    const bucket = dateBuckets.get(collectedDate) || {
      collectedDate,
      observations: 0,
      sold: 0,
      supply: 0,
      available: 0,
      runIds: new Set(),
      companyKeys: new Set()
    };
    bucket.observations += 1;
    bucket.sold += Number(row.sold || 0);
    bucket.supply += Number(row.supply || 0);
    bucket.available += Number(row.available || 0);
    if (row.runId) bucket.runIds.add(row.runId);
    if (row.companyKey) bucket.companyKeys.add(row.companyKey);
    dateBuckets.set(collectedDate, bucket);
  }

  return [...dateBuckets.values()]
    .sort((a, b) => a.collectedDate.localeCompare(b.collectedDate))
    .map((bucket) => ({
      collectedDate: bucket.collectedDate,
      observations: bucket.observations,
      sold: bucket.sold,
      supply: bucket.supply,
      available: bucket.available,
      saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null,
      runCount: bucket.runIds.size,
      companyCount: bucket.companyKeys.size
    }));
}

function summarizeHistoryOpsForKeyword(keywordBucket) {
  const timeline = [...keywordBucket.dateBuckets.values()]
    .sort((a, b) => a.collectedDate.localeCompare(b.collectedDate))
    .map((bucket) => ({
      collectedDate: bucket.collectedDate,
      observations: bucket.observations,
      sold: bucket.sold,
      supply: bucket.supply,
      saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null,
      runCount: bucket.runIds.size,
      companyCount: bucket.companyKeys.size
    }));

  const latest = timeline.at(-1) || null;
  const previous = timeline.length > 1 ? timeline.at(-2) : null;
  const comparison = latest && previous
    ? {
        previousDate: previous.collectedDate,
        latestDate: latest.collectedDate,
        saleRateDelta: Number(((latest.saleRate || 0) - (previous.saleRate || 0)).toFixed(4)),
        soldDelta: latest.sold - previous.sold,
        supplyDelta: latest.supply - previous.supply,
        companyDelta: latest.companyCount - previous.companyCount
      }
    : null;

  const companyTrends = [...keywordBucket.companyBuckets.values()]
    .map((bucket) => {
      const byDate = [...bucket.dateBuckets.values()]
        .sort((a, b) => a.collectedDate.localeCompare(b.collectedDate))
        .map((dateBucket) => ({
          collectedDate: dateBucket.collectedDate,
          sold: dateBucket.sold,
          supply: dateBucket.supply,
          saleRate: dateBucket.supply ? Number((dateBucket.sold / dateBucket.supply).toFixed(4)) : null,
          observations: dateBucket.observations
        }));
      const rates = byDate.map((row) => row.saleRate).filter((value) => Number.isFinite(value));
      return {
        companyName: bucket.companyName,
        companyKey: bucket.companyKey,
        observations: bucket.observations,
        sold: bucket.sold,
        supply: bucket.supply,
        saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null,
        runCount: bucket.runIds.size,
        dateCount: bucket.dateBuckets.size,
        latest: byDate.at(-1) || null,
        minRate: rates.length ? Math.min(...rates) : null,
        maxRate: rates.length ? Math.max(...rates) : null,
        volatility: rates.length ? Number((Math.max(...rates) - Math.min(...rates)).toFixed(4)) : null,
        byDate: byDate.slice(-8)
      };
    })
    .sort((a, b) => (b.volatility || 0) - (a.volatility || 0) || b.observations - a.observations)
    .slice(0, 12);

  return {
    keyword: keywordBucket.keyword,
    keywordKey: keywordBucket.keywordKey,
    observations: keywordBucket.observations,
    lodgingObservations: keywordBucket.lodgingObservations,
    dayUseObservations: keywordBucket.dayUseObservations,
    runCount: keywordBucket.runIds.size,
    companyCount: keywordBucket.companyKeys.size,
    dateCount: keywordBucket.dateBuckets.size,
    firstCollectedDate: timeline[0]?.collectedDate || "",
    latestCollectedDate: latest?.collectedDate || "",
    sold: keywordBucket.sold,
    supply: keywordBucket.supply,
    saleRate: keywordBucket.supply ? Number((keywordBucket.sold / keywordBucket.supply).toFixed(4)) : null,
    timeline: timeline.slice(-10),
    comparison,
    companyTrends
  };
}

async function summarizeHistoryOperations() {
  const observations = await readHistoryObservations();
  const keywordBuckets = new Map();
  const runIds = new Set();
  const companyKeys = new Set();

  for (const row of observations) {
    const keywordKey = String(row.keywordKey || compactKeyword(row.keyword || "")).toLowerCase();
    if (!keywordKey) continue;
    runIds.add(row.runId);
    if (row.companyKey) companyKeys.add(row.companyKey);

    if (!keywordBuckets.has(keywordKey)) {
      keywordBuckets.set(keywordKey, {
        keyword: row.keyword || keywordKey,
        keywordKey,
        observations: 0,
        lodgingObservations: 0,
        dayUseObservations: 0,
        sold: 0,
        supply: 0,
        runIds: new Set(),
        companyKeys: new Set(),
        dateBuckets: new Map(),
        companyBuckets: new Map()
      });
    }

    const bucket = keywordBuckets.get(keywordKey);
    bucket.keyword = bucket.keyword || row.keyword || keywordKey;
    bucket.observations += 1;
    if (row.productType === "lodging") bucket.lodgingObservations += 1;
    if (row.productType === "dayuse") bucket.dayUseObservations += 1;
    if (row.runId) bucket.runIds.add(row.runId);
    if (row.companyKey) bucket.companyKeys.add(row.companyKey);

    const supply = Number(row.supply || 0);
    const sold = Number(row.sold || 0);
    if (row.productType === "lodging" && Number.isFinite(supply) && supply > 0) {
      bucket.sold += Number.isFinite(sold) ? sold : 0;
      bucket.supply += supply;
      const collectedDate = String(row.collectedDate || row.collectedAt || "").slice(0, 10) || "unknown";
      const dateBucket = bucket.dateBuckets.get(collectedDate) || {
        collectedDate,
        observations: 0,
        sold: 0,
        supply: 0,
        runIds: new Set(),
        companyKeys: new Set()
      };
      dateBucket.observations += 1;
      dateBucket.sold += Number.isFinite(sold) ? sold : 0;
      dateBucket.supply += supply;
      if (row.runId) dateBucket.runIds.add(row.runId);
      if (row.companyKey) dateBucket.companyKeys.add(row.companyKey);
      bucket.dateBuckets.set(collectedDate, dateBucket);

      if (row.companyKey) {
        const companyBucket = bucket.companyBuckets.get(row.companyKey) || {
          companyName: row.companyName || "",
          companyKey: row.companyKey,
          observations: 0,
          sold: 0,
          supply: 0,
          runIds: new Set(),
          dateBuckets: new Map()
        };
        companyBucket.companyName = companyBucket.companyName || row.companyName || row.companyKey;
        companyBucket.observations += 1;
        companyBucket.sold += Number.isFinite(sold) ? sold : 0;
        companyBucket.supply += supply;
        if (row.runId) companyBucket.runIds.add(row.runId);
        const companyDateBucket = companyBucket.dateBuckets.get(collectedDate) || {
          collectedDate,
          observations: 0,
          sold: 0,
          supply: 0
        };
        companyDateBucket.observations += 1;
        companyDateBucket.sold += Number.isFinite(sold) ? sold : 0;
        companyDateBucket.supply += supply;
        companyBucket.dateBuckets.set(collectedDate, companyDateBucket);
        bucket.companyBuckets.set(row.companyKey, companyBucket);
      }
    }
  }

  const keywords = [...keywordBuckets.values()]
    .map(summarizeHistoryOpsForKeyword)
    .sort((a, b) => (b.latestCollectedDate || "").localeCompare(a.latestCollectedDate || "") || b.observations - a.observations);

  return {
    generatedAt: new Date().toISOString(),
    storage: "jsonl",
    file: "history/observations.jsonl",
    overall: {
      keywordCount: keywords.length,
      observationCount: observations.length,
      runCount: runIds.size,
      companyCount: companyKeys.size,
      latestCollectedAt: observations.map((row) => row.collectedAt).filter(Boolean).sort().at(-1) || ""
    },
    keywords
  };
}

async function summarizeHistoryForRun(data) {
  const run = data?.run || {};
  const keywordKey = compactKeyword(run.keyword || run.label || "").toLowerCase();
  if (!keywordKey) return { enabled: true, observationCount: 0, runCount: 0, currentRunObservationCount: 0 };
  const observations = (await readHistoryObservations()).filter((row) => row.keywordKey === keywordKey);
  const currentRunObservationCount = observations.filter((row) => row.runId === run.id).length;
  const runIds = new Set(observations.map((row) => row.runId).filter(Boolean));
  const companyKeys = new Set(observations.map((row) => row.companyKey).filter(Boolean));
  const leadBuckets = new Map();

  for (const row of observations) {
    if (!Number.isFinite(row.leadTimeDays) || !Number.isFinite(row.supply) || row.supply <= 0) continue;
    const bucket = leadBuckets.get(row.leadTimeDays) || {
      leadTimeDays: row.leadTimeDays,
      observations: 0,
      sold: 0,
      supply: 0,
      available: 0
    };
    bucket.observations += 1;
    bucket.sold += Number(row.sold || 0);
    bucket.supply += Number(row.supply || 0);
    bucket.available += Number(row.available || 0);
    leadBuckets.set(row.leadTimeDays, bucket);
  }

  const leadTime = [...leadBuckets.values()]
    .sort((a, b) => b.leadTimeDays - a.leadTimeDays)
    .map((bucket) => ({
      ...bucket,
      saleRate: bucket.supply ? Number((bucket.sold / bucket.supply).toFixed(4)) : null
    }));
  const benchmarks = summarizeHistoryBenchmarks(observations);
  const timeline = summarizeHistoryTimeline(observations);

  return {
    enabled: true,
    storage: "jsonl",
    file: "history/observations.jsonl",
    keyword: run.keyword || "",
    observationCount: observations.length,
    currentRunObservationCount,
    runCount: runIds.size,
    companyCount: companyKeys.size,
    latestCollectedAt: observations.map((row) => row.collectedAt).filter(Boolean).sort().at(-1) || "",
    canAnalyzeLeadTime: runIds.size >= 2,
    leadTime,
    benchmarks,
    timeline
  };
}

function availabilityPlaceKey(row) {
  const explicit = row.place_id || row["place_id"];
  if (explicit) return `place:${explicit}`;

  const urlText = `${row.url || ""} ${row["네이버예약URL"] || ""}`;
  const placeMatch = urlText.match(/\/accommodation\/(\d+)/);
  if (placeMatch) return `place:${placeMatch[1]}`;

  const bookingMatch = urlText.match(/\/bizes\/(\d+)/);
  if (bookingMatch) return `booking:${bookingMatch[1]}`;

  const name = compactKeyword(row["업체명"] || row.name || "");
  const region = compactKeyword(row["소재지클러스터"] || row["검색클러스터"] || row["지역"] || row["주소"] || row.location || "");
  return name ? `name:${name}:${region}` : "";
}

function availabilityBookingBusinessId(row = {}) {
  return extractBookingBusinessId({
    ...row,
    naverBookingUrl: row["네이버예약URL"] || row.naverBookingUrl || ""
  });
}

function addressRegionFromAddress(address = "") {
  const tokens = String(address || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  const suffixPattern = /(특별자치시|특별시|광역시|자치시|시|군|구)$/u;
  for (let index = 1; index < tokens.length; index += 1) {
    if (suffixPattern.test(tokens[index])) return tokens[index].replace(suffixPattern, "");
  }
  return suffixPattern.test(tokens[0]) ? tokens[0].replace(suffixPattern, "") : "";
}

function rowAddressRegion(row = {}) {
  return row["소재지클러스터"] ||
    row.addressRegion ||
    row.actualRegion ||
    addressRegionFromAddress(row["주소"] || row.address || row.location || "");
}

function rowSearchRegion(row = {}) {
  return row["검색클러스터"] || row["지역"] || row.searchCluster || row.searchRegion || "";
}

function rowDisplayRegion(row = {}) {
  return rowAddressRegion(row) || rowSearchRegion(row) || "";
}

function rankingRowBase(row = {}, fallbackRank = 0, source = "overall") {
  const overallRank = numericField(row, ["overall_rank"]);
  const regionalRank = numericField(row, ["순위"]);
  const adRank = numericField(row, ["ad_order"]);
  const rank = source === "overall"
    ? overallRank
    : source === "regional"
      ? regionalRank
      : adRank;
  const placeId = extractNaverPlaceId(row);
  const searchRegion = rowSearchRegion(row);
  const addressRegion = rowAddressRegion(row);
  const boundary = regionBoundaryInfo(searchRegion, addressRegion);
  return {
    sourceKey: availabilityPlaceKey(row),
    placeId,
    place_id: placeId,
    rank: rank || fallbackRank,
    overallRank,
    regionalRank,
    adRank,
    rankingSource: source,
    rankingSourceLabel: source === "overall" ? "네이버 전체 순위" : source === "regional" ? "네이버 지역별 순위" : "네이버 광고 순위",
    searchKeyword: row["검색키워드"] || row.query || "",
    searchCluster: searchRegion,
    searchRegion,
    addressRegion,
    regionBoundaryStatus: boundary.status,
    regionBoundaryLabel: boundary.label,
    regionBoundaryDetail: boundary.detail,
    outsideSearchRegion: boundary.outside,
    name: row["업체명"] || row.name || "확인불가",
    category: row["카테고리"] || row.category || "",
    region: rowDisplayRegion(row),
    address: row["주소"] || row.location || "",
    price: row["예약최저가"] || row["금액"] || row.price || "",
    bookingStatus: row["네이버예약재고수집상태"] || row["예약가능근거"] || "",
    naverCouponStatus: row["네이버쿠폰노출상태"] || row.naverCouponStatus || "",
    naverCouponNames: row["네이버쿠폰명"] || row.naverCouponNames || "",
    naverCouponChannel: row["네이버쿠폰확인채널"] || row.naverCouponChannel || "",
    naverCouponDetail: row["네이버쿠폰상세"] || row.naverCouponDetail || "",
    url: row.url || row["네이버예약URL"] || ""
  };
}

function summarizeRankingRows(overallRows = [], adRows = [], regionalRows = [], availability = {}) {
  const availabilityItems = availability.items || [];
  const availabilityByKey = new Map();
  availabilityItems.forEach((item, index) => {
    const keys = [
      item.sourceKey,
      item.placeId ? `place:${item.placeId}` : "",
      item.place_id ? `place:${item.place_id}` : "",
      item.bookingBusinessId ? `booking:${item.bookingBusinessId}` : ""
    ].filter(Boolean);
    for (const key of keys) {
      if (!availabilityByKey.has(key)) availabilityByKey.set(key, { item, index });
    }
  });

  const regionalByKey = new Map();
  for (const row of regionalRows) {
    const key = availabilityPlaceKey(row);
    const rank = numericField(row, ["순위"]);
    if (!key || !rank) continue;
    const current = regionalByKey.get(key);
    if (!current || rank < current.rank) {
      regionalByKey.set(key, {
        rank,
        keyword: row["검색키워드"] || "",
        region: row["지역"] || row["검색클러스터"] || ""
      });
    }
  }

  const adByKey = new Map();
  for (const row of adRows) {
    const key = availabilityPlaceKey(row);
    const rank = numericField(row, ["ad_order"]);
    if (key && rank) adByKey.set(key, { rank });
  }

  const sourceRows = overallRows.length ? overallRows : (regionalRows.length ? regionalRows : adRows);
  const source = overallRows.length ? "overall" : (regionalRows.length ? "regional" : "ad");
  const items = sourceRows
    .map((row, index) => {
      const base = rankingRowBase(row, index + 1, source);
      const linked = availabilityByKey.get(base.sourceKey);
      const regional = regionalByKey.get(base.sourceKey);
      const ad = adByKey.get(base.sourceKey);
      return {
        ...(linked?.item || {}),
        ...base,
        rank: base.rank || linked?.item?.rank || index + 1,
        hasInventory: Boolean(linked),
        availabilityIndex: Number.isInteger(linked?.index) ? linked.index : -1,
        inventoryRank: linked?.item?.rank || null,
        regionalRank: regional?.rank || base.regionalRank || null,
        regionalKeyword: regional?.keyword || "",
        regionalCluster: regional?.region || "",
        adRank: ad?.rank || base.adRank || null,
        naverCouponStatus: base.naverCouponStatus || linked?.item?.naverCouponStatus || "",
        naverCouponNames: base.naverCouponNames || linked?.item?.naverCouponNames || "",
        naverCouponChannel: base.naverCouponChannel || linked?.item?.naverCouponChannel || "",
        naverCouponDetail: base.naverCouponDetail || linked?.item?.naverCouponDetail || "",
        bookingStatus: base.bookingStatus || linked?.item?.basis || (linked ? "재고 분석 완료" : "재고 미수집")
      };
    })
    .sort((a, b) => Number(a.rank || 9999) - Number(b.rank || 9999))
    .slice(0, 50);

  return {
    source: source === "overall" ? "naver_overall" : source === "regional" ? "naver_regional" : "naver_ad",
    total: overallRows.length || regionalRows.length || adRows.length || 0,
    inventoryLinkedCount: items.filter((item) => item.hasInventory).length,
    items
  };
}

function summarizeAvailabilityRows(rows) {
  const byPlace = new Map();
  for (const row of rows) {
    const availableRooms = numericField(row, ["숙박예약가능수", "예약가능객실수", "availableRooms"]);
    const totalRooms = numericField(row, ["숙박확인재고수", "확인객실수", "totalRooms"]);
    const rate = numericField(row, ["숙박예약가능률", "예약가능률", "availabilityRate"]);
    if (availableRooms === null || totalRooms === null || totalRooms <= 0) continue;
    const soldOutRooms = numericField(row, ["숙박판매완료수", "soldOutRooms"]);
    const soldOutRate = numericField(row, ["숙박판매완료율", "soldOutRate"]);
    const resolvedSoldOutRooms = soldOutRooms !== null ? soldOutRooms : Math.max(0, totalRooms - availableRooms);
    const weeklyDays = numericField(row, ["주간재고수집일수", "weeklyDays"]);
    const weeklyDetail = row["주간잔여상세"] || "";
    const weeklySummary = weeklyDetail
      ? (weeklyDays ? `${weeklyDays}일 날짜별 잔여` : "날짜별 잔여")
      : row["주간잔여요약"] || "";
    const derivedWeeklyRates = parseWeeklyReservationRates(weeklyDetail);
    const weeklyAvgReservationRate = numericField(row, ["주간평균예약률", "weeklyAvgReservationRate"]) ?? derivedWeeklyRates.average;
    const weeklyReservationRateDetail = row["주간예약률상세"] || derivedWeeklyRates.detail;
    const weeklyTotalSoldOut = numericField(row, ["주간판매수량합계", "weeklyTotalSoldOut"]) ?? derivedWeeklyRates.totalSoldOut;
    const weeklyTotalStock = numericField(row, ["주간전체수량합계", "weeklyTotalStock"]) ?? derivedWeeklyRates.totalStock;
    const weeklyExplicitBasisTotal = numericField(row, ["주간기준재고수", "weeklyBasisTotal"]);
    const weeklyRawStockVariance = row["주간원시재고변동"] || "";
    const weeklyVariance = parseStockVarianceDetail(weeklyRawStockVariance);
    const storedWeeklyBasisRule = row["주간숙박총량기준"] || row.weeklyBasisRule || "";
    const weeklyMinTotal = numericField(row, ["주간총량최소값", "weeklyMinTotal"]) ?? weeklyVariance.minTotal;
    const weeklyMaxTotal = numericField(row, ["주간총량최대값", "weeklyMaxTotal"]) ?? weeklyVariance.maxTotal ?? parseBasisTotalFromRule(storedWeeklyBasisRule);
    const weeklyStockBasis = resolvedStockBasis({
      basisTotal: maxPositiveNumber(weeklyExplicitBasisTotal, weeklyMaxTotal, parseBasisTotalFromRule(storedWeeklyBasisRule)),
      explicitBasisTotal: weeklyExplicitBasisTotal,
      storedRule: storedWeeklyBasisRule,
      variance: weeklyVariance,
      operatingTotal: numericField(row, ["주간운영판매기준수", "weeklyOperatingTotal"]),
      operatingTotalDays: numericField(row, ["주간운영판매기준확인일수", "weeklyOperatingTotalDays"]),
      structuralBlockedTotal: numericField(row, ["주간상시차단추정수", "weeklyStructuralBlockedTotal"]),
      stockBasisType: row["주간총량판단유형"] || row.weeklyStockBasisType || ""
    });
    const weeklyBasisTotal = weeklyStockBasis.basisTotal;
    const weeklyOperatingTotal = weeklyStockBasis.operatingTotal;
    const weeklyOperatingTotalDays = weeklyStockBasis.operatingTotalDays;
    const weeklyStructuralBlockedTotal = weeklyStockBasis.structuralBlockedTotal;
    const weeklyStockBasisType = weeklyStockBasis.stockBasisType;
    const weeklyMaxTotalDays = numericField(row, ["주간최대총량확인일수", "weeklyMaxTotalDays"]) ?? weeklyVariance.maxTotalDays;
    const weeklyTotalVarianceGap = numericField(row, ["주간총량편차", "weeklyTotalVarianceGap"]) ?? weeklyVariance.totalVarianceGap;
    const weeklyOfflineReservedTotal = numericField(row, ["주간숙박오프라인예약추정수", "weeklyOfflineReservedTotal"]) ?? offlineReservedTotalForOperating(weeklyVariance, weeklyOperatingTotal);
    const weeklyBasisRule = stockBasisRule(storedWeeklyBasisRule, weeklyBasisTotal, weeklyOperatingTotal, weeklyStructuralBlockedTotal, weeklyOfflineReservedTotal, "개");
    const weeklyEstimatedRevenue = numericField(row, ["주간숙박예상매출", "weeklyEstimatedRevenue"]);
    const weeklyAdjustedRevenue = numericField(row, ["weeklyAdjustedRevenue"]);
    const weeklyMissingPriceEstimatedRevenue = numericField(row, ["weeklyMissingPriceEstimatedRevenue"]);
    const weeklyRevenuePrecisionRate = numericField(row, ["weeklyRevenuePrecisionRate"]);
    const weeklyPricedSoldOut = numericField(row, ["주간숙박가격확인판매수량", "weeklyPricedSoldOut"]);
    const weeklyMissingPriceSoldOut = numericField(row, ["주간숙박가격누락판매수량", "weeklyMissingPriceSoldOut"]);
    const weeklyAvgSoldUnitPrice = numericField(row, ["주간숙박평균판매단가", "weeklyAvgSoldUnitPrice"]);
    const weeklyRevenueDetail = row["주간숙박매출상세"] || "";
    const weeklyRevenueByDayType = row["주간숙박요일매출"] || "";
    const weeklyOfflineReservationDetail = row["주간숙박오프라인예약상세"] || "";
    const dayUseWeeklyDetail = row.dayUseWeeklyDetail || "";
    const dayUseWeeklyRawStockVariance = row.dayUseWeeklyRawStockVariance || "";
    const dayUseWeeklyVariance = parseStockVarianceDetail(dayUseWeeklyRawStockVariance);
    const derivedDayUseWeeklyRates = parseWeeklyReservationRates(dayUseWeeklyDetail);
    const dayUseWeeklyAvgReservationRate = numericField(row, ["dayUseWeeklyAvgReservationRate"]) ?? derivedDayUseWeeklyRates.average;
    const dayUseWeeklyReservationRateDetail = row.dayUseWeeklyReservationRateDetail || derivedDayUseWeeklyRates.detail;
    const dayUseWeeklyTotalSoldOut = numericField(row, ["dayUseWeeklyTotalSoldOut"]) ?? derivedDayUseWeeklyRates.totalSoldOut;
    const dayUseWeeklyTotalStock = numericField(row, ["dayUseWeeklyTotalStock"]) ?? derivedDayUseWeeklyRates.totalStock;
    const dayUseWeeklyExplicitBasisTotal = numericField(row, ["dayUseWeeklyBasisTotal"]);
    const storedDayUseWeeklyBasisRule = row.dayUseWeeklyBasisRule || "";
    const dayUseWeeklyMinTotal = numericField(row, ["dayUseWeeklyMinTotal"]) ?? dayUseWeeklyVariance.minTotal;
    const dayUseWeeklyMaxTotal = numericField(row, ["dayUseWeeklyMaxTotal"]) ?? dayUseWeeklyVariance.maxTotal ?? parseBasisTotalFromRule(storedDayUseWeeklyBasisRule);
    const dayUseWeeklyStockBasis = resolvedStockBasis({
      basisTotal: maxPositiveNumber(dayUseWeeklyExplicitBasisTotal, dayUseWeeklyMaxTotal, parseBasisTotalFromRule(storedDayUseWeeklyBasisRule)),
      explicitBasisTotal: dayUseWeeklyExplicitBasisTotal,
      storedRule: storedDayUseWeeklyBasisRule,
      variance: dayUseWeeklyVariance,
      operatingTotal: numericField(row, ["dayUseWeeklyOperatingTotal"]),
      operatingTotalDays: numericField(row, ["dayUseWeeklyOperatingTotalDays"]),
      structuralBlockedTotal: numericField(row, ["dayUseWeeklyStructuralBlockedTotal"]),
      stockBasisType: row.dayUseWeeklyStockBasisType || ""
    });
    const dayUseWeeklyBasisTotal = dayUseWeeklyStockBasis.basisTotal;
    const dayUseWeeklyOperatingTotal = dayUseWeeklyStockBasis.operatingTotal;
    const dayUseWeeklyOperatingTotalDays = dayUseWeeklyStockBasis.operatingTotalDays;
    const dayUseWeeklyStructuralBlockedTotal = dayUseWeeklyStockBasis.structuralBlockedTotal;
    const dayUseWeeklyStockBasisType = dayUseWeeklyStockBasis.stockBasisType;
    const dayUseWeeklyMaxTotalDays = numericField(row, ["dayUseWeeklyMaxTotalDays"]) ?? dayUseWeeklyVariance.maxTotalDays;
    const dayUseWeeklyTotalVarianceGap = numericField(row, ["dayUseWeeklyTotalVarianceGap"]) ?? dayUseWeeklyVariance.totalVarianceGap;
    const dayUseWeeklyOfflineReservedTotal = numericField(row, ["dayUseWeeklyOfflineReservedTotal"]) ?? offlineReservedTotalForOperating(dayUseWeeklyVariance, dayUseWeeklyOperatingTotal);
    const dayUseWeeklyBasisRule = stockBasisRule(storedDayUseWeeklyBasisRule, dayUseWeeklyBasisTotal, dayUseWeeklyOperatingTotal, dayUseWeeklyStructuralBlockedTotal, dayUseWeeklyOfflineReservedTotal, "회", "데이유즈/캠프닉");
    const dayUseWeeklyEstimatedRevenue = numericField(row, ["dayUseWeeklyEstimatedRevenue"]);
    const dayUseWeeklyAdjustedRevenue = numericField(row, ["dayUseWeeklyAdjustedRevenue"]);
    const dayUseWeeklyMissingPriceEstimatedRevenue = numericField(row, ["dayUseWeeklyMissingPriceEstimatedRevenue"]);
    const dayUseWeeklyRevenuePrecisionRate = numericField(row, ["dayUseWeeklyRevenuePrecisionRate"]);
    const dayUseWeeklyPricedSoldOut = numericField(row, ["dayUseWeeklyPricedSoldOut"]);
    const dayUseWeeklyMissingPriceSoldOut = numericField(row, ["dayUseWeeklyMissingPriceSoldOut"]);
    const dayUseWeeklyAvgSoldUnitPrice = numericField(row, ["dayUseWeeklyAvgSoldUnitPrice"]);
    const dayUseWeeklyOfflineReservationDetail = row.dayUseWeeklyOfflineReservationDetail || "";
    const naverCouponStatus = row["네이버쿠폰노출상태"] || row.naverCouponStatus || "";
    const naverCouponNames = row["네이버쿠폰명"] || row.naverCouponNames || "";
    const naverCouponChannel = row["네이버쿠폰확인채널"] || row.naverCouponChannel || "";
    const naverCouponDetail = row["네이버쿠폰상세"] || row.naverCouponDetail || "";
    const itemDetails = jsonArrayField(row, ["네이버상품상세JSON", "itemDetailsJson", "itemDetails"]);
    const weeklyProductDetails = [
      ...jsonArrayField(row, ["네이버요일별상품상세JSON", "weeklyProductDetailsJson", "weeklyProductDetails"]),
      ...jsonArrayField(row, ["dayUseWeeklyProductDetailsJson"])
    ];

    const key = availabilityPlaceKey(row);
    if (!key || byPlace.has(key)) continue;
    const placeId = extractNaverPlaceId(row);
    const bookingBusinessId = availabilityBookingBusinessId(row);
    const searchRegion = rowSearchRegion(row);
    const addressRegion = rowAddressRegion(row);
    const boundary = regionBoundaryInfo(searchRegion, addressRegion);

    byPlace.set(key, {
      sourceKey: key,
      placeId,
      place_id: placeId,
      bookingBusinessId,
      rank: numericField(row, ["overall_rank", "순위", "rank_or_order"]) || byPlace.size + 1,
      name: row["업체명"] || row.name || "확인불가",
      region: addressRegion || searchRegion || "",
      searchRegion,
      searchCluster: searchRegion,
      addressRegion,
      regionBoundaryStatus: boundary.status,
      regionBoundaryLabel: boundary.label,
      regionBoundaryDetail: boundary.detail,
      outsideSearchRegion: boundary.outside,
      address: row["주소"] || row.location || "",
      roomNamePreview: row["객실명(일부)"] || row.roomNamePreview || row.roomNames || "",
      listType: row["예약리스트유형"] || "",
      productTypeSummary: row["네이버상품구성"] || "",
      naverCouponStatus,
      naverCouponNames,
      naverCouponChannel,
      naverCouponDetail,
      itemDetails,
      weeklyProductDetails,
      nightItemCount: numericField(row, ["숙박상품수"]),
      dayUseItemCount: numericField(row, ["데이유즈상품수"]),
      countedItemCount: numericField(row, ["예약계산대상상품수"]),
      availableRooms,
      totalRooms,
      nightAvailableStock: availableRooms,
      nightTotalStock: totalRooms,
      soldOutRooms: resolvedSoldOutRooms,
      soldOutRate: soldOutRate !== null ? soldOutRate : Number((resolvedSoldOutRooms / totalRooms).toFixed(3)),
      basisLodgingRevenue: numericField(row, ["숙박기준일예상매출", "basisLodgingRevenue"]),
      basisLodgingAdjustedRevenue: numericField(row, ["basisLodgingAdjustedRevenue"]),
      basisLodgingMissingPriceEstimatedRevenue: numericField(row, ["basisLodgingMissingPriceEstimatedRevenue"]),
      basisLodgingRevenuePrecisionRate: numericField(row, ["basisLodgingRevenuePrecisionRate"]),
      basisLodgingPricedSoldOut: numericField(row, ["숙박기준일가격확인판매수량", "basisLodgingPricedSoldOut"]),
      basisLodgingMissingPriceSoldOut: numericField(row, ["숙박기준일가격누락판매수량", "basisLodgingMissingPriceSoldOut"]),
      basisLodgingAvgSoldUnitPrice: numericField(row, ["숙박기준일평균판매단가", "basisLodgingAvgSoldUnitPrice"]),
      availabilityUnit: row["예약계산단위"] || "",
      rawAvailableStock: numericField(row, ["네이버원시예약가능재고", "rawAvailableStock"]),
      rawTotalStock: numericField(row, ["네이버원시전체재고", "rawTotalStock"]),
      groupedRoomCount: numericField(row, ["네이버묶음객실범위수", "groupedRoomCount"]),
      weeklyDays,
      weeklySummary,
      weeklyAvgAvailable: numericField(row, ["주간평균잔여수", "weeklyAvgAvailable"]),
      weeklyMinAvailable: numericField(row, ["주간최소잔여수", "weeklyMinAvailable"]),
      weeklySoldOutDays: numericField(row, ["주간마감일수", "weeklySoldOutDays"]),
      weeklyTotalSoldOut,
      weeklyTotalStock,
      weeklyBasisTotal,
      weeklyOperatingTotal,
      weeklyOperatingTotalDays,
      weeklyStructuralBlockedTotal,
      weeklyStockBasisType,
      weeklyMinTotal,
      weeklyMaxTotal,
      weeklyMaxTotalDays,
      weeklyTotalVarianceGap,
      weeklyOfflineReservedTotal,
      weeklyBasisRule,
      weeklyRawStockVariance,
      weeklyDetail,
      weeklyAvgReservationRate,
      weeklyReservationRateDetail,
      weeklyEstimatedRevenue,
      weeklyAdjustedRevenue,
      weeklyMissingPriceEstimatedRevenue,
      weeklyRevenuePrecisionRate,
      weeklyPricedSoldOut,
      weeklyMissingPriceSoldOut,
      weeklyAvgSoldUnitPrice,
      weeklyRevenueDetail,
      weeklyRevenueByDayType,
      weeklyOfflineReservationDetail,
      dayUseAvailableStock: numericField(row, ["데이유즈예약가능수"]),
      dayUseTotalStock: numericField(row, ["데이유즈확인재고수"]),
      basisDayUseRevenue: numericField(row, ["데이유즈기준일예상매출", "basisDayUseRevenue"]),
      basisDayUseAdjustedRevenue: numericField(row, ["basisDayUseAdjustedRevenue"]),
      basisDayUseMissingPriceEstimatedRevenue: numericField(row, ["basisDayUseMissingPriceEstimatedRevenue"]),
      basisDayUseRevenuePrecisionRate: numericField(row, ["basisDayUseRevenuePrecisionRate"]),
      basisDayUsePricedSoldOut: numericField(row, ["데이유즈기준일가격확인판매수량", "basisDayUsePricedSoldOut"]),
      basisDayUseMissingPriceSoldOut: numericField(row, ["데이유즈기준일가격누락판매수량", "basisDayUseMissingPriceSoldOut"]),
      basisDayUseAvgSoldUnitPrice: numericField(row, ["데이유즈기준일평균판매단가", "basisDayUseAvgSoldUnitPrice"]),
      dayUseWeeklyDays: numericField(row, ["dayUseWeeklyDays"]),
      dayUseWeeklySummary: row.dayUseWeeklySummary || "",
      dayUseWeeklyAvgAvailable: numericField(row, ["dayUseWeeklyAvgAvailable"]),
      dayUseWeeklyMinAvailable: numericField(row, ["dayUseWeeklyMinAvailable"]),
      dayUseWeeklySoldOutDays: numericField(row, ["dayUseWeeklySoldOutDays"]),
      dayUseWeeklyTotalSoldOut,
      dayUseWeeklyTotalStock,
      dayUseWeeklyBasisTotal,
      dayUseWeeklyOperatingTotal,
      dayUseWeeklyOperatingTotalDays,
      dayUseWeeklyStructuralBlockedTotal,
      dayUseWeeklyStockBasisType,
      dayUseWeeklyMinTotal,
      dayUseWeeklyMaxTotal,
      dayUseWeeklyMaxTotalDays,
      dayUseWeeklyTotalVarianceGap,
      dayUseWeeklyOfflineReservedTotal,
      dayUseWeeklyBasisRule,
      dayUseWeeklyEstimatedRevenue,
      dayUseWeeklyAdjustedRevenue,
      dayUseWeeklyMissingPriceEstimatedRevenue,
      dayUseWeeklyRevenuePrecisionRate,
      dayUseWeeklyPricedSoldOut,
      dayUseWeeklyMissingPriceSoldOut,
      dayUseWeeklyAvgSoldUnitPrice,
      dayUseWeeklyRevenueDetail: row.dayUseWeeklyRevenueDetail || "",
      dayUseWeeklyRevenueByDayType: row.dayUseWeeklyRevenueByDayType || "",
      dayUseWeeklyOfflineReservationDetail,
      dayUseWeeklyRawStockVariance,
      dayUseWeeklyDetail,
      dayUseWeeklyAvgReservationRate,
      dayUseWeeklyReservationRateDetail,
      inventoryScope: row["네이버재고범위"] || "네이버예약 채널/날짜 기준 재고",
      inventoryMemo: normalizeInventoryMemo(row["객실수검증메모"], row["예약리스트유형"]),
      rate: rate !== null ? rate : Number((availableRooms / totalRooms).toFixed(3)),
      price: row["예약최저가"] || row["금액"] || row.price || "",
      basis: row["예약가능근거"] || row["네이버예약재고수집상태"] || "",
      url: row.url || row["네이버예약URL"] || ""
    });
  }

  const items = [...byPlace.values()]
    .map((item) => {
      const confidence = evaluateInventoryConfidence({
        availableRooms: item.availableRooms,
        totalRooms: item.totalRooms,
        countedItemCount: item.countedItemCount,
        weeklyDays: item.weeklyDays,
        weeklyDetail: item.weeklyDetail,
        weeklyBasisTotal: item.weeklyBasisTotal,
        weeklyOperatingTotal: item.weeklyOperatingTotal,
        weeklyStructuralBlockedTotal: item.weeklyStructuralBlockedTotal,
        weeklyOfflineReservedTotal: item.weeklyOfflineReservedTotal,
        weeklyMaxTotalDays: item.weeklyMaxTotalDays,
        weeklyTotalVarianceGap: item.weeklyTotalVarianceGap,
        weeklyRawStockVariance: item.weeklyRawStockVariance,
        listType: item.listType,
        rawTotalStock: item.rawTotalStock,
        groupedRoomCount: item.groupedRoomCount,
        dayUseTotalStock: item.dayUseTotalStock,
        dayUseItemCount: item.dayUseItemCount,
        dayUseWeeklyRawStockVariance: item.dayUseWeeklyRawStockVariance,
        inventoryMemo: item.inventoryMemo
      });
      return {
        ...item,
        inventoryConfidence: confidence,
        inventoryStructure: confidence.structure,
        inventoryStructureType: confidence.structure.type,
        inventoryStructureLabel: confidence.structure.label,
        inventoryStructureTone: confidence.structure.tone,
        inventoryStructureSummary: confidence.structure.summary,
        inventoryStructureFlags: confidence.structure.flags,
        inventoryStructureNotes: confidence.structure.notes,
        inventoryStructureAction: confidence.structure.action,
        inventoryConfidenceGrade: confidence.grade,
        inventoryConfidenceLabel: confidence.label,
        inventoryConfidenceScore: confidence.score,
        inventoryConfidenceSummary: confidence.summary,
        inventoryConfidenceReasons: confidence.reasons,
        inventoryAlerts: confidence.alerts
      };
    })
    .sort((a, b) => a.rank - b.rank);
  const totalAvailableRooms = items.reduce((sum, item) => sum + item.availableRooms, 0);
  const totalRooms = items.reduce((sum, item) => sum + item.totalRooms, 0);
  const totalSoldOutRooms = items.reduce((sum, item) => sum + item.soldOutRooms, 0);
  const totalEstimatedRevenue = items.reduce((sum, item) => sum + Number(item.weeklyEstimatedRevenue ?? item.basisLodgingRevenue ?? 0), 0);
  const totalAdjustedEstimatedRevenue = items.reduce((sum, item) => sum + Number(item.weeklyAdjustedRevenue ?? item.basisLodgingAdjustedRevenue ?? item.weeklyEstimatedRevenue ?? item.basisLodgingRevenue ?? 0), 0);
  const totalMissingPriceEstimatedRevenue = items.reduce((sum, item) => sum + Number(item.weeklyMissingPriceEstimatedRevenue ?? item.basisLodgingMissingPriceEstimatedRevenue ?? 0), 0);
  const totalPricedSoldOut = items.reduce((sum, item) => sum + Number(item.weeklyPricedSoldOut ?? item.basisLodgingPricedSoldOut ?? 0), 0);
  const totalMissingPriceSoldOut = items.reduce((sum, item) => sum + Number(item.weeklyMissingPriceSoldOut ?? item.basisLodgingMissingPriceSoldOut ?? 0), 0);
  const dayUseEstimatedRevenue = items.reduce((sum, item) => sum + Number(item.dayUseWeeklyEstimatedRevenue ?? item.basisDayUseRevenue ?? 0), 0);
  const dayUseAdjustedEstimatedRevenue = items.reduce((sum, item) => sum + Number(item.dayUseWeeklyAdjustedRevenue ?? item.basisDayUseAdjustedRevenue ?? item.dayUseWeeklyEstimatedRevenue ?? item.basisDayUseRevenue ?? 0), 0);
  const dayUseMissingPriceEstimatedRevenue = items.reduce((sum, item) => sum + Number(item.dayUseWeeklyMissingPriceEstimatedRevenue ?? item.basisDayUseMissingPriceEstimatedRevenue ?? 0), 0);
  const revenuePrecisionRate = (totalPricedSoldOut + totalMissingPriceSoldOut)
    ? Number((totalPricedSoldOut / (totalPricedSoldOut + totalMissingPriceSoldOut)).toFixed(3))
    : null;
  const revenueSampleCount = items.filter((item) => {
    const lodgingRevenue = Number(item.weeklyAdjustedRevenue ?? item.basisLodgingAdjustedRevenue ?? item.weeklyEstimatedRevenue ?? item.basisLodgingRevenue ?? 0);
    const dayUseRevenue = Number(item.dayUseWeeklyAdjustedRevenue ?? item.basisDayUseAdjustedRevenue ?? item.dayUseWeeklyEstimatedRevenue ?? item.basisDayUseRevenue ?? 0);
    return lodgingRevenue + dayUseRevenue > 0;
  }).length;
  const combinedEstimatedRevenue = totalEstimatedRevenue + dayUseEstimatedRevenue;
  const combinedAdjustedEstimatedRevenue = totalAdjustedEstimatedRevenue + dayUseAdjustedEstimatedRevenue;
  const averageEstimatedRevenue = revenueSampleCount ? Math.round(combinedEstimatedRevenue / revenueSampleCount) : 0;
  const averageAdjustedEstimatedRevenue = revenueSampleCount ? Math.round(combinedAdjustedEstimatedRevenue / revenueSampleCount) : 0;
  const revenueCoverageRate = items.length ? Number((revenueSampleCount / items.length).toFixed(3)) : null;
  return {
    stats: {
      checkedPlaces: items.length,
      totalAvailableRooms,
      totalSoldOutRooms,
      totalRooms,
      totalEstimatedRevenue,
      totalAdjustedEstimatedRevenue,
      totalMissingPriceEstimatedRevenue,
      totalPricedSoldOut,
      totalMissingPriceSoldOut,
      revenuePrecisionRate,
      avgSoldUnitPrice: totalPricedSoldOut ? Math.round(totalEstimatedRevenue / totalPricedSoldOut) : null,
      dayUseEstimatedRevenue,
      dayUseAdjustedEstimatedRevenue,
      dayUseMissingPriceEstimatedRevenue,
      combinedEstimatedRevenue,
      combinedAdjustedEstimatedRevenue,
      averageEstimatedRevenue,
      averageAdjustedEstimatedRevenue,
      revenueSampleCount,
      revenueCoverageRate,
      weightedRate: totalRooms ? Number((totalAvailableRooms / totalRooms).toFixed(3)) : null,
      weightedSoldOutRate: totalRooms ? Number((totalSoldOutRooms / totalRooms).toFixed(3)) : null,
      lowAvailabilityCount: items.filter((item) => item.rate < 0.7).length,
      lowConfidenceCount: items.filter((item) => ["D", "E"].includes(item.inventoryConfidenceGrade)).length,
      stockVarianceCount: items.filter((item) => (item.inventoryStructureFlags || []).includes("dynamic_capacity")).length,
      dayUseMixedCount: items.filter((item) => (item.inventoryStructureFlags || []).includes("dayuse_rotation")).length,
      bookingIdReusedCount: items.filter((item) => (item.inventoryStructureFlags || []).includes("booking_id_reused")).length,
      naverCouponVisibleCount: items.filter((item) => item.naverCouponStatus === "있음" || item.naverCouponNames).length,
      confidenceCounts: items.reduce((acc, item) => {
        const grade = item.inventoryConfidenceGrade || "C";
        acc[grade] = (acc[grade] || 0) + 1;
        return acc;
      }, {}),
      inventoryStructureCounts: items.reduce((acc, item) => {
        const label = item.inventoryStructureLabel || "구조 확인필요";
        acc[label] = (acc[label] || 0) + 1;
        return acc;
      }, {})
    },
    items: items.slice(0, 30)
  };
}

function platformRowGroup(row, platform, statusValue, reasonValue, directionValue, adValue) {
  const failed = statusValue.includes("실패") || statusValue.includes("차단") || reasonValue.length > 0;
  const manual = !failed && (
    statusValue.includes("수동") ||
    String(row["수집방식"] || row.collectionMethod || "").includes("수동") ||
    directionValue.includes("수동")
  );
  const ad = !failed && (
    adValue === "Y" ||
    adValue.includes("광고 집행") ||
    adValue.includes("광고+비광고") ||
    (statusValue.includes("광고") && !statusValue.includes("비광고"))
  );
  const organic = !failed && !manual && !ad && (
    adValue === "N" ||
    statusValue.includes("비광고") ||
    statusValue.includes("검색결과") ||
    platform === "떠나요" ||
    platform === "야놀자/NOL"
  );
  return failed ? "실패" : manual ? "수동" : ad ? "광고" : organic ? "비광고" : "기타";
}

function summarizeCompanyPlatforms(rows) {
  const companies = new Map();

  for (const row of rows) {
    const name = String(row["업체명"] || row.name || "").trim();
    if (!name || name.includes("Cloudflare")) continue;

    const key = companyPlatformKey(name);
    if (!key) continue;

    const platform = row["플랫폼"] || row.channel || "확인불가";
    const statusValue = String(row["수집 상태"] || row.status || row.section || "");
    const rawReasonValue = String(row["실패 원인"] || row.reason || "");
    const inferredYeogiReason =
      platform === "여기어때" && statusValue.includes("차단")
        ? "Cloudflare/WAF 차단"
        : "";
    const reasonValue = rawReasonValue || inferredYeogiReason;
    const directionValue = String(row["수집 방향"] || row.collectionDirection || row.collection_direction || "");
    const adValue = String(row["광고 여부"] || row["광고클러스터"] || row.ad_flag || row["광고집행클러스터"] || "");
    const group = platformRowGroup(row, platform, statusValue, reasonValue, directionValue, adValue);

    if (!companies.has(key)) {
      companies.set(key, {
        key,
        name,
        bestRank: 9999,
        platforms: []
      });
    }

    const company = companies.get(key);
    const rank = numericField(row, ["순위", "rank_or_order", "overall_rank", "ad_order"]);
    if (rank !== null) company.bestRank = Math.min(company.bestRank, rank);

    const available = row["숙박예약가능수"] || row["예약가능객실수"] || "";
    const total = row["숙박확인재고수"] || row["확인객실수"] || "";
    const soldOut = row["숙박판매완료수"] || "";
    const unit = row["예약계산단위"] || "";
    const stock = available && total
      ? `잔여 ${available}/${total}${unit ? ` ${unit}` : ""}${soldOut ? ` · 마감 ${soldOut}/${total}` : ""}`
      : row["전체객실수확인상태"] || "";
    const weeklyDetail = row["주간잔여상세"] || "";
    const weeklyDays = numericField(row, ["주간재고수집일수", "weeklyDays"]);
    const weeklySummary = weeklyDetail
      ? (weeklyDays ? `${weeklyDays}일 날짜별 잔여` : "날짜별 잔여")
      : row["주간잔여요약"] || "";
    const derivedWeeklyRates = parseWeeklyReservationRates(weeklyDetail);
    const weeklyAvgReservationRate = numericField(row, ["주간평균예약률", "weeklyAvgReservationRate"]) ?? derivedWeeklyRates.average;
    const weeklyReservationRateDetail = row["주간예약률상세"] || derivedWeeklyRates.detail;
    const weeklyTotalSoldOut = numericField(row, ["주간판매수량합계", "weeklyTotalSoldOut"]) ?? derivedWeeklyRates.totalSoldOut;
    const weeklyTotalStock = numericField(row, ["주간전체수량합계", "weeklyTotalStock"]) ?? derivedWeeklyRates.totalStock;
    const weeklyExplicitBasisTotal = numericField(row, ["주간기준재고수", "weeklyBasisTotal"]);
    const weeklyRawStockVariance = row["주간원시재고변동"] || "";
    const weeklyVariance = parseStockVarianceDetail(weeklyRawStockVariance);
    const storedWeeklyBasisRule = row["주간숙박총량기준"] || row.weeklyBasisRule || "";
    const weeklyStockBasis = resolvedStockBasis({
      basisTotal: maxPositiveNumber(weeklyExplicitBasisTotal, weeklyVariance.maxTotal, parseBasisTotalFromRule(storedWeeklyBasisRule)),
      explicitBasisTotal: weeklyExplicitBasisTotal,
      storedRule: storedWeeklyBasisRule,
      variance: weeklyVariance,
      operatingTotal: numericField(row, ["주간운영판매기준수", "weeklyOperatingTotal"]),
      operatingTotalDays: numericField(row, ["주간운영판매기준확인일수", "weeklyOperatingTotalDays"]),
      structuralBlockedTotal: numericField(row, ["주간상시차단추정수", "weeklyStructuralBlockedTotal"]),
      stockBasisType: row["주간총량판단유형"] || row.weeklyStockBasisType || ""
    });
    const weeklyBasisTotal = weeklyStockBasis.basisTotal;
    const weeklyOperatingTotal = weeklyStockBasis.operatingTotal;
    const weeklyStructuralBlockedTotal = weeklyStockBasis.structuralBlockedTotal;
    const weeklyOfflineReservedTotal = numericField(row, ["주간숙박오프라인예약추정수", "weeklyOfflineReservedTotal"]) ?? offlineReservedTotalForOperating(weeklyVariance, weeklyOperatingTotal);
    const weeklyBasisRule = stockBasisRule(storedWeeklyBasisRule, weeklyBasisTotal, weeklyOperatingTotal, weeklyStructuralBlockedTotal, weeklyOfflineReservedTotal, "개");
    const weeklyEstimatedRevenue = numericField(row, ["주간숙박예상매출", "weeklyEstimatedRevenue"]);
    const weeklyAdjustedRevenue = numericField(row, ["weeklyAdjustedRevenue"]);
    const weeklyMissingPriceEstimatedRevenue = numericField(row, ["weeklyMissingPriceEstimatedRevenue"]);
    const weeklyRevenuePrecisionRate = numericField(row, ["weeklyRevenuePrecisionRate"]);
    const weeklyPricedSoldOut = numericField(row, ["주간숙박가격확인판매수량", "weeklyPricedSoldOut"]);
    const weeklyMissingPriceSoldOut = numericField(row, ["주간숙박가격누락판매수량", "weeklyMissingPriceSoldOut"]);
    const weeklyAvgSoldUnitPrice = numericField(row, ["주간숙박평균판매단가", "weeklyAvgSoldUnitPrice"]);
    const weeklyRevenueDetail = row["주간숙박매출상세"] || "";
    const weeklyRevenueByDayType = row["주간숙박요일매출"] || "";
    const weeklyOfflineReservationDetail = row["주간숙박오프라인예약상세"] || "";
    const dayUseWeeklyDetail = row.dayUseWeeklyDetail || "";
    const derivedDayUseWeeklyRates = parseWeeklyReservationRates(dayUseWeeklyDetail);
    const dayUseWeeklyAvgReservationRate = numericField(row, ["dayUseWeeklyAvgReservationRate"]) ?? derivedDayUseWeeklyRates.average;
    const dayUseWeeklyReservationRateDetail = row.dayUseWeeklyReservationRateDetail || derivedDayUseWeeklyRates.detail;
    const dayUseWeeklyTotalSoldOut = numericField(row, ["dayUseWeeklyTotalSoldOut"]) ?? derivedDayUseWeeklyRates.totalSoldOut;
    const dayUseWeeklyTotalStock = numericField(row, ["dayUseWeeklyTotalStock"]) ?? derivedDayUseWeeklyRates.totalStock;
    const dayUseWeeklyEstimatedRevenue = numericField(row, ["dayUseWeeklyEstimatedRevenue"]);
    const dayUseWeeklyAdjustedRevenue = numericField(row, ["dayUseWeeklyAdjustedRevenue"]);
    const dayUseWeeklyMissingPriceEstimatedRevenue = numericField(row, ["dayUseWeeklyMissingPriceEstimatedRevenue"]);
    const dayUseWeeklyRevenuePrecisionRate = numericField(row, ["dayUseWeeklyRevenuePrecisionRate"]);
    const dayUseWeeklyPricedSoldOut = numericField(row, ["dayUseWeeklyPricedSoldOut"]);
    const dayUseWeeklyMissingPriceSoldOut = numericField(row, ["dayUseWeeklyMissingPriceSoldOut"]);
    const dayUseWeeklyAvgSoldUnitPrice = numericField(row, ["dayUseWeeklyAvgSoldUnitPrice"]);
    const dayUseWeeklyOfflineReservationDetail = row.dayUseWeeklyOfflineReservationDetail || "";
    const weeklyStockText = weeklyDetail
      ? `${weeklyTotalSoldOut !== null ? `${weeklyDays || "기간"}일 마감추정 ${weeklyTotalSoldOut}${weeklyTotalStock ? `/${weeklyTotalStock}` : ""} · ` : ""}${weeklyBasisTotal ? `전체객실수후보 ${weeklyBasisTotal}${weeklyOperatingTotal && weeklyOperatingTotal !== weeklyBasisTotal ? ` · 운영기준 ${weeklyOperatingTotal}` : ""} · ` : ""}${weeklyBasisRule ? `${weeklyBasisRule} · ` : ""}${weeklyRawStockVariance ? `날짜별 원시재고: ${weeklyRawStockVariance} · ` : ""}${weeklyAvgReservationRate !== null ? `평균 예약률 ${formatRate(weeklyAvgReservationRate)} · ` : ""}${weeklyReservationRateDetail ? `날짜별 예약률: ${weeklyReservationRateDetail} · ` : ""}${weeklySummary ? `${weeklySummary}: ` : ""}${weeklyDetail}`
      : weeklySummary;
    const dayUseWeeklyStockText = dayUseWeeklyDetail
      ? `데이유즈/캠프닉 ${dayUseWeeklyTotalSoldOut !== null ? `${row.dayUseWeeklyDays || "기간"}일 마감추정 ${dayUseWeeklyTotalSoldOut}${dayUseWeeklyTotalStock ? `/${dayUseWeeklyTotalStock}` : ""} · ` : ""}${dayUseWeeklyAvgReservationRate !== null ? `평균 예약률 ${formatRate(dayUseWeeklyAvgReservationRate)} · ` : ""}${dayUseWeeklyReservationRateDetail ? `날짜별 예약률: ${dayUseWeeklyReservationRateDetail} · ` : ""}${dayUseWeeklyDetail}`
      : "";
    const revenueText = weeklyEstimatedRevenue || weeklyMissingPriceSoldOut
      ? `숙박 예상매출 ${Number(weeklyEstimatedRevenue || 0).toLocaleString("ko-KR")}원${weeklyMissingPriceSoldOut ? ` · 가격누락 ${weeklyMissingPriceSoldOut}개` : ""}`
      : "";
    const dayUseRevenueText = dayUseWeeklyEstimatedRevenue || dayUseWeeklyMissingPriceSoldOut
      ? `데이유즈/캠프닉 예상매출 ${Number(dayUseWeeklyEstimatedRevenue || 0).toLocaleString("ko-KR")}원${dayUseWeeklyMissingPriceSoldOut ? ` · 가격누락 ${dayUseWeeklyMissingPriceSoldOut}회` : ""}`
      : "";

    company.platforms.push({
      platform,
      rank: rank ?? "",
      group,
      price: row["예약최저가"] || row["가격"] || row.price || row["금액"] || "",
      status: statusValue || group,
      stock: [stock, weeklyStockText, revenueText, dayUseWeeklyStockText, dayUseRevenueText].filter(Boolean).join(" · "),
      inventoryNote: row["네이버상품구성"] || row["채널재고해석"] || "",
      weeklySummary,
      weeklyDetail,
      weeklyAvgReservationRate,
      weeklyReservationRateDetail,
      weeklyTotalSoldOut,
      weeklyTotalStock,
      weeklyBasisTotal,
      weeklyRawStockVariance,
      weeklyEstimatedRevenue,
      weeklyAdjustedRevenue,
      weeklyMissingPriceEstimatedRevenue,
      weeklyRevenuePrecisionRate,
      weeklyPricedSoldOut,
      weeklyMissingPriceSoldOut,
      weeklyAvgSoldUnitPrice,
      weeklyRevenueDetail,
      weeklyRevenueByDayType,
      weeklyOfflineReservationDetail,
      dayUseWeeklyDays: numericField(row, ["dayUseWeeklyDays"]),
      dayUseWeeklySummary: row.dayUseWeeklySummary || "",
      dayUseWeeklyDetail,
      dayUseWeeklyAvgReservationRate,
      dayUseWeeklyReservationRateDetail,
      dayUseWeeklyTotalSoldOut,
      dayUseWeeklyTotalStock,
      dayUseWeeklyBasisTotal: numericField(row, ["dayUseWeeklyBasisTotal"]),
      dayUseWeeklyEstimatedRevenue,
      dayUseWeeklyAdjustedRevenue,
      dayUseWeeklyMissingPriceEstimatedRevenue,
      dayUseWeeklyRevenuePrecisionRate,
      dayUseWeeklyPricedSoldOut,
      dayUseWeeklyMissingPriceSoldOut,
      dayUseWeeklyAvgSoldUnitPrice,
      dayUseWeeklyRevenueDetail: row.dayUseWeeklyRevenueDetail || "",
      dayUseWeeklyRevenueByDayType: row.dayUseWeeklyRevenueByDayType || "",
      dayUseWeeklyOfflineReservationDetail,
      dayUseWeeklyRawStockVariance: row.dayUseWeeklyRawStockVariance || "",
      dayUseWeeklyStockText,
      url: row.url || row["상품 URL"] || row["네이버예약URL"] || ""
    });
  }

  return [...companies.values()]
    .map((company) => ({
      ...company,
      bestRank: company.bestRank === 9999 ? null : company.bestRank,
      platforms: company.platforms
        .sort((a, b) => {
          const rankA = Number(a.rank || 9999);
          const rankB = Number(b.rank || 9999);
          if (rankA !== rankB) return rankA - rankB;
          return String(a.platform).localeCompare(String(b.platform), "ko");
        })
        .slice(0, 8)
    }))
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999))
    .slice(0, 40);
}

function resolveRunDir(runId) {
  const safeId = path.basename(runId);
  const dirPath = path.join(OUTPUTS_DIR, safeId);
  const relative = path.relative(OUTPUTS_DIR, dirPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return dirPath;
}

async function loadRun(runId, options = {}) {
  const dirPath = resolveRunDir(runId);
  if (!dirPath || !fs.existsSync(dirPath)) return null;

  const stat = await fsp.stat(dirPath);
  const collectedAt = stat.mtime.toISOString();
  const files = await fsp.readdir(dirPath);
  const manifest = await readManifest(dirPath);
  const provinceKey = provinceKeyForRun(runId, manifest);
  const province = PROVINCES[provinceKey] || PROVINCES.local;
  const regionalFile = manifestFile(manifest, "regional", files, (file) => file.endsWith("_naver_place_glamping_clusters.csv"));
  const overallFile = manifestFile(manifest, "overall", files, (file) => file.endsWith("_overall_place_rank.csv"));
  const adFile = manifestFile(manifest, "ads", files, (file) => file.endsWith("_ad_place_list.csv"));
  const platformFile = manifestFile(manifest, "platform", files, (file) => file.endsWith("_glamping_crawl_test.csv"));
  const yeogiManualFile = manifestFile(manifest, "yeogiManual", files, (file) => file.endsWith("_yeogi_manual_import.csv"));
  const reportFile = manifestFile(manifest, "report", files, (file) => file.endsWith("_glamping_crawl_test_report.md"));
  const conditions = await readRunConditions(dirPath, manifest, reportFile);

  const regionalRows = regionalFile
    ? parseCsv((await fsp.readFile(path.join(dirPath, regionalFile), "utf8")).replace(/^\uFEFF/, ""))
    : [];
  const overallRows = overallFile
    ? parseCsv((await fsp.readFile(path.join(dirPath, overallFile), "utf8")).replace(/^\uFEFF/, ""))
    : [];
  const adRows = adFile
    ? parseCsv((await fsp.readFile(path.join(dirPath, adFile), "utf8")).replace(/^\uFEFF/, ""))
    : [];
  const platformRows = platformFile
    ? parseCsv((await fsp.readFile(path.join(dirPath, platformFile), "utf8")).replace(/^\uFEFF/, ""))
    : [];
  const yeogiManualRows = yeogiManualFile
    ? normalizeYeogiManualRows(parseCsv((await fsp.readFile(path.join(dirPath, yeogiManualFile), "utf8")).replace(/^\uFEFF/, "")))
    : [];
  const displayPlatformRows = yeogiManualRows.length
    ? [
        ...platformRows.filter((row) => String(row.channel || row["플랫폼"] || "") !== "여기어때"),
        ...yeogiManualRows
      ]
    : platformRows;
  const regions = summarizeRegionalRows(regionalRows, provinceKey);
  const datalabTrend = await enrichRegionsWithTraffic(regions, dirPath, demandKeywordForRun(manifest, conditions, regions));
  const stats = summarizeStats(regions);
  if (datalabTrend) stats.datalabTrend = datalabTrend;
  const availability = summarizeAvailabilityRows([...overallRows, ...adRows, ...regionalRows, ...displayPlatformRows]);
  const ranking = summarizeRankingRows(overallRows, adRows, regionalRows, availability);
  const demandStructure = buildDemandStructure({
    manifest,
    conditions,
    regions,
    availability,
    datalabTrend
  });

  const result = {
    run: {
      id: runId,
      label: displayNameForRun(runId, manifest),
      keyword: manifest?.keyword || conditions.keyword || "",
      keywordType: manifest?.keywordType || "province",
      searchMode: manifest?.searchMode || (manifest?.keywordType === "company" ? "company" : "keyword"),
      searchModeLabel: SEARCH_MODES[manifest?.searchMode] || (manifest?.keywordType === "company" ? SEARCH_MODES.company : SEARCH_MODES.keyword),
      collectionMode: manifest?.collectionMode || "precision",
      collectionModeLabel: manifest?.collectionModeLabel || COLLECTION_MODES[manifest?.collectionMode] || COLLECTION_MODES.precision,
      detailRankRanges: manifest?.detailRankRanges || "",
      province: provinceKey,
      provinceLabel: province.label,
      mapBounds: province.mapBounds,
      checkIn: conditions.checkIn,
      checkOut: conditions.checkOut,
      adults: conditions.adults,
      productMode: conditions.productMode,
      productModeLabel: PRODUCT_MODES[conditions.productMode] || PRODUCT_MODES.all,
      bookingRangeDays: manifest?.bookingRangeDays || 1,
      bookingRangePlaceLimit: manifest?.bookingRangePlaceLimit || 0,
      counts: manifest?.counts || {},
      files: {
        regional: regionalFile,
        overall: overallFile,
        ads: adFile,
        platform: platformFile,
        yeogiManual: yeogiManualFile,
        report: reportFile,
        all: files
      }
    },
    stats,
    datalabTrend,
    demandStructure,
    regions,
    ranking,
    availability,
    platform: summarizePlatformRows(displayPlatformRows),
    companyPlatforms: summarizeCompanyPlatforms(displayPlatformRows),
    downloads: files
      .filter((file) => /\.(csv|xlsx|md|html|png)$/i.test(file))
      .map((file) => ({
        name: file,
        label: downloadLabelForFile(file, manifest || {}),
        url: `/outputs/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`
      }))
  };

  if (!options.skipCompanyMaster) {
    result.companyMaster = await upsertCompanyMasterForRun(result, collectedAt).catch((error) => ({
      error: error.message || String(error),
      totalCompanies: 0,
      currentRunCompanies: 0,
      duplicateCandidateCount: 0,
      duplicateCandidates: []
    }));
  } else if (options.applyCompanyMaster) {
    result.companyMasterOverlay = await applyCompanyMasterOverridesForRun(result, collectedAt).catch((error) => ({
      error: error.message || String(error),
      applied: 0,
      corrected: 0
    }));
  }

  if (!options.skipHistory) {
    let history = await summarizeHistoryForRun(result);
    if (!history.currentRunObservationCount && availability.items.length) {
      await appendHistoryForRun(runId).catch((error) => {
        console.warn(`Could not backfill history for ${runId}: ${error.message || error}`);
      });
      history = await summarizeHistoryForRun(result);
    }
    result.history = history;
  }

  return result;
}

function summarizePlatformRows(rows) {
  const platformMap = {};
  for (const row of rows) {
    const platform = row["플랫폼"] || row.channel || "확인불가";
    if (!platformMap[platform]) {
      platformMap[platform] = {
        platform,
        count: 0,
        ads: 0,
        organic: 0,
        manual: 0,
        failed: 0,
        other: 0,
        statusCounts: { 광고: 0, 비광고: 0, 수동: 0, 실패: 0, 기타: 0 },
        samples: [],
        samplesByStatus: { 광고: [], 비광고: [], 수동: [], 실패: [], 기타: [] }
      };
    }

    const item = platformMap[platform];
    item.count += 1;
    const adValue = String(row["광고 여부"] || row["광고클러스터"] || row.ad_flag || row["광고집행클러스터"] || "");
    const statusValue = String(row["수집 상태"] || row.status || row.section || "");
    const methodValue = String(row["수집방식"] || row.collectionMethod || "");
    const nameValue = String(row["업체명"] || row.name || "");
    const rawReasonValue = String(row["실패 원인"] || row.reason || "");
    const inferredYeogiReason =
      platform === "여기어때" && (statusValue.includes("차단") || nameValue.includes("Cloudflare"))
        ? "Cloudflare/WAF 403 차단: 직접 HTTP 요청은 브라우저 검증(JS 챌린지, 쿠키, 브라우저 지문)을 통과하지 못했습니다."
        : "";
    const reasonValue = rawReasonValue || inferredYeogiReason;
    const directionValue = String(row["수집 방향"] || row.collectionDirection || row.collection_direction || "") ||
      (inferredYeogiReason
        ? "제휴 API는 현실성 낮은 장기 옵션으로 두고, 단기는 사용자 브라우저 세션 기반 확인 또는 수동 CSV/HTML 가져오기로 보완합니다."
        : "");
    const failed = statusValue.includes("실패") || statusValue.includes("차단") || reasonValue.length > 0;
    const manual = !failed && (
      statusValue.includes("수동") ||
      methodValue.includes("수동") ||
      directionValue.includes("수동")
    );
    const ad = !failed && (
      adValue === "Y" ||
      adValue.includes("광고 집행") ||
      adValue.includes("광고+비광고") ||
      (statusValue.includes("광고") && !statusValue.includes("비광고"))
    );
    const organic = !failed && !manual && !ad && (
      adValue === "N" ||
      statusValue.includes("비광고") ||
      statusValue.includes("검색결과")
    );
    const group = failed ? "실패" : manual ? "수동" : ad ? "광고" : organic ? "비광고" : "기타";
    const fallbackCoreRole =
      platform === "여기어때" ? "보조" : platform === "떠나요" ? "핵심(떠나요/ONDA)" : "핵심";
    const fallbackInventoryNote =
      platform === "네이버"
        ? "네이버예약은 전 채널 연동 재고와 분리 운영될 수 있어 날짜별 숙박재고로 독립 확인"
        : platform === "떠나요"
          ? "떠나요/ONDA 계열 전 채널 연동 후보, 네이버 분리 여부 별도 확인"
          : platform === "야놀자/NOL"
            ? "야놀자/NOL 검색 노출·가격 기준, 전체 객실수와 채널수는 상세 확인 필요"
            : "";
    const fallbackRoomCountStatus =
      platform === "네이버" && (row["숙박확인재고수"] || row["확인객실수"])
        ? `${row["숙박확인재고수"] || row["확인객실수"]}개(네이버 숙박재고, 전체 객실수 아님)`
        : "";
    const fallbackChannelCountStatus =
      platform === "네이버" ? "네이버예약 채널 기준" : platform === "여기어때" ? "" : "목록 단계 미확인";
    const fallbackNaverSplitStatus =
      platform === "여기어때" ? "" : platform === "네이버" ? "네이버 단독 확인" : "네이버 재고와 별도 비교 필요";
    const sample = {
      rank: row["순위"] || row.rank_or_order || "",
      name: nameValue,
      category: row["카테고리"] || row.category || "",
      location: row["주소"] || row.location || "",
      price: row["가격"] || row.price || "",
      status: statusValue || group,
      coreRole: row["핵심분석채널"] || fallbackCoreRole,
      inventoryNote: row["채널재고해석"] || fallbackInventoryNote,
      roomCountStatus: row["전체객실수확인상태"] || fallbackRoomCountStatus,
      channelCountStatus: row["채널수확인상태"] || fallbackChannelCountStatus,
      naverSplitStatus: row["네이버분리확인"] || fallbackNaverSplitStatus,
      reason: reasonValue,
      direction: directionValue,
      adFlag: adValue,
      url: row.url || row["상품 URL"] || ""
    };

    item.statusCounts[group] += 1;
    if (group === "광고") item.ads += 1;
    else if (group === "비광고") item.organic += 1;
    else if (group === "수동") item.manual += 1;
    else if (group === "실패") item.failed += 1;
    else item.other += 1;

    if (item.samples.length < 8) item.samples.push(sample);
    if (item.samplesByStatus[group].length < 6) item.samplesByStatus[group].push(sample);
  }
  return Object.values(platformMap);
}

function emptyCrawlTimingStore() {
  return { source: "glamping_crawl_timing_store", version: 1, updatedAt: "", entries: [] };
}

function normalizeCrawlTimingStore(store = {}) {
  const entries = Array.isArray(store.entries)
    ? store.entries.filter((entry) => Number.isFinite(Number(entry.durationSeconds))).slice(-CRAWL_TIMING_MAX_ENTRIES)
    : [];
  return {
    source: "glamping_crawl_timing_store",
    version: 1,
    ...store,
    entries
  };
}

function readCrawlTimingStoreSync() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_CRAWL_TIMINGS_FILE, "utf8").replace(/^\uFEFF/, ""));
    return normalizeCrawlTimingStore(parsed);
  } catch {
    return emptyCrawlTimingStore();
  }
}

async function readCrawlTimingStore() {
  try {
    const parsed = JSON.parse((await fsp.readFile(HISTORY_CRAWL_TIMINGS_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return normalizeCrawlTimingStore(parsed);
  } catch {
    return emptyCrawlTimingStore();
  }
}

async function writeCrawlTimingStore(store) {
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  const next = normalizeCrawlTimingStore({ ...store, updatedAt: new Date().toISOString() });
  const tempPath = `${HISTORY_CRAWL_TIMINGS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fsp.rename(tempPath, HISTORY_CRAWL_TIMINGS_FILE);
}

function crawlTimingErrorSummary(error) {
  const text = String(error?.message || error || "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

async function appendCrawlTimingEntry({ plan, startedAt, endedAt, estimate, result, error }) {
  if (!startedAt || !endedAt) return { recorded: false, reason: "missing_time" };
  const durationSeconds = Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
  const success = !error;
  const store = await readCrawlTimingStore();
  const entry = {
    id: crypto.randomUUID(),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSeconds,
    success,
    runId: result?.runId || null,
    keyword: plan?.keyword || "",
    conditions: crawlTimingConditions(plan),
    recrawlContext: estimate?.recrawlContext || null,
    estimatedTotalSeconds: estimate?.estimatedTotalSeconds || null,
    estimateSource: estimate?.basis?.timing?.source || "model",
    error: success ? "" : crawlTimingErrorSummary(error)
  };
  store.entries = [...(store.entries || []), entry].slice(-CRAWL_TIMING_MAX_ENTRIES);
  await writeCrawlTimingStore(store);
  return { recorded: true, durationSeconds, success, sampleCount: store.entries.length, file: "history/crawl_timings.json" };
}

async function runCrawler(payload) {
  if (activeCrawlPromise) {
    const elapsedSeconds = activeCrawlStartedAt
      ? Math.max(1, Math.round((Date.now() - activeCrawlStartedAt.getTime()) / 1000))
      : 0;
    const error = new Error(`이미 수집이 진행 중입니다${elapsedSeconds ? ` (${elapsedSeconds}초 경과)` : ""}. 완료 후 다시 실행하세요.`);
    error.statusCode = 409;
    throw error;
  }
  activeCrawlStartedAt = new Date();
  activeCrawlEstimate = estimateCrawlCompletion(payload, readCrawlTimingStoreSync());
  activeCrawlPromise = runCrawlerInternal(payload);
  let result = null;
  let failure = null;
  try {
    result = await activeCrawlPromise;
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const endedAt = new Date();
    const estimate = activeCrawlEstimate;
    await appendCrawlTimingEntry({
      plan: estimate,
      startedAt: activeCrawlStartedAt,
      endedAt,
      estimate,
      result,
      error: failure
    }).then((timing) => {
      if (result && typeof result === "object") {
        result.crawlTiming = timing;
        result.recrawlContext = estimate?.recrawlContext || null;
      }
    }).catch((error) => {
      console.warn(`Could not record crawl timing: ${error.message || error}`);
    });
    activeCrawlPromise = null;
    activeCrawlStartedAt = null;
    activeCrawlEstimate = null;
  }
}

function currentCrawlStatus() {
  const elapsedSeconds = activeCrawlStartedAt
    ? Math.max(1, Math.round((Date.now() - activeCrawlStartedAt.getTime()) / 1000))
    : 0;
  const estimatedTotalSeconds = activeCrawlEstimate?.estimatedTotalSeconds || 0;
  const remainingSeconds = activeCrawlPromise && estimatedTotalSeconds
    ? Math.max(0, Math.round(estimatedTotalSeconds - elapsedSeconds))
    : null;
  const estimatedProgress = activeCrawlPromise && estimatedTotalSeconds
    ? Math.max(1, Math.min(99, Math.round((elapsedSeconds / estimatedTotalSeconds) * 100)))
    : null;
  const estimatedCompleteAt = activeCrawlStartedAt && estimatedTotalSeconds
    ? new Date(activeCrawlStartedAt.getTime() + estimatedTotalSeconds * 1000).toISOString()
    : null;
  const delayThresholdSeconds = estimatedTotalSeconds
    ? Math.max(30, Math.round(estimatedTotalSeconds * 0.15))
    : 0;
  const delayedSeconds = activeCrawlPromise && estimatedTotalSeconds && elapsedSeconds > estimatedTotalSeconds + delayThresholdSeconds
    ? elapsedSeconds - estimatedTotalSeconds
    : 0;
  const stageStatus = activeCrawlPromise
    ? activeCrawlStageStatus(elapsedSeconds)
    : { currentStage: null, stages: [] };
  return {
    active: !!activeCrawlPromise,
    startedAt: activeCrawlStartedAt ? activeCrawlStartedAt.toISOString() : null,
    elapsedSeconds,
    estimatedTotalSeconds: activeCrawlPromise ? estimatedTotalSeconds : null,
    remainingSeconds,
    estimatedProgress,
    estimatedCompleteAt,
    isDelayed: delayedSeconds > 0,
    delayedSeconds,
    delayThresholdSeconds: activeCrawlPromise ? delayThresholdSeconds : null,
    recrawlContext: activeCrawlPromise ? activeCrawlEstimate?.recrawlContext || null : null,
    currentStage: stageStatus.currentStage,
    stages: stageStatus.stages,
    estimateBasis: activeCrawlPromise ? activeCrawlEstimate?.basis || null : null
  };
}

function activeCrawlStageStatus(elapsedSeconds = 0) {
  const stages = Array.isArray(activeCrawlEstimate?.stages) ? activeCrawlEstimate.stages : [];
  if (!stages.length) return { currentStage: null, stages: [] };
  let cursor = 0;
  let currentStage = null;
  const rendered = stages.map((stage, index) => {
    const seconds = Math.max(1, Number(stage.seconds) || 1);
    const start = cursor;
    const end = cursor + seconds;
    cursor = end;
    let status = "pending";
    let progress = 0;
    if (elapsedSeconds >= end) {
      status = "done";
      progress = 100;
    } else if (elapsedSeconds >= start || (!currentStage && index === 0)) {
      status = "active";
      progress = ((elapsedSeconds - start) / seconds) * 100;
      progress = Math.max(1, Math.min(99, progress));
    }
    const row = {
      key: stage.key,
      label: stage.label,
      detail: stage.detail,
      seconds,
      status,
      progress: Math.round(progress)
    };
    if (status === "active") currentStage = row;
    return row;
  });
  if (!currentStage && rendered.length) {
    const pending = rendered.find((stage) => stage.status === "pending");
    if (pending) {
      currentStage = pending;
    } else {
      const last = rendered[rendered.length - 1];
      last.status = "active";
      last.progress = 99;
      currentStage = last;
    }
  }
  return { currentStage, stages: rendered };
}

async function runCrawlerInternal(payload) {
  const plan = crawlExecutionPlan(payload);
  const keyword = plan.keyword;
  const collectionSource = normalizeCollectionSource(payload.collectionSource, payload.sourceRole);
  const sourceRole = sourceRoleForCollectionSource(collectionSource, payload.sourceRole);
  if (!keyword) throw new Error("키워드를 입력해야 합니다.");
  const env = {
    ...process.env,
    CHECK_IN: plan.checkIn,
    CHECK_OUT: plan.checkOut,
    ADULTS: String(payload.adults || process.env.ADULTS || 2),
    SEARCH_MODE: plan.resolvedSearchMode,
    SEARCH_MODE_REQUESTED: normalizeSearchMode(plan.requestedSearchMode),
    SEARCH_MODE_AUTO_CORRECTED: plan.resolvedSearchMode !== normalizeSearchMode(plan.requestedSearchMode) ? "1" : "0",
    COLLECTION_MODE: plan.collectionMode,
    DETAIL_RANK_RANGES: plan.detailRankRanges,
    PRODUCT_MODE: plan.productMode,
    BOOKING_RANGE_DAYS: String(plan.bookingRangeDays),
    BOOKING_RANGE_PLACE_LIMIT: String(plan.bookingRangePlaceLimit),
    SOURCE_ROLE: sourceRole,
    COLLECTION_SOURCE: collectionSource,
    COLLECTION_SOURCE_LABEL: collectionSourceLabel(collectionSource),
    DATA_DIR,
    OUTPUTS_DIR,
    CONFIG_DIR,
    NODE_PATH: process.env.NODE_PATH || (fs.existsSync(DEFAULT_NODE_MODULES) ? DEFAULT_NODE_MODULES : "")
  };

  const scriptPath = path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs");

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, keyword], {
      cwd: ROOT,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `수집 실행 실패: ${code}`));
        return;
      }

      try {
        const trimmed = stdout.trim();
        const jsonStart = trimmed.indexOf("{");
        const parsed = jsonStart >= 0 ? JSON.parse(trimmed.slice(jsonStart)) : null;
        const outputDir = parsed?.outputDir || "";
        const runId = outputDir ? path.basename(outputDir) : null;
        const history = runId
          ? await appendHistoryForRun(runId).catch((error) => ({ appended: 0, error: error.message || String(error) }))
          : null;
        resolve({ output: parsed, runId, history });
      } catch {
        resolve({ output: stdout, runId: null });
      }
    });
  });
}

async function serveStatic(reqUrl, res) {
  if (["/", "/view", "/admin", "/b2b"].includes(reqUrl.pathname)) {
    const html = await fsp.readFile(path.join(WEB_DIR, "index.html"), "utf8");
    const publicHtml = html
      .replace('href="/styles.css"', 'href="/styles.css?v=v2-20260706-interest-lodge-explicit-save"')
      .replace('src="/app.js"', 'src="/app.js?v=v2-20260706-interest-lodge-explicit-save"');
    return send(res, 200, publicHtml, "text/html; charset=utf-8");
  }
  const filePath = safeJoin(WEB_DIR, reqUrl.pathname);
  if (!filePath || !fs.existsSync(filePath) || (await fsp.stat(filePath)).isDirectory()) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  send(res, 200, await fsp.readFile(filePath), MIME_TYPES[ext] || "application/octet-stream");
}

async function serveOutput(reqUrl, res) {
  const relative = reqUrl.pathname.replace(/^\/outputs\//, "");
  const filePath = safeJoin(OUTPUTS_DIR, relative);
  if (!filePath || !fs.existsSync(filePath) || (await fsp.stat(filePath)).isDirectory()) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  send(res, 200, await fsp.readFile(filePath), MIME_TYPES[ext] || "application/octet-stream");
}

async function route(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/api/health") {
      const session = getSession(req);
      if (req.method === "HEAD") return sendHead(res, 200);
      return send(res, 200, { ok: true, loginRequired: true, ...publicSession(session) });
    }

    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/terms") {
      if (req.method === "HEAD") return sendHead(res, 200, "text/html; charset=utf-8");
      return send(res, 200, termsPage(), "text/html; charset=utf-8");
    }

    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/privacy") {
      if (req.method === "HEAD") return sendHead(res, 200, "text/html; charset=utf-8");
      return send(res, 200, privacyPage(), "text/html; charset=utf-8");
    }

    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/signup.js") {
      if (req.method === "HEAD") return sendHead(res, 200, "application/javascript; charset=utf-8");
      return send(res, 200, signupScript(), "application/javascript; charset=utf-8");
    }

    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/api/signup/check-username") {
      if (req.method === "HEAD") return sendHead(res, 200);
      return send(res, 200, await checkSignupUsernameAvailability(reqUrl.searchParams.get("username") || ""));
    }

    if (req.method === "GET" && reqUrl.pathname === "/signup") {
      const session = getSession(req);
      if (session) return send(res, 302, "", "text/plain; charset=utf-8", { Location: redirectPathForRole(session.role) });
      return send(res, 200, signupPage(), "text/html; charset=utf-8");
    }

    if (req.method === "POST" && (reqUrl.pathname === "/signup" || reqUrl.pathname === "/api/signup")) {
      const payload = await parseLoginBody(req);
      try {
        const account = await registerB2BMember(payload, { req });
        const sessionId = createSession(account.username, account.role, account);
        if (reqUrl.pathname === "/signup") {
          return send(res, 302, "", "text/plain; charset=utf-8", {
            "Set-Cookie": sessionCookie(sessionId),
            Location: "/b2b"
          });
        }
        return send(res, 200, { ok: true, ...publicSession({ ...account, role: USER_ROLES.b2b }) }, "application/json; charset=utf-8", {
          "Set-Cookie": sessionCookie(sessionId)
        });
      } catch (error) {
        if (reqUrl.pathname === "/signup") return send(res, error.statusCode || 400, signupPage(error.message, payload), "text/html; charset=utf-8");
        return send(res, error.statusCode || 400, { error: error.message || String(error) });
      }
    }

    if (req.method === "POST" && (reqUrl.pathname === "/api/login" || reqUrl.pathname === "/login")) {
      const payload = await parseLoginBody(req);
      const username = String(payload.username || "").trim();
      const password = String(payload.password || "").trim();
      const account = await authenticatedUserForCredentials(username, password);
      if (!account) {
        if (reqUrl.pathname === "/login") return sendLogin(res, 401, "아이디 또는 비밀번호가 올바르지 않습니다.");
        return send(res, 401, { error: "아이디 또는 비밀번호가 올바르지 않습니다." });
      }
      const sessionId = createSession(account.username, account.role, account);
      if (reqUrl.pathname === "/login") {
        return send(res, 302, "", "text/plain; charset=utf-8", {
          "Set-Cookie": sessionCookie(sessionId),
          Location: redirectPathForRole(account.role)
        });
      }
      return send(res, 200, { ok: true, ...account }, "application/json; charset=utf-8", {
        "Set-Cookie": sessionCookie(sessionId)
      });
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/logout") {
      const session = getSession(req);
      if (session?.id) sessions.delete(session.id);
      return send(res, 200, { ok: true }, "application/json; charset=utf-8", {
        "Set-Cookie": clearSessionCookie()
      });
    }

    if (req.method === "GET" && reqUrl.pathname === "/login") {
      const session = getSession(req);
      if (session) return send(res, 302, "", "text/plain; charset=utf-8", { Location: redirectPathForRole(session.role) });
      return sendLogin(res);
    }

    if (!requireLogin(req, res, reqUrl)) return;
    const session = getSession(req);

    if (req.method === "GET" && reqUrl.pathname === "/api/session") {
      return send(res, 200, publicSession(session));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/member/search-history") {
      const limit = Number(reqUrl.searchParams.get("limit") || 20);
      return send(res, 200, await publicB2BSearchHistoryForSession(session, limit));
    }

    if (req.method === "GET" && reqUrl.pathname.startsWith("/api/member/runs/")) {
      const runId = decodeURIComponent(reqUrl.pathname.replace("/api/member/runs/", ""));
      const history = await readB2BSearchHistoryStore();
      const allowed = normalizeUserRole(session.role) === USER_ROLES.admin
        || history.entries.some((entry) => entry.runId === runId && memberMatchesSession(entry, session));
      if (!allowed) return sendForbidden(req, res, "본인 검색 이력에 있는 리포트만 열람할 수 있습니다.");
      const data = await loadRun(runId, { skipCompanyMaster: true, skipHistory: true, applyCompanyMaster: true });
      return data ? send(res, 200, publicRunForRole(data, session.role)) : notFound(res);
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/b2b-members") {
      if (!requireAdminSession(session, req, res)) return;
      const memberStore = await readB2BMemberStore();
      const history = await readB2BSearchHistoryStore();
      return send(res, 200, {
        members: memberStore.members.map(publicB2BMember),
        searches: history.entries.slice().sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 200).map(publicB2BSearchHistoryEntry)
      });
    }

    if (reqUrl.pathname === "/admin" && !requireAdminSession(session, req, res)) return;

    if (req.method === "HEAD" && ["/", "/view", "/admin", "/b2b"].includes(reqUrl.pathname)) {
      return sendHead(res, 200, "text/html; charset=utf-8");
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/runs") {
      return send(res, 200, { runs: publicRunsForRole(await listRuns(), session.role) });
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/b2b-search") {
      if (normalizeUserRole(session.role) !== USER_ROLES.b2b) {
        return sendForbidden(req, res, "B2B 검색 계정이 필요합니다.");
      }
      const payload = await parseJsonBody(req);
      return send(res, 200, await runB2BSearch(payload, { session, req }));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/b2b-my-lodge-collect") {
      if (normalizeUserRole(session.role) !== USER_ROLES.b2b) {
        return sendForbidden(req, res, "B2B 계정이 필요합니다.");
      }
      const payload = await parseJsonBody(req);
      return send(res, 200, await runB2BMyLodgeCollection(payload));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/crawl-status") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, currentCrawlStatus());
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/crawl-estimate") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      const timingStore = readCrawlTimingStoreSync();
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 40) : null;
      if (items) {
        return send(res, 200, {
          items: items.map((item) => ({
            clientKey: item.clientKey || "",
            estimate: publicCrawlEstimate(item, timingStore)
          }))
        });
      }
      return send(res, 200, publicCrawlEstimate(payload, timingStore));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/history/summary") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, await summarizeHistoryOperations());
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/company-master/summary") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, await summarizeCompanyMaster());
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/location-card-requests") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, publicLocationCardRequests(await readLocationCardRequests()));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/location-card-request") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveLocationCardRequest(payload));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/duplicates") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      return send(res, 200, await resolveCompanyMasterDuplicate(payload));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/manual-correction") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveCompanyManualCorrection(payload));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/admin-review") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveCompanyAdminReview(payload));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/sales-contact") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveCompanySalesContact(payload));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/backfill") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      return send(res, 200, await backfillCompanyMasterFromRuns(payload));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/settings/traffic-keys") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, trafficKeyStatus(await readTrafficKeys()));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/settings/traffic-keys") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveTrafficKeys(payload));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/settings/traffic-keys/verify") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, await verifyTrafficKeys());
    }

    if (req.method === "GET" && reqUrl.pathname.startsWith("/api/runs/")) {
      if (normalizeUserRole(session.role) !== USER_ROLES.admin) {
        return sendForbidden(req, res, "저장 자료는 관리자만 볼 수 있습니다.");
      }
      const runId = decodeURIComponent(reqUrl.pathname.replace("/api/runs/", ""));
      const data = await loadRun(runId);
      return data ? send(res, 200, publicRunForRole(data, session.role)) : notFound(res);
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/crawl") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      const result = await runCrawler({
        ...payload,
        sourceRole: USER_ROLES.admin,
        collectionSource: normalizeCollectionSource(payload.collectionSource, USER_ROLES.admin)
      });
      const runs = publicRunsForRole(await listRuns(), session.role);
      return send(res, 200, { ...result, runs });
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/yeogi-import") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      const result = await importYeogiSupplement(payload);
      const runs = publicRunsForRole(await listRuns(), session.role);
      return send(res, 200, { ...result, runs });
    }

    if (req.method === "GET" && reqUrl.pathname.startsWith("/outputs/")) {
      if (!requireAdminSession(session, req, res)) return;
      return serveOutput(reqUrl, res);
    }

    if (req.method === "GET") {
      return serveStatic(reqUrl, res);
    }

    send(res, 405, { error: "Method not allowed" });
  } catch (error) {
    send(res, error.statusCode || 500, { error: error.message || String(error) });
  }
}

const server = http.createServer((req, res) => {
  route(req, res);
});

function localNetworkUrls() {
  const interfaces = os.networkInterfaces();
  return Object.values(interfaces)
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${PORT}`);
}

seedOutputsFromRepo()
  .catch((error) => {
    console.warn(`Could not seed outputs from repo: ${error.message || error}`);
  })
  .finally(() => {
    server.listen(PORT, HOST, () => {
      const primaryUrl = HOST === "0.0.0.0" ? `http://127.0.0.1:${PORT}` : `http://${HOST}:${PORT}`;
      console.log(`Glamping cluster app running at ${primaryUrl}`);
      if (HOST === "0.0.0.0") {
        for (const url of localNetworkUrls()) console.log(`Mobile/LAN URL: ${url}`);
      }
    });
  });
