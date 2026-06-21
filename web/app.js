const state = {
  runs: [],
  data: null,
  activeRunId: null,
  activeTab: "rank",
  selectedItem: null,
  selectedSheetTab: "booking",
  mapData: null,
  mapPromise: null
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
const DEFAULT_BOOKING_DAYS = 7;

const els = {
  pageTitle: document.getElementById("pageTitle"),
  pageSubtitle: document.getElementById("pageSubtitle"),
  summaryGrid: document.getElementById("summaryGrid"),
  noticeCard: document.getElementById("noticeCard"),
  rankCount: document.getElementById("rankCount"),
  companyList: document.getElementById("companyList"),
  targetCount: document.getElementById("targetCount"),
  targetList: document.getElementById("targetList"),
  mapCount: document.getElementById("mapCount"),
  mapLayerRow: document.getElementById("mapLayerRow"),
  clusterMap: document.getElementById("clusterMap"),
  mapLegend: document.getElementById("mapLegend"),
  regionList: document.getElementById("regionList"),
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
  keywordInput: document.getElementById("keywordInput"),
  checkInInput: document.getElementById("checkInInput"),
  checkOutInput: document.getElementById("checkOutInput"),
  productModeInput: document.getElementById("productModeInput"),
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
    throw new Error(data.error || `요청 실패: ${response.status}`);
  }
  return data;
}

function setStatus(text) {
  if (els.adminStatus) els.adminStatus.textContent = text;
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
  return String(value || "").replace(/\s+/g, "").toLowerCase();
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

function companyPlatformMap() {
  const map = new Map();
  for (const company of state.data?.companyPlatforms || []) {
    map.set(company.key || companyKey(company.name), company);
  }
  return map;
}

function platformsForItem(item) {
  const map = companyPlatformMap();
  const company = map.get(companyKey(item.name));
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
    return `<span class="platform-chip ${tone}"><b class="platform-dot">${platformLetter(row.platform)}</b>${escapeHtml(name)}</span>`;
  }).join("");
}

