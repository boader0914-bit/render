const state = {
  runs: [],
  data: null,
  activeRunId: null,
  activeRegion: null,
  layer: "core",
  enabledCore: new Set(),
  mapData: null,
  mapBounds: null,
  mapLoadPromise: null,
  loading: false,
  started: false
};

const coreOrder = ["메인 관광지형", "인접 관광 흡수형", "자연 관광자원형", "생활권·도심 수요형", "복합형"];
const coreColors = {
  "메인 관광지형": "#d84b3a",
  "인접 관광 흡수형": "#e18b2d",
  "자연 관광자원형": "#2f8f5b",
  "생활권·도심 수요형": "#2d6cdf",
  "복합형": "#8057c8",
  "확인불가": "#8a8f98"
};
const layerColors = {
  core: coreColors,
  price: {
    저가형: "#4f9d69",
    중가형: "#2f80ed",
    고가형: "#b75ac9",
    프리미엄형: "#c8504a",
    확인불가: "#8a8f98"
  },
  ad: {
    "광고+비광고 동시 노출": "#8057c8",
    "비광고 상위 노출": "#2f8f5b",
    "광고 집행": "#d84b3a",
    확인불가: "#8a8f98"
  },
  type: {
    글램핑: "#2f80ed",
    카라반: "#e18b2d",
    "반려견 동반형": "#8057c8",
    "펜션형 글램핑": "#2f8f5b",
    "키즈/가족형": "#c8504a",
    "풀빌라/리조트형": "#6b4aa8",
    캠핑장: "#6b7a3a",
    확인필요: "#8a8f98",
    확인불가: "#8a8f98"
  }
};

const LOCAL_MAP_URL = "/assets/korea_municipalities.geojson";
const KOREA_FULL_BOUNDS = { minLon: 124.6, maxLon: 131.9, minLat: 33.0, maxLat: 38.75 };
const MAP_DRAW_BOX = { x: 70, y: 42, width: 780, height: 590 };

const labelOffsets = {
  gyeongbuk: {
    김천: { x: -34, y: 30 },
    구미: { x: -38, y: -4 },
    칠곡: { x: 40, y: -2 },
    성주: { x: -40, y: 4 },
    고령: { x: -36, y: 30 },
    경산: { x: 42, y: -18 },
    청도: { x: 34, y: 34 },
    영천: { x: -42, y: -5 },
    경주: { x: 43, y: 22 },
    포항: { x: 45, y: -8 },
    상주: { x: -42, y: -4 },
    문경: { x: -42, y: -10 },
    예천: { x: -42, y: 4 },
    영주: { x: -40, y: -3 },
    봉화: { x: 35, y: -12 },
    안동: { x: 42, y: 28 },
    의성: { x: 38, y: 4 },
    청송: { x: 38, y: -5 },
    영양: { x: 36, y: 2 },
    영덕: { x: 42, y: 12 },
    울진: { x: 38, y: -8 },
    울릉: { x: 0, y: 36 }
  },
  gyeongnam: {
    창원: { x: 38, y: -12 },
    김해: { x: 38, y: 5 },
    양산: { x: 37, y: -8 },
    밀양: { x: 34, y: -12 },
    함안: { x: -36, y: 12 },
    의령: { x: -36, y: -7 },
    창녕: { x: -34, y: -13 },
    진주: { x: -36, y: 12 },
    사천: { x: -38, y: 18 },
    고성: { x: 34, y: 20 },
    통영: { x: 34, y: 28 },
    거제: { x: 38, y: 26 },
    남해: { x: -38, y: 24 },
    하동: { x: -38, y: -4 },
    산청: { x: -38, y: -6 },
    함양: { x: -38, y: -12 },
    거창: { x: -30, y: -22 },
    합천: { x: 34, y: -8 }
  }
};

const els = {
  runSelect: document.getElementById("runSelect"),
  refreshRuns: document.getElementById("refreshRuns"),
  crawlForm: document.getElementById("crawlForm"),
  yeogiCopyLinkButton: document.getElementById("yeogiCopyLinkButton"),
  yeogiOpenButton: document.getElementById("yeogiOpenButton"),
  yeogiScriptButton: document.getElementById("yeogiScriptButton"),
  yeogiToggleScriptButton: document.getElementById("yeogiToggleScriptButton"),
  yeogiClearButton: document.getElementById("yeogiClearButton"),
  yeogiManualBadge: document.getElementById("yeogiManualBadge"),
  yeogiCurrentKeyword: document.getElementById("yeogiCurrentKeyword"),
  yeogiPreviewStatus: document.getElementById("yeogiPreviewStatus"),
  yeogiLinkBox: document.getElementById("yeogiLinkBox"),
  yeogiLinkOutput: document.getElementById("yeogiLinkOutput"),
  yeogiScriptBox: document.getElementById("yeogiScriptBox"),
  yeogiScriptOutput: document.getElementById("yeogiScriptOutput"),
  yeogiImportInput: document.getElementById("yeogiImportInput"),
  yeogiImportButton: document.getElementById("yeogiImportButton"),
  yeogiImportStatus: document.getElementById("yeogiImportStatus"),
  trafficKeyForm: document.getElementById("trafficKeyForm"),
  keywordInput: document.getElementById("keywordInput"),
  checkInInput: document.getElementById("checkInInput"),
  checkOutInput: document.getElementById("checkOutInput"),
  adultsInput: document.getElementById("adultsInput"),
  crawlStatus: document.getElementById("crawlStatus"),
  trafficApiState: document.getElementById("trafficApiState"),
  trafficKeyStatus: document.getElementById("trafficKeyStatus"),
  naverClientIdInput: document.getElementById("naverClientIdInput"),
  naverClientSecretInput: document.getElementById("naverClientSecretInput"),
  searchadApiKeyInput: document.getElementById("searchadApiKeyInput"),
  searchadSecretKeyInput: document.getElementById("searchadSecretKeyInput"),
  searchadCustomerIdInput: document.getElementById("searchadCustomerIdInput"),
  pageTitle: document.getElementById("pageTitle"),
  metaRow: document.getElementById("metaRow"),
  statusPill: document.getElementById("statusPill"),
  feedbackList: document.getElementById("feedbackList"),
  analysisStrip: document.getElementById("analysisStrip"),
  kpiRow: document.getElementById("kpiRow"),
  availabilityPanel: document.getElementById("availabilityPanel"),
  layerButtons: document.getElementById("layerButtons"),
  clusterFilters: document.getElementById("clusterFilters"),
  legend: document.getElementById("legend"),
  map: document.getElementById("clusterMap"),
  mapGrid: document.getElementById("mapGrid"),
  mapLinks: document.getElementById("mapLinks"),
  mapMarkers: document.getElementById("mapMarkers"),
  detailPanel: document.getElementById("detailPanel"),
  coreSummary: document.getElementById("coreSummary"),
  platformList: document.getElementById("platformList"),
  downloadList: document.getElementById("downloadList")
};

function fmtNumber(value) {
  return Number(value || 0).toLocaleString("ko-KR");
}

function fmtPrice(value) {
  if (!value) return "확인불가";
  return `${Number(value).toLocaleString("ko-KR")}원`;
}

function fmtPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "확인불가";
  return `${Number(value).toFixed(2)}%`;
}

function fmtAvailability(place) {
  const available = Number(place.availableRooms);
  const total = Number(place.totalRooms);
  const rate = Number(place.availabilityRate);
  if (Number.isFinite(available) && Number.isFinite(total) && total > 0) {
    const rateText = Number.isFinite(rate) ? ` · ${(rate * 100).toFixed(0)}%` : "";
    return `숙박재고 ${available}/${total}${rateText}`;
  }
  return "확인불가";
}

