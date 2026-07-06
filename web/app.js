const state = {
  session: {
    authenticated: false,
    username: "",
    role: "admin",
    roleLabel: "관리자"
  },
  runs: [],
  data: null,
  activeRunId: null,
  activeTab: "report",
  selectedItem: null,
  selectedSheetTab: "booking",
  mapData: null,
  mapPromise: null,
  dictionary: null,
  locationCardRequests: null,
  historyOps: null,
  companyMaster: null,
  companyMasterFilters: {
    query: "",
    layer: "all",
    target: "all",
    check: "priority",
    checkQuery: "",
    salesGate: "all"
  },
  crawlEtaByKey: {},
  selectedLocationCard: null,
  dictionarySyncedRunId: null,
  trafficKeyState: null,
  crawlStatusTimer: null,
  pendingRecrawlContext: null,
  b2bSearchQuery: "",
  b2bSearchRange: "1-10",
  b2bSearchLoading: false,
  b2bSearchStartedAt: 0,
  b2bSearchPreview: null,
  b2bSearchTimer: null,
  b2bMyLodgeDraft: null,
  b2bMyLodgeCollecting: false,
  b2bMyLodgeCollectStatus: "",
  b2bMyLodgeCollectResult: null,
  memberSearchHistory: [],
  b2bHistoryExpanded: false
};

const CORE_ORDER = ["메인 관광지형", "인접 관광 흡수형", "자연 관광자원형", "생활권·도심 수요형", "복합형", "확인필요"];
const CORE_COLORS = {
  "메인 관광지형": "#e5484d",
  "인접 관광 흡수형": "#f79009",
  "자연 관광자원형": "#2e9d62",
  "생활권·도심 수요형": "#3182f6",
  "복합형": "#7a5af8",
  "확인필요": "#98a2b3"
};
const LOCAL_MAP_URL = "/assets/korea_municipalities.geojson";
const LOCATION_DICTIONARY_URL = "/data/location_dictionary.json";
const DEFAULT_BOOKING_DAYS = 7;
const B2B_HIGH_RESERVATION_RATE = 0.4;
const B2B_LOW_RESERVATION_RATE = 0.2;
const B2B_HIGH_RESERVATION_LABEL = "수집기간 예약율 40% 이상";
const B2B_LOW_RESERVATION_LABEL = "수집기간 예약율 20% 이하";
const B2B_MY_LODGE_STORAGE_PREFIX = "glamping-datalab:b2b-my-lodge:v1";
const ROLE_TABS = {
  admin: ["report", "rank", "dictionary", "target", "decisionQueue", "map", "demand", "historyOps", "admin"],
  b2b: ["report", "rank", "map", "demand"]
};
const TAB_LABELS = {
  report: "요약 리포트",
  rank: "업체 순위",
  dictionary: "입지사전",
  target: "영업 타깃",
  decisionQueue: "관리자 판단 큐",
  map: "지역 클러스터 지도",
  demand: "수요구조 분석",
  historyOps: "누적 DB 분석",
  admin: "관리"
};
const B2B_TAB_LABELS = {
  report: "리포트",
  rank: "순위",
  map: "지도",
  demand: "수요"
};

const els = {
  pageTitle: document.getElementById("pageTitle"),
  pageSubtitle: document.getElementById("pageSubtitle"),
  summaryGrid: document.getElementById("summaryGrid"),
  noticeCard: document.getElementById("noticeCard"),
  reportBody: document.getElementById("reportBody"),
  rankCount: document.getElementById("rankCount"),
  companyList: document.getElementById("companyList"),
  dictionaryCount: document.getElementById("dictionaryCount"),
  dictionarySearchForm: document.getElementById("dictionarySearchForm"),
  dictionarySearchInput: document.getElementById("dictionarySearchInput"),
  dictionaryQuickButtons: document.getElementById("dictionaryQuickButtons"),
  dictionarySearchStatus: document.getElementById("dictionarySearchStatus"),
  dictionaryResult: document.getElementById("dictionaryResult"),
  targetCount: document.getElementById("targetCount"),
  targetList: document.getElementById("targetList"),
  decisionQueueCount: document.getElementById("decisionQueueCount"),
  decisionQueueList: document.getElementById("decisionQueueList"),
  mapCount: document.getElementById("mapCount"),
  mapLayerRow: document.getElementById("mapLayerRow"),
  clusterMap: document.getElementById("clusterMap"),
  mapLegend: document.getElementById("mapLegend"),
  regionList: document.getElementById("regionList"),
  demandState: document.getElementById("demandState"),
  demandDashboard: document.getElementById("demandDashboard"),
  historyOpsState: document.getElementById("historyOpsState"),
  historyOpsDashboard: document.getElementById("historyOpsDashboard"),
  adminStatus: document.getElementById("adminStatus"),
  adminConsoleDashboard: document.getElementById("adminConsoleDashboard"),
  b2bSearchPanel: document.getElementById("b2bSearchPanel"),
  b2bSearchForm: document.getElementById("b2bSearchForm"),
  b2bSearchInput: document.getElementById("b2bSearchInput"),
  b2bSearchRangeInput: document.getElementById("b2bSearchRangeInput"),
  b2bSearchResults: document.getElementById("b2bSearchResults"),
  b2bSearchStatus: document.getElementById("b2bSearchStatus"),
  b2bSearchHistory: document.getElementById("b2bSearchHistory"),
  openControlButton: document.getElementById("openControlButton"),
  controlDrawer: document.getElementById("controlDrawer"),
  detailSheet: document.getElementById("detailSheet"),
  sheetTitle: document.getElementById("sheetTitle"),
  sheetSubtitle: document.getElementById("sheetSubtitle"),
  sheetBody: document.getElementById("sheetBody"),
  runSelect: document.getElementById("runSelect"),
  refreshRuns: document.getElementById("refreshRuns"),
  crawlForm: document.getElementById("crawlForm"),
  logoutButton: document.getElementById("logoutButton"),
  headerLogoutButton: document.getElementById("headerLogoutButton"),
  keywordInput: document.getElementById("keywordInput"),
  checkInInput: document.getElementById("checkInInput"),
  checkOutInput: document.getElementById("checkOutInput"),
  searchModeInput: document.getElementById("searchModeInput"),
  productModeInput: document.getElementById("productModeInput"),
  collectionModeInput: document.getElementById("collectionModeInput"),
  detailRankRangesInput: document.getElementById("detailRankRangesInput"),
  crawlSpeedPresetRow: document.getElementById("crawlSpeedPresetRow"),
  crawlSpeedPreview: document.getElementById("crawlSpeedPreview"),
  crawlProgress: document.getElementById("crawlProgress"),
  crawlProgressTitle: document.getElementById("crawlProgressTitle"),
  crawlProgressText: document.getElementById("crawlProgressText"),
  crawlProgressBar: document.getElementById("crawlProgressBar"),
  crawlProgressPercent: document.getElementById("crawlProgressPercent"),
  crawlProgressElapsed: document.getElementById("crawlProgressElapsed"),
  crawlProgressRemaining: document.getElementById("crawlProgressRemaining"),
  crawlProgressEta: document.getElementById("crawlProgressEta"),
  crawlProgressBasis: document.getElementById("crawlProgressBasis"),
  crawlProgressStages: document.getElementById("crawlProgressStages"),
  crawlStatus: document.getElementById("crawlStatus"),
  yeogiManualBadge: document.getElementById("yeogiManualBadge"),
  yeogiCurrentKeyword: document.getElementById("yeogiCurrentKeyword"),
  yeogiOpenButton: document.getElementById("yeogiOpenButton"),
  yeogiCopyLinkButton: document.getElementById("yeogiCopyLinkButton"),
  yeogiLinkBox: document.getElementById("yeogiLinkBox"),
  yeogiLinkOutput: document.getElementById("yeogiLinkOutput"),
  yeogiScriptButton: document.getElementById("yeogiScriptButton"),
  yeogiToggleScriptButton: document.getElementById("yeogiToggleScriptButton"),
  yeogiScriptBox: document.getElementById("yeogiScriptBox"),
  yeogiScriptOutput: document.getElementById("yeogiScriptOutput"),
  yeogiImportInput: document.getElementById("yeogiImportInput"),
  yeogiImportButton: document.getElementById("yeogiImportButton"),
  yeogiClearButton: document.getElementById("yeogiClearButton"),
  yeogiPreviewStatus: document.getElementById("yeogiPreviewStatus"),
  yeogiImportStatus: document.getElementById("yeogiImportStatus"),
  trafficApiState: document.getElementById("trafficApiState"),
  trafficKeyForm: document.getElementById("trafficKeyForm"),
  trafficKeyStatus: document.getElementById("trafficKeyStatus"),
  trafficKeyVerifyButton: document.getElementById("trafficKeyVerifyButton"),
  trafficKeyVerifyResult: document.getElementById("trafficKeyVerifyResult"),
  companyMasterState: document.getElementById("companyMasterState"),
  companyMasterPanel: document.getElementById("companyMasterPanel"),
  naverClientIdInput: document.getElementById("naverClientIdInput"),
  naverClientSecretInput: document.getElementById("naverClientSecretInput"),
  searchadApiKeyInput: document.getElementById("searchadApiKeyInput"),
  searchadSecretKeyInput: document.getElementById("searchadSecretKeyInput"),
  searchadCustomerIdInput: document.getElementById("searchadCustomerIdInput"),
  downloadList: document.getElementById("downloadList")
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("ko-KR") : "0";
}

function fmtWon(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0원";
  if (number >= 100000000) return `${(number / 100000000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억원`;
  if (number >= 10000) return `${Math.round(number / 10000).toLocaleString("ko-KR")}만원`;
  return `${number.toLocaleString("ko-KR")}원`;
}

function fmtRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "확인필요";
  return `${Math.round(number * 100)}%`;
}

function summaryIcon(type) {
  const icons = {
    sales: `
      <svg class="summary-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 18V7" />
        <path d="M20 18v-6a3 3 0 0 0-3-3h-6v9" />
        <path d="M4 12h16" />
        <path d="M7 12V8a2 2 0 0 1 2-2h2" />
      </svg>
    `,
    company: `
      <svg class="summary-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 10h14" />
        <path d="M6 10l1-5h10l1 5" />
        <path d="M6 10v8h12v-8" />
        <path d="M9 18v-5h6v5" />
      </svg>
    `,
    rate: `
      <svg class="summary-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 18V6" />
        <path d="M4 18h16" />
        <path d="M7 14l3-3 3 2 5-6" />
        <path d="M16 7h2v2" />
      </svg>
    `,
    money: `
      <svg class="summary-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16v10H4z" />
        <path d="M8 11h.01" />
        <path d="M16 13h.01" />
        <path d="M12 9v6" />
        <path d="M10.5 10.5c0-.8.7-1.3 1.6-1.3 1 0 1.6.4 1.9.8" />
        <path d="M13.5 13.5c0 .8-.7 1.3-1.6 1.3-1 0-1.6-.4-1.9-.8" />
      </svg>
    `,
    trust: `
      <svg class="summary-icon-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z" />
        <path d="M12 8v5" />
        <path d="M12 17h.01" />
      </svg>
    `
  };
  return icons[type] || icons.sales;
}

function fmtSearchRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "확인필요";
  return `${number.toFixed(2)}%`;
}

function parseDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthDay(value) {
  const date = parseDate(value);
  if (!date) return "";
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function compactDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "").slice(0, 16);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function isoAddDays(value, offset) {
  const date = parseDate(value);
  if (!date) return "";
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeMonthDayLabel(value) {
  const match = String(value || "").match(/(\d{1,2})\/(\d{1,2})/);
  return match ? `${Number(match[1])}/${Number(match[2])}` : String(value || "");
}

function bookingRangeLabels(run = {}) {
  const base = run.checkIn || new Date().toISOString().slice(0, 10);
  const count = Math.max(1, Math.min(31, bookingDays(run) || DEFAULT_BOOKING_DAYS));
  return Array.from({ length: count }, (_, index) => {
    const date = isoAddDays(base, index);
    return monthDay(date) || `D+${index}`;
  });
}

function dateRangeLabel(run = {}) {
  const start = monthDay(run.checkIn);
  const end = monthDay(run.checkOut);
  const days = bookingDays(run);
  if (days <= 1) return start ? `${start} 기준` : "기준일 확인";
  if (start && end) return `${start}~${end}`;
  return "기간 확인";
}

function b2bLongDateLabel(date) {
  if (!date) return "";
  const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
  const year = String(date.getFullYear()).slice(-2);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}. ${month}. ${day}(${dayNames[date.getDay()]})`;
}

function b2bDateRangeLabel(run = {}) {
  const start = parseDate(run.checkIn);
  if (!start) return dateRangeLabel(run);
  const days = Math.max(1, Math.min(31, bookingDays(run) || DEFAULT_BOOKING_DAYS));
  let end = parseDate(run.checkOut);
  if (!end || end < start) {
    end = new Date(start);
    end.setDate(start.getDate() + days - 1);
  }
  return `${b2bLongDateLabel(start)} ~ ${b2bLongDateLabel(end)} (${days}일)`;
}

function bookingDays(run = {}) {
  const explicit = Number(run.bookingRangeDays);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(31, Math.round(explicit));
  const start = parseDate(run.checkIn);
  const end = parseDate(run.checkOut);
  if (!start || !end) return 1;
  const diff = Math.round((end - start) / 86400000);
  if (diff > 1) return Math.min(31, diff + 1);
  return 1;
}

function productModeLabel(value) {
  if (value === "lodging") return "숙박";
  if (value === "campnic") return "데이유즈/캠프닉";
  return "전체";
}

function collectionModeLabel(value) {
  return value === "fast" ? "빠른 순위" : "정밀 분석";
}

function normalizedRankRangeText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[~–—]/g, "-")
    .replace(/\s+/g, "");
}

function crawlSpeedPresetOptions() {
  return [
    { key: "top10", label: "기본 1-10위", collectionMode: "precision", range: "1-10", note: "기본 정밀 분석" },
    { key: "top20", label: "확장 1-20위", collectionMode: "precision", range: "1-20", note: "확장 정밀 분석" },
    { key: "top5", label: "1-5위", collectionMode: "precision", range: "1-5", note: "최상위 구간 확인" },
    { key: "mid10_20", label: "10-20위", collectionMode: "precision", range: "10-20", note: "중위권 보강" }
  ];
}

function currentCrawlFormPayload() {
  const keyword = els.keywordInput?.value?.trim() || "";
  const requestedMode = els.searchModeInput?.value || "keyword";
  const resolvedMode = correctedSearchMode(keyword, requestedMode);
  const collectionMode = "precision";
  const rawDetailRankRanges = els.detailRankRangesInput?.value?.trim() || "";
  const detailRankRanges = /^(none|skip|없음)$/i.test(rawDetailRankRanges) ? "1-10" : (rawDetailRankRanges || "1-10");
  return {
    keyword,
    checkIn: els.checkInInput?.value || "",
    checkOut: els.checkOutInput?.value || "",
    searchMode: resolvedMode,
    requestedMode,
    productMode: els.productModeInput?.value || "all",
    collectionMode,
    detailRankRanges
  };
}

function selectedCrawlSpeedPresetKey(payload = currentCrawlFormPayload()) {
  if (payload.collectionMode === "fast") return "fast";
  const range = normalizedRankRangeText(payload.detailRankRanges || "");
  return crawlSpeedPresetOptions().find((preset) => normalizedRankRangeText(preset.range) === range)?.key || "";
}

function updateCrawlSpeedPreview() {
  if (!els.crawlSpeedPresetRow && !els.crawlSpeedPreview) return;
  const payload = currentCrawlFormPayload();
  const preview = crawlPreviewMeta(payload);
  const selectedKey = selectedCrawlSpeedPresetKey(payload);
  els.crawlSpeedPresetRow?.querySelectorAll("[data-crawl-speed-preset]").forEach((button) => {
    button.classList.toggle("active", button.dataset.crawlSpeedPreset === selectedKey);
  });
  if (els.crawlSpeedPreview) {
    const detailText = `상세 ${payload.detailRankRanges || "1-10"}위`;
    els.crawlSpeedPreview.textContent = `${detailText} · 예상 ${formatElapsed(preview.estimatedTotalSeconds)} · 완료 ${formatClockTime(preview.estimatedCompleteAt)}`;
  }
}

function applyCrawlSpeedPreset(key = "") {
  const preset = crawlSpeedPresetOptions().find((row) => row.key === key);
  if (!preset) return;
  if (els.collectionModeInput) els.collectionModeInput.value = preset.collectionMode;
  if (els.detailRankRangesInput) {
    els.detailRankRangesInput.value = preset.range;
    els.detailRankRangesInput.disabled = false;
  }
  syncCollectionModeInputs();
  updateCrawlSpeedPreview();
  if (els.crawlStatus) {
    const payload = currentCrawlFormPayload();
    const preview = crawlPreviewMeta(payload);
    const detailText = `상세 ${payload.detailRankRanges || "1-10"}위`;
    els.crawlStatus.textContent = `${preset.label} 프리셋 적용 · ${detailText} · 예상 ${formatElapsed(preview.estimatedTotalSeconds)} · ${preset.note}`;
  }
}

function syncCollectionModeInputs() {
  if (!els.collectionModeInput || !els.detailRankRangesInput) return;
  els.collectionModeInput.value = "precision";
  els.detailRankRangesInput.disabled = false;
  els.detailRankRangesInput.placeholder = "예: 1-10, 1-20, 10-20";
  if (!els.detailRankRangesInput.value.trim()) els.detailRankRangesInput.value = "1-10";
  updateCrawlSpeedPreview();
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

const BROAD_REGION_BASES = new Set([
  "경남", "경상남도", "경남도", "경북", "경상북도", "경북도", "경기", "경기도", "경기북부", "경기남부", "수도권", "서울근교",
  "강원", "강원도", "제주", "제주도", "전북", "전라북도", "전북특별자치도", "전남", "전라남도",
  "충남", "충청남도", "충북", "충청북도", "서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종"
]);

const REGION_BASE_ALIASES = {
  경상남: "경남",
  경상남도: "경남",
  경남도: "경남",
  경상북: "경북",
  경상북도: "경북",
  경북도: "경북",
  경기도: "경기",
  전라북: "전북",
  전라북도: "전북",
  전북특별자치: "전북",
  전북특별자치도: "전북",
  전라남: "전남",
  전라남도: "전남",
  충청남: "충남",
  충청남도: "충남",
  충청북: "충북",
  충청북도: "충북",
  강원도: "강원",
  제주도: "제주"
};

function compactCrawlKeyword(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "");
}

function normalizedRegionBase(value) {
  const raw = compactCrawlKeyword(value);
  const base = raw.replace(/(특별자치도|광역시|특별시|특별자치시|자치도|자치시|시|군|구|도)$/u, "");
  return REGION_BASE_ALIASES[base] || REGION_BASE_ALIASES[raw] || base || raw;
}

function regionalGlampingKeywordBase(value) {
  const compact = compactCrawlKeyword(value);
  const glamping = "글램핑";
  if (!compact.endsWith(glamping)) return "";
  const base = compact.slice(0, -glamping.length);
  if (!base || base.length > 10) return "";
  const withoutAdminSuffix = normalizedRegionBase(base);
  return REGIONAL_GLAMPING_BASES.has(base) || REGIONAL_GLAMPING_BASES.has(withoutAdminSuffix) ? withoutAdminSuffix : "";
}

function looksLikeRegionalGlampingKeyword(value) {
  return Boolean(regionalGlampingKeywordBase(value));
}

function correctedSearchMode(keyword, mode) {
  return mode === "company" && looksLikeRegionalGlampingKeyword(keyword) ? "keyword" : mode;
}

function currentRole() {
  return state.session?.role === "b2b" ? "b2b" : "admin";
}

function isAdminRole() {
  return currentRole() === "admin";
}

function roleTabs() {
  return ROLE_TABS[currentRole()] || ROLE_TABS.admin;
}

function roleAllowsTab(tab) {
  return roleTabs().includes(tab);
}

function firstRoleTab() {
  return roleTabs()[0] || "report";
}

function tabLabel(tab) {
  return !isAdminRole() && B2B_TAB_LABELS[tab] ? B2B_TAB_LABELS[tab] : (TAB_LABELS[tab] || "요약 리포트");
}

function setPanelHeading(panel, title, description) {
  const root = document.querySelector(`[data-panel="${panel}"] .section-title`);
  const heading = root?.querySelector("h2");
  const copy = root?.querySelector("p");
  if (heading) heading.textContent = title;
  if (copy) copy.textContent = description;
}

function syncRoleStaticLabels() {
  if (isAdminRole()) {
    setPanelHeading("rank", "업체 순위", "네이버 플레이스 노출순으로 비교");
    setPanelHeading("map", "지역 클러스터 지도", "시군구 경계 · 업체 스팟 · 검색량 · 판매율");
    setPanelHeading("demand", "수요구조 분석", "숙박업 메인터넌스 사전과 검색수요를 함께 해석");
    return;
  }
  setPanelHeading("rank", "경쟁업체 노출", "네이버 상위 노출 경쟁업체의 매출·판매율 표본 비교");
  setPanelHeading("map", "지역 경쟁 지도", "지역 내·인접 경쟁권과 네이버 반경 노출 구조");
  setPanelHeading("demand", "수요 전망", "검색량·12개월 추세·피크 월로 보는 월별 예상 검색량");
}

function applyRoleUi() {
  const allowedTabs = new Set(roleTabs());
  if (!allowedTabs.has(state.activeTab)) state.activeTab = firstRoleTab();
  document.body.classList.toggle("role-b2b", !isAdminRole());
  document.body.classList.toggle("role-admin", isAdminRole());
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const allowed = allowedTabs.has(button.dataset.tab);
    button.hidden = !allowed;
    button.classList.toggle("active", allowed && button.dataset.tab === state.activeTab);
    if (allowed) button.textContent = tabLabel(button.dataset.tab);
  });
  document.querySelectorAll("[data-drawer-tab]").forEach((button) => {
    button.hidden = !allowedTabs.has(button.dataset.drawerTab);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    const allowed = allowedTabs.has(panel.dataset.panel);
    panel.hidden = !allowed;
    panel.classList.toggle("active", allowed && panel.dataset.panel === state.activeTab);
  });
  const roleLabel = state.session?.roleLabel || (isAdminRole() ? "관리자" : "B2B");
  if (els.adminStatus) {
    els.adminStatus.textContent = `${roleLabel} 모드`;
  }
  syncRoleStaticLabels();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) {
    const error = new Error(data.error || `요청 실패: ${response.status}`);
    error.status = response.status;
    if (response.status === 401 && !url.includes("/api/logout")) {
      location.replace("/login");
    } else if (response.status === 403) {
      setStatus("권한 없음");
    }
    throw error;
  }
  return data;
}

function setStatus(text) {
  if (els.adminStatus) els.adminStatus.textContent = text;
}

function ensureCrawlControls() {
  if (!els.crawlForm) return;

  if (!els.searchModeInput) {
    const keywordLabel = els.keywordInput?.closest(".field");
    const modeLabel = document.createElement("label");
    modeLabel.className = "field";
    modeLabel.innerHTML = `
      <span>수집 모드</span>
      <select id="searchModeInput">
        <option value="keyword">키워드/권역</option>
        <option value="company">업체명</option>
      </select>
    `;
    keywordLabel?.after(modeLabel);
    els.searchModeInput = modeLabel.querySelector("#searchModeInput");
  }

  if (!els.crawlProgress) {
    const submitButton = els.crawlForm.querySelector('button[type="submit"]');
    const progress = document.createElement("div");
    progress.className = "crawl-progress";
    progress.id = "crawlProgress";
    progress.hidden = true;
    progress.innerHTML = `
      <span class="crawl-spinner" aria-hidden="true"></span>
      <div class="crawl-progress-copy">
        <strong id="crawlProgressTitle">수집 준비</strong>
        <small id="crawlProgressText">네이버·NOL·떠나요를 확인합니다.</small>
      </div>
      <div class="crawl-progress-stages" id="crawlProgressStages" aria-label="수집 단계"></div>
      <div class="crawl-progress-meter" aria-hidden="true"><span id="crawlProgressBar"></span></div>
      <div class="crawl-progress-numbers" aria-label="수집 예상 시간">
        <span><b id="crawlProgressPercent">예측중</b><small>진행률</small></span>
        <span><b id="crawlProgressElapsed">0초</b><small>경과</small></span>
        <span><b id="crawlProgressRemaining">계산 중</b><small>남은 시간</small></span>
        <span><b id="crawlProgressEta">--:--</b><small>완료 예정</small></span>
      </div>
      <small class="crawl-progress-basis" id="crawlProgressBasis">조건 기반 예상값입니다.</small>
    `;
    submitButton?.after(progress);
    els.crawlProgress = progress;
    els.crawlProgressTitle = progress.querySelector("#crawlProgressTitle");
    els.crawlProgressText = progress.querySelector("#crawlProgressText");
    els.crawlProgressBar = progress.querySelector("#crawlProgressBar");
    els.crawlProgressPercent = progress.querySelector("#crawlProgressPercent");
    els.crawlProgressElapsed = progress.querySelector("#crawlProgressElapsed");
    els.crawlProgressRemaining = progress.querySelector("#crawlProgressRemaining");
    els.crawlProgressEta = progress.querySelector("#crawlProgressEta");
    els.crawlProgressBasis = progress.querySelector("#crawlProgressBasis");
    els.crawlProgressStages = progress.querySelector("#crawlProgressStages");
  }
}

function searchModeLabel(value) {
  return value === "company" ? "업체명" : "키워드/권역";
}

function formatClockTime(value) {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}

function crawlEstimateBasisText(basis = {}) {
  if (!basis || !Object.keys(basis).length) return "조건 기반 예상값입니다.";
  const range = Number(basis.bookingRangeDays) > 1
    ? `${fmtNumber(basis.bookingRangeDays)}일 · 상세 대상 중 최대 ${fmtNumber(basis.bookingRangePlaceLimit)}개`
    : "1일 기준";
  const detail = basis.collectionMode === "fast" ? "상세 생략" : `상세 ${basis.detailRankRanges || "1-10"}위`;
  const timing = basis.timing || {};
  const timingText = timing.source === "measured"
    ? `예상 기준: 최근 유사 수집 ${fmtNumber(timing.sampleCount)}건 평균 ${formatElapsed(timing.averageSeconds)}`
    : "예상 기준: 조건 모델";
  return `${basis.collectionModeLabel || "정밀 분석"} · ${basis.searchModeLabel || "수집"} · ${basis.productModeLabel || "전체"} · ${detail} · ${range} · ${timingText}`;
}

function crawlStageFallbacks() {
  return [
    { key: "rank", label: "순위", status: "active", progress: 0 },
    { key: "inventory", label: "재고/가격", status: "pending", progress: 0 },
    { key: "save", label: "저장", status: "pending", progress: 0 }
  ];
}

function crawlPreviewMeta(payload = {}) {
  const days = Math.max(1, Math.min(31, bookingDays(payload) || DEFAULT_BOOKING_DAYS));
  const placeLimit = days > 1 ? 10 : 0;
  const fast = payload.collectionMode === "fast";
  const searchSeconds = payload.searchMode === "company" ? 55 : 95;
  const trendSeconds = payload.searchMode === "keyword" ? 25 : 10;
  const productSeconds = fast ? 0 : (payload.productMode === "all" ? 45 : 26);
  const rangeSeconds = !fast && placeLimit
    ? placeLimit * days * (payload.productMode === "all" ? 5.5 : 4.2)
    : 0;
  const regionalSeconds = fast ? 0 : 80;
  const otaSeconds = fast ? 0 : 35;
  const ioSeconds = fast ? 18 : 35;
  const stages = [
    { key: "rank", label: "순위 수집", seconds: searchSeconds, detail: "네이버 플레이스 순위와 업체 기본 정보를 정리합니다." },
    { key: "trend", label: "수요 확인", seconds: trendSeconds, detail: "검색수요와 트렌드 캐시를 확인합니다." },
    fast
      ? { key: "inventory", label: "상세 생략", seconds: 6, detail: "빠른 순위 모드라 날짜별 재고와 가격 확인을 건너뜁니다." }
      : { key: "inventory", label: "재고/가격 확인", seconds: productSeconds + rangeSeconds, detail: `상세 ${payload.detailRankRanges || "1-10"}위의 날짜별 수량과 요일별 가격을 확인합니다.` },
    !fast ? { key: "ota", label: "보조 채널", seconds: otaSeconds + regionalSeconds, detail: "OTA 보조 신호와 지역 수요 데이터를 정리합니다." } : null,
    { key: "save", label: "저장/분석", seconds: ioSeconds, detail: "결과 파일, 누적 DB, 업체 마스터를 갱신합니다." }
  ].filter(Boolean).map((stage, index) => ({
    ...stage,
    seconds: Math.max(4, Math.round(stage.seconds || 0)),
    status: index === 0 ? "active" : "pending",
    progress: index === 0 ? 1 : 0
  }));
  const stagedSeconds = stages.reduce((sum, stage) => sum + stage.seconds, 0);
  const estimatedTotalSeconds = Math.max(fast ? 45 : 90, stagedSeconds);
  if (stages.length && estimatedTotalSeconds > stagedSeconds) {
    stages[stages.length - 1].seconds += estimatedTotalSeconds - stagedSeconds;
  }
  return {
    elapsedSeconds: 0,
    remainingSeconds: estimatedTotalSeconds,
    estimatedTotalSeconds,
    estimatedProgress: 1,
    estimatedCompleteAt: new Date(Date.now() + estimatedTotalSeconds * 1000).toISOString(),
    currentStage: stages[0] || null,
    stages,
    estimateBasis: {
      searchMode: payload.searchMode,
      searchModeLabel: searchModeLabel(payload.searchMode),
      productMode: payload.productMode,
      productModeLabel: productModeLabel(payload.productMode),
      collectionMode: payload.collectionMode,
      collectionModeLabel: collectionModeLabel(payload.collectionMode),
      detailRankRanges: payload.detailRankRanges,
      bookingRangeDays: days,
      bookingRangePlaceLimit: placeLimit
    }
  };
}

function b2bSearchStageRows(preview = {}, elapsedSeconds = 0) {
  const stages = Array.isArray(preview.stages) && preview.stages.length ? preview.stages : crawlStageFallbacks();
  const totalSeconds = stages.reduce((sum, stage) => sum + Math.max(1, Number(stage.seconds || 0)), 0);
  if (elapsedSeconds >= totalSeconds) {
    return stages.map((stage, index) => ({
      ...stage,
      status: index === stages.length - 1 ? "active" : "done",
      progress: index === stages.length - 1 ? 99 : 100
    }));
  }
  let cursor = 0;
  return stages.map((stage) => {
    const seconds = Math.max(1, Number(stage.seconds || 0));
    const start = cursor;
    const end = cursor + seconds;
    cursor = end;
    if (elapsedSeconds >= end) return { ...stage, status: "done", progress: 100 };
    if (elapsedSeconds >= start) {
      const progress = Math.max(1, Math.min(99, ((elapsedSeconds - start) / seconds) * 100));
      return { ...stage, status: "active", progress };
    }
    return { ...stage, status: "pending", progress: 0 };
  });
}

function b2bSearchProgressMeta() {
  const preview = state.b2bSearchPreview || crawlPreviewMeta(b2bLiveSearchPayload(state.b2bSearchQuery || "지역글램핑"));
  const startedAt = Number(state.b2bSearchStartedAt || Date.now());
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const total = Math.max(1, Number(preview.estimatedTotalSeconds || 1));
  const delayedSeconds = Math.max(0, elapsedSeconds - total);
  const remainingSeconds = Math.max(0, Math.ceil(total - elapsedSeconds));
  const stages = b2bSearchStageRows(preview, elapsedSeconds);
  const currentStage = stages.find((stage) => stage.status === "active") || stages.at(-1) || null;
  const estimatedProgress = delayedSeconds
    ? 99
    : Math.max(4, Math.min(98, (elapsedSeconds / total) * 100));
  return {
    ...preview,
    elapsedSeconds,
    remainingSeconds,
    delayedSeconds,
    isDelayed: delayedSeconds > 0,
    estimatedProgress,
    currentStage,
    stages
  };
}

function b2bSearchProgressText(meta = b2bSearchProgressMeta()) {
  if (meta.isDelayed) return `예상 초과 ${formatElapsed(meta.delayedSeconds) || "확인 중"}`;
  return meta.remainingSeconds <= 0 ? "곧 완료" : `${formatElapsed(meta.remainingSeconds)} 남음`;
}

function b2bSearchProgressHtml(meta = b2bSearchProgressMeta()) {
  const percent = Math.max(4, Math.min(99, Math.round(Number(meta.estimatedProgress || 0))));
  return `
    <div class="b2b-live-progress ${meta.isDelayed ? "delayed" : ""}">
      <div class="b2b-live-progress-head">
        <strong>${escapeHtml(`${percent}%`)}</strong>
        <small>${escapeHtml(b2bSearchProgressText(meta))}</small>
      </div>
      <div class="b2b-live-progress-track" aria-label="검색 진행률">
        <i style="width:${percent}%"></i>
      </div>
      <div class="b2b-live-time">
        <em>경과 <b>${escapeHtml(formatElapsed(meta.elapsedSeconds) || "0초")}</b></em>
        <em>남은시간 <b>${escapeHtml(b2bSearchProgressText(meta))}</b></em>
        <em>완료예상 <b>${escapeHtml(formatClockTime(meta.estimatedCompleteAt))}</b></em>
      </div>
      <div class="b2b-live-stages">
        ${(meta.stages || []).map((stage) => `
          <i class="${escapeHtml(stage.status || "pending")}">
            <b>${escapeHtml(stage.label || "단계")}</b>
            <small>${escapeHtml(crawlStageStatusText(stage))}</small>
          </i>
        `).join("")}
      </div>
    </div>
  `;
}

function clearB2BSearchTimer() {
  if (!state.b2bSearchTimer) return;
  clearInterval(state.b2bSearchTimer);
  state.b2bSearchTimer = null;
}

function startB2BSearchTimer() {
  clearB2BSearchTimer();
  state.b2bSearchTimer = setInterval(() => {
    if (!state.b2bSearchLoading) {
      clearB2BSearchTimer();
      return;
    }
    renderB2BSearchPanel();
  }, 1000);
}

function crawlEstimatePayloadFromPlan(plan = {}) {
  return {
    keyword: plan.keyword || activeKeyword(),
    checkIn: plan.checkIn || els.checkInInput?.value || "",
    checkOut: plan.checkOut || els.checkOutInput?.value || "",
    searchMode: plan.searchMode || "keyword",
    productMode: plan.productMode || "all",
    collectionMode: plan.collectionMode || "precision",
    detailRankRanges: plan.detailRankRanges || plan.range || "1-10"
  };
}

function crawlEtaKey(plan = {}) {
  const payload = crawlEstimatePayloadFromPlan(plan);
  return [
    payload.keyword,
    payload.checkIn,
    payload.checkOut,
    payload.searchMode,
    payload.productMode,
    payload.collectionMode,
    payload.detailRankRanges
  ].map((value) => String(value || "").trim()).join("|");
}

function crawlEtaForPlan(plan = {}) {
  const key = crawlEtaKey(plan);
  return state.crawlEtaByKey[key] || crawlPreviewMeta(crawlEstimatePayloadFromPlan(plan));
}

function crawlEtaSourceText(eta = {}) {
  const timing = eta.estimateBasis?.timing || {};
  if (timing.source === "measured") return `최근 유사 ${fmtNumber(timing.sampleCount)}건`;
  return "조건 모델";
}

function crawlEtaShortText(eta = {}) {
  const seconds = Number(eta.estimatedTotalSeconds);
  return Number.isFinite(seconds) ? formatElapsed(seconds) : "계산 대기";
}

function recrawlContextMatchesPayload(context = {}, payload = {}) {
  if (!context?.key) return false;
  return context.key === crawlEtaKey(crawlEstimatePayloadFromPlan(payload));
}

function recrawlContextStatusText(context = {}) {
  if (!context?.type) return "";
  const count = Number(context.count || 0);
  const label = context.type === "batch" ? "묶음 재수집" : "재수집";
  const names = Array.isArray(context.companyNames) ? context.companyNames.slice(0, 2).join(", ") : "";
  const suffix = count > 2 ? ` 외 ${fmtNumber(count - 2)}개` : "";
  return `${label}${count ? ` ${fmtNumber(count)}개` : ""}${names ? ` · ${names}${suffix}` : ""}`;
}

function crawlStageStatusText(stage = {}) {
  if (stage.status === "done") return "완료";
  if (stage.status === "active") {
    const progress = Number(stage.progress);
    return Number.isFinite(progress) ? `${Math.max(1, Math.min(99, Math.round(progress)))}%` : "진행";
  }
  return "대기";
}

function renderCrawlStages(meta = {}) {
  if (!els.crawlProgressStages) return;
  const rows = Array.isArray(meta.stages) && meta.stages.length ? meta.stages : crawlStageFallbacks();
  els.crawlProgressStages.innerHTML = rows.map((stage) => `
    <span class="${escapeHtml(stage.status || "pending")}">
      <b>${escapeHtml(stage.label || "단계")}</b>
      <small>${escapeHtml(crawlStageStatusText(stage))}</small>
    </span>
  `).join("");
}

function crawlCurrentStageText(meta = {}) {
  const stage = meta.currentStage || {};
  if (!stage.label) return "";
  const progress = Number(stage.progress);
  const progressText = Number.isFinite(progress) ? ` ${Math.max(1, Math.min(99, Math.round(progress)))}%` : "";
  return `${stage.label}${progressText}`;
}

function updateCrawlProgressNumbers(meta = {}) {
  const percent = Number(meta.estimatedProgress);
  const elapsed = Number(meta.elapsedSeconds);
  const remaining = Number(meta.remainingSeconds);
  const hasPercent = Number.isFinite(percent);
  const width = hasPercent ? Math.max(5, Math.min(99, percent)) : 8;
  if (els.crawlProgressBar) els.crawlProgressBar.style.width = `${width}%`;
  if (els.crawlProgressPercent) els.crawlProgressPercent.textContent = hasPercent ? `${Math.round(percent)}%` : "예측중";
  if (els.crawlProgressElapsed) els.crawlProgressElapsed.textContent = formatElapsed(elapsed) || "0초";
  if (els.crawlProgressRemaining) {
    els.crawlProgressRemaining.textContent = meta.isDelayed
      ? `지연 ${formatElapsed(meta.delayedSeconds) || "확인 중"}`
      : (Number.isFinite(remaining)
          ? (remaining <= 0 ? "곧 완료" : formatElapsed(remaining))
          : "계산 중");
  }
  if (els.crawlProgressEta) els.crawlProgressEta.textContent = formatClockTime(meta.estimatedCompleteAt);
  if (els.crawlProgressBasis) els.crawlProgressBasis.textContent = crawlEstimateBasisText(meta.estimateBasis);
  renderCrawlStages(meta);
}

function setCrawlProgress(active, title = "", text = "", meta = {}) {
  if (!els.crawlProgress) return;
  els.crawlProgress.hidden = !active;
  els.crawlProgress.classList.toggle("is-delayed", Boolean(active && meta.isDelayed));
  if (title && els.crawlProgressTitle) els.crawlProgressTitle.textContent = title;
  if (text && els.crawlProgressText) els.crawlProgressText.textContent = text;
  if (active) updateCrawlProgressNumbers(meta);
}

function formatElapsed(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  if (hours) return `${hours}시간 ${Math.max(0, minutes - hours * 60)}분`;
  return minutes ? `${minutes}분 ${rest}초` : `${rest}초`;
}

function clearCrawlStatusTimer() {
  if (!state.crawlStatusTimer) return;
  clearTimeout(state.crawlStatusTimer);
  state.crawlStatusTimer = null;
}

function scheduleCrawlStatusPoll(delay = 5000, notifyIdle = false) {
  clearCrawlStatusTimer();
  state.crawlStatusTimer = setTimeout(() => pollCrawlStatusUntilIdle(notifyIdle), delay);
}

function crawlEstimateInlineText(status = {}) {
  const percent = Number(status.estimatedProgress);
  const remaining = Number(status.remainingSeconds);
  const eta = formatClockTime(status.estimatedCompleteAt);
  const stage = crawlCurrentStageText(status);
  const parts = [];
  if (status.isDelayed) parts.push(`지연 ${formatElapsed(status.delayedSeconds) || "확인 중"}`);
  if (stage) parts.push(stage);
  if (Number.isFinite(percent)) parts.push(`예상 ${Math.round(percent)}%`);
  if (Number.isFinite(remaining)) parts.push(`남은 ${remaining <= 0 ? "곧 완료" : formatElapsed(remaining)}`);
  if (eta !== "--:--") parts.push(`완료 ${eta}`);
  return parts.join(" · ");
}

async function pollCrawlStatusUntilIdle(notifyIdle = false) {
  clearCrawlStatusTimer();
  try {
    const status = await fetchJson("/api/crawl-status");
    if (status.active) {
      const elapsed = formatElapsed(status.elapsedSeconds);
      const estimate = crawlEstimateInlineText(status);
      const stage = status.currentStage || {};
      const delayed = Boolean(status.isDelayed);
      const recrawlText = recrawlContextStatusText(status.recrawlContext);
      setCrawlProgress(
        true,
        delayed ? "예상보다 지연 중" : (stage.label ? `${stage.label} 진행 중` : "수집 진행 중"),
        delayed
          ? `예상 완료 시간을 ${formatElapsed(status.delayedSeconds) || "초과"} 넘겼습니다. 마지막 단계와 저장 처리를 계속 확인하고 있습니다.`
          : `${recrawlText ? `${recrawlText} · ` : ""}${stage.detail || `네이버·NOL·떠나요를 확인하고 있습니다${elapsed ? ` · ${elapsed} 경과` : ""}${estimate ? ` · ${estimate}` : ""}.`}`,
        status
      );
      if (els.crawlStatus) {
        els.crawlStatus.textContent = delayed
          ? `수집이 예상보다 오래 걸리고 있습니다${recrawlText ? ` · ${recrawlText}` : ""}${elapsed ? ` (${elapsed} 경과)` : ""}${estimate ? ` · ${estimate}` : ""}. 완료되면 결과를 자동 갱신합니다.`
          : `수집이 진행 중입니다${recrawlText ? ` · ${recrawlText}` : ""}${elapsed ? ` (${elapsed} 경과)` : ""}${estimate ? ` · ${estimate}` : ""}. 완료되면 결과를 자동 갱신합니다.`;
      }
      setStatus("수집 중");
      scheduleCrawlStatusPoll(Number(status.remainingSeconds) <= 60 ? 5000 : 10000, true);
      return;
    }
    setCrawlProgress(false);
    setStatus("준비");
    if (notifyIdle && els.crawlStatus) els.crawlStatus.textContent = "진행 중인 수집이 끝났습니다. 결과를 갱신했습니다.";
    await loadRuns(true);
  } catch (error) {
    if (els.crawlStatus) els.crawlStatus.textContent = `수집 상태 확인 실패: ${error.message}`;
  }
}

function activeKeyword() {
  const run = state.data?.run;
  const label = run?.label || "";
  if (run?.keyword) return run.keyword;
  const fromLabel = label.split("·")[0]?.trim();
  return fromLabel || els.keywordInput?.value?.trim() || "글램핑";
}

function spacedGlampingKeyword(value) {
  const text = String(value || "").trim();
  if (/글램핑$/.test(text) && !/\s글램핑$/.test(text)) return text.replace(/글램핑$/, " 글램핑");
  return text;
}

function yeogiSearchUrl() {
  const run = state.data?.run || {};
  const url = new URL("https://www.yeogi.com/domestic-accommodations");
  url.searchParams.set("freeForm", "true");
  url.searchParams.set("keyword", spacedGlampingKeyword(activeKeyword()));
  url.searchParams.set("searchType", "KEYWORD");
  if (run.checkIn) url.searchParams.set("checkIn", run.checkIn);
  if (run.checkOut) url.searchParams.set("checkOut", run.checkOut);
  url.searchParams.set("personal", "2");
  return url.toString();
}

function companyKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

function compactSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function locationClusterCodes(card = {}) {
  return String(card.primaryCluster || "")
    .split("+")
    .map((code) => code.trim())
    .filter(Boolean);
}

function locationClusterMeta(code) {
  return (state.dictionary?.clusters || []).find((cluster) => cluster.code === code) || { code, name: code };
}

function locationGroupCards(group = {}) {
  const keys = group.children || [];
  const cards = state.dictionary?.cards || [];
  return keys
    .map((key) => cards.find((card) => card.regionKey === key))
    .filter(Boolean);
}

function averageLocationIndexes(cards = []) {
  const buckets = new Map();
  cards.forEach((card) => {
    Object.entries(card.indexes || {}).forEach(([key, index]) => {
      const bucket = buckets.get(key) || {
        key,
        label: index.label,
        shortLabel: index.shortLabel,
        total: 0,
        count: 0
      };
      const value = Number(index.value);
      if (Number.isFinite(value)) {
        bucket.total += value;
        bucket.count += 1;
      }
      buckets.set(key, bucket);
    });
  });
  return [...buckets.values()].map((bucket) => ({
    label: bucket.label,
    shortLabel: bucket.shortLabel,
    value: bucket.count ? Math.round(bucket.total / bucket.count) : 0
  }));
}

function regionGroupScore(group = {}, cards = []) {
  const cardScores = cards
    .map(weightedLocationScore)
    .filter(Number.isFinite);
  const localScore = cardScores.length
    ? Math.round(cardScores.reduce((sum, score) => sum + score, 0) / cardScores.length)
    : 0;
  const marketScore = Number(group.marketSignal);
  if (!Number.isFinite(marketScore)) return localScore || NaN;
  if (!localScore) return Math.round(marketScore);
  return Math.round(marketScore * 0.3 + localScore * 0.7);
}

function stripLocationBusinessWords(value) {
  return compactSearchText(value)
    .replace(/글램핑|카라반|캠핑장|캠핑|캠프닉|데이유즈|펜션|풀빌라|리조트|호텔|스테이|빌리지|야영장|오토캠핑/g, "")
    .replace(/특별자치도|특별자치시|광역시|특별시|자치도|자치시/g, "")
    .replace(/(도|시|군|구|읍|면|동)$/g, "");
}

function locationMatchScore(query, values = [], exactOnly = false) {
  const queryFull = compactSearchText(query);
  const queryBase = stripLocationBusinessWords(query);
  if (!queryFull) return 0;
  let best = 0;
  values.filter(Boolean).forEach((value) => {
    const candidateFull = compactSearchText(value);
    const candidateBase = stripLocationBusinessWords(value);
    if (!candidateFull) return;
    if (queryFull === candidateFull) best = Math.max(best, 100);
    if (queryBase && candidateBase && queryBase === candidateBase) best = Math.max(best, 94);
    if (exactOnly) return;
    if (candidateFull.length >= 2 && (queryFull.includes(candidateFull) || candidateFull.includes(queryFull))) {
      best = Math.max(best, 84);
    }
    if (candidateBase.length >= 2 && queryBase && (queryBase.includes(candidateBase) || candidateBase.includes(queryBase))) {
      best = Math.max(best, 74);
    }
  });
  return best;
}

function bestLocationGroupMatch(query, exactOnly = false) {
  return (state.dictionary?.regionGroups || [])
    .map((group) => ({
      group,
      score: locationMatchScore(query, [group.searchKeyword, group.sido, ...(group.aliases || [])], exactOnly)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function bestLocationCardMatch(query, exactOnly = false) {
  const aliases = state.dictionary?.aliases || [];
  return (state.dictionary?.cards || [])
    .map((card) => {
      const alias = aliases.find((item) => item.regionKey === card.regionKey) || null;
      const directValues = [card.searchKeyword, alias?.searchKeyword, alias?.sigungu];
      const values = exactOnly ? directValues : [...directValues, ...(alias?.aliases || [])];
      return {
        card,
        alias,
        score: locationMatchScore(query, values, exactOnly)
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function locationDictionaryMatchForQuery(query) {
  if (!state.dictionary) return null;
  const groupExact = bestLocationGroupMatch(query, true);
  if (groupExact?.score >= 94) {
    return { card: null, group: groupExact.group, alias: null, reason: "group-exact" };
  }

  const cardExact = bestLocationCardMatch(query, true);
  if (cardExact?.score >= 94) {
    return { card: cardExact.card, group: null, alias: cardExact.alias, reason: "card-exact" };
  }

  const cardMatch = bestLocationCardMatch(query, false);
  if (cardMatch?.score >= 74) {
    return { card: cardMatch.card, group: null, alias: cardMatch.alias, reason: "card-match" };
  }

  const groupMatch = bestLocationGroupMatch(query, false);
  if (groupMatch?.score >= 74) {
    return { card: null, group: groupMatch.group, alias: null, reason: "group-match" };
  }

  return null;
}

function locationGroupForQuery(query) {
  const dictionary = state.dictionary;
  const compact = compactSearchText(query);
  if (!dictionary || !compact) return null;
  const regionOnly = compact.replace(/글램핑|카라반|캠핑장|캠핑|펜션/g, "");
  return (dictionary.regionGroups || []).find((group) => {
    const candidates = [
      group.searchKeyword,
      group.sido,
      ...(group.aliases || [])
    ].map(compactSearchText).filter(Boolean);
    return candidates.some((candidate) => {
      const candidateRegion = candidate.replace(/글램핑|카라반|캠핑장|캠핑|펜션|도|특별자치도/g, "");
      return compact.includes(candidate) ||
        candidate.includes(compact) ||
        (regionOnly && (candidate.includes(regionOnly) || regionOnly.includes(candidateRegion)));
    });
  }) || null;
}

function locationScoreBand(value, index = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return ["unknown", "확인"];
  const reverse = /경쟁|확장|주의/.test(`${index.label || ""}${index.shortLabel || ""}`);
  if (reverse) {
    if (number >= 70) return ["risk", "주의"];
    if (number >= 50) return ["mid", "중"];
    return ["strong", "낮음"];
  }
  if (number >= 70) return ["strong", "강"];
  if (number >= 50) return ["mid", "중"];
  return ["weak", "약"];
}

function locationCardForQuery(query) {
  const dictionary = state.dictionary;
  if (!dictionary) return { card: null, group: null, alias: null, reason: "loading" };
  const compact = compactSearchText(query);
  if (!compact) return { card: null, group: null, alias: null, reason: "empty" };

  const orderedMatch = locationDictionaryMatchForQuery(query);
  if (orderedMatch) return orderedMatch;

  const matchedGroup = locationGroupForQuery(query);
  if (matchedGroup) return { card: null, group: matchedGroup, alias: null, reason: "group" };

  const aliases = dictionary.aliases || [];
  const cards = dictionary.cards || [];
  const matchedAlias = aliases.find((alias) => {
    const candidates = [
      alias.searchKeyword,
      alias.sigungu,
      ...(alias.aliases || [])
    ].map(compactSearchText).filter(Boolean);
    const regionOnly = compact.replace(/글램핑|카라반|캠핑장|캠핑|펜션/g, "");
    return candidates.some((candidate) => {
      const candidateRegion = candidate.replace(/글램핑|카라반|캠핑장|캠핑|펜션|시|군|구/g, "");
      return compact.includes(candidate) ||
        candidate.includes(compact) ||
        (regionOnly && (candidate.includes(regionOnly) || regionOnly.includes(candidateRegion)));
    });
  });

  const card = matchedAlias
    ? cards.find((item) => item.regionKey === matchedAlias.regionKey)
    : cards.find((item) => compactSearchText(item.searchKeyword) === compact || compact.includes(compactSearchText(item.searchKeyword)));

  return { card: card || null, alias: matchedAlias || null, reason: card ? "matched" : "missing" };
}

function locationCardRequestStatusMeta(status) {
  const map = {
    requested: { label: "개발 요청됨", tone: "requested", note: "지역카드 개발 큐에 저장됐습니다." },
    temporary: { label: "임시 카드", tone: "temporary", note: "현재 수집 결과 기준으로 임시 판단합니다." },
    ignored: { label: "이번에는 제외", tone: "ignored", note: "정식 카드 개발에서 일단 제외됐습니다." },
    linked: { label: "유사 지역 연결", tone: "linked", note: "기존 지역카드와 연결해 판단합니다." }
  };
  return map[status] || { label: "신규 지역 후보", tone: "new", note: "정식 지역카드 개발 여부를 선택하세요." };
}

function locationCandidateKey(candidate = {}) {
  return compactSearchText(candidate.key || candidate.regionBase || candidate.keyword || "");
}

function locationCardRequestForCandidate(candidate = {}) {
  const key = locationCandidateKey(candidate);
  return key ? state.locationCardRequests?.requests?.[key] || null : null;
}

function locationCandidateFromQuery(query) {
  const keyword = String(query || activeKeyword() || "").trim();
  if (!keyword) return null;
  const regionalBase = regionalGlampingKeywordBase(keyword);
  const strippedBase = stripLocationBusinessWords(keyword);
  const regionBase = regionalBase || strippedBase;
  const hasBusinessWord = /글램핑|카라반|캠핑|펜션/.test(keyword);
  if (!regionBase || regionBase.length < 2 || regionBase.length > 12 || (!regionalBase && !hasBusinessWord)) return null;

  const alias = {
    sigungu: regionBase,
    aliases: [regionBase, `${regionBase}글램핑`, `${regionBase} 글램핑`]
  };
  const runtime = locationRuntimeStats({ searchKeyword: keyword }, alias);
  const sales = runtime.sales || {};
  const evidence = {
    itemCount: runtime.items?.length || 0,
    regionCount: runtime.regions?.length || 0,
    salesSupply: sales.supply || 0,
    salesSold: sales.sold || 0,
    targetCount: runtime.targets?.length || 0,
    searchVolume: runtime.searchVolume || 0,
    platformGap: runtime.platformGap || 0,
    sampleCompanies: (runtime.items || []).map((item) => item.name).filter(Boolean).slice(0, 5)
  };
  return {
    key: compactSearchText(regionBase || keyword),
    keyword,
    searchKeyword: keyword,
    regionBase,
    runtime,
    evidence,
    runId: state.activeRunId || state.data?.run?.id || "",
    activeKeyword: activeKeyword()
  };
}

function renderLocationCandidateEvidence(candidate = {}) {
  const evidence = candidate.evidence || {};
  const salesRate = evidence.salesSupply ? fmtRate(evidence.salesSold / evidence.salesSupply) : "확인필요";
  return `
    <div class="location-candidate-evidence">
      <div><span>상위노출</span><strong>${fmtNumber(evidence.itemCount)}</strong><small>업체</small></div>
      <div><span>판매율</span><strong>${salesRate}</strong><small>${fmtNumber(evidence.salesSold)}/${fmtNumber(evidence.salesSupply)}개</small></div>
      <div><span>검색량</span><strong>${evidence.searchVolume ? fmtNumber(evidence.searchVolume) : "API"}</strong><small>${evidence.searchVolume ? "월검색량" : "확인필요"}</small></div>
      <div><span>타깃후보</span><strong>${fmtNumber(evidence.targetCount)}</strong><small>영업 후보</small></div>
      <div><span>지역근거</span><strong>${fmtNumber(evidence.regionCount)}</strong><small>수집 지역 row</small></div>
      <div><span>채널공백</span><strong>${fmtNumber(evidence.platformGap)}</strong><small>OTA 보완 신호</small></div>
    </div>
  `;
}

function renderLocationCandidateTemporary(candidate = {}) {
  const runtime = candidate.runtime || {};
  const targets = (runtime.targets || []).slice(0, 3);
  const sampleCompanies = candidate.evidence?.sampleCompanies || [];
  return `
    <section class="location-block location-candidate-temp">
      <div class="location-block-head">
        <h4>임시 지역카드</h4>
        <span>현재 수집 결과만 사용</span>
      </div>
      <div class="location-meta-row">
        ${(sampleCompanies.length ? sampleCompanies : ["대표 업체 수집 후 표시"]).map((name) => `<span>${escapeHtml(name)}</span>`).join("")}
      </div>
      <div class="location-action-panel">
        <span><b>1</b> 정식 카드 전까지 현재 run 기준으로 판단</span>
        <span><b>2</b> 수집 결과가 반복되면 개발 요청으로 승격</span>
        <span><b>3</b> 영업타깃은 판단큐 근거 확인 후 분리</span>
      </div>
      <div class="location-target-list">
        ${targets.length ? targets.map(({ item, reasons }, index) => `
          <button class="location-target-row" type="button" data-open-company="${(state.data?.availability?.items || []).indexOf(item)}">
            <b>${index + 1}</b>
            <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
            <span>${reasons.map(escapeHtml).slice(0, 3).join(" · ")}</span>
          </button>
        `).join("") : `<div class="location-empty-note">아직 임시 카드에서 바로 볼 영업타깃 후보가 없습니다.</div>`}
      </div>
    </section>
  `;
}

function renderMissingLocationCandidate(query, cards = []) {
  const candidate = locationCandidateFromQuery(query);
  const saved = candidate ? locationCardRequestForCandidate(candidate) : null;
  const status = locationCardRequestStatusMeta(saved?.status);
  const knownCards = cards.slice(0, 6).map((item) => item.searchKeyword).filter(Boolean);
  if (!candidate) {
    return `
      <article class="location-card empty-location">
        <h3>저장된 카드가 없는 검색어입니다</h3>
        <p>지역 키워드로 확인되면 신규 지역 후보로 표시됩니다. 현재 등록 카드: ${knownCards.map(escapeHtml).join(", ") || "없음"}</p>
      </article>
    `;
  }
  return `
    <article class="location-card empty-location location-candidate-card ${escapeHtml(status.tone)}">
      <div class="location-hero">
        <div>
          <p class="eyebrow">신규 지역 후보 · ${escapeHtml(status.label)}</p>
          <h3>${escapeHtml(candidate.keyword)}</h3>
          <p>정식 지역카드가 없습니다. 현재 수집 근거를 보고 지역카드 개발 여부를 선택하세요.</p>
        </div>
        <div class="location-score">
          <strong>${fmtNumber(candidate.evidence.itemCount)}</strong>
          <span>수집 업체</span>
        </div>
      </div>
      <div class="location-meta-row">
        <span>감지 지역 ${escapeHtml(candidate.regionBase)}</span>
        <span>상태 ${escapeHtml(status.label)}</span>
        ${saved?.relatedRegion ? `<span>연결 ${escapeHtml(saved.relatedRegion)}</span>` : ""}
        ${saved?.updatedAt ? `<span>처리 ${escapeHtml(saved.updatedAt.slice(0, 10))}</span>` : ""}
      </div>
      <section class="location-decision caution">
        <div class="location-decision-score">
          <span>판단</span>
          <strong>?</strong>
        </div>
        <div class="location-decision-copy">
          <p class="eyebrow">지역카드 개발 확인</p>
          <h4>이 지역을 정식 카드로 개발할까요?</h4>
          <p>${escapeHtml(status.note)} 수집 데이터가 충분하지 않으면 임시 카드로만 보고, 반복 검색되거나 업체 근거가 쌓이면 개발 요청으로 전환합니다.</p>
          <div class="location-action-chips">
            <span>월검색량 ${candidate.evidence.searchVolume ? fmtNumber(candidate.evidence.searchVolume) : "확인필요"}</span>
            <span>영업후보 ${fmtNumber(candidate.evidence.targetCount)}</span>
            <span>채널공백 ${fmtNumber(candidate.evidence.platformGap)}</span>
          </div>
        </div>
      </section>
      ${renderLocationCandidateEvidence(candidate)}
      <div class="location-candidate-actions" data-location-candidate-key="${escapeHtml(candidate.key)}">
        <button class="secondary-button" type="button" data-location-candidate-action="temporary">임시 카드로 보기</button>
        <button class="primary-button" type="button" data-location-candidate-action="requested">지역카드 개발 요청</button>
        <button class="secondary-button" type="button" data-location-candidate-action="linked">유사 지역에 연결</button>
        <button class="ghost-button" type="button" data-location-candidate-action="ignored">이번에는 제외</button>
      </div>
      ${saved?.status === "temporary" ? renderLocationCandidateTemporary(candidate) : ""}
      <section class="location-block">
        <div class="location-block-head">
          <h4>현재 등록 카드</h4>
          <span>${fmtNumber(cards.length)}개 중 일부</span>
        </div>
        <div class="location-meta-row">
          ${knownCards.map((name) => `<span>${escapeHtml(name)}</span>`).join("") || "<span>등록 카드 없음</span>"}
        </div>
      </section>
    </article>
  `;
}

async function saveLocationCardCandidateAction(button) {
  const status = button?.dataset?.locationCandidateAction || "";
  const query = els.dictionarySearchInput?.value?.trim() || activeKeyword();
  const candidate = locationCandidateFromQuery(query);
  if (!candidate || !status) return;
  let relatedRegion = "";
  if (status === "linked") {
    relatedRegion = window.prompt("연결할 기존 지역카드 검색어를 입력하세요.", "") || "";
    if (!relatedRegion.trim()) return;
  }
  const label = locationCardRequestStatusMeta(status).label;
  button.disabled = true;
  setStatus(`${label} 저장 중`);
  try {
    state.locationCardRequests = await fetchJson("/api/location-card-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: candidate.key,
        keyword: candidate.keyword,
        searchKeyword: candidate.searchKeyword,
        regionBase: candidate.regionBase,
        status,
        relatedRegion,
        runId: candidate.runId,
        activeKeyword: candidate.activeKeyword,
        evidence: candidate.evidence
      })
    });
    setStatus(`${label} 저장 완료`);
    renderLocationDictionary();
  } catch (error) {
    setStatus(`${label} 저장 실패`);
    els.dictionaryResult?.insertAdjacentHTML("afterbegin", `<div class="empty">지역 후보 저장 실패: ${escapeHtml(error.message)}</div>`);
  } finally {
    button.disabled = false;
  }
}

function locationCardRequestItems() {
  const source = state.locationCardRequests || {};
  const items = Array.isArray(source.items) ? source.items : Object.values(source.requests || {});
  const order = { requested: 0, temporary: 1, linked: 2, ignored: 3 };
  return items
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const statusDiff = (order[a.status] ?? 9) - (order[b.status] ?? 9);
      if (statusDiff) return statusDiff;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
}

function locationRequestEvidenceText(evidence = {}) {
  const salesRate = evidence.salesSupply ? fmtRate(evidence.salesSold / evidence.salesSupply) : "판매 확인필요";
  return [
    `업체 ${fmtNumber(evidence.itemCount || 0)}`,
    salesRate,
    `검색량 ${evidence.searchVolume ? fmtNumber(evidence.searchVolume) : "확인필요"}`,
    `타깃 ${fmtNumber(evidence.targetCount || 0)}`,
    `공백 ${fmtNumber(evidence.platformGap || 0)}`
  ].join(" · ");
}

function renderLocationCardRequestQueue() {
  const items = locationCardRequestItems();
  if (!items.length) return "";
  const counts = items.reduce((acc, item) => {
    acc[item.status || "new"] = (acc[item.status || "new"] || 0) + 1;
    return acc;
  }, {});
  const countText = [
    counts.requested ? `개발요청 ${fmtNumber(counts.requested)}` : "",
    counts.temporary ? `임시 ${fmtNumber(counts.temporary)}` : "",
    counts.linked ? `연결 ${fmtNumber(counts.linked)}` : "",
    counts.ignored ? `제외 ${fmtNumber(counts.ignored)}` : ""
  ].filter(Boolean).join(" · ");
  return `
    <section class="location-request-queue">
      <div class="location-block-head">
        <h4>지역카드 개발 큐</h4>
        <span>${escapeHtml(countText || `${fmtNumber(items.length)}개 후보`)}</span>
      </div>
      <div class="location-request-list">
        ${items.slice(0, 8).map((item) => {
          const meta = locationCardRequestStatusMeta(item.status);
          const key = item.key || locationCandidateKey(item);
          const title = item.searchKeyword || item.keyword || item.regionBase || key || "지역 후보";
          return `
            <article class="location-request-row ${escapeHtml(meta.tone)}">
              <div>
                <strong>${escapeHtml(title)}</strong>
                <small>${escapeHtml([item.regionBase ? `지역 ${item.regionBase}` : "", meta.label, item.updatedAt ? item.updatedAt.slice(0, 10) : ""].filter(Boolean).join(" · "))}</small>
                <p>${escapeHtml(locationRequestEvidenceText(item.evidence || {}))}</p>
              </div>
              <div class="location-request-actions">
                <button class="ghost-button" type="button" data-location-query="${escapeHtml(title)}">열기</button>
                <button class="secondary-button" type="button" data-location-request-key="${escapeHtml(key)}" data-location-request-action="temporary">임시</button>
                <button class="primary-button" type="button" data-location-request-key="${escapeHtml(key)}" data-location-request-action="requested">개발</button>
                <button class="secondary-button" type="button" data-location-request-key="${escapeHtml(key)}" data-location-request-action="linked">연결</button>
                <button class="ghost-button" type="button" data-location-request-key="${escapeHtml(key)}" data-location-request-action="ignored">제외</button>
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

async function saveLocationCardRequestQueueAction(button) {
  const key = button?.dataset?.locationRequestKey || "";
  const status = button?.dataset?.locationRequestAction || "";
  const request = key ? state.locationCardRequests?.requests?.[key] || locationCardRequestItems().find((item) => item.key === key) : null;
  if (!request || !status) return;
  let relatedRegion = request.relatedRegion || "";
  if (status === "linked") {
    relatedRegion = window.prompt("연결할 기존 지역카드 검색어를 입력하세요.", relatedRegion || "") || "";
    if (!relatedRegion.trim()) return;
  }
  const label = locationCardRequestStatusMeta(status).label;
  button.disabled = true;
  setStatus(`${label} 저장 중`);
  try {
    state.locationCardRequests = await fetchJson("/api/location-card-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...request,
        key,
        status,
        relatedRegion,
        evidence: request.evidence || {},
        note: request.note || `지역카드 개발 큐에서 ${label} 처리`
      })
    });
    setStatus(`${label} 저장 완료`);
    renderLocationDictionary();
  } catch (error) {
    setStatus(`${label} 저장 실패`);
    els.dictionaryResult?.insertAdjacentHTML("afterbegin", `<div class="empty">지역카드 큐 저장 실패: ${escapeHtml(error.message)}</div>`);
  } finally {
    button.disabled = false;
  }
}

function platformTone(platform = "") {
  const text = String(platform);
  if (text.includes("네이버")) return "naver";
  if (text.includes("여기")) return "yeogi";
  if (text.includes("떠나") || text.includes("ONDA")) return "ddnayo";
  if (text.includes("야놀자") || text.includes("NOL")) return "nol";
  return "other";
}

function platformShortName(platform = "") {
  const text = String(platform);
  if (text.includes("네이버")) return "네이버";
  if (text.includes("여기")) return "여기어때";
  if (text.includes("떠나") || text.includes("ONDA")) return "떠나요";
  if (text.includes("야놀자") || text.includes("NOL")) return "야놀자";
  return text || "기타";
}

function platformLetter(platform = "") {
  const name = platformShortName(platform);
  if (name === "네이버") return "N";
  if (name === "여기어때") return "여";
  if (name === "야놀자") return "야";
  if (name === "떠나요") return "떠";
  return "기";
}

function externalPlatformUrl(url) {
  const text = String(url || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

function platformRowUrl(row = {}, item = {}) {
  return externalPlatformUrl(row.url || row.link || row.href || (platformShortName(row.platform) === "네이버" ? item.url : ""));
}

function companyPlatformMap() {
  const map = new Map();
  for (const company of state.data?.companyPlatforms || []) {
    const keys = [company.key, company.name].map(companyKey).filter(Boolean);
    keys.forEach((key) => map.set(key, company));
  }
  return map;
}

function platformsForItem(item) {
  const map = companyPlatformMap();
  const key = companyKey(item.name);
  let company = map.get(key);
  if (!company && key) {
    company = [...map.entries()].find(([candidate]) => (
      candidate === key ||
      (candidate.length >= 4 && key.includes(candidate)) ||
      (key.length >= 4 && candidate.includes(key))
    ))?.[1];
  }
  const rows = company?.platforms ? [...company.platforms] : [];
  if (!rows.length && item.url) {
    rows.push({
      platform: "네이버",
      status: "노출",
      price: item.price,
      url: item.url
    });
  }

  const seen = new Set();
  return rows.filter((row) => {
    const name = platformShortName(row.platform);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function platformChips(item) {
  const rows = platformsForItem(item).slice(0, 4);
  if (!rows.length) return `<span class="platform-chip"><b class="platform-dot">?</b>확인필요</span>`;
  return rows.map((row) => {
    const tone = platformTone(row.platform);
    const name = platformShortName(row.platform);
    const url = platformRowUrl(row, item);
    const content = `<b class="platform-dot">${platformLetter(row.platform)}</b>${escapeHtml(name)}`;
    return url
      ? `<a class="platform-chip ${tone}" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(`${name}에서 ${item.name || "업체"} 보기`)}">${content}</a>`
      : `<span class="platform-chip ${tone}">${content}</span>`;
  }).join("");
}

function weeklyRows(item = {}, kind = "lodging") {
  const detail = String(kind === "day" ? item.dayUseWeeklyReservationRateDetail || "" : item.weeklyReservationRateDetail || "");
  if (!detail) return [];
  return detail.split(/\s*,\s*/).map((entry) => {
    const match = entry.match(/^(\d{1,2}\/\d{1,2})\s+(\d+)%\((\d+)\/(\d+)\)$/);
    if (!match) return null;
    return {
      label: normalizeMonthDayLabel(match[1]),
      rate: Number(match[2]) / 100,
      sold: Number(match[3]),
      total: Number(match[4])
    };
  }).filter(Boolean);
}

function activeManualCorrection(item = {}) {
  const correction = item.companyManualCorrection || item.companyProfile?.manualCorrection || {};
  return manualCorrectionHasBasis(correction);
}

function manualCorrectionHasValue(correction = {}) {
  if (!correction || correction.active === false) return false;
  const lodging = finiteNumber(correction.lodgingBasisTotal, 0);
  const dayUse = finiteNumber(correction.dayUseBasisTotal, 0);
  const note = String(correction.note || "").trim();
  return manualCorrectionHasBasis(correction) || note.length > 0;
}

function manualCorrectionHasBasis(correction = {}) {
  if (!correction || correction.active === false) return false;
  const lodging = finiteNumber(correction.lodgingBasisTotal, 0);
  const dayUse = finiteNumber(correction.dayUseBasisTotal, 0);
  return lodging > 0 || dayUse > 0;
}

function basisTotalForRows(rows = [], explicitBasis = 0, authoritative = false) {
  const basis = finiteNumber(explicitBasis, 0);
  if (authoritative && basis > 0) return basis;
  return Math.max(
    0,
    basis,
    ...rows.map((row) => finiteNumber(row.total, 0))
  );
}

function offlineSoldForTotal(basisTotal, rawTotal) {
  return Math.max(0, finiteNumber(basisTotal, 0) - finiteNumber(rawTotal, 0));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : NaN;
}

function projectedRevenueFields(revenue, pricedSoldOut, missingPriceSoldOut, adjustedRevenue, missingPriceEstimatedRevenue, precisionRate) {
  const baseRevenue = Number.isFinite(revenue) ? revenue : 0;
  const priced = Number.isFinite(pricedSoldOut) ? pricedSoldOut : 0;
  const missing = Number.isFinite(missingPriceSoldOut) ? missingPriceSoldOut : 0;
  const avg = priced ? Math.round(baseRevenue / priced) : null;
  const fallbackGap = avg && missing ? avg * missing : 0;
  const gap = Number.isFinite(missingPriceEstimatedRevenue) ? missingPriceEstimatedRevenue : fallbackGap;
  const adjusted = Number.isFinite(adjustedRevenue) ? adjustedRevenue : baseRevenue + gap;
  const totalSold = priced + missing;
  const precision = Number.isFinite(precisionRate)
    ? precisionRate
    : (totalSold ? priced / totalSold : NaN);
  return {
    adjustedRevenue: adjusted,
    missingPriceEstimatedRevenue: gap,
    revenuePrecisionRate: precision
  };
}

function salesStats(item = {}, kind = "lodging") {
  const run = state.data?.run || {};
  const days = bookingDays(run);
  const basisDate = monthDay(run.checkIn) || "기준일";
  if (kind === "lodging") {
    const rows = weeklyRows(item);
    const weeklySold = finiteNumber(item.weeklyTotalSoldOut, NaN);
    const weeklySupply = finiteNumber(item.weeklyTotalStock, NaN);
    if (Number.isFinite(weeklySold) && Number.isFinite(weeklySupply) && weeklySupply > 0) {
      const basisTotal = finiteNumber(item.weeklyOperatingTotal, finiteNumber(item.weeklyBasisTotal, 0));
      const normalizedSupply = basisTotal && rows.length ? basisTotal * rows.length : weeklySupply;
      const offlineSold = offlineSoldForTotal(normalizedSupply, weeklySupply);
      const sold = Math.min(normalizedSupply, weeklySold + offlineSold);
      return {
        sold,
        supply: normalizedSupply,
        rawSupply: weeklySupply,
        rawSold: weeklySold,
        offlineSold,
        rate: normalizedSupply ? sold / normalizedSupply : weeklySold / weeklySupply,
        unit: "개",
        label: `${rows.length || days}일 집계`,
        basis: "range"
      };
    }
    if (rows.length) {
      const basisTotal = basisTotalForRows(rows, item.weeklyOperatingTotal || item.weeklyBasisTotal, activeManualCorrection(item));
      const sum = rows.reduce((acc, row) => {
        const rawTotal = finiteNumber(row.total, 0);
        const offlineSold = offlineSoldForTotal(basisTotal, rawTotal);
        acc.sold += Math.min(basisTotal || rawTotal, finiteNumber(row.sold) + offlineSold);
        acc.rawSold += finiteNumber(row.sold);
        acc.offlineSold += offlineSold;
        acc.supply += basisTotal || rawTotal;
        acc.rawSupply += rawTotal;
        return acc;
      }, { sold: 0, rawSold: 0, offlineSold: 0, supply: 0, rawSupply: 0 });
      return { ...sum, rate: sum.supply ? sum.sold / sum.supply : NaN, unit: "개", label: `${rows.length}일 집계`, basis: "range" };
    }
    const total = finiteNumber(item.nightTotalStock, finiteNumber(item.totalRooms, 0));
    const available = finiteNumber(item.nightAvailableStock, finiteNumber(item.availableRooms, total));
    const sold = Math.max(0, total - available);
    return { sold, supply: total, rate: total ? sold / total : NaN, unit: "개", label: `${basisDate} 기준`, basis: "basis" };
  }

  const rows = weeklyRows(item, "day");
  const weeklySold = finiteNumber(item.dayUseWeeklyTotalSoldOut, NaN);
  const weeklySupply = finiteNumber(item.dayUseWeeklyTotalStock, NaN);
  if (Number.isFinite(weeklySold) && Number.isFinite(weeklySupply) && weeklySupply > 0) {
    const basisTotal = finiteNumber(item.dayUseWeeklyOperatingTotal, finiteNumber(item.dayUseWeeklyBasisTotal, 0));
    const normalizedSupply = basisTotal && rows.length ? basisTotal * rows.length : weeklySupply;
    const offlineSold = offlineSoldForTotal(normalizedSupply, weeklySupply);
    const sold = Math.min(normalizedSupply, weeklySold + offlineSold);
    return {
      sold,
      supply: normalizedSupply,
      rawSupply: weeklySupply,
      rawSold: weeklySold,
      offlineSold,
      rate: normalizedSupply ? sold / normalizedSupply : weeklySold / weeklySupply,
      unit: "회",
      label: `${rows.length || days}일 집계`,
      basis: "range"
    };
  }
  if (rows.length) {
    const basisTotal = basisTotalForRows(rows, item.dayUseWeeklyOperatingTotal || item.dayUseWeeklyBasisTotal, activeManualCorrection(item));
    const sum = rows.reduce((acc, row) => {
      const rawTotal = finiteNumber(row.total, 0);
      const offlineSold = offlineSoldForTotal(basisTotal, rawTotal);
      acc.sold += Math.min(basisTotal || rawTotal, finiteNumber(row.sold) + offlineSold);
      acc.rawSold += finiteNumber(row.sold);
      acc.offlineSold += offlineSold;
      acc.supply += basisTotal || rawTotal;
      acc.rawSupply += rawTotal;
      return acc;
    }, { sold: 0, rawSold: 0, offlineSold: 0, supply: 0, rawSupply: 0 });
    return { ...sum, rate: sum.supply ? sum.sold / sum.supply : NaN, unit: "회", label: `${rows.length}일 집계`, basis: "range" };
  }
  const total = finiteNumber(item.dayUseTotalStock, 0);
  const available = finiteNumber(item.dayUseAvailableStock, total);
  const sold = Math.max(0, total - available);
  return { sold, supply: total, rate: total ? sold / total : NaN, unit: "회", label: `${basisDate} 기준`, basis: "basis" };
}

function salesLine(item, kind = "lodging") {
  const stats = salesStats(item, kind);
  if (!stats.supply) {
    return kind === "lodging" ? "숙박 재고 확인필요" : "데이유즈/캠프닉 없음";
  }
  const name = kind === "lodging" ? "숙박" : "데이유즈";
  return `${name} ${stats.label} ${fmtNumber(stats.sold)}/${fmtNumber(stats.supply)}${stats.unit} 추정 · ${fmtRate(stats.rate)}`;
}

function summarizeSales(items = []) {
  return items.reduce((acc, item) => {
    const lodging = salesStats(item, "lodging");
    const day = salesStats(item, "day");
    acc.sold += finiteNumber(lodging.sold);
    acc.supply += finiteNumber(lodging.supply);
    acc.daySold += finiteNumber(day.sold);
    acc.daySupply += finiteNumber(day.supply);
    return acc;
  }, { sold: 0, supply: 0, daySold: 0, daySupply: 0 });
}

function itemRevenueStats(item = {}, kind = "lodging") {
  const sales = salesStats(item, kind === "day" ? "day" : "lodging");
  const unit = kind === "day" ? "회" : "개";
  const weeklyRevenue = optionalNumber(kind === "day" ? item.dayUseWeeklyEstimatedRevenue : item.weeklyEstimatedRevenue);
  const weeklyAdjusted = optionalNumber(kind === "day" ? item.dayUseWeeklyAdjustedRevenue : item.weeklyAdjustedRevenue);
  const weeklyGapRevenue = optionalNumber(kind === "day" ? item.dayUseWeeklyMissingPriceEstimatedRevenue : item.weeklyMissingPriceEstimatedRevenue);
  const weeklyPrecisionRate = optionalNumber(kind === "day" ? item.dayUseWeeklyRevenuePrecisionRate : item.weeklyRevenuePrecisionRate);
  const weeklyPriced = optionalNumber(kind === "day" ? item.dayUseWeeklyPricedSoldOut : item.weeklyPricedSoldOut);
  const weeklyMissing = optionalNumber(kind === "day" ? item.dayUseWeeklyMissingPriceSoldOut : item.weeklyMissingPriceSoldOut);
  const weeklyAvg = optionalNumber(kind === "day" ? item.dayUseWeeklyAvgSoldUnitPrice : item.weeklyAvgSoldUnitPrice);
  const weeklyDetail = kind === "day" ? item.dayUseWeeklyRevenueDetail : item.weeklyRevenueDetail;
  const weeklyByDay = kind === "day" ? item.dayUseWeeklyRevenueByDayType : item.weeklyRevenueByDayType;
  const weeklyOffline = kind === "day" ? item.dayUseWeeklyOfflineReservationDetail : item.weeklyOfflineReservationDetail;
  const hasWeekly = [weeklyRevenue, weeklyAdjusted, weeklyGapRevenue, weeklyPrecisionRate, weeklyPriced, weeklyMissing, weeklyAvg].some(Number.isFinite);
  if (hasWeekly) {
    const revenue = Number.isFinite(weeklyRevenue) ? weeklyRevenue : 0;
    const pricedSoldOut = Number.isFinite(weeklyPriced) ? weeklyPriced : 0;
    const missingPriceSoldOut = Number.isFinite(weeklyMissing) ? weeklyMissing : 0;
    const projected = projectedRevenueFields(revenue, pricedSoldOut, missingPriceSoldOut, weeklyAdjusted, weeklyGapRevenue, weeklyPrecisionRate);
    return {
      revenue,
      adjustedRevenue: projected.adjustedRevenue,
      missingPriceEstimatedRevenue: projected.missingPriceEstimatedRevenue,
      revenuePrecisionRate: projected.revenuePrecisionRate,
      pricedSoldOut,
      missingPriceSoldOut,
      avgSoldUnitPrice: Number.isFinite(weeklyAvg) ? weeklyAvg : null,
      label: sales.label || "기간 집계",
      unit,
      detail: weeklyDetail || "",
      byDayType: weeklyByDay || "",
      offlineDetail: weeklyOffline || "",
      basis: "range"
    };
  }

  const basisRevenue = optionalNumber(kind === "day" ? item.basisDayUseRevenue : item.basisLodgingRevenue);
  const basisAdjusted = optionalNumber(kind === "day" ? item.basisDayUseAdjustedRevenue : item.basisLodgingAdjustedRevenue);
  const basisGapRevenue = optionalNumber(kind === "day" ? item.basisDayUseMissingPriceEstimatedRevenue : item.basisLodgingMissingPriceEstimatedRevenue);
  const basisPrecisionRate = optionalNumber(kind === "day" ? item.basisDayUseRevenuePrecisionRate : item.basisLodgingRevenuePrecisionRate);
  const basisPriced = optionalNumber(kind === "day" ? item.basisDayUsePricedSoldOut : item.basisLodgingPricedSoldOut);
  const basisMissing = optionalNumber(kind === "day" ? item.basisDayUseMissingPriceSoldOut : item.basisLodgingMissingPriceSoldOut);
  const basisAvg = optionalNumber(kind === "day" ? item.basisDayUseAvgSoldUnitPrice : item.basisLodgingAvgSoldUnitPrice);
  const hasBasis = [basisRevenue, basisAdjusted, basisGapRevenue, basisPrecisionRate, basisPriced, basisMissing, basisAvg].some(Number.isFinite);
  if (hasBasis) {
    const revenue = Number.isFinite(basisRevenue) ? basisRevenue : 0;
    const pricedSoldOut = Number.isFinite(basisPriced) ? basisPriced : 0;
    const missingPriceSoldOut = Number.isFinite(basisMissing) ? basisMissing : 0;
    const projected = projectedRevenueFields(revenue, pricedSoldOut, missingPriceSoldOut, basisAdjusted, basisGapRevenue, basisPrecisionRate);
    return {
      revenue,
      adjustedRevenue: projected.adjustedRevenue,
      missingPriceEstimatedRevenue: projected.missingPriceEstimatedRevenue,
      revenuePrecisionRate: projected.revenuePrecisionRate,
      pricedSoldOut,
      missingPriceSoldOut,
      avgSoldUnitPrice: Number.isFinite(basisAvg) ? basisAvg : null,
      label: sales.label || "기준일",
      unit,
      detail: "",
      byDayType: "",
      offlineDetail: "",
      basis: "basis"
    };
  }

  return {
    revenue: 0,
    adjustedRevenue: 0,
    missingPriceEstimatedRevenue: 0,
    revenuePrecisionRate: NaN,
    pricedSoldOut: 0,
    missingPriceSoldOut: 0,
    avgSoldUnitPrice: null,
    label: "가격 수집 필요",
    unit,
    detail: "",
    byDayType: "",
    offlineDetail: "",
    basis: "missing"
  };
}

function revenueParsedCount(match) {
  if (!match) return 0;
  const value = String(match[1] || "").replace(/,/g, "");
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function revenueDayTypeRows(revenue = {}) {
  const text = String(revenue.byDayType || "").trim();
  const unit = revenue.unit || "";
  const order = ["평일", "금요일", "토요일", "일요일"];
  if (!text) return [];
  return text.split(/\s*,\s*/).map((entry) => {
    const match = entry.match(/^(평일|금요일|토요일|일요일)\s+(.+?)\((.*)\)$/);
    if (!match) return null;
    const detail = match[3] || "";
    const countMatch = detail.match(new RegExp(`([\\d,]+)\\s*${unit || "[개회]"}`));
    const offlineMatch = detail.match(/오프라인\s+([\d,]+)/);
    const missingMatch = detail.match(/가격누락\s+([\d,]+)/);
    return {
      label: match[1],
      revenueText: match[2],
      pricedSoldOut: revenueParsedCount(countMatch),
      offlineReserved: revenueParsedCount(offlineMatch),
      missingPriceSoldOut: revenueParsedCount(missingMatch),
      detail,
      unit,
      order: order.indexOf(match[1])
    };
  }).filter(Boolean).sort((a, b) => a.order - b.order);
}

function revenueProductRows(item = {}) {
  const rows = Array.isArray(item.itemDetails) ? item.itemDetails : [];
  return rows.map((row, index) => {
    const saleType = String(row.saleType || row.bizItemSubType || "").trim();
    const kind = /데이|day|캠프닉/i.test(saleType) ? "day" : "lodging";
    const stock = optionalNumber(row.stock);
    const available = optionalNumber(row.available);
    const bookingCount = finiteNumber(row.bookingCount, 0) + finiteNumber(row.occupiedBookingCount, 0);
    const sold = Number.isFinite(stock) && Number.isFinite(available)
      ? Math.max(0, stock - available)
      : bookingCount;
    return {
      key: row.bizItemId || `${row.name || "상품"}-${index}`,
      name: row.name || "상품명 확인",
      kind,
      kindLabel: kind === "day" ? "데이유즈/캠프닉" : "숙박",
      stock: Number.isFinite(stock) ? stock : null,
      available: Number.isFinite(available) ? available : null,
      sold,
      price: optionalNumber(row.price),
      quantityKnown: Number.isFinite(stock) || Number.isFinite(available)
    };
  });
}

function revenuePrecisionProfile(item = {}, lodging = itemRevenueStats(item, "lodging"), dayUse = itemRevenueStats(item, "day")) {
  const totalRevenue = finiteNumber(lodging.revenue) + finiteNumber(dayUse.revenue);
  const totalAdjustedRevenue = finiteNumber(lodging.adjustedRevenue) + finiteNumber(dayUse.adjustedRevenue);
  const totalMissingPriceEstimatedRevenue = finiteNumber(lodging.missingPriceEstimatedRevenue) + finiteNumber(dayUse.missingPriceEstimatedRevenue);
  const priced = finiteNumber(lodging.pricedSoldOut) + finiteNumber(dayUse.pricedSoldOut);
  const missing = finiteNumber(lodging.missingPriceSoldOut) + finiteNumber(dayUse.missingPriceSoldOut);
  const soldQuantity = priced + missing;
  const coverage = soldQuantity ? priced / soldQuantity : NaN;
  const confidence = inventoryConfidenceInfo(item);
  const structure = inventoryStructureInfo(item);
  const productRows = revenueProductRows(item);
  const productKnown = productRows.length > 0 || finiteNumber(item.countedItemCount, 0) + finiteNumber(item.nightItemCount, 0) + finiteNumber(item.dayUseItemCount, 0) > 0;
  const hasDayType = revenueDayTypeRows(lodging).length > 0 || revenueDayTypeRows(dayUse).length > 0;
  const rangeBasis = lodging.basis === "range" || dayUse.basis === "range";
  let score = 42;
  if ((totalAdjustedRevenue || totalRevenue) > 0) score += 12;
  if (rangeBasis) score += 14;
  if (hasDayType) score += 12;
  if (productKnown) score += 9;
  if (Number.isFinite(coverage)) score += Math.round(coverage * 18);
  if (["A", "B"].includes(confidence.grade)) score += 8;
  if (["D", "E"].includes(confidence.grade)) score -= 12;
  if (structure.type === "unknown" || structure.type === "grouped_stock") score -= 8;
  if (missing > 0) score -= Math.min(20, missing * 3);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 86 ? "A" : score >= 72 ? "B" : score >= 58 ? "C" : score >= 42 ? "D" : "E";
  const tone = ["A", "B"].includes(grade) ? "good" : grade === "C" ? "watch" : "bad";
  const reasons = [
    rangeBasis ? "기간 기준 수집" : "기준일 중심",
    hasDayType ? "평일/금/토/일 분리" : "요일별 매출 대기",
    productKnown ? "상품별 수량 확인" : "상품별 수량 미확보",
    Number.isFinite(coverage) ? `가격확보 ${fmtRate(coverage)}` : "가격확보 대기",
    missing ? `가격누락 ${fmtNumber(missing)}개/회` : "가격누락 없음",
    confidence.grade ? `수량 신뢰도 ${confidence.grade}` : ""
  ].filter(Boolean);
  return {
    score,
    grade,
    tone,
    label: grade === "A" ? "매출 신뢰 높음" : grade === "B" ? "매출 신뢰 양호" : grade === "C" ? "보완 필요" : "정밀 확인 필요",
    coverage,
    totalRevenue,
    totalAdjustedRevenue,
    totalMissingPriceEstimatedRevenue,
    priced,
    missing,
    soldQuantity,
    productKnown,
    hasDayType,
    rangeBasis,
    reasons
  };
}

function preciseRevenueProfile(item = {}) {
  const lodging = itemRevenueStats(item, "lodging");
  const dayUse = itemRevenueStats(item, "day");
  const precision = revenuePrecisionProfile(item, lodging, dayUse);
  return {
    lodging,
    dayUse,
    precision,
    totalRevenue: finiteNumber(lodging.revenue) + finiteNumber(dayUse.revenue),
    totalAdjustedRevenue: finiteNumber(lodging.adjustedRevenue) + finiteNumber(dayUse.adjustedRevenue),
    totalMissingPriceEstimatedRevenue: finiteNumber(lodging.missingPriceEstimatedRevenue) + finiteNumber(dayUse.missingPriceEstimatedRevenue),
    lodgingDayRows: revenueDayTypeRows(lodging),
    dayUseDayRows: revenueDayTypeRows(dayUse),
    productRows: revenueProductRows(item)
  };
}

function summarizeRevenue(items = []) {
  return items.reduce((acc, item) => {
    const lodging = itemRevenueStats(item, "lodging");
    const day = itemRevenueStats(item, "day");
    acc.revenue += finiteNumber(lodging.revenue);
    acc.adjustedRevenue += finiteNumber(lodging.adjustedRevenue);
    acc.missingPriceEstimatedRevenue += finiteNumber(lodging.missingPriceEstimatedRevenue);
    acc.pricedSoldOut += finiteNumber(lodging.pricedSoldOut);
    acc.missingPriceSoldOut += finiteNumber(lodging.missingPriceSoldOut);
    acc.dayRevenue += finiteNumber(day.revenue);
    acc.dayAdjustedRevenue += finiteNumber(day.adjustedRevenue);
    acc.dayMissingPriceEstimatedRevenue += finiteNumber(day.missingPriceEstimatedRevenue);
    acc.dayPricedSoldOut += finiteNumber(day.pricedSoldOut);
    acc.dayMissingPriceSoldOut += finiteNumber(day.missingPriceSoldOut);
    return acc;
  }, {
    revenue: 0,
    adjustedRevenue: 0,
    missingPriceEstimatedRevenue: 0,
    pricedSoldOut: 0,
    missingPriceSoldOut: 0,
    dayRevenue: 0,
    dayAdjustedRevenue: 0,
    dayMissingPriceEstimatedRevenue: 0,
    dayPricedSoldOut: 0,
    dayMissingPriceSoldOut: 0
  });
}

function priceText(value) {
  const text = String(value || "").trim();
  if (!text) return "가격 확인";
  return text.includes("~") ? text : `${text}~`;
}

function priceMeta(item = {}) {
  const hasLodging = finiteNumber(item.nightItemCount, 0) > 0 || finiteNumber(item.nightTotalStock, 0) > 0;
  const hasDayUse = finiteNumber(item.dayUseItemCount, 0) > 0 || finiteNumber(item.dayUseTotalStock, 0) > 0;
  let label = "표시 최저가";
  if (hasLodging && hasDayUse) label = "전체상품 최저";
  else if (hasLodging) label = "숙박 최저가";
  else if (hasDayUse) label = "데이유즈 최저";
  return { label, value: priceText(item.price) };
}

function priceBlock(item = {}) {
  const meta = priceMeta(item);
  return `
    <div class="price-block" title="${escapeHtml(`${meta.label}: ${meta.value}`)}">
      <span>${escapeHtml(meta.label)}</span>
      <strong class="price">${escapeHtml(meta.value)}</strong>
    </div>
  `;
}

function companyRankInsight(item = {}, fallbackRank = 0) {
  const linked = inventoryLinked(item);
  const lodging = salesStats(item, "lodging");
  const day = salesStats(item, "day");
  const impact = itemQueueRevenueImpact(item);
  const revenue = effectiveRevenueValue(impact);
  const supply = finiteNumber(lodging.supply, 0);
  const sold = finiteNumber(lodging.sold, 0);
  const hasInventory = linked || supply > 0 || sold > 0;
  const remaining = Math.max(0, supply - sold);
  const rate = lodging.supply ? lodging.rate : NaN;
  const dayUseKnown = finiteNumber(day.supply, 0) > 0;
  const rank = finiteNumber(item.rank || item.overallRank || fallbackRank, fallbackRank);
  let tone = "neutral";
  let label = "관찰";
  if (hasInventory && Number.isFinite(rate)) {
    if (rate >= B2B_HIGH_RESERVATION_RATE) {
      tone = "hot";
      label = B2B_HIGH_RESERVATION_LABEL;
    } else if (rate <= B2B_LOW_RESERVATION_RATE) {
      tone = "watch";
      label = B2B_LOW_RESERVATION_LABEL;
    } else if (remaining >= Math.max(3, Math.ceil(supply * 0.35))) {
      tone = "strong";
      label = "경쟁 여지";
    } else {
      tone = "good";
      label = "정상 흐름";
    }
  } else if (!hasInventory) {
    tone = "rank";
    label = "노출 확인";
  }
  return {
    linked,
    hasInventory,
    rank,
    tone,
    label,
    lodging,
    day,
    sold,
    supply,
    remaining,
    rate,
    dayUseKnown,
    revenue,
    revenueNote: revenueAdjustmentNote(impact),
    precision: impact.precision || {},
    productGap: hasInventory && !dayUseKnown,
    metricText: hasInventory && supply ? fmtRate(rate) : `${fmtNumber(rank)}위`,
    metricLabel: hasInventory && supply ? "객실 판매율" : "네이버 노출",
    stockText: hasInventory && supply ? `${fmtNumber(sold)}/${fmtNumber(supply)} 객실` : (item.bookingStatus || "예약 상세 대기")
  };
}

function companyRankInsightGrid(insight = {}) {
  const cells = [
    ["예상 매출", insight.revenue ? fmtWon(insight.revenue) : "대기", insight.revenue ? insight.revenueNote : "가격 표본 대기", "revenue"],
    ["판매율", Number.isFinite(insight.rate) ? fmtRate(insight.rate) : "확인필요", insight.stockText, insight.tone],
    ["예약 표본", insight.hasInventory ? insight.stockText : "대기", insight.hasInventory ? "판매 수량 확인" : "상세 수집 필요", insight.hasInventory ? "neutral" : "watch"],
    ["상품", insight.dayUseKnown ? "숙박+데이" : "숙박 중심", insight.productGap ? "데이유즈/캠프닉 미확인" : "상품 구성 확인", insight.productGap ? "watch" : "neutral"]
  ];
  return `
    <div class="company-insight-grid">
      ${cells.map(([label, value, note, tone]) => `
        <div class="${escapeHtml(tone || "neutral")}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(String(value || "대기"))}</strong>
          <small>${escapeHtml(note || "")}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function b2bCompanyProductSummary(item = {}, insight = companyRankInsight(item)) {
  const status = collectionStatusProfile(item);
  const rows = revenueProductRows(item);
  const lodgingProducts = rows.filter((row) => row.kind !== "day").length;
  const dayProducts = rows.filter((row) => row.kind === "day").length;
  const counted = finiteNumber(item.countedItemCount, 0);
  const night = finiteNumber(item.nightItemCount, 0);
  const dayUse = finiteNumber(item.dayUseItemCount, 0);
  const productSummary = String(item.productTypeSummary || item.inventoryProductSummary || "").trim();
  if (productSummary) {
    return {
      value: productSummary,
      note: status.productKnown ? "상품 구성 확인" : "상품 구성 보조 확인"
    };
  }
  if (lodgingProducts || dayProducts) {
    return {
      value: dayProducts ? `숙박 ${fmtNumber(lodgingProducts)}종 + 데이 ${fmtNumber(dayProducts)}종` : `숙박 ${fmtNumber(lodgingProducts)}종`,
      note: "가격/수량 표본 기준"
    };
  }
  if (night || dayUse || counted) {
    return {
      value: dayUse ? `숙박 ${fmtNumber(night || counted)}종 + 데이 ${fmtNumber(dayUse)}종` : `숙박 ${fmtNumber(night || counted)}종`,
      note: status.productKnown ? "네이버 상품 수량 기준" : "상품 수량 보조 확인"
    };
  }
  return {
    value: insight.dayUseKnown ? "숙박+데이" : "숙박 중심",
    note: insight.productGap ? "데이유즈/캠프닉 미확인" : "상품 구성 확인"
  };
}

function b2bCompanyCouponSummary(item = {}) {
  const coupon = naverCouponInfo(item);
  return {
    value: coupon.visible ? "쿠폰 있음" : "수동확인",
    note: coupon.visible
      ? (coupon.names || coupon.status || "쿠폰명 확인")
      : (coupon.detail || "네이버 화면 수동 확인"),
    tone: coupon.visible ? "strong" : "neutral"
  };
}

function b2bCompanyCardSummary(item = {}, insight = companyRankInsight(item)) {
  if (isAdminRole()) return companyRankInsightGrid(insight);
  const rank = finiteNumber(item.rank || item.overallRank || insight.rank, insight.rank);
  const product = b2bCompanyProductSummary(item, insight);
  const coupon = b2bCompanyCouponSummary(item);
  const revenue = finiteNumber(insight.revenue, 0);
  const cells = [
    {
      label: "순위",
      value: rank ? `${fmtNumber(rank)}위` : "확인필요",
      note: item.rankingSourceLabel || "네이버 플레이스",
      tone: rank && rank <= 5 ? "hot" : rank && rank <= 10 ? "strong" : "neutral"
    },
    {
      label: "예약율",
      value: Number.isFinite(insight.rate) ? fmtRate(insight.rate) : "확인필요",
      note: insight.hasInventory ? insight.stockText : "네이버 플레이스 예약 기준 대기",
      tone: insight.tone || "neutral"
    },
    {
      label: "예상 매출",
      value: revenue ? fmtWon(revenue) : "대기",
      note: revenue ? insight.revenueNote : "가격/수량 표본 대기",
      tone: revenue ? "revenue" : "watch"
    },
    {
      label: "쿠폰",
      value: coupon.value,
      note: coupon.note,
      tone: coupon.tone
    },
    {
      label: "주요 상품",
      value: product.value,
      note: product.note,
      tone: product.value.includes("데이") ? "good" : "neutral"
    }
  ];
  return `
    <div class="b2b-company-card-summary">
      ${cells.map((cell) => `
        <div class="${escapeHtml(cell.tone || "neutral")}">
          <span>${escapeHtml(cell.label)}</span>
          <strong>${escapeHtml(cell.value)}</strong>
          <small>${escapeHtml(cell.note || "")}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function b2bCompanyActionProfile(item = {}, insight = companyRankInsight(item)) {
  const rank = finiteNumber(item.rank || item.overallRank || insight.rank, insight.rank);
  const flow = salesFlowProfile(item);
  const platforms = platformsForItem(item);
  const linked = inventoryLinked(item);
  const rate = Number(insight.rate);
  const remaining = finiteNumber(insight.remaining, 0);
  const platformCount = platforms.length;
  let tone = "neutral";
  let label = "관찰";
  let summary = "노출, 판매율, 가격 표본을 함께 보고 경쟁 위치를 판단합니다.";
  if (!linked) {
    tone = "rank";
    label = "예약율 표본 대기";
    summary = "네이버 노출은 확인됐지만 예약율 산정 표본이 없어 판매 판단은 보류합니다.";
  } else if (Number.isFinite(rate) && rate <= B2B_LOW_RESERVATION_RATE) {
    tone = "watch";
    label = B2B_LOW_RESERVATION_LABEL;
    summary = "수집기간 예약율이 낮아 가격, 상품 구성, 채널 상태를 함께 봅니다.";
  } else if (Number.isFinite(rate) && rate >= B2B_HIGH_RESERVATION_RATE) {
    tone = "hot";
    label = B2B_HIGH_RESERVATION_LABEL;
    summary = "수집기간 예약율이 높아 가격대, 주말 재고, 객실 믹스 비교가 우선입니다.";
  } else if (insight.productGap) {
    tone = "watch";
    label = "상품 구성";
    summary = "숙박 중심 표본입니다. 데이유즈/캠프닉 상품 노출 여부를 함께 표시합니다.";
  } else if (remaining >= Math.max(3, Math.ceil(finiteNumber(insight.supply, 0) * 0.35))) {
    tone = "strong";
    label = "비교 여지";
    summary = "예약율과 노출 흐름을 함께 비교할 수 있는 업체입니다.";
  }
  return {
    tone,
    label,
    summary,
    chips: [
      rank ? `네이버 ${fmtNumber(rank)}위` : "순위 확인",
      linked && Number.isFinite(rate) ? `판매율 ${fmtRate(rate)}` : "수량 표본 대기",
      linked ? `판매 ${fmtNumber(insight.sold)}/${fmtNumber(insight.supply)}실` : "예약ID 확인 필요",
      platformCount ? `채널 ${fmtNumber(platformCount)}개` : "채널 보강"
    ],
    flowText: linked
      ? `평일 ${Number.isFinite(flow.weekday.rate) ? fmtRate(flow.weekday.rate) : "확인필요"} · 금 ${fmtRate(flow.friday.rate)} · 토 ${fmtRate(flow.saturday.rate)} · 일 ${fmtRate(flow.sunday.rate)}`
      : "상세 수집 후 요일별 판매 흐름 표시"
  };
}

function b2bCompanyActionLine(item = {}, insight = companyRankInsight(item)) {
  if (isAdminRole()) return "";
  const profile = b2bCompanyActionProfile(item, insight);
  return `
    <div class="b2b-company-action ${escapeHtml(profile.tone)}">
      <div>
        <span>${escapeHtml(profile.label)}</span>
        <strong>${escapeHtml(profile.summary)}</strong>
      </div>
      <div class="b2b-company-chips">
        ${profile.chips.map((chip) => `<em>${escapeHtml(chip)}</em>`).join("")}
      </div>
    </div>
  `;
}

function b2bRankBoardModel(items = b2bScopedRankedCompanyItems()) {
  const rows = items.slice(0, 30).map((item, index) => {
    const insight = companyRankInsight(item, index + 1);
    const linked = inventoryLinked(item);
    const rate = Number(insight.rate);
    const rank = finiteNumber(item.rank || item.overallRank || index + 1, index + 1);
    const remaining = finiteNumber(insight.remaining, 0);
    const itemIndex = linked ? finiteNumber(item.availabilityIndex, -1) : -1;
    const opportunityScore = (linked ? 30 : 8)
      + (rank > 0 && rank <= 5 ? 18 : rank <= 10 ? 12 : rank <= 20 ? 6 : 0)
      + (Number.isFinite(rate) && rate <= B2B_LOW_RESERVATION_RATE ? 22 : 0)
      + (remaining >= 3 ? 8 : 0)
      + Math.min(18, Math.round(finiteNumber(insight.revenue, 0) / 500000));
    return { item, index, itemIndex, insight, linked, rate, rank, remaining, opportunityScore };
  });
  const linkedRows = rows.filter((row) => row.linked);
  const rankOnlyRows = rows.filter((row) => !row.linked);
  const gapRows = linkedRows.filter((row) => Number.isFinite(row.rate) && row.rate <= B2B_LOW_RESERVATION_RATE);
  const hotRows = linkedRows.filter((row) => Number.isFinite(row.rate) && row.rate >= B2B_HIGH_RESERVATION_RATE);
  const sales = summarizeSales(linkedRows.map((row) => row.item));
  const rate = sales.supply ? sales.sold / sales.supply : NaN;
  const focusRows = rows
    .slice()
    .sort((a, b) => b.opportunityScore - a.opportunityScore || a.rank - b.rank)
    .slice(0, 4);
  const decision = rankOnlyRows.length > linkedRows.length
    ? { label: "노출 표본", tone: "watch", summary: "상위 노출 경쟁업체는 확인됐고, 예약 수량 표본은 일부 업체 중심으로 확보되어 있습니다." }
    : gapRows.length >= 2
      ? { label: "낮은 예약율 경쟁권", tone: "strong", summary: "상위 노출 경쟁업체 중 수집기간 예약율 20% 이하 구간을 가격, 상품 구성, 채널 상태와 함께 봅니다." }
      : hotRows.length >= 2
        ? { label: `${B2B_HIGH_RESERVATION_LABEL} 경쟁권`, tone: "hot", summary: "수집기간 예약율 40% 이상 경쟁업체가 많아 주말 재고와 가격 흐름을 함께 확인합니다." }
        : { label: "노출 요약", tone: "neutral", summary: "현재 표본에서는 경쟁업체별 순위와 예약 표본 상태를 함께 비교합니다." };
  return {
    rows,
    linkedRows,
    rankOnlyRows,
    gapRows,
    hotRows,
    sales,
    rate,
    focusRows,
    decision
  };
}

function b2bRankRangeLabel(rank) {
  const number = finiteNumber(rank, NaN);
  if (!Number.isFinite(number) || number <= 0) return "순위대기";
  if (number <= 5) return "1~5위";
  if (number <= 10) return "6~10위";
  if (number <= 20) return "11~20위";
  if (number <= 30) return "21~30위";
  return "30위 밖";
}

function b2bRankRangeModel(model = b2bRankBoardModel()) {
  const buckets = [
    { label: "1~5위", tone: "hot", rows: [] },
    { label: "6~10위", tone: "strong", rows: [] },
    { label: "11~20위", tone: "watch", rows: [] },
    { label: "21~30위", tone: "neutral", rows: [] }
  ];
  const byLabel = buckets.reduce((acc, bucket) => {
    acc[bucket.label] = bucket;
    return acc;
  }, {});
  (model.rows || []).forEach((row) => {
    const label = b2bRankRangeLabel(row.rank);
    const bucket = byLabel[label] || byLabel["21~30위"];
    bucket.rows.push(row);
  });
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.rows.length));
  return buckets.map((bucket) => {
    const linkedRows = bucket.rows.filter((row) => row.linked);
    const hotRows = bucket.rows.filter((row) => Number.isFinite(row.rate) && row.rate >= B2B_HIGH_RESERVATION_RATE);
    const gapRows = bucket.rows.filter((row) => row.linked && Number.isFinite(row.rate) && row.rate <= B2B_LOW_RESERVATION_RATE);
    const revenueTotal = bucket.rows.reduce((sum, row) => sum + finiteNumber(row.insight?.revenue, 0), 0);
    const sales = summarizeSales(linkedRows.map((row) => row.item));
    return {
      ...bucket,
      count: bucket.rows.length,
      linkedCount: linkedRows.length,
      hotCount: hotRows.length,
      gapCount: gapRows.length,
      revenueTotal,
      rate: sales.supply ? sales.sold / sales.supply : NaN,
      width: Math.max(8, Math.round((bucket.rows.length / maxCount) * 100))
    };
  });
}

function b2bRankExposureModel(model = b2bRankBoardModel()) {
  const rows = model.rows || [];
  const linkedRows = model.linkedRows || rows.filter((row) => row.linked);
  const rankOnlyRows = model.rankOnlyRows || rows.filter((row) => !row.linked);
  const gapRows = model.gapRows || linkedRows.filter((row) => Number.isFinite(row.rate) && row.rate <= B2B_LOW_RESERVATION_RATE);
  const hotRows = model.hotRows || linkedRows.filter((row) => Number.isFinite(row.rate) && row.rate >= B2B_HIGH_RESERVATION_RATE);
  const topFiveRows = rows.filter((row) => row.rank > 0 && row.rank <= 5);
  const topRows = topFiveRows.length ? topFiveRows : rows.slice(0, 5);
  const midRows = rows.filter((row) => row.rank >= 6 && row.rank <= 20);
  const outsideRows = rows.filter((row) => row.item?.regionBoundaryStatus === "outside" || row.item?.outsideSearchRegion);
  const revenueRows = rows.filter((row) => finiteNumber(row.insight?.revenue, 0) > 0);
  const linkedCoverage = rows.length ? linkedRows.length / rows.length : NaN;
  const remainingRooms = gapRows.reduce((sum, row) => sum + finiteNumber(row.remaining, 0), 0);
  const revenueValues = revenueRows.map((row) => finiteNumber(row.insight?.revenue, 0)).filter((value) => value > 0);
  const revenueTotal = revenueValues.reduce((sum, value) => sum + value, 0);
  const revenueAverage = revenueValues.length ? revenueValues.reduce((sum, value) => sum + value, 0) / revenueValues.length : 0;
  const revenueMax = revenueValues.length ? Math.max(...revenueValues) : 0;
  const revenueMin = revenueValues.length ? Math.min(...revenueValues) : 0;
  const couponRows = rows.filter((row) => naverCouponInfo(row.item).visible);
  const run = state.data?.run || {};
  const scopeRange = effectiveDetailRankRange(run);
  const scopeValue = scopeRange === "상세 생략" ? "순위만" : `${scopeRange}위`;
  const scopePeriod = b2bDateRangeLabel(run);
  const scopeProduct = productModeLabel(run.productMode || "all");
  const scopeNote = `${scopePeriod} · ${scopeProduct}`;
  const rangeRows = b2bRankRangeModel(model);
  const summaryTone = Number.isFinite(linkedCoverage) && linkedCoverage >= 0.55
    ? "strong"
    : rankOnlyRows.length > linkedRows.length
      ? "watch"
      : model.decision?.tone || "neutral";
  const cards = [
    {
      label: "지정 검색범위",
      value: scopeValue,
      note: scopeNote,
      tone: "strong"
    },
    {
      label: "경쟁업체",
      value: fmtNumber(rows.length),
      note: "지정 순위권 비교",
      tone: "neutral"
    },
    {
      label: "평균 예약율",
      value: Number.isFinite(model.rate) ? fmtRate(model.rate) : "확인필요",
      note: "네이버 플레이스 예약 기준",
      tone: Number.isFinite(model.rate) && model.rate >= B2B_HIGH_RESERVATION_RATE ? "hot" : "strong"
    },
    {
      label: "예상 평균 매출",
      value: revenueAverage ? fmtWon(revenueAverage) : "대기",
      note: revenueRows.length ? `매출 표본 ${fmtNumber(revenueRows.length)}곳` : "가격/수량 표본 필요",
      tone: revenueRows.length ? "strong" : "watch"
    },
    {
      label: "쿠폰 확인",
      value: fmtNumber(couponRows.length),
      note: couponRows.length ? "쿠폰명/혜택 노출 확인" : "자동 수집 제한",
      tone: couponRows.length ? "strong" : "neutral"
    }
  ];
  const actionRows = [];
  const focusRows = (model.focusRows || rows.slice(0, 4)).map((row) => {
    const insight = row.insight || companyRankInsight(row.item, row.index + 1);
    const itemIndex = Number.isFinite(row.itemIndex) ? row.itemIndex : (row.linked ? finiteNumber(row.item?.availabilityIndex, -1) : -1);
    return {
      ...row,
      insight,
      itemIndex,
      name: row.item?.name || "업체명 확인",
      label: insight.label || "노출 확인",
      metric: row.linked && Number.isFinite(row.rate) ? fmtRate(row.rate) : `노출 ${fmtNumber(row.rank)}위`,
      note: row.linked
        ? `예약율 ${fmtRate(row.rate)} · ${insight.revenue ? fmtWon(insight.revenue) : "매출 표본 대기"}`
        : "네이버 예약율 산정 제외"
    };
  });
  return {
    rows,
    linkedRows,
    rankOnlyRows,
    gapRows,
    hotRows,
    topRows,
    midRows,
    outsideRows,
    revenueRows,
    linkedCoverage,
    remainingRooms,
    revenueTotal,
    revenueAverage,
    revenueMax,
    revenueMin,
    couponRows,
    scopeValue,
    scopePeriod,
    scopeProduct,
    scopeNote,
    rangeRows,
    cards,
    actionRows,
    focusRows,
    summaryTone,
    summary: `예약율·예상 매출·쿠폰·상품 구성 기준`
  };
}

function pearsonCorrelation(rows = []) {
  const pairs = rows
    .map((row) => ({ x: Number(row.score), y: Number(row.actualRate) * 100 }))
    .filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y));
  if (pairs.length < 2) return NaN;
  const avgX = pairs.reduce((sum, row) => sum + row.x, 0) / pairs.length;
  const avgY = pairs.reduce((sum, row) => sum + row.y, 0) / pairs.length;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  pairs.forEach((row) => {
    const dx = row.x - avgX;
    const dy = row.y - avgY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  });
  const denominator = Math.sqrt(denomX * denomY);
  return denominator ? numerator / denominator : NaN;
}

function b2bCompetitionSalesCorrelationModel(rankModel = b2bRankBoardModel()) {
  const rows = (rankModel.rows || [])
    .filter((row) => row.linked && Number.isFinite(row.rate))
    .map((row) => {
      const rank = finiteNumber(row.rank, row.index + 1);
      const rankScore = Math.max(0, Math.min(100, Math.round(((31 - Math.min(30, Math.max(1, rank))) / 30) * 100)));
      const itemIndex = Number.isFinite(row.itemIndex) ? row.itemIndex : finiteNumber(row.item?.availabilityIndex, -1);
      return {
        itemIndex,
        name: row.item?.name || "업체명 확인",
        rank,
        score: rankScore,
        actualRate: Number(row.rate),
        revenue: finiteNumber(row.insight?.revenue, 0),
        tone: row.rate >= B2B_HIGH_RESERVATION_RATE ? "hot" : row.rate <= B2B_LOW_RESERVATION_RATE ? "watch" : "neutral"
      };
    })
    .sort((a, b) => a.rank - b.rank);
  const correlation = pearsonCorrelation(rows);
  const label = !Number.isFinite(correlation)
    ? "표본 대기"
    : correlation >= 0.35
      ? "양의 상관"
      : correlation <= -0.35
        ? "역상관"
        : "약한 상관";
  const tone = !Number.isFinite(correlation)
    ? "neutral"
    : correlation >= 0.35
      ? "strong"
      : correlation <= -0.35
        ? "watch"
        : "good";
  return {
    rows,
    correlation,
    label,
    tone,
    sampleCount: rows.length
  };
}

function renderB2BCompetitionSalesCorrelation(model = b2bCompetitionSalesCorrelationModel()) {
  const width = 640;
  const height = 260;
  const padLeft = 52;
  const padRight = 28;
  const padTop = 28;
  const padBottom = 44;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;
  const rows = model.rows || [];
  const points = rows.map((row) => {
    const x = padLeft + (Math.max(0, Math.min(100, row.score)) / 100) * chartWidth;
    const y = padTop + (1 - Math.max(0, Math.min(1, row.actualRate))) * chartHeight;
    return { ...row, x, y };
  });
  const sampleRows = rows.slice().sort((a, b) => b.score - a.score || b.actualRate - a.actualRate).slice(0, 4);
  const corrText = Number.isFinite(model.correlation) ? model.correlation.toFixed(2) : "대기";
  const summary = Number.isFinite(model.correlation)
    ? `${model.label} · 표본 ${fmtNumber(model.sampleCount)}개 · r=${corrText}`
    : "예약율 표본이 2개 이상 확보되면 상관을 표시합니다.";
  return `
    <section class="b2b-correlation-card ${escapeHtml(model.tone || "neutral")}">
      <div class="b2b-correlation-head">
        <div>
          <p class="eyebrow">경쟁 지표 상관</p>
          <h3>노출 경쟁 지표와 실제 예약율</h3>
          <p>${escapeHtml(summary)}</p>
        </div>
        <strong>${escapeHtml(corrText)}</strong>
      </div>
      <div class="b2b-correlation-chart" aria-label="노출 경쟁 지표와 예약율 산점도">
        <svg viewBox="0 0 ${width} ${height}" role="img">
          <line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" class="axis"></line>
          <line x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}" class="axis"></line>
          <line x1="${padLeft}" y1="${padTop + chartHeight * 0.5}" x2="${width - padRight}" y2="${padTop + chartHeight * 0.5}" class="grid"></line>
          <line x1="${padLeft + chartWidth * 0.5}" y1="${padTop}" x2="${padLeft + chartWidth * 0.5}" y2="${height - padBottom}" class="grid"></line>
          <text x="${padLeft - 12}" y="${padTop + 6}" text-anchor="end">100%</text>
          <text x="${padLeft - 12}" y="${height - padBottom}" text-anchor="end">0%</text>
          <text x="${padLeft}" y="${height - 10}" text-anchor="start">낮음</text>
          <text x="${width - padRight}" y="${height - 10}" text-anchor="end">노출 경쟁 높음</text>
          ${points.map((point) => `
            <circle class="point ${escapeHtml(point.tone)}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="8">
              <title>${escapeHtml(point.name)} · ${fmtNumber(point.rank)}위 · 예약율 ${fmtRate(point.actualRate)}</title>
            </circle>
          `).join("")}
        </svg>
      </div>
      <div class="b2b-correlation-legend">
        <span>가로: 네이버 노출 순위 기반 경쟁 지표</span>
        <span>세로: 수집기간 실제 예약율</span>
      </div>
      <div class="b2b-correlation-list">
        ${sampleRows.map((row) => `
          <div>
            <b>${escapeHtml(row.name)}</b>
            <span>${fmtNumber(row.rank)}위 · 지표 ${fmtNumber(row.score)} · 예약율 ${fmtRate(row.actualRate)}</span>
          </div>
        `).join("") || `<div><b>표본 대기</b><span>네이버 플레이스 예약 기준 표본이 더 필요합니다.</span></div>`}
      </div>
    </section>
  `;
}

function renderB2BRankExposureBoard(model = b2bRankBoardModel()) {
  const exposure = b2bRankExposureModel(model);
  if (!exposure.rows.length) return "";
  return `
    <div class="b2b-rank-exposure-board">
      <div class="b2b-rank-board-head">
        <div>
          <span>검색범위 요약</span>
          <strong>지정 범위 안의 경쟁 비교</strong>
        </div>
        <em class="${escapeHtml(exposure.summaryTone)}">${escapeHtml(exposure.summary)}</em>
      </div>
      <div class="b2b-rank-board-grid">
        ${exposure.cards.map((card) => `
          <article class="${escapeHtml(card.tone)}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(String(card.value))}</strong>
            <small>${escapeHtml(card.note)}</small>
          </article>
        `).join("")}
      </div>
    </div>
  `;
}

function renderB2BRankBrief(model = b2bRankBoardModel()) {
  if (isAdminRole()) return "";
  const exposure = b2bRankExposureModel(model);
  return `
    <section class="b2b-rank-brief ${escapeHtml(model.decision.tone)}">
      <div class="b2b-rank-head">
        <div>
          <p class="eyebrow">경쟁업체 노출 브리프</p>
          <h3>지정 순위권 경쟁 브리프</h3>
          <p>${escapeHtml("검색 당시 지정한 순위 안에서 노출 위치, 예약율, 예상 매출, 쿠폰, 상품 구성을 같은 기준으로 비교합니다.")}</p>
          <div class="b2b-rank-context">
            <span>검색범위 ${escapeHtml(exposure.scopeValue || "확인")}</span>
            <span>${escapeHtml(exposure.scopePeriod || "기간 확인")}</span>
            <span>${escapeHtml(exposure.scopeProduct || "전체")}</span>
          </div>
        </div>
        <strong>${escapeHtml(exposure.scopeValue || "검색범위")}</strong>
      </div>
      <div class="b2b-rank-metrics">
        <article><span>검색범위</span><strong>${escapeHtml(exposure.scopeValue || "확인")}</strong><small>${escapeHtml(exposure.scopePeriod || "기간 확인")}</small></article>
        <article><span>경쟁업체</span><strong>${fmtNumber(model.rows.length)}</strong><small>지정 범위 안</small></article>
        <article><span>평균 예약율</span><strong>${Number.isFinite(model.rate) ? fmtRate(model.rate) : "확인필요"}</strong><small>${fmtNumber(model.sales.sold)}/${fmtNumber(model.sales.supply)}실</small></article>
        <article><span>예상 평균 매출</span><strong>${exposure.revenueAverage ? fmtWon(exposure.revenueAverage) : "대기"}</strong><small>매출 표본 ${fmtNumber(exposure.revenueRows.length)}곳</small></article>
        <article><span>쿠폰 확인</span><strong>${fmtNumber(exposure.couponRows.length)}</strong><small>${exposure.couponRows.length ? "쿠폰명/혜택 확인" : "자동 수집 제한"}</small></article>
      </div>
      ${renderB2BRankExposureBoard(model)}
    </section>
  `;
}

function b2bRateTone(rate, fallback = "neutral") {
  const number = Number(rate);
  if (!Number.isFinite(number)) return fallback;
  if (number >= B2B_HIGH_RESERVATION_RATE) return "hot";
  if (number <= B2B_LOW_RESERVATION_RATE) return "watch";
  return "good";
}

function b2bFlowEvidenceRows(flow = salesFlowProfile({})) {
  const rows = [
    ["평일", flow.weekday, flow.weekday?.label || "평일"],
    ["금요일", flow.friday, "금요일"],
    ["토요일", flow.saturday, "토요일"],
    ["일요일", flow.sunday, "일요일"]
  ];
  return rows.map(([label, metric, note]) => ({
    label,
    value: Number.isFinite(metric?.rate) ? fmtRate(metric.rate) : "확인필요",
    note: metric?.total ? `${fmtNumber(metric.sold)}/${fmtNumber(metric.total)}실 · ${note}` : `${note} 표본 대기`,
    tone: b2bRateTone(metric?.rate)
  }));
}

function b2bDetailPositionModel(item = {}) {
  const insight = companyRankInsight(item, item.rank || item.overallRank || 0);
  const flow = salesFlowProfile(item);
  const impact = itemQueueRevenueImpact(item);
  const revenue = effectiveRevenueValue(impact);
  const brief = b2bMarketBriefModel(state.data || {});
  const marketRevenue = finiteNumber(brief.averageRevenue, 0);
  const marketRate = Number(brief.rate);
  const lodging = salesStats(item, "lodging");
  const day = salesStats(item, "day");
  const status = collectionStatusProfile(item);
  const confidence = inventoryConfidenceInfo(item);
  const correction = correctionStatusInfo(item);
  const audit = inventoryAuditProfile(item);
  const platforms = platformsForItem(item);
  const coupon = naverCouponInfo(item);
  const rank = finiteNumber(insight.rank || item.rank || item.overallRank, 0);
  const remaining = Math.max(0, finiteNumber(lodging.supply, 0) - finiteNumber(lodging.sold, 0));
  const revenueGap = revenue && marketRevenue ? (revenue - marketRevenue) / marketRevenue : NaN;
  const rateGap = Number.isFinite(insight.rate) && Number.isFinite(marketRate) ? insight.rate - marketRate : NaN;
  const rankBand = rank && rank <= 3
    ? "최상위 노출"
    : rank && rank <= 5
      ? "상위 5위권"
      : rank && rank <= 10
        ? "상위 10위권"
        : rank
          ? "비교권 노출"
          : "순위 대기";
  let tone = insight.tone || "neutral";
  let label = "경쟁 포지션";
  let summary = "노출 순위, 예상 매출, 요일별 판매 흐름을 함께 보고 경쟁 위치를 판단합니다.";
  if (!insight.hasInventory) {
    tone = "watch";
    label = "노출 중심 관찰";
    summary = "네이버 노출은 확인됐지만 예약 수량 표본이 부족해 매출과 판매율 판단은 보류합니다.";
  } else if (rank > 0 && rank <= 5 && Number.isFinite(insight.rate) && insight.rate >= B2B_HIGH_RESERVATION_RATE) {
    tone = "hot";
    label = B2B_HIGH_RESERVATION_LABEL;
    summary = "상위 노출과 수집기간 예약율 40% 이상이 함께 확인됩니다. 가격, 객실 구성, 주말 판매 흐름을 벤치마크합니다.";
  } else if (rank > 0 && rank <= 5 && remaining > 0) {
    tone = "strong";
    label = "상위권 비교사";
    summary = "상위 노출 업체의 예약율, 가격, 상품 구성, 채널 혜택을 비교합니다.";
  } else if (revenue && marketRevenue && revenue >= marketRevenue * 1.2) {
    tone = "strong";
    label = "매출 상위 경쟁사";
    summary = "지역 평균보다 높은 예상 매출 표본이 잡힙니다. 판매 가격대와 객실 수량을 함께 봅니다.";
  } else if (Number.isFinite(insight.rate) && insight.rate <= B2B_LOW_RESERVATION_RATE) {
    tone = "watch";
    label = B2B_LOW_RESERVATION_LABEL;
    summary = "노출 대비 수집기간 예약율이 낮아 가격, 요일별 빈구간, 상품 구성 차이를 확인합니다.";
  }
  const revenueBasis = impact.totalPricedSoldOut
    ? `${fmtNumber(impact.totalPricedSoldOut)}개 가격 확인`
    : "가격 표본 대기";
  const missingPrice = impact.totalMissingPriceSoldOut
    ? ` · 가격 미확인 ${fmtNumber(impact.totalMissingPriceSoldOut)}개`
    : "";
  const avgPrice = impact.lodging.avgSoldUnitPrice || impact.dayUse.avgSoldUnitPrice;
  const cards = [
    {
      tone: revenue ? "strong" : "watch",
      label: "예상 매출",
      value: revenue ? fmtWon(revenue) : "표본 대기",
      note: `${revenueAdjustmentNote(impact)} · ${revenueBasis}${missingPrice}`
    },
    {
      tone: Number.isFinite(revenueGap) ? (revenueGap >= 0.15 ? "strong" : revenueGap <= -0.15 ? "watch" : "good") : "neutral",
      label: "시장 평균 대비",
      value: Number.isFinite(revenueGap) ? formatSignedRate(revenueGap) : "대기",
      note: marketRevenue ? `지역 평균 ${fmtWon(marketRevenue)}` : "평균 매출 표본 대기"
    },
    {
      tone: rank && rank <= 5 ? "hot" : rank && rank <= 10 ? "strong" : "neutral",
      label: "네이버 노출",
      value: rank ? `${fmtNumber(rank)}위` : "확인필요",
      note: `${rankBand} · ${item.rankingSourceLabel || "플레이스"}`
    },
    {
      tone: b2bRateTone(insight.rate, "watch"),
      label: "예약 판매율",
      value: Number.isFinite(insight.rate) ? fmtRate(insight.rate) : "확인필요",
      note: lodging.supply ? `${fmtNumber(lodging.sold)}/${fmtNumber(lodging.supply)}실` : "숙박 수량 표본 대기"
    },
    {
      tone: lodging.supply ? "neutral" : "watch",
      label: "예약 표본",
      value: lodging.supply ? `${fmtNumber(lodging.sold)}/${fmtNumber(lodging.supply)}실` : "대기",
      note: status.offlineEstimated ? "오프라인 예약 가능성 반영" : status.label || "수량 표본 기준"
    },
    {
      tone: day.supply ? "good" : "neutral",
      label: "상품 구성",
      value: day.supply ? "숙박+데이" : "숙박 중심",
      note: day.supply ? `데이유즈/캠프닉 ${fmtNumber(day.sold)}/${fmtNumber(day.supply)}` : "데이유즈/캠프닉 미확인"
    }
  ];
  const evidence = [
    {
      label: "가격 기준",
      value: avgPrice ? `평균 ${fmtWon(avgPrice)}` : "가격 표본 대기",
      note: impact.lodging.byDayType || impact.dayUse.byDayType || revenueBasis
    },
    {
      label: "노출 권역",
      value: rankBand,
      note: itemLocationLine(item)
    },
    {
      label: "수량 신뢰",
      value: correction.label,
      note: `${confidence.label} · ${correction.summary}`
    },
    {
      label: "채널/혜택",
      value: coupon.visible ? "쿠폰 노출" : platforms.length ? `${fmtNumber(platforms.length)}채널` : "채널 보강",
      note: coupon.visible ? (coupon.names || coupon.status || "쿠폰명 확인") : (audit.otaCheckNeeded ? "OTA 보조 확인 필요" : "네이버 중심 판단")
    },
    {
      label: "판매율 차이",
      value: Number.isFinite(rateGap) ? formatSignedRate(rateGap) : "대기",
      note: Number.isFinite(marketRate) ? `지역 평균 ${fmtRate(marketRate)}` : "지역 평균 대기"
    }
  ];
  return {
    tone,
    label,
    summary,
    cards,
    evidence,
    flowRows: b2bFlowEvidenceRows(flow),
    metricText: insight.metricText,
    rankBand
  };
}

function renderB2BDetailPositionPanel(item = {}) {
  if (isAdminRole()) return "";
  const model = b2bDetailPositionModel(item);
  return `
    <section class="sheet-section sheet-b2b-detail ${escapeHtml(model.tone)}">
      <div class="sheet-b2b-head">
        <div>
          <span>${escapeHtml(model.label)}</span>
          <h3>${escapeHtml(item.name || "업체명 확인")} 경쟁 포지션</h3>
          <p>${escapeHtml(model.summary)}</p>
        </div>
        <strong>${escapeHtml(model.metricText)}</strong>
      </div>
      <div class="sheet-b2b-detail-grid">
        ${model.cards.map((card) => `
          <div class="${escapeHtml(card.tone)}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(card.value)}</strong>
            <small>${escapeHtml(card.note)}</small>
          </div>
        `).join("")}
      </div>
      <div class="sheet-b2b-flow-strip">
        ${model.flowRows.map((row) => `
          <div class="${escapeHtml(row.tone)}">
            <span>${escapeHtml(row.label)}</span>
            <strong>${escapeHtml(row.value)}</strong>
            <small>${escapeHtml(row.note)}</small>
          </div>
        `).join("")}
      </div>
      <div class="sheet-b2b-evidence-grid">
        ${model.evidence.map((row) => `
          <div>
            <span>${escapeHtml(row.label)}</span>
            <strong>${escapeHtml(row.value)}</strong>
            <small>${escapeHtml(row.note)}</small>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function sheetB2BInsightPanel(item = {}) {
  const insight = companyRankInsight(item, item.rank || 0);
  const flow = salesFlowProfile(item);
  const structure = inventoryStructureInfo(item);
  const confidence = inventoryConfidenceInfo(item);
  const profile = b2bCompanyActionProfile(item, insight);
  const action = insight.productGap
    ? "데이유즈/캠프닉 상품 노출 여부 비교"
    : insight.remaining > 0
      ? "잔여 객실 판매 흐름과 가격 비교"
      : "강한 수요 구간의 가격/재고 흐름 비교";
  return `
    <section class="sheet-section sheet-b2b-insight ${escapeHtml(insight.tone)}">
      <div class="sheet-b2b-head">
        <div>
          <span>${escapeHtml(insight.label)}</span>
          <h3>${escapeHtml(item.name || "업체명 확인")} 경쟁 요약</h3>
          <p>${escapeHtml(action)}</p>
        </div>
        <strong>${escapeHtml(insight.metricText)}</strong>
      </div>
      ${companyRankInsightGrid(insight)}
      <div class="sheet-b2b-note-grid">
        <div><span>판매 흐름</span><strong>${escapeHtml(flow.all.label || fmtRate(flow.all.rate))}</strong><small>${escapeHtml(`평일 ${Number.isFinite(flow.weekday.rate) ? fmtRate(flow.weekday.rate) : "확인필요"} · 금 ${fmtRate(flow.friday.rate)} · 토 ${fmtRate(flow.saturday.rate)} · 일 ${fmtRate(flow.sunday.rate)}`)}</small></div>
        <div><span>수량 신뢰</span><strong>${escapeHtml(confidence.label)}</strong><small>${escapeHtml(structure.summary || structure.label)}</small></div>
      </div>
      <div class="sheet-b2b-action-list">
        <strong>${escapeHtml(profile.label)}</strong>
        <p>${escapeHtml(profile.summary)}</p>
        <div>
          ${profile.chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}
        </div>
      </div>
    </section>
  `;
}

function categoryText(item = {}) {
  return [item.region || item.address, item.category || item.type].filter(Boolean).join(" · ") || "지역 확인";
}

function inventoryConfidenceInfo(item = {}) {
  const confidence = item.inventoryConfidence || {};
  const grade = item.inventoryConfidenceGrade || confidence.grade || "C";
  const label = item.inventoryConfidenceLabel || confidence.label || `${grade} 참고`;
  const summary = item.inventoryConfidenceSummary || confidence.summary || label;
  const reasons = item.inventoryConfidenceReasons || confidence.reasons || [];
  const alerts = item.inventoryAlerts || confidence.alerts || [];
  const tone = ["A", "B"].includes(grade) ? "good" : grade === "C" ? "watch" : "bad";
  return { grade, label, summary, reasons, alerts, tone };
}

function inventoryStructureInfo(item = {}) {
  const structure = item.inventoryStructure || {};
  const type = item.inventoryStructureType || structure.type || "unknown";
  const label = item.inventoryStructureLabel || structure.label || "구조 확인필요";
  const tone = item.inventoryStructureTone || structure.tone || "bad";
  const summary = item.inventoryStructureSummary || structure.summary || "예약 리스트 구조 확인이 필요합니다.";
  const flags = item.inventoryStructureFlags || structure.flags || [];
  const notes = item.inventoryStructureNotes || structure.notes || [];
  const action = item.inventoryStructureAction || structure.action || "표본 날짜 재검증";
  return { type, label, tone, summary, flags, notes, action };
}

function inventoryConfidenceBadge(item = {}) {
  const status = correctionStatusInfo(item);
  return `<span class="confidence-badge ${escapeHtml(status.tone)}" title="${escapeHtml(status.summary)}">${escapeHtml(status.label)}</span>`;
}

function inventoryStructureBadge(item = {}) {
  const info = inventoryStructureInfo(item);
  const flagText = info.flags.includes("dynamic_capacity") ? " · 총량변동" : info.flags.includes("dayuse_rotation") ? " · 당일병행" : "";
  return `<span class="structure-badge ${escapeHtml(info.tone)}" title="${escapeHtml(info.summary)}">${escapeHtml(info.label)}${escapeHtml(flagText)}</span>`;
}

function otaVerificationBadge(item = {}) {
  const audit = inventoryAuditProfile(item);
  if (!audit.otaCheckNeeded) return "";
  return `<span class="structure-badge ota-check" title="${escapeHtml(audit.otaReason || "네이버 기준 수량 해석 보조 확인")}">OTA 확인 필요</span>`;
}

function b2bPublicCompanyBadges(item = {}, linked = inventoryLinked(item)) {
  if (isAdminRole()) return "";
  const status = collectionStatusProfile(item);
  const badges = [
    linked
      ? `<span class="structure-badge good" title="네이버 플레이스 예약 기준으로 산정했습니다.">네이버 예약 기준</span>`
      : `<span class="structure-badge watch" title="네이버 노출은 확인됐지만 네이버 플레이스 예약 기준 표본이 부족합니다.">예약 기준 대기</span>`,
    status.offlineEstimated
      ? `<span class="structure-badge watch" title="운영 기준보다 낮은 수집값은 오프라인 예약 가능성을 반영합니다.">오프라인 예약 반영</span>`
      : ""
  ].filter(Boolean);
  return badges.join("");
}

function companyBadges(item = {}, linked = inventoryLinked(item), stockStatus = "") {
  if (!isAdminRole()) return b2bPublicCompanyBadges(item, linked);
  return linked
    ? `${inventoryConfidenceBadge(item)}${inventoryStructureBadge(item)}${regionBoundaryBadge(item)}${manualCorrectionBadge(item)}${otaVerificationBadge(item)}`
    : `<span class="confidence-badge watch" title="${escapeHtml(stockStatus)}">재고 미수집</span><span class="structure-badge watch">${escapeHtml(item.rankingSourceLabel || "네이버 전체 순위")}</span>${regionBoundaryBadge(item)}`;
}

function manualCorrectionInfo(item = {}) {
  const correction = item.companyManualCorrection || item.companyProfile?.manualCorrection || {};
  if (!manualCorrectionHasValue(correction)) return null;
  const lodging = finiteNumber(correction.lodgingBasisTotal, 0);
  const dayUse = finiteNumber(correction.dayUseBasisTotal, 0);
  const parts = [];
  if (lodging > 0) parts.push(`숙박 운영 ${fmtNumber(lodging)}개`);
  if (dayUse > 0) parts.push(`데이유즈 운영 ${fmtNumber(dayUse)}회`);
  return {
    correction,
    label: parts.length ? parts.join(" · ") : "보정 기준",
    note: correction.note || "관리자 수동 보정값 기준"
  };
}

function correctionStatusInfo(item = {}) {
  const manual = manualCorrectionInfo(item);
  const confidence = inventoryConfidenceInfo(item);
  if (manual) {
    return {
      key: "admin",
      label: "관리자 보정",
      tone: "manual",
      summary: `${manual.label} · ${manual.note}`,
      detail: manual.label,
      confidence
    };
  }
  return {
    key: "auto",
    label: "자동추정",
    tone: confidence.tone,
    summary: `자동추정 · 내부 신뢰도 ${confidence.grade} · ${confidence.summary}`,
    detail: `내부 신뢰도 ${confidence.grade}`,
    confidence
  };
}

function manualCorrectionBadge(item = {}) {
  return "";
}

function bookingGraphRows(item) {
  const run = state.data?.run || {};
  const rows = weeklyRows(item);
  const rowMap = new Map(rows.map((row) => [normalizeMonthDayLabel(row.label), row]));
  const lodging = salesStats(item, "lodging");
  const manualBasis = activeManualCorrection(item);
  const baseTotal = finiteNumber(item.nightTotalStock, finiteNumber(item.totalRooms, finiteNumber(lodging.supply, 0)));
  const candidateBasis = finiteNumber(item.weeklyBasisTotal, baseTotal);
  const correctedBasis = finiteNumber(item.weeklyOperatingTotal, candidateBasis);
  const maxTotal = manualBasis && candidateBasis > 0
    ? candidateBasis
    : Math.max(
      0,
      baseTotal,
      candidateBasis,
      correctedBasis,
      ...rows.map((row) => finiteNumber(row.total, 0))
    );
  const basisLabel = normalizeMonthDayLabel(monthDay(run.checkIn));

  return bookingRangeLabels(run).map((label) => {
    const key = normalizeMonthDayLabel(label);
    const row = rowMap.get(key);
    if (row) {
      const rawTotal = finiteNumber(row.total, maxTotal);
      const operatingBasis = correctedBasis || maxTotal;
      const basisTotal = Math.max(operatingBasis, rawTotal);
      const rawSold = finiteNumber(row.sold, 0);
      const offlineSold = offlineSoldForTotal(basisTotal, rawTotal);
      const sold = Math.min(basisTotal, rawSold + offlineSold);
      return {
        label,
        sold,
        total: basisTotal,
        rawTotal,
        rawSold,
        offlineSold,
        hidden: offlineSold,
        rate: basisTotal ? sold / basisTotal : row.rate,
        rawRate: row.rate,
        source: "daily",
        missing: false,
        maxTotal: basisTotal
      };
    }
    if (!rows.length && key === basisLabel && lodging.supply) {
      const rawTotal = finiteNumber(lodging.rawSupply, finiteNumber(lodging.supply, maxTotal));
      const total = finiteNumber(lodging.supply, maxTotal);
      const offlineSold = offlineSoldForTotal(total, rawTotal);
      return {
        label,
        sold: finiteNumber(lodging.sold, 0),
        total,
        rawTotal,
        rawSold: finiteNumber(lodging.rawSold, Math.max(0, rawTotal - finiteNumber(item.nightAvailableStock, finiteNumber(item.availableRooms, rawTotal)))),
        offlineSold,
        hidden: offlineSold,
        rate: lodging.rate,
        source: "basis",
        missing: false,
        maxTotal
      };
    }
    return {
      label,
      sold: 0,
      total: correctedBasis || maxTotal,
      rate: NaN,
      source: "missing",
      missing: true,
      maxTotal
    };
  });
}

function miniBars(item) {
  const visible = bookingGraphRows(item);
  const maxTotal = Math.max(1, ...visible.map((row) => finiteNumber(row.maxTotal || row.total, 0)));
  const first = visible[0]?.label || monthDay(state.data?.run?.checkIn) || "";
  const last = visible[visible.length - 1]?.label || "";
  return `
    <div class="mini-bars" aria-label="날짜별 판매 흐름" style="--bar-count:${Math.max(1, visible.length)}">
      <div class="bar-row">
        ${visible.map((row) => {
          const rangeHeight = row.total ? Math.max(18, Math.round((row.total / maxTotal) * 32)) : 32;
          const fillHeight = row.missing ? 0 : Math.max(2, Math.round((row.sold / maxTotal) * 32));
          const hot = !row.missing && Number(row.rate) >= 0.45 ? "hot" : "";
          const missing = row.missing ? "missing" : "";
          const openStock = finiteNumber(row.rawTotal, row.total);
          const hidden = Math.max(0, finiteNumber(row.hidden, 0));
          const title = row.missing
            ? `${row.label} 미수집 · 기준총량 ${fmtNumber(row.total)}개`
            : `${row.label} 예약확정 ${fmtNumber(row.sold)}/${fmtNumber(row.total)}개 · 온라인열림 ${fmtNumber(openStock)}개${hidden ? ` · 오프라인예약 ${fmtNumber(hidden)}개 포함` : ""}`;
          return `
            <span class="bar-stack ${hot} ${missing}" title="${escapeHtml(title)}" style="--range-h:${rangeHeight}px; --fill-h:${fillHeight}px">
              <span class="bar-track"><span class="bar-fill"></span></span>
            </span>
          `;
        }).join("")}
      </div>
      <div class="bar-labels"><small>${escapeHtml(first)}</small><small>${escapeHtml(last || "")}</small></div>
    </div>
  `;
}

function renderSummary() {
  const items = state.data?.availability?.items || [];
  const stats = state.data?.availability?.stats || {};
  const sales = summarizeSales(items);
  const revenue = summarizeRevenue(items);
  const rate = sales.supply ? sales.sold / sales.supply : finiteNumber(stats.weightedSoldOutRate, NaN);
  const checked = stats.checkedPlaces || items.length;
  const lowConfidence = finiteNumber(stats.lowConfidenceCount, 0);
  const stockVariance = finiteNumber(stats.stockVarianceCount, 0);
  const averageRevenue = finiteNumber(stats.averageAdjustedEstimatedRevenue, 0) || finiteNumber(revenue.adjustedRevenue, 0);
  const revenueSampleCount = finiteNumber(stats.revenueSampleCount, 0);
  const revenueCoverage = Number(stats.revenueCoverageRate);
  const revenueNote = revenueSampleCount
    ? `매출표본 ${fmtNumber(revenueSampleCount)}개${Number.isFinite(revenueCoverage) ? ` · 커버 ${fmtRate(revenueCoverage)}` : ""}`
    : "매출표본 대기";
  if (!isAdminRole()) {
    const brief = b2bMarketBriefModel(state.data || {});
    const nextDemand = demandNextMonthProjection(demandTrafficAggregate());
    els.summaryGrid.innerHTML = `
      <article class="summary-card public-summary-card">
        <span class="summary-icon green">${summaryIcon("money")}</span>
        <div><strong>${fmtWon(brief.averageRevenue)}</strong><small>경쟁업체 예상 평균 매출 · ${escapeHtml(brief.revenueNote)}</small></div>
      </article>
      <article class="summary-card public-summary-card">
        <span class="summary-icon blue">${summaryIcon("rate")}</span>
        <div><strong>${fmtRate(brief.rate)}</strong><small>경쟁업체 객실 판매율 · ${fmtNumber(brief.sold)}/${fmtNumber(brief.supply)}</small></div>
      </article>
      <article class="summary-card public-summary-card">
        <span class="summary-icon amber">${summaryIcon("sales")}</span>
        <div><strong>${fmtNumber(brief.salesSampleCount)}</strong><small>네이버 플레이스 예약 기준</small></div>
      </article>
      <article class="summary-card public-summary-card">
        <span class="summary-icon purple">${summaryIcon("company")}</span>
        <div><strong>${fmtNumber(brief.itemCount)}</strong><small>상위 노출 경쟁업체</small></div>
      </article>
      <article class="summary-card public-summary-card">
        <span class="summary-icon blue">${summaryIcon("trust")}</span>
        <div><strong>${escapeHtml(nextDemand.value)}</strong><small>${escapeHtml(nextDemand.note)}</small></div>
      </article>
    `;
    return;
  }

  els.summaryGrid.innerHTML = `
    <article class="summary-card">
      <span class="summary-icon blue">${summaryIcon("sales")}</span>
      <div><strong>${fmtNumber(sales.sold)}/${fmtNumber(sales.supply)}</strong><small>객실 판매</small></div>
    </article>
    <article class="summary-card">
      <span class="summary-icon green">${summaryIcon("money")}</span>
      <div><strong>${fmtWon(averageRevenue)}</strong><small>표본 평균 예상매출 · ${escapeHtml(revenueNote)}</small></div>
    </article>
    <article class="summary-card">
      <span class="summary-icon purple">${summaryIcon("company")}</span>
      <div><strong>${fmtNumber(checked)}</strong><small>분석 업체</small></div>
    </article>
    <article class="summary-card">
      <span class="summary-icon green">${summaryIcon("rate")}</span>
      <div><strong>${fmtRate(rate)}</strong><small>평균 판매율</small></div>
    </article>
    <article class="summary-card">
      <span class="summary-icon amber">${summaryIcon("trust")}</span>
      <div><strong>${fmtNumber(lowConfidence)}</strong><small>검증 필요 · 변동 ${fmtNumber(stockVariance)}</small></div>
    </article>
  `;
}

function renderNotice() {
  const run = state.data?.run || {};
  const today = new Date();
  const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (run.checkIn && run.checkIn !== todayText) {
    els.noticeCard.hidden = false;
    els.noticeCard.textContent = `주의: 이 결과는 ${run.checkIn} 체크인 기준입니다. 현재 직접 확인값과 다를 수 있습니다.`;
    return;
  }
  els.noticeCard.hidden = true;
}

function rankedCompanyItems() {
  const availabilityItems = state.data?.availability?.items || [];
  const rankingItems = state.data?.ranking?.items || [];
  if (rankingItems.length) return rankingItems;
  return availabilityItems.map((item, index) => ({
    ...item,
    hasInventory: true,
    availabilityIndex: index,
    overallRank: item.rank || index + 1,
    rankingSourceLabel: "재고 분석 순위"
  }));
}

function inventoryLinked(item = {}) {
  return item.hasInventory !== false && Number(item.availabilityIndex) >= 0;
}

function regionBoundaryBadge(item = {}) {
  const searchRegion = item.searchRegion || item.searchCluster || "";
  const addressRegion = item.addressRegion || item.region || "";
  const status = item.regionBoundaryStatus || (item.outsideSearchRegion ? "outside" : "same");
  if (!searchRegion || !addressRegion || status === "same" || status === "unknown") return "";
  const label = item.regionBoundaryLabel || (status === "outside" ? "권역 밖 노출" : "권역 내 노출");
  const tone = status === "outside" ? "watch" : "good";
  const detail = item.regionBoundaryDetail || (
    status === "outside"
      ? `${searchRegion} 검색권 결과이나 실제 소재지는 ${addressRegion}입니다.`
      : `${searchRegion} 권역에 포함된 ${addressRegion} 소재입니다.`
  );
  return `<span class="structure-badge ${tone}" title="${escapeHtml(detail)}">${escapeHtml(label)}</span>`;
}

function itemLocationLine(item = {}) {
  const searchRegion = item.searchRegion || item.searchCluster || "";
  const addressRegion = item.addressRegion || item.region || "";
  const status = item.regionBoundaryStatus || (item.outsideSearchRegion ? "outside" : "same");
  const regionText = searchRegion && addressRegion && status === "within"
    ? `${searchRegion} 권역 · ${addressRegion} 소재`
    : searchRegion && addressRegion && status === "parent"
      ? `${addressRegion} 권역 · ${searchRegion} 검색`
      : searchRegion && addressRegion && status === "outside"
        ? `${searchRegion} 검색권 · ${addressRegion} 소재`
        : (addressRegion || searchRegion);
  return [item.searchKeyword, regionText, item.address].filter(Boolean).join(" · ") || "지역/주소 확인";
}

function rankMetaChipRow(item = {}) {
  const chips = [
    item.overallRank ? `전체 ${fmtNumber(item.overallRank)}위` : "",
    item.regionalRank ? `지역 ${fmtNumber(item.regionalRank)}위` : "",
    item.adRank ? `광고 ${fmtNumber(item.adRank)}위` : "",
    item.hasInventory ? "재고 분석 완료" : "재고 미수집",
    ["within", "parent", "outside"].includes(item.regionBoundaryStatus) ? item.regionBoundaryLabel : (item.outsideSearchRegion ? "권역 밖 노출" : "")
  ].filter(Boolean);
  return `<div class="flow-chip-row">${chips.slice(0, 4).map((chip, index) => `<span class="${index === 0 ? "hot" : ""}">${escapeHtml(chip)}</span>`).join("")}</div>`;
}

function renderCompanies() {
  const analysisItems = state.data?.availability?.items || [];
  const items = isAdminRole() ? rankedCompanyItems() : b2bScopedRankedCompanyItems();
  const ranking = state.data?.ranking || {};
  const b2bRankBrief = !isAdminRole() ? renderB2BRankBrief(b2bRankBoardModel(items)) : "";
  els.rankCount.textContent = ranking.total
    ? `${fmtNumber(items.length)} 순위 · 재고 ${fmtNumber(ranking.inventoryLinkedCount || analysisItems.length)}`
    : `${fmtNumber(items.length)} 업체`;
  if (!items.length) {
    els.companyList.innerHTML = `<div class="empty">네이버 순위 데이터가 없습니다.</div>`;
    return;
  }

  const cards = items.slice(0, 30).map((item, index) => {
    const linked = inventoryLinked(item);
    const lodging = salesStats(item, "lodging");
    const insight = companyRankInsight(item, index + 1);
    const publicMode = !isAdminRole();
    const metric = insight.metricText;
    const stockStatus = item.bookingStatus || (linked ? "재고 분석 완료" : "예약ID 조회 실패/미수집");
    return `
      <article class="company-card ${publicMode ? "b2b-public-company" : ""} ${linked ? "" : "rank-only"} ${escapeHtml(insight.tone)}" data-company-index="${index}">
        <div class="company-main">
          <span class="rank-badge">${escapeHtml(item.rank || index + 1)}</span>
          <div class="company-title">
            <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
            <small>${escapeHtml(categoryText(item))}</small>
            <div class="company-badges">${companyBadges(item, linked, stockStatus)}</div>
          </div>
        </div>
        <div class="company-metric">
          <strong>${metric}</strong>
          <span>${escapeHtml(insight.metricLabel)}</span>
          <small title="${escapeHtml(stockStatus)}">${escapeHtml(insight.stockText)}</small>
        </div>
        <div class="company-chart">
          ${publicMode ? `
            ${b2bCompanyCardSummary(item, insight)}
          ` : linked ? `
            ${companyRankInsightGrid(insight)}
            ${b2bCompanyActionLine(item, insight)}
            <div class="sales-lines">
              <span class="sales-line">${escapeHtml(salesLine(item, "lodging"))}</span>
              <span class="sales-line day">${escapeHtml(salesLine(item, "day"))}</span>
            </div>
            ${flowChipRow(item)}
            ${validationReasonRow(item)}
            ${miniBars(item)}
          ` : `
            <div class="sales-lines">
              <span class="sales-line">${escapeHtml(`${item.rankingSourceLabel || "네이버 전체 순위"} ${fmtNumber(item.rank || index + 1)}위 · ${stockStatus}`)}</span>
              <span class="sales-line day">${escapeHtml(itemLocationLine(item))}</span>
            </div>
            ${rankMetaChipRow(item)}
          `}
        </div>
        <div class="company-action">
          <div class="company-price-platform">
            ${priceBlock(item)}
            <div class="platform-chips">${platformChips(item)}</div>
          </div>
          ${linked
            ? `<button class="more-button" type="button" data-open-company="${Number(item.availabilityIndex)}">더보기</button>`
            : `<button class="more-button" type="button" disabled title="${escapeHtml(stockStatus)}">상세 없음</button>`}
        </div>
      </article>
    `;
  }).join("");
  els.companyList.innerHTML = `${b2bRankBrief}${isAdminRole() ? renderValidationBoard(analysisItems) : ""}${cards}`;
}

function dateForRangeLabel(label, run = {}) {
  const match = String(label || "").match(/(\d{1,2})\/(\d{1,2})/);
  if (!match) return null;
  const base = parseDate(run.checkIn) || new Date();
  const month = Number(match[1]) - 1;
  const day = Number(match[2]);
  const year = month < base.getMonth() && base.getMonth() >= 10 ? base.getFullYear() + 1 : base.getFullYear();
  const date = new Date(year, month, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function summarizeFlowRows(rows = []) {
  const valid = rows.filter((row) => !row.missing && Number.isFinite(row.rate) && finiteNumber(row.total, 0) > 0);
  const total = valid.reduce((sum, row) => sum + finiteNumber(row.total, 0), 0);
  const sold = valid.reduce((sum, row) => sum + finiteNumber(row.sold, 0), 0);
  return {
    count: valid.length,
    sold,
    total,
    rate: total ? sold / total : NaN
  };
}

function historyCompanyBenchmark(item = {}) {
  const key = companyKey(item.name);
  return key ? state.data?.history?.benchmarks?.companyBenchmarks?.[key] || null : null;
}

function salesFlowProfile(item = {}) {
  const run = state.data?.run || {};
  const rows = bookingGraphRows(item).map((row) => {
    const date = dateForRangeLabel(row.label, run);
    return { ...row, date, day: date ? date.getDay() : null };
  });
  const collected = rows.filter((row) => !row.missing && Number.isFinite(row.rate));
  const weekdayRows = collected.filter((row) => row.day >= 1 && row.day <= 4);
  const fridayRows = collected.filter((row) => row.day === 5);
  const saturdayRows = collected.filter((row) => row.day === 6);
  const sundayRows = collected.filter((row) => row.day === 0);
  const weekday = summarizeFlowRows(weekdayRows);
  const weekdayLabel = weekday.count >= 4
    ? "평일 평균"
    : weekday.count >= 2
      ? "관측평일"
      : weekday.count === 1
        ? "평일 참고"
        : "평일 없음";
  const history = historyCompanyBenchmark(item);
  return {
    rows,
    all: summarizeFlowRows(collected),
    weekday: { ...weekday, label: weekdayLabel },
    friday: summarizeFlowRows(fridayRows),
    saturday: summarizeFlowRows(saturdayRows),
    sunday: summarizeFlowRows(sundayRows),
    history
  };
}

function flowMetricText(label, metric = {}) {
  return `${label} ${Number.isFinite(metric.rate) ? fmtRate(metric.rate) : "확인필요"}`;
}

function flowChipRow(item = {}) {
  const flow = salesFlowProfile(item);
  const historyWeekday = flow.history?.weekday;
  const historyText = historyWeekday?.observations
    ? `누적평일 ${fmtRate(historyWeekday.saleRate)}`
    : "";
  return `
    <div class="flow-chip-row" aria-label="7일 판매 흐름 요약">
      <span>${escapeHtml(flowMetricText("전체", flow.all))}</span>
      <span>${escapeHtml(`${flow.weekday.label} ${Number.isFinite(flow.weekday.rate) ? fmtRate(flow.weekday.rate) : "확인필요"}${flow.weekday.count ? ` · ${flow.weekday.count}일` : ""}`)}</span>
      <span>${escapeHtml(flowMetricText("금", flow.friday))}</span>
      <span class="${Number.isFinite(flow.saturday.rate) && flow.saturday.rate >= 0.75 ? "hot" : ""}">${escapeHtml(flowMetricText("토", flow.saturday))}</span>
      <span>${escapeHtml(flowMetricText("일", flow.sunday))}</span>
      ${historyText ? `<span class="history">${escapeHtml(historyText)}</span>` : ""}
    </div>
  `;
}

function combineFlowMetrics(metrics = []) {
  const valid = metrics.filter((metric) => metric && Number.isFinite(metric.rate) && finiteNumber(metric.total, 0) > 0);
  const sold = valid.reduce((sum, metric) => sum + finiteNumber(metric.sold, 0), 0);
  const total = valid.reduce((sum, metric) => sum + finiteNumber(metric.total, 0), 0);
  const count = valid.reduce((sum, metric) => sum + finiteNumber(metric.count, 0), 0);
  return {
    sold,
    total,
    count,
    rate: total ? sold / total : NaN
  };
}

function aggregateFlowProfiles(items = []) {
  const profiles = items.map((item) => salesFlowProfile(item));
  return {
    all: combineFlowMetrics(profiles.map((profile) => profile.all)),
    weekday: combineFlowMetrics(profiles.map((profile) => profile.weekday)),
    friday: combineFlowMetrics(profiles.map((profile) => profile.friday)),
    saturday: combineFlowMetrics(profiles.map((profile) => profile.saturday)),
    sunday: combineFlowMetrics(profiles.map((profile) => profile.sunday))
  };
}

function validationCardValue(label, value, note = "") {
  return `
    <div class="validation-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </div>
  `;
}

function effectiveDetailRankRange(run = {}) {
  const mode = run.collectionMode || "precision";
  if (mode === "fast") return "상세 생략";
  const raw = String(run.detailRankRanges || "").trim();
  return !raw || /^(none|skip|없음)$/i.test(raw) ? "1-20" : raw;
}

function rankRangeSegments(value = "") {
  const text = normalizedRankRangeText(value).replace(/위/g, "");
  if (!text || /^(상세생략|순위만)$/i.test(text)) return [];
  return text
    .split(/[,/|]+/)
    .map((part) => {
      const numbers = (part.match(/\d+/g) || []).map((number) => Number(number)).filter((number) => Number.isFinite(number) && number > 0);
      if (!numbers.length) return null;
      const start = numbers[0];
      const end = numbers[1] || numbers[0];
      return {
        start: Math.min(start, end),
        end: Math.max(start, end)
      };
    })
    .filter(Boolean);
}

function rankInSegments(rank, segments = []) {
  const number = Number(rank);
  if (!Number.isFinite(number) || !segments.length) return true;
  return segments.some((segment) => number >= segment.start && number <= segment.end);
}

function b2bScopedRankedCompanyItems(items = rankedCompanyItems(), run = state.data?.run || {}) {
  const range = effectiveDetailRankRange(run);
  const segments = rankRangeSegments(range);
  if (!segments.length) return items.slice(0, 30);
  return items.filter((item, index) => {
    const rank = finiteNumber(item.rank || item.overallRank || index + 1, index + 1);
    return rankInSegments(rank, segments);
  });
}

function naverCouponInfo(item = {}) {
  const latest = item.companyProfile?.inventory?.latest || {};
  const latestSignal = latest.salesSignal || {};
  const salesTargetSignals = item.companyProfile?.salesTarget?.signals || {};
  const couponSignal = latest.couponSignal || latestSignal.couponSignal || {};
  const status = String(item.naverCouponStatus || couponSignal.status || latestSignal.naverCouponStatus || salesTargetSignals.couponStatus || "").trim();
  const names = String(item.naverCouponNames || couponSignal.names || latestSignal.naverCouponNames || salesTargetSignals.couponNames || "").trim();
  const channel = String(item.naverCouponChannel || couponSignal.channel || latestSignal.naverCouponChannel || salesTargetSignals.couponChannel || "").trim();
  const detail = String(item.naverCouponDetail || couponSignal.detail || latestSignal.naverCouponDetail || salesTargetSignals.couponDetail || "").trim();
  const visible = Boolean(
    status === "있음" ||
    names ||
    couponSignal.visible ||
    latestSignal.naverCouponVisible ||
    salesTargetSignals.couponVisible
  );
  return {
    visible,
    status: status || (visible ? "있음" : ""),
    names,
    channel: channel || (visible ? "네이버" : ""),
    detail: detail || (visible ? "네이버 공개 화면 쿠폰 노출" : "자동 수집 제한 · 네이버 화면 수동 확인")
  };
}

function collectionStatusProfile(item = {}) {
  const rows = bookingGraphRows(item);
  const collectedRows = rows.filter((row) => !row.missing && finiteNumber(row.total, 0) > 0);
  const missingDates = rows.filter((row) => row.missing).map((row) => row.label);
  const lodging = salesStats(item, "lodging");
  const dayUse = salesStats(item, "day");
  const lodgingRevenue = itemRevenueStats(item, "lodging");
  const dayUseRevenue = itemRevenueStats(item, "day");
  const confidence = inventoryConfidenceInfo(item);
  const structure = inventoryStructureInfo(item);
  const coupon = naverCouponInfo(item);
  const flags = new Set(structure.flags || []);
  const soldQuantity = finiteNumber(lodging.sold, 0) + finiteNumber(dayUse.sold, 0);
  const pricedQuantity = finiteNumber(lodgingRevenue.pricedSoldOut, 0) + finiteNumber(dayUseRevenue.pricedSoldOut, 0);
  const missingPriceQuantity = finiteNumber(lodgingRevenue.missingPriceSoldOut, 0) + finiteNumber(dayUseRevenue.missingPriceSoldOut, 0);
  const productCount = finiteNumber(item.countedItemCount, 0) + finiteNumber(item.nightItemCount, 0) + finiteNumber(item.dayUseItemCount, 0);
  const productKnown = productCount > 0 || Boolean(String(item.productTypeSummary || "").trim());
  const manualCorrection = item.companyManualCorrection || item.companyProfile?.manualCorrection || {};
  const manualLodgingBasis = manualCorrectionHasBasis(manualCorrection) ? finiteNumber(manualCorrection.lodgingBasisTotal, 0) : 0;
  const basisTotal = finiteNumber(item.weeklyBasisTotal, manualLodgingBasis);
  const operatingTotal = manualLodgingBasis || finiteNumber(item.weeklyOperatingTotal, basisTotal);
  const structuralBlockedQuantity = finiteNumber(item.weeklyStructuralBlockedTotal, Math.max(0, basisTotal - operatingTotal)) +
    finiteNumber(item.dayUseWeeklyStructuralBlockedTotal, 0);
  const quantityUnclear = Boolean(
    ["D", "E"].includes(confidence.grade) ||
    ["unknown", "stock_only", "grouped_stock"].includes(structure.type) ||
    flags.has("booking_id_reused") ||
    flags.has("grouped_range") ||
    missingDates.length > 0
  );
  const priceMissing = Boolean(
    missingPriceQuantity > 0 ||
    (soldQuantity > 0 && pricedQuantity === 0 && lodgingRevenue.basis === "missing" && dayUseRevenue.basis === "missing")
  );
  const offlineQuantity = Math.max(
    finiteNumber(item.weeklyOfflineReservedTotal, 0),
    rows.reduce((sum, row) => sum + finiteNumber(row.offlineSold || row.hidden, 0), 0)
  ) + finiteNumber(item.dayUseWeeklyOfflineReservedTotal, 0);
  const hasOfflineDetail = Boolean(item.weeklyOfflineReservationDetail || item.dayUseWeeklyOfflineReservationDetail);
  const offlineEstimated = offlineQuantity > 0 || hasOfflineDetail;
  const basisRule = manualLodgingBasis
    ? `관리자 보정값 ${fmtNumber(manualLodgingBasis)}개 기준`
    : item.weeklyBasisRule || (basisTotal
    ? `전체객실수 후보는 날짜별 숙박 총량 최대값 ${fmtNumber(basisTotal)}개 기준`
    : "날짜별 총량 최대값 기준");
  const statusKey = !collectedRows.length
    ? "missing"
    : priceMissing || quantityUnclear || !productKnown
      ? "partial"
      : "ready";
  const tone = statusKey === "ready" ? "good" : statusKey === "partial" ? "watch" : "bad";
  const reasons = [];
  if (!collectedRows.length) reasons.push("날짜별 재고가 확보되지 않음");
  if (missingDates.length) reasons.push(`미수집 날짜 ${fmtNumber(missingDates.length)}일`);
  if (quantityUnclear) reasons.push(`수량 신뢰도 ${confidence.grade} · ${structure.label}`);
  if (!productKnown) reasons.push("상품별 수량 구조 확인 필요");
  if (priceMissing) reasons.push(`가격 누락 판매수량 ${fmtNumber(missingPriceQuantity || soldQuantity)}개/회`);
  if (structuralBlockedQuantity > 0) reasons.push(`상시 차단/운영 축소 ${fmtNumber(structuralBlockedQuantity)}개/회`);
  if (offlineEstimated) reasons.push("오프라인 예약/차단 추정 포함");
  return {
    statusKey,
    tone,
    label: statusKey === "ready" ? "데이터 확보" : statusKey === "partial" ? "부분 확보" : "미확보",
    collectedDays: collectedRows.length,
    expectedDays: rows.length,
    missingDates,
    productKnown,
    productCount,
    quantityUnclear,
    priceMissing,
    pricedQuantity,
    missingPriceQuantity,
    soldQuantity,
    offlineEstimated,
    offlineQuantity,
    basisTotal,
    operatingTotal,
    structuralBlockedQuantity,
    basisRule,
    coupon,
    reasons: reasons.slice(0, 5)
  };
}

function collectionDiagnosticProfile(items = []) {
  const run = state.data?.run || {};
  const counts = run.counts || {};
  const ranking = state.data?.ranking || {};
  const checked = finiteNumber(counts.naverBookingStockChecked, 0);
  const succeeded = finiteNumber(counts.naverBookingStockSucceeded, items.length);
  const skippedByRank = finiteNumber(counts.naverBookingStockSkippedByRank, 0);
  const skippedByMode = finiteNumber(counts.naverBookingStockSkippedByMode, 0);
  const candidates = Math.max(checked + skippedByRank + skippedByMode, finiteNumber(ranking.total, 0));
  const rankOnly = (ranking.items || []).filter((item) => !inventoryLinked(item)).length;
  const profiles = items.map((item) => collectionStatusProfile(item));
  const missingData = profiles.filter((profile) => profile.statusKey === "missing").length;
  const partialData = profiles.filter((profile) => profile.statusKey === "partial").length;
  const priceMissing = profiles.filter((profile) => profile.priceMissing).length;
  const quantityUnclear = profiles.filter((profile) => profile.quantityUnclear || !profile.productKnown).length;
  const missingDates = profiles.filter((profile) => profile.missingDates.length).length;
  const offlineEstimated = profiles.filter((profile) => profile.offlineEstimated).length;
  const successRate = checked ? succeeded / checked : NaN;
  const coverageRate = candidates ? succeeded / candidates : NaN;
  const precision = (run.collectionMode || "precision") !== "fast";
  const zeroPrecisionData = precision && !items.length;
  const tone = zeroPrecisionData
    ? "bad"
    : (!precision || partialData || priceMissing || quantityUnclear || rankOnly || skippedByRank)
      ? "watch"
      : "good";
  const issues = [];
  if (!precision) {
    issues.push(["빠른 순위 모드", skippedByMode || candidates, "상세 재고를 의도적으로 생략했습니다.", "watch"]);
  }
  if (zeroPrecisionData && skippedByRank) {
    issues.push(["범위 제외", skippedByRank, "상세 수집 순위 범위 밖이라 재고를 확인하지 못했습니다.", "bad"]);
  } else if (skippedByRank) {
    issues.push(["범위 제외", skippedByRank, "지정 순위 밖 후보입니다. 필요 시 1-30 등으로 범위를 넓히세요.", "watch"]);
  }
  if (precision && checked === 0 && !skippedByRank) {
    issues.push(["확인 시도 0", 0, "네이버예약 링크/예약ID 또는 상세 조건을 확인해야 합니다.", "bad"]);
  }
  if (checked > 0 && succeeded === 0) {
    issues.push(["재고 확인 실패", checked, "예약재고 API 응답 또는 파서 결과가 연결되지 않았습니다.", "bad"]);
  }
  if (rankOnly) {
    issues.push(["노출만 확인", rankOnly, "네이버 순위는 있으나 재고 상세가 없는 업체입니다.", "watch"]);
  }
  if (missingDates) {
    issues.push(["미수집 날짜", missingDates, "기간 중 일부 날짜 재고가 없어 상세 재수집 대상입니다.", "watch"]);
  }
  if (quantityUnclear) {
    issues.push(["수량 구조 확인", quantityUnclear, "상품별 수량 또는 객실 구조가 불명확합니다.", "watch"]);
  }
  if (priceMissing) {
    issues.push(["가격 누락", priceMissing, "판매수량은 있으나 가격이 없어 매출 산정에서 제외된 업체입니다.", "watch"]);
  }
  if (offlineEstimated) {
    issues.push(["오프라인 예약 추정", offlineEstimated, "운영 기준 미만 부족분을 오프라인 예약/일시 차단으로 해석했습니다.", "good"]);
  }
  return {
    run,
    rangeLabel: effectiveDetailRankRange(run),
    precision,
    tone,
    checked,
    succeeded,
    skippedByRank,
    skippedByMode,
    candidates,
    rankOnly,
    acquired: items.length,
    partialData,
    missingData,
    priceMissing,
    quantityUnclear,
    missingDates,
    offlineEstimated,
    successRate,
    coverageRate,
    issues
  };
}

function collectionQualityScore(diag = {}) {
  let score = 100;
  if (!diag.precision) score -= 18;
  if (diag.checked > 0 && diag.succeeded === 0) score -= 35;
  if (diag.candidates > 0 && diag.acquired === 0) score -= 25;
  if (Number.isFinite(diag.successRate)) {
    score -= Math.round(Math.max(0, 0.92 - diag.successRate) * 46);
  } else if (!diag.checked) {
    score -= 10;
  }
  if (Number.isFinite(diag.coverageRate)) {
    score -= Math.round(Math.max(0, 0.82 - diag.coverageRate) * 34);
  }
  score -= Math.min(20, finiteNumber(diag.rankOnly, 0) * 4);
  score -= Math.min(18, finiteNumber(diag.skippedByRank, 0) * 2);
  score -= Math.min(18, finiteNumber(diag.priceMissing, 0) * 3);
  score -= Math.min(18, finiteNumber(diag.quantityUnclear, 0) * 3);
  score -= Math.min(18, finiteNumber(diag.missingData, 0) * 6 + finiteNumber(diag.missingDates, 0) * 3 + finiteNumber(diag.partialData, 0) * 2);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 85 ? "안정" : score >= 70 ? "주의" : score >= 50 ? "재수집 권장" : "수집 불안정";
  const tone = score >= 85 ? "good" : score >= 50 ? "watch" : "bad";
  const summary = score >= 85
    ? "현재 수집 결과를 바로 판단에 활용할 수 있습니다."
    : score >= 70
      ? "일부 업체는 확인 후 판단하는 것이 좋습니다."
      : score >= 50
        ? "가격/수량/범위 누락을 보강 수집해야 합니다."
        : "현재 결과만으로 영업 판단을 내리기 어렵습니다.";
  return { score, label, tone, summary };
}

function collectionQualityRankRangeForRank(rank) {
  const value = Number(rank || 0);
  if (value > 0 && value <= 5) return "1-5";
  if (value > 0 && value <= 10) return "1-10";
  if (value > 0 && value <= 20) return "1-20";
  return "1-30";
}

function collectionQualityHistoryAlerts(activeKeywordRow = null) {
  const rows = activeKeywordRow?.timeline || [];
  if (rows.length < 2) return [];
  const latest = rows[rows.length - 1] || {};
  const previous = rows[rows.length - 2] || {};
  const alerts = [];
  const latestCount = finiteNumber(latest.companyCount, NaN);
  const previousCount = finiteNumber(previous.companyCount, NaN);
  if (Number.isFinite(latestCount) && Number.isFinite(previousCount) && previousCount > 0 && latestCount < previousCount * 0.7) {
    alerts.push({
      key: "history_company_drop",
      label: "수집 업체 수 급감",
      value: `${fmtNumber(previousCount)} → ${fmtNumber(latestCount)}업체`,
      detail: "직전 회차 대비 확보 업체가 30% 이상 줄었습니다. 상세 순위 범위나 예약ID 연결을 재확인해야 합니다.",
      tone: "bad",
      severity: 92
    });
  }
  const latestObservations = finiteNumber(latest.observations, NaN);
  const previousObservations = finiteNumber(previous.observations, NaN);
  if (Number.isFinite(latestObservations) && Number.isFinite(previousObservations) && previousObservations > 0 && latestObservations < previousObservations * 0.65) {
    alerts.push({
      key: "history_observation_drop",
      label: "관측치 급감",
      value: `${fmtNumber(previousObservations)} → ${fmtNumber(latestObservations)}건`,
      detail: "날짜별 수량/가격 관측치가 직전보다 크게 줄었습니다. 동일 기간 재수집을 권장합니다.",
      tone: "watch",
      severity: 82
    });
  }
  const latestRate = Number(latest.saleRate);
  const previousRate = Number(previous.saleRate);
  if (Number.isFinite(latestRate) && Number.isFinite(previousRate) && previousRate - latestRate >= 0.25) {
    alerts.push({
      key: "history_sale_rate_drop",
      label: "판매율 급락",
      value: `${fmtRate(previousRate)} → ${fmtRate(latestRate)}`,
      detail: "판매율 급락은 실제 시장 변화일 수 있지만, 수집 누락과 구분하기 위해 재수집 비교가 필요합니다.",
      tone: "watch",
      severity: 70
    });
  }
  return alerts;
}

function collectionQualityAlerts(diag = {}, activeKeywordRow = null) {
  const alerts = [
    ...collectionQualityHistoryAlerts(activeKeywordRow),
    ...(diag.issues || []).map(([label, count, detail, tone]) => ({
      key: companyKey(label),
      label,
      value: `${fmtNumber(count)}건`,
      detail,
      tone,
      severity: tone === "bad" ? 90 : tone === "watch" ? 70 : 40
    }))
  ];
  if (diag.priceMissing > 0 || diag.quantityUnclear > 0) {
    alerts.push({
      key: "price_quantity_coverage",
      label: "가격/수량 확보율 저하",
      value: `가격 ${fmtNumber(diag.priceMissing)} · 수량 ${fmtNumber(diag.quantityUnclear)}`,
      detail: "요일별 가격과 상품별 수량이 확인되지 않은 업체는 예상 매출 산정에서 보수적으로 분리됩니다.",
      tone: "watch",
      severity: 76
    });
  }
  if (diag.skippedByRank > 0) {
    alerts.push({
      key: "rank_range_skipped",
      label: "상세 수집 범위 밖 업체",
      value: `${fmtNumber(diag.skippedByRank)}개`,
      detail: "플레이스 순위 범위를 1-5, 6-10, 10-20처럼 분할하면 속도와 정확도를 함께 관리할 수 있습니다.",
      tone: "watch",
      severity: 68
    });
  }
  return alerts
    .filter((row, index, list) => list.findIndex((other) => other.key === row.key) === index)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 8);
}

function collectionQualityCompanyIndexForName(name = "", companyId = "") {
  const items = state.data?.availability?.items || [];
  if (companyId) {
    const idIndex = items.findIndex((item) => item.companyProfile?.companyId === companyId);
    if (idIndex >= 0) return idIndex;
  }
  const key = companyKey(name);
  if (!key) return -1;
  return items.findIndex((item) => companyKey(item.name) === key);
}

function collectionQualityRecrawlRows(diag = {}) {
  const items = state.data?.availability?.items || [];
  const rankingItems = state.data?.ranking?.items || [];
  const rows = [];
  items.forEach((item, index) => {
    const profile = collectionStatusProfile(item);
    const decision = decisionQueueProfile(item);
    if (profile.statusKey === "ready" && !decision.inQueue) return;
    const rank = Number(item.rank || item.overallRank || index + 1);
    const reasons = [
      decision.inQueue ? `판단 큐: ${decision.label}` : "",
      ...profile.reasons,
      decision.problemDateText && decision.problemDateText !== "문제 날짜 없음" ? `문제 날짜: ${decision.problemDateText}` : "",
      profile.priceMissing ? "요일/상품별 판매가 재확인" : "",
      profile.quantityUnclear ? "상품별 총량 구조 재확인" : ""
    ].filter(Boolean);
    const score = (decision.priority || 0)
      + (profile.statusKey === "missing" ? 42 : 0)
      + (profile.statusKey === "partial" ? 24 : 0)
      + (profile.priceMissing ? 12 : 0)
      + (profile.quantityUnclear ? 12 : 0)
      + (rank > 0 && rank <= 10 ? 8 : 0);
    rows.push({
      key: item.companyProfile?.companyId || companyKey(item.name) || `current-${index}`,
      source: "현재 수집",
      name: item.name || "업체명 확인",
      region: item.region || item.address || "",
      rank,
      score,
      tone: profile.statusKey === "missing" ? "bad" : "watch",
      reason: compactListText(reasons, "재수집 확인 필요", 3),
      setting: `정밀분석 · 상세 ${collectionQualityRankRangeForRank(rank)}위`,
      range: collectionQualityRankRangeForRank(rank),
      revenue: 0,
      itemIndex: index
    });
  });
  rankingItems.forEach((item, index) => {
    if (inventoryLinked(item)) return;
    const rank = Number(item.rank || item.overallRank || index + 1);
    const key = companyKey(item.name) || `rank-${index}`;
    if (rows.some((row) => row.key === key)) return;
    rows.push({
      key,
      source: "순위 노출",
      name: item.name || "업체명 확인",
      region: item.region || item.address || "",
      rank,
      score: 36 + (rank > 0 && rank <= 10 ? 10 : 0),
      tone: "watch",
      reason: "네이버 노출은 있으나 상세 재고/가격이 확보되지 않았습니다.",
      setting: `정밀분석 · 상세 ${collectionQualityRankRangeForRank(rank)}위`,
      range: collectionQualityRankRangeForRank(rank),
      revenue: 0,
      itemIndex: collectionQualityCompanyIndexForName(item.name)
    });
  });
  companyDecisionQueueEntries(companyMasterSource())
    .filter((entry) => entry.workflow.key !== "done")
    .forEach((entry) => {
      const company = entry.company || {};
      const plan = companyQueueRecrawlPlan(company, entry.profile, entry.decision);
      const rank = Number(company.bestRank || 0);
      const revenue = effectiveRevenueValue(entry.revenueImpact || {});
      const key = company.companyId || companyKey(company.primaryName);
      const existing = rows.find((row) => row.key === key);
      const reason = compactListText([
        entry.autoRecommendation?.label,
        entry.decision?.summary,
        entry.type?.label,
        entry.profile?.issues?.[0]?.label
      ], "관리자 판단 필요", 3);
      const row = {
        key,
        source: "판단 큐",
        name: company.primaryName || "업체명 확인",
        region: (company.regions || []).slice(0, 2).join(" / "),
        rank,
        score: finiteNumber(entry.priority?.score, 0) + Math.min(20, revenue / 150000) + (entry.autoRecommendation?.status === "recrawl_needed" ? 12 : 0),
        tone: entry.autoRecommendation?.tone || entry.type?.tone || "watch",
        reason,
        setting: `정밀분석 · 상세 ${plan.range || "1-20"}위`,
        range: plan.range || "1-20",
        revenue,
        itemIndex: collectionQualityCompanyIndexForName(company.primaryName, company.companyId)
      };
      if (existing) {
        existing.score = Math.max(existing.score, row.score);
        existing.source = `${existing.source} + 판단 큐`;
        existing.revenue = Math.max(existing.revenue || 0, revenue);
        existing.reason = compactListText([existing.reason, reason], "관리자 판단 필요", 3);
      } else {
        rows.push(row);
      }
    });
  if (diag.checked > 0 && diag.succeeded === 0 && !rows.length) {
    rows.push({
      key: "all_failed",
      source: "수집 실패",
      name: activeKeyword(),
      region: "",
      rank: 0,
      score: 100,
      tone: "bad",
      reason: "상세 재고 확인을 시도했지만 성공 업체가 없습니다.",
      setting: "정밀분석 · 상세 1-20위",
      range: "1-20",
      revenue: 0,
      itemIndex: -1
    });
  }
  return rows
    .filter((row) => row.name)
    .sort((a, b) => b.score - a.score || finiteNumber(b.revenue, 0) - finiteNumber(a.revenue, 0) || finiteNumber(a.rank, 9999) - finiteNumber(b.rank, 9999))
    .slice(0, 8);
}

function collectionQualitySettingFeedback(diag = {}, quality = {}) {
  const keyword = activeKeyword();
  const rows = [];
  if (!diag.precision) {
    rows.push({
      label: "정밀분석으로 전환",
      value: "상세 1-20위",
      detail: "빠른 순위 모드는 상세 재고를 생략하므로 판단 큐/예상 매출 산정에는 정밀분석이 필요합니다.",
      range: "1-20",
      mode: "precision",
      keyword
    });
  }
  if (diag.skippedByRank > 0 || diag.rankOnly > 0) {
    rows.push({
      label: "상세 범위 확대",
      value: "1-30위",
      detail: "노출만 있고 재고가 없는 업체가 많으면 상세 범위를 1-30위까지 넓혀 확인합니다.",
      range: "1-30",
      mode: "precision",
      keyword
    });
  }
  if (diag.priceMissing > 0 || diag.quantityUnclear > 0 || diag.missingDates > 0) {
    rows.push({
      label: "동일 기간 재수집",
      value: effectiveDetailRankRange(diag.run),
      detail: "요일별 가격, 상품별 총량, 미수집 날짜를 같은 기간으로 다시 확인합니다.",
      range: effectiveDetailRankRange(diag.run) === "상세 생략" ? "1-20" : effectiveDetailRankRange(diag.run),
      mode: "precision",
      keyword
    });
  }
  rows.push({
    label: "순위 구간 분할",
    value: "1-5 / 6-10 / 10-20",
    detail: "상위권은 정확도, 10-20위권은 신규 후보 발굴로 나눠 수집하면 속도와 비용을 조절할 수 있습니다.",
    range: "1-5,6-10,10-20",
    mode: "precision",
    keyword
  });
  if (quality.score >= 85 && !diag.skippedByRank && !diag.priceMissing && !diag.quantityUnclear) {
    rows.push({
      label: "속도 우선 가능",
      value: "상세 1-5위",
      detail: "품질 점수가 안정이면 상위 1-5위만 정밀 확인하고 나머지는 빠른 순위로 확인해도 됩니다.",
      range: "1-5",
      mode: "precision",
      keyword
    });
  }
  return rows
    .filter((row, index, list) => list.findIndex((other) => `${other.label}-${other.value}` === `${row.label}-${row.value}`) === index)
    .slice(0, 5);
}

function collectionQualityMonitorProfile() {
  const items = state.data?.availability?.items || [];
  const diag = collectionDiagnosticProfile(items);
  const quality = collectionQualityScore(diag);
  const activeKeywordRow = activeHistoryKeywordSummary();
  const alerts = collectionQualityAlerts(diag, activeKeywordRow);
  const recrawlRows = collectionQualityRecrawlRows(diag);
  const feedback = collectionQualitySettingFeedback(diag, quality);
  return {
    diag,
    quality,
    activeKeywordRow,
    alerts,
    recrawlRows,
    feedback,
    hasData: Boolean(items.length || state.data?.ranking?.items?.length || diag.checked || diag.candidates)
  };
}

function collectionQualityMetric(label, value, note = "", tone = "") {
  return `
    <article class="${escapeHtml(tone)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </article>
  `;
}

function collectionQualityDetailLabel(diag = {}) {
  return diag.precision ? `상세 ${diag.rangeLabel}위` : "상세 생략";
}

function collectionQualityMonitorHtml() {
  const profile = collectionQualityMonitorProfile();
  const { diag, quality, alerts, recrawlRows, feedback } = profile;
  if (!profile.hasData) {
    return `
      <section class="collection-quality-panel">
        <div class="collection-quality-head">
          <div>
            <p class="eyebrow">수집 안정성 모니터링 V2</p>
            <h3>수집 결과 대기</h3>
            <p>정밀분석을 실행하면 품질 점수, 이상 수집 신호, 재수집 우선순위를 자동으로 계산합니다.</p>
          </div>
        </div>
      </section>
    `;
  }
  return `
    <section class="collection-quality-panel ${escapeHtml(quality.tone)}">
      <div class="collection-quality-head">
        <div>
          <p class="eyebrow">수집 안정성 모니터링 V2</p>
          <h3>데이터 품질 ${fmtNumber(quality.score)}점 · ${escapeHtml(quality.label)}</h3>
          <p>${escapeHtml(quality.summary)} 현재 설정은 ${escapeHtml(diag.run.collectionModeLabel || collectionModeLabel(diag.run.collectionMode))} · ${escapeHtml(collectionQualityDetailLabel(diag))} 기준입니다.</p>
        </div>
        <button type="button" data-export-collection-quality>품질 CSV</button>
      </div>
      <div class="collection-quality-metrics">
        ${collectionQualityMetric("품질 점수", `${fmtNumber(quality.score)}점`, quality.label, quality.tone)}
        ${collectionQualityMetric("확인/성공", `${fmtNumber(diag.checked)}/${fmtNumber(diag.succeeded)}`, Number.isFinite(diag.successRate) ? `성공률 ${fmtRate(diag.successRate)}` : "시도 없음")}
        ${collectionQualityMetric("후보 대비 확보", fmtNumber(diag.acquired), Number.isFinite(diag.coverageRate) ? `확보율 ${fmtRate(diag.coverageRate)}` : "상세 재고 기준")}
        ${collectionQualityMetric("가격/수량 이슈", fmtNumber(diag.priceMissing + diag.quantityUnclear), `가격 ${fmtNumber(diag.priceMissing)} · 수량 ${fmtNumber(diag.quantityUnclear)}`, diag.priceMissing || diag.quantityUnclear ? "watch" : "good")}
        ${collectionQualityMetric("범위/노출 누락", fmtNumber(diag.skippedByRank + diag.rankOnly), `범위밖 ${fmtNumber(diag.skippedByRank)} · 노출만 ${fmtNumber(diag.rankOnly)}`, diag.skippedByRank || diag.rankOnly ? "watch" : "good")}
      </div>
      <div class="collection-quality-grid">
        <article>
          <div class="history-card-head">
            <strong>이상 수집 신호</strong>
            <small>실패·부분 수집·급감 감지</small>
          </div>
          <div class="collection-quality-alerts">
            ${alerts.length ? alerts.map((row) => `
              <div class="${escapeHtml(row.tone)}">
                <b>${escapeHtml(row.label)}</b>
                <span>${escapeHtml(row.value)}</span>
                <small>${escapeHtml(row.detail)}</small>
              </div>
            `).join("") : `
              <div class="good">
                <b>이상 신호 없음</b>
                <span>정상</span>
                <small>현재 설정에서 뚜렷한 수집 오류나 급감 신호가 없습니다.</small>
              </div>
            `}
          </div>
        </article>
        <article>
          <div class="history-card-head">
            <strong>재수집 우선순위</strong>
            <small>사람 판단 전 보강 대상</small>
          </div>
          <div class="collection-quality-recrawl">
            ${recrawlRows.length ? recrawlRows.map((row, index) => `
              <div class="${escapeHtml(row.tone)}">
                <mark>${fmtNumber(index + 1)}</mark>
                <div>
                  <strong>${escapeHtml(row.name)}</strong>
                  <small>${escapeHtml([row.source, row.region, row.rank ? `${fmtNumber(row.rank)}위` : "", row.revenue ? `예상 ${fmtWon(row.revenue)}` : ""].filter(Boolean).join(" · "))}</small>
                  <p>${escapeHtml(row.reason)}</p>
                </div>
                <button type="button" data-apply-quality-setting data-quality-range="${escapeHtml(row.range)}" data-quality-mode="precision" data-quality-keyword="${escapeHtml(activeKeyword())}">${escapeHtml(row.setting)}</button>
                ${row.itemIndex >= 0 ? `<button type="button" data-open-company="${row.itemIndex}">상세</button>` : ""}
              </div>
            `).join("") : `<p class="empty">재수집 우선 대상이 없습니다.</p>`}
          </div>
        </article>
        <article class="wide">
          <div class="history-card-head">
            <strong>수집 설정 피드백</strong>
            <small>검색 속도와 정확도 조절</small>
          </div>
          <div class="collection-quality-feedback">
            ${feedback.map((row) => `
              <div>
                <span>${escapeHtml(row.label)}</span>
                <strong>${escapeHtml(row.value)}</strong>
                <small>${escapeHtml(row.detail)}</small>
                <button type="button" data-apply-quality-setting data-quality-range="${escapeHtml(row.range)}" data-quality-mode="${escapeHtml(row.mode)}" data-quality-keyword="${escapeHtml(row.keyword)}">설정 적용</button>
              </div>
            `).join("")}
          </div>
        </article>
      </div>
    </section>
  `;
}

function renderCollectionDiagnostics(items = []) {
  const diag = collectionDiagnosticProfile(items);
  const modeLabel = diag.precision ? `상세 ${diag.rangeLabel}위` : "상세 생략";
  const statusLabel = diag.tone === "good"
    ? "정밀분석 데이터 확보"
    : diag.tone === "bad"
      ? "데이터 미확보 원인 확인"
      : "데이터 부분 확보";
  const issueRows = diag.issues.length ? diag.issues : [["특이사항 없음", diag.acquired, "현재 범위에서는 재고/가격/수량 진단 신호가 안정적입니다.", "good"]];
  return `
    <div class="validation-card validation-card-collection ${escapeHtml(diag.tone)}">
      <div class="validation-card-head">
        <div>
          <span class="eyebrow">정밀분석 데이터 확보 진단</span>
          <h3>${escapeHtml(statusLabel)}</h3>
        </div>
        <span>${escapeHtml(diag.run.collectionModeLabel || collectionModeLabel(diag.run.collectionMode))} · ${escapeHtml(modeLabel)}</span>
      </div>
      <div class="collection-diagnostic-grid">
        ${validationCardValue("재고 후보", fmtNumber(diag.candidates || diag.checked + diag.skippedByRank), `범위 제외 ${fmtNumber(diag.skippedByRank)}`)}
        ${validationCardValue("확인/성공", `${fmtNumber(diag.checked)}/${fmtNumber(diag.succeeded)}`, Number.isFinite(diag.successRate) ? `성공률 ${fmtRate(diag.successRate)}` : "시도 없음")}
        ${validationCardValue("확보 업체", fmtNumber(diag.acquired), Number.isFinite(diag.coverageRate) ? `후보 대비 ${fmtRate(diag.coverageRate)}` : "재고 상세")}
        ${validationCardValue("노출만 확인", fmtNumber(diag.rankOnly), "순위는 있으나 상세 재고 없음")}
        ${validationCardValue("가격/수량 확인", fmtNumber(diag.priceMissing + diag.quantityUnclear), `가격 ${fmtNumber(diag.priceMissing)} · 수량 ${fmtNumber(diag.quantityUnclear)}`)}
        ${validationCardValue("오프라인 추정", fmtNumber(diag.offlineEstimated), "미오픈/차단 포함 해석")}
      </div>
      <div class="collection-diagnostic-list">
        ${issueRows.map(([label, count, note, tone]) => `
          <div class="${escapeHtml(tone)}">
            <strong>${escapeHtml(label)}</strong>
            <b>${fmtNumber(count)}</b>
            <small>${escapeHtml(note)}</small>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function medianNumber(values = []) {
  const sorted = values
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stockVarianceRowsFromDetail(detail = "") {
  const rows = String(detail || "")
    .split(/\s*,\s*/)
    .map((entry) => {
      const match = entry.match(/(\d{1,2}\/\d{1,2}).*?원시\s+(\d+)\/(\d+)(?:.*?오프라인예약\s+(\d+))?/);
      if (!match) return null;
      return {
        label: normalizeMonthDayLabel(match[1]),
        rawAvailable: Number(match[2]),
        rawTotal: Number(match[3]),
        offlineReserved: Number(match[4] || 0)
      };
    })
    .filter((row) => row && Number.isFinite(row.rawTotal) && row.rawTotal > 0);
  const maxTotal = rows.length ? Math.max(...rows.map((row) => row.rawTotal)) : 0;
  return rows.map((row) => ({
    ...row,
    offlineReserved: row.offlineReserved || (maxTotal ? Math.max(0, maxTotal - row.rawTotal) : 0)
  }));
}

function rateGapText(value) {
  return Number.isFinite(Number(value)) ? formatSignedRate(Number(value)) : "대기";
}

function compactListText(values = [], emptyText = "없음", limit = 4) {
  const unique = [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!unique.length) return emptyText;
  const shown = unique.slice(0, limit);
  const suffix = unique.length > shown.length ? ` 외 ${fmtNumber(unique.length - shown.length)}` : "";
  return `${shown.join(", ")}${suffix}`;
}

function isReviewBeforeCorrection(review = {}, correction = {}) {
  const correctionAt = correction?.updatedAt || "";
  const reviewAt = review?.updatedAt || "";
  if (!correctionAt) return false;
  if (!reviewAt) return true;
  const correctionTime = Date.parse(correctionAt);
  const reviewTime = Date.parse(reviewAt);
  return Number.isFinite(correctionTime) && Number.isFinite(reviewTime) && correctionTime > reviewTime;
}

function inventoryAuditProfile(item = {}) {
  const rows = bookingGraphRows(item);
  const collectedRows = rows.filter((row) => !row.missing && finiteNumber(row.total, 0) > 0);
  const rawVarianceRows = stockVarianceRowsFromDetail(item.weeklyRawStockVariance);
  const rawTotals = collectedRows
    .map((row) => finiteNumber(row.rawTotal, row.total))
    .filter((value) => value > 0);
  const varianceTotals = rawVarianceRows.map((row) => row.rawTotal).filter((value) => value > 0);
  const totalMax = finiteNumber(item.weeklyMaxTotal, 0) || finiteNumber(item.weeklyBasisTotal, 0) || (varianceTotals.length ? Math.max(...varianceTotals) : (rawTotals.length ? Math.max(...rawTotals) : 0));
  const totalMin = finiteNumber(item.weeklyMinTotal, 0) || (varianceTotals.length ? Math.min(...varianceTotals) : (rawTotals.length ? Math.min(...rawTotals) : 0));
  const operatingTotal = finiteNumber(item.weeklyOperatingTotal, totalMax);
  const structuralBlockedTotal = finiteNumber(item.weeklyStructuralBlockedTotal, Math.max(0, totalMax - operatingTotal));
  const totalMedian = medianNumber(rawTotals);
  const totalGap = finiteNumber(item.weeklyTotalVarianceGap, 0) || Math.max(0, totalMax - totalMin);
  const totalGapRate = totalMax ? totalGap / totalMax : NaN;
  const varianceRows = rawVarianceRows.length ? rawVarianceRows.filter((row) => row.rawTotal < totalMax) : collectedRows.filter((row) => {
    const rawTotal = finiteNumber(row.rawTotal, row.total);
    if (!rawTotal || !Number.isFinite(totalMedian)) return false;
    return rawTotal <= totalMedian * 0.72 || rawTotal >= totalMedian * 1.28;
  });
  const missingCount = rows.filter((row) => row.missing).length;
  const structure = inventoryStructureInfo(item);
  const confidence = inventoryConfidenceInfo(item);
  const flow = salesFlowProfile(item);
  const weekdayHistory = flow.history?.weekday;
  const weekdayGap = Number.isFinite(flow.weekday.rate) && Number.isFinite(Number(weekdayHistory?.saleRate))
    ? flow.weekday.rate - Number(weekdayHistory.saleRate)
    : NaN;
  const lodging = salesStats(item, "lodging");
  const day = salesStats(item, "day");
  const flags = new Set(structure.flags || []);
  const reasons = [];
  const actions = [];
  const otaSignals = [];
  const issueChannels = new Set();
  const problemDates = {
    missing: rows.filter((row) => row.missing).map((row) => row.label),
    variance: varianceRows.map((row) => {
      const rawTotal = finiteNumber(row.rawTotal, row.total);
      const offline = operatingTotal ? Math.max(0, operatingTotal - rawTotal) : finiteNumber(row.offlineReserved, 0);
      return `${row.label} 원시 ${fmtNumber(rawTotal)}개${offline ? ` · 오프라인 ${fmtNumber(offline)}개` : ""}`;
    }),
    gap: []
  };
  const gapTypes = [];
  let statusKey = "normal";
  let tone = "good";
  let priority = 0;

  if (flags.has("booking_id_reused") || confidence.grade === "E") {
    statusKey = "structure_risk";
    tone = "bad";
    priority += 70;
    reasons.push("예약ID 또는 상품 구조 재확인이 필요합니다.");
    actions.push("네이버 객실 탭에서 객실별/종류별 판매 방식을 직접 확인");
    otaSignals.push("상품/객실 구조");
    issueChannels.add("네이버 객실 탭");
    issueChannels.add("OTA 보조 채널");
  }

  if (flags.has("dynamic_capacity") || (Number.isFinite(totalGapRate) && totalGap >= 2 && totalGapRate >= 0.25)) {
    if (statusKey === "normal") {
      statusKey = "phone_stock";
      tone = "watch";
    }
    priority += 48;
    reasons.push(totalMin && totalMax
      ? `날짜별 총량 변동 ${fmtNumber(totalMin)}~${fmtNumber(totalMax)}개`
      : "날짜별 총량 변동 감지");
    actions.push("전체 객실 후보, 운영 판매 기준, 일시 차단 수량을 분리 확인");
    otaSignals.push("날짜별 총량 변동");
    issueChannels.add("전화예약/오프라인");
    issueChannels.add("네이버 날짜별 재고");
  }

  if (structuralBlockedTotal > 0) {
    if (statusKey === "normal") {
      statusKey = "phone_stock";
      tone = "watch";
    }
    priority += 36;
    reasons.push(`상시 차단/운영 축소 ${fmtNumber(structuralBlockedTotal)}개`);
    actions.push("현재 운영 판매 기준을 매출 산정 기준으로 유지할지 관리자 확인");
    otaSignals.push("운영 판매 기준 분리");
    issueChannels.add("네이버 재고 세팅");
  }

  if (varianceRows.length) {
    priority += Math.min(30, varianceRows.length * 8);
    reasons.push(`총량 튐 ${fmtNumber(varianceRows.length)}일`);
    otaSignals.push("총량 이상치");
    issueChannels.add("네이버 날짜별 재고");
  }

  if (missingCount) {
    if (statusKey === "normal") {
      statusKey = "quantity_check";
      tone = "watch";
    }
    priority += Math.min(32, missingCount * 6);
    reasons.push(`미수집 날짜 ${fmtNumber(missingCount)}일`);
    actions.push("동일 기간으로 재수집 후 날짜별 상세 비교");
    issueChannels.add("네이버 재수집");
  }

  if (["D", "E"].includes(confidence.grade)) {
    if (statusKey === "normal") {
      statusKey = "quantity_check";
      tone = "watch";
    }
    priority += confidence.grade === "E" ? 30 : 18;
    reasons.push(`수집 신뢰도 ${confidence.grade}`);
    if (confidence.grade === "E") otaSignals.push("수집 신뢰도 낮음");
    issueChannels.add("네이버 객실 탭");
  }

  if (flags.has("dayuse_rotation") || (day.supply && lodging.supply && day.supply >= lodging.supply * 0.6)) {
    priority += 14;
    reasons.push("데이유즈/캠프닉 회전형 상품 병행 가능성");
    actions.push("숙박과 당일상품을 분리해서 판매수·총량 확인");
  }

  const collectionStatus = collectionStatusProfile(item);
  const dataIncomplete = Boolean(collectionStatus.priceMissing || !collectionStatus.productKnown || collectionStatus.statusKey === "missing");
  if (dataIncomplete) {
    if (statusKey === "normal") {
      statusKey = "data_missing";
      tone = collectionStatus.statusKey === "missing" ? "bad" : "watch";
    }
    priority += collectionStatus.statusKey === "missing" ? 42 : 24;
    if (!collectionStatus.productKnown) {
      reasons.push("상품별 수량 구조가 확보되지 않았습니다.");
      actions.push("네이버 상품별 객실수와 숙박/데이유즈 구분을 확인");
      issueChannels.add("네이버 상품/수량");
    }
    if (collectionStatus.priceMissing) {
      reasons.push(`가격 누락 판매수량 ${fmtNumber(collectionStatus.missingPriceQuantity || collectionStatus.soldQuantity)}개/회`);
      actions.push("평일/금/토/일 상품 가격을 확인한 뒤 매출을 재산정");
      issueChannels.add("네이버 가격/요일");
    }
    if (collectionStatus.statusKey === "missing") {
      reasons.push("정밀분석 재고 상세가 확보되지 않았습니다.");
      actions.push("상세 순위 범위, 예약ID, 수집 기간을 확인하고 재수집");
      issueChannels.add("정밀분석 재수집");
    }
  }

  const saturdayRate = flow.saturday.rate;
  const naverExposed = Number(item.rank || 0) > 0 || platformsForItem(item).some((row) => platformShortName(row.platform) === "네이버");
  const addGap = (label, metric, dayIndexes) => {
    if (!naverExposed || !Number.isFinite(saturdayRate) || saturdayRate < 0.55) return;
    const rate = metric?.rate;
    const isGap = !Number.isFinite(rate) || rate <= 0.35 || saturdayRate - rate >= 0.35;
    if (!isGap) return;
    gapTypes.push(label);
    const labels = flow.rows
      .filter((row) => !row.missing && dayIndexes.includes(row.day))
      .map((row) => row.label);
    if (labels.length) problemDates.gap.push(`${label} ${labels.join("/")}`);
  };
  addGap("금요일", flow.friday, [5]);
  addGap("일요일", flow.sunday, [0]);
  addGap(flow.weekday.label || "평일", flow.weekday, [1, 2, 3, 4]);
  if (gapTypes.length) {
    if (statusKey === "normal") {
      statusKey = "sales_gap";
      tone = "watch";
    }
    priority += Math.min(36, 16 + gapTypes.length * 8);
    reasons.push(`네이버 노출 대비 ${gapTypes.join("/")} 판매 공백`);
    actions.push(`${gapTypes.join("/")} 가격, 연박, 퇴실 조건 확인`);
    issueChannels.add("네이버 가격/일자");
    issueChannels.add("관리자 영업 판단");
  }

  if (Number.isFinite(weekdayGap) && Math.abs(weekdayGap) >= 0.25) {
    if (statusKey === "normal") {
      statusKey = "quantity_check";
      tone = "watch";
    }
    priority += 16;
    reasons.push(`누적 평일 대비 ${rateGapText(weekdayGap)}`);
  }

  const correctionInfo = manualCorrectionInfo(item);
  const correction = correctionInfo?.correction || {};
  const review = item.companyProfile?.adminReview || {};
  const manualRecheckNeeded = Boolean(
    correctionInfo && (
      !review.status ||
      review.status === "manual_needed" ||
      isReviewBeforeCorrection(review, correction)
    )
  );
  if (manualRecheckNeeded) {
    if (statusKey === "normal" || statusKey === "confirmed") {
      statusKey = "manual_recheck";
      tone = "watch";
    }
    priority += 24;
    reasons.push("수동 보정 후 재검토 필요");
    actions.push("보정 기준 총량으로 판매율을 다시 확인하고 판단 저장");
    issueChannels.add("관리자 보정 메모");
  }

  if (statusKey === "normal" && confidence.grade === "A" && collectedRows.length >= Math.min(7, bookingDays(state.data?.run || {}))) {
    statusKey = "confirmed";
    tone = "good";
    reasons.push("현재 기간 기준 수량 구조가 안정적입니다.");
    actions.push("영업타깃 판단에 바로 사용 가능");
  }

  const labelMap = {
    confirmed: "수동확정 가능",
    normal: "정상",
    quantity_check: "수량확인 필요",
    structure_risk: "상품구조 의심",
    phone_stock: "전화예약/재고조절 가능성",
    sales_gap: "판매 공백 확인",
    data_missing: "가격/수량 미확보",
    manual_recheck: "보정 후 재검토"
  };
  const defaultAction = statusKey === "normal" || statusKey === "confirmed"
    ? "현재 결과를 기준값으로 사용"
    : statusKey === "structure_risk"
      ? "상품 종류와 실제 객실 수량을 먼저 검증"
      : statusKey === "phone_stock"
        ? "총량 변동 원인을 메모하고 판매율 해석"
        : "날짜별 상세를 열어 원자료 확인";
  const otaCheckNeeded = !["normal", "confirmed"].includes(statusKey) && otaSignals.length > 0;
  const otaReason = otaCheckNeeded ? `${[...new Set(otaSignals)].join(", ")} 보조 확인` : "";
  if (otaCheckNeeded) {
    issueChannels.add("여기어때 수동 보완");
    issueChannels.add("NOL/야놀자");
    issueChannels.add("떠나요");
  }
  const quantityUnclear = Boolean(
    ["D", "E"].includes(confidence.grade) ||
    flags.has("booking_id_reused") ||
    flags.has("grouped_range") ||
    ["unknown", "stock_only", "grouped_stock"].includes(structure.type) ||
    missingCount > 0
  );
  const capacityVolatile = Boolean(flags.has("dynamic_capacity") || (Number.isFinite(totalGapRate) && totalGap >= 2 && totalGapRate >= 0.25));
  const criteria = [
    otaCheckNeeded ? {
      key: "ota",
      label: "OTA 확인 필요",
      reason: otaReason || "네이버 기준만으로 확정하기 어려움",
      action: "여기어때는 수동 보완값으로 확인하고, NOL/야놀자/떠나요 노출을 비교"
    } : null,
    quantityUnclear ? {
      key: "quantity",
      label: "수량 구조 불명확",
      reason: `수량 신뢰도 ${confidence.grade} · ${structure.label}`,
      action: structure.action || "객실별/상품별 수량 재확인"
    } : null,
    capacityVolatile ? {
      key: "capacity",
      label: "날짜별 총량 변동 큼",
      reason: totalMax ? `총량 ${fmtNumber(totalMin)}~${fmtNumber(totalMax)}개` : "날짜별 원시 총량 변동",
      action: "미오픈/차단/온라인 미노출은 오프라인 예약 가능성으로 메모"
    } : null,
    gapTypes.length ? {
      key: "gap",
      label: "판매 공백 큼",
      reason: `네이버 노출 대비 ${gapTypes.join("/")} 공백`,
      action: "금요일/일요일/평일 가격과 연박 조건 확인"
    } : null,
    dataIncomplete ? {
      key: "data",
      label: "가격/수량 미확보",
      reason: collectionStatus.reasons[0] || "정밀분석 결과만으로 컨택 판단이 불충분",
      action: "상품별 수량과 요일별 가격을 확인한 뒤 영업타깃 여부 재판정"
    } : null,
    manualRecheckNeeded ? {
      key: "manual_recheck",
      label: "수동 보정 후 재검토 필요",
      reason: correctionInfo?.label || "관리자 보정값 보유",
      action: "보정값 적용 후 컨택/보류/제외 판단 재저장"
    } : null
  ].filter(Boolean);

  return {
    statusKey,
    label: labelMap[statusKey] || "확인 필요",
    indexLabel: otaCheckNeeded ? "OTA 확인 필요" : (labelMap[statusKey] || "확인 필요"),
    otaCheckNeeded,
    otaReason,
    inQueue: criteria.length > 0,
    criteria,
    neededChannels: [...issueChannels],
    problemDates,
    gapTypes,
    quantityUnclear,
    capacityVolatile,
    manualRecheckNeeded,
    correctionStatus: correctionInfo ? "관리자 보정" : "자동추정",
    tone,
    priority,
    reasons: [...new Set(reasons)].slice(0, 5),
    actions: [...new Set(actions.length ? actions : [defaultAction])].slice(0, 3),
    metrics: {
      totalMin,
      totalMax,
      totalGap,
      totalGapRate,
      missingCount,
      varianceDays: varianceRows.length,
      weekdayGap,
      collectedDays: collectedRows.length,
      dataStatus: collectionStatus.statusKey,
      missingPriceQuantity: collectionStatus.missingPriceQuantity,
      productKnown: collectionStatus.productKnown
    }
  };
}

function validationQueueEntries(items = [], limit = 8) {
  const entries = items
    .map((item, index) => {
      const decision = decisionQueueProfile(item);
      return { item, index, audit: decision.audit, decision };
    })
    .filter(({ decision }) => decision.inQueue)
    .sort((a, b) => b.decision.priority - a.decision.priority || Number(a.item.rank || 999) - Number(b.item.rank || 999));
  return limit ? entries.slice(0, limit) : entries;
}

function auditIndexLabel(audit = {}) {
  return audit.otaCheckNeeded ? "OTA 확인 필요" : (audit.indexLabel || audit.label || "확인 필요");
}

function auditProblemDateText(audit = {}) {
  const dates = [
    ...(audit.problemDates?.variance || []),
    ...(audit.problemDates?.gap || []),
    ...(audit.problemDates?.missing || []).map((label) => `${label} 미수집`)
  ];
  return compactListText(dates, "문제 날짜 없음", 5);
}

function decisionQueueProfile(item = {}) {
  const audit = inventoryAuditProfile(item);
  const confidence = inventoryConfidenceInfo(item);
  const structure = inventoryStructureInfo(item);
  const correction = manualCorrectionInfo(item);
  const revenueEvidence = queueRevenueEvidenceProfile(itemQueueRevenueImpact(item));
  const revenueCriterion = revenueEvidence.weak ? {
    key: "revenue",
    label: "매출 근거 보강",
    reason: compactListText(revenueEvidence.reasons, "요일/상품/가격 근거 확인 필요", 3),
    action: "요일별 가격과 상품별 수량을 같은 기간으로 재수집"
  } : null;
  const criteria = [...(audit.criteria || []), revenueCriterion].filter(Boolean);
  const reasons = criteria.length
    ? criteria.map((criterion) => `${criterion.label}: ${criterion.reason}`)
    : audit.reasons;
  const inQueue = Boolean(audit.inQueue || revenueEvidence.weak);
  const channels = [
    ...(audit.neededChannels || []),
    revenueEvidence.weak ? "네이버 가격/상품" : ""
  ].filter(Boolean);
  const tone = revenueEvidence.weak && audit.tone === "good" ? "watch" : audit.tone;
  return {
    audit,
    inQueue,
    label: criteria[0]?.label || auditIndexLabel(audit),
    tone,
    priority: audit.priority + (revenueEvidence.weak ? 18 : 0),
    criteria,
    reasons,
    actions: criteria.map((criterion) => criterion.action).filter(Boolean).concat(audit.actions || []).slice(0, 4),
    problemDateText: auditProblemDateText(audit),
    quantityConfidence: `신뢰도 ${confidence.grade} · ${structure.label}`,
    gapType: compactListText(audit.gapTypes || [], "공백 특이 없음", 3),
    channelText: compactListText(channels, "네이버 기준", 4),
    correctionText: correction ? `${correction.label} · ${correction.note}` : "자동추정",
    adminReviewText: item.companyProfile?.adminReview?.label || companyAdminReviewLabel(item.companyProfile?.adminReview?.status),
    summary: reasons[0] || audit.actions?.[0] || "확인 필요"
  };
}

function renderValidationQueue(items = []) {
  const entries = validationQueueEntries(items, 6);
  const allProfiles = items.map((item) => decisionQueueProfile(item));
  const queueCount = allProfiles.filter((profile) => profile.inQueue).length;
  const counts = allProfiles.reduce((acc, profile) => {
    for (const criterion of profile.criteria || []) {
      acc[criterion.key] = (acc[criterion.key] || 0) + 1;
    }
    if (!profile.inQueue) acc.clean = (acc.clean || 0) + 1;
    return acc;
  }, {});
  const chips = [
    ["OTA 확인 필요", counts.ota || 0, "bad"],
    ["수량 구조 불명확", counts.quantity || 0, "watch"],
    ["총량 변동 큼", counts.capacity || 0, "watch"],
    ["판매 공백 큼", counts.gap || 0, "watch"],
    ["매출 근거 보강", counts.revenue || 0, "watch"],
    ["가격/수량 미확보", counts.data || 0, "watch"],
    ["정상/확정", counts.clean || 0, "good"]
  ];
  return `
    <div class="validation-card validation-card-audit">
      <div class="validation-card-head compact">
        <div>
          <span class="eyebrow">관리자 판단 큐 V2</span>
          <h3>사람이 확인해야 할 업체</h3>
        </div>
        <span>${fmtNumber(queueCount)} 큐 진입</span>
      </div>
      <div class="audit-status-strip">
        ${chips.map(([label, count, tone]) => `<span class="${tone}">${escapeHtml(label)} <b>${fmtNumber(count)}</b></span>`).join("")}
      </div>
      <div class="audit-queue-list">
        ${entries.length ? entries.map(({ item, index, audit, decision }) => {
          const metric = audit.metrics.totalMax
            ? `총량 ${fmtNumber(audit.metrics.totalMin)}~${fmtNumber(audit.metrics.totalMax)}개`
            : `${fmtNumber(audit.metrics.collectedDays)}일 관측`;
          return `
            <button type="button" data-open-company="${index}">
              <span class="audit-rank">${escapeHtml(item.rank || index + 1)}</span>
              <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
              <em class="${escapeHtml(decision.tone)}">${escapeHtml(decision.label)}</em>
              <small>${escapeHtml([metric, decision.problemDateText, decision.summary].filter(Boolean).join(" · "))}</small>
            </button>
          `;
        }).join("") : `<p>현재 우선 검증할 이상치가 없습니다.</p>`}
      </div>
    </div>
  `;
}

function validationReasonRow(item = {}) {
  const analysis = targetExpansionAnalysis(item);
  const confidence = inventoryConfidenceInfo(item);
  const structure = inventoryStructureInfo(item);
  const decision = decisionQueueProfile(item);
  const reasons = decision.inQueue
    ? [
        `판단 큐: ${decision.label}`,
        `문제 날짜: ${decision.problemDateText}`,
        `수량: ${decision.quantityConfidence}`,
        `채널: ${decision.channelText}`
      ]
    : [
        `구조: ${structure.label}`,
        `확인: ${structure.action}`,
        ...confidence.alerts.map((reason) => `검증: ${reason}`),
        ...structure.notes,
        ...analysis.reasons
      ];
  const visibleReasons = reasons.filter(Boolean).slice(0, 4);
  if (!visibleReasons.length) return "";
  return `
    <div class="reason-chip-row" aria-label="판단 근거">
      ${visibleReasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
    </div>
  `;
}

function renderValidationBoard(items = []) {
  const stats = state.data?.availability?.stats || {};
  const flow = aggregateFlowProfiles(items);
  const lowConfidence = finiteNumber(stats.lowConfidenceCount, 0);
  const stockVariance = finiteNumber(stats.stockVarianceCount, 0);
  const dayUseMixed = finiteNumber(stats.dayUseMixedCount, 0);
  const bookingIdReused = finiteNumber(stats.bookingIdReusedCount, 0);
  const structureCounts = stats.inventoryStructureCounts || {};
  const structureSummary = Object.entries(structureCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, count]) => `${label} ${fmtNumber(count)}`)
    .join(" · ");
  const missingItems = items.filter((item) => bookingGraphRows(item).some((row) => row.missing)).length;
  const targets = targetEntries(5);
  const run = state.data?.run || {};
  const rangeLabel = dateRangeLabel(run);
  return `
    <section class="validation-board" aria-label="관리자 검증 요약">
      ${renderCollectionDiagnostics(items)}
      <div class="validation-card validation-card-main">
        <div class="validation-card-head">
          <div>
            <span class="eyebrow">관리자 검증</span>
            <h3>7일 흐름과 수집 신뢰도</h3>
          </div>
          <b>${escapeHtml(rangeLabel)}</b>
        </div>
        <div class="validation-metric-grid">
          ${validationCardValue("전체 판매율", fmtRate(flow.all.rate), `${fmtNumber(flow.all.sold)}/${fmtNumber(flow.all.total)}개`)}
          ${validationCardValue("평일 기준", Number.isFinite(flow.weekday.rate) ? fmtRate(flow.weekday.rate) : "확인필요", `${fmtNumber(flow.weekday.count)}일 관측`)}
          ${validationCardValue("토요일", Number.isFinite(flow.saturday.rate) ? fmtRate(flow.saturday.rate) : "확인필요", "주말 수요")}
          ${validationCardValue("검증 필요", fmtNumber(lowConfidence), `총량변동 ${fmtNumber(stockVariance)} · 당일 ${fmtNumber(dayUseMixed)}`)}
        </div>
        ${structureSummary ? `<div class="structure-summary-strip">${escapeHtml(structureSummary)}${bookingIdReused ? ` · 예약ID 재확인 ${fmtNumber(bookingIdReused)}` : ""}</div>` : ""}
      </div>
      <div class="validation-card validation-card-flow">
        <div class="validation-card-head compact">
          <h3>요일별 압력</h3>
          <span>${fmtNumber(items.length)} 업체</span>
        </div>
        <div class="weekday-pressure">
          ${[
            ["평일", flow.weekday],
            ["금", flow.friday],
            ["토", flow.saturday],
            ["일", flow.sunday]
          ].map(([label, metric]) => `
            <div>
              <span>${label}</span>
              <b>${Number.isFinite(metric.rate) ? fmtRate(metric.rate) : "확인필요"}</b>
              <i><em style="width:${Number.isFinite(metric.rate) ? Math.max(3, Math.min(100, metric.rate * 100)) : 0}%"></em></i>
            </div>
          `).join("")}
        </div>
      </div>
      <div class="validation-card validation-card-target">
        <div class="validation-card-head compact">
          <h3>바로 컨택 후보</h3>
          <span>${fmtNumber(targets.length)} 후보</span>
        </div>
        <div class="validation-target-list">
          ${targets.length ? targets.slice(0, 3).map(({ item, score, reasons }) => `
            <button type="button" data-open-company="${items.indexOf(item)}">
              <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
              <span>${fmtNumber(score)}점 · ${escapeHtml(reasons[0] || "확인 필요")}</span>
            </button>
          `).join("") : `<p>현재 기준 우선 후보가 없습니다.</p>`}
        </div>
        <small>${missingItems ? `${fmtNumber(missingItems)}개 업체는 일부 날짜 미수집으로 판단 큐 확인` : "판단 큐를 제외한 즉시 후보"}</small>
      </div>
      ${renderValidationQueue(items)}
    </section>
  `;
}

function targetExpansionAnalysis(item = {}) {
  const platforms = platformsForItem(item).map((row) => platformShortName(row.platform));
  const lodging = salesStats(item, "lodging");
  const day = salesStats(item, "day");
  const confidence = inventoryConfidenceInfo(item);
  const audit = inventoryAuditProfile(item);
  const flow = salesFlowProfile(item);
  const profile = {
    friday: flow.friday,
    saturday: flow.saturday,
    sunday: flow.sunday,
    weekday: flow.weekday,
    all: flow.all
  };
  const rank = Number(item.rank || 999);
  const reasons = [];
  let score = 0;

  if (rank >= 5 && rank <= 20) {
    score += 22;
    reasons.push("네이버 5~20위권");
  } else if (rank >= 1 && rank <= 4) {
    score += 6;
    reasons.push("상위권 강자");
  } else if (rank <= 30) {
    score += 10;
    reasons.push("노출 개선 여지");
  }

  const allRate = profile.all?.rate;
  const weekdayRate = profile.weekday?.rate;
  const satRate = profile.saturday?.rate;
  const friRate = profile.friday?.rate;
  const sunRate = profile.sunday?.rate;
  if (Number.isFinite(allRate) && flow.all.count >= 5) {
    score += allRate < 0.45 ? 10 : 4;
    reasons.push(`7일 전체 ${fmtRate(allRate)}`);
  }
  if (Number.isFinite(weekdayRate) && flow.weekday.count >= 2 && weekdayRate <= 0.35) {
    score += 14;
    reasons.push(`${flow.weekday.label} 약함 ${fmtRate(weekdayRate)}`);
  }
  if (Number.isFinite(satRate) && satRate >= 0.75) {
    score += 28;
    reasons.push(`토요일 수요 확인 ${fmtRate(satRate)}`);
  } else if (Number.isFinite(satRate) && satRate >= 0.55) {
    score += 18;
    reasons.push(`토요일 판매 보통 ${fmtRate(satRate)}`);
  }

  const fridayGap = Number.isFinite(satRate) && Number.isFinite(friRate) ? satRate - friRate : NaN;
  const sundayGap = Number.isFinite(satRate) && Number.isFinite(sunRate) ? satRate - sunRate : NaN;
  if (Number.isFinite(fridayGap) && fridayGap >= 0.35) {
    score += 18;
    reasons.push(`금요일 미활용 ${fmtRate(friRate)}`);
  }
  if (Number.isFinite(sundayGap) && sundayGap >= 0.35) {
    score += 18;
    reasons.push(`일요일 미활용 ${fmtRate(sunRate)}`);
  }

  if (!Number.isFinite(friRate) && !Number.isFinite(sunRate) && Number.isFinite(lodging.rate) && lodging.rate < 0.35) {
    score += 8;
    reasons.push("전후일 데이터 추가 확인");
  }
  if (!day.supply) {
    score += 7;
    reasons.push("당일상품 확장 여지");
  }
  const missingOtas = ["여기어때", "야놀자", "떠나요"].filter((name) => !platforms.includes(name));
  if (audit.otaCheckNeeded && missingOtas.length) {
    score += Math.min(8, missingOtas.length * 3);
    reasons.push(`OTA 보조 확인 ${missingOtas.slice(0, 2).join("/")}`);
  }
  if (["D", "E"].includes(confidence.grade)) {
    score -= 12;
    reasons.push("수집값 검증 필요");
  }
  if (audit.statusKey === "phone_stock") {
    score += 4;
    reasons.push("전화예약/재고조절 메모 필요");
  }
  if (audit.statusKey === "quantity_check") {
    score -= 7;
    reasons.push("수량 확인 후 판단");
  }
  if (audit.statusKey === "structure_risk") {
    score -= 16;
    reasons.push("상품구조 검증 후 컨택");
  }
  if (audit.statusKey === "data_missing") {
    score -= 14;
    reasons.push("가격/수량 확보 후 판단");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    label: score >= 75 ? "1순위 확장 후보" : score >= 55 ? "검토 후보" : "관찰 후보",
    reasons: reasons.slice(0, 6),
    profile,
    flow
  };
}

function targetReasons(item) {
  return targetExpansionAnalysis(item).reasons;
}

function targetEntries(limit = 15, options = {}) {
  const includeDecisionQueue = Boolean(options.includeDecisionQueue);
  const entries = (state.data?.availability?.items || [])
    .map((item) => {
      const revenueImpact = itemQueueRevenueImpact(item);
      const revenueEvidence = queueRevenueEvidenceProfile(revenueImpact);
      return { item, decision: decisionQueueProfile(item), revenueImpact, revenueEvidence, ...targetExpansionAnalysis(item) };
    })
    .filter((entry) => entry.score >= 42 && entry.reasons.length && (includeDecisionQueue || (!entry.decision.inQueue && !entry.revenueEvidence.weak)))
    .sort((a, b) => b.score - a.score || Number(a.item.rank || 999) - Number(b.item.rank || 999));
  return limit ? entries.slice(0, limit) : entries;
}

function companyMasterSource() {
  return { ...(state.data?.companyMaster || {}), ...(state.companyMaster || {}) };
}

function companyItemFromCurrentRun(company = {}) {
  const items = state.data?.availability?.items || [];
  const aliases = new Set([company.primaryName, ...(company.aliases || [])].map((value) => compactSearchText(value || "")).filter(Boolean));
  return items.find((item) => item.companyId && item.companyId === company.companyId) ||
    items.find((item) => aliases.has(compactSearchText(item.name || ""))) ||
    null;
}

function queueRevenuePartFromItem(item = {}, kind = "lodging") {
  const stats = itemRevenueStats(item, kind);
  return {
    revenue: stats.revenue,
    adjustedRevenue: stats.adjustedRevenue,
    missingPriceEstimatedRevenue: stats.missingPriceEstimatedRevenue,
    revenuePrecisionRate: stats.revenuePrecisionRate,
    pricedSoldOut: stats.pricedSoldOut,
    missingPriceSoldOut: stats.missingPriceSoldOut,
    avgSoldUnitPrice: stats.avgSoldUnitPrice,
    byDayType: stats.byDayType,
    detail: stats.detail,
    offlineDetail: stats.offlineDetail,
    basis: stats.basis,
    label: stats.label,
    unit: stats.unit
  };
}

function queueRevenuePartFromSnapshot(part = {}, unit = "") {
  const revenue = optionalNumber(part.revenue);
  const adjusted = optionalNumber(part.adjustedRevenue);
  const gapRevenue = optionalNumber(part.missingPriceEstimatedRevenue);
  const precisionRate = optionalNumber(part.revenuePrecisionRate);
  const priced = optionalNumber(part.pricedSoldOut);
  const missing = optionalNumber(part.missingPriceSoldOut);
  const avg = optionalNumber(part.avgSoldUnitPrice);
  const baseRevenue = Number.isFinite(revenue) ? revenue : 0;
  const pricedSoldOut = Number.isFinite(priced) ? priced : 0;
  const missingPriceSoldOut = Number.isFinite(missing) ? missing : 0;
  const projected = projectedRevenueFields(baseRevenue, pricedSoldOut, missingPriceSoldOut, adjusted, gapRevenue, precisionRate);
  return {
    revenue: baseRevenue,
    adjustedRevenue: projected.adjustedRevenue,
    missingPriceEstimatedRevenue: projected.missingPriceEstimatedRevenue,
    revenuePrecisionRate: projected.revenuePrecisionRate,
    pricedSoldOut,
    missingPriceSoldOut,
    avgSoldUnitPrice: Number.isFinite(avg) ? avg : null,
    byDayType: part.byDayType || "",
    detail: part.detail || "",
    offlineDetail: part.offlineDetail || "",
    basis: part.basis || "basis",
    label: part.basis === "range" ? "기간 집계" : "기준일",
    unit
  };
}

function itemQueueRevenueImpact(item = {}) {
  const lodging = queueRevenuePartFromItem(item, "lodging");
  const dayUse = queueRevenuePartFromItem(item, "day");
  const totalRevenue = finiteNumber(lodging.revenue) + finiteNumber(dayUse.revenue);
  const totalAdjustedRevenue = finiteNumber(lodging.adjustedRevenue) + finiteNumber(dayUse.adjustedRevenue);
  const totalMissingPriceEstimatedRevenue = finiteNumber(lodging.missingPriceEstimatedRevenue) + finiteNumber(dayUse.missingPriceEstimatedRevenue);
  const totalPricedSoldOut = finiteNumber(lodging.pricedSoldOut) + finiteNumber(dayUse.pricedSoldOut);
  const totalMissingPriceSoldOut = finiteNumber(lodging.missingPriceSoldOut) + finiteNumber(dayUse.missingPriceSoldOut);
  const precision = revenuePrecisionProfile(item || {}, lodging, dayUse);
  const lodgingDayRows = revenueDayTypeRows(lodging);
  const dayUseDayRows = revenueDayTypeRows(dayUse);
  const productRows = revenueProductRows(item);
  const hasDetail = Boolean(
    totalRevenue ||
    totalPricedSoldOut ||
    totalMissingPriceSoldOut ||
    lodging.avgSoldUnitPrice ||
    dayUse.avgSoldUnitPrice ||
    lodging.byDayType ||
    dayUse.byDayType ||
    lodging.offlineDetail ||
    dayUse.offlineDetail ||
    productRows.length
  );
  return {
    hasDetail,
    lodging,
    dayUse,
    lodgingDayRows,
    dayUseDayRows,
    productRows,
    totalRevenue,
    totalAdjustedRevenue,
    totalMissingPriceEstimatedRevenue,
    totalPricedSoldOut,
    totalMissingPriceSoldOut,
    precision,
    source: "current"
  };
}

function companyQueueRevenueImpact(company = {}) {
  const item = companyItemFromCurrentRun(company);
  if (item) return itemQueueRevenueImpact(item);
  const lodging = queueRevenuePartFromSnapshot(company.inventory?.latest?.revenue?.lodging || {}, "개");
  const dayUse = queueRevenuePartFromSnapshot(company.inventory?.latest?.revenue?.dayUse || {}, "회");
  const totalRevenue = finiteNumber(lodging.revenue) + finiteNumber(dayUse.revenue);
  const totalAdjustedRevenue = finiteNumber(lodging.adjustedRevenue) + finiteNumber(dayUse.adjustedRevenue);
  const totalMissingPriceEstimatedRevenue = finiteNumber(lodging.missingPriceEstimatedRevenue) + finiteNumber(dayUse.missingPriceEstimatedRevenue);
  const totalPricedSoldOut = finiteNumber(lodging.pricedSoldOut) + finiteNumber(dayUse.pricedSoldOut);
  const totalMissingPriceSoldOut = finiteNumber(lodging.missingPriceSoldOut) + finiteNumber(dayUse.missingPriceSoldOut);
  const precision = revenuePrecisionProfile({}, lodging, dayUse);
  const lodgingDayRows = revenueDayTypeRows(lodging);
  const dayUseDayRows = revenueDayTypeRows(dayUse);
  const productRows = [];
  const hasDetail = Boolean(
    totalRevenue ||
    totalPricedSoldOut ||
    totalMissingPriceSoldOut ||
    lodging.avgSoldUnitPrice ||
    dayUse.avgSoldUnitPrice ||
    lodging.byDayType ||
    dayUse.byDayType ||
    lodging.offlineDetail ||
    dayUse.offlineDetail ||
    productRows.length
  );
  return {
    hasDetail,
    lodging,
    dayUse,
    lodgingDayRows,
    dayUseDayRows,
    productRows,
    totalRevenue,
    totalAdjustedRevenue,
    totalMissingPriceEstimatedRevenue,
    totalPricedSoldOut,
    totalMissingPriceSoldOut,
    precision,
    source: "master"
  };
}

function queueSnapshotRevenueImpact(snapshot = {}) {
  const lodging = queueRevenuePartFromSnapshot(snapshot.revenue?.lodging || {}, "개");
  const dayUse = queueRevenuePartFromSnapshot(snapshot.revenue?.dayUse || {}, "회");
  return {
    lodging,
    dayUse,
    totalRevenue: finiteNumber(lodging.revenue) + finiteNumber(dayUse.revenue),
    totalAdjustedRevenue: finiteNumber(lodging.adjustedRevenue) + finiteNumber(dayUse.adjustedRevenue),
    totalMissingPriceEstimatedRevenue: finiteNumber(lodging.missingPriceEstimatedRevenue) + finiteNumber(dayUse.missingPriceEstimatedRevenue),
    totalPricedSoldOut: finiteNumber(lodging.pricedSoldOut) + finiteNumber(dayUse.pricedSoldOut),
    totalMissingPriceSoldOut: finiteNumber(lodging.missingPriceSoldOut) + finiteNumber(dayUse.missingPriceSoldOut)
  };
}

function effectiveRevenueValue(impact = {}) {
  const adjusted = finiteNumber(impact.totalAdjustedRevenue, 0);
  const base = finiteNumber(impact.totalRevenue, 0);
  return adjusted || base;
}

function revenueAdjustmentNote(impact = {}) {
  const adjusted = finiteNumber(impact.totalAdjustedRevenue, 0);
  const base = finiteNumber(impact.totalRevenue, 0);
  const gap = finiteNumber(impact.totalMissingPriceEstimatedRevenue, 0);
  if (adjusted > base && gap > 0) return `보정포함 ${fmtWon(adjusted)} · 가격누락 보정 ${fmtWon(gap)}`;
  return `확인가격 매출 ${fmtWon(base)}`;
}

function queueGradeScore(value) {
  return { A: 5, B: 4, C: 3, D: 2, E: 1 }[String(value || "").toUpperCase()] || 0;
}

function queueSignalGapCount(signal = {}) {
  const lodging = signal.lodging || {};
  return [lodging.fridayWeak, lodging.sundayWeak, lodging.weekdayWeak].filter(Boolean).length;
}

function queueSnapshotMetrics(snapshot = {}) {
  const signal = snapshot.salesSignal || {};
  const lodging = signal.lodging || {};
  const dayUse = signal.dayUse || {};
  const flags = new Set([
    ...(Array.isArray(snapshot.structureFlags) ? snapshot.structureFlags : []),
    ...(Array.isArray(signal.structureFlags) ? signal.structureFlags : [])
  ]);
  const revenue = queueSnapshotRevenueImpact(snapshot);
  const grade = String(snapshot.confidenceGrade || "").toUpperCase();
  const totalSupply = finiteNumber(lodging.totalSupply) + finiteNumber(dayUse.totalSupply);
  const totalSold = finiteNumber(lodging.totalSold) + finiteNumber(dayUse.totalSold);
  const offlineQuantity = finiteNumber(lodging.manualOfflineReserved) + finiteNumber(dayUse.manualOfflineReserved);
  const offlineDetail = compactListText([
    revenue.lodging.offlineDetail,
    revenue.dayUse.offlineDetail
  ].filter(Boolean), "", 2);
  return {
    runId: snapshot.runId || "",
    collectedAt: snapshot.collectedAt || "",
    grade,
    gradeScore: queueGradeScore(grade),
    structureLabel: snapshot.structureLabel || "구조 대기",
    quantityWeak: Boolean(signal.structureWeak || flags.has("grouped_range") || flags.has("booking_id_reused") || ["C", "D", "E"].includes(grade)),
    stockVariance: Boolean(signal.stockVariance || lodging.stockVariance || dayUse.stockVariance || flags.has("dynamic_capacity")),
    gapCount: queueSignalGapCount(signal),
    fridayWeak: Boolean(lodging.fridayWeak),
    sundayWeak: Boolean(lodging.sundayWeak),
    weekdayWeak: Boolean(lodging.weekdayWeak),
    totalSupply,
    totalSold,
    averageRate: Number.isFinite(Number(lodging.averageRate)) ? Number(lodging.averageRate) : null,
    totalRevenue: revenue.totalRevenue,
    totalAdjustedRevenue: revenue.totalAdjustedRevenue,
    totalMissingPriceEstimatedRevenue: revenue.totalMissingPriceEstimatedRevenue,
    totalPricedSoldOut: revenue.totalPricedSoldOut,
    totalMissingPriceSoldOut: revenue.totalMissingPriceSoldOut,
    offlineQuantity,
    offlineEstimated: Boolean(offlineQuantity || offlineDetail || signal.stockVariance || flags.has("dynamic_capacity")),
    offlineDetail
  };
}

function queueDeltaTone(previous, current, higherIsBetter = true) {
  const left = Number(previous);
  const right = Number(current);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === right) return "same";
  return higherIsBetter ? (right > left ? "good" : "bad") : (right < left ? "good" : "bad");
}

function queueBooleanResolvedTone(previous, current) {
  if (Boolean(previous) === Boolean(current)) return "same";
  return previous && !current ? "good" : "bad";
}

function queueComparisonCell(label, before, after, tone = "same", note = "") {
  return `
    <div class="${escapeHtml(tone)}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(`${before} → ${after}`)}</strong>
      <small>${escapeHtml(note || (tone === "good" ? "개선" : tone === "bad" ? "악화" : "유지"))}</small>
    </div>
  `;
}

function companyRecrawlComparison(company = {}) {
  const latest = company.inventory?.latest || {};
  const previous = company.inventory?.previousLatest
    || (company.inventory?.snapshots || []).find((row) => (row.runId || row.collectedAt) !== (latest.runId || latest.collectedAt))
    || null;
  if (!latest?.collectedAt || !previous?.collectedAt) {
    return { hasComparison: false, latest, previous };
  }
  const current = queueSnapshotMetrics(latest);
  const before = queueSnapshotMetrics(previous);
  const beforeRevenue = effectiveRevenueValue(before);
  const currentRevenue = effectiveRevenueValue(current);
  const cells = [
    {
      key: "confidence",
      label: "수량 신뢰도",
      before: before.grade ? `${before.grade} · ${before.structureLabel}` : "대기",
      after: current.grade ? `${current.grade} · ${current.structureLabel}` : "대기",
      tone: queueDeltaTone(before.gradeScore, current.gradeScore, true),
      note: current.quantityWeak ? "구조 확인 필요" : "수량 구조 안정"
    },
    {
      key: "price",
      label: "가격 확보",
      before: `${fmtNumber(before.totalPricedSoldOut)}개 확인 · 누락 ${fmtNumber(before.totalMissingPriceSoldOut)}`,
      after: `${fmtNumber(current.totalPricedSoldOut)}개 확인 · 누락 ${fmtNumber(current.totalMissingPriceSoldOut)}`,
      tone: before.totalMissingPriceSoldOut !== current.totalMissingPriceSoldOut
        ? queueDeltaTone(before.totalMissingPriceSoldOut, current.totalMissingPriceSoldOut, false)
        : queueDeltaTone(before.totalPricedSoldOut, current.totalPricedSoldOut, true),
      note: current.totalMissingPriceSoldOut ? "가격 누락 남음" : "가격 누락 없음"
    },
    {
      key: "gap",
      label: "판매 공백",
      before: `${fmtNumber(before.gapCount)}개 유형`,
      after: `${fmtNumber(current.gapCount)}개 유형`,
      tone: queueDeltaTone(before.gapCount, current.gapCount, false),
      note: current.gapCount ? "금/일/평일 공백 확인" : "공백 신호 해소"
    },
    {
      key: "stock",
      label: "총량 변동",
      before: before.stockVariance ? "있음" : "없음",
      after: current.stockVariance ? "있음" : "없음",
      tone: queueBooleanResolvedTone(before.stockVariance, current.stockVariance),
      note: current.stockVariance ? "날짜별 총량 변동" : "총량 안정"
    },
    {
      key: "offline",
      label: "오프라인 예약",
      before: before.offlineEstimated ? `${fmtNumber(before.offlineQuantity)}개/회 추정` : "신호 없음",
      after: current.offlineEstimated ? `${fmtNumber(current.offlineQuantity)}개/회 추정` : "신호 없음",
      tone: queueBooleanResolvedTone(before.offlineEstimated, current.offlineEstimated),
      note: current.offlineDetail || (current.offlineEstimated ? "미오픈/차단/총량차 반영" : "추정 신호 없음")
    },
    {
      key: "revenue",
      label: "예상 매출",
      before: fmtWon(beforeRevenue),
      after: fmtWon(currentRevenue),
      tone: queueDeltaTone(beforeRevenue, currentRevenue, true),
      note: `변화 ${formatSignedWon(currentRevenue - beforeRevenue)}`
    }
  ];
  const improved = cells.filter((cell) => cell.tone === "good").length;
  const worsened = cells.filter((cell) => cell.tone === "bad").length;
  const tone = worsened > improved ? "bad" : improved > 0 ? "good" : "same";
  return {
    hasComparison: true,
    latest,
    previous,
    current,
    before,
    cells,
    improved,
    worsened,
    tone
  };
}

function formatSignedWon(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return "0원";
  const sign = number > 0 ? "+" : "-";
  return `${sign}${fmtWon(Math.abs(number))}`;
}

function companyRecrawlAutoRecommendation(company = {}, profile = {}, decision = {}, comparison = null) {
  const compare = comparison || companyRecrawlComparison(company);
  const criteria = new Set((decision.criteria || []).map((criterion) => criterion.key));
  const issues = new Set((profile.issues || []).map((issue) => issue.key));
  const current = compare.current || queueSnapshotMetrics(company.inventory?.latest || {});
  const revenueEvidence = queueRevenueEvidenceProfile(companyQueueRevenueImpact(company));
  const quantityIssue = criteria.has("quantity") || criteria.has("capacity") || issues.has("structure") || issues.has("booking") || issues.has("offline");
  const noQuantity = !current.totalSupply && !current.totalSold;
  const priceIssue = current.totalMissingPriceSoldOut > 0 || (!current.totalPricedSoldOut && current.totalSold > 0);
  if (!compare.hasComparison) {
    return {
      status: company.adminReview?.status || "recrawl_needed",
      label: "비교 대기",
      tone: "watch",
      reasons: [
        ...(revenueEvidence.weak ? revenueEvidence.reasons.slice(0, 2) : []),
        "이전 수집 스냅샷이 없어 재수집 전후 비교는 다음 수집부터 표시됩니다."
      ]
    };
  }
  if (noQuantity) {
    return { status: "recrawl_needed", label: "재수집 필요", tone: "watch", reasons: ["최신 수집에서 판매/총량 데이터가 충분히 확보되지 않았습니다."] };
  }
  if (quantityIssue || current.quantityWeak || current.stockVariance) {
    return { status: "manual_needed", label: "보정 필요", tone: "bad", reasons: ["수량 구조 또는 날짜별 총량 변동이 남아 있어 관리자 보정/확인이 필요합니다."] };
  }
  if (priceIssue) {
    return { status: "recrawl_needed", label: "재수집 필요", tone: "watch", reasons: ["판매수량은 있으나 가격 누락이 남아 매출 판단이 불완전합니다."] };
  }
  if (revenueEvidence.weak) {
    return { status: "recrawl_needed", label: "매출 근거 보강", tone: "watch", reasons: revenueEvidence.reasons.slice(0, 3) };
  }
  if (criteria.has("ota") || issues.has("ota") || criteria.has("gap") || issues.has("gap")) {
    return { status: "check_needed", label: "확인 필요", tone: "watch", reasons: ["OTA 또는 요일별 판매 공백은 사람이 채널/상품 조건을 확인해야 합니다."] };
  }
  if (!decision.inQueue || compare.improved >= 2 || company.salesTarget?.category === "contact") {
    return { status: "contact_ready", label: "컨택 가능", tone: "good", reasons: ["재수집 후 핵심 수량/가격 문제가 해소되어 컨택 후보로 볼 수 있습니다."] };
  }
  return { status: "check_needed", label: "확인 필요", tone: "watch", reasons: ["잔여 신호를 확인한 뒤 컨택 또는 보류를 결정하세요."] };
}

function companyAdminReviewOutcome(status = "") {
  return {
    contact_ready: { label: "영업타깃 이동", detail: "바로 컨택 가능한 업체로 분리", tone: "good" },
    confirmed: { label: "확정 타깃", detail: "관리자가 판단 맞음으로 확정", tone: "good" },
    recrawl_needed: { label: "판단큐 유지", detail: "재수집 후 전후 비교 필요", tone: "watch" },
    check_needed: { label: "판단큐 유지", detail: "채널/공백 확인 후 재판단", tone: "watch" },
    manual_needed: { label: "보정 후 재검토", detail: "총량/상품 수량 보정 필요", tone: "bad" },
    hold: { label: "보류 유지", detail: "컨택 제외, 관찰 또는 추후 확인", tone: "hold" },
    exclude: { label: "영업 제외", detail: "타깃/판단큐에서 제외", tone: "bad" }
  }[status] || { label: "판단 대기", detail: "관리자 처리 상태 미정", tone: "watch" };
}

function companyQueueResolutionProfile(company = {}, profile = {}, workflow = {}, decision = {}, comparison = null) {
  const compare = comparison || companyRecrawlComparison(company);
  const recommendation = companyRecrawlAutoRecommendation(company, profile, decision, compare);
  const status = recommendation.status || company.adminReview?.status || "check_needed";
  const outcome = companyAdminReviewOutcome(status);
  const criteriaLabels = (decision.criteria || []).map((criterion) => criterion.label || criterion.reason).filter(Boolean);
  const issueLabels = (profile.issues || []).map((issue) => issue.label || issue.task).filter(Boolean);
  const blockers = [...new Set([
    ...criteriaLabels,
    ...issueLabels,
    ...(recommendation.reasons || [])
  ].filter(Boolean))];
  const nextAction = {
    contact_ready: "컨택 기록을 남기고 응답/관심도를 추적",
    confirmed: "확정 타깃으로 유지하며 후속 일정 관리",
    recrawl_needed: "수집 설정 적용 후 같은 기간으로 재수집",
    check_needed: "OTA, 네이버 객실 탭, 공백 날짜를 확인",
    manual_needed: "기준 총량과 상품별 수량 보정 후 재검토",
    hold: "보류 사유를 남기고 다음 수집에서 변화 확인",
    exclude: "동일성/업종 부적합 근거를 남기고 제외"
  }[status] || "관리자 확인 후 상태 저장";
  return {
    status,
    recommendation,
    outcome,
    nextAction,
    blockers,
    comparison: compare,
    workflow,
    canMoveToTarget: status === "contact_ready" || status === "confirmed",
    needsMoreData: ["recrawl_needed", "manual_needed", "check_needed"].includes(status)
  };
}

function companyReviewContextText(context = {}) {
  if (!context || typeof context !== "object") return "";
  const comparison = context.comparison || {};
  const recrawl = context.recrawlPlan || {};
  const revenue = context.revenue || {};
  const revenueValue = effectiveRevenueValue(revenue);
  return compactListText([
    context.summary,
    context.recommendationLabel ? `자동 추천 ${context.recommendationLabel}` : "",
    comparison.hasComparison ? `비교 개선 ${fmtNumber(comparison.improved)} / 악화 ${fmtNumber(comparison.worsened)}` : "",
    recrawl.range ? `재수집 상세 ${recrawl.range}위` : "",
    revenueValue ? `예상매출 ${fmtWon(revenueValue)}` : ""
  ], "", 4);
}

function companyReviewContextForCompany(companyId = "", status = "", sourceOverride = "") {
  if (!companyId) return null;
  const entries = companyDecisionQueueEntries(companyMasterSource());
  const entry = entries.find((row) => row.company?.companyId === companyId);
  const company = entry?.company || (companyMasterSource().companies || []).find((row) => row.companyId === companyId) || {};
  if (!company.companyId) return null;
  const profile = entry?.profile || companyNeedsCorrection(company);
  const decision = entry?.decision || companyDecisionQueueProfile(company);
  const comparison = entry?.comparison || companyRecrawlComparison(company);
  const recommendation = entry?.autoRecommendation || companyRecrawlAutoRecommendation(company, profile, decision, comparison);
  const revenue = entry?.revenueImpact || companyQueueRevenueImpact(company);
  const revenueValue = effectiveRevenueValue(revenue);
  const plan = companyQueueRecrawlPlan(company, profile, decision);
  const comparisonCells = comparison?.hasComparison
    ? (comparison.cells || []).map((cell) => ({
        key: cell.key || "",
        label: cell.label || "",
        before: cell.before || "",
        after: cell.after || "",
        tone: cell.tone || "same",
        note: cell.note || ""
      })).slice(0, 6)
    : [];
  const summary = compactListText([
    decision.label,
    recommendation.label,
    decision.problemDateText && decision.problemDateText !== "문제 날짜 없음" ? `문제 날짜 ${decision.problemDateText}` : "",
    decision.quantityConfidence,
    comparison?.hasComparison ? `개선 ${fmtNumber(comparison.improved)} / 악화 ${fmtNumber(comparison.worsened)}` : "",
    revenueValue ? `예상매출 ${fmtWon(revenueValue)}` : ""
  ], "관리자 판단 저장", 4);
  return {
    source: sourceOverride || (entry ? "decision_queue" : "company_master"),
    appliedStatus: status,
    appliedLabel: companyAdminReviewLabel(status),
    recommendationStatus: recommendation.status || "",
    recommendationLabel: recommendation.label || "",
    recommendationReasons: (recommendation.reasons || []).slice(0, 4),
    decisionLabel: decision.label || "",
    decisionSummary: decision.summary || "",
    problemDateText: decision.problemDateText || "",
    quantityConfidence: decision.quantityConfidence || "",
    gapType: decision.gapType || "",
    channelText: decision.channelText || "",
    summary,
    recrawlPlan: {
      keyword: plan.keyword || activeKeyword(),
      range: plan.range || plan.detailRankRanges || "",
      dateText: plan.dateText || "",
      checkIn: plan.checkIn || "",
      checkOut: plan.checkOut || ""
    },
    comparison: {
      hasComparison: Boolean(comparison?.hasComparison),
      improved: comparison?.improved || 0,
      worsened: comparison?.worsened || 0,
      tone: comparison?.tone || "same",
      previousCollectedAt: comparison?.previous?.collectedAt || "",
      latestCollectedAt: comparison?.latest?.collectedAt || "",
      cells: comparisonCells
    },
    revenue: {
      totalRevenue: revenue.totalRevenue || 0,
      totalAdjustedRevenue: revenue.totalAdjustedRevenue || 0,
      totalMissingPriceEstimatedRevenue: revenue.totalMissingPriceEstimatedRevenue || 0,
      totalPricedSoldOut: revenue.totalPricedSoldOut || 0,
      totalMissingPriceSoldOut: revenue.totalMissingPriceSoldOut || 0,
      precisionLabel: revenue.precision?.label || "",
      precisionGrade: revenue.precision?.grade || ""
    }
  };
}

function companyRecrawlComparisonHtml(company = {}, profile = {}, decision = {}) {
  const comparison = companyRecrawlComparison(company);
  const recommendation = companyRecrawlAutoRecommendation(company, profile, decision, comparison);
  const latestDate = comparison.latest?.collectedAt ? compactDateTime(comparison.latest.collectedAt) : "최신 수집 대기";
  const previousDate = comparison.previous?.collectedAt ? compactDateTime(comparison.previous.collectedAt) : "이전 수집 대기";
  const applyButton = recommendation.status
    ? `<button type="button" data-company-review-action="${escapeHtml(recommendation.status)}" data-company-id="${escapeHtml(company.companyId || "")}">추천 적용</button>`
    : "";
  if (!comparison.hasComparison) {
    return `
      <div class="company-recheck-card watch">
        <div class="company-recheck-head">
          <div>
            <strong>재수집 후 자동 재검토</strong>
            <small>${escapeHtml(`${previousDate} → ${latestDate}`)}</small>
          </div>
          <span class="company-recheck-badge watch">${escapeHtml(recommendation.label)}</span>
        </div>
        <p>${escapeHtml(recommendation.reasons[0] || "이전 수집값이 확보되면 전후 비교가 표시됩니다.")}</p>
      </div>
    `;
  }
  return `
    <div class="company-recheck-card ${escapeHtml(comparison.tone)}">
      <div class="company-recheck-head">
        <div>
          <strong>재수집 후 자동 재검토</strong>
          <small>${escapeHtml(`${previousDate} → ${latestDate}`)}</small>
        </div>
        <span class="company-recheck-badge ${escapeHtml(recommendation.tone)}">${escapeHtml(recommendation.label)}</span>
      </div>
      <div class="company-recheck-grid">
        ${comparison.cells.map((cell) => queueComparisonCell(cell.label, cell.before, cell.after, cell.tone, cell.note)).join("")}
      </div>
      <div class="company-recheck-recommend">
        <div>
          <span>자동 추천</span>
          <strong>${escapeHtml(companyAdminReviewLabel(recommendation.status) || recommendation.label)}</strong>
          <small>${escapeHtml(recommendation.reasons.join(" · "))}</small>
        </div>
        ${applyButton}
      </div>
    </div>
  `;
}

function companySalesAction(company = {}) {
  const tags = company.salesTarget?.priorityTags || [];
  const signals = company.salesTarget?.signals || {};
  const reasons = company.salesTarget?.reasons || [];
  const has = (text) => tags.some((tag) => String(tag).includes(text)) || reasons.some((reason) => String(reason).includes(text));
  if (has("금요일")) {
    return {
      label: "금요일 보강",
      pitch: "토요일 수요를 금요일 숙박/연박 패키지로 당겨오는 제안",
      next: "금요일 가격, 조식/바비큐, 2박 할인 구성을 확인"
    };
  }
  if (has("일요일")) {
    return {
      label: "일요일 보강",
      pitch: "주말 이후 빈 수요를 늦은 퇴실/일요일 특가로 회수",
      next: "일요일 잔여율과 퇴실시간/연박 조건 확인"
    };
  }
  if (has("평일") || signals.weekdayWeak) {
    return {
      label: "평일 패키지",
      pitch: "월~목 저점에 가족/단체/기업 소규모 체류 상품 제안",
      next: "평일 평균 판매율과 지역 생활권 수요 확인"
    };
  }
  if (has("당일") || has("캠프닉") || signals.dayUseMissing) {
    return {
      label: "캠프닉 추가",
      pitch: "숙박 외 당일상품을 보조 매출 상품으로 설계",
      next: "데이유즈 회차, 기준 인원, 바비큐 포함 여부 확인"
    };
  }
  if (has("OTA") || has("예약ID") || has("수량구조")) {
    return {
      label: "채널/수량 확인",
      pitch: "네이버 기준 총량을 확인한 뒤 OTA 가격·노출 공백 점검",
      next: "총 객실수, 예약ID, NOL/떠나요/여기어때 노출 비교"
    };
  }
  return {
    label: "상품 재정리",
    pitch: "노출 대비 예약 상품과 가격 구성을 고객 관점으로 정리",
    next: "대표 상품명, 최저가, 주말/평일 구성 확인"
  };
}

function companyReviewContextFromButton(button, status = "") {
  return companyReviewContextForCompany(button?.dataset?.companyId || "", status, button?.dataset?.companyReviewSource || "");
}

function companySalesStage(company = {}) {
  const review = company.adminReview?.status || "";
  if (review === "contact_ready") return { key: "contact", label: "컨택 가능", priority: 0 };
  if (review === "confirmed") return { key: "confirmed", label: "확인 완료", priority: 0 };
  if (review === "manual_needed") return { key: "manual", label: "보정 필요", priority: 2 };
  if (review === "recrawl_needed") return { key: "verify", label: "재수집 필요", priority: 2 };
  if (review === "check_needed") return { key: "verify", label: "확인 필요", priority: 2 };
  if (review === "hold") return { key: "hold", label: "보류", priority: 5 };
  if (review === "exclude" || company.salesTarget?.category === "exclude") return { key: "exclude", label: "제외", priority: 9 };
  if (company.salesTarget?.category === "contact") return { key: "contact", label: "컨택 후보", priority: 1 };
  if (company.salesTarget?.category === "verify") return { key: "verify", label: "검증 후보", priority: 3 };
  return { key: "observe", label: "관찰", priority: 6 };
}

function companySalesBoardEntries() {
  const master = companyMasterSource();
  const companies = master.companies || [];
  return companies
    .map((company) => {
      const stage = companySalesStage(company);
      const action = companySalesAction(company);
      const item = companyItemFromCurrentRun(company);
      const decision = companyDecisionQueueProfile(company);
      const revenueImpact = companyQueueRevenueImpact(company);
      const revenueEvidence = queueRevenueEvidenceProfile(revenueImpact);
      const comparison = companyRecrawlComparison(company);
      const contact = company.salesContact || {};
      const executionScore = companySalesExecutionScore(company, revenueImpact, comparison);
      const followUp = companySalesFollowUpProfile(company, revenueImpact);
      const followUpScore = companySalesFollowUpScore(company, revenueImpact, followUp);
      const priorityScore = executionScore + followUpScore;
      return { company, stage, action, item, decision, revenueImpact, revenueEvidence, comparison, contact, executionScore, followUp, followUpScore, priorityScore };
    })
    .filter((entry) => ["confirmed", "contact"].includes(entry.stage.key) && !entry.decision.inQueue && (!entry.revenueEvidence.weak || ["confirmed", "contact_ready"].includes(entry.company.adminReview?.status || "")))
    .sort((a, b) => a.stage.priority - b.stage.priority || a.followUp.priority - b.followUp.priority || b.priorityScore - a.priorityScore || (b.company.salesTarget?.score || 0) - (a.company.salesTarget?.score || 0) || (a.company.bestRank || 9999) - (b.company.bestRank || 9999));
}

function salesGateReviewEntries(limit = 8) {
  const boardIds = new Set(companySalesBoardEntries().map((entry) => entry.company.companyId).filter(Boolean));
  const rows = companyDecisionQueueEntries(companyMasterSource())
    .filter((entry) => !boardIds.has(entry.company.companyId))
    .filter((entry) => !["confirmed", "contact_ready"].includes(entry.company.adminReview?.status || ""))
    .map((entry) => {
      const contextText = companyReviewContextText(entry.company.adminReview?.context || {});
      const note = entry.company.adminReview?.note || "";
      const reasons = [
        note,
        contextText,
        entry.decision?.summary,
        entry.decision?.reasons?.[0],
        entry.autoRecommendation?.label,
        ...(entry.autoRecommendation?.reasons || []),
        ...(entry.company.salesTarget?.reasons || [])
      ].filter(Boolean);
      return {
        ...entry,
        gateReason: compactListText(reasons, "판단 근거 확인 필요", 3),
        gateStatus: entry.company.adminReview?.label || entry.workflow?.label || entry.type?.label || "확인 필요"
      };
    });
  return limit ? rows.slice(0, limit) : rows;
}

function salesGateFilterOptions() {
  return [
    ["all", "전체"],
    ["revenue_weak", "매출 근거"],
    ["recrawl", "재수집"],
    ["manual", "확인/보정"],
    ["high_revenue", "고매출"],
    ["gap", "판매 공백"],
    ["ota", "OTA"]
  ];
}

function salesGateFilterLabel(value = "all") {
  return salesGateFilterOptions().find(([key]) => key === value)?.[1] || "전체";
}

function salesGateFilterMatches(entry = {}, filter = "all") {
  if (filter === "all") return true;
  const criteria = new Set((entry.decision?.criteria || []).map((criterion) => criterion.key).filter(Boolean));
  const issues = new Set((entry.profile?.issues || []).map((issue) => issue.key).filter(Boolean));
  const recommendationStatus = entry.autoRecommendation?.status || "";
  const reviewStatus = entry.company?.adminReview?.status || "";
  const typeKey = entry.type?.key || "";
  const revenue = entry.revenueImpact || {};
  const revenueEvidence = entry.revenueEvidence || queueRevenueEvidenceProfile(revenue);
  if (filter === "revenue_weak") return revenueEvidence.weak || criteria.has("revenue") || finiteNumber(revenue.totalMissingPriceSoldOut) > 0;
  if (filter === "recrawl") return recommendationStatus === "recrawl_needed" || reviewStatus === "recrawl_needed" || typeKey === "recrawl" || criteria.has("revenue") || revenueEvidence.weak;
  if (filter === "manual") return ["manual_needed", "check_needed"].includes(recommendationStatus) || ["manual_needed", "check_needed"].includes(reviewStatus) || ["correction", "check"].includes(typeKey) || ["quantity", "capacity", "manual_recheck"].some((key) => criteria.has(key)) || ["manual", "structure", "booking", "offline"].some((key) => issues.has(key));
  if (filter === "high_revenue") return effectiveRevenueValue(revenue) >= 2000000;
  if (filter === "gap") return criteria.has("gap") || issues.has("gap") || (entry.decision?.gapType && entry.decision.gapType !== "공백 특이 없음");
  if (filter === "ota") return criteria.has("ota") || issues.has("ota") || ["OTA", "여기어때", "야놀자", "떠나요"].some((label) => (entry.decision?.channelText || "").includes(label));
  return false;
}

function salesGateFilteredEntries(entries = [], filter = "all") {
  return entries.filter((entry) => salesGateFilterMatches(entry, filter));
}

function salesGateFilterHtml(entries = [], selectedFilter = "all") {
  return `
    <div class="target-gate-filters" role="group" aria-label="보류 게이트 필터">
      ${salesGateFilterOptions().map(([value, label]) => {
        const count = value === "all" ? entries.length : entries.filter((entry) => salesGateFilterMatches(entry, value)).length;
        return `
          <button type="button" class="${selectedFilter === value ? "active" : ""}" data-sales-gate-filter="${escapeHtml(value)}">
            ${escapeHtml(label)}
            <span>${fmtNumber(count)}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function salesGateReviewActionsHtml(entry = {}) {
  const company = entry.company || {};
  const companyId = company.companyId || "";
  if (!companyId) return "";
  const current = company.adminReview?.status || "";
  const recommendationStatus = entry.autoRecommendation?.status || "";
  const note = company.adminReview?.note || compactListText([
    "영업 보류 게이트",
    entry.gateStatus,
    entry.gateReason,
    ...(entry.revenueEvidence?.reasons || []).slice(0, 1)
  ], "영업 보류 게이트 판단", 3);
  const actions = [
    ["recrawl_needed", "재수집"],
    ["check_needed", "확인"],
    ["manual_needed", "보정"],
    ["contact_ready", "컨택"],
    ["hold", "보류"]
  ];
  return `
    <div class="target-gate-review company-review-control compact" data-company-review-control data-company-id="${escapeHtml(companyId)}">
      <input type="text" data-company-review-note value="${escapeHtml(note)}" placeholder="보류 게이트 판단 메모">
      <div class="company-review-actions compact">
        ${actions.map(([status, label]) => `
          <button type="button" class="${current === status ? "active" : ""}" data-company-review-action="${status}" data-company-id="${escapeHtml(companyId)}" data-company-review-source="sales_gate">${escapeHtml(recommendationStatus === status ? `추천 ${label}` : label)}</button>
        `).join("")}
      </div>
    </div>
  `;
}

function salesGateBulkReviewHtml(entries = [], selectedFilter = "all") {
  const count = entries.filter((entry) => entry.company?.companyId).length;
  if (!count) return "";
  const filterLabel = salesGateFilterLabel(selectedFilter);
  const actions = [
    ["recrawl_needed", "재수집"],
    ["check_needed", "확인"],
    ["manual_needed", "보정"],
    ["contact_ready", "컨택"],
    ["hold", "보류"]
  ];
  return `
    <div class="target-gate-bulk" data-sales-gate-bulk>
      <div>
        <strong>보류 게이트 일괄 처리</strong>
        <small>${escapeHtml(`현재 필터 ${filterLabel} · 보류 대상 ${fmtNumber(count)}개 · 저장 후 컨택 가능 업체는 영업타깃으로 이동`)}</small>
      </div>
      <input type="text" data-sales-gate-bulk-note value="${escapeHtml(`보류 게이트 일괄 처리: ${filterLabel} ${fmtNumber(count)}개`)}" placeholder="보류 게이트 일괄 처리 메모">
      <div>
        ${actions.map(([status, label]) => `<button type="button" data-sales-gate-bulk-action="${escapeHtml(status)}">${escapeHtml(label)}</button>`).join("")}
      </div>
    </div>
  `;
}

function salesGateRevenueEvidenceHtml(entry = {}) {
  const company = entry.company || {};
  const profile = entry.profile || {};
  const decision = entry.decision || {};
  const revenueImpact = entry.revenueImpact || {};
  const revenueEvidence = entry.revenueEvidence || queueRevenueEvidenceProfile(revenueImpact);
  const dayCoverage = queueRevenueDayCoverageSummary(revenueImpact);
  const productCoverage = queueRevenueProductCoverageSummary(revenueImpact);
  const plan = companyQueueRecrawlPlan(company, profile, decision);
  const eta = crawlEtaForPlan(plan);
  const reasonText = compactListText(revenueEvidence.reasons || [], "매출 근거는 현재 기준 안정적입니다.", 3);
  return `
    <div class="target-gate-evidence ${escapeHtml(revenueEvidence.weak ? "watch" : "good")}">
      <div>
        <span>요일 가격</span>
        <strong>${escapeHtml(dayCoverage.value)}</strong>
        <small>${escapeHtml(dayCoverage.detail)}</small>
      </div>
      <div>
        <span>상품 수량</span>
        <strong>${escapeHtml(productCoverage.value)}</strong>
        <small>${escapeHtml(productCoverage.detail)}</small>
      </div>
      <div>
        <span>보류 근거</span>
        <strong>${escapeHtml(revenueEvidence.label)}</strong>
        <small>${escapeHtml(reasonText)}</small>
      </div>
    </div>
    <div class="target-gate-recrawl">
      <button type="button" data-queue-recrawl-company="${escapeHtml(company.companyId || "")}" data-queue-recrawl-source="sales_gate">수집 설정 적용</button>
      <small>${escapeHtml(`${plan.keyword || activeKeyword()} · ${plan.regionScope ? `지역 ${plan.regionScope} · ` : ""}${plan.keywordSource || "업체 기준"} · ${plan.checkIn || "체크인"}~${plan.checkOut || "체크아웃"} · 상세 ${plan.range || "1-20"}위 · 예상 ${crawlEtaShortText(eta)}`)}</small>
      ${recrawlRangePresetHtml({ companyId: company.companyId || "", selectedRange: plan.range || "1-20" })}
    </div>
  `;
}

function salesGateRecrawlRows(entries = salesGateReviewEntries(0)) {
  return entries
    .map(recrawlAutomationRow)
    .filter((row) => row.status === "recrawl_needed" || row.revenueEvidence?.weak || row.entry.type.key === "recrawl" || !row.comparison.hasComparison);
}

function salesGateRecrawlBatches(entries = salesGateReviewEntries(0)) {
  return recrawlAutomationBatches(salesGateRecrawlRows(entries));
}

function salesGateBatchHtml(entries = []) {
  const rows = salesGateRecrawlBatches(entries).filter((batch) => batch.count > 1).slice(0, 3);
  if (!rows.length) return "";
  return `
    <article class="target-gate-batch recrawl-batch-panel">
      <div class="history-card-head">
        <strong>보류 항목 묶음 실행</strong>
        <small>같은 키워드·지역·기간·상세 범위의 보류 업체를 한 번에 재수집합니다.</small>
      </div>
      <div class="recrawl-batch-list">
        ${rows.map((batch, index) => `
          <div>
            <mark>${fmtNumber(index + 1)}</mark>
            <div>
              <b>${escapeHtml(batch.plan.keyword || activeKeyword())}</b>
              <small>${escapeHtml([
                `${fmtNumber(batch.count)}개 보류`,
                batch.regionScopes?.length ? `지역 ${batch.regionScopes.slice(0, 2).join(" / ")}` : "",
                batch.plan.checkIn && batch.plan.checkOut ? `${batch.plan.checkIn}~${batch.plan.checkOut}` : "기간 확인",
                `상세 ${batch.plan.range || batch.plan.detailRankRanges || "1-20"}위`
              ].filter(Boolean).join(" · "))}</small>
              <div class="recrawl-auto-eta">
                <span><b>묶음 ETA</b>${escapeHtml(batch.etaText || "계산 대기")}</span>
                <span><b>절감 예상</b>${escapeHtml(batch.savedSeconds ? formatElapsed(batch.savedSeconds) : "중복 없음")}</span>
              </div>
              <p>${escapeHtml(`${batch.names.slice(0, 3).join(", ")}${batch.count > 3 ? ` 외 ${fmtNumber(batch.count - 3)}개` : ""} · ${batch.reason}`)}</p>
              ${recrawlRangePresetHtml({ batchKey: batch.key, selectedRange: batch.plan.range || batch.plan.detailRankRanges || "1-20", source: "sales_gate" })}
            </div>
            <button type="button" data-recrawl-batch-key="${escapeHtml(batch.key)}" data-recrawl-batch-source="sales_gate">묶음 설정</button>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function salesContactOptions() {
  return [
    ["not_contacted", "미컨택"],
    ["first_contacted", "1차 컨택"],
    ["waiting_reply", "답변 대기"],
    ["interested", "관심 있음"],
    ["high_potential", "계약 가능성 높음"],
    ["hold", "보류"],
    ["excluded", "제외"]
  ];
}

function salesContactMeta(status) {
  return {
    not_contacted: { label: "미컨택", tone: "todo", order: 1 },
    first_contacted: { label: "1차 컨택", tone: "progress", order: 2 },
    waiting_reply: { label: "답변 대기", tone: "wait", order: 3 },
    interested: { label: "관심 있음", tone: "good", order: 4 },
    high_potential: { label: "계약 가능성 높음", tone: "strong", order: 5 },
    hold: { label: "보류", tone: "hold", order: 6 },
    excluded: { label: "제외", tone: "bad", order: 7 }
  }[status] || { label: "미컨택", tone: "todo", order: 1 };
}

function salesResponseOptions() {
  return [
    ["not_recorded", "반응 미기록"],
    ["no_response", "무응답"],
    ["replied", "답변 있음"],
    ["requested_materials", "자료 요청"],
    ["meeting_scheduled", "미팅 예정"],
    ["low_interest", "관심 낮음"],
    ["price_rejected", "가격 거절"],
    ["contract_review", "계약 검토"],
    ["contract_excluded", "계약 제외"]
  ];
}

function salesResponseMeta(status) {
  return {
    not_recorded: { label: "반응 미기록", tone: "todo", score: 0, positive: false },
    no_response: { label: "무응답", tone: "wait", score: -8, positive: false },
    replied: { label: "답변 있음", tone: "progress", score: 10, positive: true },
    requested_materials: { label: "자료 요청", tone: "good", score: 18, positive: true },
    meeting_scheduled: { label: "미팅 예정", tone: "strong", score: 28, positive: true },
    low_interest: { label: "관심 낮음", tone: "hold", score: -18, positive: false },
    price_rejected: { label: "가격 거절", tone: "bad", score: -16, positive: false },
    contract_review: { label: "계약 검토", tone: "strong", score: 34, positive: true },
    contract_excluded: { label: "계약 제외", tone: "bad", score: -45, positive: false }
  }[status] || { label: "반응 미기록", tone: "todo", score: 0, positive: false };
}

function salesResponseReasonOptions() {
  return [
    ["none", "사유 미기록"],
    ["price_issue", "가격 문제"],
    ["ops_mismatch", "운영 방식 불일치"],
    ["using_ota", "OTA 사용 중"],
    ["direct_booking_pref", "직접 예약 선호"],
    ["low_room_count", "객실 수 부족"],
    ["after_peak", "성수기 이후 재논의"],
    ["needs_owner_review", "대표 검토 필요"],
    ["product_fit", "상품 적합"],
    ["offline_booking_high", "오프라인 예약 높음"]
  ];
}

function salesResponseReasonMeta(reason) {
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
  }[reason] || { label: "사유 미기록", tone: "todo" };
}

function todayIsoDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function salesPipelineStatusKeys() {
  return ["first_contacted", "waiting_reply", "interested", "high_potential"];
}

function salesHotStatusKeys() {
  return ["interested", "high_potential"];
}

function salesClosedStatusKeys() {
  return ["hold", "excluded"];
}

function companySalesFollowUpProfile(company = {}, revenueImpact = {}) {
  const contact = company.salesContact || {};
  const status = contact.status || "not_contacted";
  const nextActionAt = String(contact.nextActionAt || "").slice(0, 10);
  const today = todayIsoDate();
  const soonLimit = isoAddDays(today, 3);
  const hasNext = /^\d{4}-\d{2}-\d{2}$/.test(nextActionAt);
  const active = salesPipelineStatusKeys().includes(status);
  const closed = salesClosedStatusKeys().includes(status);
  const revenue = effectiveRevenueValue(revenueImpact);
  if (closed) {
    return { key: "closed", label: "종료", tone: "closed", priority: 8, nextActionAt, detail: salesContactMeta(status).label, revenue };
  }
  if (hasNext && nextActionAt < today) {
    return { key: "overdue", label: "지연", tone: "overdue", priority: 0, nextActionAt, detail: `${nextActionAt} 처리 필요`, revenue };
  }
  if (hasNext && nextActionAt === today) {
    return { key: "today", label: "오늘 처리", tone: "today", priority: 1, nextActionAt, detail: "오늘 후속 예정", revenue };
  }
  if (hasNext && soonLimit && nextActionAt <= soonLimit) {
    return { key: "soon", label: "임박", tone: "soon", priority: 2, nextActionAt, detail: `${nextActionAt} 예정`, revenue };
  }
  if (active && !hasNext) {
    return { key: "needs_date", label: "날짜 필요", tone: "needs-date", priority: 3, nextActionAt, detail: "다음 액션일 미지정", revenue };
  }
  if (hasNext) {
    return { key: "scheduled", label: "예정", tone: "scheduled", priority: 4, nextActionAt, detail: `${nextActionAt} 예정`, revenue };
  }
  return { key: "not_planned", label: "초기 컨택", tone: "todo", priority: 5, nextActionAt, detail: "컨택일 미지정", revenue };
}

function companySalesFollowUpScore(company = {}, revenueImpact = {}, followUp = null) {
  const profile = followUp || companySalesFollowUpProfile(company, revenueImpact);
  const status = company.salesContact?.status || "not_contacted";
  const response = salesResponseMeta(company.salesContact?.responseStatus || "not_recorded");
  let score = 0;
  if (profile.key === "overdue") score += 38;
  else if (profile.key === "today") score += 34;
  else if (profile.key === "soon") score += 22;
  else if (profile.key === "needs_date") score += 14;
  if (status === "high_potential") score += 28;
  else if (status === "interested") score += 22;
  else if (status === "waiting_reply") score += 14;
  else if (status === "first_contacted") score += 9;
  const revenue = effectiveRevenueValue(revenueImpact);
  if (revenue >= 5000000) score += 18;
  else if (revenue >= 2000000) score += 11;
  else if (revenue >= 700000) score += 5;
  if (salesClosedStatusKeys().includes(status)) score -= 50;
  score += response.score || 0;
  return Math.max(0, Math.round(score));
}

function companySalesExecutionScore(company = {}, revenueImpact = {}, comparison = {}) {
  let score = Number(company.salesTarget?.score || 0);
  const rank = Number(company.bestRank || 0);
  if (rank > 0 && rank <= 5) score += 14;
  else if (rank > 0 && rank <= 10) score += 9;
  else if (rank > 0 && rank <= 20) score += 5;
  const revenue = effectiveRevenueValue(revenueImpact);
  if (revenue >= 5000000) score += 18;
  else if (revenue >= 2000000) score += 11;
  else if (revenue >= 700000) score += 5;
  if (finiteNumber(revenueImpact.totalMissingPriceSoldOut) > 0) score += 4;
  const signals = company.salesTarget?.signals || {};
  if (signals.fridayWeak) score += 5;
  if (signals.sundayWeak) score += 5;
  if (signals.weekdayWeak) score += 4;
  if (comparison.hasComparison && comparison.improved > comparison.worsened) score += 8;
  if (company.adminReview?.status === "contact_ready") score += 12;
  if (company.adminReview?.status === "confirmed") score += 8;
  const contactOrder = salesContactMeta(company.salesContact?.status).order;
  if (contactOrder >= 4 && contactOrder <= 5) score += 10;
  if (company.salesContact?.status === "excluded") score -= 80;
  if (company.salesContact?.status === "hold") score -= 20;
  return Math.max(0, Math.round(score));
}

function companySalesPipelineSummary(entries = []) {
  const rows = salesContactOptions().map(([status, fallbackLabel]) => {
    const meta = salesContactMeta(status);
    const matches = entries.filter((entry) => (entry.company.salesContact?.status || "not_contacted") === status);
    return {
      status,
      label: meta.label || fallbackLabel,
      tone: meta.tone,
      count: matches.length,
      revenue: matches.reduce((sum, entry) => sum + effectiveRevenueValue(entry.revenueImpact || {}), 0),
      due: matches.filter((entry) => ["overdue", "today", "soon"].includes(entry.followUp.key)).length
    };
  });
  const active = entries.filter((entry) => salesPipelineStatusKeys().includes(entry.company.salesContact?.status || ""));
  const hot = entries.filter((entry) => salesHotStatusKeys().includes(entry.company.salesContact?.status || ""));
  return {
    rows,
    activeCount: active.length,
    activeRevenue: active.reduce((sum, entry) => sum + effectiveRevenueValue(entry.revenueImpact || {}), 0),
    hotCount: hot.length,
    hotRevenue: hot.reduce((sum, entry) => sum + effectiveRevenueValue(entry.revenueImpact || {}), 0),
    overdueCount: entries.filter((entry) => entry.followUp.key === "overdue").length,
    todayCount: entries.filter((entry) => entry.followUp.key === "today").length,
    soonCount: entries.filter((entry) => entry.followUp.key === "soon").length,
    needsDateCount: entries.filter((entry) => entry.followUp.key === "needs_date").length
  };
}

function companySalesPerformanceSummary(entries = []) {
  const contacted = entries.filter((entry) => (entry.company.salesContact?.status || "not_contacted") !== "not_contacted");
  const recorded = entries.filter((entry) => (entry.company.salesContact?.responseStatus || "not_recorded") !== "not_recorded");
  const responded = entries.filter((entry) => ["replied", "requested_materials", "meeting_scheduled", "contract_review"].includes(entry.company.salesContact?.responseStatus));
  const interested = entries.filter((entry) => ["requested_materials", "meeting_scheduled", "contract_review"].includes(entry.company.salesContact?.responseStatus) || salesHotStatusKeys().includes(entry.company.salesContact?.status || ""));
  const meetings = entries.filter((entry) => entry.company.salesContact?.responseStatus === "meeting_scheduled");
  const contractReview = entries.filter((entry) => entry.company.salesContact?.responseStatus === "contract_review" || entry.company.salesContact?.status === "high_potential");
  return {
    contactedCount: contacted.length,
    recordedCount: recorded.length,
    respondedCount: responded.length,
    interestedCount: interested.length,
    meetingCount: meetings.length,
    contractReviewCount: contractReview.length,
    responseRate: contacted.length ? responded.length / contacted.length : NaN,
    interestRate: contacted.length ? interested.length / contacted.length : NaN,
    meetingRate: contacted.length ? meetings.length / contacted.length : NaN,
    contractRevenue: contractReview.reduce((sum, entry) => sum + effectiveRevenueValue(entry.revenueImpact || {}), 0),
    responseRevenue: responded.reduce((sum, entry) => sum + effectiveRevenueValue(entry.revenueImpact || {}), 0)
  };
}

function companySalesProposalResponseSummary(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.action?.label || "상품 재정리";
    if (!groups.has(key)) {
      groups.set(key, { label: key, total: 0, contacted: 0, responded: 0, interested: 0, meeting: 0, contract: 0, revenue: 0 });
    }
    const row = groups.get(key);
    const status = entry.company.salesContact?.status || "not_contacted";
    const response = entry.company.salesContact?.responseStatus || "not_recorded";
    row.total += 1;
    row.revenue += effectiveRevenueValue(entry.revenueImpact || {});
    if (status !== "not_contacted") row.contacted += 1;
    if (["replied", "requested_materials", "meeting_scheduled", "contract_review"].includes(response)) row.responded += 1;
    if (["requested_materials", "meeting_scheduled", "contract_review"].includes(response) || salesHotStatusKeys().includes(status)) row.interested += 1;
    if (response === "meeting_scheduled") row.meeting += 1;
    if (response === "contract_review" || status === "high_potential") row.contract += 1;
  }
  return [...groups.values()]
    .map((row) => ({
      ...row,
      responseRate: row.contacted ? row.responded / row.contacted : NaN,
      interestRate: row.contacted ? row.interested / row.contacted : NaN
    }))
    .sort((a, b) => b.interested - a.interested || b.responded - a.responded || b.revenue - a.revenue)
    .slice(0, 6);
}

function companySalesPrimaryUrl(company = {}, item = {}) {
  return externalPlatformUrl(item?.url) || externalPlatformUrl((company.urls || [])[0]) || "";
}

function companySalesEvidenceList(company = {}, entry = {}) {
  const signals = company.salesTarget?.signals || {};
  const revenue = entry.revenueImpact || {};
  const rows = [
    company.salesTarget?.recommendation,
    ...(company.salesTarget?.reasons || []).slice(0, 2),
    entry.action?.pitch,
    company.bestRank ? `최고 노출 ${fmtNumber(company.bestRank)}위 · ${company.bestKeyword || "대표 키워드"}` : "",
    effectiveRevenueValue(revenue) ? `예상매출 ${fmtWon(effectiveRevenueValue(revenue))}` : "",
    revenue.precision?.grade ? `매출 신뢰도 ${revenue.precision.grade} · ${fmtNumber(revenue.precision.score)}점` : "",
    finiteNumber(revenue.totalMissingPriceSoldOut) ? `가격 누락 ${fmtNumber(revenue.totalMissingPriceSoldOut)}개/회` : "",
    signals.fridayWeak ? `금요일 공백 ${fmtRate(signals.fridayRate)}` : "",
    signals.sundayWeak ? `일요일 공백 ${fmtRate(signals.sundayRate)}` : "",
    signals.weekdayWeak ? `평일 공백 ${fmtRate(signals.weekdayRate)}` : "",
    manualCorrectionHasValue(company.manualCorrection) ? `수동 보정: ${company.correctionStatus?.detail || "보정값 있음"}` : "",
    entry.comparison?.hasComparison ? `재수집 비교 개선 ${fmtNumber(entry.comparison.improved)} / 악화 ${fmtNumber(entry.comparison.worsened)}` : ""
  ].filter(Boolean);
  return [...new Set(rows)].slice(0, 7);
}

function companySalesProposalSignals(company = {}, entry = {}) {
  const signals = company.salesTarget?.signals || {};
  const action = entry.action || companySalesAction(company);
  const revenue = entry.revenueImpact || {};
  const rows = [
    { label: "제안축", value: action.label || "상품 재정리" },
    { label: "예상매출", value: fmtWon(effectiveRevenueValue(revenue)) },
    revenue.precision?.grade ? { label: "매출신뢰", value: `${revenue.precision.grade} · ${fmtNumber(revenue.precision.score)}점` } : null,
    company.bestRank ? { label: "노출", value: `${fmtNumber(company.bestRank)}위 · ${company.bestKeyword || company.latestKeyword || "대표 키워드"}` } : null,
    finiteNumber(revenue.totalMissingPriceSoldOut) ? { label: "가격확인", value: `${fmtNumber(revenue.totalMissingPriceSoldOut)}개/회` } : null,
    signals.fridayWeak ? { label: "금요일", value: `공백 ${fmtRate(signals.fridayRate)}` } : null,
    signals.sundayWeak ? { label: "일요일", value: `공백 ${fmtRate(signals.sundayRate)}` } : null,
    signals.weekdayWeak ? { label: "평일", value: `공백 ${fmtRate(signals.weekdayRate)}` } : null,
    signals.dayUseMissing ? { label: "캠프닉", value: "데이유즈/캠프닉 확인" } : null,
    manualCorrectionHasValue(company.manualCorrection) ? { label: "보정", value: company.correctionStatus?.detail || "수동 보정 있음" } : null
  ].filter((row) => row && row.value && row.value !== "0원");
  return rows.slice(0, 8);
}

function companySalesProposalQuestions(company = {}, entry = {}) {
  const action = entry.action || companySalesAction(company);
  const signals = company.salesTarget?.signals || {};
  const questions = [
    "실제 운영 총 객실수와 네이버에 열어둔 판매 수량이 같은가요?",
    "평일, 금요일, 토요일, 일요일 대표 판매가와 운영 상품 구성이 각각 어떻게 되나요?",
    "미오픈/차단으로 보이는 수량 중 오프라인 예약으로 잡는 비중이 어느 정도인가요?"
  ];
  if (signals.fridayWeak || String(action.label || "").includes("금요일")) {
    questions.push("금요일 객실 공백을 연박, 바비큐, 늦은 입실 상품으로 보강할 수 있나요?");
  }
  if (signals.sundayWeak || String(action.label || "").includes("일요일")) {
    questions.push("일요일 잔여 객실에 늦은 퇴실, 특가, 다음 주 재방문 혜택을 붙일 수 있나요?");
  }
  if (signals.weekdayWeak || String(action.label || "").includes("평일")) {
    questions.push("월~목 평일에 가족, 단체, 기업 소규모 체류 상품을 운영할 수 있나요?");
  }
  if (signals.dayUseMissing || String(action.label || "").includes("캠프닉")) {
    questions.push("데이유즈/캠프닉은 숙박과 같은 카테고리로 묶어 회차, 기준 인원, 바비큐 포함 여부를 확인해야 합니다.");
  }
  questions.push("NOL, 떠나요, 여기어때 등 OTA 채널별 노출 가격과 네이버 예약 가격이 일치하나요?");
  return [...new Set(questions)].slice(0, 7);
}

function companySalesScriptText(company = {}, entry = {}) {
  const action = entry.action || companySalesAction(company);
  const contact = company.salesContact || {};
  const status = contact.status || "not_contacted";
  const companyName = company.primaryName || entry.item?.name || "대표님";
  const revenueText = fmtWon(effectiveRevenueValue(entry.revenueImpact || {}));
  const rankText = company.bestRank ? `${company.bestKeyword || company.latestKeyword || "주요 키워드"} ${fmtNumber(company.bestRank)}위 노출` : "네이버 노출 데이터";
  const proposal = contact.proposal || action.next || action.pitch || "예약 상품 구성을 확인";
  const lead = `${companyName} 담당자님, 안녕하세요. 글램핑 예약 데이터 기준으로 ${rankText}과 판매 공백을 같이 보고 연락드립니다.`;
  if (status === "waiting_reply") {
    return `${lead}\n지난 컨택 이후 ${action.label} 제안 가능성을 다시 확인드리고 싶습니다. 현재 분석상 ${revenueText} 수준의 보완 여지가 있어 보이며, ${proposal}만 확인되면 바로 실행안을 정리할 수 있습니다.`;
  }
  if (status === "interested") {
    return `${lead}\n관심 주신 내용 기준으로는 ${action.label}이 우선입니다. 평일/금요일/일요일 가격과 실제 총 객실수만 맞춰보면, ${revenueText} 규모의 공백을 어떤 상품으로 회수할지 제안서를 짧게 정리드릴 수 있습니다.`;
  }
  if (status === "high_potential") {
    return `${lead}\n현재는 계약 가능성이 높은 상태로 보고 있습니다. ${proposal} 확인 후 ${action.label} 실행안과 예상 매출 근거를 확정해서 다음 미팅에서 바로 결정하실 수 있게 준비하겠습니다.`;
  }
  if (status === "first_contacted") {
    return `${lead}\n1차로 말씀드린 내용처럼 ${action.label} 여지가 보입니다. 실제 운영 총량과 요일별 가격만 맞춰보면 ${revenueText} 수준의 공백을 더 정확히 산출할 수 있습니다.`;
  }
  return `${lead}\n분석상 ${action.label} 제안이 우선으로 보이고, 예상 보완 매출은 ${revenueText} 수준입니다. 실제 총 객실수, 요일별 가격, 오프라인 예약 비중만 확인되면 바로 적용 가능한 제안으로 정리드리겠습니다.`;
}

function companySalesCallNote(company = {}, entry = {}) {
  const action = entry.action || companySalesAction(company);
  const questions = companySalesProposalQuestions(company, entry).slice(0, 4);
  return [
    `전화 목적: ${action.label} 제안 가능성 확인`,
    `핵심 근거: ${companySalesEvidenceList(company, entry).slice(0, 3).join(" / ") || action.pitch}`,
    `확인 질문: ${questions.join(" / ")}`,
    `다음 액션: ${company.salesContact?.nextActionAt || "후속 일정 지정"}`
  ].join("\n");
}

function companySalesProposalProfile(company = {}, entry = {}) {
  const signals = companySalesProposalSignals(company, entry);
  const questions = companySalesProposalQuestions(company, entry);
  const script = companySalesScriptText(company, entry);
  const callNote = companySalesCallNote(company, entry);
  return {
    signals,
    questions,
    script,
    callNote,
    summary: signals.map((row) => `${row.label}: ${row.value}`).join(" / "),
    questionText: questions.map((question, index) => `${index + 1}. ${question}`).join("\n")
  };
}

function salesProposalHtml(entry = {}) {
  const company = entry.company || {};
  const profile = companySalesProposalProfile(company, entry);
  return `
    <div class="sales-proposal-card">
      <div class="sales-proposal-head">
        <div>
          <strong>제안/컨택 스크립트</strong>
          <small>${escapeHtml(entry.action?.label || "상품 재정리")} · ${escapeHtml(salesContactMeta(company.salesContact?.status).label)}</small>
        </div>
        <div class="sales-copy-actions">
          <button type="button" data-copy-sales-script data-company-id="${escapeHtml(company.companyId || "")}">문구 복사</button>
          <button type="button" data-copy-sales-call-note data-company-id="${escapeHtml(company.companyId || "")}">전화 메모</button>
        </div>
      </div>
      <div class="sales-proposal-grid">
        ${profile.signals.map((row) => `
          <div>
            <span>${escapeHtml(row.label)}</span>
            <strong>${escapeHtml(row.value)}</strong>
          </div>
        `).join("")}
      </div>
      <div class="sales-script-box">
        <span>문자/카톡 초안</span>
        <p>${escapeHtml(profile.script)}</p>
      </div>
      <div class="sales-question-list">
        <strong>확인 질문</strong>
        <ol>
          ${profile.questions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}
        </ol>
      </div>
    </div>
  `;
}

function salesContactFormHtml(company = {}) {
  const contact = company.salesContact || {};
  const status = contact.status || "not_contacted";
  const responseStatus = contact.responseStatus || "not_recorded";
  const responseReason = contact.responseReason || "none";
  return `
    <div class="sales-contact-form" data-sales-contact-form data-company-id="${escapeHtml(company.companyId || "")}">
      <div class="sales-contact-fields">
        <label>
          <span>상태</span>
          <select data-sales-contact-status>
            ${salesContactOptions().map(([value, label]) => `<option value="${value}" ${status === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <label>
          <span>채널</span>
          <input type="text" data-sales-contact-channel value="${escapeHtml(contact.channel || "")}" placeholder="전화, 문자, 카톡">
        </label>
        <label>
          <span>담당자</span>
          <input type="text" data-sales-contact-person value="${escapeHtml(contact.contactPerson || "")}" placeholder="대표/담당자">
        </label>
        <label>
          <span>다음 액션</span>
          <input type="date" data-sales-contact-next value="${escapeHtml(contact.nextActionAt || "")}">
        </label>
      </div>
      <div class="sales-response-fields">
        <label>
          <span>컨택 결과</span>
          <select data-sales-response-status>
            ${salesResponseOptions().map(([value, label]) => `<option value="${value}" ${responseStatus === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <label>
          <span>반응 사유</span>
          <select data-sales-response-reason>
            ${salesResponseReasonOptions().map(([value, label]) => `<option value="${value}" ${responseReason === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
      </div>
      <label>
        <span>제안 포인트</span>
        <input type="text" data-sales-contact-proposal value="${escapeHtml(contact.proposal || "")}" placeholder="예: 금요일 객실 공백 보완, 평일 패키지 제안">
      </label>
      <label>
        <span>메모</span>
        <input type="text" data-sales-contact-note value="${escapeHtml(contact.note || "")}" placeholder="통화/문자/카톡 메모">
      </label>
      <div class="sales-contact-actions">
        <small>${contact.updatedAt ? `최근 저장 ${escapeHtml(compactDateTime(contact.updatedAt))}` : "컨택 상태 미저장"}</small>
        <button type="button" data-save-sales-contact data-company-id="${escapeHtml(company.companyId || "")}">컨택 저장</button>
      </div>
    </div>
  `;
}

function salesContactHistoryHtml(company = {}) {
  const rows = (company.salesContactHistory || []).slice(-4).reverse();
  if (!rows.length) {
    return `
      <div class="sales-contact-history empty-history">
        <div class="sales-contact-history-head">
          <strong>컨택 히스토리</strong>
          <small>저장된 컨택 기록 없음</small>
        </div>
      </div>
    `;
  }
  return `
    <div class="sales-contact-history">
      <div class="sales-contact-history-head">
        <strong>컨택 히스토리</strong>
        <small>최근 ${fmtNumber(rows.length)}건</small>
      </div>
      <ol>
        ${rows.map((row) => {
          const meta = salesContactMeta(row.status);
          const responseMeta = salesResponseMeta(row.responseStatus);
          const reasonMeta = salesResponseReasonMeta(row.responseReason);
          const details = [
            row.responseStatus && row.responseStatus !== "not_recorded" ? `반응 ${row.responseLabel || responseMeta.label}` : "",
            row.responseReason && row.responseReason !== "none" ? `사유 ${row.responseReasonLabel || reasonMeta.label}` : "",
            row.channel ? `채널 ${row.channel}` : "",
            row.contactPerson ? `담당 ${row.contactPerson}` : "",
            row.nextActionAt ? `다음 ${row.nextActionAt}` : "",
            row.proposal || "",
            row.note || ""
          ].filter(Boolean).join(" · ");
          return `
            <li>
              <span>${escapeHtml(compactDateTime(row.at || row.updatedAt || ""))}</span>
              <div>
                <strong>${escapeHtml(row.label || meta.label)}</strong>
                <small>${escapeHtml(details || "상태 저장")}</small>
              </div>
            </li>
          `;
        }).join("")}
      </ol>
    </div>
  `;
}

function salesPipelineHtml(summary = {}) {
  const activeRevenue = fmtWon(summary.activeRevenue);
  const hotRevenue = fmtWon(summary.hotRevenue);
  return `
    <section class="sales-pipeline-panel">
      <div class="target-lane-head">
        <div>
          <strong>영업 파이프라인</strong>
          <small>컨택 상태별 진행 수량과 예상 매출을 분리해서 봅니다. 진행 매출 ${activeRevenue}, 관심/유력 매출 ${hotRevenue}</small>
        </div>
        <span>${fmtNumber(summary.activeCount || 0)}</span>
      </div>
      <div class="sales-pipeline-grid">
        ${(summary.rows || []).map((row) => `
          <article class="sales-pipeline-card ${escapeHtml(row.tone)}">
            <span>${escapeHtml(row.label)}</span>
            <strong>${fmtNumber(row.count)}</strong>
            <small>${fmtWon(row.revenue)} · 후속 ${fmtNumber(row.due)}</small>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function salesPerformanceHtml(summary = {}, proposalRows = []) {
  const metricRows = [
    ["컨택", fmtNumber(summary.contactedCount), `반응 기록 ${fmtNumber(summary.recordedCount)}`],
    ["응답률", fmtRate(summary.responseRate), `응답 ${fmtNumber(summary.respondedCount)}`],
    ["관심률", fmtRate(summary.interestRate), `관심 ${fmtNumber(summary.interestedCount)}`],
    ["미팅 전환", fmtRate(summary.meetingRate), `미팅 ${fmtNumber(summary.meetingCount)}`],
    ["계약 검토", fmtNumber(summary.contractReviewCount), fmtWon(summary.contractRevenue)]
  ];
  return `
    <section class="sales-performance-panel">
      <div class="target-lane-head">
        <div>
          <strong>영업 반응/성과 추적 V2</strong>
          <small>컨택 결과와 반응 사유를 기록하고, 실제 반응이 좋은 제안 유형을 다음 우선순위에 반영합니다.</small>
        </div>
        <span>${fmtNumber(summary.respondedCount || 0)}</span>
      </div>
      <div class="sales-performance-metrics">
        ${metricRows.map(([label, value, note]) => `
          <article>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(note)}</small>
          </article>
        `).join("")}
      </div>
      <div class="sales-proposal-response-grid">
        ${proposalRows.length ? proposalRows.map((row) => `
          <article>
            <div>
              <strong>${escapeHtml(row.label)}</strong>
              <small>컨택 ${fmtNumber(row.contacted)} · 응답 ${fmtNumber(row.responded)} · 관심 ${fmtNumber(row.interested)}</small>
            </div>
            <span>${fmtRate(row.responseRate)}</span>
          </article>
        `).join("") : `<p class="empty">제안 유형별 반응 데이터가 아직 없습니다.</p>`}
      </div>
    </section>
  `;
}

function salesTargetCsvValue(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function salesTargetCsv(entries = []) {
  const headers = ["업체명", "지역", "URL", "우선순위", "예상매출", "컨택상태", "컨택결과", "반응사유", "후속상태", "다음액션", "제안포인트", "메모", "추천사유", "제안요약", "확인질문", "컨택문구", "전화메모"];
  const rows = entries.map((entry) => {
    const company = entry.company || {};
    const item = entry.item || {};
    const contact = company.salesContact || {};
    const proposal = companySalesProposalProfile(company, entry);
    return [
      company.primaryName || item.name || "",
      (company.regions || []).slice(0, 2).join(" / ") || item.region || "",
      companySalesPrimaryUrl(company, item),
      entry.priorityScore,
      effectiveRevenueValue(entry.revenueImpact || {}),
      salesContactMeta(contact.status).label,
      salesResponseMeta(contact.responseStatus).label,
      salesResponseReasonMeta(contact.responseReason).label,
      entry.followUp?.label || "",
      contact.nextActionAt || "",
      contact.proposal || entry.action?.label || "",
      contact.note || "",
      companySalesEvidenceList(company, entry).join(" | "),
      proposal.summary,
      proposal.questionText,
      proposal.script,
      proposal.callNote
    ].map(salesTargetCsvValue).join(",");
  });
  return `\uFEFF${headers.map(salesTargetCsvValue).join(",")}\n${rows.join("\n")}`;
}

function salesGateCsv(entries = salesGateReviewEntries(0), context = {}) {
  const headers = ["필터", "업체ID", "업체명", "지역", "URL", "최고순위", "최고키워드", "보류상태", "큐유형", "워크플로우", "큐사유", "문제날짜", "수량신뢰도", "공백유형", "확인채널", "추천조치", "추천근거", "예상매출", "매출정밀도", "요일가격확보", "상품수량근거", "가격확보수량", "가격누락수량", "관리메모", "저장근거", "다음처리"];
  const rows = entries.map((entry) => {
    const company = entry.company || {};
    const item = entry.item || {};
    const decision = entry.decision || {};
    const revenueImpact = entry.revenueImpact || {};
    const precision = revenueImpact.precision || {};
    const regions = Array.isArray(company.regions) ? company.regions : [];
    const recommendationReasons = Array.isArray(entry.autoRecommendation?.reasons) ? entry.autoRecommendation.reasons : [];
    const workflowReasons = Array.isArray(entry.workflow?.reasons) ? entry.workflow.reasons : [];
    const decisionActions = Array.isArray(decision.actions) ? decision.actions : [];
    const nextActions = [...workflowReasons, ...decisionActions].filter(Boolean);
    const revenue = effectiveRevenueValue(revenueImpact);
    const pricedSoldOut = finiteNumber(revenueImpact.totalPricedSoldOut, 0);
    const missingPriceSoldOut = finiteNumber(revenueImpact.totalMissingPriceSoldOut, 0);
    const dayCoverage = queueRevenueDayCoverageSummary(revenueImpact);
    const productCoverage = queueRevenueProductCoverageSummary(revenueImpact);
    return [
      context.filterLabel || "",
      company.companyId || "",
      company.primaryName || item.name || "",
      regions.slice(0, 3).join(" / ") || item.region || "",
      companySalesPrimaryUrl(company, item),
      company.bestRank ? `${fmtNumber(company.bestRank)}위` : "",
      company.bestKeyword || company.latestKeyword || "",
      entry.gateStatus || company.adminReview?.label || entry.workflow?.label || entry.type?.label || "확인 필요",
      entry.type?.label || "",
      entry.workflow?.label || "",
      entry.gateReason || decision.summary || "",
      decision.problemDateText || "",
      decision.quantityConfidence || "",
      decision.gapType || "",
      decision.channelText || "",
      entry.autoRecommendation?.label || "",
      recommendationReasons.slice(0, 3).join(" | "),
      revenue || "",
      [precision.grade, precision.label].filter(Boolean).join(" · "),
      dayCoverage.csv || "",
      productCoverage.csv || "",
      pricedSoldOut || "",
      missingPriceSoldOut || "",
      company.adminReview?.note || "",
      companyReviewContextText(company.adminReview?.context || {}),
      nextActions.slice(0, 2).join(" | ")
    ].map(salesTargetCsvValue).join(",");
  });
  return `\uFEFF${headers.map(salesTargetCsvValue).join(",")}\n${rows.join("\n")}`;
}

function decisionQueueCsv(entries = [], context = {}) {
  const headers = ["필터", "검색어", "업체ID", "업체명", "지역", "URL", "최고순위", "최고키워드", "우선도", "우선도점수", "워크플로우", "큐유형", "현재관리상태", "자동추천", "추천근거", "큐사유", "문제날짜", "수량신뢰도", "공백유형", "확인채널", "재수집설정", "예상소요", "예상매출", "매출정밀도", "요일가격확보", "상품수량근거", "가격확보수량", "가격누락수량", "관리메모", "저장근거", "다음처리"];
  const rows = entries.map((entry) => {
    const company = entry.company || {};
    const decision = entry.decision || {};
    const revenueImpact = entry.revenueImpact || {};
    const precision = revenueImpact.precision || {};
    const plan = companyQueueRecrawlPlan(company, entry.profile || {}, decision);
    const eta = crawlEtaForPlan(plan);
    const regions = Array.isArray(company.regions) ? company.regions : [];
    const recommendationReasons = Array.isArray(entry.autoRecommendation?.reasons) ? entry.autoRecommendation.reasons : [];
    const decisionReasons = Array.isArray(decision.reasons) ? decision.reasons : [];
    const decisionActions = Array.isArray(decision.actions) ? decision.actions : [];
    const workflowReasons = Array.isArray(entry.workflow?.reasons) ? entry.workflow.reasons : [];
    const dayCoverage = queueRevenueDayCoverageSummary(revenueImpact);
    const productCoverage = queueRevenueProductCoverageSummary(revenueImpact);
    return [
      context.filterLabel || "",
      context.query || "",
      company.companyId || "",
      company.primaryName || "",
      regions.slice(0, 3).join(" / "),
      companySalesPrimaryUrl(company, companyItemFromCurrentRun(company) || {}),
      company.bestRank ? `${fmtNumber(company.bestRank)}위` : "",
      company.bestKeyword || company.latestKeyword || "",
      entry.priority?.label || "",
      finiteNumber(entry.priority?.score, 0) || "",
      entry.workflow?.label || "",
      entry.type?.label || "",
      company.adminReview?.label || companyAdminReviewLabel(company.adminReview?.status) || "미검증",
      entry.autoRecommendation?.label || "",
      recommendationReasons.slice(0, 3).join(" | "),
      decision.summary || decisionReasons.slice(0, 2).join(" | "),
      decision.problemDateText || "",
      decision.quantityConfidence || "",
      decision.gapType || "",
      decision.channelText || "",
      `${plan.keyword} · ${plan.regionScope ? `지역 ${plan.regionScope} · ` : ""}${plan.keywordSource || "업체 기준"} · ${plan.checkIn || "체크인"}~${plan.checkOut || "체크아웃"} · 상세 ${plan.range}위`,
      `${crawlEtaShortText(eta)} · ${crawlEtaSourceText(eta)}`,
      effectiveRevenueValue(revenueImpact) || "",
      [precision.grade, precision.label].filter(Boolean).join(" · "),
      dayCoverage.csv || "",
      productCoverage.csv || "",
      finiteNumber(revenueImpact.totalPricedSoldOut, 0) || "",
      finiteNumber(revenueImpact.totalMissingPriceSoldOut, 0) || "",
      company.adminReview?.note || "",
      companyReviewContextText(company.adminReview?.context || {}),
      [...workflowReasons, ...decisionActions].filter(Boolean).slice(0, 2).join(" | ")
    ].map(salesTargetCsvValue).join(",");
  });
  return `\uFEFF${headers.map(salesTargetCsvValue).join(",")}\n${rows.join("\n")}`;
}

function collectionQualityCsv(profile = collectionQualityMonitorProfile()) {
  const headers = ["구분", "대상", "지역", "순위", "상태/점수", "근거", "추천설정", "예상매출"];
  const rows = [
    [
      "요약",
      activeKeyword(),
      "",
      "",
      `${fmtNumber(profile.quality.score)}점 · ${profile.quality.label}`,
      profile.quality.summary,
      `${profile.diag.run.collectionModeLabel || collectionModeLabel(profile.diag.run.collectionMode)} · ${collectionQualityDetailLabel(profile.diag)}`,
      ""
    ],
    ...profile.alerts.map((row) => [
      "이상신호",
      row.label,
      "",
      "",
      row.value,
      row.detail,
      "",
      ""
    ]),
    ...profile.recrawlRows.map((row) => [
      "재수집",
      row.name,
      row.region,
      row.rank ? `${fmtNumber(row.rank)}위` : "",
      `${fmtNumber(row.score)}점 · ${row.source}`,
      row.reason,
      row.setting,
      row.revenue ? finiteNumber(row.revenue, 0) : ""
    ]),
    ...profile.feedback.map((row) => [
      "설정피드백",
      row.label,
      "",
      "",
      row.value,
      row.detail,
      `${row.mode === "fast" ? "빠른순위" : "정밀분석"} · 상세 ${row.range}`,
      ""
    ])
  ];
  return `\uFEFF${headers.map(salesTargetCsvValue).join(",")}\n${rows.map((row) => row.map(salesTargetCsvValue).join(",")).join("\n")}`;
}

function recrawlAutomationCsv(entries = companyDecisionQueueEntries(companyMasterSource())) {
  const profile = recrawlAutomationProfile(entries);
  const batches = recrawlAutomationBatches(profile.needsExecution);
  const headers = ["구분", "업체명/묶음", "지역", "순위", "포함업체", "추천상태", "재수집설정", "예상소요", "예상기준", "절감예상", "전후비교", "근거", "예상매출", "관리메모"];
  const rowFor = (group, row) => [
    group,
    row.name,
    row.region,
    row.rank ? `${fmtNumber(row.rank)}위` : "",
    "1",
    recrawlAutomationStatusLabel(row.status),
    `${row.plan?.keyword || ""} · ${row.keywordSource || "업체 기준"}${row.regionScope ? ` · 지역 ${row.regionScope}` : ""} · 정밀분석 · 상세 ${row.range}위 · ${row.dateText}`,
    row.etaText || "",
    row.etaSource || "",
    "",
    row.comparison?.hasComparison ? `개선 ${fmtNumber(row.comparison.improved)} / 악화 ${fmtNumber(row.comparison.worsened)} · ${compactDateTime(row.previous)} → ${compactDateTime(row.latest)}` : "비교 대기",
    row.reason,
    row.revenue ? finiteNumber(row.revenue, 0) : "",
    row.note
  ];
  const batchFor = (batch) => [
    "묶음실행",
    batch.names.join(" / "),
    batch.regions.join(" / "),
    "",
    batch.count,
    "묶음 수집",
    `정밀분석 · 상세 ${batch.plan.range || batch.plan.detailRankRanges || "1-20"}위 · ${batch.plan.checkIn || ""}~${batch.plan.checkOut || ""}`,
    batch.etaText || "",
    batch.etaSource || "",
    batch.savedSeconds ? formatElapsed(batch.savedSeconds) : "",
    "한 번 수집으로 동일 조건 후보 동시 확인",
    batch.reason,
    batch.revenue ? finiteNumber(batch.revenue, 0) : "",
    `${batch.plan.keyword || activeKeyword()}${batch.regionScopes?.length ? ` · 지역 ${batch.regionScopes.join("/")}` : ""} · ${fmtNumber(batch.count)}개 후보`
  ];
  const rows = [
    ...batches.map(batchFor),
    ...profile.needsExecution.map((row) => rowFor("재수집실행", row)),
    ...profile.transitions.map((row) => rowFor("추천적용", row)),
    ...profile.compared.map((row) => rowFor("전후비교", row))
  ];
  return `\uFEFF${headers.map(salesTargetCsvValue).join(",")}\n${rows.map((row) => row.map(salesTargetCsvValue).join(",")).join("\n")}`;
}

function adminReviewContextCells(context = {}) {
  const comparison = context.comparison || {};
  const recrawl = context.recrawlPlan || {};
  const revenue = context.revenue || {};
  const comparisonDetail = Array.isArray(comparison.cells)
    ? comparison.cells.map((cell) => {
        const label = cell.label || cell.key || "비교";
        const values = [cell.before, cell.after].filter(Boolean).join(" -> ");
        return [label, values, cell.note].filter(Boolean).join(" ");
      }).filter(Boolean).slice(0, 4).join(" | ")
    : "";
  return {
    summary: companyReviewContextText(context),
    recommendation: [context.recommendationLabel, ...(context.recommendationReasons || [])].filter(Boolean).join(" | "),
    problemDateText: context.problemDateText || "",
    quantityConfidence: context.quantityConfidence || "",
    gapType: context.gapType || "",
    channelText: context.channelText || "",
    recrawlText: [
      recrawl.keyword,
      recrawl.range ? `상세 ${recrawl.range}위` : "",
      recrawl.checkIn || recrawl.checkOut ? `${recrawl.checkIn || ""}~${recrawl.checkOut || ""}` : recrawl.dateText
    ].filter(Boolean).join(" | "),
    improved: comparison.hasComparison ? finiteNumber(comparison.improved, 0) : "",
    worsened: comparison.hasComparison ? finiteNumber(comparison.worsened, 0) : "",
    comparisonDetail,
    revenue: effectiveRevenueValue(revenue) || "",
    pricedSoldOut: finiteNumber(revenue.totalPricedSoldOut, 0) || "",
    missingPriceSoldOut: finiteNumber(revenue.totalMissingPriceSoldOut, 0) || "",
    precision: [revenue.precisionGrade, revenue.precisionLabel].filter(Boolean).join(" · ")
  };
}

function adminReviewAuditRows(master = companyMasterSource()) {
  return (master.companies || []).flatMap((company) => {
    const histories = Array.isArray(company.adminReviewHistory) ? company.adminReviewHistory : [];
    const rows = histories.map((history) => ({ kind: "이력", review: history }));
    if (!rows.length && company.adminReview) rows.push({ kind: "현재", review: company.adminReview });
    return rows.map(({ kind, review }) => {
      const context = adminReviewContextCells(review.context || {});
      return [
        kind,
        company.companyId || "",
        company.primaryName || "",
        (company.regions || []).slice(0, 3).join(" / "),
        company.bestRank ? `${fmtNumber(company.bestRank)}위` : "",
        company.adminReview?.label || companyAdminReviewLabel(company.adminReview?.status),
        review.action === "clear" ? "해제" : (review.label || companyAdminReviewLabel(review.status)),
        review.status || "",
        review.at || review.updatedAt || "",
        review.note || "",
        review.context?.source || "",
        context.summary,
        context.recommendation,
        context.problemDateText,
        context.quantityConfidence,
        context.gapType,
        context.channelText,
        context.recrawlText,
        context.improved,
        context.worsened,
        context.comparisonDetail,
        context.revenue,
        context.pricedSoldOut,
        context.missingPriceSoldOut,
        context.precision
      ];
    });
  }).sort((a, b) => String(b[8] || "").localeCompare(String(a[8] || "")));
}

function adminReviewAuditCsv(master = companyMasterSource()) {
  const headers = [
    "구분", "업체ID", "업체명", "지역", "최고순위", "현재상태", "저장상태", "상태코드", "처리시각", "관리메모", "근거출처",
    "근거요약", "자동추천", "문제날짜", "수량신뢰도", "공백유형", "확인채널", "재수집설정",
    "비교개선", "비교악화", "비교상세", "예상매출", "가격확보수량", "가격누락수량", "매출정밀도"
  ];
  const rows = adminReviewAuditRows(master);
  return `\uFEFF${headers.map(salesTargetCsvValue).join(",")}\n${rows.map((row) => row.map(salesTargetCsvValue).join(",")).join("\n")}`;
}

function reportPlatformStats(items = []) {
  const platformNames = ["네이버", "야놀자", "여기어때", "떠나요"];
  const stats = Object.fromEntries(platformNames.map((name) => [name, 0]));
  const otaStats = Object.fromEntries(platformNames.map((name) => [name, 0]));
  let otaCheckCount = 0;
  for (const item of items) {
    const names = platformsForItem(item).map((row) => platformShortName(row.platform));
    const audit = inventoryAuditProfile(item);
    platformNames.forEach((name) => {
      if (names.includes(name)) stats[name] += 1;
    });
    if (audit.otaCheckNeeded) {
      otaCheckCount += 1;
      platformNames.forEach((name) => {
        if (names.includes(name)) otaStats[name] += 1;
      });
    }
  }
  return {
    names: platformNames,
    counts: stats,
    otaCheckCount,
    otaCounts: otaStats,
    missingYeogi: Math.max(0, otaCheckCount - otaStats["여기어때"]),
    missingYanolja: Math.max(0, otaCheckCount - otaStats["야놀자"]),
    missingDdnayo: Math.max(0, otaCheckCount - otaStats["떠나요"])
  };
}

function reportMarketScore({ rate, targetCount, itemCount, platformGapRatio, searchVolume }) {
  const targetSignal = itemCount ? Math.min(30, (targetCount / itemCount) * 40) : 0;
  const gapSignal = Math.min(22, platformGapRatio * 26);
  const saleSignal = Number.isFinite(rate)
    ? (rate <= B2B_LOW_RESERVATION_RATE ? 18 : rate < B2B_HIGH_RESERVATION_RATE ? 12 : 5)
    : 8;
  const demandSignal = searchVolume >= 30000 ? 16 : searchVolume >= 10000 ? 10 : searchVolume > 0 ? 6 : 4;
  return Math.max(35, Math.min(94, Math.round(30 + targetSignal + gapSignal + saleSignal + demandSignal)));
}

function reportDecision(score, rate, targetCount) {
  if (score >= 75 && targetCount >= 5) {
    return {
      label: "집중 공략",
      tone: "strong",
      summary: "노출은 확인되지만 판매 흐름과 상품 구성 개선 여지가 큽니다."
    };
  }
  if (score >= 62) {
    return {
      label: "선별 공략",
      tone: "watch",
      summary: "상위 업체 중 판매 흐름이 비는 곳부터 선별 접촉이 적합합니다."
    };
  }
  if (Number.isFinite(rate) && rate >= 0.6) {
    return {
      label: "수요 강세",
      tone: "hot",
      summary: "판매율이 높아 신규 영업보다 기존 고객 운영 효율과 가격 점검이 우선입니다."
    };
  }
  return {
    label: "관찰",
    tone: "neutral",
    summary: "즉시 공략보다는 추가 수집과 네이버 기준값 검증이 필요합니다."
  };
}

function b2bMarketDecision(score, rate, opportunityCount) {
  if (score >= 78 && opportunityCount >= 3) {
    return {
      label: "경쟁 기회",
      tone: "strong",
      summary: "검색 수요와 경쟁업체 예약율 표본이 함께 보여 매출, 가격, 상품 구성을 비교하기 좋은 지역입니다."
    };
  }
  if (score >= 64) {
    return {
      label: "경쟁 비교",
      tone: "watch",
      summary: "상위 노출 경쟁업체의 예약율, 매출 표본, 채널 표본을 중심으로 시장 위치를 비교합니다."
    };
  }
  if (Number.isFinite(rate) && rate >= 0.6) {
    return {
      label: "수요 강세",
      tone: "hot",
      summary: "경쟁업체 판매율이 높아 가격대, 주말 재고, 채널 노출 흐름을 우선 비교합니다."
    };
  }
  return {
    label: "표본 관찰",
    tone: "neutral",
    summary: "현재 표본만으로 단정하기보다 경쟁업체 표본과 기간별 수요 변화를 함께 보는 것이 적합합니다."
  };
}

function b2bMarketBriefModel(data = state.data || {}) {
  const run = data.run || {};
  const items = data.availability?.items || [];
  const stats = data.availability?.stats || {};
  const sales = summarizeSales(items);
  const revenue = summarizeRevenue(items);
  const rate = sales.supply ? sales.sold / sales.supply : finiteNumber(stats.weightedSoldOutRate, NaN);
  const sold = finiteNumber(sales.sold, 0);
  const supply = finiteNumber(sales.supply, 0);
  const remainingSupply = Math.max(0, supply - sold);
  const averageRevenue = finiteNumber(stats.averageAdjustedEstimatedRevenue, 0) || finiteNumber(revenue.adjustedRevenue, 0);
  const revenueSampleCount = finiteNumber(stats.revenueSampleCount, 0);
  const revenueCoverage = Number(stats.revenueCoverageRate);
  const revenueNote = revenueSampleCount
    ? `표본 ${fmtNumber(revenueSampleCount)}개${Number.isFinite(revenueCoverage) ? ` · 커버 ${fmtRate(revenueCoverage)}` : ""}`
    : "표본 대기";
  const searchVolume = (data.regions || []).reduce((sum, region) => sum + finiteNumber(region.traffic?.totalSearchVolume, 0), 0);
  const platformStats = reportPlatformStats(items);
  const platformGapRatio = platformStats.otaCheckCount
    ? (platformStats.missingYeogi + platformStats.missingYanolja + platformStats.missingDdnayo) / (platformStats.otaCheckCount * 3)
    : 0;
  const dayUseCount = items.filter((item) => salesStats(item, "day").supply > 0).length;
  const opportunityRows = items
    .map((item, index) => ({ item, index, lodging: salesStats(item, "lodging") }))
    .filter((row) => Number.isFinite(row.lodging.rate))
    .sort((a, b) => a.lodging.rate - b.lodging.rate)
    .slice(0, 5);
  const salesSampleCount = items.filter((item) => Number.isFinite(salesStats(item, "lodging").rate)).length;
  const lowSalesCount = opportunityRows.filter((row) => row.lodging.rate <= B2B_LOW_RESERVATION_RATE).length;
  const score = reportMarketScore({
    rate,
    targetCount: lowSalesCount || opportunityRows.length,
    itemCount: items.length,
    platformGapRatio,
    searchVolume
  });
  const decision = b2bMarketDecision(score, rate, lowSalesCount || opportunityRows.length);
  const regions = (data.regions || []).slice(0, 4);
  const topRegion = regions[0] || {};
  return {
    run,
    keyword: activeKeyword(),
    range: dateRangeLabel(run),
    itemCount: items.length,
    sold,
    supply,
    remainingSupply,
    salesSampleCount,
    rate,
    averageRevenue,
    revenueSampleCount,
    revenueCoverage,
    revenueNote,
    searchVolume,
    platformStats,
    platformGapRatio,
    dayUseCount,
    dayUseGapCount: Math.max(0, items.length - dayUseCount),
    opportunityRows,
    lowSalesCount,
    score,
    decision,
    regions,
    topRegion
  };
}

function b2bCompetitiveSnapshotModel(brief = b2bMarketBriefModel()) {
  const rankModel = b2bRankBoardModel();
  const topRows = rankModel.rows.slice(0, 6).map((row) => {
    const insight = row.insight || companyRankInsight(row.item, row.index + 1);
    const revenue = finiteNumber(insight.revenue, 0);
    const itemIndex = row.linked ? finiteNumber(row.item.availabilityIndex, -1) : -1;
    const rank = finiteNumber(row.rank, row.index + 1);
    const productText = insight.dayUseKnown ? "숙박+데이" : "숙박 중심";
    const rateText = Number.isFinite(row.rate) ? fmtRate(row.rate) : "판매율 대기";
    const remainingText = row.linked ? `${fmtNumber(row.remaining)}실` : "상세 대기";
    const revenueText = revenue ? fmtWon(revenue) : "매출 표본 대기";
    const meta = row.linked
      ? `${rateText} · 잔여 ${remainingText} · ${productText}`
      : `${row.item.rankingSourceLabel || "네이버 노출"} · 예약 표본 대기`;
    return {
      itemIndex,
      rank,
      rankText: `${fmtNumber(rank)}위`,
      name: row.item.name || "업체명 확인",
      tone: insight.tone || "neutral",
      revenue,
      revenueText,
      rateText,
      remainingText,
      productText,
      meta
    };
  });
  const exposureRows = rankModel.rows.filter((row) => row.rank > 0 && row.rank <= 5);
  const topExposureRows = exposureRows.length ? exposureRows : rankModel.rows.slice(0, 5);
  const revenueRows = topRows.filter((row) => row.revenue > 0);
  const topRevenueTotal = revenueRows.reduce((sum, row) => sum + row.revenue, 0);
  const revenueValues = revenueRows.map((row) => row.revenue).filter((value) => value > 0);
  const revenueAverage = revenueValues.length ? revenueValues.reduce((sum, value) => sum + value, 0) / revenueValues.length : 0;
  const revenueMax = revenueValues.length ? Math.max(...revenueValues) : 0;
  const revenueMin = revenueValues.length ? Math.min(...revenueValues) : 0;
  const revenueLeader = topRows.slice().sort((a, b) => b.revenue - a.revenue)[0] || null;
  const remainingRooms = rankModel.gapRows.reduce((sum, row) => sum + finiteNumber(row.remaining, 0), 0);
  const trend = demandTrendSource();
  const trendStats = demandTrendStats(trend);
  const traffic = demandTrafficAggregate();
  const nextDemand = demandNextMonthProjection(traffic, trend, trendStats);
  const trendLabel = demandTrendLabel();
  let trendTone = "neutral";
  if (trend.reason) {
    trendTone = "watch";
  } else if (trend.hasSeries) {
    if (Number.isFinite(trendStats.recentChange) && trendStats.recentChange >= 0.12) trendTone = "strong";
    else if (Number.isFinite(trendStats.recentChange) && trendStats.recentChange <= -0.12) trendTone = "watch";
    else trendTone = "good";
  }
  const peakLabel = trendStats.peak ? `${trendStats.peak.label} 피크` : "피크 대기";
  const recentLabel = Number.isFinite(trendStats.recentChange)
    ? `최근 3개월 ${formatSignedRate(trendStats.recentChange)}`
    : "최근 추이 대기";
  const trendNote = trend.reason
    ? trend.reason
    : trend.hasSeries
      ? `${peakLabel} · ${recentLabel}`
      : "데이터랩 연동 대기";
  const cards = [
    {
      tone: revenueRows.length ? "strong" : "watch",
      label: "매출 표본 범위",
      value: revenueRows.length ? `평균 ${fmtWon(revenueAverage)}` : "표본 대기",
      note: revenueRows.length ? `최고 ${fmtWon(revenueMax)} · 최저 ${fmtWon(revenueMin)}` : "가격·수량 표본 필요"
    },
    {
      tone: "neutral",
      label: "노출 1~5위",
      value: fmtNumber(topExposureRows.length),
      note: topRows[0] ? `${topRows[0].name} ${topRows[0].rankText}` : "순위 표본 대기"
    },
    {
      tone: rankModel.hotRows.length ? "hot" : "neutral",
      label: B2B_HIGH_RESERVATION_LABEL,
      value: fmtNumber(rankModel.hotRows.length),
      note: "예약 수량 표본 기준"
    },
    {
      tone: nextDemand.tone || trendTone,
      label: nextDemand.label || "다음달 예상 검색량",
      value: nextDemand.value,
      note: nextDemand.note
    }
  ];
  const insights = [
    {
      label: "매출 표본",
      value: revenueRows.length
        ? `${fmtNumber(revenueRows.length)}개 업체에서 예상 매출을 확인했습니다.`
        : "상위 업체의 가격·수량 표본이 확보되면 경쟁 매출을 계산합니다."
    },
    {
      label: "노출 해석",
      value: topRows[0]
        ? `${topRows[0].rankText} ${topRows[0].name} 기준으로 상위 노출 경쟁권을 비교합니다.`
        : "네이버 노출 표본을 먼저 확인해야 합니다."
    },
    {
      label: "예약율 해석",
      value: rankModel.gapRows.length
        ? `${B2B_LOW_RESERVATION_LABEL} 업체 ${fmtNumber(rankModel.gapRows.length)}곳은 가격과 상품 구성을 함께 확인합니다.`
        : `${B2B_LOW_RESERVATION_LABEL} 업체가 적어 판매 흐름이 안정적입니다.`
    },
    {
      label: "검색량 보정",
      value: nextDemand.detailText || trendNote
    }
  ];
  return {
    rankModel,
    rows: topRows,
    cards,
    insights,
    revenueRows,
    revenueLeader,
    topRevenueTotal,
    revenueAverage,
    revenueMax,
    revenueMin,
    remainingRooms,
    trendLabel,
    trendNote,
    nextDemand,
    range: brief.range
  };
}

function b2bRevenueBenchmarkModel(brief = b2bMarketBriefModel(), data = state.data || {}) {
  const items = data.availability?.items || [];
  const rows = items.map((item, index) => {
    const profile = preciseRevenueProfile(item);
    const revenue = finiteNumber(profile.totalAdjustedRevenue, 0) || finiteNumber(profile.totalRevenue, 0);
    const baseRevenue = finiteNumber(profile.totalRevenue, 0);
    const gapRevenue = finiteNumber(profile.totalMissingPriceEstimatedRevenue, 0);
    const precision = profile.precision || {};
    const lodging = profile.lodging || {};
    const dayUse = profile.dayUse || {};
    const flow = salesFlowProfile(item);
    const rank = finiteNumber(item.rank || item.overallRank || index + 1, index + 1);
    const itemIndex = finiteNumber(item.availabilityIndex, index);
    const avgPrice = finiteNumber(lodging.avgSoldUnitPrice, 0) || finiteNumber(dayUse.avgSoldUnitPrice, 0);
    const priced = finiteNumber(precision.priced, 0);
    const missing = finiteNumber(precision.missing, 0);
    const soldQuantity = finiteNumber(precision.soldQuantity, priced + missing);
    return {
      item,
      index,
      itemIndex,
      rank,
      name: item.name || "업체명 확인",
      revenue,
      baseRevenue,
      gapRevenue,
      avgPrice,
      precision,
      grade: precision.grade || "",
      tone: precision.tone || "neutral",
      priced,
      missing,
      soldQuantity,
      flow,
      lodging,
      dayUse
    };
  });
  const revenueRows = rows.filter((row) => row.revenue > 0);
  const precisionRows = rows.filter((row) => row.soldQuantity > 0 || row.revenue > 0);
  const revenueTotal = revenueRows.reduce((sum, row) => sum + row.revenue, 0);
  const baseTotal = revenueRows.reduce((sum, row) => sum + row.baseRevenue, 0);
  const gapRevenueTotal = revenueRows.reduce((sum, row) => sum + row.gapRevenue, 0);
  const averageRevenue = revenueRows.length ? revenueTotal / revenueRows.length : finiteNumber(brief.averageRevenue, 0);
  const revenueMax = revenueRows.length ? Math.max(...revenueRows.map((row) => row.revenue)) : 0;
  const revenueMin = revenueRows.length ? Math.min(...revenueRows.map((row) => row.revenue)) : 0;
  const pricedTotal = precisionRows.reduce((sum, row) => sum + row.priced, 0);
  const missingTotal = precisionRows.reduce((sum, row) => sum + row.missing, 0);
  const soldQuantity = pricedTotal + missingTotal;
  const priceCoverage = soldQuantity ? pricedTotal / soldQuantity : NaN;
  const highPrecisionRows = precisionRows.filter((row) => ["A", "B"].includes(String(row.grade).toUpperCase()));
  const precisionScore = precisionRows.length
    ? Math.round(precisionRows.reduce((sum, row) => sum + finiteNumber(row.precision.score, 0), 0) / precisionRows.length)
    : 0;
  const topRows = revenueRows
    .slice()
    .sort((a, b) => b.revenue - a.revenue || a.rank - b.rank)
    .slice(0, 4);
  const benchmarkRows = topRows.length ? topRows : rows.slice(0, 4);
  const flow = aggregateFlowProfiles(items);
  const weekend = combineFlowMetrics([flow.friday, flow.saturday, flow.sunday]);
  const weekdayGap = Number.isFinite(weekend.rate) && Number.isFinite(flow.weekday.rate)
    ? weekend.rate - flow.weekday.rate
    : NaN;
  const decision = revenueRows.length >= Math.max(2, Math.ceil(items.length * 0.2))
    ? { tone: "strong", label: "매출 비교 가능", summary: "가격과 판매 수량이 연결된 표본으로 경쟁업체 매출 수준을 비교할 수 있습니다." }
    : precisionRows.length
      ? { tone: "watch", label: "표본 보완 필요", summary: "일부 업체는 가격 또는 수량 표본이 부족하므로 매출은 보조 지표로 해석합니다." }
      : { tone: "neutral", label: "매출 표본 대기", summary: "매출 산출에 필요한 가격과 판매 수량 표본이 더 필요합니다." };
  const cards = [
    {
      label: "예상 평균 매출",
      value: averageRevenue ? fmtWon(averageRevenue) : "대기",
      note: revenueRows.length ? `${fmtNumber(revenueRows.length)}개 표본 평균` : "가격·수량 표본 필요",
      tone: revenueRows.length ? "strong" : "watch"
    },
    {
      label: "최고 매출",
      value: revenueMax ? fmtWon(revenueMax) : "대기",
      note: topRows[0] ? `${topRows[0].name} · ${fmtNumber(topRows[0].rank)}위` : "상위 표본 대기",
      tone: revenueMax ? "hot" : "neutral"
    },
    {
      label: "최저 매출",
      value: revenueMin ? fmtWon(revenueMin) : "대기",
      note: revenueRows.length ? `${fmtNumber(revenueRows.length)}개 표본 중 최소` : "표본 대기",
      tone: revenueMin ? "neutral" : "watch"
    },
    {
      label: "매출 표본",
      value: `${fmtNumber(revenueRows.length)}/${fmtNumber(items.length)}`,
      note: "경쟁업체 중 매출 산출 가능",
      tone: revenueRows.length >= Math.max(2, Math.ceil(items.length * 0.2)) ? "good" : "watch"
    },
    {
      label: "가격 확인률",
      value: Number.isFinite(priceCoverage) ? fmtRate(priceCoverage) : "대기",
      note: `${fmtNumber(pricedTotal)}건 확인 · 누락 ${fmtNumber(missingTotal)}건`,
      tone: Number.isFinite(priceCoverage) && priceCoverage >= 0.7 ? "good" : "watch"
    },
    {
      label: "보정 매출",
      value: gapRevenueTotal ? fmtWon(gapRevenueTotal) : "없음",
      note: gapRevenueTotal ? `확인매출 ${fmtWon(baseTotal)}` : "가격누락 보정 없음",
      tone: gapRevenueTotal ? "watch" : "good"
    },
    {
      label: "주말 판매압력",
      value: Number.isFinite(weekend.rate) ? fmtRate(weekend.rate) : "대기",
      note: Number.isFinite(weekdayGap) ? `평일 대비 ${formatSignedRate(weekdayGap)}` : "요일 표본 필요",
      tone: Number.isFinite(weekend.rate) && weekend.rate >= 0.65 ? "hot" : "neutral"
    }
  ];
  const guideRows = [
    {
      tone: "strong",
      label: "정밀도",
      value: precisionScore ? `${fmtNumber(precisionScore)}점` : "대기",
      note: highPrecisionRows.length ? `A/B 등급 ${fmtNumber(highPrecisionRows.length)}개` : "가격·요일 표본 확보 필요"
    },
    {
      tone: "watch",
      label: "가격 누락",
      value: fmtNumber(missingTotal),
      note: missingTotal ? "누락 가격은 평균가 기반 보정으로 표시" : "누락 보정 영향 낮음"
    },
    {
      tone: "good",
      label: "요일 해석",
      value: Number.isFinite(flow.weekday.rate) ? fmtRate(flow.weekday.rate) : "대기",
      note: "평일·금요일·토요일·일요일 판매 흐름을 함께 반영"
    }
  ];
  return {
    rows,
    revenueRows,
    precisionRows,
    topRows,
    benchmarkRows,
    revenueTotal,
    averageRevenue,
    revenueMax,
    revenueMin,
    priceCoverage,
    pricedTotal,
    missingTotal,
    gapRevenueTotal,
    precisionScore,
    highPrecisionRows,
    flow,
    weekend,
    weekdayGap,
    decision,
    cards,
    guideRows
  };
}

function b2bMyLodgeAccountToken() {
  return compactSearchText(state.session?.memberId || state.session?.username || "guest") || "guest";
}

function b2bMyLodgeStorageKey() {
  return `${B2B_MY_LODGE_STORAGE_PREFIX}:${b2bMyLodgeAccountToken()}:account`;
}

function b2bMyLodgeStoredObject(key = "") {
  if (typeof localStorage === "undefined" || !key) return {};
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function b2bMyLodgeLegacyStorageKeys() {
  if (typeof localStorage === "undefined") return [];
  const account = b2bMyLodgeAccountToken();
  const currentKey = b2bMyLodgeStorageKey();
  const prefix = `${B2B_MY_LODGE_STORAGE_PREFIX}:${account}:`;
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key) => key && key.startsWith(prefix) && key !== currentKey)
      .sort();
  } catch {
    return [];
  }
}

function b2bMyLodgeMergeStoredValues(primary = {}, legacyValues = []) {
  const stores = [primary, ...legacyValues].map((value) => b2bMyLodgeStoreFromValue(value));
  const primaryStore = stores[0] || { draft: {}, interestLodges: [] };
  const draft = b2bMyLodgeDraftHasInput(primaryStore.draft)
    ? primaryStore.draft
    : (stores.find((store) => b2bMyLodgeDraftHasInput(store.draft))?.draft || {});
  const seen = new Set();
  const interestLodges = [];
  stores.forEach((store) => {
    (store.interestLodges || []).forEach((lodge) => {
      const normalized = b2bNormalizeInterestLodge(lodge);
      if (!b2bMyLodgeDraftHasInput(normalized)) return;
      const key = compactSearchText(normalized.lodgingName) || normalized.id || b2bStableInterestLodgeId(normalized);
      if (seen.has(key)) return;
      seen.add(key);
      interestLodges.push(normalized);
    });
  });
  return {
    version: 2,
    draft,
    interestLodges: interestLodges.slice(0, B2B_INTEREST_LODGE_LIMIT)
  };
}

function readB2BMyLodgeStoredValue() {
  const key = b2bMyLodgeStorageKey();
  const memoryDraft = state.b2bMyLodgeDraft?.key === key ? state.b2bMyLodgeDraft.values : null;
  if (typeof localStorage === "undefined") return memoryDraft || {};
  try {
    const primary = b2bMyLodgeStoredObject(key);
    const legacyValues = b2bMyLodgeLegacyStorageKeys()
      .map((legacyKey) => b2bMyLodgeStoredObject(legacyKey))
      .filter((value) => value && Object.keys(value).length);
    if (!legacyValues.length) return Object.keys(primary).length ? primary : (memoryDraft || {});
    const merged = b2bMyLodgeMergeStoredValues(Object.keys(primary).length ? primary : (memoryDraft || {}), legacyValues);
    localStorage.setItem(key, JSON.stringify(merged));
    return merged;
  } catch {
    return memoryDraft || {};
  }
}

function readB2BMyLodgeStore() {
  return b2bMyLodgeStoreFromValue(readB2BMyLodgeStoredValue());
}

function readB2BMyLodgeDraft() {
  return readB2BMyLodgeStore().draft || {};
}

function readB2BInterestLodges() {
  return readB2BMyLodgeStore().interestLodges || [];
}

function b2bMyLodgeNumber(value) {
  const number = optionalNumber(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function b2bMyLodgeInputNumberText(value) {
  const number = b2bMyLodgeNumber(value);
  return number > 0 ? fmtNumber(Math.round(number)) : "";
}

function formatB2BWonInput(input) {
  if (!input) return;
  const digits = String(input.value || "").replace(/[^\d]/g, "");
  input.value = digits ? Number(digits).toLocaleString("ko-KR") : "";
}

const B2B_MY_LODGE_SEGMENT_LIMIT = 8;
const B2B_INTEREST_LODGE_LIMIT = 2;
const B2B_MY_LODGE_PRICE_KEYS = ["weekdayPrice", "fridayPrice", "saturdayPrice", "sundayPrice"];

function b2bMyLodgeBlankSegment() {
  return {
    type: "",
    count: "",
    weekdayPrice: "",
    fridayPrice: "",
    saturdayPrice: "",
    sundayPrice: ""
  };
}

function b2bMyLodgeCleanSegment(row = {}) {
  return {
    type: String(row.type || row.roomType || "").trim().slice(0, 80),
    count: Math.round(b2bMyLodgeNumber(row.count ?? row.roomCount)),
    weekdayPrice: b2bMyLodgeNumber(row.weekdayPrice),
    fridayPrice: b2bMyLodgeNumber(row.fridayPrice),
    saturdayPrice: b2bMyLodgeNumber(row.saturdayPrice),
    sundayPrice: b2bMyLodgeNumber(row.sundayPrice)
  };
}

function b2bMyLodgeSegmentHasInput(row = {}) {
  return Boolean(
    String(row.type || "").trim() ||
    b2bMyLodgeNumber(row.count) > 0 ||
    B2B_MY_LODGE_PRICE_KEYS.some((key) => b2bMyLodgeNumber(row[key]) > 0)
  );
}

function b2bMyLodgeSegmentRows(draft = {}) {
  return (Array.isArray(draft.roomSegments) ? draft.roomSegments : [])
    .map((row) => b2bMyLodgeCleanSegment(row))
    .filter((row) => b2bMyLodgeSegmentHasInput(row))
    .slice(0, B2B_MY_LODGE_SEGMENT_LIMIT);
}

function b2bMyLodgeLegacySegment(draft = {}) {
  const row = b2bMyLodgeCleanSegment({
    type: draft.roomType,
    count: draft.roomCount,
    weekdayPrice: draft.weekdayPrice,
    fridayPrice: draft.fridayPrice,
    saturdayPrice: draft.saturdayPrice,
    sundayPrice: draft.sundayPrice
  });
  return b2bMyLodgeSegmentHasInput(row) ? row : null;
}

function b2bMyLodgeSegmentInputRows(draft = {}) {
  if (Array.isArray(draft.roomSegments) && draft.roomSegments.length) {
    return draft.roomSegments
      .map((row) => b2bMyLodgeCleanSegment(row))
      .slice(0, B2B_MY_LODGE_SEGMENT_LIMIT);
  }
  const legacy = b2bMyLodgeLegacySegment(draft);
  return legacy ? [legacy] : [];
}

function b2bMyLodgeDraftHasInput(draft = {}) {
  if (!draft || typeof draft !== "object") return false;
  const roomSegments = b2bMyLodgeSegmentInputRows(draft).filter((row) => b2bMyLodgeSegmentHasInput(row));
  return Boolean(
    String(draft.lodgingName || "").trim() ||
    b2bMyLodgeNumber(draft.roomCount) > 0 ||
    String(draft.roomType || "").trim() ||
    b2bMyLodgeNumber(draft.dayUseCount) > 0 ||
    b2bMyLodgeAveragePrice(draft) > 0 ||
    roomSegments.length > 0 ||
    String(draft.facilities || "").trim()
  );
}

function b2bStableInterestLodgeId(lodge = {}) {
  const existing = String(lodge.id || "").trim();
  if (existing) return existing;
  const basis = compactSearchText([
    lodge.lodgingName,
    lodge.savedAt,
    lodge.collectedAt,
    lodge.roomCount,
    lodge.roomType
  ].filter(Boolean).join("-"));
  return `interest-${(basis || "lodge").slice(0, 72)}`;
}

function b2bNewInterestLodgeId() {
  return `interest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function b2bNormalizeInterestLodge(lodge = {}) {
  const roomSegments = b2bMyLodgeSegmentInputRows(lodge)
    .filter((row) => b2bMyLodgeSegmentHasInput(row))
    .slice(0, B2B_MY_LODGE_SEGMENT_LIMIT);
  const segmentTotal = roomSegments.reduce((sum, row) => sum + Math.round(b2bMyLodgeNumber(row.count)), 0);
  const firstSegment = roomSegments[0] || {};
  const roomType = roomSegments.map((row) => row.type).filter(Boolean).slice(0, 4).join(", ");
  return {
    id: b2bStableInterestLodgeId(lodge),
    lodgingName: String(lodge.lodgingName || "").trim().slice(0, 80),
    roomCount: String(lodge.roomCount || (segmentTotal > 0 ? segmentTotal : "")).trim(),
    roomType: String(lodge.roomType || roomType || "").trim().slice(0, 80),
    dayUseCount: String(lodge.dayUseCount || "").trim(),
    weekdayPrice: String(lodge.weekdayPrice || firstSegment.weekdayPrice || "").trim(),
    fridayPrice: String(lodge.fridayPrice || firstSegment.fridayPrice || "").trim(),
    saturdayPrice: String(lodge.saturdayPrice || firstSegment.saturdayPrice || "").trim(),
    sundayPrice: String(lodge.sundayPrice || firstSegment.sundayPrice || "").trim(),
    roomSegments,
    facilities: String(lodge.facilities || "").trim().slice(0, 160),
    naverConnected: Boolean(lodge.naverConnected),
    otaConnected: Boolean(lodge.otaConnected),
    savedAt: lodge.savedAt || new Date().toISOString(),
    collectedAt: lodge.collectedAt || "",
    collectionRunId: lodge.collectionRunId || "",
    collectionSource: lodge.collectionSource || "",
    collectionStatus: lodge.collectionStatus || ""
  };
}

function b2bMyLodgeStoreFromValue(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const hasStructuredShape = Array.isArray(source.interestLodges) || Object.prototype.hasOwnProperty.call(source, "draft");
  if (hasStructuredShape) {
    return {
      version: 2,
      draft: source.draft && typeof source.draft === "object" ? source.draft : {},
      interestLodges: (Array.isArray(source.interestLodges) ? source.interestLodges : [])
        .map((lodge) => b2bNormalizeInterestLodge(lodge))
        .filter((lodge) => b2bMyLodgeDraftHasInput(lodge))
        .slice(0, B2B_INTEREST_LODGE_LIMIT)
    };
  }
  if (b2bMyLodgeDraftHasInput(source)) {
    return {
      version: 2,
      draft: {},
      interestLodges: [b2bNormalizeInterestLodge(source)].slice(0, B2B_INTEREST_LODGE_LIMIT)
    };
  }
  return { version: 2, draft: source, interestLodges: [] };
}

function b2bMyLodgeSegmentAverage(row = {}) {
  const weekday = b2bMyLodgeNumber(row.weekdayPrice);
  const friday = b2bMyLodgeNumber(row.fridayPrice);
  const saturday = b2bMyLodgeNumber(row.saturdayPrice);
  const sunday = b2bMyLodgeNumber(row.sundayPrice);
  const weighted = weekday * 4 + friday + saturday + sunday;
  if (weighted > 0) return weighted / 7;
  const values = [weekday, friday, saturday, sunday].filter((value) => value > 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function b2bMyLodgeAveragePriceFromSegments(rows = []) {
  let weightedTotal = 0;
  let weightedCount = 0;
  const unweighted = [];
  rows.forEach((row) => {
    const average = b2bMyLodgeSegmentAverage(row);
    if (!average) return;
    const count = Math.round(b2bMyLodgeNumber(row.count));
    if (count > 0) {
      weightedTotal += average * count;
      weightedCount += count;
    } else {
      unweighted.push(average);
    }
  });
  if (weightedCount > 0) return weightedTotal / weightedCount;
  return unweighted.length ? unweighted.reduce((sum, value) => sum + value, 0) / unweighted.length : 0;
}

function b2bMyLodgeSegmentPrice(row = {}, key = "weekdayPrice") {
  const direct = b2bMyLodgeNumber(row[key]);
  if (direct > 0) return direct;
  const weekday = b2bMyLodgeNumber(row.weekdayPrice);
  return weekday > 0 ? weekday : b2bMyLodgeSegmentAverage(row);
}

function b2bMyLodgeSegmentRevenue(rows = [], rates = {}, dayCounts = {}) {
  return rows.reduce((sum, row) => {
    const count = Math.round(b2bMyLodgeNumber(row.count));
    if (count <= 0) return sum;
    return sum +
      count * b2bMyLodgeSegmentPrice(row, "weekdayPrice") * b2bMyLodgeNumber(rates.weekday) * b2bMyLodgeNumber(dayCounts.weekday) +
      count * b2bMyLodgeSegmentPrice(row, "fridayPrice") * b2bMyLodgeNumber(rates.friday) * b2bMyLodgeNumber(dayCounts.friday) +
      count * b2bMyLodgeSegmentPrice(row, "saturdayPrice") * b2bMyLodgeNumber(rates.saturday) * b2bMyLodgeNumber(dayCounts.saturday) +
      count * b2bMyLodgeSegmentPrice(row, "sundayPrice") * b2bMyLodgeNumber(rates.sunday) * b2bMyLodgeNumber(dayCounts.sunday);
  }, 0);
}

function b2bMyLodgeAveragePrice(draft = {}) {
  const weekday = b2bMyLodgeNumber(draft.weekdayPrice);
  const friday = b2bMyLodgeNumber(draft.fridayPrice);
  const saturday = b2bMyLodgeNumber(draft.saturdayPrice);
  const sunday = b2bMyLodgeNumber(draft.sundayPrice);
  const weighted = weekday * 4 + friday + saturday + sunday;
  return weighted > 0 ? weighted / 7 : 0;
}

function b2bMyLodgeFacilities(value = "") {
  return String(value || "")
    .split(/[,/|\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function b2bWonNumber(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const text = String(value || "").replace(/,/g, "").replace(/\s+/g, "");
  if (!text) return 0;
  let total = 0;
  const eok = text.match(/([\d.]+)억/u);
  const man = text.match(/([\d.]+)만/u);
  const won = text.match(/([\d.]+)원/u);
  if (eok) total += Number(eok[1]) * 100000000;
  if (man) total += Number(man[1]) * 10000;
  if (!eok && !man && won) total += Number(won[1]);
  if (Number.isFinite(total) && total > 0) return Math.round(total);
  const numeric = Number(text.replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundB2BLodgePrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return String(Math.round(number / 1000) * 1000);
}

function b2bCollectedRoomCount(item = {}) {
  const days = Math.max(1, bookingDays(state.data?.run || {}) || DEFAULT_BOOKING_DAYS);
  const candidates = [
    item.weeklyOperatingTotal,
    item.weeklyBasisTotal,
    item.weeklyMaxTotal,
    item.nightTotalStock,
    item.totalRooms,
    item.rawTotalStock,
    Number(item.weeklyTotalStock) > 0 ? Number(item.weeklyTotalStock) / days : 0
  ].map((value) => finiteNumber(value, 0)).filter((value) => value > 0);
  return candidates.length ? String(Math.round(Math.max(...candidates))) : "";
}

function b2bCollectedRoomType(item = {}) {
  const productNames = (Array.isArray(item.itemDetails) ? item.itemDetails : [])
    .map((row) => String(row.name || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return [
    item.productTypeSummary,
    item.category,
    item.businessCategory,
    ...productNames
  ].filter(Boolean).join(", ").slice(0, 80);
}

function b2bCollectedDayUseCount(item = {}) {
  const days = Math.max(1, bookingDays(state.data?.run || {}) || DEFAULT_BOOKING_DAYS);
  const candidates = [
    item.dayUseWeeklyOperatingTotal,
    item.dayUseWeeklyBasisTotal,
    item.dayUseTotalStock,
    item.dayUseItemCount,
    Number(item.dayUseWeeklyTotalStock) > 0 ? Number(item.dayUseWeeklyTotalStock) / days : 0
  ].map((value) => finiteNumber(value, 0)).filter((value) => value > 0);
  return candidates.length ? String(Math.round(Math.max(...candidates))) : "";
}

function b2bCollectedPriceFields(item = {}) {
  const profile = preciseRevenueProfile(item);
  const revenue = profile.lodging || {};
  const result = {};
  const keys = ["weekdayPrice", "fridayPrice", "saturdayPrice", "sundayPrice"];
  (profile.lodgingDayRows || []).slice(0, 4).forEach((row, index) => {
    const priced = finiteNumber(row.pricedSoldOut, 0);
    const amount = b2bWonNumber(row.revenueText);
    const price = priced > 0 ? amount / priced : 0;
    const rounded = roundB2BLodgePrice(price);
    if (rounded) result[keys[index]] = rounded;
  });
  const avg = finiteNumber(revenue.avgSoldUnitPrice, finiteNumber(item.weeklyAvgSoldUnitPrice, finiteNumber(item.basisLodgingAvgSoldUnitPrice, 0)));
  const fallback = roundB2BLodgePrice(avg);
  if (fallback) {
    keys.forEach((key) => {
      if (!result[key]) result[key] = fallback;
    });
  }
  return result;
}

function b2bCollectedFacilities(item = {}) {
  const coupon = naverCouponInfo(item);
  const productNames = (Array.isArray(item.itemDetails) ? item.itemDetails : [])
    .map((row) => String(row.name || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return [
    item.productTypeSummary,
    item.category,
    item.businessCategory,
    ...productNames,
    coupon.visible ? `쿠폰: ${coupon.names || "노출"}` : ""
  ].filter(Boolean).join(", ").slice(0, 160);
}

function b2bCollectedNaverConnected(item = {}) {
  return Boolean(
    item.hasInventory ||
    finiteNumber(item.weeklyTotalStock, 0) > 0 ||
    finiteNumber(item.nightTotalStock, 0) > 0 ||
    (Array.isArray(item.itemDetails) && item.itemDetails.length)
  );
}

function b2bMyLodgeDraftFromCollectedItem(item = {}, result = {}, current = {}) {
  const prices = b2bCollectedPriceFields(item);
  const roomCount = b2bCollectedRoomCount(item);
  const roomType = b2bCollectedRoomType(item);
  const dayUseCount = b2bCollectedDayUseCount(item);
  const facilities = b2bCollectedFacilities(item);
  const name = String(item.name || item.companyName || current.lodgingName || result.keyword || "").trim();
  const collectedSegment = {
    type: roomType || current.roomType || "",
    count: roomCount || current.roomCount || "",
    weekdayPrice: prices.weekdayPrice || current.weekdayPrice || "",
    fridayPrice: prices.fridayPrice || current.fridayPrice || "",
    saturdayPrice: prices.saturdayPrice || current.saturdayPrice || "",
    sundayPrice: prices.sundayPrice || current.sundayPrice || ""
  };
  const currentSegments = b2bMyLodgeSegmentInputRows(current);
  const roomSegments = b2bMyLodgeSegmentHasInput(collectedSegment)
    ? [collectedSegment]
    : currentSegments;
  const collected = {
    ...current,
    lodgingName: name || current.lodgingName || "",
    roomCount: roomCount || current.roomCount || "",
    roomType: roomType || current.roomType || "",
    dayUseCount: dayUseCount || current.dayUseCount || "",
    weekdayPrice: prices.weekdayPrice || current.weekdayPrice || "",
    fridayPrice: prices.fridayPrice || current.fridayPrice || "",
    saturdayPrice: prices.saturdayPrice || current.saturdayPrice || "",
    sundayPrice: prices.sundayPrice || current.sundayPrice || "",
    roomSegments,
    facilities: facilities || current.facilities || "",
    naverConnected: b2bCollectedNaverConnected(item) || Boolean(current.naverConnected),
    otaConnected: Boolean(current.otaConnected),
    savedAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    collectionRunId: result.runId || "",
    collectionSource: "naver_company",
    collectionStatus: `${name || current.lodgingName || "관심숙소"} 자동 수집 완료`
  };
  return collected;
}

function b2bMyLodgeRate(flow = {}, key = "all", fallback = 0.25) {
  const rate = flow?.[key]?.rate;
  if (Number.isFinite(rate)) return Math.max(0, Math.min(1, rate));
  return Math.max(0, Math.min(1, fallback));
}

function b2bMyLodgeDayTypeCounts(run = {}) {
  const days = Math.max(1, bookingDays(run) || DEFAULT_BOOKING_DAYS);
  const start = parseDate(run.checkIn) || new Date();
  const counts = { weekday: 0, friday: 0, saturday: 0, sunday: 0 };
  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const day = date.getDay();
    if (day === 5) counts.friday += 1;
    else if (day === 6) counts.saturday += 1;
    else if (day === 0) counts.sunday += 1;
    else counts.weekday += 1;
  }
  return counts;
}

function b2bMyLodgeDeltaText(value, base) {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base <= 0) return "비교 대기";
  return formatSignedRate(value / base - 1);
}

function b2bMyLodgeDeltaTone(value, base) {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base <= 0) return "neutral";
  const delta = value / base - 1;
  if (delta >= 0.2) return "good";
  if (delta <= -0.2) return "watch";
  return "strong";
}

function b2bMyLodgeBenchmarkModel(brief = b2bMarketBriefModel(), revenueModel = b2bRevenueBenchmarkModel(brief), draftOverride = null) {
  const draft = draftOverride && typeof draftOverride === "object" ? draftOverride : readB2BMyLodgeDraft();
  const roomSegments = b2bMyLodgeSegmentRows(draft);
  const segmentRoomCount = roomSegments.reduce((sum, row) => sum + Math.round(b2bMyLodgeNumber(row.count)), 0);
  const roomCount = Math.round(b2bMyLodgeNumber(draft.roomCount)) || segmentRoomCount;
  const segmentTypes = roomSegments.map((row) => row.type).filter(Boolean);
  const roomType = String(draft.roomType || segmentTypes.slice(0, 4).join(", ")).trim();
  const dayUseCount = Math.round(b2bMyLodgeNumber(draft.dayUseCount));
  const weekdayPrice = b2bMyLodgeNumber(draft.weekdayPrice);
  const fridayPrice = b2bMyLodgeNumber(draft.fridayPrice);
  const saturdayPrice = b2bMyLodgeNumber(draft.saturdayPrice);
  const sundayPrice = b2bMyLodgeNumber(draft.sundayPrice);
  const avgPrice = roomSegments.length ? b2bMyLodgeAveragePriceFromSegments(roomSegments) : b2bMyLodgeAveragePrice(draft);
  const hasSegmentEstimateBasis = roomSegments.some((row) =>
    b2bMyLodgeNumber(row.count) > 0 && B2B_MY_LODGE_PRICE_KEYS.some((key) => b2bMyLodgeNumber(row[key]) > 0)
  );
  const hasInput = Boolean(String(draft.lodgingName || "").trim()) || roomCount > 0 || roomType || dayUseCount > 0 || avgPrice > 0 || roomSegments.length > 0;
  const hasEstimateBasis = hasSegmentEstimateBasis || (roomCount > 0 && avgPrice > 0);
  const fallbackRate = Number.isFinite(brief.rate) ? brief.rate : b2bMyLodgeRate(revenueModel.flow, "all", 0.25);
  const rates = {
    weekday: b2bMyLodgeRate(revenueModel.flow, "weekday", fallbackRate),
    friday: b2bMyLodgeRate(revenueModel.flow, "friday", fallbackRate),
    saturday: b2bMyLodgeRate(revenueModel.flow, "saturday", fallbackRate),
    sunday: b2bMyLodgeRate(revenueModel.flow, "sunday", fallbackRate)
  };
  const dayCounts = b2bMyLodgeDayTypeCounts(state.data?.run || {});
  const basisDays = Object.values(dayCounts).reduce((sum, count) => sum + count, 0);
  const legacyWeeklyRevenue = hasEstimateBasis
    ? Math.round((
      roomCount * weekdayPrice * rates.weekday * dayCounts.weekday +
      roomCount * fridayPrice * rates.friday * dayCounts.friday +
      roomCount * saturdayPrice * rates.saturday * dayCounts.saturday +
      roomCount * sundayPrice * rates.sunday * dayCounts.sunday
    ) / 1000) * 1000
    : 0;
  const segmentWeeklyRevenue = hasSegmentEstimateBasis
    ? Math.round(b2bMyLodgeSegmentRevenue(roomSegments, rates, dayCounts) / 1000) * 1000
    : 0;
  const weeklyRevenue = hasSegmentEstimateBasis ? segmentWeeklyRevenue : legacyWeeklyRevenue;
  const sortedRevenueRows = (revenueModel.revenueRows || [])
    .filter((row) => row.revenue > 0)
    .slice()
    .sort((a, b) => b.revenue - a.revenue);
  const topSlice = sortedRevenueRows.slice(0, Math.min(3, sortedRevenueRows.length));
  const lowSlice = sortedRevenueRows.slice(Math.max(0, sortedRevenueRows.length - Math.min(3, sortedRevenueRows.length)));
  const topAverage = topSlice.length ? topSlice.reduce((sum, row) => sum + row.revenue, 0) / topSlice.length : 0;
  const lowAverage = lowSlice.length ? lowSlice.reduce((sum, row) => sum + row.revenue, 0) / lowSlice.length : 0;
  const marketAvgPriceRows = sortedRevenueRows.filter((row) => row.avgPrice > 0);
  const marketAvgPrice = marketAvgPriceRows.length
    ? marketAvgPriceRows.reduce((sum, row) => sum + row.avgPrice, 0) / marketAvgPriceRows.length
    : 0;
  const averageRevenue = finiteNumber(revenueModel.averageRevenue, 0) || finiteNumber(brief.averageRevenue, 0);
  const maxRevenue = finiteNumber(revenueModel.revenueMax, 0);
  const maxChartValue = Math.max(weeklyRevenue, averageRevenue, topAverage, lowAverage, maxRevenue, 1);
  const channelLabels = [
    draft.naverConnected ? "네이버 노출" : "",
    draft.otaConnected ? "OTA 노출" : ""
  ].filter(Boolean);
  const channelScore = (draft.naverConnected ? 1 : 0) + (draft.otaConnected ? 1 : 0);
  const facilities = b2bMyLodgeFacilities(draft.facilities);
  const segmentBasisText = hasSegmentEstimateBasis
    ? `${fmtNumber(roomSegments.length)}개 객실종류 · 요일별 가격 기준`
    : "입력 객실수와 요일별 가격 기준";
  const benchmarkRows = [
    { label: "관심숙소", value: weeklyRevenue, note: segmentBasisText, tone: hasEstimateBasis ? "mine" : "neutral" },
    { label: "지역 평균", value: averageRevenue, note: `${fmtNumber(sortedRevenueRows.length)}개 매출 표본 평균`, tone: "strong" },
    { label: "상위권 평균", value: topAverage, note: topSlice.length ? `상위 ${fmtNumber(topSlice.length)}개 평균` : "상위 표본 대기", tone: "good" },
    { label: "하위권 평균", value: lowAverage, note: lowSlice.length ? `하위 ${fmtNumber(lowSlice.length)}개 평균` : "하위 표본 대기", tone: "watch" },
    { label: "매출 상위", value: maxRevenue, note: sortedRevenueRows[0]?.name || "최고 표본 대기", tone: "hot" }
  ].map((row) => ({
    ...row,
    width: Math.max(row.value > 0 ? 8 : 0, Math.min(100, Math.round((row.value / maxChartValue) * 100)))
  }));
  const cards = [
    {
      tone: hasEstimateBasis ? "mine" : "neutral",
      label: "내 예상 기간 매출",
      value: hasEstimateBasis ? fmtWon(weeklyRevenue) : "입력 대기",
      note: hasSegmentEstimateBasis
        ? `${fmtNumber(roomSegments.length)}개 객실종류 · ${fmtNumber(basisDays)}일 예약율 반영`
        : `${fmtNumber(basisDays)}일 검색기간 예약율 반영`
    },
    {
      tone: b2bMyLodgeDeltaTone(weeklyRevenue, averageRevenue),
      label: "지역 평균 대비",
      value: hasEstimateBasis ? b2bMyLodgeDeltaText(weeklyRevenue, averageRevenue) : "입력 대기",
      note: averageRevenue ? `지역 평균 ${fmtWon(averageRevenue)}` : "매출 표본 대기"
    },
    {
      tone: b2bMyLodgeDeltaTone(weeklyRevenue, topAverage),
      label: "상위권 대비",
      value: hasEstimateBasis ? b2bMyLodgeDeltaText(weeklyRevenue, topAverage) : "입력 대기",
      note: topAverage ? `상위권 평균 ${fmtWon(topAverage)}` : "상위 표본 대기"
    },
    {
      tone: marketAvgPrice && avgPrice >= marketAvgPrice ? "strong" : "watch",
      label: "평균 객실가",
      value: avgPrice ? fmtWon(avgPrice) : "입력 대기",
      note: marketAvgPrice ? `경쟁 평균 ${fmtWon(marketAvgPrice)}` : "가격 표본 대기"
    },
    {
      tone: channelScore >= 2 ? "good" : channelScore === 1 ? "strong" : "watch",
      label: "판매 채널",
      value: channelLabels.length ? channelLabels.join(" + ") : "미입력",
      note: "공유 재고 가능 · 매출 중복 가산 없음"
    }
  ];
  return {
    draft,
    hasInput,
    hasEstimateBasis,
    roomCount,
    roomType,
    dayUseCount,
    roomSegments,
    segmentRoomCount,
    avgPrice,
    weeklyRevenue,
    rates,
    dayCounts,
    basisDays,
    cards,
    benchmarkRows,
    facilities,
    channelLabels,
    savedAt: draft.savedAt || "",
    storageKey: b2bMyLodgeStorageKey()
  };
}

function renderB2BInterestLodgeCards(interestLodges = [], brief = b2bMarketBriefModel(), revenueModel = b2bRevenueBenchmarkModel(brief)) {
  if (!interestLodges.length) return "";
  return `
    <div class="b2b-interest-lodge-grid" aria-label="등록된 관심숙소">
      ${interestLodges.map((lodge, index) => {
        const model = b2bMyLodgeBenchmarkModel(brief, revenueModel, lodge);
        const name = String(lodge.lodgingName || `관심숙소 ${index + 1}`).trim();
        const facilities = model.facilities.length ? model.facilities.slice(0, 4) : [];
        const segmentLabels = model.roomSegments.map((row) => row.type).filter(Boolean).slice(0, 4);
        const chips = [
          model.roomCount ? `${fmtNumber(model.roomCount)}실` : "",
          model.dayUseCount ? `데이유즈 ${fmtNumber(model.dayUseCount)}회` : "",
          ...segmentLabels,
          ...model.channelLabels,
          ...facilities
        ].filter(Boolean).slice(0, 8);
        return `
          <article class="b2b-interest-lodge-card">
            <div class="b2b-interest-lodge-card-head">
              <span>관심숙소 ${fmtNumber(index + 1)}</span>
              <strong>${escapeHtml(name)}</strong>
              <em>${model.hasEstimateBasis ? fmtWon(model.weeklyRevenue) : "매출 입력 대기"}</em>
            </div>
            <div class="b2b-interest-lodge-metrics">
              <div><span>객실</span><strong>${model.roomCount ? `${fmtNumber(model.roomCount)}실` : "대기"}</strong></div>
              <div><span>평균 객실가</span><strong>${model.avgPrice ? fmtWon(model.avgPrice) : "대기"}</strong></div>
              <div><span>판매 채널</span><strong>${model.channelLabels.length ? escapeHtml(model.channelLabels.join(" + ")) : "미입력"}</strong></div>
            </div>
            <div class="b2b-interest-lodge-tags">
              ${chips.length ? chips.map((chip) => `<em>${escapeHtml(chip)}</em>`).join("") : "<em>상세 입력 대기</em>"}
            </div>
            <div class="b2b-interest-lodge-actions">
              <button class="secondary-button" type="button" data-b2b-interest-lodge-edit="${escapeHtml(lodge.id)}">수정</button>
              <button class="ghost-button" type="button" data-b2b-interest-lodge-delete="${escapeHtml(lodge.id)}">삭제</button>
            </div>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderB2BMyLodgeBenchmark(brief = b2bMarketBriefModel(), model = b2bMyLodgeBenchmarkModel(brief), revenueModelOverride = null) {
  const draft = model.draft || {};
  const name = String(draft.lodgingName || "").trim();
  const collecting = Boolean(state.b2bMyLodgeCollecting);
  const collectStatus = state.b2bMyLodgeCollectStatus || draft.collectionStatus || "";
  const revenueModel = revenueModelOverride || b2bRevenueBenchmarkModel(brief);
  const interestLodges = readB2BInterestLodges();
  const canRegisterMore = interestLodges.length < B2B_INTEREST_LODGE_LIMIT;
  const facilities = model.facilities.length ? model.facilities : ["시설 입력 대기"];
  const inputSegments = b2bMyLodgeSegmentInputRows(draft);
  const segmentRows = inputSegments.length ? inputSegments : [b2bMyLodgeBlankSegment()];
  const roomCountValue = draft.roomCount || (model.segmentRoomCount ? String(model.segmentRoomCount) : "");
  const segmentPriceValue = (row, key) => escapeHtml(b2bMyLodgeInputNumberText(row[key]));
  const segmentRowHtml = segmentRows.map((row, index) => `
    <div class="b2b-room-segment-row" data-b2b-room-segment-row>
      <label>
        <span>객실 종류</span>
        <input name="segmentType" type="text" maxlength="80" value="${escapeHtml(row.type || "")}" placeholder="글램핑, 카라반">
      </label>
      <label>
        <span>수량</span>
        <input name="segmentCount" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(row.count || "")}" placeholder="예: 6">
      </label>
      <label>
        <span>평일</span>
        <input name="segmentWeekdayPrice" type="text" inputmode="numeric" data-b2b-won-input value="${segmentPriceValue(row, "weekdayPrice")}" placeholder="120,000">
      </label>
      <label>
        <span>금</span>
        <input name="segmentFridayPrice" type="text" inputmode="numeric" data-b2b-won-input value="${segmentPriceValue(row, "fridayPrice")}" placeholder="160,000">
      </label>
      <label>
        <span>토</span>
        <input name="segmentSaturdayPrice" type="text" inputmode="numeric" data-b2b-won-input value="${segmentPriceValue(row, "saturdayPrice")}" placeholder="220,000">
      </label>
      <label>
        <span>일</span>
        <input name="segmentSundayPrice" type="text" inputmode="numeric" data-b2b-won-input value="${segmentPriceValue(row, "sundayPrice")}" placeholder="140,000">
      </label>
      <button class="b2b-room-segment-remove" type="button" data-b2b-room-segment-remove="${index}" aria-label="객실종류 삭제" ${segmentRows.length <= 1 ? "disabled" : ""}>×</button>
    </div>
  `).join("");
  return `
    <div class="b2b-my-lodge-board">
      <div class="b2b-my-lodge-head">
        <div>
          <span>My Stay Benchmark</span>
          <strong>관심숙소 등록</strong>
          <p>비교할 숙소를 최대 2곳까지 등록하고, 객실종류별 수량·요일 가격으로 지역 평균·상위권 매출 표본과 비교합니다.</p>
        </div>
        <em>${fmtNumber(interestLodges.length)}/${fmtNumber(B2B_INTEREST_LODGE_LIMIT)} 등록</em>
      </div>
      ${renderB2BInterestLodgeCards(interestLodges, brief, revenueModel)}
      ${canRegisterMore ? `
      <form class="b2b-my-lodge-form" data-b2b-my-lodge-form>
        <label class="b2b-my-lodge-field name">
          <span>숙소명</span>
          <input name="lodgingName" type="text" maxlength="80" value="${escapeHtml(name)}" placeholder="지역명 + 운영업체명">
        </label>
        <label class="b2b-my-lodge-field">
          <span>객실 수(총량)</span>
          <input name="roomCount" type="number" min="0" step="1" value="${escapeHtml(roomCountValue)}" placeholder="12">
        </label>
        <label class="b2b-my-lodge-field">
          <span>데이유즈</span>
          <input name="dayUseCount" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(draft.dayUseCount ?? "")}" placeholder="예: 6">
        </label>
        <label class="b2b-my-lodge-field facilities">
          <span>시설</span>
          <input name="facilities" type="text" maxlength="160" value="${escapeHtml(draft.facilities || "")}" placeholder="개별화장실, 수영장, 바비큐">
        </label>
        <div class="b2b-room-segment-panel" data-b2b-room-segments>
          <div class="b2b-room-segment-head">
            <div>
              <strong>객실종류별 가격</strong>
              <span>객실 종류를 추가해 세그먼트별 객실수와 평일·금·토·일 가격을 입력합니다.</span>
            </div>
            <button class="secondary-button" type="button" data-b2b-room-segment-add ${segmentRows.length >= B2B_MY_LODGE_SEGMENT_LIMIT ? "disabled" : ""}>객실종류 +</button>
          </div>
          <div class="b2b-room-segment-list">
            ${segmentRowHtml}
          </div>
        </div>
        <div class="b2b-my-lodge-checks" aria-label="판매 채널 참고">
          <label><input name="naverConnected" type="checkbox" ${draft.naverConnected ? "checked" : ""}> 네이버 노출</label>
          <label><input name="otaConnected" type="checkbox" ${draft.otaConnected ? "checked" : ""}> OTA 노출</label>
        </div>
        <div class="b2b-my-lodge-channel-note">네이버/OTA는 같은 객실 재고를 공유할 수 있어 매출 산정에는 중복 가산하지 않습니다.</div>
        <div class="b2b-my-lodge-actions">
          <button class="secondary-button collect" type="button" data-b2b-my-lodge-collect ${collecting ? "disabled" : ""}>${collecting ? "숙소명 찾는 중" : "숙소명으로 찾기"}</button>
          <button class="primary-button" type="button" data-b2b-my-lodge-save>관심숙소 등록</button>
          <button class="secondary-button" type="button" data-b2b-my-lodge-clear ${model.hasInput ? "" : "disabled"}>입력 초기화</button>
        </div>
        ${collectStatus ? `<div class="b2b-my-lodge-collect-status ${collecting ? "loading" : ""}">${escapeHtml(collectStatus)}</div>` : ""}
      </form>
      ` : `
        <div class="b2b-interest-lodge-limit">
          <strong>관심숙소는 최대 ${fmtNumber(B2B_INTEREST_LODGE_LIMIT)}곳까지 등록됩니다.</strong>
          <span>다른 숙소를 비교하려면 기존 관심숙소를 수정하거나 삭제하세요.</span>
        </div>
      `}
      ${canRegisterMore && model.hasInput ? `
      <div class="b2b-my-lodge-result ${model.hasEstimateBasis ? "ready" : "empty"}">
        <article class="b2b-my-lodge-main">
          <span>${escapeHtml(name || "관심숙소 미리보기")}</span>
          <strong>${model.hasEstimateBasis ? fmtWon(model.weeklyRevenue) : "입력 후 비교"}</strong>
          <small>경쟁권 요일별 예약율: 평일 ${fmtRate(model.rates.weekday)} · 금 ${fmtRate(model.rates.friday)} · 토 ${fmtRate(model.rates.saturday)} · 일 ${fmtRate(model.rates.sunday)}</small>
          <div class="b2b-my-lodge-tags">
            <em>${fmtNumber(model.roomCount)}실</em>
            ${model.roomType ? `<em>${escapeHtml(model.roomType)}</em>` : ""}
            ${model.dayUseCount ? `<em>데이유즈 ${fmtNumber(model.dayUseCount)}회</em>` : ""}
            ${facilities.map((item) => `<em>${escapeHtml(item)}</em>`).join("")}
          </div>
        </article>
        <div class="b2b-my-lodge-cards">
          ${model.cards.map((card) => `
            <article class="${escapeHtml(card.tone)}">
              <span>${escapeHtml(card.label)}</span>
              <strong>${escapeHtml(card.value)}</strong>
              <small>${escapeHtml(card.note)}</small>
            </article>
          `).join("")}
        </div>
        <article class="b2b-my-lodge-chart">
          <div class="b2b-my-lodge-subhead">
            <strong>매출 포지션 비교</strong>
            <small>관심숙소 vs 지역 평균·상위권·하위권·매출 상위</small>
          </div>
          ${model.benchmarkRows.map((row) => `
            <div class="b2b-my-lodge-row ${escapeHtml(row.tone)}" style="--bar:${row.width}%">
              <span>${escapeHtml(row.label)}</span>
              <i><b></b></i>
              <strong>${row.value ? fmtWon(row.value) : "대기"}</strong>
              <small>${escapeHtml(row.note)}</small>
            </div>
          `).join("")}
        </article>
      </div>
      ` : ""}
    </div>
  `;
}

function collectB2BMyLodgeSegmentFormRows({ includeBlank = false } = {}) {
  const form = document.querySelector("[data-b2b-my-lodge-form]");
  if (!form) return [];
  const rows = Array.from(form.querySelectorAll("[data-b2b-room-segment-row]"))
    .map((row) => {
      const rowValue = (name) => String(row.querySelector(`[name="${name}"]`)?.value || "").trim();
      const rowNumber = (name) => {
        const number = b2bMyLodgeNumber(rowValue(name));
        return number > 0 ? String(Math.round(number)) : "";
      };
      return {
        type: rowValue("segmentType").slice(0, 80),
        count: rowNumber("segmentCount"),
        weekdayPrice: rowNumber("segmentWeekdayPrice"),
        fridayPrice: rowNumber("segmentFridayPrice"),
        saturdayPrice: rowNumber("segmentSaturdayPrice"),
        sundayPrice: rowNumber("segmentSundayPrice")
      };
    })
    .slice(0, B2B_MY_LODGE_SEGMENT_LIMIT);
  return includeBlank ? rows : rows.filter((row) => b2bMyLodgeSegmentHasInput(row));
}

function collectB2BMyLodgeFormValues() {
  const form = document.querySelector("[data-b2b-my-lodge-form]");
  if (!form) return null;
  const formData = new FormData(form);
  const value = (name) => String(formData.get(name) || "").trim();
  const numberValue = (name) => {
    const number = b2bMyLodgeNumber(value(name));
    return number > 0 ? String(Math.round(number)) : "";
  };
  const segmentRows = collectB2BMyLodgeSegmentFormRows();
  const segmentTotal = segmentRows.reduce((sum, row) => sum + Math.round(b2bMyLodgeNumber(row.count)), 0);
  const firstSegment = segmentRows[0] || {};
  const roomType = segmentRows.map((row) => row.type).filter(Boolean).slice(0, 4).join(", ");
  return {
    lodgingName: value("lodgingName").slice(0, 80),
    roomCount: numberValue("roomCount") || (segmentTotal > 0 ? String(segmentTotal) : ""),
    roomType: roomType.slice(0, 80),
    dayUseCount: numberValue("dayUseCount"),
    weekdayPrice: firstSegment.weekdayPrice || "",
    fridayPrice: firstSegment.fridayPrice || "",
    saturdayPrice: firstSegment.saturdayPrice || "",
    sundayPrice: firstSegment.sundayPrice || "",
    roomSegments: segmentRows,
    facilities: value("facilities").slice(0, 160),
    naverConnected: Boolean(form.querySelector('input[name="naverConnected"]')?.checked),
    otaConnected: Boolean(form.querySelector('input[name="otaConnected"]')?.checked),
    savedAt: new Date().toISOString()
  };
}

function persistB2BMyLodgeStore(store = {}) {
  const values = {
    version: 2,
    draft: store.draft && typeof store.draft === "object" ? store.draft : {},
    interestLodges: (Array.isArray(store.interestLodges) ? store.interestLodges : [])
      .map((lodge) => b2bNormalizeInterestLodge(lodge))
      .filter((lodge) => b2bMyLodgeDraftHasInput(lodge))
      .slice(0, B2B_INTEREST_LODGE_LIMIT)
  };
  state.b2bMyLodgeDraft = { key: b2bMyLodgeStorageKey(), values };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(b2bMyLodgeStorageKey(), JSON.stringify(values));
    }
  } catch {
    // The comparison still renders from memory if browser storage is blocked.
  }
}

function persistB2BMyLodgeDraft(values = {}) {
  const store = readB2BMyLodgeStore();
  persistB2BMyLodgeStore({ ...store, draft: values });
}

function saveB2BMyLodgeBenchmark() {
  const values = collectB2BMyLodgeFormValues();
  if (!values) return;
  const store = readB2BMyLodgeStore();
  const interestLodges = Array.isArray(store.interestLodges) ? store.interestLodges.slice(0, B2B_INTEREST_LODGE_LIMIT) : [];
  if (interestLodges.length >= B2B_INTEREST_LODGE_LIMIT) {
    state.b2bMyLodgeCollectStatus = `관심숙소는 최대 ${fmtNumber(B2B_INTEREST_LODGE_LIMIT)}곳까지 등록할 수 있습니다.`;
    renderReport();
    return;
  }
  if (!b2bMyLodgeDraftHasInput(values) || !String(values.lodgingName || "").trim()) {
    state.b2bMyLodgeCollectStatus = "관심숙소명을 먼저 입력하세요.";
    persistB2BMyLodgeStore({ ...store, draft: values, interestLodges });
    renderReport();
    document.querySelector(".b2b-my-lodge-board")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const lodge = b2bNormalizeInterestLodge({
    ...values,
    id: b2bNewInterestLodgeId(),
    savedAt: new Date().toISOString()
  });
  interestLodges.push(lodge);
  state.b2bMyLodgeCollectStatus = `${lodge.lodgingName} 관심숙소 등록 완료`;
  persistB2BMyLodgeStore({ ...store, draft: {}, interestLodges });
  renderReport();
  document.querySelector(".b2b-my-lodge-board")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function editB2BInterestLodge(lodgeId = "") {
  const store = readB2BMyLodgeStore();
  const interestLodges = Array.isArray(store.interestLodges) ? store.interestLodges : [];
  const target = interestLodges.find((lodge) => lodge.id === lodgeId);
  if (!target) return;
  state.b2bMyLodgeCollectStatus = `${target.lodgingName || "관심숙소"} 정보를 수정합니다. 저장하면 다시 카드로 등록됩니다.`;
  persistB2BMyLodgeStore({
    ...store,
    draft: { ...target, id: "" },
    interestLodges: interestLodges.filter((lodge) => lodge.id !== lodgeId)
  });
  renderReport();
  document.querySelector(".b2b-my-lodge-board")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function deleteB2BInterestLodge(lodgeId = "") {
  const store = readB2BMyLodgeStore();
  const interestLodges = Array.isArray(store.interestLodges) ? store.interestLodges : [];
  const next = interestLodges.filter((lodge) => lodge.id !== lodgeId);
  state.b2bMyLodgeCollectStatus = next.length === interestLodges.length ? "삭제할 관심숙소를 찾지 못했습니다." : "관심숙소를 삭제했습니다.";
  persistB2BMyLodgeStore({ ...store, interestLodges: next });
  renderReport();
  document.querySelector(".b2b-my-lodge-board")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function updateB2BMyLodgeRoomSegments(action = "add", index = -1) {
  const values = collectB2BMyLodgeFormValues() || readB2BMyLodgeDraft() || {};
  const displayedRows = collectB2BMyLodgeSegmentFormRows({ includeBlank: true });
  const rows = (displayedRows.length ? displayedRows : b2bMyLodgeSegmentInputRows(values)).slice(0, B2B_MY_LODGE_SEGMENT_LIMIT);
  if (!rows.length) rows.push(b2bMyLodgeBlankSegment());
  if (action === "add" && rows.length < B2B_MY_LODGE_SEGMENT_LIMIT) {
    rows.push(b2bMyLodgeBlankSegment());
  }
  if (action === "remove" && rows.length > 1 && index >= 0 && index < rows.length) {
    rows.splice(index, 1);
  }
  values.roomSegments = rows;
  persistB2BMyLodgeDraft(values);
  renderReport();
  document.querySelector("[data-b2b-room-segments]")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function collectB2BMyLodgeByName() {
  if (state.b2bMyLodgeCollecting) return;
  const current = collectB2BMyLodgeFormValues() || {};
  const lodgingName = String(current.lodgingName || "").trim();
  if (!lodgingName) {
    state.b2bMyLodgeCollectStatus = "숙소명을 먼저 입력하세요.";
    renderReport();
    return;
  }
  const payload = {
    lodgingName,
    checkIn: state.data?.run?.checkIn || els.checkInInput?.value || "",
    checkOut: state.data?.run?.checkOut || els.checkOutInput?.value || "",
    detailRankRanges: "1-5",
    bookingRangeDays: DEFAULT_BOOKING_DAYS,
    bookingRangePlaceLimit: 3
  };
  state.b2bMyLodgeCollecting = true;
  state.b2bMyLodgeCollectStatus = `${lodgingName} 자동 수집을 시작합니다. 네이버 업체명 검색 기준입니다.`;
  state.b2bMyLodgeCollectResult = null;
  renderReport();
  try {
    const result = await fetchJson("/api/b2b-my-lodge-collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const item = result.selectedItem || (Array.isArray(result.candidateItems) ? result.candidateItems[0] : null);
    if (!item) throw new Error("일치하는 네이버 업체를 찾지 못했습니다. 숙소명을 더 정확히 입력하세요.");
    const values = b2bMyLodgeDraftFromCollectedItem(item, result, current);
    state.b2bMyLodgeCollectResult = result;
    state.b2bMyLodgeCollectStatus = `${values.lodgingName || lodgingName} 자동 수집 완료 · 객실/가격/쿠폰/상품 구성을 반영했습니다.`;
    values.collectionStatus = state.b2bMyLodgeCollectStatus;
    persistB2BMyLodgeDraft(values);
  } catch (error) {
    state.b2bMyLodgeCollectStatus = `자동 수집 실패: ${error.message}`;
  } finally {
    state.b2bMyLodgeCollecting = false;
    renderReport();
    document.querySelector(".b2b-my-lodge-board")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function clearB2BMyLodgeBenchmark() {
  const store = readB2BMyLodgeStore();
  state.b2bMyLodgeCollectStatus = "";
  state.b2bMyLodgeCollectResult = null;
  persistB2BMyLodgeStore({ ...store, draft: {} });
  renderReport();
  document.querySelector(".b2b-my-lodge-board")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderB2BRevenueBenchmark(brief = b2bMarketBriefModel(), model = b2bRevenueBenchmarkModel(brief)) {
  if (!model.rows.length) return "";
  return `
    <div class="b2b-revenue-board ${escapeHtml(model.decision.tone)}">
      <div class="b2b-revenue-head">
        <div>
          <span>B2B Revenue Benchmark</span>
          <strong>경쟁 매출 정밀도</strong>
          <p>${escapeHtml(model.decision.summary)}</p>
        </div>
        <em>${escapeHtml(model.decision.label)}</em>
      </div>
      <div class="b2b-revenue-grid">
        ${model.cards.map((card) => `
          <article class="${escapeHtml(card.tone)}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(card.value)}</strong>
            <small>${escapeHtml(card.note)}</small>
          </article>
        `).join("")}
      </div>
      <div class="b2b-revenue-layout">
        <article class="b2b-revenue-list">
          <div class="b2b-revenue-subhead">
            <strong>매출 벤치마크 업체</strong>
            <small>가격과 판매 수량이 연결된 경쟁업체를 우선 표시합니다.</small>
          </div>
          ${model.benchmarkRows.map((row) => {
            const attrs = row.itemIndex >= 0 ? `type="button" data-open-company="${row.itemIndex}"` : `type="button" disabled`;
            const revenueText = row.revenue ? fmtWon(row.revenue) : "매출 표본 대기";
            const priceTextValue = row.avgPrice ? `평균가 ${fmtWon(row.avgPrice)}` : "가격 표본 대기";
            const rateText = Number.isFinite(row.flow.all.rate) ? fmtRate(row.flow.all.rate) : "판매율 대기";
            return `
              <button class="b2b-revenue-row ${escapeHtml(row.tone)}" ${attrs}>
                <span>${fmtNumber(row.rank)}위</span>
                <strong>${escapeHtml(row.name)}</strong>
                <em>${escapeHtml(revenueText)}</em>
                <small>${escapeHtml(`${rateText} · ${priceTextValue} · 신뢰 ${row.grade || "대기"}`)}</small>
              </button>
            `;
          }).join("")}
        </article>
        <article class="b2b-revenue-guide">
          <div class="b2b-revenue-subhead">
            <strong>해석 기준</strong>
            <small>할인 옵션은 산출하지 않고, 확인 가격과 수량 기반 매출만 비교합니다.</small>
          </div>
          ${model.guideRows.map((row) => `
            <div class="${escapeHtml(row.tone)}">
              <span>${escapeHtml(row.label)}</span>
              <strong>${escapeHtml(row.value)}</strong>
              <small>${escapeHtml(row.note)}</small>
            </div>
          `).join("")}
        </article>
      </div>
    </div>
  `;
}

function b2bStrategyBoardModel(brief = b2bMarketBriefModel(), revenueModel = b2bRevenueBenchmarkModel(brief)) {
  const rankModel = b2bRankBoardModel();
  const mapModel = b2bRegionMapModel();
  const trend = demandTrendSource();
  const trendStats = demandTrendStats(trend);
  const nextDemand = demandNextMonthProjection(demandTrafficAggregate(), trend, trendStats);
  const revenueCoverage = brief.itemCount ? revenueModel.revenueRows.length / brief.itemCount : NaN;
  const outsideCount = finiteNumber(mapModel.outsideCount, 0);
  const gapCount = finiteNumber(rankModel.gapRows.length, 0);
  const hotCount = finiteNumber(rankModel.hotRows.length, 0);
  const trendRising = Number.isFinite(trendStats.recentChange) && trendStats.recentChange >= 0.12;
  const trendFalling = Number.isFinite(trendStats.recentChange) && trendStats.recentChange <= -0.12;
  const peakNow = trend.hasSeries && Number.isFinite(trendStats.peakRatio) && trendStats.peakRatio >= 0.82;
  const revenueReady = revenueModel.revenueRows.length > 0;
  const priceCoverage = revenueModel.priceCoverage;
  const weekendRate = revenueModel.weekend?.rate;
  const weekdayRate = revenueModel.flow?.weekday?.rate;
  let decision = {
    tone: "neutral",
    label: "관찰 필요",
    summary: "최소 1주일, 주 1회 이상 반복 수집 후 경쟁권 방향 판단이 가능합니다."
  };
  if (revenueReady && (trendRising || peakNow) && hotCount >= 1) {
    decision = {
      tone: "hot",
      label: `${B2B_HIGH_RESERVATION_LABEL} 경쟁권`,
      summary: "매출 표본과 수요 신호가 동시에 잡힙니다. 수집기간 예약율 40% 이상 업체의 가격과 주말 재고를 먼저 비교합니다."
    };
  } else if (gapCount >= 2) {
    decision = {
      tone: "strong",
      label: "공략 가능권",
      summary: `${B2B_LOW_RESERVATION_LABEL} 업체가 보입니다. 가격, 상품 구성, 채널 노출 차이를 우선 비교합니다.`
    };
  } else if (outsideCount > 0) {
    decision = {
      tone: "watch",
      label: "반경 경쟁권",
      summary: "검색 지역 밖 업체도 노출됩니다. 행정구역보다 네이버 반경 경쟁권 기준으로 비교합니다."
    };
  } else if (trendFalling || !revenueReady) {
    decision = {
      tone: "watch",
      label: "표본 보완권",
      summary: "매출 또는 수요 표본이 부족합니다. 현재 값은 방향성 판단용으로 보고 표본 보완을 병행합니다."
    };
  }
  const demandLabel = trend.reason
    ? "추세 대기"
    : trend.hasSeries
      ? demandTrendLabel()
      : "데이터랩 대기";
  const topRegion = mapModel.topRegion || brief.topRegion || {};
  const topRevenue = revenueModel.topRows?.[0] || null;
  const topRank = rankModel.rows?.[0] || null;
  const cards = [
    {
      tone: revenueReady ? "strong" : "watch",
      label: "매출 판단",
      value: revenueModel.averageRevenue ? fmtWon(revenueModel.averageRevenue) : "대기",
      note: revenueReady ? `표본 ${fmtNumber(revenueModel.revenueRows.length)}개 · 가격 ${Number.isFinite(priceCoverage) ? fmtRate(priceCoverage) : "대기"}` : "가격·수량 표본 필요"
    },
    {
      tone: hotCount ? "hot" : gapCount ? "strong" : "neutral",
      label: "노출 판단",
      value: `${fmtNumber(rankModel.rows.length)}개`,
      note: `${B2B_HIGH_RESERVATION_LABEL} ${fmtNumber(hotCount)}개 · ${B2B_LOW_RESERVATION_LABEL} ${fmtNumber(gapCount)}개`
    },
    {
      tone: nextDemand.tone || (trendRising || peakNow ? "hot" : trendFalling ? "watch" : "good"),
      label: nextDemand.label || "다음달 검색량",
      value: nextDemand.value,
      note: nextDemand.note
    },
    {
      tone: outsideCount ? "watch" : "good",
      label: "권역 판단",
      value: outsideCount ? `${fmtNumber(outsideCount)}곳` : "지역권",
      note: topRegion.region || topRegion.name || "지역 표본 기준"
    }
  ];
  const actionRows = [
    {
      tone: revenueReady ? "strong" : "watch",
      label: "가격 포지션",
      value: topRevenue?.revenue ? fmtWon(topRevenue.revenue) : "표본 대기",
      detail: topRevenue
        ? `${topRevenue.name} 기준으로 평균가, 가격 확인률, 누락 보정 영향을 비교합니다.`
        : "매출 표본이 확보되면 상위 업체 가격대를 기준으로 비교합니다.",
      tab: "report",
      button: "매출 보기"
    },
    {
      tone: gapCount ? "strong" : hotCount ? "hot" : "neutral",
      label: "노출 대응",
      value: topRank ? `${fmtNumber(topRank.rank)}위` : "대기",
      detail: gapCount
        ? `${B2B_LOW_RESERVATION_LABEL} 업체 ${fmtNumber(gapCount)}개를 먼저 열어 가격·상품 구성을 확인합니다.`
        : "상위 노출 업체의 예약율과 매출 표본을 기준값으로 봅니다.",
      tab: "rank",
      button: "순위 보기"
    },
    {
      tone: Number.isFinite(weekendRate) && weekendRate >= 0.65 ? "hot" : "good",
      label: "요일 전략",
      value: Number.isFinite(weekendRate) ? fmtRate(weekendRate) : "대기",
      detail: Number.isFinite(weekendRate) && Number.isFinite(weekdayRate)
        ? `주말 ${fmtRate(weekendRate)} · 평일 ${fmtRate(weekdayRate)} 기준으로 요일별 가격 차이를 봅니다.`
        : "평일·금요일·토요일·일요일 판매 흐름 표본이 확보되면 요일별 전략을 분리합니다.",
      tab: "demand",
      button: "수요 보기"
    },
    {
      tone: outsideCount ? "watch" : "good",
      label: "권역 전략",
      value: outsideCount ? "반경권" : "지역권",
      detail: outsideCount
        ? "네이버 반경 노출로 들어오는 타지역 업체까지 경쟁군에 포함합니다."
        : "현재 표본은 검색 지역권 중심으로 비교합니다.",
      tab: "map",
      button: "지도 보기"
    }
  ];
  const checklist = [
    {
      tone: revenueReady ? "strong" : "watch",
      label: "매출 기준값",
      note: revenueReady
        ? `평균 ${fmtWon(revenueModel.averageRevenue)} · 상위 ${topRevenue?.revenue ? fmtWon(topRevenue.revenue) : "대기"}`
        : "가격과 수량 표본을 먼저 확보"
    },
    {
      tone: rankModel.rows.length ? "good" : "watch",
      label: "분석 범위",
      note: rankModel.rows.length
        ? `네이버 플레이스 ${fmtNumber(rankModel.rows.length)}개 · 매출 표본 ${Number.isFinite(revenueCoverage) ? fmtRate(revenueCoverage) : "대기"}`
        : "검색 범위 표본 대기"
    },
    {
      tone: nextDemand.tone || (trendRising || peakNow ? "hot" : "neutral"),
      label: `${nextDemand.targetMonthLabel || "다음달"} 수요`,
      note: nextDemand.detailText || nextDemand.note || (trend.reason || (trend.hasSeries ? `${demandLabel} · ${trendStats.peak?.label || "피크 대기"}` : "데이터랩 추세 대기"))
    }
  ];
  return {
    decision,
    cards,
    actionRows,
    checklist
  };
}

function b2bSimpleSummaryModel(
  brief = b2bMarketBriefModel(),
  strategyModel = b2bStrategyBoardModel(brief),
  revenueModel = b2bRevenueBenchmarkModel(brief),
  snapshotModel = b2bCompetitiveSnapshotModel(brief)
) {
  const decision = strategyModel.decision || brief.decision || {};
  const rankModel = snapshotModel.rankModel || b2bRankBoardModel();
  const trend = demandTrendSource();
  const trendStats = demandTrendStats(trend);
  const nextDemand = snapshotModel.nextDemand || demandNextMonthProjection(demandTrafficAggregate(), trend, trendStats);
  const revenueReady = revenueModel.revenueRows.length > 0;
  const priceCoverage = revenueModel.priceCoverage;
  const revenueSampleText = revenueReady
    ? `${fmtNumber(revenueModel.revenueRows.length)}개 매출 표본`
    : "매출 표본 대기";
  const hotCount = finiteNumber(rankModel.hotRows?.length, 0);
  const gapCount = finiteNumber(rankModel.gapRows?.length, 0);
  const competitionScore = Math.max(0, Math.min(100, Math.round(finiteNumber(brief.score, 0))));
  const actualReservationRate = Number.isFinite(brief.rate)
    ? brief.rate
    : (Number.isFinite(rankModel.rate) ? rankModel.rate : NaN);
  const reservationSampleNote = brief.salesSampleCount
    ? `예약율 산출 표본 (네이버 플레이스 기준) ${fmtNumber(brief.salesSampleCount)}곳`
    : "예약율 산출 표본 (네이버 플레이스 기준) 대기";
  const revenueMeter = revenueReady
    ? Math.max(18, Math.min(100, Math.round((revenueModel.revenueRows.length / Math.max(1, rankModel.rows.length || brief.itemCount)) * 100)))
    : 0;
  const searchMeter = Number.isFinite(nextDemand.change)
    ? Math.max(0, Math.min(100, Math.round(50 + nextDemand.change * 100)))
    : (nextDemand.projectedVolume ? 55 : 0);
  const summaryByTone = {
    hot: "수요와 매출 신호가 강합니다. 상위 경쟁업체의 가격대와 주말 판매 압력을 먼저 보세요.",
    strong: `공략 가능한 경쟁권입니다. 노출 대비 ${B2B_LOW_RESERVATION_LABEL} 업체와 가격 차이를 먼저 확인하세요.`,
    watch: "권역 또는 표본 변수가 있습니다. 반경 경쟁권과 매출 표본을 보완해서 판단하세요.",
    neutral: "현재는 관찰 구간입니다. 경쟁업체 표본을 더 쌓아 방향성을 확인하세요."
  };
  const cards = [
    {
      tone: hotCount ? "hot" : gapCount ? "strong" : "neutral",
      label: "경쟁지표",
      value: `${fmtNumber(competitionScore)}점`,
      note: `지정 검색범위 ${fmtNumber(rankModel.rows.length || brief.itemCount)}곳 비교`,
      barValue: competitionScore,
      meterLabel: `${fmtNumber(competitionScore)}점`
    },
    {
      tone: Number.isFinite(actualReservationRate) && actualReservationRate >= B2B_HIGH_RESERVATION_RATE
        ? "hot"
        : Number.isFinite(actualReservationRate) && actualReservationRate <= B2B_LOW_RESERVATION_RATE
          ? "watch"
          : "strong",
      label: "실제 예약 지표",
      value: Number.isFinite(actualReservationRate) ? fmtRate(actualReservationRate) : "확인필요",
      note: reservationSampleNote,
      barValue: Number.isFinite(actualReservationRate) ? Math.round(actualReservationRate * 100) : 0,
      meterLabel: Number.isFinite(actualReservationRate) ? fmtRate(actualReservationRate) : "대기"
    },
    {
      tone: revenueReady ? "strong" : "watch",
      label: "예상 평균 매출",
      value: revenueModel.averageRevenue ? fmtWon(revenueModel.averageRevenue) : fmtWon(brief.averageRevenue),
      note: Number.isFinite(priceCoverage) ? `${revenueSampleText} · 가격 ${fmtRate(priceCoverage)}` : revenueSampleText,
      barValue: revenueMeter,
      meterLabel: revenueReady ? `표본 ${fmtNumber(revenueModel.revenueRows.length)}곳` : "대기"
    },
    {
      tone: nextDemand.tone || (trend.reason ? "watch" : trend.hasSeries ? "good" : "neutral"),
      label: nextDemand.label || "다음달 예상 검색량",
      value: nextDemand.value,
      note: nextDemand.note,
      barValue: searchMeter,
      meterLabel: Number.isFinite(nextDemand.change) ? formatSignedRate(nextDemand.change) : "예측"
    }
  ];
  const actions = [
    {
      tone: revenueReady ? "strong" : "watch",
      label: "매출 기준 확인",
      detail: revenueReady ? "평균 매출과 상위 업체 가격대를 비교" : "가격·수량 표본을 먼저 확인",
      tab: "report"
    },
    {
      tone: gapCount || hotCount ? "strong" : "neutral",
      label: "순위경쟁 확인",
      detail: "수집기간중 노출 순서, 예약율 확인",
      tab: "rank"
    },
    {
      tone: trend.hasSeries ? "good" : "watch",
      label: "예상 검색량 확인",
      detail: "수집기간중 월별검색량과 흐름을 확인",
      tab: "demand"
    }
  ];
  return {
    decision,
    headline: decision.label || brief.decision.label || "경쟁 리포트",
    summary: summaryByTone[decision.tone] || decision.summary || brief.decision.summary,
    cards,
    actions,
    dataNote: `${brief.range} · ${fmtNumber(brief.itemCount)}개 경쟁업체 기준`
  };
}

function renderB2BSimpleSummary(brief = b2bMarketBriefModel(), model = b2bSimpleSummaryModel(brief)) {
  return `
    <div class="b2b-simple-summary ${escapeHtml(model.decision.tone || "neutral")}">
      <div class="b2b-simple-answer">
        <span>먼저 볼 결론</span>
        <strong>${escapeHtml(model.headline)}</strong>
        <p>${escapeHtml(model.summary)}</p>
        <small>${escapeHtml(model.dataNote)}</small>
      </div>
      <div class="b2b-simple-grid">
        ${model.cards.map((card) => `
          <article class="b2b-simple-card ${escapeHtml(card.tone)}">
            <div class="b2b-simple-card-head">
              <span>${escapeHtml(card.label)}</span>
              <strong>${escapeHtml(card.value)}</strong>
            </div>
            <small>${escapeHtml(card.note)}</small>
            ${Number.isFinite(Number(card.barValue)) ? `<div class="b2b-simple-meter" style="--meter:${Math.max(0, Math.min(100, Number(card.barValue)))}%"><i></i><em>${escapeHtml(card.meterLabel || `${Math.round(Number(card.barValue))}%`)}</em></div>` : ""}
          </article>
        `).join("")}
      </div>
      <div class="b2b-simple-next">
        <strong>다음 확인</strong>
        <div>
          ${model.actions.map((action) => `
            <button class="${escapeHtml(action.tone)}" type="button" data-drawer-tab="${escapeHtml(action.tab)}">
              <span>${escapeHtml(action.label)}</span>
              <small>${escapeHtml(action.detail)}</small>
            </button>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderB2BStrategyBoard(brief = b2bMarketBriefModel(), model = b2bStrategyBoardModel(brief)) {
  return `
    <div class="b2b-strategy-board ${escapeHtml(model.decision.tone)}">
      <div class="b2b-strategy-head">
        <div>
          <span>B2B Strategy Summary</span>
          <strong>경쟁 대응 우선순위</strong>
          <p>${escapeHtml(model.decision.summary)}</p>
        </div>
        <em>${escapeHtml(model.decision.label)}</em>
      </div>
      <div class="b2b-strategy-grid">
        ${model.cards.map((card) => `
          <article class="${escapeHtml(card.tone)}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(card.value)}</strong>
            <small>${escapeHtml(card.note)}</small>
          </article>
        `).join("")}
      </div>
      <div class="b2b-strategy-layout">
        <article class="b2b-strategy-actions">
          ${model.actionRows.map((row) => `
            <div class="${escapeHtml(row.tone)}">
              <mark>${escapeHtml(row.value)}</mark>
              <div>
                <strong>${escapeHtml(row.label)}</strong>
                <span>${escapeHtml(row.detail)}</span>
              </div>
              <button type="button" data-drawer-tab="${escapeHtml(row.tab)}">${escapeHtml(row.button)}</button>
            </div>
          `).join("")}
        </article>
        <article class="b2b-strategy-checklist">
          <div class="b2b-strategy-subhead">
            <strong>판단 체크</strong>
            <small>리포트를 읽을 때 우선 확인할 기준입니다.</small>
          </div>
          ${model.checklist.map((row) => `
            <div class="${escapeHtml(row.tone)}">
              <span>${escapeHtml(row.label)}</span>
              <strong>${escapeHtml(row.note)}</strong>
            </div>
          `).join("")}
        </article>
      </div>
    </div>
  `;
}

function b2bPublicOverviewModel(brief = b2bMarketBriefModel()) {
  const rankModel = b2bRankBoardModel();
  const items = state.data?.availability?.items || [];
  const nextDemand = demandNextMonthProjection(demandTrafficAggregate());
  const couponRows = items.filter((item) => naverCouponInfo(item).visible);
  const offlineRows = items.filter((item) => collectionStatusProfile(item).offlineEstimated);
  const revenueCoverageText = brief.revenueSampleCount
    ? `${fmtNumber(brief.revenueSampleCount)}개 표본${Number.isFinite(brief.revenueCoverage) ? ` · ${fmtRate(brief.revenueCoverage)}` : ""}`
    : "매출 표본 대기";
  const dataStatus = [
    { label: "분석 범위", value: `${fmtNumber(rankModel.rows.length || brief.itemCount)}곳`, note: "지정 검색범위 기준", tone: rankModel.rows.length ? "good" : "watch" },
    { label: "예약율 표본", value: brief.salesSampleCount ? `${fmtNumber(brief.salesSampleCount)}곳` : "대기", note: "네이버 플레이스 기준", tone: brief.salesSampleCount ? "good" : "watch" },
    { label: "매출 표본", value: brief.revenueSampleCount ? fmtNumber(brief.revenueSampleCount) : "대기", note: revenueCoverageText, tone: brief.revenueSampleCount ? "good" : "watch" },
    { label: "쿠폰 확인", value: fmtNumber(couponRows.length), note: couponRows.length ? "쿠폰명/노출 확인" : "자동 수집 제한", tone: couponRows.length ? "strong" : "neutral" }
  ];
  const actionRows = [
    {
      tone: "strong",
      label: "경쟁 매출",
      value: fmtNumber(brief.score),
      detail: "경쟁업체 예상 매출과 객실 판매율을 같은 기준으로 봅니다.",
      tab: "report",
      button: "매출 보기"
    },
    {
      tone: "watch",
      label: "노출 순위",
      value: `${fmtNumber(rankModel.rows.length)}개`,
      detail: "처음 지정한 검색 순위 범위 안에서 경쟁업체 노출을 비교합니다.",
      tab: "rank",
      button: "순위 보기"
    },
    {
      tone: "neutral",
      label: "경쟁 지도",
      value: `${fmtNumber(brief.regions.length)}권역`,
      detail: "지역 내·인접 경쟁권과 반경 노출 구조를 봅니다.",
      tab: "map",
      button: "지도 보기"
    },
    {
      tone: nextDemand.tone || "good",
      label: nextDemand.label || "다음달 검색량",
      value: nextDemand.value,
      detail: nextDemand.detailText || "기준년월 검색량에 작년 동월 트렌드 비율을 반영합니다.",
      tab: "demand",
      button: "전망 보기"
    }
  ];
  return {
    rankModel,
    dataStatus,
    actionRows,
    couponCount: couponRows.length,
    offlineCount: offlineRows.length
  };
}

function renderB2BPublicOverview(brief = b2bMarketBriefModel(), model = b2bPublicOverviewModel(brief)) {
  return `
    <div class="b2b-public-board">
      <article class="b2b-public-actions">
        <div class="report-card-head">
          <div>
            <h3>경쟁 리포트 구성</h3>
            <p>매출, 노출, 수요 전망을 기준으로 지역 경쟁상황을 봅니다.</p>
          </div>
          <span>${fmtNumber(model.actionRows.length)}개</span>
        </div>
        <div class="b2b-action-stack">
          ${model.actionRows.map((row) => `
            <div class="${escapeHtml(row.tone)}">
              <mark>${escapeHtml(row.value)}</mark>
              <div>
                <strong>${escapeHtml(row.label)}</strong>
                <span>${escapeHtml(row.detail)}</span>
              </div>
              <button type="button" data-drawer-tab="${escapeHtml(row.tab)}">${escapeHtml(row.button)}</button>
            </div>
          `).join("")}
        </div>
      </article>
      <article class="b2b-public-data">
        <div class="report-card-head">
          <div>
            <h3>데이터 상태</h3>
            <p>경쟁 리포트에 사용한 예약·매출·채널 표본 수준입니다.</p>
          </div>
          <span>${model.offlineCount ? `오프라인 ${fmtNumber(model.offlineCount)}개` : "표본 기준"}</span>
        </div>
        <div class="b2b-data-grid">
          ${model.dataStatus.map((row) => `
            <div class="${escapeHtml(row.tone)}">
              <span>${escapeHtml(row.label)}</span>
              <strong>${escapeHtml(row.value)}</strong>
              <small>${escapeHtml(row.note)}</small>
            </div>
          `).join("")}
        </div>
      </article>
    </div>
  `;
}

function renderB2BCompetitiveSnapshot(brief = b2bMarketBriefModel(), model = b2bCompetitiveSnapshotModel(brief)) {
  if (!model.rows.length) return "";
  return `
    <div class="b2b-competition-snapshot">
      <div class="report-card-head">
        <div>
          <h3>경쟁 매출·노출·수요 스냅샷</h3>
          <p>고객이 바로 확인해야 하는 상위 경쟁업체의 예상 매출, 노출 순위, 판매율, 월별 검색량입니다.</p>
        </div>
        <span>${escapeHtml(model.range || "기간 확인")}</span>
      </div>
      <div class="b2b-snapshot-grid">
        ${model.cards.map((card) => `
          <article class="${escapeHtml(card.tone)}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(card.value)}</strong>
            <small>${escapeHtml(card.note)}</small>
          </article>
        `).join("")}
      </div>
      <div class="b2b-snapshot-layout">
        <article class="b2b-snapshot-list">
          <div class="b2b-snapshot-subhead">
            <strong>상위 노출 경쟁업체</strong>
            <small>업체를 누르면 예약·가격·요일별 판매 상세로 이동합니다.</small>
          </div>
          ${model.rows.map((row) => {
            const buttonAttrs = row.itemIndex >= 0
              ? `type="button" data-open-company="${row.itemIndex}"`
              : `type="button" disabled`;
            return `
              <button class="b2b-snapshot-row ${escapeHtml(row.tone)}" ${buttonAttrs}>
                <span>${escapeHtml(row.rankText)}</span>
                <strong>${escapeHtml(row.name)}</strong>
                <em>${escapeHtml(row.revenueText)}</em>
                <small>${escapeHtml(row.meta)}</small>
              </button>
            `;
          }).join("")}
        </article>
        <article class="b2b-snapshot-read">
          <div class="b2b-snapshot-subhead">
            <strong>고객용 해석</strong>
            <small>영업 후보가 아니라 지역 경쟁 리포트 관점으로 표시합니다.</small>
          </div>
          ${model.insights.map((row) => `
            <div>
              <b>${escapeHtml(row.label)}</b>
              <span>${escapeHtml(row.value)}</span>
            </div>
          `).join("")}
        </article>
      </div>
    </div>
  `;
}

function renderB2BMarketBrief(brief = b2bMarketBriefModel()) {
  const regionLabel = brief.topRegion.region || brief.topRegion.name || "지역 데이터 대기";
  const primary = brief.topRegion ? regionPrimary(brief.topRegion) : "";
  const overviewModel = b2bPublicOverviewModel(brief);
  const snapshotModel = b2bCompetitiveSnapshotModel(brief);
  const revenueModel = b2bRevenueBenchmarkModel(brief);
  const strategyModel = b2bStrategyBoardModel(brief, revenueModel);
  const correlationModel = b2bCompetitionSalesCorrelationModel(snapshotModel.rankModel);
  const simpleModel = b2bSimpleSummaryModel(brief, strategyModel, revenueModel, snapshotModel);
  const myLodgeModel = b2bMyLodgeBenchmarkModel(brief, revenueModel);
  const rankRange = effectiveDetailRankRange(brief.run);
  const rankRangeLabel = rankRange === "상세 생략" ? rankRange : `${rankRange}위`;
  return `
    <section class="b2b-brief-card b2b-report-first">
      <div class="b2b-brief-head">
        <div>
          <span class="report-badge ${escapeHtml(brief.decision.tone)}">리포트 요약</span>
          <h3>${escapeHtml(brief.keyword)} 경쟁 현황</h3>
          <p>${escapeHtml("지정 검색범위 안의 경쟁지표, 실제 예약율, 예상 평균 매출, 월별 예상 검색량만 먼저 보여줍니다.")}</p>
        </div>
        <div class="b2b-brief-score">
          <span>분석 기준</span>
          <strong>${fmtNumber(brief.score)}점</strong>
          <small>${escapeHtml(`${brief.range} · ${rankRangeLabel}`)}</small>
        </div>
      </div>
      ${renderB2BSimpleSummary(brief, simpleModel)}
      ${renderB2BMyLodgeBenchmark(brief, myLodgeModel)}
      <details class="b2b-detail-pack">
        <summary>
          <span>분석 근거 펼치기</span>
          <small>매출 표본, 노출 경쟁, 데이터 상태는 필요할 때만 확인</small>
        </summary>
        <div class="b2b-detail-pack-body">
          <div class="b2b-brief-metrics">
            <article><span>예상 평균 매출</span><strong>${fmtWon(brief.averageRevenue)}</strong><small>${escapeHtml(brief.revenueNote)}</small></article>
            <article><span>경쟁업체</span><strong>${fmtNumber(brief.itemCount)}</strong><small>상위 노출 표본</small></article>
            <article><span>객실 판매율</span><strong>${fmtRate(brief.rate)}</strong><small>${fmtNumber(brief.sold)}/${fmtNumber(brief.supply)} 객실</small></article>
            <article><span>수요 전망</span><strong>${fmtNumber(brief.searchVolume)}</strong><small>${escapeHtml(regionLabel)} · ${escapeHtml(primary || "권역 확인")}</small></article>
          </div>
          ${renderB2BStrategyBoard(brief, strategyModel)}
          ${renderB2BCompetitiveSnapshot(brief, snapshotModel)}
          ${renderB2BCompetitionSalesCorrelation(correlationModel)}
          ${renderB2BRevenueBenchmark(brief, revenueModel)}
          <div class="b2b-brief-grid">
            <article class="b2b-insight-panel">
              <div class="report-card-head">
                <div>
                  <h3>경쟁 해석</h3>
                  <p>경쟁업체의 예약율, 매출 표본, 상품 구성을 고객 관점으로 요약합니다.</p>
                </div>
              </div>
              <div class="report-insight-list">
                <div><b>판매 흐름</b><span>${Number.isFinite(brief.rate) ? `${fmtRate(brief.rate)} 판매` : "확인 필요"}</span></div>
                <div><b>예약 표본</b><span>${fmtNumber(brief.salesSampleCount)}개 업체</span></div>
                <div><b>상품 구성</b><span>${fmtNumber(brief.dayUseGapCount)}개 업체 데이유즈/캠프닉 미확인</span></div>
                <div><b>채널 표본</b><span>${fmtNumber(brief.platformStats.otaCheckCount || 0)}개 업체 OTA 비교 기준</span></div>
              </div>
            </article>
            <article class="b2b-insight-panel">
              <div class="report-card-head">
                <div>
                  <h3>데이터 범위</h3>
                  <p>경쟁 리포트에 사용한 예약, 매출, 채널 보조 신호입니다.</p>
                </div>
              </div>
              <div class="report-insight-list">
                ${overviewModel.dataStatus.map((row) => `
                  <div><b>${escapeHtml(row.label)}</b><span>${escapeHtml(row.value)} · ${escapeHtml(row.note)}</span></div>
                `).join("")}
              </div>
            </article>
          </div>
          ${renderB2BPublicOverview(brief, overviewModel)}
        </div>
      </details>
    </section>
  `;
}

function renderB2BPreSearchMyLodge() {
  const emptyData = {
    run: state.data?.run || {},
    availability: { items: [], stats: {} },
    regions: []
  };
  const brief = b2bMarketBriefModel(emptyData);
  const revenueModel = b2bRevenueBenchmarkModel(brief, emptyData);
  const myLodgeModel = b2bMyLodgeBenchmarkModel(brief, revenueModel);
  return `
    <section class="b2b-brief-card b2b-report-first">
      <div class="report-card-head">
        <div>
          <h3>관심숙소 등록</h3>
          <p>검색 전에도 관심숙소를 먼저 등록할 수 있습니다. 이후 지역을 검색하면 등록한 숙소를 지역 평균·상위권·하위권 매출 표본과 비교합니다.</p>
        </div>
        <span>계정 저장</span>
      </div>
      ${renderB2BMyLodgeBenchmark(brief, myLodgeModel, revenueModel)}
    </section>
  `;
}

function renderReport() {
  if (!els.reportBody) return;
  const data = state.data || {};
  const run = data.run || {};
  const items = data.availability?.items || [];
  if (!items.length) {
    els.reportBody.innerHTML = isAdminRole()
      ? `<div class="empty">요약할 수집 결과가 없습니다. 관리 탭에서 새 수집을 실행하세요.</div>`
      : renderB2BPreSearchMyLodge();
    return;
  }

  const sales = summarizeSales(items);
  const rate = sales.supply ? sales.sold / sales.supply : finiteNumber(data.availability?.stats?.weightedSoldOutRate, NaN);
  const publicMode = !isAdminRole();
  const targets = publicMode ? [] : targetEntries(8);
  const allTargets = publicMode ? [] : targetEntries(0);
  const platformStats = reportPlatformStats(items);
  const searchVolume = (data.regions || []).reduce((sum, region) => sum + finiteNumber(region.traffic?.totalSearchVolume, 0), 0);
  const platformGapRatio = platformStats.otaCheckCount ? (platformStats.missingYeogi + platformStats.missingYanolja + platformStats.missingDdnayo) / (platformStats.otaCheckCount * 3) : 0;
  const score = reportMarketScore({
    rate,
    targetCount: allTargets.length,
    itemCount: items.length,
    platformGapRatio,
    searchVolume
  });
  const decision = reportDecision(score, rate, allTargets.length);
  const dayUseCount = items.filter((item) => salesStats(item, "day").supply > 0).length;
  const lowSalesCount = items.filter((item) => {
    const lodging = salesStats(item, "lodging");
    return Number.isFinite(lodging.rate) && lodging.rate < 0.25;
  }).length;
  const regions = (data.regions || []).slice(0, 4);
  const keyword = activeKeyword();
  const range = dateRangeLabel(run);
  const b2bBrief = publicMode ? b2bMarketBriefModel(data) : null;
  const heroDecision = publicMode && b2bBrief ? b2bBrief.decision : decision;
  const heroScore = publicMode && b2bBrief ? b2bBrief.score : score;
  const heroTitle = publicMode ? `${keyword} 지역 경쟁 리포트` : `${keyword} 시장 브리핑`;
  const heroCopy = publicMode
    ? `${range} 리포트로 지역 내 경쟁업체의 네이버 노출, 예상 매출, 판매율, 상품 구성, 월별 검색량을 함께 비교합니다.`
    : `${range} 입력기간 기준으로 네이버 노출, 객실 판매율, OTA 보조 확인, 상품 구성을 함께 판정했습니다.`;
  const reportActionTitle = publicMode ? "경쟁 리포트 체크포인트" : "이번 주 액션";
  const reportActionSubtitle = publicMode ? "지역 경쟁상황을 판단할 핵심 범위" : "먼저 확인해야 할 영업/운영 과제";
  const reportActionItems = publicMode
    ? [
      {
        title: "경쟁업체 노출 확인",
        detail: `상위 노출 경쟁업체 ${fmtNumber(items.length)}개 · 예약 수량 ${fmtNumber(sales.supply)}개 기준`
      },
      {
        title: "매출과 판매율 비교",
        detail: `예상 평균 매출 ${b2bBrief ? fmtWon(b2bBrief.averageRevenue) : "표본 대기"} · 객실 판매율 ${fmtRate(rate)}`
      },
      {
        title: "수요 전망 확인",
        detail: `${fmtNumber(regions.length)}개 권역 · 검색수요 ${searchVolume ? `월 ${fmtNumber(searchVolume)}회` : "API 확인필요"}`
      }
    ]
    : [
      {
        title: "OTA 색인 업체만 보조 채널 확인",
        detail: `색인 ${fmtNumber(platformStats.otaCheckCount || 0)}개 · 여기어때 ${fmtNumber(platformStats.missingYeogi)}개, 야놀자 ${fmtNumber(platformStats.missingYanolja)}개 확인`
      },
      {
        title: "객실 판매율 낮은 업체 상품 재구성",
        detail: `저판매 ${fmtNumber(lowSalesCount)}개, 가격/패키지/캠프닉 점검`
      },
      {
        title: "데이유즈/캠프닉 공백 제안",
        detail: `${fmtNumber(items.length - dayUseCount)}개 업체는 당일상품 확인 필요`
      }
    ];

  els.reportBody.innerHTML = `
    <section class="report-hero">
      <div class="report-hero-copy">
        <span class="report-badge ${escapeHtml(heroDecision.tone)}">${escapeHtml(heroDecision.label)}</span>
        <h2>${escapeHtml(heroTitle)}</h2>
        <p>${escapeHtml(heroCopy)}</p>
      </div>
      <div class="report-score-card">
        <span>${publicMode ? "경쟁 지표" : "공략 매력도"}</span>
        <strong>${fmtNumber(heroScore)}</strong>
        <small>${escapeHtml(heroDecision.summary)}</small>
      </div>
    </section>

    ${publicMode ? renderB2BMarketBrief(b2bBrief) : ""}

    <section class="report-metric-grid ${publicMode ? "b2b-legacy-detail" : ""}" aria-label="보고서 핵심 지표">
      <article>
        <span>객실 판매율</span>
        <strong>${fmtRate(rate)}</strong>
        <small>${fmtNumber(sales.sold)}/${fmtNumber(sales.supply)}개 추정</small>
      </article>
      <article>
        <span>${publicMode ? "경쟁업체" : "분석 업체"}</span>
        <strong>${fmtNumber(items.length)}</strong>
        <small>상위 노출 기준</small>
      </article>
      <article>
        <span>${publicMode ? "예약 표본" : "컨택 후보"}</span>
        <strong>${fmtNumber(publicMode && b2bBrief ? b2bBrief.salesSampleCount : allTargets.length)}</strong>
        <small>${publicMode ? "예약율 산출 가능" : "판매흐름/상품 약점 감지"}</small>
      </article>
      <article>
        <span>${publicMode ? "상품 구성" : "상품 공백"}</span>
        <strong>${fmtNumber(items.length - dayUseCount)}</strong>
        <small>${publicMode ? "데이유즈/캠프닉 표본" : "데이유즈/캠프닉 미확인"}</small>
      </article>
    </section>

    <section class="report-layout ${publicMode ? "b2b-legacy-detail" : ""}">
      <article class="report-card market">
        <div class="report-card-head">
          <div>
            <h3>${publicMode ? "경쟁 해석" : "시장 해석"}</h3>
            <p>${publicMode ? "경쟁업체 판매율, 채널 표본, 상품 구성으로 본 지역 시장 위치" : "판매율, OTA 보조 확인, 상품 구성으로 본 영업 우선순위"}</p>
          </div>
          <span>${fmtNumber(bookingDays(run))}일 기준</span>
        </div>
        <div class="report-insight-list">
          <div><b>판매 강도</b><span>${Number.isFinite(rate) ? `${fmtRate(rate)} 객실 판매율` : "확인필요"}</span></div>
          <div><b>${publicMode ? "예약 표본" : "저판매 후보"}</b><span>${publicMode && b2bBrief ? `${fmtNumber(b2bBrief.salesSampleCount)}개 업체` : `${fmtNumber(lowSalesCount)}개 업체`}</span></div>
          <div><b>검색 수요</b><span>${searchVolume ? `월 ${fmtNumber(searchVolume)}회` : "API 확인필요"}</span></div>
          <div><b>${publicMode ? "상품 구성" : "상품 확장"}</b><span>${fmtNumber(dayUseCount)}개 업체 데이유즈/캠프닉 확인</span></div>
        </div>
      </article>

      <article class="report-card">
        <div class="report-card-head">
          <div>
            <h3>${publicMode ? "경쟁 채널 표본" : "OTA 보조 확인"}</h3>
            <p>${publicMode ? "경쟁업체별 네이버와 보조 채널 노출 현황" : "의심 업체 기준 보조 채널 현황"}</p>
          </div>
        </div>
        <div class="report-channel-grid">
          ${platformStats.names.map((name) => `
            <div>
              <span>${escapeHtml(name)}</span>
              <strong>${fmtNumber(platformStats.counts[name])}</strong>
              <small>${name === "네이버" ? "기준 채널" : `${fmtNumber(Math.max(0, (platformStats.otaCheckCount || 0) - (platformStats.otaCounts[name] || 0)))}개 보조확인`}</small>
            </div>
          `).join("")}
        </div>
      </article>

      <article class="report-card report-action-card">
        <div class="report-card-head">
          <div>
            <h3>${reportActionTitle}</h3>
            <p>${reportActionSubtitle}</p>
          </div>
        </div>
        <ol class="report-action-list">
          ${reportActionItems.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></li>`).join("")}
        </ol>
      </article>
    </section>

    ${publicMode ? "" : `<section class="report-card report-target-preview">
      <div class="report-card-head">
        <div>
          <h3>우선 컨택 후보</h3>
          <p>노출은 있으나 판매 흐름과 상품 구성이 약한 업체</p>
        </div>
        <button class="small-button" type="button" data-drawer-tab="target">전체 보기</button>
      </div>
      <div class="report-target-list">
        ${targets.length ? targets.slice(0, 5).map(({ item, reasons }, index) => {
          const lodging = salesStats(item, "lodging");
          const itemIndex = items.indexOf(item);
          return `
            <button class="report-target-row" type="button" data-open-company="${itemIndex}">
              <span>${index + 1}</span>
              <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
              <em>${fmtRate(lodging.rate)}</em>
              <small>${reasons.map(escapeHtml).join(" · ")}</small>
            </button>
          `;
        }).join("") : `<div class="empty">우선 컨택 후보가 없습니다.</div>`}
      </div>
    </section>`}

    <section class="report-card report-region-preview ${publicMode ? "b2b-legacy-detail" : ""}">
      <div class="report-card-head">
        <div>
          <h3>${publicMode ? "지역 경쟁 구조" : "지역 클러스터 요약"}</h3>
          <p>${publicMode ? "지역 내·인접 경쟁권과 관광 앵커 기준" : "관광 앵커와 인접 수요권 기준"}</p>
        </div>
        <button class="small-button" type="button" data-drawer-tab="map">지도 보기</button>
      </div>
      <div class="report-region-grid">
        ${regions.length ? regions.map((region) => {
          const primary = regionPrimary(region);
          const traffic = region.traffic || {};
          return `
            <div>
              <span style="background:${CORE_COLORS[primary] || CORE_COLORS["확인필요"]}"></span>
              <strong>${escapeHtml(region.region || region.name || "지역")}</strong>
              <small>${escapeHtml(primary)} · 월검색 ${fmtNumber(traffic.totalSearchVolume || 0)}</small>
            </div>
          `;
        }).join("") : `<div class="empty">지역 클러스터 데이터가 없습니다.</div>`}
      </div>
    </section>
  `;
}

function demandTrafficAggregate() {
  const statsTraffic = state.data?.stats?.traffic || {};
  if (statsTraffic.totalSearchVolume || statsTraffic.collectableCount) return statsTraffic;
  return (state.data?.regions || []).reduce((aggregate, region) => {
    const traffic = region.traffic || {};
    aggregate.keywordCount += 1;
    if (!traffic.collectable) return aggregate;
    aggregate.collectableCount += 1;
    aggregate.monthlyPc += finiteNumber(traffic.monthlyPc, 0);
    aggregate.monthlyMobile += finiteNumber(traffic.monthlyMobile, 0);
    aggregate.totalSearchVolume += finiteNumber(traffic.totalSearchVolume, 0);
    aggregate.totalClicks += finiteNumber(traffic.totalClicks, 0);
    aggregate.combinedCtr = aggregate.totalSearchVolume
      ? Number(((aggregate.totalClicks / aggregate.totalSearchVolume) * 100).toFixed(2))
      : null;
    return aggregate;
  }, {
    keywordCount: 0,
    collectableCount: 0,
    monthlyPc: 0,
    monthlyMobile: 0,
    totalSearchVolume: 0,
    totalClicks: 0,
    combinedCtr: null
  });
}

function demandTrendSource() {
  const candidates = [
    state.data?.datalabTrend,
    state.data?.stats?.datalabTrend,
    state.data?.trend,
    state.data?.stats?.trend
  ].filter(Boolean);
  const source = candidates.find((entry) => Array.isArray(entry.series) || Array.isArray(entry.data));
  const rawSeries = source ? (source.series || source.data || []) : [];
  const series = rawSeries.map((entry, index) => {
    const rawLabel = entry.month || entry.period || entry.date || `${index + 1}월`;
    const value = Number(entry.ratio ?? entry.value ?? entry.score);
    const period = trendPeriodInfo(rawLabel, index);
    return {
      label: period.label,
      year: period.year,
      month: period.month,
      periodLabel: period.periodLabel,
      rawLabel: String(rawLabel),
      value: Number.isFinite(value) ? value : null
    };
  }).filter((entry) => entry.label);
  return {
    configured: Boolean(state.trafficKeyState?.datalabConfigured || source?.configured),
    hasSeries: series.some((entry) => Number.isFinite(entry.value)),
    series,
    status: source?.status || null,
    reason: source?.reason || "",
    collectable: source?.collectable,
    keyword: source?.keyword || source?.rawTitle || activeKeyword(),
    collectedAt: source?.collectedAt || "",
    cacheHit: Boolean(source?.cache?.hit),
    cachePolicy: source?.cache?.policy || "",
    cacheStartDate: source?.cache?.startDate || source?.startDate || "",
    cacheEndDate: source?.cache?.endDate || source?.endDate || "",
    observationCount: source?.cache?.observationCount || null,
    firstCollectedAt: source?.cache?.firstCollectedAt || "",
    lastCollectedAt: source?.cache?.lastCollectedAt || "",
    lastUsedAt: source?.cache?.lastUsedAt || ""
  };
}

function trendPeriodInfo(value, index = 0) {
  const text = String(value || "").trim();
  const yearMonth = text.match(/^(\d{4})[-./년\s]*0?(\d{1,2})/);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    if (month >= 1 && month <= 12) {
      return {
        year,
        month,
        label: `${year}.${String(month).padStart(2, "0")}`,
        periodLabel: `${year}년 ${month}월`
      };
    }
  }
  const monthMatch = text.match(/0?(\d{1,2})월?/);
  if (monthMatch) {
    const month = Number(monthMatch[1]);
    if (month >= 1 && month <= 12) {
      return {
        year: null,
        month,
        label: `${month}월`,
        periodLabel: `${month}월`
      };
    }
  }
  const fallbackMonth = ((index % 12) + 1);
  return {
    year: null,
    month: fallbackMonth,
    label: `${fallbackMonth}월`,
    periodLabel: `${fallbackMonth}월`
  };
}

function trendMonthLabel(value, index = 0) {
  return trendPeriodInfo(value, index).label;
}

function trendIndexLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, "");
}

function trendAxisLabel(entry = {}) {
  const month = Number(entry.month) || trendMonthNumber(entry.label || entry.rawLabel || "");
  return Number.isFinite(month) ? `${month}월` : String(entry.label || "").replace(/^\d{4}[.-]/, "");
}

function trendShortPeriodLabel(entry = {}, fallbackMonth = NaN) {
  const month = Number(entry?.month) || trendMonthNumber(entry?.label || entry?.rawLabel || "") || Number(fallbackMonth);
  const year = Number(entry?.year);
  if (Number.isFinite(year) && Number.isFinite(month)) return `${String(year).slice(-2)}.${String(month).padStart(2, "0")}`;
  if (Number.isFinite(month)) return `${fmtNumber(month)}월`;
  return "기준월";
}

function trendLongPeriodLabel(entry = {}, fallbackMonth = NaN) {
  const month = Number(entry?.month) || trendMonthNumber(entry?.label || entry?.rawLabel || "") || Number(fallbackMonth);
  const year = Number(entry?.year);
  if (Number.isFinite(year) && Number.isFinite(month)) return `${year}년 ${fmtNumber(month)}월`;
  if (Number.isFinite(month)) return `${fmtNumber(month)}월`;
  return "기준월";
}

function demandInferredYearForMonth(month = NaN) {
  const number = Number(month);
  if (!Number.isFinite(number)) return NaN;
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  return number > currentMonth ? now.getFullYear() - 1 : now.getFullYear();
}

function demandPeriodFromEntry(entry = {}, fallbackMonth = NaN) {
  const month = Number(entry?.month) || trendMonthNumber(entry?.label || entry?.rawLabel || "") || Number(fallbackMonth);
  const year = Number(entry?.year);
  if (!Number.isFinite(month)) return { year: NaN, month: NaN };
  return {
    year: Number.isFinite(year) ? year : demandInferredYearForMonth(month),
    month
  };
}

function demandShiftPeriod(period = {}, offset = 0, fallbackMonth = NaN) {
  const month = Number(period.month) || Number(fallbackMonth);
  if (!Number.isFinite(month)) return { year: NaN, month: NaN };
  const year = Number(period.year);
  if (!Number.isFinite(year)) {
    const shiftedMonth = ((month - 1 + offset) % 12 + 12) % 12 + 1;
    return { year: NaN, month: shiftedMonth };
  }
  const total = year * 12 + (month - 1) + offset;
  return {
    year: Math.floor(total / 12),
    month: (total % 12) + 1
  };
}

function demandPeriodShortLabel(period = {}, fallback = "기준월") {
  const year = Number(period.year);
  const month = Number(period.month);
  if (Number.isFinite(year) && Number.isFinite(month)) return `${String(year).slice(-2)}.${String(month).padStart(2, "0")}`;
  if (Number.isFinite(month)) return `${fmtNumber(month)}월`;
  return fallback;
}

function demandPeriodLongLabel(period = {}, fallback = "기준월") {
  const year = Number(period.year);
  const month = Number(period.month);
  if (Number.isFinite(year) && Number.isFinite(month)) return `${year}년 ${fmtNumber(month)}월`;
  if (Number.isFinite(month)) return `${fmtNumber(month)}월`;
  return fallback;
}

function trendLineChart(series, trend) {
  const width = 640;
  const height = 220;
  const padX = 28;
  const padTop = 34;
  const padBottom = 34;
  const baseline = height - padBottom;
  const chartHeight = baseline - padTop;
  const numericValues = series.map((entry) => Number(entry.value)).filter(Number.isFinite);
  const max = Math.max(100, ...numericValues);
  const count = Math.max(1, series.length - 1);
  const points = series.map((entry, index) => {
    const value = Number(entry.value);
    const hasValue = Number.isFinite(value);
    const x = padX + ((width - padX * 2) * index) / count;
    const y = hasValue ? baseline - Math.max(0, Math.min(1, value / max)) * chartHeight : baseline;
    return { ...entry, index, value, hasValue, x, y };
  });
  const validPoints = points.filter((point) => point.hasValue);
  const linePoints = validPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const areaPoints = validPoints.length >= 2
    ? `${validPoints[0].x.toFixed(1)},${baseline} ${linePoints} ${validPoints[validPoints.length - 1].x.toFixed(1)},${baseline}`
    : "";
  const gridLines = [0, 25, 50, 75, 100].map((value) => {
    const y = baseline - (value / 100) * chartHeight;
    return `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${width - padX}" y2="${y.toFixed(1)}"></line>`;
  }).join("");

  return `
    <div class="trend-line-chart ${trend.hasSeries ? "" : "pending"}" style="--trend-count:${series.length}">
      <div class="trend-line-values">
        ${points.map((point) => `<span>${point.hasValue ? escapeHtml(trendIndexLabel(point.value)) : "-"}</span>`).join("")}
      </div>
      <svg class="trend-line-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="월별 네이버 데이터랩 상대지수">
        <g class="trend-grid">${gridLines}</g>
        ${areaPoints ? `<polygon class="trend-line-area" points="${areaPoints}"></polygon>` : ""}
        ${linePoints ? `<polyline class="trend-line-path" points="${linePoints}"></polyline>` : ""}
        <g class="trend-points">
          ${points.map((point) => {
            const title = point.hasValue
              ? `${point.label} 상대지수 ${trendIndexLabel(point.value)}`
              : `${point.label} 데이터 대기`;
            return `
              <g class="trend-point ${point.hasValue ? "" : "missing"}" title="${escapeHtml(title)}">
                <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${point.hasValue ? 5 : 4}"></circle>
              </g>
            `;
          }).join("")}
        </g>
      </svg>
      <div class="trend-line-axis">
        ${points.map((point) => `<span title="${escapeHtml(point.periodLabel || point.label)}">${escapeHtml(trendAxisLabel(point))}</span>`).join("")}
      </div>
    </div>
  `;
}

function demandTrendChart() {
  const trend = demandTrendSource();
  const fallbackMonths = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];
  const series = trend.series.length ? trend.series.slice(-12) : fallbackMonths.map((label) => ({ label, value: null }));
  const errorLabel = Number(trend.status) === 401 ? "인증 실패" : "API 오류";
  const validMonthCount = series.filter((entry) => Number.isFinite(Number(entry.value))).length;
  const statusLabel = trend.reason
    ? errorLabel
    : trend.hasSeries
      ? `${trend.cacheHit ? "동일 기준일 캐시" : "연동 정상"} · ${fmtNumber(validMonthCount)}개월`
      : (trend.configured ? "연동 대기" : "API 키 필요");
  const cacheBasis = trend.cacheHit && trend.cacheEndDate
    ? ` · 기준일 ${trend.cacheEndDate}`
    : "";
  const detailLabel = trend.hasSeries
    ? `최고점=100 기준 · ${trend.keyword || activeKeyword()}${cacheBasis}${trend.collectedAt ? ` · ${compactDateTime(trend.collectedAt)}` : ""}`
    : trend.reason
      ? trend.reason
      : "데이터랩 API 연동 후 12개월 추세 표시";
  return `
    <div class="demand-chart ${trend.hasSeries ? "" : "pending"}">
      <div class="demand-chart-head">
        <div>
          <strong>네이버 트렌드 상대지수</strong>
          <small>${escapeHtml(detailLabel)}</small>
        </div>
        <span>${escapeHtml(statusLabel)}</span>
      </div>
      ${trendLineChart(series, trend)}
    </div>
  `;
}

function demandMobileShare(traffic = {}) {
  const mobile = finiteNumber(traffic.monthlyMobile, 0);
  const total = finiteNumber(traffic.totalSearchVolume, 0);
  return total ? mobile / total : NaN;
}

function demandTrendLabel() {
  const trend = demandTrendSource();
  if (trend.reason) return Number(trend.status) === 401 ? "인증 실패" : "API 오류";
  if (!trend.hasSeries) return "연동 대기";
  const values = trend.series.map((entry) => Number(entry.value)).filter(Number.isFinite);
  if (values.length < 2) return "확인";
  const first = values[0];
  const last = values[values.length - 1];
  const change = first ? (last - first) / first : 0;
  if (change >= 0.15) return `상승 ${formatSignedRate(change)}`;
  if (change <= -0.15) return `하락 ${formatSignedRate(change)}`;
  return "변동 작음";
}

function averageTrendValue(entries = []) {
  const values = entries.map((entry) => Number(entry.value)).filter(Number.isFinite);
  if (!values.length) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function demandTrendStats(trend = demandTrendSource()) {
  const valid = trend.series
    .map((entry, index) => ({ ...entry, index, value: Number(entry.value) }))
    .filter((entry) => Number.isFinite(entry.value));
  const first = valid[0] || null;
  const last = valid[valid.length - 1] || null;
  const peak = valid.reduce((best, entry) => !best || entry.value > best.value ? entry : best, null);
  const low = valid.reduce((best, entry) => !best || entry.value < best.value ? entry : best, null);
  const recent = valid.slice(-3);
  const previous = valid.slice(-6, -3);
  const recentAvg = averageTrendValue(recent);
  const previousAvg = averageTrendValue(previous);
  const recentChange = Number.isFinite(recentAvg) && Number.isFinite(previousAvg) && previousAvg
    ? (recentAvg - previousAvg) / previousAvg
    : NaN;
  const overallChange = first && last && first.value
    ? (last.value - first.value) / first.value
    : NaN;
  const peakRatio = peak && last && peak.value
    ? last.value / peak.value
    : NaN;
  return {
    valid,
    first,
    last,
    peak,
    low,
    recentAvg,
    previousAvg,
    recentChange,
    overallChange,
    peakRatio
  };
}

function demandTrendEntryForMonth(trend = demandTrendSource(), monthNumber = NaN) {
  const month = Number(monthNumber);
  if (!Number.isFinite(month)) return null;
  const rows = (trend.series || [])
    .map((entry, index) => ({ ...entry, index, value: Number(entry.value), month: Number(entry.month) || trendMonthNumber(entry.label) }))
    .filter((entry) => entry.month === month && Number.isFinite(entry.value));
  return rows[rows.length - 1] || null;
}

function demandSeasonalTrendEntryForMonth(trend = demandTrendSource(), monthNumber = NaN, beforeIndex = NaN) {
  const month = Number(monthNumber);
  if (!Number.isFinite(month)) return null;
  const rows = (trend.series || [])
    .map((entry, index) => ({ ...entry, index, value: Number(entry.value), month: Number(entry.month) || trendMonthNumber(entry.label) }))
    .filter((entry) => entry.month === month && Number.isFinite(entry.value));
  if (!rows.length) return null;
  const priorRows = Number.isFinite(beforeIndex)
    ? rows.filter((entry) => entry.index < beforeIndex)
    : [];
  return priorRows[priorRows.length - 1] || rows[rows.length - 1] || null;
}

function demandNextMonthProjection(traffic = demandTrafficAggregate(), trend = demandTrendSource(), stats = demandTrendStats(trend)) {
  const currentVolume = finiteNumber(traffic.totalSearchVolume, 0);
  const fallbackDate = new Date();
  const fallbackBaseMonth = fallbackDate.getMonth() === 0 ? 12 : fallbackDate.getMonth();
  const currentEntry = stats.last || demandTrendEntryForMonth(trend, fallbackBaseMonth);
  const currentMonth = Number(currentEntry?.month) || trendMonthNumber(currentEntry?.label) || fallbackBaseMonth;
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
  const nextEntry = demandSeasonalTrendEntryForMonth(trend, nextMonth, currentEntry?.index);
  const basePeriod = demandPeriodFromEntry(currentEntry, currentMonth);
  const targetPeriod = demandShiftPeriod(basePeriod, 1, nextMonth);
  const baseShortLabel = demandPeriodShortLabel(basePeriod, trendShortPeriodLabel(currentEntry, currentMonth));
  const targetShortLabel = demandPeriodShortLabel(targetPeriod, trendShortPeriodLabel(nextEntry, nextMonth));
  const baseLongLabel = demandPeriodLongLabel(basePeriod, trendLongPeriodLabel(currentEntry, currentMonth));
  const targetLongLabel = demandPeriodLongLabel(targetPeriod, trendLongPeriodLabel(nextEntry, nextMonth));
  let factor = 1;
  let basis = "기준년월 검색량 유지";
  let detail = "";
  let hasTrendBasis = false;

  if (trend.reason) {
    basis = trend.reason;
  } else if (
    trend.hasSeries &&
    currentEntry &&
    nextEntry &&
    Number.isFinite(currentEntry.value) &&
    currentEntry.value > 0 &&
    Number.isFinite(nextEntry.value)
  ) {
    factor = nextEntry.value / currentEntry.value;
    basis = `${baseShortLabel} 검색량 × ${targetShortLabel}/${baseShortLabel} 트렌드 비율`;
    detail = `트렌드 지수 ${trendIndexLabel(currentEntry.value)}→${trendIndexLabel(nextEntry.value)} · 계절비율 ${factor.toFixed(2).replace(/\.00$/, "")}`;
    hasTrendBasis = true;
  } else if (trend.hasSeries && Number.isFinite(stats.recentChange)) {
    const bounded = Math.max(-0.35, Math.min(0.35, stats.recentChange));
    factor = 1 + bounded;
    basis = "최근 3개월 추세 보정";
    detail = `최근 ${formatSignedRate(bounded)}`;
    hasTrendBasis = true;
  } else if (trend.hasSeries && Number.isFinite(stats.overallChange)) {
    const bounded = Math.max(-0.25, Math.min(0.25, stats.overallChange / 3));
    factor = 1 + bounded;
    basis = "12개월 추세 보정";
    detail = `연간 ${formatSignedRate(stats.overallChange)}`;
    hasTrendBasis = true;
  }

  const change = Number.isFinite(factor) ? factor - 1 : NaN;
  const projectedVolume = currentVolume && hasTrendBasis && Number.isFinite(factor)
    ? Math.max(0, Math.round(currentVolume * Math.max(0, factor)))
    : 0;
  const tone = trend.reason
    ? "watch"
    : Number.isFinite(change) && change >= 0.12
      ? "strong"
      : Number.isFinite(change) && change <= -0.12
        ? "watch"
        : "good";
  return {
    currentVolume,
    projectedVolume,
    change,
    currentMonth,
    nextMonth,
    basePeriod,
    targetPeriod,
    baseMonthLabel: baseShortLabel,
    targetMonthLabel: targetShortLabel,
    basePeriodLabel: baseLongLabel,
    targetPeriodLabel: targetLongLabel,
    currentEntry,
    nextEntry,
    basis,
    detail,
    hasTrendBasis,
    tone,
    label: `${targetShortLabel} 예상 검색량`,
    value: projectedVolume ? `${fmtNumber(projectedVolume)}회` : (currentVolume ? "트렌드 대기" : "검색량 대기"),
    note: currentVolume
      ? (hasTrendBasis
        ? `${baseShortLabel} 검색량 ${fmtNumber(currentVolume)}회 · ${targetShortLabel} 예상 ${Number.isFinite(change) ? formatSignedRate(change) : "확인"}`
        : `${baseShortLabel} 검색량 ${fmtNumber(currentVolume)}회 · 트렌드 보정 대기`)
      : "검색광고 월검색량 대기",
    detailText: [detail, basis].filter(Boolean).join(" · ")
  };
}

function demandPreviousTrendEntry(trend = demandTrendSource(), stats = demandTrendStats(trend), currentEntry = null, currentMonth = NaN) {
  const currentIndex = Number(currentEntry?.index);
  if (Number.isFinite(currentIndex)) {
    const previousByIndex = (stats.valid || []).filter((entry) => entry.index < currentIndex).slice(-1)[0] || null;
    if (previousByIndex) return previousByIndex;
  }
  const month = Number(currentMonth);
  const previousMonth = Number.isFinite(month) ? (month === 1 ? 12 : month - 1) : NaN;
  return demandSeasonalTrendEntryForMonth(trend, previousMonth, currentIndex);
}

function demandThreeMonthProjection(traffic = demandTrafficAggregate(), trend = demandTrendSource(), stats = demandTrendStats(trend), nextDemand = demandNextMonthProjection(traffic, trend, stats)) {
  const currentVolume = finiteNumber(nextDemand.currentVolume, 0);
  const currentEntry = nextDemand.currentEntry || stats.last || null;
  const currentIndex = Number(currentEntry?.value);
  const targetVolume = finiteNumber(nextDemand.projectedVolume, 0);
  const followingMonth = nextDemand.nextMonth === 12 ? 1 : nextDemand.nextMonth + 1;
  const followingEntry = demandTrendEntryForMonth(trend, followingMonth);
  const followingIndex = Number(followingEntry?.value);
  const followingFactor = currentVolume && Number.isFinite(followingIndex) && Number.isFinite(currentIndex) && currentIndex > 0
    ? followingIndex / currentIndex
    : NaN;
  const followingVolume = Number.isFinite(followingFactor) ? Math.max(0, Math.round(currentVolume * followingFactor)) : 0;
  const followingPeriod = demandShiftPeriod(nextDemand.targetPeriod || demandPeriodFromEntry(nextDemand.nextEntry, nextDemand.nextMonth), 1, followingMonth);
  const baseLabel = nextDemand.baseMonthLabel || "기준월";
  const targetLabel = nextDemand.targetMonthLabel || "이번달";
  const followingLabel = demandPeriodShortLabel(followingPeriod, trendShortPeriodLabel(followingEntry, followingMonth));
  const maxVolume = Math.max(1, currentVolume, targetVolume, followingVolume);
  const row = (key, label, volume, note, tone, entry, change = NaN, period = "") => ({
    key,
    label,
    value: volume ? `${fmtNumber(volume)}회` : "대기",
    volume,
    note,
    tone,
    period: period || trendShortPeriodLabel(entry, key === "next" ? followingMonth : key === "current" ? nextDemand.nextMonth : nextDemand.currentMonth),
    index: Number.isFinite(Number(entry?.value)) ? trendIndexLabel(Number(entry.value)) : "",
    change,
    width: volume ? Math.max(7, Math.round((volume / maxVolume) * 100)) : 0
  });
  const followingChange = currentVolume && followingVolume ? (followingVolume - currentVolume) / currentVolume : NaN;
  return {
    rows: [
      row(
        "base",
        `${baseLabel} 검색량`,
        currentVolume,
        `${baseLabel} 검색광고 월검색량`,
        "strong",
        currentEntry,
        0,
        baseLabel
      ),
      row(
        "current",
        `${targetLabel} 예상`,
        targetVolume,
        nextDemand.hasTrendBasis
          ? `${targetLabel} 트렌드 반영${Number.isFinite(nextDemand.change) ? ` · ${formatSignedRate(nextDemand.change)}` : ""}`
          : `${targetLabel} 트렌드 대기`,
        nextDemand.tone || "neutral",
        nextDemand.nextEntry,
        nextDemand.change,
        targetLabel
      ),
      row(
        "next",
        `${followingLabel} 예상`,
        followingVolume,
        Number.isFinite(followingFactor)
          ? `${followingLabel} 트렌드 반영${Number.isFinite(followingChange) ? ` · ${formatSignedRate(followingChange)}` : ""}`
          : `${followingLabel} 트렌드 대기`,
        Number.isFinite(followingChange) && followingChange >= 0.12 ? "strong" : Number.isFinite(followingChange) && followingChange <= -0.12 ? "watch" : "neutral",
        followingEntry,
        followingChange,
        followingLabel
      )
    ],
    basis: currentVolume
      ? `${baseLabel} 검색량을 기준으로 데이터랩 상대지수 비율을 곱해 ${targetLabel}·${followingLabel} 예상 검색량을 환산합니다.`
      : "검색광고 월검색량이 확보되면 기준월·이번달·다음달 추이를 표시합니다."
  };
}

function demandTrendDirectionCard(trend, stats) {
  if (!trend.hasSeries || !stats.valid.length) {
    return {
      tone: "neutral",
      label: "추세 방향",
      value: "연동 대기",
      detail: "데이터랩 월별 지수가 들어오면 최근 흐름을 판단합니다."
    };
  }
  const change = Number.isFinite(stats.recentChange) ? stats.recentChange : stats.overallChange;
  const basis = Number.isFinite(stats.recentChange) ? "최근 3개월 평균 기준" : "12개월 시작·끝 기준";
  if (Number.isFinite(change) && change >= 0.15) {
    return {
      tone: "positive",
      label: "추세 방향",
      value: `상승 ${formatSignedRate(change)}`,
      detail: `${basis}. 검색 관심이 올라오는 구간입니다.`
    };
  }
  if (Number.isFinite(change) && change <= -0.15) {
    return {
      tone: "warning",
      label: "추세 방향",
      value: `하락 ${formatSignedRate(change)}`,
      detail: `${basis}. 상품 전환이나 가격 방어를 함께 봐야 합니다.`
    };
  }
  return {
    tone: "neutral",
    label: "추세 방향",
    value: "변동 작음",
    detail: `${basis}. 검색 흐름은 큰 변동 없이 유지됩니다.`
  };
}

function demandTrendPeakCard(trend, stats) {
  if (!trend.hasSeries || !stats.peak) {
    return {
      tone: "neutral",
      label: "피크 월",
      value: "확인 필요",
      detail: "12개월 상대지수가 쌓이면 성수기 위치를 잡습니다."
    };
  }
  const nearPeak = Number.isFinite(stats.peakRatio) && stats.peakRatio >= 0.82;
  return {
    tone: nearPeak ? "positive" : "neutral",
    label: "피크 월",
    value: `${stats.peak.label} ${trendIndexLabel(stats.peak.value)}`,
    detail: nearPeak
      ? `현재 ${stats.last?.label || "최근월"}도 피크권입니다. 노출/상품 점검 우선.`
      : `최근월은 피크 대비 ${Number.isFinite(stats.peakRatio) ? fmtRate(stats.peakRatio) : "확인필요"} 수준입니다.`
  };
}

function demandTrendQualityCard(traffic = {}) {
  const total = finiteNumber(traffic.totalSearchVolume, 0);
  const mobileShare = demandMobileShare(traffic);
  const ctr = Number(traffic.combinedCtr);
  let tone = "neutral";
  let value = total ? `${fmtNumber(total)}회` : "확인 필요";
  if (total >= 30000 || (Number.isFinite(ctr) && ctr >= 2)) tone = "positive";
  else if (!total || (Number.isFinite(ctr) && ctr < 0.8)) tone = "warning";
  const detail = [
    Number.isFinite(mobileShare) ? `모바일 ${fmtRate(mobileShare)}` : "모바일 확인필요",
    Number.isFinite(ctr) ? `CTR ${fmtSearchRate(ctr)}` : "CTR 확인필요"
  ].join(" · ");
  return {
    tone,
    label: "수요 품질",
    value,
    detail
  };
}

function demandTrendStorageCard(trend) {
  if (!trend.hasSeries) {
    return {
      tone: "neutral",
      label: "누적 신뢰",
      value: "대기",
      detail: "키워드별 저장 DB가 쌓이면 재사용성과 비교력이 올라갑니다."
    };
  }
  const count = Number(trend.observationCount || 0);
  const tone = count >= 7 ? "positive" : count >= 2 ? "neutral" : "warning";
  const value = count ? `${fmtNumber(count)}회 저장` : "신규 수집";
  const source = trend.cacheHit ? "동일 키워드·동일 기준일 재사용" : "이번 실행 수집";
  const time = trend.lastCollectedAt || trend.collectedAt;
  return {
    tone,
    label: "누적 신뢰",
    value,
    detail: `${source}${trend.cacheEndDate ? ` · ${trend.cacheEndDate}` : ""}${time ? ` · ${compactDateTime(time)}` : ""}`
  };
}

function demandTrendInsightCards(traffic = {}) {
  const trend = demandTrendSource();
  const stats = demandTrendStats(trend);
  return [
    demandTrendDirectionCard(trend, stats),
    demandTrendPeakCard(trend, stats),
    demandTrendQualityCard(traffic),
    demandTrendStorageCard(trend)
  ];
}

function demandTrendActionText(traffic = {}) {
  const trend = demandTrendSource();
  const stats = demandTrendStats(trend);
  const mobileShare = demandMobileShare(traffic);
  const rising = Number.isFinite(stats.recentChange) && stats.recentChange >= 0.15;
  const falling = Number.isFinite(stats.recentChange) && stats.recentChange <= -0.15;
  const peakNow = Number.isFinite(stats.peakRatio) && stats.peakRatio >= 0.82;
  if (!trend.hasSeries) {
    return "검색광고 지표와 데이터랩 추세가 함께 들어오면 시장 크기와 계절 흐름을 분리해 판단합니다.";
  }
  if (rising && Number.isFinite(mobileShare) && mobileShare >= 0.75) {
    return "검색 관심과 모바일 비중이 같이 높습니다. 네이버 예약 첫 화면, 모바일 상품명, 당일/숙박 대표상품을 우선 점검합니다.";
  }
  if (peakNow) {
    return "최근 수요가 피크권입니다. 상위 노출 업체의 금·일 판매 흐름, 가격, 채널 표본을 함께 확인합니다.";
  }
  if (falling) {
    return "검색 추세가 내려가는 구간입니다. 상품 구성과 평일/일요일 판매 흐름을 기간별로 비교합니다.";
  }
  return "검색량, 모바일 비중, CTR, 예약 판매율을 함께 보며 노출과 판매 구조를 비교합니다.";
}

function renderDemandTrendInsightCards(traffic = {}) {
  return `
    <div class="demand-signal-grid" aria-label="트렌드 판단 카드">
      ${demandTrendInsightCards(traffic).map((card) => `
        <article class="demand-signal-card ${escapeHtml(card.tone)}">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
          <small>${escapeHtml(card.detail)}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function formatSignedRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "확인";
  const sign = number > 0 ? "+" : "";
  return `${sign}${Math.round(number * 100)}%`;
}

function demandInterpretation(traffic = {}) {
  const total = finiteNumber(traffic.totalSearchVolume, 0);
  const mobileShare = demandMobileShare(traffic);
  const ctr = Number(traffic.combinedCtr);
  const trend = demandTrendSource();
  const pills = [];
  if (total >= 30000) pills.push("광역 수요 강함");
  else if (total >= 10000) pills.push("지역 수요 유효");
  else if (total > 0) pills.push("소형 키워드");
  else pills.push("검색광고 확인필요");

  if (Number.isFinite(mobileShare) && mobileShare >= 0.75) pills.push("모바일 중심");
  else if (Number.isFinite(mobileShare)) pills.push("PC 보조수요");

  if (Number.isFinite(ctr) && ctr >= 1) pills.push("클릭 반응 양호");
  else if (Number.isFinite(ctr)) pills.push("CTR 점검");

  pills.push(trend.hasSeries || trend.reason ? demandTrendLabel() : "트렌드 API 대기");
  return pills;
}

function demandPriorityLabel(traffic = {}, extraSignal = 0) {
  const volume = finiteNumber(traffic.totalSearchVolume, 0);
  const ctr = Number(traffic.combinedCtr);
  if (volume >= 30000) return "1순위";
  const score = (volume >= 8000 ? 34 : volume >= 3000 ? 27 : volume >= 1500 ? 21 : volume > 0 ? 14 : 6) +
    (Number.isFinite(ctr) && ctr >= 1 ? 10 : Number.isFinite(ctr) ? 6 : 3) +
    extraSignal;
  if (score >= 38) return "1순위";
  if (score >= 27) return "2순위";
  return "보류";
}

function demandStructureSource() {
  return state.data?.demandStructure || null;
}

function demandTone(score) {
  const number = Number(score);
  if (number >= 82) return "strong";
  if (number >= 68) return "good";
  if (number >= 55) return "watch";
  return "risk";
}

function demandMetricValue(metric = {}) {
  if (metric.key === "monthlyDemand") return metric.value || "확인";
  if (metric.key === "targetFit") {
    const names = (demandStructureSource()?.topSegments || []).slice(0, 2).map((item) => item.group);
    return Array.from(new Set(names)).join("·") || metric.value || "확인";
  }
  return metric.value || `${fmtNumber(metric.score)}점`;
}

function demandRadarChart(items = []) {
  const width = 320;
  const height = 260;
  const cx = width / 2;
  const cy = 132;
  const radius = 92;
  const axes = items.length ? items.slice(0, 6) : [
    { label: "월수요", score: 0 },
    { label: "타겟", score: 0 },
    { label: "평일", score: 0 },
    { label: "가격", score: 0 },
    { label: "콘텐츠", score: 0 },
    { label: "리스크", score: 0 }
  ];
  const pointFor = (index, score = 100) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / axes.length;
    const r = radius * Math.max(0, Math.min(100, Number(score) || 0)) / 100;
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      angle
    };
  };
  const grid = [25, 50, 75, 100].map((score) => axes.map((_, index) => {
    const point = pointFor(index, score);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(" "));
  const polygon = axes.map((axis, index) => {
    const point = pointFor(index, axis.score);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(" ");
  return `
    <svg class="structure-radar" viewBox="0 0 ${width} ${height}" role="img" aria-label="수요구조 레이더 차트">
      <g class="structure-radar-grid">
        ${grid.map((points) => `<polygon points="${points}"></polygon>`).join("")}
        ${axes.map((_, index) => {
          const outer = pointFor(index, 100);
          return `<line x1="${cx}" y1="${cy}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}"></line>`;
        }).join("")}
      </g>
      <polygon class="structure-radar-fill" points="${polygon}"></polygon>
      <polyline class="structure-radar-line" points="${polygon} ${polygon.split(" ")[0] || ""}"></polyline>
      <g class="structure-radar-labels">
        ${axes.map((axis, index) => {
          const point = pointFor(index, 118);
          return `<text x="${point.x.toFixed(1)}" y="${point.y.toFixed(1)}">${escapeHtml(axis.label)}</text>`;
        }).join("")}
      </g>
    </svg>
  `;
}

function renderDemandStructure() {
  const structure = demandStructureSource();
  if (!structure) {
    return `
      <section class="structure-empty-card">
        <strong>수요구조 사전 대기</strong>
        <p>숙박업 메인터넌스 사전이 연결되면 월별 수요강도, 핵심타겟, 평일 확장성, 가격 방어력을 표시합니다.</p>
      </section>
    `;
  }
  const primaryMetrics = (structure.metrics || []).slice(0, 4);
  const secondaryMetrics = (structure.metrics || []).slice(4);
  const tone = demandTone(structure.overallScore);
  return `
    <section class="structure-hero ${tone}">
      <div class="structure-score">
        <span>수요구조 종합점수</span>
        <strong>${fmtNumber(structure.overallScore)}</strong>
        <em>${escapeHtml(structure.overallLabel || "판단 대기")}</em>
      </div>
      <div class="structure-summary">
        <p class="eyebrow">${escapeHtml(structure.source || "숙박업 메인터넌스")}</p>
        <h3>${escapeHtml(structure.monthLabel || "")} ${escapeHtml(structure.season || "")} 수요 판단</h3>
        <p>${escapeHtml(structure.summary || structure.interpretation || "")}</p>
        <div class="structure-chip-row">
          ${(structure.contentKeywords || []).slice(0, 6).map((keyword) => `<span>${escapeHtml(keyword)}</span>`).join("")}
        </div>
      </div>
    </section>

    <section class="structure-metric-grid" aria-label="수요구조 핵심 지표">
      ${primaryMetrics.map((metric) => `
        <article>
          <span>${escapeHtml(metric.label)}</span>
          <strong>${escapeHtml(demandMetricValue(metric))}</strong>
          <small>${fmtNumber(metric.score)}점 · ${escapeHtml(metric.note || "")}</small>
        </article>
      `).join("")}
    </section>

    <section class="structure-layout">
      <article class="structure-card radar-card">
        <div class="demand-card-head">
          <div>
            <h3>지표 균형</h3>
            <p>월수요, 타겟, 평일, 가격, 콘텐츠, 리스크 기준</p>
          </div>
        </div>
        ${demandRadarChart(structure.radar || [])}
      </article>

      <article class="structure-card">
        <div class="demand-card-head">
          <div>
            <h3>핵심 타겟</h3>
            <p>이번 시점에 우선 맞춰야 할 고객군</p>
          </div>
          <span>${escapeHtml(structure.monthLabel || "")}</span>
        </div>
        <div class="segment-list">
          ${(structure.topSegments || []).map((segment) => `
            <div>
              <strong>${escapeHtml(segment.name)}</strong>
              <span>${escapeHtml(segment.group)} · ${fmtNumber(segment.score)}점</span>
              <small>${escapeHtml(segment.operation || "")}</small>
            </div>
          `).join("")}
        </div>
      </article>
    </section>

    <section class="structure-action-grid">
      <article class="structure-card">
        <div class="demand-card-head">
          <div>
            <h3>추천 운영</h3>
            <p>상품·가격·콘텐츠 실행 방향</p>
          </div>
        </div>
        <ol class="structure-action-list">
          ${(structure.recommendedOperations || []).slice(0, 5).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ol>
      </article>
      <article class="structure-card risk">
        <div class="demand-card-head">
          <div>
            <h3>운영 리스크</h3>
            <p>예약률 해석 시 보정해야 할 변수</p>
          </div>
        </div>
        <div class="risk-chip-row">
          ${(structure.risks || []).length
            ? structure.risks.map((risk) => `<span>${escapeHtml(risk)}</span>`).join("")
            : `<span>특이 리스크 없음</span>`}
        </div>
        <p>${escapeHtml(structure.interpretation || "")}</p>
      </article>
    </section>

    ${secondaryMetrics.length ? `
      <section class="structure-submetric-row">
        ${secondaryMetrics.map((metric) => `
          <article>
            <span>${escapeHtml(metric.label)}</span>
            <strong>${fmtNumber(metric.score)}</strong>
            <small>${escapeHtml(metric.note || metric.value || "")}</small>
          </article>
        `).join("")}
      </section>
    ` : ""}
  `;
}

function demandRegionRows() {
  return (state.data?.regions || [])
    .map((region) => ({
      region,
      traffic: region.traffic || {},
      primary: regionPrimary(region)
    }))
    .sort((a, b) => finiteNumber(b.traffic.totalSearchVolume, 0) - finiteNumber(a.traffic.totalSearchVolume, 0))
    .slice(0, 8);
}

function b2bDemandPlaybookModel(traffic = demandTrafficAggregate()) {
  const trend = demandTrendSource();
  const stats = demandTrendStats(trend);
  const nextDemand = demandNextMonthProjection(traffic, trend, stats);
  const total = finiteNumber(traffic.totalSearchVolume, 0);
  const mobileShare = demandMobileShare(traffic);
  const ctr = Number(traffic.combinedCtr);
  const items = state.data?.availability?.items || [];
  const sales = summarizeSales(items);
  const salesRate = sales.supply ? sales.sold / sales.supply : NaN;
  const peakText = trend.hasSeries && stats.peak ? `${stats.peak.label} ${trendIndexLabel(stats.peak.value)}` : "확인필요";
  const recentText = trend.hasSeries && stats.last ? `${stats.last.label} ${trendIndexLabel(stats.last.value)}` : "대기";
  const demandStrength = total >= 30000
    ? "광역 수요 강함"
    : total >= 10000
      ? "지역 수요 유효"
      : total > 0
        ? "소형 키워드"
        : "검색량 확인필요";
  const decision = total >= 30000 || (Number.isFinite(salesRate) && salesRate >= 0.55)
    ? "수요 우위"
    : total >= 10000
      ? "경쟁권 유효"
      : "표본 보강";
  const action = demandTrendActionText(traffic);
  return {
    trend,
    stats,
    total,
    mobileShare,
    ctr,
    sales,
    salesRate,
    nextDemand,
    peakText,
    recentText,
    demandStrength,
    decision,
    action,
    metrics: [
      {
        label: "월 검색량",
        value: total ? fmtNumber(total) : "확인필요",
        detail: traffic.collectableCount ? `${fmtNumber(traffic.collectableCount)}개 키워드 합산` : "네이버 검색광고 API"
      },
      {
        label: `${nextDemand.targetMonthLabel || "다음달"} 예상`,
        value: nextDemand.value,
        detail: nextDemand.detailText || "기준년월 검색량에 작년 동월 트렌드 비율 반영"
      },
      {
        label: "피크 월",
        value: peakText,
        detail: trend.hasSeries ? `최근 ${recentText}` : "누적 캐시 확보 후 표시"
      },
      {
        label: "판매 표본",
        value: Number.isFinite(salesRate) ? fmtRate(salesRate) : "확인필요",
        detail: sales.supply ? `${fmtNumber(sales.sold)}/${fmtNumber(sales.supply)}실 표본` : "수량 표본 대기"
      }
    ],
    checks: [
      total ? `검색량은 ${demandStrength} 구간입니다.` : "검색광고 API 표본이 없어 수요 강도는 보류합니다.",
      nextDemand.projectedVolume ? `${nextDemand.label || "예상 검색량"}은 ${fmtNumber(nextDemand.projectedVolume)}회이며 ${nextDemand.note} 기준입니다.` : "예상 검색량은 검색광고 월검색량과 트렌드 표본 확보 후 표시합니다.",
      Number.isFinite(mobileShare) ? `모바일 비중 ${fmtRate(mobileShare)}로 예약 화면/상품명 영향이 큽니다.` : "모바일 비중은 추가 수집 후 판단합니다.",
      Number.isFinite(ctr) ? `평균 CTR ${fmtSearchRate(ctr)}로 노출 대비 클릭 반응을 봅니다.` : "CTR은 키워드별 클릭 데이터 확보 후 비교합니다.",
      sales.supply ? `네이버 예약 판매율 ${fmtRate(salesRate)}와 잔여 객실을 함께 봅니다.` : "업체별 수량 표본이 없는 경우 지도/순위 표본을 먼저 봅니다."
    ]
  };
}

function trendMonthNumber(label = "") {
  const text = String(label || "").trim();
  const yearMonth = text.match(/^\d{4}[-./년\s]*0?(\d{1,2})/);
  const match = yearMonth || text.match(/(\d{1,2})월/) || text.match(/^0?(\d{1,2})$/);
  if (!match) return NaN;
  const month = Number(match[1]);
  return month >= 1 && month <= 12 ? month : NaN;
}

function b2bPeakDistanceText(stats = {}) {
  const peakMonth = trendMonthNumber(stats.peak?.label);
  const recentMonth = trendMonthNumber(stats.last?.label);
  if (!Number.isFinite(peakMonth) || !Number.isFinite(recentMonth)) return "피크 대기";
  const distance = (peakMonth - recentMonth + 12) % 12;
  if (distance === 0 || (Number.isFinite(stats.peakRatio) && stats.peakRatio >= 0.82)) return "피크권";
  if (distance <= 2) return `${fmtNumber(distance)}개월 전`;
  if (distance <= 5) return `${fmtNumber(distance)}개월 전 준비`;
  return "비수기 대비";
}

function b2bDemandOutlookModel(traffic = demandTrafficAggregate(), playbook = b2bDemandPlaybookModel(traffic)) {
  const trend = playbook.trend;
  const stats = playbook.stats;
  const nextDemand = playbook.nextDemand || demandNextMonthProjection(traffic, trend, stats);
  const monthFlow = demandThreeMonthProjection(traffic, trend, stats, nextDemand);
  const items = state.data?.availability?.items || [];
  const rankModel = b2bRankBoardModel();
  const market = b2bMarketBriefModel(state.data || {});
  const flow = aggregateFlowProfiles(items);
  const snapshot = b2bCompetitiveSnapshotModel(market);
  const change = Number.isFinite(nextDemand.change)
    ? nextDemand.change
    : (Number.isFinite(stats.recentChange) ? stats.recentChange : stats.overallChange);
  const rising = Number.isFinite(change) && change >= 0.12;
  const falling = Number.isFinite(change) && change <= -0.12;
  const peakNow = trend.hasSeries && Number.isFinite(stats.peakRatio) && stats.peakRatio >= 0.82;
  const weekendGap = Number.isFinite(flow.saturday.rate) && Number.isFinite(flow.weekday.rate)
    ? flow.saturday.rate - flow.weekday.rate
    : NaN;
  const revenueSample = finiteNumber(market.revenueSampleCount, 0);
  const forecastTone = rising || peakNow
    ? "positive"
    : falling
      ? "warning"
      : "neutral";
  const forecastLabel = rising
    ? "다음달 증가"
    : peakNow
      ? "피크권"
      : falling
        ? "다음달 감소"
        : "변동 작음";
  const peakDistance = b2bPeakDistanceText(stats);
  const cards = [
    {
      tone: forecastTone,
      label: nextDemand.label || "다음달 검색량",
      value: nextDemand.value,
      note: nextDemand.note
    },
    {
      tone: peakNow ? "positive" : "neutral",
      label: "피크 접근",
      value: peakDistance,
      note: stats.peak ? `${stats.peak.label} 피크 · 최근 ${stats.last?.label || "대기"}` : "피크 월 대기"
    },
    {
      tone: Number.isFinite(playbook.mobileShare) && playbook.mobileShare >= 0.75 ? "positive" : "neutral",
      label: "모바일 예약수요",
      value: Number.isFinite(playbook.mobileShare) ? fmtRate(playbook.mobileShare) : "확인필요",
      note: playbook.total ? `월검색 ${fmtNumber(playbook.total)} · CTR ${Number.isFinite(playbook.ctr) ? fmtSearchRate(playbook.ctr) : "대기"}` : "검색광고 표본 대기"
    },
    {
      tone: rankModel.hotRows.length ? "warning" : "neutral",
      label: "경쟁 판매압력",
      value: `${fmtNumber(rankModel.hotRows.length)}개`,
      note: Number.isFinite(rankModel.rate) ? `상위 표본 평균 ${fmtRate(rankModel.rate)}` : "판매 표본 대기"
    },
    {
      tone: Number.isFinite(weekendGap) && weekendGap >= 0.25 ? "positive" : "neutral",
      label: "주말 집중도",
      value: Number.isFinite(flow.saturday.rate) ? fmtRate(flow.saturday.rate) : "확인필요",
      note: Number.isFinite(weekendGap) ? `토-평일 ${formatSignedRate(weekendGap)}` : "요일별 표본 대기"
    },
    {
      tone: revenueSample ? "positive" : "warning",
      label: "매출 표본",
      value: revenueSample ? `${fmtNumber(revenueSample)}개` : "대기",
      note: market.averageRevenue ? `평균 ${fmtWon(market.averageRevenue)} · 최고 ${snapshot.revenueMax ? fmtWon(snapshot.revenueMax) : "대기"}` : "가격·수량 표본 필요"
    }
  ];
  const timeline = (trend.series.length ? trend.series.slice(-12) : [])
    .map((entry) => {
      const value = Number(entry.value);
      const isPeak = stats.peak && entry.index === stats.peak.index;
      const isRecent = stats.last && entry.index === stats.last.index;
      const tone = isPeak ? "peak" : isRecent ? "recent" : Number.isFinite(value) && value >= 80 ? "high" : "";
      return {
        label: trendAxisLabel(entry),
        value,
        height: Number.isFinite(value) ? Math.max(5, Math.min(100, value)) : 0,
        tone,
        title: Number.isFinite(value) ? `${entry.label} 상대지수 ${trendIndexLabel(value)}` : `${entry.label} 데이터 대기`
      };
    });
  const actionRows = [
    {
      label: "상품 노출",
      value: peakNow || rising ? "대표상품 강화" : "검색 화면 점검",
      detail: peakNow || rising
        ? "피크권 또는 상승권에서는 네이버 예약 첫 화면과 모바일 상품명을 먼저 비교합니다."
        : "변동이 작은 구간에서는 노출 순위와 지정 검색범위의 예약율을 우선 확인합니다."
    },
    {
      label: "가격/재고",
      value: Number.isFinite(weekendGap) && weekendGap >= 0.25 ? "주말 방어" : "요일별 비교",
      detail: Number.isFinite(weekendGap)
        ? `토요일과 평일 판매율 차이는 ${formatSignedRate(weekendGap)}입니다. 금·일·평일 ${B2B_LOW_RESERVATION_LABEL} 구간을 함께 봅니다.`
        : "요일별 가격과 수량 표본이 쌓이면 금·토·일·평일을 분리해 봅니다."
    },
    {
      label: "경쟁 기준",
      value: rankModel.hotRows.length ? `${B2B_HIGH_RESERVATION_LABEL} 업체 비교` : "상위 노출 비교",
      detail: rankModel.hotRows.length
        ? `${B2B_HIGH_RESERVATION_LABEL} 업체 ${fmtNumber(rankModel.hotRows.length)}개를 가격/상품 벤치마크로 봅니다.`
        : "상위 노출 업체의 예약율 표본을 향후 컨택 판단 근거로 씁니다."
    }
  ];
  return {
    trend,
    stats,
    nextDemand,
    monthFlow,
    cards,
    timeline,
    actionRows,
    forecastLabel,
    forecastTone
  };
}

function keywordRecommendationLabel(value = "") {
  return compactCrawlKeyword(value);
}

function keywordTrafficIndex() {
  const map = new Map();
  const put = (keyword, traffic = {}, source = "검색광고") => {
    const label = keywordRecommendationLabel(keyword || traffic.relKeyword || traffic.keyword);
    const key = compactSearchText(label);
    if (!key) return;
    const row = {
      keyword: label,
      relKeyword: traffic.relKeyword || label,
      totalSearchVolume: finiteNumber(traffic.totalSearchVolume, 0),
      monthlyPc: finiteNumber(traffic.monthlyPc, 0),
      monthlyMobile: finiteNumber(traffic.monthlyMobile, 0),
      combinedCtr: Number(traffic.combinedCtr),
      competition: traffic.competition || "",
      collectable: Boolean(traffic.collectable || traffic.totalSearchVolume),
      source
    };
    const current = map.get(key);
    if (!current || row.totalSearchVolume > current.totalSearchVolume) map.set(key, row);
  };

  const aggregate = demandTrafficAggregate();
  put(activeKeyword(), {
    ...aggregate,
    relKeyword: aggregate.relKeyword || aggregate.keyword || activeKeyword(),
    collectable: Boolean(aggregate.totalSearchVolume)
  }, "기준 키워드");

  (state.data?.regions || []).forEach((region) => {
    const traffic = region.traffic || {};
    put(region.trafficKeyword || region.region || region.name, traffic, "지역 검색량");
    put(traffic.keyword, traffic, "지역 검색량");
    put(traffic.relKeyword, traffic, "지역 검색량");
    (traffic.relatedKeywords || []).forEach((row) => {
      put(row.keyword || row.relKeyword, {
        ...row,
        collectable: true
      }, "검색광고 관련");
    });
  });
  return map;
}

function keywordRecommendationContext() {
  const keyword = activeKeyword();
  const match = locationCardForQuery(keyword);
  const candidate = locationCandidateFromQuery(keyword);
  const card = match?.card || null;
  const group = match?.group ||
    locationGroupForQuery(keyword) ||
    (card ? (state.dictionary?.regionGroups || []).find((item) => (item.children || []).includes(card.regionKey)) : null);
  const alias = match?.alias || dictionaryAliasForCard(card);
  const groupCards = group ? locationGroupCards(group) : [];
  const base = [
    alias?.sigungu,
    group?.sido,
    candidate?.regionBase,
    stripLocationBusinessWords(card?.searchKeyword || ""),
    stripLocationBusinessWords(group?.searchKeyword || ""),
    stripLocationBusinessWords(keyword)
  ].map((value) => String(value || "").trim()).find(Boolean) || "지역";
  const clusters = card
    ? locationClusterCodes(card).map(locationClusterMeta)
    : groupCards.flatMap((item) => locationClusterCodes(item).map(locationClusterMeta));
  const structure = demandStructureSource();
  const contextText = [
    keyword,
    base,
    group?.strategy,
    group?.interpretation,
    group?.salesFocus,
    card?.recommendedProduct,
    card?.interpretation,
    ...(clusters || []).map((cluster) => `${cluster.name || ""} ${cluster.product || ""} ${cluster.channel || ""}`),
    ...(structure?.topSegments || []).map((segment) => `${segment.name || ""} ${segment.group || ""}`),
    ...(structure?.contentKeywords || [])
  ].filter(Boolean).join(" ");
  return {
    keyword,
    base: keywordRecommendationLabel(base),
    card,
    group,
    alias,
    groupCards,
    clusters,
    structure,
    contextText
  };
}

function keywordRecommendationPurpose(keyword = "", category = "", volume = 0) {
  if (category === "기준") return "현재 리포트 기준 키워드";
  if (category === "실측 관련") return "검색광고 관련 키워드로 다음 수집 후보";
  if (category === "하위지역") return "광역 검색에서 분리 수집할 지역 후보";
  if (category === "업종") return "글램핑 외 유사 업종 수요 확인";
  if (category === "상품") return "카라반/오토캠핑 등 상품 구성 확인";
  if (category === "시설") return "시설형 검색 의도와 상품명 점검";
  if (category === "고객의도") return "가족·커플·단체 등 고객군별 콘텐츠 점검";
  if (category === "관광") return "관광 앵커 기반 목적 방문 수요 확인";
  return volume ? "검색수요 실측 후보" : "추가 수집 후보";
}

function b2bKeywordRecommendationModel(traffic = demandTrafficAggregate(), playbook = b2bDemandPlaybookModel(traffic)) {
  const context = keywordRecommendationContext();
  const trafficIndex = keywordTrafficIndex();
  const seen = new Set();
  const rows = [];
  const trendChange = Number(playbook?.nextDemand?.change);
  const trendBoost = Number.isFinite(trendChange)
    ? trendChange >= 0.12 ? 4 : trendChange <= -0.12 ? -2 : 1
    : 0;
  const add = (keyword, category, source, baseScore = 60, explicitReason = "") => {
    const label = keywordRecommendationLabel(keyword);
    const key = compactSearchText(label);
    if (!key || seen.has(key) || label.length < 3) return;
    seen.add(key);
    const trafficRow = trafficIndex.get(key) || null;
    const volume = finiteNumber(trafficRow?.totalSearchVolume, 0);
    const volumeBoost = volume >= 30000 ? 14 : volume >= 10000 ? 10 : volume >= 3000 ? 7 : volume > 0 ? 4 : 0;
    const score = Math.max(35, Math.min(99, Math.round(baseScore + volumeBoost + trendBoost)));
    const purpose = keywordRecommendationPurpose(label, category, volume);
    rows.push({
      keyword: label,
      key,
      category,
      source,
      purpose,
      reason: explicitReason || (trafficRow?.source ? `${trafficRow.source} 기준` : "현재 지역/수요 구조 기준"),
      score,
      totalSearchVolume: volume,
      ctr: Number(trafficRow?.combinedCtr),
      competition: trafficRow?.competition || "",
      collectable: Boolean(trafficRow?.collectable),
      tone: score >= 82 ? "strong" : score >= 68 ? "good" : volume ? "neutral" : "watch"
    });
  };

  const base = context.base || stripLocationBusinessWords(context.keyword) || "지역";
  add(context.keyword, "기준", "현재 검색", 88, "현재 리포트의 노출·예약·수요 기준");
  add(`${base}글램핑`, "기준", "지역명 + 글램핑", 86, "지역명과 업종을 붙인 기본 비교 키워드");
  ["캠핑장", "카라반", "오토캠핑장"].forEach((suffix, index) => {
    add(`${base}${suffix}`, index === 1 ? "상품" : "업종", "지역명 + 업종/상품", 70 - index * 2);
  });

  (context.group?.plannedKeywords || []).forEach((keyword, index) => {
    add(keyword, "하위지역", "권역 plannedKeywords", 76 - Math.min(index, 4), `${context.group?.sido || base} 권역에서 분리 수집할 후보`);
  });
  (context.groupCards || []).forEach((card, index) => {
    add(card.searchKeyword, "하위지역", "지역카드 하위지역", 74 - Math.min(index, 4), "지역카드가 연결된 하위 경쟁권");
  });

  [...trafficIndex.values()]
    .filter((row) => {
      const keyword = row.keyword || row.relKeyword || "";
      const compact = compactSearchText(keyword);
      if (!keyword || seen.has(compact)) return false;
      if (!/(글램핑|캠핑|카라반|펜션|캠핑장|오토캠핑)/.test(keyword)) return false;
      const baseCompact = compactSearchText(base);
      return !baseCompact || compact.includes(baseCompact) || compactSearchText(context.keyword).includes(baseCompact);
    })
    .sort((a, b) => finiteNumber(b.totalSearchVolume, 0) - finiteNumber(a.totalSearchVolume, 0))
    .slice(0, 6)
    .forEach((row) => {
      add(row.keyword || row.relKeyword, "실측 관련", "검색광고 관련 키워드", 78, "검색광고 API 관련 키워드 후보");
    });

  const text = context.contextText || "";
  if (/바다|해안|해변|오션|섬|서해|남해/.test(text)) {
    add(`${base}바다글램핑`, "관광", "관광 앵커", 66);
    add(`${base}오션뷰글램핑`, "시설", "관광 앵커", 64);
  }
  if (/계곡|산|숲|자연|호수|강|둘레|휴양림/.test(text)) {
    add(`${base}계곡글램핑`, "관광", "관광 앵커", 66);
    add(`${base}숲속글램핑`, "시설", "자연 체류", 63);
  }
  if (/수도권|서울|근교/.test(text)) {
    add("서울근교글램핑", "관광", "생활권 확장", 69);
  }

  ["수영장", "개별바베큐", "애견동반", "독채"].forEach((intent, index) => {
    add(`${base}${intent}글램핑`, "시설", "시설 의도", 62 - index);
  });
  ["가족", "커플", "감성", "단체"].forEach((intent, index) => {
    const boost = text.includes(intent) ? 6 : 0;
    add(`${base}${intent}글램핑`, "고객의도", "고객 의도", 61 - index + boost);
  });

  rows.sort((a, b) => b.score - a.score || b.totalSearchVolume - a.totalSearchVolume || a.keyword.localeCompare(b.keyword, "ko"));
  const recommended = rows.slice(0, 12);
  const measuredCount = recommended.filter((row) => row.totalSearchVolume > 0).length;
  const expansionCount = recommended.filter((row) => !row.totalSearchVolume).length;
  return {
    context,
    rows: recommended,
    measuredCount,
    expansionCount,
    base,
    summary: measuredCount
      ? `실측 검색량 ${fmtNumber(measuredCount)}개와 확장 후보 ${fmtNumber(expansionCount)}개`
      : `확장 후보 ${fmtNumber(expansionCount)}개 · 다음 수집에서 검색량 확인`
  };
}

function renderB2BKeywordRecommendations(traffic = demandTrafficAggregate(), playbook = b2bDemandPlaybookModel(traffic)) {
  if (isAdminRole()) return "";
  const model = b2bKeywordRecommendationModel(traffic, playbook);
  const focus = model.rows.slice(0, 3);
  const tail = model.rows.slice(3);
  return `
    <div class="b2b-keyword-recommend">
      <div class="b2b-keyword-head">
        <div>
          <span>Keyword Expansion</span>
          <strong>추천 검색 키워드</strong>
          <small>${escapeHtml(`${activeKeyword()} 기준 · ${model.summary}`)}</small>
        </div>
        <em>${escapeHtml(model.base)}</em>
      </div>
      ${focus.length ? `
        <div class="b2b-keyword-focus">
          ${focus.map((row) => `
            <article class="${escapeHtml(row.tone)}">
              <span>${escapeHtml(row.category)}</span>
              <strong>${escapeHtml(row.keyword)}</strong>
              <small>${escapeHtml(row.totalSearchVolume ? `월검색 ${fmtNumber(row.totalSearchVolume)} · ${row.purpose}` : row.purpose)}</small>
              <button type="button" data-b2b-keyword-apply="${escapeHtml(row.keyword)}">검색어 적용</button>
            </article>
          `).join("")}
        </div>
      ` : `<div class="b2b-demand-empty-line">추천 키워드 생성을 위한 지역 기준이 필요합니다.</div>`}
      ${tail.length ? `
        <div class="b2b-keyword-list">
          ${tail.map((row) => `
            <button type="button" class="${escapeHtml(row.tone)}" data-b2b-keyword-apply="${escapeHtml(row.keyword)}">
              <span>${escapeHtml(row.category)}</span>
              <strong>${escapeHtml(row.keyword)}</strong>
              <em>${row.totalSearchVolume ? `${fmtNumber(row.totalSearchVolume)}회` : "수집후 확인"}</em>
              <small>${escapeHtml(row.reason)}</small>
            </button>
          `).join("")}
        </div>
      ` : ""}
      <p>추천 키워드는 검색광고 관련 키워드, 지역카드, 권역 후보, 시설·고객 의도 기준입니다. 적용 후 검색 실행 시 새 경쟁 리포트를 수집합니다.</p>
    </div>
  `;
}

function renderB2BDemandOutlook(traffic = demandTrafficAggregate(), playbook = b2bDemandPlaybookModel(traffic)) {
  if (isAdminRole()) return "";
  const model = b2bDemandOutlookModel(traffic, playbook);
  return `
    <div class="b2b-demand-outlook">
      <div class="b2b-demand-outlook-head">
        <div>
          <strong>월별 검색량 보드</strong>
          <span>기준월 검색량에 계절 트렌드 비율을 반영해 이번달·다음달을 예측합니다.</span>
        </div>
        <em class="${escapeHtml(model.forecastTone)}">${escapeHtml(model.forecastLabel)}</em>
      </div>
      <div class="b2b-demand-outlook-grid">
        ${model.cards.map((card) => `
          <article class="${escapeHtml(card.tone)}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(card.value)}</strong>
            <small>${escapeHtml(card.note)}</small>
          </article>
        `).join("")}
      </div>
      <div class="b2b-demand-month-flow" aria-label="기준월 이번달 다음달 검색량 추이">
        <div>
          <strong>검색량 3개월 흐름</strong>
          <span>${escapeHtml(model.monthFlow.basis)}</span>
        </div>
        ${model.monthFlow.rows.map((row) => `
          <article class="${escapeHtml(row.tone)}">
            <div>
              <span>${escapeHtml(row.label)}</span>
              <strong>${escapeHtml(row.value)}</strong>
              <small>${escapeHtml([row.period, row.index ? `지수 ${row.index}` : "", row.note].filter(Boolean).join(" · "))}</small>
            </div>
            <i><b style="width:${row.width}%"></b></i>
          </article>
        `).join("")}
      </div>
      ${model.timeline.length ? `
        <div class="b2b-demand-season-strip" aria-label="12개월 수요 시즌 흐름">
          ${model.timeline.map((row) => `
            <div class="${escapeHtml(row.tone)}" title="${escapeHtml(row.title)}">
              <span><i style="height:${row.height}%"></i></span>
              <b>${escapeHtml(row.label)}</b>
              <small>${Number.isFinite(row.value) ? escapeHtml(trendIndexLabel(row.value)) : "-"}</small>
            </div>
          `).join("")}
        </div>
      ` : `
        <div class="b2b-demand-empty-line">데이터랩 12개월 추세가 확보되면 시즌 흐름을 월별 막대로 표시합니다.</div>
      `}
      <div class="b2b-demand-outlook-layout single">
        <article class="b2b-demand-action-board">
          ${model.actionRows.map((row) => `
            <div>
              <span>${escapeHtml(row.label)}</span>
              <strong>${escapeHtml(row.value)}</strong>
              <small>${escapeHtml(row.detail)}</small>
            </div>
          `).join("")}
        </article>
      </div>
      ${renderB2BKeywordRecommendations(traffic, playbook)}
    </div>
  `;
}

function renderB2BDemandPlaybook(traffic = demandTrafficAggregate()) {
  if (isAdminRole()) return "";
  const model = b2bDemandPlaybookModel(traffic);
  return `
    <section class="b2b-demand-playbook">
      <div class="b2b-demand-head">
        <div>
          <p class="eyebrow">B2B Demand Outlook</p>
          <h3>월별 검색량과 경쟁 흐름</h3>
          <p>기준월 검색량, 12개월 트렌드, 네이버 예약 판매 표본을 묶어 이번달·다음달 권역 수요를 추정합니다.</p>
        </div>
        <strong>${escapeHtml(model.decision)}</strong>
      </div>
      <div class="b2b-demand-grid">
        ${model.metrics.map((metric) => `
          <article>
            <span>${escapeHtml(metric.label)}</span>
            <strong>${escapeHtml(metric.value)}</strong>
            <small>${escapeHtml(metric.detail)}</small>
          </article>
        `).join("")}
      </div>
      ${renderB2BDemandOutlook(traffic, model)}
      <div class="b2b-demand-actions">
        <div>
          <span>수요 해석</span>
          <strong>${escapeHtml(model.demandStrength)}</strong>
          <p>${escapeHtml(model.action)}</p>
        </div>
        <ul>
          ${model.checks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}
        </ul>
      </div>
    </section>
  `;
}

function demandCompanySample() {
  const target = targetEntries(1)[0]?.item || (state.data?.availability?.items || [])[0];
  if (!target) return "";
  const region = (state.data?.regions || []).find((entry) => {
    const regionName = String(entry.region || "");
    const itemRegion = String(target.region || "");
    return regionName && itemRegion && (regionName.includes(itemRegion) || itemRegion.includes(regionName));
  });
  const traffic = region?.traffic || demandTrafficAggregate();
  const lodging = salesStats(target, "lodging");
  const index = (state.data?.availability?.items || []).indexOf(target);
  return `
    <article class="demand-company-card">
      <div>
        <span>경쟁업체 예시</span>
        <strong>${escapeHtml(target.name || "업체명 확인")}</strong>
        <small>${escapeHtml(categoryText(target))} · 네이버 ${escapeHtml(target.rank || index + 1)}위</small>
      </div>
      <dl>
        <div><dt>객실판매</dt><dd>${lodging.supply ? `${fmtNumber(lodging.sold)}/${fmtNumber(lodging.supply)}개 · ${fmtRate(lodging.rate)}` : "확인필요"}</dd></div>
        <div><dt>검색수요</dt><dd>${traffic.totalSearchVolume ? fmtNumber(traffic.totalSearchVolume) : "확인필요"} · ${demandTrendLabel()}</dd></div>
        <div><dt>경쟁해석</dt><dd>${demandPriorityLabel(traffic, targetReasons(target).length * 5)}</dd></div>
      </dl>
      <button class="secondary-button" type="button" data-open-company="${index}">상세 보기</button>
    </article>
  `;
}

function historySource() {
  return state.data?.history || {};
}

function historyRateText(value) {
  return Number.isFinite(Number(value)) ? fmtRate(Number(value)) : "누적 대기";
}

function historyMetricCard(label, value, note = "") {
  return `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </article>
  `;
}

function historyLeadTimeChart(leadTime = []) {
  const rows = [...leadTime]
    .filter((row) => Number.isFinite(Number(row.leadTimeDays)))
    .sort((a, b) => Number(b.leadTimeDays) - Number(a.leadTimeDays))
    .slice(-14);
  if (!rows.length) {
    return `<div class="history-empty-inline">리드타임 누적 데이터가 아직 부족합니다.</div>`;
  }
  return `
    <div class="history-lead-chart" aria-label="리드타임별 누적 판매율">
      ${rows.map((row) => {
        const rate = Number(row.saleRate);
        const height = Number.isFinite(rate) ? Math.max(4, Math.min(100, rate * 100)) : 0;
        const label = Number(row.leadTimeDays) === 0 ? "D-day" : `D-${fmtNumber(row.leadTimeDays)}`;
        return `
          <div title="${escapeHtml(`${label} · ${historyRateText(rate)} · ${fmtNumber(row.observations)}건`)}">
            <span><i style="height:${height}%"></i></span>
            <b>${escapeHtml(label)}</b>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function historyDayBars(byDay = []) {
  const order = ["월", "화", "수", "목", "금", "토", "일"];
  const mapped = new Map((byDay || []).map((row) => [row.label, row]));
  return `
    <div class="history-day-bars" aria-label="요일별 누적 판매율">
      ${order.map((label) => {
        const row = mapped.get(label);
        const rate = Number(row?.saleRate);
        const width = Number.isFinite(rate) ? Math.max(3, Math.min(100, rate * 100)) : 0;
        return `
          <div>
            <span>${label}</span>
            <i><em style="width:${width}%"></em></i>
            <strong>${historyRateText(rate)}</strong>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function historyTimelineChart(timeline = []) {
  const rows = [...timeline].slice(-8);
  if (!rows.length) {
    return `<div class="history-empty-inline">수집일별 변화 데이터가 아직 없습니다.</div>`;
  }
  return `
    <div class="history-timeline" aria-label="수집일별 누적 판매율 변화">
      ${rows.map((row) => {
        const rate = Number(row.saleRate);
        const height = Number.isFinite(rate) ? Math.max(4, Math.min(100, rate * 100)) : 0;
        const label = row.collectedDate ? row.collectedDate.slice(5).replace("-", "/") : "-";
        return `
          <div title="${escapeHtml(`${row.collectedDate || ""} · ${historyRateText(rate)} · ${fmtNumber(row.companyCount)}업체`)}">
            <b>${historyRateText(rate)}</b>
            <span><i style="height:${height}%"></i></span>
            <em>${escapeHtml(label)}</em>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function historyCompanyRows() {
  const benchmarks = historySource().benchmarks?.companyBenchmarks || {};
  const items = state.data?.availability?.items || [];
  return items
    .map((item) => {
      const key = companyKey(item.name);
      const benchmark = key ? benchmarks[key] : null;
      const flow = salesFlowProfile(item);
      const weekday = benchmark?.weekday;
      const all = benchmark?.all;
      const sat = flow.saturday;
      const currentAll = flow.all;
      const gap = Number.isFinite(Number(sat.rate)) && Number.isFinite(Number(weekday?.saleRate))
        ? Number(sat.rate) - Number(weekday.saleRate)
        : NaN;
      return { item, benchmark, weekday, all, sat, currentAll, gap };
    })
    .filter((row) => row.benchmark && (row.all?.observations || row.weekday?.observations))
    .sort((a, b) => {
      const gapA = Number.isFinite(a.gap) ? a.gap : -1;
      const gapB = Number.isFinite(b.gap) ? b.gap : -1;
      return gapB - gapA || Number(a.item.rank || 999) - Number(b.item.rank || 999);
    })
    .slice(0, 6);
}

function renderHistoryLab() {
  const history = historySource();
  const benchmarks = history.benchmarks || {};
  const rows = historyCompanyRows();
  const hasHistory = finiteNumber(history.observationCount, 0) > 0;
  if (!hasHistory) {
    return `
      <section class="history-lab empty-state">
        <div class="demand-card-head">
          <div>
            <h3>누적 DB</h3>
            <p>같은 키워드를 반복 수집하면 리드타임과 요일별 평균이 쌓입니다.</p>
          </div>
          <span>대기</span>
        </div>
      </section>
    `;
  }
  return `
    <section class="history-lab">
      <div class="demand-card-head">
        <div>
          <h3>누적 DB</h3>
          <p>동일 키워드 반복 수집 기반 리드타임·요일별·업체별 변화</p>
        </div>
        <span>${history.canAnalyzeLeadTime ? "분석 가능" : "누적 중"}</span>
      </div>
      <div class="history-metric-grid">
        ${historyMetricCard("누적 관측", fmtNumber(history.observationCount), `${fmtNumber(history.runCount)}회 수집 · ${fmtNumber(history.companyCount)}업체`)}
        ${historyMetricCard("현재 수집 반영", fmtNumber(history.currentRunObservationCount), "이번 결과 관측치")}
        ${historyMetricCard("누적 평일", historyRateText(benchmarks.weekday?.saleRate), `${fmtNumber(benchmarks.weekday?.observations || 0)}건`)}
        ${historyMetricCard("누적 전체", historyRateText(benchmarks.all?.saleRate), `${fmtNumber(benchmarks.all?.sold || 0)}/${fmtNumber(benchmarks.all?.supply || 0)}개`)}
      </div>
      <div class="history-layout">
        <article class="history-card">
          <div class="history-card-head">
            <strong>리드타임 곡선</strong>
            <small>D-day 기준 판매율</small>
          </div>
          ${historyLeadTimeChart(history.leadTime || [])}
        </article>
        <article class="history-card">
          <div class="history-card-head">
            <strong>요일별 평균</strong>
            <small>숙박 상품 누적 기준</small>
          </div>
          ${historyDayBars(benchmarks.byDay || [])}
        </article>
        <article class="history-card">
          <div class="history-card-head">
            <strong>수집일별 변화</strong>
            <small>최근 수집일 기준</small>
          </div>
          ${historyTimelineChart(history.timeline || [])}
        </article>
      </div>
      <div class="history-company-table">
        <div class="history-company-head">
          <span>업체</span><span>현재 전체</span><span>누적 평일</span><span>토-평일 차이</span>
        </div>
        ${rows.length ? rows.map(({ item, weekday, currentAll, gap }) => `
          <button type="button" data-open-company="${(state.data?.availability?.items || []).indexOf(item)}">
            <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
            <span>${historyRateText(currentAll.rate)}</span>
            <span>${historyRateText(weekday?.saleRate)}</span>
            <em>${Number.isFinite(gap) ? formatSignedRate(gap) : "대기"}</em>
          </button>
        `).join("") : `<p>업체별 누적 비교 데이터가 아직 부족합니다.</p>`}
      </div>
    </section>
  `;
}

function historyOpsSource() {
  return state.historyOps || {};
}

function activeHistoryKeywordSummary() {
  const keywordKey = companyKey(activeKeyword());
  const labelKey = companyKey(state.data?.run?.keyword || state.data?.run?.label || "");
  const keywords = historyOpsSource().keywords || [];
  return keywords.find((row) => row.keywordKey === keywordKey)
    || keywords.find((row) => row.keywordKey === labelKey)
    || keywords.find((row) => companyKey(row.keyword).includes(keywordKey) || keywordKey.includes(companyKey(row.keyword)))
    || keywords[0]
    || null;
}

function historyOpsCard(label, value, note = "") {
  return `
    <article>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </article>
  `;
}

function historyOpsTimeline(rows = []) {
  const items = [...rows].slice(-10);
  if (!items.length) return `<div class="history-empty-inline">수집 회차 데이터가 아직 없습니다.</div>`;
  const maxRate = Math.max(0.01, ...items.map((row) => Number(row.saleRate || 0)));
  return `
    <div class="history-ops-timeline" aria-label="누적 DB 수집 회차 변화">
      ${items.map((row) => {
        const rate = Number(row.saleRate);
        const height = Number.isFinite(rate) ? Math.max(5, Math.min(100, (rate / maxRate) * 100)) : 0;
        return `
          <div title="${escapeHtml(`${row.collectedDate} · ${historyRateText(rate)} · ${fmtNumber(row.companyCount)}업체`)}">
            <b>${historyRateText(rate)}</b>
            <span><i style="height:${height}%"></i></span>
            <em>${escapeHtml(String(row.collectedDate || "").slice(5).replace("-", "/"))}</em>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function historyOpsKeywordRows(activeKeywordRow) {
  const keywords = (historyOpsSource().keywords || []).slice(0, 8);
  if (!keywords.length) return `<div class="empty">누적 DB 키워드가 아직 없습니다.</div>`;
  return `
    <div class="history-ops-keyword-list">
      ${keywords.map((row) => {
        const active = activeKeywordRow && row.keywordKey === activeKeywordRow.keywordKey ? "active" : "";
        return `
          <article class="${active}">
            <div>
              <strong>${escapeHtml(row.keyword || "키워드 확인")}</strong>
              <small>최근 ${escapeHtml(row.latestCollectedDate || "대기")} · ${fmtNumber(row.runCount)}회 수집 · ${fmtNumber(row.companyCount)}업체</small>
            </div>
            <span>${historyRateText(row.saleRate)}</span>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function historyOpsComparison(row) {
  if (!row) return `<div class="empty">비교할 활성 키워드가 없습니다.</div>`;
  const comparison = row.comparison;
  const cells = [
    ["누적 판매율", historyRateText(row.saleRate), `${fmtNumber(row.sold)}/${fmtNumber(row.supply)}개`],
    ["수집 회차", `${fmtNumber(row.runCount)}회`, `${escapeHtml(row.firstCollectedDate || "-")}~${escapeHtml(row.latestCollectedDate || "-")}`],
    ["업체 범위", `${fmtNumber(row.companyCount)}업체`, `${fmtNumber(row.observations)}건 관측`],
    ["직전 대비", comparison ? formatSignedRate(comparison.saleRateDelta) : "대기", comparison ? `${comparison.previousDate}→${comparison.latestDate}` : "2회 이상 필요"]
  ];
  return `
    <div class="history-ops-comparison">
      ${cells.map(([label, value, note]) => `
        <article>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(note)}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function historyOpsAuditLog() {
  const entries = validationQueueEntries(state.data?.availability?.items || [], 4);
  if (!entries.length) {
    return `
      <div class="history-ops-log">
        <article class="good">
          <strong>현재 검증 큐 안정</strong>
          <span>우선 확인할 이상치가 없습니다.</span>
        </article>
      </div>
    `;
  }
  return `
    <div class="history-ops-log">
      ${entries.map(({ item, index, decision }) => `
        <button class="${escapeHtml(decision.tone)}" type="button" data-open-company="${index}">
          <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
          <span>${escapeHtml(decision.label)} · ${escapeHtml(decision.summary || "확인 필요")}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function historyOpsCompanyTrends(activeKeywordRow) {
  const trends = activeKeywordRow?.companyTrends || [];
  if (!trends.length) return `<div class="empty">업체별 누적 추이가 아직 부족합니다.</div>`;
  const currentItems = state.data?.availability?.items || [];
  return `
    <div class="history-ops-company-list">
      ${trends.slice(0, 6).map((trend) => {
        const itemIndex = currentItems.findIndex((item) => companyKey(item.name) === trend.companyKey);
        const buttonAttrs = itemIndex >= 0 ? `type="button" data-open-company="${itemIndex}"` : `type="button" disabled`;
        const spark = trend.byDate || [];
        return `
          <button ${buttonAttrs}>
            <div>
              <strong>${escapeHtml(trend.companyName || "업체명 확인")}</strong>
              <small>${fmtNumber(trend.runCount)}회 · ${fmtNumber(trend.observations)}건 · 변동폭 ${historyRateText(trend.volatility)}</small>
            </div>
            <div class="history-ops-spark" aria-label="${escapeHtml(`${trend.companyName || ""} 누적 추이`)}">
              ${spark.map((row) => {
                const rate = Number(row.saleRate);
                const height = Number.isFinite(rate) ? Math.max(4, Math.min(30, rate * 30)) : 0;
                return `<span title="${escapeHtml(`${row.collectedDate} · ${historyRateText(rate)}`)}" style="height:${height}px"></span>`;
              }).join("")}
            </div>
            <em>${historyRateText(trend.latest?.saleRate ?? trend.saleRate)}</em>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function companyProfileKeywordList(profile = {}) {
  const rows = profile.keywords || [];
  if (!rows.length) return `<div class="empty">아직 다른 키워드 노출 이력이 없습니다.</div>`;
  return `
    <div class="company-profile-keywords">
      ${rows.slice(0, 6).map((row) => `
        <span>
          <strong>${escapeHtml(row.keyword || "키워드")}</strong>
          <small>최고 ${row.bestRank ? `${fmtNumber(row.bestRank)}위` : "순위대기"} · ${fmtNumber(row.runCount || 0)}회</small>
        </span>
      `).join("")}
    </div>
  `;
}

function sheetManualCorrectionForm(profile = {}, item = {}) {
  if (!profile.companyId) return "";
  const candidateCorrection = profile.manualCorrection || item.companyManualCorrection || {};
  const correction = manualCorrectionHasValue(candidateCorrection) ? candidateCorrection : {};
  return `
    <div class="company-manual-form" data-company-manual-form data-company-id="${escapeHtml(profile.companyId)}">
      <div>
        <label>
          <span>숙박 운영 판매 기준</span>
          <input type="number" min="0" inputmode="numeric" data-manual-lodging value="${escapeHtml(correction.lodgingBasisTotal || "")}" placeholder="예: 26">
        </label>
        <label>
          <span>데이유즈/캠프닉 운영 기준</span>
          <input type="number" min="0" inputmode="numeric" data-manual-dayuse value="${escapeHtml(correction.dayUseBasisTotal || "")}" placeholder="예: 12">
        </label>
      </div>
      <label>
        <span>보정 메모</span>
        <input type="text" data-manual-note value="${escapeHtml(correction.note || "")}" placeholder="예: 전체 후보 28동, 현재 운영 26동">
      </label>
      <div class="company-manual-actions">
        <button type="button" data-save-company-correction data-company-id="${escapeHtml(profile.companyId)}">보정 저장</button>
        <button type="button" data-clear-company-correction data-company-id="${escapeHtml(profile.companyId)}">보정 해제</button>
      </div>
    </div>
  `;
}

function companyReviewHistoryPanel(profile = {}) {
  const rows = (profile.adminReviewHistory || []).slice().reverse().slice(0, 5);
  const current = profile.adminReview || null;
  if (!rows.length && !current) return "";
  return `
    <div class="company-review-history">
      <div>
        <strong>관리자 판단 이력</strong>
        <span>${current ? escapeHtml(current.label || companyAdminReviewLabel(current.status)) : "현재 판단 없음"}</span>
      </div>
      ${rows.length ? rows.map((row) => `
        <article>
          <b>${escapeHtml(row.label || companyAdminReviewLabel(row.status) || "판단 기록")}</b>
          <span>${escapeHtml(compactDateTime(row.at))}</span>
          <small>${escapeHtml(row.note || companyReviewContextText(row.context) || (row.action === "clear" ? "검증 상태를 해제했습니다." : "메모 없이 저장됨"))}</small>
        </article>
      `).join("") : `<article><b>${escapeHtml(current.label || companyAdminReviewLabel(current.status))}</b><span>${escapeHtml(compactDateTime(current.updatedAt))}</span><small>${escapeHtml(current.note || companyReviewContextText(current.context) || "현재 저장된 판단입니다.")}</small></article>`}
    </div>
  `;
}

function sheetCompanyProfile(item = {}) {
  const profile = item.companyProfile || {};
  if (!profile.companyId) return "";
  const active = profile.activeKeyword;
  const correctionInfo = manualCorrectionInfo(item);
  const correctionStatus = correctionStatusInfo(item);
  const cells = [
    ["누적 수집", `${fmtNumber(profile.runCount || 0)}회`, `${fmtNumber(profile.keywordCount || 0)}개 키워드`],
    ["노출 레이어", profile.exposureLayer?.label || "분류 대기", profile.exposureLayer?.note || "키워드 누적 필요"],
    ["최고 노출", profile.bestRank ? `${fmtNumber(profile.bestRank)}위` : "대기", profile.bestKeyword || "키워드 누적 중"],
    ["현재 키워드", active?.latestRank ? `${fmtNumber(active.latestRank)}위` : "대기", active?.keyword || activeKeyword()],
    ["보정 상태", correctionStatus.label, correctionInfo ? `${correctionInfo.label} · ${correctionInfo.note}` : correctionStatus.detail]
  ];
  return `
    <section class="sheet-section sheet-company-profile-section">
      <div class="sheet-structure-title">
        <h3>누적 업체 프로필</h3>
        <span class="structure-badge watch">${escapeHtml(profile.companyId)}</span>
      </div>
      <div class="sheet-history-grid">
        ${cells.map(([label, value, note]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(note)}</small>
          </div>
        `).join("")}
      </div>
      ${companyProfileKeywordList(profile)}
      ${companyReviewHistoryPanel(profile)}
      ${companyReviewActionsHtml(profile, true)}
      ${sheetManualCorrectionEvidence(item)}
      ${sheetManualCorrectionForm(profile, item)}
    </section>
  `;
}

function sheetManualCorrectionEvidence(item = {}) {
  const info = manualCorrectionInfo(item);
  if (!info) return "";
  const lodging = salesStats(item, "lodging");
  const day = salesStats(item, "day");
  const rawLodging = finiteNumber(item.rawNightTotalStock, finiteNumber(item.rawWeeklyBasisTotal, 0));
  const rawDayUse = finiteNumber(item.rawDayUseTotalStock, finiteNumber(item.rawDayUseWeeklyBasisTotal, 0));
  const rows = [
    ["숙박 기준", lodging.supply ? `${fmtNumber(lodging.sold)}/${fmtNumber(lodging.supply)}개` : "확인필요", rawLodging ? `네이버 원본 ${fmtNumber(rawLodging)}개` : "원본 총량 대기"],
    ["데이유즈 기준", day.supply ? `${fmtNumber(day.sold)}/${fmtNumber(day.supply)}회` : "없음", rawDayUse ? `네이버 원본 ${fmtNumber(rawDayUse)}회` : "원본 총량 대기"],
    ["보정 메모", info.note || "메모 없음", info.label]
  ];
  return `
    <div class="manual-correction-evidence">
      ${rows.map(([label, value, note]) => `
        <div>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(note)}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function companyMasterTools() {
  return `
    <div class="company-master-tools">
      <button type="button" data-company-backfill>기존 결과 전체 반영</button>
      <small>저장된 수집 결과를 다시 읽어 업체 고유키, 노출 키워드, 수동 보정 재사용 기준을 마스터 DB에 누적합니다.</small>
    </div>
  `;
}

function companyMasterBackfillResult(master = {}) {
  const backfill = master.backfill;
  if (!backfill) return "";
  return `
    <div class="company-master-backfill">
      <strong>백필 완료</strong>
      <p>${fmtNumber(backfill.processedRuns || 0)}개 결과 반영 · ${fmtNumber(backfill.touchedCompanies || 0)}개 업체 확인 · 실패 ${fmtNumber(backfill.failedRuns || 0)}건</p>
      ${(backfill.runs || []).length ? `
        <div>
          ${(backfill.runs || []).slice(0, 5).map((run) => `
            <span>${escapeHtml(run.label || run.runId)} · ${fmtNumber(run.currentRunCompanies || 0)}업체</span>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function companyMasterCrossKeywordPanel(master = {}) {
  const cross = master.crossKeyword || {};
  if (!cross.totalCompanies) return "";
  const regionalLocalCompanies = cross.regionalLocalCompanies || [];
  const localOnlyCompanies = cross.localOnlyCompanies || [];
  const pendingCompanies = cross.localMatchPendingCompanies || [];
  const companyOnlyCompanies = cross.companyOnlyCompanies || [];
  const reviewCompanies = cross.reviewNeededCompanies || [];
  const confidence = cross.confidenceCounts || {};
  const renderLayerCompanies = (companies, emptyText) => companies.length ? companies.slice(0, 6).map((company) => `
    <article>
      <div>
        <b>${escapeHtml(company.primaryName || "업체명 확인")}</b>
        <small>${escapeHtml(company.exposureLayer?.label || "분류 대기")} · ${fmtNumber(company.keywordCount || 0)}개 키워드 · ${fmtNumber(company.runCount || 0)}회</small>
      </div>
      <p>${(company.keywords || []).map((row) => {
        const label = row.layer?.label ? `${row.keyword}(${row.layer.label})` : row.keyword;
        return escapeHtml(label || "");
      }).filter(Boolean).join(" · ") || "키워드 대기"}</p>
    </article>
  `).join("") : `<p>${escapeHtml(emptyText)}</p>`;
  return `
    <div class="company-cross-panel">
      <div class="company-cross-metrics">
        <article><span>광역+로컬</span><strong>${fmtNumber(cross.regionalLocalCompanyCount || 0)}</strong><small>권역 강자</small></article>
        <article><span>로컬 전용</span><strong>${fmtNumber(cross.localOnlyCompanyCount || 0)}</strong><small>개선 후보</small></article>
        <article><span>매칭 대기</span><strong>${fmtNumber(cross.localMatchPendingCompanyCount || 0)}</strong><small>로컬 수집 필요</small></article>
        <article><span>확실/높음</span><strong>${fmtNumber((confidence["확실"] || 0) + (confidence["높음"] || 0))}</strong><small>ID 기반</small></article>
      </div>
      <div class="company-cross-list">
        <strong>광역+로컬 장악형</strong>
        ${renderLayerCompanies(regionalLocalCompanies, "아직 광역과 로컬에 동시에 잡힌 업체가 없습니다. 권역 키워드와 지역 키워드를 함께 쌓으면 확인됩니다.")}
      </div>
      <div class="company-cross-list">
        <strong>로컬 전용 개선 후보</strong>
        ${renderLayerCompanies(localOnlyCompanies, "아직 로컬 전용 후보가 없습니다. 지역 키워드 수집이 늘어나면 광역 미노출 업체를 찾을 수 있습니다.")}
      </div>
      <div class="company-cross-list">
        <strong>로컬 매칭 대기</strong>
        ${renderLayerCompanies(pendingCompanies, "광역 노출 업체의 대응 로컬 키워드가 모두 매칭되었습니다.")}
      </div>
      ${companyOnlyCompanies.length ? `
        <div class="company-cross-list">
          <strong>업체명 확인형</strong>
          ${renderLayerCompanies(companyOnlyCompanies, "업체명 검색 전용 업체가 없습니다.")}
        </div>
      ` : ""}
      <div class="company-master-rule">
        <strong>해석 기준</strong>
        <p>광역 키워드 노출은 네이버 가산점이 높은 업체로 해석하고, 로컬 키워드에만 노출되는 업체를 개선 후보로 봅니다. 광역에서만 보이는 업체는 유형이 아니라 로컬 매칭 대기 상태입니다.</p>
      </div>
      ${reviewCompanies.length ? `
        <div class="company-cross-list">
          <strong>고유키 신뢰도 보강 대상</strong>
          ${reviewCompanies.slice(0, 4).map((company) => `
            <article>
              <div>
                <b>${escapeHtml(company.primaryName || "업체명 확인")}</b>
                <small>${escapeHtml(company.identityConfidence?.label || "검토 필요")} · ${escapeHtml(company.identityConfidence?.reason || "")}</small>
              </div>
            </article>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function companyTargetCategoryLabel(category) {
  return {
    contact: "컨택 후보",
    observe: "관찰 후보",
    verify: "검증 후보",
    benchmark: "벤치마크",
    exclude: "제외 후보"
  }[category] || "관찰 후보";
}

function companyMasterKeywordText(company = {}) {
  const keywords = company.keywords || [];
  if (!keywords.length) return "키워드 없음";
  return keywords.slice(0, 4).map((row) => {
    const layer = row.layer?.label ? `/${row.layer.label}` : "";
    const rank = row.bestRank ? ` ${fmtNumber(row.bestRank)}위` : "";
    return `${row.keyword || "키워드"}${layer}${rank}`;
  }).join(" · ");
}

function companyMasterKeywordChips(company = {}, limit = 6) {
  const keywords = company.keywords || [];
  if (!keywords.length) return `<div class="company-keyword-chips"><span>키워드 없음</span></div>`;
  return `
    <div class="company-keyword-chips">
      ${keywords.slice(0, limit).map((row) => {
        const rank = row.bestRank ? `${fmtNumber(row.bestRank)}위` : "순위대기";
        const latest = row.latestRank && row.latestRank !== row.bestRank ? ` / 최근 ${fmtNumber(row.latestRank)}위` : "";
        return `<span>${escapeHtml(row.keyword || "키워드")} <b>${escapeHtml(rank + latest)}</b></span>`;
      }).join("")}
      ${keywords.length > limit ? `<span>+${fmtNumber(keywords.length - limit)}개</span>` : ""}
    </div>
  `;
}

function companyMasterIdentityTag(company = {}) {
  const level = company.identityConfidence?.level || "review";
  const label = company.identityConfidence?.label || "검토 필요";
  return `<span class="company-identity-tag ${escapeHtml(level)}">${escapeHtml(label)}</span>`;
}

function companyMasterCorrectionTag(company = {}) {
  const status = company.correctionStatus || {};
  const isAdmin = status.key === "admin_override" || manualCorrectionHasValue(company.manualCorrection);
  return `<span class="company-correction-status ${isAdmin ? "admin" : "auto"}">${escapeHtml(isAdmin ? "관리자 보정" : "자동추정")}</span>`;
}

function companyMasterSourceTag(company = {}) {
  const sources = company.collectionSources || [];
  const latest = company.inventory?.latest || {};
  const latestSource = latest.collectionSource || sources[0] || "admin_search";
  const b2bCount = Number((company.sourceStats || []).find((row) => row.collectionSource === "b2b_search")?.runCount || 0);
  if (sources.includes("b2b_search") || latestSource === "b2b_search") {
    return `<span class="company-source-tag b2b">B2B 검색${b2bCount ? ` ${fmtNumber(b2bCount)}회` : ""}</span>`;
  }
  return `<span class="company-source-tag admin">관리자 수집</span>`;
}

function companyMasterVerificationItem(company = {}, meta = "") {
  return `
    <article>
      <div>
        <b>${escapeHtml(company.primaryName || "업체명 확인")}</b>
        <span>${escapeHtml(company.exposureLayer?.label || "분류 대기")}</span>
      </div>
      <small>${escapeHtml(meta || company.salesTarget?.recommendation || "검증 정보 대기")}</small>
      <div class="company-verification-tags">
        ${companyMasterIdentityTag(company)}
        ${companyMasterCorrectionTag(company)}
        <span>${fmtNumber(company.keywordCount || 0)}키워드</span>
        <span>${fmtNumber(company.runCount || 0)}회</span>
      </div>
      ${companyMasterKeywordChips(company, 4)}
    </article>
  `;
}

function companyMasterVerificationPanel(master = {}) {
  const companies = master.companies || [];
  if (!companies.length) return "";
  const trusted = companies.filter((company) => ["certain", "high"].includes(company.identityConfidence?.level) || (company.placeIds || []).length || (company.bookingBusinessIds || []).length);
  const merged = companies
    .filter((company) => Number(company.keywordCount || 0) >= 2)
    .sort((a, b) => (b.keywordCount || 0) - (a.keywordCount || 0) || (b.runCount || 0) - (a.runCount || 0));
  const corrections = companies
    .filter((company) => manualCorrectionHasValue(company.manualCorrection))
    .sort((a, b) => String(b.correctionStatus?.updatedAt || "").localeCompare(String(a.correctionStatus?.updatedAt || "")));
  const review = companies
    .map((company) => ({ company, profile: companyNeedsCorrection(company) }))
    .filter(({ company, profile }) => profile.needed || company.identityConfidence?.level === "review")
    .sort((a, b) => b.profile.priority - a.profile.priority || (a.company.bestRank || 9999) - (b.company.bestRank || 9999));
  const latestSeenAt = companies.map((company) => company.lastSeenAt).filter(Boolean).sort().at(-1) || "";
  const recentDate = master.history?.latestCollectedAt || master.latestCollectedAt || latestSeenAt;
  const renderLane = (title, note, rows, emptyText, metaBuilder) => `
    <div class="company-verification-lane">
      <div>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(note)}</small>
      </div>
      ${rows.length ? rows.slice(0, 4).map((company) => companyMasterVerificationItem(company, metaBuilder ? metaBuilder(company) : "")).join("") : `<p class="empty">${escapeHtml(emptyText)}</p>`}
    </div>
  `;
  return `
    <section class="company-verification-panel">
      <div class="company-verification-head">
        <div>
          <strong>업체 DB 검증</strong>
          <small>고유키, 키워드 병합, 보정 재사용 상태를 먼저 확인합니다.</small>
        </div>
        <span>${escapeHtml(recentDate ? recentDate.slice(0, 10) : "누적 DB")}</span>
      </div>
      <div class="company-verification-metrics">
        <article><span>고유키 안정</span><strong>${fmtNumber(trusted.length)}</strong><small>place_id/예약ID 기반</small></article>
        <article><span>키워드 병합</span><strong>${fmtNumber(merged.length)}</strong><small>2개 이상 키워드 연결</small></article>
        <article><span>보정 재사용</span><strong>${fmtNumber(corrections.length)}</strong><small>업체 단위 보정값</small></article>
        <article><span>확인 필요</span><strong>${fmtNumber(review.length)}</strong><small>수량/ID/OTA 검토</small></article>
      </div>
      <div class="company-verification-grid">
        ${renderLane(
          "보정 재사용",
          "한 번 저장한 보정값이 다른 키워드 수집에도 붙는 업체",
          corrections,
          "현재 관리자 보정값이 있는 업체가 없습니다.",
          (company) => company.correctionStatus?.detail || "관리자 보정값 기준"
        )}
        ${renderLane(
          "키워드 병합 확인",
          "권역·지역·업체명 검색이 같은 업체로 합쳐진 사례",
          merged,
          "아직 2개 이상 키워드가 연결된 업체가 없습니다.",
          (company) => `${fmtNumber(company.keywordCount || 0)}개 키워드 · 최고 ${company.bestRank ? `${fmtNumber(company.bestRank)}위` : "순위대기"}`
        )}
        ${renderLane(
          "확인 필요",
          "판단이 흔들릴 수 있어 관리자 확인이 필요한 업체",
          review.map((entry) => entry.company),
          "현재 확인 필요 업체가 없습니다.",
          (company) => (company.salesTarget?.reasons || []).slice(0, 2).join(" · ") || company.identityConfidence?.reason || "추가 확인 필요"
        )}
      </div>
    </section>
  `;
}

function companySalesTargetTagHtml(company = {}, limit = 6) {
  const tags = company.salesTarget?.priorityTags || [];
  if (!tags.length) return "";
  return `
    <div class="company-target-tags">
      ${tags.slice(0, limit).map((tag) => `<mark>${escapeHtml(tag)}</mark>`).join("")}
    </div>
  `;
}

function companyAdminReviewLabel(status) {
  return {
    confirmed: "확인 완료",
    check_needed: "확인 필요",
    recrawl_needed: "재수집 필요",
    contact_ready: "컨택 가능",
    hold: "보류",
    exclude: "제외",
    manual_needed: "보정 필요"
  }[status] || "미검증";
}

function companyAdminReviewBadgeHtml(company = {}) {
  const status = company.adminReview?.status || "";
  if (!status) return "";
  const label = company.adminReview?.label || companyAdminReviewLabel(status);
  return `<span class="company-review-badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function companyReviewActionsHtml(company = {}, compact = false) {
  const companyId = company.companyId || "";
  const current = company.adminReview?.status || "";
  const note = company.adminReview?.note || "";
  const actions = [
    ["check_needed", "확인"],
    ["recrawl_needed", "재수집"],
    ["manual_needed", "보정"],
    ["contact_ready", "컨택"],
    ["hold", "보류"],
    ["exclude", "제외"]
  ];
  return `
    <div class="company-review-control ${compact ? "compact" : ""}" data-company-review-control data-company-id="${escapeHtml(companyId)}">
      <input type="text" data-company-review-note value="${escapeHtml(note)}" placeholder="확인 채널, 재수집 범위, 수량/가격 메모">
      <div class="company-review-actions ${compact ? "compact" : ""}">
        ${actions.map(([status, label]) => `
          <button type="button" class="${current === status ? "active" : ""}" data-company-review-action="${status}" data-company-id="${escapeHtml(companyId)}">${label}</button>
        `).join("")}
        ${current ? `<button type="button" data-company-review-action="clear" data-company-id="${escapeHtml(companyId)}">해제</button>` : ""}
      </div>
    </div>
  `;
}

function companyDecisionQueueProfile(company = {}) {
  const latest = company.inventory?.latest || {};
  const signals = company.salesTarget?.signals || {};
  const salesSignal = latest.salesSignal || {};
  const structureFlags = new Set([
    ...(Array.isArray(latest.structureFlags) ? latest.structureFlags : []),
    ...(Array.isArray(salesSignal.structureFlags) ? salesSignal.structureFlags : [])
  ]);
  const confidenceGrade = String(latest.confidenceGrade || "").toUpperCase() || "C";
  const structureLabel = latest.structureLabel || "구조 대기";
  const review = company.adminReview || {};
  const hasManualCorrection = manualCorrectionHasValue(company.manualCorrection);
  const manualNeedsReview = Boolean(
    review.status === "manual_needed" ||
    (hasManualCorrection && (!review.status || isReviewBeforeCorrection(review, company.manualCorrection || {})))
  );
  const staleAfterReview = Boolean(
    review.status &&
    latest.collectedAt &&
    review.updatedAt &&
    isAfterDate(latest.collectedAt, review.updatedAt)
  );
  const revenueEvidence = queueRevenueEvidenceProfile(companyQueueRevenueImpact(company));
  const gapLabels = [
    signals.fridayWeak ? `금요일 ${fmtRate(signals.fridayRate)}` : "",
    signals.sundayWeak ? `일요일 ${fmtRate(signals.sundayRate)}` : "",
    signals.weekdayWeak ? `평일 ${fmtRate(signals.weekdayRate)}` : ""
  ].filter(Boolean);
  const criteria = [
    (signals.otaReviewNeeded || structureFlags.has("booking_id_reused") || structureFlags.has("dynamic_capacity")) ? {
      key: "ota",
      label: "OTA 확인 필요",
      reason: "네이버 기준만으로 컨택 여부를 확정하기 어려움",
      action: "여기어때 수동 보완, NOL/야놀자, 떠나요 노출과 가격 비교"
    } : null,
    (signals.structureWeak || ["C", "D", "E"].includes(confidenceGrade) || structureFlags.has("grouped_range") || structureFlags.has("booking_id_reused")) ? {
      key: "quantity",
      label: "수량 구조 불명확",
      reason: `수량 신뢰도 ${confidenceGrade} · ${structureLabel}`,
      action: "네이버 객실 탭에서 객실/상품 단위와 실제 총량 확인"
    } : null,
    (signals.stockVariance || structureFlags.has("dynamic_capacity")) ? {
      key: "capacity",
      label: "날짜별 총량 변동 큼",
      reason: "날짜별 판매 가능 총량이 흔들림",
      action: "미오픈/차단/온라인 미노출은 오프라인 예약 가능성으로 메모"
    } : null,
    gapLabels.length ? {
      key: "gap",
      label: "판매 공백 큼",
      reason: `네이버 노출 대비 ${gapLabels.join(" · ")} 공백`,
      action: "금요일/일요일/평일 가격, 연박, 퇴실 조건 확인"
    } : null,
    manualNeedsReview ? {
      key: "manual_recheck",
      label: "수동 보정 후 재검토 필요",
      reason: hasManualCorrection ? (company.correctionStatus?.detail || "관리자 보정값 보유") : "관리자가 보정 필요로 지정",
      action: "보정값 적용 후 컨택/보류/제외 판단 재저장"
    } : null,
    revenueEvidence.weak ? {
      key: "revenue",
      label: "매출 근거 보강",
      reason: compactListText(revenueEvidence.reasons, "요일/상품/가격 근거 확인 필요", 3),
      action: "요일별 가격과 상품별 수량을 같은 기간으로 재수집"
    } : null
  ].filter(Boolean);
  if (staleAfterReview && criteria.length) {
    criteria.unshift({
      key: "recheck",
      label: "관리자 판단 후 재확인",
      reason: "이전 판단 이후 새 수집 신호가 들어옴",
      action: "변경된 신호만 확인하고 판단을 다시 저장"
    });
  }
  const closed = ["confirmed", "contact_ready", "hold", "exclude"].includes(review.status || "");
  const inQueue = criteria.length > 0 && (!closed || staleAfterReview || manualNeedsReview);
  const channels = [];
  if (criteria.some((criterion) => criterion.key === "ota")) channels.push("여기어때 수동", "NOL/야놀자", "떠나요");
  if (criteria.some((criterion) => criterion.key === "quantity")) channels.push("네이버 객실 탭");
  if (criteria.some((criterion) => criterion.key === "capacity")) channels.push("전화예약/오프라인");
  if (criteria.some((criterion) => criterion.key === "gap")) channels.push("네이버 가격/일자");
  if (criteria.some((criterion) => criterion.key === "manual_recheck")) channels.push("관리자 보정 메모");
  if (criteria.some((criterion) => criterion.key === "revenue")) channels.push("네이버 가격/상품");
  return {
    inQueue,
    criteria,
    priority: criteria.length * 18 + (staleAfterReview ? 28 : 0) + Number(company.salesTarget?.score || 0) / 5,
    label: criteria[0]?.label || "판단 대기",
    reasons: criteria.map((criterion) => `${criterion.label}: ${criterion.reason}`),
    actions: criteria.map((criterion) => criterion.action).filter(Boolean),
    problemDateText: compactListText([salesSignal.checkIn, ...gapLabels].filter(Boolean), "최근 수집일 기준", 4),
    quantityConfidence: `신뢰도 ${confidenceGrade} · ${structureLabel}`,
    gapType: compactListText(gapLabels, "공백 특이 없음", 3),
    channelText: compactListText(channels, "네이버 기준", 4),
    correctionText: hasManualCorrection ? (company.correctionStatus?.detail || "관리자 보정") : "자동추정",
    adminReviewText: review.label || companyAdminReviewLabel(review.status),
    tone: criteria.some((criterion) => ["ota", "quantity", "capacity", "revenue"].includes(criterion.key)) ? "watch" : "good"
  };
}

function companyNeedsCorrection(company = {}) {
  const signals = company.salesTarget?.signals || {};
  const tags = company.salesTarget?.priorityTags || [];
  const reasons = company.salesTarget?.reasons || [];
  const latest = company.inventory?.latest || {};
  const hasManualCorrection = manualCorrectionHasValue(company.manualCorrection);
  const hasText = (text) => tags.some((tag) => String(tag).includes(text)) || reasons.some((reason) => String(reason).includes(text));
  const decision = companyDecisionQueueProfile(company);
  const issues = [];
  if (signals.structureWeak || hasText("수량구조") || ["C", "D", "E"].includes(String(latest.confidenceGrade || "").toUpperCase())) {
    issues.push({ key: "structure", label: "수량구조", task: "객실별/종류별 판매 방식과 실제 총 객실수 확인" });
  }
  if (signals.bookingIdReused || hasText("예약ID")) {
    issues.push({ key: "booking", label: "예약ID", task: "네이버 예약ID와 상품명이 현재 객실 구조와 맞는지 확인" });
  }
  if (signals.stockVariance || hasText("오프라인")) {
    issues.push({ key: "offline", label: "총량변동", task: "전화예약/비연동 채널 조절 가능성을 메모" });
  }
  if (signals.dayUseMissing || hasText("당일") || hasText("캠프닉")) {
    issues.push({ key: "dayuse", label: "당일상품", task: "데이유즈/캠프닉 회차와 판매 가능 수량 확인" });
  }
  if (signals.otaReviewNeeded || hasText("OTA")) {
    issues.push({ key: "ota", label: "OTA", task: "NOL/떠나요/여기어때 노출과 가격 보조 확인" });
  }
  if ((signals.fridayWeak || signals.sundayWeak || signals.weekdayWeak) && !issues.some((issue) => issue.key === "gap")) {
    issues.push({ key: "gap", label: "판매 공백", task: "금요일/일요일/평일 공백을 확인한 뒤 컨택 여부 판단" });
  }
  if (decision.criteria.some((criterion) => criterion.key === "manual_recheck") && !issues.some((issue) => issue.key === "manual")) {
    issues.unshift({ key: "manual", label: "보정 후 재검토", task: "수동 보정값 적용 후 판단을 다시 저장" });
  }
  if (company.adminReview?.status === "manual_needed" && !issues.some((issue) => issue.key === "manual")) {
    issues.unshift({ key: "manual", label: "관리자 보정", task: "관리자가 보정 필요로 지정한 업체" });
  }
  return {
    needed: decision.inQueue || company.adminReview?.status === "manual_needed" || issues.length > 0,
    issues,
    applied: hasManualCorrection,
    decision,
    priority: decision.priority + (company.adminReview?.status === "manual_needed" ? 40 : 0) + issues.length * 12 + (hasManualCorrection ? -18 : 0) + Number(company.salesTarget?.score || 0) / 10
  };
}

function companyCheckEntryType(company = {}, profile = {}) {
  const reviewStatus = company.adminReview?.status || "";
  if (reviewStatus === "recrawl_needed") return { key: "recrawl", label: "재수집 필요" };
  if (reviewStatus === "check_needed") return { key: "check", label: "확인 필요" };
  if (reviewStatus === "contact_ready") return { key: "contact", label: "컨택 가능" };
  if (reviewStatus === "manual_needed") return { key: "correction", label: "보정 필요" };
  const issues = profile.issues || [];
  if (issues.some((issue) => ["structure", "booking", "offline", "dayuse", "manual"].includes(issue.key))) {
    return { key: "correction", label: "보정 필요" };
  }
  if ((profile.decision?.criteria || []).some((criterion) => criterion.key === "revenue")) return { key: "recrawl", label: "매출 근거 보강" };
  if (issues.some((issue) => issue.key === "ota")) return { key: "ota", label: "OTA 확인" };
  if (issues.some((issue) => issue.key === "gap")) return { key: "gap", label: "판매 공백" };
  if (company.salesTarget?.category === "contact") return { key: "contact", label: "컨택 후보" };
  if (company.salesTarget?.category === "benchmark") return { key: "benchmark", label: "벤치마크" };
  if (company.salesTarget?.category === "exclude" || company.identityConfidence?.level === "review") return { key: "exclude", label: "제외 검토" };
  return { key: "observe", label: "관찰" };
}

function companyCheckReasons(company = {}, profile = {}, workflow = {}, decision = {}) {
  const issueReasons = (profile.issues || []).map((issue) => `${issue.label}: ${issue.task}`);
  const workflowReasons = workflow.key === "recheck" ? (workflow.reasons || []).map((reason) => `재확인: ${reason}`) : [];
  const decisionReasons = decision.inQueue ? decision.reasons || [] : [];
  const targetReasons = company.salesTarget?.reasons || [];
  const fallback = company.salesTarget?.recommendation || company.identityConfidence?.reason || "추가 확인 후 판단";
  return [...new Set([...workflowReasons, ...decisionReasons, ...issueReasons, ...targetReasons, fallback].filter(Boolean))].slice(0, 4);
}

function companyCheckRecommendation(company = {}, profile = {}, workflow = {}, decision = {}) {
  if (workflow.key === "recheck" && workflow.label === "보정 후 재검토") return "보정값 기준 판매율과 실제 총량을 확인한 뒤 컨택/보류/제외 판단을 다시 저장하세요.";
  if (workflow.key === "recheck") return "기존 관리자 판단 이후 조건이 바뀌었습니다. 변경 사유만 확인하고 판단을 다시 저장하세요.";
  if (workflow.key === "done") return "이미 처리된 업체입니다. 새 신호가 생기면 재확인 큐로 자동 이동합니다.";
  const issues = profile.issues || [];
  if (issues.some((issue) => ["structure", "booking", "offline", "dayuse", "manual"].includes(issue.key))) {
    return profile.applied ? "보정값이 적용되어 있습니다. 실제 총량과 맞는지 확인 후 확정하세요." : "수량 구조를 확인하고 필요하면 관리자 보정값을 입력하세요.";
  }
  if ((decision.criteria || []).some((criterion) => criterion.key === "revenue")) return "요일별 가격과 상품종류별 수량 근거를 먼저 보강한 뒤 컨택 가능 여부를 다시 판단하세요.";
  if (issues.some((issue) => issue.key === "ota")) return "OTA 노출과 가격을 확인한 뒤 컨택/보류를 결정하세요.";
  if ((decision.criteria || []).some((criterion) => criterion.key === "gap") || issues.some((issue) => issue.key === "gap")) return "판매 공백 날짜의 가격/연박 조건을 확인한 뒤 바로 컨택할지 보류할지 정하세요.";
  if (company.salesTarget?.category === "contact") return "노출은 있으나 개선 여지가 있는 업체입니다. 컨택 후보로 검토하세요.";
  if (company.salesTarget?.category === "benchmark") return "광역과 로컬에서 강한 업체입니다. 벤치마크로 관찰하세요.";
  if (company.salesTarget?.category === "exclude" || company.identityConfidence?.level === "review") return "글램핑 적합성 또는 업체 동일성을 확인한 뒤 제외 여부를 정하세요.";
  return "누적 수집을 더 쌓아 관찰 유지 여부를 판단하세요.";
}

function isAfterDate(value, base) {
  const left = Date.parse(value || "");
  const right = Date.parse(base || "");
  return Number.isFinite(left) && Number.isFinite(right) && left > right;
}

function companyReviewRecheckProfile(company = {}, profile = {}) {
  const review = company.adminReview || null;
  if (!review?.status) return { needed: false, reasons: [] };
  const reviewAt = review.updatedAt || "";
  const latest = company.inventory?.latest || {};
  const latestAt = latest.collectedAt || company.lastSeenAt || "";
  const hasNewCollection = isAfterDate(latestAt, reviewAt) || isAfterDate(company.lastSeenAt, reviewAt);
  const newKeywords = (company.keywords || []).filter((row) => isAfterDate(row.lastSeenAt, reviewAt));
  const issueKeys = new Set((profile.issues || []).map((issue) => issue.key).filter((key) => key !== "manual"));
  const reasons = [];

  if (review.status === "manual_needed" && profile.applied) {
    return { needed: true, reasons: ["관리자 보정값이 적용되어 컨택 여부 재판단 필요"] };
  }

  if (!reviewAt) return { needed: false, reasons: [] };
  if (hasNewCollection && review.status === "recrawl_needed") {
    reasons.push("재수집 필요 판단 이후 새 수집 결과가 들어와 전후 비교가 필요");
  }
  if (hasNewCollection && issueKeys.size) {
    reasons.push(`기존 판단 이후 ${[...issueKeys].map((key) => ({
      structure: "수량구조",
      booking: "예약ID",
      offline: "총량변동",
      dayuse: "당일상품",
      ota: "OTA"
    }[key] || key)).join(", ")} 신호 발생`);
  }
  if (newKeywords.length && Number(company.bestRank || 0) > 0 && Number(company.bestRank || 0) <= 10) {
    reasons.push(`기존 판단 이후 새 키워드 노출 ${newKeywords.slice(0, 2).map((row) => row.keyword).filter(Boolean).join(", ")}`);
  }
  if (hasNewCollection && ["D", "E"].includes(String(latest.confidenceGrade || "").toUpperCase())) {
    reasons.push(`수량 신뢰도 ${latest.confidenceGrade} 등급으로 악화`);
  }
  if (review.status === "exclude" && hasNewCollection && Number(company.bestRank || 9999) <= 5) {
    reasons.push("제외 후 상위권 노출이 다시 확인됨");
  }
  if (["confirmed", "contact_ready"].includes(review.status) && hasNewCollection && company.salesTarget?.category === "verify") {
    reasons.push("컨택 가능 판단 후 검증 후보 신호가 다시 발생");
  }

  return {
    needed: reasons.length > 0,
    reasons: reasons.slice(0, 4),
    reviewAt,
    latestAt
  };
}

function companyCheckWorkflow(company = {}, profile = {}, type = {}) {
  const review = company.adminReview || null;
  const recheck = companyReviewRecheckProfile(company, profile);
  if (review?.status === "manual_needed" && profile.applied) {
    return { key: "recheck", label: "보정 후 재검토", tone: "recheck", reasons: ["보정값이 입력되어 판단을 다시 저장해야 함"] };
  }
  if (!recheck.needed && review?.status === "recrawl_needed") {
    return { key: "open", label: "재수집 필요", tone: "open", reasons: ["관리자가 재수집 필요로 지정"] };
  }
  if (!recheck.needed && review?.status === "check_needed") {
    return { key: "open", label: "확인 필요", tone: "open", reasons: ["관리자가 확인 필요로 지정"] };
  }
  if (!recheck.needed && review?.status === "manual_needed") {
    return { key: "open", label: "수동 보정 필요", tone: "open", reasons: ["관리자가 수동 보정 필요로 지정"] };
  }
  if (recheck.needed) {
    return { key: "recheck", label: "재확인", tone: "recheck", reasons: recheck.reasons };
  }
  if (review?.status === "contact_ready") {
    return { key: "done", label: "컨택 가능", tone: "done", reasons: ["관리자가 컨택 가능으로 확정"] };
  }
  if (review?.status === "confirmed") {
    return { key: "done", label: "확인 완료", tone: "done", reasons: ["관리자가 판단 맞음으로 확정"] };
  }
  if (review?.status === "exclude") {
    return { key: "done", label: "제외 완료", tone: "done", reasons: ["관리자가 제외로 확정"] };
  }
  if (review?.status === "hold") {
    return { key: "done", label: "보류", tone: "hold", reasons: ["관리자가 보류로 지정"] };
  }
  return { key: "open", label: type.label || "오늘 처리", tone: "open", reasons: [] };
}

function queueRevenueCoverageShort(part = {}) {
  const priced = finiteNumber(part.pricedSoldOut, 0);
  const missing = finiteNumber(part.missingPriceSoldOut, 0);
  const unit = part.unit || "";
  if (!priced && !missing) return "가격 판매수량 대기";
  return `가격확인 ${fmtNumber(priced)}${unit}${missing ? ` · 가격누락 ${fmtNumber(missing)}${unit}` : ""}`;
}

function queueRevenueDetailShort(part = {}, fallback = "요일별 가격/수량 추가 확인") {
  return compactListText([part.byDayType, part.offlineDetail, part.detail].filter(Boolean), fallback, 2);
}

function queueRevenueDayCoverageSummary(impact = {}) {
  const labels = ["평일", "금요일", "토요일", "일요일"];
  const sourceRows = [
    ...(impact.lodgingDayRows || []).map((row) => ({ ...row, kindLabel: "숙박", unit: row.unit || "개" })),
    ...(impact.dayUseDayRows || []).map((row) => ({ ...row, kindLabel: "데이유즈", unit: row.unit || "회" }))
  ];
  const segments = labels.map((label) => {
    const rows = sourceRows.filter((row) => row.label === label);
    const priced = rows.reduce((sum, row) => sum + finiteNumber(row.pricedSoldOut, 0), 0);
    const missing = rows.reduce((sum, row) => sum + finiteNumber(row.missingPriceSoldOut, 0), 0);
    const offline = rows.reduce((sum, row) => sum + finiteNumber(row.offlineReserved, 0), 0);
    const countText = rows.length
      ? rows.map((row) => `${row.kindLabel} ${fmtNumber(row.pricedSoldOut)}${row.unit}`).join(" + ")
      : "대기";
    return { label, rows, priced, missing, offline, countText };
  });
  const covered = segments.filter((row) => row.rows.length).length;
  const missing = segments.reduce((sum, row) => sum + row.missing, 0);
  const offline = segments.reduce((sum, row) => sum + row.offline, 0);
  const tone = covered === labels.length && !missing ? "good" : covered ? "watch" : "bad";
  const detail = compactListText(
    segments.map((row) => {
      if (!row.rows.length) return `${row.label} 대기`;
      const flags = [
        row.missing ? `가격누락 ${fmtNumber(row.missing)}개/회` : "",
        row.offline ? `오프라인 ${fmtNumber(row.offline)}개/회` : ""
      ].filter(Boolean);
      return `${row.label} ${row.countText}${flags.length ? ` · ${flags.join(" · ")}` : ""}`;
    }),
    "요일별 가격/판매수량 대기",
    4
  );
  return {
    tone,
    value: `${fmtNumber(covered)}/4개 요일 확보`,
    detail,
    csv: `${fmtNumber(covered)}/4개 요일 확보${missing ? ` · 가격누락 ${fmtNumber(missing)}개/회` : ""}${offline ? ` · 오프라인 ${fmtNumber(offline)}개/회` : ""} | ${detail}`
  };
}

function queueRevenueProductKindSummary(label, rows = [], part = {}, unit = "개") {
  const productCount = rows.length;
  const quantityKnown = rows.filter((row) => row.quantityKnown).length;
  const priceKnown = rows.filter((row) => Number.isFinite(row.price)).length;
  const stockTotal = rows.reduce((sum, row) => sum + (Number.isFinite(row.stock) ? row.stock : 0), 0);
  const soldTotal = rows.reduce((sum, row) => sum + finiteNumber(row.sold, 0), 0);
  const priced = finiteNumber(part.pricedSoldOut, 0);
  const missing = finiteNumber(part.missingPriceSoldOut, 0);
  const hasSalesBasis = Boolean(productCount || priced || missing || finiteNumber(part.revenue, 0));
  if (!hasSalesBasis) {
    return {
      label,
      tone: "good",
      hasSalesBasis: false,
      value: `${label} 대기`,
      detail: "판매근거 없음"
    };
  }
  const value = productCount
    ? `${label} ${fmtNumber(productCount)}종 · 판매 ${fmtNumber(soldTotal)}${unit}`
    : `${label} 상품목록 대기 · 판매 ${fmtNumber(priced + missing)}${unit}`;
  const quantityText = productCount
    ? (stockTotal ? `총량 ${fmtNumber(stockTotal)}${unit}` : `총량확인 ${fmtNumber(quantityKnown)}/${fmtNumber(productCount)}종`)
    : "상품목록 미확보";
  const priceText = productCount
    ? `가격 ${fmtNumber(priceKnown)}/${fmtNumber(productCount)}종`
    : `가격확인 ${fmtNumber(priced)}${unit}`;
  const tone = missing ? "watch" : (productCount && quantityKnown === productCount && priceKnown === productCount ? "good" : "watch");
  return {
    label,
    tone,
    hasSalesBasis: true,
    value,
    detail: `${quantityText} · ${priceText}${missing ? ` · 가격누락 ${fmtNumber(missing)}${unit}` : ""} · 매출 ${fmtWon(part.adjustedRevenue || part.revenue)}`
  };
}

function queueRevenueProductCoverageSummary(impact = {}) {
  const productRows = impact.productRows || [];
  const lodging = queueRevenueProductKindSummary(
    "숙박",
    productRows.filter((row) => row.kind !== "day"),
    impact.lodging || {},
    "개"
  );
  const dayUse = queueRevenueProductKindSummary(
    "데이유즈/캠프닉",
    productRows.filter((row) => row.kind === "day"),
    impact.dayUse || {},
    "회"
  );
  const summaries = [lodging, dayUse];
  const activeSummaries = summaries.filter((row) => row.hasSalesBasis);
  const productCount = productRows.length;
  const priced = finiteNumber(impact.totalPricedSoldOut, 0);
  const missing = finiteNumber(impact.totalMissingPriceSoldOut, 0);
  const value = productCount
    ? `상품 ${fmtNumber(productCount)}종 · 가격확인 ${fmtNumber(priced)}개/회`
    : priced || missing
      ? `판매근거 ${fmtNumber(priced + missing)}개/회`
      : "상품 근거 대기";
  const tone = missing ? "watch" : (productCount && activeSummaries.length && activeSummaries.every((row) => row.tone === "good") ? "good" : "watch");
  const detailRows = activeSummaries.length ? activeSummaries : summaries;
  const detail = compactListText(detailRows.map((row) => `${row.label}: ${row.detail}`), "상품별 수량/가격 대기", 2);
  return {
    tone,
    value,
    detail,
    csv: `${value} | ${detail}`
  };
}

function queueRevenueEvidenceProfile(impact = {}) {
  const precision = impact.precision || {};
  const grade = String(precision.grade || "").toUpperCase();
  const precisionScore = Number(precision.score);
  const dayLabels = new Set([
    ...(impact.lodgingDayRows || []).map((row) => row.label),
    ...(impact.dayUseDayRows || []).map((row) => row.label)
  ].filter(Boolean));
  const dayCovered = dayLabels.size;
  const productRows = impact.productRows || [];
  const totalRevenue = effectiveRevenueValue(impact);
  const priced = finiteNumber(impact.totalPricedSoldOut, 0);
  const missing = finiteNumber(impact.totalMissingPriceSoldOut, 0);
  const totalSold = priced + missing;
  const hasRevenueBasis = Boolean(totalRevenue || totalSold);
  const priceMissing = missing > 0;
  const productKnown = Boolean(precision.productKnown || productRows.length);
  const dayCoverageWeak = hasRevenueBasis && dayCovered < 4;
  const productWeak = hasRevenueBasis && !productKnown;
  const precisionWeak = hasRevenueBasis && (["D", "E"].includes(grade) || (Number.isFinite(precisionScore) && precisionScore < 58));
  const reasons = [
    dayCoverageWeak ? `요일별 가격 ${fmtNumber(dayCovered)}/4개 요일 확보` : "",
    productWeak ? "상품종류별 수량 미확보" : "",
    priceMissing ? `가격누락 ${fmtNumber(missing)}개/회` : "",
    precisionWeak ? `매출 신뢰도 ${grade || "대기"}${Number.isFinite(precisionScore) ? ` · ${fmtNumber(precisionScore)}점` : ""}` : ""
  ].filter(Boolean);
  return {
    weak: Boolean(reasons.length),
    hasRevenueBasis,
    dayCovered,
    productKnown,
    priceMissing,
    productWeak,
    dayCoverageWeak,
    precisionWeak,
    reasons,
    label: reasons.length ? "매출 근거 보강" : "매출 근거 안정"
  };
}

function companyQueueRevenueImpactHtml(company = {}) {
  const impact = companyQueueRevenueImpact(company);
  if (!impact.hasDetail) return "";
  const priceTone = impact.totalMissingPriceSoldOut > 0 ? "watch" : "good";
  const precision = impact.precision || {};
  const sourceText = impact.source === "current" ? "현재 수집 결과" : "업체 최신 스냅샷";
  const dayCoverage = queueRevenueDayCoverageSummary(impact);
  const productCoverage = queueRevenueProductCoverageSummary(impact);
  const revenueValue = effectiveRevenueValue(impact);
  const revenueNote = revenueAdjustmentNote(impact);
  return `
    <div class="company-check-revenue-impact">
      <div>
        <span>숙박 예상매출</span>
        <strong>${fmtWon(impact.lodging.revenue)}</strong>
        <small>${escapeHtml(`${queueRevenueCoverageShort(impact.lodging)} · ${queueRevenueDetailShort(impact.lodging, "요일별 가격 대기")}`)}</small>
      </div>
      <div>
        <span>데이유즈/캠프닉</span>
        <strong>${fmtWon(impact.dayUse.revenue)}</strong>
        <small>${escapeHtml(`${queueRevenueCoverageShort(impact.dayUse)} · ${queueRevenueDetailShort(impact.dayUse, "회차 가격 대기")}`)}</small>
      </div>
      <div class="${priceTone}">
        <span>매출 영향</span>
        <strong>${fmtWon(revenueValue)}</strong>
        <small>${escapeHtml(`${sourceText} · ${revenueNote}`)}</small>
      </div>
      <div class="${escapeHtml(precision.tone || "watch")}">
        <span>매출 신뢰도</span>
        <strong>${escapeHtml(precision.grade ? `${precision.grade} · ${fmtNumber(precision.score)}점` : "대기")}</strong>
        <small>${escapeHtml((precision.reasons || []).slice(0, 2).join(" · ") || "가격/수량 정밀 확인 필요")}</small>
      </div>
      <div class="${escapeHtml(dayCoverage.tone)} wide">
        <span>요일별 가격 확보</span>
        <strong>${escapeHtml(dayCoverage.value)}</strong>
        <small>${escapeHtml(dayCoverage.detail)}</small>
      </div>
      <div class="${escapeHtml(productCoverage.tone)} wide">
        <span>상품종류별 수량</span>
        <strong>${escapeHtml(productCoverage.value)}</strong>
        <small>${escapeHtml(productCoverage.detail)}</small>
      </div>
    </div>
  `;
}

function companyCheckPriority(company = {}, profile = {}, type = {}, workflow = {}) {
  const issueWeights = {
    manual: 26,
    structure: 22,
    booking: 18,
    offline: 16,
    dayuse: 12,
    ota: 10
  };
  let score = Number(profile.priority || 0);
  for (const issue of profile.issues || []) score += issueWeights[issue.key] || 8;
  const latest = company.inventory?.latest || {};
  const sales = latest.salesSignal || {};
  const lodging = sales.lodging || {};
  const dayUse = sales.dayUse || {};
  if (lodging.fridayWeak) score += 8;
  if (lodging.sundayWeak) score += 8;
  if (lodging.weekdayWeak) score += 6;
  if (lodging.stockVariance || sales.stockVariance) score += 12;
  if (dayUse.days === 0 && sales.dayUseMissing) score += 6;
  if (company.salesTarget?.category === "contact") score += 14;
  if (company.salesTarget?.category === "verify") score += 10;
  if (company.salesTarget?.category === "benchmark") score += 2;
  if (company.salesTarget?.category === "exclude") score += 8;
  if (company.exposureLayer?.type === "local_only") score += 10;
  if (company.exposureLayer?.type === "local_match_pending") score += 8;
  if (company.exposureLayer?.type === "regional_local") score += 4;
  const bestRank = Number(company.bestRank || 0);
  if (bestRank > 0 && bestRank <= 5) score += 12;
  else if (bestRank > 0 && bestRank <= 10) score += 8;
  else if (bestRank > 0 && bestRank <= 20) score += 4;
  const revenueImpact = companyQueueRevenueImpact(company);
  const revenueValue = effectiveRevenueValue(revenueImpact);
  if (revenueValue >= 5000000) score += 16;
  else if (revenueValue >= 2000000) score += 10;
  else if (revenueValue >= 700000) score += 5;
  if (revenueImpact.totalMissingPriceSoldOut > 0) score += Math.min(12, revenueImpact.totalMissingPriceSoldOut * 2);
  if (queueRevenueEvidenceProfile(revenueImpact).weak) score += 10;
  if (company.identityConfidence?.level === "review") score += 15;
  if (profile.applied) score -= 14;
  if (workflow.key === "recheck") score += 28;
  if (workflow.key === "done") score -= 35;
  const bounded = Math.max(0, Math.round(score));
  if (bounded >= 95) return { key: "urgent", label: "긴급", score: bounded, note: "오늘 먼저 확인" };
  if (bounded >= 70) return { key: "high", label: "높음", score: bounded, note: "우선 확인" };
  if (bounded >= 45) return { key: "normal", label: "보통", score: bounded, note: "필터 확인" };
  return { key: "watch", label: "관찰", score: bounded, note: "누적 관찰" };
}

function companyCheckFilterOptions() {
  return [
    ["priority", "오늘 처리"],
    ["recheck", "재검토"],
    ["recommend_contact", "추천 컨택"],
    ["recommend_manual", "추천 보정"],
    ["recommend_recrawl", "추천 재수집"],
    ["recommend_check", "추천 확인"],
    ["high_revenue", "매출 영향"],
    ["revenue_weak", "매출 근거"],
    ["price_missing", "가격 누락"],
    ["improved", "개선"],
    ["worsened", "악화"],
    ["recrawl", "재수집"],
    ["all", "전체"],
    ["correction", "보정 필요"],
    ["ota", "OTA 확인"],
    ["gap", "판매 공백"],
    ["done", "완료/보류"]
  ];
}

function companyCheckFilterLabel(value = "priority") {
  return companyCheckFilterOptions().find(([key]) => key === value)?.[1] || "오늘 처리";
}

function companyCheckFilterMatches(entry = {}, filter = "priority") {
  const open = entry.workflow?.key !== "done";
  const recommendation = entry.autoRecommendation || {};
  const comparison = entry.comparison || {};
  const revenue = entry.revenueImpact || {};
  if (filter === "all") return true;
  if (filter === "priority") return entry.workflow.key === "open";
  if (filter === "recheck") return entry.workflow.key === "recheck";
  if (filter === "recommend_contact") return open && recommendation.status === "contact_ready";
  if (filter === "recommend_manual") return open && recommendation.status === "manual_needed";
  if (filter === "recommend_recrawl") return open && recommendation.status === "recrawl_needed";
  if (filter === "recommend_check") return open && recommendation.status === "check_needed";
  if (filter === "high_revenue") return open && effectiveRevenueValue(revenue) >= 2000000;
  if (filter === "revenue_weak") return open && queueRevenueEvidenceProfile(revenue).weak;
  if (filter === "price_missing") return open && finiteNumber(revenue.totalMissingPriceSoldOut) > 0;
  if (filter === "improved") return open && comparison.hasComparison && comparison.improved > comparison.worsened;
  if (filter === "worsened") return open && comparison.hasComparison && comparison.worsened > 0;
  if (filter === "recrawl") return open && (entry.type.key === "recrawl" || entry.company.adminReview?.status === "recrawl_needed");
  if (filter === "done") return entry.workflow.key === "done";
  if (filter === "ota") return open && (entry.type.key === "ota" || (entry.profile.issues || []).some((issue) => issue.key === "ota"));
  if (filter === "gap") return open && (entry.type.key === "gap" || (entry.profile.issues || []).some((issue) => issue.key === "gap"));
  return open && entry.type.key === filter;
}

function companyCheckSearchMatches(entry = {}, query = "") {
  if (!query) return true;
  const company = entry.company || {};
  const decision = entry.decision || {};
  const profile = entry.profile || {};
  const array = (value) => Array.isArray(value) ? value : [];
  const text = compactSearchText([
    company.companyId,
    company.primaryName,
    ...array(company.aliases),
    ...array(company.regions),
    ...array(company.addresses),
    company.bestKeyword,
    company.latestKeyword,
    ...array(company.keywords).map((row) => row.keyword).filter(Boolean),
    ...array(company.salesTarget?.priorityTags),
    ...array(company.salesTarget?.reasons),
    company.salesTarget?.recommendation,
    company.exposureLayer?.label,
    entry.type?.label,
    entry.workflow?.label,
    ...array(entry.workflow?.reasons),
    entry.priority?.label,
    decision.label,
    decision.summary,
    decision.problemDateText,
    decision.quantityConfidence,
    decision.gapType,
    decision.channelText,
    ...array(decision.reasons),
    ...array(decision.actions),
    ...array(decision.criteria).flatMap((criterion) => [criterion.label, criterion.reason, criterion.action]),
    ...array(profile.issues).flatMap((issue) => [issue.label, issue.task]),
    entry.autoRecommendation?.label,
    ...array(entry.autoRecommendation?.reasons),
    entry.revenueImpact?.precision?.label,
    queueRevenueEvidenceProfile(entry.revenueImpact || {}).label,
    ...queueRevenueEvidenceProfile(entry.revenueImpact || {}).reasons
  ].filter(Boolean).join(" "));
  return text.includes(query);
}

function companyCheckVisibleEntries(master = companyMasterSource()) {
  const entries = companyDecisionQueueEntries(master);
  const filters = state.companyMasterFilters || {};
  const selectedFilter = filters.check || "priority";
  const checkQuery = filters.checkQuery || "";
  const checkSearch = compactSearchText(checkQuery);
  const filteredEntries = entries.filter((entry) => companyCheckFilterMatches(entry, selectedFilter));
  const visibleEntries = filteredEntries.filter((entry) => companyCheckSearchMatches(entry, checkSearch));
  return {
    entries,
    selectedFilter,
    filterLabel: companyCheckFilterLabel(selectedFilter),
    checkQuery,
    checkSearch,
    filteredEntries,
    visibleEntries
  };
}

function companyDecisionQueueEntries(master = {}) {
  return (master.companies || [])
    .map((company) => {
      const decision = companyDecisionQueueProfile(company);
      const profile = companyNeedsCorrection(company);
      const type = companyCheckEntryType(company, profile);
      const workflow = companyCheckWorkflow(company, profile, type);
      const priority = companyCheckPriority(company, profile, type, workflow);
      const comparison = companyRecrawlComparison(company);
      const autoRecommendation = companyRecrawlAutoRecommendation(company, profile, decision, comparison);
      const revenueImpact = companyQueueRevenueImpact(company);
      const revenueEvidence = queueRevenueEvidenceProfile(revenueImpact);
      const include = decision.inQueue
        || revenueEvidence.weak
        || Boolean(company.adminReview?.status)
        || workflow.key === "recheck";
      return { company, profile, type, workflow, priority, decision, comparison, autoRecommendation, revenueImpact, revenueEvidence, include };
    })
    .filter((entry) => entry.include)
    .sort((a, b) => {
      const workflowWeight = { open: 3, recheck: 2, done: 1 };
      const typeWeight = { correction: 6, recrawl: 5, check: 4, ota: 4, gap: 3, exclude: 2, benchmark: 1, observe: 0 };
      return (workflowWeight[b.workflow.key] || 0) - (workflowWeight[a.workflow.key] || 0)
        || b.priority.score - a.priority.score
        || (typeWeight[b.type.key] || 0) - (typeWeight[a.type.key] || 0)
        || b.profile.priority - a.profile.priority
        || (b.company.salesTarget?.score || 0) - (a.company.salesTarget?.score || 0)
        || (a.company.bestRank || 9999) - (b.company.bestRank || 9999);
    });
}

function companyDecisionEvidenceHtml(decision = {}) {
  const cells = [
    ["문제 날짜", decision.problemDateText || "최근 수집일 기준"],
    ["수량 신뢰도", decision.quantityConfidence || "대기"],
    ["공백 유형", decision.gapType || "공백 특이 없음"],
    ["확인 채널", decision.channelText || "네이버 기준"],
    ["보정 상태", decision.correctionText || "자동추정"]
  ];
  return `
    <div class="company-decision-evidence">
      ${cells.map(([label, value]) => `
        <div>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function companyRegionBaseCandidates(company = {}) {
  const values = [
    ...(Array.isArray(company.regions) ? company.regions : []),
    ...(Array.isArray(company.addresses) ? company.addresses : [])
  ].map(compactCrawlKeyword).filter(Boolean);
  const found = [];
  for (const base of REGIONAL_GLAMPING_BASES) {
    const compact = compactCrawlKeyword(base);
    if (values.some((value) => value.includes(compact))) found.push(normalizedRegionBase(base));
  }
  return [...new Set(found)]
    .sort((a, b) => {
      const broadDelta = Number(BROAD_REGION_BASES.has(a)) - Number(BROAD_REGION_BASES.has(b));
      return broadDelta || b.length - a.length || a.localeCompare(b);
    });
}

function companyPrimaryRegionBase(company = {}) {
  return companyRegionBaseCandidates(company)[0] || "";
}

function regionalKeywordMatchesCompany(company = {}, keyword = "") {
  const base = regionalGlampingKeywordBase(keyword);
  if (!base) return true;
  const candidates = companyRegionBaseCandidates(company);
  if (!candidates.length) return false;
  const compactBase = compactCrawlKeyword(base);
  return candidates.some((candidate) => compactCrawlKeyword(candidate) === compactBase);
}

function sortedCompanyKeywordRows(company = {}) {
  return (Array.isArray(company.keywords) ? company.keywords : [])
    .filter((row) => row?.keyword)
    .sort((a, b) => (a.bestRank || 9999) - (b.bestRank || 9999) || String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
}

function companyRecrawlKeywordPlan(company = {}, run = {}) {
  const rows = sortedCompanyKeywordRows(company);
  const regionBase = companyPrimaryRegionBase(company);
  const rowPlan = (row, source) => ({
    keyword: row.keyword,
    rank: row.bestRank || row.latestRank || company.bestRank || 0,
    regionScope: regionalGlampingKeywordBase(row.keyword) || regionBase,
    keywordSource: source
  });
  const currentKeyword = run.keyword || activeKeyword();
  const currentKey = compactCrawlKeyword(currentKeyword).toLowerCase();
  const exactCurrent = currentKey
    ? rows.find((row) => compactCrawlKeyword(row.keyword).toLowerCase() === currentKey && regionalKeywordMatchesCompany(company, row.keyword))
    : null;
  if (exactCurrent) return rowPlan(exactCurrent, "현재 키워드 노출");
  const hasRegionScope = Boolean(regionBase);
  const local = rows.find((row) => row.layer?.type === "local" && regionalKeywordMatchesCompany(company, row.keyword))
    || (!hasRegionScope ? rows.find((row) => row.layer?.type === "local") : null);
  if (local) return rowPlan(local, "업체 로컬 키워드");
  const regionMatched = rows.find((row) => regionalKeywordMatchesCompany(company, row.keyword));
  if (regionMatched) return rowPlan(regionMatched, "업체 노출 키워드");
  const fallbackKeyword = [company.bestKeyword, company.latestKeyword]
    .find((keyword) => keyword && regionalKeywordMatchesCompany(company, keyword));
  if (fallbackKeyword) {
    return {
      keyword: fallbackKeyword,
      rank: company.bestRank || 0,
      regionScope: regionalGlampingKeywordBase(fallbackKeyword) || regionBase,
      keywordSource: "업체 대표 키워드"
    };
  }
  if (regionBase) {
    return {
      keyword: `${regionBase}글램핑`,
      rank: company.bestRank || 0,
      regionScope: regionBase,
      keywordSource: "업체 지역 기준"
    };
  }
  return {
    keyword: company.bestKeyword || company.latestKeyword || currentKeyword || activeKeyword(),
    rank: company.bestRank || 0,
    regionScope: "",
    keywordSource: "기본 키워드"
  };
}

function companyQueueRecrawlPlan(company = {}, profile = {}, decision = {}) {
  const run = state.data?.run || {};
  const criteria = new Set((decision.criteria || []).map((criterion) => criterion.key));
  const issues = new Set((profile.issues || []).map((issue) => issue.key));
  const keywordPlan = companyRecrawlKeywordPlan(company, run);
  const rank = Number(keywordPlan.rank || company.bestRank || 0);
  let range = "1-20";
  if (!rank || rank > 20 || criteria.has("ota") || criteria.has("quantity") || criteria.has("capacity") || issues.has("booking")) {
    range = "1-30";
  } else if (rank <= 5 && !(criteria.has("quantity") || criteria.has("capacity"))) {
    range = "1-10";
  }
  const dateText = decision.problemDateText && decision.problemDateText !== "최근 수집일 기준"
    ? decision.problemDateText
    : dateRangeLabel(run);
  const keyword = keywordPlan.keyword || company.bestKeyword || activeKeyword();
  return {
    keyword,
    regionScope: keywordPlan.regionScope || regionalGlampingKeywordBase(keyword) || "",
    keywordSource: keywordPlan.keywordSource || "업체 기준",
    range,
    dateText,
    checkIn: run.checkIn || els.checkInInput?.value || "",
    checkOut: run.checkOut || els.checkOutInput?.value || "",
    searchMode: correctedSearchMode(keyword, run.searchMode || "keyword"),
    productMode: run.productMode || "all",
    collectionMode: "precision"
  };
}

function recrawlRankRangePresets(selectedRange = "1-20") {
  return [...new Set([selectedRange || "1-20", "1-5", "1-10", "10-20", "1-20", "1-30"].filter(Boolean))];
}

function recrawlRangePresetHtml({ companyId = "", batchKey = "", selectedRange = "1-20", source = "" } = {}) {
  const presets = recrawlRankRangePresets(selectedRange);
  return `
    <div class="recrawl-range-presets">
      <span>범위 선택</span>
      ${presets.map((range) => {
        const attrs = companyId
          ? `data-queue-recrawl-company="${escapeHtml(companyId)}" data-queue-recrawl-range="${escapeHtml(range)}"`
          : `data-recrawl-batch-key="${escapeHtml(batchKey)}" data-recrawl-batch-range="${escapeHtml(range)}"${source ? ` data-recrawl-batch-source="${escapeHtml(source)}"` : ""}`;
        return `<button type="button" class="${range === selectedRange ? "active" : ""}" ${attrs}>${escapeHtml(range)}위</button>`;
      }).join("")}
    </div>
  `;
}

function applyRecrawlRangeOverride(plan = {}, range = "") {
  const value = String(range || "").trim();
  if (!value) return { ...plan };
  return {
    ...plan,
    range: value,
    detailRankRanges: value,
    collectionMode: "precision"
  };
}

function companyQueueActionPlan(company = {}, profile = {}, workflow = {}, decision = {}) {
  const plan = companyQueueRecrawlPlan(company, profile, decision);
  const eta = crawlEtaForPlan(plan);
  const recheckComparison = companyRecrawlComparison(company);
  const autoRecommendation = companyRecrawlAutoRecommendation(company, profile, decision, recheckComparison);
  const resolution = companyQueueResolutionProfile(company, profile, workflow, decision, recheckComparison);
  const criteria = new Set((decision.criteria || []).map((criterion) => criterion.key));
  const issues = new Set((profile.issues || []).map((issue) => issue.key));
  const statusSuggestion = company.adminReview?.status
    ? companyAdminReviewLabel(company.adminReview.status)
    : recheckComparison.hasComparison
      ? autoRecommendation.label
    : criteria.has("manual_recheck") || issues.has("manual") || issues.has("structure") || issues.has("offline")
      ? "보정 필요"
      : workflow.key === "recheck" || criteria.has("quantity") || criteria.has("capacity") || issues.has("booking")
        ? "재수집 필요"
        : criteria.has("gap") || criteria.has("ota") || issues.has("ota")
          ? "확인 필요"
          : company.salesTarget?.category === "contact"
            ? "컨택 가능"
            : "확인 필요";
  const rows = [
    ["추천 처리", statusSuggestion, "버튼으로 처리 상태 저장"],
    ["해소 경로", resolution.outcome.label, resolution.outcome.detail],
    ["다음 액션", resolution.nextAction, resolution.canMoveToTarget ? "영업타깃에서 후속 관리" : "판단큐에서 근거 보강"],
    ["자동 재검토", recheckComparison.hasComparison ? `${autoRecommendation.label} · 개선 ${fmtNumber(recheckComparison.improved)} / 악화 ${fmtNumber(recheckComparison.worsened)}` : "비교 대기", "재수집 전후 수량/가격/공백 비교"],
    ["재수집 설정", `정밀분석 · 상세 ${plan.range}위`, "순위 범위 문제 또는 수량 구조 확인용"],
    ["예상 소요", `${crawlEtaShortText(eta)} · ${crawlEtaSourceText(eta)}`, "수집 실행 전 ETA 기준"],
    ["문제 날짜", plan.dateText || "최근 수집일 기준", "동일 기간 재수집 또는 날짜별 직접 확인"],
    ["확인 채널", decision.channelText || "네이버 기준", "OTA/네이버 객실 탭/전화예약 메모"]
  ];
  return `
    <div class="company-check-action-plan">
      ${rows.map(([label, value, note]) => `
        <div>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
          <small>${escapeHtml(note)}</small>
        </div>
      `).join("")}
    </div>
    <div class="company-check-apply-row">
      <button type="button" data-queue-recrawl-company="${escapeHtml(company.companyId || "")}">수집 설정 적용</button>
      <small>${escapeHtml(`${plan.keyword} · ${plan.keywordSource || "업체 기준"}${plan.regionScope ? ` · 지역 ${plan.regionScope}` : ""} · ${plan.checkIn || "체크인"}~${plan.checkOut || "체크아웃"} · 상세 ${plan.range}위`)}</small>
      ${recrawlRangePresetHtml({ companyId: company.companyId || "", selectedRange: plan.range || "1-20" })}
    </div>
  `;
}

function companyQueueResolutionHtml(company = {}, profile = {}, workflow = {}, decision = {}, compact = false) {
  if (!company.companyId) return "";
  const resolution = companyQueueResolutionProfile(company, profile, workflow, decision);
  const blockerText = compactListText(resolution.blockers, resolution.canMoveToTarget ? "잔여 차단 조건 없음" : "잔여 조건 확인", 3);
  const comparisonText = resolution.comparison?.hasComparison
    ? `개선 ${fmtNumber(resolution.comparison.improved)} / 악화 ${fmtNumber(resolution.comparison.worsened)}`
    : "비교 대기";
  const rows = [
    ["자동 추천", resolution.recommendation.label || companyAdminReviewLabel(resolution.status), compactListText(resolution.recommendation.reasons || [], "추천 근거 대기", 2)],
    ["이동 위치", resolution.outcome.label, resolution.outcome.detail],
    ["잔여 조건", blockerText, resolution.needsMoreData ? "해소 전 컨택 보류" : "컨택 가능성 확인"],
    ["재수집 비교", comparisonText, resolution.comparison?.hasComparison ? "전후 변화 기준" : "다음 수집부터 비교"]
  ];
  const states = [
    ["contact_ready", "컨택", "영업타깃 이동"],
    ["recrawl_needed", "재수집", "큐 유지"],
    ["manual_needed", "보정", "재검토"],
    ["check_needed", "확인", "큐 유지"],
    ["hold", "보류", "관찰"],
    ["exclude", "제외", "제거"]
  ];
  return `
    <div class="company-resolution-panel ${escapeHtml(resolution.outcome.tone)} ${compact ? "compact" : ""}">
      <div class="company-resolution-head">
        <div>
          <strong>판단큐 해소 흐름</strong>
          <small>${escapeHtml(resolution.nextAction)}</small>
        </div>
        <span>${escapeHtml(resolution.outcome.label)}</span>
      </div>
      <div class="company-resolution-grid">
        ${rows.map(([label, value, note]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(note)}</small>
          </div>
        `).join("")}
      </div>
      <div class="company-resolution-states">
        ${states.map(([status, label, effect]) => `
          <span class="${resolution.status === status ? "active" : ""}">
            <b>${escapeHtml(label)}</b>
            <small>${escapeHtml(effect)}</small>
          </span>
        `).join("")}
      </div>
    </div>
  `;
}

function companyCheckEntryHtml(entry = {}) {
  const { company, profile, type, priority, workflow, decision, revenueImpact } = entry;
  const latest = company.inventory?.latest || {};
  const reasons = companyCheckReasons(company, profile, workflow, decision);
  const showCorrectionForm = (profile.issues || []).some((issue) => ["structure", "booking", "offline", "dayuse", "manual"].includes(issue.key));
  const revenueEvidence = queueRevenueEvidenceProfile(revenueImpact || {});
  return `
    <article class="company-check-card ${escapeHtml(type.key)} ${escapeHtml(workflow.key)}">
      <div class="company-check-card-head">
        <div>
          <b>${escapeHtml(company.primaryName || "업체명 확인")}</b>
          <small>${escapeHtml((company.regions || []).slice(0, 2).join(" · ") || "지역 확인")} · ${escapeHtml(company.exposureLayer?.label || "분류 대기")} · ${fmtNumber(company.salesTarget?.score || 0)}점</small>
        </div>
        <span>${escapeHtml(workflow.label)}</span>
      </div>
      <div class="company-check-priority">
        <strong class="${escapeHtml(priority.key)}">${escapeHtml(priority.label)}</strong>
        <span>${fmtNumber(priority.score)}점 · ${escapeHtml(priority.note)}</span>
      </div>
      <div class="company-check-tags">
        ${companyAdminReviewBadgeHtml(company)}
        ${companyMasterIdentityTag(company)}
        ${companyMasterCorrectionTag(company)}
        <mark>${escapeHtml(companyTargetCategoryLabel(company.salesTarget?.category))}</mark>
        <mark>${fmtNumber(company.keywordCount || 0)}키워드</mark>
        <mark>구조 ${escapeHtml(latest.structureLabel || "대기")}</mark>
        <mark>${escapeHtml(workflow.label)}</mark>
        ${revenueEvidence.weak ? `<mark>${escapeHtml(revenueEvidence.label)}</mark>` : ""}
        ${(profile.issues || []).slice(0, 4).map((issue) => `<mark>${escapeHtml(issue.label)}</mark>`).join("")}
      </div>
      ${companyDecisionEvidenceHtml(decision)}
      ${companyQueueRevenueImpactHtml(company)}
      ${companyRecrawlComparisonHtml(company, profile, decision)}
      ${companyMasterKeywordChips(company, 5)}
      <div class="company-check-reason">
        <strong>왜 확인해야 하나?</strong>
        <ul>
          ${reasons.slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
        </ul>
      </div>
      <div class="company-check-next">
        <span>추천 판단</span>
        <strong>${escapeHtml(companyCheckRecommendation(company, profile, workflow, decision))}</strong>
      </div>
      ${companyQueueActionPlan(company, profile, workflow, decision)}
      ${companyQueueResolutionHtml(company, profile, workflow, decision)}
      ${companyReviewActionsHtml(company, true)}
      ${showCorrectionForm ? companyCorrectionFormHtml(company, true) : ""}
    </article>
  `;
}

function companyQueueRecentLogs(entries = []) {
  const rows = [];
  for (const entry of entries) {
    const company = entry.company || {};
    const name = company.primaryName || "업체명 확인";
    for (const history of (company.adminReviewHistory || []).slice(-3)) {
      rows.push({
        at: history.at || "",
        tone: history.status === "contact_ready" ? "good" : history.status === "exclude" ? "bad" : "watch",
        name,
        label: "관리자 판단",
        value: history.action === "clear" ? "판단 해제" : (history.label || companyAdminReviewLabel(history.status) || "상태 변경"),
        note: history.note || companyReviewContextText(history.context) || history.reason || "관리자 처리 이력"
      });
    }
    if (entry.workflow?.key === "recheck") {
      rows.push({
        at: entry.comparison?.latest?.collectedAt || company.lastSeenAt || "",
        tone: entry.autoRecommendation?.tone || "watch",
        name,
        label: "재검토 필요",
        value: entry.autoRecommendation?.label || entry.workflow.label || "재검토",
        note: (entry.workflow.reasons || entry.autoRecommendation?.reasons || []).slice(0, 2).join(" · ") || "새 수집/보정 이후 판단 필요"
      });
    }
    if (entry.comparison?.hasComparison && (entry.comparison.improved || entry.comparison.worsened)) {
      rows.push({
        at: entry.comparison.latest?.collectedAt || company.lastSeenAt || "",
        tone: entry.comparison.worsened > entry.comparison.improved ? "bad" : "good",
        name,
        label: "재수집 비교",
        value: `개선 ${fmtNumber(entry.comparison.improved)} / 악화 ${fmtNumber(entry.comparison.worsened)}`,
        note: `${entry.autoRecommendation?.label || "추천 대기"} · 매출 ${fmtWon(effectiveRevenueValue(entry.revenueImpact || {}))}`
      });
    }
    if (manualCorrectionHasValue(company.manualCorrection)) {
      rows.push({
        at: company.manualCorrection.updatedAt || "",
        tone: "watch",
        name,
        label: "수동 보정",
        value: company.correctionStatus?.detail || "보정값 저장",
        note: company.manualCorrection.note || "보정 후 재검토 대상"
      });
    }
  }
  return rows
    .filter((row) => row.at || row.name)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
    .slice(0, 8);
}

function recrawlAutomationStatusLabel(status = "") {
  return companyAdminReviewLabel(status) || {
    contact_ready: "컨택 가능",
    manual_needed: "보정 필요",
    check_needed: "확인 필요",
    recrawl_needed: "재수집 필요"
  }[status] || "추천 대기";
}

function recrawlAutomationNote(entry = {}) {
  const recommendation = entry.autoRecommendation || {};
  const comparison = entry.comparison || {};
  const base = [
    `재수집 자동판정: ${recommendation.label || recrawlAutomationStatusLabel(recommendation.status)}`,
    ...(recommendation.reasons || []).slice(0, 2),
    comparison.hasComparison ? `개선 ${fmtNumber(comparison.improved)} / 악화 ${fmtNumber(comparison.worsened)}` : ""
  ].filter(Boolean);
  return compactListText(base, "재수집 자동판정", 3);
}

function recrawlAutomationRow(entry = {}) {
  const company = entry.company || {};
  const plan = companyQueueRecrawlPlan(company, entry.profile, entry.decision);
  const eta = crawlEtaForPlan(plan);
  const comparison = entry.comparison || {};
  const recommendation = entry.autoRecommendation || {};
  const latest = comparison.latest?.collectedAt || company.inventory?.latest?.collectedAt || company.lastSeenAt || "";
  const previous = comparison.previous?.collectedAt || company.inventory?.previousLatest?.collectedAt || "";
  const rank = Number(company.bestRank || 0);
  const revenue = effectiveRevenueValue(entry.revenueImpact || {});
  const revenueEvidence = queueRevenueEvidenceProfile(entry.revenueImpact || {});
  const reasons = [
    recommendation.label,
    ...(recommendation.reasons || []),
    revenueEvidence.weak ? compactListText(revenueEvidence.reasons, "매출 근거 보강", 2) : "",
    entry.decision?.summary,
    (entry.profile?.issues || [])[0]?.task
  ].filter(Boolean);
  const score = finiteNumber(entry.priority?.score, 0)
    + (recommendation.status === "recrawl_needed" ? 22 : 0)
    + (recommendation.status === "contact_ready" ? 18 : 0)
    + (revenueEvidence.weak ? 14 : 0)
    + (comparison.hasComparison ? 10 : 0)
    + Math.min(18, revenue / 200000)
    + (rank > 0 && rank <= 10 ? 8 : 0);
  return {
    entry,
    company,
    plan,
    eta,
    etaText: crawlEtaShortText(eta),
    etaSource: crawlEtaSourceText(eta),
    comparison,
    recommendation,
    name: company.primaryName || "업체명 확인",
    region: (company.regions || []).slice(0, 2).join(" / "),
    rank,
    revenue,
    score,
    latest,
    previous,
    range: plan.range || "1-20",
    dateText: plan.dateText || "최근 수집일 기준",
    status: recommendation.status || "check_needed",
    label: recommendation.label || recrawlAutomationStatusLabel(recommendation.status),
    tone: recommendation.tone || entry.type?.tone || "watch",
    reason: compactListText(reasons, "재수집 후 판단 필요", 3),
    revenueEvidence,
    regionScope: plan.regionScope || "",
    keywordSource: plan.keywordSource || "업체 기준",
    note: recrawlAutomationNote(entry)
  };
}

function recrawlAutomationProfile(entries = []) {
  const open = entries.filter((entry) => entry.workflow.key !== "done");
  const rows = open.map(recrawlAutomationRow);
  const needsExecution = rows
    .filter((row) => row.status === "recrawl_needed" || row.revenueEvidence?.weak || row.entry.type.key === "recrawl" || !row.comparison.hasComparison)
    .sort((a, b) => b.score - a.score || finiteNumber(a.rank, 9999) - finiteNumber(b.rank, 9999));
  const compared = rows
    .filter((row) => row.comparison.hasComparison)
    .sort((a, b) => String(b.latest || "").localeCompare(String(a.latest || "")) || b.score - a.score);
  const transitions = compared
    .filter((row) => row.status && row.company.adminReview?.status !== row.status)
    .sort((a, b) => {
      const weight = { contact_ready: 4, manual_needed: 3, check_needed: 2, recrawl_needed: 1 };
      return (weight[b.status] || 0) - (weight[a.status] || 0) || b.score - a.score;
    });
  const contactReady = transitions.filter((row) => row.status === "contact_ready");
  const manualNeeded = transitions.filter((row) => row.status === "manual_needed");
  const checkNeeded = transitions.filter((row) => row.status === "check_needed");
  const repeatNeeded = transitions.filter((row) => row.status === "recrawl_needed");
  return {
    rows,
    needsExecution,
    compared,
    transitions,
    contactReady,
    manualNeeded,
    checkNeeded,
    repeatNeeded
  };
}

function recrawlAutomationBatchKey(plan = {}) {
  return `${crawlEtaKey(plan)}|region:${compactCrawlKeyword(plan.regionScope || regionalGlampingKeywordBase(plan.keyword) || "")}`;
}

function recrawlAutomationBatches(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = recrawlAutomationBatchKey(row.plan);
    if (!map.has(key)) {
      map.set(key, {
        key,
        plan: row.plan,
        eta: row.eta,
        etaText: row.etaText,
        etaSource: row.etaSource,
        rows: [],
        score: 0,
        revenue: 0,
        minRank: 9999
      });
    }
    const batch = map.get(key);
    batch.rows.push(row);
    batch.score += finiteNumber(row.score, 0);
    batch.revenue += finiteNumber(row.revenue, 0);
    batch.minRank = Math.min(batch.minRank, finiteNumber(row.rank, 9999));
  }
  return [...map.values()]
    .map((batch) => {
      const etaSeconds = Number(batch.eta?.estimatedTotalSeconds);
      const savedSeconds = Number.isFinite(etaSeconds) ? Math.max(0, (batch.rows.length - 1) * etaSeconds) : 0;
      return {
        ...batch,
        count: batch.rows.length,
        savedSeconds,
        names: batch.rows.map((row) => row.name).filter(Boolean),
        regions: [...new Set(batch.rows.map((row) => row.region).filter(Boolean))],
        regionScopes: [...new Set(batch.rows.map((row) => row.regionScope).filter(Boolean))],
        reason: compactListText(batch.rows.flatMap((row) => [row.reason, row.label]).filter(Boolean), "동일 조건 재수집", 3)
      };
    })
    .sort((a, b) => b.count - a.count || b.savedSeconds - a.savedSeconds || b.score - a.score || a.minRank - b.minRank);
}

async function loadRecrawlEtaEstimates(master = state.companyMaster) {
  const entries = companyDecisionQueueEntries(master || {});
  const profile = recrawlAutomationProfile(entries);
  const rows = profile.needsExecution.slice(0, 16);
  const unique = new Map();
  for (const row of rows) {
    const payload = crawlEstimatePayloadFromPlan(row.plan);
    const key = crawlEtaKey(payload);
    if (!unique.has(key)) unique.set(key, { ...payload, clientKey: key });
  }
  if (!unique.size) {
    state.crawlEtaByKey = {};
    return;
  }
  try {
    const data = await fetchJson("/api/crawl-estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [...unique.values()] })
    });
    const next = {};
    for (const row of data.items || []) {
      if (row.clientKey && row.estimate) next[row.clientKey] = row.estimate;
    }
    state.crawlEtaByKey = next;
  } catch {
    state.crawlEtaByKey = {};
  }
}

function recrawlAutomationEtaCells(row = {}) {
  return `
    <div class="recrawl-auto-eta">
      <span><b>예상 소요</b>${escapeHtml(row.etaText || "계산 대기")}</span>
      <span><b>예상 기준</b>${escapeHtml(row.etaSource || "조건 모델")}</span>
    </div>
  `;
}

function recrawlAutomationBatchHtml(batches = []) {
  const rows = batches.slice(0, 4);
  return `
    <article class="recrawl-batch-panel">
      <div class="history-card-head">
        <strong>0. 묶음 실행</strong>
        <small>같은 키워드·지역·기간·범위만 한 번 수집해 여러 판단 큐 업체를 동시에 확인합니다.</small>
      </div>
      <div class="recrawl-batch-list">
        ${rows.length ? rows.map((batch, index) => `
          <div>
            <mark>${fmtNumber(index + 1)}</mark>
            <div>
              <b>${escapeHtml(batch.plan.keyword || activeKeyword())}</b>
              <small>${escapeHtml([
                `${fmtNumber(batch.count)}개 후보`,
                batch.regionScopes?.length ? `지역 ${batch.regionScopes.slice(0, 2).join(" / ")}` : "",
                batch.plan.checkIn && batch.plan.checkOut ? `${batch.plan.checkIn}~${batch.plan.checkOut}` : "기간 확인",
                `상세 ${batch.plan.range || batch.plan.detailRankRanges || "1-20"}위`,
                batch.regions.slice(0, 2).join(" / ")
              ].filter(Boolean).join(" · "))}</small>
              <div class="recrawl-auto-eta">
                <span><b>묶음 ETA</b>${escapeHtml(batch.etaText || "계산 대기")}</span>
                <span><b>절감 예상</b>${escapeHtml(batch.savedSeconds ? formatElapsed(batch.savedSeconds) : "중복 없음")}</span>
              </div>
              <p>${escapeHtml(`${batch.names.slice(0, 3).join(", ")}${batch.count > 3 ? ` 외 ${fmtNumber(batch.count - 3)}개` : ""} · ${batch.reason}`)}</p>
              ${recrawlRangePresetHtml({ batchKey: batch.key, selectedRange: batch.plan.range || batch.plan.detailRankRanges || "1-20" })}
            </div>
            <button type="button" data-recrawl-batch-key="${escapeHtml(batch.key)}">묶음 설정</button>
          </div>
        `).join("") : `<p class="empty">같은 조건으로 묶을 재수집 후보가 없습니다.</p>`}
      </div>
    </article>
  `;
}

function recrawlAutomationMiniCells(row = {}) {
  if (!row.comparison?.hasComparison) {
    return `
      <div class="recrawl-auto-cells">
        <span><b>비교</b>이전 수집 대기</span>
        <span><b>기간</b>${escapeHtml(row.dateText)}</span>
        <span><b>범위</b>${escapeHtml(row.range)}위</span>
        <span><b>키워드</b>${escapeHtml(row.keywordSource || "업체 기준")}</span>
        <span><b>예상</b>${escapeHtml(row.etaText || "계산 대기")}</span>
      </div>
    `;
  }
  const price = (row.comparison.cells || []).find((cell) => cell.key === "price");
  const stock = (row.comparison.cells || []).find((cell) => cell.key === "stock");
  const revenue = (row.comparison.cells || []).find((cell) => cell.key === "revenue");
  const cells = [
    ["개선/악화", `${fmtNumber(row.comparison.improved)} / ${fmtNumber(row.comparison.worsened)}`, row.comparison.tone],
    ["가격", price?.note || "가격 비교", price?.tone || "same"],
    ["총량", stock?.note || "총량 비교", stock?.tone || "same"],
    ["매출", revenue?.note || fmtWon(row.revenue), revenue?.tone || "same"]
  ];
  return `
    <div class="recrawl-auto-cells">
      ${cells.map(([label, value, tone]) => `<span class="${escapeHtml(tone)}"><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`).join("")}
    </div>
  `;
}

function recrawlAutomationCompanyAttrs(row = {}) {
  return `data-company-id="${escapeHtml(row.company.companyId || "")}"`;
}

function recrawlAutomationBoardHtml(entries = []) {
  const profile = recrawlAutomationProfile(entries);
  const batches = recrawlAutomationBatches(profile.needsExecution);
  const executionEtaSeconds = profile.needsExecution
    .map((row) => Number(row.eta?.estimatedTotalSeconds))
    .filter(Number.isFinite);
  const averageEtaSeconds = executionEtaSeconds.length
    ? Math.round(executionEtaSeconds.reduce((sum, value) => sum + value, 0) / executionEtaSeconds.length)
    : null;
  const totalSavedSeconds = batches.reduce((sum, batch) => sum + finiteNumber(batch.savedSeconds, 0), 0);
  const metricRows = [
    ["실행 묶음", batches.length, "중복 수집 축소"],
    ["실행 대기", profile.needsExecution.length, "수집 설정 적용 대상"],
    ["평균 ETA", averageEtaSeconds ? formatElapsed(averageEtaSeconds) : "대기", "실측 기록 반영"],
    ["절감 예상", totalSavedSeconds ? formatElapsed(totalSavedSeconds) : "대기", "개별 실행 대비"],
    ["비교 완료", profile.compared.length, "전후 스냅샷 확보"],
    ["컨택 전환", profile.contactReady.length, "영업타깃 이동 추천"],
    ["보정 필요", profile.manualNeeded.length, "수량/총량 확인"],
    ["재수집 반복", profile.repeatNeeded.length, "가격/수량 미확보"]
  ];
  const executionRows = profile.needsExecution.slice(0, 5);
  const transitionRows = profile.transitions.slice(0, 6);
  return `
    <section class="recrawl-auto-panel">
      <div class="recrawl-auto-head">
        <div>
          <strong>재수집 실행/비교 자동화 V2</strong>
          <small>재수집 대상 설정, 전후 비교, 추천 상태 적용을 한 흐름으로 관리합니다.</small>
        </div>
        <button type="button" data-export-recrawl-automation>재수집 CSV</button>
      </div>
      <div class="recrawl-auto-metrics">
        ${metricRows.map(([label, value, note]) => `
          <article>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(typeof value === "number" ? fmtNumber(value) : String(value))}</strong>
            <small>${escapeHtml(note)}</small>
          </article>
        `).join("")}
      </div>
      ${recrawlAutomationBatchHtml(batches)}
      <div class="recrawl-auto-layout">
        <article>
          <div class="history-card-head">
            <strong>1. 재수집 실행 순서</strong>
            <small>동일 기간 · 권장 상세 범위</small>
          </div>
          <div class="recrawl-auto-list">
            ${executionRows.length ? executionRows.map((row, index) => `
              <div class="${escapeHtml(row.tone)}">
                <mark>${fmtNumber(index + 1)}</mark>
                <div>
                  <b>${escapeHtml(row.name)}</b>
                  <small>${escapeHtml([row.region, row.rank ? `${fmtNumber(row.rank)}위` : "", row.dateText, `상세 ${row.range}위`].filter(Boolean).join(" · "))}</small>
                  ${recrawlAutomationEtaCells(row)}
                  <p>${escapeHtml(row.reason)}</p>
                </div>
                <button type="button" data-queue-recrawl-company="${escapeHtml(row.company.companyId || "")}">수집 설정</button>
              </div>
            `).join("") : `<p class="empty">재수집 실행 대기 대상이 없습니다.</p>`}
          </div>
        </article>
        <article>
          <div class="history-card-head">
            <strong>2. 전후 비교와 자동 추천</strong>
            <small>추천 적용 시 판단 큐/영업타깃 상태가 갱신됩니다.</small>
          </div>
          <div class="recrawl-auto-list transition">
            ${transitionRows.length ? transitionRows.map((row, index) => `
              <div class="${escapeHtml(row.tone)}">
                <mark>${fmtNumber(index + 1)}</mark>
                <div>
                  <b>${escapeHtml(row.name)}</b>
                  <small>${escapeHtml([row.previous ? compactDateTime(row.previous) : "이전 대기", row.latest ? compactDateTime(row.latest) : "최신 대기", row.revenue ? `매출 ${fmtWon(row.revenue)}` : ""].filter(Boolean).join(" → "))}</small>
                  ${recrawlAutomationMiniCells(row)}
                  <p>${escapeHtml(row.reason)}</p>
                </div>
                <button type="button" data-company-review-action="${escapeHtml(row.status)}" ${recrawlAutomationCompanyAttrs(row)} data-company-review-note="${escapeHtml(row.note)}">${escapeHtml(recrawlAutomationStatusLabel(row.status))}</button>
              </div>
            `).join("") : `<p class="empty">적용할 자동 추천이 없습니다. 재수집 후 비교가 쌓이면 표시됩니다.</p>`}
          </div>
        </article>
      </div>
    </section>
  `;
}

function companyQueueOperationSummaryHtml(entries = []) {
  const open = entries.filter((entry) => entry.workflow.key !== "done");
  const countRecommendation = (status) => open.filter((entry) => entry.autoRecommendation?.status === status).length;
  const highRevenue = open.filter((entry) => effectiveRevenueValue(entry.revenueImpact || {}) >= 2000000);
  const revenueWeak = open.filter((entry) => queueRevenueEvidenceProfile(entry.revenueImpact || {}).weak);
  const priceMissing = open.filter((entry) => finiteNumber(entry.revenueImpact?.totalMissingPriceSoldOut) > 0);
  const improved = open.filter((entry) => entry.comparison?.hasComparison && entry.comparison.improved > entry.comparison.worsened);
  const worsened = open.filter((entry) => entry.comparison?.hasComparison && entry.comparison.worsened > 0);
  const logs = companyQueueRecentLogs(entries);
  const cards = [
    ["오늘 처리", open.filter((entry) => entry.workflow.key === "open").length, "미완료 판단 큐"],
    ["재검토", open.filter((entry) => entry.workflow.key === "recheck").length, "재수집/보정 후 확인"],
    ["추천 컨택", countRecommendation("contact_ready"), "바로 영업타깃 이동 가능"],
    ["추천 보정", countRecommendation("manual_needed"), "총량/상품 구조 확인"],
    ["매출 영향", highRevenue.length, "예상매출 200만원 이상"],
    ["매출 근거", revenueWeak.length, "요일/상품/가격 보강"],
    ["가격 누락", priceMissing.length, "매출 산정 불완전"],
    ["개선/악화", `${fmtNumber(improved.length)} / ${fmtNumber(worsened.length)}`, "재수집 전후 비교"]
  ];
  return `
    <div class="company-queue-ops">
      <div class="company-queue-ops-grid">
        ${cards.map(([label, value, note]) => `
          <article>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(typeof value === "number" ? fmtNumber(value) : String(value))}</strong>
            <small>${escapeHtml(note)}</small>
          </article>
        `).join("")}
      </div>
      <div class="company-queue-log-panel">
        <div>
          <strong>최근 처리 로그</strong>
          <small>관리자 판단, 보정, 재수집 이후 상태 변화를 최신순으로 표시합니다.</small>
        </div>
        <button type="button" data-export-admin-review-audit>판단 이력 CSV</button>
        <div class="company-queue-log-list">
          ${logs.length ? logs.map((row) => `
            <article class="${escapeHtml(row.tone)}">
              <div>
                <b>${escapeHtml(row.name)}</b>
                <span>${escapeHtml(row.label)} · ${escapeHtml(row.value)}</span>
              </div>
              <small>${escapeHtml(compactDateTime(row.at))} · ${escapeHtml(row.note)}</small>
            </article>
          `).join("") : `<p class="empty">아직 표시할 처리 로그가 없습니다.</p>`}
        </div>
      </div>
    </div>
  `;
}

function companyCheckBulkReviewHtml(visibleEntries = [], filteredEntries = [], selectedFilter = "priority", checkQuery = "") {
  const count = visibleEntries.length;
  const filterLabel = companyCheckFilterLabel(selectedFilter);
  const queryText = String(checkQuery || "").trim();
  const actions = [
    ["check_needed", "확인 필요"],
    ["recrawl_needed", "재수집 필요"],
    ["manual_needed", "보정 필요"],
    ["contact_ready", "컨택 가능"],
    ["hold", "보류"]
  ];
  const scopeText = queryText
    ? `${filterLabel} 필터 · "${queryText}" 검색 결과`
    : `${filterLabel} 필터 전체 결과`;
  return `
    <div class="company-check-bulk" data-company-check-bulk>
      <div>
        <strong>현재 큐 일괄 처리</strong>
        <small>${escapeHtml(`${scopeText} ${fmtNumber(count)}개 대상 · 화면에 보이는 카드 수와 관계없이 필터/검색 결과 전체에 적용`)}</small>
      </div>
      <input type="text" data-company-check-bulk-note value="${escapeHtml(`일괄 처리: ${filterLabel}${queryText ? ` / ${queryText}` : ""}`)}" placeholder="일괄 처리 메모">
      <div>
        ${actions.map(([status, label]) => `
          <button type="button" data-company-check-bulk-action="${escapeHtml(status)}" ${count ? "" : "disabled"}>${escapeHtml(label)}</button>
        `).join("")}
      </div>
      <small>${escapeHtml(`현재 필터 ${fmtNumber(filteredEntries.length)}개 중 검색 적용 ${fmtNumber(count)}개`)}</small>
    </div>
  `;
}

function companyMasterCheckPanel(master = {}) {
  const { entries, selectedFilter, checkQuery, checkSearch, filteredEntries, visibleEntries } = companyCheckVisibleEntries(master);
  const countForFilter = (value) => entries.filter((entry) => companyCheckFilterMatches(entry, value)).length;
  const openEntries = entries.filter((entry) => entry.workflow.key !== "done");
  const criterionCount = (key) => openEntries.filter((entry) => (entry.decision.criteria || []).some((criterion) => criterion.key === key)).length;
  const reviewStatusCount = (status) => entries.filter((entry) => entry.company.adminReview?.status === status).length;
  const revenueWeakCount = openEntries.filter((entry) => queueRevenueEvidenceProfile(entry.revenueImpact || {}).weak).length;
  const metrics = [
    ["판단 큐", openEntries.length, "사람 확인 필요"],
    ["재수집 필요", reviewStatusCount("recrawl_needed"), "범위/기간 재확인"],
    ["수동 보정", reviewStatusCount("manual_needed") + criterionCount("manual_recheck"), "총량 보정 후 재판정"],
    ["매출 근거", revenueWeakCount, "요일/상품/가격 보강"],
    ["컨택 가능", reviewStatusCount("contact_ready"), "영업타깃 이동"]
  ];
  const displayLimit = selectedFilter === "priority" ? 15 : 24;
  const displayedEntries = visibleEntries.slice(0, displayLimit);
  const hiddenCount = Math.max(0, visibleEntries.length - displayedEntries.length);
  return `
    <section class="company-check-panel">
      <div class="company-check-head">
        <div>
          <strong>관리자 판단 큐 V2</strong>
          <small>OTA, 수량 구조, 날짜별 총량 변동, 판매 공백, 보정 후 재검토 기준으로 컨택 전 확인할 업체입니다.</small>
        </div>
        <span>${fmtNumber(displayedEntries.length)}/${fmtNumber(visibleEntries.length)}개 표시 · 필터 ${fmtNumber(filteredEntries.length)} · 전체 ${fmtNumber(entries.length)}</span>
      </div>
      <div class="company-check-metrics">
        ${metrics.map(([label, value, note]) => `
          <article>
            <span>${escapeHtml(label)}</span>
            <strong>${fmtNumber(value)}</strong>
            <small>${escapeHtml(note)}</small>
          </article>
        `).join("")}
      </div>
      ${recrawlAutomationBoardHtml(entries)}
      ${companyQueueOperationSummaryHtml(entries)}
      <div class="company-check-search">
        <label>
          <span>큐 검색</span>
          <input type="search" data-company-check-search value="${escapeHtml(checkQuery)}" placeholder="업체명, 지역, 키워드, 큐사유, 확인채널">
        </label>
        <small>${escapeHtml(checkSearch ? `현재 필터 ${fmtNumber(filteredEntries.length)}개 중 ${fmtNumber(visibleEntries.length)}개 표시` : "업체명·지역·키워드·큐사유·확인채널로 빠르게 좁힙니다.")}</small>
        <button type="button" data-export-decision-queue>현재 큐 CSV</button>
        ${checkSearch ? `<button type="button" data-company-check-search-clear>검색 해제</button>` : ""}
      </div>
      ${companyCheckBulkReviewHtml(visibleEntries, filteredEntries, selectedFilter, checkQuery)}
      <div class="company-check-filters">
        ${companyCheckFilterOptions().map(([value, label]) => `
          <button type="button" class="${selectedFilter === value ? "active" : ""}" data-company-check-filter="${escapeHtml(value)}">
            ${escapeHtml(label)}
            <span>${fmtNumber(value === "all" ? entries.length : countForFilter(value))}</span>
          </button>
        `).join("")}
      </div>
      <div class="company-check-list">
        ${displayedEntries.length
          ? displayedEntries.map(companyCheckEntryHtml).join("")
          : `<p class="empty">${escapeHtml(checkSearch ? "검색 조건에 맞는 판단 큐 업체가 없습니다." : "해당 조건의 확인할 업체가 없습니다.")}</p>`}
        ${hiddenCount ? `<p class="company-check-more">상위 ${fmtNumber(displayedEntries.length)}개를 먼저 표시합니다. 남은 ${fmtNumber(hiddenCount)}개는 아래 업체 마스터에서 검색해 확인하세요.</p>` : ""}
      </div>
    </section>
  `;
}

function companyCorrectionFormHtml(company = {}, compact = false) {
  const correction = manualCorrectionHasValue(company.manualCorrection) ? company.manualCorrection : {};
  return `
    <div class="company-manual-form correction-inline-form ${compact ? "compact" : ""}" data-company-manual-form data-company-id="${escapeHtml(company.companyId || "")}">
      <div>
        <label>
          <span>숙박 운영 기준</span>
          <input type="number" min="0" inputmode="numeric" data-manual-lodging value="${escapeHtml(correction.lodgingBasisTotal || "")}" placeholder="예: 26">
        </label>
        <label>
          <span>데이유즈 운영 기준</span>
          <input type="number" min="0" inputmode="numeric" data-manual-dayuse value="${escapeHtml(correction.dayUseBasisTotal || "")}" placeholder="예: 12">
        </label>
      </div>
      <label>
        <span>보정 메모</span>
        <input type="text" data-manual-note value="${escapeHtml(correction.note || "")}" placeholder="예: 전체 후보 28동, 현재 운영 26동">
      </label>
      <div class="company-manual-actions">
        <button type="button" data-save-company-correction data-company-id="${escapeHtml(company.companyId || "")}">저장</button>
        <button type="button" data-clear-company-correction data-company-id="${escapeHtml(company.companyId || "")}">해제</button>
      </div>
    </div>
  `;
}

function companyMasterSalesTargetsPanel(master = {}) {
  const targets = master.salesTargets || {};
  const companies = master.companies || [];
  const queueEntries = companyDecisionQueueEntries(master);
  const topTargets = companies
    .filter((company) => company.salesTarget?.category === "contact" && !companyDecisionQueueProfile(company).inQueue)
    .sort((a, b) => (b.salesTarget?.score || 0) - (a.salesTarget?.score || 0) || (a.bestRank || 9999) - (b.bestRank || 9999));
  const confirmedTargets = companies.filter((company) => ["confirmed", "contact_ready"].includes(company.adminReview?.status) && !companyDecisionQueueProfile(company).inQueue);
  const queueCount = queueEntries.filter((entry) => entry.workflow.key !== "done").length;
  return `
    <div class="company-sales-panel">
      <div class="company-sales-metrics">
        <article><span>바로 컨택</span><strong>${fmtNumber(topTargets.length)}</strong><small>판단 큐 제외</small></article>
        <article><span>확정 타깃</span><strong>${fmtNumber(confirmedTargets.length)}</strong><small>관리자 판단 맞음</small></article>
        <article><span>벤치마크</span><strong>${fmtNumber(targets.benchmarkCount || 0)}</strong><small>광역+로컬 강자</small></article>
        <article><span>판단 큐</span><strong>${fmtNumber(queueCount)}</strong><small>컨택 전 확인</small></article>
      </div>
      <div class="company-sales-list">
        <strong>바로 컨택 후보</strong>
        ${topTargets.length ? topTargets.slice(0, 6).map((company) => `
          <article>
            <div>
              <b>${escapeHtml(company.primaryName || "업체명 확인")}</b>
              <span>${fmtNumber(company.salesTarget?.score || 0)}점</span>
            </div>
            <small>${escapeHtml(company.exposureLayer?.label || "분류 대기")} · ${escapeHtml(companyMasterKeywordText(company))}</small>
            ${companySalesTargetTagHtml(company, 5)}
            <p>${escapeHtml((company.salesTarget?.reasons || []).slice(0, 3).join(" · ") || company.salesTarget?.recommendation || "추가 확인 필요")}</p>
          </article>
        `).join("") : `<p>현재 기준 바로 컨택 후보가 없습니다. 판단 큐 항목은 아래에서 먼저 확인하세요.</p>`}
      </div>
    </div>
  `;
}

function companyMasterReviewQueuePanel(master = {}) {
  const companies = master.companies || [];
  const reviewedCount = companies.filter((company) => company.adminReview?.status).length;
  const rows = companies
    .filter((company) => !company.adminReview?.status && ["contact", "verify"].includes(company.salesTarget?.category))
    .sort((a, b) => (b.salesTarget?.score || 0) - (a.salesTarget?.score || 0) || (a.bestRank || 9999) - (b.bestRank || 9999))
    .slice(0, 8);
  return `
    <div class="company-review-panel">
      <div class="company-review-head">
        <div>
          <strong>관리자 검증 큐</strong>
          <small>알고리즘 후보를 맞음/보류/제외/보정 필요로 확정</small>
        </div>
        <span>${fmtNumber(reviewedCount)}개 검증됨</span>
      </div>
      <div class="company-review-queue">
        ${rows.length ? rows.map((company) => `
          <article>
            <div>
              <b>${escapeHtml(company.primaryName || "업체명 확인")}</b>
              <span>${fmtNumber(company.salesTarget?.score || 0)}점</span>
            </div>
            ${companySalesTargetTagHtml(company, 5)}
            <p>${escapeHtml((company.salesTarget?.reasons || []).slice(0, 2).join(" · ") || company.salesTarget?.recommendation || "검증 필요")}</p>
            ${companyReviewActionsHtml(company)}
          </article>
        `).join("") : `<p class="empty">현재 미검증 컨택/검증 후보가 없습니다.</p>`}
      </div>
    </div>
  `;
}

function companyMasterCorrectionPanel(master = {}) {
  const rows = (master.companies || [])
    .map((company) => ({ company, profile: companyNeedsCorrection(company) }))
    .filter((entry) => entry.profile.needed)
    .sort((a, b) => b.profile.priority - a.profile.priority || (b.company.salesTarget?.score || 0) - (a.company.salesTarget?.score || 0))
    .slice(0, 12);
  const appliedCount = rows.filter((entry) => entry.profile.applied).length;
  const urgentCount = rows.filter((entry) => !entry.profile.applied).length;
  return `
    <div class="company-correction-panel">
      <div class="company-correction-head">
        <div>
          <strong>보정 필요 업체</strong>
          <small>수량 구조·예약ID·총량변동·당일상품·OTA 확인이 필요한 업체</small>
        </div>
        <span>${fmtNumber(urgentCount)}개 미보정 · ${fmtNumber(appliedCount)}개 적용</span>
      </div>
      <div class="company-correction-list">
        ${rows.length ? rows.map(({ company, profile }) => {
          const latest = company.inventory?.latest || {};
          const hasManualCorrection = manualCorrectionHasValue(company.manualCorrection);
          const correctionStatus = company.correctionStatus || {
            label: hasManualCorrection ? "관리자 보정" : "자동추정",
            detail: latest.confidenceGrade ? `내부 신뢰도 ${latest.confidenceGrade}` : "추정 대기"
          };
          const correctionNote = hasManualCorrection ? company.manualCorrection?.note : "";
          return `
            <article class="${profile.applied ? "applied" : ""}">
              <div class="company-correction-title">
                <div>
                  <b>${escapeHtml(company.primaryName || "업체명 확인")}</b>
                  <small>${escapeHtml((company.regions || []).slice(0, 2).join(" · ") || "지역 확인")} · ${escapeHtml(company.exposureLayer?.label || "분류 대기")} · ${fmtNumber(company.salesTarget?.score || 0)}점</small>
                </div>
                <span>${escapeHtml(correctionStatus.label)}</span>
              </div>
              <div class="company-correction-tags">
                ${profile.issues.slice(0, 6).map((issue) => `<mark>${escapeHtml(issue.label)}</mark>`).join("")}
              </div>
              <ul>
                ${profile.issues.slice(0, 4).map((issue) => `<li>${escapeHtml(issue.task)}</li>`).join("")}
              </ul>
              <div class="company-correction-meta">
                <span>구조 ${escapeHtml(latest.structureLabel || "대기")}</span>
                <span>${escapeHtml(correctionStatus.detail || "자동추정")}</span>
                <span>${escapeHtml(correctionNote || "보정 메모 없음")}</span>
              </div>
              ${companyCorrectionFormHtml(company, true)}
            </article>
          `;
        }).join("") : `<p class="empty">현재 보정 필요 업체가 없습니다.</p>`}
      </div>
    </div>
  `;
}

function companyMasterFilterPanel(master = {}) {
  const filters = state.companyMasterFilters || {};
  const total = (master.companies || []).length;
  return `
    <div class="company-master-filter">
      <label>
        <span>업체 검색</span>
        <input type="search" data-company-master-search value="${escapeHtml(filters.query || "")}" placeholder="업체명, 지역, 키워드">
      </label>
      <label>
        <span>노출 레이어</span>
        <select data-company-master-layer>
          ${[
            ["all", "전체"],
            ["regional_local", "광역+로컬"],
            ["local_only", "로컬 전용"],
            ["local_match_pending", "로컬 매칭 대기"],
            ["company_only", "업체명 확인"]
          ].map(([value, label]) => `<option value="${value}" ${filters.layer === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <label>
        <span>후보 유형</span>
        <select data-company-master-target>
          ${[
            ["all", "전체"],
            ["contact", "컨택 후보"],
            ["verify", "검증 후보"],
            ["benchmark", "벤치마크"],
            ["observe", "관찰 후보"],
            ["exclude", "제외 후보"]
          ].map(([value, label]) => `<option value="${value}" ${filters.target === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
      <small>${fmtNumber(total)}개 업체 기준</small>
    </div>
  `;
}

function companyMasterFilteredCompanies(master = {}) {
  const filters = state.companyMasterFilters || {};
  const query = compactSearchText(filters.query || "");
  return (master.companies || []).filter((company) => {
    if (filters.layer && filters.layer !== "all" && company.exposureLayer?.type !== filters.layer) return false;
    if (filters.target && filters.target !== "all" && company.salesTarget?.category !== filters.target) return false;
    if (!query) return true;
    const text = compactSearchText([
      company.primaryName,
      ...(company.aliases || []),
      ...(company.regions || []),
      ...(company.addresses || []),
      ...(company.keywords || []).map((row) => row.keyword).filter(Boolean)
    ].join(" "));
    return text.includes(query);
  });
}

function companyMasterListPanel(master = {}) {
  const rows = companyMasterFilteredCompanies(master)
    .sort((a, b) => (b.salesTarget?.score || 0) - (a.salesTarget?.score || 0) || (a.bestRank || 9999) - (b.bestRank || 9999));
  return `
    <div class="company-master-list-panel">
      <div class="company-master-list-head">
        <strong>업체 마스터 리스트</strong>
        <span>${fmtNumber(rows.length)}개 표시</span>
      </div>
      <div class="company-master-list">
        ${rows.length ? rows.slice(0, 80).map((company) => `
          <article>
            <div class="company-master-row-main">
              <b>${escapeHtml(company.primaryName || "업체명 확인")}</b>
              <small>${escapeHtml((company.regions || []).slice(0, 2).join(" · ") || "지역 확인")} · ${escapeHtml(company.companyId || "고유키 대기")}</small>
            </div>
            <div class="company-master-row-tags">
              <span>${escapeHtml(company.exposureLayer?.label || "분류 대기")}</span>
              <span>${escapeHtml(companyTargetCategoryLabel(company.salesTarget?.category))}</span>
              ${companyMasterSourceTag(company)}
              ${companyMasterIdentityTag(company)}
              ${companyMasterCorrectionTag(company)}
              ${companyAdminReviewBadgeHtml(company)}
              <span>${fmtNumber(company.salesTarget?.score || 0)}점</span>
              <span>${fmtNumber(company.keywordCount || 0)}키워드</span>
              <span>${company.bestRank ? `${fmtNumber(company.bestRank)}위` : "순위대기"}</span>
            </div>
            ${companySalesTargetTagHtml(company, 6)}
            ${companyMasterKeywordChips(company, 6)}
            <small>${escapeHtml((company.salesTarget?.reasons || []).slice(0, 2).join(" · ") || company.salesTarget?.recommendation || "추가 수집 후 판단")}</small>
            ${companyReviewActionsHtml(company, true)}
          </article>
        `).join("") : `<p class="empty">필터 조건에 맞는 업체가 없습니다.</p>`}
      </div>
    </div>
  `;
}

function adminDateToken(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function adminRunDateToken(run = {}) {
  const idMatch = String(run.id || "").match(/(\d{4})(\d{2})(\d{2})/);
  if (idMatch) return `${idMatch[1]}${idMatch[2]}${idMatch[3]}`;
  const rawDate = run.createdAt || run.collectedAt || run.updatedAt || run.date || "";
  const date = rawDate ? new Date(rawDate) : null;
  return date && !Number.isNaN(date.getTime()) ? adminDateToken(date) : "";
}

function adminConsoleMasterSource() {
  return { ...(state.data?.companyMaster || {}), ...(state.companyMaster || {}) };
}

function adminConsoleKpis(master = {}, entries = []) {
  const companies = master.companies || [];
  const todayToken = adminDateToken();
  const todayRuns = (state.runs || []).filter((run) => adminRunDateToken(run) === todayToken).length;
  const openEntries = entries.filter((entry) => entry.workflow.key !== "done");
  const manualNeeded = openEntries.filter((entry) =>
    entry.type.key === "correction" ||
    entry.profile.needed ||
    entry.company.adminReview?.status === "manual_needed" ||
    (entry.decision.criteria || []).some((criterion) => criterion.key === "manual_recheck")
  ).length;
  const inQueueCompanyIds = new Set(openEntries.map((entry) => entry.company.companyId).filter(Boolean));
  const contactReady = companies.filter((company) =>
    company.adminReview?.status === "contact_ready" ||
    (company.salesTarget?.category === "contact" && !inQueueCompanyIds.has(company.companyId))
  ).length;
  const trend = state.data?.stats?.datalabTrend || state.data?.datalabTrend || state.data?.trend || {};
  const cacheHit = Boolean(trend.cache?.hit);
  return [
    ["오늘 수집", todayRuns, `${fmtNumber(state.runs?.length || 0)}개 실행 결과`, "neutral"],
    ["판단 큐", openEntries.length, "컨택 전 확인", openEntries.length ? "warning" : "good"],
    ["보정 필요", manualNeeded, "수량/총량 검토", manualNeeded ? "bad" : "good"],
    ["컨택 가능", contactReady, "큐 제외 후보", contactReady ? "good" : "neutral"],
    ["캐시 재사용률", trend.collectable || trend.cache ? (cacheHit ? "100%" : "0%") : "대기", cacheHit ? "동일 기준일 캐시" : "이번 실행/대기", cacheHit ? "good" : "neutral"]
  ];
}

function adminConsoleQueuePreview(entries = []) {
  const rows = entries.filter((entry) => entry.workflow.key !== "done").slice(0, 6);
  return `
    <section class="admin-console-panel admin-queue-preview">
      <div class="admin-console-head">
        <div>
          <strong>판단 큐 V2</strong>
          <small>OTA, 수량 구조, 총량 변동, 판매 공백, 보정 재검토를 먼저 처리합니다.</small>
        </div>
        <button type="button" data-drawer-tab="decisionQueue">전체 큐</button>
      </div>
      <div class="admin-queue-table">
        <div class="admin-queue-row head">
          <span>업체</span><span>지역</span><span>진입 사유</span><span>우선</span><span>액션</span>
        </div>
        ${rows.length ? rows.map((entry) => {
          const company = entry.company || {};
          const criteria = (entry.decision.criteria || []).slice(0, 4);
          const region = (company.regions || [])[0] || "지역 확인";
          return `
            <div class="admin-queue-row ${escapeHtml(entry.workflow.key)}">
              <div>
                <strong>${escapeHtml(company.primaryName || "업체명 확인")}</strong>
                <small>${escapeHtml(company.bestKeyword || company.latestKeyword || "키워드 대기")}</small>
              </div>
              <span>${escapeHtml(region)}</span>
              <div class="admin-reason-badges">
                ${(criteria.length ? criteria : [{ label: entry.type.label || "확인 필요" }]).map((criterion) => `<mark>${escapeHtml(criterion.label || "확인 필요")}</mark>`).join("")}
              </div>
              <b>${fmtNumber(entry.priority.score || 0)}</b>
              <div class="admin-row-actions">
                <button type="button" data-company-review-action="check_needed" data-company-id="${escapeHtml(company.companyId || "")}" data-company-review-source="admin_console" data-company-review-note="관리자 콘솔에서 확인 필요로 지정">확인</button>
                <button type="button" data-company-review-action="manual_needed" data-company-id="${escapeHtml(company.companyId || "")}" data-company-review-source="admin_console" data-company-review-note="관리자 콘솔에서 보정 필요로 지정">보정</button>
                <button type="button" data-company-review-action="hold" data-company-id="${escapeHtml(company.companyId || "")}" data-company-review-source="admin_console" data-company-review-note="관리자 콘솔에서 보류로 지정">보류</button>
              </div>
            </div>
          `;
        }).join("") : `<p class="empty">현재 열린 판단 큐가 없습니다.</p>`}
      </div>
    </section>
  `;
}

function adminConsoleCrawlPanel(entries = []) {
  const payload = currentCrawlFormPayload();
  const preview = crawlPreviewMeta(payload);
  const run = state.data?.run || {};
  const counts = run.counts || {};
  const openEntries = entries.filter((entry) => entry.workflow.key !== "done");
  const recrawlRows = recrawlAutomationProfile(entries).needsExecution;
  const trend = state.data?.stats?.datalabTrend || state.data?.datalabTrend || {};
  const cells = [
    ["예상 소요", formatElapsed(preview.estimatedTotalSeconds), crawlEstimateBasisText(preview.estimateBasis)],
    ["완료 예정", formatClockTime(preview.estimatedCompleteAt), `${collectionModeLabel(payload.collectionMode)} · ${payload.detailRankRanges || "상세 생략"}`],
    ["API/캐시", trend.cache?.hit ? "캐시 사용" : trend.collectable ? "연동 정상" : "대기", trend.cache?.endDate || trend.reason || "동일 기준일 캐시 우선"],
    ["재수집 후보", fmtNumber(recrawlRows.length), openEntries.length ? "큐 기준 자동 산출" : "대기"],
    ["최근 상세", fmtNumber(counts.naverBookingStockSucceeded || 0), `${fmtNumber(counts.naverBookingStockChecked || 0)}개 시도`],
    ["범위 제외", fmtNumber(counts.naverBookingStockSkippedByRank || 0), "설정 순위 밖"]
  ];
  return `
    <section class="admin-console-panel admin-crawl-panel">
      <div class="admin-console-head">
        <div>
          <strong>수집 상태</strong>
          <small>현재 설정 기준 예상 시간과 최신 실행 품질을 함께 봅니다.</small>
        </div>
        <button type="button" data-drawer-tab="admin">수집 실행</button>
      </div>
      <div class="admin-crawl-meter">
        <span style="width:${Math.max(8, Math.min(100, Math.round(preview.confidence * 100 || 48)))}%"></span>
      </div>
      <div class="admin-crawl-grid">
        ${cells.map(([label, value, note]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(String(value || "대기"))}</strong>
            <small>${escapeHtml(note || "")}</small>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function adminConsoleMasterPreview(master = {}) {
  const rows = (master.companies || [])
    .slice()
    .sort((a, b) => (b.salesTarget?.score || 0) - (a.salesTarget?.score || 0) || (a.bestRank || 9999) - (b.bestRank || 9999))
    .slice(0, 7);
  return `
    <section class="admin-console-panel admin-master-preview">
      <div class="admin-console-head">
        <div>
          <strong>업체 마스터</strong>
          <small>누적 DB 기준 상위 업체와 전략 신호를 빠르게 확인합니다.</small>
        </div>
        <button type="button" data-company-master-focus>마스터 보기</button>
      </div>
      <div class="admin-master-table">
        <div class="admin-master-row head">
          <span>업체</span><span>최고</span><span>쿠폰</span><span>예상 평균 매출</span><span>보정</span>
        </div>
        ${rows.length ? rows.map((company) => {
          const latest = company.inventory?.latest || {};
          const couponSignal = latest.couponSignal || latest.salesSignal?.couponSignal || {};
          const targetSignals = company.salesTarget?.signals || {};
          const couponVisible = Boolean(
            couponSignal.visible ||
            couponSignal.status === "있음" ||
            couponSignal.names ||
            latest.salesSignal?.naverCouponVisible ||
            targetSignals.couponVisible
          );
          const revenue = companyQueueRevenueImpact(company);
          const revenueValue = effectiveRevenueValue(revenue);
          const corrected = manualCorrectionHasValue(company.manualCorrection);
          return `
            <div class="admin-master-row">
              <div>
                <strong>${escapeHtml(company.primaryName || "업체명 확인")}</strong>
                <small>${escapeHtml((company.regions || []).slice(0, 2).join(" · ") || company.bestKeyword || "지역 대기")}</small>
              </div>
              <b>${company.bestRank ? `${fmtNumber(company.bestRank)}위` : "대기"}</b>
              <span>${escapeHtml(couponVisible ? "노출" : "미확인")}</span>
              <span>${revenueValue ? fmtWon(revenueValue) : "대기"}</span>
              <mark class="${corrected ? "good" : latest.confidenceGrade && !["A", "B"].includes(String(latest.confidenceGrade).toUpperCase()) ? "watch" : ""}">${escapeHtml(corrected ? "보정" : (latest.confidenceGrade || "대기"))}</mark>
            </div>
          `;
        }).join("") : `<p class="empty">업체 마스터가 아직 비어 있습니다.</p>`}
      </div>
    </section>
  `;
}

function adminConsoleTaskQueue(master = {}, entries = []) {
  const openEntries = entries.filter((entry) => entry.workflow.key !== "done");
  const recrawlRows = recrawlAutomationProfile(entries).needsExecution;
  const manualRows = openEntries.filter((entry) => entry.type.key === "correction" || entry.profile.needed);
  const contactRows = (master.companies || []).filter((company) => company.salesTarget?.category === "contact" && !companyDecisionQueueProfile(company).inQueue);
  const duplicateCount = master.duplicateCandidateCount || (master.duplicateCandidates || []).length;
  const tasks = [
    ["재수집 실행", recrawlRows.length, "예상 시간 기준 묶음 실행", "recrawl"],
    ["수동 보정 입력", manualRows.length, "총량/상품 구조 보정", "correction"],
    ["컨택 가능 전환", contactRows.length, "큐 제외 영업 후보", "contact"],
    ["중복 병합 검토", duplicateCount, "업체 마스터 정리", "duplicate"]
  ];
  return `
    <section class="admin-console-panel admin-task-panel">
      <div class="admin-console-head">
        <div>
          <strong>관리자 작업</strong>
          <small>오늘 처리할 큐를 작업 단위로 모읍니다.</small>
        </div>
        <button type="button" data-drawer-tab="decisionQueue">처리 화면</button>
      </div>
      <div class="admin-task-list">
        ${tasks.map(([label, count, note, key]) => {
          const attrs = key === "contact"
            ? 'data-drawer-tab="target"'
            : key === "duplicate"
              ? "data-company-master-focus"
              : `data-company-check-filter="${escapeHtml(key)}"`;
          return `
          <article class="${count ? "active" : ""}">
            <div>
              <strong>${escapeHtml(label)}</strong>
              <small>${escapeHtml(note)}</small>
            </div>
            <span>${fmtNumber(count)}</span>
            <button type="button" ${attrs}>${escapeHtml(count ? "열기" : "대기")}</button>
          </article>
        `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderAdminConsoleDashboard(master = adminConsoleMasterSource()) {
  if (!els.adminConsoleDashboard || !isAdminRole()) return;
  if (master.error) {
    els.adminConsoleDashboard.innerHTML = `<div class="admin-console-empty">관리자 콘솔 로딩 실패: ${escapeHtml(master.error)}</div>`;
    return;
  }
  const entries = companyDecisionQueueEntries(master);
  const kpis = adminConsoleKpis(master, entries);
  const latestRun = state.runs?.[0] || {};
  els.adminConsoleDashboard.innerHTML = `
    <section class="admin-console-hero">
      <div>
        <span>Admin Operations</span>
        <h3>운영 콘솔</h3>
        <p>수집 상태, 판단 큐, 업체 마스터, 관리자 작업을 한 화면에서 처리합니다.</p>
      </div>
      <small>최근 실행 ${escapeHtml(latestRun.label || latestRun.id || "대기")}</small>
    </section>
    <section class="admin-kpi-grid">
      ${kpis.map(([label, value, note, tone]) => `
        <article class="${escapeHtml(tone)}">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(typeof value === "number" ? fmtNumber(value) : String(value))}</strong>
          <small>${escapeHtml(note)}</small>
        </article>
      `).join("")}
    </section>
    <section class="admin-console-layout">
      ${adminConsoleQueuePreview(entries)}
      ${adminConsoleCrawlPanel(entries)}
      ${adminConsoleMasterPreview(master)}
      ${adminConsoleTaskQueue(master, entries)}
    </section>
  `;
}

function renderDecisionQueue() {
  if (!els.decisionQueueList) return;
  const master = companyMasterSource();
  if (master.error) {
    if (els.decisionQueueCount) els.decisionQueueCount.textContent = "오류";
    els.decisionQueueList.innerHTML = `<div class="empty">판단 큐 로딩 실패: ${escapeHtml(master.error)}</div>`;
    return;
  }
  const companies = master.companies || [];
  const entries = companyDecisionQueueEntries(master);
  const openCount = entries.filter((entry) => entry.workflow.key !== "done").length;
  if (els.decisionQueueCount) {
    els.decisionQueueCount.textContent = `${fmtNumber(openCount)} 대기`;
  }
  if (!companies.length) {
    els.decisionQueueList.innerHTML = `<div class="empty">업체 마스터를 불러오는 중입니다. 관리 탭에서 수집 결과를 선택하거나 기존 결과 전체 반영을 실행하세요.</div>`;
    return;
  }
  els.decisionQueueList.innerHTML = `
    <div class="decision-queue-intro">
      <strong>영업타깃과 판단 큐 분리 기준</strong>
      <p>영업타깃은 바로 컨택 가능한 업체만 표시하고, 판단 큐는 OTA·수량 구조·날짜별 총량·판매 공백·수동 보정 신호가 있어 사람이 확인해야 하는 업체만 모읍니다.</p>
    </div>
    ${companyMasterCheckPanel(master)}
  `;
}

function rerenderCompanyMasterPreservingSearch() {
  const active = document.activeElement;
  const preserveSelector = active?.matches?.("[data-company-master-search]")
    ? "[data-company-master-search]"
    : active?.matches?.("[data-company-check-search]")
      ? "[data-company-check-search]"
      : "";
  const preserveSearch = Boolean(preserveSelector);
  const selectionStart = preserveSearch ? active.selectionStart : null;
  const selectionEnd = preserveSearch ? active.selectionEnd : null;
  const previousValue = preserveSearch ? active.value : "";
  renderCompanyMasterPanel();
  renderDecisionQueue();
  if (preserveSearch) {
    const input = Array.from(document.querySelectorAll(preserveSelector)).find((node) => node.value === previousValue) || document.querySelector(preserveSelector);
    input?.focus();
    if (input && selectionStart !== null && selectionEnd !== null) {
      input.setSelectionRange(selectionStart, selectionEnd);
    }
  }
}

function renderCompanyMasterPanel() {
  if (!els.companyMasterPanel) return;
  const master = { ...(state.data?.companyMaster || {}), ...(state.companyMaster || {}) };
  renderAdminConsoleDashboard(master);
  if (els.companyMasterState) {
    els.companyMasterState.textContent = master.error ? "오류" : master.totalCompanies ? `${fmtNumber(master.totalCompanies)} 업체` : "대기";
  }
  if (master.error) {
    els.companyMasterPanel.innerHTML = `<div class="empty">업체 마스터 로딩 실패: ${escapeHtml(master.error)}</div>`;
    return;
  }
  if (!master.totalCompanies) {
    els.companyMasterPanel.innerHTML = `
      <div class="empty">
        업체 마스터 DB가 아직 비어 있습니다. 수집 결과를 열면 업체별 고유키와 키워드 이력이 자동 저장됩니다.
      </div>
      ${companyMasterTools()}
    `;
    return;
  }
  const duplicates = master.duplicateCandidates || [];
  els.companyMasterPanel.innerHTML = `
    ${companyMasterTools()}
    ${companyMasterBackfillResult(master)}
    <div class="company-master-metrics">
      <article><span>전체 업체</span><strong>${fmtNumber(master.totalCompanies)}</strong><small>마스터 DB</small></article>
      <article><span>이번 결과</span><strong>${fmtNumber(master.currentRunCompanies || 0)}</strong><small>자동 upsert</small></article>
      <article><span>중복 후보</span><strong>${fmtNumber(master.duplicateCandidateCount || 0)}</strong><small>수동 검토</small></article>
    </div>
    ${companyMasterVerificationPanel(master)}
    ${companyMasterCrossKeywordPanel(master)}
    ${companyMasterSalesTargetsPanel(master)}
    ${companyMasterCheckPanel(master)}
    ${companyMasterFilterPanel(master)}
    ${companyMasterListPanel(master)}
    <div class="company-master-rule">
      <strong>병합 기준</strong>
      <p>${escapeHtml(master.principle || "place_id/예약ID 우선, 업체명+주소/지역 보조")}</p>
    </div>
    <div class="company-master-duplicates">
      ${duplicates.length ? duplicates.slice(0, 5).map((candidate) => `
        <article>
          <strong>${escapeHtml(candidate.reason || "중복 후보")}</strong>
          <small>${escapeHtml(candidate.candidateKey || "")}</small>
          <div>
            ${(candidate.companies || []).map((company) => `
              <span>${escapeHtml(company.primaryName || "업체명 확인")} · ${fmtNumber(company.runCount || 0)}회</span>
            `).join("")}
          </div>
          <div class="company-master-actions">
            <button type="button" data-company-duplicate-action="merge" data-candidate-key="${escapeHtml(candidate.candidateKey || "")}" data-company-ids="${escapeHtml((candidate.companies || []).map((company) => company.companyId).filter(Boolean).join(","))}">대표로 병합</button>
            <button type="button" data-company-duplicate-action="separate" data-candidate-key="${escapeHtml(candidate.candidateKey || "")}">분리 유지</button>
          </div>
        </article>
      `).join("") : `<p>현재 수동 병합/분리 후보가 없습니다.</p>`}
    </div>
  `;
}

function renderHistoryOps() {
  if (!els.historyOpsDashboard) return;
  const ops = historyOpsSource();
  const overall = ops.overall || {};
  const activeKeywordRow = activeHistoryKeywordSummary();
  if (!ops.keywords?.length) {
    if (els.historyOpsState) els.historyOpsState.textContent = "누적 대기";
    els.historyOpsDashboard.innerHTML = `
      <section class="history-ops-empty">
        <strong>누적 DB가 아직 비어 있습니다.</strong>
        <p>같은 키워드를 반복 수집하면 키워드별 이력, 회차 비교, 업체별 추이가 자동으로 쌓입니다.</p>
      </section>
      ${collectionQualityMonitorHtml()}
    `;
    return;
  }
  if (els.historyOpsState) els.historyOpsState.textContent = `${fmtNumber(overall.keywordCount)} 키워드`;
  els.historyOpsDashboard.innerHTML = `
    <section class="history-ops-hero">
      <div>
        <p class="eyebrow">누적 DB 운영</p>
        <h3>${escapeHtml(activeKeywordRow?.keyword || activeKeyword())}</h3>
        <p>반복 수집된 관측값으로 키워드별 추이와 업체별 안정성을 확인합니다.</p>
      </div>
      <span>${escapeHtml(activeKeywordRow?.latestCollectedDate || overall.latestCollectedAt?.slice(0, 10) || "대기")}</span>
    </section>

    <section class="history-ops-metrics">
      ${historyOpsCard("누적 키워드", fmtNumber(overall.keywordCount), `${fmtNumber(overall.runCount)}회 수집`)}
      ${historyOpsCard("누적 관측", fmtNumber(overall.observationCount), `${fmtNumber(overall.companyCount)}업체`)}
      ${historyOpsCard("활성 키워드", fmtNumber(activeKeywordRow?.observations || 0), `${fmtNumber(activeKeywordRow?.companyCount || 0)}업체`)}
      ${historyOpsCard("활성 판매율", historyRateText(activeKeywordRow?.saleRate), `${fmtNumber(activeKeywordRow?.sold || 0)}/${fmtNumber(activeKeywordRow?.supply || 0)}개`)}
    </section>

    ${collectionQualityMonitorHtml()}

    <section class="history-ops-layout">
      <article class="history-ops-card wide">
        <div class="history-card-head">
          <strong>키워드별 누적 수집 이력</strong>
          <small>최근 수집순</small>
        </div>
        ${historyOpsKeywordRows(activeKeywordRow)}
      </article>
      <article class="history-ops-card">
        <div class="history-card-head">
          <strong>수집 회차 비교</strong>
          <small>활성 키워드</small>
        </div>
        ${historyOpsComparison(activeKeywordRow)}
      </article>
      <article class="history-ops-card">
        <div class="history-card-head">
          <strong>회차별 판매율 추이</strong>
          <small>${escapeHtml(activeKeywordRow?.keyword || "")}</small>
        </div>
        ${historyOpsTimeline(activeKeywordRow?.timeline || [])}
      </article>
      <article class="history-ops-card">
        <div class="history-card-head">
          <strong>데이터 신뢰도 로그</strong>
          <small>현재 실행 기준</small>
        </div>
        ${historyOpsAuditLog()}
      </article>
      <article class="history-ops-card wide">
        <div class="history-card-head">
          <strong>업체별 누적 추이</strong>
          <small>변동폭 높은 순</small>
        </div>
        ${historyOpsCompanyTrends(activeKeywordRow)}
      </article>
    </section>
  `;
}

function renderDemand() {
  if (!els.demandDashboard) return;
  const data = state.data || {};
  const run = data.run || {};
  const traffic = demandTrafficAggregate();
  const total = finiteNumber(traffic.totalSearchVolume, 0);
  const mobileShare = demandMobileShare(traffic);
  const ctr = Number(traffic.combinedCtr);
  const trend = demandTrendSource();
  const regions = demandRegionRows();
  const demandStateText = trend.hasSeries
    ? "연동 정상"
    : trend.reason
      ? (Number(trend.status) === 401 ? "인증 실패" : "API 오류")
    : state.trafficKeyState?.datalabConfigured
      ? "트렌드 대기"
      : "데이터랩 미설정";
  if (els.demandState) els.demandState.textContent = demandStateText;

  els.demandDashboard.innerHTML = `
    <section class="demand-hero-card">
      <div>
        <p class="eyebrow">수요구조 분석</p>
        <h3>${escapeHtml(activeKeyword())}</h3>
        <p>${escapeHtml(dateRangeLabel(run))} · 숙박업 메인터넌스 사전 · 네이버 검색수요</p>
      </div>
      <span>${escapeHtml(productModeLabel(run.productMode || "all"))}</span>
    </section>

    ${renderB2BDemandPlaybook(traffic)}

    ${renderDemandStructure()}

    ${renderHistoryLab()}

    <section class="demand-metric-grid" aria-label="검색수요 핵심 지표">
      <article><span>월검색량</span><strong>${total ? fmtNumber(total) : "확인필요"}</strong><small>PC+모바일</small></article>
      <article><span>모바일 비중</span><strong>${Number.isFinite(mobileShare) ? fmtRate(mobileShare) : "확인필요"}</strong><small>검색광고 API</small></article>
      <article><span>평균 CTR</span><strong>${Number.isFinite(ctr) ? fmtSearchRate(ctr) : "확인필요"}</strong><small>예상 클릭 반응</small></article>
      <article><span>트렌드 상태</span><strong>${escapeHtml(demandTrendLabel())}</strong><small>데이터랩 상대지수</small></article>
    </section>

    <section class="demand-layout">
      ${demandTrendChart()}
      <article class="demand-insight-card">
        <div class="demand-card-head">
          <div>
            <h3>수요 해석</h3>
            <p>검색광고 지표와 데이터랩 추세를 분리해 판단</p>
          </div>
        </div>
        <div class="demand-pill-row">
          ${demandInterpretation(traffic).map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
        </div>
        ${renderDemandTrendInsightCards(traffic)}
        <div class="demand-rule-box">
          <strong>다음 판단</strong>
          <p>${escapeHtml(demandTrendActionText(traffic))}</p>
        </div>
      </article>
    </section>

    <section class="demand-table-card">
      <div class="demand-card-head">
        <div>
          <h3>지역 비교</h3>
          <p>지역 키워드별 월검색량과 영업 우선순위</p>
        </div>
        <span>${fmtNumber(regions.length)} 지역</span>
      </div>
      <div class="demand-region-table">
        <div class="demand-region-head">
          <span>지역</span><span>월검색량</span><span>트렌드</span><span>클러스터</span><span>판단</span>
        </div>
        ${regions.length ? regions.map(({ region, traffic: rowTraffic, primary }) => `
          <div class="demand-region-row">
            <strong>${escapeHtml(region.region || region.name || "지역")}</strong>
            <span>${rowTraffic.totalSearchVolume ? fmtNumber(rowTraffic.totalSearchVolume) : "확인필요"}</span>
            <span>${escapeHtml(rowTraffic.trendLabel || "연동대기")}</span>
            <span>${escapeHtml(primary)}</span>
            <em>${escapeHtml(demandPriorityLabel(rowTraffic))}</em>
          </div>
        `).join("") : `<div class="empty">지역별 검색수요 데이터가 없습니다.</div>`}
      </div>
    </section>

    ${demandCompanySample()}
  `;
}

function renderTargets() {
  const boardEntries = companySalesBoardEntries();
  const currentItems = targetEntries(12);
  const confirmed = boardEntries.filter((entry) => entry.stage.key === "confirmed");
  const contact = boardEntries.filter((entry) => entry.stage.key === "contact");
  const pipelineSummary = companySalesPipelineSummary(boardEntries);
  const performanceSummary = companySalesPerformanceSummary(boardEntries);
  const proposalResponseRows = companySalesProposalResponseSummary(boardEntries);
  const followUpEntries = boardEntries.filter((entry) => ["overdue", "today", "soon", "needs_date"].includes(entry.followUp.key)).slice(0, 8);
  const masterQueueCount = companyDecisionQueueEntries(companyMasterSource()).filter((entry) => entry.workflow.key !== "done").length;
  const currentQueueCount = validationQueueEntries(state.data?.availability?.items || [], 0).length;
  const decisionQueueCount = masterQueueCount || currentQueueCount;
  const actionableCount = confirmed.length + contact.length;
  const currentOnly = currentItems.filter(({ item }) => !boardEntries.some((entry) => entry.item === item)).slice(0, 6);
  const allGatedEntries = salesGateReviewEntries(0);
  const selectedSalesGateFilter = state.companyMasterFilters?.salesGate || "all";
  const filteredGatedEntries = salesGateFilteredEntries(allGatedEntries, selectedSalesGateFilter);
  const gatedEntries = filteredGatedEntries.slice(0, 8);

  els.targetCount.textContent = `${fmtNumber(actionableCount || currentItems.length)} 타깃`;
  if (!boardEntries.length && !currentItems.length && !allGatedEntries.length) {
    els.targetList.innerHTML = `<div class="empty">현재 기준 바로 컨택 가능한 영업 후보가 없습니다. 판단 큐 ${fmtNumber(decisionQueueCount)}개는 관리 탭에서 먼저 확인하세요.</div>`;
    return;
  }

  const boardCard = (entry, index) => {
    const { company, stage, action, item, revenueImpact, priorityScore, followUp } = entry;
    const itemIndex = item ? (state.data?.availability?.items || []).indexOf(item) : -1;
    const regionText = (company.regions || []).slice(0, 2).join(" · ") || item?.region || "지역 확인";
    const evidence = companySalesEvidenceList(company, entry);
    const contactMeta = salesContactMeta(company.salesContact?.status);
    const responseMeta = salesResponseMeta(company.salesContact?.responseStatus);
    const reasonMeta = salesResponseReasonMeta(company.salesContact?.responseReason);
    const url = companySalesPrimaryUrl(company, item);
    const revenueValue = effectiveRevenueValue(revenueImpact);
    const revenueNote = revenueAdjustmentNote(revenueImpact);
    return `
      <article class="target-action-card ${stage.key}">
        <div class="target-action-head">
          <span>${index + 1}</span>
          <div>
            <strong>${escapeHtml(company.primaryName || item?.name || "업체명 확인")}</strong>
            <small>${escapeHtml(regionText)} · ${escapeHtml(stage.label)} · 우선순위 ${fmtNumber(priorityScore)}</small>
          </div>
          <div class="target-badge-stack">
            <mark class="sales-contact-badge ${escapeHtml(contactMeta.tone)}">${escapeHtml(contactMeta.label)}</mark>
            <mark class="sales-followup-badge ${escapeHtml(followUp.tone)}">${escapeHtml(followUp.label)}</mark>
            <mark class="sales-response-badge ${escapeHtml(responseMeta.tone)}">${escapeHtml(responseMeta.label)}</mark>
          </div>
        </div>
        <div class="target-execution-metrics">
          <div><span>예상매출</span><strong>${fmtWon(revenueValue)}</strong><small>${escapeHtml(revenueImpact.precision?.grade ? `신뢰 ${revenueImpact.precision.grade} · ${revenueNote}` : revenueNote)}</small></div>
          <div><span>노출</span><strong>${company.bestRank ? `${fmtNumber(company.bestRank)}위` : "대기"}</strong><small>${escapeHtml(company.bestKeyword || company.latestKeyword || "키워드 확인")}</small></div>
          <div><span>후속</span><strong>${escapeHtml(followUp.label)}</strong><small>${escapeHtml(followUp.detail || "다음 액션 미지정")}</small></div>
          <div><span>반응</span><strong>${escapeHtml(responseMeta.label)}</strong><small>${escapeHtml(reasonMeta.label)}</small></div>
        </div>
        <div class="target-action-main">
          <b>${escapeHtml(action.label)}</b>
          <p>${escapeHtml(action.pitch)}</p>
        </div>
        <div class="target-reasons">
          ${evidence.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
        </div>
        <div class="target-next-line">
          <strong>다음 액션</strong>
          <span>${escapeHtml(company.salesContact?.proposal || action.next)}</span>
        </div>
        ${salesProposalHtml(entry)}
        ${salesContactFormHtml(company)}
        ${salesContactHistoryHtml(company)}
        <div class="target-card-actions">
          ${itemIndex >= 0 ? `<button class="secondary-button" type="button" data-open-company="${itemIndex}">상세 보기</button>` : `<button class="secondary-button" type="button" data-drawer-tab="admin">관리에서 확인</button>`}
          ${url ? `<a class="secondary-button target-link-button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">예약/플레이스</a>` : ""}
        </div>
      </article>
    `;
  };
  const lane = (title, subtitle, rows, emptyText) => `
    <section class="target-lane">
      <div class="target-lane-head">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <small>${escapeHtml(subtitle)}</small>
        </div>
        <span>${fmtNumber(rows.length)}</span>
      </div>
      <div class="target-lane-list">
        ${rows.length ? rows.slice(0, 6).map(boardCard).join("") : `<p class="empty">${escapeHtml(emptyText)}</p>`}
      </div>
    </section>
  `;
  const gatePanel = (rows, filteredRows = rows, allRows = filteredRows, selectedFilter = "all") => allRows.length ? `
    <section class="target-gate-panel">
      <div class="target-lane-head">
        <div>
          <strong>컨택 보류 사유</strong>
          <small>판단 큐에 남아 있어 영업타깃에서 제외된 업체와 확인 근거입니다.</small>
        </div>
        <span>${fmtNumber(filteredRows.length)} / ${fmtNumber(allRows.length)}</span>
      </div>
      ${salesGateFilterHtml(allRows, selectedFilter)}
      ${salesGateBatchHtml(filteredRows)}
      ${salesGateBulkReviewHtml(filteredRows, selectedFilter)}
      <div class="target-gate-list">
        ${rows.length ? rows.map((entry, index) => {
          const { company, workflow, type, decision, autoRecommendation, revenueImpact, gateReason, gateStatus } = entry;
          return `
          <article class="${escapeHtml(workflow?.tone || type?.key || "watch")}">
            <div class="target-gate-head">
              <mark>${fmtNumber(index + 1)}</mark>
              <div>
                <b>${escapeHtml(company.primaryName || "업체명 확인")}</b>
                <small>${escapeHtml([(company.regions || []).slice(0, 2).join(" / "), company.bestRank ? `${fmtNumber(company.bestRank)}위` : "", company.bestKeyword || company.latestKeyword || ""].filter(Boolean).join(" · ") || "지역/순위 확인")}</small>
              </div>
              <span>${escapeHtml(gateStatus)}</span>
            </div>
            <div class="target-gate-grid">
              <div><span>큐 사유</span><strong>${escapeHtml(decision.label || type?.label || "확인 필요")}</strong><small>${escapeHtml(decision.problemDateText || "문제 날짜 확인")}</small></div>
              <div><span>수량/공백</span><strong>${escapeHtml(decision.quantityConfidence || "수량 확인")}</strong><small>${escapeHtml(decision.gapType || "공백 유형 없음")}</small></div>
              <div><span>확인 채널</span><strong>${escapeHtml(decision.channelText || "네이버 기준")}</strong><small>${escapeHtml(autoRecommendation?.label || workflow?.label || "관리자 판단")}</small></div>
              <div><span>예상매출</span><strong>${fmtWon(effectiveRevenueValue(revenueImpact || {}))}</strong><small>${escapeHtml(revenueAdjustmentNote(revenueImpact || {}))}</small></div>
            </div>
            ${salesGateRevenueEvidenceHtml(entry)}
            <p>${escapeHtml(gateReason)}</p>
            ${salesGateReviewActionsHtml(entry)}
            <div class="target-card-actions">
              <button class="secondary-button" type="button" data-drawer-tab="decisionQueue">판단 큐에서 처리</button>
              <button class="secondary-button" type="button" data-drawer-tab="admin">관리에서 확인</button>
            </div>
          </article>
        `;
        }).join("") : `<p class="empty target-gate-empty">${escapeHtml(`${salesGateFilterLabel(selectedFilter)} 조건의 보류 업체가 없습니다.`)}</p>`}
      </div>
    </section>
  ` : "";

  els.targetList.innerHTML = `
    <section class="target-board-hero">
      <article><span>영업 대상</span><strong>${fmtNumber(actionableCount)}</strong><small>큐 제외 즉시 후보</small></article>
      <article><span>오늘 처리</span><strong>${fmtNumber(pipelineSummary.todayCount)}</strong><small>오늘 후속 예정</small></article>
      <article><span>지연</span><strong>${fmtNumber(pipelineSummary.overdueCount)}</strong><small>날짜 지난 액션</small></article>
      <article><span>응답률</span><strong>${fmtRate(performanceSummary.responseRate)}</strong><small>응답 ${fmtNumber(performanceSummary.respondedCount)}</small></article>
      <article><span>계약 검토</span><strong>${fmtNumber(performanceSummary.contractReviewCount)}</strong><small>${fmtWon(performanceSummary.contractRevenue)}</small></article>
    </section>
    <section class="target-export-bar">
      <div>
        <strong>영업 반응/성과 추적 V2</strong>
        <small>컨택 결과와 반응 사유를 기록하고, 응답률·관심률·미팅 전환률과 제안 유형별 반응을 우선순위에 반영합니다. 판단 큐 ${fmtNumber(decisionQueueCount)}개는 분리되어 있습니다.</small>
      </div>
      <div class="target-export-actions">
        <button type="button" data-export-sales-targets>컨택+반응 CSV</button>
        <button type="button" data-export-sales-gate>${escapeHtml(selectedSalesGateFilter === "all" ? "보류사유 CSV" : `${salesGateFilterLabel(selectedSalesGateFilter)} CSV`)}</button>
      </div>
    </section>
    ${gatePanel(gatedEntries, filteredGatedEntries, allGatedEntries, selectedSalesGateFilter)}
    ${salesPipelineHtml(pipelineSummary)}
    ${salesPerformanceHtml(performanceSummary, proposalResponseRows)}
    <section class="target-followup-board">
      <div class="target-lane-head">
        <div>
          <strong>오늘/지연 후속 대상</strong>
          <small>지연 ${fmtNumber(pipelineSummary.overdueCount)} · 오늘 ${fmtNumber(pipelineSummary.todayCount)} · 임박 ${fmtNumber(pipelineSummary.soonCount)} · 날짜 필요 ${fmtNumber(pipelineSummary.needsDateCount)}</small>
        </div>
        <span>${fmtNumber(followUpEntries.length)}</span>
      </div>
      <div class="target-followup-list">
        ${followUpEntries.length ? followUpEntries.map(boardCard).join("") : `<p class="empty">우선 후속 대상이 없습니다.</p>`}
      </div>
    </section>
    <section class="target-board">
      ${lane("확정 타깃", "관리자가 판단 맞음으로 확정한 업체", confirmed, "아직 확정 타깃이 없습니다. 관리 탭에서 후보를 검증하세요.")}
      ${lane("컨택 후보", "판단 큐에 걸리지 않은 바로 컨택 가능한 업체", contact, "현재 바로 컨택 가능한 후보가 없습니다.")}
    </section>
    ${currentOnly.length ? `
      <section class="target-current-run">
        <div class="target-lane-head">
          <div>
            <strong>현재 수집 결과 후보</strong>
            <small>아직 업체 마스터 검증 전인 단기 후보</small>
          </div>
          <span>${fmtNumber(currentOnly.length)}</span>
        </div>
        <div class="target-current-grid">
          ${currentOnly.map(({ item, reasons, score, label }, index) => `
            <article class="target-card">
              <div class="target-head">
                <strong>${index + 1}. ${escapeHtml(item.name)}</strong>
                <span>${escapeHtml(label)} · ${fmtNumber(score)}</span>
              </div>
              <p class="hint">${escapeHtml(categoryText(item))} · ${escapeHtml(salesLine(item, "lodging"))}</p>
              ${flowChipRow(item)}
              <div class="target-reasons">
                ${reasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
              </div>
              <button class="secondary-button" type="button" data-open-company="${(state.data?.availability?.items || []).indexOf(item)}">상세 보기</button>
            </article>
          `).join("")}
        </div>
      </section>
    ` : ""}
  `;
}

function regionPrimary(region = {}) {
  return region.primary || region.cluster || region.core || "확인필요";
}

function regionRuntimeForMapRegion(region = {}) {
  const localNames = [
    region.region,
    region.name,
    region.target
  ].map(compactSearchText).filter((name) => name.length >= 2);
  const clusterNames = [
    region.primary,
    region.cluster,
    region.core
  ].map(compactSearchText).filter((name) => name.length >= 2);
  const regionNames = localNames.length ? localNames : clusterNames;
  const items = (state.data?.availability?.items || []).filter((item) => {
    const haystack = compactSearchText([
      item.region,
      item.addressRegion,
      item.searchRegion,
      item.searchCluster,
      item.address,
      item.name,
      item.searchKeyword
    ].filter(Boolean).join(" "));
    return haystack.length >= 2 && regionNames.some((name) => name.length >= 2 && (haystack.includes(name) || name.includes(haystack)));
  });
  const sales = summarizeSales(items);
  const outsideCount = items.filter((item) => item.regionBoundaryStatus === "outside" || item.outsideSearchRegion).length;
  return {
    items,
    sales,
    outsideCount,
    salesRate: sales.supply ? sales.sold / sales.supply : NaN
  };
}

function uniqueClusterItems(items = []) {
  const seen = new Set();
  return items.filter((item, index) => {
    const key = item.companyId || item.placeId || item.naverPlaceId || item.bookingId || companyKey(item.name) || `cluster-${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clusterRevenueMetrics(items = []) {
  const rows = uniqueClusterItems(items).map((item) => {
    const profile = preciseRevenueProfile(item);
    const revenue = finiteNumber(profile.totalAdjustedRevenue, 0) || finiteNumber(profile.totalRevenue, 0);
    return { item, revenue };
  }).filter((row) => row.revenue > 0);
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  return {
    sampleCount: rows.length,
    total,
    average: rows.length ? total / rows.length : 0
  };
}

function scorePart(key, label, score, max, value, note, tone = "neutral") {
  const safeScore = Math.max(0, Math.min(max, Math.round(Number(score) || 0)));
  return {
    key,
    label,
    score: safeScore,
    max,
    value,
    note,
    tone,
    width: max ? Math.round((safeScore / max) * 100) : 0
  };
}

function clusterScoreDetail(cluster = {}) {
  const density = cluster.count ? cluster.itemCount / cluster.count : 0;
  const salesRate = Number(cluster.salesRate);
  const revenueCoverage = cluster.itemCount ? cluster.revenueSampleCount / cluster.itemCount : NaN;
  const localFit = cluster.itemCount
    ? (finiteNumber(cluster.localCount, 0) + finiteNumber(cluster.adjacentCount, 0) * 0.65) / cluster.itemCount
    : NaN;
  const parts = [
    scorePart(
      "density",
      "노출 밀도",
      Math.min(22, density * 4),
      22,
      `${fmtNumber(cluster.itemCount)}곳`,
      `${fmtNumber(cluster.count)}개 지역 · 지역당 ${density ? density.toFixed(1) : "0"}곳`,
      density >= 4 ? "strong" : density >= 2 ? "good" : "neutral"
    ),
    scorePart(
      "reservation",
      "예약율",
      Number.isFinite(salesRate) ? salesRate * 22 : 0,
      22,
      Number.isFinite(salesRate) ? fmtRate(salesRate) : "대기",
      cluster.supply ? `${fmtNumber(cluster.sold)}/${fmtNumber(cluster.supply)}실` : "네이버 플레이스 예약 표본 대기",
      Number.isFinite(salesRate) && salesRate >= B2B_HIGH_RESERVATION_RATE ? "hot" : Number.isFinite(salesRate) ? "good" : "watch"
    ),
    scorePart(
      "revenue",
      "매출 표본",
      Number.isFinite(revenueCoverage) ? revenueCoverage * 20 : 0,
      20,
      cluster.revenueSampleCount ? `${fmtNumber(cluster.revenueSampleCount)}곳` : "대기",
      cluster.revenueSampleCount ? `평균 ${fmtWon(cluster.revenueAverage)}` : "가격·수량 표본 필요",
      cluster.revenueSampleCount ? "strong" : "watch"
    ),
    scorePart(
      "search",
      "검색 수요",
      Math.min(22, cluster.searchVolume / 900),
      22,
      cluster.searchVolume ? fmtNumber(cluster.searchVolume) : "대기",
      "지역 키워드 월검색량 합산",
      cluster.searchVolume >= 18000 ? "strong" : cluster.searchVolume ? "good" : "watch"
    ),
    scorePart(
      "distance",
      "거리 적합도",
      Number.isFinite(localFit) ? localFit * 14 : 0,
      14,
      Number.isFinite(localFit) ? fmtRate(localFit) : "대기",
      `지역 내 ${fmtNumber(cluster.localCount || 0)} · 인접 ${fmtNumber(cluster.adjacentCount || 0)} · 권역 밖 ${fmtNumber(cluster.outsideCount || 0)}`,
      Number.isFinite(localFit) && localFit >= 0.72 ? "good" : Number.isFinite(localFit) ? "watch" : "neutral"
    )
  ];
  const score = parts.reduce((sum, part) => sum + part.score, 0);
  return { parts, score };
}

function b2bRegionMapModel() {
  const regions = state.data?.regions || [];
  const items = state.data?.availability?.items || [];
  const sales = summarizeSales(items);
  const match = locationCardForQuery(activeKeyword());
  const candidate = !match?.card && !match?.group ? locationCandidateFromQuery(activeKeyword()) : null;
  const totalSearchVolume = regions.reduce((sum, region) => sum + finiteNumber(region.traffic?.totalSearchVolume, 0), 0);
  const outsideCount = items.filter((item) => item.regionBoundaryStatus === "outside" || item.outsideSearchRegion).length;
  const regionRuntime = new Map(regions.map((region) => [region, regionRuntimeForMapRegion(region)]));
  const topRegion = regions.slice().sort((a, b) => finiteNumber(b.traffic?.totalSearchVolume, 0) - finiteNumber(a.traffic?.totalSearchVolume, 0))[0] || null;
  const clusterStats = regions.reduce((acc, region) => {
    const primary = regionPrimary(region);
    const runtime = regionRuntime.get(region) || regionRuntimeForMapRegion(region);
    const searchVolume = finiteNumber(region.traffic?.totalSearchVolume, 0);
    if (!acc[primary]) {
      acc[primary] = {
        name: primary,
        count: 0,
        searchVolume: 0,
        itemCount: 0,
        localCount: 0,
        adjacentCount: 0,
        outsideCount: 0,
        unknownCount: 0,
        sold: 0,
        supply: 0,
        revenueSampleCount: 0,
        revenueTotal: 0
      };
    }
    const uniqueItems = uniqueClusterItems(runtime.items);
    const revenueMetrics = clusterRevenueMetrics(uniqueItems);
    const boundaryCounts = uniqueItems.reduce((counts, item) => {
      const bucket = b2bBoundaryBucket(item);
      counts[bucket] = (counts[bucket] || 0) + 1;
      return counts;
    }, { local: 0, adjacent: 0, outside: 0, unknown: 0 });
    acc[primary].count += 1;
    acc[primary].searchVolume += searchVolume;
    acc[primary].itemCount += uniqueItems.length;
    acc[primary].localCount += finiteNumber(boundaryCounts.local, 0);
    acc[primary].adjacentCount += finiteNumber(boundaryCounts.adjacent, 0);
    acc[primary].outsideCount += finiteNumber(boundaryCounts.outside, 0);
    acc[primary].unknownCount += finiteNumber(boundaryCounts.unknown, 0);
    acc[primary].sold += finiteNumber(runtime.sales?.sold, 0);
    acc[primary].supply += finiteNumber(runtime.sales?.supply, 0);
    acc[primary].revenueSampleCount += revenueMetrics.sampleCount;
    acc[primary].revenueTotal += revenueMetrics.total;
    return acc;
  }, {});
  const clusters = Object.values(clusterStats)
    .map((cluster) => {
      const salesRate = cluster.supply ? cluster.sold / cluster.supply : NaN;
      const revenueAverage = cluster.revenueSampleCount ? cluster.revenueTotal / cluster.revenueSampleCount : 0;
      const detail = clusterScoreDetail({ ...cluster, salesRate, revenueAverage });
      return { ...cluster, salesRate, revenueAverage, score: detail.score, scoreParts: detail.parts };
    })
    .sort((a, b) => b.score - a.score || b.searchVolume - a.searchVolume || b.count - a.count)
    .slice(0, 5)
    .map((cluster) => cluster);
  const status = match?.card
    ? { label: "지역카드 연결", tone: "good", detail: match.card.searchKeyword || match.alias?.searchKeyword || activeKeyword() }
    : match?.group
      ? { label: "광역 권역", tone: "group", detail: match.group.searchKeyword || match.group.sido || activeKeyword() }
      : candidate
        ? { label: "신규 지역 후보", tone: "watch", detail: candidate.regionBase || candidate.keyword }
        : { label: "카드 대기", tone: "wait", detail: "현재 수집 표본 기준" };
  return {
    regions,
    items,
    sales,
    salesRate: sales.supply ? sales.sold / sales.supply : NaN,
    totalSearchVolume,
    outsideCount,
    regionRuntime,
    topRegion,
    clusters,
    status,
    summary: "네이버 플레이스는 검색 중심과 반경에 따라 인접 지역이 함께 노출될 수 있어, 권역 밖 표본은 제외가 아니라 실제 경쟁권으로 분리 해석합니다."
  };
}

function b2bBoundaryBucket(item = {}) {
  const status = item.regionBoundaryStatus || (item.outsideSearchRegion ? "outside" : "same");
  if (status === "outside") return "outside";
  if (status === "within" || status === "parent") return "adjacent";
  if (status === "same") return "local";
  return "unknown";
}

function b2bMapCompetitionModel(model = b2bRegionMapModel()) {
  const rankRows = b2bRankBoardModel();
  const buckets = model.items.reduce((acc, item) => {
    const bucket = b2bBoundaryBucket(item);
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, { local: 0, adjacent: 0, outside: 0, unknown: 0 });
  const radiusRows = rankRows.rows
    .filter((row) => row.item.regionBoundaryStatus === "outside" || row.item.outsideSearchRegion || b2bBoundaryBucket(row.item) === "adjacent")
    .slice(0, 5);
  const fallbackRows = rankRows.rows.slice(0, 5);
  const competitorRows = (radiusRows.length ? radiusRows : fallbackRows).map((row) => {
    const itemIndex = row.linked ? finiteNumber(row.item.availabilityIndex, -1) : -1;
    const bucket = b2bBoundaryBucket(row.item);
    const boundaryLabel = bucket === "outside"
      ? "권역 밖"
      : bucket === "adjacent"
        ? "인접권"
        : bucket === "local"
          ? "지역 내"
          : "권역 확인";
    const location = itemLocationLine(row.item);
    return {
      itemIndex,
      rank: row.rank,
      name: row.item.name || "업체명 확인",
      boundaryLabel,
      tone: bucket === "outside" ? "watch" : row.insight?.tone || "neutral",
      metric: Number.isFinite(row.rate) ? fmtRate(row.rate) : (row.rank ? `${fmtNumber(row.rank)}위` : "노출"),
      note: row.linked
        ? `${location} · 잔여 ${fmtNumber(row.remaining)}실`
        : `${location} · 예약 표본 대기`
    };
  });
  const regionRows = model.regions.map((region) => {
    const runtime = model.regionRuntime.get(region) || regionRuntimeForMapRegion(region);
    const traffic = region.traffic || {};
    const searchVolume = finiteNumber(traffic.totalSearchVolume, 0);
    const salesRate = Number(runtime.salesRate);
    const score = Math.round(
      Math.min(45, searchVolume / 900)
      + Math.min(30, runtime.items.length * 4)
      + (Number.isFinite(salesRate) ? salesRate * 25 : 0)
      + Math.min(12, runtime.outsideCount * 4)
    );
    return {
      region,
      runtime,
      score,
      primary: regionPrimary(region),
      name: region.region || region.name || "지역",
      searchVolume,
      salesRate,
      tone: score >= 70 ? "strong" : score >= 46 ? "watch" : "neutral"
    };
  }).sort((a, b) => b.score - a.score || b.searchVolume - a.searchVolume).slice(0, 4);
  const salesRate = Number(model.salesRate);
  const localRatio = model.items.length ? buckets.local / model.items.length : NaN;
  const cards = [
    {
      tone: "neutral",
      label: "검색권 표본",
      value: fmtNumber(model.items.length),
      note: "네이버 노출 경쟁업체"
    },
    {
      tone: model.outsideCount ? "watch" : "good",
      label: "권역 밖 노출",
      value: fmtNumber(model.outsideCount),
      note: model.outsideCount ? "반경 노출 경쟁권 포함" : "지역 내 표본 중심"
    },
    {
      tone: Number.isFinite(localRatio) && localRatio >= 0.7 ? "good" : "watch",
      label: "지역 내 비중",
      value: Number.isFinite(localRatio) ? fmtRate(localRatio) : "확인필요",
      note: `지역 내 ${fmtNumber(buckets.local)} · 인접 ${fmtNumber(buckets.adjacent)}`
    },
    {
      tone: Number.isFinite(salesRate) && salesRate >= 0.55 ? "strong" : "neutral",
      label: "경쟁 판매율",
      value: Number.isFinite(salesRate) ? fmtRate(salesRate) : "확인필요",
      note: model.sales.supply ? `${fmtNumber(model.sales.sold)}/${fmtNumber(model.sales.supply)}실` : "수량 표본 대기"
    }
  ];
  const actionRows = [
    {
      label: "지역 내 경쟁",
      value: `${fmtNumber(buckets.local)}개`,
      detail: "검색 지역 안에 있는 업체는 직접 경쟁권으로 보고 노출 순위와 판매율을 우선 비교합니다."
    },
    {
      label: "인접/반경 경쟁",
      value: `${fmtNumber(buckets.adjacent + buckets.outside)}개`,
      detail: "소재지가 달라도 네이버 반경 노출로 함께 보이면 고객 입장에서는 같은 선택지입니다."
    },
    {
      label: "지도 해석 기준",
      value: "최대 100km",
      detail: "네이버 플레이스는 검색 중심 반경 노출이 가능하므로 행정구역보다 실제 노출권을 우선 봅니다."
    }
  ];
  return {
    buckets,
    cards,
    actionRows,
    regionRows,
    competitorRows
  };
}

function renderB2BMapCompetitionBoard(model = b2bRegionMapModel(), board = b2bMapCompetitionModel(model)) {
  if (isAdminRole()) return "";
  return `
    <div class="b2b-map-competition-board">
      <div class="b2b-map-board-head">
        <div>
          <strong>지역 경쟁권 해석</strong>
          <span>행정구역과 실제 네이버 반경 노출을 분리해 봅니다.</span>
        </div>
        <em>${board.buckets.outside ? "반경 노출 포함" : "지역 내 중심"}</em>
      </div>
      <div class="b2b-map-board-grid">
        ${board.cards.map((card) => `
          <article class="${escapeHtml(card.tone)}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(card.value)}</strong>
            <small>${escapeHtml(card.note)}</small>
          </article>
        `).join("")}
      </div>
      <div class="b2b-map-board-layout">
        <article class="b2b-map-action-board">
          ${board.actionRows.map((row) => `
            <div>
              <span>${escapeHtml(row.label)}</span>
              <strong>${escapeHtml(row.value)}</strong>
              <small>${escapeHtml(row.detail)}</small>
            </div>
          `).join("")}
        </article>
        <article class="b2b-map-region-rank">
          <div>
            <strong>주요 경쟁권</strong>
            <small>검색량·업체수·판매율 기준</small>
          </div>
          ${board.regionRows.length ? board.regionRows.map((row) => `
            <div class="${escapeHtml(row.tone)}">
              <span>${escapeHtml(row.name)}</span>
              <strong>${fmtNumber(row.score)}</strong>
              <small>${escapeHtml(`${row.primary} · 업체 ${fmtNumber(row.runtime.items.length)} · 검색 ${row.searchVolume ? fmtNumber(row.searchVolume) : "대기"} · 판매 ${Number.isFinite(row.salesRate) ? fmtRate(row.salesRate) : "대기"}`)}</small>
            </div>
          `).join("") : `<p>지역 표본이 없습니다.</p>`}
        </article>
      </div>
      <div class="b2b-map-radius-list">
        <div>
          <strong>지도 업체 요약</strong>
          <small>점 또는 행을 누르면 예약·가격·채널 요약을 엽니다.</small>
        </div>
        ${board.competitorRows.length ? board.competitorRows.map((row) => {
          const attrs = row.itemIndex >= 0 ? `type="button" data-open-company="${row.itemIndex}"` : `type="button" disabled`;
          return `
            <button class="${escapeHtml(row.tone)}" ${attrs}>
              <span>${row.rank ? `${fmtNumber(row.rank)}위` : "순위"}</span>
              <strong>${escapeHtml(row.name)}</strong>
              <em>${escapeHtml(row.boundaryLabel)}</em>
              <small>${escapeHtml(`${row.metric} · ${row.note}`)}</small>
            </button>
          `;
        }).join("") : `<p>반경 노출 경쟁업체 표본이 없습니다.</p>`}
      </div>
    </div>
  `;
}

function renderB2BRegionMapBrief(model = b2bRegionMapModel()) {
  if (isAdminRole()) return "";
  const topRegionName = model.topRegion?.region || model.topRegion?.name || "확인필요";
  const salesRate = Number.isFinite(model.salesRate) ? fmtRate(model.salesRate) : "확인필요";
  const clusterDetailRows = model.clusters.slice(0, 3);
  return `
    <section class="b2b-map-brief ${escapeHtml(model.status.tone)}">
      <div class="b2b-map-head">
        <div>
          <p class="eyebrow">B2B Competition Map</p>
          <h3>${escapeHtml(activeKeyword())} 지역 경쟁 구조</h3>
          <p>${escapeHtml(model.summary)}</p>
        </div>
        <strong>${escapeHtml(model.status.label)}</strong>
      </div>
      <div class="b2b-map-metrics">
        <article><span>대표 권역</span><strong>${escapeHtml(topRegionName)}</strong><small>${escapeHtml(model.status.detail || "현재 검색 기준")}</small></article>
        <article><span>경쟁업체</span><strong>${fmtNumber(model.items.length)}</strong><small>네이버 노출 표본</small></article>
        <article><span>판매율</span><strong>${salesRate}</strong><small>${model.sales.supply ? `${fmtNumber(model.sales.sold)}/${fmtNumber(model.sales.supply)}실` : "수량 표본 대기"}</small></article>
        <article><span>월 검색량</span><strong>${model.totalSearchVolume ? fmtNumber(model.totalSearchVolume) : "확인필요"}</strong><small>지역 키워드 합산</small></article>
        <article><span>권역 밖 노출</span><strong>${fmtNumber(model.outsideCount)}</strong><small>반경 노출 별도 해석</small></article>
      </div>
      <div class="b2b-map-cluster-row">
        ${model.clusters.length
          ? model.clusters.map((cluster) => `
            <span>
              <strong>${escapeHtml(cluster.name)} ${fmtNumber(cluster.score)}점</strong>
              <small>${escapeHtml(`노출 ${fmtNumber(cluster.itemCount)} · 예약 ${Number.isFinite(cluster.salesRate) ? fmtRate(cluster.salesRate) : "대기"} · 매출표본 ${fmtNumber(cluster.revenueSampleCount || 0)}`)}</small>
            </span>
          `).join("")
          : `<span>클러스터 대기</span>`}
      </div>
      ${clusterDetailRows.length ? `
        <div class="b2b-map-cluster-detail">
          <div class="b2b-map-cluster-detail-head">
            <strong>클러스터 점수 상세</strong>
            <small>노출 밀도 · 예약율 · 매출 표본 · 검색 수요 · 거리 적합도 기준</small>
          </div>
          ${clusterDetailRows.map((cluster) => `
            <article class="b2b-map-cluster-card">
              <div class="b2b-map-cluster-card-head">
                <div>
                  <span>${escapeHtml(cluster.name)}</span>
                  <strong>${fmtNumber(cluster.score)}점</strong>
                </div>
                <small>${escapeHtml(`지역 ${fmtNumber(cluster.count)} · 업체 ${fmtNumber(cluster.itemCount)} · 검색 ${cluster.searchVolume ? fmtNumber(cluster.searchVolume) : "대기"}`)}</small>
              </div>
              <div class="b2b-map-score-parts">
                ${(cluster.scoreParts || []).map((part) => `
                  <div class="${escapeHtml(part.tone || "neutral")}">
                    <span>${escapeHtml(part.label)}</span>
                    <strong>${fmtNumber(part.score)}/${fmtNumber(part.max)}</strong>
                    <i style="--score:${Math.max(0, Math.min(100, Number(part.width) || 0))}%"><b></b></i>
                    <small>${escapeHtml(`${part.value} · ${part.note}`)}</small>
                  </div>
                `).join("")}
              </div>
            </article>
          `).join("")}
        </div>
      ` : ""}
      ${renderB2BMapCompetitionBoard(model)}
    </section>
  `;
}

function renderMapControls() {
  els.mapLayerRow.innerHTML = ["검색 중심", "50/100km 반경", "지역 내 업체", "인접권", "권역 밖"].map((name, index) => `
    <span><b style="background:${["#6aa8ff", "#8fc7ff", "#34d399", "#fbbf24", "#fb7185"][index]}"></b>${name}</span>
  `).join("");
  els.mapLegend.innerHTML = CORE_ORDER.slice(0, 5).map((name) => `
    <span><b style="background:${CORE_COLORS[name]}"></b>${name}</span>
  `).join("") + `<span><b style="background:#ffffff;border:2px solid #34d399"></b>업체 점 클릭 시 요약</span>`;
  const caption = document.querySelector(".map-caption");
  if (caption) caption.textContent = "검색 기준 지역 중심 · 50/100km 반경 · 업체 위치 점 · 권역 밖 노출 구분";
}

async function loadLocalMap() {
  if (state.mapData) return state.mapData;
  if (!state.mapPromise) {
    state.mapPromise = fetch(LOCAL_MAP_URL)
      .then((res) => res.ok ? res.json() : null)
      .catch(() => null);
  }
  state.mapData = await state.mapPromise;
  return state.mapData;
}

function coordinatePairs(geometry) {
  const pairs = [];
  function walk(value) {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      pairs.push([value[0], value[1]]);
      return;
    }
    value.forEach(walk);
  }
  walk(geometry?.coordinates);
  return pairs;
}

function project(lon, lat, bounds) {
  const width = 720;
  const height = 620;
  const pad = 34;
  const x = pad + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon || 1)) * (width - pad * 2);
  const y = pad + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat || 1)) * (height - pad * 2);
  return [x, y];
}

function coordinateFromValue(value = {}) {
  const pairs = [
    [value.lon, value.lat],
    [value.lng, value.lat],
    [value.longitude, value.latitude],
    [value.x, value.y],
    [value.geo?.lon, value.geo?.lat],
    [value.geo?.lng, value.geo?.lat],
    [value.geo?.longitude, value.geo?.latitude],
    [value.location?.lon, value.location?.lat],
    [value.location?.lng, value.location?.lat],
    [value.location?.longitude, value.location?.latitude],
    [value.companyProfile?.location?.lon, value.companyProfile?.location?.lat],
    [value.companyProfile?.location?.lng, value.companyProfile?.location?.lat],
    [value.companyProfile?.location?.longitude, value.companyProfile?.location?.latitude],
    [value.companyProfile?.geo?.lon, value.companyProfile?.geo?.lat],
    [value.companyProfile?.geo?.longitude, value.companyProfile?.geo?.latitude]
  ];
  for (const [rawLon, rawLat] of pairs) {
    const lon = Number(rawLon);
    const lat = Number(rawLat);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return { lon, lat, source: "exact" };
  }
  return null;
}

function regionCoordinate(region = {}) {
  const coordinate = coordinateFromValue(region);
  return coordinate ? { ...coordinate, source: "region" } : null;
}

function regionMatchScoreForItem(region = {}, item = {}) {
  const regionTokens = [
    region.region,
    region.name,
    region.target,
    region.searchKeyword,
    region.primary,
    region.cluster,
    region.core
  ].map(compactSearchText).filter((token) => token.length >= 2);
  const itemText = compactSearchText([
    item.region,
    item.addressRegion,
    item.searchRegion,
    item.searchCluster,
    item.address,
    item.name,
    item.searchKeyword
  ].filter(Boolean).join(" "));
  if (!itemText || !regionTokens.length) return 0;
  return regionTokens.reduce((score, token) => {
    if (itemText === token) return Math.max(score, 7);
    if (itemText.includes(token)) return Math.max(score, token.length >= 3 ? 6 : 4);
    if (token.includes(itemText)) return Math.max(score, 3);
    return score;
  }, 0);
}

function regionForCompanyMapItem(item = {}, regions = []) {
  let best = null;
  let bestScore = 0;
  for (const region of regions) {
    const score = regionMatchScoreForItem(region, item);
    if (score > bestScore) {
      best = region;
      bestScore = score;
    }
  }
  return best || regions[0] || null;
}

function fallbackCompanyCoordinate(item = {}, index = 0, regions = [], centerRegion = null) {
  const bucket = b2bBoundaryBucket(item);
  const baseRegion = regionForCompanyMapItem(item, regions) || centerRegion;
  const base = regionCoordinate(baseRegion || {});
  if (!base) return null;
  const angle = (index * 137.508 + (bucket === "outside" ? 34 : bucket === "adjacent" ? 18 : 0)) * Math.PI / 180;
  const distance = bucket === "outside"
    ? 0.28 + (index % 4) * 0.035
    : bucket === "adjacent"
      ? 0.17 + (index % 3) * 0.028
      : 0.055 + (index % 5) * 0.014;
  const latFactor = Math.max(0.35, Math.cos(base.lat * Math.PI / 180));
  return {
    lon: base.lon + (Math.cos(angle) * distance) / latFactor,
    lat: base.lat + Math.sin(angle) * distance,
    source: "estimated",
    baseRegion
  };
}

function companyMapPointRows(regions = []) {
  const centerRegion = b2bRegionMapModel().topRegion || regions[0] || null;
  const rankRows = b2bRankBoardModel().rows.slice(0, 30);
  return rankRows.map((row, index) => {
    const explicit = coordinateFromValue(row.item);
    const coordinate = explicit || fallbackCompanyCoordinate(row.item, index, regions, centerRegion);
    if (!coordinate) return null;
    const itemIndex = Number.isFinite(row.itemIndex)
      ? row.itemIndex
      : (row.linked ? finiteNumber(row.item?.availabilityIndex, -1) : (state.data?.availability?.items || []).indexOf(row.item));
    const bucket = b2bBoundaryBucket(row.item);
    return {
      ...row,
      coordinate,
      itemIndex,
      bucket,
      tone: bucket === "outside" ? "outside" : bucket === "adjacent" ? "adjacent" : row.insight?.tone || "local",
      label: bucket === "outside" ? "권역 밖" : bucket === "adjacent" ? "인접권" : "지역 내"
    };
  }).filter(Boolean);
}

function svgRadiusForKm(lon, lat, km, bounds) {
  const [, y1] = project(lon, lat, bounds);
  const [, y2] = project(lon, lat + km / 111, bounds);
  return Math.abs(y2 - y1);
}

function featurePath(feature, bounds) {
  const type = feature.geometry?.type;
  const coordinates = feature.geometry?.coordinates || [];
  const polygons = type === "Polygon" ? [coordinates] : coordinates;
  return polygons.map((polygon) => {
    const ring = polygon[0] || [];
    return ring.map(([lon, lat], index) => {
      const [x, y] = project(lon, lat, bounds);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ") + " Z";
  }).join(" ");
}

function regionBounds(regions = [], features = [], items = []) {
  const pairs = [];
  for (const region of regions) {
    const lon = Number(region.lon || region.lng || region.longitude);
    const lat = Number(region.lat || region.latitude);
    if (Number.isFinite(lon) && Number.isFinite(lat)) pairs.push([lon, lat]);
  }
  for (const item of items) {
    const coordinate = coordinateFromValue(item);
    if (coordinate) pairs.push([coordinate.lon, coordinate.lat]);
  }
  if (!pairs.length) {
    features.slice(0, 80).forEach((feature) => pairs.push(...coordinatePairs(feature.geometry)));
  }
  if (!pairs.length) return { minLon: 124.5, maxLon: 131.9, minLat: 33.0, maxLat: 38.8 };
  const lons = pairs.map((pair) => pair[0]);
  const lats = pairs.map((pair) => pair[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const lonPad = Math.max(0.35, (maxLon - minLon) * 1.2);
  const latPad = Math.max(0.25, (maxLat - minLat) * 1.2);
  return {
    minLon: minLon - lonPad,
    maxLon: maxLon + lonPad,
    minLat: minLat - latPad,
    maxLat: maxLat + latPad
  };
}

function featureName(feature) {
  return feature.properties?.name || feature.properties?.SIG_KOR_NM || feature.properties?.adm_nm || "";
}

async function renderMap() {
  renderMapControls();
  const regions = state.data?.regions || [];
  const items = state.data?.availability?.items || [];
  els.mapCount.textContent = `${fmtNumber(regions.length)} 지역`;
  const geojson = await loadLocalMap();
  const features = geojson?.features || [];
  const activeNames = new Set(regions.map((region) => String(region.region || region.name || "").replace(/\s+/g, "")));
  const bounds = regionBounds(regions, features, items);
  const model = b2bRegionMapModel();
  const centerRegion = model.topRegion || regions[0] || null;
  const centerCoordinate = regionCoordinate(centerRegion || {});
  const companyPoints = companyMapPointRows(regions);

  const visibleFeatures = features.filter((feature) => {
    const pairs = coordinatePairs(feature.geometry);
    if (!pairs.length) return false;
    return pairs.some(([lon, lat]) => lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat);
  }).slice(0, 180);

  const paths = visibleFeatures.map((feature) => {
    const name = featureName(feature).replace(/\s+/g, "");
    const active = Array.from(activeNames).some((regionName) => name.includes(regionName) || regionName.includes(name));
    return `<path class="map-region ${active ? "active" : ""}" d="${featurePath(feature, bounds)}"></path>`;
  }).join("");

  const radiusOverlay = centerCoordinate ? (() => {
    const [cx, cy] = project(centerCoordinate.lon, centerCoordinate.lat, bounds);
    const r50 = svgRadiusForKm(centerCoordinate.lon, centerCoordinate.lat, 50, bounds);
    const r100 = svgRadiusForKm(centerCoordinate.lon, centerCoordinate.lat, 100, bounds);
    const centerName = centerRegion?.region || centerRegion?.name || activeKeyword();
    return `
      <g class="map-radius-layer" aria-label="검색 기준 반경">
        <circle class="map-radius-ring ring-100" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r100.toFixed(1)}"></circle>
        <circle class="map-radius-ring ring-50" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r50.toFixed(1)}"></circle>
        <g class="map-search-center" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})">
          <circle r="10"></circle>
          <path d="M-15 0H15M0-15V15"></path>
          <text y="-20" text-anchor="middle">${escapeHtml(centerName)}</text>
        </g>
      </g>
    `;
  })() : "";

  const markers = regions.map((region, index) => {
    const lon = Number(region.lon || region.lng || region.longitude);
    const lat = Number(region.lat || region.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return "";
    const [x, y] = project(lon, lat, bounds);
    const primary = regionPrimary(region);
    const color = CORE_COLORS[primary] || CORE_COLORS["확인필요"];
    const count = region.topPlaces?.length || region.placeCount || region.naverTopCount || index + 1;
    return `
      <g class="map-marker" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
        <circle r="17" fill="${color}" stroke="#fff" stroke-width="4"></circle>
        <text y="5" text-anchor="middle" fill="#fff" font-size="12" font-weight="900">${fmtNumber(count)}</text>
        <text y="33" text-anchor="middle" fill="#344054" font-size="12" font-weight="900">${escapeHtml(region.region || region.name || "")}</text>
      </g>
    `;
  }).join("");

  const companyMarkers = companyPoints.map((row) => {
    const [x, y] = project(row.coordinate.lon, row.coordinate.lat, bounds);
    const rank = finiteNumber(row.rank, row.index + 1);
    const radius = rank <= 5 ? 9 : rank <= 10 ? 7 : 5.5;
    const rateText = Number.isFinite(row.rate) ? fmtRate(row.rate) : "예약율 대기";
    const attrs = row.itemIndex >= 0 ? `data-open-company="${row.itemIndex}" tabindex="0" role="button"` : "";
    const sourceText = row.coordinate.source === "exact" ? "좌표" : "지역 중심 추정";
    const name = row.item?.name || "업체명 확인";
    const label = rank <= 5 || row.bucket !== "local"
      ? `<text class="company-map-label" x="12" y="-10">${escapeHtml(name.slice(0, 10))}</text>`
      : "";
    return `
      <g class="company-map-marker ${escapeHtml(row.bucket)} ${escapeHtml(row.tone)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" ${attrs}>
        <title>${escapeHtml(`${fmtNumber(rank)}위 · ${name} · ${row.label} · ${rateText} · ${sourceText}`)}</title>
        <circle class="company-map-hit" r="20"></circle>
        <circle class="company-map-halo" r="${(radius + 7).toFixed(1)}"></circle>
        <circle class="company-map-dot" r="${radius.toFixed(1)}"></circle>
        <text class="company-map-rank" y="3" text-anchor="middle">${rank <= 20 ? fmtNumber(rank) : ""}</text>
        ${label}
      </g>
    `;
  }).join("");

  els.clusterMap.innerHTML = `${paths}${radiusOverlay}${markers}${companyMarkers}`;
  renderRegions();
}

function renderRegions() {
  const regions = state.data?.regions || [];
  if (!regions.length) {
    els.regionList.innerHTML = `<div class="empty">지역 클러스터 데이터가 없습니다.</div>`;
    return;
  }
  const model = b2bRegionMapModel();
  const cards = regions.map((region) => {
    const traffic = region.traffic || {};
    const primary = regionPrimary(region);
    const runtime = model.regionRuntime.get(region) || regionRuntimeForMapRegion(region);
    const priority = demandPriorityLabel(traffic, runtime.items.length ? 6 : 0);
    const tone = priority.includes("1") ? "strong" : priority.includes("2") ? "watch" : "neutral";
    const salesRate = Number.isFinite(runtime.salesRate) ? fmtRate(runtime.salesRate) : "확인필요";
    const boundaryNote = runtime.outsideCount
      ? `${fmtNumber(runtime.outsideCount)}곳은 검색권역 밖 소재입니다. 네이버 반경 노출 경쟁권으로 봅니다.`
      : "검색권역 내부 표본 중심입니다.";
    return `
      <article class="region-card ${escapeHtml(tone)}">
        <div class="region-card-main">
          <strong>${escapeHtml(region.region || region.name || "지역")}</strong>
          <small>${escapeHtml(primary)} · ${escapeHtml(region.target || "수요권 확인")}</small>
          <p>월검색 ${fmtNumber(traffic.totalSearchVolume || 0)} · CTR ${traffic.collectable ? fmtSearchRate(traffic.combinedCtr) : "확인필요"}</p>
        </div>
        <em>${escapeHtml(priority)}</em>
        <div class="region-card-metrics">
          <div><span>업체 표본</span><strong>${fmtNumber(runtime.items.length)}</strong><small>${escapeHtml(region.dominantType || region.type || "분석")}</small></div>
          <div><span>판매율</span><strong>${salesRate}</strong><small>${runtime.sales.supply ? `${fmtNumber(runtime.sales.sold)}/${fmtNumber(runtime.sales.supply)}실` : "표본 대기"}</small></div>
          <div><span>월검색</span><strong>${traffic.totalSearchVolume ? fmtNumber(traffic.totalSearchVolume) : "확인필요"}</strong><small>키워드 수요</small></div>
          <div><span>CTR</span><strong>${traffic.collectable ? fmtSearchRate(traffic.combinedCtr) : "확인필요"}</strong><small>클릭 반응</small></div>
        </div>
        ${!isAdminRole() ? `<p class="region-card-note">${escapeHtml(boundaryNote)}</p>` : ""}
      </article>
    `;
  }).join("");
  els.regionList.innerHTML = `${renderB2BRegionMapBrief(model)}${cards}`;
}

function renderDownloads() {
  const downloads = state.data?.downloads || [];
  if (!downloads.length) {
    els.downloadList.innerHTML = `<div class="empty">다운로드할 파일이 없습니다.</div>`;
    return;
  }
  els.downloadList.innerHTML = downloads.map((file) => `
    <a class="download-item" href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer">
      <strong>${escapeHtml(file.label || "파일")}</strong>
      <span>${escapeHtml(file.name || file.url)}</span>
    </a>
  `).join("");
}

function renderDictionaryQuickButtons() {
  if (!els.dictionaryQuickButtons) return;
  const groups = state.dictionary?.regionGroups || [];
  const cards = state.dictionary?.cards || [];
  els.dictionaryQuickButtons.innerHTML = [
    ...groups.map((group) => `
    <button class="dictionary-chip group" type="button" data-location-query="${escapeHtml(group.searchKeyword)}">
      ${escapeHtml(group.searchKeyword)}
    </button>
  `),
    ...cards.map((card) => `
    <button class="dictionary-chip" type="button" data-location-query="${escapeHtml(card.searchKeyword)}">
      ${escapeHtml(card.searchKeyword)}
    </button>
  `)
  ].join("");
}

function dictionaryAliasForCard(card) {
  if (!card) return null;
  return (state.dictionary?.aliases || []).find((alias) => alias.regionKey === card.regionKey) || null;
}

function weightedLocationScore(card) {
  const indexes = Object.values(card?.indexes || {});
  const models = state.dictionary?.scoreModels || [];
  let weighted = 0;
  let totalWeight = 0;
  indexes.forEach((index) => {
    const model = models.find((entry) => entry.name === index.label || entry.name.includes(index.shortLabel));
    const weight = Number(model?.weight || 10);
    const raw = Number(index.value);
    if (!Number.isFinite(raw)) return;
    const reverse = String(model?.direction || "").includes("역") || /경쟁|확장/.test(index.label || "");
    weighted += (reverse ? 100 - raw : raw) * weight;
    totalWeight += weight;
  });
  return totalWeight ? Math.round(weighted / totalWeight) : NaN;
}

function locationIndexValue(card, key, fallback = NaN) {
  const value = Number(card?.indexes?.[key]?.value);
  return Number.isFinite(value) ? value : fallback;
}

function locationRuntimeScope(card = {}, alias = null) {
  const allItems = state.data?.availability?.items || [];
  const regions = state.data?.regions || [];
  const terms = [
    alias?.sigungu,
    card.searchKeyword,
    ...(alias?.aliases || [])
  ]
    .map(stripLocationBusinessWords)
    .filter((term) => term.length >= 2);
  const activeBase = stripLocationBusinessWords(activeKeyword());
  const cardBase = stripLocationBusinessWords(card.searchKeyword);
  const exactActive = activeBase && cardBase && (activeBase === cardBase || activeBase.includes(cardBase) || cardBase.includes(activeBase));

  const itemMatches = (item) => {
    const haystack = compactSearchText([item.region, item.address, item.location, item.name, item.category].filter(Boolean).join(" "));
    return terms.some((term) => term && haystack.includes(term));
  };
  const regionMatches = (region) => {
    const haystack = compactSearchText([region.region, region.name, region.target, region.note].filter(Boolean).join(" "));
    return terms.some((term) => term && haystack.includes(term));
  };
  const scopedItems = allItems.filter(itemMatches);
  const scopedRegions = regions.filter(regionMatches);
  return {
    items: scopedItems.length ? scopedItems : (exactActive ? allItems : []),
    regions: scopedRegions.length ? scopedRegions : (exactActive ? regions : []),
    exactActive
  };
}

function locationRuntimeStats(card = {}, alias = null) {
  const scope = locationRuntimeScope(card, alias);
  const items = scope.items;
  const sales = summarizeSales(items);
  const rate = sales.supply ? sales.sold / sales.supply : NaN;
  const platformStats = reportPlatformStats(items);
  const itemSet = new Set(items);
  const targets = targetEntries(0).filter((entry) => itemSet.has(entry.item));
  const adCount = items.filter((item) => /광고/.test(String(item.ad || item.adFlag || item.adStatus || ""))).length;
  const searchVolume = scope.regions.reduce((sum, region) => sum + finiteNumber(region.traffic?.totalSearchVolume, 0), 0);
  const platformGap = items.length
    ? platformStats.missingYeogi + platformStats.missingYanolja + platformStats.missingDdnayo
    : 0;
  return {
    ...scope,
    sales,
    rate,
    platformStats,
    targets,
    adCount,
    adRatio: items.length ? adCount / items.length : NaN,
    searchVolume,
    platformGap
  };
}

function locationDecision(card = {}, clusters = [], runtime = {}) {
  const baseScore = weightedLocationScore(card);
  const tourism = locationIndexValue(card, "tourism", 0);
  const dayUse = locationIndexValue(card, "dayUse", 0);
  const operation = locationIndexValue(card, "operation", 0);
  const expansionRisk = locationIndexValue(card, "expansionRisk", 0);
  const runtimeScore = runtime.items?.length
    ? reportMarketScore({
        rate: runtime.rate,
        targetCount: runtime.targets?.length || 0,
        itemCount: runtime.items.length,
        platformGapRatio: runtime.items.length ? runtime.platformGap / (runtime.items.length * 3) : 0,
        searchVolume: runtime.searchVolume
      })
    : 0;
  const confidence = Number.isFinite(baseScore)
    ? Math.round(baseScore * (runtimeScore ? 0.68 : 1) + runtimeScore * (runtimeScore ? 0.32 : 0))
    : runtimeScore || NaN;
  const headline = clusters.length
    ? clusters.map((cluster) => cluster.name).slice(0, 2).join(" + ")
    : "입지판정 확인";
  const chips = [];
  chips.push(tourism >= 70 ? "숙박 중심" : "근교/당일 검증");
  chips.push(dayUse >= 65 ? "데이유즈 강화" : "데이유즈 보조");
  chips.push(expansionRisk >= 55 ? "확장 신중" : "확장 여지");
  if (operation < 50) chips.push("운영 총량 검증");
  const summary = tourism >= 70
    ? "목적 방문 수요는 강하지만 실제 객실 총량과 운영 가능 규모를 먼저 확인해야 합니다."
    : "생활권 수요와 상품 구성의 반응을 실제 판매율로 확인해야 합니다.";
  const tone = expansionRisk >= 60 || operation < 45 ? "caution" : tourism >= 70 ? "strong" : "watch";
  return { confidence, headline, chips, summary, tone };
}

function locationEvidenceRows(card = {}) {
  const rows = [
    ["tourism", "관광", "목적 방문 강도"],
    ["operation", "운영", "인력/세탁/수리 부담"],
    ["expansionRisk", "확장주의", "객실 확대 전 총량 검증"],
    ["dayUse", "데이유즈", "당일상품 확장성"]
  ];
  return rows.map(([key, label, note]) => {
    const index = card.indexes?.[key] || {};
    const value = finiteNumber(index.value, 0);
    const [tone, band] = locationScoreBand(value, index);
    return { key, label, note, value, band, tone };
  });
}

function renderLocationDecisionPanel(card, clusters, runtime) {
  const decision = locationDecision(card, clusters, runtime);
  return `
    <section class="location-decision ${decision.tone}">
      <div class="location-decision-score">
        <span>확신도</span>
        <strong>${Number.isFinite(decision.confidence) ? fmtNumber(decision.confidence) : "확인"}</strong>
      </div>
      <div class="location-decision-copy">
        <p class="eyebrow">최종 입지판정</p>
        <h4>${escapeHtml(decision.headline)}</h4>
        <p>${escapeHtml(decision.summary)}</p>
        <div class="location-action-chips">
          ${decision.chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderLocationEvidence(card) {
  const rows = locationEvidenceRows(card);
  return `
    <section class="location-block">
      <div class="location-block-head">
        <h4>판단 근거</h4>
        <span>핵심 지수만 먼저 확인</span>
      </div>
      <div class="location-evidence-list">
        ${rows.map((row) => `
          <div class="location-evidence ${row.tone}">
            <b>${escapeHtml(row.label)}</b>
            <strong>${fmtNumber(row.value)}</strong>
            <span>${escapeHtml(row.band)} · ${escapeHtml(row.note)}</span>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderLocationReality(runtime = {}) {
  const salesRate = Number.isFinite(runtime.rate) ? fmtRate(runtime.rate) : "확인필요";
  const adRatio = Number.isFinite(runtime.adRatio) ? fmtRate(runtime.adRatio) : "확인필요";
  const salesBar = Number.isFinite(runtime.rate) ? Math.round(Math.max(0, Math.min(1, runtime.rate)) * 100) : 0;
  const dictionaryStrength = runtime.regions?.length
    ? Math.min(100, Math.round((runtime.searchVolume ? 65 : 45) + Math.min(25, runtime.items.length)))
    : 55;
  return `
    <section class="location-block">
      <div class="location-block-head">
        <h4>사전판단 × 수집결과</h4>
        <span>실제 노출/판매와 비교</span>
      </div>
      <div class="location-reality-grid">
        <div><span>상위노출</span><strong>${fmtNumber(runtime.items?.length || 0)}</strong><small>업체</small></div>
        <div><span>객실판매율</span><strong>${salesRate}</strong><small>${fmtNumber(runtime.sales?.sold || 0)}/${fmtNumber(runtime.sales?.supply || 0)}개</small></div>
        <div><span>광고비중</span><strong>${adRatio}</strong><small>${fmtNumber(runtime.adCount || 0)}개 광고</small></div>
        <div><span>월검색</span><strong>${runtime.searchVolume ? fmtNumber(runtime.searchVolume) : "API"}</strong><small>${runtime.searchVolume ? "검색량" : "확인필요"}</small></div>
      </div>
      <div class="location-compare-bars">
        <div>
          <span>사전 강도</span>
          <i><b style="width:${dictionaryStrength}%"></b></i>
          <em>${fmtNumber(dictionaryStrength)}</em>
        </div>
        <div>
          <span>실제 판매</span>
          <i><b style="width:${salesBar}%"></b></i>
          <em>${salesRate}</em>
        </div>
      </div>
    </section>
  `;
}

function renderLocationTargetPreview(runtime = {}) {
  const allItems = state.data?.availability?.items || [];
  const targets = (runtime.targets || []).slice(0, 3);
  return `
    <section class="location-block">
      <div class="location-block-head">
        <h4>컨택 우선순위</h4>
        <span>${fmtNumber(runtime.targets?.length || 0)} 후보 감지</span>
      </div>
      <div class="location-target-list">
        ${targets.length ? targets.map(({ item, reasons }, index) => {
          const itemIndex = allItems.indexOf(item);
          return `
            <button class="location-target-row" type="button" data-open-company="${itemIndex}">
              <b>${index + 1}</b>
              <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
              <span>${reasons.map(escapeHtml).slice(0, 3).join(" · ")}</span>
            </button>
          `;
        }).join("") : `<div class="location-empty-note">현재 수집결과 안에서 즉시 컨택 후보가 뚜렷하지 않습니다.</div>`}
      </div>
    </section>
  `;
}

function locationActionItems(card = {}, runtime = {}) {
  const actions = ["객실 총량 검증", "네이버 상품분리"];
  if ((runtime.platformGap || 0) > 0) actions.push("채널 공백 확인");
  if (locationIndexValue(card, "dayUse", 0) < 55) actions.push("데이유즈 설계");
  if (locationIndexValue(card, "operation", 0) < 55) actions.push("운영 한계 확인");
  actions.push("사진/가격 점검");
  return [...new Set(actions)].slice(0, 6);
}

function renderLocationActionPlan(card, runtime) {
  return `
    <section class="location-block">
      <div class="location-block-head">
        <h4>이번 주 실행</h4>
        <span>확인 순서</span>
      </div>
      <div class="location-action-panel">
        ${locationActionItems(card, runtime).map((action, index) => `
          <span><b>${index + 1}</b>${escapeHtml(action)}</span>
        `).join("")}
      </div>
    </section>
  `;
}

function locationGroupRuntimeStats(group = {}, cards = []) {
  const allItems = state.data?.availability?.items || [];
  const allRegions = state.data?.regions || [];
  const aliases = state.dictionary?.aliases || [];
  const terms = [
    group.searchKeyword,
    group.sido,
    ...(group.aliases || []),
    ...(group.plannedKeywords || []),
    ...cards.flatMap((card) => {
      const alias = aliases.find((item) => item.regionKey === card.regionKey) || {};
      return [card.searchKeyword, alias.sigungu, ...(alias.aliases || [])];
    })
  ]
    .map(stripLocationBusinessWords)
    .filter((term) => term.length >= 2);
  const activeBase = stripLocationBusinessWords(activeKeyword());
  const groupBase = stripLocationBusinessWords(group.searchKeyword || group.sido || "");
  const exactActive = activeBase && groupBase && (activeBase === groupBase || activeBase.includes(groupBase) || groupBase.includes(activeBase));
  const matches = (values = []) => {
    const haystack = compactSearchText(values.filter(Boolean).join(" "));
    return terms.some((term) => term && haystack.includes(term));
  };
  const scopedItems = allItems.filter((item) => matches([item.region, item.address, item.location, item.name, item.category]));
  const scopedRegions = allRegions.filter((region) => matches([region.region, region.name, region.target, region.note]));
  const items = scopedItems.length ? scopedItems : (exactActive ? allItems : []);
  const regions = scopedRegions.length ? scopedRegions : (exactActive ? allRegions : []);
  const sales = summarizeSales(items);
  const rate = sales.supply ? sales.sold / sales.supply : NaN;
  const platformStats = reportPlatformStats(items);
  const itemSet = new Set(items);
  const targets = targetEntries(0).filter((entry) => itemSet.has(entry.item));
  const adCount = items.filter((item) => /광고/.test(String(item.ad || item.adFlag || item.adStatus || ""))).length;
  const searchVolume = regions.reduce((sum, region) => sum + finiteNumber(region.traffic?.totalSearchVolume, 0), 0);
  const platformGap = items.length
    ? platformStats.missingYeogi + platformStats.missingYanolja + platformStats.missingDdnayo
    : 0;
  return {
    items,
    regions,
    sales,
    rate,
    platformStats,
    targets,
    adCount,
    adRatio: items.length ? adCount / items.length : NaN,
    searchVolume,
    platformGap,
    exactActive
  };
}

function locationGroupDecision(group = {}, cards = [], runtime = {}, score = NaN, clusters = []) {
  const runtimeScore = runtime.items?.length
    ? reportMarketScore({
        rate: runtime.rate,
        targetCount: runtime.targets?.length || 0,
        itemCount: runtime.items.length,
        platformGapRatio: runtime.items.length ? runtime.platformGap / (runtime.items.length * 3) : 0,
        searchVolume: runtime.searchVolume
      })
    : 0;
  const marketSignal = finiteNumber(group.marketSignal, 0);
  const baseScore = Number.isFinite(score) ? score : marketSignal;
  const decisionScore = Math.round(
    (baseScore || 0) * 0.55 +
    (marketSignal || 0) * 0.2 +
    (runtimeScore || baseScore || 0) * 0.25
  );
  const label = decisionScore >= 76
    ? "집중 권역"
    : decisionScore >= 64
      ? "선별 권역"
      : "보강 권역";
  const dominant = clusters[0]?.name || group.strategy || "권역 판단";
  const second = clusters[1]?.name || "하위 지역 검증";
  const summary = runtime.items?.length
    ? "광역 검색으로 시장 크기를 보고, 수집결과가 붙는 하위 지역부터 영업 우선순위를 잡습니다."
    : "광역 사전 판단은 가능하지만 현재 run의 실제 수집결과와 연결된 업체가 적어 추가 수집이 필요합니다.";
  const chips = [
    `${fmtNumber(cards.length)}개 지역카드`,
    runtime.items?.length ? `${fmtNumber(runtime.items.length)}개 업체연결` : "실측 연결 대기",
    runtime.targets?.length ? `${fmtNumber(runtime.targets.length)}개 컨택후보` : "후보 검증",
    group.strategy || "권역 전략"
  ];
  return { score: decisionScore, label, headline: `${dominant} + ${second}`, summary, chips };
}

function renderLocationGroupDecision(group, cards, clusters, runtime, score) {
  const decision = locationGroupDecision(group, cards, runtime, score, clusters);
  return `
    <section class="location-decision region-decision">
      <div class="location-decision-score">
        <span>권역점수</span>
        <strong>${fmtNumber(decision.score)}</strong>
      </div>
      <div class="location-decision-copy">
        <p class="eyebrow">권역판정 · ${escapeHtml(decision.label)}</p>
        <h4>${escapeHtml(decision.headline)}</h4>
        <p>${escapeHtml(decision.summary)}</p>
        <div class="location-action-chips">
          ${decision.chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}
        </div>
      </div>
    </section>
  `;
}

function locationGroupCardRows(cards = []) {
  return cards.map((card) => {
    const alias = dictionaryAliasForCard(card);
    const runtime = locationRuntimeStats(card, alias);
    const score = weightedLocationScore(card);
    const clusters = locationClusterCodes(card).map(locationClusterMeta);
    const targetScore = Math.min(22, (runtime.targets?.length || 0) * 4);
    const gapScore = runtime.items?.length ? Math.min(14, (runtime.platformGap / Math.max(1, runtime.items.length * 3)) * 18) : 0;
    const saleScore = Number.isFinite(runtime.rate) ? (runtime.rate < 0.35 ? 12 : runtime.rate < 0.55 ? 7 : 2) : 4;
    const priority = Math.round((Number.isFinite(score) ? score : 50) * 0.62 + targetScore + gapScore + saleScore);
    return {
      card,
      alias,
      runtime,
      score,
      priority,
      clusters,
      primaryCluster: clusters[0]?.name || "클러스터 확인"
    };
  }).sort((a, b) => b.priority - a.priority || b.score - a.score);
}

function renderLocationGroupComparison(rows = []) {
  return `
    <section class="location-block">
      <div class="location-block-head">
        <h4>하위 지역 비교</h4>
        <span>사전점수 + 실제수집 연결</span>
      </div>
      <div class="region-compare-list">
        ${rows.slice(0, 6).map((row) => {
          const rate = Number.isFinite(row.runtime.rate) ? fmtRate(row.runtime.rate) : "확인필요";
          return `
            <button class="region-compare-row" type="button" data-location-query="${escapeHtml(row.card.searchKeyword)}">
              <b>${escapeHtml(row.card.searchKeyword)}</b>
              <span>${escapeHtml(row.primaryCluster)}</span>
              <strong>${Number.isFinite(row.score) ? `${fmtNumber(row.score)}점` : "확인"}</strong>
              <small>업체 ${fmtNumber(row.runtime.items?.length || 0)} · 판매 ${rate} · 후보 ${fmtNumber(row.runtime.targets?.length || 0)}</small>
            </button>
          `;
        }).join("") || `<div class="location-empty-note">비교할 하위 지역 카드가 없습니다.</div>`}
      </div>
    </section>
  `;
}

function renderLocationGroupPriority(rows = []) {
  const priorities = rows.slice(0, 4);
  return `
    <section class="location-block">
      <div class="location-block-head">
        <h4>우선 공략 지역</h4>
        <span>영업 착수 순서</span>
      </div>
      <div class="region-priority-grid">
        ${priorities.map((row, index) => {
          const reason = [
            row.runtime.targets?.length ? `컨택후보 ${fmtNumber(row.runtime.targets.length)}` : "",
            row.runtime.platformGap ? "채널공백" : "",
            Number.isFinite(row.runtime.rate) && row.runtime.rate < 0.35 ? "저판매" : "",
            row.primaryCluster
          ].filter(Boolean).slice(0, 3).join(" · ");
          return `
            <button class="region-priority-card" type="button" data-location-query="${escapeHtml(row.card.searchKeyword)}">
              <em>${index + 1}</em>
              <strong>${escapeHtml(row.card.searchKeyword)}</strong>
              <span>${escapeHtml(reason || "지역 카드 세부 확인")}</span>
            </button>
          `;
        }).join("") || `<div class="location-empty-note">우선 공략 지역을 산출할 카드가 없습니다.</div>`}
      </div>
    </section>
  `;
}

function renderLocationGroupActionPlan(group = {}, runtime = {}) {
  const actions = ["하위 지역별 재수집", "상위노출 업체 분류"];
  if ((runtime.platformGap || 0) > 0) actions.push("권역 채널공백 확인");
  if ((runtime.targets?.length || 0) > 0) actions.push("컨택 후보 선별");
  actions.push("광역 키워드 검색량 비교", "지역카드 추가 후보 선정");
  return `
    <section class="location-block">
      <div class="location-block-head">
        <h4>권역 실행</h4>
        <span>${escapeHtml(group.sido || "광역")} 기준</span>
      </div>
      <div class="location-action-panel">
        ${[...new Set(actions)].slice(0, 6).map((action, index) => `
          <span><b>${index + 1}</b>${escapeHtml(action)}</span>
        `).join("")}
      </div>
    </section>
  `;
}

function renderLocationGroupDictionary(group) {
  const cards = locationGroupCards(group);
  const score = regionGroupScore(group, cards);
  const indexes = averageLocationIndexes(cards);
  const topIndexes = indexes
    .slice()
    .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
    .slice(0, 3);
  const clusterCounts = new Map();
  cards.forEach((card) => {
    locationClusterCodes(card).forEach((code) => {
      clusterCounts.set(code, (clusterCounts.get(code) || 0) + 1);
    });
  });
  const clusters = [...clusterCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([code, count]) => ({ ...locationClusterMeta(code), count }));
  const rankedCards = cards
    .slice()
    .sort((a, b) => {
      const aScore = weightedLocationScore(a);
      const bScore = weightedLocationScore(b);
      return (Number.isFinite(bScore) ? bScore : 0) - (Number.isFinite(aScore) ? aScore : 0);
    });
  const runtime = locationGroupRuntimeStats(group, cards);
  const regionRows = locationGroupCardRows(cards);

  if (els.dictionarySearchStatus) {
    els.dictionarySearchStatus.textContent = `${group.searchKeyword} 권역 스캔 · ${fmtNumber(cards.length)}개 지역 카드 연결`;
  }

  els.dictionaryResult.innerHTML = `
    <article class="location-card region-group-card">
      <div class="location-hero region-group-hero">
        <div>
          <p class="eyebrow">권역-지역 계층 분석</p>
          <h3>${escapeHtml(group.searchKeyword)}</h3>
          <p>${escapeHtml(group.interpretation || "광역 검색으로 시장 크기를 보고, 하위 지역 카드로 영업 우선순위를 판단합니다.")}</p>
        </div>
        <div class="location-score">
          <strong>${Number.isFinite(score) ? fmtNumber(score) : "확인"}</strong>
          <span>권역 총점</span>
        </div>
      </div>

      <div class="location-meta-row">
        <span>권역 스캔 30%</span>
        <span>지역 카드 70%</span>
        <span>연결 ${fmtNumber(cards.length)}지역</span>
        <span>시장신호 ${fmtNumber(group.marketSignal || 0)}</span>
      </div>

      <div class="location-cluster-row">
        ${clusters.length ? clusters.map((cluster) => `
          <span class="location-cluster-chip">
            <b>${escapeHtml(cluster.code)}</b>
            ${escapeHtml(cluster.name)} ${fmtNumber(cluster.count)}
          </span>
        `).join("") : `<span class="location-cluster-chip"><b>대기</b>지역 카드 추가 필요</span>`}
      </div>

      ${renderLocationGroupDecision(group, cards, clusters, runtime, score)}
      ${renderLocationReality(runtime)}
      ${renderLocationGroupComparison(regionRows)}
      ${renderLocationGroupPriority(regionRows)}

      <section class="location-block">
        <div class="location-block-head">
          <h4>권역 해석</h4>
          <span>${escapeHtml(group.sido || "광역")} · ${escapeHtml(group.strategy || "권역 먼저, 지역 카드로 검증")}</span>
        </div>
        <div class="region-group-summary">
          <div>
            <strong>권역 역할</strong>
            <p>${escapeHtml(group.role || "광역 검색량과 노출 분포로 시장 크기를 파악합니다.")}</p>
          </div>
          <div>
            <strong>판단 방식</strong>
            <p>권역 시장신호 30%와 연결 지역 카드 평균 70%를 합산해 우선순위를 봅니다.</p>
          </div>
          <div>
            <strong>영업 관점</strong>
            <p>${escapeHtml(group.salesFocus || "상위 노출은 있으나 상품/채널 구성이 약한 업체를 우선 확인합니다.")}</p>
          </div>
        </div>
      </section>

      ${indexes.length ? `
        <section class="location-block">
          <div class="location-block-head">
            <h4>연결 지역 평균 8대 지수</h4>
            <span>높은 축: ${topIndexes.map((index) => escapeHtml(index.shortLabel)).join(" · ")}</span>
          </div>
          <div class="location-index-grid">
            ${indexes.map((index) => {
              const [tone, label] = locationScoreBand(index.value, index);
              return `
                <div class="location-index ${tone}">
                  <div>
                    <strong>${escapeHtml(index.shortLabel || index.label)}</strong>
                    <em>${fmtNumber(index.value)}</em>
                  </div>
                  <span>${escapeHtml(label)}</span>
                  <div class="location-progress"><i style="width:${Math.max(0, Math.min(100, Number(index.value) || 0))}%"></i></div>
                </div>
              `;
            }).join("")}
          </div>
        </section>
      ` : ""}

      <section class="location-block">
        <div class="location-block-head">
          <h4>연결 지역 카드</h4>
          <span>클릭하면 지역 카드로 이동</span>
        </div>
        <div class="region-card-grid">
          ${rankedCards.length ? rankedCards.map((card) => {
            const cardScore = weightedLocationScore(card);
            const clustersForCard = locationClusterCodes(card).map(locationClusterMeta).map((cluster) => cluster.name).join(" + ");
            return `
              <button class="region-mini-card" type="button" data-location-query="${escapeHtml(card.searchKeyword)}">
                <strong>${escapeHtml(card.searchKeyword)}</strong>
                <span>${Number.isFinite(cardScore) ? `${fmtNumber(cardScore)}점` : "확인"} · ${escapeHtml(clustersForCard || "클러스터 확인")}</span>
                <small>${escapeHtml(card.recommendedProduct || card.interpretation || "")}</small>
              </button>
            `;
          }).join("") : `<div class="empty">아직 연결된 지역 카드가 없습니다. 아래 추가 후보 중 먼저 고를 지역을 선택하세요.</div>`}
        </div>
      </section>

      ${renderLocationGroupActionPlan(group, runtime)}

      <section class="location-block">
        <div class="location-block-head">
          <h4>다음 추가 후보</h4>
          <span>2차 사전 후보</span>
        </div>
        <div class="location-meta-row">
          ${(group.plannedKeywords || []).map((keyword) => `<span>${escapeHtml(keyword)}</span>`).join("") || "<span>추가 후보 없음</span>"}
        </div>
      </section>
    </article>
  `;
}

function renderLocationDictionary(match = null) {
  if (!els.dictionaryResult) return;
  const cards = state.dictionary?.cards || [];
  const groups = state.dictionary?.regionGroups || [];
  if (els.dictionaryCount) els.dictionaryCount.textContent = `${fmtNumber(groups.length)} 권역 · ${fmtNumber(cards.length)} 지역`;
  if (!state.dictionary) {
    els.dictionaryResult.innerHTML = `<div class="empty">입지판단 사전을 불러오는 중입니다.</div>`;
    return;
  }

  const query = els.dictionarySearchInput?.value?.trim() || "";
  const requestQueueHtml = renderLocationCardRequestQueue();
  const result = match || locationCardForQuery(query || cards[0]?.searchKeyword || "");
  if (result.group) {
    renderLocationGroupDictionary(result.group);
    return;
  }
  const card = result.card || state.selectedLocationCard;
  if (!card) {
    if (els.dictionarySearchStatus) {
      els.dictionarySearchStatus.textContent = query
        ? `"${query}"에 맞는 저장 지역 카드가 없습니다. 신규 지역 후보로 확인합니다.`
        : "지역명과 업종을 입력하면 저장된 지역 카드를 호출합니다.";
    }
    els.dictionaryResult.innerHTML = `${requestQueueHtml}${renderMissingLocationCandidate(query, cards)}`;
    return;
  }

  state.selectedLocationCard = card;
  const alias = result.alias || dictionaryAliasForCard(card);
  const clusters = locationClusterCodes(card).map(locationClusterMeta);
  const indexes = Object.values(card.indexes || {});
  const score = weightedLocationScore(card);
  const runtime = locationRuntimeStats(card, alias);
  const topIndexes = indexes
    .slice()
    .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
    .slice(0, 3);

  if (els.dictionarySearchStatus) {
    els.dictionarySearchStatus.textContent = `${card.searchKeyword} 카드 호출 · ${clusters.map((cluster) => cluster.name).join(" + ")}`;
  }

  els.dictionaryResult.innerHTML = `
    ${requestQueueHtml}
    <article class="location-card">
      <div class="location-hero">
        <div>
          <p class="eyebrow">저장형 입지판단 카드</p>
          <h3>${escapeHtml(card.searchKeyword)}</h3>
          <p>${escapeHtml(card.interpretation || "지역 해석을 확인하세요.")}</p>
        </div>
        <div class="location-score">
          <strong>${Number.isFinite(score) ? fmtNumber(score) : "확인"}</strong>
          <span>보정 총점</span>
        </div>
      </div>

      <div class="location-meta-row">
        <span>${escapeHtml(alias?.sido || "광역")}</span>
        <span>${escapeHtml(alias?.sigungu || "시군구")}</span>
        <span>1차권역 ${fmtNumber(alias?.primaryRadiusKm || 0)}km</span>
        <span>2차권역 ${fmtNumber(alias?.secondaryRadiusKm || 0)}km</span>
      </div>

      <div class="location-cluster-row">
        ${clusters.map((cluster) => `
          <span class="location-cluster-chip">
            <b>${escapeHtml(cluster.code)}</b>
            ${escapeHtml(cluster.name)}
          </span>
        `).join("")}
      </div>

      ${renderLocationDecisionPanel(card, clusters, runtime)}
      ${renderLocationEvidence(card)}
      ${renderLocationReality(runtime)}
      ${renderLocationTargetPreview(runtime)}

      <section class="location-block">
        <div class="location-block-head">
          <h4>8대 지수</h4>
          <span>높은 축: ${topIndexes.map((index) => escapeHtml(index.shortLabel)).join(" · ")}</span>
        </div>
        <div class="location-index-grid">
          ${indexes.map((index) => {
            const [tone, label] = locationScoreBand(index.value, index);
            return `
              <div class="location-index ${tone}">
                <div>
                  <strong>${escapeHtml(index.shortLabel || index.label)}</strong>
                  <em>${fmtNumber(index.value)}</em>
                </div>
                <span>${escapeHtml(label)}</span>
                <div class="location-progress"><i style="width:${Math.max(0, Math.min(100, Number(index.value) || 0))}%"></i></div>
              </div>
            `;
          }).join("")}
        </div>
      </section>

      <section class="location-block">
        <div class="location-block-head">
          <h4>상품/가격/채널/운영 제안</h4>
          <span>클러스터 규칙 기반</span>
        </div>
        <div class="location-advice-grid">
          ${clusters.map((cluster) => `
            <div class="location-advice-card">
              <strong>${escapeHtml(cluster.name)}</strong>
              <p>${escapeHtml(cluster.sentence || cluster.condition || "")}</p>
              <dl>
                <div><dt>상품</dt><dd>${escapeHtml(cluster.product || "확인")}</dd></div>
                <div><dt>가격</dt><dd>${escapeHtml(cluster.price || "확인")}</dd></div>
                <div><dt>채널</dt><dd>${escapeHtml(cluster.channel || "확인")}</dd></div>
                <div><dt>운영</dt><dd>${escapeHtml(cluster.operation || "확인")}</dd></div>
              </dl>
            </div>
          `).join("")}
        </div>
      </section>

      ${renderLocationActionPlan(card, runtime)}

      <section class="location-block">
        <div class="location-summary-grid">
          <div>
            <strong>우선 상품</strong>
            <p>${escapeHtml(card.recommendedProduct || "상품 제안 확인")}</p>
          </div>
          <div>
            <strong>주의점</strong>
            <p>${escapeHtml(card.caution || alias?.fallbackAction || "추가 확인 필요")}</p>
          </div>
          <div>
            <strong>미등록 지역 처리</strong>
            <p>${escapeHtml(alias?.fallbackAction || "인접 생활권과 관광 앵커를 수동 확인")}</p>
          </div>
        </div>
      </section>
    </article>
  `;
}

function syncDictionaryInputToActiveRun(force = false) {
  if (!els.dictionarySearchInput || !state.data?.run) return "";
  const keyword = activeKeyword();
  const runId = state.activeRunId || state.data.run.id || "";
  if (!keyword) return "";
  if (force || state.dictionarySyncedRunId !== runId) {
    els.dictionarySearchInput.value = keyword;
    state.dictionarySyncedRunId = runId;
    state.selectedLocationCard = null;
  }
  return keyword;
}

function runDictionarySearch(query) {
  if (query && els.dictionarySearchInput) els.dictionarySearchInput.value = query;
  const result = locationCardForQuery(els.dictionarySearchInput?.value || "");
  state.selectedLocationCard = result.card;
  renderLocationDictionary(result);
}

async function loadLocationDictionary() {
  try {
    state.dictionary = await fetchJson(LOCATION_DICTIONARY_URL);
    renderDictionaryQuickButtons();
    if (!els.dictionarySearchInput?.value && state.dictionary.cards?.[0]) {
      els.dictionarySearchInput.value = state.dictionary.cards[0].searchKeyword;
    }
    runDictionarySearch(els.dictionarySearchInput?.value || state.dictionary.cards?.[0]?.searchKeyword || "");
    if (!isAdminRole()) renderB2BSearchPanel();
  } catch (error) {
    if (els.dictionarySearchStatus) els.dictionarySearchStatus.textContent = `입지사전 로딩 실패: ${error.message}`;
    if (els.dictionaryResult) els.dictionaryResult.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadLocationCardRequests() {
  try {
    state.locationCardRequests = await fetchJson("/api/location-card-requests");
    if (state.activeTab === "dictionary" && state.dictionary) renderLocationDictionary();
  } catch (error) {
    state.locationCardRequests = { error: error.message, requests: {}, items: [] };
  }
}

function b2bSearchText(value = "") {
  return compactCrawlKeyword(value).toLowerCase();
}

function b2bSearchTokens(value = "") {
  return String(value || "").normalize("NFKC").toLowerCase().match(/[가-힣a-z0-9]+/g) || [];
}

function b2bMeaningfulSearchTokens(value = "") {
  const generic = new Set(["글램핑", "캠핑", "펜션", "숙소", "리조트", "카라반", "오토캠핑"]);
  return b2bSearchTokens(value)
    .map(b2bSearchText)
    .filter((token) => token && token.length > 1 && !generic.has(token));
}

function runSearchTitle(run = {}) {
  return String(run.keyword || run.searchKeyword || run.label || run.id || "").split("·")[0].trim() || run.id || "리포트";
}

function runSearchHaystack(run = {}) {
  return [
    run.keyword,
    run.searchKeyword,
    run.naverKeyword,
    run.label,
    run.id,
    run.provinceLabel,
    run.collectionModeLabel,
    run.searchModeLabel,
    run.region,
    run.regionBase
  ].map((value) => String(value || "")).join(" ");
}

function runCount(run = {}, keys = []) {
  const counts = run.counts || {};
  for (const key of keys) {
    const value = Number(counts[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function runSearchDateLabel(run = {}) {
  const range = dateRangeLabel(run);
  if (range && range !== "기준일 확인" && range !== "기간 확인") return range;
  if (run.updatedAt) return String(run.updatedAt).slice(0, 10);
  return "기준일 확인";
}

function runSearchModeLabel(run = {}) {
  const parts = [
    run.collectionModeLabel || (run.collectionMode === "fast" ? "빠른 분석" : "정밀 분석"),
    run.detailRankRanges ? `${run.detailRankRanges}위` : "",
    Number(run.bookingRangeDays) > 1 ? `${fmtNumber(run.bookingRangeDays)}일` : ""
  ].filter(Boolean);
  return parts.join(" · ") || "분석 리포트";
}

function runSearchMetrics(run = {}) {
  const exposure = runCount(run, ["naverOverall", "naverRegional"]);
  const ads = runCount(run, ["naverAds"]);
  const salesSample = runCount(run, ["naverBookingStockSucceeded", "naverBookingStockChecked"]);
  return [
    { label: "노출 표본", value: fmtNumber(exposure) },
    { label: "매출 표본", value: salesSample ? `${fmtNumber(salesSample)}곳` : "대기" },
    { label: "광고 표본", value: fmtNumber(ads) }
  ];
}

function b2bSearchMatchLabel(row = {}, normalized = "") {
  if (row.active) return "현재 결과";
  if (!normalized) return "검색 결과";
  if (row.score >= 100) return "정확";
  if (row.score >= 78) return "관련";
  return "후보";
}

function b2bQuickSearchOptions() {
  const activeRun = state.runs.find((run) => run.id === state.activeRunId);
  const seen = new Set();
  return [activeRun, ...state.runs].filter(Boolean).map((run) => {
    const title = runSearchTitle(run);
    const key = b2bSearchText(title);
    if (!key || seen.has(key)) return null;
    seen.add(key);
    return { query: title, label: title.replace(/글램핑$/u, "") || title };
  }).filter(Boolean).slice(0, 6);
}

function b2bSearchMatches(query = state.b2bSearchQuery) {
  const normalized = b2bSearchText(query);
  const queryTokens = b2bMeaningfulSearchTokens(query);
  const activeRun = state.runs.find((run) => run.id === state.activeRunId);
  const rows = state.runs.map((run, index) => {
    const title = runSearchTitle(run);
    const compactTitle = b2bSearchText(title);
    const haystack = b2bSearchText(runSearchHaystack(run));
    const haystackTokens = b2bSearchTokens(runSearchHaystack(run)).map(b2bSearchText);
    let score = 0;
    if (!normalized) {
      score = run.id === state.activeRunId ? 80 : Math.max(1, 30 - index);
    } else if (compactTitle === normalized || b2bSearchText(run.keyword) === normalized) {
      score = 120;
    } else if (compactTitle.startsWith(normalized)) {
      score = 94;
    } else if (compactTitle.includes(normalized)) {
      score = 78;
    } else if (haystack.includes(normalized)) {
      score = 70;
    } else {
      const hitCount = queryTokens.filter((token) => {
        const compactToken = b2bSearchText(token);
        return compactToken && (haystack.includes(compactToken) || haystackTokens.includes(compactToken));
      }).length;
      score = hitCount ? Math.min(55, 24 + hitCount * 12) : 0;
    }
    return { run, index, title, score, active: run.id === state.activeRunId };
  }).filter((row) => row.score > 0);
  rows.sort((a, b) => b.score - a.score || a.index - b.index);
  if (!rows.length && activeRun && !normalized) {
    return [{ run: activeRun, index: state.runs.indexOf(activeRun), title: runSearchTitle(activeRun), score: 80, active: true }];
  }
  return rows.slice(0, 8);
}

function b2bDictionaryNoMatch(query = "") {
  const trimmed = String(query || "").trim();
  if (!state.dictionary || !trimmed) {
    return {
      type: "unknown",
      title: "검색어를 입력하세요",
      note: "지역명과 글램핑을 함께 입력하면 새 경쟁 리포트를 수집합니다.",
      tokens: [],
      chips: []
    };
  }
  const match = locationCardForQuery(trimmed);
  if (match?.group) {
    const cards = locationGroupCards(match.group);
    return {
      type: "group",
      title: `${match.group.searchKeyword || match.group.sido || "상위 권역"} 권역 검색 가능`,
      note: `${fmtNumber(cards.length)}개 지역 카드가 연결된 권역입니다. 새 검색을 실행하면 현재 경쟁 리포트를 생성합니다.`,
      tokens: [match.group.searchKeyword, match.group.sido, ...(match.group.aliases || [])],
      chips: cards.slice(0, 4).map((card) => card.searchKeyword).filter(Boolean)
    };
  }
  if (match?.card) {
    const alias = match.alias || dictionaryAliasForCard(match.card);
    const clusters = locationClusterCodes(match.card).map(locationClusterMeta).map((cluster) => cluster.name).filter(Boolean);
    return {
      type: "card",
      title: `${match.card.searchKeyword || trimmed} 지역카드 있음`,
      note: `입지사전 기준 지역입니다.${clusters.length ? ` ${clusters.slice(0, 2).join(" · ")} 기준으로 새 검색을 실행할 수 있습니다.` : ""}`,
      tokens: [match.card.searchKeyword, alias?.sido, alias?.sigungu, ...(alias?.aliases || [])],
      chips: clusters.slice(0, 4)
    };
  }
  const candidate = locationCandidateFromQuery(trimmed);
  if (candidate) {
    return {
      type: "candidate",
      title: `${candidate.regionBase || trimmed} 신규 수집 필요`,
      note: "신규 지역으로 판단됩니다. 새 검색을 실행해 현재 노출과 예약 표본을 확인합니다.",
      tokens: [candidate.keyword, candidate.regionBase],
      chips: ["신규 지역", "수집 필요"]
    };
  }
  return {
    type: "unknown",
    title: "검색어 확인 필요",
    note: "지역명과 업종을 함께 입력하면 현재 경쟁 리포트를 새로 수집합니다.",
    tokens: b2bMeaningfulSearchTokens(trimmed),
    chips: ["지역명 + 글램핑"]
  };
}

function b2bFallbackRunOptions(query = "", dictionaryInfo = b2bDictionaryNoMatch(query)) {
  if (!isAdminRole()) return [];
  const tokens = [
    ...b2bMeaningfulSearchTokens(query),
    ...(dictionaryInfo.tokens || []).map(b2bSearchText)
  ].filter(Boolean);
  const scored = state.runs.map((run, index) => {
    const haystack = b2bSearchText(runSearchHaystack(run));
    const province = b2bSearchText(run.provinceLabel || "");
    let score = 0;
    tokens.forEach((token) => {
      if (!token) return;
      if (haystack.includes(token)) score += 50;
      if (province && (province.includes(token) || token.includes(province))) score += 30;
    });
    return { run, index, score };
  }).filter((row) => row.score > 0);
  const sorted = scored.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, 3);
  if (sorted.length) return sorted.map((row) => ({ ...row, reason: "관련 리포트" }));
  return state.runs.slice(0, 3).map((run, index) => ({ run, index, score: 0, reason: "최근 리포트" }));
}

function b2bSearchNoMatchPanel(query = state.b2bSearchQuery) {
  const info = b2bDictionaryNoMatch(query);
  const fallbacks = b2bFallbackRunOptions(query, info);
  return `
    <div class="b2b-search-empty b2b-search-missing ${escapeHtml(info.type)}">
      <div class="b2b-search-missing-copy">
        <span>${escapeHtml(info.type === "candidate" ? "수집 필요" : info.type === "card" || info.type === "group" ? "지역카드 확인" : "검색 결과 없음")}</span>
        <strong>${escapeHtml(info.title)}</strong>
        <p>${escapeHtml(info.note)}</p>
        ${(info.chips || []).length ? `
          <div class="b2b-search-missing-chips">
            ${(info.chips || []).map((chip) => `<em>${escapeHtml(chip)}</em>`).join("")}
          </div>
        ` : ""}
      </div>
      ${fallbacks.length ? `
        <div class="b2b-search-fallbacks">
          <small>대체 확인 리포트</small>
          ${fallbacks.map((row) => `
            <button type="button" data-b2b-run-id="${escapeHtml(row.run.id)}">
              <b>${escapeHtml(runSearchTitle(row.run))}</b>
              <span>${escapeHtml(row.reason)} · ${escapeHtml(runSearchDateLabel(row.run))}</span>
            </button>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function b2bSearchResultCard(row = {}, normalized = "") {
  const run = row.run || {};
  const metrics = runSearchMetrics(run);
  const activeClass = row.active ? " active" : "";
  const currentAttr = row.active ? ' aria-current="page"' : "";
  return `
    <button type="button" class="b2b-search-card${activeClass}" data-b2b-run-id="${escapeHtml(run.id)}"${currentAttr}>
      <span class="b2b-search-match">${escapeHtml(b2bSearchMatchLabel(row, normalized))}</span>
      <strong>${escapeHtml(row.title)}</strong>
      <span class="b2b-search-card-sub">${escapeHtml(run.provinceLabel || run.label || run.id)} · ${escapeHtml(runSearchDateLabel(run))}</span>
      <span class="b2b-search-card-mode">${escapeHtml(runSearchModeLabel(run))}</span>
      <span class="b2b-search-card-metrics">
        ${metrics.map((metric) => `
          <em>
            <b>${escapeHtml(metric.value)}</b>
            <small>${escapeHtml(metric.label)}</small>
          </em>
        `).join("")}
      </span>
    </button>
  `;
}

function renderB2BSearchHistoryPanel() {
  if (!els.b2bSearchHistory || isAdminRole()) return;
  const rows = state.memberSearchHistory || [];
  const expanded = Boolean(state.b2bHistoryExpanded);
  const latest = rows[0] || null;
  const profile = state.session?.profile || {};
  const ownership = profile.ownershipStatusLabel || "";
  const memberLabel = state.session?.accountType === "demo"
    ? "공용 B2B 계정"
    : [state.session?.username || "", ownership].filter(Boolean).join(" · ");
  const latestLabel = latest
    ? [
      latest.keyword || latest.runLabel || "검색 리포트",
      latest.completedAt ? compactDateTime(latest.completedAt) : ""
    ].filter(Boolean).join(" · ")
    : (memberLabel || "로그인 아이디 기준");
  els.b2bSearchHistory.innerHTML = `
    <div class="b2b-history-head">
      <div>
        <strong>내 검색 기록</strong>
        <small>${escapeHtml(latestLabel)}</small>
      </div>
      <div class="b2b-history-actions">
        <span>${fmtNumber(rows.length)}건</span>
        ${rows.length ? `<button type="button" data-b2b-history-toggle aria-expanded="${expanded ? "true" : "false"}">${expanded ? "접기" : "더보기"}</button>` : ""}
      </div>
    </div>
    ${rows.length && expanded ? `
      <div class="b2b-history-list">
        ${rows.slice(0, 8).map((row) => `
          <button type="button" data-b2b-history-run-id="${escapeHtml(row.runId)}">
            <strong>${escapeHtml(row.keyword || row.runLabel || "검색 리포트")}</strong>
            <span>${escapeHtml([row.regionLabel, row.checkIn && row.checkOut ? `${row.checkIn.slice(5)}~${row.checkOut.slice(5)}` : "", row.detailRankRanges ? `${row.detailRankRanges}위` : ""].filter(Boolean).join(" · "))}</span>
            <small>${escapeHtml(row.completedAt ? compactDateTime(row.completedAt) : "")}</small>
          </button>
        `).join("")}
      </div>
    ` : `<p>아직 이 아이디로 저장된 검색 기록이 없습니다.</p>`}
  `;
}

function renderB2BSearchPanel() {
  if (!els.b2bSearchPanel) return;
  const publicMode = !isAdminRole();
  els.b2bSearchPanel.hidden = !publicMode;
  if (!publicMode) return;
  if (els.b2bSearchInput && document.activeElement !== els.b2bSearchInput) {
    els.b2bSearchInput.value = state.b2bSearchQuery || "";
  }
  if (els.b2bSearchRangeInput && document.activeElement !== els.b2bSearchRangeInput) {
    els.b2bSearchRangeInput.value = state.b2bSearchRange || "1-10";
  }
  if (els.b2bSearchResults) {
    const hasResult = Boolean(state.data?.run);
    const keyword = hasResult ? activeKeyword() : (state.b2bSearchQuery || "").trim();
    const shouldShowEstimate = Boolean(state.b2bSearchLoading || hasResult || keyword);
    const previewPayload = shouldShowEstimate ? b2bLiveSearchPayload(keyword) : null;
    const progressMeta = state.b2bSearchLoading ? b2bSearchProgressMeta() : null;
    const preview = progressMeta || (previewPayload ? crawlPreviewMeta(previewPayload) : null);
    const panelClass = state.b2bSearchLoading ? "loading" : hasResult ? "ready" : "idle";
    const badge = state.b2bSearchLoading ? "검색중" : hasResult ? "결과 표시" : "새 검색";
    const title = state.b2bSearchLoading
      ? `${keyword || "입력 지역"} 검색 중`
      : hasResult
        ? `${keyword} 검색 결과`
        : "지역명을 입력해 경쟁 리포트를 생성하세요";
    const copy = state.b2bSearchLoading
      ? "네이버 노출, 예약 수량, 요일별 가격 표본을 새로 확인하고 있습니다."
      : hasResult
        ? "방금 실행한 검색 결과를 표시합니다. 다른 지역은 검색어 입력 후 새로 실행하세요."
        : "검색 시 현재 조건으로 네이버 노출, 예약 수량, 가격 표본을 새로 수집합니다.";
    els.b2bSearchResults.innerHTML = `
      <div class="b2b-live-search-panel ${escapeHtml(panelClass)}">
        <div>
          <span>${escapeHtml(badge)}</span>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(copy)}</p>
          ${state.b2bSearchLoading ? b2bSearchProgressHtml(progressMeta) : ""}
        </div>
        <div class="b2b-live-search-meta">
          <em>${escapeHtml((state.b2bSearchRange || "1-10") === "1-20" ? "확장 분석" : "기본 분석")}</em>
          <em>${escapeHtml(state.b2bSearchRange || "1-10")}위</em>
          ${preview ? `<em>예상 ${escapeHtml(formatElapsed(preview.estimatedTotalSeconds))}</em>` : ""}
          ${state.b2bSearchLoading && preview ? `<em>완료 ${escapeHtml(formatClockTime(preview.estimatedCompleteAt))}</em>` : ""}
        </div>
      </div>
    `;
  }
  if (els.b2bSearchStatus) {
    const current = state.data?.run ? `현재 표시: ${activeKeyword()} · ${dateRangeLabel(state.data.run)}` : "검색어를 입력하면 새 경쟁 리포트를 수집합니다.";
    const progressMeta = state.b2bSearchLoading ? b2bSearchProgressMeta() : null;
    els.b2bSearchStatus.textContent = state.b2bSearchLoading
      ? `${state.b2bSearchQuery || "검색"} 실행 중 · 경과 ${formatElapsed(progressMeta.elapsedSeconds) || "0초"} · ${b2bSearchProgressText(progressMeta)} · 완료 ${formatClockTime(progressMeta.estimatedCompleteAt)}`
      : current;
  }
  renderB2BSearchHistoryPanel();
}

function b2bLiveSearchPayload(keyword = state.b2bSearchQuery) {
  const range = els.b2bSearchRangeInput?.value || state.b2bSearchRange || "1-10";
  return {
    keyword: String(keyword || "").trim(),
    checkIn: els.checkInInput?.value || "",
    checkOut: els.checkOutInput?.value || "",
    searchMode: "keyword",
    productMode: "all",
    collectionMode: "precision",
    detailRankRanges: range === "1-20" ? "1-20" : "1-10"
  };
}

async function submitB2BSearch() {
  if (isAdminRole()) return;
  state.b2bSearchQuery = els.b2bSearchInput?.value?.trim() || "";
  if (!state.b2bSearchQuery) {
    renderB2BSearchPanel();
    if (els.b2bSearchStatus) els.b2bSearchStatus.textContent = "검색할 지역명 또는 키워드를 입력하세요.";
    return;
  }
  if (state.b2bSearchLoading) return;
  state.b2bSearchRange = els.b2bSearchRangeInput?.value || state.b2bSearchRange || "1-10";
  const payload = b2bLiveSearchPayload(state.b2bSearchQuery);
  const submitButton = els.b2bSearchForm?.querySelector('button[type="submit"]');
  const preview = crawlPreviewMeta(payload);
  state.b2bSearchLoading = true;
  state.b2bSearchStartedAt = Date.now();
  state.b2bSearchPreview = preview;
  if (submitButton) submitButton.disabled = true;
  startB2BSearchTimer();
  renderB2BSearchPanel();
  setStatus("B2B 검색 중");
  if (els.b2bSearchStatus) {
    els.b2bSearchStatus.textContent = `${state.b2bSearchQuery} 검색을 시작했습니다. 예상 ${formatElapsed(preview.estimatedTotalSeconds)} · 완료 ${formatClockTime(preview.estimatedCompleteAt)}.`;
  }
  let finalErrorMessage = "";
  try {
    const result = await fetchJson("/api/b2b-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.data = result.data || null;
    state.activeRunId = result.runId || state.data?.run?.id || null;
    state.runs = state.data?.run ? [{ ...state.data.run, id: state.activeRunId }] : [];
    await loadMemberSearchHistory();
    state.activeTab = "report";
    setStatus("검색 완료");
    renderAll();
  } catch (error) {
    setStatus("검색 실패");
    finalErrorMessage = `검색 실패: ${error.message}`;
  } finally {
    state.b2bSearchLoading = false;
    state.b2bSearchStartedAt = 0;
    state.b2bSearchPreview = null;
    clearB2BSearchTimer();
    if (submitButton) submitButton.disabled = false;
    renderB2BSearchPanel();
    if (finalErrorMessage && els.b2bSearchStatus) els.b2bSearchStatus.textContent = finalErrorMessage;
  }
}

function renderB2BEmptyPanels() {
  if (isAdminRole()) return;
  const emptyMessages = {
    report: "검색어를 입력하면 새 경쟁 리포트를 수집합니다.",
    rank: "검색 후 업체 순위를 표시합니다.",
    map: "검색 후 지역 지도와 경쟁권을 표시합니다.",
    demand: "검색 후 수요 전망을 표시합니다."
  };
  const activeMessage = emptyMessages[state.activeTab] || emptyMessages.report;
  if (els.pageTitle) els.pageTitle.textContent = tabLabel(state.activeTab);
  if (els.pageSubtitle) {
    els.pageSubtitle.hidden = false;
    els.pageSubtitle.textContent = activeMessage;
  }
  document.title = `글램핑데이터랩 V2 · ${tabLabel(state.activeTab)}`;
  if (els.summaryGrid) els.summaryGrid.innerHTML = "";
  if (els.noticeCard) els.noticeCard.innerHTML = "";
  if (els.reportBody) els.reportBody.innerHTML = `<div class="empty">${emptyMessages.report}</div>`;
  if (els.companyList) els.companyList.innerHTML = `<div class="empty">${emptyMessages.rank}</div>`;
  if (els.rankCount) els.rankCount.textContent = "0";
  if (els.mapCount) els.mapCount.textContent = "0";
  if (els.clusterMap) {
    els.clusterMap.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="map-empty-label">${emptyMessages.map}</text>`;
  }
  if (els.mapLegend) els.mapLegend.innerHTML = "";
  if (els.regionList) els.regionList.innerHTML = `<div class="empty">${emptyMessages.map}</div>`;
  if (els.demandState) els.demandState.textContent = "검색 대기";
  if (els.demandDashboard) els.demandDashboard.innerHTML = `<div class="empty">${emptyMessages.demand}</div>`;
}

function renderHeader() {
  const run = state.data?.run || {};
  const title = run.label || `${activeKeyword()} 분석`;
  els.pageTitle.textContent = tabLabel(state.activeTab);
  if (els.pageSubtitle) els.pageSubtitle.hidden = false;
  if (state.activeTab === "dictionary") {
    els.pageSubtitle.textContent = "저장된 지역 카드 · 8대 지수 · 클러스터 판정";
  } else if (state.activeTab === "decisionQueue") {
    els.pageSubtitle.textContent = `${title} · 컨택 전 사람 확인 · OTA/수량/공백/보정 재검토`;
  } else if (state.activeTab === "historyOps") {
    els.pageSubtitle.textContent = `${title} · 반복 수집 이력 · 회차 비교 · 업체별 추이`;
  } else if (state.activeTab === "demand") {
    els.pageSubtitle.textContent = isAdminRole()
      ? `${title} · 숙박업 메인터넌스 · 네이버 트렌드`
      : `${title} · 12개월 검색 추이 · 피크 월 · 월별 예상 검색량`;
  } else if (state.activeTab === "report") {
    els.pageSubtitle.textContent = isAdminRole()
      ? `${title} · 상업용 시장 요약 · ${dateRangeLabel(run)}`
      : `${title} · 경쟁업체 매출·노출·수요 전망 · ${dateRangeLabel(run)}`;
  } else if (state.activeTab === "rank" && !isAdminRole()) {
    els.pageSubtitle.textContent = `${title} · 네이버 노출 순위 · 매출/판매율 표본`;
  } else if (state.activeTab === "map" && !isAdminRole()) {
    els.pageSubtitle.textContent = `${title} · 지역 내·인접 경쟁권 · 반경 노출`;
  } else {
    els.pageSubtitle.textContent = `${title} · ${dateRangeLabel(run)}`;
  }
  document.title = `글램핑데이터랩 V2 · ${title}`;
}

function renderAll() {
  applyRoleUi();
  renderB2BSearchPanel();
  if (!state.data) {
    renderB2BEmptyPanels();
    if (roleAllowsTab("dictionary")) renderLocationDictionary();
    return;
  }
  renderHeader();
  renderSummary();
  renderNotice();
  renderReport();
  renderCompanies();
  if (roleAllowsTab("target")) renderTargets();
  if (roleAllowsTab("decisionQueue")) renderDecisionQueue();
  if (roleAllowsTab("map")) renderMap();
  if (roleAllowsTab("demand")) renderDemand();
  if (roleAllowsTab("historyOps")) renderHistoryOps();
  if (isAdminRole()) {
    renderCompanyMasterPanel();
    renderDownloads();
    syncYeogiManualInterface();
  }
  if (roleAllowsTab("dictionary")) renderLocationDictionary();
}

function setActiveTab(tab) {
  state.activeTab = roleAllowsTab(tab) ? tab : firstRoleTab();
  applyRoleUi();
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === state.activeTab && roleAllowsTab(panel.dataset.panel));
  });
  document.querySelectorAll(".bottom-nav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.activeTab);
  });
  renderHeader();
  closeDrawer();
  if (!state.data) {
    renderB2BEmptyPanels();
    if (state.activeTab === "dictionary") renderLocationDictionary();
    return;
  }
  if (state.activeTab === "report") renderReport();
  if (state.activeTab === "decisionQueue") renderDecisionQueue();
  if (state.activeTab === "map") renderMap();
  if (state.activeTab === "demand") renderDemand();
  if (state.activeTab === "historyOps") renderHistoryOps();
  if (state.activeTab === "admin" && isAdminRole()) {
    renderCompanyMasterPanel();
    renderDownloads();
    syncYeogiManualInterface();
  }
  if (state.activeTab === "dictionary") renderLocationDictionary();
}

function sheetRowsForBooking(item) {
  return bookingGraphRows(item).map((row) => ({
    label: row.label,
    sold: row.sold,
    supply: row.total,
    rate: row.rate,
    unit: "개",
    missing: row.missing,
    openStock: row.rawTotal ?? row.total,
    hidden: row.hidden || 0,
    rawSold: row.rawSold ?? row.sold,
    offlineSold: row.offlineSold || row.hidden || 0,
    statusText: row.missing ? "미수집" : "예약확정",
    note: row.missing
      ? "날짜별 상세 미수집"
      : row.source === "daily"
        ? "네이버예약 날짜별 재고"
        : (item.listType || "네이버예약 기준일 재고")
  }));
}

function sheetRowsForDayUse(item) {
  const rows = weeklyRows(item, "day");
  if (rows.length) {
    const basisTotal = basisTotalForRows(rows, item.dayUseWeeklyOperatingTotal || item.dayUseWeeklyBasisTotal, activeManualCorrection(item));
    return rows.map((row) => ({
      label: row.label,
      sold: Math.min(basisTotal || row.total, finiteNumber(row.sold) + offlineSoldForTotal(basisTotal, row.total)),
      supply: basisTotal || row.total,
      unit: "회",
      missing: false,
      openStock: row.total,
      hidden: offlineSoldForTotal(basisTotal, row.total),
      rawSold: row.sold,
      offlineSold: offlineSoldForTotal(basisTotal, row.total),
      statusText: "예약확정",
      note: "데이유즈/캠프닉 날짜별 재고"
    })).map((row) => ({
      ...row,
      rate: row.supply ? row.sold / row.supply : NaN
    }));
  }
  const day = salesStats(item, "day");
  if (!day.supply) return [];
  return [{
    label: `${monthDay(state.data?.run?.checkIn) || "기준일"} 기준`,
    sold: day.sold,
    supply: day.supply,
    rate: day.rate,
    unit: "회",
    statusText: "마감추정",
    note: "데이유즈/캠프닉 기준일 재고"
  }];
}

function dateRow(row) {
  const rate = Number.isFinite(row.rate) ? row.rate : 0;
  const statusText = row.statusText || "판매/마감 추정";
  const note = row.note ? `${row.note} · ` : "";
  const openStock = finiteNumber(row.openStock, row.supply);
  const hidden = Math.max(0, finiteNumber(row.hidden, 0));
  const rawOverBasis = openStock > finiteNumber(row.supply, 0);
  const stockNote = hidden
    ? `온라인열림 ${fmtNumber(openStock)}${row.unit} · 오프라인예약 ${fmtNumber(hidden)}${row.unit} 포함`
    : rawOverBasis
      ? `네이버 원본 ${fmtNumber(openStock)}${row.unit} · 관리자 보정 기준`
      : `온라인열림 ${fmtNumber(openStock)}${row.unit}`;
  if (row.missing) {
    return `
      <div class="date-row missing">
        <div>
          <strong>${escapeHtml(row.label)} · 미수집</strong>
          <small>${escapeHtml(note)}기준재고 ${fmtNumber(row.supply)}${row.unit}</small>
        </div>
        <div class="progress missing"><span style="width:100%"></span></div>
      </div>
    `;
  }
  return `
    <div class="date-row">
      <div>
        <strong>${escapeHtml(row.label)} · ${escapeHtml(statusText)} ${fmtNumber(row.sold)}${row.unit} / 기준총량 ${fmtNumber(row.supply)}${row.unit}</strong>
        <small>${escapeHtml(note)}${escapeHtml(stockNote)} · 기준총량 대비 ${fmtRate(row.rate)}</small>
      </div>
      <div class="progress"><span style="width:${Math.max(2, Math.min(100, rate * 100))}%"></span></div>
    </div>
  `;
}

function sheetCollectionStatusPanel(item = {}) {
  if (!isAdminRole()) return "";
  const status = collectionStatusProfile(item);
  const confidence = inventoryConfidenceInfo(item);
  const structure = inventoryStructureInfo(item);
  const decision = decisionQueueProfile(item);
  const priceText = status.priceMissing
    ? `가격누락 ${fmtNumber(status.missingPriceQuantity || status.soldQuantity)}개/회`
    : status.pricedQuantity
      ? `가격확인 ${fmtNumber(status.pricedQuantity)}개/회`
      : "판매/가격 대기";
  const coupon = status.coupon || naverCouponInfo(item);
  const couponValue = coupon.visible ? "쿠폰 노출" : (coupon.status || "미노출/미확인");
  const couponNote = coupon.visible
    ? compactListText([coupon.names, coupon.detail, coupon.channel].filter(Boolean), "쿠폰명 확인", 2)
    : coupon.detail;
  const productText = status.productKnown
    ? `${status.productCount ? `${fmtNumber(status.productCount)}개 상품` : "상품구성 확인"}`
    : "상품별 수량 확인필요";
  const rows = [
    ["수집 상태", status.label, `${fmtNumber(status.collectedDays)}/${fmtNumber(status.expectedDays)}일 확보`],
    ["문제 날짜", compactListText(status.missingDates, "없음", 5), status.missingDates.length ? "동일 기간 재수집 대상" : "기간 내 날짜 확보"],
    ["총량 기준", status.basisTotal ? `${fmtNumber(status.basisTotal)}개` : "확인필요", status.basisRule],
    ["운영 기준", status.operatingTotal ? `${fmtNumber(status.operatingTotal)}개` : "확인필요", status.structuralBlockedQuantity ? `상시 차단/운영 축소 ${fmtNumber(status.structuralBlockedQuantity)}개/회 분리` : "전체 후보와 동일"],
    ["수량 신뢰도", `신뢰도 ${confidence.grade} · ${structure.label}`, structure.action || "자동 수량 판단"],
    ["상품별 수량", productText, status.productKnown ? "숙박/데이유즈 분리 기준" : "객실/상품 수량 직접 확인"],
    ["가격 확보", priceText, "할인 옵션 패키지는 산출 제외"],
    ["네이버 쿠폰", couponValue, couponNote],
    ["오프라인 예약", status.offlineEstimated ? `${fmtNumber(status.offlineQuantity)}개 추정` : "특이 없음", "운영 기준 미만 날짜만 오프라인 예약/일시 차단으로 해석"]
  ];
  return `
    <section class="sheet-section sheet-collection-section ${escapeHtml(status.tone)}">
      <div class="sheet-structure-title">
        <h3>정밀분석 수집 상태</h3>
        <span class="structure-badge ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
      </div>
      <div class="sheet-collection-grid">
        ${rows.map(([label, value, note]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(note)}</small>
          </div>
        `).join("")}
      </div>
      <div class="sheet-audit-reasons">
        ${(status.reasons.length ? status.reasons : [`판단 큐 상태: ${decision.inQueue ? decision.label : "바로 판단 가능"}`]).map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
      </div>
    </section>
  `;
}

function sheetMasterCompanyForItem(item = {}) {
  const companies = companyMasterSource().companies || [];
  const companyId = item.companyId || item.companyProfile?.companyId || "";
  if (companyId) {
    const direct = companies.find((company) => company.companyId === companyId);
    if (direct) return direct;
  }
  const itemName = compactSearchText(item.name || "");
  if (!itemName || itemName.length < 3) return null;
  return companies.find((company) => {
    const names = [company.primaryName, ...(company.aliases || [])]
      .map((value) => compactSearchText(value || ""))
      .filter(Boolean);
    return names.some((name) => name === itemName || name.includes(itemName) || itemName.includes(name));
  }) || null;
}

function sheetAuditDetailProfile(item = {}) {
  const itemDecision = decisionQueueProfile(item);
  const company = sheetMasterCompanyForItem(item);
  if (!company?.companyId) {
    const revenueImpact = itemQueueRevenueImpact(item);
    return {
      company: item.companyProfile || {},
      decision: itemDecision,
      itemDecision,
      criteria: itemDecision.criteria || [],
      profile: {},
      workflow: {},
      autoRecommendation: null,
      comparison: null,
      revenueImpact,
      revenueEvidence: queueRevenueEvidenceProfile(revenueImpact),
      sourceLabel: "현재 수집 결과"
    };
  }
  const profile = companyNeedsCorrection(company);
  const decision = companyDecisionQueueProfile(company);
  const type = companyCheckEntryType(company, profile);
  const workflow = companyCheckWorkflow(company, profile, type);
  const comparison = companyRecrawlComparison(company);
  const autoRecommendation = companyRecrawlAutoRecommendation(company, profile, decision, comparison);
  const revenueImpact = companyQueueRevenueImpact(company);
  return {
    company,
    decision,
    itemDecision,
    criteria: (decision.criteria || []).length ? decision.criteria : (itemDecision.criteria || []),
    profile,
    workflow,
    autoRecommendation,
    comparison,
    revenueImpact,
    revenueEvidence: queueRevenueEvidenceProfile(revenueImpact),
    sourceLabel: "누적 업체 DB"
  };
}

function sheetAuditCriteriaForDetail(detail = {}) {
  const decision = detail.decision || {};
  const criteria = (detail.criteria || []).filter(Boolean);
  if (criteria.length) return criteria;
  const reasons = decision.reasons || [];
  if (reasons.length) {
    return reasons.slice(0, 3).map((reason, index) => ({
      key: `reason_${index}`,
      label: index ? "보조 근거" : (decision.label || "확인 필요"),
      reason,
      action: (decision.actions || [])[index] || "관리자 확인 후 컨택/보류 판단"
    }));
  }
  return [{
    key: "clear",
    label: decision.inQueue ? (decision.label || "확인 필요") : "바로 판단 가능",
    reason: decision.summary || (decision.inQueue ? "관리자 판단 근거 확인 필요" : "현재 기준 큐 진입 사유 없음"),
    action: decision.inQueue ? "근거 확인 후 상태 저장" : "영업타깃 분리 기준 통과"
  }];
}

function sheetAuditPanel(item = {}) {
  if (!isAdminRole()) return "";
  const detail = sheetAuditDetailProfile(item);
  const decision = detail.decision || {};
  const itemDecision = detail.itemDecision || decisionQueueProfile(item);
  const audit = itemDecision.audit;
  const review = detail.company?.adminReview || item.companyProfile?.adminReview || {};
  const manualCorrection = detail.company?.manualCorrection || item.companyProfile?.manualCorrection || item.companyManualCorrection || {};
  const hasManualCorrection = manualCorrectionHasValue(manualCorrection);
  const correctionDetail = hasManualCorrection
    ? (detail.company?.correctionStatus?.detail || item.companyProfile?.correctionStatus?.detail || manualCorrection.note || "관리자 보정값 있음")
    : (review.status === "manual_needed" ? "관리자 보정 필요로 저장됨" : "수동 보정값 없음");
  const recommendation = detail.autoRecommendation;
  const criteria = sheetAuditCriteriaForDetail(detail);
  const queueActive = Boolean(decision.inQueue || itemDecision.inQueue || detail.revenueEvidence?.weak);
  const tone = decision.tone || itemDecision.tone || audit.tone || "watch";
  const metrics = [
    ["문제 날짜", decision.problemDateText || itemDecision.problemDateText, audit.metrics.missingCount ? `미수집 ${fmtNumber(audit.metrics.missingCount)}일` : "날짜별 기준"],
    ["수량 신뢰도", decision.quantityConfidence || itemDecision.quantityConfidence, criteria.find((criterion) => criterion.key === "quantity")?.reason || "자동 수량 판단"],
    ["공백 유형", decision.gapType || itemDecision.gapType, criteria.find((criterion) => criterion.key === "gap")?.reason || "요일별 공백"],
    ["확인 채널", decision.channelText || itemDecision.channelText, criteria.find((criterion) => criterion.key === "ota")?.action || audit.otaReason || "필요 채널"],
    ["보정 상태", decision.correctionText || itemDecision.correctionText, correctionDetail]
  ];
  const summaryRows = [
    ["큐 상태", queueActive ? (decision.label || itemDecision.label || "판단 큐") : "바로 판단 가능", detail.sourceLabel],
    ["추천 처리", recommendation?.label || (queueActive ? "확인 필요" : "컨택 가능"), compactListText(recommendation?.reasons || decision.actions || [], "관리자 판단 기준", 2)],
    ["관리자 판단", review.label || companyAdminReviewLabel(review.status), review.note || companyReviewContextText(review.context || {}) || "저장 메모 없음"],
    ["수동 보정", hasManualCorrection ? "보정 있음" : (review.status === "manual_needed" ? "보정 필요" : "보정 없음"), correctionDetail]
  ];
  const reasonChips = (decision.reasons || []).length ? decision.reasons : (itemDecision.reasons || []);
  return `
    <section class="sheet-section sheet-audit-section ${escapeHtml(tone)}">
      <div class="sheet-structure-title">
        <h3>관리자 판단 큐 V2</h3>
        <span class="structure-badge ${escapeHtml(audit.otaCheckNeeded ? "ota-check" : tone)}">${escapeHtml(queueActive ? (decision.label || itemDecision.label) : "바로 판단 가능")}</span>
      </div>
      <div class="sheet-audit-summary">
        ${summaryRows.map(([label, value, note]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(note)}</small>
          </div>
        `).join("")}
      </div>
      <div class="sheet-audit-grid">
        ${metrics.map(([label, value, note]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(note)}</small>
          </div>
        `).join("")}
      </div>
      <div class="sheet-audit-criteria">
        ${criteria.slice(0, 5).map((criterion, index) => `
          <article class="${escapeHtml(criterion.key || "reason")}">
            <mark>${fmtNumber(index + 1)}</mark>
            <div>
              <strong>${escapeHtml(criterion.label || "확인 필요")}</strong>
              <p>${escapeHtml(criterion.reason || "판단 근거 확인 필요")}</p>
              <small>${escapeHtml(criterion.action || "관리자 확인 후 상태 저장")}</small>
            </div>
          </article>
        `).join("")}
      </div>
      ${companyQueueResolutionHtml(detail.company || {}, detail.profile || {}, detail.workflow || {}, decision, true)}
      <div class="sheet-audit-reasons">
        ${(reasonChips.length ? reasonChips : ["현재 기준 특이 신호가 없습니다."]).map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
      </div>
    </section>
  `;
}

function sheetRecrawlComparisonPanel(item = {}) {
  const companyId = item.companyId || item.companyProfile?.companyId || "";
  const company = (companyMasterSource().companies || []).find((row) => row.companyId === companyId) || item.companyProfile || {};
  if (!company.companyId) return "";
  const decision = companyDecisionQueueProfile(company);
  const profile = companyNeedsCorrection(company);
  return companyRecrawlComparisonHtml(company, profile, decision);
}

function revenueCoverageText(revenue = {}) {
  const priced = finiteNumber(revenue.pricedSoldOut, 0);
  const missing = finiteNumber(revenue.missingPriceSoldOut, 0);
  const gapRevenue = finiteNumber(revenue.missingPriceEstimatedRevenue, 0);
  if (!priced && !missing) return "가격/판매수량 대기";
  return `${fmtNumber(priced)}${revenue.unit} 가격확인${missing ? ` · 가격누락 ${fmtNumber(missing)}${revenue.unit}` : ""}${gapRevenue ? ` · 보정 ${fmtWon(gapRevenue)}` : ""}`;
}

function revenueDayTypeGridHtml(title, rows = [], fallback = "요일별 가격과 판매수량을 같은 수집에서 확보해야 합니다.") {
  return `
    <div class="revenue-day-panel">
      <strong>${escapeHtml(title)}</strong>
      <div class="revenue-day-grid">
        ${rows.length ? rows.map((row) => `
          <div>
            <span>${escapeHtml(row.label)}</span>
            <strong>${escapeHtml(row.revenueText)}</strong>
            <small>${escapeHtml(`${fmtNumber(row.pricedSoldOut)}${row.unit} 가격확인${row.offlineReserved ? ` · 오프라인 ${fmtNumber(row.offlineReserved)}${row.unit}` : ""}${row.missingPriceSoldOut ? ` · 가격누락 ${fmtNumber(row.missingPriceSoldOut)}${row.unit}` : ""}`)}</small>
          </div>
        `).join("") : `<p class="empty">${escapeHtml(fallback)}</p>`}
      </div>
    </div>
  `;
}

function revenueProductRowsHtml(rows = []) {
  if (!rows.length) {
    return `<div class="empty">상품별 수량 데이터가 아직 없습니다. 정밀분석 재수집 후 객실/데이유즈 상품 단위가 표시됩니다.</div>`;
  }
  return `
    <div class="revenue-product-list">
      ${rows.slice(0, 8).map((row) => `
        <div>
          <div>
            <strong>${escapeHtml(row.name)}</strong>
            <small>${escapeHtml(row.kindLabel)}</small>
          </div>
          <span>${row.stock === null ? "총량확인" : `${fmtNumber(row.stock)}개/회`}</span>
          <span>${row.available === null ? "잔여확인" : `${fmtNumber(row.available)}잔여`}</span>
          <span>${fmtNumber(row.sold)}판매</span>
          <b>${Number.isFinite(row.price) ? fmtWon(row.price) : "가격확인"}</b>
        </div>
      `).join("")}
    </div>
  `;
}

function sheetRevenuePanel(item = {}) {
  const profile = preciseRevenueProfile(item);
  const { lodging, dayUse, precision } = profile;
  const lodgingDetail = lodging.byDayType || lodging.detail || "요일별 매출은 다음 수집부터 표시됩니다.";
  const dayUseDetail = dayUse.byDayType || dayUse.detail || "데이유즈/캠프닉 매출은 상품 가격과 판매수량이 함께 확인될 때 표시됩니다.";
  const offlineRows = [
    lodging.offlineDetail ? ["숙박 오프라인 예약 추정", lodging.offlineDetail, lodging.revenue] : null,
    dayUse.offlineDetail ? ["데이유즈/캠프닉 오프라인 예약 추정", dayUse.offlineDetail, dayUse.revenue] : null
  ].filter(Boolean);
  const totalRevenueValue = profile.totalAdjustedRevenue || profile.totalRevenue;
  const totalRevenueNote = profile.totalAdjustedRevenue > profile.totalRevenue && profile.totalMissingPriceEstimatedRevenue
    ? `확인가격 ${fmtWon(profile.totalRevenue)} · 가격누락 보정 ${fmtWon(profile.totalMissingPriceEstimatedRevenue)}`
    : `가격확보 ${Number.isFinite(precision.coverage) ? fmtRate(precision.coverage) : "대기"} · ${fmtNumber(precision.priced)}개/회`;
  const lodgingRevenueValue = lodging.adjustedRevenue || lodging.revenue;
  const dayUseRevenueValue = dayUse.adjustedRevenue || dayUse.revenue;
  return `
    <section class="sheet-section sheet-revenue-section">
      <div class="sheet-structure-title">
        <h3>예상 매출 정밀 산정</h3>
        <span class="structure-badge ${escapeHtml(precision.tone)}">${escapeHtml(`${precision.grade} · ${precision.label}`)}</span>
      </div>
      <div class="sheet-history-grid">
        <div>
          <span>전체 예상매출</span>
          <strong>${fmtWon(totalRevenueValue)}</strong>
          <small>${escapeHtml(totalRevenueNote)}</small>
        </div>
        <div>
          <span>숙박 매출</span>
          <strong>${fmtWon(lodgingRevenueValue)}</strong>
          <small>${escapeHtml(`${lodging.label} · ${revenueCoverageText(lodging)}${lodgingRevenueValue > lodging.revenue ? ` · 원매출 ${fmtWon(lodging.revenue)}` : ""}`)}</small>
        </div>
        <div>
          <span>숙박 평균단가</span>
          <strong>${lodging.avgSoldUnitPrice ? fmtWon(lodging.avgSoldUnitPrice) : "확인필요"}</strong>
          <small>상품별 가격×판매수량 가중 평균</small>
        </div>
        <div>
          <span>데이유즈/캠프닉</span>
          <strong>${fmtWon(dayUseRevenueValue)}</strong>
          <small>${escapeHtml(`${dayUse.label} · ${revenueCoverageText(dayUse)}${dayUseRevenueValue > dayUse.revenue ? ` · 원매출 ${fmtWon(dayUse.revenue)}` : ""}`)}</small>
        </div>
        <div>
          <span>매출 신뢰도</span>
          <strong>${fmtNumber(precision.score)}점</strong>
          <small>${escapeHtml(precision.reasons.slice(0, 2).join(" · "))}</small>
        </div>
      </div>
      ${revenueDayTypeGridHtml("숙박 요일별 가격/판매금", profile.lodgingDayRows)}
      ${revenueDayTypeGridHtml("데이유즈/캠프닉 요일별 가격/판매금", profile.dayUseDayRows, "데이유즈/캠프닉은 숙박과 같은 카테고리로 보되, 회차 가격과 판매수량이 확인될 때 산정합니다.")}
      <div class="revenue-product-panel">
        <div class="history-card-head">
          <strong>상품별 수량/가격</strong>
          <small>할인 옵션·패키지는 산출하지 않고 상품 가격과 판매수량만 반영</small>
        </div>
        ${revenueProductRowsHtml(profile.productRows)}
      </div>
      <div class="search-row">
        <div>
          <strong>숙박 요일별 매출</strong>
          <small>${escapeHtml(lodgingDetail)}</small>
        </div>
        <strong>${fmtWon(lodging.revenue)}</strong>
      </div>
      <div class="search-row">
        <div>
          <strong>데이유즈/캠프닉 매출</strong>
          <small>${escapeHtml(dayUseDetail)}</small>
        </div>
        <strong>${fmtWon(dayUse.revenue)}</strong>
      </div>
      ${offlineRows.map(([label, detail, revenue]) => `
        <div class="search-row">
          <div>
            <strong>${escapeHtml(label)}</strong>
            <small>${escapeHtml(detail)}</small>
          </div>
          <strong>${fmtWon(revenue)}</strong>
        </div>
      `).join("")}
    </section>
  `;
}

function sheetFlowOverview(item = {}) {
  const flow = salesFlowProfile(item);
  const correctionStatus = correctionStatusInfo(item);
  const structure = inventoryStructureInfo(item);
  const historyWeekday = flow.history?.weekday;
  const analysis = targetExpansionAnalysis(item);
  const publicMode = !isAdminRole();
  const cells = [
    ["7일 전체", flow.all, `${fmtNumber(flow.all.sold)}/${fmtNumber(flow.all.total)}개`],
    [flow.weekday.label, flow.weekday, `${fmtNumber(flow.weekday.count)}일 관측`],
    ["금요일", flow.friday, "전야 수요"],
    ["토요일", flow.saturday, "핵심 수요"],
    ["일요일", flow.sunday, "퇴실 후 공백"],
    ["누적평일", historyWeekday, historyWeekday?.observations ? `${fmtNumber(historyWeekday.observations)}건` : "대기"]
  ];
  return `
    <section class="sheet-section sheet-decision-section">
      <div class="sheet-decision-head">
        <div>
          <h3>${publicMode ? "요일별 판매 흐름" : "관리자 판단 요약"}</h3>
          <p>${escapeHtml(publicMode ? "평일, 금요일, 토요일, 일요일 판매 흐름을 나눠 경쟁 흐름을 봅니다." : `${analysis.label} · ${fmtNumber(analysis.score)}점 · ${structure.label}`)}</p>
        </div>
        <span class="confidence-badge ${escapeHtml(correctionStatus.tone)}">${escapeHtml(publicMode ? "판매 흐름" : correctionStatus.label)}</span>
      </div>
      <div class="sheet-flow-grid">
        ${cells.map(([label, metric, note]) => {
          const rate = metric && Number.isFinite(metric.rate ?? metric.saleRate)
            ? (Number.isFinite(metric.rate) ? metric.rate : metric.saleRate)
            : NaN;
          return `
            <div>
              <span>${escapeHtml(label)}</span>
              <strong>${Number.isFinite(rate) ? fmtRate(rate) : "확인필요"}</strong>
              <small>${escapeHtml(note || "")}</small>
            </div>
          `;
        }).join("")}
      </div>
      ${publicMode ? "" : validationReasonRow(item)}
    </section>
  `;
}

function sheetInventoryStructure(item = {}) {
  const structure = inventoryStructureInfo(item);
  const confidence = inventoryConfidenceInfo(item);
  const correctionStatus = correctionStatusInfo(item);
  const flags = structure.flags || [];
  const rows = [
    ["리스트 구조", structure.label, structure.summary],
    ["검증 액션", structure.action, flags.includes("dynamic_capacity") ? "날짜별 총량 변동은 전화예약, 시설점검, 채널별 재고조정 가능성으로 우선 해석합니다." : ""],
    ["수량 기준", item.inventoryScope || "네이버예약 채널/날짜 기준 재고", item.inventoryMemo || "실제 전체 객실수와 다를 수 있습니다."],
    ["보정 상태", correctionStatus.label, correctionStatus.key === "admin" ? correctionStatus.summary : `자동추정 근거: ${confidence.label} · ${confidence.summary}`]
  ];
  return `
    <section class="sheet-section sheet-structure-section">
      <div class="sheet-structure-title">
        <h3>수량 구조 검증</h3>
        ${inventoryStructureBadge(item)}
      </div>
      <div class="sheet-structure-list">
        ${rows.map(([label, value, note]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            ${note ? `<small>${escapeHtml(note)}</small>` : ""}
          </div>
        `).join("")}
      </div>
      ${flags.length ? `
        <div class="structure-flag-row">
          ${flags.map((flag) => `<span>${escapeHtml({
            dayuse_rotation: "당일 회전형 병행",
            dynamic_capacity: "날짜별 총량 변동",
            raw_calc_gap: "원시/계산 재고 차이",
            grouped_range: "객실 범위형 상품",
            booking_id_reused: "예약ID 재확인",
            not_total_rooms: "전체 객실수 아님"
          }[flag] || flag)}</span>`).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function renderB2BBookingQualityPanel(item = {}, lodgingRows = sheetRowsForBooking(item), dayRows = sheetRowsForDayUse(item)) {
  if (isAdminRole()) return "";
  const status = collectionStatusProfile(item);
  const lodging = salesStats(item, "lodging");
  const day = salesStats(item, "day");
  const revenue = itemRevenueStats(item, "lodging");
  const remaining = Math.max(0, finiteNumber(lodging.supply, 0) - finiteNumber(lodging.sold, 0));
  const missingCount = lodgingRows.filter((row) => row.missing).length;
  const tone = status.statusKey === "ready" ? "good" : status.statusKey === "partial" ? "watch" : "bad";
  const label = status.statusKey === "ready"
    ? "판단 기준 확보"
    : status.statusKey === "partial"
      ? "표본 보강 필요"
      : "예약 표본 부족";
  const summary = status.statusKey === "ready"
    ? "현재 예약 표본은 판매 흐름과 잔여 객실 판단에 활용할 수 있습니다."
    : status.statusKey === "partial"
      ? "일부 날짜, 가격, 상품 구성이 부족해 판매 판단은 보조 기준으로 봅니다."
      : "예약 수량 표본이 부족합니다. 순위와 채널 노출을 먼저 보고 추가 확인이 필요합니다.";
  const basisText = status.basisTotal
    ? `${fmtNumber(status.basisTotal)}실 기준`
    : "총량 확인필요";
  const priceText = revenue.pricedSoldOut
    ? `${fmtNumber(revenue.pricedSoldOut)}개 가격 확인`
    : "가격 표본 대기";
  const offlineText = status.offlineEstimated
    ? `${fmtNumber(status.offlineQuantity)}개 오프라인 추정`
    : "특이 신호 없음";
  const metrics = [
    { label: "숙박 판매율", value: Number.isFinite(lodging.rate) ? fmtRate(lodging.rate) : "확인필요", note: lodging.supply ? `${fmtNumber(lodging.sold)}/${fmtNumber(lodging.supply)}실` : "숙박 표본 대기" },
    { label: "잔여 객실", value: lodging.supply ? fmtNumber(remaining) : "확인필요", note: basisText },
    { label: "데이유즈/캠프닉", value: day.supply ? fmtRate(day.rate) : "미확인", note: dayRows.length ? `${fmtNumber(day.sold)}/${fmtNumber(day.supply)}개` : "같은 카테고리 보조 판단" },
    { label: "매출 표본", value: revenue.adjustedRevenue ? fmtWon(revenue.adjustedRevenue) : "대기", note: revenueCoverageText(revenue) },
    { label: "날짜 표본", value: `${fmtNumber(lodgingRows.length - missingCount)}/${fmtNumber(lodgingRows.length)}`, note: missingCount ? `미확인 ${fmtNumber(missingCount)}일` : "기간 내 날짜 확보" },
    { label: "오프라인 예약", value: status.offlineEstimated ? "반영" : "특이 없음", note: offlineText }
  ];
  return `
    <section class="sheet-section sheet-b2b-booking ${escapeHtml(tone)}">
      <div class="sheet-b2b-head">
        <div>
          <span>${escapeHtml(label)}</span>
          <h3>예약 판단 기준</h3>
          <p>${escapeHtml(summary)}</p>
        </div>
        <strong>${escapeHtml(Number.isFinite(lodging.rate) ? fmtRate(lodging.rate) : "예약")}</strong>
      </div>
      <div class="sheet-b2b-platform-grid">
        ${metrics.map((metric) => `
          <div>
            <span>${escapeHtml(metric.label)}</span>
            <strong>${escapeHtml(metric.value)}</strong>
            <small>${escapeHtml(metric.note || "")}</small>
          </div>
        `).join("")}
      </div>
      <div class="sheet-b2b-coupon-line">
        <strong>가격/수량 해석 기준</strong>
        <span>${escapeHtml([basisText, priceText, missingCount ? `미확인 날짜 ${fmtNumber(missingCount)}일` : "", status.offlineEstimated ? "오프라인 예약 가능성 반영" : ""].filter(Boolean).join(" · "))}</span>
      </div>
    </section>
  `;
}

function sheetHistoryPanel(item = {}) {
  const benchmark = historyCompanyBenchmark(item);
  if (!benchmark?.all?.observations && !benchmark?.weekday?.observations) {
    return "";
  }
  const flow = salesFlowProfile(item);
  const currentWeekday = flow.weekday;
  const currentAll = flow.all;
  const cumulativeAll = benchmark.all || {};
  const cumulativeWeekday = benchmark.weekday || {};
  const weekdayGap = Number.isFinite(Number(currentWeekday.rate)) && Number.isFinite(Number(cumulativeWeekday.saleRate))
    ? Number(currentWeekday.rate) - Number(cumulativeWeekday.saleRate)
    : NaN;
  const cells = [
    ["현재 전체", historyRateText(currentAll.rate), `${fmtNumber(currentAll.sold)}/${fmtNumber(currentAll.total)}개`],
    ["누적 전체", historyRateText(cumulativeAll.saleRate), `${fmtNumber(cumulativeAll.observations || 0)}건`],
    ["현재 평일", historyRateText(currentWeekday.rate), `${fmtNumber(currentWeekday.count || 0)}일`],
    ["누적 평일", historyRateText(cumulativeWeekday.saleRate), `${fmtNumber(cumulativeWeekday.observations || 0)}건`],
    ["평일 편차", Number.isFinite(weekdayGap) ? formatSignedRate(weekdayGap) : "대기", "현재-누적"]
  ];
  return `
    <section class="sheet-section sheet-history-section">
      <div class="sheet-structure-title">
        <h3>누적 DB 비교</h3>
        <span class="structure-badge watch">${fmtNumber(cumulativeAll.runCount || 0)}회 수집</span>
      </div>
      <div class="sheet-history-grid">
        ${cells.map(([label, value, note]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
            <small>${escapeHtml(note)}</small>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function sheetBookingBarsPanel(item = {}, lodgingRows = sheetRowsForBooking(item)) {
  const run = state.data?.run || {};
  const flow = salesFlowProfile(item);
  const rows = lodgingRows.length ? lodgingRows : sheetRowsForBooking(item);
  const maxTotal = Math.max(1, ...rows.map((row) => finiteNumber(row.supply, 0)));
  const collectedRows = rows.filter((row) => !row.missing).length;
  const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
  const flowRows = [
    ["전체", flow.all, `${fmtNumber(flow.all.count)}일`],
    ["평일", flow.weekday, `${fmtNumber(flow.weekday.count)}일`],
    ["금요일", flow.friday, `${fmtNumber(flow.friday.count)}일`],
    ["토요일", flow.saturday, `${fmtNumber(flow.saturday.count)}일`],
    ["일요일", flow.sunday, `${fmtNumber(flow.sunday.count)}일`]
  ];
  return `
    <section class="sheet-section sheet-booking-bars">
      <div class="sheet-booking-bars-head">
        <div>
          <h3>검색 기간 날짜별 판매 흐름</h3>
          <p>${escapeHtml(dateRangeLabel(run))} 입력기간 기준으로 날짜별 수량과 요일별 판매율을 함께 봅니다.</p>
        </div>
        <span>${fmtNumber(collectedRows)}/${fmtNumber(rows.length)}일 확보</span>
      </div>
      <div class="sheet-date-bars" aria-label="검색 기간 날짜별 판매율">
        ${rows.map((row) => {
          const date = dateForRangeLabel(row.label, run);
          const dayName = date ? dayNames[date.getDay()] : "";
          const supply = finiteNumber(row.supply, 0);
          const sold = finiteNumber(row.sold, 0);
          const rate = Number(row.rate);
          const rangeHeight = supply ? Math.max(24, Math.round((supply / maxTotal) * 86)) : 24;
          const fillHeight = row.missing || !supply ? 0 : Math.max(3, Math.round((sold / maxTotal) * 86));
          const rateText = row.missing || !Number.isFinite(rate) ? "미수집" : fmtRate(rate);
          const tone = row.missing
            ? "missing"
            : rate >= 0.70
              ? "hot"
              : rate >= 0.45
                ? "strong"
                : rate >= 0.20
                  ? "watch"
                  : "low";
          const title = `${row.label}${dayName ? ` ${dayName}요일` : ""} · ${rateText} · ${fmtNumber(sold)}/${fmtNumber(supply)}${row.unit}`;
          return `
            <div class="sheet-date-bar ${tone}" title="${escapeHtml(title)}">
              <strong>${escapeHtml(row.label)}</strong>
              <span style="--range-h:${rangeHeight}px; --fill-h:${fillHeight}px"><i></i></span>
              <em>${escapeHtml(dayName || "-")}</em>
              <small>${escapeHtml(rateText)}</small>
            </div>
          `;
        }).join("")}
      </div>
      <div class="sheet-weekday-bars" aria-label="요일별 판매율">
        ${flowRows.map(([label, metric, note]) => {
          const rate = Number(metric?.rate);
          const width = Number.isFinite(rate) ? Math.max(3, Math.min(100, Math.round(rate * 100))) : 0;
          return `
            <div>
              <span>${escapeHtml(label)}</span>
              <b><i style="width:${width}%"></i></b>
              <strong>${Number.isFinite(rate) ? fmtRate(rate) : "확인필요"}</strong>
              <small>${escapeHtml(note)}</small>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderSheetBooking(item) {
  const run = state.data?.run || {};
  const rangeDays = bookingDays(run);
  const rangeLabel = dateRangeLabel(run);
  const placeLimit = finiteNumber(run.bookingRangePlaceLimit, rangeDays > 1 ? 10 : 0);
  const lodgingRows = sheetRowsForBooking(item);
  const collectedRows = lodgingRows.filter((row) => !row.missing).length;
  const missingRows = lodgingRows.length - collectedRows;
  const dayRows = sheetRowsForDayUse(item);
  const confidence = inventoryConfidenceInfo(item);
  const correctionStatus = correctionStatusInfo(item);
  const confidenceReasons = [...confidence.alerts, ...confidence.reasons].filter(Boolean).slice(0, 4);
  const flow = salesFlowProfile(item);
  const historyWeekday = flow.history?.weekday;
  const publicMode = !isAdminRole();
  const publicBlocks = publicMode
    ? `${renderB2BDetailPositionPanel(item)}${sheetB2BInsightPanel(item)}${renderB2BBookingQualityPanel(item, lodgingRows, dayRows)}`
    : "";
  const adminBlocks = isAdminRole()
    ? `${sheetCollectionStatusPanel(item)}${sheetRevenuePanel(item)}${sheetAuditPanel(item)}${sheetRecrawlComparisonPanel(item)}${sheetCompanyProfile(item)}${sheetInventoryStructure(item)}${sheetHistoryPanel(item)}`
    : "";
  return `
    ${publicBlocks}
    ${sheetFlowOverview(item)}
    ${adminBlocks}
    ${sheetBookingBarsPanel(item, lodgingRows)}
    <section class="sheet-section">
      <h3>숙박 날짜별 예약 상세</h3>
      ${lodgingRows.length ? lodgingRows.map(dateRow).join("") : `<div class="empty">숙박 재고가 확인되지 않았습니다.</div>`}
    </section>
    <section class="sheet-section">
      <h3>데이유즈/캠프닉 기준일</h3>
      ${dayRows.length ? dayRows.map(dateRow).join("") : `<div class="empty">데이유즈/캠프닉 상품이 확인되지 않았습니다.</div>`}
    </section>
    <section class="sheet-section">
      <h3>재고 해석</h3>
      <div class="search-row">
        <div>
          <strong>표시 기준</strong>
          <small>그래프와 더보기는 ${escapeHtml(rangeLabel)} 입력기간 기준입니다. 수집값이 없는 날짜는 반투명 미수집으로 표시합니다.</small>
        </div>
        <strong>${fmtNumber(rangeDays)}일 중 ${fmtNumber(collectedRows)}일</strong>
      </div>
      <div class="search-row">
        <div>
          <strong>데이유즈/캠프닉</strong>
          <small>현재는 기준일 확인 재고입니다. 숙박 예약률 계산에는 포함하지 않습니다.</small>
        </div>
        <strong>보조 지표</strong>
      </div>
      <div class="search-row confidence-row ${escapeHtml(correctionStatus.tone)}">
        <div>
          <strong>보정 상태 ${escapeHtml(correctionStatus.label)}</strong>
          <small>${escapeHtml(correctionStatus.key === "admin" ? correctionStatus.summary : (confidenceReasons.length ? `자동추정 근거: ${confidenceReasons.join(" · ")}` : correctionStatus.summary))}</small>
        </div>
        <strong>${escapeHtml(correctionStatus.detail)}</strong>
      </div>
      <div class="search-row">
        <div>
          <strong>7일 흐름 / 평일 기준</strong>
          <small>${escapeHtml(`전체 ${fmtRate(flow.all.rate)} · ${flow.weekday.label} ${Number.isFinite(flow.weekday.rate) ? fmtRate(flow.weekday.rate) : "확인필요"}(${flow.weekday.count}일) · 금 ${fmtRate(flow.friday.rate)} · 토 ${fmtRate(flow.saturday.rate)} · 일 ${fmtRate(flow.sunday.rate)}`)}</small>
        </div>
        <strong>${historyWeekday?.observations ? `누적 ${fmtRate(historyWeekday.saleRate)}` : "누적 대기"}</strong>
      </div>
      ${missingRows ? `
        <div class="search-row">
          <div>
            <strong>미수집 날짜</strong>
            <small>입력기간 전체를 기준으로 다시 수집하면 상위 ${fmtNumber(placeLimit)}개 업체는 날짜별 상세를 반복 확인합니다.</small>
          </div>
          <strong>${missingRows}일</strong>
        </div>
      ` : ""}
      ${item.weeklyRawStockVariance ? `
        <div class="search-row">
          <div>
            <strong>날짜별 원시재고</strong>
            <small>${escapeHtml(item.weeklyRawStockVariance)}</small>
          </div>
          <strong>총량 변동</strong>
        </div>
      ` : ""}
      <div class="search-row">
        <div>
          <strong>${escapeHtml(item.inventoryScope || "채널 기준 재고")}</strong>
          <small>${escapeHtml(item.inventoryMemo || "실제 전체 객실수와 다를 수 있습니다.")}</small>
        </div>
        <strong>${escapeHtml(item.listType || "확인")}</strong>
      </div>
    </section>
  `;
}

function platformStatus(row) {
  const status = String(row.status || row.group || "");
  if (status.includes("미노출") || status.includes("실패") || status.includes("차단")) return ["bad", status || "미노출"];
  if (status.includes("OTA 확인")) return ["warn", "OTA 확인 필요"];
  if (status.includes("보조")) return ["good", "보조"];
  if (status.includes("확인") || status.includes("수동")) return ["warn", status || "확인 필요"];
  return ["good", status || "노출"];
}

function b2bPlatformModel(item = {}, rows = platformsForItem(item), audit = inventoryAuditProfile(item)) {
  const coupon = naverCouponInfo(item);
  const visibleRows = rows.filter((row) => {
    const status = String(row.status || row.group || "");
    return !/미노출|실패|차단/.test(status);
  });
  const naverRow = rows.find((row) => platformShortName(row.platform) === "네이버") || null;
  const otaRows = rows.filter((row) => platformShortName(row.platform) !== "네이버");
  const hasOta = otaRows.some((row) => !/미노출|실패|차단/.test(String(row.status || row.group || "")));
  const decision = audit.otaCheckNeeded
    ? {
      tone: "watch",
      label: "OTA 보완 확인",
      summary: "네이버 수량만으로 전체 운영을 판단하기 애매한 구간입니다. 여기어때, 야놀자, 떠나요 노출과 가격을 보조 확인합니다."
    }
    : coupon.visible
      ? {
        tone: "strong",
        label: "프로모션 확인",
        summary: "네이버 쿠폰이 노출되어 가격/혜택 중심의 접근이 가능합니다. 쿠폰명과 노출 채널을 먼저 확인합니다."
      }
      : hasOta
        ? {
          tone: "good",
          label: "채널 보조 가능",
          summary: "네이버 외 OTA 노출이 있어 가격과 객실 구성 비교가 가능합니다."
        }
        : {
          tone: "neutral",
          label: "네이버 중심",
          summary: "현재 확인 가능한 채널은 네이버 중심입니다. 추가 OTA 표본은 수동 보완 대상으로 둡니다."
        };
  return {
    coupon,
    naverRow,
    otaRows,
    visibleRows,
    hasOta,
    decision,
    metrics: [
      { label: "노출 채널", value: fmtNumber(visibleRows.length), note: rows.length ? `${fmtNumber(rows.length)}개 채널 확인` : "채널 표본 대기" },
      { label: "네이버", value: naverRow ? "노출" : "확인필요", note: naverRow?.price || naverRow?.stock || item.price || "예약 화면 기준" },
      { label: "OTA", value: hasOta ? "보조 가능" : "보완 필요", note: otaRows.length ? `${fmtNumber(otaRows.length)}개 OTA 표본` : "여기어때/야놀자/떠나요" },
      { label: "쿠폰", value: coupon.visible ? "노출" : "수동확인", note: coupon.visible ? (coupon.names || coupon.status || "쿠폰명 확인") : coupon.detail }
    ]
  };
}

function renderB2BPlatformBrief(item = {}, rows = platformsForItem(item), audit = inventoryAuditProfile(item)) {
  if (isAdminRole()) return "";
  const model = b2bPlatformModel(item, rows, audit);
  return `
    <section class="sheet-section sheet-b2b-platform ${escapeHtml(model.decision.tone)}">
      <div class="sheet-b2b-head">
        <div>
          <span>${escapeHtml(model.decision.label)}</span>
          <h3>채널 노출과 혜택 요약</h3>
          <p>${escapeHtml(model.decision.summary)}</p>
        </div>
        <strong>${escapeHtml(model.coupon.visible ? "쿠폰" : "채널")}</strong>
      </div>
      <div class="sheet-b2b-platform-grid">
        ${model.metrics.map((metric) => `
          <div>
            <span>${escapeHtml(metric.label)}</span>
            <strong>${escapeHtml(metric.value)}</strong>
            <small>${escapeHtml(metric.note || "")}</small>
          </div>
        `).join("")}
      </div>
      <div class="sheet-b2b-coupon-line">
        <strong>${model.coupon.visible ? "네이버 쿠폰 노출" : "쿠폰 자동수집 제한"}</strong>
        <span>${escapeHtml([model.coupon.names, model.coupon.channel, model.coupon.detail].filter(Boolean).join(" · ") || "네이버 화면에서 쿠폰명/노출 채널 수동 확인")}</span>
      </div>
    </section>
  `;
}

function sheetRegionForItem(item = {}) {
  const itemRegion = String(item.region || item.addressRegion || "").trim();
  return (state.data?.regions || []).find((entry) => {
    const regionName = String(entry.region || entry.name || "").trim();
    if (!regionName || !itemRegion) return false;
    return regionName.includes(itemRegion) || itemRegion.includes(regionName);
  }) || null;
}

function b2bSearchModel(item = {}) {
  const region = sheetRegionForItem(item);
  const traffic = region?.traffic || state.data?.stats?.traffic || {};
  const insight = companyRankInsight(item, item.rank || item.overallRank || 0);
  const profile = b2bCompanyActionProfile(item, insight);
  const status = item.regionBoundaryStatus || (item.outsideSearchRegion ? "outside" : "same");
  const boundaryLabel = status === "outside"
    ? "반경 노출 경쟁권"
    : ["within", "parent"].includes(status)
      ? "권역 내 노출"
      : "검색권역 확인";
  const boundaryDetail = item.regionBoundaryDetail || (
    status === "outside"
      ? "검색 지역 경계 밖 소재라도 네이버 플레이스 반경 노출로 함께 비교되는 업체입니다."
      : "검색권역과 업체 소재지가 같은 생활권으로 해석됩니다."
  );
  const total = finiteNumber(traffic.totalSearchVolume, 0);
  const ctr = Number(traffic.combinedCtr);
  return {
    region,
    traffic,
    insight,
    profile,
    boundaryLabel,
    boundaryDetail,
    metrics: [
      { label: "월검색량", value: total ? fmtNumber(total) : "확인필요", note: traffic.relKeyword || traffic.keyword || activeKeyword() },
      { label: "CTR", value: traffic.collectable || total ? fmtSearchRate(ctr) : "확인필요", note: "검색광고 API 기준" },
      { label: "노출순위", value: insight.rank ? `${fmtNumber(insight.rank)}위` : "확인필요", note: item.rankingSourceLabel || "네이버 플레이스" },
      { label: "노출권역", value: boundaryLabel, note: regionPrimary(region || {}) }
    ]
  };
}

function renderB2BSearchBrief(item = {}) {
  if (isAdminRole()) return "";
  const model = b2bSearchModel(item);
  return `
    <section class="sheet-section sheet-b2b-search ${escapeHtml(model.profile.tone)}">
      <div class="sheet-b2b-head">
        <div>
          <span>${escapeHtml(model.profile.label)}</span>
          <h3>검색량과 노출 기준</h3>
          <p>${escapeHtml("월검색량·CTR은 수요, 네이버 순위·반경권은 노출 근거로 봅니다.")}</p>
        </div>
        <strong>${escapeHtml(model.insight.rank ? `${fmtNumber(model.insight.rank)}위` : "순위")}</strong>
      </div>
      <div class="sheet-b2b-platform-grid">
        ${model.metrics.map((metric) => `
          <div>
            <span>${escapeHtml(metric.label)}</span>
            <strong>${escapeHtml(metric.value)}</strong>
            <small>${escapeHtml(metric.note || "")}</small>
          </div>
        `).join("")}
      </div>
      <div class="sheet-b2b-coupon-line">
        <strong>${escapeHtml(model.boundaryLabel)}</strong>
        <span>${escapeHtml(model.boundaryDetail)}</span>
      </div>
    </section>
  `;
}

function renderSheetPlatform(item) {
  const rows = platformsForItem(item);
  const known = new Set(rows.map((row) => platformShortName(row.platform)));
  const audit = inventoryAuditProfile(item);
  const baseRows = [...rows];
  ["네이버", "여기어때", "야놀자", "떠나요"].forEach((name) => {
    if (!known.has(name)) {
      const status = name === "네이버"
        ? "확인 필요"
        : audit.otaCheckNeeded
          ? "OTA 확인 필요"
          : "보조 확인";
      baseRows.push({ platform: name, status });
    }
  });
  return `
    ${renderB2BPlatformBrief(item, baseRows, audit)}
    <section class="sheet-section">
      <h3>플랫폼 비교</h3>
      ${baseRows.map((row) => {
        const [tone, label] = platformStatus(row);
        const url = platformRowUrl(row, item);
        const rowContent = `
          <b class="platform-dot">${platformLetter(row.platform)}</b>
          <div>
            <strong>${escapeHtml(platformShortName(row.platform))}</strong>
            <small>${escapeHtml(row.price || row.stock || row.inventoryNote || "상세 확인")}</small>
          </div>
          <em>${escapeHtml(url ? "이동" : label)}</em>
        `;
        return `
          ${url
            ? `<a class="platform-row ${tone}" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${escapeHtml(`${platformShortName(row.platform)} 채널로 이동`)}" aria-label="${escapeHtml(`${platformShortName(row.platform)}에서 ${item.name || "업체"} 보기`)}">${rowContent}</a>`
            : `<div class="platform-row ${tone}">${rowContent}</div>`}
        `;
      }).join("")}
    </section>
    <section class="sheet-section">
      <h3>OTA 보조 확인</h3>
      <div class="search-row">
        <div>
          <strong>${audit.otaCheckNeeded ? (isAdminRole() ? "OTA 확인 필요" : "다른 예약채널 비교 필요") : (isAdminRole() ? "현재는 네이버 기준 판단" : "네이버 중심 판단 가능")}</strong>
          <small>${audit.otaCheckNeeded
            ? escapeHtml(isAdminRole()
              ? (audit.otaReason || "네이버 수량 해석 보조 확인")
              : "네이버만으로 전체 판매 구조가 충분히 설명되지 않아 OTA 노출, 가격, 잔여 객실을 함께 봅니다.")
            : (isAdminRole()
              ? "네이버 재고 구조가 안정적이면 OTA는 노출/가격 보조값으로만 봅니다."
              : "현재 표본에서는 네이버 예약 흐름을 중심으로 보고, OTA는 가격/혜택 비교용으로 봅니다.")}</small>
        </div>
        <strong>${audit.otaCheckNeeded ? (isAdminRole() ? "확인" : "비교") : "보조"}</strong>
      </div>
    </section>
  `;
}

function renderSheetSearch(item) {
  const region = sheetRegionForItem(item);
  const traffic = region?.traffic || state.data?.stats?.traffic || {};
  return `
    ${renderB2BSearchBrief(item)}
    <section class="sheet-section">
      <h3>검색량 데이터</h3>
      <div class="search-row">
        <div>
          <strong>${escapeHtml(traffic.relKeyword || traffic.keyword || activeKeyword())}</strong>
          <small>PC+모바일 월검색량</small>
        </div>
        <strong>${traffic.totalSearchVolume ? fmtNumber(traffic.totalSearchVolume) : "확인필요"}</strong>
      </div>
      <div class="search-row">
        <div>
          <strong>종합 클릭률</strong>
          <small>검색광고 API 기준</small>
        </div>
        <strong>${traffic.collectable || traffic.totalSearchVolume ? fmtSearchRate(traffic.combinedCtr) : "확인필요"}</strong>
      </div>
      <div class="search-row">
        <div>
          <strong>클러스터</strong>
          <small>${escapeHtml(region?.note || "지역별 본질 클러스터 기준")}</small>
        </div>
        <strong>${escapeHtml(regionPrimary(region || {}))}</strong>
      </div>
    </section>
  `;
}

function renderSheet() {
  const item = state.selectedItem;
  if (!item) return;
  els.sheetTitle.textContent = `${item.name} 상세`;
  els.sheetSubtitle.textContent = `${categoryText(item)} · ${priceText(item.price)}`;
  document.querySelectorAll(".sheet-tabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.sheetTab === state.selectedSheetTab);
  });
  els.sheetBody.innerHTML = state.selectedSheetTab === "platform"
    ? renderSheetPlatform(item)
    : state.selectedSheetTab === "search"
      ? renderSheetSearch(item)
      : renderSheetBooking(item);
}

function openSheet(index) {
  const item = (state.data?.availability?.items || [])[Number(index)];
  if (!item) return;
  state.selectedItem = item;
  state.selectedSheetTab = "booking";
  renderSheet();
  els.detailSheet.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSheet() {
  els.detailSheet.hidden = true;
  document.body.style.overflow = "";
}

function openDrawer() {
  els.controlDrawer.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDrawer() {
  els.controlDrawer.hidden = true;
  if (els.detailSheet.hidden) document.body.style.overflow = "";
}

async function loadSession() {
  const session = await fetchJson("/api/session");
  state.session = {
    authenticated: Boolean(session.authenticated),
    username: session.username || "",
    role: session.role === "b2b" ? "b2b" : "admin",
    roleLabel: session.roleLabel || (session.role === "b2b" ? "B2B" : "관리자")
  };
  state.session.memberId = session.memberId || "";
  state.session.accountType = session.accountType || "";
  state.session.profile = session.profile || null;
  if (state.session.role === "admin" && state.session.roleLabel !== "마스터") state.session.roleLabel = "마스터";
  if (location.pathname === "/b2b" && state.session.role === "b2b") {
    state.activeTab = "report";
  } else if (location.pathname === "/admin" && state.session.role === "admin") {
    state.activeTab = "admin";
  }
  applyRoleUi();
}

async function loadMemberSearchHistory() {
  if (isAdminRole()) {
    state.memberSearchHistory = [];
    return;
  }
  try {
    const data = await fetchJson("/api/member/search-history?limit=20");
    state.memberSearchHistory = data.entries || [];
  } catch {
    state.memberSearchHistory = [];
  }
}

async function loadHistoryOps() {
  if (!isAdminRole()) {
    state.historyOps = null;
    return;
  }
  try {
    state.historyOps = await fetchJson("/api/history/summary");
  } catch (error) {
    state.historyOps = { error: error.message, keywords: [], overall: {} };
    if (els.historyOpsState) els.historyOpsState.textContent = "오류";
  }
}

async function loadCompanyMasterSummary() {
  if (!isAdminRole()) {
    state.companyMaster = null;
    state.crawlEtaByKey = {};
    return;
  }
  try {
    state.companyMaster = await fetchJson("/api/company-master/summary");
    await loadRecrawlEtaEstimates(state.companyMaster);
  } catch (error) {
    state.companyMaster = { error: error.message, totalCompanies: 0, duplicateCandidates: [] };
    state.crawlEtaByKey = {};
  }
}

async function resolveCompanyDuplicate(button) {
  const action = button?.dataset?.companyDuplicateAction;
  const candidateKey = button?.dataset?.candidateKey || "";
  const companyIds = (button?.dataset?.companyIds || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!action || !candidateKey) return;
  button.disabled = true;
  if (els.companyMasterState) els.companyMasterState.textContent = action === "merge" ? "병합 중" : "분리 저장 중";
  try {
    const data = await fetchJson("/api/company-master/duplicates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, candidateKey, companyIds })
    });
    state.companyMaster = data;
    if (state.data) state.data.companyMaster = { ...(state.data.companyMaster || {}), ...data };
    renderCompanyMasterPanel();
    renderDecisionQueue();
    setStatus(action === "merge" ? "업체 병합 완료" : "분리 유지 저장");
  } catch (error) {
    if (els.companyMasterPanel) {
      els.companyMasterPanel.insertAdjacentHTML("afterbegin", `<div class="empty">중복 처리 실패: ${escapeHtml(error.message)}</div>`);
    }
    if (els.companyMasterState) els.companyMasterState.textContent = "오류";
  } finally {
    button.disabled = false;
  }
}

async function saveCompanyCorrection(button, clear = false) {
  const form = button?.closest("[data-company-manual-form]");
  const companyId = button?.dataset?.companyId || form?.dataset?.companyId || state.selectedItem?.companyId || "";
  if (!companyId) return;
  button.disabled = true;
  const selectedCompanyId = state.selectedItem?.companyId || companyId;
  const lodgingBasisTotal = form?.querySelector("[data-manual-lodging]")?.value || "";
  const dayUseBasisTotal = form?.querySelector("[data-manual-dayuse]")?.value || "";
  const note = form?.querySelector("[data-manual-note]")?.value || "";
  const emptySave = !clear && !String(lodgingBasisTotal).trim() && !String(dayUseBasisTotal).trim() && !String(note).trim();
  const shouldClear = clear || emptySave;
  setStatus(shouldClear ? "보정 해제 중" : "보정 저장 중");
  const payload = shouldClear
    ? { companyId, active: false }
    : {
        companyId,
        lodgingBasisTotal,
        dayUseBasisTotal,
        note
      };
  try {
    const data = await fetchJson("/api/company-master/manual-correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.companyMaster = data;
    if (state.activeRunId) {
      await loadRun(state.activeRunId);
      const updatedItem = (state.data?.availability?.items || []).find((item) => item.companyId === selectedCompanyId);
      if (updatedItem) state.selectedItem = updatedItem;
      if (state.selectedItem && els.detailSheet && !els.detailSheet.hidden) renderSheet();
    } else {
      renderCompanyMasterPanel();
      renderDecisionQueue();
    }
    setStatus(shouldClear ? "보정 해제 완료" : "보정 저장 완료");
  } catch (error) {
    setStatus("보정 저장 실패");
    if (form) form.insertAdjacentHTML("beforeend", `<div class="empty">보정 저장 실패: ${escapeHtml(error.message)}</div>`);
  } finally {
    button.disabled = false;
  }
}

async function saveCompanyAdminReview(button) {
  const companyId = button?.dataset?.companyId || "";
  const status = button?.dataset?.companyReviewAction || "";
  if (!companyId || !status) return;
  const control = button.closest("[data-company-review-control]");
  const existingCompany = (companyMasterSource().companies || []).find((row) => row.companyId === companyId);
  const note = control?.querySelector("[data-company-review-note]")?.value
    ?? button.dataset.companyReviewNote
    ?? existingCompany?.adminReview?.note
    ?? "";
  const reviewContext = companyReviewContextFromButton(button, status);
  button.disabled = true;
  setStatus(status === "clear" ? "검증 해제 중" : "검증 저장 중");
  try {
    const data = await fetchJson("/api/company-master/admin-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, status, note, reviewContext })
    });
    state.companyMaster = data;
    if (state.data) state.data.companyMaster = { ...(state.data.companyMaster || {}), ...data };
    renderCompanyMasterPanel();
    renderDecisionQueue();
    renderTargets();
    if (state.selectedItem && els.detailSheet && !els.detailSheet.hidden) renderSheet();
    const outcome = companyAdminReviewOutcome(status);
    setStatus(status === "clear" ? "검증 해제 완료" : `${companyAdminReviewLabel(status)} 저장 완료 · ${outcome.label}`);
  } catch (error) {
    setStatus("검증 저장 실패");
    if (els.companyMasterPanel) {
      els.companyMasterPanel.insertAdjacentHTML("afterbegin", `<div class="empty">검증 저장 실패: ${escapeHtml(error.message)}</div>`);
    }
  } finally {
    button.disabled = false;
  }
}

async function applyCompanyCheckBulkReview(button) {
  const status = button?.dataset?.companyCheckBulkAction || "";
  if (!status) return;
  const { visibleEntries, filterLabel, checkQuery } = companyCheckVisibleEntries(companyMasterSource());
  const rows = visibleEntries
    .map((entry) => ({ entry, companyId: entry.company?.companyId || "" }))
    .filter((row) => row.companyId);
  if (!rows.length) {
    setStatus("일괄 처리할 판단 큐 결과 없음");
    return;
  }
  const label = companyAdminReviewLabel(status);
  const queryText = String(checkQuery || "").trim();
  const scopeText = `${filterLabel}${queryText ? ` / ${queryText}` : ""}`;
  if (rows.length > 20 && !window.confirm(`${scopeText} ${fmtNumber(rows.length)}개 업체를 '${label}' 상태로 일괄 저장할까요?`)) {
    return;
  }
  const panel = button.closest("[data-company-check-bulk]");
  const buttons = panel ? Array.from(panel.querySelectorAll("button")) : [button];
  const note = panel?.querySelector("[data-company-check-bulk-note]")?.value || `일괄 처리: ${scopeText}`;
  buttons.forEach((item) => { item.disabled = true; });
  setStatus(`${label} 일괄 저장 중 0/${fmtNumber(rows.length)}`);
  let latestData = null;
  let saved = 0;
  let failed = 0;
  for (const { companyId } of rows) {
    const reviewContext = companyReviewContextForCompany(companyId, status, "decision_queue_bulk");
    if (reviewContext) {
      reviewContext.summary = compactListText([
        `일괄 ${label}: ${scopeText}`,
        reviewContext.summary
      ], `일괄 ${label}`, 4);
    }
    try {
      latestData = await fetchJson("/api/company-master/admin-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, status, note, reviewContext })
      });
      saved += 1;
      setStatus(`${label} 일괄 저장 중 ${fmtNumber(saved)}/${fmtNumber(rows.length)}`);
    } catch {
      failed += 1;
    }
  }
  if (latestData) {
    state.companyMaster = latestData;
    if (state.data) state.data.companyMaster = { ...(state.data.companyMaster || {}), ...latestData };
    renderCompanyMasterPanel();
    renderDecisionQueue();
    renderTargets();
  } else {
    buttons.forEach((item) => { item.disabled = false; });
  }
  const outcome = companyAdminReviewOutcome(status);
  setStatus(failed ? `${label} 일괄 저장 ${fmtNumber(saved)}개 완료 · ${outcome.label} · 실패 ${fmtNumber(failed)}개` : `${label} 일괄 저장 ${fmtNumber(saved)}개 완료 · ${outcome.label}`);
}

async function saveCompanySalesContact(button) {
  const companyId = button?.dataset?.companyId || button?.closest("[data-sales-contact-form]")?.dataset?.companyId || "";
  const form = button?.closest("[data-sales-contact-form]");
  if (!companyId || !form) return;
  const payload = {
    companyId,
    status: form.querySelector("[data-sales-contact-status]")?.value || "not_contacted",
    responseStatus: form.querySelector("[data-sales-response-status]")?.value || "not_recorded",
    responseReason: form.querySelector("[data-sales-response-reason]")?.value || "none",
    channel: form.querySelector("[data-sales-contact-channel]")?.value || "",
    contactPerson: form.querySelector("[data-sales-contact-person]")?.value || "",
    proposal: form.querySelector("[data-sales-contact-proposal]")?.value || "",
    nextActionAt: form.querySelector("[data-sales-contact-next]")?.value || "",
    note: form.querySelector("[data-sales-contact-note]")?.value || ""
  };
  button.disabled = true;
  setStatus("컨택 상태 저장 중");
  try {
    const data = await fetchJson("/api/company-master/sales-contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.companyMaster = data;
    if (state.data) state.data.companyMaster = { ...(state.data.companyMaster || {}), ...data };
    renderTargets();
    renderCompanyMasterPanel();
    renderDecisionQueue();
    setStatus(`${salesContactMeta(payload.status).label} / ${salesResponseMeta(payload.responseStatus).label} 저장 완료`);
  } catch (error) {
    setStatus("컨택 상태 저장 실패");
    form.insertAdjacentHTML("afterbegin", `<div class="empty">컨택 저장 실패: ${escapeHtml(error.message)}</div>`);
  } finally {
    button.disabled = false;
  }
}

async function applySalesGateBulkReview(button) {
  const status = button?.dataset?.salesGateBulkAction || "";
  if (!status) return;
  const selectedFilter = state.companyMasterFilters?.salesGate || "all";
  const filterLabel = salesGateFilterLabel(selectedFilter);
  const entries = salesGateFilteredEntries(salesGateReviewEntries(0), selectedFilter);
  const rows = entries
    .map((entry) => ({ entry, companyId: entry.company?.companyId || "" }))
    .filter((row) => row.companyId);
  if (!rows.length) {
    setStatus(`${filterLabel} 필터에서 일괄 처리할 보류 게이트 없음`);
    return;
  }
  const label = companyAdminReviewLabel(status);
  if (rows.length > 12 && !window.confirm(`${filterLabel} 보류 게이트 ${fmtNumber(rows.length)}개 업체를 '${label}' 상태로 일괄 저장할까요?`)) {
    return;
  }
  const panel = button.closest("[data-sales-gate-bulk]");
  const buttons = panel ? Array.from(panel.querySelectorAll("button")) : [button];
  const note = panel?.querySelector("[data-sales-gate-bulk-note]")?.value || `보류 게이트 일괄 처리: ${filterLabel} ${label}`;
  buttons.forEach((item) => { item.disabled = true; });
  setStatus(`${filterLabel} ${label} 보류 게이트 일괄 저장 중 0/${fmtNumber(rows.length)}`);
  let latestData = null;
  let saved = 0;
  let failed = 0;
  for (const { companyId } of rows) {
    const reviewContext = companyReviewContextForCompany(companyId, status, "sales_gate_bulk");
    if (reviewContext) {
      reviewContext.summary = compactListText([
        `보류 게이트 일괄 ${filterLabel} ${label}`,
        reviewContext.summary
      ], `보류 게이트 일괄 ${filterLabel} ${label}`, 4);
    }
    try {
      latestData = await fetchJson("/api/company-master/admin-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, status, note, reviewContext })
      });
      saved += 1;
      setStatus(`${filterLabel} ${label} 보류 게이트 일괄 저장 중 ${fmtNumber(saved)}/${fmtNumber(rows.length)}`);
    } catch {
      failed += 1;
    }
  }
  if (latestData) {
    state.companyMaster = latestData;
    if (state.data) state.data.companyMaster = { ...(state.data.companyMaster || {}), ...latestData };
    renderCompanyMasterPanel();
    renderDecisionQueue();
    renderTargets();
  }
  buttons.forEach((item) => { item.disabled = false; });
  const outcome = companyAdminReviewOutcome(status);
  setStatus(failed ? `${filterLabel} ${label} 일괄 저장 완료 · ${outcome.label} · 실패 ${fmtNumber(failed)}개` : `${filterLabel} ${label} 일괄 저장 완료 · ${outcome.label}`);
}

function exportSalesTargetsCsv() {
  const entries = companySalesBoardEntries();
  if (!entries.length) {
    setStatus("내보낼 컨택 리스트 없음");
    return;
  }
  const csv = salesTargetCsv(entries);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `glamping-sales-targets-${date}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(`컨택 리스트 ${fmtNumber(entries.length)}개 내보내기`);
}

function exportSalesGateCsv() {
  const selectedFilter = state.companyMasterFilters?.salesGate || "all";
  const filterLabel = salesGateFilterLabel(selectedFilter);
  const entries = salesGateFilteredEntries(salesGateReviewEntries(0), selectedFilter);
  if (!entries.length) {
    setStatus(`${filterLabel} 필터에서 내보낼 컨택 보류 사유 없음`);
    return;
  }
  const csv = salesGateCsv(entries, { filterLabel });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `glamping-sales-gate-${selectedFilter}-${date}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(`${filterLabel} 컨택 보류 사유 ${fmtNumber(entries.length)}개 내보내기`);
}

function exportDecisionQueueCsv() {
  const { visibleEntries, selectedFilter, filterLabel, checkQuery } = companyCheckVisibleEntries(companyMasterSource());
  if (!visibleEntries.length) {
    setStatus("내보낼 판단 큐 결과 없음");
    return;
  }
  const csv = decisionQueueCsv(visibleEntries, { filterLabel, query: checkQuery });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `glamping-decision-queue-${selectedFilter}-${date}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(`판단 큐 ${fmtNumber(visibleEntries.length)}개 내보내기`);
}

function exportCollectionQualityCsv() {
  const profile = collectionQualityMonitorProfile();
  if (!profile.hasData) {
    setStatus("내보낼 수집 품질 데이터 없음");
    return;
  }
  const csv = collectionQualityCsv(profile);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `glamping-collection-quality-${date}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(`수집 품질 리포트 ${fmtNumber(profile.recrawlRows.length)}개 우선순위 내보내기`);
}

function exportRecrawlAutomationCsv() {
  const entries = companyDecisionQueueEntries(companyMasterSource());
  const profile = recrawlAutomationProfile(entries);
  if (!profile.needsExecution.length && !profile.transitions.length && !profile.compared.length) {
    setStatus("내보낼 재수집 자동화 데이터 없음");
    return;
  }
  const csv = recrawlAutomationCsv(entries);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `glamping-recrawl-automation-${date}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(`재수집 자동화 리포트 ${fmtNumber(profile.needsExecution.length + profile.transitions.length)}개 내보내기`);
}

function exportAdminReviewAuditCsv() {
  const rows = adminReviewAuditRows(companyMasterSource());
  if (!rows.length) {
    setStatus("내보낼 관리자 판단 이력이 없음");
    return;
  }
  const csv = adminReviewAuditCsv(companyMasterSource());
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `glamping-admin-review-audit-${date}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(`관리자 판단 이력 ${fmtNumber(rows.length)}건 내보내기`);
}

async function copyTextToClipboard(text = "") {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      // Fall through to textarea copy for non-secure contexts or denied clipboard permissions.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand("copy");
  textarea.remove();
  return ok;
}

async function copySalesProposal(button, type = "script") {
  const companyId = button?.dataset?.companyId || "";
  const entry = companySalesBoardEntries().find((row) => row.company.companyId === companyId);
  if (!entry) {
    setStatus("복사할 영업 문구를 찾지 못했습니다.");
    return;
  }
  const proposal = companySalesProposalProfile(entry.company, entry);
  const text = type === "call" ? proposal.callNote : proposal.script;
  button.disabled = true;
  try {
    const ok = await copyTextToClipboard(text);
    setStatus(ok ? (type === "call" ? "전화 메모 복사 완료" : "컨택 문구 복사 완료") : "복사 실패");
  } catch (error) {
    setStatus(`복사 실패: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function applyCollectionQualitySetting(button) {
  const range = button?.dataset?.qualityRange || "1-20";
  const mode = button?.dataset?.qualityMode || "precision";
  const keyword = button?.dataset?.qualityKeyword || activeKeyword();
  if (els.keywordInput) els.keywordInput.value = keyword;
  if (els.searchModeInput) els.searchModeInput.value = correctedSearchMode(keyword, "keyword");
  if (els.productModeInput) els.productModeInput.value = "all";
  if (els.collectionModeInput) els.collectionModeInput.value = mode;
  if (els.detailRankRangesInput) {
    els.detailRankRangesInput.disabled = mode === "fast";
    els.detailRankRangesInput.value = mode === "fast" ? "" : range;
  }
  syncCollectionModeInputs();
  setActiveTab("admin");
  if (els.crawlStatus) {
    const detail = mode === "fast" ? "빠른 순위 · 상세 생략" : `정밀분석 · 상세 ${range}위`;
    els.crawlStatus.textContent = `${keyword} 수집 설정을 적용했습니다. ${detail}. 조건을 확인한 뒤 수집 실행을 누르세요.`;
  }
  setStatus("수집 품질 권장 설정 적용");
  window.requestAnimationFrame(() => {
    els.crawlForm?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function applyQueueRecrawlSetting(button) {
  const companyId = button?.dataset?.queueRecrawlCompany || "";
  const company = (companyMasterSource().companies || []).find((row) => row.companyId === companyId);
  if (!company) {
    setStatus("재수집 설정 실패");
    return;
  }
  const decision = companyDecisionQueueProfile(company);
  const profile = companyNeedsCorrection(company);
  const plan = applyRecrawlRangeOverride(companyQueueRecrawlPlan(company, profile, decision), button?.dataset?.queueRecrawlRange || "");
  const eta = crawlEtaForPlan(plan);
  state.pendingRecrawlContext = {
    type: "company",
    key: crawlEtaKey(plan),
    label: "개별 재수집",
    count: 1,
    companyIds: [company.companyId || ""].filter(Boolean),
    companyNames: [company.primaryName || ""].filter(Boolean),
    keyword: plan.keyword || activeKeyword(),
    range: plan.range || "1-20",
    regionScope: plan.regionScope || "",
    keywordSource: plan.keywordSource || "업체 기준",
    checkIn: plan.checkIn || "",
    checkOut: plan.checkOut || "",
    etaSeconds: eta.estimatedTotalSeconds || 0,
    source: button?.dataset?.queueRecrawlSource || "decision_queue"
  };
  const keyword = plan.keyword || activeKeyword();
  if (els.keywordInput) els.keywordInput.value = keyword;
  if (els.checkInInput && plan.checkIn) els.checkInInput.value = plan.checkIn;
  if (els.checkOutInput && plan.checkOut) els.checkOutInput.value = plan.checkOut;
  if (els.searchModeInput) els.searchModeInput.value = correctedSearchMode(keyword, plan.searchMode || "keyword");
  if (els.productModeInput) els.productModeInput.value = plan.productMode || "all";
  if (els.collectionModeInput) els.collectionModeInput.value = "precision";
  if (els.detailRankRangesInput) {
    els.detailRankRangesInput.disabled = false;
    els.detailRankRangesInput.value = plan.range || "1-20";
  }
  syncCollectionModeInputs();
  setActiveTab("admin");
  if (els.crawlStatus) {
    els.crawlStatus.textContent = `${company.primaryName || "업체"} 재수집 설정을 적용했습니다. 상세 ${plan.range || "1-20"}위 · 예상 ${crawlEtaShortText(eta)} · ${crawlEtaSourceText(eta)}. 조건을 확인한 뒤 수집 실행을 누르세요.`;
  }
  setStatus("재수집 설정 적용");
  window.requestAnimationFrame(() => {
    els.crawlForm?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function applyRecrawlBatchSetting(button) {
  const key = button?.dataset?.recrawlBatchKey || "";
  const source = button?.dataset?.recrawlBatchSource || "decision_queue";
  const entries = source === "sales_gate" ? salesGateReviewEntries(0) : companyDecisionQueueEntries(companyMasterSource());
  const rows = source === "sales_gate" ? salesGateRecrawlRows(entries) : recrawlAutomationProfile(entries).needsExecution;
  const batch = recrawlAutomationBatches(rows).find((row) => row.key === key);
  if (!batch) {
    setStatus("묶음 재수집 설정 실패");
    return;
  }
  const plan = applyRecrawlRangeOverride(batch.plan || {}, button?.dataset?.recrawlBatchRange || "");
  const eta = button?.dataset?.recrawlBatchRange ? crawlEtaForPlan(plan) : (batch.eta || crawlEtaForPlan(plan));
  state.pendingRecrawlContext = {
    type: "batch",
    key: crawlEtaKey(plan),
    batchKey: batch.key,
    label: "묶음 재수집",
    count: batch.count || 0,
    companyIds: batch.rows.map((row) => row.company.companyId || "").filter(Boolean),
    companyNames: batch.names || [],
    keyword: plan.keyword || activeKeyword(),
    range: plan.range || plan.detailRankRanges || "1-20",
    regionScope: plan.regionScope || batch.regionScopes?.join("/") || "",
    checkIn: plan.checkIn || "",
    checkOut: plan.checkOut || "",
    savedSeconds: batch.savedSeconds || 0,
    etaSeconds: eta.estimatedTotalSeconds || 0,
    source: source === "sales_gate" ? "sales_gate_batch" : "decision_queue_batch"
  };
  const keyword = plan.keyword || activeKeyword();
  if (els.keywordInput) els.keywordInput.value = keyword;
  if (els.checkInInput && plan.checkIn) els.checkInInput.value = plan.checkIn;
  if (els.checkOutInput && plan.checkOut) els.checkOutInput.value = plan.checkOut;
  if (els.searchModeInput) els.searchModeInput.value = correctedSearchMode(keyword, plan.searchMode || "keyword");
  if (els.productModeInput) els.productModeInput.value = plan.productMode || "all";
  if (els.collectionModeInput) els.collectionModeInput.value = plan.collectionMode || "precision";
  if (els.detailRankRangesInput) {
    els.detailRankRangesInput.disabled = false;
    els.detailRankRangesInput.value = plan.range || plan.detailRankRanges || "1-20";
  }
  syncCollectionModeInputs();
  setActiveTab("admin");
  if (els.crawlStatus) {
    const saved = batch.savedSeconds ? ` · 개별 실행 대비 ${formatElapsed(batch.savedSeconds)} 절감` : "";
    const label = source === "sales_gate" ? "보류 업체" : "후보";
    els.crawlStatus.textContent = `${fmtNumber(batch.count)}개 ${label} 묶음 재수집 설정을 적용했습니다. 상세 ${plan.range || plan.detailRankRanges || "1-20"}위 · 예상 ${crawlEtaShortText(eta)} · ${crawlEtaSourceText(eta)}${saved}.`;
  }
  setStatus("묶음 재수집 설정 적용");
  window.requestAnimationFrame(() => {
    els.crawlForm?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function backfillCompanyMaster(button) {
  if (!button) return;
  button.disabled = true;
  if (els.companyMasterState) els.companyMasterState.textContent = "백필 중";
  setStatus("기존 결과 반영 중");
  try {
    const data = await fetchJson("/api/company-master/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    state.companyMaster = data;
    if (state.data) state.data.companyMaster = { ...(state.data.companyMaster || {}), ...data };
    renderCompanyMasterPanel();
    renderDecisionQueue();
    setStatus(`백필 완료: ${fmtNumber(data.backfill?.processedRuns || 0)}개 결과`);
  } catch (error) {
    if (els.companyMasterPanel) {
      els.companyMasterPanel.insertAdjacentHTML("afterbegin", `<div class="empty">백필 실패: ${escapeHtml(error.message)}</div>`);
    }
    if (els.companyMasterState) els.companyMasterState.textContent = "오류";
    setStatus("백필 실패");
  } finally {
    button.disabled = false;
  }
}

async function loadRuns(selectLatest = false) {
  if (!isAdminRole()) {
    state.runs = [];
    state.activeRunId = null;
    state.data = null;
    if (els.runSelect) els.runSelect.innerHTML = "";
    renderB2BSearchPanel();
    renderB2BEmptyPanels();
    setStatus("검색 대기");
    return;
  }
  setStatus("결과 로딩");
  const data = await fetchJson("/api/runs");
  state.runs = data.runs || [];
  els.runSelect.innerHTML = state.runs.map((run) => `<option value="${escapeHtml(run.id)}">${escapeHtml(run.label || run.id)}</option>`).join("");
  if (!state.runs.length) {
    renderB2BSearchPanel();
    const emptyText = isAdminRole() ? "실행 결과가 없습니다. 관리 탭에서 새 수집을 실행하세요." : "검색어를 입력하면 새 경쟁 리포트를 수집합니다.";
    if (els.reportBody) {
      els.reportBody.innerHTML = isAdminRole()
        ? `<div class="empty">${escapeHtml(emptyText)}</div>`
        : renderB2BPreSearchMyLodge();
    }
    els.companyList.innerHTML = `<div class="empty">${escapeHtml(emptyText)}</div>`;
    if (els.decisionQueueCount) els.decisionQueueCount.textContent = "0 대기";
    if (els.decisionQueueList) els.decisionQueueList.innerHTML = `<div class="empty">실행 결과가 없습니다. 수집 후 판단 큐가 생성됩니다.</div>`;
    setStatus("결과 없음");
    return;
  }
  if (selectLatest || !state.activeRunId || !state.runs.some((run) => run.id === state.activeRunId)) {
    state.activeRunId = state.runs[0].id;
  }
  els.runSelect.value = state.activeRunId;
  renderB2BSearchPanel();
  await loadRun(state.activeRunId);
}

async function loadRun(runId) {
  if (!runId) return;
  setStatus("데이터 로딩");
  const data = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
  state.data = data;
  state.activeRunId = runId;
  if (isAdminRole()) {
    await loadHistoryOps();
    await loadCompanyMasterSummary();
  } else {
    state.historyOps = null;
    state.companyMaster = null;
    state.crawlEtaByKey = {};
  }
  if (roleAllowsTab("dictionary")) syncDictionaryInputToActiveRun(true);
  if (els.runSelect) els.runSelect.value = runId;
  const run = data.run || {};
  if (els.keywordInput) els.keywordInput.value = run.keyword || (run.label || "").split("·")[0].trim() || els.keywordInput.value;
  if (els.searchModeInput) {
    const runMode = run.searchMode || (run.keywordType === "company" ? "company" : "keyword");
    els.searchModeInput.value = correctedSearchMode(run.keyword || "", runMode);
  }
  if (els.productModeInput && run.productMode) els.productModeInput.value = run.productMode;
  if (els.collectionModeInput) els.collectionModeInput.value = run.collectionMode || "precision";
  if (els.detailRankRangesInput) {
    const rawDetailRankRanges = String(run.detailRankRanges || "").trim();
    const useDefaultDetailRange = !rawDetailRankRanges || /^(none|skip|없음)$/i.test(rawDetailRankRanges);
    els.detailRankRangesInput.value = run.collectionMode === "fast"
      ? ""
      : (useDefaultDetailRange ? "1-20" : rawDetailRankRanges);
  }
  syncCollectionModeInputs();
  renderAll();
  setStatus("준비");
}

async function loadB2BHistoryRun(runId) {
  if (!runId || isAdminRole()) return;
  setStatus("검색 기록 로딩");
  const data = await fetchJson(`/api/member/runs/${encodeURIComponent(runId)}`);
  state.data = data;
  state.activeRunId = runId;
  state.runs = data.run ? [{ ...data.run, id: runId }] : [];
  state.activeTab = "report";
  renderAll();
  setStatus("준비");
}

function syncYeogiManualInterface() {
  const url = yeogiSearchUrl();
  if (els.yeogiLinkOutput) els.yeogiLinkOutput.value = url;
  if (els.yeogiCurrentKeyword) {
    els.yeogiCurrentKeyword.textContent = `${spacedGlampingKeyword(activeKeyword())} · ${productModeLabel(els.productModeInput?.value)} 기준`;
  }
  const text = els.yeogiImportInput?.value?.trim() || "";
  const lineCount = text ? text.split(/\r?\n/).filter(Boolean).length : 0;
  const ready = text.length >= 8 && state.activeRunId;
  if (els.yeogiPreviewStatus) {
    els.yeogiPreviewStatus.textContent = ready ? `${fmtNumber(lineCount)}줄 감지 · 통합 가능` : "붙여넣기 대기";
  }
  if (els.yeogiImportButton) els.yeogiImportButton.disabled = !ready;
}

function setYeogiBadge(text, tone = "") {
  els.yeogiManualBadge.textContent = text;
  els.yeogiManualBadge.className = `state-badge ${tone}`;
}

function csvExtractScript() {
  return `(() => {
  const rows = [...document.querySelectorAll("a, article, li, div")]
    .map((el) => el.innerText || "")
    .filter((text) => /글램핑|캠핑|카라반|펜션|원/.test(text))
    .slice(0, 80);
  copy(rows.join("\\n---\\n"));
})();`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyYeogiSearchLink() {
  const url = yeogiSearchUrl();
  if (els.yeogiLinkBox) els.yeogiLinkBox.hidden = false;
  if (els.yeogiLinkOutput) {
    els.yeogiLinkOutput.value = url;
    els.yeogiLinkOutput.select();
  }
  const copied = await copyText(url);
  els.yeogiImportStatus.textContent = copied ? "여기어때 링크를 복사했습니다." : "링크 입력창에서 직접 복사하세요.";
}

async function openYeogiSearch() {
  await copyYeogiSearchLink();
  window.open(yeogiSearchUrl(), "_blank", "noopener,noreferrer");
}

async function copyYeogiScript() {
  const script = csvExtractScript();
  if (els.yeogiScriptOutput) els.yeogiScriptOutput.value = script;
  if (els.yeogiScriptBox) els.yeogiScriptBox.hidden = false;
  const copied = await copyText(script);
  els.yeogiImportStatus.textContent = copied ? "PC용 추출 코드를 복사했습니다." : "코드창에서 직접 선택해 복사하세요.";
}

function toggleYeogiScriptBox() {
  if (!els.yeogiScriptOutput.value) els.yeogiScriptOutput.value = csvExtractScript();
  els.yeogiScriptBox.hidden = !els.yeogiScriptBox.hidden;
}

function clearYeogiImport() {
  els.yeogiImportInput.value = "";
  syncYeogiManualInterface();
  els.yeogiImportStatus.textContent = "입력값을 비웠습니다.";
}

async function submitYeogiImport() {
  const sourceText = els.yeogiImportInput.value.trim();
  if (!sourceText || !state.activeRunId) {
    els.yeogiImportStatus.textContent = "선택된 결과와 붙여넣은 내용이 필요합니다.";
    return;
  }
  setYeogiBadge("통합 중");
  els.yeogiImportStatus.textContent = "여기어때 데이터를 통합 중입니다.";
  els.yeogiImportButton.disabled = true;
  try {
    const selectedKey = companyKey(state.selectedItem?.name);
    const result = await fetchJson("/api/yeogi-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: state.activeRunId, sourceText })
    });
    state.runs = result.runs || state.runs;
    state.data = result.data || state.data;
    if (selectedKey) {
      const updatedItem = (state.data?.availability?.items || []).find((item) => companyKey(item.name) === selectedKey);
      if (updatedItem) state.selectedItem = updatedItem;
    }
    els.yeogiImportInput.value = "";
    setYeogiBadge("통합완료");
    els.yeogiImportStatus.textContent = `통합 완료: ${fmtNumber(result.importedCount || 0)}건 반영 · 화면 자동 갱신`;
    await loadHistoryOps();
    renderAll();
    if (state.selectedItem && els.detailSheet && !els.detailSheet.hidden) renderSheet();
  } catch (error) {
    setYeogiBadge("오류");
    els.yeogiImportStatus.textContent = `통합 실패: ${error.message}`;
  } finally {
    syncYeogiManualInterface();
  }
}

async function submitTrafficKeys(event) {
  event.preventDefault();
  els.trafficKeyStatus.textContent = "저장 중입니다.";
  try {
    const payload = {};
    [
      ["naverClientId", els.naverClientIdInput],
      ["naverClientSecret", els.naverClientSecretInput],
      ["searchadApiKey", els.searchadApiKeyInput],
      ["searchadSecretKey", els.searchadSecretKeyInput],
      ["searchadCustomerId", els.searchadCustomerIdInput]
    ].forEach(([key, input]) => {
      const value = input?.value?.trim();
      if (value) payload[key] = value;
    });
    if (!Object.keys(payload).length) {
      els.trafficKeyStatus.textContent = "입력된 새 키가 없습니다. 기존 키는 유지됩니다.";
      return;
    }
    const data = await fetchJson("/api/settings/traffic-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    renderTrafficState(data);
    els.trafficKeyForm.reset();
    els.trafficKeyStatus.textContent = "API 키를 저장했습니다. 연결을 확인합니다.";
    await verifyTrafficKeys();
  } catch (error) {
    els.trafficKeyStatus.textContent = `저장 실패: ${error.message}`;
  }
}

function trafficCheckLabel(name, check) {
  if (!check?.configured) return `${name}: 키 없음`;
  if (check.ok) return `${name}: 정상`;
  const status = check.status ? ` ${check.status}` : "";
  return `${name}: 실패${status} · ${check.message || "확인 필요"}`;
}

function renderTrafficVerification(data) {
  if (!els.trafficKeyVerifyResult) return;
  const verification = data?.verification;
  if (!verification) {
    els.trafficKeyVerifyResult.textContent = "저장 후 연결 테스트로 실제 인증 상태를 확인합니다.";
    return;
  }
  const datalab = trafficCheckLabel("DataLab", verification.datalab);
  const searchad = trafficCheckLabel("SearchAd", verification.searchad);
  els.trafficKeyVerifyResult.textContent = `${datalab} / ${searchad}`;
}

async function verifyTrafficKeys() {
  if (!els.trafficKeyVerifyButton) return;
  els.trafficKeyVerifyButton.disabled = true;
  els.trafficKeyStatus.textContent = "API 연결을 테스트 중입니다.";
  try {
    const data = await fetchJson("/api/settings/traffic-keys/verify", { method: "POST" });
    renderTrafficState(data);
    renderTrafficVerification(data);
    const datalabOk = Boolean(data?.verification?.datalab?.ok);
    const searchadOk = Boolean(data?.verification?.searchad?.ok);
    els.trafficKeyStatus.textContent = datalabOk && searchadOk
      ? "API 연결이 정상입니다."
      : "일부 API 연결에 문제가 있습니다. 아래 결과를 확인하세요.";
  } catch (error) {
    els.trafficKeyStatus.textContent = `연결 테스트 실패: ${error.message}`;
  } finally {
    els.trafficKeyVerifyButton.disabled = false;
  }
}

function renderTrafficState(data) {
  state.trafficKeyState = data || null;
  const datalabOk = data?.verification?.datalab?.ok;
  const searchadOk = data?.verification?.searchad?.ok;
  const configured = data?.datalabConfigured || data?.searchadConfigured;
  els.trafficApiState.textContent = datalabOk || searchadOk
    ? "연동 정상"
    : configured
      ? "키 저장됨"
      : "미설정";
  renderTrafficVerification(data);
  renderDemand();
}

async function loadTrafficState() {
  if (!isAdminRole()) {
    state.trafficKeyState = null;
    return;
  }
  try {
    renderTrafficState(await fetchJson("/api/settings/traffic-keys"));
  } catch {
    renderTrafficState(null);
  }
}

async function logout() {
  try {
    await fetchJson("/api/logout", { method: "POST" });
  } catch {
    // Even if the session is already gone, return the user to the login screen.
  } finally {
    location.replace("/login");
  }
}

async function submitCrawl(event) {
  event.preventDefault();
  const submitButton = els.crawlForm?.querySelector('button[type="submit"]');
  const requestedMode = els.searchModeInput?.value || "keyword";
  const resolvedMode = correctedSearchMode(els.keywordInput.value.trim(), requestedMode);
  if (els.searchModeInput && resolvedMode !== requestedMode) {
    els.searchModeInput.value = resolvedMode;
    els.crawlStatus.textContent = "지역 키워드로 판단되어 키워드/권역 모드로 자동 전환했습니다.";
  }
  const collectionMode = "precision";
  const rawDetailRankRanges = els.detailRankRangesInput?.value?.trim() || "";
  const detailRankRanges = /^(none|skip|없음)$/i.test(rawDetailRankRanges) ? "1-10" : (rawDetailRankRanges || "1-10");
  const payload = {
    keyword: els.keywordInput.value.trim(),
    checkIn: els.checkInInput.value,
    checkOut: els.checkOutInput.value,
    searchMode: resolvedMode,
    productMode: els.productModeInput.value,
    collectionMode,
    detailRankRanges
  };
  if (recrawlContextMatchesPayload(state.pendingRecrawlContext, payload)) {
    payload.recrawlContext = state.pendingRecrawlContext;
  }
  if (submitButton?.disabled) return;
  if (submitButton) submitButton.disabled = true;
  const detailText = `상세 ${payload.detailRankRanges || "1-10"}위`;
  const preview = crawlPreviewMeta(payload);
  const recrawlText = recrawlContextStatusText(payload.recrawlContext);
  setCrawlProgress(
    true,
    "수집 실행 중",
    `${recrawlText ? `${recrawlText} · ` : ""}${collectionModeLabel(payload.collectionMode)} · ${searchModeLabel(payload.searchMode)} · ${detailText}`,
    preview
  );
  els.crawlStatus.textContent = `${recrawlText ? `${recrawlText} 기준 ` : ""}${collectionModeLabel(payload.collectionMode)} 수집을 시작했습니다. ${detailText}. 예상 ${formatElapsed(preview.estimatedTotalSeconds)} · 완료 ${formatClockTime(preview.estimatedCompleteAt)}.`;
  setStatus("수집 중");
  scheduleCrawlStatusPoll(1500, false);
  try {
    const result = await fetchJson("/api/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.runs = result.runs || state.runs;
    state.activeRunId = result.runId || state.runs[0]?.id;
    await loadRuns(false);
    clearCrawlStatusTimer();
    setCrawlProgress(false);
    els.crawlStatus.textContent = payload.recrawlContext
      ? `${recrawlContextStatusText(payload.recrawlContext)} 완료. 화면을 갱신했습니다.`
      : "수집 완료. 화면을 갱신했습니다.";
    if (payload.recrawlContext) state.pendingRecrawlContext = null;
    setActiveTab("rank");
  } catch (error) {
    if (error.status === 409) {
      setCrawlProgress(true, "수집 대기 중", "이미 진행 중인 수집이 끝나면 결과를 자동으로 불러옵니다.", { stages: crawlStageFallbacks() });
      els.crawlStatus.textContent = `${error.message} 결과가 생기면 자동으로 갱신합니다.`;
      setStatus("수집 중");
      pollCrawlStatusUntilIdle(true);
    } else {
      clearCrawlStatusTimer();
      setCrawlProgress(false);
      els.crawlStatus.textContent = `수집 실패: ${error.message}`;
      setStatus("수집 실패");
    }
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

function setDefaultDates() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const start = new Date(kst);
  const end = new Date(kst);
  end.setUTCDate(end.getUTCDate() + (DEFAULT_BOOKING_DAYS > 1 ? DEFAULT_BOOKING_DAYS - 1 : 1));
  if (els.checkInInput && !els.checkInInput.value) els.checkInInput.value = start.toISOString().slice(0, 10);
  if (els.checkOutInput && !els.checkOutInput.value) els.checkOutInput.value = end.toISOString().slice(0, 10);
  updateCrawlSpeedPreview();
}

function bindEvents() {
  document.querySelectorAll(".bottom-nav button").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });
  document.addEventListener("click", (event) => {
    const open = event.target.closest("[data-open-company]");
    if (open) openSheet(open.dataset.openCompany);
    if (event.target.closest("[data-b2b-history-toggle]")) {
      state.b2bHistoryExpanded = !state.b2bHistoryExpanded;
      renderB2BSearchHistoryPanel();
      return;
    }
    const b2bHistoryRun = event.target.closest("[data-b2b-history-run-id]");
    if (b2bHistoryRun) {
      loadB2BHistoryRun(b2bHistoryRun.dataset.b2bHistoryRunId).catch((error) => {
        if (els.b2bSearchStatus) els.b2bSearchStatus.textContent = error.message;
      });
      return;
    }
    const b2bRun = event.target.closest("[data-b2b-run-id]");
    if (b2bRun) {
      state.b2bSearchQuery = runSearchTitle(state.runs.find((run) => run.id === b2bRun.dataset.b2bRunId) || {});
      loadRun(b2bRun.dataset.b2bRunId).then(() => setActiveTab("report")).catch((error) => {
        setStatus("리포트 로딩 실패");
        if (els.b2bSearchStatus) els.b2bSearchStatus.textContent = error.message;
      });
      return;
    }
    const b2bQuery = event.target.closest("[data-b2b-query]");
    if (b2bQuery) {
      state.b2bSearchQuery = b2bQuery.dataset.b2bQuery || "";
      if (els.b2bSearchInput) els.b2bSearchInput.value = state.b2bSearchQuery;
      submitB2BSearch().catch((error) => {
        setStatus("리포트 검색 실패");
        if (els.b2bSearchStatus) els.b2bSearchStatus.textContent = error.message;
      });
      return;
    }
    const b2bKeywordApply = event.target.closest("[data-b2b-keyword-apply]");
    if (b2bKeywordApply) {
      state.b2bSearchQuery = b2bKeywordApply.dataset.b2bKeywordApply || "";
      if (els.b2bSearchInput) els.b2bSearchInput.value = state.b2bSearchQuery;
      renderB2BSearchPanel();
      els.b2bSearchPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (els.b2bSearchStatus) els.b2bSearchStatus.textContent = `${state.b2bSearchQuery} 검색어를 적용했습니다. 범위를 확인한 뒤 검색 실행을 누르세요.`;
      return;
    }
    if (event.target.closest("[data-b2b-room-segment-add]")) {
      updateB2BMyLodgeRoomSegments("add");
      return;
    }
    const roomSegmentRemove = event.target.closest("[data-b2b-room-segment-remove]");
    if (roomSegmentRemove) {
      updateB2BMyLodgeRoomSegments("remove", Number(roomSegmentRemove.dataset.b2bRoomSegmentRemove));
      return;
    }
    const interestLodgeEdit = event.target.closest("[data-b2b-interest-lodge-edit]");
    if (interestLodgeEdit) {
      editB2BInterestLodge(interestLodgeEdit.dataset.b2bInterestLodgeEdit || "");
      return;
    }
    const interestLodgeDelete = event.target.closest("[data-b2b-interest-lodge-delete]");
    if (interestLodgeDelete) {
      deleteB2BInterestLodge(interestLodgeDelete.dataset.b2bInterestLodgeDelete || "");
      return;
    }
    if (event.target.closest("[data-b2b-my-lodge-collect]")) {
      collectB2BMyLodgeByName().catch((error) => {
        state.b2bMyLodgeCollecting = false;
        state.b2bMyLodgeCollectStatus = `자동 수집 실패: ${error.message}`;
        renderReport();
      });
      return;
    }
    if (event.target.closest("[data-b2b-my-lodge-save]")) {
      saveB2BMyLodgeBenchmark();
      return;
    }
    if (event.target.closest("[data-b2b-my-lodge-clear]")) {
      clearB2BMyLodgeBenchmark();
      return;
    }
    const duplicateAction = event.target.closest("[data-company-duplicate-action]");
    if (duplicateAction) resolveCompanyDuplicate(duplicateAction);
    const saveCorrection = event.target.closest("[data-save-company-correction]");
    if (saveCorrection) saveCompanyCorrection(saveCorrection, false);
    const clearCorrection = event.target.closest("[data-clear-company-correction]");
    if (clearCorrection) saveCompanyCorrection(clearCorrection, true);
    const reviewAction = event.target.closest("[data-company-review-action]");
    if (reviewAction) saveCompanyAdminReview(reviewAction);
    const bulkReviewAction = event.target.closest("[data-company-check-bulk-action]");
    if (bulkReviewAction) applyCompanyCheckBulkReview(bulkReviewAction);
    const salesGateBulkAction = event.target.closest("[data-sales-gate-bulk-action]");
    if (salesGateBulkAction) applySalesGateBulkReview(salesGateBulkAction);
    const salesContact = event.target.closest("[data-save-sales-contact]");
    if (salesContact) saveCompanySalesContact(salesContact);
    const salesScript = event.target.closest("[data-copy-sales-script]");
    if (salesScript) copySalesProposal(salesScript, "script");
    const salesCallNote = event.target.closest("[data-copy-sales-call-note]");
    if (salesCallNote) copySalesProposal(salesCallNote, "call");
    if (event.target.closest("[data-export-sales-targets]")) exportSalesTargetsCsv();
    if (event.target.closest("[data-export-sales-gate]")) exportSalesGateCsv();
    if (event.target.closest("[data-export-decision-queue]")) exportDecisionQueueCsv();
    if (event.target.closest("[data-export-collection-quality]")) exportCollectionQualityCsv();
    if (event.target.closest("[data-export-recrawl-automation]")) exportRecrawlAutomationCsv();
    if (event.target.closest("[data-export-admin-review-audit]")) exportAdminReviewAuditCsv();
    const qualitySetting = event.target.closest("[data-apply-quality-setting]");
    if (qualitySetting) applyCollectionQualitySetting(qualitySetting);
    const queueRecrawl = event.target.closest("[data-queue-recrawl-company]");
    if (queueRecrawl) applyQueueRecrawlSetting(queueRecrawl);
    const recrawlBatch = event.target.closest("[data-recrawl-batch-key]");
    if (recrawlBatch) applyRecrawlBatchSetting(recrawlBatch);
    if (event.target.closest("[data-company-master-focus]")) {
      els.companyMasterPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    const checkFilter = event.target.closest("[data-company-check-filter]");
    if (checkFilter) {
      state.companyMasterFilters.check = checkFilter.dataset.companyCheckFilter || "priority";
      renderCompanyMasterPanel();
      renderDecisionQueue();
    }
    const salesGateFilter = event.target.closest("[data-sales-gate-filter]");
    if (salesGateFilter) {
      state.companyMasterFilters = state.companyMasterFilters || {};
      state.companyMasterFilters.salesGate = salesGateFilter.dataset.salesGateFilter || "all";
      renderTargets();
    }
    if (event.target.closest("[data-company-check-search-clear]")) {
      state.companyMasterFilters.checkQuery = "";
      renderCompanyMasterPanel();
      renderDecisionQueue();
    }
    const backfillButton = event.target.closest("[data-company-backfill]");
    if (backfillButton) backfillCompanyMaster(backfillButton);
    if (event.target.closest("[data-close-sheet]")) closeSheet();
    if (event.target.closest("[data-close-drawer]")) closeDrawer();
    const drawerTab = event.target.closest("[data-drawer-tab]");
    if (drawerTab) setActiveTab(drawerTab.dataset.drawerTab);
  });
  document.addEventListener("submit", (event) => {
    if (event.target.closest("[data-b2b-my-lodge-form]")) {
      event.preventDefault();
      saveB2BMyLodgeBenchmark();
    }
  });
  document.addEventListener("input", (event) => {
    const b2bSearch = event.target.closest("#b2bSearchInput");
    if (b2bSearch) {
      state.b2bSearchQuery = b2bSearch.value || "";
      renderB2BSearchPanel();
      return;
    }
    const b2bWonInput = event.target.closest("[data-b2b-won-input]");
    if (b2bWonInput) {
      formatB2BWonInput(b2bWonInput);
      return;
    }
    const checkSearch = event.target.closest("[data-company-check-search]");
    if (checkSearch) {
      state.companyMasterFilters.checkQuery = checkSearch.value || "";
      rerenderCompanyMasterPreservingSearch();
      return;
    }
    const search = event.target.closest("[data-company-master-search]");
    if (!search) return;
    state.companyMasterFilters.query = search.value || "";
    rerenderCompanyMasterPreservingSearch();
  });
  document.addEventListener("change", (event) => {
    const b2bRange = event.target.closest("#b2bSearchRangeInput");
    if (b2bRange) {
      state.b2bSearchRange = b2bRange.value === "1-20" ? "1-20" : "1-10";
      renderB2BSearchPanel();
      return;
    }
    const layer = event.target.closest("[data-company-master-layer]");
    if (layer) {
      state.companyMasterFilters.layer = layer.value || "all";
      renderCompanyMasterPanel();
      renderDecisionQueue();
    }
    const target = event.target.closest("[data-company-master-target]");
    if (target) {
      state.companyMasterFilters.target = target.value || "all";
      renderCompanyMasterPanel();
      renderDecisionQueue();
    }
  });
  els.openControlButton.addEventListener("click", openDrawer);
  document.querySelectorAll(".sheet-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSheetTab = button.dataset.sheetTab;
      renderSheet();
    });
  });
  document.addEventListener("keydown", (event) => {
    const mapCompany = event.target.closest?.(".company-map-marker[data-open-company]");
    if (mapCompany && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openSheet(mapCompany.dataset.openCompany);
      return;
    }
    if (event.key !== "Escape") return;
    closeSheet();
    closeDrawer();
  });
  els.runSelect.addEventListener("change", (event) => loadRun(event.target.value).catch((error) => {
    setStatus("오류");
    els.companyList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }));
  els.refreshRuns.addEventListener("click", () => loadRuns(true).catch((error) => {
    setStatus("오류");
    els.companyList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }));
  els.crawlForm.addEventListener("submit", submitCrawl);
  els.yeogiOpenButton.addEventListener("click", openYeogiSearch);
  els.yeogiCopyLinkButton.addEventListener("click", copyYeogiSearchLink);
  els.yeogiScriptButton.addEventListener("click", copyYeogiScript);
  els.yeogiToggleScriptButton.addEventListener("click", toggleYeogiScriptBox);
  els.yeogiImportInput.addEventListener("input", syncYeogiManualInterface);
  els.yeogiImportButton.addEventListener("click", submitYeogiImport);
  els.yeogiClearButton.addEventListener("click", clearYeogiImport);
  els.trafficKeyForm.addEventListener("submit", submitTrafficKeys);
  els.trafficKeyVerifyButton?.addEventListener("click", verifyTrafficKeys);
  els.logoutButton?.addEventListener("click", logout);
  els.headerLogoutButton?.addEventListener("click", logout);
  els.collectionModeInput?.addEventListener("change", syncCollectionModeInputs);
  els.crawlSpeedPresetRow?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-crawl-speed-preset]");
    if (!button) return;
    applyCrawlSpeedPreset(button.dataset.crawlSpeedPreset || "");
  });
  [els.keywordInput, els.checkInInput, els.checkOutInput, els.searchModeInput, els.productModeInput, els.detailRankRangesInput].forEach((input) => {
    input?.addEventListener("input", updateCrawlSpeedPreview);
    input?.addEventListener("change", updateCrawlSpeedPreview);
  });
  els.dictionarySearchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    runDictionarySearch();
  });
  els.b2bSearchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitB2BSearch().catch((error) => {
      setStatus("리포트 검색 실패");
      if (els.b2bSearchStatus) els.b2bSearchStatus.textContent = error.message;
    });
  });
  els.dictionaryQuickButtons?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-location-query]");
    if (!button) return;
    runDictionarySearch(button.dataset.locationQuery);
  });
  els.dictionaryResult?.addEventListener("click", (event) => {
    const requestButton = event.target.closest("[data-location-request-action]");
    if (requestButton) {
      saveLocationCardRequestQueueAction(requestButton);
      return;
    }
    const candidateButton = event.target.closest("[data-location-candidate-action]");
    if (candidateButton) {
      saveLocationCardCandidateAction(candidateButton);
      return;
    }
    const button = event.target.closest("[data-location-query]");
    if (!button) return;
    runDictionarySearch(button.dataset.locationQuery);
  });
}

async function init() {
  ensureCrawlControls();
  try {
    await loadSession();
    syncCollectionModeInputs();
    bindEvents();
    setDefaultDates();
    if (isAdminRole()) {
      await Promise.all([loadRuns(true), loadLocationDictionary(), loadTrafficState(), loadLocationCardRequests()]);
    } else {
      state.runs = [];
      state.activeRunId = null;
      state.data = null;
      await loadMemberSearchHistory();
      renderB2BEmptyPanels();
    }
    renderB2BSearchPanel();
    if (isAdminRole()) pollCrawlStatusUntilIdle(false);
  } catch (error) {
    setStatus("오류");
    els.pageSubtitle.textContent = error.message;
    els.companyList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    if (isAdminRole()) loadLocationDictionary();
  }
}

init();
