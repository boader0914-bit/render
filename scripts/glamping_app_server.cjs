const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");
const yeogiImportParser = require("./yeogi_import_parser.cjs");
const { createCollector: createTourismCollector } = require("./tourism_collector.cjs");

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
const LOCATION_SCORE_OVERRIDES_FILE = path.join(CONFIG_DIR, "location_score_overrides.json");
const LEGACY_B2B_MEMBERS_FILE = path.join(CONFIG_DIR, "b2b_members.json");
const B2B_MEMBERS_FILE = path.join(CUSTOMER_DB_DIR, "b2b_members.json");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const HISTORY_OBSERVATIONS_FILE = path.join(HISTORY_DIR, "observations.jsonl");
const HISTORY_DATALAB_TRENDS_FILE = path.join(HISTORY_DIR, "datalab_trends.json");
const HISTORY_CRAWL_TIMINGS_FILE = path.join(HISTORY_DIR, "crawl_timings.json");
const LEGACY_B2B_SEARCH_HISTORY_FILE = path.join(HISTORY_DIR, "b2b_search_history.json");
const B2B_SEARCH_HISTORY_FILE = path.join(CUSTOMER_DB_DIR, "b2b_search_history.json");
const B2B_INTEREST_LODGES_FILE = path.join(CUSTOMER_DB_DIR, "b2b_interest_lodges.json");
const ACCOUNT_DELETE_REQUESTS_FILE = path.join(CUSTOMER_DB_DIR, "account_delete_requests.json");
const COMPANY_MASTER_DIR = path.join(DATA_DIR, "company_master");
const COMPANY_MASTER_FILE = path.join(COMPANY_MASTER_DIR, "companies.json");
const TOURISM_DATA_DIR = path.join(DATA_DIR, "tourism_data");
const LEGAL_POLICY_VERSION = "2026-07-08";
const TERMS_VERSION = LEGAL_POLICY_VERSION;
const PRIVACY_VERSION = LEGAL_POLICY_VERSION;
const MARKETING_CONSENT_VERSION = LEGAL_POLICY_VERSION;
const SERVICE_BUSINESS_NAME = String(process.env.LODGING_DATALAB_BUSINESS_NAME || "사분").trim();
const SERVICE_BUSINESS_REGISTRATION_NO = String(process.env.LODGING_DATALAB_BUSINESS_REGISTRATION_NO || "515-13-21899").trim();
const SERVICE_BUSINESS_ADDRESS = String(process.env.LODGING_DATALAB_BUSINESS_ADDRESS || "경상남도 진주시 도동로3번길 10, 1층 일부(상평동)").trim();
const SERVICE_OPERATOR_NAME = String(process.env.LODGING_DATALAB_OPERATOR_NAME || process.env.GLAMPING_OPERATOR_NAME || SERVICE_BUSINESS_NAME).trim();
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
const B2B_MEMBER_DAILY_SEARCH_LIMIT = 2;
const B2B_MEMBER_MAX_DAILY_SEARCH_LIMIT = 50;
const B2B_MEMBER_ALLOWED_RANK_RANGE = "1-10";
const B2B_MEMBER_EXPANDED_RANK_RANGE = "1-20";
const B2B_INTEREST_LODGE_LIMIT = 2;
const B2B_INTEREST_LODGE_SEGMENT_LIMIT = 8;
const SESSION_COOKIE_NAME = "glamping_datalab_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const PASSWORD_HASH_ITERATIONS = 120000;
const USER_ROLES = {
  admin: "admin",
  b2b: "b2b"
};
const sessions = new Map();
const loginAttempts = new Map();
const requestRateLimits = new Map();
const RATE_LIMIT_POLICIES = {
  login: { limit: 20, windowMs: 15 * 60 * 1000 },
  signupCheck: { limit: 60, windowMs: 10 * 60 * 1000 },
  signup: { limit: 8, windowMs: 60 * 60 * 1000 },
  accountDelete: { limit: 10, windowMs: 60 * 60 * 1000 },
  b2bSearch: { limit: 12, windowMs: 5 * 60 * 1000 },
  b2bMyLodgeCollect: { limit: 10, windowMs: 10 * 60 * 1000 },
  b2bInterestLodgeSave: { limit: 60, windowMs: 10 * 60 * 1000 },
  adminCrawl: { limit: 20, windowMs: 10 * 60 * 1000 },
  adminTourism: { limit: 30, windowMs: 10 * 60 * 1000 }
};
const tourismCollector = createTourismCollector({
  rootDir: ROOT,
  webDir: WEB_DIR,
  dataDir: DATA_DIR,
  tourismDataDir: TOURISM_DATA_DIR
});
let activeCrawlPromise = null;
let activeCrawlStartedAt = null;
let activeCrawlEstimate = null;
let activeCrawlChild = null;
let activeCrawlCancelRequested = false;
let activeCrawlCancelReason = "";
let activeCrawlSourceRole = "";
let activeCrawlJob = null;
let crawlJobSequence = 0;
const crawlQueue = [];
const recentCrawlResults = new Map();
const CRAWL_RESULT_REUSE_TTL_MS = 5 * 60 * 1000;
const B2B_COMPLETED_SEARCH_REUSE_TTL_MS = Math.max(
  0,
  Math.round(
    Number.isFinite(Number(process.env.B2B_SEARCH_REUSE_TTL_MINUTES))
      ? Number(process.env.B2B_SEARCH_REUSE_TTL_MINUTES)
      : 30
  )
) * 60 * 1000;
const CRAWL_RUNTIME_STAGE_DEFS = [
  { key: "rank_main", label: "네이버 순위", group: "rank", estimatedRatio: 0.18, detail: "지정 키워드의 네이버 플레이스 노출 순위를 확인합니다." },
  { key: "rank_regional", label: "지역권 노출", group: "rank", estimatedRatio: 0.12, detail: "검색 기준 지역과 인접 권역 노출을 정리합니다." },
  { key: "ota_nol", label: "NOL 확인", group: "ota", estimatedRatio: 0.08, detail: "NOL 보조 채널 노출을 확인합니다." },
  { key: "ota_yeogi", label: "여기어때 확인", group: "ota", estimatedRatio: 0.08, detail: "여기어때 보조 채널 노출을 확인합니다." },
  { key: "ota_ddnayo", label: "떠나요 확인", group: "ota", estimatedRatio: 0.08, detail: "떠나요 보조 채널 노출을 확인합니다." },
  { key: "inventory", label: "예약/가격 확인", group: "inventory", estimatedRatio: 0.36, detail: "네이버 예약 수량, 요일별 가격, 상품 구성을 확인합니다." },
  { key: "save", label: "저장/분석", group: "save", estimatedRatio: 0.10, detail: "결과 파일, 누적 DB, 마스터 자료를 정리합니다." }
];
const CRAWL_LOG_STAGE_RULES = [
  { key: "rank_main", pattern: /Collecting Naver main/i },
  { key: "rank_regional", pattern: /Collecting Naver regional/i },
  { key: "rank_regional", pattern: /Skipping Naver regional/i, skipped: true },
  { key: "ota_nol", pattern: /Collecting NOL/i },
  { key: "ota_nol", pattern: /Skipping NOL/i, skipped: true },
  { key: "ota_yeogi", pattern: /Checking Yeogi/i },
  { key: "ota_yeogi", pattern: /Skipping Yeogi/i, skipped: true },
  { key: "ota_ddnayo", pattern: /Collecting DDNayo/i },
  { key: "ota_ddnayo", pattern: /Skipping DDNayo/i, skipped: true },
  { key: "inventory", pattern: /Checking Naver booking stock/i },
  { key: "save", pattern: /Writing outputs/i }
];
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

function rankRangePlaceLimit(ranges = []) {
  const ranks = new Set();
  for (const range of ranges) {
    const from = Math.max(1, Math.min(50, Math.floor(Number(range.from) || 0)));
    const to = Math.max(1, Math.min(50, Math.floor(Number(range.to) || from)));
    for (let rank = Math.min(from, to); rank <= Math.max(from, to); rank += 1) {
      ranks.add(rank);
      if (ranks.size >= 20) return 20;
    }
  }
  return Math.max(0, Math.min(20, ranks.size));
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
  const productMode = normalizeProductMode(payload.productMode || process.env.PRODUCT_MODE || "all");
  const collectionMode = normalizeCollectionMode(payload.collectionMode || process.env.COLLECTION_MODE || "precision");
  const rawDetailRankRanges = collectionMode === "fast"
    ? ""
    : (payload.detailRankRanges || process.env.DETAIL_RANK_RANGES);
  const parsedDetailRankRanges = parseRankRanges(
    rawDetailRankRanges,
    collectionMode === "fast" ? "" : "1-10"
  );
  const detailRankRanges = rankRangeLabel(parsedDetailRankRanges);
  const detailPlaceLimit = collectionMode === "fast" ? 0 : (rankRangePlaceLimit(parsedDetailRankRanges) || 10);
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
    bookingRangeDays,
    detailPlaceLimit
  );
  const requestedSearchMode = payload.searchMode || process.env.SEARCH_MODE || "keyword";
  const resolvedSearchMode = resolveSearchModeForCrawl(keyword, requestedSearchMode);
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
    estimatedCompleteAt: new Date(Date.now() + Math.max(0, estimate.estimatedTotalSeconds || 0) * 1000).toISOString(),
    estimateBasis: estimate.basis,
    stages: estimate.stages
  };
}

function crawlQueueClientRequestId(value) {
  return String(value || "").trim().replace(/[^a-z0-9._:-]/gi, "").slice(0, 120);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function crawlPayloadSignature(payload = {}) {
  const plan = crawlExecutionPlan(payload);
  const collectionSource = normalizeCollectionSource(payload.collectionSource, payload.sourceRole);
  const sourceRole = sourceRoleForCollectionSource(collectionSource, payload.sourceRole);
  const recrawlContext = sanitizeRecrawlContext(payload.recrawlContext, plan);
  const signaturePayload = {
    keyword: compactKeyword(plan.keyword || "").toLowerCase(),
    checkIn: plan.checkIn,
    checkOut: plan.checkOut,
    bookingRangeDays: plan.bookingRangeDays,
    bookingRangePlaceLimit: plan.bookingRangePlaceLimit,
    searchMode: plan.resolvedSearchMode,
    requestedSearchMode: normalizeSearchMode(plan.requestedSearchMode),
    productMode: plan.productMode,
    collectionMode: plan.collectionMode,
    detailRankRanges: plan.detailRankRanges,
    collectionSource,
    sourceRole,
    recrawlContext
  };
  return crypto.createHash("sha1").update(stableJson(signaturePayload)).digest("hex");
}

function cleanupRecentCrawlResults() {
  const now = Date.now();
  for (const [signature, entry] of recentCrawlResults.entries()) {
    if (!entry || now - Number(entry.createdAt || 0) > CRAWL_RESULT_REUSE_TTL_MS) {
      recentCrawlResults.delete(signature);
    }
  }
}

function reusableRecentCrawlResult(signature) {
  cleanupRecentCrawlResults();
  const entry = recentCrawlResults.get(signature);
  if (!entry || !entry.result?.runId) return null;
  return entry.result;
}

function activeCrawlRemainingSeconds() {
  if (!activeCrawlPromise) return 0;
  const elapsedSeconds = activeCrawlStartedAt
    ? Math.max(0, Math.round((Date.now() - activeCrawlStartedAt.getTime()) / 1000))
    : 0;
  const estimatedTotalSeconds = Number(activeCrawlEstimate?.estimatedTotalSeconds || activeCrawlJob?.estimate?.estimatedTotalSeconds || 0);
  if (!estimatedTotalSeconds) return 30;
  return Math.max(5, Math.round(estimatedTotalSeconds - elapsedSeconds));
}

function crawlJobWaitSeconds(job) {
  if (!job || job.status === "active") return 0;
  let seconds = activeCrawlRemainingSeconds();
  for (const queued of crawlQueue) {
    if (queued === job) break;
    seconds += Math.max(1, Number(queued.estimate?.estimatedTotalSeconds || 1));
  }
  return Math.max(0, Math.round(seconds));
}

function publicCrawlJob(job, position = 0) {
  if (!job) return null;
  const waitSeconds = crawlJobWaitSeconds(job);
  const ownSeconds = Math.max(1, Number(job.estimate?.estimatedTotalSeconds || 1));
  return {
    id: job.id,
    signature: job.signature,
    status: job.status,
    keyword: job.plan?.keyword || "",
    checkIn: job.plan?.checkIn || "",
    checkOut: job.plan?.checkOut || "",
    detailRankRanges: job.plan?.detailRankRanges || "",
    bookingRangeDays: job.plan?.bookingRangeDays || 0,
    bookingRangePlaceLimit: job.plan?.bookingRangePlaceLimit || 0,
    sourceRole: job.sourceRole || "",
    collectionSource: job.collectionSource || "",
    queuePosition: position,
    waiterCount: job.waiterCount || 1,
    queuedAt: job.queuedAt ? job.queuedAt.toISOString() : null,
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    estimatedTotalSeconds: ownSeconds,
    waitSeconds,
    estimatedStartAt: job.status === "active" && job.startedAt
      ? job.startedAt.toISOString()
      : new Date(Date.now() + waitSeconds * 1000).toISOString(),
    estimatedCompleteAt: job.status === "active" && job.startedAt
      ? new Date(job.startedAt.getTime() + ownSeconds * 1000).toISOString()
      : new Date(Date.now() + (waitSeconds + ownSeconds) * 1000).toISOString(),
    stageTimings: publicCrawlStageTimings(job)
  };
}

function findReusableCrawlJob(signature) {
  if (activeCrawlJob?.signature === signature && !activeCrawlCancelRequested) return activeCrawlJob;
  return crawlQueue.find((job) => job.signature === signature && job.status === "queued") || null;
}

function crawlJobHasClientRequestId(job, clientRequestId) {
  return Boolean(job && clientRequestId && job.clientRequestIds?.has(clientRequestId));
}

function findCrawlJobByClientRequestId(clientRequestId) {
  const id = crawlQueueClientRequestId(clientRequestId);
  if (!id) return null;
  if (crawlJobHasClientRequestId(activeCrawlJob, id)) return activeCrawlJob;
  return crawlQueue.find((job) => crawlJobHasClientRequestId(job, id)) || null;
}

function resolveCrawlJob(result, job, mode = "completed") {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    queueStatus: {
      mode,
      jobId: job?.id || "",
      signature: job?.signature || "",
      waiterCount: job?.waiterCount || 1
    }
  };
}

function crawlRuntimeStageDef(key) {
  return CRAWL_RUNTIME_STAGE_DEFS.find((stage) => stage.key === key) || { key, label: key, group: key, estimatedRatio: 0.1, detail: "" };
}

function crawlRuntimeStageEstimatedSeconds(key, estimate = activeCrawlEstimate) {
  const def = crawlRuntimeStageDef(key);
  const total = Math.max(1, Number(estimate?.estimatedTotalSeconds || activeCrawlEstimate?.estimatedTotalSeconds || 1));
  return Math.max(4, Math.round(total * Number(def.estimatedRatio || 0.1)));
}

function ensureCrawlRuntimeState(job) {
  if (!job) return null;
  if (!Array.isArray(job.stageEvents)) job.stageEvents = [];
  if (!job.stageEventByKey) job.stageEventByKey = new Map();
  return job;
}

function finishOpenCrawlRuntimeStage(job, endedAt = new Date()) {
  if (!ensureCrawlRuntimeState(job)) return;
  const current = job.stageEvents.find((event) => event.status === "active");
  if (!current) return;
  current.status = "done";
  current.endedAt = endedAt.toISOString();
  current.durationSeconds = Math.max(0, Math.round((endedAt.getTime() - Date.parse(current.startedAt || endedAt.toISOString())) / 1000));
}

function recordCrawlRuntimeStage(job, key, options = {}) {
  if (!ensureCrawlRuntimeState(job)) return null;
  const def = crawlRuntimeStageDef(key);
  const now = options.at instanceof Date ? options.at : new Date();
  const existing = job.stageEventByKey.get(key);
  if (existing) {
    if (options.skipped && existing.status !== "done") {
      existing.status = "done";
      existing.skipped = true;
      existing.endedAt = now.toISOString();
      existing.durationSeconds = 0;
    }
    return existing;
  }
  finishOpenCrawlRuntimeStage(job, now);
  const event = {
    key,
    group: def.group || key,
    label: def.label || key,
    detail: def.detail || "",
    status: options.skipped ? "done" : "active",
    skipped: Boolean(options.skipped),
    startedAt: now.toISOString(),
    endedAt: options.skipped ? now.toISOString() : "",
    durationSeconds: options.skipped ? 0 : null,
    estimatedSeconds: crawlRuntimeStageEstimatedSeconds(key, job.estimate)
  };
  job.stageEvents.push(event);
  job.stageEventByKey.set(key, event);
  return event;
}

function recordCrawlRuntimeLog(job, text = "") {
  if (!job || !text) return;
  for (const line of String(text).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const rule = CRAWL_LOG_STAGE_RULES.find((item) => item.pattern.test(line));
    if (rule) recordCrawlRuntimeStage(job, rule.key, { skipped: rule.skipped });
  }
}

function recordCrawlRuntimeOutputChunk(job, chunk = "", flush = false) {
  if (!ensureCrawlRuntimeState(job)) return;
  const text = String(chunk || "");
  const source = `${job.stdoutLineBuffer || ""}${text}`;
  const lines = source.split(/\r?\n/);
  job.stdoutLineBuffer = flush ? "" : (lines.pop() || "");
  recordCrawlRuntimeLog(job, flush ? source : lines.join("\n"));
}

function crawlRuntimeStageRows(job = activeCrawlJob, elapsedSeconds = 0) {
  if (!job || !Array.isArray(job.stageEvents) || !job.stageEvents.length) return null;
  const byKey = new Map(job.stageEvents.map((event) => [event.key, event]));
  const rows = CRAWL_RUNTIME_STAGE_DEFS.map((def) => {
    const event = byKey.get(def.key);
    if (!event) return {
      key: def.key,
      group: def.group,
      label: def.label,
      detail: def.detail,
      seconds: crawlRuntimeStageEstimatedSeconds(def.key, job.estimate),
      status: "pending",
      progress: 0,
      actual: true
    };
    if (event.status === "done") return {
      ...event,
      seconds: event.estimatedSeconds || crawlRuntimeStageEstimatedSeconds(def.key, job.estimate),
      progress: 100,
      actual: true
    };
    const startedAtMs = Date.parse(event.startedAt || "");
    const activeElapsed = Number.isFinite(startedAtMs)
      ? Math.max(0, Math.round((Date.now() - startedAtMs) / 1000))
      : Math.max(0, elapsedSeconds);
    const seconds = event.estimatedSeconds || crawlRuntimeStageEstimatedSeconds(def.key, job.estimate);
    return {
      ...event,
      seconds,
      durationSeconds: activeElapsed,
      status: "active",
      progress: Math.max(1, Math.min(99, Math.round((activeElapsed / Math.max(1, seconds)) * 100))),
      actual: true
    };
  });
  const currentStage = rows.find((row) => row.status === "active") || rows.find((row) => row.status === "pending") || rows.at(-1) || null;
  return { currentStage, stages: rows };
}

function publicCrawlStageTimings(job = {}) {
  const events = Array.isArray(job.stageEvents) ? job.stageEvents : [];
  return events.map((event) => ({
    key: event.key,
    group: event.group,
    label: event.label,
    status: event.status,
    skipped: Boolean(event.skipped),
    startedAt: event.startedAt || "",
    endedAt: event.endedAt || "",
    durationSeconds: Number.isFinite(Number(event.durationSeconds)) ? Number(event.durationSeconds) : null,
    estimatedSeconds: Number.isFinite(Number(event.estimatedSeconds)) ? Number(event.estimatedSeconds) : null
  }));
}

function b2bSubscriberFromPayload(payload = {}) {
  const subscriber = payload.b2bSubscriber && typeof payload.b2bSubscriber === "object" ? payload.b2bSubscriber : null;
  const clientRequestId = crawlQueueClientRequestId(payload.clientRequestId || subscriber?.clientRequestId);
  if (!subscriber || !clientRequestId) return null;
  return {
    clientRequestId,
    memberId: String(subscriber.memberId || "").trim(),
    username: String(subscriber.username || "").trim(),
    accountType: String(subscriber.accountType || "").trim(),
    role: USER_ROLES.b2b,
    ipHash: String(subscriber.ipHash || "").trim(),
    sessionHash: String(subscriber.sessionHash || "").trim(),
    quotaCounted: subscriber.quotaCounted !== false
  };
}

function b2bSubscriberKey(subscriber = {}) {
  const identity = subscriber.memberId || normalizeLoginId(subscriber.username);
  return [subscriber.clientRequestId || "", identity || "", subscriber.sessionHash || ""].join("|");
}

function addB2BSubscriberToJob(job, payload = {}) {
  if (!job) return;
  const subscriber = b2bSubscriberFromPayload(payload);
  if (!subscriber) return;
  const key = b2bSubscriberKey(subscriber);
  if (!key.trim()) return;
  job.b2bSubscribers.set(key, subscriber);
}

function createCrawlJob(payload = {}, signature = "") {
  const estimate = estimateCrawlCompletion(payload, readCrawlTimingStoreSync());
  const collectionSource = normalizeCollectionSource(payload.collectionSource, payload.sourceRole);
  const sourceRole = sourceRoleForCollectionSource(collectionSource, payload.sourceRole);
  const clientRequestId = crawlQueueClientRequestId(payload.clientRequestId);
  const job = {
    id: `crawl_${Date.now().toString(36)}_${(++crawlJobSequence).toString(36)}`,
    signature,
    payload: { ...payload },
    plan: crawlExecutionPlan(payload),
    estimate,
    collectionSource,
    sourceRole,
    status: "queued",
    queuedAt: new Date(),
    startedAt: null,
    waiterCount: 1,
    clientRequestIds: new Set(clientRequestId ? [clientRequestId] : []),
    b2bSubscribers: new Map(),
    stageEvents: [],
    stageEventByKey: new Map(),
    stdoutLineBuffer: "",
    promise: null,
    resolve: null,
    reject: null
  };
  addB2BSubscriberToJob(job, payload);
  job.promise = new Promise((resolve, reject) => {
    job.resolve = resolve;
    job.reject = reject;
  });
  return job;
}

function attachCrawlJobClient(job, payload = {}) {
  if (!job) return;
  job.waiterCount = Math.max(1, Number(job.waiterCount || 1) + 1);
  const clientRequestId = crawlQueueClientRequestId(payload.clientRequestId);
  if (clientRequestId) job.clientRequestIds.add(clientRequestId);
  addB2BSubscriberToJob(job, payload);
}

function startNextCrawlJob() {
  if (activeCrawlPromise || activeCrawlJob) return;
  const job = crawlQueue.shift();
  if (!job) return;
  startCrawlJob(job);
}

function startCrawlJob(job) {
  job.status = "active";
  job.startedAt = new Date();
  activeCrawlJob = job;
  activeCrawlStartedAt = job.startedAt;
  activeCrawlEstimate = estimateCrawlCompletion(job.payload, readCrawlTimingStoreSync());
  job.estimate = activeCrawlEstimate;
  activeCrawlCancelRequested = false;
  activeCrawlCancelReason = "";
  activeCrawlSourceRole = job.sourceRole;
  const internalPromise = runCrawlerInternal(job.payload);
  activeCrawlPromise = internalPromise;

  (async () => {
    let result = null;
    let failure = null;
    try {
      result = await internalPromise;
    } catch (error) {
      failure = error;
    }
    const endedAt = new Date();
    finishOpenCrawlRuntimeStage(job, endedAt);
    const stageTimings = publicCrawlStageTimings(job);
    const estimate = activeCrawlEstimate;
    await appendCrawlTimingEntry({
      plan: estimate,
      startedAt: activeCrawlStartedAt,
      endedAt,
      estimate,
      result,
      error: failure,
      stageTimings
    }).then((timing) => {
      if (result && typeof result === "object") {
        result.crawlTiming = timing;
        result.recrawlContext = estimate?.recrawlContext || null;
      }
    }).catch((error) => {
      console.warn(`Could not record crawl timing: ${error.message || error}`);
    });
    if (!failure && result?.runId) {
      cleanupRecentCrawlResults();
      recentCrawlResults.set(job.signature, { createdAt: Date.now(), result });
      await ensureB2BSearchHistoryForJob(job, result).catch((error) => {
        console.warn(`Could not ensure B2B history for ${result.runId}: ${error.message || error}`);
      });
    }
    activeCrawlPromise = null;
    activeCrawlStartedAt = null;
    activeCrawlEstimate = null;
    activeCrawlChild = null;
    activeCrawlCancelRequested = false;
    activeCrawlCancelReason = "";
    activeCrawlSourceRole = "";
    activeCrawlJob = null;
    job.status = failure ? "failed" : "completed";
    if (failure) job.reject(failure);
    else job.resolve(resolveCrawlJob(result, job, job.waiterCount > 1 ? "shared" : "completed"));
    startNextCrawlJob();
  })();
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
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
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

function emptyLocationScoreOverrides() {
  return {
    schemaVersion: 1,
    updatedAt: "",
    overrides: {}
  };
}

function locationScoreOverrideKey(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase()
    .slice(0, 120);
}

function sanitizeLocationScoreOverrideText(value, max = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);
}

