const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const INPUT = path.join(ROOT, "outputs", "gyeongbuk_glamping_20260607", "gyeongbuk_naver_place_glamping_clusters.csv");
const OUTPUT = path.join(ROOT, "outputs", "gyeongbuk_glamping_20260607", "gyeongbuk_cluster_map_test.html");

const regionProfiles = {
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
};

const colors = {
  core: {
    "메인 관광지형": "#d84b3a",
    "인접 관광 흡수형": "#e18b2d",
    "자연 관광자원형": "#2f8f5b",
    "생활권·도심 수요형": "#2d6cdf",
    "복합형": "#8057c8"
  },
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
    "확인불가": "#8a8f98"
  },
  type: {
    글램핑: "#2f80ed",
    카라반: "#e18b2d",
    "반려견 동반형": "#8057c8",
    "펜션형 글램핑": "#2f8f5b",
    "키즈/가족형": "#c8504a",
    캠핑장: "#6b7a3a",
    확인필요: "#8a8f98"
  }
};

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

  const headers = rows.shift();
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function minPrice(value) {
  const match = String(value || "").match(/[\d,]+/);
  if (!match) return null;
  return Number(match[0].replace(/,/g, ""));
}

function increment(map, key, by = 1) {
  const safeKey = key || "확인불가";
  map[safeKey] = (map[safeKey] || 0) + by;
}

function topKey(map) {
  return Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] || "확인불가";
}

