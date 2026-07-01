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
    target: "all"
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
  crawlProgress: document.getElementById("crawlProgress"),
  crawlProgressTitle: document.getElementById("crawlProgressTitle"),
  crawlProgressText: document.getElementById("crawlProgressText"),
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
    `;
    submitButton?.after(progress);
    els.crawlProgress = progress;
    els.crawlProgressTitle = progress.querySelector("#crawlProgressTitle");
    els.crawlProgressText = progress.querySelector("#crawlProgressText");
  }
}

function searchModeLabel(value) {
  return value === "company" ? "업체명" : "키워드/권역";
}

function setCrawlProgress(active, title = "", text = "") {
  if (!els.crawlProgress) return;
  els.crawlProgress.hidden = !active;
  if (title && els.crawlProgressTitle) els.crawlProgressTitle.textContent = title;
  if (text && els.crawlProgressText) els.crawlProgressText.textContent = text;
}

function formatElapsed(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const minutes = Math.floor(value / 60);
  const rest = Math.round(value % 60);
  return minutes ? `${minutes}분 ${rest}초` : `${rest}초`;
}

async function pollCrawlStatusUntilIdle(notifyIdle = false) {
  if (state.crawlStatusTimer) {
    clearTimeout(state.crawlStatusTimer);
    state.crawlStatusTimer = null;
  }
  try {
    const status = await fetchJson("/api/crawl-status");
    if (status.active) {
      const elapsed = formatElapsed(status.elapsedSeconds);
      setCrawlProgress(
        true,
        "수집 진행 중",
        `네이버·NOL·떠나요를 확인하고 있습니다${elapsed ? ` · ${elapsed} 경과` : ""}.`
      );
      if (els.crawlStatus) {
        els.crawlStatus.textContent = `기존 수집이 진행 중입니다${elapsed ? ` (${elapsed} 경과)` : ""}. 완료되면 결과를 자동 갱신합니다.`;
      }
      setStatus("수집 중");
      state.crawlStatusTimer = setTimeout(() => pollCrawlStatusUntilIdle(true), 10000);
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
  const rate = sales.supply ? sales.sold / sales.supply : finiteNumber(state.data?.availability?.stats?.weightedSoldOutRate, NaN);
  const checked = state.data?.availability?.stats?.checkedPlaces || items.length;
  const lowConfidence = finiteNumber(state.data?.availability?.stats?.lowConfidenceCount, 0);
  const stockVariance = finiteNumber(state.data?.availability?.stats?.stockVarianceCount, 0);
  els.summaryGrid.innerHTML = `
    <article class="summary-card">
      <span class="summary-icon blue">${summaryIcon("sales")}</span>
      <div><strong>${fmtNumber(sales.sold)}/${fmtNumber(sales.supply)}</strong><small>객실 판매</small></div>
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