function weeklyRows(item = {}) {
  const detail = String(item.weeklyReservationRateDetail || "");
  if (!detail) return [];
  return detail.split(/\s*,\s*/).map((entry) => {
    const match = entry.match(/^(\d{1,2}\/\d{1,2})\s+(\d+)%\((\d+)\/(\d+)\)$/);
    if (!match) return null;
    return {
      label: match[1],
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
      return { sold: weeklySold, supply: weeklySupply, rate: weeklySold / weeklySupply, unit: "박", label: `${rows.length || days}일 집계`, basis: "range" };
    }
    if (rows.length) {
      const sum = rows.reduce((acc, row) => {
        acc.sold += finiteNumber(row.sold);
        acc.supply += finiteNumber(row.total);
        return acc;
      }, { sold: 0, supply: 0 });
      return { ...sum, rate: sum.supply ? sum.sold / sum.supply : NaN, unit: "박", label: `${rows.length}일 집계`, basis: "range" };
    }
    const total = finiteNumber(item.nightTotalStock, finiteNumber(item.totalRooms, 0));
    const available = finiteNumber(item.nightAvailableStock, finiteNumber(item.availableRooms, total));
    const sold = Math.max(0, total - available);
    return { sold, supply: total, rate: total ? sold / total : NaN, unit: "박", label: `${basisDate} 기준`, basis: "basis" };
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

function categoryText(item = {}) {
  return [item.region || item.address, item.category || item.type].filter(Boolean).join(" · ") || "지역 확인";
}

function miniBars(item) {
  const rows = weeklyRows(item);
  const visible = rows.length
    ? rows.slice(0, 7)
    : Array.from({ length: Math.max(3, Math.min(DEFAULT_BOOKING_DAYS, bookingDays(state.data?.run || {}) || DEFAULT_BOOKING_DAYS)) }, (_, index) => {
      const lodging = salesStats(item, "lodging");
      const base = Number.isFinite(lodging.rate) ? lodging.rate : 0;
      const variance = [0.35, 0.55, 0.42, 0.68, 0.5, 0.75, 0.6][index % 7];
      return {
        label: index === 0 ? monthDay(state.data?.run?.checkIn) : "",
        rate: Math.max(0.04, Math.min(1, base ? (base * 0.55) + (variance * 0.45) : variance * 0.25)),
        sold: null,
        total: null
      };
    });
  const first = visible[0]?.label || monthDay(state.data?.run?.checkIn) || "";
  const last = rows.length ? visible[visible.length - 1]?.label : monthDay(state.data?.run?.checkOut);
  return `
    <div class="mini-bars" aria-label="날짜별 판매 흐름">
      <div class="bar-row">
        ${visible.map((row) => {
          const height = Math.max(7, Math.round((Number(row.rate) || 0.05) * 31));
          const hot = Number(row.rate) >= 0.45 ? "hot" : "";
          const title = row.total ? `${row.label} ${row.sold}/${row.total} 추정` : `${row.label || "기간"} 보조 그래프`;
          return `<i class="${hot}" style="height:${height}px" title="${escapeHtml(title)}"></i>`;
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
  els.summaryGrid.innerHTML = `
    <article class="summary-card">
      <span class="summary-icon blue">박</span>
      <div><strong>${fmtNumber(sales.sold)}/${fmtNumber(sales.supply)}</strong><small>숙박 판매</small></div>
    </article>
    <article class="summary-card">
      <span class="summary-icon purple">업</span>
      <div><strong>${fmtNumber(checked)}</strong><small>업체</small></div>
    </article>
    <article class="summary-card">
      <span class="summary-icon green">%</span>
      <div><strong>${fmtRate(rate)}</strong><small>평균 판매율</small></div>
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

  els.companyList.innerHTML = items.slice(0, 30).map((item, index) => {
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
          ${miniBars(item)}
        </div>
        <div class="company-action">
          <div>
            <div class="price">${escapeHtml(priceText(item.price))}</div>
            <div class="platform-chips">${platformChips(item)}</div>
          </div>
          <button class="more-button" type="button" data-open-company="${index}">더보기</button>
        </div>
      </article>
    `;
  }).join("");
}

function targetReasons(item) {
  const platforms = platformsForItem(item).map((row) => platformShortName(row.platform));
  const lodging = salesStats(item, "lodging");
  const day = salesStats(item, "day");
  const reasons = [];
  if (!platforms.includes("여기어때")) reasons.push("여기어때 확인");
  if (!platforms.includes("야놀자")) reasons.push("야놀자 미노출");
  if (!platforms.includes("떠나요")) reasons.push("떠나요 확인");
  if (Number.isFinite(lodging.rate) && lodging.rate < 0.25) reasons.push("판매율 낮음");
  if (!day.supply) reasons.push("당일상품 없음");
  if (item.ad && String(item.ad).includes("광고")) reasons.push("광고비 효율 점검");
  return reasons.slice(0, 5);
}

function renderTargets() {
  const items = (state.data?.availability?.items || [])
    .map((item) => ({ item, reasons: targetReasons(item) }))
    .filter((entry) => entry.reasons.length)
    .sort((a, b) => b.reasons.length - a.reasons.length || Number(a.item.rank || 999) - Number(b.item.rank || 999))
    .slice(0, 15);

  els.targetCount.textContent = `${fmtNumber(items.length)} 후보`;
  if (!items.length) {
    els.targetList.innerHTML = `<div class="empty">현재 기준 영업 후보가 없습니다.</div>`;
    return;
  }

  els.targetList.innerHTML = items.map(({ item, reasons }, index) => `
    <article class="target-card">
      <div class="target-head">
        <strong>${index + 1}. ${escapeHtml(item.name)}</strong>
        <span>컨택 후보</span>
      </div>
      <p class="hint">${escapeHtml(categoryText(item))} · ${escapeHtml(salesLine(item, "lodging"))}</p>
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

function renderHeader() {
  const run = state.data?.run || {};
  const title = run.label || `${activeKeyword()} 분석`;
  els.pageTitle.textContent = state.activeTab === "rank" ? "업체 순위" :
    state.activeTab === "target" ? "영업 타깃" :
    state.activeTab === "map" ? "지역 클러스터 지도" : "관리";
  els.pageSubtitle.textContent = `${title} · ${dateRangeLabel(run)}`;
  document.title = `글램핑데이터랩 V2 · ${title}`;
}

function renderAll() {
  if (!state.data) return;
  renderHeader();
  renderSummary();
  renderNotice();
  renderCompanies();
  renderTargets();
  renderMap();
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
  if (tab === "map") renderMap();
}

function sheetRowsForBooking(item) {
  const rows = weeklyRows(item);
  if (rows.length) {
    return rows.map((row) => ({
      label: row.label,
      sold: row.sold,
      supply: row.total,
      rate: row.rate,
      unit: "박",
      statusText: "판매/마감 추정",
      note: "네이버예약 날짜별 재고"
    }));
  }
  const lodging = salesStats(item, "lodging");
  if (!lodging.supply) return [];
  return [{
    label: `${monthDay(state.data?.run?.checkIn) || "기준일"} 기준`,
    sold: lodging.sold,
    supply: lodging.supply,
    rate: lodging.rate,
    unit: "박",
    statusText: "판매/마감 추정",
    note: item.listType || "네이버예약 기준일 재고"
  }];
}

function dateRow(row) {
  const rate = Number.isFinite(row.rate) ? row.rate : 0;
  const statusText = row.statusText || "판매/마감 추정";
  const note = row.note ? `${row.note} · ` : "";
  return `
    <div class="date-row">
      <div>
        <strong>${escapeHtml(row.label)} · ${fmtNumber(row.sold)}/${fmtNumber(row.supply)}${row.unit} ${escapeHtml(statusText)}</strong>
        <small>${escapeHtml(note)}추정률 ${fmtRate(row.rate)}</small>
      </div>
      <div class="progress"><span style="width:${Math.max(2, Math.min(100, rate * 100))}%"></span></div>
    </div>
  `;
}

function renderSheetBooking(item) {
  const day = salesStats(item, "day");
  const hasDailyRows = weeklyRows(item).length > 0;
  const lodgingRows = sheetRowsForBooking(item);
  const dayRows = day.supply ? [{
    label: `${monthDay(state.data?.run?.checkIn) || "기준일"} 기준`,
    sold: day.sold,
    supply: day.supply,
    rate: day.rate,
    unit: "회",
    statusText: "판매/마감 추정",
    note: "데이유즈/캠프닉 기준일 재고"
  }] : [];
  return `
    <section class="sheet-section">
      <h3>${hasDailyRows ? "숙박 일자별 상세" : "숙박 기준일 상세"}</h3>
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
          <small>숙박은 날짜별 재고가 수집된 경우에만 기간 합산합니다. 없으면 기준일 재고만 표시합니다.</small>
        </div>
        <strong>${hasDailyRows ? "기간 집계" : "기준일"}</strong>
      </div>
      <div class="search-row">
        <div>
          <strong>데이유즈/캠프닉</strong>
          <small>현재는 기준일 확인 재고입니다. 숙박 예약률 계산에는 포함하지 않습니다.</small>
        </div>
        <strong>보조 지표</strong>
      </div>
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
        return `
          <div class="platform-row ${tone}">
            <b class="platform-dot">${platformLetter(row.platform)}</b>
            <div>
              <strong>${escapeHtml(platformShortName(row.platform))}</strong>
              <small>${escapeHtml(row.price || row.stock || row.inventoryNote || "상세 확인")}</small>
            </div>
            <em>${escapeHtml(label)}</em>
          </div>
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
  if (els.runSelect) els.runSelect.value = runId;
  const run = data.run || {};
  if (els.keywordInput) els.keywordInput.value = run.keyword || (run.label || "").split("·")[0].trim() || els.keywordInput.value;
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
    const result = await fetchJson("/api/yeogi-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: state.activeRunId, sourceText })
    });
    state.runs = result.runs || state.runs;
    state.data = result.data || state.data;
    els.yeogiImportInput.value = "";
    setYeogiBadge("통합완료");
    els.yeogiImportStatus.textContent = `통합 완료: ${fmtNumber(result.importedCount || 0)}건 반영 · 화면 자동 갱신`;
    renderAll();
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
    const payload = {
      naverClientId: els.naverClientIdInput.value,
      naverClientSecret: els.naverClientSecretInput.value,
      searchadApiKey: els.searchadApiKeyInput.value,
      searchadSecretKey: els.searchadSecretKeyInput.value,
      searchadCustomerId: els.searchadCustomerIdInput.value
    };
    const data = await fetchJson("/api/settings/traffic-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    renderTrafficState(data);
    els.trafficKeyForm.reset();
    els.trafficKeyStatus.textContent = "API 키를 저장했습니다.";
  } catch (error) {
    els.trafficKeyStatus.textContent = `저장 실패: ${error.message}`;
  }
}

function renderTrafficState(data) {
  const ready = data?.datalabConfigured || data?.searchadConfigured;
  els.trafficApiState.textContent = ready ? "연동 준비" : "미설정";
}

async function loadTrafficState() {
  try {
    renderTrafficState(await fetchJson("/api/settings/traffic-keys"));
  } catch {
    renderTrafficState(null);
  }
}

async function submitCrawl(event) {
  event.preventDefault();
  const payload = {
    keyword: els.keywordInput.value.trim(),
    checkIn: els.checkInInput.value,
    checkOut: els.checkOutInput.value,
    productMode: els.productModeInput.value
  };
  els.crawlStatus.textContent = "수집 실행 중입니다.";
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
    els.crawlStatus.textContent = "수집 완료. 화면을 갱신했습니다.";
    setActiveTab("rank");
  } catch (error) {
    els.crawlStatus.textContent = `수집 실패: ${error.message}`;
    setStatus("수집 실패");
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
}

async function init() {
  bindEvents();
  setDefaultDates();
  try {
    await Promise.all([loadRuns(true), loadTrafficState()]);
  } catch (error) {
    setStatus("오류");
    els.pageSubtitle.textContent = error.message;
    els.companyList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

init();