function fmtDayUseStock(item) {
  const available = Number(item.dayUseAvailableStock);
  const total = Number(item.dayUseTotalStock);
  if (Number.isFinite(available) && Number.isFinite(total) && total > 0) {
    return `데이유즈재고 ${fmtNumber(available)}/${fmtNumber(total)}`;
  }
  return "";
}

function fmtSearchVolume(traffic) {
  if (!traffic?.collectableCount && !traffic?.collectable) return "확인불가";
  return fmtNumber(traffic.totalSearchVolume || 0);
}

function fmtTrafficCtr(traffic) {
  if (!traffic?.collectableCount && !traffic?.collectable) return "확인불가";
  return fmtPercent(traffic.combinedCtr);
}

function nowTime() {
  return new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function addFeedback(message, type = "info") {
  if (!els.feedbackList) return;
  const item = document.createElement("div");
  item.className = `feedback-message ${type}`;
  const time = document.createElement("span");
  const body = document.createElement("strong");
  time.textContent = nowTime();
  body.textContent = message;
  item.append(time, body);
  els.feedbackList.prepend(item);
  while (els.feedbackList.children.length > 8) els.feedbackList.lastElementChild.remove();
}

function status(text) {
  els.statusPill.textContent = text;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "요청 실패");
  return data;
}

function activeKeyword() {
  const labelKeyword = state.data?.run?.label?.split(" · ")[0];
  return (labelKeyword || els.keywordInput.value || "글램핑").trim();
}

function spacedGlampingKeyword(value) {
  const compact = String(value || "").replace(/\s+/g, "").trim();
  if (!compact) return "글램핑";
  if (compact.endsWith("글램핑") && compact.length > 3) return `${compact.slice(0, -3)} 글램핑`;
  return String(value || "").replace(/\s+/g, " ").trim();
}

function yeogiKeyword() {
  return spacedGlampingKeyword(activeKeyword());
}

function yeogiSearchUrl() {
  const url = new URL("https://www.yeogi.com/domestic-accommodations");
  const run = state.data?.run || {};
  const checkIn = run.checkIn || els.checkInInput?.value || "";
  const checkOut = run.checkOut || els.checkOutInput?.value || "";
  const adults = run.adults || els.adultsInput?.value || 2;
  url.searchParams.set("freeForm", "true");
  url.searchParams.set("keyword", yeogiKeyword());
  url.searchParams.set("searchType", "KEYWORD");
  if (checkIn) url.searchParams.set("checkIn", checkIn);
  if (checkOut) url.searchParams.set("checkOut", checkOut);
  url.searchParams.set("personal", String(Math.max(1, Number(adults || 2))));
  return url.toString();
}

function csvExtractScript() {
  return `(() => {
  const priceRe = /(?:\\d{1,3},)*\\d{1,3}\\s*원\\s*~?|(?:\\d{1,3},)+\\d{3}/;
  const topicRe = /글램핑|캠핑|카라반|펜션|풀빌라|리조트|호텔|스테이|빌리지|캠프|camp|glamp/i;
  const badRe = /예약|쿠폰|할인|로그인|회원|검색|필터|지도|정렬|성인|아동|입실|퇴실|후기|리뷰|평점|무료취소|원/;
  const soldOutRe = /예약마감|예약완료|마감|매진|품절|sold\\s*out|unavailable/i;
  const categoryRe = /^(?:풀빌라\\s*펜션|비즈니스\\s*호텔|레지던스\\s*호텔|관광\\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)\\s*/i;
  const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const nameKey = (value) => clean(value).replace(/\\s+/g, "").toLowerCase();
  const escapeCsv = (value) => {
    const text = String(value || "");
    return /[",\\r\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  const pickName = (lines, priceIndex) => {
    const before = lines.slice(Math.max(0, priceIndex - 8), priceIndex).reverse();
    const around = lines.slice(Math.max(0, priceIndex - 8), Math.min(lines.length, priceIndex + 4));
    const found = [...before, ...around].find((line) => topicRe.test(line) && !badRe.test(line) && !priceRe.test(line)) || "";
    return clean(found.replace(categoryRe, ""));
  };
  const lowestPrice = (text) => {
    const prices = String(text || "").match(priceRe) || [];
    const values = prices
      .map((item) => Number(String(item).replace(/[^\\d]/g, "")))
      .filter((value) => Number.isFinite(value) && value >= 10000);
    const min = values.length ? Math.min(...values) : 0;
    return min ? min.toLocaleString("ko-KR") + "원" : clean(prices[0] || "");
  };
  const rows = [];
  const seen = new Set();
  const cardsFromLinks = [...document.querySelectorAll("a[href*='/domestic-accommodations/']")].map((link) => {
    let node = link;
    for (let i = 0; i < 4 && node?.parentElement; i += 1) {
      const text = String(node.innerText || "");
      if (priceRe.test(text) && topicRe.test(text) && text.length < 2600) return node;
      node = node.parentElement;
    }
    return link;
  });
  const candidates = [...cardsFromLinks, ...document.querySelectorAll("a[href], article, li, [role='listitem'], [data-testid], [class*='card'], [class*='item']")];
  for (const el of candidates) {
    const rawText = String(el.innerText || "");
    if (rawText.length > 2200) continue;
    if (!priceRe.test(rawText) || !topicRe.test(rawText)) continue;
    const lines = rawText.split(/\\n+/).map(clean).filter(Boolean);
    if (lines.length > 36) continue;
    const price = lowestPrice(rawText);
    const priceIndex = Math.max(0, lines.findIndex((line) => priceRe.test(line)));
    const name = pickName(lines, priceIndex);
    if (!name || !price) continue;
    const key = nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const link = el.closest("a") || el.querySelector("a");
    const adFlag = lines.some((line) => /^광고$|^AD$/i.test(line)) ? "Y" : "확인불가";
    const soldOut = lines.some((line) => soldOutRe.test(line));
    rows.push({
      rank: rows.length + 1,
      name,
      price,
      url: link?.href || "",
      section: adFlag === "Y" ? "광고" : "수동수집",
      ad_flag: adFlag,
      reservation_available: soldOut ? "N" : "Y",
      availability_status: soldOut ? "예약마감/매진 문구 감지" : "가격 노출",
      raw: lines.slice(0, 12).join(" / ")
    });
    if (rows.length >= 80) break;
  }
  if (!rows.length) {
    const lines = String(document.body?.innerText || "")
      .replace(/(원|개|확인|마감|매진)(풀빌라\\s*펜션|비즈니스\\s*호텔|레지던스\\s*호텔|관광\\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)(?=[가-힣A-Za-z0-9★])/g, "$1\\n$2")
      .split(/\\n+/).map(clean).filter(Boolean);
    lines.forEach((line, index) => {
      if (!priceRe.test(line)) return;
      const windowLines = lines.slice(Math.max(0, index - 8), Math.min(lines.length, index + 4));
      const name = pickName(lines, index);
      const price = lowestPrice(line);
      const key = nameKey(name);
      if (!name || !price || seen.has(key)) return;
      seen.add(key);
      const adFlag = windowLines.some((item) => /^광고$|^AD$/i.test(item)) ? "Y" : "확인불가";
      const soldOut = windowLines.some((item) => soldOutRe.test(item));
      rows.push({
        rank: rows.length + 1,
        name,
        price,
        url: location.href,
        section: adFlag === "Y" ? "광고" : "수동수집",
        ad_flag: adFlag,
        reservation_available: soldOut ? "N" : "Y",
        availability_status: soldOut ? "예약마감/매진 문구 감지" : "가격 노출",
        raw: windowLines.join(" / ")
      });
    });
  }
  const headers = ["rank", "name", "price", "url", "section", "ad_flag", "reservation_available", "availability_status", "raw"];
  const csv = [headers.join(","), ...rows.map((row) => headers.map((key) => escapeCsv(row[key])).join(","))].join("\\n");
  try {
    if (typeof copy === "function") copy(csv);
    else navigator.clipboard?.writeText(csv);
  } catch (error) {}
  console.log(csv);
  return csv;
})();`;
}