function renderCompanies() {
  const items = state.data?.availability?.items || [];
  els.rankCount.textContent = `${fmtNumber(items.length)} 업체`;
  if (!items.length) {
    els.companyList.innerHTML = `<div class="empty">업체별 판매/재고 데이터가 없습니다.</div>`;
    return;
  }

  const cards = items.slice(0, 30).map((item, index) => {
    const lodging = salesStats(item, "lodging");
    const day = salesStats(item, "day");
    const metric = lodging.supply ? `${fmtNumber(lodging.sold)}/${fmtNumber(lodging.supply)}` : "확인필요";
    return `
      <article class="company-card" data-company-index="${index}">
        <div class="company-main">
          <span class="rank-badge">${escapeHtml(item.rank || index + 1)}</span>
          <div class="company-title">
            <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
            <small>${escapeHtml(categoryText(item))}</small>
            <div class="company-badges">${inventoryConfidenceBadge(item)}${inventoryStructureBadge(item)}${manualCorrectionBadge(item)}${otaVerificationBadge(item)}</div>
          </div>
        </div>
        <div class="company-metric">
          <strong>${metric}</strong>
          <span>${lodging.supply ? "숙박 추정" : "재고 확인"}</span>
          <small>${fmtRate(lodging.rate)}</small>
        </div>
        <div class="company-chart">
          <div class="sales-lines">
            <span class="sales-line">${escapeHtml(salesLine(item, "lodging"))}</span>
            <span class="sales-line day">${escapeHtml(salesLine(item, "day"))}</span>
          </div>
          ${flowChipRow(item)}
          ${validationReasonRow(item)}
          ${miniBars(item)}
        </div>
        <div class="company-action">
          <div class="company-price-platform">
            ${priceBlock(item)}
            <div class="platform-chips">${platformChips(item)}</div>
          </div>
          <button class="more-button" type="button" data-open-company="${index}">더보기</button>
        </div>
      </article>
    `;
  }).join("");
  els.companyList.innerHTML = `${renderValidationBoard(items)}${cards}`;
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
  }

  if (varianceRows.length) {
    priority += Math.min(30, varianceRows.length * 8);
    reasons.push(`총량 튐 ${fmtNumber(varianceRows.length)}일`);
    otaSignals.push("총량 이상치");
  }

  if (missingCount) {
    if (statusKey === "normal") {
      statusKey = "quantity_check";
      tone = "watch";
    }
    priority += Math.min(32, missingCount * 6);
    reasons.push(`미수집 날짜 ${fmtNumber(missingCount)}일`);
    actions.push("동일 기간으로 재수집 후 날짜별 상세 비교");
  }

  if (["D", "E"].includes(confidence.grade)) {
    if (statusKey === "normal") {
      statusKey = "quantity_check";
      tone = "watch";
    }
    priority += confidence.grade === "E" ? 30 : 18;
    reasons.push(`수집 신뢰도 ${confidence.grade}`);
    if (confidence.grade === "E") otaSignals.push("수집 신뢰도 낮음");
  }

  if (flags.has("dayuse_rotation") || (day.supply && lodging.supply && day.supply >= lodging.supply * 0.6)) {
    priority += 14;
    reasons.push("데이유즈/캠프닉 회전형 상품 병행 가능성");
    actions.push("숙박과 당일상품을 분리해서 판매수·총량 확인");
  }

  if (Number.isFinite(weekdayGap) && Math.abs(weekdayGap) >= 0.25) {
    if (statusKey === "normal") {
      statusKey = "quantity_check";
      tone = "watch";
    }
    priority += 16;
    reasons.push(`누적 평일 대비 ${rateGapText(weekdayGap)}`);
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
    phone_stock: "전화예약/재고조절 가능성"
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

  return {
    statusKey,
    label: labelMap[statusKey] || "확인 필요",
    indexLabel: otaCheckNeeded ? "OTA 확인 필요" : (labelMap[statusKey] || "확인 필요"),
    otaCheckNeeded,
    otaReason,
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
      collectedDays: collectedRows.length
    }
  };
}

function validationQueueEntries(items = [], limit = 8) {
  const entries = items
    .map((item, index) => ({ item, index, audit: inventoryAuditProfile(item) }))
    .filter(({ audit }) => audit.statusKey !== "confirmed" && audit.statusKey !== "normal")
    .sort((a, b) => b.audit.priority - a.audit.priority || Number(a.item.rank || 999) - Number(b.item.rank || 999));
  return limit ? entries.slice(0, limit) : entries;
}

function auditIndexLabel(audit = {}) {
  return audit.otaCheckNeeded ? "OTA 확인 필요" : (audit.indexLabel || audit.label || "확인 필요");
}