function summarize(rows) {
  const regions = new Map();

  for (const row of rows) {
    const region = row["지역"] || row["검색클러스터"] || row["소재지클러스터"];
    if (!region || !regionProfiles[region]) continue;

    if (!regions.has(region)) {
      regions.set(region, {
        region,
        ...regionProfiles[region],
        count: 0,
        adCount: 0,
        dualCount: 0,
        organicCount: 0,
        priceSum: 0,
        priceCount: 0,
        priceBuckets: {},
        typeBuckets: {},
        adBuckets: {},
        places: []
      });
    }

    const item = regions.get(region);
    item.count += 1;
    increment(item.priceBuckets, row["가격대클러스터"]);
    increment(item.typeBuckets, row["상품유형클러스터"]);
    increment(item.adBuckets, row["광고집행클러스터"]);

    const adCluster = row["광고집행클러스터"] || "";
    if (adCluster.includes("광고+비광고")) item.dualCount += 1;
    else if (adCluster.includes("광고")) item.adCount += 1;
    else if (adCluster.includes("비광고")) item.organicCount += 1;

    const price = minPrice(row["금액"]);
    if (price) {
      item.priceSum += price;
      item.priceCount += 1;
    }

    item.places.push({
      rank: Number(row["순위"] || 999),
      name: row["업체명"] || "",
      category: row["카테고리"] || "",
      price: row["금액"] || "",
      ad: row["광고집행클러스터"] || "",
      type: row["상품유형클러스터"] || "",
      url: row["url"] || ""
    });
  }

  return [...regions.values()]
    .map((item) => ({
      ...item,
      avgPrice: item.priceCount ? Math.round(item.priceSum / item.priceCount) : null,
      dominantPrice: topKey(item.priceBuckets),
      dominantType: topKey(item.typeBuckets),
      dominantAd: topKey(item.adBuckets),
      places: item.places.sort((a, b) => a.rank - b.rank).slice(0, 5)
    }))
    .sort((a, b) => a.region.localeCompare(b.region, "ko"));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function html(data) {
  const total = data.reduce((sum, item) => sum + item.count, 0);
  const coreCounts = {};
  for (const item of data) increment(coreCounts, item.primary, item.count);

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>경북글램핑 수요 클러스터 지도 테스트</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Arial, "Malgun Gothic", sans-serif;
      --ink: #1c2530;
      --muted: #667085;
      --line: #d9dee8;
      --panel: #ffffff;
      --bg: #f4f6f8;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      letter-spacing: 0;
    }

    header {
      padding: 18px 24px 14px;
      background: #ffffff;
      border-bottom: 1px solid var(--line);
    }

    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.25;
      font-weight: 800;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
    }

    .meta span,
    .legend span {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 0 9px;
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 7px;
    }

    main {
      display: grid;
      grid-template-columns: minmax(540px, 1fr) 360px;
      gap: 16px;
      padding: 16px 24px 24px;
      max-width: 1440px;
      margin: 0 auto;
    }

    .toolbar,
    .map-wrap,
    .side,
    .summary {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }

    .workspace {
      display: grid;
      gap: 12px;
      min-width: 0;
    }

    .toolbar {
      padding: 12px;
      display: grid;
      gap: 12px;
    }

    .segmented,
    .filters,
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    button,
    label.filter {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 7px;
      min-height: 34px;
      padding: 0 11px;
      font-size: 13px;
      cursor: pointer;
    }

    button.active,
    label.filter.active {
      border-color: #1f5fbf;
      background: #eaf2ff;
      color: #174a9c;
      font-weight: 700;
    }

    .dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 6px;
      flex: 0 0 auto;
    }

    .map-wrap {
      position: relative;
      min-height: 680px;
      overflow: hidden;
    }

    svg {
      display: block;
      width: 100%;
      height: 680px;
      background:
        linear-gradient(90deg, rgba(45,108,223,0.06), transparent 42%),
        linear-gradient(180deg, #fbfcfd, #edf3f7);
    }

    .map-region {
      cursor: pointer;
      transition: opacity .15s ease, transform .15s ease;
    }

    .map-region.dim { opacity: .18; }

    .map-region:hover circle,
    .map-region.active circle {
      stroke: #111827;
      stroke-width: 3;
    }

    .region-label {
      font-size: 12px;
      font-weight: 700;
      pointer-events: none;
      paint-order: stroke;
      stroke: #fff;
      stroke-width: 4px;
      stroke-linejoin: round;
    }

    .coast {
      fill: none;
      stroke: #87a8c7;
      stroke-width: 3;
      stroke-dasharray: 6 7;
    }

    .map-note {
      position: absolute;
      right: 16px;
      bottom: 14px;
      color: var(--muted);
      font-size: 12px;
      background: rgba(255,255,255,.86);
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 7px 9px;
    }

    .side {
      padding: 16px;
      display: grid;
      align-content: start;
      gap: 14px;
      min-width: 0;
    }

    .region-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 12px;
    }

    .region-title h2 {
      margin: 0;
      font-size: 22px;
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .kpi {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px;
      min-height: 64px;
      background: #fbfcfd;
    }

    .kpi strong {
      display: block;
      font-size: 18px;
      margin-bottom: 4px;
    }

    .kpi span,
    .field span {
      color: var(--muted);
      font-size: 12px;
    }

    .field {
      display: grid;
      gap: 4px;
      font-size: 14px;
      line-height: 1.45;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th,
    td {
      border-bottom: 1px solid var(--line);
      padding: 8px 6px;
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-weight: 700;
      white-space: nowrap;
    }

    .summary {
      grid-column: 1 / -1;
      padding: 14px 16px 16px;
    }

    .summary h2 {
      margin: 0 0 8px;
      font-size: 17px;
    }

    .cluster-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      gap: 8px;
    }

    .cluster-tile {
      border: 1px solid var(--line);
      border-left-width: 5px;
      border-radius: 7px;
      padding: 10px;
      background: #fff;
    }

    .cluster-tile strong {
      display: block;
      font-size: 18px;
      margin-bottom: 3px;
    }

    .cluster-tile span {
      color: var(--muted);
      font-size: 12px;
    }

    @media (max-width: 1040px) {
      main {
        grid-template-columns: 1fr;
        padding: 12px;
      }

      .map-wrap { min-height: 560px; }
      svg { height: 560px; }
      .cluster-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    @media (max-width: 640px) {
      header { padding: 16px 12px 12px; }
      h1 { font-size: 20px; }
      .cluster-grid { grid-template-columns: 1fr; }
      .kpi-grid { grid-template-columns: 1fr; }
      button, label.filter { flex: 1 1 auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>경북글램핑 수요 클러스터 지도 테스트</h1>
    <div class="meta">
      <span>네이버 지역별 상위 5개 ${total}건</span>
      <span>${data.length}개 시군</span>
      <span>본질 클러스터 기본</span>
      <span>유형·가격·광고 옵션 레이어</span>
    </div>
  </header>

  <main>
    <section class="workspace" aria-label="지도 작업 영역">
      <div class="toolbar">
        <div class="segmented" id="modeButtons">
          <button class="active" data-mode="core">본질</button>
          <button data-mode="type">유형</button>
          <button data-mode="price">가격</button>
          <button data-mode="ad">광고</button>
        </div>
        <div class="filters" id="clusterFilters"></div>
        <div class="legend" id="legend"></div>
      </div>

      <div class="map-wrap">
        <svg id="map" viewBox="0 0 820 680" role="img" aria-label="경북 글램핑 클러스터 지도">
          <path class="coast" d="M665,80 C700,160 710,245 692,330 C680,400 690,492 650,590" />
          <path class="coast" d="M244,575 C330,624 448,630 560,596 C620,577 648,563 678,526" opacity=".45" />
          <text x="690" y="320" fill="#5f87a8" font-size="15" font-weight="700">동해</text>
          <g id="links"></g>
          <g id="markers"></g>
        </svg>
        <div class="map-note">시군 중심 좌표 기반 테스트 · 업체 개별 좌표는 주소 변환 단계에서 확장</div>
      </div>
    </section>

    <aside class="side" id="detail" aria-label="상세 정보"></aside>

    <section class="summary">
      <h2>본질 클러스터 집계</h2>
      <div class="cluster-grid">
        ${Object.keys(colors.core).map((name) => `
          <div class="cluster-tile" style="border-left-color:${colors.core[name]}">
            <strong>${coreCounts[name] || 0}</strong>
            <span>${escapeHtml(name)}</span>
          </div>`).join("")}
      </div>
    </section>
  </main>

  <script>
    const data = ${JSON.stringify(data)};
    const colors = ${JSON.stringify(colors)};
    let mode = "core";
    let activeRegion = data[0]?.region;
    let enabledClusters = new Set(Object.keys(colors.core));

    const bounds = { minLon: 127.95, maxLon: 130.95, minLat: 35.55, maxLat: 37.55 };
    const labelOffsets = {
      김천: { x: -28, y: 28 },
      구미: { x: 0, y: -34 },
      칠곡: { x: 44, y: -2 },
      성주: { x: -38, y: 4 },
      고령: { x: -34, y: 28 },
      경산: { x: 42, y: -18 },
      청도: { x: 35, y: 32 },
      영천: { x: -42, y: -6 },
      경주: { x: 42, y: 22 },
      포항: { x: 46, y: -8 },
      상주: { x: -40, y: -4 },
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
    };
    const map = document.getElementById("map");
    const markers = document.getElementById("markers");
    const links = document.getElementById("links");
    const legend = document.getElementById("legend");
    const detail = document.getElementById("detail");
    const filters = document.getElementById("clusterFilters");

    function project(item) {
      if (item.region === "울릉") return { x: 742, y: 83 };
      const x = 70 + ((item.lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * 630;
      const y = 55 + ((bounds.maxLat - item.lat) / (bounds.maxLat - bounds.minLat)) * 560;
      return { x, y };
    }

    function colorFor(item) {
      if (mode === "core") return colors.core[item.primary] || "#8a8f98";
      if (mode === "type") return colors.type[item.dominantType] || "#8a8f98";
      if (mode === "price") return colors.price[item.dominantPrice] || "#8a8f98";
      if (mode === "ad") return colors.ad[item.dominantAd] || "#8a8f98";
      return "#8a8f98";
    }

    function categoryFor(item) {
      if (mode === "core") return item.primary;
      if (mode === "type") return item.dominantType;
      if (mode === "price") return item.dominantPrice;
      if (mode === "ad") return item.dominantAd;
      return "확인불가";
    }

    function formatPrice(value) {
      if (!value) return "확인불가";
      return value.toLocaleString("ko-KR") + "원";
    }

    function renderFilters() {
      filters.innerHTML = Object.keys(colors.core).map((name) => {
        const checked = enabledClusters.has(name);
        return '<label class="filter ' + (checked ? 'active' : '') + '" data-cluster="' + name + '">' +
          '<span class="dot" style="background:' + colors.core[name] + '"></span>' + name +
        '</label>';
      }).join("");

      filters.querySelectorAll("label").forEach((label) => {
        label.addEventListener("click", () => {
          const cluster = label.dataset.cluster;
          if (enabledClusters.has(cluster) && enabledClusters.size > 1) enabledClusters.delete(cluster);
          else enabledClusters.add(cluster);
          render();
        });
      });
    }

    function renderLegend() {
      const palette = colors[mode === "core" ? "core" : mode] || {};
      legend.innerHTML = Object.entries(palette).map(([name, color]) =>
        '<span><span class="dot" style="background:' + color + '"></span>' + name + '</span>'
      ).join("");
    }

    function renderLinks() {
      const active = data.find((item) => item.region === activeRegion) || data[0];
      links.innerHTML = "";
      if (!active || !active.target) return;

      const targetNames = active.target.split(/[·,/]/).map((value) => value.trim()).filter(Boolean);
      const start = project(active);
      for (const name of targetNames) {
        const target = data.find((item) => item.region === name);
        if (!target) continue;
        const end = project(target);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", start.x);
        line.setAttribute("y1", start.y);
        line.setAttribute("x2", end.x);
        line.setAttribute("y2", end.y);
        line.setAttribute("stroke", "#344054");
        line.setAttribute("stroke-width", "2");
        line.setAttribute("stroke-dasharray", "5 5");
        line.setAttribute("opacity", ".38");
        links.appendChild(line);
      }
    }

    function renderMap() {
      markers.innerHTML = "";
      renderLinks();

      for (const item of data) {
        const point = project(item);
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        group.setAttribute("class", "map-region" + (item.region === activeRegion ? " active" : "") + (!enabledClusters.has(item.primary) ? " dim" : ""));
        group.setAttribute("tabindex", "0");
        group.dataset.region = item.region;

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", point.x);
        circle.setAttribute("cy", point.y);
        const radius = Math.min(24, 7 + Math.sqrt(item.count) * 4);
        circle.setAttribute("r", radius);
        circle.setAttribute("fill", colorFor(item));
        circle.setAttribute("fill-opacity", ".86");
        circle.setAttribute("stroke", "#ffffff");
        circle.setAttribute("stroke-width", "2");

        const count = document.createElementNS("http://www.w3.org/2000/svg", "text");
        count.setAttribute("x", point.x);
        count.setAttribute("y", point.y + 4);
        count.setAttribute("text-anchor", "middle");
        count.setAttribute("font-size", "12");
        count.setAttribute("font-weight", "800");
        count.setAttribute("fill", "#fff");
        count.textContent = item.count;

        const offset = labelOffsets[item.region] || { x: 0, y: 27 + Math.sqrt(item.count) * 4 };
        if (Math.abs(offset.x) + Math.abs(offset.y) > 34) {
          const leader = document.createElementNS("http://www.w3.org/2000/svg", "line");
          leader.setAttribute("x1", point.x);
          leader.setAttribute("y1", point.y);
          leader.setAttribute("x2", point.x + offset.x * 0.72);
          leader.setAttribute("y2", point.y + offset.y * 0.72);
          leader.setAttribute("stroke", "#9aa9bb");
          leader.setAttribute("stroke-width", "1.2");
          leader.setAttribute("opacity", ".62");
          group.appendChild(leader);
        }

        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("class", "region-label");
        label.setAttribute("x", point.x + offset.x);
        label.setAttribute("y", point.y + offset.y);
        label.setAttribute("text-anchor", offset.x > 8 ? "start" : offset.x < -8 ? "end" : "middle");
        label.setAttribute("fill", "#263241");
        label.textContent = item.region;

        group.appendChild(circle);
        group.appendChild(count);
        group.appendChild(label);
        group.addEventListener("click", () => {
          activeRegion = item.region;
          render();
        });
        group.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            activeRegion = item.region;
            render();
          }
        });
        markers.appendChild(group);
      }
    }

    function renderDetail() {
      const item = data.find((entry) => entry.region === activeRegion) || data[0];
      if (!item) return;

      detail.innerHTML = \`
        <div class="region-title">
          <h2>\${item.region}</h2>
          <span style="color:\${colors.core[item.primary]};font-weight:800">\${item.primary}</span>
        </div>
        <div class="kpi-grid">
          <div class="kpi"><strong>\${item.count}</strong><span>지역별 상위 노출</span></div>
          <div class="kpi"><strong>\${formatPrice(item.avgPrice)}</strong><span>평균 최저가</span></div>
          <div class="kpi"><strong>\${item.dualCount}</strong><span>광고+비광고 동시</span></div>
          <div class="kpi"><strong>\${categoryFor(item)}</strong><span>현재 레이어 기준</span></div>
        </div>
        <div class="field"><span>보조 클러스터</span><strong>\${item.secondary}</strong></div>
        <div class="field"><span>관광자원 태그</span><strong>\${item.resources.join(", ")}</strong></div>
        <div class="field"><span>트래픽 흡수 대상</span><strong>\${item.target}</strong></div>
        <div class="field"><span>판단 메모</span><strong>\${item.note}</strong></div>
        <table>
          <thead>
            <tr><th>순위</th><th>업체명</th><th>유형</th><th>가격</th></tr>
          </thead>
          <tbody>
            \${item.places.map((place) => \`
              <tr>
                <td>\${place.rank}</td>
                <td>\${place.name}</td>
                <td>\${place.type}</td>
                <td>\${place.price || "확인불가"}</td>
              </tr>\`).join("")}
          </tbody>
        </table>
      \`;
    }

    function render() {
      renderFilters();
      renderLegend();
      renderMap();
      renderDetail();
    }

    document.getElementById("modeButtons").querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        mode = button.dataset.mode;
        document.querySelectorAll("#modeButtons button").forEach((item) => item.classList.toggle("active", item === button));
        render();
      });
    });

    render();
  </script>
</body>
</html>`;
}

const csv = fs.readFileSync(INPUT, "utf8").replace(/^\uFEFF/, "");
const rows = parseCsv(csv);
const data = summarize(rows);

fs.writeFileSync(OUTPUT, html(data), "utf8");
console.log(JSON.stringify({ output: OUTPUT, regions: data.length, rows: rows.length }, null, 2));