function looksLikeYeogiExtractScript(value) {
  const text = String(value || "");
  return /\(\(\)\s*=>\s*\{/.test(text) &&
    /const\s+priceRe/.test(text) &&
    /navigator\.clipboard|console\.log\(csv\)|headers\s*=/.test(text);
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

function showYeogiScriptFallback(script) {
  if (!els.yeogiScriptBox || !els.yeogiScriptOutput) return;
  els.yeogiScriptOutput.value = script;
  els.yeogiScriptBox.hidden = false;
  if (els.yeogiToggleScriptButton) els.yeogiToggleScriptButton.textContent = "코드 닫기";
  els.yeogiScriptOutput.focus();
  els.yeogiScriptOutput.select();
}

function setYeogiManualBadge(text, tone = "idle") {
  if (!els.yeogiManualBadge) return;
  els.yeogiManualBadge.textContent = text;
  els.yeogiManualBadge.className = `manual-badge ${tone}`;
}

function setYeogiImportStatus(text, tone = "idle") {
  if (!els.yeogiImportStatus) return;
  els.yeogiImportStatus.textContent = text;
  els.yeogiImportStatus.className = `manual-status ${tone}`;
}

function updateYeogiKeywordLabel() {
  if (!els.yeogiCurrentKeyword) return;
  els.yeogiCurrentKeyword.textContent = `${yeogiKeyword()} 검색 기준`;
  if (els.yeogiLinkOutput) els.yeogiLinkOutput.value = yeogiSearchUrl();
}

function showYeogiLinkFallback(url) {
  if (!els.yeogiLinkBox || !els.yeogiLinkOutput) return;
  els.yeogiLinkOutput.value = url;
  els.yeogiLinkBox.hidden = false;
  els.yeogiLinkOutput.focus();
  els.yeogiLinkOutput.select();
}

function previewYeogiImport(value) {
  const text = String(value || "").trim();
  if (!text) return { ready: false, tone: "idle", badge: "대기", message: "붙여넣기 대기" };
  if (looksLikeYeogiExtractScript(text)) {
    return { ready: false, tone: "warning", badge: "코드", message: "추출 코드가 붙어 있습니다" };
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  const csvLike = looksLikeYeogiCsvHeader(firstLine);
  if (csvLike) {
    const count = Math.max(0, lines.length - 1);
    return count
      ? { ready: true, tone: "ready", badge: `${fmtNumber(count)}건`, message: `CSV ${fmtNumber(count)}건 후보` }
      : { ready: false, tone: "warning", badge: "확인", message: "CSV 헤더만 감지됨" };
  }

  const priceRe = /(?:\d{1,3},)*\d{1,3}\s*원|(?:\d{1,3},)+\d{3}/;
  const topicRe = /글램핑|캠핑|카라반|펜션|리조트|스테이|빌리지|glamp|camp/i;
  const categoryStartRe = /(?:^|\n)(풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)(?=[가-힣A-Za-z0-9★\[])/g;
  const categoryBoundaryRe = /(원|개|확인|마감|매진)(풀빌라\s*펜션|비즈니스\s*호텔|레지던스\s*호텔|관광\s*호텔|모텔|호텔|펜션|캠핑|리조트|게스트하우스|한옥|카라반)(?=[가-힣A-Za-z0-9★\[])/g;
  const priceCount = lines.filter((line) => priceRe.test(line)).length;
  const nameCount = new Set(lines.filter((line) => topicRe.test(line) && line.length <= 80)).size;
  const compactCount = (text.match(categoryStartRe) || []).length + (text.match(categoryBoundaryRe) || []).length;
  const count = Math.max(priceCount, compactCount, Math.min(nameCount, 80));
  if (count) return { ready: true, tone: "ready", badge: `${fmtNumber(count)}건`, message: `텍스트 ${fmtNumber(count)}건 후보` };
  if (text.length > 300) return { ready: true, tone: "check", badge: "검토", message: "긴 텍스트 감지, 병합 전 검토" };
  return { ready: false, tone: "warning", badge: "부족", message: "숙소/가격 후보가 부족합니다" };
}

function syncYeogiManualInterface() {
  updateYeogiKeywordLabel();
  const preview = previewYeogiImport(els.yeogiImportInput?.value || "");
  if (els.yeogiPreviewStatus) {
    els.yeogiPreviewStatus.textContent = preview.message;
    els.yeogiPreviewStatus.className = `manual-preview ${preview.tone}`;
  }
  setYeogiManualBadge(preview.badge, preview.tone);
  if (els.yeogiImportButton) {
    els.yeogiImportButton.disabled = !preview.ready || !state.activeRunId;
  }
}

function toggleYeogiScriptBox() {
  if (!els.yeogiScriptBox || !els.yeogiScriptOutput) return;
  const willShow = els.yeogiScriptBox.hidden;
  if (willShow && !els.yeogiScriptOutput.value) els.yeogiScriptOutput.value = csvExtractScript();
  els.yeogiScriptBox.hidden = !willShow;
  if (els.yeogiToggleScriptButton) els.yeogiToggleScriptButton.textContent = willShow ? "코드 닫기" : "코드 보기";
}

function clearYeogiImport() {
  if (els.yeogiImportInput) els.yeogiImportInput.value = "";
  setYeogiImportStatus("입력칸을 비웠습니다. 여기어때 결과를 붙여넣으세요.", "check");
  syncYeogiManualInterface();
}

function formatDateInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function initializeDateInputs() {
  if (!els.checkInInput || !els.checkOutInput) return;
  const today = formatDateInput(new Date());
  const tomorrow = formatDateInput(addDays(new Date(), 1));
  const dayAfterTomorrow = formatDateInput(addDays(new Date(), 2));

  els.checkInInput.min = today;
  els.checkOutInput.min = tomorrow;
  if (!els.checkInInput.value || els.checkInInput.value < today) {
    els.checkInInput.value = tomorrow;
  }
  if (!els.checkOutInput.value || els.checkOutInput.value <= els.checkInInput.value) {
    els.checkOutInput.value = dayAfterTomorrow;
  }
}

function normalize(value) {
  return value || "확인불가";
}

function colorFor(item) {
  const palette = layerColors[state.layer] || coreColors;
  return palette[categoryFor(item)] || "#8a8f98";
}

function categoryFor(item) {
  if (state.layer === "core") return normalize(item.primary);
  if (state.layer === "type") return normalize(item.dominantType);
  if (state.layer === "price") return normalize(item.dominantPrice);
  if (state.layer === "ad") return normalize(item.dominantAd);
  return "확인불가";
}

function makeSvg(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  return el;
}

async function loadLocalMap() {
  if (state.mapData) return state.mapData;
  if (!state.mapLoadPromise) {
    state.mapLoadPromise = fetchJson(LOCAL_MAP_URL)
      .then((data) => {
        state.mapData = data;
        addFeedback("로컬 행정구역 지도를 불러왔습니다.", "success");
        return data;
      })
      .catch((error) => {
        addFeedback(`로컬 지도 로딩 실패: ${error.message}`, "error");
        throw error;
      });
  }
  return state.mapLoadPromise;
}

function clampBounds(bounds) {
  const full = KOREA_FULL_BOUNDS;
  const lonSpan = Math.min(bounds.maxLon - bounds.minLon, full.maxLon - full.minLon);
  const latSpan = Math.min(bounds.maxLat - bounds.minLat, full.maxLat - full.minLat);
  let centerLon = (bounds.minLon + bounds.maxLon) / 2;
  let centerLat = (bounds.minLat + bounds.maxLat) / 2;
  centerLon = Math.max(full.minLon + lonSpan / 2, Math.min(full.maxLon - lonSpan / 2, centerLon));
  centerLat = Math.max(full.minLat + latSpan / 2, Math.min(full.maxLat - latSpan / 2, centerLat));
  return {
    minLon: centerLon - lonSpan / 2,
    maxLon: centerLon + lonSpan / 2,
    minLat: centerLat - latSpan / 2,
    maxLat: centerLat + latSpan / 2
  };
}

function fitBoundsToAspect(bounds) {
  const targetAspect = MAP_DRAW_BOX.width / MAP_DRAW_BOX.height;
  const centerLon = (bounds.minLon + bounds.maxLon) / 2;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  let lonSpan = bounds.maxLon - bounds.minLon;
  let latSpan = bounds.maxLat - bounds.minLat;

  if (lonSpan / latSpan < targetAspect) lonSpan = latSpan * targetAspect;
  else latSpan = lonSpan / targetAspect;

  return clampBounds({
    minLon: centerLon - lonSpan / 2,
    maxLon: centerLon + lonSpan / 2,
    minLat: centerLat - latSpan / 2,
    maxLat: centerLat + latSpan / 2
  });
}

function computeMapBounds(regions = []) {
  const points = regions
    .map((region) => ({ lon: Number(region.lon), lat: Number(region.lat) }))
    .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat));
  if (!points.length) return KOREA_FULL_BOUNDS;

  let minLon = Math.min(...points.map((point) => point.lon));
  let maxLon = Math.max(...points.map((point) => point.lon));
  let minLat = Math.min(...points.map((point) => point.lat));
  let maxLat = Math.max(...points.map((point) => point.lat));
  const single = points.length === 1;
  const lonSpan = Math.max(maxLon - minLon, single ? 1.35 : 0.85);
  const latSpan = Math.max(maxLat - minLat, single ? 1.0 : 0.7);
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const pad = single ? 0 : 0.24;

  return fitBoundsToAspect({
    minLon: centerLon - lonSpan * (0.5 + pad),
    maxLon: centerLon + lonSpan * (0.5 + pad),
    minLat: centerLat - latSpan * (0.5 + pad),
    maxLat: centerLat + latSpan * (0.5 + pad)
  });
}

function projectGeo(lon, lat) {
  const bounds = state.mapBounds || KOREA_FULL_BOUNDS;
  const x = MAP_DRAW_BOX.x + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * MAP_DRAW_BOX.width;
  const y = MAP_DRAW_BOX.y + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * MAP_DRAW_BOX.height;
  return { x, y };
}

function project(item) {
  return projectGeo(Number(item.lon || 127.7), Number(item.lat || 36.1));
}

function geometryRingPath(ring) {
  return ring.map(([lon, lat], index) => {
    const point = projectGeo(lon, lat);
    return `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(" ");
}

function geometryToPath(geometry) {
  if (!geometry) return "";
  if (geometry.type === "Polygon") {
    return geometry.coordinates.map((ring) => `${geometryRingPath(ring)} Z`).join(" ");
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates
      .flatMap((polygon) => polygon.map((ring) => `${geometryRingPath(ring)} Z`))
      .join(" ");
  }
  return "";
}

function normalizePlaceName(value) {
  return String(value || "").replace(/\s+/g, "").replace(/특별자치도|특별자치시|특별시|광역시|자치시|시|군|구/g, "");
}

function matchedRegionForFeature(feature) {
  const featureName = String(feature?.properties?.name || "").replace(/\s+/g, "");
  const featureKey = normalizePlaceName(featureName);
  return state.data?.regions.find((region) => {
    const regionName = String(region.region || "").replace(/\s+/g, "");
    const regionKey = normalizePlaceName(regionName);
    return featureName.includes(regionName) || featureKey.includes(regionKey) || regionKey.includes(featureKey);
  }) || null;
}

function pointInCurrentBounds(lon, lat) {
  const bounds = state.mapBounds || KOREA_FULL_BOUNDS;
  return lon >= bounds.minLon && lon <= bounds.maxLon && lat >= bounds.minLat && lat <= bounds.maxLat;
}

function renderRuns() {
  els.runSelect.innerHTML = "";
  if (!state.runs.length) {
    const option = document.createElement("option");
    option.textContent = "실행 결과 없음";
    option.value = "";
    els.runSelect.append(option);
    return;
  }

  for (const run of state.runs) {
    const option = document.createElement("option");
    option.value = run.id;
    option.textContent = run.label;
    if (run.id === state.activeRunId) option.selected = true;
    els.runSelect.append(option);
  }
}

async function loadRuns(selectLatest = false) {
  status("결과 불러오는 중");
  addFeedback("실행 결과를 불러오는 중입니다.", "info");
  const data = await fetchJson("/api/runs");
  state.runs = data.runs;
  if (!state.activeRunId || selectLatest) state.activeRunId = state.runs[0]?.id || null;
  renderRuns();
  if (state.activeRunId) await loadRun(state.activeRunId);
  else {
    renderEmpty();
    syncYeogiManualInterface();
  }
}

async function loadTrafficKeyStatus() {
  const data = await fetchJson("/api/settings/traffic-keys");
  renderTrafficKeyStatus(data);
}

function renderTrafficKeyStatus(data) {
  const datalab = data.datalabConfigured;
  const searchad = data.searchadConfigured;
  const label = datalab && searchad ? "연동 준비" : datalab ? "데이터랩 준비" : searchad ? "검색광고 준비" : "미설정";
  els.trafficApiState.textContent = label;
  els.trafficApiState.classList.toggle("ready", datalab || searchad);

  const fieldText = [
    `데이터랩: ${datalab ? "저장됨" : "미설정"}`,
    `검색광고: ${searchad ? "저장됨" : "미설정"}`
  ].join(" · ");
  els.trafficKeyStatus.textContent = fieldText;
}

async function loadRun(runId) {
  if (!runId) return;
  status("데이터 로딩");
  addFeedback("선택한 결과를 지도와 지표로 정리하고 있습니다.", "info");
  await loadLocalMap();
  const data = await fetchJson(`/api/runs/${encodeURIComponent(runId)}`);
  state.data = data;
  state.activeRunId = runId;
  state.activeRegion = data.regions[0]?.region || null;
  state.enabledCore = new Set(coreOrder);
  state.mapBounds = computeMapBounds(data.regions);
  renderAll();
  syncYeogiManualInterface();
  status("준비");
  addFeedback(`${data.run.label} 분석 결과를 표시했습니다.`, "success");
}

function renderEmpty() {
  els.pageTitle.textContent = "글램핑 수요 클러스터 지도";
  els.metaRow.innerHTML = "";
  if (els.analysisStrip) els.analysisStrip.innerHTML = "";
  els.kpiRow.innerHTML = "";
  if (els.availabilityPanel) els.availabilityPanel.innerHTML = "";
  els.mapMarkers.innerHTML = "";
  els.detailPanel.innerHTML = `<div class="empty">수집 결과가 없습니다.</div>`;
  els.downloadList.innerHTML = `<div class="empty">다운로드할 파일이 없습니다.</div>`;
  status("결과 없음");
}

function renderAll() {
  renderHeader();
  renderAnalysisStrip();
  renderKpis();
  renderAvailability();
  renderLayerControls();
  renderMap();
  renderDetail();
  renderCoreSummary();
  renderPlatforms();
  renderDownloads();
}

function renderHeader() {
  const { run, stats } = state.data;
  const trafficText = stats.traffic?.collectableCount
    ? `월검색 ${fmtNumber(stats.traffic.totalSearchVolume)}건`
    : "검색광고 지표 확인필요";
  els.pageTitle.textContent = `${run.label} 수요 클러스터`;
  els.metaRow.innerHTML = [
    `${run.provinceLabel} 지도`,
    `지역별 상위 노출 ${fmtNumber(stats.totalRegionalRows)}건`,
    `${fmtNumber(state.data.regions.length)}개 시군`,
    trafficText,
    "핵심채널 네이버·NOL·ONDA·떠나요",
    "본질 클러스터 기본",
    "유형·가격·광고 옵션"
  ].map((text) => `<span>${text}</span>`).join("");
}

function platformRole(platformName) {
  const name = String(platformName || "");
  if (/네이버|야놀자|NOL|ONDA|떠나요/i.test(name)) return "core";
  if (/여기어때/i.test(name)) return "manual";
  return "optional";
}

function platformRoleLabel(platformName) {
  const role = platformRole(platformName);
  if (role === "core") return "핵심";
  if (role === "manual") return "수동 보완";
  return "보조";
}

function renderAnalysisStrip() {
  if (!els.analysisStrip) return;
  const { stats } = state.data;
  const platforms = state.data?.platform || [];
  const availabilityStats = state.data?.availability?.stats || {};
  const coreCount = platforms
    .filter((platform) => platformRole(platform.platform) === "core")
    .reduce((sum, platform) => sum + Number(platform.count || 0), 0);
  const manualPlatform = platforms.find((platform) => platformRole(platform.platform) === "manual");
  const checkedPlaces = Number(availabilityStats.checkedPlaces || 0);
  const traffic = stats.traffic || {};
  const cards = [
    {
      kicker: "핵심 채널",
      value: "네이버 · 야놀자/NOL · ONDA · 떠나요",
      note: `${fmtNumber(coreCount)}건 수집`
    },
    {
      kicker: "예약가능률",
      value: checkedPlaces ? fmtAvailabilityRate(availabilityStats.weightedRate) : "확인필요",
      note: `네이버 숙박재고 ${fmtNumber(checkedPlaces)}곳`
    },
    {
      kicker: "재고 해석",
      value: "전체객실 · 채널수 분리",
      note: "네이버 분리 여부 별도 표시"
    },
    {
      kicker: "검색 지표",
      value: fmtSearchVolume(traffic),
      note: `CTR ${fmtTrafficCtr(traffic)}`
    },
    {
      kicker: "보조 채널",
      value: manualPlatform ? "여기어때 보유" : "여기어때 대기",
      note: manualPlatform ? `${fmtNumber(manualPlatform.count)}건 수동 보완` : "CSV/HTML 가져오기"
    }
  ];
  els.analysisStrip.innerHTML = cards.map((card, index) => `
    <div class="analysis-item tone-${index + 1}">
      <span class="analysis-kicker">${card.kicker}</span>
      <strong>${card.value}</strong>
      <span class="analysis-note">${card.note}</span>
    </div>
  `).join("");
}

function renderKpis() {
  const { run, stats } = state.data;
  const traffic = stats.traffic || {};
  const cards = [
    { value: fmtNumber(run.counts.naverOverall || 0), label: "네이버 전체순위", note: "광역 키워드 기준", tone: "blue" },
    { value: fmtNumber(run.counts.naverAds || 0), label: "광고집행 노출", note: "광고 분리", tone: "purple" },
    { value: fmtNumber(stats.totalRegionalRows), label: "지역별 상위 노출", note: "지역 키워드 Top 10", tone: "green" },
    { value: fmtSearchVolume(traffic), label: "월검색량", note: "PC+모바일", tone: "orange" },
    { value: fmtTrafficCtr(traffic), label: "종합 클릭률", note: "검색광고 API 기준", tone: "blue" },
    { value: fmtPrice(stats.avgPrice), label: "평균 최저가", note: "플랫폼 최저가 평균", tone: "green" }
  ];
  els.kpiRow.innerHTML = cards.map((card) => `
    <div class="kpi-card ${card.tone}">
      <span class="kpi-label">${card.label}</span>
      <strong>${card.value}</strong>
      <em>${card.note}</em>
    </div>
  `).join("");
}

function availabilityLevel(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return "unknown";
  if (n < 0.7) return "low";
  if (n < 0.9) return "mid";
  return "high";
}

function fmtAvailabilityRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "확인불가";
  return `${Math.round(n * 100)}%`;
}

function renderAvailability() {
  if (!els.availabilityPanel) return;
  const availability = state.data?.availability;
  const items = availability?.items || [];
  if (!items.length) {
    els.availabilityPanel.innerHTML = `
      <div class="section-head">
        <h2>네이버 상위 업체 예약가능률</h2>
      </div>
      <div class="empty">네이버예약 재고 확인 데이터가 없습니다.</div>
    `;
    return;
  }

  const stats = availability.stats || {};
  els.availabilityPanel.innerHTML = `
    <div class="section-head availability-head">
      <div>
        <h2>네이버 상위 업체 예약가능률</h2>
        <p>네이버예약 채널의 날짜별 숙박재고 기준 · 실제 전체 객실수와 다를 수 있음 · 데이유즈는 별도 표시</p>
      </div>
      <div class="availability-summary">
        <span><strong>${fmtAvailabilityRate(stats.weightedRate)}</strong>전체</span>
        <span><strong>${fmtNumber(stats.checkedPlaces || 0)}</strong>업체</span>
        <span><strong>${fmtNumber(stats.totalAvailableRooms || 0)}/${fmtNumber(stats.totalRooms || 0)}</strong>숙박재고</span>
      </div>
    </div>
    <div class="availability-list">
      ${items.slice(0, 12).map((item) => {
        const rate = Number(item.rate);
        const width = Number.isFinite(rate) ? Math.max(3, Math.min(100, rate * 100)) : 0;
        return `
          <a class="availability-card ${availabilityLevel(item.rate)}" href="${item.url || "#"}" target="${item.url ? "_blank" : "_self"}" rel="noreferrer" title="${item.basis || ""}">
            <div class="availability-card-top">
              <span class="availability-rank">${item.rank || "-"}</span>
              <strong>${item.name}</strong>
              <b>${fmtAvailabilityRate(item.rate)}</b>
            </div>
            <div class="availability-meter"><span style="width:${width}%"></span></div>
            <div class="availability-meta">
              <span>숙박재고 ${fmtNumber(item.availableRooms)}/${fmtNumber(item.totalRooms)}</span>
              ${fmtDayUseStock(item) ? `<span>${fmtDayUseStock(item)}</span>` : ""}
              <span>${item.productTypeSummary || `숙박 ${fmtNumber(item.nightItemCount || 0)} · 데이유즈 ${fmtNumber(item.dayUseItemCount || 0)}`}</span>
              <span>${item.region || "지역 확인"}</span>
              <span>${item.price || item.listType || "가격 확인"}</span>
              ${item.inventoryMemo ? `<span>${item.inventoryMemo}</span>` : ""}
            </div>
          </a>
        `;
      }).join("")}
    </div>
  `;
}

function renderLayerControls() {
  els.layerButtons.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.layer === state.layer);
  });

  els.clusterFilters.innerHTML = coreOrder.map((cluster) => {
    const active = state.enabledCore.has(cluster);
    return `<button class="cluster-filter ${active ? "active" : ""}" type="button" data-core="${cluster}">
      <span class="dot" style="background:${coreColors[cluster]}"></span>${cluster}
    </button>`;
  }).join("");

  els.clusterFilters.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const cluster = button.dataset.core;
      if (state.enabledCore.has(cluster) && state.enabledCore.size > 1) state.enabledCore.delete(cluster);
      else state.enabledCore.add(cluster);
      renderLayerControls();
      renderMap();
    });
  });

  const palette = layerColors[state.layer] || coreColors;
  els.legend.innerHTML = Object.entries(palette).map(([name, color]) => `
    <span><span class="dot" style="background:${color}"></span>${name}</span>
  `).join("");
}

function renderGrid() {
  els.mapGrid.innerHTML = "";
  const features = state.mapData?.features || [];
  if (!features.length) {
    const label = makeSvg("text", { x: 460, y: 330, class: "map-country-label", "text-anchor": "middle" });
    label.textContent = "로컬 지도 로딩 중";
    els.mapGrid.append(label);
    return;
  }

  for (const feature of features) {
    const matched = matchedRegionForFeature(feature);
    const className = [
      "geo-region",
      matched ? "available" : "",
      matched?.region === state.activeRegion ? "active" : ""
    ].filter(Boolean).join(" ");
    const path = makeSvg("path", {
      d: geometryToPath(feature.geometry),
      class: className,
      "data-name": feature.properties?.name || ""
    });
    const title = makeSvg("title");
    title.textContent = matched
      ? `${feature.properties?.name || matched.region} · ${matched.primary}`
      : feature.properties?.name || "행정구역";
    path.append(title);
    if (matched) {
      path.addEventListener("click", () => {
        state.activeRegion = matched.region;
        renderMap();
        renderDetail();
      });
    }
    els.mapGrid.append(path);
  }
}

function renderLinks() {
  els.mapLinks.innerHTML = "";
  const active = state.data.regions.find((region) => region.region === state.activeRegion);
  if (!active || !active.target) return;

  const start = project(active);
  const targetNames = active.target.split(/[·,/]/).map((name) => name.trim()).filter(Boolean);
  for (const targetName of targetNames) {
    const target = state.data.regions.find((region) => region.region === targetName);
    if (!target) continue;
    const end = project(target);
    els.mapLinks.append(makeSvg("line", {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      class: "map-link"
    }));
  }
}

function renderMap() {
  if (!state.data) return;
  renderGrid();
  renderLinks();
  els.mapMarkers.innerHTML = "";

  const province = state.data.run.province;
  for (const item of state.data.regions) {
    const point = project(item);
    const offset = labelOffsets[province]?.[item.region] || { x: 0, y: 34 };
    const radius = Math.min(26, 8 + Math.sqrt(item.count) * 4.2);
    const visible = state.enabledCore.has(item.primary);
    const group = makeSvg("g", {
      class: `map-marker ${item.region === state.activeRegion ? "active" : ""} ${visible ? "" : "dim"}`,
      tabindex: "0",
      role: "button",
      "aria-label": `${item.region} ${item.primary} 월검색 ${fmtSearchVolume(item.traffic)} CTR ${fmtTrafficCtr(item.traffic)}`,
      "data-region": item.region
    });
    const title = makeSvg("title");
    title.textContent = `${item.region} · ${item.primary} · 월검색 ${fmtSearchVolume(item.traffic)} · CTR ${fmtTrafficCtr(item.traffic)}`;
    group.append(title);

    if (Math.abs(offset.x) + Math.abs(offset.y) > 34) {
      group.append(makeSvg("line", {
        x1: point.x,
        y1: point.y,
        x2: point.x + offset.x * 0.75,
        y2: point.y + offset.y * 0.75,
        class: "label-line"
      }));
    }

    group.append(makeSvg("circle", {
      cx: point.x,
      cy: point.y,
      r: radius,
      fill: colorFor(item),
      "fill-opacity": ".9"
    }));

    const count = makeSvg("text", {
      x: point.x,
      y: point.y + 4,
      "text-anchor": "middle",
      class: "marker-count"
    });
    count.textContent = item.count;
    group.append(count);

    const label = makeSvg("text", {
      x: point.x + offset.x,
      y: point.y + offset.y,
      "text-anchor": offset.x > 8 ? "start" : offset.x < -8 ? "end" : "middle",
      class: "marker-label"
    });
    label.textContent = item.region;
    group.append(label);

    group.addEventListener("click", () => {
      state.activeRegion = item.region;
      renderMap();
      renderDetail();
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        state.activeRegion = item.region;
        renderMap();
        renderDetail();
      }
    });

    els.mapMarkers.append(group);
  }
}

function renderDetail() {
  const item = state.data?.regions.find((region) => region.region === state.activeRegion) || state.data?.regions[0];
  if (!item) {
    els.detailPanel.innerHTML = `<div class="empty">선택할 지역이 없습니다.</div>`;
    return;
  }

  const coreColor = coreColors[item.primary] || coreColors["확인불가"];
  const traffic = item.traffic || {};
  const trafficAvailable = Boolean(traffic.collectable);
  const trafficReason = trafficAvailable
    ? `${traffic.relKeyword || item.trafficKeyword} · 경쟁도 ${traffic.competition || "확인불가"}`
    : traffic.reason || "검색광고 API 지표를 확인할 수 없습니다.";
  els.detailPanel.innerHTML = `
    <div class="region-head">
      <div>
        <h2>${item.region}</h2>
        <span class="subtle">${item.trafficKeyword || item.region} 기준</span>
      </div>
      <div class="cluster-badge" style="background:${coreColor}">${item.primary}</div>
    </div>

    <div class="detail-kpis">
      <div class="detail-kpi"><strong>${fmtNumber(item.count)}</strong><span>지역별 상위 노출</span></div>
      <div class="detail-kpi"><strong>${fmtSearchVolume(traffic)}</strong><span>월검색량(PC+모바일)</span></div>
      <div class="detail-kpi"><strong>${fmtTrafficCtr(traffic)}</strong><span>종합 클릭률</span></div>
      <div class="detail-kpi"><strong>${fmtPrice(item.avgPrice)}</strong><span>평균 최저가</span></div>
      <div class="detail-kpi"><strong>${fmtNumber(item.dualCount)}</strong><span>광고+비광고 동시</span></div>
      <div class="detail-kpi"><strong>${item.dominantType}</strong><span>대표 유형</span></div>
    </div>

    <div class="info-list">
      <div class="info-item"><span>검색광고 지표</span><strong>${trafficReason}</strong></div>
      <div class="info-item"><span>PC/모바일 검색량</span><strong>PC ${trafficAvailable ? fmtNumber(traffic.monthlyPc) : "확인불가"} · 모바일 ${trafficAvailable ? fmtNumber(traffic.monthlyMobile) : "확인불가"}</strong></div>
      <div class="info-item"><span>PC/모바일 클릭률</span><strong>PC ${trafficAvailable ? fmtPercent(traffic.pcCtr) : "확인불가"} · 모바일 ${trafficAvailable ? fmtPercent(traffic.mobileCtr) : "확인불가"}</strong></div>
      <div class="info-item"><span>보조 클러스터</span><strong>${item.secondary}</strong></div>
      <div class="info-item"><span>관광자원 태그</span><strong>${item.resources.join(", ")}</strong></div>
      <div class="info-item"><span>트래픽 흡수 대상</span><strong>${item.target}</strong></div>
      <div class="info-item"><span>판단 메모</span><strong>${item.note}</strong></div>
    </div>

    <table class="place-table">
      <thead>
        <tr>
          <th>순위</th>
          <th>업체명</th>
          <th>유형</th>
          <th>네이버 숙박재고</th>
          <th>가격</th>
        </tr>
      </thead>
      <tbody>
        ${item.places.map((place) => `
          <tr>
            <td>${place.rank}</td>
            <td>${place.url ? `<a href="${place.url}" target="_blank" rel="noreferrer">${place.name}</a>` : place.name}</td>
            <td>${place.type}</td>
            <td title="${place.availabilityBasis || ""}">${fmtAvailability(place)}</td>
            <td>${place.price || "확인불가"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderCoreSummary() {
  const stats = state.data?.stats?.byCore || {};
  const trafficStats = state.data?.stats?.byCoreTraffic || {};
  els.coreSummary.innerHTML = coreOrder.map((cluster) => `
    <div class="cluster-tile" style="border-left-color:${coreColors[cluster]}">
      <strong>${fmtNumber(stats[cluster] || 0)}</strong>
      <span>${cluster}</span>
      <small>월검색 ${fmtSearchVolume(trafficStats[cluster])}</small>
      <small>CTR ${fmtTrafficCtr(trafficStats[cluster])}</small>
    </div>
  `).join("");
}

function renderPlatformSamples(samples = []) {
  if (!samples.length) return `<div class="platform-empty">해당 상태 데이터 없음</div>`;
  return samples.map((sample) => {
    const primaryMeta = [
      sample.coreRole,
      sample.status || "상태 확인",
      sample.price
    ].filter(Boolean);
    const inventoryMeta = [
      sample.roomCountStatus ? `객실 ${sample.roomCountStatus}` : "",
      sample.channelCountStatus ? `채널 ${sample.channelCountStatus}` : "",
      sample.naverSplitStatus,
      sample.inventoryNote,
      sample.reason,
      sample.direction
    ].filter(Boolean);
    return `
      <a class="platform-sample" href="${sample.url || "#"}" target="${sample.url ? "_blank" : "_self"}" rel="noreferrer">
        <span class="platform-rank">${sample.rank || "-"}</span>
        <span>
          <strong>${sample.name || sample.reason || "확인불가"}</strong>
          <small>${primaryMeta.join(" · ")}</small>
          ${inventoryMeta.length ? `<small class="platform-note">${inventoryMeta.join(" · ")}</small>` : ""}
        </span>
      </a>
    `;
  }).join("");
}

function renderPlatforms() {
  const platforms = state.data?.platform || [];
  if (!platforms.length) {
    els.platformList.innerHTML = `<div class="empty">플랫폼 수집 데이터가 없습니다.</div>`;
    return;
  }
  const statusOrder = ["광고", "비광고", "실패", "기타"];
  els.platformList.innerHTML = platforms.map((platform, index) => `
    <details class="platform-item ${platformRole(platform.platform)}" ${index === 0 ? "open" : ""}>
      <summary>
        <span>
          <strong>${platform.platform}</strong>
          <small>${fmtNumber(platform.count)}건 · 광고 ${fmtNumber(platform.ads)}건 · 비광고 ${fmtNumber(platform.organic)}건 · 실패 ${fmtNumber(platform.failed)}건</small>
        </span>
        <b class="platform-badge">${platformRoleLabel(platform.platform)}</b>
      </summary>
      <div class="platform-status-grid">
        ${statusOrder.map((name) => `
          <div class="platform-status ${name === "실패" && platform.statusCounts?.[name] ? "warning" : ""}">
            <strong>${fmtNumber(platform.statusCounts?.[name] || 0)}</strong>
            <span>${name}</span>
          </div>
        `).join("")}
      </div>
      <div class="platform-groups">
        ${statusOrder.map((name) => `
          <section class="platform-group">
            <h3>${name}</h3>
            ${renderPlatformSamples(platform.samplesByStatus?.[name] || [])}
          </section>
        `).join("")}
      </div>
    </details>
  `).join("");
}

function renderDownloads() {
  const downloads = state.data?.downloads || [];
  if (!downloads.length) {
    els.downloadList.innerHTML = `<div class="empty">다운로드할 파일이 없습니다.</div>`;
    return;
  }
  els.downloadList.innerHTML = downloads.map((file) => `
    <a class="download-item" href="${file.url}" target="_blank" rel="noreferrer">
      <strong>${file.name}</strong>
      <span>열기 / 다운로드</span>
    </a>
  `).join("");
}

async function submitCrawl(event) {
  event.preventDefault();
  if (state.loading) return;

  const button = els.crawlForm.querySelector("button[type='submit']");
  const payload = {
    keyword: els.keywordInput.value.trim(),
    checkIn: els.checkInInput.value,
    checkOut: els.checkOutInput.value,
    adults: Number(els.adultsInput.value || 2)
  };
  if (!payload.keyword) {
    els.crawlStatus.textContent = "키워드를 입력하세요.";
    addFeedback("키워드를 입력해야 수집을 시작할 수 있습니다.", "warning");
    return;
  }

  state.loading = true;
  button.disabled = true;
  status("수집 실행 중");
  els.crawlStatus.textContent = "수집 중입니다. 플랫폼 응답에 따라 시간이 걸릴 수 있습니다.";
  addFeedback(`${payload.keyword} 수집을 시작했습니다. 네이버와 숙박 플랫폼 응답을 기다리는 중입니다.`, "progress");

  try {
    const result = await fetchJson("/api/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    state.runs = result.runs || [];
    state.activeRunId = result.runId || state.runs[0]?.id;
    renderRuns();
    if (state.activeRunId) await loadRun(state.activeRunId);
    els.crawlStatus.textContent = "수집이 완료되었습니다.";
    addFeedback("수집이 완료되었습니다. 최신 결과로 화면을 갱신했습니다.", "success");
  } catch (error) {
    els.crawlStatus.textContent = `수집 실패: ${error.message}`;
    status("수집 실패");
    addFeedback(`수집 실패: ${error.message}`, "error");
  } finally {
    state.loading = false;
    button.disabled = false;
  }
}

async function submitTrafficKeys(event) {
  event.preventDefault();

  const payload = {
    naverClientId: els.naverClientIdInput.value,
    naverClientSecret: els.naverClientSecretInput.value,
    searchadApiKey: els.searchadApiKeyInput.value,
    searchadSecretKey: els.searchadSecretKeyInput.value,
    searchadCustomerId: els.searchadCustomerIdInput.value
  };

  els.trafficKeyStatus.textContent = "저장 중입니다.";
  addFeedback("트래픽 API 키 저장을 시도합니다.", "progress");

  try {
    const data = await fetchJson("/api/settings/traffic-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    els.trafficKeyForm.reset();
    renderTrafficKeyStatus(data);
    addFeedback("트래픽 API 키 저장 상태를 갱신했습니다.", "success");
  } catch (error) {
    els.trafficKeyStatus.textContent = `저장 실패: ${error.message}`;
    addFeedback(`API 키 저장 실패: ${error.message}`, "error");
  }
}

async function copyYeogiScript() {
  const script = csvExtractScript();
  try {
    await navigator.clipboard.writeText(script);
    setYeogiImportStatus("추출 코드가 복사되었습니다. 여기어때 결과 페이지에서 실행한 뒤 나온 CSV를 앱에 붙여넣으세요.", "check");
    addFeedback("여기어때 브라우저 추출 코드를 복사했습니다.", "success");
  } catch (error) {
    showYeogiScriptFallback(script);
    setYeogiImportStatus("클립보드 복사가 막혀 아래 코드 박스에 표시했습니다.", "warning");
    addFeedback("클립보드 복사가 막혀 추출 코드를 별도 박스에 표시했습니다.", "warning");
  }
}

async function copyYeogiScriptBeforeOpen() {
  const script = csvExtractScript();
  try {
    await navigator.clipboard.writeText(script);
    setYeogiImportStatus("추출 코드를 먼저 복사했습니다. 여기어때 검색을 엽니다.", "check");
    addFeedback("추출 코드를 먼저 복사한 뒤 여기어때를 엽니다.", "success");
    return true;
  } catch (error) {
    showYeogiScriptFallback(script);
    setYeogiImportStatus("코드 복사가 막혀 검색을 열지 않았습니다. 아래 코드 박스에서 직접 복사한 뒤 다시 열어주세요.", "warning");
    addFeedback("코드 복사가 막혀 새 탭 열기를 멈췄습니다.", "warning");
    return false;
  }
}

async function copyYeogiSearchLink() {
  const url = yeogiSearchUrl();
  try {
    await navigator.clipboard.writeText(url);
    if (els.yeogiLinkBox) els.yeogiLinkBox.hidden = true;
    setYeogiImportStatus("검색 링크만 복사했습니다. 모바일에서 코드를 쓸 예정이면 '코드 복사 후 열기'를 사용하세요.", "check");
    addFeedback("여기어때 검색 링크만 복사했습니다.", "success");
  } catch (error) {
    showYeogiLinkFallback(url);
    setYeogiImportStatus("클립보드 복사가 막혀 검색 링크를 아래에 표시했습니다.", "warning");
    addFeedback("검색 링크를 직접 선택할 수 있도록 표시했습니다.", "warning");
  }
}

async function openYeogiSearch() {
  const url = yeogiSearchUrl();
  const copied = await copyYeogiScriptBeforeOpen();
  if (!copied) return;
  window.open(url, "_blank", "noopener,noreferrer");
  setYeogiImportStatus("코드를 복사한 뒤 여기어때를 열었습니다. 코드 실행이 어렵다면 결과 화면 텍스트를 복사해 앱에 붙여넣으세요.", "check");
  addFeedback("코드 복사 후 여기어때 검색 페이지를 열었습니다.", "info");
}

async function submitYeogiImport() {
  if (!state.activeRunId) {
    setYeogiImportStatus("먼저 실행 결과를 선택하세요.", "warning");
    syncYeogiManualInterface();
    addFeedback("여기어때 데이터를 합칠 실행 결과가 필요합니다.", "warning");
    return;
  }

  const sourceText = els.yeogiImportInput.value.trim();
  const preview = previewYeogiImport(sourceText);
  if (!sourceText) {
    setYeogiImportStatus("붙여넣기 데이터가 필요합니다.", "warning");
    syncYeogiManualInterface();
    addFeedback("CSV, HTML, 텍스트 중 하나를 붙여넣어야 합니다.", "warning");
    return;
  }
  if (looksLikeYeogiExtractScript(sourceText)) {
    setYeogiImportStatus("추출 코드가 아니라 여기어때 페이지에서 실행한 결과 CSV/HTML/텍스트를 붙여넣어야 합니다.", "warning");
    syncYeogiManualInterface();
    addFeedback("결과 입력칸에 추출 코드가 들어 있어 병합을 중단했습니다.", "warning");
    return;
  }
  if (!preview.ready) {
    setYeogiImportStatus("숙소명 또는 가격 후보가 부족합니다. 여기어때 결과 화면의 텍스트나 추출 CSV를 다시 붙여넣으세요.", "warning");
    syncYeogiManualInterface();
    addFeedback("여기어때 붙여넣기 데이터가 부족해 병합을 중단했습니다.", "warning");
    return;
  }

  els.yeogiImportButton.disabled = true;
  setYeogiImportStatus("여기어때 결과를 병합 중입니다.", "progress");
  addFeedback("여기어때 보조 수집 데이터를 병합합니다.", "progress");

  try {
    const result = await fetchJson("/api/yeogi-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: state.activeRunId, sourceText })
    });
    state.runs = result.runs;
    state.data = result.data;
    state.activeRegion = state.data.regions[0]?.region || null;
    state.mapBounds = computeMapBounds(state.data.regions);
    renderRuns();
    renderAll();
    els.yeogiImportInput.value = "";
    setYeogiImportStatus(`여기어때 ${fmtNumber(result.importedCount)}건 병합 완료`, "ready");
    status("준비");
    addFeedback(`여기어때 ${fmtNumber(result.importedCount)}건을 현재 결과에 반영했습니다.`, "success");
  } catch (error) {
    setYeogiImportStatus(`병합 실패: ${error.message}`, "error");
    addFeedback(`여기어때 병합 실패: ${error.message}`, "error");
  } finally {
    syncYeogiManualInterface();
  }
}

function wireEvents() {
  els.refreshRuns.addEventListener("click", () => loadRuns(true).catch((error) => {
    status("오류");
    els.crawlStatus.textContent = error.message;
    addFeedback(`결과 새로고침 실패: ${error.message}`, "error");
  }));

  els.runSelect.addEventListener("change", (event) => {
    loadRun(event.target.value).catch((error) => {
      status("오류");
      els.detailPanel.innerHTML = `<div class="empty">${error.message}</div>`;
      addFeedback(`결과 표시 실패: ${error.message}`, "error");
    });
  });

  els.layerButtons.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      state.layer = button.dataset.layer;
      renderLayerControls();
      renderMap();
      renderDetail();
    });
  });

  els.crawlForm.addEventListener("submit", submitCrawl);
  els.yeogiCopyLinkButton.addEventListener("click", copyYeogiSearchLink);
  els.yeogiOpenButton.addEventListener("click", openYeogiSearch);
  els.yeogiScriptButton.addEventListener("click", copyYeogiScript);
  els.yeogiToggleScriptButton.addEventListener("click", toggleYeogiScriptBox);
  els.yeogiClearButton.addEventListener("click", clearYeogiImport);
  els.yeogiImportInput.addEventListener("input", syncYeogiManualInterface);
  els.keywordInput.addEventListener("input", syncYeogiManualInterface);
  els.checkInInput.addEventListener("change", syncYeogiManualInterface);
  els.checkOutInput.addEventListener("change", syncYeogiManualInterface);
  els.adultsInput.addEventListener("input", syncYeogiManualInterface);
  els.yeogiImportButton.addEventListener("click", submitYeogiImport);
  els.trafficKeyForm.addEventListener("submit", submitTrafficKeys);
}

async function startApp() {
  if (state.started) return;
  state.started = true;
  initializeDateInputs();
  wireEvents();
  addFeedback("키워드를 입력하고 수집 실행을 누르면 진행 상태가 여기에 표시됩니다.", "info");
  loadTrafficKeyStatus().catch(() => {});
  await loadRuns(true);
}

async function boot() {
  await startApp();
}

boot().catch((error) => {
  status("오류");
  els.detailPanel.innerHTML = `<div class="empty">${error.message}</div>`;
});
