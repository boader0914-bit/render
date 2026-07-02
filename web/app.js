const state = {
  runs: [],
  data: null,
  activeRunId: null,
  activeTab: "report",
  selectedItem: null,
  selectedSheetTab: "booking",
  mapData: null,
  mapPromise: null,
  dictionary: null,
  historyOps: null,
  companyMaster: null,
  companyMasterFilters: {
    query: "",
    layer: "all",
    target: "all",
    check: "priority"
  },
  selectedLocationCard: null,
  dictionarySyncedRunId: null,
  trafficKeyState: null,
  crawlStatusTimer: null
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
  keywordInput: document.getElementById("keywordInput"),
  checkInInput: document.getElementById("checkInInput"),
  checkOutInput: document.getElementById("checkOutInput"),
  searchModeInput: document.getElementById("searchModeInput"),
  productModeInput: document.getElementById("productModeInput"),
  collectionModeInput: document.getElementById("collectionModeInput"),
  detailRankRangesInput: document.getElementById("detailRankRangesInput"),
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

function syncCollectionModeInputs() {
  if (!els.collectionModeInput || !els.detailRankRangesInput) return;
  const fast = els.collectionModeInput.value === "fast";
  els.detailRankRangesInput.disabled = fast;
  els.detailRankRangesInput.placeholder = fast ? "빠른 순위는 상세 생략" : "예: 1-5,10-20";
  if (!fast && !els.detailRankRangesInput.value.trim()) els.detailRankRangesInput.value = "1-20";
}

const REGIONAL_GLAMPING_BASES = new Set([
  "\uACBD\uB0A8", "\uACBD\uC0C1\uB0A8\uB3C4", "\uACBD\uB0A8\uB3C4",
  "\uACBD\uBD81", "\uACBD\uC0C1\uBD81\uB3C4", "\uACBD\uBD81\uB3C4",
  "\uACBD\uAE30", "\uACBD\uAE30\uB3C4", "\uACBD\uAE30\uBD81\uBD80", "\uACBD\uAE30\uB0A8\uBD80", "\uC218\uB3C4\uAD8C", "\uC11C\uC6B8\uADFC\uAD50",
  "\uAC15\uC6D0", "\uAC15\uC6D0\uB3C4", "\uC81C\uC8FC", "\uC81C\uC8FC\uB3C4",
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

function compactCrawlKeyword(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "");
}

function looksLikeRegionalGlampingKeyword(value) {
  const compact = compactCrawlKeyword(value);
  const glamping = "\uAE00\uB7A8\uD551";
  if (!compact.endsWith(glamping)) return false;
  const base = compact.slice(0, -glamping.length);
  if (!base || base.length > 10) return false;
  const withoutAdminSuffix = base.replace(/(\uD2B9\uBCC4\uC790\uCE58\uB3C4|\uAD11\uC5ED\uC2DC|\uD2B9\uBCC4\uC2DC|\uD2B9\uBCC4\uC790\uCE58\uC2DC|\uC790\uCE58\uB3C4|\uC790\uCE58\uC2DC|\uC2DC|\uAD70|\uAD6C|\uB3C4)$/u, "");
  return REGIONAL_GLAMPING_BASES.has(base) || REGIONAL_GLAMPING_BASES.has(withoutAdminSuffix);
}

function correctedSearchMode(keyword, mode) {
  return mode === "company" && looksLikeRegionalGlampingKeyword(keyword) ? "keyword" : mode;
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
  const detail = basis.collectionMode === "fast" ? "상세 생략" : `상세 ${basis.detailRankRanges || "1-20"}위`;
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
      : { key: "inventory", label: "재고/가격 확인", seconds: productSeconds + rangeSeconds, detail: `상세 ${payload.detailRankRanges || "1-20"}위의 날짜별 수량과 요일별 가격을 확인합니다.` },
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
      setCrawlProgress(
        true,
        delayed ? "예상보다 지연 중" : (stage.label ? `${stage.label} 진행 중` : "수집 진행 중"),
        delayed
          ? `예상 완료 시간을 ${formatElapsed(status.delayedSeconds) || "초과"} 넘겼습니다. 마지막 단계와 저장 처리를 계속 확인하고 있습니다.`
          : (stage.detail || `네이버·NOL·떠나요를 확인하고 있습니다${elapsed ? ` · ${elapsed} 경과` : ""}${estimate ? ` · ${estimate}` : ""}.`),
        status
      );
      if (els.crawlStatus) {
        els.crawlStatus.textContent = delayed
          ? `수집이 예상보다 오래 걸리고 있습니다${elapsed ? ` (${elapsed} 경과)` : ""}${estimate ? ` · ${estimate}` : ""}. 완료되면 결과를 자동 갱신합니다.`
          : `수집이 진행 중입니다${elapsed ? ` (${elapsed} 경과)` : ""}${estimate ? ` · ${estimate}` : ""}. 완료되면 결과를 자동 갱신합니다.`;
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
    const url = externalPlatformUrl(row.url);
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

function salesStats(item = {}, kind = "lodging") {
  const run = state.data?.run || {};
  const days = bookingDays(run);
  const basisDate = monthDay(run.checkIn) || "기준일";
  if (kind === "lodging") {
    const rows = weeklyRows(item);
    const weeklySold = finiteNumber(item.weeklyTotalSoldOut, NaN);
    const weeklySupply = finiteNumber(item.weeklyTotalStock, NaN);
    if (Number.isFinite(weeklySold) && Number.isFinite(weeklySupply) && weeklySupply > 0) {
      const basisTotal = finiteNumber(item.weeklyBasisTotal, 0);
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
      const basisTotal = basisTotalForRows(rows, item.weeklyBasisTotal, activeManualCorrection(item));
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
    const basisTotal = finiteNumber(item.dayUseWeeklyBasisTotal, 0);
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
    const basisTotal = basisTotalForRows(rows, item.dayUseWeeklyBasisTotal, activeManualCorrection(item));
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
  const weeklyPriced = optionalNumber(kind === "day" ? item.dayUseWeeklyPricedSoldOut : item.weeklyPricedSoldOut);
  const weeklyMissing = optionalNumber(kind === "day" ? item.dayUseWeeklyMissingPriceSoldOut : item.weeklyMissingPriceSoldOut);
  const weeklyAvg = optionalNumber(kind === "day" ? item.dayUseWeeklyAvgSoldUnitPrice : item.weeklyAvgSoldUnitPrice);
  const weeklyDetail = kind === "day" ? item.dayUseWeeklyRevenueDetail : item.weeklyRevenueDetail;
  const weeklyByDay = kind === "day" ? item.dayUseWeeklyRevenueByDayType : item.weeklyRevenueByDayType;
  const weeklyOffline = kind === "day" ? item.dayUseWeeklyOfflineReservationDetail : item.weeklyOfflineReservationDetail;
  const hasWeekly = [weeklyRevenue, weeklyPriced, weeklyMissing, weeklyAvg].some(Number.isFinite);
  if (hasWeekly) {
    return {
      revenue: Number.isFinite(weeklyRevenue) ? weeklyRevenue : 0,
      pricedSoldOut: Number.isFinite(weeklyPriced) ? weeklyPriced : 0,
      missingPriceSoldOut: Number.isFinite(weeklyMissing) ? weeklyMissing : 0,
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
  const basisPriced = optionalNumber(kind === "day" ? item.basisDayUsePricedSoldOut : item.basisLodgingPricedSoldOut);
  const basisMissing = optionalNumber(kind === "day" ? item.basisDayUseMissingPriceSoldOut : item.basisLodgingMissingPriceSoldOut);
  const basisAvg = optionalNumber(kind === "day" ? item.basisDayUseAvgSoldUnitPrice : item.basisLodgingAvgSoldUnitPrice);
  const hasBasis = [basisRevenue, basisPriced, basisMissing, basisAvg].some(Number.isFinite);
  if (hasBasis) {
    return {
      revenue: Number.isFinite(basisRevenue) ? basisRevenue : 0,
      pricedSoldOut: Number.isFinite(basisPriced) ? basisPriced : 0,
      missingPriceSoldOut: Number.isFinite(basisMissing) ? basisMissing : 0,
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

function revenueDayTypeRows(revenue = {}) {
  const text = String(revenue.byDayType || "").trim();
  const unit = revenue.unit || "";
  const order = ["평일", "금요일", "토요일", "일요일"];
  if (!text) return [];
  return text.split(/\s*,\s*/).map((entry) => {
    const match = entry.match(/^(평일|금요일|토요일|일요일)\s+(.+?)\((.*)\)$/);
    if (!match) return null;
    const detail = match[3] || "";
    const countMatch = detail.match(new RegExp(`(\\d+)\\s*${unit || "[개회]"}`));
    const offlineMatch = detail.match(/오프라인\s+(\d+)/);
    const missingMatch = detail.match(/가격누락\s+(\d+)/);
    return {
      label: match[1],
      revenueText: match[2],
      pricedSoldOut: countMatch ? Number(countMatch[1]) : 0,
      offlineReserved: offlineMatch ? Number(offlineMatch[1]) : 0,
      missingPriceSoldOut: missingMatch ? Number(missingMatch[1]) : 0,
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
  if (totalRevenue > 0) score += 12;
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
    acc.pricedSoldOut += finiteNumber(lodging.pricedSoldOut);
    acc.missingPriceSoldOut += finiteNumber(lodging.missingPriceSoldOut);
    acc.dayRevenue += finiteNumber(day.revenue);
    acc.dayPricedSoldOut += finiteNumber(day.pricedSoldOut);
    acc.dayMissingPriceSoldOut += finiteNumber(day.missingPriceSoldOut);
    return acc;
  }, { revenue: 0, pricedSoldOut: 0, missingPriceSoldOut: 0, dayRevenue: 0, dayPricedSoldOut: 0, dayMissingPriceSoldOut: 0 });
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

function manualCorrectionInfo(item = {}) {
  const correction = item.companyManualCorrection || item.companyProfile?.manualCorrection || {};
  if (!manualCorrectionHasValue(correction)) return null;
  const lodging = finiteNumber(correction.lodgingBasisTotal, 0);
  const dayUse = finiteNumber(correction.dayUseBasisTotal, 0);
  const parts = [];
  if (lodging > 0) parts.push(`숙박 ${fmtNumber(lodging)}개`);
  if (dayUse > 0) parts.push(`데이유즈 ${fmtNumber(dayUse)}회`);
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
  const correctedBasis = finiteNumber(item.weeklyBasisTotal, baseTotal);
  const maxTotal = manualBasis && correctedBasis > 0
    ? correctedBasis
    : Math.max(
      0,
      baseTotal,
      correctedBasis,
      ...rows.map((row) => finiteNumber(row.total, 0))
    );
  const basisLabel = normalizeMonthDayLabel(monthDay(run.checkIn));

  return bookingRangeLabels(run).map((label) => {
    const key = normalizeMonthDayLabel(label);
    const row = rowMap.get(key);
    if (row) {
      const rawTotal = finiteNumber(row.total, maxTotal);
      const basisTotal = manualBasis && maxTotal > 0 ? maxTotal : Math.max(maxTotal, rawTotal);
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
      total: maxTotal,
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
  const sales = summarizeSales(items);
  const revenue = summarizeRevenue(items);
  const rate = sales.supply ? sales.sold / sales.supply : finiteNumber(state.data?.availability?.stats?.weightedSoldOutRate, NaN);
  const checked = state.data?.availability?.stats?.checkedPlaces || items.length;
  const lowConfidence = finiteNumber(state.data?.availability?.stats?.lowConfidenceCount, 0);
  const stockVariance = finiteNumber(state.data?.availability?.stats?.stockVarianceCount, 0);
  const revenueNote = revenue.missingPriceSoldOut
    ? `${fmtNumber(revenue.pricedSoldOut)}개 가격확인 · 가격누락 ${fmtNumber(revenue.missingPriceSoldOut)}개`
    : `${fmtNumber(revenue.pricedSoldOut)}개 가격확인`;
  els.summaryGrid.innerHTML = `
    <article class="summary-card">
      <span class="summary-icon blue">${summaryIcon("sales")}</span>
      <div><strong>${fmtNumber(sales.sold)}/${fmtNumber(sales.supply)}</strong><small>객실 판매</small></div>
    </article>
    <article class="summary-card">
      <span class="summary-icon green">${summaryIcon("money")}</span>
      <div><strong>${fmtWon(revenue.revenue)}</strong><small>숙박 예상 매출 · ${escapeHtml(revenueNote)}</small></div>
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

function rankMetaChipRow(item = {}) {
  const chips = [
    item.overallRank ? `전체 ${fmtNumber(item.overallRank)}위` : "",
    item.regionalRank ? `지역 ${fmtNumber(item.regionalRank)}위` : "",
    item.adRank ? `광고 ${fmtNumber(item.adRank)}위` : "",
    item.hasInventory ? "재고 분석 완료" : "재고 미수집"
  ].filter(Boolean);
  return `<div class="flow-chip-row">${chips.slice(0, 4).map((chip, index) => `<span class="${index === 0 ? "hot" : ""}">${escapeHtml(chip)}</span>`).join("")}</div>`;
}

function renderCompanies() {
  const analysisItems = state.data?.availability?.items || [];
  const items = rankedCompanyItems();
  const ranking = state.data?.ranking || {};
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
    const metric = linked && lodging.supply ? `${fmtNumber(lodging.sold)}/${fmtNumber(lodging.supply)}` : `${fmtNumber(item.rank || index + 1)}위`;
    const stockStatus = item.bookingStatus || (linked ? "재고 분석 완료" : "예약ID 조회 실패/미수집");
    return `
      <article class="company-card ${linked ? "" : "rank-only"}" data-company-index="${index}">
        <div class="company-main">
          <span class="rank-badge">${escapeHtml(item.rank || index + 1)}</span>
          <div class="company-title">
            <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
            <small>${escapeHtml(categoryText(item))}</small>
            <div class="company-badges">${
              linked
                ? `${inventoryConfidenceBadge(item)}${inventoryStructureBadge(item)}${manualCorrectionBadge(item)}${otaVerificationBadge(item)}`
                : `<span class="confidence-badge watch" title="${escapeHtml(stockStatus)}">재고 미수집</span><span class="structure-badge watch">${escapeHtml(item.rankingSourceLabel || "네이버 전체 순위")}</span>`
            }</div>
          </div>
        </div>
        <div class="company-metric">
          <strong>${metric}</strong>
          <span>${linked && lodging.supply ? "숙박 추정" : "네이버 전체"}</span>
          <small title="${escapeHtml(stockStatus)}">${linked && lodging.supply ? fmtRate(lodging.rate) : escapeHtml(stockStatus)}</small>
        </div>
        <div class="company-chart">
          ${linked ? `
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
              <span class="sales-line day">${escapeHtml([item.searchKeyword, item.regionalCluster || item.region, item.address].filter(Boolean).join(" · ") || "지역/주소 확인")}</span>
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
  els.companyList.innerHTML = `${renderValidationBoard(analysisItems)}${cards}`;
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
  const flags = new Set(structure.flags || []);
  const soldQuantity = finiteNumber(lodging.sold, 0) + finiteNumber(dayUse.sold, 0);
  const pricedQuantity = finiteNumber(lodgingRevenue.pricedSoldOut, 0) + finiteNumber(dayUseRevenue.pricedSoldOut, 0);
  const missingPriceQuantity = finiteNumber(lodgingRevenue.missingPriceSoldOut, 0) + finiteNumber(dayUseRevenue.missingPriceSoldOut, 0);
  const productCount = finiteNumber(item.countedItemCount, 0) + finiteNumber(item.nightItemCount, 0) + finiteNumber(item.dayUseItemCount, 0);
  const productKnown = productCount > 0 || Boolean(String(item.productTypeSummary || "").trim());
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
  const offlineQuantity = rows.reduce((sum, row) => sum + finiteNumber(row.offlineSold || row.hidden, 0), 0);
  const hasOfflineDetail = Boolean(item.weeklyOfflineReservationDetail || item.dayUseWeeklyOfflineReservationDetail);
  const offlineEstimated = offlineQuantity > 0 || hasOfflineDetail;
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
    issues.push(["오프라인 예약 추정", offlineEstimated, "총량 최대값 대비 부족분을 오프라인 예약/차단으로 해석했습니다.", "good"]);
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
      const revenue = finiteNumber(entry.revenueImpact?.totalRevenue, 0);
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
  const rawTotals = collectedRows
    .map((row) => finiteNumber(row.rawTotal, row.total))
    .filter((value) => value > 0);
  const totalMax = rawTotals.length ? Math.max(...rawTotals) : 0;
  const totalMin = rawTotals.length ? Math.min(...rawTotals) : 0;
  const totalMedian = medianNumber(rawTotals);
  const totalGap = Math.max(0, totalMax - totalMin);
  const totalGapRate = totalMax ? totalGap / totalMax : NaN;
  const varianceRows = collectedRows.filter((row) => {
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
    variance: varianceRows.map((row) => `${row.label} ${fmtNumber(finiteNumber(row.rawTotal, row.total))}개`),
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
    reasons.push(`날짜별 총량 변동 ${fmtNumber(totalMin)}~${fmtNumber(totalMax)}개`);
    actions.push("전화예약, 시설점검, 채널 재고조절 가능성으로 우선 해석");
    otaSignals.push("날짜별 총량 변동");
    issueChannels.add("전화예약/오프라인");
    issueChannels.add("네이버 날짜별 재고");
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
  const criteria = audit.criteria || [];
  const reasons = criteria.length
    ? criteria.map((criterion) => `${criterion.label}: ${criterion.reason}`)
    : audit.reasons;
  return {
    audit,
    inQueue: Boolean(audit.inQueue),
    label: criteria[0]?.label || auditIndexLabel(audit),
    tone: audit.tone,
    priority: audit.priority,
    criteria,
    reasons,
    actions: criteria.map((criterion) => criterion.action).filter(Boolean).concat(audit.actions || []).slice(0, 4),
    problemDateText: auditProblemDateText(audit),
    quantityConfidence: `신뢰도 ${confidence.grade} · ${structure.label}`,
    gapType: compactListText(audit.gapTypes || [], "공백 특이 없음", 3),
    channelText: compactListText(audit.neededChannels || [], "네이버 기준", 4),
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
    .map((item) => ({ item, decision: decisionQueueProfile(item), ...targetExpansionAnalysis(item) }))
    .filter((entry) => entry.score >= 42 && entry.reasons.length && (includeDecisionQueue || !entry.decision.inQueue))
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
  const priced = optionalNumber(part.pricedSoldOut);
  const missing = optionalNumber(part.missingPriceSoldOut);
  const avg = optionalNumber(part.avgSoldUnitPrice);
  return {
    revenue: Number.isFinite(revenue) ? revenue : 0,
    pricedSoldOut: Number.isFinite(priced) ? priced : 0,
    missingPriceSoldOut: Number.isFinite(missing) ? missing : 0,
    avgSoldUnitPrice: Number.isFinite(avg) ? avg : null,
    byDayType: part.byDayType || "",
    detail: part.detail || "",
    offlineDetail: part.offlineDetail || "",
    basis: part.basis || "basis",
    label: part.basis === "range" ? "기간 집계" : "기준일",
    unit
  };
}

function companyQueueRevenueImpact(company = {}) {
  const item = companyItemFromCurrentRun(company);
  const lodging = item
    ? queueRevenuePartFromItem(item, "lodging")
    : queueRevenuePartFromSnapshot(company.inventory?.latest?.revenue?.lodging || {}, "개");
  const dayUse = item
    ? queueRevenuePartFromItem(item, "day")
    : queueRevenuePartFromSnapshot(company.inventory?.latest?.revenue?.dayUse || {}, "회");
  const totalRevenue = finiteNumber(lodging.revenue) + finiteNumber(dayUse.revenue);
  const totalPricedSoldOut = finiteNumber(lodging.pricedSoldOut) + finiteNumber(dayUse.pricedSoldOut);
  const totalMissingPriceSoldOut = finiteNumber(lodging.missingPriceSoldOut) + finiteNumber(dayUse.missingPriceSoldOut);
  const precision = revenuePrecisionProfile(item || {}, lodging, dayUse);
  const hasDetail = Boolean(
    totalRevenue ||
    totalPricedSoldOut ||
    totalMissingPriceSoldOut ||
    lodging.avgSoldUnitPrice ||
    dayUse.avgSoldUnitPrice ||
    lodging.byDayType ||
    dayUse.byDayType ||
    lodging.offlineDetail ||
    dayUse.offlineDetail
  );
  return {
    hasDetail,
    lodging,
    dayUse,
    totalRevenue,
    totalPricedSoldOut,
    totalMissingPriceSoldOut,
    precision,
    source: item ? "current" : "master"
  };
}

function queueSnapshotRevenueImpact(snapshot = {}) {
  const lodging = queueRevenuePartFromSnapshot(snapshot.revenue?.lodging || {}, "개");
  const dayUse = queueRevenuePartFromSnapshot(snapshot.revenue?.dayUse || {}, "회");
  return {
    lodging,
    dayUse,
    totalRevenue: finiteNumber(lodging.revenue) + finiteNumber(dayUse.revenue),
    totalPricedSoldOut: finiteNumber(lodging.pricedSoldOut) + finiteNumber(dayUse.pricedSoldOut),
    totalMissingPriceSoldOut: finiteNumber(lodging.missingPriceSoldOut) + finiteNumber(dayUse.missingPriceSoldOut)
  };
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
      before: fmtWon(before.totalRevenue),
      after: fmtWon(current.totalRevenue),
      tone: queueDeltaTone(before.totalRevenue, current.totalRevenue, true),
      note: `변화 ${formatSignedWon(current.totalRevenue - before.totalRevenue)}`
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
  const quantityIssue = criteria.has("quantity") || criteria.has("capacity") || issues.has("structure") || issues.has("booking") || issues.has("offline");
  const noQuantity = !current.totalSupply && !current.totalSold;
  const priceIssue = current.totalMissingPriceSoldOut > 0 || (!current.totalPricedSoldOut && current.totalSold > 0);
  if (!compare.hasComparison) {
    return {
      status: company.adminReview?.status || "recrawl_needed",
      label: "비교 대기",
      tone: "watch",
      reasons: ["이전 수집 스냅샷이 없어 재수집 전후 비교는 다음 수집부터 표시됩니다."]
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
  if (criteria.has("ota") || issues.has("ota") || criteria.has("gap") || issues.has("gap")) {
    return { status: "check_needed", label: "확인 필요", tone: "watch", reasons: ["OTA 또는 요일별 판매 공백은 사람이 채널/상품 조건을 확인해야 합니다."] };
  }
  if (!decision.inQueue || compare.improved >= 2 || company.salesTarget?.category === "contact") {
    return { status: "contact_ready", label: "컨택 가능", tone: "good", reasons: ["재수집 후 핵심 수량/가격 문제가 해소되어 컨택 후보로 볼 수 있습니다."] };
  }
  return { status: "check_needed", label: "확인 필요", tone: "watch", reasons: ["잔여 신호를 확인한 뒤 컨택 또는 보류를 결정하세요."] };
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
      const comparison = companyRecrawlComparison(company);
      const contact = company.salesContact || {};
      const executionScore = companySalesExecutionScore(company, revenueImpact, comparison);
      const followUp = companySalesFollowUpProfile(company, revenueImpact);
      const followUpScore = companySalesFollowUpScore(company, revenueImpact, followUp);
      const priorityScore = executionScore + followUpScore;
      return { company, stage, action, item, decision, revenueImpact, comparison, contact, executionScore, followUp, followUpScore, priorityScore };
    })
    .filter((entry) => ["confirmed", "contact"].includes(entry.stage.key) && !entry.decision.inQueue)
    .sort((a, b) => a.stage.priority - b.stage.priority || a.followUp.priority - b.followUp.priority || b.priorityScore - a.priorityScore || (b.company.salesTarget?.score || 0) - (a.company.salesTarget?.score || 0) || (a.company.bestRank || 9999) - (b.company.bestRank || 9999));
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
  const revenue = finiteNumber(revenueImpact.totalRevenue);
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
  const revenue = finiteNumber(revenueImpact.totalRevenue);
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
  const revenue = finiteNumber(revenueImpact.totalRevenue);
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
      revenue: matches.reduce((sum, entry) => sum + finiteNumber(entry.revenueImpact?.totalRevenue), 0),
      due: matches.filter((entry) => ["overdue", "today", "soon"].includes(entry.followUp.key)).length
    };
  });
  const active = entries.filter((entry) => salesPipelineStatusKeys().includes(entry.company.salesContact?.status || ""));
  const hot = entries.filter((entry) => salesHotStatusKeys().includes(entry.company.salesContact?.status || ""));
  return {
    rows,
    activeCount: active.length,
    activeRevenue: active.reduce((sum, entry) => sum + finiteNumber(entry.revenueImpact?.totalRevenue), 0),
    hotCount: hot.length,
    hotRevenue: hot.reduce((sum, entry) => sum + finiteNumber(entry.revenueImpact?.totalRevenue), 0),
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
    contractRevenue: contractReview.reduce((sum, entry) => sum + finiteNumber(entry.revenueImpact?.totalRevenue), 0),
    responseRevenue: responded.reduce((sum, entry) => sum + finiteNumber(entry.revenueImpact?.totalRevenue), 0)
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
    row.revenue += finiteNumber(entry.revenueImpact?.totalRevenue);
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
    finiteNumber(revenue.totalRevenue) ? `예상매출 ${fmtWon(revenue.totalRevenue)}` : "",
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
    { label: "예상매출", value: fmtWon(revenue.totalRevenue) },
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
  const revenueText = fmtWon(entry.revenueImpact?.totalRevenue);
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
      finiteNumber(entry.revenueImpact?.totalRevenue),
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
  const headers = ["구분", "업체명", "지역", "순위", "추천상태", "재수집설정", "전후비교", "근거", "예상매출", "관리메모"];
  const rowFor = (group, row) => [
    group,
    row.name,
    row.region,
    row.rank ? `${fmtNumber(row.rank)}위` : "",
    recrawlAutomationStatusLabel(row.status),
    `정밀분석 · 상세 ${row.range}위 · ${row.dateText}`,
    row.comparison?.hasComparison ? `개선 ${fmtNumber(row.comparison.improved)} / 악화 ${fmtNumber(row.comparison.worsened)} · ${compactDateTime(row.previous)} → ${compactDateTime(row.latest)}` : "비교 대기",
    row.reason,
    row.revenue ? finiteNumber(row.revenue, 0) : "",
    row.note
  ];
  const rows = [
    ...profile.needsExecution.map((row) => rowFor("재수집실행", row)),
    ...profile.transitions.map((row) => rowFor("추천적용", row)),
    ...profile.compared.map((row) => rowFor("전후비교", row))
  ];
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
  const saleSignal = Number.isFinite(rate) ? (rate < 0.35 ? 18 : rate < 0.55 ? 12 : 5) : 8;
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

function renderReport() {
  if (!els.reportBody) return;
  const data = state.data || {};
  const run = data.run || {};
  const items = data.availability?.items || [];
  if (!items.length) {
    els.reportBody.innerHTML = `<div class="empty">요약할 수집 결과가 없습니다. 관리 탭에서 새 수집을 실행하세요.</div>`;
    return;
  }

  const sales = summarizeSales(items);
  const rate = sales.supply ? sales.sold / sales.supply : finiteNumber(data.availability?.stats?.weightedSoldOutRate, NaN);
  const targets = targetEntries(8);
  const allTargets = targetEntries(0);
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

  els.reportBody.innerHTML = `
    <section class="report-hero">
      <div class="report-hero-copy">
        <span class="report-badge ${decision.tone}">${escapeHtml(decision.label)}</span>
        <h2>${escapeHtml(keyword)} 시장 브리핑</h2>
        <p>${escapeHtml(range)} 입력기간 기준으로 네이버 노출, 객실 판매율, OTA 보조 확인, 상품 구성 약점을 함께 판정했습니다.</p>
      </div>
      <div class="report-score-card">
        <span>공략 매력도</span>
        <strong>${fmtNumber(score)}</strong>
        <small>${escapeHtml(decision.summary)}</small>
      </div>
    </section>

    <section class="report-metric-grid" aria-label="보고서 핵심 지표">
      <article>
        <span>객실 판매율</span>
        <strong>${fmtRate(rate)}</strong>
        <small>${fmtNumber(sales.sold)}/${fmtNumber(sales.supply)}개 추정</small>
      </article>
      <article>
        <span>분석 업체</span>
        <strong>${fmtNumber(items.length)}</strong>
        <small>상위 노출 기준</small>
      </article>
      <article>
        <span>컨택 후보</span>
        <strong>${fmtNumber(allTargets.length)}</strong>
        <small>판매흐름/상품 약점 감지</small>
      </article>
      <article>
        <span>상품 공백</span>
        <strong>${fmtNumber(items.length - dayUseCount)}</strong>
        <small>데이유즈/캠프닉 미확인</small>
      </article>
    </section>

    <section class="report-layout">
      <article class="report-card market">
        <div class="report-card-head">
          <div>
            <h3>시장 해석</h3>
            <p>판매율, OTA 보조 확인, 상품 구성으로 본 영업 우선순위</p>
          </div>
          <span>${fmtNumber(bookingDays(run))}일 기준</span>
        </div>
        <div class="report-insight-list">
          <div><b>판매 강도</b><span>${Number.isFinite(rate) ? `${fmtRate(rate)} 객실 판매율` : "확인필요"}</span></div>
          <div><b>저판매 후보</b><span>${fmtNumber(lowSalesCount)}개 업체</span></div>
          <div><b>검색 수요</b><span>${searchVolume ? `월 ${fmtNumber(searchVolume)}회` : "API 확인필요"}</span></div>
          <div><b>상품 확장</b><span>${fmtNumber(dayUseCount)}개 업체만 데이유즈/캠프닉 확인</span></div>
        </div>
      </article>

      <article class="report-card">
        <div class="report-card-head">
          <div>
            <h3>OTA 보조 확인</h3>
            <p>의심 업체 기준 보조 채널 현황</p>
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
            <h3>이번 주 액션</h3>
            <p>먼저 확인해야 할 영업/운영 과제</p>
          </div>
        </div>
        <ol class="report-action-list">
          <li><strong>OTA 색인 업체만 보조 채널 확인</strong><span>색인 ${fmtNumber(platformStats.otaCheckCount || 0)}개 · 여기어때 ${fmtNumber(platformStats.missingYeogi)}개, 야놀자 ${fmtNumber(platformStats.missingYanolja)}개 확인</span></li>
          <li><strong>객실 판매율 낮은 업체 상품 재구성</strong><span>저판매 후보 ${fmtNumber(lowSalesCount)}개, 가격/패키지/캠프닉 점검</span></li>
          <li><strong>데이유즈/캠프닉 공백 제안</strong><span>${fmtNumber(items.length - dayUseCount)}개 업체는 당일상품 확인 필요</span></li>
        </ol>
      </article>
    </section>

    <section class="report-card report-target-preview">
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
    </section>

    <section class="report-card report-region-preview">
      <div class="report-card-head">
        <div>
          <h3>지역 클러스터 요약</h3>
          <p>관광 앵커와 인접 수요권 기준</p>
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
    return {
      label: trendMonthLabel(rawLabel, index),
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
    observationCount: source?.cache?.observationCount || null,
    firstCollectedAt: source?.cache?.firstCollectedAt || "",
    lastCollectedAt: source?.cache?.lastCollectedAt || "",
    lastUsedAt: source?.cache?.lastUsedAt || ""
  };
}

function trendMonthLabel(value, index = 0) {
  const text = String(value || "").trim();
  const match = text.match(/^(?:\d{4}-)?0?(\d{1,2})(?:-\d{1,2})?/);
  if (match) return `${Number(match[1])}월`;
  if (/^\d{1,2}$/.test(text)) return `${Number(text)}월`;
  if (/월$/.test(text)) return text.replace(/^0/, "");
  return `${index + 1}월`;
}

function trendIndexLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, "");
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
        ${points.map((point) => `<span>${escapeHtml(point.label)}</span>`).join("")}
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
      ? `${trend.cacheHit ? "저장자료 사용" : "연동 정상"} · ${fmtNumber(validMonthCount)}개월`
      : (trend.configured ? "연동 대기" : "API 키 필요");
  const detailLabel = trend.hasSeries
    ? `최고점=100 기준 · ${trend.keyword || activeKeyword()}${trend.collectedAt ? ` · ${compactDateTime(trend.collectedAt)}` : ""}`
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
  return "보합";
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
    value: "보합",
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
  const source = trend.cacheHit ? "저장자료 재사용" : "이번 실행 수집";
  const time = trend.lastCollectedAt || trend.collectedAt;
  return {
    tone,
    label: "누적 신뢰",
    value,
    detail: `${source}${time ? ` · ${compactDateTime(time)}` : ""}`
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
    return "최근 수요가 피크권입니다. 상위 노출 업체의 금·일 공백, 가격 방어, 채널 미노출을 컨택 후보 판단에 연결합니다.";
  }
  if (falling) {
    return "검색 추세가 내려가는 구간입니다. 신규 영업보다 기존 후보의 상품 재구성, 평일/일요일 보완 제안을 우선합니다.";
  }
  return "검색량, 모바일 비중, CTR, 예약 판매율을 함께 보며 노출은 있는데 판매 구조가 약한 업체를 우선 확인합니다.";
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
        <span>업체 적용 예시</span>
        <strong>${escapeHtml(target.name || "업체명 확인")}</strong>
        <small>${escapeHtml(categoryText(target))} · 네이버 ${escapeHtml(target.rank || index + 1)}위</small>
      </div>
      <dl>
        <div><dt>객실판매</dt><dd>${lodging.supply ? `${fmtNumber(lodging.sold)}/${fmtNumber(lodging.supply)}개 · ${fmtRate(lodging.rate)}` : "확인필요"}</dd></div>
        <div><dt>검색수요</dt><dd>${traffic.totalSearchVolume ? fmtNumber(traffic.totalSearchVolume) : "확인필요"} · ${demandTrendLabel()}</dd></div>
        <div><dt>영업판단</dt><dd>${demandPriorityLabel(traffic, targetReasons(target).length * 5)}</dd></div>
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
          <span>숙박 기준 총량</span>
          <input type="number" min="0" inputmode="numeric" data-manual-lodging value="${escapeHtml(correction.lodgingBasisTotal || "")}" placeholder="예: 30">
        </label>
        <label>
          <span>데이유즈/캠프닉 기준 총량</span>
          <input type="number" min="0" inputmode="numeric" data-manual-dayuse value="${escapeHtml(correction.dayUseBasisTotal || "")}" placeholder="예: 12">
        </label>
      </div>
      <label>
        <span>보정 메모</span>
        <input type="text" data-manual-note value="${escapeHtml(correction.note || "")}" placeholder="예: 전화예약 조절 반영, 실제 객실 30동">
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
          ${row.note ? `<small>${escapeHtml(row.note)}</small>` : `<small>${escapeHtml(row.action === "clear" ? "검증 상태를 해제했습니다." : "메모 없이 저장됨")}</small>`}
        </article>
      `).join("") : `<article><b>${escapeHtml(current.label || companyAdminReviewLabel(current.status))}</b><span>${escapeHtml(compactDateTime(current.updatedAt))}</span><small>${escapeHtml(current.note || "현재 저장된 판단입니다.")}</small></article>`}
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
    tone: criteria.some((criterion) => ["ota", "quantity", "capacity"].includes(criterion.key)) ? "watch" : "good"
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

function companyQueueRevenueImpactHtml(company = {}) {
  const impact = companyQueueRevenueImpact(company);
  if (!impact.hasDetail) return "";
  const priceTone = impact.totalMissingPriceSoldOut > 0 ? "watch" : "good";
  const precision = impact.precision || {};
  const sourceText = impact.source === "current" ? "현재 수집 결과" : "업체 최신 스냅샷";
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
        <strong>${fmtWon(impact.totalRevenue)}</strong>
        <small>${escapeHtml(`${sourceText} · ${queueRevenueDetailShort(impact.lodging, "숙박 요일별 매출 대기")}`)}</small>
      </div>
      <div class="${escapeHtml(precision.tone || "watch")}">
        <span>매출 신뢰도</span>
        <strong>${escapeHtml(precision.grade ? `${precision.grade} · ${fmtNumber(precision.score)}점` : "대기")}</strong>
        <small>${escapeHtml((precision.reasons || []).slice(0, 2).join(" · ") || "가격/수량 정밀 확인 필요")}</small>
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
  if (revenueImpact.totalRevenue >= 5000000) score += 16;
  else if (revenueImpact.totalRevenue >= 2000000) score += 10;
  else if (revenueImpact.totalRevenue >= 700000) score += 5;
  if (revenueImpact.totalMissingPriceSoldOut > 0) score += Math.min(12, revenueImpact.totalMissingPriceSoldOut * 2);
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
  if (filter === "high_revenue") return open && finiteNumber(revenue.totalRevenue) >= 2000000;
  if (filter === "price_missing") return open && finiteNumber(revenue.totalMissingPriceSoldOut) > 0;
  if (filter === "improved") return open && comparison.hasComparison && comparison.improved > comparison.worsened;
  if (filter === "worsened") return open && comparison.hasComparison && comparison.worsened > 0;
  if (filter === "recrawl") return open && (entry.type.key === "recrawl" || entry.company.adminReview?.status === "recrawl_needed");
  if (filter === "done") return entry.workflow.key === "done";
  if (filter === "ota") return open && (entry.type.key === "ota" || (entry.profile.issues || []).some((issue) => issue.key === "ota"));
  if (filter === "gap") return open && (entry.type.key === "gap" || (entry.profile.issues || []).some((issue) => issue.key === "gap"));
  return open && entry.type.key === filter;
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
      const include = decision.inQueue
        || Boolean(company.adminReview?.status)
        || workflow.key === "recheck";
      return { company, profile, type, workflow, priority, decision, comparison, autoRecommendation, revenueImpact, include };
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

function companyQueueRecrawlPlan(company = {}, profile = {}, decision = {}) {
  const run = state.data?.run || {};
  const criteria = new Set((decision.criteria || []).map((criterion) => criterion.key));
  const issues = new Set((profile.issues || []).map((issue) => issue.key));
  const rank = Number(company.bestRank || 0);
  let range = "1-20";
  if (!rank || rank > 20 || criteria.has("ota") || criteria.has("quantity") || criteria.has("capacity") || issues.has("booking")) {
    range = "1-30";
  } else if (rank <= 5 && !(criteria.has("quantity") || criteria.has("capacity"))) {
    range = "1-10";
  }
  const dateText = decision.problemDateText && decision.problemDateText !== "최근 수집일 기준"
    ? decision.problemDateText
    : dateRangeLabel(run);
  const keyword = run.keyword || company.bestKeyword || activeKeyword();
  return {
    keyword,
    range,
    dateText,
    checkIn: run.checkIn || els.checkInInput?.value || "",
    checkOut: run.checkOut || els.checkOutInput?.value || "",
    searchMode: run.searchMode || "keyword",
    productMode: run.productMode || "all",
    collectionMode: "precision"
  };
}

function companyQueueActionPlan(company = {}, profile = {}, workflow = {}, decision = {}) {
  const plan = companyQueueRecrawlPlan(company, profile, decision);
  const recheckComparison = companyRecrawlComparison(company);
  const autoRecommendation = companyRecrawlAutoRecommendation(company, profile, decision, recheckComparison);
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
    ["자동 재검토", recheckComparison.hasComparison ? `${autoRecommendation.label} · 개선 ${fmtNumber(recheckComparison.improved)} / 악화 ${fmtNumber(recheckComparison.worsened)}` : "비교 대기", "재수집 전후 수량/가격/공백 비교"],
    ["재수집 설정", `정밀분석 · 상세 ${plan.range}위`, "순위 범위 문제 또는 수량 구조 확인용"],
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
      <small>${escapeHtml(`${plan.keyword} · ${plan.checkIn || "체크인"}~${plan.checkOut || "체크아웃"} · 상세 ${plan.range}위`)}</small>
    </div>
  `;
}

function companyCheckEntryHtml(entry = {}) {
  const { company, profile, type, priority, workflow, decision } = entry;
  const latest = company.inventory?.latest || {};
  const reasons = companyCheckReasons(company, profile, workflow, decision);
  const showCorrectionForm = (profile.issues || []).some((issue) => ["structure", "booking", "offline", "dayuse", "manual"].includes(issue.key));
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
        note: history.note || history.reason || "관리자 처리 이력"
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
        note: `${entry.autoRecommendation?.label || "추천 대기"} · 매출 ${fmtWon(entry.revenueImpact?.totalRevenue || 0)}`
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
  const comparison = entry.comparison || {};
  const recommendation = entry.autoRecommendation || {};
  const latest = comparison.latest?.collectedAt || company.inventory?.latest?.collectedAt || company.lastSeenAt || "";
  const previous = comparison.previous?.collectedAt || company.inventory?.previousLatest?.collectedAt || "";
  const rank = Number(company.bestRank || 0);
  const revenue = finiteNumber(entry.revenueImpact?.totalRevenue, 0);
  const reasons = [
    recommendation.label,
    ...(recommendation.reasons || []),
    entry.decision?.summary,
    (entry.profile?.issues || [])[0]?.task
  ].filter(Boolean);
  const score = finiteNumber(entry.priority?.score, 0)
    + (recommendation.status === "recrawl_needed" ? 22 : 0)
    + (recommendation.status === "contact_ready" ? 18 : 0)
    + (comparison.hasComparison ? 10 : 0)
    + Math.min(18, revenue / 200000)
    + (rank > 0 && rank <= 10 ? 8 : 0);
  return {
    entry,
    company,
    plan,
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
    note: recrawlAutomationNote(entry)
  };
}

function recrawlAutomationProfile(entries = []) {
  const open = entries.filter((entry) => entry.workflow.key !== "done");
  const rows = open.map(recrawlAutomationRow);
  const needsExecution = rows
    .filter((row) => row.status === "recrawl_needed" || row.entry.type.key === "recrawl" || !row.comparison.hasComparison)
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

function recrawlAutomationMiniCells(row = {}) {
  if (!row.comparison?.hasComparison) {
    return `
      <div class="recrawl-auto-cells">
        <span>이전 수집 대기</span>
        <span>${escapeHtml(row.dateText)}</span>
        <span>${escapeHtml(row.range)}위</span>
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
  const metricRows = [
    ["실행 대기", profile.needsExecution.length, "수집 설정 적용 대상"],
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
            <strong>${fmtNumber(value)}</strong>
            <small>${escapeHtml(note)}</small>
          </article>
        `).join("")}
      </div>
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
  const highRevenue = open.filter((entry) => finiteNumber(entry.revenueImpact?.totalRevenue) >= 2000000);
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

function companyMasterCheckPanel(master = {}) {
  const entries = companyDecisionQueueEntries(master);
  const filters = state.companyMasterFilters || {};
  const selectedFilter = filters.check || "priority";
  const countForFilter = (value) => entries.filter((entry) => companyCheckFilterMatches(entry, value)).length;
  const visibleEntries = entries.filter((entry) => companyCheckFilterMatches(entry, selectedFilter));
  const openEntries = entries.filter((entry) => entry.workflow.key !== "done");
  const criterionCount = (key) => openEntries.filter((entry) => (entry.decision.criteria || []).some((criterion) => criterion.key === key)).length;
  const reviewStatusCount = (status) => entries.filter((entry) => entry.company.adminReview?.status === status).length;
  const metrics = [
    ["판단 큐", openEntries.length, "사람 확인 필요"],
    ["재수집 필요", reviewStatusCount("recrawl_needed"), "범위/기간 재확인"],
    ["수동 보정", reviewStatusCount("manual_needed") + criterionCount("manual_recheck"), "총량 보정 후 재판정"],
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
        <span>${fmtNumber(displayedEntries.length)}/${fmtNumber(visibleEntries.length)}개 표시 · 전체 ${fmtNumber(entries.length)}</span>
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
          : `<p class="empty">해당 조건의 확인할 업체가 없습니다.</p>`}
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
          <span>숙박 총량</span>
          <input type="number" min="0" inputmode="numeric" data-manual-lodging value="${escapeHtml(correction.lodgingBasisTotal || "")}" placeholder="예: 30">
        </label>
        <label>
          <span>데이유즈 총량</span>
          <input type="number" min="0" inputmode="numeric" data-manual-dayuse value="${escapeHtml(correction.dayUseBasisTotal || "")}" placeholder="예: 12">
        </label>
      </div>
      <label>
        <span>보정 메모</span>
        <input type="text" data-manual-note value="${escapeHtml(correction.note || "")}" placeholder="예: 전화예약 조절, 실제 객실 30동, 캠프닉 2회전">
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
  const preserveSearch = active?.matches?.("[data-company-master-search]");
  const selectionStart = preserveSearch ? active.selectionStart : null;
  const selectionEnd = preserveSearch ? active.selectionEnd : null;
  renderCompanyMasterPanel();
  renderDecisionQueue();
  if (preserveSearch) {
    const input = document.querySelector("[data-company-master-search]");
    input?.focus();
    if (input && selectionStart !== null && selectionEnd !== null) {
      input.setSelectionRange(selectionStart, selectionEnd);
    }
  }
}

function renderCompanyMasterPanel() {
  if (!els.companyMasterPanel) return;
  const master = { ...(state.data?.companyMaster || {}), ...(state.companyMaster || {}) };
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

  els.targetCount.textContent = `${fmtNumber(actionableCount || currentItems.length)} 타깃`;
  if (!boardEntries.length && !currentItems.length) {
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
          <div><span>예상매출</span><strong>${fmtWon(revenueImpact.totalRevenue)}</strong><small>${escapeHtml(revenueImpact.precision?.grade ? `신뢰 ${revenueImpact.precision.grade} · 가격누락 ${fmtNumber(revenueImpact.totalMissingPriceSoldOut)}개/회` : `가격누락 ${fmtNumber(revenueImpact.totalMissingPriceSoldOut)}개/회`)}</small></div>
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
      <button type="button" data-export-sales-targets>컨택+반응 CSV</button>
    </section>
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

function renderMapControls() {
  els.mapLayerRow.innerHTML = ["시군구 경계", "업체 스팟", "검색량", "판매율"].map((name, index) => `
    <span><b style="background:${["#3182f6", "#12b76a", "#7a5af8", "#f79009"][index]}"></b>${name}</span>
  `).join("");
  els.mapLegend.innerHTML = CORE_ORDER.slice(0, 5).map((name) => `
    <span><b style="background:${CORE_COLORS[name]}"></b>${name}</span>
  `).join("");
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

function regionBounds(regions = [], features = []) {
  const pairs = [];
  for (const region of regions) {
    const lon = Number(region.lon || region.lng || region.longitude);
    const lat = Number(region.lat || region.latitude);
    if (Number.isFinite(lon) && Number.isFinite(lat)) pairs.push([lon, lat]);
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
  els.mapCount.textContent = `${fmtNumber(regions.length)} 지역`;
  const geojson = await loadLocalMap();
  const features = geojson?.features || [];
  const activeNames = new Set(regions.map((region) => String(region.region || region.name || "").replace(/\s+/g, "")));
  const bounds = regionBounds(regions, features);

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

  els.clusterMap.innerHTML = `${paths}${markers}`;
  renderRegions();
}

function renderRegions() {
  const regions = state.data?.regions || [];
  if (!regions.length) {
    els.regionList.innerHTML = `<div class="empty">지역 클러스터 데이터가 없습니다.</div>`;
    return;
  }
  els.regionList.innerHTML = regions.map((region) => {
    const traffic = region.traffic || {};
    const primary = regionPrimary(region);
    return `
      <article class="region-card">
        <div>
          <strong>${escapeHtml(region.region || region.name || "지역")}</strong>
          <small>${escapeHtml(primary)} · ${escapeHtml(region.target || "수요권 확인")}</small>
          <p>월검색 ${fmtNumber(traffic.totalSearchVolume || 0)} · CTR ${traffic.collectable ? fmtSearchRate(traffic.combinedCtr) : "확인필요"}</p>
        </div>
        <em>${escapeHtml(region.dominantType || region.type || "분석")}</em>
      </article>
    `;
  }).join("");
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
  const result = match || locationCardForQuery(query || cards[0]?.searchKeyword || "");
  if (result.group) {
    renderLocationGroupDictionary(result.group);
    return;
  }
  const card = result.card || state.selectedLocationCard;
  if (!card) {
    if (els.dictionarySearchStatus) {
      els.dictionarySearchStatus.textContent = query
        ? `"${query}"에 맞는 저장 지역 카드가 없습니다. 현재는 등록된 지역부터 판단합니다.`
        : "지역명과 업종을 입력하면 저장된 지역 카드를 호출합니다.";
    }
    els.dictionaryResult.innerHTML = `
      <article class="location-card empty-location">
        <h3>저장된 카드가 없는 지역입니다</h3>
        <p>현재 사전에는 ${cards.map((item) => escapeHtml(item.searchKeyword)).join(", ")} 카드가 등록되어 있습니다. 같은 구조로 지역 카드를 추가하면 즉시 호출할 수 있습니다.</p>
      </article>
    `;
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
  } catch (error) {
    if (els.dictionarySearchStatus) els.dictionarySearchStatus.textContent = `입지사전 로딩 실패: ${error.message}`;
    if (els.dictionaryResult) els.dictionaryResult.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderHeader() {
  const run = state.data?.run || {};
  const title = run.label || `${activeKeyword()} 분석`;
  const titleMap = {
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
  els.pageTitle.textContent = titleMap[state.activeTab] || "요약 리포트";
  if (state.activeTab === "dictionary") {
    els.pageSubtitle.textContent = "저장된 지역 카드 · 8대 지수 · 클러스터 판정";
  } else if (state.activeTab === "decisionQueue") {
    els.pageSubtitle.textContent = `${title} · 컨택 전 사람 확인 · OTA/수량/공백/보정 재검토`;
  } else if (state.activeTab === "historyOps") {
    els.pageSubtitle.textContent = `${title} · 반복 수집 이력 · 회차 비교 · 업체별 추이`;
  } else if (state.activeTab === "demand") {
    els.pageSubtitle.textContent = `${title} · 숙박업 메인터넌스 · 네이버 트렌드`;
  } else if (state.activeTab === "report") {
    els.pageSubtitle.textContent = `${title} · 상업용 시장 요약 · ${dateRangeLabel(run)}`;
  } else {
    els.pageSubtitle.textContent = `${title} · ${dateRangeLabel(run)}`;
  }
  document.title = `글램핑데이터랩 V2 · ${title}`;
}

function renderAll() {
  if (!state.data) {
    renderLocationDictionary();
    return;
  }
  renderHeader();
  renderSummary();
  renderNotice();
  renderReport();
  renderCompanies();
  renderTargets();
  renderDecisionQueue();
  renderMap();
  renderDemand();
  renderHistoryOps();
  renderCompanyMasterPanel();
  renderLocationDictionary();
  renderDownloads();
  syncYeogiManualInterface();
}

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tab);
  });
  document.querySelectorAll(".bottom-nav button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  renderHeader();
  closeDrawer();
  if (tab === "report") renderReport();
  if (tab === "decisionQueue") renderDecisionQueue();
  if (tab === "map") renderMap();
  if (tab === "demand") renderDemand();
  if (tab === "historyOps") renderHistoryOps();
  if (tab === "dictionary") renderLocationDictionary();
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
    const basisTotal = basisTotalForRows(rows, item.dayUseWeeklyBasisTotal, activeManualCorrection(item));
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
  const status = collectionStatusProfile(item);
  const confidence = inventoryConfidenceInfo(item);
  const structure = inventoryStructureInfo(item);
  const decision = decisionQueueProfile(item);
  const priceText = status.priceMissing
    ? `가격누락 ${fmtNumber(status.missingPriceQuantity || status.soldQuantity)}개/회`
    : status.pricedQuantity
      ? `가격확인 ${fmtNumber(status.pricedQuantity)}개/회`
      : "판매/가격 대기";
  const productText = status.productKnown
    ? `${status.productCount ? `${fmtNumber(status.productCount)}개 상품` : "상품구성 확인"}`
    : "상품별 수량 확인필요";
  const rows = [
    ["수집 상태", status.label, `${fmtNumber(status.collectedDays)}/${fmtNumber(status.expectedDays)}일 확보`],
    ["문제 날짜", compactListText(status.missingDates, "없음", 5), status.missingDates.length ? "동일 기간 재수집 대상" : "기간 내 날짜 확보"],
    ["수량 신뢰도", `신뢰도 ${confidence.grade} · ${structure.label}`, structure.action || "자동 수량 판단"],
    ["상품별 수량", productText, status.productKnown ? "숙박/데이유즈 분리 기준" : "객실/상품 수량 직접 확인"],
    ["가격 확보", priceText, "할인 옵션 패키지는 산출 제외"],
    ["오프라인 예약", status.offlineEstimated ? `${fmtNumber(status.offlineQuantity)}개 추정` : "특이 없음", "미오픈/차단은 오프라인 예약 가능성으로 해석"]
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

function sheetAuditPanel(item = {}) {
  const decision = decisionQueueProfile(item);
  const audit = decision.audit;
  const metrics = [
    ["문제 날짜", decision.problemDateText, audit.metrics.missingCount ? `미수집 ${fmtNumber(audit.metrics.missingCount)}일` : "날짜별 기준"],
    ["수량 신뢰도", decision.quantityConfidence, audit.criteria?.find((criterion) => criterion.key === "quantity")?.reason || "자동 수량 판단"],
    ["공백 유형", decision.gapType, audit.criteria?.find((criterion) => criterion.key === "gap")?.reason || "요일별 공백"],
    ["확인 채널", decision.channelText, audit.otaReason || "필요 채널"],
    ["보정 상태", decision.correctionText, decision.adminReviewText || "관리자 판단 대기"]
  ];
  return `
    <section class="sheet-section sheet-audit-section ${escapeHtml(audit.tone)}">
      <div class="sheet-structure-title">
        <h3>관리자 판단 큐 V2</h3>
        <span class="structure-badge ${escapeHtml(audit.otaCheckNeeded ? "ota-check" : audit.tone)}">${escapeHtml(decision.inQueue ? decision.label : "바로 판단 가능")}</span>
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
      <div class="sheet-audit-reasons">
        ${(decision.reasons.length ? decision.reasons : ["현재 기준 특이 신호가 없습니다."]).map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
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
  if (!priced && !missing) return "가격/판매수량 대기";
  return `${fmtNumber(priced)}${revenue.unit} 가격확인${missing ? ` · 가격누락 ${fmtNumber(missing)}${revenue.unit}` : ""}`;
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
  return `
    <section class="sheet-section sheet-revenue-section">
      <div class="sheet-structure-title">
        <h3>예상 매출 정밀 산정</h3>
        <span class="structure-badge ${escapeHtml(precision.tone)}">${escapeHtml(`${precision.grade} · ${precision.label}`)}</span>
      </div>
      <div class="sheet-history-grid">
        <div>
          <span>전체 예상매출</span>
          <strong>${fmtWon(profile.totalRevenue)}</strong>
          <small>${escapeHtml(`가격확보 ${Number.isFinite(precision.coverage) ? fmtRate(precision.coverage) : "대기"} · ${fmtNumber(precision.priced)}개/회`)}</small>
        </div>
        <div>
          <span>숙박 매출</span>
          <strong>${fmtWon(lodging.revenue)}</strong>
          <small>${escapeHtml(`${lodging.label} · ${revenueCoverageText(lodging)}`)}</small>
        </div>
        <div>
          <span>숙박 평균단가</span>
          <strong>${lodging.avgSoldUnitPrice ? fmtWon(lodging.avgSoldUnitPrice) : "확인필요"}</strong>
          <small>상품별 가격×판매수량 가중 평균</small>
        </div>
        <div>
          <span>데이유즈/캠프닉</span>
          <strong>${fmtWon(dayUse.revenue)}</strong>
          <small>${escapeHtml(`${dayUse.label} · ${revenueCoverageText(dayUse)}`)}</small>
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
          <h3>관리자 판단 요약</h3>
          <p>${escapeHtml(analysis.label)} · ${fmtNumber(analysis.score)}점 · ${escapeHtml(structure.label)}</p>
        </div>
        <span class="confidence-badge ${escapeHtml(correctionStatus.tone)}">${escapeHtml(correctionStatus.label)}</span>
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
      ${validationReasonRow(item)}
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
  return `
    ${sheetFlowOverview(item)}
    ${sheetCollectionStatusPanel(item)}
    ${sheetRevenuePanel(item)}
    ${sheetAuditPanel(item)}
    ${sheetRecrawlComparisonPanel(item)}
    ${sheetCompanyProfile(item)}
    ${sheetHistoryPanel(item)}
    ${sheetInventoryStructure(item)}
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
    <section class="sheet-section">
      <h3>플랫폼 비교</h3>
      ${baseRows.map((row) => {
        const [tone, label] = platformStatus(row);
        const url = externalPlatformUrl(row.url);
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
            ? `<a class="platform-row ${tone}" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(`${platformShortName(row.platform)}에서 ${item.name || "업체"} 보기`)}">${rowContent}</a>`
            : `<div class="platform-row ${tone}">${rowContent}</div>`}
        `;
      }).join("")}
    </section>
    <section class="sheet-section">
      <h3>OTA 보조 확인</h3>
      <div class="search-row">
        <div>
          <strong>${audit.otaCheckNeeded ? "OTA 확인 필요" : "현재는 네이버 기준 판단"}</strong>
          <small>${audit.otaCheckNeeded ? escapeHtml(audit.otaReason || "네이버 수량 해석 보조 확인") : "네이버 재고 구조가 안정적이면 OTA는 노출/가격 보조값으로만 봅니다."}</small>
        </div>
        <strong>${audit.otaCheckNeeded ? "색인" : "보조"}</strong>
      </div>
    </section>
  `;
}

function renderSheetSearch(item) {
  const region = (state.data?.regions || []).find((entry) => String(entry.region || "").includes(item.region) || String(item.region || "").includes(entry.region));
  const traffic = region?.traffic || state.data?.stats?.traffic || {};
  return `
    <section class="sheet-section">
      <h3>검색수요</h3>
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

async function loadHistoryOps() {
  try {
    state.historyOps = await fetchJson("/api/history/summary");
  } catch (error) {
    state.historyOps = { error: error.message, keywords: [], overall: {} };
    if (els.historyOpsState) els.historyOpsState.textContent = "오류";
  }
}

async function loadCompanyMasterSummary() {
  try {
    state.companyMaster = await fetchJson("/api/company-master/summary");
  } catch (error) {
    state.companyMaster = { error: error.message, totalCompanies: 0, duplicateCandidates: [] };
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
  button.disabled = true;
  setStatus(status === "clear" ? "검증 해제 중" : "검증 저장 중");
  try {
    const data = await fetchJson("/api/company-master/admin-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, status, note })
    });
    state.companyMaster = data;
    if (state.data) state.data.companyMaster = { ...(state.data.companyMaster || {}), ...data };
    renderCompanyMasterPanel();
    renderDecisionQueue();
    renderTargets();
    setStatus(status === "clear" ? "검증 해제 완료" : `${companyAdminReviewLabel(status)} 저장 완료`);
  } catch (error) {
    setStatus("검증 저장 실패");
    if (els.companyMasterPanel) {
      els.companyMasterPanel.insertAdjacentHTML("afterbegin", `<div class="empty">검증 저장 실패: ${escapeHtml(error.message)}</div>`);
    }
  } finally {
    button.disabled = false;
  }
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
  const plan = companyQueueRecrawlPlan(company, profile, decision);
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
    els.crawlStatus.textContent = `${company.primaryName || "업체"} 재수집 설정을 적용했습니다. 조건을 확인한 뒤 수집 실행을 누르세요.`;
  }
  setStatus("재수집 설정 적용");
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
  setStatus("결과 로딩");
  const data = await fetchJson("/api/runs");
  state.runs = data.runs || [];
  els.runSelect.innerHTML = state.runs.map((run) => `<option value="${escapeHtml(run.id)}">${escapeHtml(run.label || run.id)}</option>`).join("");
  if (!state.runs.length) {
    if (els.reportBody) els.reportBody.innerHTML = `<div class="empty">실행 결과가 없습니다. 관리 탭에서 새 수집을 실행하세요.</div>`;
    els.companyList.innerHTML = `<div class="empty">실행 결과가 없습니다. 관리 탭에서 새 수집을 실행하세요.</div>`;
    if (els.decisionQueueCount) els.decisionQueueCount.textContent = "0 대기";
    if (els.decisionQueueList) els.decisionQueueList.innerHTML = `<div class="empty">실행 결과가 없습니다. 수집 후 판단 큐가 생성됩니다.</div>`;
    setStatus("결과 없음");
    return;
  }
  if (selectLatest || !state.activeRunId || !state.runs.some((run) => run.id === state.activeRunId)) {
    state.activeRunId = state.runs[0].id;
  }
  els.runSelect.value = state.activeRunId;
  await loadRun(state.activeRunId);
}

async function loadRun(runId) {
  if (!runId) return;
  setStatus("데이터 로딩");
  const data = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
  state.data = data;
  state.activeRunId = runId;
  await loadHistoryOps();
  await loadCompanyMasterSummary();
  syncDictionaryInputToActiveRun(true);
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
  const collectionMode = els.collectionModeInput?.value || "precision";
  const rawDetailRankRanges = els.detailRankRangesInput?.value?.trim() || "";
  const detailRankRanges = collectionMode === "fast"
    ? ""
    : (/^(none|skip|없음)$/i.test(rawDetailRankRanges) ? "1-20" : (rawDetailRankRanges || "1-20"));
  const payload = {
    keyword: els.keywordInput.value.trim(),
    checkIn: els.checkInInput.value,
    checkOut: els.checkOutInput.value,
    searchMode: resolvedMode,
    productMode: els.productModeInput.value,
    collectionMode,
    detailRankRanges
  };
  if (submitButton?.disabled) return;
  if (submitButton) submitButton.disabled = true;
  const detailText = payload.collectionMode === "fast"
    ? "상세 분석 생략"
    : `상세 ${payload.detailRankRanges || "1-20"}위`;
  const preview = crawlPreviewMeta(payload);
  setCrawlProgress(
    true,
    "수집 실행 중",
    `${collectionModeLabel(payload.collectionMode)} · ${searchModeLabel(payload.searchMode)} · ${detailText}`,
    preview
  );
  els.crawlStatus.textContent = `${collectionModeLabel(payload.collectionMode)} 기준 수집을 시작했습니다. ${detailText}. 예상 ${formatElapsed(preview.estimatedTotalSeconds)} · 완료 ${formatClockTime(preview.estimatedCompleteAt)}.`;
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
    els.crawlStatus.textContent = "수집 완료. 화면을 갱신했습니다.";
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
}

function bindEvents() {
  document.querySelectorAll(".bottom-nav button").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });
  document.addEventListener("click", (event) => {
    const open = event.target.closest("[data-open-company]");
    if (open) openSheet(open.dataset.openCompany);
    const duplicateAction = event.target.closest("[data-company-duplicate-action]");
    if (duplicateAction) resolveCompanyDuplicate(duplicateAction);
    const saveCorrection = event.target.closest("[data-save-company-correction]");
    if (saveCorrection) saveCompanyCorrection(saveCorrection, false);
    const clearCorrection = event.target.closest("[data-clear-company-correction]");
    if (clearCorrection) saveCompanyCorrection(clearCorrection, true);
    const reviewAction = event.target.closest("[data-company-review-action]");
    if (reviewAction) saveCompanyAdminReview(reviewAction);
    const salesContact = event.target.closest("[data-save-sales-contact]");
    if (salesContact) saveCompanySalesContact(salesContact);
    const salesScript = event.target.closest("[data-copy-sales-script]");
    if (salesScript) copySalesProposal(salesScript, "script");
    const salesCallNote = event.target.closest("[data-copy-sales-call-note]");
    if (salesCallNote) copySalesProposal(salesCallNote, "call");
    if (event.target.closest("[data-export-sales-targets]")) exportSalesTargetsCsv();
    if (event.target.closest("[data-export-collection-quality]")) exportCollectionQualityCsv();
    if (event.target.closest("[data-export-recrawl-automation]")) exportRecrawlAutomationCsv();
    const qualitySetting = event.target.closest("[data-apply-quality-setting]");
    if (qualitySetting) applyCollectionQualitySetting(qualitySetting);
    const queueRecrawl = event.target.closest("[data-queue-recrawl-company]");
    if (queueRecrawl) applyQueueRecrawlSetting(queueRecrawl);
    const checkFilter = event.target.closest("[data-company-check-filter]");
    if (checkFilter) {
      state.companyMasterFilters.check = checkFilter.dataset.companyCheckFilter || "priority";
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
  document.addEventListener("input", (event) => {
    const search = event.target.closest("[data-company-master-search]");
    if (!search) return;
    state.companyMasterFilters.query = search.value || "";
    rerenderCompanyMasterPreservingSearch();
  });
  document.addEventListener("change", (event) => {
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
  els.collectionModeInput?.addEventListener("change", syncCollectionModeInputs);
  els.dictionarySearchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    runDictionarySearch();
  });
  els.dictionaryQuickButtons?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-location-query]");
    if (!button) return;
    runDictionarySearch(button.dataset.locationQuery);
  });
  els.dictionaryResult?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-location-query]");
    if (!button) return;
    runDictionarySearch(button.dataset.locationQuery);
  });
}

async function init() {
  ensureCrawlControls();
  syncCollectionModeInputs();
  bindEvents();
  setDefaultDates();
  try {
    await Promise.all([loadRuns(true), loadTrafficState(), loadLocationDictionary()]);
    pollCrawlStatusUntilIdle(false);
  } catch (error) {
    setStatus("오류");
    els.pageSubtitle.textContent = error.message;
    els.companyList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    loadLocationDictionary();
  }
}

init();