function renderValidationQueue(items = []) {
  const entries = validationQueueEntries(items, 6);
  const allEntries = items.map((item) => inventoryAuditProfile(item));
  const counts = allEntries.reduce((acc, audit) => {
    acc[audit.statusKey] = (acc[audit.statusKey] || 0) + 1;
    if (audit.otaCheckNeeded) acc.otaCheckNeeded = (acc.otaCheckNeeded || 0) + 1;
    if (audit.statusKey === "quantity_check" && !audit.otaCheckNeeded) acc.sourceCheck = (acc.sourceCheck || 0) + 1;
    return acc;
  }, {});
  const chips = [
    ["OTA 확인 필요", counts.otaCheckNeeded || 0, "bad"],
    ["원자료 재확인", counts.sourceCheck || 0, "watch"],
    ["오프라인예약 가능성", counts.phone_stock || 0, "watch"],
    ["정상/확정", (counts.normal || 0) + (counts.confirmed || 0), "good"]
  ];
  return `
    <div class="validation-card validation-card-audit">
      <div class="validation-card-head compact">
        <div>
          <span class="eyebrow">확인 필요</span>
          <h3>네이버 기준 해석 보조 확인</h3>
        </div>
        <span>${fmtNumber(counts.otaCheckNeeded || 0)} OTA색인</span>
      </div>
      <div class="audit-status-strip">
        ${chips.map(([label, count, tone]) => `<span class="${tone}">${escapeHtml(label)} <b>${fmtNumber(count)}</b></span>`).join("")}
      </div>
      <div class="audit-queue-list">
        ${entries.length ? entries.map(({ item, index, audit }) => {
          const metric = audit.metrics.totalMax
            ? `총량 ${fmtNumber(audit.metrics.totalMin)}~${fmtNumber(audit.metrics.totalMax)}개`
            : `${fmtNumber(audit.metrics.collectedDays)}일 관측`;
          return `
            <button type="button" data-open-company="${index}">
              <span class="audit-rank">${escapeHtml(item.rank || index + 1)}</span>
              <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
              <em class="${escapeHtml(audit.otaCheckNeeded ? "bad" : audit.tone)}">${escapeHtml(auditIndexLabel(audit))}</em>
              <small>${escapeHtml([metric, audit.reasons[0]].filter(Boolean).join(" · "))}</small>
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
  const audit = inventoryAuditProfile(item);
  const reasons = [
    `${auditIndexLabel(audit)}: ${audit.actions[0] || "확인"}`,
    ...audit.reasons,
    `구조: ${structure.label}`,
    `확인: ${structure.action}`,
    ...confidence.alerts.map((reason) => `검증: ${reason}`),
    ...structure.notes,
    ...analysis.reasons
  ].filter(Boolean).slice(0, 4);
  if (!reasons.length) return "";
  return `
    <div class="reason-chip-row" aria-label="판단 근거">
      ${reasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
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
          <h3>우선 확인</h3>
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
        <small>${missingItems ? `${fmtNumber(missingItems)}개 업체는 일부 날짜 미수집` : "입력 기간 날짜별 수집 정상"}</small>
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

function targetEntries(limit = 15) {
  const entries = (state.data?.availability?.items || [])
    .map((item) => ({ item, ...targetExpansionAnalysis(item) }))
    .filter((entry) => entry.score >= 42 && entry.reasons.length)
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
  if (review === "confirmed") return { key: "confirmed", label: "확정 타깃", priority: 0 };
  if (review === "manual_needed") return { key: "manual", label: "보정 필요", priority: 2 };
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
      return { company, stage, action, item };
    })
    .filter((entry) => entry.stage.key !== "exclude" && ["confirmed", "contact", "manual", "verify", "hold"].includes(entry.stage.key))
    .sort((a, b) => a.stage.priority - b.stage.priority || (b.company.salesTarget?.score || 0) - (a.company.salesTarget?.score || 0) || (a.company.bestRank || 9999) - (b.company.bestRank || 9999));
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
    collectable: source?.collectable
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
  const statusLabel = trend.reason ? errorLabel : (trend.configured ? "데이터랩 준비" : "API 키 필요");
  const detailLabel = trend.hasSeries
    ? "최고점=100 기준"
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
      ${entries.map(({ item, index, audit }) => `
        <button class="${escapeHtml(audit.tone)}" type="button" data-open-company="${index}">
          <strong>${escapeHtml(item.name || "업체명 확인")}</strong>
          <span>${escapeHtml(auditIndexLabel(audit))} · ${escapeHtml(audit.reasons[0] || audit.actions[0] || "확인 필요")}</span>
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
    confirmed: "판단 맞음",
    hold: "보류",
    exclude: "제외",
    manual_needed: "보정 필요"
  }[status] || "미검증";
}