async function readLocationScoreOverrides() {
  try {
    const parsed = JSON.parse((await fsp.readFile(LOCATION_SCORE_OVERRIDES_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return {
      ...emptyLocationScoreOverrides(),
      ...parsed,
      overrides: parsed.overrides || {}
    };
  } catch {
    return emptyLocationScoreOverrides();
  }
}

function publicLocationScoreOverrides(store = emptyLocationScoreOverrides()) {
  const overrides = store.overrides || {};
  return {
    schemaVersion: store.schemaVersion || 1,
    updatedAt: store.updatedAt || "",
    overrides,
    items: Object.values(overrides).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
  };
}

async function writeLocationScoreOverrides(store = emptyLocationScoreOverrides()) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  const tempPath = `${LOCATION_SCORE_OVERRIDES_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
  await fsp.rename(tempPath, LOCATION_SCORE_OVERRIDES_FILE);
}

async function saveLocationScoreOverride(payload = {}, session = {}) {
  const key = locationScoreOverrideKey(payload.key || payload.regionKey || payload.groupKey || payload.searchKeyword);
  if (!key) {
    const error = new Error("보정할 지역 키가 없습니다.");
    error.statusCode = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const store = await readLocationScoreOverrides();
  const current = store.overrides[key] || {};
  const history = Array.isArray(current.history) ? current.history.slice(-29) : [];
  const shouldClear = payload.active === false || payload.clear === true;
  const scoreRaw = payload.scoreOverride ?? payload.overrideScore ?? payload.locationScoreOverride;
  const deltaRaw = payload.scoreDelta ?? payload.adjustmentDelta ?? payload.locationScoreAdjustment;
  const score = String(scoreRaw ?? "").trim() ? Number(scoreRaw) : NaN;
  const delta = String(deltaRaw ?? "").trim() ? Number(deltaRaw) : NaN;
  const hasScore = Number.isFinite(score);
  const hasDelta = Number.isFinite(delta);
  if (!shouldClear && !hasScore && !hasDelta) {
    const error = new Error("보정 점수 또는 보정 폭을 입력하세요.");
    error.statusCode = 400;
    throw error;
  }
  const next = {
    ...current,
    key,
    type: sanitizeLocationScoreOverrideText(payload.type || payload.subjectType || current.type || "region", 40),
    regionKey: sanitizeLocationScoreOverrideText(payload.regionKey || current.regionKey || "", 120),
    groupKey: sanitizeLocationScoreOverrideText(payload.groupKey || current.groupKey || "", 120),
    searchKeyword: sanitizeLocationScoreOverrideText(payload.searchKeyword || current.searchKeyword || "", 120),
    label: sanitizeLocationScoreOverrideText(payload.label || payload.searchKeyword || current.label || key, 120),
    active: !shouldClear,
    scoreOverride: !shouldClear && hasScore ? Math.max(0, Math.min(100, Math.round(score))) : null,
    scoreDelta: !shouldClear && !hasScore && hasDelta ? Math.max(-40, Math.min(40, Math.round(delta))) : null,
    note: shouldClear ? "" : sanitizeLocationScoreOverrideText(payload.note, 500),
    updatedAt: now,
    updatedBy: sanitizeLocationScoreOverrideText(session.username || session.memberId || "admin", 80),
    history: [
      ...history,
      {
        at: now,
        action: shouldClear ? "clear" : "save",
        scoreOverride: !shouldClear && hasScore ? Math.max(0, Math.min(100, Math.round(score))) : null,
        scoreDelta: !shouldClear && !hasScore && hasDelta ? Math.max(-40, Math.min(40, Math.round(delta))) : null,
        note: shouldClear ? "" : sanitizeLocationScoreOverrideText(payload.note, 240),
        by: sanitizeLocationScoreOverrideText(session.username || session.memberId || "admin", 80)
      }
    ]
  };
  store.overrides[key] = next;
  store.updatedAt = now;
  await writeLocationScoreOverrides(store);
  return publicLocationScoreOverrides(store);
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

function normalizeB2BAccountType(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (["demo", "test", "internal"].includes(text)) return text;
  return "member";
}

function normalizeB2BMemberStatus(value = "") {
  return String(value || "").trim().toLowerCase() === "disabled" ? "disabled" : "active";
}

function normalizeB2BMemberDailyLimit(value, fallback = B2B_MEMBER_DAILY_SEARCH_LIMIT) {
  if (value === null || value === "" || value === undefined) return fallback;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  return Math.max(1, Math.min(B2B_MEMBER_MAX_DAILY_SEARCH_LIMIT, number));
}

function normalizeB2BMemberPolicy(policy = {}, accountType = "member") {
  const type = normalizeB2BAccountType(accountType);
  const defaultUnlimited = ["demo", "test", "internal"].includes(type);
  const dailySearchLimit = normalizeB2BMemberDailyLimit(
    policy.dailySearchLimit,
    defaultUnlimited ? 0 : B2B_MEMBER_DAILY_SEARCH_LIMIT
  );
  const expandedSearchAllowed = defaultUnlimited || policy.expandedSearchAllowed === true;
  const limited = dailySearchLimit > 0;
  return {
    dailySearchLimit,
    expandedSearchAllowed,
    limited,
    dailyLimit: limited ? dailySearchLimit : null,
    allowedRankRange: expandedSearchAllowed ? B2B_MEMBER_EXPANDED_RANK_RANGE : B2B_MEMBER_ALLOWED_RANK_RANGE,
    expandedAllowed: expandedSearchAllowed
  };
}

function publicB2BMemberPolicy(member = {}) {
  return normalizeB2BMemberPolicy(member.policy || {}, member.accountType || "member");
}

function publicB2BMemberAdminPolicyHistory(member = {}) {
  return (Array.isArray(member.adminPolicyHistory) ? member.adminPolicyHistory : [])
    .slice(-20)
    .reverse()
    .map((entry) => {
      const accountType = normalizeB2BAccountType(entry.accountType || member.accountType || "member");
      return {
        changedAt: entry.changedAt || "",
        adminUsername: entry.adminUsername || "",
        accountType,
        status: normalizeB2BMemberStatus(entry.status || member.status || "active"),
        policy: normalizeB2BMemberPolicy(entry.policy || {}, accountType)
      };
    });
}

function publicB2BMember(member = {}) {
  const profile = member.profile || {};
  const consents = member.consents || {};
  return {
    memberId: member.memberId || "",
    username: member.username || "",
    role: USER_ROLES.b2b,
    accountType: normalizeB2BAccountType(member.accountType || "member"),
    status: normalizeB2BMemberStatus(member.status || "active"),
    createdAt: member.createdAt || "",
    updatedAt: member.updatedAt || "",
    lastLoginAt: member.lastLoginAt || "",
    searchCount: Number(member.searchCount || 0),
    policy: publicB2BMemberPolicy(member),
    consents: {
      termsVersion: consents.termsVersion || "",
      privacyVersion: consents.privacyVersion || "",
      marketingAccepted: Boolean(consents.marketingAccepted),
      marketingVersion: consents.marketingVersion || "",
      marketingAcceptedAt: consents.marketingAcceptedAt || "",
      acceptedAt: consents.acceptedAt || ""
    },
    profile: {
      ...profile,
      ownershipStatusLabel: profile.ownershipStatusLabel || ownershipStatusLabel(profile.ownershipStatus)
    },
    adminPolicyHistory: publicB2BMemberAdminPolicyHistory(member)
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

function consentRecordFromRequest(req, acceptedAt, payload = {}) {
  const userAgent = String(req?.headers?.["user-agent"] || "");
  const marketingAccepted = isConsentAccepted(payload.agreeMarketing);
  return {
    termsAccepted: true,
    termsVersion: TERMS_VERSION,
    privacyAccepted: true,
    privacyVersion: PRIVACY_VERSION,
    marketingAccepted,
    marketingVersion: marketingAccepted ? MARKETING_CONSENT_VERSION : "",
    marketingAcceptedAt: marketingAccepted ? acceptedAt : "",
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
    policy: normalizeB2BMemberPolicy({}, "member"),
    consents: consentRecordFromRequest(context.req, now, payload),
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

function emptyB2BInterestLodgeStore() {
  return {
    schemaVersion: 1,
    updatedAt: "",
    accounts: {}
  };
}

function b2bInterestLodgeOwnerKey(session = {}) {
  const memberId = sanitizeMemberText(session.memberId, 120);
  if (memberId) return `member:${memberId}`;
  const username = normalizeLoginId(session.username);
  return username ? `username:${username}` : "";
}

function sanitizeInterestLodgeNumberText(value) {
  const numeric = Number(String(value ?? "").replace(/,/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) && numeric > 0 ? String(Math.round(numeric)) : "";
}

function stableB2BInterestLodgeId(lodge = {}) {
  const existing = sanitizeMemberText(lodge.id, 120);
  if (existing) return existing;
  const basis = [
    lodge.lodgingName,
    lodge.savedAt,
    lodge.collectedAt,
    lodge.roomCount,
    lodge.roomType
  ].filter(Boolean).join("|");
  const hash = crypto.createHash("sha256").update(String(basis || Date.now())).digest("base64url").slice(0, 18);
  return `interest-${hash}`;
}

function sanitizeB2BInterestLodgeSegment(row = {}) {
  return {
    type: sanitizeMemberText(row.type || row.roomType, 80),
    count: sanitizeInterestLodgeNumberText(row.count ?? row.roomCount),
    weekdayPrice: sanitizeInterestLodgeNumberText(row.weekdayPrice),
    fridayPrice: sanitizeInterestLodgeNumberText(row.fridayPrice),
    saturdayPrice: sanitizeInterestLodgeNumberText(row.saturdayPrice),
    sundayPrice: sanitizeInterestLodgeNumberText(row.sundayPrice)
  };
}

function b2bInterestLodgeSegmentHasInput(row = {}) {
  return Boolean(
    sanitizeMemberText(row.type, 80) ||
    sanitizeInterestLodgeNumberText(row.count) ||
    sanitizeInterestLodgeNumberText(row.weekdayPrice) ||
    sanitizeInterestLodgeNumberText(row.fridayPrice) ||
    sanitizeInterestLodgeNumberText(row.saturdayPrice) ||
    sanitizeInterestLodgeNumberText(row.sundayPrice)
  );
}

function sanitizeManualCorrectionRoomSegments(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((row) => sanitizeB2BInterestLodgeSegment(row))
    .filter((row) => b2bInterestLodgeSegmentHasInput(row))
    .slice(0, B2B_INTEREST_LODGE_SEGMENT_LIMIT);
}

function manualCorrectionRoomSegments(correction = {}) {
  if (!correction || correction.active === false) return [];
  return sanitizeManualCorrectionRoomSegments(correction.roomSegments);
}

function manualCorrectionRoomSegmentTotal(correction = {}) {
  return manualCorrectionRoomSegments(correction)
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
}

function sanitizeManualCorrectionMeta(payload = {}) {
  return {
    regionOverride: sanitizeMemberText(payload.regionOverride, 80),
    channelNote: sanitizeMemberText(payload.channelNote, 180),
    couponNote: sanitizeMemberText(payload.couponNote, 180)
  };
}

function manualCorrectionMetaHasValue(correction = {}) {
  const meta = sanitizeManualCorrectionMeta(correction);
  return Boolean(meta.regionOverride || meta.channelNote || meta.couponNote);
}

function manualCorrectionLodgingBasisTotal(correction = {}) {
  if (!correction || correction.active === false) return 0;
  const explicit = Number(correction.lodgingBasisTotal);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  const segmentTotal = manualCorrectionRoomSegmentTotal(correction);
  return segmentTotal > 0 ? Math.round(segmentTotal) : 0;
}

function sanitizeB2BInterestLodge(lodge = {}) {
  const now = new Date().toISOString();
  const roomSegments = (Array.isArray(lodge.roomSegments) ? lodge.roomSegments : [])
    .map((row) => sanitizeB2BInterestLodgeSegment(row))
    .filter((row) => b2bInterestLodgeSegmentHasInput(row))
    .slice(0, B2B_INTEREST_LODGE_SEGMENT_LIMIT);
  const verifiedRoomSegments = (Array.isArray(lodge.verifiedRoomSegments) ? lodge.verifiedRoomSegments : [])
    .map((row) => sanitizeB2BInterestLodgeSegment(row))
    .filter((row) => b2bInterestLodgeSegmentHasInput(row))
    .slice(0, B2B_INTEREST_LODGE_SEGMENT_LIMIT);
  const segmentTotal = roomSegments.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const firstSegment = roomSegments[0] || {};
  const roomType = sanitizeMemberText(
    lodge.roomType || roomSegments.map((row) => row.type).filter(Boolean).slice(0, 4).join(", "),
    120
  );
  const savedAt = sanitizeMemberText(lodge.savedAt, 40) || now;
  const registeredAt = sanitizeMemberText(lodge.registeredAt, 40) || savedAt;
  return {
    id: stableB2BInterestLodgeId(lodge),
    lodgingName: sanitizeMemberText(lodge.lodgingName, 100),
    roomCount: sanitizeInterestLodgeNumberText(lodge.roomCount) || (segmentTotal > 0 ? String(segmentTotal) : ""),
    roomType,
    dayUseCount: sanitizeInterestLodgeNumberText(lodge.dayUseCount),
    weekdayPrice: sanitizeInterestLodgeNumberText(lodge.weekdayPrice) || firstSegment.weekdayPrice || "",
    fridayPrice: sanitizeInterestLodgeNumberText(lodge.fridayPrice) || firstSegment.fridayPrice || "",
    saturdayPrice: sanitizeInterestLodgeNumberText(lodge.saturdayPrice) || firstSegment.saturdayPrice || "",
    sundayPrice: sanitizeInterestLodgeNumberText(lodge.sundayPrice) || firstSegment.sundayPrice || "",
    roomSegments,
    facilities: sanitizeMemberText(lodge.facilities, 220),
    naverConnected: lodge.naverConnected === true,
    otaConnected: lodge.otaConnected === true,
    savedAt,
    registeredAt,
    collectedAt: sanitizeMemberText(lodge.collectedAt, 40),
    collectionRunId: sanitizeMemberText(lodge.collectionRunId, 120),
    collectionSource: sanitizeMemberText(lodge.collectionSource, 80),
    collectionStatus: sanitizeMemberText(lodge.collectionStatus, 260),
    collectionPrecisionGrade: sanitizeMemberText(lodge.collectionPrecisionGrade, 12),
    collectionPrecisionLabel: sanitizeMemberText(lodge.collectionPrecisionLabel, 80),
    collectionPrecisionTone: sanitizeMemberText(lodge.collectionPrecisionTone, 20),
    collectionPrecisionScore: Math.max(0, Math.min(100, Math.round(Number(lodge.collectionPrecisionScore) || 0))),
    collectionPrecisionReasons: (Array.isArray(lodge.collectionPrecisionReasons) ? lodge.collectionPrecisionReasons : [])
      .map((item) => sanitizeMemberText(item, 120))
      .filter(Boolean)
      .slice(0, 5),
    collectionPrecisionWarnings: (Array.isArray(lodge.collectionPrecisionWarnings) ? lodge.collectionPrecisionWarnings : [])
      .map((item) => sanitizeMemberText(item, 120))
      .filter(Boolean)
      .slice(0, 5),
    collectionBasis: sanitizeMemberText(lodge.collectionBasis, 260),
    verifiedCorrectionApplied: lodge.verifiedCorrectionApplied === true,
    verifiedLodgingBasisTotal: sanitizeInterestLodgeNumberText(lodge.verifiedLodgingBasisTotal),
    verifiedDayUseBasisTotal: sanitizeInterestLodgeNumberText(lodge.verifiedDayUseBasisTotal),
    verifiedCorrectionLabel: sanitizeMemberText(lodge.verifiedCorrectionLabel, 80),
    verifiedCorrectionSource: sanitizeMemberText(lodge.verifiedCorrectionSource, 80),
    verifiedCorrectionNote: sanitizeMemberText(lodge.verifiedCorrectionNote, 180),
    verifiedCorrectionUpdatedAt: sanitizeMemberText(lodge.verifiedCorrectionUpdatedAt, 40),
    verifiedRoomSegments,
    manualAdjusted: lodge.manualAdjusted === true,
    manualAdjustedAt: sanitizeMemberText(lodge.manualAdjustedAt, 40),
    searchRegion: sanitizeMemberText(lodge.searchRegion, 120),
    addressRegion: sanitizeMemberText(lodge.addressRegion, 120),
    regionBoundaryStatus: sanitizeMemberText(lodge.regionBoundaryStatus, 40),
    regionBoundaryLabel: sanitizeMemberText(lodge.regionBoundaryLabel, 120),
    regionBoundaryDetail: sanitizeMemberText(lodge.regionBoundaryDetail, 220),
    outsideSearchRegion: lodge.outsideSearchRegion === true,
    address: sanitizeMemberText(lodge.address, 220)
  };
}

function b2bInterestLodgeHasInput(lodge = {}) {
  return Boolean(
    sanitizeMemberText(lodge.lodgingName, 100) ||
    sanitizeInterestLodgeNumberText(lodge.roomCount) ||
    sanitizeMemberText(lodge.roomType, 120) ||
    sanitizeInterestLodgeNumberText(lodge.dayUseCount) ||
    sanitizeInterestLodgeNumberText(lodge.weekdayPrice) ||
    sanitizeInterestLodgeNumberText(lodge.fridayPrice) ||
    sanitizeInterestLodgeNumberText(lodge.saturdayPrice) ||
    sanitizeInterestLodgeNumberText(lodge.sundayPrice) ||
    (Array.isArray(lodge.roomSegments) && lodge.roomSegments.some((row) => b2bInterestLodgeSegmentHasInput(row))) ||
    (Array.isArray(lodge.verifiedRoomSegments) && lodge.verifiedRoomSegments.some((row) => b2bInterestLodgeSegmentHasInput(row)))
  );
}

async function readB2BInterestLodgeStore() {
  try {
    const parsed = JSON.parse((await fsp.readFile(B2B_INTEREST_LODGES_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return {
      ...emptyB2BInterestLodgeStore(),
      ...parsed,
      accounts: parsed.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {}
    };
  } catch {
    return emptyB2BInterestLodgeStore();
  }
}

async function writeB2BInterestLodgeStore(store = {}) {
  await fsp.mkdir(CUSTOMER_DB_DIR, { recursive: true });
  const next = {
    ...emptyB2BInterestLodgeStore(),
    ...store,
    updatedAt: new Date().toISOString(),
    accounts: store.accounts && typeof store.accounts === "object" ? store.accounts : {}
  };
  const tempPath = `${B2B_INTEREST_LODGES_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fsp.rename(tempPath, B2B_INTEREST_LODGES_FILE);
  return next;
}

async function publicB2BInterestLodgesForSession(session = {}) {
  const ownerKey = b2bInterestLodgeOwnerKey(session);
  if (!ownerKey) return { version: 2, interestLodges: [], updatedAt: "", storage: "customer_db" };
  const store = await readB2BInterestLodgeStore();
  const account = store.accounts[ownerKey] || {};
  const interestLodges = (Array.isArray(account.interestLodges) ? account.interestLodges : [])
    .map((lodge) => sanitizeB2BInterestLodge(lodge))
    .filter((lodge) => b2bInterestLodgeHasInput(lodge))
    .slice(0, B2B_INTEREST_LODGE_LIMIT);
  return {
    version: 2,
    interestLodges,
    updatedAt: account.updatedAt || store.updatedAt || "",
    storage: "customer_db"
  };
}

async function saveB2BInterestLodgesForSession(session = {}, payload = {}) {
  const ownerKey = b2bInterestLodgeOwnerKey(session);
  if (!ownerKey) {
    const error = new Error("관심숙소를 저장할 계정 정보가 필요합니다.");
    error.statusCode = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const store = await readB2BInterestLodgeStore();
  const interestLodges = (Array.isArray(payload.interestLodges) ? payload.interestLodges : [])
    .map((lodge) => sanitizeB2BInterestLodge(lodge))
    .filter((lodge) => b2bInterestLodgeHasInput(lodge))
    .slice(0, B2B_INTEREST_LODGE_LIMIT);
  store.accounts = store.accounts && typeof store.accounts === "object" ? store.accounts : {};
  store.accounts[ownerKey] = {
    owner: {
      memberId: sanitizeMemberText(session.memberId, 120),
      username: normalizeLoginId(session.username),
      accountType: normalizeB2BAccountType(session.accountType || "")
    },
    updatedAt: now,
    interestLodges
  };
  await writeB2BInterestLodgeStore(store);
  return publicB2BInterestLodgesForSession(session);
}

function clientIpHash(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const raw = forwarded || req.socket?.remoteAddress || "";
  return raw ? crypto.createHash("sha256").update(`ip:${raw}`).digest("hex") : "";
}

function clientUserAgentHash(req) {
  const raw = String(req?.headers?.["user-agent"] || "");
  return raw ? crypto.createHash("sha256").update(`ua:${raw}`).digest("hex") : "";
}

function cleanupRequestRateLimits(now = Date.now()) {
  for (const [key, record] of requestRateLimits) {
    if (!record?.resetAt || record.resetAt <= now) requestRateLimits.delete(key);
  }
}

function requestRateLimitKey(req, scope = "default", identity = "") {
  const ipHash = clientIpHash(req) || "unknown";
  const owner = normalizeLoginId(identity) || "";
  return `${scope}:${owner}:${ipHash}`;
}

function requestRateLimitStatus(req, scope = "default", options = {}, identity = "") {
  const now = Date.now();
  cleanupRequestRateLimits(now);
  const limit = Math.max(1, Math.round(Number(options.limit || 30)));
  const windowMs = Math.max(1000, Math.round(Number(options.windowMs || 60 * 1000)));
  const key = requestRateLimitKey(req, scope, identity);
  const current = requestRateLimits.get(key);
  if (!current || current.resetAt <= now) {
    return { key, allowed: true, limit, remaining: limit, resetAt: now + windowMs, retryAfterSeconds: 0 };
  }
  const count = Number(current.count || 0);
  return {
    key,
    allowed: count < limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt: current.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  };
}

function assertRequestRateLimit(req, scope = "default", options = {}, identity = "") {
  const status = requestRateLimitStatus(req, scope, options, identity);
  if (!status.allowed) {
    const error = new Error(`요청이 잠시 많습니다. ${Math.ceil(status.retryAfterSeconds / 60)}분 후 다시 시도해 주세요.`);
    error.statusCode = 429;
    error.retryAfterSeconds = status.retryAfterSeconds;
    throw error;
  }
  const record = requestRateLimits.get(status.key) || { count: 0, resetAt: status.resetAt };
  record.count = Number(record.count || 0) + 1;
  record.resetAt = status.resetAt;
  requestRateLimits.set(status.key, record);
  return {
    ...status,
    remaining: Math.max(0, status.limit - record.count)
  };
}

function loginAttemptKey(req, username = "") {
  const loginId = normalizeLoginId(username) || "blank";
  const ipHash = clientIpHash(req) || "unknown";
  return `${loginId}:${ipHash}`;
}

function cleanupLoginAttempts(now = Date.now()) {
  for (const [key, attempt] of loginAttempts) {
    const lockedUntil = Number(attempt?.lockedUntil || 0);
    const lastFailedAt = Number(attempt?.lastFailedAt || attempt?.firstFailedAt || 0);
    const staleAfter = Math.max(lockedUntil, lastFailedAt) + LOGIN_FAILURE_WINDOW_MS + LOGIN_LOCK_MS;
    if (!Number.isFinite(staleAfter) || staleAfter <= now) loginAttempts.delete(key);
  }
}

function loginAttemptStatus(req, username = "") {
  const now = Date.now();
  cleanupLoginAttempts(now);
  const key = loginAttemptKey(req, username);
  const attempt = loginAttempts.get(key);
  if (!attempt) return { key, locked: false, retryAfterSeconds: 0, count: 0 };
  const lockedUntil = Number(attempt.lockedUntil || 0);
  if (lockedUntil > now) {
    return {
      key,
      locked: true,
      retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)),
      count: Number(attempt.count || 0)
    };
  }
  if (Number(attempt.firstFailedAt || 0) && now - Number(attempt.firstFailedAt || 0) > LOGIN_FAILURE_WINDOW_MS) {
    loginAttempts.delete(key);
    return { key, locked: false, retryAfterSeconds: 0, count: 0 };
  }
  return { key, locked: false, retryAfterSeconds: 0, count: Number(attempt.count || 0) };
}

function recordLoginFailure(req, username = "") {
  const now = Date.now();
  cleanupLoginAttempts(now);
  const key = loginAttemptKey(req, username);
  const previous = loginAttempts.get(key);
  const windowExpired = !previous?.firstFailedAt || now - Number(previous.firstFailedAt || 0) > LOGIN_FAILURE_WINDOW_MS;
  const attempt = windowExpired
    ? { firstFailedAt: now, count: 0, lockedUntil: 0 }
    : { ...previous };
  attempt.count = Number(attempt.count || 0) + 1;
  attempt.lastFailedAt = now;
  if (attempt.count >= LOGIN_FAILURE_LIMIT) {
    attempt.lockedUntil = now + LOGIN_LOCK_MS;
  }
  loginAttempts.set(key, attempt);
  return loginAttemptStatus(req, username);
}

function clearLoginFailures(req, username = "") {
  loginAttempts.delete(loginAttemptKey(req, username));
}

function loginLockMessage(status = {}) {
  const seconds = Math.max(1, Number(status.retryAfterSeconds || Math.ceil(LOGIN_LOCK_MS / 1000)));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `로그인 시도가 많습니다. ${minutes}분 후 다시 시도하세요.`;
}

function loginLockHeaders(status = {}) {
  if (!status.locked) return {};
  return { "Retry-After": String(Math.max(1, Number(status.retryAfterSeconds || Math.ceil(LOGIN_LOCK_MS / 1000)))) };
}

function publicB2BSearchHistoryEntry(entry = {}) {
  return {
    id: entry.id || "",
    runId: entry.runId || "",
    keyword: entry.keyword || "",
    clientRequestId: entry.clientRequestId || "",
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
    quotaCounted: entry.quotaCounted !== false,
    reuseMode: entry.reuseMode || "",
    reusedFromRunId: entry.reusedFromRunId || "",
    resultSummary: entry.resultSummary || {}
  };
}

function memberMatchesSession(entry = {}, session = {}) {
  if (!session) return false;
  if (entry.memberId && session.memberId) return entry.memberId === session.memberId;
  return normalizeLoginId(entry.username) === normalizeLoginId(session.username);
}

function b2bHistoryOwnerMatches(entry = {}, owner = {}) {
  if (!owner) return false;
  if (entry.memberId && owner.memberId) return entry.memberId === owner.memberId;
  return normalizeLoginId(entry.username) === normalizeLoginId(owner.username);
}

function isGeneralB2BMemberSession(session = {}) {
  return normalizeUserRole(session?.role) === USER_ROLES.b2b
    && String(session?.accountType || "").toLowerCase() === "member";
}

async function effectiveB2BMemberPolicyForSession(session = {}) {
  if (normalizeUserRole(session?.role) !== USER_ROLES.b2b) {
    return normalizeB2BMemberPolicy({}, "member");
  }
  if (session.memberId || session.username) {
    try {
      const store = await readB2BMemberStore();
      const member = (store.members || []).find((item) =>
        (session.memberId && item.memberId === session.memberId) ||
        normalizeLoginId(item.username) === normalizeLoginId(session.username)
      );
      if (member) {
        return {
          ...normalizeB2BMemberPolicy(member.policy || {}, member.accountType || session.accountType || "member"),
          accountType: normalizeB2BAccountType(member.accountType || session.accountType || "member"),
          status: normalizeB2BMemberStatus(member.status || "active")
        };
      }
    } catch {
      // Fall through to the session-level default policy.
    }
  }
  const accountType = normalizeB2BAccountType(session.accountType || (session.username === B2B_USERNAME ? "demo" : "member"));
  return {
    ...normalizeB2BMemberPolicy({}, accountType),
    accountType,
    status: "active"
  };
}

function kstDayKeyFromValue(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const kstDateValue = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  return kstDateValue.toISOString().slice(0, 10);
}

function secondsUntilNextKstDay(nowMs = Date.now()) {
  const kstDateValue = new Date(nowMs + (9 * 60 * 60 * 1000));
  const nextUtcMs = Date.UTC(
    kstDateValue.getUTCFullYear(),
    kstDateValue.getUTCMonth(),
    kstDateValue.getUTCDate() + 1
  ) - (9 * 60 * 60 * 1000);
  return Math.max(1, Math.ceil((nextUtcMs - nowMs) / 1000));
}

function b2bSearchUsageForOwner(owner = {}, entries = []) {
  const dayKey = kstDayKeyFromValue();
  const counted = new Set();
  const todayCounted = new Set();
  let reuseCount = 0;
  let sharedCount = 0;
  const ownerEntries = (entries || []).filter((entry) => b2bHistoryOwnerMatches(entry, owner));
  for (const entry of ownerEntries) {
    const key = entry.runId || entry.searchSignature || entry.id;
    if (entry.quotaCounted === false) {
      reuseCount += 1;
      if (String(entry.reuseMode || "").includes("shared")) sharedCount += 1;
      continue;
    }
    if (key) counted.add(key);
    const entryDayKey = kstDayKeyFromValue(entry.createdAt || entry.completedAt || entry.sourceCompletedAt || "");
    if (entryDayKey === dayKey && key) todayCounted.add(key);
  }
  const recentEntries = ownerEntries
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return {
    dayKey,
    usedToday: todayCounted.size,
    countedTotal: counted.size,
    reuseCount,
    sharedCount,
    latestSearch: recentEntries[0] ? publicB2BSearchHistoryEntry(recentEntries[0]) : null,
    recentSearches: recentEntries.slice(0, 5).map(publicB2BSearchHistoryEntry)
  };
}

async function b2bMemberDailySearchQuota(session = {}, store = null, policy = null) {
  const history = store || await readB2BSearchHistoryStore();
  const usage = b2bSearchUsageForOwner(session, history.entries || []);
  const effectivePolicy = policy || await effectiveB2BMemberPolicyForSession(session);
  const dailyLimit = Number(effectivePolicy.dailySearchLimit || 0);
  return {
    limited: dailyLimit > 0,
    limit: dailyLimit > 0 ? dailyLimit : null,
    used: usage.usedToday,
    remaining: dailyLimit > 0 ? Math.max(0, dailyLimit - usage.usedToday) : null,
    dayKey: usage.dayKey,
    resetAfterSeconds: secondsUntilNextKstDay()
  };
}

async function publicB2BSearchUsageForSession(session = {}, store = null) {
  const role = normalizeUserRole(session?.role);
  if (role !== USER_ROLES.b2b) return null;
  const history = store || await readB2BSearchHistoryStore();
  const usage = b2bSearchUsageForOwner(session, history.entries || []);
  const policy = await effectiveB2BMemberPolicyForSession(session);
  const limited = Number(policy.dailySearchLimit || 0) > 0;
  return {
    accountType: policy.accountType || session.accountType || (session.username === B2B_USERNAME ? "demo" : "member"),
    limited,
    dailyLimit: limited ? Number(policy.dailySearchLimit || 0) : null,
    usedToday: usage.usedToday,
    remainingToday: limited ? Math.max(0, Number(policy.dailySearchLimit || 0) - usage.usedToday) : null,
    countedTotal: usage.countedTotal,
    reuseCount: usage.reuseCount,
    sharedCount: usage.sharedCount,
    allowedRankRange: policy.allowedRankRange || B2B_MEMBER_ALLOWED_RANK_RANGE,
    expandedAllowed: Boolean(policy.expandedSearchAllowed),
    dayKey: usage.dayKey,
    resetAfterSeconds: secondsUntilNextKstDay(),
    latestSearch: usage.latestSearch
  };
}

async function assertB2BMemberSearchPolicy(crawlPayload = {}, session = {}, reusableSearch = null) {
  const policy = await effectiveB2BMemberPolicyForSession(session);
  if (policy.status === "disabled") {
    const error = new Error("비활성화된 계정입니다. 관리자에게 문의하세요.");
    error.statusCode = 403;
    throw error;
  }
  if (normalizeUserRole(session?.role) !== USER_ROLES.b2b) {
    return { limited: false, allowed: true };
  }

  const detailRankRanges = String(crawlPayload.detailRankRanges || "1-10").trim() || "1-10";
  if (!policy.expandedSearchAllowed && detailRankRanges !== B2B_MEMBER_ALLOWED_RANK_RANGE) {
    const error = new Error("이 계정은 기본 분석 1~10위만 사용할 수 있습니다.");
    error.statusCode = 403;
    throw error;
  }

  const quota = await b2bMemberDailySearchQuota(session, null, policy);
  if (reusableSearch) {
    return { ...quota, allowed: true, reuse: true };
  }
  if (quota.limited && quota.remaining <= 0) {
    const error = new Error(`이 계정은 하루 ${quota.limit}회까지 새 리포트를 수집할 수 있습니다. 같은 조건의 최근 리포트는 검색 이력에서 다시 열람하세요.`);
    error.statusCode = 429;
    error.retryAfterSeconds = quota.resetAfterSeconds;
    throw error;
  }
  return { ...quota, allowed: true, reuse: false };
}

async function publicB2BSearchHistoryForSession(session, limit = 20) {
  const store = await readB2BSearchHistoryStore();
  const entries = normalizeUserRole(session?.role) === USER_ROLES.admin
    ? store.entries
    : store.entries.filter((entry) => memberMatchesSession(entry, session));
  return {
    quota: await publicB2BSearchUsageForSession(session, store),
    entries: entries
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(publicB2BSearchHistoryEntry)
  };
}

async function publicB2BMembersAdminOverview() {
  const memberStore = await readB2BMemberStore();
  const history = await readB2BSearchHistoryStore();
  const entries = history.entries || [];
  const members = (memberStore.members || [])
    .map((member) => {
      const publicMember = publicB2BMember(member);
      const usage = b2bSearchUsageForOwner(publicMember, entries);
      const policy = publicMember.policy || normalizeB2BMemberPolicy(member.policy || {}, member.accountType || "member");
      const limited = Number(policy.dailySearchLimit || 0) > 0;
      return {
        ...publicMember,
        policy: {
          ...policy,
          limited,
          dailyLimit: limited ? Number(policy.dailySearchLimit || 0) : null,
          allowedRankRange: policy.allowedRankRange || B2B_MEMBER_ALLOWED_RANK_RANGE,
          expandedAllowed: Boolean(policy.expandedSearchAllowed)
        },
        usage: {
          ...usage,
          remainingToday: limited ? Math.max(0, Number(policy.dailySearchLimit || 0) - usage.usedToday) : null,
          resetAfterSeconds: secondsUntilNextKstDay()
        }
      };
    })
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const todayKey = kstDayKeyFromValue();
  const todayEntries = entries.filter((entry) =>
    kstDayKeyFromValue(entry.createdAt || entry.completedAt || entry.sourceCompletedAt || "") === todayKey
  );
  const policyHistoryEntries = members.flatMap((member) =>
    (Array.isArray(member.adminPolicyHistory) ? member.adminPolicyHistory : [])
      .map((entry) => ({ ...entry, memberId: member.memberId, username: member.username }))
  );
  const latestPolicyChange = policyHistoryEntries
    .slice()
    .sort((a, b) => String(b.changedAt || "").localeCompare(String(a.changedAt || "")))[0] || null;
  const todayNewSearches = new Set(todayEntries
    .filter((entry) => entry.quotaCounted !== false)
    .map((entry) => entry.runId || entry.searchSignature || entry.id)
    .filter(Boolean)).size;
  const todayReuseCount = todayEntries.filter((entry) => entry.quotaCounted === false).length;
  const activeToday = new Set(todayEntries
    .map((entry) => entry.memberId || normalizeLoginId(entry.username))
    .filter(Boolean)).size;

  return {
    members,
    searches: entries
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 200)
      .map(publicB2BSearchHistoryEntry),
    summary: {
      memberCount: members.length,
      activeMemberCount: members.filter((member) => member.status !== "disabled").length,
      todayActiveUsers: activeToday,
      todayNewSearches,
      todayReuseCount,
      todayPolicyChanges: policyHistoryEntries.filter((entry) => kstDayKeyFromValue(entry.changedAt || "") === todayKey).length,
      latestPolicyChangeAt: latestPolicyChange?.changedAt || "",
      totalNewSearches: members.reduce((sum, member) => sum + Number(member.usage?.countedTotal || 0), 0),
      dayKey: todayKey,
      resetAfterSeconds: secondsUntilNextKstDay()
    }
  };
}

const ACCOUNT_DELETE_REQUEST_TYPES = {
  account_delete: "계정 삭제",
  search_history_delete: "검색 이력 삭제",
  interest_lodge_delete: "관심숙소 삭제",
  all_data_delete: "전체 데이터 삭제"
};

const ACCOUNT_DELETE_REQUEST_STATUSES = {
  received: "접수",
  verifying: "본인 확인중",
  processing: "처리중",
  completed: "처리 완료",
  rejected: "반려"
};

function emptyAccountDeleteRequestStore() {
  return {
    schemaVersion: 1,
    updatedAt: "",
    requests: []
  };
}

async function readAccountDeleteRequestStore() {
  try {
    const parsed = JSON.parse((await fsp.readFile(ACCOUNT_DELETE_REQUESTS_FILE, "utf8")).replace(/^\uFEFF/, ""));
    return {
      ...emptyAccountDeleteRequestStore(),
      ...parsed,
      requests: Array.isArray(parsed.requests) ? parsed.requests : []
    };
  } catch {
    return emptyAccountDeleteRequestStore();
  }
}

async function writeAccountDeleteRequestStore(store) {
  await fsp.mkdir(CUSTOMER_DB_DIR, { recursive: true });
  const next = {
    ...emptyAccountDeleteRequestStore(),
    ...store,
    updatedAt: new Date().toISOString(),
    requests: Array.isArray(store.requests) ? store.requests : []
  };
  const tempPath = `${ACCOUNT_DELETE_REQUESTS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fsp.rename(tempPath, ACCOUNT_DELETE_REQUESTS_FILE);
  return next;
}

function normalizeAccountDeleteRequestType(value = "") {
  const key = String(value || "").trim().toLowerCase();
  return ACCOUNT_DELETE_REQUEST_TYPES[key] ? key : "";
}

function accountDeleteRequestTypeLabel(value = "") {
  return ACCOUNT_DELETE_REQUEST_TYPES[normalizeAccountDeleteRequestType(value)] || "삭제 요청";
}

function normalizeAccountDeleteRequestStatus(value = "") {
  const key = String(value || "").trim().toLowerCase();
  return ACCOUNT_DELETE_REQUEST_STATUSES[key] ? key : "received";
}

function accountDeleteRequestStatusLabel(value = "") {
  return ACCOUNT_DELETE_REQUEST_STATUSES[normalizeAccountDeleteRequestStatus(value)] || ACCOUNT_DELETE_REQUEST_STATUSES.received;
}

function accountDeleteRequestPublicRow(request = {}) {
  const status = normalizeAccountDeleteRequestStatus(request.status);
  return {
    requestId: request.requestId || "",
    requestedAt: request.requestedAt || "",
    updatedAt: request.updatedAt || "",
    username: request.username || "",
    memberId: request.memberId || "",
    accountType: request.accountType || "",
    companyName: request.companyName || "",
    contact: request.contact || "",
    requestType: normalizeAccountDeleteRequestType(request.requestType) || "account_delete",
    requestTypeLabel: accountDeleteRequestTypeLabel(request.requestType),
    status,
    statusLabel: accountDeleteRequestStatusLabel(status),
    policyVersion: request.policyVersion || LEGAL_POLICY_VERSION,
    termsVersion: request.termsVersion || TERMS_VERSION,
    privacyVersion: request.privacyVersion || PRIVACY_VERSION,
    consentAcceptedAt: request.consentAcceptedAt || "",
    detail: request.detail || "",
    adminNote: request.adminNote || "",
    statusHistory: Array.isArray(request.statusHistory) ? request.statusHistory.slice(-20) : []
  };
}

async function publicAccountDeleteRequestsAdminOverview() {
  const store = await readAccountDeleteRequestStore();
  const requests = (store.requests || [])
    .map(accountDeleteRequestPublicRow)
    .sort((a, b) => String(b.requestedAt || "").localeCompare(String(a.requestedAt || "")));
  const openStatuses = new Set(["received", "verifying", "processing"]);
  return {
    requests: requests.slice(0, 200),
    summary: {
      totalCount: requests.length,
      openCount: requests.filter((request) => openStatuses.has(request.status)).length,
      completedCount: requests.filter((request) => request.status === "completed").length,
      rejectedCount: requests.filter((request) => request.status === "rejected").length,
      latestRequestedAt: requests[0]?.requestedAt || ""
    }
  };
}

async function findB2BMemberByLoginId(username = "") {
  const normalized = normalizeLoginId(username);
  if (!normalized) return null;
  const store = await readB2BMemberStore();
  return (store.members || []).find((member) => normalizeLoginId(member.username) === normalized) || null;
}

function accountDeletePrefill(session = null, payload = {}) {
  const publicInfo = publicSession(session);
  const profile = publicInfo.profile || {};
  const username = sanitizeMemberText(payload.username || publicInfo.username || "", 80);
  const phone = sanitizeMemberText(payload.phone || profile.phone || "", 40);
  const email = sanitizeMemberText(payload.email || profile.email || "", 120);
  const contact = sanitizeMemberText(payload.contact || email || phone || "", 160);
  return {
    username,
    phone,
    email,
    contact,
    companyName: sanitizeMemberText(payload.companyName || profile.companyName || profile.lodgingName || "", 120),
    requestType: normalizeAccountDeleteRequestType(payload.requestType) || "account_delete",
    detail: sanitizeMemberText(payload.detail, 500)
  };
}

async function createAccountDeleteRequest(payload = {}, context = {}) {
  const session = context.session || null;
  const prefill = accountDeletePrefill(session, payload);
  const username = normalizeLoginId(prefill.username);
  const requestType = normalizeAccountDeleteRequestType(payload.requestType || prefill.requestType);
  const contact = sanitizeMemberText(payload.contact || prefill.contact || payload.email || payload.phone, 160);
  if (!username) {
    const error = new Error("아이디를 입력해 주세요.");
    error.statusCode = 400;
    throw error;
  }
  if (!requestType) {
    const error = new Error("삭제 요청 항목을 선택해 주세요.");
    error.statusCode = 400;
    throw error;
  }
  if (!contact) {
    const error = new Error("처리 결과를 안내받을 연락처 또는 이메일을 입력해 주세요.");
    error.statusCode = 400;
    throw error;
  }
  if (!isConsentAccepted(payload.confirmRequest)) {
    const error = new Error("삭제 요청 내용을 확인했다는 동의가 필요합니다.");
    error.statusCode = 400;
    throw error;
  }

  const member = await findB2BMemberByLoginId(username);
  const now = new Date().toISOString();
  const userAgent = String(context.req?.headers?.["user-agent"] || "");
  const publicInfo = publicSession(session);
  const profile = member?.profile || publicInfo.profile || {};
  const consents = member?.consents || publicInfo.consents || {};
  const request = {
    requestId: `adr_${crypto.randomBytes(9).toString("base64url")}`,
    requestedAt: now,
    updatedAt: now,
    username,
    memberId: member?.memberId || publicInfo.memberId || "",
    accountType: member?.accountType || publicInfo.accountType || "",
    role: publicInfo.authenticated ? publicInfo.role : "",
    companyName: sanitizeMemberText(payload.companyName || profile.companyName || profile.lodgingName || "", 120),
    phone: sanitizeMemberText(payload.phone || profile.phone || "", 40),
    email: sanitizeMemberText(payload.email || profile.email || "", 120),
    contact,
    requestType,
    requestTypeLabel: accountDeleteRequestTypeLabel(requestType),
    status: "received",
    statusLabel: accountDeleteRequestStatusLabel("received"),
    detail: sanitizeMemberText(payload.detail, 500),
    policyVersion: LEGAL_POLICY_VERSION,
    termsVersion: consents.termsVersion || TERMS_VERSION,
    privacyVersion: consents.privacyVersion || PRIVACY_VERSION,
    consentAcceptedAt: consents.acceptedAt || "",
    ipHash: context.req ? clientIpHash(context.req) : "",
    userAgentHash: userAgent ? crypto.createHash("sha256").update(`ua:${userAgent}`).digest("hex") : "",
    statusHistory: [
      {
        changedAt: now,
        status: "received",
        statusLabel: accountDeleteRequestStatusLabel("received"),
        adminUsername: "",
        note: "고객 요청 접수"
      }
    ]
  };
  const store = await readAccountDeleteRequestStore();
  store.requests = [request, ...(store.requests || [])].slice(0, 1000);
  await writeAccountDeleteRequestStore(store);
  return accountDeleteRequestPublicRow(request);
}

async function updateAccountDeleteRequestStatus(requestId = "", payload = {}, adminSession = {}) {
  const id = String(requestId || payload.requestId || "").trim();
  if (!id) {
    const error = new Error("삭제 요청 ID가 필요합니다.");
    error.statusCode = 400;
    throw error;
  }
  const store = await readAccountDeleteRequestStore();
  const request = (store.requests || []).find((item) => item.requestId === id);
  if (!request) {
    const error = new Error("삭제 요청을 찾을 수 없습니다.");
    error.statusCode = 404;
    throw error;
  }
  const now = new Date().toISOString();
  const status = normalizeAccountDeleteRequestStatus(payload.status);
  request.status = status;
  request.statusLabel = accountDeleteRequestStatusLabel(status);
  request.adminNote = sanitizeMemberText(payload.adminNote || request.adminNote || "", 500);
  request.updatedAt = now;
  request.statusHistory = [
    ...(Array.isArray(request.statusHistory) ? request.statusHistory : []),
    {
      changedAt: now,
      status,
      statusLabel: accountDeleteRequestStatusLabel(status),
      adminUsername: adminSession?.username || "",
      note: request.adminNote
    }
  ].slice(-30);
  await writeAccountDeleteRequestStore(store);
  return publicAccountDeleteRequestsAdminOverview();
}

function relativeDataPath(filePath = "") {
  const relative = path.relative(DATA_DIR, filePath || "");
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : path.basename(filePath || "");
}

async function securityHardeningOverview() {
  const memberStore = await readB2BMemberStore();
  const deleteOverview = await publicAccountDeleteRequestsAdminOverview();
  const members = Array.isArray(memberStore.members) ? memberStore.members : [];
  const hashedPasswords = members.filter((member) => /^pbkdf2_sha256\$\d+\$/.test(String(member.passwordHash || ""))).length;
  const weakPasswordRows = members.filter((member) => member.password && !member.passwordHash).length;
  const activeRateLimitBuckets = [...requestRateLimits.values()].filter((record) => Number(record?.resetAt || 0) > Date.now()).length;
  return {
    checkedAt: new Date().toISOString(),
    session: {
      cookieName: SESSION_COOKIE_NAME,
      httpOnly: true,
      sameSite: "Lax",
      secureInProduction: IS_PRODUCTION_RUNTIME,
      priority: "High",
      ttlHours: Math.round(SESSION_TTL_MS / 3600000),
      userAgentBound: true,
      activeSessionCount: sessions.size
    },
    passwordStorage: {
      algorithm: "pbkdf2_sha256",
      iterations: PASSWORD_HASH_ITERATIONS,
      memberCount: members.length,
      hashedCount: hashedPasswords,
      weakPlaintextCount: weakPasswordRows,
      status: weakPasswordRows ? "watch" : "ok"
    },
    requestLimits: {
      login: { limit: RATE_LIMIT_POLICIES.login.limit, minutes: Math.round(RATE_LIMIT_POLICIES.login.windowMs / 60000) },
      signup: { limit: RATE_LIMIT_POLICIES.signup.limit, minutes: Math.round(RATE_LIMIT_POLICIES.signup.windowMs / 60000) },
      signupCheck: { limit: RATE_LIMIT_POLICIES.signupCheck.limit, minutes: Math.round(RATE_LIMIT_POLICIES.signupCheck.windowMs / 60000) },
      accountDelete: { limit: RATE_LIMIT_POLICIES.accountDelete.limit, minutes: Math.round(RATE_LIMIT_POLICIES.accountDelete.windowMs / 60000) },
      b2bSearch: { limit: RATE_LIMIT_POLICIES.b2bSearch.limit, minutes: Math.round(RATE_LIMIT_POLICIES.b2bSearch.windowMs / 60000) },
      b2bInterestLodgeSave: { limit: RATE_LIMIT_POLICIES.b2bInterestLodgeSave.limit, minutes: Math.round(RATE_LIMIT_POLICIES.b2bInterestLodgeSave.windowMs / 60000) },
      adminCrawl: { limit: RATE_LIMIT_POLICIES.adminCrawl.limit, minutes: Math.round(RATE_LIMIT_POLICIES.adminCrawl.windowMs / 60000) },
      activeBucketCount: activeRateLimitBuckets
    },
    roleSeparation: {
      adminOnlyApis: [
        "/api/runs",
        "/api/crawl",
        "/api/history/summary",
        "/api/company-master/*",
        "/api/location-score-overrides",
        "/api/settings/traffic-keys",
        "/outputs/*",
        "/api/account-delete-requests"
      ],
      b2bOnlyApis: [
        "/api/b2b-search",
        "/api/b2b-search/status",
        "/api/b2b-search/cancel",
        "/api/b2b-my-lodge-collect",
        "/api/member/search-history",
        "/api/member/interest-lodges",
        "/api/member/runs/:runId"
      ],
      b2bHiddenTabs: ["dictionary", "target", "decisionQueue", "historyOps", "admin"],
      b2bRunListHidden: true,
      b2bPrivateFieldsStripped: true,
      status: "ok"
    },
    dataStorage: {
      customerDbDir: relativeDataPath(CUSTOMER_DB_DIR),
      memberDb: relativeDataPath(B2B_MEMBERS_FILE),
      searchHistoryDb: relativeDataPath(B2B_SEARCH_HISTORY_FILE),
      interestLodgeDb: relativeDataPath(B2B_INTEREST_LODGES_FILE),
      accountDeleteRequestDb: relativeDataPath(ACCOUNT_DELETE_REQUESTS_FILE),
      companyMasterDb: relativeDataPath(COMPANY_MASTER_FILE),
      locationScoreOverrideDb: relativeDataPath(LOCATION_SCORE_OVERRIDES_FILE),
      interestLodgeStorage: "고객 DB 계정 저장 + 브라우저 임시 보관",
      apiKeyStorage: relativeDataPath(TRAFFIC_KEYS_FILE)
    },
    accountDeleteLog: {
      totalCount: deleteOverview.summary?.totalCount || 0,
      openCount: deleteOverview.summary?.openCount || 0,
      completedCount: deleteOverview.summary?.completedCount || 0,
      latestRequestedAt: deleteOverview.summary?.latestRequestedAt || "",
      statusHistoryKept: true,
      storage: relativeDataPath(ACCOUNT_DELETE_REQUESTS_FILE)
    }
  };
}

function accountDeletePage(session = null, options = {}) {
  const values = accountDeletePrefill(session, options.values || {});
  const success = options.success || null;
  const error = options.error || "";
  const selected = (type) => values.requestType === type ? "selected" : "";
  const requestSummary = success ? `
    <section class="account-delete-result success">
      <strong>삭제 요청이 접수되었습니다.</strong>
      <p>요청번호 ${escapeHtml(success.requestId)} · ${escapeHtml(success.requestTypeLabel)} · 상태 ${escapeHtml(success.statusLabel)}</p>
      <p>관리자가 본인 확인과 처리 범위를 확인한 뒤 입력한 연락처로 안내합니다.</p>
    </section>
  ` : "";
  const errorSummary = error ? `
    <section class="account-delete-result error">
      <strong>접수하지 못했습니다.</strong>
      <p>${escapeHtml(error)}</p>
    </section>
  ` : "";
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>계정·데이터 삭제 요청</title>
  <style>
    :root { color-scheme: light; font-family: "Pretendard Variable", Pretendard, Arial, "Malgun Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f4f7fb; color: #101828; }
    main { width: min(100% - 32px, 920px); margin: 34px auto; display: grid; gap: 18px; }
    .hero, form, .notice, .account-delete-result { border: 1px solid #dbe4f0; border-radius: 24px; background: #fff; box-shadow: 0 18px 48px rgba(16, 24, 40, .10); padding: 26px; }
    .eyebrow { margin: 0 0 8px; color: #175cd3; font-size: 13px; font-weight: 950; }
    h1 { margin: 0; font-size: clamp(28px, 5vw, 42px); line-height: 1.12; letter-spacing: 0; }
    p { margin: 10px 0 0; color: #475467; font-size: 15px; font-weight: 750; line-height: 1.65; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
    label { display: grid; gap: 7px; min-width: 0; color: #344054; font-size: 13px; font-weight: 950; }
    input, select, textarea { width: 100%; min-height: 48px; border: 1px solid #d0d5dd; border-radius: 14px; background: #fff; color: #101828; padding: 0 14px; font: inherit; font-weight: 850; }
    textarea { min-height: 112px; padding-top: 12px; resize: vertical; }
    .full { grid-column: 1 / -1; }
    .check { display: flex; gap: 10px; align-items: flex-start; margin-top: 2px; color: #344054; font-size: 13px; font-weight: 850; line-height: 1.55; }
    .check input { width: 18px; min-width: 18px; min-height: 18px; margin-top: 2px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 16px; }
    button, .back { min-height: 48px; display: inline-grid; place-items: center; border: 0; border-radius: 14px; background: #3182f6; color: #fff; padding: 0 18px; font: inherit; font-weight: 950; text-decoration: none; cursor: pointer; }
    .back { border: 1px solid #d5e3f7; background: #eef5ff; color: #175cd3; }
    .notice ul { margin: 8px 0 0; padding-left: 20px; color: #475467; line-height: 1.7; }
    .account-delete-result.success { border-color: #a6f4c5; background: #f6fef9; }
    .account-delete-result.error { border-color: #fecdca; background: #fffbfa; }
    .account-delete-result strong { color: #101828; font-size: 18px; font-weight: 950; }
    .required { color: #d92d20; }
    @media (max-width: 680px) { main { margin-block: 18px; } .hero, form, .notice, .account-delete-result { padding: 20px; border-radius: 20px; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <p class="eyebrow">회원 권리 요청</p>
      <h1>계정·데이터 삭제 요청</h1>
      <p>계정 삭제, 검색 이력 삭제, 관심숙소 삭제, 전체 데이터 삭제를 요청할 수 있습니다. 요청은 고객 DB에 접수되고 관리자가 본인 확인 후 처리합니다.</p>
    </section>
    ${requestSummary}
    ${errorSummary}
    <form method="post" action="/account-delete">
      <div class="grid">
        <label>
          <span>아이디 <b class="required">*</b></span>
          <input name="username" value="${escapeHtml(values.username)}" autocomplete="username" required>
        </label>
        <label>
          <span>연락처 또는 이메일 <b class="required">*</b></span>
          <input name="contact" value="${escapeHtml(values.contact)}" autocomplete="email" required>
        </label>
        <label>
          <span>숙소 또는 회사명</span>
          <input name="companyName" value="${escapeHtml(values.companyName)}" autocomplete="organization">
        </label>
        <label>
          <span>요청 항목 <b class="required">*</b></span>
          <select name="requestType" required>
            <option value="account_delete" ${selected("account_delete")}>계정 삭제</option>
            <option value="search_history_delete" ${selected("search_history_delete")}>검색 이력 삭제</option>
            <option value="interest_lodge_delete" ${selected("interest_lodge_delete")}>관심숙소 삭제</option>
            <option value="all_data_delete" ${selected("all_data_delete")}>전체 데이터 삭제</option>
          </select>
        </label>
        <label class="full">
          <span>요청 상세</span>
          <textarea name="detail" placeholder="삭제 범위나 확인이 필요한 내용을 적어주세요.">${escapeHtml(values.detail)}</textarea>
        </label>
      </div>
      <label class="check">
        <input name="confirmRequest" value="1" type="checkbox" required>
        <span>삭제 요청 내용과 처리 후 일부 데이터가 복구되지 않을 수 있음을 확인했습니다.</span>
      </label>
      <div class="actions">
        <button type="submit">삭제 요청 접수</button>
        <a class="back" href="/b2b">서비스 화면으로 돌아가기</a>
      </div>
    </form>
    <section class="notice">
      <strong>처리 기준</strong>
      <ul>
        <li>요청 일시, 아이디, 연락처, 약관 버전, 처리 상태는 고객 DB에 보관합니다.</li>
        <li>법령상 보관이 필요한 결제·정산·보안 로그는 별도 보관 기간 후 삭제될 수 있습니다.</li>
        <li>처리 현황은 관리자 큐에서 접수, 본인 확인중, 처리중, 완료, 반려 상태로 관리합니다.</li>
        <li>문의: ${policyContactHtml()}</li>
      </ul>
    </section>
  </main>
</body>
</html>`;
}

function parseBooleanOption(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (/^(1|true|yes|on|allow|allowed)$/i.test(String(value || "").trim())) return true;
  if (/^(0|false|no|off|deny|denied)$/i.test(String(value || "").trim())) return false;
  return fallback;
}

async function updateB2BMemberAdminPolicy(memberId = "", payload = {}, adminSession = {}) {
  const targetId = String(memberId || payload.memberId || "").trim();
  if (!targetId) {
    const error = new Error("회원 ID가 필요합니다.");
    error.statusCode = 400;
    throw error;
  }
  const store = await readB2BMemberStore();
  const member = (store.members || []).find((item) => item.memberId === targetId);
  if (!member) {
    const error = new Error("회원을 찾을 수 없습니다.");
    error.statusCode = 404;
    throw error;
  }
  const now = new Date().toISOString();
  const nextAccountType = normalizeB2BAccountType(payload.accountType || member.accountType || "member");
  const accountTypeChanged = nextAccountType !== normalizeB2BAccountType(member.accountType || "member");
  const currentPolicy = normalizeB2BMemberPolicy(member.policy || {}, member.accountType || "member");
  const defaultPolicyForType = normalizeB2BMemberPolicy({}, nextAccountType);
  const hasDailyLimit = Object.prototype.hasOwnProperty.call(payload, "dailySearchLimit");
  const hasExpandedAllowed = Object.prototype.hasOwnProperty.call(payload, "expandedSearchAllowed");
  const nextDailyLimit = normalizeB2BMemberDailyLimit(
    hasDailyLimit ? payload.dailySearchLimit : (accountTypeChanged ? defaultPolicyForType.dailySearchLimit : currentPolicy.dailySearchLimit),
    accountTypeChanged ? defaultPolicyForType.dailySearchLimit : currentPolicy.dailySearchLimit
  );
  const nextExpandedAllowed = parseBooleanOption(
    hasExpandedAllowed ? payload.expandedSearchAllowed : (accountTypeChanged ? defaultPolicyForType.expandedSearchAllowed : currentPolicy.expandedSearchAllowed),
    accountTypeChanged ? defaultPolicyForType.expandedSearchAllowed : currentPolicy.expandedSearchAllowed
  );
  const nextStatus = Object.prototype.hasOwnProperty.call(payload, "status")
    ? normalizeB2BMemberStatus(payload.status)
    : normalizeB2BMemberStatus(member.status || "active");

  member.accountType = nextAccountType;
  member.status = nextStatus;
  member.policy = normalizeB2BMemberPolicy({
    dailySearchLimit: nextDailyLimit,
    expandedSearchAllowed: nextExpandedAllowed
  }, nextAccountType);
  member.updatedAt = now;
  member.adminPolicyHistory = [
    ...(Array.isArray(member.adminPolicyHistory) ? member.adminPolicyHistory : []),
    {
      changedAt: now,
      adminUsername: adminSession?.username || "",
      accountType: member.accountType,
      status: member.status,
      policy: member.policy
    }
  ].slice(-20);

  await writeB2BMemberStore(store);
  if (member.status === "disabled") {
    for (const [sessionId, session] of sessions.entries()) {
      if (session.memberId === member.memberId || normalizeLoginId(session.username) === normalizeLoginId(member.username)) {
        sessions.delete(sessionId);
      }
    }
  }
  return publicB2BMembersAdminOverview();
}

function completedB2BSearchReuseAllowed(payload = {}) {
  if (!B2B_COMPLETED_SEARCH_REUSE_TTL_MS) return false;
  if (payload.forceFresh || payload.disableReuse) return false;
  if (payload.recrawlContext?.type) return false;
  if (normalizeUserRole(payload.sourceRole) !== USER_ROLES.b2b) return false;
  if (String(payload.collectionSource || "") !== "b2b_search") return false;
  return normalizeSearchMode(payload.searchMode) === "keyword";
}

function b2bSearchHistoryTimeMs(entry = {}) {
  const ms = Date.parse(entry.sourceCompletedAt || entry.completedAt || entry.createdAt || "");
  return Number.isFinite(ms) ? ms : 0;
}

function comparableB2BSearchHistoryEntry(entry = {}) {
  const detailRankRanges = String(entry.detailRankRanges || "1-10").trim() || "1-10";
  const detailPlaceLimit = rankRangePlaceLimit(parseRankRanges(detailRankRanges, "1-10")) || 10;
  const bookingRangePlaceLimit = Math.max(
    Number(entry.bookingRangePlaceLimit || 0),
    detailPlaceLimit
  );
  return {
    keyword: compactKeyword(entry.keyword || "").toLowerCase(),
    checkIn: entry.checkIn || "",
    checkOut: entry.checkOut || "",
    searchMode: normalizeSearchMode(entry.searchMode || "keyword"),
    productMode: normalizeProductMode(entry.productMode || "all"),
    collectionMode: normalizeCollectionMode(entry.collectionMode || "precision"),
    detailRankRanges,
    bookingRangeDays: Number(entry.bookingRangeDays || 7),
    bookingRangePlaceLimit
  };
}

function comparableB2BSearchPayload(payload = {}) {
  return {
    keyword: compactKeyword(payload.keyword || "").toLowerCase(),
    checkIn: payload.checkIn || "",
    checkOut: payload.checkOut || "",
    searchMode: normalizeSearchMode(payload.searchMode || "keyword"),
    productMode: normalizeProductMode(payload.productMode || "all"),
    collectionMode: normalizeCollectionMode(payload.collectionMode || "precision"),
    detailRankRanges: String(payload.detailRankRanges || "1-10").trim() || "1-10",
    bookingRangeDays: Number(payload.bookingRangeDays || 7),
    bookingRangePlaceLimit: Number(payload.bookingRangePlaceLimit || 0)
  };
}

function b2bSearchHistoryMatchesPayload(entry = {}, payload = {}, signature = "") {
  if (entry.searchSignature && signature && entry.searchSignature === signature) return true;
  const left = comparableB2BSearchHistoryEntry(entry);
  const right = comparableB2BSearchPayload(payload);
  return left.keyword === right.keyword
    && left.checkIn === right.checkIn
    && left.checkOut === right.checkOut
    && left.searchMode === right.searchMode
    && left.productMode === right.productMode
    && left.collectionMode === right.collectionMode
    && left.detailRankRanges === right.detailRankRanges
    && left.bookingRangeDays === right.bookingRangeDays
    && left.bookingRangePlaceLimit === right.bookingRangePlaceLimit;
}

async function findReusableCompletedB2BSearch(crawlPayload = {}, options = {}) {
  if (!completedB2BSearchReuseAllowed(crawlPayload)) return null;
  const signature = options.signature || crawlPayloadSignature(crawlPayload);
  const now = Date.now();
  const store = await readB2BSearchHistoryStore();
  const candidates = (store.entries || [])
    .filter((entry) => entry?.status === "completed" && entry.runId)
    .map((entry) => ({ entry, completedAtMs: b2bSearchHistoryTimeMs(entry) }))
    .filter((row) => row.completedAtMs && now - row.completedAtMs <= B2B_COMPLETED_SEARCH_REUSE_TTL_MS)
    .filter((row) => b2bSearchHistoryMatchesPayload(row.entry, crawlPayload, signature))
    .sort((a, b) => b.completedAtMs - a.completedAtMs);

  for (const row of candidates) {
    if (!fs.existsSync(resolveRunDir(row.entry.runId))) continue;
    const ageSeconds = Math.max(0, Math.round((now - row.completedAtMs) / 1000));
    return {
      mode: "completed_search",
      runId: row.entry.runId,
      keyword: row.entry.keyword || crawlPayload.keyword || "",
      completedAt: new Date(row.completedAtMs).toISOString(),
      ageSeconds,
      signature,
      ttlSeconds: Math.round(B2B_COMPLETED_SEARCH_REUSE_TTL_MS / 1000)
    };
  }
  return null;
}

function completedB2BSearchReuseEstimate(base = {}, reuse = {}) {
  const seconds = 4;
  return {
    ...base,
    estimatedTotalSeconds: seconds,
    remainingSeconds: seconds,
    estimatedCompleteAt: new Date(Date.now() + seconds * 1000).toISOString(),
    estimateBasis: {
      ...(base.estimateBasis || {}),
      timing: {
        source: "recent_result",
        label: "동일 조건 최근 결과",
        sampleCount: 1,
        averageSeconds: seconds,
        ageSeconds: reuse.ageSeconds || 0,
        reusedRunId: reuse.runId || ""
      }
    },
    stages: [
      { key: "reuse_check", label: "동일 조건 확인", seconds: 1, detail: "최근 완료된 동일 조건 검색 결과를 확인합니다.", status: "active", progress: 1 },
      { key: "reuse_load", label: "결과 적용", seconds: 3, detail: "저장된 결과를 현재 화면에 맞게 불러옵니다.", status: "pending", progress: 0 }
    ],
    reuse
  };
}

async function publicCrawlEstimateForSession(payload = {}, timingStore = null, session = {}) {
  const base = publicCrawlEstimate(payload, timingStore);
  if (normalizeUserRole(session?.role) !== USER_ROLES.b2b) return base;
  let crawlPayload = null;
  try {
    crawlPayload = b2bSearchPayload(payload);
  } catch {
    return base;
  }
  const reuse = await findReusableCompletedB2BSearch(crawlPayload).catch(() => null);
  return reuse ? completedB2BSearchReuseEstimate(base, reuse) : base;
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

async function ensureB2BSearchHistory({ session, subscriber, req, payload, runId, data, crawlTiming, quotaCounted = true }) {
  const now = new Date().toISOString();
  const store = await readB2BSearchHistoryStore();
  const owner = subscriber || session || {};
  const clientRequestId = crawlQueueClientRequestId(payload.clientRequestId || subscriber?.clientRequestId);
  const existing = clientRequestId
    ? store.entries.find((entry) => entry.runId === runId
        && entry.clientRequestId === clientRequestId
        && b2bHistoryOwnerMatches(entry, owner))
    : null;
  if (existing) return publicB2BSearchHistoryEntry(existing);
  const entry = {
    id: `s_${crypto.randomBytes(9).toString("base64url")}`,
    memberId: owner?.memberId || "",
    username: owner?.username || "",
    accountType: owner?.accountType || (owner?.username === B2B_USERNAME ? "demo" : "member"),
    role: USER_ROLES.b2b,
    ipHash: owner?.ipHash || (req ? clientIpHash(req) : ""),
    sessionHash: owner?.sessionHash || (session?.id ? crypto.createHash("sha256").update(`session:${session.id}`).digest("hex") : ""),
    keyword: payload.keyword || "",
    clientRequestId,
    checkIn: payload.checkIn || "",
    checkOut: payload.checkOut || "",
    searchMode: normalizeSearchMode(payload.searchMode || "keyword"),
    productMode: normalizeProductMode(payload.productMode || "all"),
    detailRankRanges: payload.detailRankRanges || "",
    collectionMode: payload.collectionMode || "",
    collectionModeLabel: COLLECTION_MODES[payload.collectionMode] || "",
    bookingRangeDays: payload.bookingRangeDays || 0,
    bookingRangePlaceLimit: payload.bookingRangePlaceLimit || 0,
    searchSignature: crawlPayloadSignature(payload),
    runId,
    runLabel: data?.run?.label || payload.keyword || runId,
    regionLabel: data?.run?.provinceLabel || "",
    status: "completed",
    createdAt: now,
    completedAt: now,
    sourceCompletedAt: crawlTiming?.reusedCompletedAt || now,
    reuseMode: crawlTiming?.reuseMode || "",
    reusedFromRunId: crawlTiming?.reusedRunId || "",
    quotaCounted: quotaCounted !== false,
    crawlTiming: crawlTiming || null,
    resultSummary: b2bSearchResultSummary(data)
  };
  store.entries.push(entry);
  await writeB2BSearchHistoryStore(store);

  if (owner?.memberId && quotaCounted !== false) {
    const memberStore = await readB2BMemberStore();
    const member = memberStore.members.find((item) => item.memberId === owner.memberId);
    if (member) {
      member.searchCount = Number(member.searchCount || 0) + 1;
      member.updatedAt = now;
      await writeB2BMemberStore(memberStore);
    }
  }

  return publicB2BSearchHistoryEntry(entry);
}

const appendB2BSearchHistory = ensureB2BSearchHistory;

async function ensureB2BSearchHistoryForJob(job = {}, result = {}) {
  if (!result?.runId || !job?.b2bSubscribers?.size) return;
  const data = await loadRun(result.runId, { skipCompanyMaster: true, skipHistory: true, applyCompanyMaster: true });
  if (!data) return;
  for (const subscriber of job.b2bSubscribers.values()) {
    await ensureB2BSearchHistory({
      subscriber,
      payload: job.payload || {},
      runId: result.runId,
      data,
      crawlTiming: result.crawlTiming || null,
      quotaCounted: subscriber.quotaCounted !== false
    });
  }
}

function b2bSubscriberFromContext(context = {}, payload = {}) {
  const session = context.session || {};
  const clientRequestId = crawlQueueClientRequestId(payload.clientRequestId);
  if (!clientRequestId || normalizeUserRole(session.role) !== USER_ROLES.b2b) return null;
  return {
    clientRequestId,
    memberId: session.memberId || "",
    username: session.username || "",
    accountType: session.accountType || (session.username === B2B_USERNAME ? "demo" : "member"),
    role: USER_ROLES.b2b,
    ipHash: context.req ? clientIpHash(context.req) : "",
    sessionHash: session.id ? crypto.createHash("sha256").update(`session:${session.id}`).digest("hex") : "",
    quotaCounted: context.quotaCounted !== false
  };
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
    "Priority=High",
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
  if (!sessionMatchesRequest(session, req)) {
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

function createSession(username, role = USER_ROLES.admin, meta = {}, req = null) {
  cleanupSessions();
  const id = crypto.randomBytes(32).toString("base64url");
  sessions.set(id, {
    username,
    role: normalizeUserRole(role),
    memberId: meta.memberId || "",
    accountType: meta.accountType || (normalizeUserRole(role) === USER_ROLES.admin ? "master" : "member"),
    profile: meta.profile || null,
    consents: meta.consents || null,
    memberCreatedAt: meta.createdAt || "",
    lastLoginAt: meta.lastLoginAt || "",
    userAgentHash: req ? clientUserAgentHash(req) : "",
    sessionCreatedAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return id;
}

function sessionMatchesRequest(session = {}, req = null) {
  if (!session || !req) return false;
  if (!session.userAgentHash) return true;
  return session.userAgentHash === clientUserAgentHash(req);
}

function publicSession(session) {
  if (!session) {
    return { authenticated: false, username: "", role: "", roleLabel: "", memberId: "", accountType: "", profile: null, expiresAt: "" };
  }
  const role = normalizeUserRole(session.role);
  return {
    authenticated: true,
    username: session.username || "",
    role,
    roleLabel: userRoleLabel(role),
    memberId: session.memberId || "",
    accountType: session.accountType || (role === USER_ROLES.admin ? "master" : "member"),
    profile: session.profile || null,
    consents: session.consents || null,
    memberCreatedAt: session.memberCreatedAt || "",
    lastLoginAt: session.lastLoginAt || "",
    sessionCreatedAt: session.sessionCreatedAt ? new Date(session.sessionCreatedAt).toISOString() : "",
    expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : ""
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

function brandTitleHtml(text = "") {
  const escaped = escapeHtml(text || "");
  return escaped.replace(
    "숙박업 데이터랩 beta",
    '숙박업 데이터랩 <span class="brand-beta-badge">beta</span>'
  );
}

function legalPage(title, eyebrow, sections, options = {}) {
  const backHref = options.backHref || "/signup";
  const backLabel = options.backLabel || "회원가입으로 돌아가기";
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
    .brand-beta-badge { display: inline-grid; place-items: center; min-height: 24px; margin-left: 7px; padding: 0 11px; border: 1px solid rgba(49, 130, 246, .24); border-radius: 999px; background: linear-gradient(135deg, rgba(49, 130, 246, .10), rgba(20, 184, 166, .12)); color: #175cd3; font-size: 11px; font-weight: 900; line-height: 1; text-transform: uppercase; vertical-align: .16em; }
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
    <h1>${brandTitleHtml(title)}</h1>
    <p class="meta">시행일 ${PRIVACY_VERSION.replace(/-/g, ".")} · 운영자 ${escapeHtml(SERVICE_OPERATOR_NAME)}</p>
    ${rows}
    <a class="back" href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a>
  </main>
</body>
</html>`;
}

function termsPage() {
  return legalPage("숙박업 데이터랩 beta 사업자(개인) 이용약관", "필수 동의", [
    {
      title: "목적",
      body: "<p>이 약관은 숙박업 데이터랩 beta 사업자(개인) 서비스의 회원가입, 로그인, 경쟁 리포트 조회, 검색 이력 관리 및 관리자 검토 기능 이용 조건을 정합니다.</p>"
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
      body: `<p>회원은 계정 삭제, 정보 정정, 검색 이력 삭제를 운영자에게 요청할 수 있습니다. 삭제 요청은 <a href="/account-delete" target="_blank" rel="noopener">계정·데이터 삭제 요청 화면</a>에서도 접수할 수 있습니다. 문의: ${policyContactHtml()}</p>`
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
      title: "계정·데이터 삭제 절차",
      body: "<ul><li>회원은 앱 하단 또는 웹 공개 URL의 <a href=\"/account-delete\" target=\"_blank\" rel=\"noopener\">계정·데이터 삭제 요청</a> 화면에서 계정 삭제, 검색 이력 삭제, 관심숙소 삭제, 전체 데이터 삭제를 선택해 요청할 수 있습니다.</li><li>요청 시 아이디, 연락처, 요청 유형, 상세 사유, 약관·개인정보처리방침 버전, 동의 일시, 처리 상태가 고객 DB에 저장됩니다.</li><li>운영자는 본인 확인 후 접수, 확인중, 처리중, 완료, 반려 상태로 처리하며 상태 변경 이력은 삭제 요청 로그에 보관합니다.</li><li>전체 데이터 삭제는 법령상 보관이 필요한 기록과 부정 이용 방지에 필요한 최소 로그를 제외하고 처리합니다.</li></ul>"
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

function refundPolicyPage() {
  return legalPage("환불·결제·해지 정책", "결제 고지", [
    {
      title: "요금과 제공 범위",
      body: "<p>유료 서비스의 가격, 이용 기간, 수집 가능 횟수, 저장 기간, 제공 기능은 결제 화면 또는 견적서에 표시합니다. 베타 또는 테스트 계정에는 별도 결제 없이 제한된 검색 횟수와 기능 범위가 적용될 수 있습니다.</p>"
    },
    {
      title: "환불 기준",
      body: "<ul><li>서비스 제공 전 또는 수집 실행 전에는 결제 취소 또는 환불을 요청할 수 있습니다.</li><li>수집 실행, 리포트 생성, 파일 다운로드 등 디지털 결과물이 제공된 뒤에는 제공 범위에 따라 환불이 제한될 수 있습니다.</li><li>외부 플랫폼 장애 또는 접근 제한으로 일부 데이터가 누락된 경우에는 누락 범위와 대체 제공 가능성을 확인한 뒤 처리합니다.</li></ul>"
    },
    {
      title: "해지 기준",
      body: "<p>회원은 언제든지 해지를 요청할 수 있습니다. 월 구독 또는 정기 계약이 도입되는 경우 해지 적용일, 잔여 기간 처리, 데이터 보관 기간을 결제 화면 또는 계약서에 명시합니다.</p>"
    },
    {
      title: "외부 플랫폼 수집 실패 가능성",
      body: "<p>네이버, 여기어때, 야놀자/NOL, 떠나요 등 외부 플랫폼의 구조 변경, 접근 차단, 장애, 보안 정책 변경으로 일부 항목이 수집되지 않을 수 있습니다. 이 경우 서비스는 실패 항목을 별도 표시하고 가능한 대체 표본 또는 수동 확인 기준을 안내합니다.</p>"
    }
  ]);
}

function dataCollectionNoticePage() {
  return legalPage("데이터 수집 범위 고지", "운영 고지", [
    {
      title: "수집 대상",
      body: "<p>서비스는 사용자가 입력한 지역/키워드와 검색범위 기준으로 네이버 플레이스 노출, 네이버 예약 가능 여부, 공개 가격, 상품 구성, 검색량, 트렌드 지표, 보조 OTA 노출 정보를 수집·정리합니다.</p>"
    },
    {
      title: "수집 기준",
      body: "<ul><li>수집 기준일과 수집 시점은 리포트 상단에 표시합니다.</li><li>검색범위는 기본 1~10위, 확장 1~20위 등 사용자가 지정한 범위를 따릅니다.</li><li>데이유즈/캠프닉은 동일한 당일 이용 상품군으로 처리합니다.</li><li>미오픈/차단 등 총량보다 적게 확인되는 수량은 오프라인 예약 또는 운영상 차단 가능성으로 별도 해석합니다.</li></ul>"
    },
    {
      title: "수동 보완",
      body: "<p>여기어때 등 일부 채널은 자동 수집보다 수동 보완값을 우선할 수 있습니다. 관리자가 보정한 업체 고유정보는 마스터 DB에 기록되며 이후 분석의 기준값으로 활용될 수 있습니다.</p>"
    }
  ]);
}

function dataQualityNoticePage() {
  return legalPage("외부 플랫폼 데이터 한계 고지", "데이터 한계", [
    {
      title: "외부 플랫폼 기준",
      body: "<p>서비스는 네이버, 여기어때, 야놀자/NOL, 떠나요 등 외부 플랫폼의 공개 화면 또는 API 응답을 바탕으로 데이터를 해석합니다. 각 플랫폼의 내부 정렬 방식, 광고 노출, 재고 동기화 정책은 서비스가 통제하지 않습니다.</p>"
    },
    {
      title: "정확성 한계",
      body: "<ul><li>수집 결과는 특정 시점의 관측값입니다.</li><li>실제 예약 가능 여부, 오프라인 판매, 전화 예약, OTA별 재고 분리 판매는 화면 표시와 다를 수 있습니다.</li><li>매출과 예약율은 표본 기반 추정값이며 회계상 확정 매출이 아닙니다.</li></ul>"
    },
    {
      title: "활용 기준",
      body: "<p>리포트는 지역 경쟁 상태, 수요 흐름, 상품/채널 점검을 위한 참고 자료입니다. 가격 변경, 광고 집행, 투자, 입점, 영업 판단의 최종 책임은 사용자에게 있습니다.</p>"
    }
  ]);
}

function collectionFailureNoticePage() {
  return legalPage("수집 실패 가능성 고지", "운영 고지", [
    {
      title: "실패 가능 원인",
      body: "<ul><li>외부 플랫폼 구조 변경 또는 접근 제한</li><li>예약 페이지 차단, 로그인 요구, 성인/지역/기기 제한</li><li>네트워크 장애, API 장애, 서버 점검</li><li>업체명 변경, 중복 업체명, 예약 ID 미노출</li></ul>"
    },
    {
      title: "표시 방식",
      body: "<p>수집 실패 또는 누락이 발생하면 리포트와 관리자 화면에 실패 항목, 확인 필요 채널, 수동 보완 필요 여부를 표시합니다. 실패 항목은 데이터가 없다는 뜻이지 반드시 영업 또는 운영상 문제가 있다는 뜻은 아닙니다.</p>"
    },
    {
      title: "재수집과 보완",
      body: "<p>관리자는 동일 조건 재수집, 수동 보정, 보조 채널 확인으로 데이터를 보완할 수 있습니다. 단 외부 플랫폼 정책상 접근이 제한된 항목은 자동화로 보장하지 않습니다.</p>"
    }
  ]);
}

function apiRetentionPolicyPage() {
  return legalPage("관리자 API 키 및 고객 데이터 보관 정책", "보안 고지", [
    {
      title: "API 키 보관",
      body: "<p>네이버 데이터랩, 검색광고 API 키는 운영 서버의 설정 저장소에 보관합니다. 키 입력 화면은 관리자 권한으로 제한되며 화면에는 민감값을 마스킹해 표시합니다.</p>"
    },
    {
      title: "고객 데이터 보관",
      body: "<ul><li>고객 DB: 회원 계정, 검색 이력, 관심숙소, 동의 이력</li><li>마스터 DB: 관리자 보정 업체정보, 객실 수, 가격 기준, 채널 정보</li><li>히스토리: 수집 실행 이력, 트렌드 캐시, 관측 기록</li></ul>"
    },
    {
      title: "접근 통제",
      body: "<p>관리자 계정과 B2B 계정은 권한이 분리됩니다. 저장 자료, 원본 파일, 관리자 보정값, API 키 설정은 관리자 권한에서만 접근하도록 제한합니다.</p>"
    }
  ]);
}

function reportDisclaimerPage() {
  return legalPage("리포트 결과 면책 문구", "리포트 고지", [
    {
      title: "분석 결과의 성격",
      body: "<p>리포트는 외부 플랫폼 관측값, 공개 가격, 예약 가능 수량, 검색량, 내부 보정값을 조합한 참고용 분석 결과입니다. 실제 매출, 예약 완료, 광고 성과, 입점 성공, 투자 성과를 보장하지 않습니다.</p>"
    },
    {
      title: "누락 데이터",
      body: "<p>외부 플랫폼 구조 변경, 네트워크, 차단, 업체명 불일치, 예약 ID 미노출 등으로 일부 데이터가 누락될 수 있습니다. 누락/실패 데이터는 리포트 내 별도 표시를 기준으로 확인해야 합니다.</p>"
    },
    {
      title: "의사결정 책임",
      body: "<p>가격, 상품, 광고, 영업, 투자 관련 최종 의사결정은 사용자 책임입니다. 중요한 의사결정 전에는 직접 예약 화면, OTA, 전화 확인, 회계 자료 등으로 재검증해야 합니다.</p>"
    }
  ]);
}

function businessInfoPage() {
  return legalPage("사업자정보", "공개 정보", [
    {
      title: "운영자 정보",
      body: `<ul><li>서비스명: 숙박업 데이터랩 beta</li><li>상호: ${escapeHtml(SERVICE_BUSINESS_NAME)}</li><li>사업자등록번호: ${escapeHtml(SERVICE_BUSINESS_REGISTRATION_NO)}</li><li>사업장 소재지: ${escapeHtml(SERVICE_BUSINESS_ADDRESS)}</li><li>운영자: ${escapeHtml(SERVICE_OPERATOR_NAME)}</li><li>문의: ${policyContactHtml()}</li></ul>`
    },
    {
      title: "추가 확정 필요 항목",
      body: "<p>유료 공개 전 통신판매업 신고번호, 고객센터 연락처, 개인정보 보호책임자, 환불 담당 연락처를 확정해 이 페이지에 게시해야 합니다. 사업자등록증의 생년월일 등 공개가 불필요한 개인정보는 게시하지 않습니다.</p>"
    }
  ]);
}

function googlePlayDataSafetyPage() {
  return legalPage("구글플레이 Data Safety 입력용 정리", "앱 출시 점검", [
    {
      title: "기본 답변",
      body: "<ul><li>사용자 데이터 수집 여부: 예</li><li>개인정보처리방침 URL: /privacy</li><li>계정 및 데이터 삭제 요청 URL: /account-delete</li><li>전송 중 암호화: 예. 운영 URL은 HTTPS로 제공합니다.</li><li>데이터 공유: 판매 또는 광고 목적 공유 없음. 서버 호스팅, API 연동, 장애·보안 대응 등 서비스 운영에 필요한 처리만 사용합니다.</li><li>독립 보안 심사: 현재 미해당. 심사 또는 인증을 받은 뒤에만 예로 변경합니다.</li></ul>"
    },
    {
      title: "수집 데이터 유형",
      body: "<ul><li>개인 정보: 아이디, 이메일, 연락처, 선택 입력한 숙소 또는 회사명</li><li>앱 활동: 검색 키워드, 검색 기간, 순위 범위, 검색 이력, 리포트 열람·재사용 기록</li><li>기기 또는 기타 식별자: 세션 식별값, IP 해시, 브라우저 식별값 해시</li><li>사용자 콘텐츠: 관심숙소 등록 정보, 숙소명, 객실수, 객실종류, 요일별 가격, 시설 정보</li><li>위치 정보: 기기 위치는 수집하지 않습니다. 사용자가 입력한 지역명과 검색 키워드만 분석 기준으로 사용합니다.</li><li>결제 정보: 현재 앱 내부 결제 정보는 수집하지 않습니다. 유료 결제 기능 추가 시 별도 갱신해야 합니다.</li></ul>"
    },
    {
      title: "사용 목적",
      body: "<ul><li>앱 기능: 로그인, 회원 식별, 리포트 생성, 검색 이력 재사용, 관심숙소 비교</li><li>분석: 지역 경쟁 리포트 품질 개선, 검색 속도 개선, 오류 재현</li><li>보안·부정 이용 방지: 로그인 실패 제한, 검색 요청 제한, 세션 보호</li><li>고객 지원: 계정·데이터 삭제 요청, 문의 대응, 처리 상태 안내</li></ul>"
    },
    {
      title: "제출 전 확인",
      body: "<ul><li>광고 SDK, 결제 SDK, 푸시 알림, 앱 분석 SDK를 추가하면 해당 SDK의 수집 항목을 다시 반영해야 합니다.</li><li>Play Console Data Safety는 앱의 모든 배포 버전 기준으로 작성해야 하므로 TWA 패키징 전후에 최종 점검합니다.</li><li>이 페이지는 운영 초안입니다. 실제 제출 전 법무·정책 검토로 최종 문구를 확정합니다.</li></ul>"
    }
  ], { backHref: "/admin", backLabel: "관리자 화면으로 돌아가기" });
}

function accountRequestPage(session = {}) {
  const publicInfo = publicSession(session);
  const role = normalizeUserRole(session?.role);
  const accountName = publicInfo.username || "로그인 계정";
  const accountType = role === USER_ROLES.admin ? "관리자" : (publicInfo.accountType === "demo" ? "공용 테스트 계정" : "사업자 계정");
  const companyName = publicInfo.profile?.companyName || publicInfo.profile?.lodgingName || "";
  const ownerLine = [accountName, accountType, companyName].filter(Boolean).join(" · ");
  return legalPage("계정·검색 이력 삭제/정정 요청", "회원 권리 안내", [
    {
      title: "현재 요청 대상",
      body: `<p>현재 로그인 기준: <strong>${escapeHtml(ownerLine || "로그인 계정")}</strong></p><p>계정별 검색 이력, 관심숙소, 회원 정보는 로그인 아이디 기준으로 확인합니다.</p>`
    },
    {
      title: "요청 가능 항목",
      body: "<ul><li>회원 계정 삭제 또는 비활성화</li><li>연락처, 이메일, 숙소 또는 회사명 등 회원 정보 정정</li><li>내 검색 기록 삭제</li><li>관심숙소 등록 정보 삭제</li><li>개인정보 수집 및 이용 동의 철회</li></ul>"
    },
    {
      title: "요청 시 필요한 정보",
      body: "<ul><li>로그인 아이디</li><li>요청 유형: 계정 삭제, 정보 정정, 검색 이력 삭제, 관심숙소 삭제 중 선택</li><li>삭제 또는 정정할 범위</li><li>본인 확인과 처리 결과 안내를 받을 연락처</li></ul>"
    },
    {
      title: "처리 기준",
      body: "<p>운영자는 본인 확인 후 요청 범위를 확인하고 처리합니다. 법령상 보존이 필요한 정보, 보안 사고 대응에 필요한 최소 로그, 이미 비식별화된 통계성 데이터는 즉시 삭제 대상에서 제외될 수 있습니다.</p>"
    },
    {
      title: "요청 방법",
      body: `<p>운영자에게 로그인 아이디와 요청 유형을 전달하세요. 문의: ${policyContactHtml()}</p><p>처리 전 실수로 인한 데이터 손실을 막기 위해 삭제 범위는 한 번 더 확인합니다.</p>`
    }
  ], { backHref: role === USER_ROLES.admin ? "/admin" : "/b2b", backLabel: "서비스 화면으로 돌아가기" });
}

function forbiddenPage(message = "") {
  const escapedMessage = String(message || "접근 권한이 없습니다.").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>숙박업 데이터랩 beta 권한 없음</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Malgun Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); background: #f4f6f8; color: #101828; }
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
  const lockMinutes = Math.max(1, Math.ceil(LOGIN_LOCK_MS / 60000));
  const sessionHours = Math.max(1, Math.round(SESSION_TTL_MS / 3600000));
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="application-name" content="숙박업 데이터랩 beta">
  <meta name="apple-mobile-web-app-title" content="숙박업 데이터랩 beta">
  <meta name="theme-color" content="#1457c7">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
  <title>숙박업 데이터랩 beta 로그인</title>
  <style>
    :root { color-scheme: dark; font-family: "Pretendard Variable", Pretendard, Arial, "Malgun Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding:
        calc(24px + env(safe-area-inset-top))
        calc(24px + env(safe-area-inset-right))
        calc(24px + env(safe-area-inset-bottom))
        calc(24px + env(safe-area-inset-left));
      background: #070b12;
      color: #f7fbff;
    }
    main {
      width: min(100%, 920px);
      display: grid;
      grid-template-columns: minmax(0, .92fr) minmax(340px, .68fr);
      overflow: hidden;
      border: 1px solid rgba(148, 163, 184, .26);
      border-radius: 28px;
      background: #0c121d;
      box-shadow: 0 28px 80px rgba(0, 0, 0, .42);
    }
    .login-brand-panel {
      min-height: 520px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 38px;
      background:
        linear-gradient(135deg, rgba(49, 130, 246, .24), rgba(20, 184, 166, .16)),
        linear-gradient(180deg, #111c2d 0%, #0d1725 100%);
      border-right: 1px solid rgba(148, 163, 184, .18);
    }
    .login-form-panel {
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
      padding: 38px;
      background: rgba(11, 18, 29, .92);
    }
    .brand-beta-badge {
      display: inline-grid;
      place-items: center;
      min-height: 24px;
      padding: 0 12px;
      border: 1px solid rgba(94, 234, 212, .42);
      border-radius: 999px;
      background: linear-gradient(135deg, rgba(49, 130, 246, .18), rgba(20, 184, 166, .20));
      color: #dffeff;
      font-size: 11px;
      font-weight: 900;
      line-height: 1;
      text-transform: uppercase;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, .16), 0 8px 18px rgba(20, 184, 166, .12);
    }
    h1 {
      max-width: 560px;
      margin: 0;
      color: #fff;
      font-size: clamp(34px, 5vw, 54px);
      font-weight: 950;
      line-height: 1.02;
      letter-spacing: 0;
    }
    h1 .brand-beta-badge {
      margin-left: 8px;
      transform: translateY(-.18em);
      vertical-align: middle;
    }
    .brand-note {
      max-width: 420px;
      margin: 18px 0 0;
      color: #b8c4d6;
      font-size: 18px;
      font-weight: 800;
      line-height: 1.55;
    }
    .form-head { margin-bottom: 22px; }
    .form-head strong {
      display: block;
      color: #fff;
      font-size: 28px;
      font-weight: 950;
      letter-spacing: 0;
    }
    .form-head p {
      margin: 8px 0 0;
      color: #95a3b8;
      font-size: 14px;
      font-weight: 750;
      line-height: 1.5;
    }
    form { display: grid; gap: 15px; }
    label { display: grid; gap: 8px; color: #d7e1ef; font-size: 13px; font-weight: 900; }
    input {
      width: 100%;
      min-height: 54px;
      padding: 0 15px;
      border: 1px solid rgba(148, 163, 184, .26);
      border-radius: 14px;
      background: #0a111c;
      color: #f8fbff;
      font: inherit;
      font-size: 16px;
      font-weight: 800;
      outline: none;
    }
    input::placeholder { color: #64748b; }
    input:focus {
      border-color: rgba(96, 165, 250, .9);
      box-shadow: 0 0 0 4px rgba(49, 130, 246, .18);
    }
    button {
      width: 100%;
      min-height: 56px;
      margin-top: 4px;
      border: 0;
      border-radius: 15px;
      background: #3182f6;
      color: #fff;
      font: inherit;
      font-size: 17px;
      font-weight: 950;
      cursor: pointer;
      box-shadow: 0 14px 30px rgba(49, 130, 246, .28);
    }
    button:hover { background: #2f76df; }
    button:disabled { opacity: .6; cursor: wait; }
    .link { display: block; margin-top: 18px; color: #91c4ff; font-size: 13px; font-weight: 900; text-align: center; text-decoration: none; }
    .legal-links {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 10px;
      margin-top: 12px;
    }
    .legal-links a {
      color: #8ea0b8;
      font-size: 12px;
      font-weight: 850;
      text-decoration: none;
    }
    .legal-links a:hover { color: #d7e7ff; }
    .security-note {
      margin: 2px 0 0;
      color: #8ea0b8;
      font-size: 12px;
      font-weight: 750;
      line-height: 1.5;
      word-break: keep-all;
    }
    .error { min-height: 20px; color: #ff8b8b; font-size: 13px; font-weight: 900; line-height: 1.35; }
    @media (max-width: 760px) {
      body { align-items: stretch; padding: 14px; }
      main { grid-template-columns: 1fr; border-radius: 24px; }
      .login-brand-panel { min-height: auto; padding: 26px; border-right: 0; border-bottom: 1px solid rgba(148, 163, 184, .18); }
      .login-form-panel { padding: 26px; }
      h1 { font-size: 36px; }
      .brand-note { font-size: 15px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="login-brand-panel" aria-label="숙박업 데이터랩 beta">
      <div>
        <h1>${brandTitleHtml("숙박업 데이터랩 beta")}</h1>
        <p class="brand-note">운영전략을 제안해드립니다</p>
      </div>
    </section>
    <section class="login-form-panel" aria-label="로그인">
      <div class="form-head">
        <strong>로그인</strong>
        <p>계정 정보를 입력하세요.</p>
      </div>
      <form method="post" action="/login">
        <label>아이디<input name="username" autocomplete="username" autofocus required></label>
        <label>비밀번호<input name="password" type="password" autocomplete="current-password" required></label>
        <button type="submit">로그인</button>
        <p class="security-note">보안을 위해 ${LOGIN_FAILURE_LIMIT}회 이상 실패하면 ${lockMinutes}분간 로그인이 제한됩니다. 로그인 세션은 최대 ${sessionHours}시간 유지됩니다.</p>
        <div class="error">${escapedMessage}</div>
      </form>
      <a class="link" href="/signup">회원가입</a>
      <div class="legal-links" aria-label="정책 문서">
        <a href="/terms" target="_blank" rel="noopener">이용약관</a>
        <a href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a>
        <a href="/refund" target="_blank" rel="noopener">환불·결제·해지</a>
        <a href="/data-collection-notice" target="_blank" rel="noopener">데이터 수집 범위</a>
        <a href="/data-quality-notice" target="_blank" rel="noopener">데이터 수집 한계</a>
        <a href="/collection-failure-notice" target="_blank" rel="noopener">수집 실패 가능성</a>
        <a href="/business-info" target="_blank" rel="noopener">사업자정보</a>
        <a href="/account-delete" target="_blank" rel="noopener">계정·데이터 삭제 요청</a>
      </div>
    </section>
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
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="application-name" content="숙박업 데이터랩 beta">
  <meta name="apple-mobile-web-app-title" content="숙박업 데이터랩 beta">
  <meta name="theme-color" content="#1457c7">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
  <title>숙박업 데이터랩 beta 회원가입</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Malgun Gothic", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6f8; color: #101828; }
    main { width: min(100% - 32px, 640px); padding: 30px; border: 1px solid #e4e7ec; border-radius: 24px; background: #fff; box-shadow: 0 18px 48px rgba(16, 24, 40, .10); }
    .brand-kicker { display: inline-flex; align-items: center; gap: 7px; margin: 0 0 8px; color: #667085; font-size: 13px; font-weight: 900; }
    .brand-beta-badge { display: inline-grid; place-items: center; min-height: 24px; padding: 0 11px; border: 1px solid rgba(49, 130, 246, .24); border-radius: 999px; background: linear-gradient(135deg, rgba(49, 130, 246, .10), rgba(20, 184, 166, .12)); color: #175cd3; font-size: 11px; font-weight: 900; line-height: 1; text-transform: uppercase; }
    h1 { margin: 0 0 20px; font-size: 28px; font-weight: 900; letter-spacing: 0; }
    p { margin: 0 0 18px; color: #667085; line-height: 1.45; }
    form { display: grid; gap: 14px; }
    .signup-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 9px;
      margin: 0 0 18px;
    }
    .signup-summary article {
      display: grid;
      gap: 4px;
      padding: 12px;
      border: 1px solid #d5e3f7;
      border-radius: 15px;
      background: #f8fbff;
    }
    .signup-summary strong {
      color: #175cd3;
      font-size: 13px;
      font-weight: 950;
      line-height: 1.25;
    }
    .signup-summary span {
      color: #475467;
      font-size: 11px;
      font-weight: 800;
      line-height: 1.4;
      word-break: keep-all;
    }
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
    .agreement-note {
      margin: 0;
      color: #475467;
      font-size: 12px;
      font-weight: 800;
      line-height: 1.5;
      word-break: keep-all;
    }
    .check { display: grid; grid-template-columns: auto 1fr auto; align-items: start; gap: 10px; color: #182230; font-size: 13px; line-height: 1.4; }
    .check a { color: #175cd3; font-weight: 900; text-decoration: none; }
    .password-match { min-height: 18px; color: #667085; font-size: 12px; font-weight: 800; line-height: 1.35; }
    .required { color: #f04438; font-weight: 900; }
    .link { display: block; margin-top: 14px; color: #175cd3; font-size: 13px; font-weight: 900; text-align: center; text-decoration: none; }
    .legal-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 9px; margin-top: 12px; }
    .legal-links a { color: #667085; font-size: 12px; font-weight: 850; text-decoration: none; }
    .legal-links a:hover { color: #175cd3; }
    @media (max-width: 560px) {
      main { padding: 22px; }
      .grid, .signup-summary { grid-template-columns: 1fr; }
      .field-with-action { grid-template-columns: 1fr; }
      .inline-action { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <p class="brand-kicker">${brandTitleHtml("숙박업 데이터랩 beta")}</p>
    <h1>회원가입</h1>
    <p>가입하면 일반 회원 기준으로 시작하며, 검색 이력과 관심숙소는 로그인 아이디 기준으로 관리됩니다.</p>
    <div class="signup-summary" aria-label="회원가입 후 이용 기준">
      <article><strong>일반 회원</strong><span>새 리포트 하루 2회 · 기본 1~10위 검색</span></article>
      <article><strong>고객 DB</strong><span>아이디, 연락처, 이메일, 검색 이력, 동의 이력을 보관</span></article>
      <article><strong>보안 관리</strong><span>비밀번호는 해시 저장 · IP/세션 식별값은 해시로 관리</span></article>
    </div>
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
        <p class="agreement-note">필수 동의 후 고객 DB에 계정 정보, 동의 일시, 약관 버전 ${escapeHtml(TERMS_VERSION)}, 개인정보 버전 ${escapeHtml(PRIVACY_VERSION)}, 이용 이력이 저장됩니다. 업체 마스터 DB의 관리자 보정값과는 분리해 관리합니다.</p>
        <label class="check"><input type="checkbox" name="agreeTerms" value="1" required${checked("agreeTerms")}><span>(필수) 숙박업 데이터랩 beta 사업자(개인) 이용약관에 동의합니다.</span><a href="/terms" target="_blank" rel="noopener">보기</a></label>
        <label class="check"><input type="checkbox" name="agreePrivacy" value="1" required${checked("agreePrivacy")}><span>(필수) 개인정보 수집 및 이용에 동의합니다.</span><a href="/privacy" target="_blank" rel="noopener">보기</a></label>
        <label class="check"><input type="checkbox" name="agreeMarketing" value="1"${checked("agreeMarketing")}><span>(선택) 서비스 업데이트, 요금제, 운영 안내 등 마케팅 수신에 동의합니다.</span><span>선택</span></label>
        <label class="check"><input type="checkbox" name="confirmAge" value="1" required${checked("confirmAge")}><span>(필수) 만 14세 이상입니다.</span><span></span></label>
      </section>
      <p class="hint"><b class="required">*</b> 표시 항목은 필수 입력입니다.</p>
      <button type="submit">가입하고 시작</button>
      <div class="error">${escapedMessage}</div>
    </form>
    <a class="link" href="/login">이미 계정이 있습니다</a>
    <div class="legal-links" aria-label="정책 문서">
      <a href="/terms" target="_blank" rel="noopener">이용약관</a>
      <a href="/privacy" target="_blank" rel="noopener">개인정보처리방침</a>
      <a href="/refund" target="_blank" rel="noopener">환불·결제·해지</a>
      <a href="/data-collection-notice" target="_blank" rel="noopener">데이터 수집 범위</a>
      <a href="/data-quality-notice" target="_blank" rel="noopener">데이터 수집 한계</a>
      <a href="/collection-failure-notice" target="_blank" rel="noopener">수집 실패 가능성</a>
      <a href="/business-info" target="_blank" rel="noopener">사업자정보</a>
      <a href="/account-delete" target="_blank" rel="noopener">계정·데이터 삭제 요청</a>
    </div>
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

function sendLogin(res, status = 200, message = "", extraHeaders = {}) {
  return send(res, status, loginPage(message), "text/html; charset=utf-8", extraHeaders);
}

function sendRedirect(res, location) {
  return send(res, 302, "", "text/plain; charset=utf-8", { Location: location });
}

function sendHeadRedirect(res, location) {
  return sendHead(res, 302, "text/plain; charset=utf-8", { Location: location });
}

function requireLogin(req, res, reqUrl) {
  const hadSessionCookie = Boolean(parseCookies(req)[SESSION_COOKIE_NAME]);
  if (getSession(req)) return true;
  const headers = hadSessionCookie ? { "Set-Cookie": clearSessionCookie() } : {};
  const message = hadSessionCookie ? "세션이 만료되었습니다. 다시 로그인하세요." : "";
  if (req.method === "GET" && acceptsHtml(req)) {
    sendLogin(res, 200, message, headers);
  } else if (req.method === "HEAD") {
    sendHead(res, 401, "application/json; charset=utf-8", headers);
  } else {
    send(res, 401, { error: message || "로그인이 필요합니다." }, "application/json; charset=utf-8", headers);
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

function routeRolePage(req, res, reqUrl, session) {
  if (!["GET", "HEAD"].includes(req.method)) return false;
  const role = normalizeUserRole(session?.role);
  const redirect = (location) => req.method === "HEAD" ? sendHeadRedirect(res, location) : sendRedirect(res, location);
  if (["/", "/view"].includes(reqUrl.pathname)) {
    redirect(redirectPathForRole(role));
    return true;
  }
  if (reqUrl.pathname === "/admin" && role !== USER_ROLES.admin) {
    redirect("/b2b");
    return true;
  }
  if (reqUrl.pathname === "/b2b" && role !== USER_ROLES.b2b) {
    redirect("/admin");
    return true;
  }
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
  "adminRegionalOperations",
  "regionalOperations",
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
  const detailRankRanges = String(value.detailRankRanges || "1-10").trim() || "1-10";
  const detailPlaceLimit = rankRangePlaceLimit(parseRankRanges(detailRankRanges, "1-10")) || 10;
  const providedPlaceLimit = Math.max(0, Math.min(20, Math.round(Number(value.bookingRangePlaceLimit) || 0)));
  return {
    keyword,
    checkIn: value.checkIn || kstDate(0),
    checkOut: value.checkOut || kstDate(6),
    searchMode: "keyword",
    productMode: normalizeProductMode(value.productMode || "all"),
    collectionMode: normalizeCollectionMode(value.collectionMode || "precision"),
    detailRankRanges,
    bookingRangeDays: Number(value.bookingRangeDays) || 7,
    bookingRangePlaceLimit: Math.max(providedPlaceLimit, detailPlaceLimit),
    sourceRole: USER_ROLES.b2b,
    collectionSource: "b2b_search",
    clientRequestId: crawlQueueClientRequestId(value.clientRequestId)
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
    collectionSource: "b2b_search",
    clientRequestId: crawlQueueClientRequestId(value.clientRequestId)
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

function publicB2BMyLodgeVerification(item = {}) {
  const correction = item.companyManualCorrection || item.companyProfile?.manualCorrection || item.manualCorrection || {};
  if (!manualCorrectionHasValue(correction)) return {};
  const lodging = manualCorrectionLodgingBasisTotal(correction);
  const dayUse = Number(correction.dayUseBasisTotal);
  return {
    verifiedCorrectionApplied: true,
    verifiedLodgingBasisTotal: Number.isFinite(lodging) && lodging > 0 ? Math.round(lodging) : null,
    verifiedDayUseBasisTotal: Number.isFinite(dayUse) && dayUse > 0 ? Math.round(dayUse) : null,
    verifiedCorrectionLabel: "운영 검수값",
    verifiedCorrectionSource: "company_master",
    verifiedCorrectionNote: sanitizeMemberText(correction.note || "", 180),
    verifiedCorrectionUpdatedAt: sanitizeMemberText(correction.updatedAt || "", 40),
    verifiedRoomSegments: manualCorrectionRoomSegments(correction)
  };
}

async function runB2BCrawlerWithReuse(crawlPayload = {}) {
  const signature = crawlPayloadSignature(crawlPayload);
  const cached = reusableRecentCrawlResult(signature);
  if (cached) {
    return resolveCrawlJob(cached, { signature, waiterCount: 1 }, "recent_reuse");
  }

  const existing = findReusableCrawlJob(signature);
  if (existing) {
    attachCrawlJobClient(existing, crawlPayload);
    const result = await existing.promise;
    return resolveCrawlJob(result, existing, "shared");
  }

  const reuse = await findReusableCompletedB2BSearch(crawlPayload, { signature });
  if (reuse) {
    const result = {
      runId: reuse.runId,
      reuse,
      crawlTiming: {
        recorded: false,
        success: true,
        durationSeconds: 0,
        reused: true,
        reuseMode: reuse.mode,
        reusedRunId: reuse.runId,
        reusedCompletedAt: reuse.completedAt,
        ageSeconds: reuse.ageSeconds
      },
      queueStatus: {
        mode: "completed_reuse",
        signature,
        waiterCount: 1
      }
    };
    recentCrawlResults.set(signature, { createdAt: Date.now(), result });
    return result;
  }

  return runCrawler(crawlPayload);
}

function b2bSearchResultReusedCollection(result = {}) {
  const queueMode = String(result?.queueStatus?.mode || "");
  return Boolean(result?.reuse || result?.crawlTiming?.reused)
    || ["recent_reuse", "completed_reuse", "shared"].includes(queueMode);
}

async function runB2BSearch(payload = {}, context = {}) {
  const crawlPayload = b2bSearchPayload(payload);
  const signature = crawlPayloadSignature(crawlPayload);
  const completedReuse = await findReusableCompletedB2BSearch(crawlPayload, { signature }).catch(() => null);
  const sameSearchReuse = completedReuse || reusableRecentCrawlResult(signature) || findReusableCrawlJob(signature);
  await assertB2BMemberSearchPolicy(crawlPayload, context.session || {}, sameSearchReuse);
  const b2bSubscriber = b2bSubscriberFromContext({
    ...context,
    quotaCounted: !sameSearchReuse
  }, crawlPayload);
  if (b2bSubscriber) crawlPayload.b2bSubscriber = b2bSubscriber;
  const result = await runB2BCrawlerWithReuse(crawlPayload);
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
        crawlTiming: result.crawlTiming || null,
        quotaCounted: (b2bSubscriber?.quotaCounted !== false) && !b2bSearchResultReusedCollection(result)
      })
    : null;
  return {
    ok: true,
    runId,
    data: publicRunForRole(data, USER_ROLES.b2b),
    crawlTiming: result.crawlTiming || null,
    reuse: result.reuse || null,
    queueStatus: result.queueStatus || null,
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
    ...publicB2BMyLodgeVerification(candidates[index]?.item || {}),
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

const LODGING_SEARCH_SUFFIXES = [
  "글램핑장",
  "오토캠핑장",
  "캠핑장",
  "야영장",
  "풀빌라",
  "카라반",
  "글램핑",
  "펜션",
  "리조트",
  "호텔",
  "모텔",
  "캠핑",
  "스테이",
  "숙소"
];

function lodgingSearchSuffix(keyword = "") {
  const compact = compactKeyword(keyword);
  return LODGING_SEARCH_SUFFIXES.find((suffix) => compact.endsWith(suffix)) || "";
}

function lodgingSearchSuffixInKeyword(keyword = "") {
  const compact = compactKeyword(keyword);
  return LODGING_SEARCH_SUFFIXES.find((suffix) => compact.includes(suffix)) || "";
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
  return lodgingSearchSuffix(compact) ? compact : `${compact}글램핑`;
}

function uniqueTexts(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function spacedLodgingKeyword(keyword = "") {
  const compact = compactKeyword(keyword);
  const suffix = lodgingSearchSuffix(compact);
  if (!compact || !suffix) return compact;
  const prefix = compact.slice(0, -suffix.length);
  return prefix ? `${prefix} ${suffix}` : compact;
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
    spacedLodgingKeyword(compact)
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
  const suffix = lodgingSearchSuffixInKeyword(compact) || "글램핑";
  if (regionName && compact.includes(regionName)) return normalizeSearchKeyword(compact);
  return normalizeSearchKeyword(compact || `${regionName}${suffix}`);
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

function summarizeRegionalRows(rows, provinceKey, fallbackKeyword = "") {
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
      trafficKeywordForRegion(row["검색키워드"] || row["기준키워드"] || fallbackKeyword || `${region}글램핑`, region)
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
      trafficKeyword: normalizeSearchKeyword(topRawKey(item.keywordBuckets) || fallbackKeyword || `${item.region}글램핑`),
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

function jsonArrayFromFileReference(text = "", baseDir = "") {
  if (!baseDir || !String(text || "").startsWith("@json-file:")) return [];
  const relativePath = String(text || "").replace(/^@json-file:/, "").trim();
  if (!relativePath) return [];
  const filePath = safeJoin(baseDir, relativePath);
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonArrayField(row, keys, baseDir = "") {
  for (const key of keys) {
    const value = row[key];
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) return value;
    const text = String(value || "").trim();
    if (!text) continue;
    if (text.startsWith("@json-file:")) {
      const fromFile = jsonArrayFromFileReference(text, baseDir);
      if (fromFile.length) return fromFile;
      continue;
    }
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

function resolveBookingRangePlaceLimit(value, bookingRangeDays, fallbackLimit = 10) {
  const text = String(value ?? "").trim();
  const fallback = Math.max(0, Math.min(20, Math.floor(Number(fallbackLimit) || 0)));
  if (!text) return Number(bookingRangeDays) > 1 ? fallback : 0;
  const number = Number(text);
  if (!Number.isFinite(number)) return Number(bookingRangeDays) > 1 ? fallback : 0;
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
  const note = String(correction.note || "").trim();
  return manualCorrectionHasBasis(correction)
    || manualCorrectionRoomSegments(correction).length > 0
    || manualCorrectionMetaHasValue(correction)
    || note.length > 0;
}

function manualCorrectionHasBasis(correction = {}) {
  if (!correction || correction.active === false) return false;
  const lodging = manualCorrectionLodgingBasisTotal(correction);
  const dayUse = Number(correction.dayUseBasisTotal);
  return lodging > 0
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

function naverCouponDisplayNames(value = "") {
  const generic = new Set([
    "네이버",
    "네이버 상품",
    "상품",
    "일정",
    "숙박상품",
    "데이유즈상품",
    "숙박일정",
    "데이유즈일정",
    "예약페이지"
  ]);
  return [...new Set(String(value || "")
    .split(/\s*(?:·|ㆍ|\||,|\n|\r)\s*/)
    .map((part) => part.trim())
    .filter((part) => {
      if (!part || generic.has(part)) return false;
      if (/^근거\s*/.test(part)) return false;
      if (/^네이버\s*공개\s*노출\s*쿠폰/.test(part)) return false;
      return true;
    }))]
    .slice(0, 5)
    .join(" · ");
}

function naverCouponSignalFromItem(item = {}) {
  const status = String(item.naverCouponStatus || item["네이버쿠폰노출상태"] || "").trim();
  const rawNames = String(item.naverCouponNames || item["네이버쿠폰명"] || "").trim();
  const names = naverCouponDisplayNames(rawNames);
  const channel = String(item.naverCouponChannel || item["네이버쿠폰확인채널"] || "").trim();
  const detail = String(item.naverCouponDetail || item["네이버쿠폰상세"] || "").trim();
  const visible = /^(?:있음|노출|exposed|visible|yes|true)$/i.test(status) || Boolean(names);
  return {
    visible,
    named: Boolean(names),
    status: status || (visible ? "있음" : ""),
    names,
    rawNames,
    channel: channel || (visible ? "네이버" : ""),
    detail: detail || (visible ? (names ? `네이버 공개 노출 쿠폰: ${names}` : "네이버 쿠폰 노출 신호 확인 · 쿠폰명 미확인") : "")
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
    duplicateResolutions: {},
    regionReviews: {},
    regionReviewHistory: []
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
      duplicateResolutions: parsed.duplicateResolutions || {},
      regionReviews: parsed.regionReviews || {},
      regionReviewHistory: Array.isArray(parsed.regionReviewHistory) ? parsed.regionReviewHistory : []
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
  const lodgingBasisTotal = manualCorrectionLodgingBasisTotal(correction);
  const dayUseBasisTotal = Number(correction.dayUseBasisTotal);
  const dayUseBasis = Number.isFinite(dayUseBasisTotal) && dayUseBasisTotal > 0 ? Math.round(dayUseBasisTotal) : 0;
  const lodging = applyManualBasisToSalesSummary(signal.lodging || {}, lodgingBasisTotal);
  const dayUse = applyManualBasisToSalesSummary(signal.dayUse || {}, dayUseBasis);
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
      lodgingBasisTotal: lodgingBasisTotal || null,
      dayUseBasisTotal: dayUseBasis || null,
      roomSegments: manualCorrectionRoomSegments(correction),
      ...sanitizeManualCorrectionMeta(correction),
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
        lodgingBasisTotal: manualCorrectionLodgingBasisTotal(correction) || null,
        dayUseBasisTotal: correction.dayUseBasisTotal || null,
        roomSegments: manualCorrectionRoomSegments(correction),
        ...sanitizeManualCorrectionMeta(correction),
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

function companyRegionsWithManualCorrection(company = {}) {
  const regions = Array.isArray(company.regions) ? company.regions : [];
  const override = sanitizeManualCorrectionMeta(company.manualCorrection || {}).regionOverride;
  if (!override) return regions;
  const overrideKey = normalizeCompanyIdentityName(override);
  return [
    override,
    ...regions.filter((region) => normalizeCompanyIdentityName(region) !== overrideKey)
  ];
}

function companyCorrectionStatus(company = {}, inventory = null) {
  const correction = company.manualCorrection;
  const latest = (inventory || company.inventory || {}).latest || {};
  if (manualCorrectionHasValue(correction)) {
    const parts = [];
    const lodgingBasisTotal = manualCorrectionLodgingBasisTotal(correction);
    const roomSegmentCount = manualCorrectionRoomSegments(correction).length;
    const meta = sanitizeManualCorrectionMeta(correction);
    if (lodgingBasisTotal) parts.push(`숙박 운영 ${lodgingBasisTotal}개`);
    if (correction.dayUseBasisTotal) parts.push(`데이유즈 운영 ${correction.dayUseBasisTotal}회`);
    if (roomSegmentCount) parts.push(`객실종류 ${roomSegmentCount}개`);
    if (meta.regionOverride) parts.push(`지역 ${meta.regionOverride}`);
    if (meta.channelNote) parts.push("채널 확인");
    if (meta.couponNote) parts.push("쿠폰 확인");
    return {
      key: "admin_override",
      label: "관리자 보정",
      detail: parts.join(" · ") || "보정 기준 저장",
      note: [correction.note, meta.channelNote, meta.couponNote].filter(Boolean).join(" · ") || "관리자 보정값 기준",
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
  const regions = companyRegionsWithManualCorrection(company);
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
    regions,
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

function adminRegionClassification(value = "") {
  const rawLabel = String(value || "").trim();
  const normalizedKey = normalizeAdminRegionName(rawLabel);
  const directGroup = ADMIN_REGION_GROUPS[normalizedKey];
  if (directGroup) {
    return {
      regionKey: normalizedKey,
      regionLabel: directGroup.label,
      provinceKey: normalizedKey,
      provinceLabel: directGroup.label,
      localityKey: "",
      localityLabel: "",
      level: "province"
    };
  }

  for (const [provinceKey, group] of Object.entries(ADMIN_REGION_GROUPS)) {
    if (adminRegionContains(provinceKey, rawLabel)) {
      const localityKey = adminRegionToken(rawLabel) || normalizedKey || "unknown";
      return {
        regionKey: `${provinceKey}:${localityKey}`,
        regionLabel: rawLabel || group.label,
        provinceKey,
        provinceLabel: group.label,
        localityKey,
        localityLabel: rawLabel,
        level: "local"
      };
    }
  }

  const fallbackKey = normalizedKey || adminRegionToken(rawLabel) || "unknown";
  return {
    regionKey: fallbackKey,
    regionLabel: rawLabel || "지역 미확인",
    provinceKey: "unknown",
    provinceLabel: "기타",
    localityKey: fallbackKey === "unknown" ? "" : fallbackKey,
    localityLabel: rawLabel,
    level: "unknown"
  };
}

function regionOpsEntityKey(item = {}) {
  return [
    item.companyId ? `company:${item.companyId}` : "",
    item.sourceKey || "",
    item.placeId ? `place:${item.placeId}` : "",
    item.place_id ? `place:${item.place_id}` : "",
    item.bookingBusinessId ? `booking:${item.bookingBusinessId}` : "",
    item.name ? `name:${compactKeyword(item.name)}:${compactKeyword(item.address || item.region || item.addressRegion || "")}` : ""
  ].find(Boolean) || `row:${stableHash(JSON.stringify({
    name: item.name || "",
    region: item.region || item.addressRegion || "",
    rank: item.rank || ""
  }))}`;
}

function regionOpsItemName(item = {}) {
  return String(item.name || item.primaryName || item.companyProfile?.primaryName || "").trim();
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function regionOpsRevenueValue(item = {}) {
  const lodging = firstPositiveNumber(
    item.weeklyAdjustedRevenue,
    item.basisLodgingAdjustedRevenue,
    item.weeklyEstimatedRevenue,
    item.basisLodgingRevenue,
    item.companyProfile?.inventory?.latest?.revenue?.lodging?.adjustedRevenue,
    item.companyProfile?.inventory?.latest?.revenue?.lodging?.revenue
  );
  const dayUse = firstPositiveNumber(
    item.dayUseWeeklyAdjustedRevenue,
    item.basisDayUseAdjustedRevenue,
    item.dayUseWeeklyEstimatedRevenue,
    item.basisDayUseRevenue,
    item.companyProfile?.inventory?.latest?.revenue?.dayUse?.adjustedRevenue,
    item.companyProfile?.inventory?.latest?.revenue?.dayUse?.revenue
  );
  return lodging + dayUse;
}

function regionOpsReservationRate(item = {}) {
  const sold = firstPositiveNumber(item.weeklyTotalSoldOut, item.soldOutRooms);
  const total = firstPositiveNumber(item.weeklyTotalStock, item.weeklyBasisTotal, item.totalRooms);
  if (total > 0) return Number((sold / total).toFixed(4));
  const average = Number(item.weeklyAvgReservationRate ?? item.companyProfile?.inventory?.latest?.salesSignal?.lodging?.averageRate);
  return Number.isFinite(average) ? Number(average.toFixed(4)) : null;
}

function regionOpsHasReservationSample(item = {}) {
  return firstPositiveNumber(item.weeklyTotalStock, item.weeklyBasisTotal, item.totalRooms) > 0
    || Number.isFinite(Number(item.weeklyAvgReservationRate))
    || Number.isFinite(Number(item.companyProfile?.inventory?.latest?.salesSignal?.lodging?.averageRate));
}

function regionOpsInventoryFlags(item = {}) {
  return boundedUnique([
    ...(Array.isArray(item.inventoryStructureFlags) ? item.inventoryStructureFlags : []),
    ...(Array.isArray(item.companyProfile?.inventory?.latest?.structureFlags) ? item.companyProfile.inventory.latest.structureFlags : []),
    ...(Array.isArray(item.companyProfile?.inventory?.latest?.salesSignal?.structureFlags) ? item.companyProfile.inventory.latest.salesSignal.structureFlags : [])
  ], 20);
}

function regionOpsConfidenceGrade(item = {}) {
  return String(
    item.inventoryConfidenceGrade
    || item.companyProfile?.inventory?.latest?.confidenceGrade
    || item.companyProfile?.inventory?.latest?.inventoryConfidenceGrade
    || ""
  ).toUpperCase();
}

function regionOpsActualRegionText(item = {}) {
  return String(
    item.addressRegion
    || addressRegionFromAddress(item.address || "")
    || item.region
    || item.companyProfile?.regions?.[0]
    || item.searchRegion
    || ""
  ).trim();
}

function regionOpsSearchRegionText(item = {}, run = {}) {
  return String(item.searchRegion || item.searchCluster || run.provinceLabel || "").trim();
}

function createRegionalOpsBucket(classification = {}) {
  return {
    regionKey: classification.regionKey,
    regionLabel: classification.regionLabel,
    provinceKey: classification.provinceKey,
    provinceLabel: classification.provinceLabel,
    localityKey: classification.localityKey,
    localityLabel: classification.localityLabel,
    level: classification.level,
    companyKeys: new Set(),
    companyNames: new Set(),
    companyCount: 0,
    exposureCount: 0,
    inRegionExposureCount: 0,
    outsideExposureCount: 0,
    reservationSampleCount: 0,
    revenueSampleCount: 0,
    revenueTotal: 0,
    lowConfidenceCount: 0,
    stockVarianceCount: 0,
    offlineReservationCount: 0,
    structuralBlockedCount: 0,
    manualCorrectionCount: 0,
    adminReviewCount: 0,
    reviewStatusCounts: {},
    couponVisibleCount: 0,
    bestRank: null,
    reservationRateSum: 0,
    reservationRateCount: 0,
    sampleCompanies: []
  };
}

function regionalOpsMaintenanceProfile(bucket = {}, status = {}) {
  const companyCount = Number(bucket.companyCount || bucket.companyKeys?.size || 0);
  const reservationGap = Math.max(0, 5 - Number(bucket.reservationSampleCount || 0));
  const revenueGap = Math.max(0, 3 - Number(bucket.revenueSampleCount || 0));
  const reviewGap = Math.max(0, Math.min(companyCount, 5) - Number(bucket.adminReviewCount || 0));
  const riskCount = Number(bucket.lowConfidenceCount || 0)
    + Number(bucket.stockVarianceCount || 0)
    + Number(bucket.structuralBlockedCount || 0)
    + Number(bucket.outsideExposureCount || 0);
  const sampleScore = Math.min(42, Number(bucket.reservationSampleCount || 0) * 4 + Number(bucket.revenueSampleCount || 0) * 5);
  const reviewScore = Math.min(22, Number(bucket.adminReviewCount || 0) * 3 + Number(bucket.manualCorrectionCount || 0) * 5);
  const scaleScore = Math.min(14, companyCount * 1.4);
  const riskPenalty = Math.min(44,
    Number(bucket.lowConfidenceCount || 0) * 7
    + Number(bucket.stockVarianceCount || 0) * 6
    + Number(bucket.structuralBlockedCount || 0) * 5
    + Number(bucket.outsideExposureCount || 0) * 2
  );
  const readinessScore = Math.max(0, Math.min(100, Math.round(32 + sampleScore + reviewScore + scaleScore - riskPenalty)));
  const actions = [];
  const addAction = (key, label, detail, priority, tone = "watch") => {
    actions.push({ key, label, detail, priority, tone });
  };

  if (reservationGap > 0) {
    addAction("reservation_sample", "예약 표본 보강", `네이버 예약 기준 ${reservationGap}곳 이상 추가 확인`, 96, "hot");
  }
  if (revenueGap > 0) {
    addAction("revenue_sample", "매출 표본 보강", `가격/판매 기준 ${revenueGap}곳 이상 보강`, 92, "hot");
  }
  if (bucket.lowConfidenceCount) {
    addAction("quantity_correction", "수량 신뢰도 보정", `수량 신뢰도 낮은 업체 ${bucket.lowConfidenceCount}곳`, 86, "watch");
  }
  if (bucket.stockVarianceCount) {
    addAction("capacity_review", "총량 변동 검토", `날짜별 총량 변동 ${bucket.stockVarianceCount}곳`, 82, "watch");
  }
  if (bucket.structuralBlockedCount) {
    addAction("maintenance_check", "미오픈/차단 확인", `오프라인 예약 또는 운영 차단 의심 ${bucket.structuralBlockedCount}곳`, 76, "watch");
  }
  if (bucket.outsideExposureCount) {
    addAction("boundary_check", "검색권 경계 확인", `지역 밖 노출 ${bucket.outsideExposureCount}곳`, 66, "neutral");
  }
  if (reviewGap > 0) {
    addAction("admin_review", "관리자 사전 검수", `상위 표본 ${reviewGap}곳 추가 판단`, 62, "neutral");
  }
  if (!actions.length) {
    addAction("weekly_maintenance", "주간 유지 점검", "주 1회 표본 유지와 신규 노출 업체만 확인", 30, "good");
  }
  actions.sort((a, b) => b.priority - a.priority);

  let preflightStatus = { key: "blocked", label: "공개 보류", tone: "hot" };
  if (readinessScore >= 82 && reservationGap === 0 && revenueGap === 0 && riskCount === 0) {
    preflightStatus = { key: "ready", label: "공개 준비", tone: "good" };
  } else if (readinessScore >= 68 && reservationGap === 0 && revenueGap === 0) {
    preflightStatus = { key: "review", label: "검수 후 공개", tone: "watch" };
  } else if (readinessScore >= 50) {
    preflightStatus = { key: "sample_needed", label: "표본 보강", tone: "watch" };
  }

  const maintenancePriority = Math.max(0, Math.min(100, Math.round(
    100 - readinessScore
    + reservationGap * 9
    + revenueGap * 10
    + Number(bucket.lowConfidenceCount || 0) * 5
    + Number(bucket.stockVarianceCount || 0) * 4
    + Number(bucket.structuralBlockedCount || 0) * 3
  )));
  const nextCycle = maintenancePriority >= 80
    ? "즉시 보강"
    : (maintenancePriority >= 58 ? "이번 주 검수" : (preflightStatus.key === "ready" ? "주 1회 유지" : "3일 내 재확인"));

  return {
    readinessScore,
    preflightStatus,
    maintenancePriority,
    nextCycle,
    primaryAction: actions[0] || null,
    actions: actions.slice(0, 6),
    coverage: {
      reservationSampleGoal: 5,
      reservationSampleGap: reservationGap,
      revenueSampleGoal: 3,
      revenueSampleGap: revenueGap,
      adminReviewGoal: Math.min(companyCount, 5),
      adminReviewGap: reviewGap,
      riskCount,
      publicStatus: status.key || ""
    }
  };
}

function regionalOpsStatus(bucket = {}) {
  const sampleScore = Math.min(40, (bucket.reservationSampleCount * 3) + (bucket.revenueSampleCount * 4) + (bucket.companyCount * 1.5));
  const correctionScore = Math.min(12, bucket.manualCorrectionCount * 3);
  const riskPenalty = Math.min(35, (bucket.lowConfidenceCount * 5) + (bucket.stockVarianceCount * 4) + (bucket.outsideExposureCount * 2));
  const score = Math.max(0, Math.min(100, Math.round(45 + sampleScore + correctionScore - riskPenalty)));
  if (score >= 78 && bucket.reservationSampleCount >= 5 && bucket.revenueSampleCount >= 3) {
    return { key: "public_ready", label: "공개 가능", score };
  }
  if (score >= 58) return { key: "review_needed", label: "검수 필요", score };
  return { key: "collect_needed", label: "수집 보강", score };
}

function finalizeRegionalOpsBucket(bucket = {}) {
  const status = regionalOpsStatus(bucket);
  const maintenance = regionalOpsMaintenanceProfile(bucket, status);
  const averageRevenue = bucket.revenueSampleCount ? Math.round(bucket.revenueTotal / bucket.revenueSampleCount) : 0;
  const averageReservationRate = bucket.reservationRateCount
    ? Number((bucket.reservationRateSum / bucket.reservationRateCount).toFixed(4))
    : null;
  const reviewReasons = [
    bucket.lowConfidenceCount ? `수량 신뢰도 낮음 ${bucket.lowConfidenceCount}곳` : "",
    bucket.stockVarianceCount ? `총량 변동 ${bucket.stockVarianceCount}곳` : "",
    bucket.outsideExposureCount ? `지역 밖 노출 ${bucket.outsideExposureCount}곳` : "",
    bucket.structuralBlockedCount ? `메인터넌스/차단 의심 ${bucket.structuralBlockedCount}곳` : "",
    bucket.reservationSampleCount < 5 ? "예약 표본 보강 필요" : "",
    bucket.revenueSampleCount < 3 ? "매출 표본 보강 필요" : ""
  ].filter(Boolean);
  return {
    regionKey: bucket.regionKey,
    regionLabel: bucket.regionLabel,
    provinceKey: bucket.provinceKey,
    provinceLabel: bucket.provinceLabel,
    localityKey: bucket.localityKey,
    localityLabel: bucket.localityLabel,
    level: bucket.level,
    companyCount: bucket.companyCount,
    exposureCount: bucket.exposureCount,
    inRegionExposureCount: bucket.inRegionExposureCount,
    outsideExposureCount: bucket.outsideExposureCount,
    reservationSampleCount: bucket.reservationSampleCount,
    revenueSampleCount: bucket.revenueSampleCount,
    revenueTotal: bucket.revenueTotal,
    averageRevenue,
    averageReservationRate,
    lowConfidenceCount: bucket.lowConfidenceCount,
    stockVarianceCount: bucket.stockVarianceCount,
    offlineReservationCount: bucket.offlineReservationCount,
    structuralBlockedCount: bucket.structuralBlockedCount,
    manualCorrectionCount: bucket.manualCorrectionCount,
    adminReviewCount: bucket.adminReviewCount,
    reviewStatusCounts: bucket.reviewStatusCounts,
    couponVisibleCount: bucket.couponVisibleCount,
    bestRank: bucket.bestRank,
    status,
    preflight: {
      status: maintenance.preflightStatus,
      readinessScore: maintenance.readinessScore,
      coverage: maintenance.coverage
    },
    maintenance,
    reviewReasons,
    sampleCompanies: bucket.sampleCompanies.slice(0, 8)
  };
}

function adminRegionReviewMeta(status = "") {
  return {
    public_ready: { label: "공개 가능", tone: "good", statusKey: "public_ready", scoreFloor: 82, nextCycle: "주 1회 유지" },
    review_needed: { label: "검수 후 공개", tone: "watch", statusKey: "review_needed", scoreFloor: 68, nextCycle: "이번 주 검수" },
    collect_needed: { label: "보강 필요", tone: "hot", statusKey: "collect_needed", scoreCap: 58, nextCycle: "즉시 보강" },
    hold: { label: "보류", tone: "hot", statusKey: "collect_needed", scoreCap: 50, nextCycle: "보류 사유 재검토" }
  }[String(status || "").trim()] || null;
}

function regionReviewKey(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}:_-]+/gu, "")
    .trim()
    .slice(0, 120);
}

function applyAdminRegionReviewsToOperations(ops = {}, master = {}) {
  const reviews = master.regionReviews || {};
  const histories = Array.isArray(master.regionReviewHistory) ? master.regionReviewHistory : [];
  const reviewValues = Object.values(reviews || {}).filter(Boolean);
  const regionLookupKeys = (region = {}) => {
    return [
      region.regionKey,
      regionReviewKey(region.regionLabel),
      regionReviewKey(`${region.provinceKey || ""}:${region.localityKey || ""}`),
      regionReviewKey(`${region.provinceLabel || ""}:${region.regionLabel || ""}`),
      regionReviewKey(`${region.provinceLabel || ""}:${region.localityLabel || ""}`)
    ].filter(Boolean);
  };
  const reviewFor = (region = {}) => {
    const keys = regionLookupKeys(region);
    const direct = keys.map((key) => reviews[key]).find(Boolean);
    if (direct) return direct;
    const labelKey = regionReviewKey(region.regionLabel);
    const provinceLabelKey = regionReviewKey(`${region.provinceLabel || ""}:${region.regionLabel || ""}`);
    return reviewValues.find((review) => {
      const reviewKeys = [
        review.regionKey,
        regionReviewKey(review.regionLabel),
        regionReviewKey(`${review.provinceLabel || ""}:${review.regionLabel || ""}`)
      ].filter(Boolean);
      return reviewKeys.some((key) => keys.includes(key))
        || (labelKey && reviewKeys.includes(labelKey))
        || (provinceLabelKey && reviewKeys.includes(provinceLabelKey));
    }) || null;
  };
  const regions = (ops.regions || []).map((region) => {
    const review = reviewFor(region);
    const historyKeys = regionLookupKeys(region);
    const regionHistory = histories
      .filter((row) => {
        const rowKeys = [
          row.regionKey,
          regionReviewKey(row.regionLabel),
          regionReviewKey(`${row.provinceLabel || ""}:${row.regionLabel || ""}`)
        ].filter(Boolean);
        return rowKeys.some((key) => historyKeys.includes(key));
      })
      .slice(-20);
    if (!review) return regionHistory.length ? { ...region, adminReviewHistory: regionHistory } : region;
    const meta = adminRegionReviewMeta(review.status);
    const score = Number(region.status?.score || 0);
    const nextScore = meta?.scoreFloor ? Math.max(score, meta.scoreFloor) : (meta?.scoreCap ? Math.min(score, meta.scoreCap) : score);
    const nextStatus = meta ? {
      ...(region.status || {}),
      key: meta.statusKey,
      label: meta.label,
      score: nextScore,
      adminOverride: true
    } : region.status;
    const nextMaintenance = {
      ...(region.maintenance || {}),
      preflightStatus: meta ? { key: review.status, label: meta.label, tone: meta.tone, adminOverride: true } : region.maintenance?.preflightStatus,
      nextCycle: meta?.nextCycle || region.maintenance?.nextCycle,
      adminReview: review
    };
    return {
      ...region,
      status: nextStatus,
      preflight: {
        ...(region.preflight || {}),
        status: meta ? { key: review.status, label: meta.label, tone: meta.tone, adminOverride: true } : region.preflight?.status,
        readinessScore: Math.max(Number(region.preflight?.readinessScore || 0), meta?.scoreFloor || 0)
      },
      maintenance: nextMaintenance,
      adminReview: review,
      adminReviewHistory: regionHistory
    };
  });
  const summary = { ...(ops.summary || {}) };
  summary.regionReviewCount = Object.keys(reviews).length;
  summary.adminPublicReadyRegionCount = regions.filter((region) => region.adminReview?.status === "public_ready").length;
  summary.adminReviewNeededRegionCount = regions.filter((region) => region.adminReview?.status === "review_needed").length;
  summary.adminCollectNeededRegionCount = regions.filter((region) => ["collect_needed", "hold"].includes(region.adminReview?.status)).length;
  summary.preflightReadyRegionCount = Math.max(Number(summary.preflightReadyRegionCount || 0), summary.adminPublicReadyRegionCount);
  summary.publicReadyRegionCount = Math.max(Number(summary.publicReadyRegionCount || 0), summary.adminPublicReadyRegionCount);
  return { ...ops, regions, summary };
}

function b2bRegionKeywordBases(value = "") {
  const raw = String(value || "").normalize("NFKC").trim();
  const compact = compactKeyword(raw);
  const stripped = compact
    .replace(/(글램핑장|글램핑|풀빌라|펜션|캠핑장|야영장|카라반|캠핑|숙소|리조트|호텔|모텔|민박)$/u, "")
    .trim();
  return [...new Set([raw, compact, stripped].filter((item) => item && item.length >= 2))];
}

function publicB2BRegionReviewCopy(review = null) {
  const status = String(review?.status || "").trim();
  if (!status) return null;
  const map = {
    public_ready: {
      status: "verified",
      label: "지역 기준 확인",
      tone: "good",
      headline: "사전 확인된 지역 기준으로 입지와 경쟁권을 해석합니다.",
      summary: "지역카드와 주요 표본 기준이 확인된 상태입니다. 예약율, 매출 표본, 검색수요를 함께 비교해도 되는 기준입니다.",
      sourceLabel: "확인된 지역 기준"
    },
    review_needed: {
      status: "review_needed",
      label: "기준 검토 중",
      tone: "watch",
      headline: "지역 기준은 연결됐지만 일부 표본 확인이 남아 있습니다.",
      summary: "입지 점수는 참고할 수 있으나, 예약율·매출 표본을 함께 보고 보수적으로 판단하는 것이 좋습니다.",
      sourceLabel: "검토 중인 지역 기준"
    },
    collect_needed: {
      status: "limited",
      label: "기준 보강 중",
      tone: "hot",
      headline: "지역 기준 보강이 필요한 상태입니다.",
      summary: "현재 입지 해석은 참고용입니다. 표본이 더 쌓인 뒤 예약율과 매출 비교를 다시 확인하세요.",
      sourceLabel: "보강 중인 지역 기준"
    },
    hold: {
      status: "limited",
      label: "기준 보류",
      tone: "hot",
      headline: "현재 지역 기준은 공개 판단을 보류한 상태입니다.",
      summary: "입지 점수보다 실제 예약율, 매출 표본, 노출 순위를 우선 확인하세요.",
      sourceLabel: "보류된 지역 기준"
    }
  };
  const copy = map[status];
  if (!copy) return null;
  return {
    ...copy,
    regionKey: regionReviewKey(review.regionKey),
    regionLabel: sanitizeMemberText(review.regionLabel, 80),
    provinceLabel: sanitizeMemberText(review.provinceLabel, 80),
    updatedAt: review.updatedAt || ""
  };
}

function publicB2BRegionReviewSummary(data = {}, master = {}) {
  const baseOps = data.adminRegionalOperations || buildRunRegionalOperations(data, new Date().toISOString());
  const ops = applyAdminRegionReviewsToOperations(baseOps, master);
  const reviewedRegions = (ops.regions || []).filter((region) => region.adminReview?.status);
  if (!reviewedRegions.length) return null;
  const run = data.run || {};
  const searchLabels = [
    run.keyword,
    run.label,
    ...(data.regions || []).map((region) => region.region || region.name || "")
  ].flatMap(b2bRegionKeywordBases);
  const candidateKeys = new Set();
  for (const label of searchLabels) {
    const classified = adminRegionClassification(label);
    [
      classified.regionKey,
      regionReviewKey(classified.regionLabel),
      regionReviewKey(`${classified.provinceLabel || ""}:${classified.regionLabel || ""}`),
      regionReviewKey(label)
    ].filter(Boolean).forEach((key) => candidateKeys.add(key));
  }
  const matched = reviewedRegions.find((region) => {
    const keys = [
      region.regionKey,
      regionReviewKey(region.regionLabel),
      regionReviewKey(`${region.provinceLabel || ""}:${region.regionLabel || ""}`)
    ].filter(Boolean);
    return keys.some((key) => candidateKeys.has(key));
  }) || reviewedRegions.find((region) => region.adminReview?.status === "public_ready") || reviewedRegions[0];
  const reviewCopy = publicB2BRegionReviewCopy(matched.adminReview);
  if (!reviewCopy) return null;
  return {
    ...reviewCopy,
    sampleRegionCount: reviewedRegions.length,
    basis: "region_review"
  };
}

function buildRegionalOperationsFromItems({ basis = "run", items = [], run = {}, collectedAt = "" } = {}) {
  const entities = new Map();
  for (const item of items) {
    const key = regionOpsEntityKey(item);
    const previous = entities.get(key) || {};
    entities.set(key, {
      ...previous,
      ...item,
      hasInventory: Boolean(previous.hasInventory || item.hasInventory || regionOpsHasReservationSample(item))
    });
  }

  const buckets = new Map();
  const outsideExposureItems = [];
  for (const item of entities.values()) {
    const actualRegion = regionOpsActualRegionText(item);
    const searchRegion = regionOpsSearchRegionText(item, run);
    const classification = adminRegionClassification(actualRegion || searchRegion || run.provinceLabel);
    const boundary = item.regionBoundaryStatus
      ? {
          status: item.regionBoundaryStatus,
          label: item.regionBoundaryLabel || "",
          detail: item.regionBoundaryDetail || "",
          outside: Boolean(item.outsideSearchRegion)
        }
      : regionBoundaryInfo(searchRegion, actualRegion);
    const bucket = buckets.get(classification.regionKey) || createRegionalOpsBucket(classification);
    const companyKey = regionOpsEntityKey(item);
    const companyName = regionOpsItemName(item);
    const rank = Number(item.rank || item.bestRank || 0);
    const revenue = regionOpsRevenueValue(item);
    const reservationRate = regionOpsReservationRate(item);
    const flags = regionOpsInventoryFlags(item);
    const grade = regionOpsConfidenceGrade(item);
    const hasReservation = regionOpsHasReservationSample(item);
    const hasRevenue = revenue > 0;
    const manualCorrection = Boolean(
      item.manualCorrectionApplied
      || item.companyProfile?.manualCorrection
      || item.companyProfile?.inventory?.latest?.manualCorrectionApplied
    );
    const adminReviewStatus = String(item.companyProfile?.adminReview?.status || item.adminReview?.status || "").trim();
    const adminReview = Boolean(adminReviewStatus);
    const structuralBlocked = firstPositiveNumber(
      item.weeklyStructuralBlockedTotal,
      item.dayUseWeeklyStructuralBlockedTotal,
      item.companyProfile?.inventory?.latest?.salesSignal?.lodgingStructuralBlockedTotal,
      item.companyProfile?.inventory?.latest?.salesSignal?.dayUseStructuralBlockedTotal
    ) > 0;
    const offlineReservation = firstPositiveNumber(
      item.weeklyOfflineReservedTotal,
      item.dayUseWeeklyOfflineReservedTotal,
      item.companyProfile?.inventory?.latest?.salesSignal?.lodgingOfflineReservedTotal,
      item.companyProfile?.inventory?.latest?.salesSignal?.dayUseOfflineReservedTotal
    ) > 0;
    const couponSignal = naverCouponSignalFromItem({
      ...item,
      naverCouponNames: item.naverCouponNames
        || item.companyProfile?.inventory?.latest?.couponSignal?.names
        || item.companyProfile?.inventory?.latest?.salesSignal?.couponSignal?.names
        || "",
      naverCouponStatus: item.naverCouponStatus
        || item.companyProfile?.inventory?.latest?.couponSignal?.status
        || item.companyProfile?.inventory?.latest?.salesSignal?.couponSignal?.status
        || ""
    });
    const couponVisible = Boolean(couponSignal.named);

    bucket.companyKeys.add(companyKey);
    if (companyName) bucket.companyNames.add(companyName);
    bucket.exposureCount += 1;
    if (boundary.outside) bucket.outsideExposureCount += 1;
    else bucket.inRegionExposureCount += 1;
    if (hasReservation) bucket.reservationSampleCount += 1;
    if (hasRevenue) {
      bucket.revenueSampleCount += 1;
      bucket.revenueTotal += revenue;
    }
    if (["D", "E"].includes(grade)) bucket.lowConfidenceCount += 1;
    if (flags.includes("dynamic_capacity")) bucket.stockVarianceCount += 1;
    if (offlineReservation) bucket.offlineReservationCount += 1;
    if (structuralBlocked) bucket.structuralBlockedCount += 1;
    if (manualCorrection) bucket.manualCorrectionCount += 1;
    if (adminReview) {
      bucket.adminReviewCount += 1;
      bucket.reviewStatusCounts[adminReviewStatus] = Number(bucket.reviewStatusCounts[adminReviewStatus] || 0) + 1;
    }
    if (couponVisible) bucket.couponVisibleCount += 1;
    if (Number.isFinite(rank) && rank > 0) bucket.bestRank = bucket.bestRank ? Math.min(bucket.bestRank, rank) : rank;
    if (reservationRate !== null) {
      bucket.reservationRateSum += reservationRate;
      bucket.reservationRateCount += 1;
    }
    if (bucket.sampleCompanies.length < 12) {
      bucket.sampleCompanies.push({
        companyId: item.companyId || item.companyProfile?.companyId || "",
        name: companyName || "업체명 확인",
        rank: Number.isFinite(rank) && rank > 0 ? rank : null,
        addressRegion: actualRegion,
        searchRegion,
        boundaryStatus: boundary.status,
        boundaryLabel: boundary.label,
        reservationRate,
        revenue,
        confidenceGrade: grade || "",
        flags
      });
    }
    if (boundary.outside && outsideExposureItems.length < 30) {
      outsideExposureItems.push({
        companyId: item.companyId || item.companyProfile?.companyId || "",
        name: companyName || "업체명 확인",
        rank: Number.isFinite(rank) && rank > 0 ? rank : null,
        searchRegion,
        addressRegion: actualRegion,
        boundaryLabel: boundary.label,
        boundaryDetail: boundary.detail
      });
    }
    buckets.set(classification.regionKey, bucket);
  }

  const regions = [...buckets.values()]
    .map((bucket) => {
      bucket.companyCount = bucket.companyKeys.size;
      return finalizeRegionalOpsBucket(bucket);
    })
    .sort((a, b) => b.companyCount - a.companyCount || (a.bestRank || 9999) - (b.bestRank || 9999) || a.regionLabel.localeCompare(b.regionLabel, "ko"));
  const summary = {
    basis,
    regionCount: regions.length,
    companyCount: regions.reduce((sum, region) => sum + region.companyCount, 0),
    exposureCount: regions.reduce((sum, region) => sum + region.exposureCount, 0),
    outsideExposureCount: regions.reduce((sum, region) => sum + region.outsideExposureCount, 0),
    reservationSampleCount: regions.reduce((sum, region) => sum + region.reservationSampleCount, 0),
    revenueSampleCount: regions.reduce((sum, region) => sum + region.revenueSampleCount, 0),
    lowConfidenceCount: regions.reduce((sum, region) => sum + region.lowConfidenceCount, 0),
    manualCorrectionCount: regions.reduce((sum, region) => sum + region.manualCorrectionCount, 0),
    adminReviewCount: regions.reduce((sum, region) => sum + region.adminReviewCount, 0),
    reviewStatusCounts: regions.reduce((acc, region) => {
      for (const [status, count] of Object.entries(region.reviewStatusCounts || {})) {
        acc[status] = Number(acc[status] || 0) + Number(count || 0);
      }
      return acc;
    }, {}),
    publicReadyRegionCount: regions.filter((region) => region.status.key === "public_ready").length,
    reviewNeededRegionCount: regions.filter((region) => region.status.key === "review_needed").length,
    collectNeededRegionCount: regions.filter((region) => region.status.key === "collect_needed").length,
    preflightReadyRegionCount: regions.filter((region) => region.preflight?.status?.key === "ready").length,
    preflightReviewRegionCount: regions.filter((region) => region.preflight?.status?.key === "review").length,
    urgentMaintenanceRegionCount: regions.filter((region) => Number(region.maintenance?.maintenancePriority || 0) >= 80).length,
    weeklyMaintenanceRegionCount: regions.filter((region) => region.maintenance?.nextCycle === "주 1회 유지").length,
    maintenanceActionCount: regions.reduce((sum, region) => {
      const actions = Array.isArray(region.maintenance?.actions) ? region.maintenance.actions : [];
      return sum + actions.filter((action) => action.key !== "weekly_maintenance").length;
    }, 0)
  };
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    basis,
    search: {
      runId: run.id || "",
      keyword: run.keyword || "",
      provinceKey: run.province || "",
      provinceLabel: run.provinceLabel || "",
      detailRankRanges: run.detailRankRanges || "",
      checkIn: run.checkIn || "",
      checkOut: run.checkOut || ""
    },
    summary,
    regions,
    outsideExposureItems,
    rules: [
      "실제 주소 지역을 우선 적용하고 없으면 수집 지역, 검색 기준 지역 순서로 분류합니다.",
      "검색 기준과 실제 소재 지역이 다르면 지역 밖 노출로 별도 집계합니다.",
      "예약 표본, 매출 표본, 수량 신뢰도, 총량 변동, 관리자 보정 여부를 지역 공개 품질의 기초 지표로 저장합니다."
    ]
  };
}

function buildRunRegionalOperations(data = {}, collectedAt = "") {
  const run = data.run || {};
  const items = [
    ...(data.ranking?.items || []),
    ...(data.availability?.items || [])
  ];
  return buildRegionalOperationsFromItems({ basis: "run", items, run, collectedAt });
}

function summarizeCompanyMasterRegionalOperations(companies = [], master = {}) {
  const items = companies.map((company) => {
    const latest = company.inventory?.latest || {};
    const signal = latest.salesSignal || {};
    const lodging = signal.lodging || {};
    const dayUse = signal.dayUse || {};
    return {
      companyId: company.companyId,
      companyProfile: company,
      name: company.primaryName,
      primaryName: company.primaryName,
      rank: company.bestRank,
      bestRank: company.bestRank,
      region: company.regions?.[0] || "",
      address: company.addresses?.[0] || "",
      weeklyTotalStock: lodging.totalSupply || null,
      weeklyTotalSoldOut: lodging.totalSold || null,
      weeklyAvgReservationRate: lodging.averageRate ?? null,
      weeklyBasisTotal: signal.lodgingBasisTotal || null,
      weeklyStructuralBlockedTotal: signal.lodgingStructuralBlockedTotal || null,
      weeklyOfflineReservedTotal: signal.lodgingOfflineReservedTotal || null,
      dayUseWeeklyTotalStock: dayUse.totalSupply || null,
      dayUseWeeklyTotalSoldOut: dayUse.totalSold || null,
      dayUseWeeklyAvgReservationRate: dayUse.averageRate ?? null,
      dayUseWeeklyBasisTotal: signal.dayUseBasisTotal || null,
      dayUseWeeklyStructuralBlockedTotal: signal.dayUseStructuralBlockedTotal || null,
      dayUseWeeklyOfflineReservedTotal: signal.dayUseOfflineReservedTotal || null,
      inventoryConfidenceGrade: latest.confidenceGrade || "",
      inventoryStructureFlags: latest.structureFlags || signal.structureFlags || [],
      manualCorrectionApplied: Boolean(company.manualCorrection || latest.manualCorrectionApplied),
      adminReview: company.adminReview || null
    };
  });
  return applyAdminRegionReviewsToOperations(
    buildRegionalOperationsFromItems({ basis: "company_master", items, run: {}, collectedAt: "" }),
    master
  );
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
  const normalizedCouponSignal = naverCouponSignalFromItem({
    naverCouponStatus: couponSignal.status || signal.naverCouponStatus || "",
    naverCouponNames: couponSignal.names || signal.naverCouponNames || "",
    naverCouponChannel: couponSignal.channel || signal.naverCouponChannel || "",
    naverCouponDetail: couponSignal.detail || signal.naverCouponDetail || ""
  });
  const couponVisible = Boolean(
    signal.naverCouponVisible ||
    normalizedCouponSignal.visible
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
    couponNames: normalizedCouponSignal.names,
    couponStatus: normalizedCouponSignal.status,
    couponChannel: normalizedCouponSignal.channel,
    couponDetail: normalizedCouponSignal.detail,
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
  const regions = companyRegionsWithManualCorrection(company);
  return {
    ...item,
    name: company.primaryName || item.name || "",
    region: regions.find(Boolean) || item.region || "",
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
  const lodgingBasis = manualCorrectionLodgingBasisTotal(correction);
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
  const roomSegments = sanitizeManualCorrectionRoomSegments(payload.roomSegments);
  const correctionMeta = sanitizeManualCorrectionMeta(payload);
  const nextCorrection = {
    active: true,
    lodgingBasisTotal: Number.isFinite(lodgingBasisTotal) && lodgingBasisTotal > 0 ? Math.round(lodgingBasisTotal) : null,
    dayUseBasisTotal: Number.isFinite(dayUseBasisTotal) && dayUseBasisTotal > 0 ? Math.round(dayUseBasisTotal) : null,
    roomSegments,
    ...correctionMeta,
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
      roomSegmentCount: company.manualCorrection?.roomSegments?.length || 0,
      regionOverride: company.manualCorrection?.regionOverride || "",
      channelNote: company.manualCorrection?.channelNote || "",
      couponNote: company.manualCorrection?.couponNote || "",
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

async function saveAdminRegionReview(payload = {}, session = {}) {
  const regionKey = regionReviewKey(payload.regionKey || payload.key || payload.regionLabel);
  const regionLabel = sanitizeMemberText(payload.regionLabel || payload.label || regionKey, 80);
  const provinceLabel = sanitizeMemberText(payload.provinceLabel, 80);
  const status = String(payload.status || "").trim();
  const master = await readCompanyMaster();
  if (!regionKey) {
    const error = new Error("감수할 지역 키가 없습니다.");
    error.statusCode = 400;
    throw error;
  }
  const savedAt = new Date().toISOString();
  const previous = master.regionReviews?.[regionKey] || null;
  const note = sanitizeMemberText(payload.note, 260);
  const checklistSummary = sanitizeMemberText(payload.checklistSummary, 260);
  let review = null;
  let action = "save";
  if (!status || status === "clear") {
    action = "clear";
    delete master.regionReviews[regionKey];
  } else {
    const meta = adminRegionReviewMeta(status);
    if (!meta) {
      const error = new Error("지원하지 않는 지역 감수 상태입니다.");
      error.statusCode = 400;
      throw error;
    }
    review = {
      regionKey,
      regionLabel,
      provinceLabel,
      status,
      label: meta.label,
      tone: meta.tone,
      note,
      checklistSummary,
      source: "admin",
      updatedBy: sanitizeMemberText(session.username || session.memberId || "admin", 80),
      updatedAt: savedAt
    };
    master.regionReviews[regionKey] = review;
  }
  master.regionReviewHistory = [
    ...(master.regionReviewHistory || []),
    {
      at: savedAt,
      action,
      regionKey,
      regionLabel,
      provinceLabel,
      previousStatus: previous?.status || "",
      previousLabel: previous?.label || "",
      status: review?.status || "",
      label: review?.label || "감수 해제",
      note,
      checklistSummary,
      source: "admin",
      by: sanitizeMemberText(session.username || session.memberId || "admin", 80)
    }
  ].slice(-200);
  await writeCompanyMaster(master);
  return {
    ...(await summarizeCompanyMaster()),
    resolved: { action: action === "clear" ? "clearAdminRegionReview" : "saveAdminRegionReview", regionKey, status: review?.status || "clear" }
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
    adminRegionalOperations: summarizeCompanyMasterRegionalOperations(profiledCompanies, master),
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

function summarizeAvailabilityRows(rows, baseDir = "") {
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
    const itemDetails = jsonArrayField(row, ["네이버상품상세JSON", "itemDetailsJson", "itemDetails"], baseDir);
    const weeklyProductDetails = [
      ...jsonArrayField(row, ["네이버요일별상품상세JSON", "weeklyProductDetailsJson", "weeklyProductDetails"], baseDir),
      ...jsonArrayField(row, ["dayUseWeeklyProductDetailsJson"], baseDir)
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
      naverCouponVisibleCount: items.filter((item) => naverCouponSignalFromItem(item).named).length,
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
  const regions = summarizeRegionalRows(regionalRows, provinceKey, manifest?.keyword || conditions.keyword || "");
  const datalabTrend = await enrichRegionsWithTraffic(regions, dirPath, demandKeywordForRun(manifest, conditions, regions));
  const stats = summarizeStats(regions);
  if (datalabTrend) stats.datalabTrend = datalabTrend;
  const availability = summarizeAvailabilityRows([...overallRows, ...adRows, ...regionalRows, ...displayPlatformRows], dirPath);
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

  result.adminRegionalOperations = buildRunRegionalOperations(result, collectedAt);
  if (options.applyCompanyMaster) {
    await readCompanyMaster()
      .then((master) => {
        result.adminRegionalOperations = applyAdminRegionReviewsToOperations(result.adminRegionalOperations, master);
        result.b2bRegionReviewSummary = publicB2BRegionReviewSummary(result, master);
      })
      .catch((error) => {
        result.b2bRegionReviewSummary = {
          status: "unavailable",
          label: "지역 기준 확인 대기",
          tone: "watch",
          summary: error.message || "지역 기준 확인 정보를 불러오지 못했습니다."
        };
      });
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

async function appendCrawlTimingEntry({ plan, startedAt, endedAt, estimate, result, error, stageTimings = [] }) {
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
    stageTimings: Array.isArray(stageTimings) ? stageTimings : [],
    error: success ? "" : crawlTimingErrorSummary(error)
  };
  store.entries = [...(store.entries || []), entry].slice(-CRAWL_TIMING_MAX_ENTRIES);
  await writeCrawlTimingStore(store);
  return { recorded: true, durationSeconds, success, sampleCount: store.entries.length, stageTimings: entry.stageTimings, file: "history/crawl_timings.json" };
}

async function runCrawlerLegacySingleFlight(payload) {
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
  activeCrawlCancelRequested = false;
  activeCrawlCancelReason = "";
  activeCrawlSourceRole = sourceRoleForCollectionSource(
    normalizeCollectionSource(payload.collectionSource, payload.sourceRole),
    payload.sourceRole
  );
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
    activeCrawlChild = null;
    activeCrawlCancelRequested = false;
    activeCrawlCancelReason = "";
    activeCrawlSourceRole = "";
  }
}

async function runCrawler(payload) {
  const signature = crawlPayloadSignature(payload);
  const cached = reusableRecentCrawlResult(signature);
  if (cached) {
    return resolveCrawlJob(cached, { signature, waiterCount: 1 }, "recent_reuse");
  }
  const existing = findReusableCrawlJob(signature);
  if (existing) {
    attachCrawlJobClient(existing, payload);
    const result = await existing.promise;
    return resolveCrawlJob(result, existing, "shared");
  }
  const job = createCrawlJob(payload, signature);
  crawlQueue.push(job);
  startNextCrawlJob();
  return job.promise;
}

function crawlCancelledError(reason = "") {
  const error = new Error(reason || "수집이 중지되었습니다.");
  error.statusCode = 499;
  error.cancelled = true;
  return error;
}

function terminateActiveCrawlChild(reason = "사용자 요청으로 수집을 중지합니다.", requesterRole = USER_ROLES.admin) {
  if (!activeCrawlPromise) return { ok: false, active: false, message: "진행 중인 수집이 없습니다." };
  if (normalizeUserRole(requesterRole) === USER_ROLES.b2b && normalizeUserRole(activeCrawlSourceRole) !== USER_ROLES.b2b) {
    return { ok: false, active: true, blocked: true, message: "관리자 수집은 B2B 화면에서 중지할 수 없습니다." };
  }
  activeCrawlCancelRequested = true;
  activeCrawlCancelReason = reason;
  if (activeCrawlJob) activeCrawlJob.status = "cancelling";
  const child = activeCrawlChild;
  if (!child || child.killed || !child.pid) {
    return { ok: true, active: true, message: "수집 중지 요청을 접수했습니다." };
  }
  try {
    child.kill();
  } catch {
    // Fall through to the process-tree fallback below.
  }
  if (process.platform === "win32") {
    setTimeout(() => {
      if (!activeCrawlCancelRequested || !child.pid || child.killed) return;
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      } catch {
        // The child close handler will clear state when it exits.
      }
    }, 1500);
  }
  return { ok: true, active: true, message: "수집 중지 요청을 보냈습니다." };
}

function currentCrawlStatus(options = {}) {
  const clientRequestId = crawlQueueClientRequestId(options.clientRequestId);
  const requesterJob = findCrawlJobByClientRequestId(clientRequestId);
  const requesterQueueIndex = requesterJob
    ? (requesterJob === activeCrawlJob ? 0 : crawlQueue.indexOf(requesterJob) + 1)
    : -1;
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
    cancelling: Boolean(activeCrawlCancelRequested),
    cancelReason: activeCrawlCancelReason || "",
    sourceRole: activeCrawlPromise ? normalizeUserRole(activeCrawlSourceRole) : "",
    delayThresholdSeconds: activeCrawlPromise ? delayThresholdSeconds : null,
    recrawlContext: activeCrawlPromise ? activeCrawlEstimate?.recrawlContext || null : null,
    currentStage: stageStatus.currentStage,
    stages: stageStatus.stages,
    stageTimings: activeCrawlPromise ? publicCrawlStageTimings(activeCrawlJob) : [],
    stageSource: stageStatus.stages?.some((stage) => stage.actual) ? "runtime" : "estimate",
    estimateBasis: activeCrawlPromise ? activeCrawlEstimate?.basis || null : null,
    activeJob: publicCrawlJob(activeCrawlJob, 0),
    queueLength: crawlQueue.length,
    queuedJobs: crawlQueue.map((job, index) => publicCrawlJob(job, index + 1)),
    requesterJob: requesterJob ? publicCrawlJob(requesterJob, requesterQueueIndex) : null
  };
}

function activeCrawlStageStatus(elapsedSeconds = 0) {
  const runtime = crawlRuntimeStageRows(activeCrawlJob, elapsedSeconds);
  if (runtime) return runtime;
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
    activeCrawlChild = child;
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      recordCrawlRuntimeOutputChunk(activeCrawlJob, text);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (activeCrawlCancelRequested) {
        reject(crawlCancelledError(activeCrawlCancelReason));
        return;
      }
      reject(error);
    });
    child.on("close", async (code) => {
      if (activeCrawlChild === child) activeCrawlChild = null;
      recordCrawlRuntimeOutputChunk(activeCrawlJob, "", true);
      if (activeCrawlCancelRequested) {
        reject(crawlCancelledError(activeCrawlCancelReason));
        return;
      }
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
      .replace('href="/styles.css"', 'href="/styles.css?v=v2-20260710-admin-region-final-approval"')
      .replace('src="/app.js"', 'src="/app.js?v=v2-20260710-admin-region-final-approval"');
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
    const publicStaticPaths = new Set([
      "/manifest.webmanifest",
      "/sw.js",
      "/offline.html",
      "/favicon.svg",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/maskable-512.png"
    ]);
    if ((req.method === "GET" || req.method === "HEAD") && publicStaticPaths.has(reqUrl.pathname)) {
      if (req.method === "HEAD") {
        const ext = path.extname(reqUrl.pathname).toLowerCase();
        return sendHead(res, 200, MIME_TYPES[ext] || "application/octet-stream");
      }
      return serveStatic(reqUrl, res);
    }

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

    const legalRoutes = {
      "/refund": refundPolicyPage,
      "/refund-cancellation-policy": refundPolicyPage,
      "/data-collection-notice": dataCollectionNoticePage,
      "/data-quality-notice": dataQualityNoticePage,
      "/external-platform-data-limit": dataQualityNoticePage,
      "/collection-failure-notice": collectionFailureNoticePage,
      "/api-key-retention-policy": apiRetentionPolicyPage,
      "/report-disclaimer": reportDisclaimerPage,
      "/business-info": businessInfoPage,
      "/google-play-data-safety": googlePlayDataSafetyPage
    };
    if ((req.method === "GET" || req.method === "HEAD") && legalRoutes[reqUrl.pathname]) {
      if (req.method === "HEAD") return sendHead(res, 200, "text/html; charset=utf-8");
      return send(res, 200, legalRoutes[reqUrl.pathname](), "text/html; charset=utf-8");
    }

    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/account-delete") {
      if (req.method === "HEAD") return sendHead(res, 200, "text/html; charset=utf-8");
      return send(res, 200, accountDeletePage(getSession(req)), "text/html; charset=utf-8");
    }

    if (req.method === "POST" && (reqUrl.pathname === "/account-delete" || reqUrl.pathname === "/api/account-delete-request")) {
      const session = getSession(req);
      const payload = await parseLoginBody(req);
      try {
        assertRequestRateLimit(req, "accountDelete", RATE_LIMIT_POLICIES.accountDelete);
        const requestRow = await createAccountDeleteRequest(payload, { req, session });
        if (reqUrl.pathname === "/api/account-delete-request") {
          return send(res, 200, { ok: true, request: requestRow });
        }
        return send(res, 200, accountDeletePage(session, { success: requestRow, values: payload }), "text/html; charset=utf-8");
      } catch (error) {
        if (reqUrl.pathname === "/api/account-delete-request") {
          return send(res, error.statusCode || 400, { error: error.message || String(error) });
        }
        return send(res, error.statusCode || 400, accountDeletePage(session, { error: error.message || String(error), values: payload }), "text/html; charset=utf-8");
      }
    }

    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/signup.js") {
      if (req.method === "HEAD") return sendHead(res, 200, "application/javascript; charset=utf-8");
      return send(res, 200, signupScript(), "application/javascript; charset=utf-8");
    }

    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/api/signup/check-username") {
      if (req.method === "HEAD") return sendHead(res, 200);
      assertRequestRateLimit(req, "signupCheck", RATE_LIMIT_POLICIES.signupCheck);
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
        assertRequestRateLimit(req, "signup", RATE_LIMIT_POLICIES.signup);
        const account = await registerB2BMember(payload, { req });
        const sessionId = createSession(account.username, account.role, account, req);
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
      try {
        assertRequestRateLimit(req, "login", RATE_LIMIT_POLICIES.login);
      } catch (error) {
        const headers = { "Retry-After": String(Math.max(1, Number(error.retryAfterSeconds) || 60)) };
        if (reqUrl.pathname === "/login") return sendLogin(res, 429, error.message || "로그인 요청이 잠시 많습니다.", headers);
        return send(res, 429, { error: error.message || "로그인 요청이 잠시 많습니다.", retryAfterSeconds: error.retryAfterSeconds || 60 }, "application/json; charset=utf-8", headers);
      }
      const lockStatus = loginAttemptStatus(req, username);
      if (lockStatus.locked) {
        const message = loginLockMessage(lockStatus);
        const headers = loginLockHeaders(lockStatus);
        if (reqUrl.pathname === "/login") return sendLogin(res, 429, message, headers);
        return send(res, 429, { error: message, retryAfterSeconds: lockStatus.retryAfterSeconds }, "application/json; charset=utf-8", headers);
      }
      const account = await authenticatedUserForCredentials(username, password);
      if (!account) {
        const failureStatus = recordLoginFailure(req, username);
        if (failureStatus.locked) {
          const message = loginLockMessage(failureStatus);
          const headers = loginLockHeaders(failureStatus);
          if (reqUrl.pathname === "/login") return sendLogin(res, 429, message, headers);
          return send(res, 429, { error: message, retryAfterSeconds: failureStatus.retryAfterSeconds }, "application/json; charset=utf-8", headers);
        }
        const message = "아이디 또는 비밀번호가 올바르지 않습니다.";
        if (reqUrl.pathname === "/login") return sendLogin(res, 401, message);
        return send(res, 401, { error: message });
      }
      clearLoginFailures(req, username);
      const sessionId = createSession(account.username, account.role, account, req);
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
      const hadSessionCookie = Boolean(parseCookies(req)[SESSION_COOKIE_NAME]);
      const session = getSession(req);
      if (session) return send(res, 302, "", "text/plain; charset=utf-8", { Location: redirectPathForRole(session.role) });
      return sendLogin(res, 200, hadSessionCookie ? "세션이 만료되었습니다. 다시 로그인하세요." : "", hadSessionCookie ? { "Set-Cookie": clearSessionCookie() } : {});
    }

    if (!requireLogin(req, res, reqUrl)) return;
    const session = getSession(req);

    if ((req.method === "GET" || req.method === "HEAD") && reqUrl.pathname === "/account-request") {
      if (req.method === "HEAD") return sendHead(res, 200, "text/html; charset=utf-8");
      return send(res, 200, accountRequestPage(session), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/account-delete-requests") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, await publicAccountDeleteRequestsAdminOverview());
    }

    if (req.method === "POST" && reqUrl.pathname.startsWith("/api/account-delete-requests/") && reqUrl.pathname.endsWith("/status")) {
      if (!requireAdminSession(session, req, res)) return;
      const requestId = decodeURIComponent(reqUrl.pathname.replace("/api/account-delete-requests/", "").replace("/status", ""));
      const payload = await parseJsonBody(req).catch(() => ({}));
      return send(res, 200, await updateAccountDeleteRequestStatus(requestId, payload, session));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/session") {
      return send(res, 200, publicSession(session));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/member/search-history") {
      const limit = Number(reqUrl.searchParams.get("limit") || 20);
      return send(res, 200, await publicB2BSearchHistoryForSession(session, limit));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/member/interest-lodges") {
      if (normalizeUserRole(session.role) !== USER_ROLES.b2b) {
        return sendForbidden(req, res, "B2B 계정이 필요합니다.");
      }
      return send(res, 200, await publicB2BInterestLodgesForSession(session));
    }

    if ((req.method === "PUT" || req.method === "POST") && reqUrl.pathname === "/api/member/interest-lodges") {
      if (normalizeUserRole(session.role) !== USER_ROLES.b2b) {
        return sendForbidden(req, res, "B2B 계정이 필요합니다.");
      }
      assertRequestRateLimit(req, "b2bInterestLodgeSave", RATE_LIMIT_POLICIES.b2bInterestLodgeSave, session.username || session.memberId || "");
      const payload = await parseJsonBody(req).catch(() => ({}));
      return send(res, 200, await saveB2BInterestLodgesForSession(session, payload));
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
      return send(res, 200, await publicB2BMembersAdminOverview());
    }

    if (req.method === "POST" && reqUrl.pathname.startsWith("/api/b2b-members/") && reqUrl.pathname.endsWith("/policy")) {
      if (!requireAdminSession(session, req, res)) return;
      const memberId = decodeURIComponent(reqUrl.pathname.replace("/api/b2b-members/", "").replace("/policy", ""));
      const payload = await parseJsonBody(req).catch(() => ({}));
      return send(res, 200, await updateB2BMemberAdminPolicy(memberId, payload, session));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/security-hardening") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, await securityHardeningOverview());
    }

    if (routeRolePage(req, res, reqUrl, session)) return;

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
      assertRequestRateLimit(req, "b2bSearch", RATE_LIMIT_POLICIES.b2bSearch, session.username || session.memberId || "");
      const payload = await parseJsonBody(req);
      return send(res, 200, await runB2BSearch(payload, { session, req }));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/b2b-my-lodge-collect") {
      if (normalizeUserRole(session.role) !== USER_ROLES.b2b) {
        return sendForbidden(req, res, "B2B 계정이 필요합니다.");
      }
      assertRequestRateLimit(req, "b2bMyLodgeCollect", RATE_LIMIT_POLICIES.b2bMyLodgeCollect, session.username || session.memberId || "");
      const payload = await parseJsonBody(req);
      return send(res, 200, await runB2BMyLodgeCollection(payload));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/b2b-search/status") {
      if (normalizeUserRole(session.role) !== USER_ROLES.b2b) {
        return sendForbidden(req, res, "B2B 계정이 필요합니다.");
      }
      return send(res, 200, currentCrawlStatus({ clientRequestId: reqUrl.searchParams.get("clientRequestId") }));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/b2b-search/cancel") {
      if (normalizeUserRole(session.role) !== USER_ROLES.b2b) {
        return sendForbidden(req, res, "B2B 계정이 필요합니다.");
      }
      const payload = await parseJsonBody(req).catch(() => ({}));
      const reason = String(payload.reason || "새 B2B 검색 실행을 위해 기존 수집을 중지합니다.").trim();
      const result = terminateActiveCrawlChild(reason, session.role);
      return send(res, result.blocked ? 409 : 200, { ...result, error: result.blocked ? result.message : undefined, status: currentCrawlStatus() });
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/crawl-status") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, currentCrawlStatus({ clientRequestId: reqUrl.searchParams.get("clientRequestId") }));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/crawl-estimate") {
      if (![USER_ROLES.admin, USER_ROLES.b2b].includes(normalizeUserRole(session.role))) {
        return sendForbidden(req, res, "로그인이 필요합니다.");
      }
      const payload = await parseJsonBody(req);
      const timingStore = readCrawlTimingStoreSync();
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 40) : null;
      if (items) {
        return send(res, 200, {
          items: await Promise.all(items.map(async (item) => ({
            clientKey: item.clientKey || "",
            estimate: await publicCrawlEstimateForSession(item, timingStore, session)
          })))
        });
      }
      return send(res, 200, await publicCrawlEstimateForSession(payload, timingStore, session));
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

    if (req.method === "GET" && reqUrl.pathname === "/api/location-score-overrides") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, publicLocationScoreOverrides(await readLocationScoreOverrides()));
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/location-score-overrides") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveLocationScoreOverride(payload, session));
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/tourism-data/status") {
      if (!requireAdminSession(session, req, res)) return;
      return send(res, 200, await tourismCollector.status());
    }

    if (req.method === "POST" && reqUrl.pathname === "/api/tourism-data/collect") {
      if (!requireAdminSession(session, req, res)) return;
      assertRequestRateLimit(req, "adminTourism", RATE_LIMIT_POLICIES.adminTourism, session.username || "");
      const payload = await parseJsonBody(req);
      return send(res, 200, await tourismCollector.collect(payload));
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

    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/region-review") {
      if (!requireAdminSession(session, req, res)) return;
      const payload = await parseJsonBody(req);
      return send(res, 200, await saveAdminRegionReview(payload, session));
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
      assertRequestRateLimit(req, "adminCrawl", RATE_LIMIT_POLICIES.adminCrawl, session.username || "");
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
    const headers = error.retryAfterSeconds
      ? { "Retry-After": String(Math.max(1, Number(error.retryAfterSeconds) || 1)) }
      : {};
    send(res, error.statusCode || 500, {
      error: error.message || String(error),
      retryAfterSeconds: error.retryAfterSeconds || undefined
    }, "application/json; charset=utf-8", headers);
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
      console.log(`Lodging datalab beta app running at ${primaryUrl}`);
      if (HOST === "0.0.0.0") {
        for (const url of localNetworkUrls()) console.log(`Mobile/LAN URL: ${url}`);
      }
    });
  });
