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
      return {
        sold: weeklySold,
        supply: normalizedSupply,
        rawSupply: weeklySupply,
        rate: normalizedSupply ? weeklySold / normalizedSupply : weeklySold / weeklySupply,
        unit: "개",
        label: `${rows.length || days}일 집계`,
        basis: "range"
      };
    }
    if (rows.length) {
      const sum = rows.reduce((acc, row) => {
        acc.sold += finiteNumber(row.sold);
        acc.supply += finiteNumber(row.total);
        return acc;
      }, { sold: 0, supply: 0 });
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
    return {
      sold: weeklySold,
      supply: normalizedSupply,
      rawSupply: weeklySupply,
      rate: normalizedSupply ? weeklySold / normalizedSupply : weeklySold / weeklySupply,
      unit: "회",
      label: `${rows.length || days}일 집계`,
      basis: "range"
    };
  }
  if (rows.length) {
    const sum = rows.reduce((acc, row) => {
      acc.sold += finiteNumber(row.sold);
      acc.supply += finiteNumber(row.total);
      return acc;
    }, { sold: 0, supply: 0 });
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

function inventoryConfidenceBadge(item = {}) {
  const info = inventoryConfidenceInfo(item);
  const alertText = info.alerts.length ? ` · ${info.alerts[0]}` : "";
  return `<span class="confidence-badge ${info.tone}" title="${escapeHtml(info.summary)}">신뢰도 ${escapeHtml(info.grade)}${escapeHtml(alertText)}</span>`;
}

function bookingGraphRows(item) {
  const run = state.data?.run || {};
  const rows = weeklyRows(item);
  const rowMap = new Map(rows.map((row) => [normalizeMonthDayLabel(row.label), row]));
  const lodging = salesStats(item, "lodging");
  const baseTotal = finiteNumber(item.nightTotalStock, finiteNumber(item.totalRooms, finiteNumber(lodging.supply, 0)));
  const maxTotal = Math.max(
    0,
    baseTotal,
    finiteNumber(item.weeklyBasisTotal, 0),
    ...rows.map((row) => finiteNumber(row.total, 0))
  );
  const basisLabel = normalizeMonthDayLabel(monthDay(run.checkIn));

  return bookingRangeLabels(run).map((label) => {
    const key = normalizeMonthDayLabel(label);
    const row = rowMap.get(key);
    if (row) {
      const rawTotal = finiteNumber(row.total, maxTotal);
      const basisTotal = Math.max(maxTotal, rawTotal);
      const sold = finiteNumber(row.sold, 0);
      return {
        label,
        sold,
        total: basisTotal,
        rawTotal,
        hidden: Math.max(0, basisTotal - rawTotal),
        rate: basisTotal ? sold / basisTotal : row.rate,
        rawRate: row.rate,
        source: "daily",
        missing: false,
        maxTotal: basisTotal
      };
    }
    if (!rows.length && key === basisLabel && lodging.supply) {
      return {
        label,
        sold: finiteNumber(lodging.sold, 0),
        total: finiteNumber(lodging.supply, maxTotal),
        rawTotal: finiteNumber(lodging.rawSupply, finiteNumber(lodging.supply, maxTotal)),
        hidden: Math.max(0, finiteNumber(lodging.supply, maxTotal) - finiteNumber(lodging.rawSupply, finiteNumber(lodging.supply, maxTotal))),
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
            : `${row.label} 마감추정 ${fmtNumber(row.sold)}/${fmtNumber(row.total)}개 · 판매열림 ${fmtNumber(openStock)}개${hidden ? ` · 미오픈/차단 ${fmtNumber(hidden)}개` : ""}`;
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
            <div class="company-badges">${inventoryConfidenceBadge(item)}</div>
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

function validationReasonRow(item = {}) {
  const analysis = targetExpansionAnalysis(item);
  const confidence = inventoryConfidenceInfo(item);
  const reasons = [
    ...confidence.alerts.map((reason) => `검증: ${reason}`),
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
          ${validationCardValue("검증 필요", fmtNumber(lowConfidence), `총량 변동 ${fmtNumber(stockVariance)}`)}
        </div>
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
    </section>
  `;
}

function targetExpansionAnalysis(item = {}) {
  const platforms = platformsForItem(item).map((row) => platformShortName(row.platform));
  const lodging = salesStats(item, "lodging");
  const day = salesStats(item, "day");
  const confidence = inventoryConfidenceInfo(item);
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
  if (!platforms.includes("여기어때")) {
    score += 5;
    reasons.push("여기어때 확인");
  }
  if (!platforms.includes("야놀자")) {
    score += 4;
    reasons.push("야놀자 확인");
  }
  if (["D", "E"].includes(confidence.grade)) {
    score -= 12;
    reasons.push("수집값 검증 필요");
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

function reportPlatformStats(items = []) {
  const platformNames = ["네이버", "야놀자", "여기어때", "떠나요"];
  const stats = Object.fromEntries(platformNames.map((name) => [name, 0]));
  for (const item of items) {
    const names = platformsForItem(item).map((row) => platformShortName(row.platform));
    platformNames.forEach((name) => {
      if (names.includes(name)) stats[name] += 1;
    });
  }
  return {
    names: platformNames,
    counts: stats,
    missingYeogi: Math.max(0, items.length - stats["여기어때"]),
    missingYanolja: Math.max(0, items.length - stats["야놀자"]),
    missingDdnayo: Math.max(0, items.length - stats["떠나요"])
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
      summary: "노출은 확인되지만 상품/채널 구성 공백이 커서 영업 전환 여지가 큽니다."
    };
  }
  if (score >= 62) {
    return {
      label: "선별 공략",
      tone: "watch",
      summary: "상위 업체 중 채널 누락과 상품 공백이 있는 곳부터 선별 접촉이 적합합니다."
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
    summary: "즉시 공략보다는 추가 수집과 플랫폼별 실제 노출 검증이 필요합니다."
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
  const platformGapRatio = items.length ? (platformStats.missingYeogi + platformStats.missingYanolja + platformStats.missingDdnayo) / (items.length * 3) : 0;
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
        <p>${escapeHtml(range)} 입력기간 기준으로 네이버 노출, 객실 판매율, 채널 공백, 상품 구성 약점을 함께 판정했습니다.</p>
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
        <small>채널/상품 약점 감지</small>
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
            <p>판매율, 채널 공백, 상품 구성으로 본 영업 우선순위</p>
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
            <h3>플랫폼 공백</h3>
            <p>검색 노출 대비 OTA/직판 채널 구성</p>
          </div>
        </div>
        <div class="report-channel-grid">
          ${platformStats.names.map((name) => `
            <div>
              <span>${escapeHtml(name)}</span>
              <strong>${fmtNumber(platformStats.counts[name])}</strong>
              <small>${fmtNumber(items.length - platformStats.counts[name])}개 미확인</small>
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
          <li><strong>상위 노출 업체부터 채널 누락 확인</strong><span>여기어때 ${fmtNumber(platformStats.missingYeogi)}개, 야놀자 ${fmtNumber(platformStats.missingYanolja)}개 미확인</span></li>
          <li><strong>객실 판매율 낮은 업체 상품 재구성</strong><span>저판매 후보 ${fmtNumber(lowSalesCount)}개, 가격/패키지/캠프닉 점검</span></li>
          <li><strong>데이유즈/캠프닉 공백 제안</strong><span>${fmtNumber(items.length - dayUseCount)}개 업체는 당일상품 확인 필요</span></li>
        </ol>
      </article>
    </section>

    <section class="report-card report-target-preview">
      <div class="report-card-head">
        <div>
          <h3>우선 컨택 후보</h3>
          <p>노출은 있으나 상품/채널 구성이 약한 업체</p>
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
  const items = targetEntries(15);

  els.targetCount.textContent = `${fmtNumber(items.length)} 후보`;
  if (!items.length) {
    els.targetList.innerHTML = `<div class="empty">현재 기준 영업 후보가 없습니다.</div>`;
    return;
  }

  els.targetList.innerHTML = items.map(({ item, reasons, score, label }, index) => `
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
  `).join("");
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
    admin: "관리"
  };
  els.pageTitle.textContent = titleMap[state.activeTab] || "요약 리포트";
  if (state.activeTab === "dictionary") {
    els.pageSubtitle.textContent = "저장된 지역 카드 · 8대 지수 · 클러스터 판정";
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
    statusText: row.missing ? "미수집" : "마감추정",
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
    return rows.map((row) => ({
      label: row.label,
      sold: row.sold,
      supply: row.total,
      rate: row.rate,
      unit: "회",
      missing: false,
      statusText: "마감추정",
      note: "데이유즈/캠프닉 날짜별 재고"
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
  const stockNote = hidden
    ? `판매열림 ${fmtNumber(openStock)}${row.unit} · 미오픈/차단 ${fmtNumber(hidden)}${row.unit}`
    : `판매열림 ${fmtNumber(openStock)}${row.unit}`;
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

function sheetFlowOverview(item = {}) {
  const flow = salesFlowProfile(item);
  const confidence = inventoryConfidenceInfo(item);
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
          <p>${escapeHtml(analysis.label)} · ${fmtNumber(analysis.score)}점</p>
        </div>
        <span class="confidence-badge ${confidence.tone}">${escapeHtml(confidence.label)}</span>
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
  const confidenceReasons = [...confidence.alerts, ...confidence.reasons].filter(Boolean).slice(0, 4);
  const flow = salesFlowProfile(item);
  const historyWeekday = flow.history?.weekday;
  return `
    ${sheetFlowOverview(item)}
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
      <div class="search-row confidence-row ${confidence.tone}">
        <div>
          <strong>수집 신뢰도 ${escapeHtml(confidence.grade)}</strong>
          <small>${escapeHtml(confidenceReasons.length ? confidenceReasons.join(" · ") : confidence.summary)}</small>
        </div>
        <strong>${escapeHtml(confidence.label)}</strong>
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
  if (status.includes("확인") || status.includes("수동")) return ["warn", status || "확인 필요"];
  return ["good", status || "노출"];
}

function renderSheetPlatform(item) {
  const rows = platformsForItem(item);
  const known = new Set(rows.map((row) => platformShortName(row.platform)));
  const baseRows = [...rows];
  ["네이버", "여기어때", "야놀자", "떠나요"].forEach((name) => {
    if (!known.has(name)) baseRows.push({ platform: name, status: name === "네이버" ? "확인 필요" : "미노출/확인 필요" });
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
      <h3>여기어때 통합</h3>
      <div class="search-row">
        <div>
          <strong>${known.has("여기어때") ? "여기어때 데이터 반영됨" : "여기어때 확인 필요"}</strong>
          <small>관리 탭에서 결과 텍스트를 붙여넣고 통합하면 화면이 자동 갱신됩니다.</small>
        </div>
        <strong>${known.has("여기어때") ? "완료" : "대기"}</strong>
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
  syncDictionaryInputToActiveRun(true);
  if (els.runSelect) els.runSelect.value = runId;
  const run = data.run || {};
  if (els.keywordInput) els.keywordInput.value = run.keyword || (run.label || "").split("·")[0].trim() || els.keywordInput.value;
  if (els.searchModeInput) els.searchModeInput.value = run.searchMode || (run.keywordType === "company" ? "company" : "keyword");
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
  const payload = {
    keyword: els.keywordInput.value.trim(),
    checkIn: els.checkInInput.value,
    checkOut: els.checkOutInput.value,
    searchMode: els.searchModeInput?.value || "keyword",
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
    if (event.target.closest("[data-close-sheet]")) closeSheet();
    if (event.target.closest("[data-close-drawer]")) closeDrawer();
    const drawerTab = event.target.closest("[data-drawer-tab]");
    if (drawerTab) setActiveTab(drawerTab.dataset.drawerTab);
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