function companyAdminReviewBadgeHtml(company = {}) {
  const status = company.adminReview?.status || "pending";
  const label = company.adminReview?.label || companyAdminReviewLabel(status);
  return `<span class="company-review-badge ${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function companyReviewActionsHtml(company = {}, compact = false) {
  const companyId = company.companyId || "";
  const current = company.adminReview?.status || "";
  const actions = [
    ["confirmed", "맞음"],
    ["hold", "보류"],
    ["manual_needed", "보정"],
    ["exclude", "제외"]
  ];
  return `
    <div class="company-review-actions ${compact ? "compact" : ""}">
      ${actions.map(([status, label]) => `
        <button type="button" class="${current === status ? "active" : ""}" data-company-review-action="${status}" data-company-id="${escapeHtml(companyId)}">${label}</button>
      `).join("")}
      ${current ? `<button type="button" data-company-review-action="clear" data-company-id="${escapeHtml(companyId)}">해제</button>` : ""}
    </div>
  `;
}

function companyNeedsCorrection(company = {}) {
  const signals = company.salesTarget?.signals || {};
  const tags = company.salesTarget?.priorityTags || [];
  const reasons = company.salesTarget?.reasons || [];
  const latest = company.inventory?.latest || {};
  const hasManualCorrection = manualCorrectionHasValue(company.manualCorrection);
  const hasText = (text) => tags.some((tag) => String(tag).includes(text)) || reasons.some((reason) => String(reason).includes(text));
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
  if (company.adminReview?.status === "manual_needed" && !issues.some((issue) => issue.key === "manual")) {
    issues.unshift({ key: "manual", label: "관리자 보정", task: "관리자가 보정 필요로 지정한 업체" });
  }
  return {
    needed: company.adminReview?.status === "manual_needed" || issues.length > 0,
    issues,
    applied: hasManualCorrection,
    priority: (company.adminReview?.status === "manual_needed" ? 40 : 0) + issues.length * 12 + (hasManualCorrection ? -18 : 0) + Number(company.salesTarget?.score || 0) / 10
  };
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
  const topTargets = targets.topTargets || [];
  return `
    <div class="company-sales-panel">
      <div class="company-sales-metrics">
        <article><span>컨택 후보</span><strong>${fmtNumber(targets.contactCandidateCount || 0)}</strong><small>로컬 전용 중심</small></article>
        <article><span>검증 후보</span><strong>${fmtNumber(targets.verificationQueueCount || 0)}</strong><small>로컬 매칭 필요</small></article>
        <article><span>벤치마크</span><strong>${fmtNumber(targets.benchmarkCount || 0)}</strong><small>광역+로컬 강자</small></article>
      </div>
      <div class="company-sales-list">
        <strong>우선 컨택 후보</strong>
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
        `).join("") : `<p>현재 기준 우선 컨택 후보가 없습니다. 로컬 키워드 수집이 늘어나면 자동으로 채워집니다.</p>`}
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

function rerenderCompanyMasterPreservingSearch() {
  const active = document.activeElement;
  const preserveSearch = active?.matches?.("[data-company-master-search]");
  const selectionStart = preserveSearch ? active.selectionStart : null;
  const selectionEnd = preserveSearch ? active.selectionEnd : null;
  renderCompanyMasterPanel();
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
    ${companyMasterReviewQueuePanel(master)}
    ${companyMasterCorrectionPanel(master)}
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
    ? "트렌드 반영"
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
        <div class="demand-rule-box">
          <strong>판단 기준</strong>
          <p>검색량은 시장 크기, 트렌드는 타이밍, 예약재고와 플랫폼 공백은 영업 가능성을 판단합니다.</p>
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
  const manual = boardEntries.filter((entry) => entry.stage.key === "manual" || entry.stage.key === "verify");
  const hold = boardEntries.filter((entry) => entry.stage.key === "hold");
  const actionableCount = confirmed.length + contact.length;
  const currentOnly = currentItems.filter(({ item }) => !boardEntries.some((entry) => entry.item === item)).slice(0, 6);

  els.targetCount.textContent = `${fmtNumber(actionableCount || currentItems.length)} 타깃`;
  if (!boardEntries.length && !currentItems.length) {
    els.targetList.innerHTML = `<div class="empty">현재 기준 영업 후보가 없습니다.</div>`;
    return;
  }

  const boardCard = (entry, index) => {
    const { company, stage, action, item } = entry;
    const itemIndex = item ? (state.data?.availability?.items || []).indexOf(item) : -1;
    const regionText = (company.regions || []).slice(0, 2).join(" · ") || item?.region || "지역 확인";
    const tags = company.salesTarget?.priorityTags || [];
    return `
      <article class="target-action-card ${stage.key}">
        <div class="target-action-head">
          <span>${index + 1}</span>
          <div>
            <strong>${escapeHtml(company.primaryName || item?.name || "업체명 확인")}</strong>
            <small>${escapeHtml(regionText)} · ${escapeHtml(stage.label)} · ${fmtNumber(company.salesTarget?.score || 0)}점</small>
          </div>
          ${companyAdminReviewBadgeHtml(company)}
        </div>
        <div class="target-action-main">
          <b>${escapeHtml(action.label)}</b>
          <p>${escapeHtml(action.pitch)}</p>
        </div>
        <div class="target-reasons">
          ${tags.length ? tags.slice(0, 5).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("") : (company.salesTarget?.reasons || []).slice(0, 4).map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
        </div>
        <div class="target-next-line">
          <strong>다음 확인</strong>
          <span>${escapeHtml(action.next)}</span>
        </div>
        <div class="target-card-actions">
          ${itemIndex >= 0 ? `<button class="secondary-button" type="button" data-open-company="${itemIndex}">상세 보기</button>` : `<button class="secondary-button" type="button" data-drawer-tab="admin">관리에서 확인</button>`}
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
      <article><span>오늘 컨택</span><strong>${fmtNumber(actionableCount)}</strong><small>확정+컨택 후보</small></article>
      <article><span>검증 완료</span><strong>${fmtNumber(confirmed.length)}</strong><small>판단 맞음</small></article>
      <article><span>보정 필요</span><strong>${fmtNumber(manual.length)}</strong><small>수량/채널 확인</small></article>
      <article><span>보류</span><strong>${fmtNumber(hold.length)}</strong><small>추가 관찰</small></article>
    </section>
    <section class="target-board">
      ${lane("확정 타깃", "관리자가 판단 맞음으로 확정한 업체", confirmed, "아직 확정 타깃이 없습니다. 관리 탭에서 후보를 검증하세요.")}
      ${lane("컨택 후보", "광역 진입 또는 판매 개선 여지가 큰 업체", contact, "현재 컨택 후보가 없습니다.")}
      ${lane("보정/검증 필요", "수량 구조나 OTA 확인 후 제안해야 하는 업체", manual, "보정 또는 검증 필요 업체가 없습니다.")}
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
    map: "지역 클러스터 지도",
    demand: "수요구조 분석",
    historyOps: "누적 DB 분석",
    admin: "관리"
  };
  els.pageTitle.textContent = titleMap[state.activeTab] || "요약 리포트";
  if (state.activeTab === "dictionary") {
    els.pageSubtitle.textContent = "저장된 지역 카드 · 8대 지수 · 클러스터 판정";
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

function sheetAuditPanel(item = {}) {
  const audit = inventoryAuditProfile(item);
  const metrics = [
    ["확인색인", auditIndexLabel(audit), audit.otaReason || audit.actions[0] || "확인"],
    ["총량변동", audit.metrics.totalMax ? `${fmtNumber(audit.metrics.totalMin)}~${fmtNumber(audit.metrics.totalMax)}개` : "대기", audit.metrics.totalGap ? `차이 ${fmtNumber(audit.metrics.totalGap)}개` : "변동 없음"],
    ["미수집", `${fmtNumber(audit.metrics.missingCount)}일`, "입력기간 기준"],
    ["누적편차", rateGapText(audit.metrics.weekdayGap), "현재 평일-누적 평일"]
  ];
  return `
    <section class="sheet-section sheet-audit-section ${escapeHtml(audit.tone)}">
      <div class="sheet-structure-title">
        <h3>확인 필요 판단</h3>
        <span class="structure-badge ${escapeHtml(audit.otaCheckNeeded ? "ota-check" : audit.tone)}">${escapeHtml(auditIndexLabel(audit))}</span>
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
        ${(audit.reasons.length ? audit.reasons : ["현재 기준 특이 신호가 없습니다."]).map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}
      </div>
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
    ${sheetAuditPanel(item)}
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
  button.disabled = true;
  setStatus(status === "clear" ? "검증 해제 중" : "검증 저장 중");
  try {
    const data = await fetchJson("/api/company-master/admin-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, status })
    });
    state.companyMaster = data;
    if (state.data) state.data.companyMaster = { ...(state.data.companyMaster || {}), ...data };
    renderCompanyMasterPanel();
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
  const payload = {
    keyword: els.keywordInput.value.trim(),
    checkIn: els.checkInInput.value,
    checkOut: els.checkOutInput.value,
    searchMode: resolvedMode,
    productMode: els.productModeInput.value
  };
  if (submitButton?.disabled) return;
  if (submitButton) submitButton.disabled = true;
  setCrawlProgress(
    true,
    "수집 실행 중",
    `${searchModeLabel(payload.searchMode)} 기준으로 네이버·NOL·떠나요를 확인합니다.`
  );
  els.crawlStatus.textContent = `${searchModeLabel(payload.searchMode)} 기준 수집을 시작했습니다. 완료되면 화면을 갱신합니다.`;
  setStatus("수집 중");
  try {
    const result = await fetchJson("/api/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.runs = result.runs || state.runs;
    state.activeRunId = result.runId || state.runs[0]?.id;
    await loadRuns(false);
    setCrawlProgress(false);
    els.crawlStatus.textContent = "수집 완료. 화면을 갱신했습니다.";
    setActiveTab("rank");
  } catch (error) {
    if (error.status === 409) {
      setCrawlProgress(true, "수집 대기 중", "이미 진행 중인 수집이 끝나면 결과를 자동으로 불러옵니다.");
      els.crawlStatus.textContent = `${error.message} 결과가 생기면 자동으로 갱신합니다.`;
      setStatus("수집 중");
      pollCrawlStatusUntilIdle(true);
    } else {
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
    }
    const target = event.target.closest("[data-company-master-target]");
    if (target) {
      state.companyMasterFilters.target = target.value || "all";
      renderCompanyMasterPanel();
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
