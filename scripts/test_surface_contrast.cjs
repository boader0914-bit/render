const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const stylesPath = path.join(root, "web", "styles.css");
const themePath = path.join(root, "web", "admin-theme.css");
const appPath = path.join(root, "web", "app.js");
const indexPath = path.join(root, "web", "index.html");
const serviceWorkerPath = path.join(root, "web", "sw.js");
const serverPath = path.join(root, "scripts", "glamping_app_server.cjs");
const crawlerPath = path.join(root, "scripts", "gyeongnam_glamping_crawl.cjs");
const channelAssetPaths = {
  naver: path.join(root, "web", "assets", "channels", "naver.webp"),
  nol: path.join(root, "web", "assets", "channels", "nol.png"),
  yeogi: path.join(root, "web", "assets", "channels", "yeogi.webp"),
  ddnayo: path.join(root, "web", "assets", "channels", "ddnayo.ico"),
  sources: path.join(root, "web", "assets", "channels", "SOURCES.md")
};
const styles = fs.readFileSync(stylesPath, "utf8");
const themeStyles = fs.readFileSync(themePath, "utf8");
const app = fs.readFileSync(appPath, "utf8");
const indexHtml = fs.readFileSync(indexPath, "utf8");
const serviceWorker = fs.readFileSync(serviceWorkerPath, "utf8");
const server = fs.readFileSync(serverPath, "utf8");
const crawler = fs.readFileSync(crawlerPath, "utf8");

const requiredMarkers = [
  "Surface contrast contract v3",
  "Location contrast contract v5",
  "Dark surface coherence v1",
  "Sabun Labs UI alignment v1",
  "SABUN × BLACK unified surface contract v2",
  "UI surface contract v3",
  "[data-surface=\"light\"]",
  "[data-surface=\"dark\"]"
];

const lightSelectors = [
  ".report-target-row",
  ".report-region-grid div",
  ".demand-company-card",
  ".demand-company-card dl div",
  ".company-insight-grid div",
  ".b2b-company-card-summary div",
  ".b2b-rank-metrics article",
  ".b2b-rank-board-grid article",
  ".b2b-rank-action-board div",
  ".b2b-rank-focus button",
  ".b2b-rank-range-row",
  ".b2b-correlation-card",
  ".b2b-correlation-chart",
  ".b2b-correlation-list div",
  ".b2b-demand-competitors button",
  ".b2b-keyword-focus article",
  ".b2b-keyword-list button",
  ".b2b-map-region-rank div:not(:first-child)",
  ".validation-target-list button",
  ".audit-queue-list button",
  ".audit-status-strip span",
  ".collection-diagnostic-list div",
  ".admin-db-channel-panel",
  ".admin-db-channel-summary article",
  ".admin-db-channel-row",
  ".admin-db-applied-values",
  ".admin-db-applied-grid article",
  ".admin-db-selected-grid article",
  ".admin-db-selected-brief article",
  ".admin-db-selected-next-grid article",
  ".admin-db-selected-task-rail article",
  ".admin-db-audit-detail-grid article",
  ".admin-db-audit-queue article",
  ".admin-queue-summary-grid article",
  ".admin-queue-row:not(.head)",
  ".admin-region-ops-queue-grid article",
  ".admin-location-score-queue-list article",
  ".company-review-queue article",
  ".sheet-audit-summary div",
  ".sheet-audit-grid div",
  ".sheet-audit-criteria article",
  ".sheet-booking-bars",
  ".sheet-weekday-bars div",
  ".sheet-collection-grid div",
  ".sheet-b2b-platform-grid div",
  ".sheet-b2b-detail-grid div",
  ".sheet-b2b-flow-strip div",
  ".sheet-b2b-evidence-grid div",
  ".sheet-b2b-note-grid div",
  ".search-row",
  ".platform-row",
  ".location-decision",
  ".location-decision-score",
  ".location-score-model-head > *",
  ".location-score-component-grid article",
  ".location-score-validation-grid article",
  ".location-score-admin-form",
  ".location-score-history article",
  ".admin-region-location-score-panel",
  ".admin-region-location-score-grid article",
  ".location-evidence",
  ".location-candidate-evidence div",
  ".location-request-row",
  ".location-reality-grid > *",
  ".location-compare-bars",
  ".location-target-row",
  ".location-empty-note",
  ".location-action-panel",
  ".location-index",
  ".location-advice-card",
  ".location-summary-grid > *"
];

const darkSelectors = [
  ".company-card",
  ".validation-card",
  ".validation-card-collection",
  ".validation-card-audit",
  ".decision-queue-intro",
  ".company-check-card",
  ".report-card",
  ".b2b-rank-brief",
  ".b2b-rank-exposure-board",
  ".b2b-rank-range-board",
  ".b2b-rank-action-board",
  ".demand-hero-card",
  ".demand-chart",
  ".demand-insight-card",
  ".demand-table-card",
  ".structure-card",
  ".b2b-location-score",
  ".b2b-map-location-score",
  ".admin-db-company",
  ".admin-db-flat-list",
  ".admin-console-panel",
  ".company-review-queue",
  ".place-rank-change-stats article.up strong",
  ".admin-db-applied-values",
  ".location-decision"
];

const appSurfaceContracts = [
  'data-surface="light"',
  'data-surface="dark"',
  'class="admin-db-company',
  'class="admin-db-applied-values',
  'class="admin-db-channel-row',
  'class="demand-company-card"',
  'class="demand-chart'
];

const sabunThemeContracts = [
  'font-family: "Sabun MaruBuri"',
  '--theme-accent: #3f6350',
  '--bg: #f7f5f0',
  '--bg: #000000',
  '--panel: #111111',
  '--card-radius: 12px',
  '--card-hover: #edf2ee',
  '--card-hover: #1c1c1c'
];

const unifiedSurfaceContracts = [
  '--card-radius: 12px',
  '--card-radius-large: 14px',
  '--card-transition: background-color 160ms ease-out',
  '--card-bg: #ffffff',
  '--card-bg: #111111',
  '.admin-kpi-grid > article',
  '.admin-db-province-card-grid > button',
  '.admin-db-company-values > span',
  '.collection-archive-actions button',
  '@media (hover: hover)'
];

const explicitSurfaceContracts = [
  '[data-ui-surface="card"]',
  '[data-ui-surface="metric"]',
  '[data-ui-surface="control"]',
  '[data-ui-surface="soft"]',
  '[data-ui-status="positive"]',
  '[data-ui-status="warning"]',
  '[data-ui-status="danger"]',
  '[data-ui-interactive="true"]',
  '[data-admin-section-panel="files"] .advanced-box'
];

const canonicalThemeContracts = [
  "SABUN Data Lab theme system",
  "--app-bg: #f7f8f5",
  "--surface-card: #ffffff",
  "--accent: #3e7565",
  "--app-bg: #000000",
  "--surface-card: #111111",
  "--theme-surface-soft: #171717",
  "--accent: #91bfa9",
  ".admin-region-ops-queue",
  ".admin-member-summary > article",
  ".flow-chip-row > span",
  ".location-score-component-grid > article",
  "Every named dashboard surface is neutral",
  "State changes are small signals",
  "Desktop navigation is fixed"
];

const appExplicitSurfaceContracts = [
  'class="admin-console-panel admin-member-panel" data-ui-surface="card"',
  'class="admin-db-company-explorer" aria-label="업체 DB 검색과 지역 탐색"',
  'data-ui-surface="control" data-ui-interactive="true" data-admin-db-company-province=',
  'data-ui-surface="control" data-ui-interactive="true" data-admin-db-company-region=',
  'class="location-decision ${decision.tone}" data-ui-surface="soft"',
  'data-ui-status="${escapeHtml(component.tone)}"'
];

const indexExplicitSurfaceContracts = [
  'id="trafficAdminCard" data-ui-surface="card"',
  'class="advanced-box" data-ui-surface="control"',
  'id="companyMasterAdminCard" data-ui-surface="card"',
  'id="downloadAdminCard" data-ui-surface="card"'
];

function hexToRgb(hex) {
  const normalized = String(hex || "").replace("#", "").trim();
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16)
  };
}

function luminancePart(value) {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground, background) {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  if (!fg || !bg) return 0;
  const fgLum = 0.2126 * luminancePart(fg.r) + 0.7152 * luminancePart(fg.g) + 0.0722 * luminancePart(fg.b);
  const bgLum = 0.2126 * luminancePart(bg.r) + 0.7152 * luminancePart(bg.g) + 0.0722 * luminancePart(bg.b);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

function assert(condition, message, failures) {
  if (!condition) failures.push(message);
}

const failures = [];

for (const marker of requiredMarkers) {
  assert(styles.includes(marker), `missing style marker: ${marker}`, failures);
}

for (const selector of lightSelectors) {
  assert(styles.includes(selector), `missing light surface selector: ${selector}`, failures);
}

for (const selector of darkSelectors) {
  assert(styles.includes(selector), `missing dark surface selector: ${selector}`, failures);
}

for (const contract of appSurfaceContracts) {
  assert(app.includes(contract), `missing app surface contract: ${contract}`, failures);
}

for (const contract of sabunThemeContracts) {
  assert(styles.includes(contract), `missing Sabun theme contract: ${contract}`, failures);
}

for (const contract of unifiedSurfaceContracts) {
  assert(styles.includes(contract), `missing unified surface contract: ${contract}`, failures);
}

for (const contract of explicitSurfaceContracts) {
  assert(styles.includes(contract), `missing explicit surface contract: ${contract}`, failures);
}

for (const contract of canonicalThemeContracts) {
  assert(themeStyles.includes(contract), `missing canonical theme contract: ${contract}`, failures);
}

assert(indexHtml.includes('href="/admin-theme.css"'), "index must load the canonical theme module", failures);
assert(!themeStyles.includes("linear-gradient"), "canonical theme must not introduce gradients", failures);
assert(!themeStyles.includes("#08111f"), "canonical theme must not restore legacy navy", failures);
assert(!themeStyles.includes("rgba(74, 144, 226"), "canonical theme must not restore legacy blue", failures);

for (const contract of appExplicitSurfaceContracts) {
  assert(app.includes(contract), `missing explicit app surface contract: ${contract}`, failures);
}

for (const contract of indexExplicitSurfaceContracts) {
  assert(indexHtml.includes(contract), `missing explicit static surface contract: ${contract}`, failures);
}

const explicitSurfaceStart = styles.lastIndexOf("UI surface contract v3");
const legacySurfaceStart = styles.lastIndexOf("SABUN × BLACK unified surface contract v2");
const explicitSurfaceStyles = explicitSurfaceStart >= 0 ? styles.slice(explicitSurfaceStart) : "";
assert(explicitSurfaceStart > legacySurfaceStart, "explicit surface contract must be the final theme layer", failures);
assert(!explicitSurfaceStyles.includes("linear-gradient"), "explicit surface contract must not restore gradients", failures);
assert(!explicitSurfaceStyles.includes("rgba(74, 144, 226"), "explicit surface contract must not restore legacy blue", failures);

const contrastChecks = [
  ["canonical light text", "#172235", "#ffffff", 7],
  ["canonical light muted", "#5e6975", "#ffffff", 4.5],
  ["canonical light accent", "#3e7565", "#ffffff", 4.5],
  ["canonical dark text", "#f4f4f5", "#111111", 7],
  ["canonical dark muted", "#b8b8bd", "#111111", 4.5],
  ["canonical dark accent", "#91bfa9", "#111111", 4.5],
  ["canonical dark warning", "#f2c875", "#111111", 4.5],
  ["canonical dark danger", "#ff9a9a", "#111111", 4.5],
  ["light text", "#162637", "#ffffff", 7],
  ["light muted", "#59636c", "#ffffff", 4.5],
  ["light accent", "#3f6350", "#ffffff", 4.5],
  ["light status positive", "#287f53", "#ffffff", 4.5],
  ["light warning", "#90632a", "#ffffff", 4.5],
  ["light danger", "#ae4d49", "#ffffff", 4.5],
  ["light rank danger", "#a83c3c", "#f3f6f3", 4.5],
  ["light rank warning", "#805009", "#f3f6f3", 4.5],
  ["dark text", "#f5f5f5", "#111111", 7],
  ["dark muted", "#b5b5b5", "#111111", 4.5],
  ["dark accent", "#a7c5ae", "#111111", 4.5],
  ["dark warning", "#e5b46d", "#111111", 4.5],
  ["dark danger", "#f09c98", "#111111", 4.5],
  ["dark status positive", "#76c891", "#111111", 4.5],
  ["dark status warning", "#e5b46d", "#111111", 4.5],
  ["dark status danger", "#f09c98", "#111111", 4.5]
];

for (const [label, foreground, background, minimum] of contrastChecks) {
  const ratio = contrastRatio(foreground, background);
  assert(ratio >= minimum, `${label} contrast ${ratio.toFixed(2)} below ${minimum}`, failures);
}

assert(
  /database:\s*\{[\s\S]*?adminPanelSection:\s*"database"/.test(app),
  "mobile database navigation must open the database panel",
  failures
);

assert(
  app.includes("const ADMIN_NAV_ICON_PATHS = Object.freeze({")
    && app.includes('class="admin-nav-icon"')
    && app.includes('stroke="currentColor"')
    && app.includes('class="admin-nav-icon-shell"'),
  "admin navigation must use the shared currentColor SVG icon system",
  failures
);

const adminNavMetaBlock = app.slice(
  app.indexOf("const ADMIN_NAV_META ="),
  app.indexOf("const ADMIN_NAV_ICON_PATHS =")
);

const adminMobileSectionsBlock = app.slice(
  app.indexOf("const ADMIN_MOBILE_SECTIONS ="),
  app.indexOf("const ADMIN_COMPACT_SECTIONS =")
);
const adminCollectNavigationBlock = adminMobileSectionsBlock.slice(
  adminMobileSectionsBlock.indexOf("  collect: {"),
  adminMobileSectionsBlock.indexOf("  analysis: {")
);
const adminAnalysisNavigationBlock = adminMobileSectionsBlock.slice(
  adminMobileSectionsBlock.indexOf("  analysis: {"),
  adminMobileSectionsBlock.indexOf("  region: {")
);
const adminPrimaryRouteBlock = app.slice(
  app.indexOf("function adminPrimarySectionForTab("),
  app.indexOf("function adminMobileSectionForTab(")
);
const adminMobileRouteBlock = app.slice(
  app.indexOf("function adminMobileSectionForTab("),
  app.indexOf("function syncPrimaryNavButtons(")
);

assert(
  adminCollectNavigationBlock.includes('{ label: "이번 수집 분석", tab: "rank" }')
    && !adminAnalysisNavigationBlock.includes('tab: "rank"')
    && adminPrimaryRouteBlock.includes('if (tab === "rank") return "collect";')
    && adminMobileRouteBlock.includes('["rank", "historyOps"].includes(tab)')
    && app.includes('rank: ["이번 수집 분석", "수집 완료 즉시 품질·확인 대상·저장된 플레이스 순서 분석"]')
    && app.includes('analysis: { icon: "industry", detail: "시장 브리핑" }')
    && indexHtml.includes('id="rankPanel" data-panel="rank" aria-label="이번 수집 분석"')
    && indexHtml.includes("수집 완료 결과의 품질과 저장된 네이버 플레이스 노출순")
    && app.includes("이번 수집 분석 보기"),
  "completed collection results must live under collection analysis while industry briefing remains separate",
  failures
);

assert(
  adminNavMetaBlock.length > 0 && !/[⌂▣⇩▥⌖♙⚙•]/.test(adminNavMetaBlock),
  "admin navigation must not regress to font-dependent symbol icons",
  failures
);

const adminIntegrationDefinitionsBlock = app.slice(
  app.indexOf("const ADMIN_INTEGRATIONS ="),
  app.indexOf("const B2B_NAV_META =")
);
const adminIntegrationRowsBlock = app.slice(
  app.indexOf("function adminTourismIntegrationEvidence("),
  app.indexOf("function adminHomeSourceTimestamp(")
);
const adminIntegrationContext = {
  fmtNumber: (value) => String(value),
  state: {
    trafficKeyState: {
      datalabConfigured: true,
      searchadConfigured: true,
      verification: {}
    },
    tourismDataStatus: {
      sources: [
        { key: "visitors", status: "ready", serviceKeyConfigured: true, endpointConfigured: true },
        { key: "demandStrength", status: "ready", serviceKeyConfigured: true, endpointConfigured: true },
        { key: "resourceDemand", status: "ready", serviceKeyConfigured: true, endpointConfigured: true },
        { key: "diversity", status: "ready", serviceKeyConfigured: true, endpointConfigured: true }
      ],
      visitorHistory: { availableMonthCount: 12 },
      demandStrength: { snapshotCount: 4, availableMonthCount: 4 },
      resourceDemand: { snapshotCount: 12, availableMonthCount: 12 },
      diversity: { snapshotCount: 12, availableMonthCount: 12 },
      demandStrengthBackfill: { completedPairCount: 4 }
    }
  }
};
vm.runInNewContext(
  `${adminIntegrationDefinitionsBlock}\n${adminIntegrationRowsBlock}\nthis.getAdminIntegrationRows = adminIntegrationRows; this.getAdminIntegrationSummary = adminIntegrationSummary; this.getAdminIntegrationSummaryLabel = adminIntegrationSummaryLabel;`,
  adminIntegrationContext
);
const connectedAdminIntegrations = adminIntegrationContext.getAdminIntegrationRows();
const connectedAdminIntegrationSummary = adminIntegrationContext.getAdminIntegrationSummary(connectedAdminIntegrations);

assert(
  connectedAdminIntegrations.find((row) => row.key === "regional-visitors")?.status === "connected"
    && connectedAdminIntegrations.find((row) => row.key === "tourism-demand-strength")?.status === "connected"
    && connectedAdminIntegrations.find((row) => row.key === "tourism-resource-demand")?.status === "connected"
    && connectedAdminIntegrations.find((row) => row.key === "tourism-diversity")?.status === "connected"
    && connectedAdminIntegrationSummary.connected === 4
    && connectedAdminIntegrationSummary.configured === 2
    && connectedAdminIntegrationSummary.planned === 9
    && adminIntegrationContext.getAdminIntegrationSummaryLabel(connectedAdminIntegrationSummary) === "4 정상 · 2 설정 · 9 예정",
  "admin API registry must map four stored tourism sources to 4/15 connected without merging planned APIs",
  failures
);

adminIntegrationContext.state.tourismDataStatus = {
  sources: [
    { key: "visitors", status: "ready", serviceKeyConfigured: true, endpointConfigured: true },
    { key: "demandStrength", status: "ready", serviceKeyConfigured: true, endpointConfigured: true },
    { key: "resourceDemand", status: "ready", serviceKeyConfigured: true, endpointConfigured: true },
    { key: "diversity", status: "ready", serviceKeyConfigured: true, endpointConfigured: true }
  ],
  visitorHistory: { availableMonthCount: 0 },
  demandStrength: { snapshotCount: 0, availableMonthCount: 0 },
  resourceDemand: { snapshotCount: 0, availableMonthCount: 0 },
  diversity: { snapshotCount: 0, availableMonthCount: 0 },
  demandStrengthBackfill: { completedPairCount: 0 }
};
const configuredTourismRows = adminIntegrationContext.getAdminIntegrationRows();
assert(
  configuredTourismRows.find((row) => row.key === "regional-visitors")?.status === "configured"
    && configuredTourismRows.find((row) => row.key === "regional-visitors")?.statusLabel === "설정 완료"
    && configuredTourismRows.find((row) => row.key === "holiday")?.status === "planned",
  "admin API registry must separate configured-first-collection-waiting sources from undeveloped planned sources",
  failures
);

adminIntegrationContext.state.tourismDataStatus.sources[0] = {
  key: "visitors",
  status: "missing_service_key",
  serviceKeyConfigured: false,
  endpointConfigured: true
};
const missingTourismRows = adminIntegrationContext.getAdminIntegrationRows();
const missingTourismSummary = adminIntegrationContext.getAdminIntegrationSummary(missingTourismRows);
assert(
  missingTourismRows.find((row) => row.key === "regional-visitors")?.status === "missing"
    && missingTourismRows.find((row) => row.key === "regional-visitors")?.statusLabel === "설정 필요"
    && missingTourismSummary.missing === 1
    && missingTourismSummary.planned === 9
    && adminIntegrationContext.getAdminIntegrationSummaryLabel(missingTourismSummary).includes("1 확인")
    && adminIntegrationContext.getAdminIntegrationSummaryLabel(missingTourismSummary).includes("9 예정"),
  "admin API registry must keep missing configuration separate from planned integrations",
  failures
);

const expectedCacheVersion = "lodging-datalab-pwa-v20260901-collection-analysis-v99";
const expectedAssetVersion = "datalab-20260901-collection-analysis-v99";
const cacheVersionAssignment = serviceWorker.match(/^const CACHE_VERSION = "([^"]+)";$/m);
const assetVersionAssignments = [...server.matchAll(
  /^\s*\.replace\('(href|src)="\/(styles\.css|admin-theme\.css|app\.js)"', '\1="\/\2\?v=([^"]+)"'\);?$/gm
)].map((match) => ({ asset: match[2], version: match[3] }));

assert(
  cacheVersionAssignment?.[1] === expectedCacheVersion
    && /const APP_SHELL = \[[\s\S]*?"\/styles\.css"[\s\S]*?"\/admin-theme\.css"[\s\S]*?"\/app\.js"[\s\S]*?\];/.test(serviceWorker),
  "service worker CACHE_VERSION assignment and app shell must match the API registry release exactly",
  failures
);

assert(
  assetVersionAssignments.length === 3
    && assetVersionAssignments.map((entry) => entry.asset).join("|") === "styles.css|admin-theme.css|app.js"
    && assetVersionAssignments.every((entry) => entry.version === expectedAssetVersion),
  "server asset query assignments must version styles, theme, and app exactly and together",
  failures
);

assert(
  app.includes("function tourismVisitorOutlookCard()")
    && app.includes("function tourismVisitorTableValue(regionName = \"\")")
    && app.includes("function tourismVisitorHistoryChart(series = [], region = null)")
    && app.includes("function tourismVisitorHistoryEvidenceForLocation(card = {}, tourismMatch = {})")
    && app.includes("완전월 일평균 방문자")
    && app.includes("방문자 수요전망 보조점수")
    && app.includes("누락·부분수집 월은 0명으로 표시하지 않습니다")
    && app.includes('model?.eligible === true && status === "ready"')
    && app.includes('Number.isFinite(score) ? fmtNumber(score) : "자료 부족"')
    && app.includes("data-tourism-visitor-history-refresh")
    && server.includes("tourismCollector.collectVisitorCounts({")
    && server.includes("tourismCollector.collectVisitorHistory({")
    && server.includes('reqUrl.pathname === "/api/tourism-data/visitors/history"')
    && server.includes("tourismVisitorHistory,"),
  "regional visitor observations and 36-month history must remain source-labelled, non-synthetic demand evidence",
  failures
);

assert(
  styles.includes(".demand-source-note")
    && styles.includes(".b2b-demand-outlook-grid article.visitor")
    && styles.includes(".tourism-visitor-history-card")
    && styles.includes(".tourism-visitor-history-chart")
    && styles.includes(".tourism-visitor-history-point")
    && /grid-template-columns:\s*minmax\(130px, 1\.15fr\) \.72fr \.9fr \.7fr \.9fr \.62fr;/.test(styles),
  "regional visitor demand evidence and history chart must remain readable in cards and the comparison table",
  failures
);

assert(
  app.includes("function renderTourismDemandStrengthHistory()")
    && app.includes("function tourismDemandStrengthChart(series = [], kind = \"stay\"")
    && app.includes("function tourismDemandStrengthSeriesState(series = [], kind = \"stay\"")
    && app.includes("API 수집에 실패했습니다. 공식 무관측으로 처리하지 않습니다.")
    && app.includes("응답을 검증하지 못했습니다. 공식 무관측과 구분하여 재수집합니다.")
    && app.includes("data-tourism-demand-strength-refresh")
    && app.includes("결측값을 0으로 표시하지 않습니다")
    && app.includes("0점으로 표시하지 않습니다")
    && app.includes("지역 관광 기초지수")
    && server.includes("tourismCollector.collectDemandStrengthHistory({")
    && server.includes('reqUrl.pathname === "/api/tourism-data/demand-strength/history"')
    && server.includes("tourismDemandStrengthHistory,"),
  "tourism demand strength must remain a separate cache-backed stay and spend history contract",
  failures
);

const demandStrengthSeriesStateBlock = app.slice(
  app.indexOf("function tourismDemandStrengthSeriesState("),
  app.indexOf("function tourismDemandStrengthCoverage(")
);
const demandStrengthSeriesStateContext = {};
vm.runInNewContext(
  `${demandStrengthSeriesStateBlock}\nthis.classifyDemandStrengthSeries = tourismDemandStrengthSeriesState;`,
  demandStrengthSeriesStateContext
);
const classifyDemandStrengthSeries = demandStrengthSeriesStateContext.classifyDemandStrengthSeries;
assert(
  classifyDemandStrengthSeries([
    { yearMonth: "202605", status: "error", reason: "timeout", hasValue: false },
    { yearMonth: "202606", status: "unavailable", reason: "monthly_cache_missing", hasValue: false }
  ], "spend").valueLabel === "수집 실패"
    && classifyDemandStrengthSeries([
      { yearMonth: "202604", status: "complete", reason: "", hasValue: true, value: 51 },
      { yearMonth: "202605", status: "error", reason: "response_grain_mismatch", hasValue: false },
      { yearMonth: "202606", status: "unavailable", reason: "monthly_cache_missing", hasValue: false }
    ], "spend").valueLabel === "응답 확인 필요"
    && classifyDemandStrengthSeries([
      { yearMonth: "202604", status: "error", reason: "timeout", hasValue: false },
      { yearMonth: "202605", status: "complete", reason: "", hasValue: true, value: 52 },
      { yearMonth: "202606", status: "unavailable", reason: "monthly_cache_missing", hasValue: false }
    ], "spend").valueLabel === "수집 대기"
    && classifyDemandStrengthSeries([
      { yearMonth: "202606", status: "complete", reason: "", hasValue: true, value: 53 }
    ], "spend").valueLabel === "실제 관측"
    && classifyDemandStrengthSeries([
      { yearMonth: "202606", status: "missing", reason: "empty_verified", hasValue: false }
    ], "spend").valueLabel === "공공 API 응답 0건"
    && classifyDemandStrengthSeries([
      { yearMonth: "202606", status: "missing", reason: "no_observation", hasValue: false }
    ], "spend").valueLabel === "공공 API 제공 대기",
  "demand-strength cards must distinguish API failures, validation failures, pending cache, observations, and verified empty responses",
  failures
);

const demandStrengthSourceStatusBlock = app.slice(
  app.indexOf("function tourismDemandStrengthSourceStatusLabel("),
  app.indexOf("function tourismDemandStrengthCollectionLabel(")
);
const demandStrengthSourceStatusContext = {};
vm.runInNewContext(
  `${demandStrengthSourceStatusBlock}\nthis.classifyDemandStrengthSource = tourismDemandStrengthSourceStatusLabel;`,
  demandStrengthSourceStatusContext
);
const classifyDemandStrengthSource = demandStrengthSourceStatusContext.classifyDemandStrengthSource;
const observedComparison = {
  series: [
    { yearMonth: "202605", status: "complete", reason: "", hasValue: true, value: 53 },
    { yearMonth: "202606", status: "missing", reason: "no_observation", hasValue: false }
  ]
};
assert(
  classifyDemandStrengthSource({}, {}, { series: [{ reason: "no_observation", hasValue: false }] }, { series: [] }) === "공공 API 제공 대기"
    && classifyDemandStrengthSource({}, {}, { series: [{ reason: "empty_verified", hasValue: false }] }, { series: [] }) === "공공 API 응답 0건"
    && classifyDemandStrengthSource({}, {}, observedComparison, { series: [] }) === "기존 관측 유지 · 최신월 공공 API 제공 대기"
    && classifyDemandStrengthSource({}, {}, {
      series: [
        { yearMonth: "202605", status: "complete", reason: "", hasValue: true, value: 53 },
        { yearMonth: "202606", status: "missing", reason: "empty_verified", hasValue: false }
      ]
    }, { series: [] }) === "기존 관측 유지 · 최신월 공공 API 응답 0건"
    && classifyDemandStrengthSource({ reason: "monthly_cache_missing" }, {}, { series: [] }, { series: [] }) === "수집 대기",
  "demand-strength source status must separate provider pending, verified empty, retained history, and uncollected cache",
  failures
);

assert(
  styles.includes(".tourism-demand-strength-card")
    && styles.includes(".tourism-demand-strength-chart-grid")
    && styles.includes(".tourism-demand-strength-line")
    && styles.includes(".tourism-demand-strength-point")
    && styles.includes('html[data-theme-resolved="dark"] .tourism-demand-strength-card')
    && styles.includes("@media (max-width: 600px)"),
  "tourism demand strength cards and charts must remain readable across themes and mobile layouts",
  failures
);

assert(
  app.includes("state.tourismDataStatus?.demandStrengthBackfill")
    && app.includes("function renderTourismDemandStrengthBackfillStatus()")
    && app.includes("산청군을 먼저 확인한 뒤 전국 시군구의 최근 완료월 기준 12개월만 저장")
    && app.includes("data-tourism-demand-strength-backfill-run")
    && app.includes('fetchJson("/api/tourism-data/status")')
    && app.includes('fetchJson("/api/tourism-data/demand-strength/backfill/run"')
    && app.includes('body: JSON.stringify({ force: false })')
    && app.includes('priority_sancheong: "산청 우선 선수집"')
    && app.includes('recent_12: "전국 최근 12개월"')
    && app.includes('history_24: "최근 12개월 보강"')
    && app.includes("completedPairCount")
    && app.includes("todayUsedCalls")
    && app.includes("nextCheckAt")
    && app.includes("lastResultStatus")
    && app.includes("lastReason")
    && app.includes("tourismVisitorMonthLabel(backfill?.recoveryYearMonth)")
    && !app.includes("tourismDemandStrengthMonthLabel("),
  "admin demand-strength UI must show source-backed nationwide backfill progress and run only the bounded force-false continuation",
  failures
);

assert(
  app.includes("TOURISM_DEMAND_STRENGTH_BACKFILL_POLL_INTERVAL_MS = 10_000")
    && app.includes("TOURISM_DEMAND_STRENGTH_BACKFILL_POLL_MAX_MS = 10 * 60_000")
    && app.includes("function startTourismDemandStrengthBackfillPolling()")
    && app.includes("function stopTourismDemandStrengthBackfillPolling(")
    && app.includes('document.visibilityState !== "visible"')
    && app.includes("stopTourismDemandStrengthBackfillPolling({ render: false });")
    && app.includes("if (tourismDemandStrengthBackfillIsRunning()) startTourismDemandStrengthBackfillPolling();"),
  "demand-strength backfill status polling must be bounded, deduplicated, and stopped outside the active authenticated tab",
  failures
);

assert(
  styles.includes(".tourism-demand-strength-backfill")
    && styles.includes(".tourism-demand-strength-backfill-metrics")
    && styles.includes(".tourism-demand-strength-backfill-run:focus-visible")
    && /@media \(max-width: 600px\)[\s\S]*?\.tourism-demand-strength-backfill-metrics,[\s\S]*?grid-template-columns:\s*1fr/.test(styles),
  "demand-strength backfill status must remain legible and operable across themes and 390px layouts",
  failures
);

const locationProfileBlock = app.slice(
  app.indexOf("function administrativeRegionForLocationCard("),
  app.indexOf("function renderLocationDictionary(", app.indexOf("function administrativeRegionForLocationCard("))
);
const ensureLocationProfileBlock = app.slice(
  app.indexOf("async function ensureLocationProfile("),
  app.indexOf("function locationProfileFirstObject(")
);
const renderObservedLocationProfileBlock = app.slice(
  app.indexOf("function renderObservedLocationProfile("),
  app.indexOf("function administrativeProfileDefinitionRows(")
);
const tourismIndexUiBlock = app.slice(
  app.indexOf("const LOCATION_PROFILE_RESOURCE_DEMAND_SERIES"),
  app.indexOf("function renderLocationProfileSourcePanel(")
);
const tourismIndexRefreshBlock = app.slice(
  app.indexOf("async function refreshLocationTourismIndexHistory("),
  app.indexOf("function locationProfileObservedAt(")
);
const locationHistoryServerBlock = server.slice(
  server.indexOf("async function readTourismLocationHistoryCache("),
  server.indexOf("async function loadRun(", server.indexOf("async function readTourismLocationHistoryCache("))
);

assert(
  locationProfileBlock.includes('/api/tourism-data/location-history?regionKey=')
    && locationProfileBlock.includes("function locationProfileTrafficEvidence(")
    && locationProfileBlock.includes("function locationProfilePlaceEvidence(")
    && locationProfileBlock.includes("function locationProfileVisitorEvidence(")
    && locationProfileBlock.includes("function locationProfileStrengthEvidence(")
    && locationProfileBlock.includes("정확히 일치하는 DataLab 관측이 없습니다")
    && locationProfileBlock.includes("상세/재고 미관측")
    && locationProfileBlock.includes("부분수집·미관측은 선 단절")
    && locationProfileBlock.includes("기존 내부 입지판단 기준")
    && server.includes('reqUrl.pathname === "/api/tourism-data/location-history"'),
  "the common location profile must lead with exact source-backed evidence and keep missing observations non-zero",
  failures
);

assert(
  locationProfileBlock.includes("snapshot.axisLabel = snapshot.periodLabel;")
    && !locationProfileBlock.includes("snapshot.axisLabel = roles[index]")
    && locationProfileBlock.includes("12개월 누적 방문자 구간 비교")
    && locationProfileBlock.includes("각 점은 표시된 12개월 전체 누적값")
    && locationProfileBlock.includes("<h4>현재월 포함 최근 12개월</h4>")
    && locationProfileBlock.includes("현재월은 완전월 확정 전 자료 대기")
    && locationProfileBlock.includes("최근 확정월 기준 12개월 방문자")
    && locationProfileBlock.includes("조회 대상 ${visitor.period}")
    && locationProfileBlock.includes("function locationProfileRecentSeriesWindow(")
    && locationProfileBlock.includes("방문자 그래프 동일 기간 ${referencePeriodLabel}")
    && locationProfileBlock.includes("최근 완료월 기준 12개월")
    && locationProfileBlock.includes("referencePeriod: strengthReferencePeriod")
    && locationProfileBlock.includes('const textAnchor = points.length === 1 ? "middle" : index === 0 ? "start" : index === points.length - 1 ? "end" : "middle";'),
  "location graphs must distinguish rolling monthly periods, 12-month snapshot ranges, and requested strength windows",
  failures
);

assert(
  !app.includes("최근 3개년")
    && !app.includes("36개월 저장 이력 유지")
    && !/\bmonths\s*:\s*36\b/.test(app),
  "tourism UI and refresh requests must remain bounded to the latest 12 months",
  failures
);

const visitorMonthHelperBlock = app.slice(
  app.indexOf("function tourismVisitorYearMonth("),
  app.indexOf("function tourismVisitorHistoryRegionForName(")
);
const recentStrengthWindowBlock = app.slice(
  app.indexOf("function locationProfileRecentSeriesWindow("),
  app.indexOf("function renderLocationProfileStrengthPanel(")
);
const tourismIndexPeriodHelperBlock = app.slice(
  app.indexOf("function locationProfileTourismIndexPeriod("),
  app.indexOf("function locationProfileTourismIndexEvidence(")
);
const recentStrengthWindowSandbox = {};
vm.runInNewContext(
  `${visitorMonthHelperBlock}\n${recentStrengthWindowBlock}\nthis.locationProfileRecentSeriesWindow = locationProfileRecentSeriesWindow; this.locationProfileSeriesCoverage = locationProfileSeriesCoverage;`,
  recentStrengthWindowSandbox
);
const alignedStrengthSeries = recentStrengthWindowSandbox.locationProfileRecentSeriesWindow([
  { yearMonth: "202507", status: "complete", value: 51, hasValue: true },
  { yearMonth: "202606", status: "complete", value: 62, hasValue: true },
  { yearMonth: "202607", status: "complete", value: 63, hasValue: true }
], { startYearMonth: "202507", endYearMonth: "202606" }, 12);
const alignedStrengthCoverage = recentStrengthWindowSandbox.locationProfileSeriesCoverage(alignedStrengthSeries);
const fallbackStrengthSeries = recentStrengthWindowSandbox.locationProfileRecentSeriesWindow([
  { yearMonth: "202605", status: "complete", value: 61, hasValue: true },
  { yearMonth: "202606", status: "complete", value: 62, hasValue: true }
], null, 12);
const fallbackStrengthCoverage = recentStrengthWindowSandbox.locationProfileSeriesCoverage(fallbackStrengthSeries);
const apiPeriodSeries = recentStrengthWindowSandbox.locationProfileRecentSeriesWindow([
  { yearMonth: "202507", status: "complete", value: 50, hasValue: true },
  { yearMonth: "202508", status: "complete", value: 51, hasValue: true },
  { yearMonth: "202607", status: "complete", value: 63, hasValue: true },
  { yearMonth: "202608", status: "complete", value: 64, hasValue: true }
], { startYearMonth: "202508", endYearMonth: "202607" }, 12);
const apiPeriodCoverage = recentStrengthWindowSandbox.locationProfileSeriesCoverage(apiPeriodSeries);
const tourismIndexPeriodSandbox = {};
vm.runInNewContext(
  `${visitorMonthHelperBlock}\nfunction locationProfileFirstObject(...values) { return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || null; }\n${tourismIndexPeriodHelperBlock}\nthis.locationProfileTourismIndexPeriod = locationProfileTourismIndexPeriod;`,
  tourismIndexPeriodSandbox
);
const tourismIndexPeriod = tourismIndexPeriodSandbox.locationProfileTourismIndexPeriod({
  period: {
    startYearMonth: "202508",
    endYearMonth: "202607",
    latestClosedYearMonth: "202607",
    months: 12
  }
}, null, [
  { yearMonth: "202507" },
  { yearMonth: "202608" }
]);
assert(
  alignedStrengthSeries.length === 12
    && alignedStrengthSeries[0].yearMonth === "202507"
    && alignedStrengthSeries.at(-1).yearMonth === "202606"
    && alignedStrengthSeries.every((entry) => entry.yearMonth !== "202607")
    && alignedStrengthCoverage.expectedMonths === 12
    && alignedStrengthCoverage.completeMonths === 2
    && alignedStrengthCoverage.missingMonths === 10
    && fallbackStrengthSeries.length === 12
    && fallbackStrengthSeries[0].yearMonth === "202507"
    && fallbackStrengthSeries.at(-1).yearMonth === "202606"
    && fallbackStrengthCoverage.expectedMonths === 12
    && fallbackStrengthCoverage.completeMonths === 2
    && fallbackStrengthCoverage.missingMonths === 10
    && apiPeriodSeries.length === 12
    && apiPeriodSeries[0].yearMonth === "202508"
    && apiPeriodSeries.at(-1).yearMonth === "202607"
    && apiPeriodSeries.every((entry) => entry.yearMonth !== "202507" && entry.yearMonth !== "202608")
    && apiPeriodCoverage.completeMonths === 2
    && apiPeriodCoverage.missingMonths === 10
    && tourismIndexPeriod.startYearMonth === "202508"
    && tourismIndexPeriod.endYearMonth === "202607"
    && tourismIndexPeriod.latestClosedYearMonth === "202607"
    && tourismIndexPeriod.months === 12,
  "strength graphs must use the visitor period while tourism index graphs use each API period without filling missing observations as zero",
  failures
);

assert(
  locationProfileBlock.includes("실제 관측 · 체류 ${stayCoverage.completeMonths}/${expectedMonths}")
    && locationProfileBlock.includes('최근월 미수집')
    && styles.includes(".location-profile-strength .location-profile-chart")
    && styles.includes("min-width: 820px;"),
  "strength cards must distinguish partial 12-month coverage and keep monthly labels readable in a scrollable chart",
  failures
);

assert(
  styles.includes("Shared administrative location profile")
    && styles.includes(".location-profile-grid")
    && styles.includes(".location-profile-chart-line")
    && styles.includes(".location-profile-source-list")
    && styles.includes(".location-profile-internal")
    && /@media \(max-width: 600px\)[\s\S]*?\.location-profile-source-list > div\s*\{[\s\S]*?grid-template-columns:\s*1fr/.test(styles),
  "the common location profile must keep token-based cards, charts, sources, and mobile stacking",
  failures
);

assert(
  tourismIndexUiBlock.includes('{ key: "service", label: "서비스"')
    && tourismIndexUiBlock.includes('{ key: "culture", label: "문화"')
    && tourismIndexUiBlock.includes('{ key: "visitor", label: "관광객"')
    && tourismIndexUiBlock.includes('{ key: "spend", label: "소비"')
    && tourismIndexUiBlock.includes('{ key: "international", label: "국제"')
    && tourismIndexUiBlock.includes("entry?.values?.[spec.key] ?? operation?.overallValue")
    && tourismIndexUiBlock.includes("graphReady: observedPoints.length >= 8")
    && tourismIndexUiBlock.includes("legacySeries")
    && tourismIndexUiBlock.includes("const referencePeriod = evidence.periodRange")
    && tourismIndexUiBlock.includes("latestClosedYearMonth")
    && tourismIndexUiBlock.includes("최신 확정월")
    && tourismIndexUiBlock.includes("metric.hasValue && !metric.isOverall")
    && tourismIndexUiBlock.includes("function renderLocationProfileTourismIndexDetailRows(")
    && tourismIndexUiBlock.includes("const visible = rows.slice(0, 5)")
    && tourismIndexUiBlock.includes("const folded = rows.slice(5)")
    && tourismIndexUiBlock.includes('class="location-profile-index-detail-more"')
    && !renderObservedLocationProfileBlock.includes("tourismReferencePeriod")
    && styles.includes(".location-profile-index-series-grid")
    && styles.includes(".location-profile-index-detail-empty")
    && styles.includes(".location-profile-index-detail-more"),
  "resource-demand and diversity cards must use their own confirmed 12-month periods and fold observed detail metrics after five rows",
  failures
);

assert(
  tourismIndexRefreshBlock.includes('resourceDemand: "/api/tourism-data/resource-demand/history"')
    && tourismIndexRefreshBlock.includes('diversity: "/api/tourism-data/diversity/history"')
    && tourismIndexRefreshBlock.includes("JSON.stringify({ regionKey, months: 12 })")
    && tourismIndexRefreshBlock.includes("if (!isAdminRole()")
    && tourismIndexRefreshBlock.includes("await ensureLocationProfile(activeCard, { force: true })")
    && tourismIndexRefreshBlock.includes("공급기관 제공자료 없음"),
  "admin-only tourism index refresh must collect exactly 12 months and reload the cache-only location profile without treating provider gaps as request failures",
  failures
);

assert(
  !app.includes("SANCHEONG_LOCATION_REGION_KEY")
    && !app.includes("function isSancheongLocationCard(")
    && !app.includes("function renderSancheongLocationProfile(")
    && !ensureLocationProfileBlock.includes("isDefaultLocationCard(")
    && !ensureLocationProfileBlock.includes("kr_gyeongnam_sancheong")
    && ensureLocationProfileBlock.includes("if (!regionKey) return false;")
    && renderObservedLocationProfileBlock.includes("options.administrativeRegion || administrativeRegionForLocationCard(card)"),
  "location profile loading and rendering must not be gated to Sancheong",
  failures
);

assert(
  ensureLocationProfileBlock.includes("fetchJson(`/api/tourism-data/location-history?regionKey=${encodeURIComponent(regionKey)}`)")
    && ensureLocationProfileBlock.includes("forceRefreshCoolingDown")
    && ensureLocationProfileBlock.includes("existingAge < LOCATION_PROFILE_RETRY_INTERVAL_MS")
    && !ensureLocationProfileBlock.includes("/api/tourism-data/visitors/history")
    && !ensureLocationProfileBlock.includes("/api/tourism-data/demand-strength/history")
    && !ensureLocationProfileBlock.includes('method: "POST"')
    && locationHistoryServerBlock.includes("collectMissing: false")
    && locationHistoryServerBlock.includes("refresh: false")
    && locationHistoryServerBlock.includes("force: false")
    && locationHistoryServerBlock.includes('mode: "cache_only"')
    && locationHistoryServerBlock.includes("externalRequestsAttempted")
    && locationHistoryServerBlock.includes("외부 요청이 감지되었습니다"),
  "opening any location profile must remain a cache-only GET and must not call a tourism provider",
  failures
);

assert(
  indexHtml.includes('data-location-workspace')
    && indexHtml.includes('id="dictionaryProvinceSelect"')
    && indexHtml.includes('id="dictionaryQuickButtons"')
    && indexHtml.includes('class="dictionary-admin-operations"')
    && indexHtml.indexOf('id="dictionaryResult"') < indexHtml.indexOf('class="dictionary-admin-operations"')
    && indexHtml.includes('data-dictionary-view="dictionary"')
    && indexHtml.includes('data-dictionary-view="demand"')
    && indexHtml.includes('data-dictionary-view="compare"')
    && indexHtml.includes('data-dictionary-view="sources"'),
  "location dictionary must lead with search, province and region selection before collapsed admin operations",
  failures
);

assert(
  app.includes('dictionaryProvince: "경남"')
    && app.includes('dictionaryDetailTab: "basic"')
    && app.includes('data-location-region-item data-location-region-key=')
    && app.includes('function selectDictionaryProvince(')
    && app.includes('function selectDictionaryRegion(')
    && app.includes('const LOCATION_PROFILE_TABS = new Set(["basic", "tourism", "supply", "history"])')
    && app.includes('data-location-profile-tab=')
    && app.includes('data-location-profile-panel=')
    && app.includes('role="tabpanel"')
    && app.includes('" hidden"')
    && app.includes('state.dictionaryDetailTab = tab')
    && app.includes('state.dictionaryPendingRegion = card ? null : region'),
  "location dictionary must preserve exact province and region selection and expose four state-backed detail tabs",
  failures
);

const loadLocationDictionaryBlock = app.slice(
  app.indexOf("async function loadLocationDictionary()"),
  app.indexOf("async function loadLocationCardRequests()")
);
const dictionaryProvinceEntriesBlock = app.slice(
  app.indexOf("function dictionaryProvinceEntries()"),
  app.indexOf("function dictionaryProvinceForCard(")
);
const dictionaryRegionsForProvinceBlock = app.slice(
  app.indexOf("function dictionaryRegionsForProvince("),
  app.indexOf("function renderDictionaryProvinceSelect(")
);
const dictionaryStoredCardBlock = app.slice(
  app.indexOf("function dictionaryStoredCardForRegion("),
  app.indexOf("function dictionaryProvinceEntries()")
);
const locationQueryBlock = app.slice(
  app.indexOf("function locationCardForQuery("),
  app.indexOf("function locationCardRequestStatusMeta(")
);
const administrativeProfileBlock = app.slice(
  app.indexOf("function renderAdministrativeObservationPanel("),
  app.indexOf("function renderLocationDictionary(")
);
const selectDictionaryProvinceBlock = app.slice(
  app.indexOf("function selectDictionaryProvince("),
  app.indexOf("async function loadLocationDictionary()")
);
const renderLocationDictionaryBlock = app.slice(
  app.indexOf("function renderLocationDictionary("),
  app.indexOf("function runDictionarySearch(")
);
const dictionaryRegionButtonBlock = app.slice(
  app.indexOf("function dictionaryRegionButton("),
  app.indexOf("function renderDictionaryQuickButtons(")
);

assert(
  app.includes("regionMaster: null")
    && app.includes('const REGION_MASTER_URL = "/data/region_master.json";')
    && loadLocationDictionaryBlock.includes("fetchJson(REGION_MASTER_URL).catch(")
    && loadLocationDictionaryBlock.includes("state.regionMaster = regionMaster")
    && loadLocationDictionaryBlock.includes("state.tourismRegionMap = tourismRegionMap"),
  "location dictionary must load the administrative master independently and retain the tourism-provider map",
  failures
);

assert(
  app.includes("function administrativeRegionEntries()")
    && app.includes("function administrativeProvinceEntries()")
    && dictionaryProvinceEntriesBlock.includes("administrativeProvinceEntries()")
    && dictionaryRegionsForProvinceBlock.includes("administrativeRegionsForProvince(province)")
    && app.includes("function tourismRegionEntries()"),
  "province and local navigation must be master-first while KTO regions remain a separate provider crosswalk",
  failures
);

assert(
  dictionaryStoredCardBlock.includes("locationCardKey")
    && dictionaryStoredCardBlock.includes("providerMappings?.kto?.regionKey")
    && dictionaryStoredCardBlock.includes("region.regionKey"),
  "stored location cards must resolve through explicit master links before legacy region-key fallback",
  failures
);

assert(
  app.includes("function administrativeRegionForQuery(")
    && locationQueryBlock.includes("administrativeRegionForQuery(query)")
    && locationQueryBlock.includes('reason: "region-master"'),
  "location search must resolve an official master region before treating it as an unsaved candidate",
  failures
);

assert(
  administrativeProfileBlock.includes("function renderAdministrativeProvinceProfile(")
    && administrativeProfileBlock.includes("공식 행정구역 코드")
    && administrativeProfileBlock.includes("관측 없음")
    && administrativeProfileBlock.includes("미수집을 0으로 표시하지")
    && !administrativeProfileBlock.includes(">0명<")
    && !administrativeProfileBlock.includes(">0원<")
    && !administrativeProfileBlock.includes(">0%<"),
  "master-only province and region profiles must show official base facts and never synthesize missing observations as zero",
  failures
);

assert(
  selectDictionaryProvinceBlock.includes("administrativeProvinceForValue(nextValue)")
    && selectDictionaryProvinceBlock.includes("renderLocationDictionary({ province: administrativeProvince")
    && renderLocationDictionaryBlock.includes("result.province")
    && app.includes("data-location-province-master")
    && app.includes('const label = broad ? "광역 전체"'),
  "selecting a province must open its province master instead of silently opening the first saved local card",
  failures
);

assert(
  renderLocationDictionaryBlock.includes("administrativeProvinceEntries().length")
    && renderLocationDictionaryBlock.includes("administrativeRegionEntries().length")
    && renderLocationDictionaryBlock.includes("const storedCard = result.card || dictionaryStoredCardForRegion(administrativeRegion)")
    && renderLocationDictionaryBlock.includes("const card = storedCard || locationProfileSubjectForRegion(administrativeRegion)")
    && renderLocationDictionaryBlock.includes("const hasStoredCard = Boolean(storedCard)")
    && renderLocationDictionaryBlock.includes("renderObservedLocationProfile(")
    && renderLocationDictionaryBlock.includes("{ administrativeRegion, hasStoredCard }")
    && renderLocationDictionaryBlock.includes("renderMissingLocationCandidate(missingQuery, cards)")
    && !renderLocationDictionaryBlock.includes("저장형 입지판단 카드")
    && !renderLocationDictionaryBlock.includes("<h3>${escapeHtml(card.searchKeyword)}</h3>"),
  "stored and master-only local regions must share one observed profile while unknown queries retain the candidate workflow",
  failures
);

assert(
  renderObservedLocationProfileBlock.includes("administrativeRegion?.sido")
    && renderObservedLocationProfileBlock.includes("administrativeRegion?.sigungu")
    && renderObservedLocationProfileBlock.includes('<h3>${escapeHtml(`${shortSido} ${sigungu}`)}</h3>')
    && renderObservedLocationProfileBlock.includes("업종 분석 키워드")
    && renderObservedLocationProfileBlock.includes('industryKeyword || "업종 분석에서 별도 선택"')
    && renderObservedLocationProfileBlock.includes("지역명과 분리")
    && renderObservedLocationProfileBlock.includes("hasStoredCard ? renderLocationProfileInternalDictionary")
    && !renderObservedLocationProfileBlock.includes("<h3>${escapeHtml(card.searchKeyword)}</h3>"),
  "official administrative names must remain the profile title while lodging keywords stay in a separate field",
  failures
);

assert(
  dictionaryRegionButtonBlock.includes("tourismRegion?.codeStatus")
    && dictionaryRegionButtonBlock.includes("region.providerMappings?.kto?.status")
    && dictionaryRegionButtonBlock.includes("masterProviderStatus !== \"ready\"")
    && dictionaryRegionButtonBlock.includes('"코드대기"')
    && renderLocationDictionaryBlock.includes("administrativeRegion?.providerMappings?.kto?.status")
    && renderObservedLocationProfileBlock.includes("providerCodePending")
    && renderObservedLocationProfileBlock.includes("행정개편 코드 확인 대기")
    && renderObservedLocationProfileBlock.includes("관광코드 확인 대기")
    && renderObservedLocationProfileBlock.includes("공급기관 코드 확인 후 저장")
    && renderObservedLocationProfileBlock.includes("잘못된 값 저장 안 함")
    && renderObservedLocationProfileBlock.includes("providerMappingStatus !== \"ready\"")
    && renderObservedLocationProfileBlock.includes("const exactRegion = Boolean(providerCode && !providerCodePending)")
    && renderObservedLocationProfileBlock.includes("if (exactRegion) void ensureLocationProfile(card)")
    && renderObservedLocationProfileBlock.includes("const forecastReady = exactRegion && evidence.visitor.observed && evidence.strength.observed"),
  "provider-code-pending regions must be labelled and blocked from being treated as callable observations",
  failures
);

assert(
  styles.includes("Location dictionary workspace v2")
    && styles.includes(".location-dictionary-workspace")
    && styles.includes(".dictionary-region-item.active")
    && styles.includes(".location-profile-tabs button[aria-selected=\"true\"]")
    && styles.includes(".dictionary-admin-operations")
    && styles.includes("background: var(--surface-card)")
    && styles.includes("background: var(--surface-control)")
    && styles.includes("background: var(--surface-selected)")
    && /@media \(max-width: 900px\)[\s\S]*?\.location-dictionary-workspace\s*\{[\s\S]*?grid-template-columns:\s*1fr/.test(styles)
    && /@media \(max-width: 600px\)[\s\S]*?\.location-profile-definition-list > div\s*\{[\s\S]*?grid-template-columns:\s*1fr/.test(styles),
  "location dictionary workspace must use theme tokens and collapse cleanly for tablet and mobile",
  failures
);

const crawlFormMatch = indexHtml.match(/<form class="admin-card" id="crawlForm">([\s\S]*?)<\/form>/);
const crawlFormMarkup = crawlFormMatch?.[1] || "";
const purposeOptionsMarkup = crawlFormMarkup.match(/<div class="crawl-purpose-options">([\s\S]*?)<\/div>/)?.[1] || "";
const purposeButtons = [...crawlFormMarkup.matchAll(/data-collection-purpose="([^"]+)"/g)].map((match) => match[1]);
const ensureCrawlControlsBlock = app.slice(
  app.indexOf("function ensureCrawlControls()"),
  app.indexOf("function searchModeLabel", app.indexOf("function ensureCrawlControls()"))
);
const currentCrawlPayloadBlock = app.slice(
  app.indexOf("function currentCrawlFormPayload()"),
  app.indexOf("function selectedCrawlSpeedPresetKey", app.indexOf("function currentCrawlFormPayload()"))
);
const broadLodgingPolicyBlock = app.slice(
  app.indexOf("function syncBroadLodgingPurposePolicy("),
  app.indexOf("function updateCrawlSpeedPreview", app.indexOf("function syncBroadLodgingPurposePolicy("))
);
const updateCrawlSpeedPreviewBlock = app.slice(
  app.indexOf("function updateCrawlSpeedPreview()"),
  app.indexOf("function applyCrawlSpeedPreset", app.indexOf("function updateCrawlSpeedPreview()"))
);
const submitCrawlBlock = app.slice(
  app.indexOf("async function submitCrawl(event)"),
  app.indexOf("function bindEvents()", app.indexOf("async function submitCrawl(event)"))
);
const broadPolicyBindEventsBlock = app.slice(app.indexOf("function bindEvents()"));

assert(
  submitCrawlBlock.includes('if (completedRecrawlContext?.source === "admin_db_detail")')
    && /if \(completedRecrawlContext\?\.source === "admin_db_detail"\)[\s\S]*?\} else \{\s*setActiveTab\("rank"\);\s*\}/.test(submitCrawlBlock),
  "completed administrator collection must open the newly classified current-run analysis instead of the industry briefing",
  failures
);

assert(
  crawlFormMarkup.includes('<h3 id="crawlKeywordHeading">키워드</h3>') && !crawlFormMarkup.includes("새 수집"),
  "collection form must use keyword as the heading without the old new-collection title",
  failures
);

assert(
  /id="keywordInput"[^>]*placeholder="예: 경남 숙소"[^>]*required/.test(crawlFormMarkup)
    && !/id="keywordInput"[^>]*\bvalue=/.test(crawlFormMarkup)
    && /id="keywordInput"[^>]*autocomplete="off"[^>]*autocorrect="off"[^>]*spellcheck="false"/.test(crawlFormMarkup)
    && /<span id="crawlPurposeHint" role="status" aria-live="polite">[^<]+<\/span>/.test(crawlFormMarkup)
    && (crawlFormMarkup.match(/aria-describedby="crawlPurposeHint"/g) || []).length === 2,
  "collection form must start with a blank non-restored keyword and expose its automatic policy hint",
  failures
);

assert(
  /id="searchModeInput" type="hidden" value="keyword"/.test(crawlFormMarkup)
    && /id="productModeInput" type="hidden" value="all"/.test(crawlFormMarkup)
    && ensureCrawlControlsBlock.includes('modeInput.type = "hidden"')
    && !ensureCrawlControlsBlock.includes("<select"),
  "collection mode and product scope must stay hidden while preserving internal values",
  failures
);

assert(
  crawlFormMarkup.includes("<span>시작일</span>")
    && crawlFormMarkup.includes("<span>종료일</span>")
    && !crawlFormMarkup.includes("<span>체크인</span>"),
  "collection date labels must read start and end date",
  failures
);

assert(
  purposeButtons.length === 2
    && purposeButtons[0] === "basic_db"
    && purposeButtons[1] === "revenue_detail"
    && !crawlFormMarkup.includes('data-collection-purpose="demand_location"')
    && !crawlFormMarkup.includes("crawlPurposeRoutePreview")
    && !/<(?:span|em)\b/.test(purposeOptionsMarkup),
  "collection form must expose only the two simplified collection purposes",
  failures
);

assert(
  /id="collectionPurposeInput" type="hidden" value="basic_db"/.test(crawlFormMarkup)
    && /id="detailRankEndInput"[^>]*value="40"/.test(crawlFormMarkup)
    && !/id="detailRankEndInput"[^>]*\bmax=/.test(crawlFormMarkup)
    && /id="detailRankRangesInput" type="hidden" value="1-40"/.test(crawlFormMarkup),
  "basic collection must start at 1-40 without treating the default as an input cap",
  failures
);

assert(
  /basic_db:\s*\{[\s\S]*?defaultRange:\s*"1-40"/.test(app)
    && /revenue_detail:\s*\{[\s\S]*?defaultRange:\s*"1-20"/.test(app)
    && currentCrawlPayloadBlock.includes('productMode: "all"'),
  "client collection defaults must be basic 1-40, detail 1-20, and all products",
  failures
);

assert(
  app.includes("function regionalLodgingSearchIntent(value)")
    && app.includes("function syncBroadLodgingPurposePolicy(options = {})")
    && broadLodgingPolicyBlock.includes('els.detailRankEndInput.disabled = false')
    && broadLodgingPolicyBlock.includes('collectionPurposeDefaultRange("basic_db")')
    && !broadLodgingPolicyBlock.includes('setDetailRankRange("1-40", "basic_db")')
    && broadLodgingPolicyBlock.includes('button.disabled = blocked')
    && broadLodgingPolicyBlock.includes('button.classList.toggle("active"')
    && broadLodgingPolicyBlock.includes('button.setAttribute("aria-pressed"')
    && broadLodgingPolicyBlock.includes('전체 숙박은 기본정보로 수집합니다. 종료 순위는 직접 조절할 수 있습니다. 상세정보는 경남 펜션처럼 업종을 지정하세요.')
    && app.includes('숙박 또는 숙소 앞에 지역명을 함께 입력하세요. 예: 경남 숙소'),
  "regional lodging keywords must be interpreted automatically and broad lodging must use the safe basic-information path",
  failures
);

assert(
  updateCrawlSpeedPreviewBlock.includes("syncBroadLodgingPurposePolicy();")
    && submitCrawlBlock.includes("syncBroadLodgingPurposePolicy();")
    && /els\.keywordInput\?\.addEventListener\(eventName,[\s\S]*?syncBroadLodgingPurposePolicy\(\{ resetRangeOnEntry: true \}\);/.test(broadPolicyBindEventsBlock),
  "broad lodging policy must run for keyword edits, previews, and final submission",
  failures
);

assert(
  /\.crawl-purpose-options\s*\{[^}]*grid-template-columns:\s*repeat\(2,/i.test(styles)
    && /\.crawl-rank-range-control\s*\{[^}]*grid-template-columns:/i.test(styles),
  "collection purpose buttons and editable rank range must keep the simplified responsive layout",
  failures
);

assert(
  /if \(purpose === "basic_db"\) return "1-40";[\s\S]*?return "1-20";/.test(server)
    && /if \(purpose === "basic_db"\) return "1-40";[\s\S]*?return "1-20";/.test(crawler)
    && server.includes("NAVER_BOOKING_STOCK_LIMIT: String(plan.bookingStockPlaceLimit)")
    && crawler.includes("NAVER_BOOKING_STOCK_LIMIT > 0 ? NAVER_BOOKING_STOCK_LIMIT : 20")
    && crawler.includes("const items = [...nightItems, ...unknownItems];")
    && !server.includes("items: items.slice(0, 40)")
    && !/\.sort\(\(a, b\) => Number\(a\.rank \|\| 9999\) - Number\(b\.rank \|\| 9999\)\)\s*\.slice\(0, 50\)/.test(server),
  "server and crawler must preserve administrator-selected ranges through the stored result boundary",
  failures
);

const databasePanelStart = indexHtml.indexOf('data-admin-section-panel="database"');
const overviewPanelStart = indexHtml.indexOf('data-admin-section-panel="overview"', databasePanelStart);
const collectPanelStart = indexHtml.indexOf('data-admin-section-panel="collect"');
const archivePanelStart = indexHtml.indexOf('data-admin-section-panel="archive"', collectPanelStart);
const databasePanelMarkup = indexHtml.slice(databasePanelStart, overviewPanelStart);
const collectPanelMarkup = indexHtml.slice(collectPanelStart, archivePanelStart);
const runResultCardStart = collectPanelMarkup.indexOf('id="runResultAdminCard"');
const runResultCardMarkup = runResultCardStart >= 0 ? collectPanelMarkup.slice(runResultCardStart) : "";
const rankActionStart = collectPanelMarkup.indexOf('class="crawl-rank-action-row"');
const rankActionMarkup = rankActionStart >= 0
  ? collectPanelMarkup.slice(rankActionStart, collectPanelMarkup.indexOf('id="detailRankRangesInput"', rankActionStart))
  : "";
const crawlKeywordCssStart = styles.indexOf(".crawl-keyword-bar {");
const crawlKeywordCssBlock = crawlKeywordCssStart >= 0
  ? styles.slice(crawlKeywordCssStart, styles.indexOf("\n.field {", crawlKeywordCssStart))
  : "";
const runResultDisclosureCssStart = styles.indexOf(".run-result-admin-card {");
const runResultDisclosureCssBlock = runResultDisclosureCssStart >= 0
  ? styles.slice(runResultDisclosureCssStart, styles.indexOf("\n.run-apply-summary {", runResultDisclosureCssStart))
  : "";
const rankActionCssStart = styles.indexOf(".crawl-rank-action-row {");
const rankActionCssBlock = rankActionCssStart >= 0
  ? styles.slice(rankActionCssStart, styles.indexOf("\n.crawl-speed-panel {", rankActionCssStart))
  : "";
const crawlSubmitCssStart = styles.indexOf(".crawl-submit-row {");
const crawlSubmitCssBlock = crawlSubmitCssStart >= 0
  ? styles.slice(crawlSubmitCssStart, styles.indexOf("\n@keyframes crawl-spin", crawlSubmitCssStart))
  : "";
const recentResultEntryBlock = app.slice(
  app.indexOf("function closeRecentResultDisclosureForFreshEntry()"),
  app.indexOf("function ensureLatestCollectionResult", app.indexOf("function closeRecentResultDisclosureForFreshEntry()"))
);
const receiptEntityBlock = app.slice(
  app.indexOf("function runResultCanonicalEntityMap("),
  app.indexOf("function runResultReceiptModel(", app.indexOf("function runResultCanonicalEntityMap("))
);
const receiptPreferredRankBlock = app.slice(
  app.indexOf("function runResultPreferredRank("),
  app.indexOf("function runResultReceiptModel(", app.indexOf("function runResultPreferredRank("))
);
const receiptModelBlock = app.slice(
  app.indexOf("function runResultReceiptModel("),
  app.indexOf("function collectionRouteRunCount", app.indexOf("function runResultReceiptModel("))
);
const receiptRendererBlock = app.slice(
  app.indexOf("function renderRunResultApplySummary()"),
  app.indexOf("function updateCrawlSpeedPreview", app.indexOf("function renderRunResultApplySummary()"))
);
const receiptQueueRendererBlock = app.slice(
  app.indexOf("function runResultReviewQueueHtml("),
  app.indexOf("function renderRunResultApplySummary()", app.indexOf("function runResultReviewQueueHtml("))
);
const receiptCssBlock = styles.slice(
  styles.indexOf(".run-apply-summary"),
  styles.indexOf("body.role-admin .crawl-purpose-panel", styles.indexOf(".run-apply-summary"))
);
const loadRunsBlock = app.slice(
  app.indexOf("async function loadRuns("),
  app.indexOf("async function loadRun(", app.indexOf("async function loadRuns("))
);
const bindEventsBlock = app.slice(app.indexOf("function bindEvents()"));
const runDbUniqueNameBlock = app.slice(
  app.indexOf("function runDbApplyUniqueNameFallbacks("),
  app.indexOf("function rowMatchesRunApply(", app.indexOf("function runDbApplyUniqueNameFallbacks("))
);

assert(
  runResultCardMarkup.includes("최근 수집 결과")
    && /<details class="admin-card run-result-admin-card" id="runResultAdminCard">/.test(collectPanelMarkup)
    && runResultCardMarkup.includes('class="run-result-admin-summary"')
    && runResultCardMarkup.includes('id="runResultAdminTitle"')
    && runResultCardMarkup.includes('id="runResultAdminMeta"')
    && runResultCardMarkup.includes('id="runApplySummary"')
    && runResultCardMarkup.includes("결과 보기")
    && runResultCardMarkup.includes("접기")
    && !runResultCardMarkup.includes('id="runSelect"')
    && !runResultCardMarkup.includes('id="refreshRuns"'),
  "collection result card must default to a compact native disclosure without duplicate history controls",
  failures
);

assert(
  collectPanelMarkup.includes('class="crawl-keyword-bar"')
    && collectPanelMarkup.includes('id="crawlKeywordHeading"')
    && collectPanelMarkup.includes('id="keywordInput"')
    && styles.includes(".admin-stack-collect {\n  grid-template-columns: minmax(0, 1fr)")
    && crawlKeywordCssBlock.includes("grid-template-columns: minmax(62px, 86px) minmax(0, 1fr)")
    && crawlKeywordCssBlock.includes("width: min(100%, 298px)")
    && crawlKeywordCssBlock.includes("width: 226px")
    && crawlKeywordCssBlock.includes("height: 54px")
    && crawlKeywordCssBlock.includes("@media (max-width: 860px)")
    && crawlKeywordCssBlock.includes("height: 58px"),
  "collection keyword title and input must share a responsive horizontal row at the main-menu heights",
  failures
);

assert(
  rankActionMarkup.includes('class="field crawl-rank-range-field"')
    && rankActionMarkup.includes('id="detailRankEndInput"')
    && rankActionMarkup.includes('class="crawl-submit-row"')
    && rankActionMarkup.includes('<button class="primary-button" type="submit">수집 실행</button>')
    && rankActionMarkup.includes('id="crawlSubmitMeta"')
    && rankActionMarkup.indexOf('id="detailRankEndInput"') < rankActionMarkup.indexOf('type="submit"')
    && rankActionCssBlock.includes("width: min(100%, 508px)")
    && rankActionCssBlock.includes("grid-template-columns: minmax(190px, 280px) minmax(160px, 220px)")
    && crawlSubmitCssBlock.includes("grid-template-rows: minmax(44px, 1fr) auto")
    && crawlSubmitCssBlock.includes("@media (max-width: 600px)")
    && crawlSubmitCssBlock.includes("@media (max-width: 360px)")
    && themeStyles.includes(".crawl-submit-row,"),
  "collection rank range and submit card must share one responsive action row without changing form behavior",
  failures
);

assert(
  recentResultEntryBlock.includes("els.runResultAdminCard.open = false")
    && bindEventsBlock.includes('els.runResultAdminCard?.querySelector(":scope > summary")?.addEventListener("keydown"')
    && bindEventsBlock.includes("els.runResultAdminCard.open = !els.runResultAdminCard.open")
    && runResultDisclosureCssBlock.includes("min-height: 54px")
    && runResultDisclosureCssBlock.includes("grid-template-columns: minmax(0, 1fr) auto")
    && runResultDisclosureCssBlock.includes("@media (max-width: 760px)")
    && runResultDisclosureCssBlock.includes("min-height: 58px"),
  "recent collection result must return to its compact closed state on each fresh collection entry",
  failures
);

assert(
  receiptRendererBlock.includes('class="run-result-receipt"')
    && receiptRendererBlock.includes('class="run-result-receipt-kpis"')
    && receiptRendererBlock.includes('class="run-result-receipt-exception"')
    && receiptRendererBlock.includes("data-open-run-review-queue")
    && receiptRendererBlock.includes('data-admin-db-status-link="needs_work"')
    && receiptRendererBlock.includes("data-admin-db-reset-filters")
    && receiptRendererBlock.includes("data-open-place-rank-replay")
    && receiptRendererBlock.includes("data-open-collection-archive")
    && receiptRendererBlock.includes("data-open-collection-run")
    && receiptRendererBlock.includes("이번 수집 검수대상")
    && receiptRendererBlock.includes("전체 DB 검수큐")
    && receiptRendererBlock.includes("runResultReviewQueueHtml(receipt.reviewRows)")
    && receiptQueueRendererBlock.includes('id="runResultReviewQueue"')
    && receiptQueueRendererBlock.includes("reviewRows.map")
    && receiptQueueRendererBlock.includes("이 업체 검수")
    && receiptQueueRendererBlock.includes("data-open-run-review-company")
    && bindEventsBlock.includes('event.target.closest("[data-open-run-review-queue]")')
    && bindEventsBlock.includes("reviewQueue.open = true")
    && bindEventsBlock.includes('event.target.closest("[data-open-run-review-company]")')
    && bindEventsBlock.includes('setAdminPanelSection("database")')
    && bindEventsBlock.includes('drawerTab.hasAttribute("data-admin-db-reset-filters")')
    && bindEventsBlock.includes("clearAdminDbCompanyHash();")
    && bindEventsBlock.includes('state.adminDbSelectedCompanyId = "";')
    && receiptCssBlock.includes(".run-result-review-queue-list")
    && !receiptRendererBlock.includes('class="run-result-receipt" data-ui-surface="card"')
    && !receiptRendererBlock.includes("placeRankComparisonSummaryHtml"),
  "collection receipt must keep this-run review rows in the collection screen and separate the reset global DB queue route",
  failures
);

assert(
  receiptModelBlock.includes('label: "발견 업체"')
    && receiptModelBlock.includes('label: "DB 반영"')
    && receiptModelBlock.includes('label: "확인 업체"')
    && receiptModelBlock.includes('label: "판매율 산출"')
    && receiptModelBlock.includes('label: "확인 필요"')
    && receiptModelBlock.includes('`요청 ${fmtNumber(requestedRankCount)}곳 · 실제 ${fmtNumber(observedRankCount)}곳 확인`')
    && receiptModelBlock.includes("rankInSegments")
    && receiptModelBlock.includes("const reviewEntryMap = new Map()")
    && receiptModelBlock.includes("reviewRows,"),
  "collection receipt must expose the agreed KPIs and distinguish the requested range from actual Naver observations",
  failures
);

assert(
  receiptEntityBlock.includes("function runResultCanonicalEntityMap(")
    && receiptEntityBlock.includes("company.placeIds")
    && receiptEntityBlock.includes("company.bookingBusinessIds")
    && receiptEntityBlock.includes("canonicalMap.has")
    && receiptModelBlock.includes("const canonicalEntityMap")
    && receiptModelBlock.includes("canonicalEntityMap)")
    && receiptModelBlock.includes("const observedRankByKey = new Map(")
    && receiptModelBlock.includes("runResultCurrentRank(item, observedRankByKey.get(key), metrics.rank, index + 1)")
    && receiptModelBlock.includes("const channelOnlyIssueCount")
    && receiptModelBlock.includes('salesStats(item, "day")')
    && receiptModelBlock.includes("runResultPreferredRank(detail.rank, existing.rank)")
    && app.includes("match.names = runDbApplyUniqueNameFallbacks(allRows, match.names)"),
  "collection receipt must deduplicate by stable IDs, keep issue totals disjoint, and count day-use sales rates",
  failures
);

const reviewQueueMatchSandbox = {
  compactSearchText(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }
};
vm.createContext(reviewQueueMatchSandbox);
vm.runInContext(
  `${receiptPreferredRankBlock}\n${runDbUniqueNameBlock}\nthis.runResultPreferredRank = runResultPreferredRank;\nthis.runResultCurrentRank = runResultCurrentRank;\nthis.runDbApplyUniqueNameFallbacks = runDbApplyUniqueNameFallbacks;`,
  reviewQueueMatchSandbox
);
const uniqueRunNames = reviewQueueMatchSandbox.runDbApplyUniqueNameFallbacks([
  { company: { companyId: "same-1", primaryName: "같은 글램핑", aliases: [] } },
  { company: { companyId: "same-2", primaryName: "다른 상호", aliases: ["같은글램핑"] } },
  { company: { companyId: "unique-1", primaryName: "고유 캠프", aliases: ["고유캠프"] } }
], new Set(["같은글램핑", "고유캠프"]));
assert(
  reviewQueueMatchSandbox.runResultPreferredRank(null, 7) === 7
    && reviewQueueMatchSandbox.runResultPreferredRank(0, 7) === 7
    && reviewQueueMatchSandbox.runResultPreferredRank(3, 7) === 7
    && reviewQueueMatchSandbox.runResultPreferredRank(3, 0) === 3
    && reviewQueueMatchSandbox.runResultPreferredRank(undefined, undefined) === 0
    && reviewQueueMatchSandbox.runResultCurrentRank({ overallRank: 18 }, 0, 3, 1) === 18
    && reviewQueueMatchSandbox.runResultCurrentRank({}, 18, 3, 1) === 18
    && reviewQueueMatchSandbox.runResultCurrentRank({}, 0, 3, 1) === 3
    && uniqueRunNames.has("고유캠프")
    && !uniqueRunNames.has("같은글램핑"),
  "review queue merging must preserve a valid Place rank and reject ambiguous duplicate-name DB fallbacks",
  failures
);

assert(
  /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(receiptCssBlock)
    && /@media \(max-width:\s*560px\)[\s\S]*?\.run-result-receipt-kpis\s*\{[\s\S]*?grid-template-columns:\s*1fr/.test(receiptCssBlock)
    && receiptCssBlock.includes("cursor: default")
    && !/\.run-apply-empty,\s*\.run-result-receipt\s*\{[^}]*\b(?:border|background|box-shadow):/i.test(receiptCssBlock)
    && !/rgba\(|linear-gradient/.test(receiptCssBlock),
  "collection receipt must use a flat static token-based three-column layout with a one-column mobile fallback",
  failures
);

assert(
  /\.secondary-button,\s*\.ghost-button,\s*\.small-button,/.test(themeStyles)
    && themeStyles.includes("body.role-admin .admin-files-collapsible summary::after")
    && !themeStyles.includes(".run-result-receipt-exception,"),
  "moved OTA controls and receipt status rails must keep global theme tokens without scoped navy overrides",
  failures
);

assert(
  !/(run-purpose-result|run-apply-grid|run-apply-linked|run-apply-panel|run-apply-check)/.test(`${app}\n${styles}\n${themeStyles}`),
  "removed collection-result layers must not remain as legacy rendering or theme rules",
  failures
);

assert(
  databasePanelMarkup.includes('id="yeogiAdminCard"')
    && databasePanelMarkup.includes("OTA 보조 도구")
    && databasePanelMarkup.includes('id="yeogiAdminCard" data-ui-surface="card" hidden aria-hidden="true"')
    && databasePanelMarkup.includes('id="companyMasterAdminCard" data-ui-surface="card" hidden aria-hidden="true"')
    && !collectPanelMarkup.includes('id="yeogiAdminCard"')
    && !app.includes('{ label: "OTA 수집"')
    && !app.includes('{ label: "OTA 보조 도구", tab: "admin", adminPanelSection: "database", anchor: "#yeogiAdminCard" }')
    && !app.includes('{ label: "업체 기준값", tab: "admin", adminPanelSection: "database", anchor: "#companyMasterAdminCard" }'),
  "OTA batch tooling may remain available internally but must not compete with company and region DB navigation",
  failures
);

const desktopSecondaryNavBlock = app.slice(
  app.indexOf("function syncAdminDesktopSecondaryNav()"),
  app.indexOf("function syncB2BRegionSecondaryNav()")
);
const mobileSecondaryNavBlock = app.slice(
  app.indexOf("function syncAdminMobileNav()"),
  app.indexOf("let latestCollectionResultPromise")
);
const adminPanelSectionBlock = app.slice(
  app.indexOf("function setAdminPanelSection("),
  app.indexOf("function syncAdminSectionPanels()")
);

assert(
  app.includes("function resetCollectionKeywordForFreshEntry()")
    && app.includes('els.keywordInput.value = "";')
    && app.includes('els.keywordInput.defaultValue = "";')
    && adminPanelSectionBlock.includes('sectionKey === "collect" && options.freshEntry === true')
    && app.includes('setAdminPanelSection("collect", { freshEntry: true });')
    && app.includes('{ scroll: true, freshEntry: section === "collect" }'),
  "fresh collection navigation must clear the keyword while programmatic recrawl navigation can preserve its assigned keyword",
  failures
);

assert(
  app.includes("function adminSectionAllowsAnchor(")
    && app.includes("function adminAnchorAllowedForState(")
    && desktopSecondaryNavBlock.includes("(!item.anchor || item.anchor === state.adminMobileAnchor)")
    && mobileSecondaryNavBlock.includes("(!item.anchor || item.anchor === state.adminMobileAnchor)")
    && desktopSecondaryNavBlock.includes('aria-pressed="${active ? "true" : "false"}"')
    && mobileSecondaryNavBlock.includes('aria-pressed="${active ? "true" : "false"}"')
    && mobileSecondaryNavBlock.includes("scrollAdminMobileAnchor(requestedAnchor)")
    && adminPanelSectionBlock.includes("adminAnchorAllowedForState(state.adminMobileAnchor, compactSection)"),
  "admin secondary navigation must preserve explicit anchors and expose only the clicked destination as active",
  failures
);

assert(
  loadRunsBlock.includes("if (els.runSelect)")
    && bindEventsBlock.includes('els.runSelect?.addEventListener("change"')
    && bindEventsBlock.includes('els.refreshRuns?.addEventListener("click"')
    && app.includes("function ensureLatestCollectionResult(options = {})")
    && app.includes("const forceLatestRequest = options.force === true;")
    && app.includes("retryStaleLoad = result === null;")
    && app.includes("if (!retryStaleLoad) return;")
    && app.includes("ensureLatestCollectionResult({ force: true });")
    && app.includes('if (sectionKey === "collect")')
    && app.includes("ensureLatestCollectionResult();")
    && app.includes("let loadRunRequestSequence = 0;")
    && app.includes("if (requestSequence !== loadRunRequestSequence) return null;")
    && server.includes("function runCollectedAt(")
    && crawler.includes("collectedAt: new Date().toISOString()")
    && server.includes("const collectedAt = runCollectedAt(runId, manifest || {}, stat);")
    && server.includes("String(b.collectedAt || \"\").localeCompare(String(a.collectedAt || \"\"))"),
  "removing result selectors must remain runtime-safe and collection entry must restore the latest run",
  failures
);

assert(
  app.includes("function yeogiTargetRun()")
    && app.includes("const targetRunId = String(targetRun?.id || \"\").trim();")
    && app.includes("adminDbChannelStatusLinked(exposure?.status)")
    && app.includes("const channelReviewNeeded = Number(metrics.channels?.reviewNeeded || 0) > 0;")
    && server.includes("async function applyYeogiImportToCompanyMaster(")
    && server.includes('method: "yeogi_bulk_import"'),
  "OTA tools must target the explicit latest run, expose only confirmed links, and persist matched Yeogi evidence to company review data",
  failures
);

const adminDbCompanyRowBlock = app.slice(
  app.indexOf("function adminDbCompanyRow("),
  app.indexOf("function adminDbRegionGroup(", app.indexOf("function adminDbCompanyRow("))
);
const adminDbAutocompleteBlock = app.slice(
  app.indexOf("function adminDbAutocompleteSuggestions("),
  app.indexOf("function adminDbCompanyAutocompleteHtml(", app.indexOf("function adminDbAutocompleteSuggestions("))
);
const adminDbAutocompleteCssBlock = styles.slice(
  styles.indexOf(".admin-db-autocomplete {"),
  styles.indexOf(".admin-db-company-filter {", styles.indexOf(".admin-db-autocomplete {"))
);
const adminDbFilterGridCssBlock = styles.slice(
  styles.indexOf(".admin-db-company-filter-grid {"),
  styles.indexOf('.admin-db-company-filter:not([open]) > .admin-db-company-filter-grid', styles.indexOf(".admin-db-company-filter-grid {"))
);
const adminDbSearchShellBlock = app.slice(
  app.indexOf("function adminDbCompanySearchShellHtml("),
  app.indexOf("function adminDbCompanyExplorerHtml(", app.indexOf("function adminDbCompanySearchShellHtml("))
);
const adminDbExplorerBlock = app.slice(
  app.indexOf("function adminDbCompanyExplorerHtml("),
  app.indexOf("function adminDbMetricCard(", app.indexOf("function adminDbCompanyExplorerHtml("))
);
const adminDbRenderBlock = app.slice(
  app.indexOf("function renderAdminDatabaseDashboard("),
  app.indexOf("function adminConsoleKpis(", app.indexOf("function renderAdminDatabaseDashboard("))
);
const adminDbQueryRenderBlock = app.slice(
  app.indexOf("function commitAdminDbQueryRender("),
  app.indexOf("function commitAdminRegionCompanyQueryRender(", app.indexOf("function commitAdminDbQueryRender("))
);
const adminDbNativeLinkBlock = app.slice(
  app.indexOf("function adminDbCompanyUseNativeLink("),
  app.indexOf("function setAdminDbCompanyRoute(", app.indexOf("function adminDbCompanyUseNativeLink("))
);
const adminDbBindEventsBlock = app.slice(app.indexOf("function bindEvents()"));
const adminDbExplorerCssBlock = styles.slice(styles.indexOf("/* Company DB explorer v1:"));
const adminDbDetailBlock = app.slice(
  app.indexOf("function adminDbSelectedDetailPanel("),
  app.indexOf("function adminDbCompanyRow(", app.indexOf("function adminDbSelectedDetailPanel("))
);
const adminDbOverviewBlock = app.slice(
  app.indexOf("function adminDbSelectedOverviewCardsHtml("),
  app.indexOf("function adminDbSelectedDetailTabs(", app.indexOf("function adminDbSelectedOverviewCardsHtml("))
);
const inlineRecrawlBlock = app.slice(
  app.indexOf("function applyQueueRecrawlSetting("),
  app.indexOf("function applyRecrawlBatchSetting(", app.indexOf("function applyQueueRecrawlSetting("))
);
const adminCompanyChartBlock = app.slice(
  app.indexOf("function adminDbChartSafeId("),
  app.indexOf("function adminDbInlineCollectionHtml(", app.indexOf("function adminDbChartSafeId("))
);
const cumulativeDashboardModelBlock = app.slice(
  app.indexOf("function adminDbCumulativeDashboardModel("),
  app.indexOf("function adminDbCumulativeKpiStripHtml(", app.indexOf("function adminDbCumulativeDashboardModel("))
);
const cumulativeDashboardBlock = app.slice(
  app.indexOf("function adminDbCompanyCumulativeDashboardHtml("),
  app.indexOf("function adminDbInlineCollectionHtml(", app.indexOf("function adminDbCompanyCumulativeDashboardHtml("))
);
const referenceDashboardBlock = app.slice(
  app.indexOf("function adminDbCompanyReferenceDashboardHtml("),
  app.indexOf("function adminDbInlineCollectionHtml(", app.indexOf("function adminDbCompanyReferenceDashboardHtml("))
);
const referenceObservedInventoryBasisBlock = app.slice(
  app.indexOf("function adminDbReferenceObservedInventoryBasis("),
  app.indexOf("function adminDbReferenceObservedInventoryLabel(", app.indexOf("function adminDbReferenceObservedInventoryBasis("))
);
const referenceObservedInventoryLabelBlock = app.slice(
  app.indexOf("function adminDbReferenceObservedInventoryLabel("),
  app.indexOf("function adminDbReferenceLegacyProductPreviewHtml(", app.indexOf("function adminDbReferenceObservedInventoryLabel("))
);
const companyCorrectionFormBlock = app.slice(
  app.indexOf("function companyCorrectionFormHtml("),
  app.indexOf("function companyManualFeedbackHtml(", app.indexOf("function companyCorrectionFormHtml("))
);
const collectedCorrectionBlock = app.slice(
  app.indexOf("function adminDbCorrectionProductType("),
  app.indexOf("function adminDbProductPriceRange(", app.indexOf("function adminDbCorrectionProductType("))
);
const collectedCorrectionCssBlock = styles.slice(
  styles.indexOf(".admin-db-collected-correction {"),
  styles.indexOf(".admin-db-quick-edit > .admin-db-correction-flash", styles.indexOf(".admin-db-collected-correction {"))
);
const referenceBasicsCardBlock = app.slice(
  app.indexOf("function adminDbReferenceBasicsCard("),
  app.indexOf("const ADMIN_REFERENCE_CHANNEL_BRAND_META", app.indexOf("function adminDbReferenceBasicsCard("))
);
const referenceProductQuantityBlock = app.slice(
  app.indexOf("function adminDbReferenceProductNameKey("),
  app.indexOf("function adminDbReferenceProductRowHtml(", app.indexOf("function adminDbReferenceProductNameKey("))
);
const adminProfilePanelBlock = app.slice(
  app.indexOf("function adminDbAdminProfilePanel("),
  app.indexOf("function companyMasterSalesTargetsPanel(", app.indexOf("function adminDbAdminProfilePanel("))
);
const saveAdminProfileBlock = app.slice(
  app.indexOf("async function saveCompanyAdminProfile("),
  app.indexOf("async function saveCompanyChannelExposure(", app.indexOf("async function saveCompanyAdminProfile("))
);
const referenceSalesHistoryBlock = app.slice(
  app.indexOf("function adminDbReferenceDateLabel("),
  app.indexOf("function adminDbReferenceProductRowHtml(", app.indexOf("function adminDbReferenceDateLabel("))
);
const referenceChannelRowBlock = app.slice(
  app.indexOf("function adminDbReferenceChannelRowHtml("),
  app.indexOf("function adminDbReferenceChannelsCard(", app.indexOf("function adminDbReferenceChannelRowHtml("))
);
const channelCorrectionFormBlock = app.slice(
  app.indexOf("function adminDbChannelDraftKeys("),
  app.indexOf("function adminDbNaverChannelObservationHtml(", app.indexOf("function adminDbChannelDraftKeys("))
);
const channelCorrectionPanelBlock = app.slice(
  app.indexOf("function adminDbChannelExposurePanel("),
  app.indexOf("function adminDbCollectionPanel(", app.indexOf("function adminDbChannelExposurePanel("))
);
const cumulativeCssBlock = styles.slice(
  styles.indexOf("/* Company cumulative DB v1:"),
  styles.indexOf("/* Region keyword readability", styles.indexOf("/* Company cumulative DB v1:"))
);
const referenceCssBlock = styles.slice(
  styles.indexOf("/* Company DB reference v2:"),
  styles.indexOf("/* Region keyword readability", styles.indexOf("/* Company DB reference v2:"))
);

assert(
  adminDbCompanyRowBlock.includes('>검토</a>')
    && adminDbCompanyRowBlock.includes("admin-db-company-simple")
    && !adminDbCompanyRowBlock.includes("admin-db-company-values")
    && !adminDbCompanyRowBlock.includes("7일 매출")
    && !adminDbCompanyRowBlock.includes("예약율")
    && !adminDbCompanyRowBlock.includes("자동 수집 신뢰도")
    && !adminDbCompanyRowBlock.includes("data-queue-recrawl-company"),
  "company DB list rows must stay identity-focused with one review action",
  failures
);

assert(
  app.includes('adminDbViewMode: "list"')
    && adminDbSearchShellBlock.includes('role="combobox"')
    && adminDbSearchShellBlock.includes('aria-autocomplete="list"')
    && adminDbSearchShellBlock.includes('aria-controls="adminDbAutocomplete"')
    && adminDbSearchShellBlock.includes('data-admin-db-persistent-search="true"')
    && adminDbSearchShellBlock.includes("다른 업체 검색")
    && adminDbExplorerBlock.includes("adminDbCompanySearchShellHtml(context)")
    && adminDbExplorerBlock.includes("adminDbCompanyProvinceCardsHtml(grouped, filters)")
    && adminDbExplorerBlock.includes("adminDbCompanyRegionCardsHtml(grouped, filters)")
    && adminDbExplorerBlock.includes("adminDbCompanyExplorerResultsHtml(filteredRows, rows, filters)")
    && adminDbRenderBlock.includes("adminDbCompanyExplorerHtml(searchContext)")
    && adminDbRenderBlock.includes('viewMode === "region" ? adminRegionalDatabasePanel(master) : ""')
    && !adminDbExplorerBlock.includes("data-admin-db-ota"),
  "company DB must open with search, then province, municipality, and company results while region DB remains separate",
  failures
);

assert(
  adminDbRenderBlock.includes('adminDbCompanySearchShellHtml(searchContext, { compact: true, queryValue: "" })')
    && adminDbRenderBlock.indexOf('adminDbCompanySearchShellHtml(searchContext, { compact: true, queryValue: "" })')
      < adminDbRenderBlock.indexOf("adminDbSelectedDetailPanel(rows)")
    && app.includes("function adminDbQueryUsesInlineAutocomplete(input = null)")
    && adminDbNativeLinkBlock.includes("event?.ctrlKey")
    && !adminDbNativeLinkBlock.includes('element.hasAttribute("data-admin-db-company-select")')
    && adminDbBindEventsBlock.includes("adminDbQueryUsesInlineAutocomplete(adminDbQuery)")
    && adminDbBindEventsBlock.includes("refreshAdminDbAutocomplete(adminDbQuery);")
    && adminDbBindEventsBlock.includes('scroll: !adminDbCompanySelect.closest("[data-admin-db-persistent-search]")')
    && app.includes("function openFirstAdminDbAutocompleteOption(input = null)")
    && adminDbBindEventsBlock.includes("openFirstAdminDbAutocompleteOption(input);")
    && adminDbBindEventsBlock.includes("state.adminDbInlineSearchScroll = { left: window.scrollX || 0, top: window.scrollY || 0 };")
    && app.includes("function restoreAdminDbInlineSearchViewport(position = null, options = {})")
    && app.includes("restoreAdminDbInlineSearchViewport(preservedScroll, { clear: false });")
    && app.includes("detailRequest.finally(() => restoreAdminDbInlineSearchViewport(preservedScroll)).catch(() => {});")
    && app.includes("if (options.load !== false) loadAdminDbCompanyDetail(selectedCompanyId).catch(() => {});")
    && app.includes('if (state.adminDbViewMode === "review" && state.adminDbSelectedCompanyId === companyId) return true;')
    && /\.admin-db-company-search-shell\.compact\s*\{[^}]*grid-template-columns:\s*minmax\(170px,\s*0\.34fr\)\s*minmax\(0,\s*1fr\)/i.test(styles)
    && /@media \(max-width: 760px\)[\s\S]*?\.admin-db-company-search-shell\.compact\s*\{[^}]*grid-template-columns:\s*1fr/i.test(styles),
  "company detail search must keep the current screen, show inline autocomplete, and replace only the selected company detail",
  failures
);

assert(
  adminDbAutocompleteBlock.includes("if (!query) return [];")
    && adminDbAutocompleteBlock.includes("primary.startsWith(query)")
    && adminDbAutocompleteBlock.includes("aliases.some((alias) => alias.startsWith(query))")
    && adminDbAutocompleteBlock.includes("Math.min(8")
    && app.includes("data-admin-db-autocomplete-option")
    && app.includes("function refreshAdminDbAutocomplete(input)")
    && app.includes("function closeAdminDbAutocomplete()")
    && !app.includes("function scheduleAdminDbQueryRender(")
    && !app.includes("adminDbQueryRenderTimer")
    && app.includes('input.insertAdjacentHTML("afterend", markup)')
    && adminDbBindEventsBlock.includes('document.addEventListener("pointerdown", (event) => {')
    && adminDbBindEventsBlock.includes('if (event.target.closest?.(".admin-db-company-search-shell")) return;')
    && adminDbBindEventsBlock.includes('document.addEventListener("focusin", (event) => {')
    && adminDbBindEventsBlock.includes("closeAdminDbAutocomplete();")
    && app.includes('event.key === "ArrowDown"')
    && adminDbBindEventsBlock.includes('adminDbQuery && event.key === "Enter"')
    && adminDbBindEventsBlock.includes("commitAdminDbQueryRender(adminDbQuery.value")
    && app.includes('(adminDbQuery || autocompleteOption) && event.key === "Escape"'),
  "one-character company autocomplete must stay separate from committed results, support button and keyboard commit, cap suggestions at eight, and close on outside interaction",
  failures
);

assert(
  (themeStyles.match(/--theme-floating-subtle-shadow:/g) || []).length === 2
    && themeStyles.includes("body.role-admin .admin-db-autocomplete-option:focus-visible")
    && adminDbAutocompleteCssBlock.includes("background: var(--surface-control);")
    && adminDbAutocompleteCssBlock.includes("box-shadow: var(--theme-floating-subtle-shadow);")
    && adminDbAutocompleteCssBlock.includes("border-radius: var(--ui-radius-control);")
    && adminDbAutocompleteCssBlock.includes("outline: 2px solid var(--focus-ring);")
    && !adminDbAutocompleteCssBlock.includes("border-color: var(--theme-accent);")
    && styles.includes('body.role-admin a[data-admin-db-company-select]:not(.admin-db-autocomplete-option)')
    && /html\[data-theme-resolved\] body\.role-admin a\.admin-db-autocomplete-option\s*\{[^}]*display:\s*grid;[^}]*border-color:\s*transparent\s*!important;[^}]*background:\s*transparent\s*!important;[^}]*color:\s*var\(--text-primary\)\s*!important;[^}]*box-shadow:\s*none\s*!important;/i.test(themeStyles)
    && /html\[data-theme-resolved="light"\] body\.role-admin \.admin-db-autocomplete\s*\{[^}]*border-color:\s*#ffffff\s*!important;[^}]*background:\s*var\(--surface-card\)\s*!important;[^}]*box-shadow:\s*0 0 0 1px var\(--border-subtle\),\s*var\(--theme-floating-subtle-shadow\)\s*!important;/i.test(themeStyles)
    && /html\[data-theme-resolved="dark"\] body\.role-admin \.admin-db-autocomplete\s*\{[^}]*border-color:\s*var\(--border-subtle\)\s*!important;[^}]*background:\s*var\(--surface-card\)\s*!important;[^}]*box-shadow:\s*var\(--theme-floating-subtle-shadow\)\s*!important;/i.test(themeStyles),
  "company autocomplete must not inherit blue company links, must use a white card and border effect in light mode, and an opaque charcoal card in dark mode",
  failures
);

const autocompleteSandbox = {
  compactSearchText(value) {
    return String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  }
};
vm.createContext(autocompleteSandbox);
vm.runInContext(`${adminDbAutocompleteBlock}\nthis.adminDbAutocompleteSuggestions = adminDbAutocompleteSuggestions;`, autocompleteSandbox);
const autocompleteFixture = [
  { company: { primaryName: "월명글램핑", aliases: ["월명 캠프"] }, provinceLabel: "경남", localityLabel: "산청" },
  { company: { primaryName: "달빛글램핑", aliases: ["월빛 캠핑"] }, provinceLabel: "경남", localityLabel: "합천" },
  ...Array.from({ length: 10 }, (_, index) => ({ company: { primaryName: `월하${index}글램핑`, aliases: [] }, provinceLabel: "경남", localityLabel: "산청" }))
];
const autocompleteResult = autocompleteSandbox.adminDbAutocompleteSuggestions(autocompleteFixture, "월", 8);
assert(
  autocompleteResult.length === 8
    && autocompleteResult[0]?.company?.primaryName === "월명글램핑"
    && autocompleteResult.every((row) => /월/.test(`${row.company?.primaryName || ""}${(row.company?.aliases || []).join("")}`)),
  "one Korean character must return at most eight deterministic existing-company suggestions",
  failures
);

assert(
  adminDbExplorerCssBlock.includes(".admin-db-company-autocomplete") === false
    && adminDbExplorerCssBlock.includes(".admin-db-autocomplete")
    && /\.admin-db-company-filter\[open\]\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*width:\s*100%;/i.test(adminDbExplorerCssBlock)
    && /position:\s*static;/i.test(adminDbFilterGridCssBlock)
    && /width:\s*100%;/i.test(adminDbFilterGridCssBlock)
    && !/position:\s*absolute;/i.test(adminDbFilterGridCssBlock)
    && adminDbExplorerCssBlock.includes('.admin-db-company-filter:not([open]) > .admin-db-company-filter-grid')
    && adminDbExplorerCssBlock.includes("grid-template-columns: repeat(5, minmax(0, 1fr))")
    && adminDbExplorerCssBlock.includes("grid-template-columns: repeat(4, minmax(0, 1fr))")
    && adminDbExplorerCssBlock.includes("@media (max-width: 460px)")
    && !/#[0-9a-f]{3,8}|linear-gradient|radial-gradient|!important/i.test(adminDbExplorerCssBlock)
    && !/body\.role-admin \.admin-db-hero span,/.test(styles),
  "company explorer must keep an open filter panel in document flow and use token-only light and dark surfaces",
  failures
);

assert(
  adminDbOverviewBlock.includes("adminDbCompanyReferenceDashboardHtml")
    && adminDbOverviewBlock.includes("admin-company-overview-reference")
    && !adminDbOverviewBlock.includes("admin-company-evidence-fold")
    && adminDbDetailBlock.includes('data-queue-recrawl-source="admin_db_detail"')
    && adminDbDetailBlock.includes("globalInlineBusy")
    && adminDbDetailBlock.includes("collectButtonLabel")
    && adminDbDetailBlock.includes("다른 업체 수집 중")
    && adminDbDetailBlock.includes("admin-company-reference-header")
    && adminDbDetailBlock.includes("admin-company-reference-freshness")
    && adminDbDetailBlock.includes('data-admin-db-open-fold="review"')
    && adminDbDetailBlock.includes('data-admin-db-open-fold="collect"')
    && adminDbDetailBlock.includes("maintenanceHtml")
    && app.includes("function adminDbCompanyMaintenanceHtml(")
    && referenceDashboardBlock.includes("adminDbReferenceHistorySection(row, detail, model, maintenanceHtml)"),
  "company review must lead with the attached reference dashboard, inline auto collection, and collapsed detail tools",
  failures
);

assert(
  indexHtml.includes('class="theme-switcher"')
    && indexHtml.includes('data-theme-mode="light"')
    && indexHtml.includes('data-theme-mode="dark"')
    && indexHtml.includes('id="headerLogoutButton"')
    && indexHtml.includes('id="openControlButton"')
    && !/body\.role-admin #openControlButton\s*\{\s*display:\s*none;?\s*\}/.test(styles)
    && !/body\.role-admin:has\(#adminPanel\.active \[data-layout-contract="company-db-reference-v2"\]\) \.app-header\s*\{\s*display:\s*none;?\s*\}/.test(themeStyles),
  "company review must keep the shared theme, logout, filter management, and navigation header visible",
  failures
);

assert(
  referenceChannelRowBlock.includes("adminDbChannelInventoryModeLabel")
    && referenceChannelRowBlock.includes("data-company-channel-manual-collect")
    && referenceChannelRowBlock.includes(">수동 수집</button>")
    && referenceChannelRowBlock.includes("naverPartnerName")
    && referenceChannelRowBlock.includes('item.key === "naver"')
    && referenceChannelRowBlock.includes("공식 연동상품")
    && referenceChannelRowBlock.includes("공식 연동 표기 없음")
    && referenceChannelRowBlock.includes("예약상품 관측 없음")
    && app.includes('const preferredKeys = ["naver", "tteonayo", "yanolja", "yeogi"];')
    && app.includes('item.key === "naver" || (preferredKeys.includes(item.key)')
    && app.includes('item.appliedToSummary && item.status === "directly_verified"'),
  "booking channel summary must always show Naver as the base channel and show only applied external selling channels",
  failures
);

assert(
  app.includes('label: "채널 보정"')
    && app.includes('title: "OTA 및 기타 보정"')
    && channelCorrectionPanelBlock.includes("떠나요·야놀자·여기어때")
    && channelCorrectionPanelBlock.includes("ADMIN_DB_MANAGED_CHANNELS.map")
    && !channelCorrectionPanelBlock.includes("adminDbNaverChannelObservationHtml")
    && !channelCorrectionPanelBlock.includes("네이버 기준")
    && channelCorrectionFormBlock.includes("data-company-channel-link-state")
    && channelCorrectionFormBlock.includes("data-company-channel-inventory-mode")
    && channelCorrectionFormBlock.includes("data-company-channel-url")
    && channelCorrectionFormBlock.includes('channelKey === "yeogi"')
    && channelCorrectionFormBlock.includes("canPasteYeogiScreen")
    && channelCorrectionFormBlock.includes('"전체 화면 붙여넣기"')
    && channelCorrectionFormBlock.includes('"적용 후 붙여넣기"')
    && channelCorrectionFormBlock.includes(">적용</button>")
    && channelCorrectionFormBlock.includes("data-company-channel-clear")
    && app.includes("const hasProduct = Boolean(productBox?.open) && adminDbChannelProductHasValue(product);")
    && app.includes('["not_linked", "연동 없음"]')
    && app.includes('appliedToSummary: status === "directly_verified"')
    && app.includes('routineMode: ADMIN_DB_AUTO_CHANNEL_KEYS.includes(channel)')
    && server.includes("const preserveAppliedRoutine")
    && server.includes("lastRoutineStatus: checked.status")
    && server.includes("inventoryMode: entry.inventoryMode || \"unknown\"")
    && server.includes('if (key === "not_linked") return "연동 없음";')
    && /"not_linked",\r?\n\s*"needs_manual"/.test(server),
  "channel correction must hide Naver controls, configure three external channels, expose Yeogi full-screen paste after apply, and preserve manual routine settings",
  failures
);

assert(
  app.includes("function openAdminDbYeogiPasteDialog(")
    && app.includes("data-admin-db-yeogi-paste-input")
    && app.includes("data-admin-db-yeogi-paste-preview-button")
    && app.includes("data-admin-db-yeogi-paste-apply")
    && app.includes('fetchJson("/api/company-master/yeogi-manual-import"')
    && app.includes("업체 화면 전체를 복사해 붙여넣으면")
    && styles.includes(".admin-db-yeogi-paste-dialog")
    && styles.includes(".admin-db-yeogi-paste-preview dl")
    && server.includes("async function resolveYeogiCompanyPaste(")
    && server.includes("companyChannelCandidateScore(company")
    && server.includes('action: "yeogi_manual_paste"')
    && server.includes('reqUrl.pathname === "/api/company-master/yeogi-manual-import"'),
  "Yeogi B-card manual collection must preview full-screen paste, verify the selected company, and save only parsed summary evidence",
  failures
);

const referenceSlotOrder = [
  'data-layout-slot="basics-channels"',
  "adminDbReferenceCurrentSection(row, model)",
  "adminDbReferenceHistorySection(row, detail, model, maintenanceHtml)"
].map((token) => referenceDashboardBlock.indexOf(token));

assert(
  referenceDashboardBlock.includes('data-layout-contract="company-db-reference-v2"')
    && referenceSlotOrder.every((index) => index >= 0)
    && referenceSlotOrder.every((index, position) => position === 0 || index > referenceSlotOrder[position - 1])
    && referenceDashboardBlock.includes("adminDbReferenceBasicsCard(row, detail, model)")
    && referenceDashboardBlock.includes("adminDbReferenceChannelsCard(row)")
    && adminCompanyChartBlock.includes("A · 업체 기본정보") === false
    && adminCompanyChartBlock.includes("업체 기본정보")
    && adminCompanyChartBlock.includes("예약 채널")
    && adminCompanyChartBlock.includes("최근 운영 관측")
    && adminCompanyChartBlock.includes("누적 이력·관리")
    && adminCompanyChartBlock.includes("추정 평일 예약율")
    && adminCompanyChartBlock.includes("누적 리드타임 추이")
    && adminCompanyChartBlock.includes("data-admin-db-rank-keyword")
    && adminCompanyChartBlock.includes("네이버는 기본 채널로 항상 표시하며"),
  "company reference dashboard must render A and B first, then C current observations and D cumulative history with keyword-scoped rank",
  failures
);

assert(
  adminCompanyChartBlock.includes("관리자 확정 기본정보")
    && adminCompanyChartBlock.includes("최근 자동관측 상품정보")
    && adminCompanyChartBlock.includes("재고 총량 관측")
    && adminCompanyChartBlock.includes("구조화 상품상세 없음")
    && adminCompanyChartBlock.includes("자동관측 자료 없음")
    && adminCompanyChartBlock.includes("detail.observationBasis?.daily")
    && adminCompanyChartBlock.includes('data-admin-db-open-fold="profile"')
    && !adminCompanyChartBlock.includes("플레이스 ID")
    && !referenceBasicsCardBlock.includes("업체명 별칭")
    && !referenceBasicsCardBlock.includes("사업자 확인값")
    && !referenceBasicsCardBlock.includes("성수기 참고")
    && !referenceBasicsCardBlock.includes("시즌 가격")
    && !referenceBasicsCardBlock.includes("숙박 운영 기준")
    && !referenceBasicsCardBlock.includes("데이유즈 운영 기준")
    && !referenceBasicsCardBlock.includes("확정 상품 기준")
    && !referenceBasicsCardBlock.includes("adminDbFixedRoomBasisHtml")
    && !referenceBasicsCardBlock.includes("adminDbReferenceProductSeasonHtml")
    && referenceBasicsCardBlock.includes('aria-label="상품별 최신 저장가격"')
    && !referenceBasicsCardBlock.includes("관리자 확정 기본정보는 자동수집으로 덮지 않습니다")
    && !referenceBasicsCardBlock.includes("상품 가격은 가장 최근에 저장된 완전한 Snapshot")
    && !referenceBasicsCardBlock.includes("과거 연도와 월별 소폭 변동")
    && !referenceBasicsCardBlock.includes("네이버 공개 관측가는 실제 보유 객실·결제 매출과 구분")
    && !referenceBasicsCardBlock.includes("네이버 공개 관측가는 실제 결제자료와 구분")
    && !adminProfilePanelBlock.includes("업체명 별칭")
    && !adminProfilePanelBlock.includes("사업자 확인값")
    && !adminProfilePanelBlock.includes('data-admin-profile-field="aliases"')
    && !adminProfilePanelBlock.includes('data-admin-profile-field="businessVerificationStatus"')
    && !adminProfilePanelBlock.includes("관리자가 확정한 객실·상품 기준")
    && !adminProfilePanelBlock.includes("data-manual-lodging")
    && !adminProfilePanelBlock.includes("data-manual-dayuse")
    && !adminProfilePanelBlock.includes("manualCorrectionRoomSegmentsField")
    && !saveAdminProfileBlock.includes('aliases: field("aliases")')
    && !saveAdminProfileBlock.includes('businessVerificationStatus: field("businessVerificationStatus")')
    && !saveAdminProfileBlock.includes("lodgingBasisTotal:")
    && !saveAdminProfileBlock.includes("dayUseBasisTotal:")
    && !saveAdminProfileBlock.includes("roomSegments:")
    && app.includes('foldKey: "profile"')
    && app.includes("function adminDbAdminProfilePanel(")
    && app.includes("function saveCompanyAdminProfile(")
    && app.includes('fetchJson("/api/company-master/admin-profile"')
    && server.includes('reqUrl.pathname === "/api/company-master/admin-profile"')
    && server.includes("sanitizeCompanyAdminProfile(payload")
    && server.includes('Object.hasOwn(payload, "aliases") ? payload.aliases : previous.aliases')
    && server.includes('Object.hasOwn(payload, "lodgingBasisTotal") ? payload.lodgingBasisTotal : previousRoomBasis.lodgingBasisTotal')
    && server.includes('Object.hasOwn(payload, "dayUseBasisTotal") ? payload.dayUseBasisTotal : previousRoomBasis.dayUseBasisTotal')
    && server.includes('Object.hasOwn(payload, "roomSegments") ? payload.roomSegments : previousRoomBasis.roomSegments')
    && server.includes('Object.hasOwn(payload, "businessVerificationStatus") ? payload.businessVerificationStatus : previousVerification.status'),
  "company basics must keep aliases, business verification, room basis, fixed products, Naver ids, and season notes out of the primary A-card and maintenance UI while preserving stored hidden values",
  failures
);

assert(
  companyCorrectionFormBlock.includes("adminDbCollectedCorrectionBasis(company, options.detail || {})")
    && companyCorrectionFormBlock.includes("adminDbCollectedCorrectionDraft(correction, collectedBasis)")
    && companyCorrectionFormBlock.includes("adminDbCollectedCorrectionEvidenceHtml(collectedBasis, correctionDraft)")
    && companyCorrectionFormBlock.includes("correctionDraft.correction.lodgingBasisTotal")
    && companyCorrectionFormBlock.includes("correctionDraft.correction.dayUseBasisTotal")
    && companyCorrectionFormBlock.includes("manualCorrectionRoomSegmentsField(correctionDraft.correction")
    && adminDbDetailBlock.includes("adminDbQuickCorrectionPanel(row, selectedDetail)")
    && app.includes("companyCorrectionFormHtml(company, true, { detail })")
    && collectedCorrectionBlock.includes("최근 수집 Snapshot")
    && collectedCorrectionBlock.includes("수집값을 입력 초안으로 불러왔습니다")
    && collectedCorrectionBlock.includes("상품별 수량·요일가격은 원본에 미보존")
    && collectedCorrectionBlock.includes('limit: 5')
    && collectedCorrectionCssBlock.includes("background: var(--surface-card);")
    && collectedCorrectionCssBlock.includes("background: var(--surface-control);")
    && !/(#[0-9a-f]{3,8}|linear-gradient|radial-gradient|!important)/i.test(collectedCorrectionCssBlock),
  "company correction must show collected products first, prefill editable drafts only from structured snapshots, and keep legacy summaries read-only with token surfaces",
  failures
);

const collectedCorrectionSandbox = {
  B2B_MY_LODGE_SEGMENT_LIMIT: 8,
  optionalNumber(value) {
    if (value === "" || value === null || value === undefined) return NaN;
    const parsed = Number(String(value).replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : NaN;
  },
  adminDbProductQuantity(product = {}) {
    const parsed = Number(product.totalQuantity ?? product.maxTotal ?? product.total ?? product.quantity);
    return Number.isFinite(parsed) ? parsed : NaN;
  },
  adminDbProductPrice(product = {}, key = "weekday") {
    const aliases = {
      weekday: ["weekdayPrice", "weekday"],
      friday: ["fridayPrice", "friday"],
      saturday: ["saturdayPrice", "saturday"],
      sunday: ["sundayPrice", "sunday"]
    }[key] || [];
    for (const alias of aliases) {
      const parsed = Number(product[alias] ?? product.prices?.[alias]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return NaN;
  },
  cleanManualCorrectionSegment(row = {}) {
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
    };
    return {
      type: String(row.type || "").trim(),
      count: number(row.count),
      weekdayPrice: number(row.weekdayPrice),
      fridayPrice: number(row.fridayPrice),
      saturdayPrice: number(row.saturdayPrice),
      sundayPrice: number(row.sundayPrice)
    };
  },
  manualCorrectionSegmentHasValue(row = {}) {
    return Boolean(row.type || row.count || row.weekdayPrice || row.fridayPrice || row.saturdayPrice || row.sundayPrice);
  },
  manualCorrectionRoomSegments(correction = {}) {
    return (Array.isArray(correction.roomSegments) ? correction.roomSegments : [])
      .map((row) => collectedCorrectionSandbox.cleanManualCorrectionSegment(row))
      .filter((row) => collectedCorrectionSandbox.manualCorrectionSegmentHasValue(row))
      .slice(0, 8);
  }
};
vm.createContext(collectedCorrectionSandbox);
vm.runInContext(
  `${collectedCorrectionBlock}\nthis.adminDbCollectedCorrectionBasis = adminDbCollectedCorrectionBasis;\nthis.adminDbCollectedCorrectionDraft = adminDbCollectedCorrectionDraft;`,
  collectedCorrectionSandbox
);
const collectedStructuredBasis = collectedCorrectionSandbox.adminDbCollectedCorrectionBasis({}, {
  products: [
    { key: "a", name: "스탠다드", productType: "lodging", totalQuantity: 2, weekdayPrice: 149000, fridayPrice: 179000, saturdayPrice: 229000, sundayPrice: 189000 },
    { key: "b", name: "패밀리", saleType: "숙박", totalQuantity: 3, weekdayPrice: 199000, fridayPrice: 229000, saturdayPrice: 279000, sundayPrice: 239000 },
    { key: "c", name: "오토캠핑", productType: "dayuse", totalQuantity: 4, weekdayPrice: 49000, fridayPrice: 59000, saturdayPrice: 79000, sundayPrice: 59000 }
  ],
  observationBasis: { products: { collectedAt: "2026-08-22T01:32:00.000Z", runId: "structured-run" } }
});
const collectedDraft = collectedCorrectionSandbox.adminDbCollectedCorrectionDraft({}, collectedStructuredBasis);
const savedDraft = collectedCorrectionSandbox.adminDbCollectedCorrectionDraft({
  lodgingBasisTotal: 7,
  roomSegments: [{ type: "관리자 객실", count: 7, weekdayPrice: 120000 }]
}, collectedStructuredBasis);
const collectedLegacyBasis = collectedCorrectionSandbox.adminDbCollectedCorrectionBasis({}, {
  products: [],
  legacyProductPreview: {
    structured: false,
    productCount: 5,
    previewNames: ["스탠다드", "슈페리어", "디럭스", "스위트"],
    listedPriceRange: { min: 159000, max: 349000 }
  }
});
const legacyDraft = collectedCorrectionSandbox.adminDbCollectedCorrectionDraft({}, collectedLegacyBasis);
assert(
  collectedStructuredBasis.structured === true
    && collectedStructuredBasis.products.length === 3
    && collectedStructuredBasis.lodgingSegments.length === 2
    && collectedStructuredBasis.lodgingBasisTotal === 5
    && collectedStructuredBasis.dayUseBasisTotal === 4
    && collectedDraft.prefilled === true
    && collectedDraft.correction.roomSegments[0].type === "스탠다드"
    && collectedDraft.correction.lodgingBasisTotal === 5
    && collectedDraft.correction.dayUseBasisTotal === 4
    && savedDraft.correction.roomSegments[0].type === "관리자 객실"
    && savedDraft.correction.lodgingBasisTotal === 7
    && savedDraft.usedObservedSegments === false
    && collectedLegacyBasis.structured === false
    && collectedLegacyBasis.lodgingSegments.length === 0
    && legacyDraft.prefilled === false
    && !Array.isArray(legacyDraft.correction.roomSegments),
  "structured product snapshots must prefill lodging rows and complete totals, saved admin values must win, and legacy summaries must never fabricate editable products",
  failures
);

assert(
  styles.includes('.admin-reference-delta[data-ui-status="positive"]')
    && styles.includes('.admin-reference-delta[data-ui-status="warning"]')
    && styles.includes(".admin-reference-insight-strip strong")
    && styles.includes("color: var(--text-primary);")
    && app.includes('adminDbReferenceDeltaTag("비교 대기")'),
  "company trend comparison waiting labels must remain readable in light and dark themes",
  failures
);

const referenceProductQuantitySandbox = {
  optionalNumber(value) {
    if (value === "" || value === null || value === undefined) return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  },
  adminDbProductQuantity(product = {}) {
    const value = product.totalQuantity ?? product.maxTotal ?? product.total ?? product.quantity;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
};
vm.createContext(referenceProductQuantitySandbox);
vm.runInContext(
  `${referenceProductQuantityBlock}\nthis.adminDbReferenceProductQuantityProfile = adminDbReferenceProductQuantityProfile;`,
  referenceProductQuantitySandbox
);
const wolmyeongFixedQuantity = referenceProductQuantitySandbox.adminDbReferenceProductQuantityProfile({
  name: "월명 빌라 스테이 / BBQ PKG(조식포함)",
  total: 3,
  latestTotal: 2
}, [{ type: "월명 빌라 스테이 / BBQ PKG(조식포함)", count: "2" }]);
const wolmyeongObservedQuantity = referenceProductQuantitySandbox.adminDbReferenceProductQuantityProfile({
  name: "월명 빌라 스테이 / BBQ PKG(조식포함)",
  total: 3,
  latestTotal: 2
}, []);
const unmatchedFixedQuantity = referenceProductQuantitySandbox.adminDbReferenceProductQuantityProfile({
  name: "월명 빌라 스테이 / BBQ PKG(조식포함)",
  total: 3,
  latestTotal: 2
}, [{ type: "월명 스탠다드", count: "7" }]);
assert(
  wolmyeongFixedQuantity.primary === 2
    && wolmyeongFixedQuantity.primarySource === "관리자 확정"
    && wolmyeongFixedQuantity.observedLatest === 2
    && wolmyeongFixedQuantity.observedMaximum === 3
    && wolmyeongObservedQuantity.primary === 2
    && wolmyeongObservedQuantity.primarySource === "최근 자동관측"
    && unmatchedFixedQuantity.primary === 2
    && unmatchedFixedQuantity.hasFixed === false,
  "A-card product quantities must prefer exact admin-confirmed counts, otherwise the latest observation, while preserving the observed-period maximum as evidence",
  failures
);

const observedInventorySandbox = {
  optionalNumber(value) {
    if (value === "" || value === null || value === undefined) return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  },
  adminDbProductQuantity(product = {}) {
    const value = product.totalQuantity ?? product.total ?? product.quantity;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  },
  compactDateTime(value) {
    return String(value || "");
  }
};
vm.createContext(observedInventorySandbox);
vm.runInContext(
  `${referenceObservedInventoryBasisBlock}\n${referenceObservedInventoryLabelBlock}\nthis.adminDbReferenceObservedInventoryBasis = adminDbReferenceObservedInventoryBasis;\nthis.adminDbReferenceObservedInventoryLabel = adminDbReferenceObservedInventoryLabel;`,
  observedInventorySandbox
);
const aggregateOnlyBasis = observedInventorySandbox.adminDbReferenceObservedInventoryBasis({
  products: [],
  daily: [{ productType: "lodging", total: 16 }],
  observationBasis: {
    products: { collectedAt: "" },
    daily: { actualObservation: true, collectedAt: "2026-06-27T08:01:53.632Z" }
  }
}, {
  collectedAt: "2026-07-24T11:27:10.389Z",
  salesSignal: { lodgingBasisTotal: 16, lodging: { totalSupply: 112, maxTotal: 16 } },
  productSnapshot: null
});
const manualOnlyBasis = observedInventorySandbox.adminDbReferenceObservedInventoryBasis({
  products: [],
  daily: [],
  observationBasis: { products: { collectedAt: "" }, daily: { actualObservation: false, collectedAt: "" } }
}, {});
const mixedManualAndObservedBasis = observedInventorySandbox.adminDbReferenceObservedInventoryBasis({
  products: [],
  daily: [{ productType: "lodging", total: 10 }],
  observationBasis: {
    products: { collectedAt: "" },
    daily: { actualObservation: true, collectedAt: "2026-08-22T01:00:00.000Z" }
  }
}, {
  salesSignal: { lodging: { days: 1, maxTotal: 12, manualCorrectionApplied: true } },
  manualCorrectionApplied: true
});
const correctedSignalOnlyBasis = observedInventorySandbox.adminDbReferenceObservedInventoryBasis({
  products: [],
  daily: [],
  observationBasis: { products: { collectedAt: "" }, daily: { actualObservation: false, collectedAt: "" } }
}, {
  salesSignal: { manualCorrectionApplied: true, lodging: { maxTotal: 12, manualCorrectionApplied: true } },
  manualCorrectionApplied: true
});
const legacyPreviewBasis = observedInventorySandbox.adminDbReferenceObservedInventoryBasis({
  products: [],
  daily: [{ productType: "lodging", total: 16 }],
  legacyProductPreview: {
    structured: false,
    observedAt: "2026-06-27T08:01:53.632Z",
    productCount: 5,
    previewNames: ["스탠다드", "슈페리어", "디럭스", "스위트"]
  },
  observationBasis: {
    products: { collectedAt: "" },
    daily: { actualObservation: true, collectedAt: "2026-06-27T08:01:53.632Z" }
  }
}, {});
const recoveredOlderProductBasis = observedInventorySandbox.adminDbReferenceObservedInventoryBasis({
  products: [{ totalQuantity: 13 }],
  daily: [{ productType: "lodging", total: 16 }],
  observationBasis: {
    products: { collectedAt: "2026-06-27T08:01:53.632Z" },
    daily: { actualObservation: true, collectedAt: "2026-07-03T08:01:53.632Z" }
  }
}, {});
const newerStructuredProductBasis = observedInventorySandbox.adminDbReferenceObservedInventoryBasis({
  products: [{ totalQuantity: 13 }],
  daily: [{ productType: "lodging", total: 16 }],
  observationBasis: {
    products: { collectedAt: "2026-08-22T08:01:53.632Z" },
    daily: { actualObservation: true, collectedAt: "2026-08-21T08:01:53.632Z" }
  }
}, {});
const mixedHistoryRunsBasis = observedInventorySandbox.adminDbReferenceObservedInventoryBasis({
  products: [],
  daily: [
    { productType: "lodging", runId: "old-run", total: 20 },
    { productType: "lodging", runId: "latest-run", total: 16 }
  ],
  observationBasis: {
    products: { collectedAt: "" },
    daily: {
      source: "history_observations",
      actualObservation: true,
      runId: "latest-run",
      lodgingBasisRunId: "latest-run",
      lodgingBasisTotal: 16,
      lodgingBasisCollectedAt: "2026-08-23T01:00:00.000Z",
      collectedAt: "2026-08-23T01:00:00.000Z"
    }
  }
}, {});
assert(
  aggregateOnlyBasis.totalQuantity === 16
    && aggregateOnlyBasis.hasInventoryObservation === true
    && aggregateOnlyBasis.inventoryObservedAt === "2026-06-27T08:01:53.632Z"
    && observedInventorySandbox.adminDbReferenceObservedInventoryLabel(aggregateOnlyBasis) === "재고 총량 관측 2026-06-27T08:01:53.632Z · 구조화 상품상세 없음"
    && Number.isNaN(manualOnlyBasis.totalQuantity)
    && manualOnlyBasis.hasInventoryObservation === false
    && observedInventorySandbox.adminDbReferenceObservedInventoryLabel(manualOnlyBasis) === "자동관측 자료 없음"
    && mixedManualAndObservedBasis.totalQuantity === 10
    && Number.isNaN(correctedSignalOnlyBasis.totalQuantity)
    && legacyPreviewBasis.legacyProductPreview.productCount === 5
    && recoveredOlderProductBasis.totalQuantity === 16
    && recoveredOlderProductBasis.totalQuantitySource === "최근 공개재고 기준총량"
    && newerStructuredProductBasis.totalQuantity === 13
    && newerStructuredProductBasis.totalQuantitySource === "구조화 상품 수량 합계"
    && mixedHistoryRunsBasis.totalQuantity === 16
    && mixedHistoryRunsBasis.totalQuantityObservedAt === "2026-08-23T01:00:00.000Z"
    && observedInventorySandbox.adminDbReferenceObservedInventoryLabel(legacyPreviewBasis) === "과거 수집 요약 2026-06-27T08:01:53.632Z 관측 · 구조화 상품상세 없음",
  "aggregate inventory observations must use the original history time, the newest evidence must determine total quantity, and manual-only values must stay out of the automatic panel",
  failures
);

assert(
  referenceCssBlock.includes("grid-template-columns: minmax(0, 1.33fr) minmax(340px, 1fr)")
    && referenceCssBlock.includes("grid-template-columns: repeat(4, minmax(0, 1fr))")
    && referenceCssBlock.includes("grid-template-columns: repeat(2, minmax(0, 1fr))")
    && referenceCssBlock.includes("grid-template-columns: minmax(410px, .95fr) minmax(0, 1.35fr)")
    && referenceCssBlock.includes("grid-template-columns: repeat(3, minmax(0, 1fr))")
    && referenceCssBlock.includes(".admin-reference-product-table")
    && referenceCssBlock.includes(".admin-reference-current-grid")
    && referenceCssBlock.includes(".admin-reference-history-chart-grid")
    && referenceCssBlock.includes(".admin-reference-history-fold")
    && referenceCssBlock.includes(".admin-reference-archive-year")
    && referenceCssBlock.includes(".admin-reference-archive-month")
    && referenceCssBlock.includes(".admin-reference-archive-week")
    && referenceCssBlock.includes("@media (max-width: 760px)")
    && !/(#[0-9a-f]{3,8}|linear-gradient|radial-gradient|!important)/i.test(referenceCssBlock),
  "company reference layout must preserve the attached desktop geometry and token-only responsive styling",
  failures
);

assert(
  adminCompanyChartBlock.includes("function adminDbReferenceCurrentSection(")
    && adminCompanyChartBlock.includes("오늘 이후 확보된 예약일 없음")
    && adminCompanyChartBlock.includes("추정 평일 예약율")
    && adminCompanyChartBlock.includes("추정 금요일 예약율")
    && adminCompanyChartBlock.includes("추정 토요일 예약율")
    && adminCompanyChartBlock.includes("추정 일요일 예약율")
    && adminCompanyChartBlock.includes("기간별 예약율")
    && adminCompanyChartBlock.includes("지난 관측자료")
    && adminCompanyChartBlock.includes("연도 → 월 → 주 → 일")
    && adminCompanyChartBlock.includes("adminDbReferenceResolvedSalesHistory(model)")
    && adminCompanyChartBlock.includes("model.salesHistory")
    && adminCompanyChartBlock.includes("adminDbReferenceArchiveHtml(history.archive)")
    && adminCompanyChartBlock.includes('class="admin-reference-archive-level admin-reference-archive-year"')
    && adminCompanyChartBlock.includes('class="admin-reference-archive-level admin-reference-archive-month"')
    && adminCompanyChartBlock.includes('class="admin-reference-archive-level admin-reference-archive-week"'),
  "current sales observations must separate weekday rates and expose a year-month-week-day archive under cumulative history",
  failures
);

const salesHistorySandbox = {
  todayIsoDate: () => "2026-08-23",
  adminDbChartClamp: (value, min, max) => Math.max(min, Math.min(max, value)),
  optionalNumber(value) {
    if (value === "" || value === null || value === undefined) return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
};
vm.createContext(salesHistorySandbox);
vm.runInContext(`${referenceSalesHistoryBlock}\nthis.adminDbReferenceSalesHistoryModel = adminDbReferenceSalesHistoryModel;`, salesHistorySandbox);
const salesHistoryModel = salesHistorySandbox.adminDbReferenceSalesHistoryModel({
  daily: [
    { date: "2026-08-23", productType: "lodging", total: 10, sold: 5, estimatedRevenue: 500000 },
    { date: "2026-08-25", productType: "lodging", total: 10, sold: 6, estimatedRevenue: 600000 },
    { date: "2026-08-20", productType: "lodging", total: 10, sold: 2, estimatedRevenue: 200000 },
    { date: "2026-08-15", productType: "lodging", total: 10, sold: 4, estimatedRevenue: 400000 },
    { date: "2025-12-30", productType: "lodging", total: 8, sold: 2, estimatedRevenue: 180000 }
  ]
}, "2026-08-23");

assert(
  salesHistoryModel.current.observedDays === 2
    && Math.abs(salesHistoryModel.current.rate - 0.55) < 0.0001
    && salesHistoryModel.current.estimatedRevenue === 1100000
    && salesHistoryModel.expectedCurrentDays === 3
    && salesHistoryModel.missingCurrentDays === 1
    && salesHistoryModel.archive.map((year) => year.key).join("|") === "2026|2025"
    && salesHistoryModel.archive[0].months[0].key === "2026-08"
    && salesHistoryModel.archive[0].months[0].weeks.length === 2,
  "sales observation grouping must preserve current coverage and descending year-month-week history",
  failures
);

assert(
  adminCompanyChartBlock.includes("const performanceBasisComparable")
    && adminCompanyChartBlock.includes("sameObservedHorizon")
    && adminCompanyChartBlock.includes("currentPerformanceAligned")
    && adminCompanyChartBlock.includes("Math.abs(optionalNumber(latestPerformance.estimatedRevenue) - optionalNumber(model.estimatedRevenue)) < 1")
    && cumulativeDashboardModelBlock.includes("const salesArchiveDaily = adminDbDailyRows")
    && cumulativeDashboardModelBlock.includes("salesArchiveDaily,")
    && adminCompanyChartBlock.includes("model.salesArchiveDaily")
    && adminCompanyChartBlock.includes("items.every((item) => Number.isFinite(item[key]))")
    && adminCompanyChartBlock.includes("가격 미관측으로 계산 불가")
    && adminCompanyChartBlock.includes("미수집 날짜는 0으로 계산하지 않습니다")
    && adminCompanyChartBlock.includes('role="columnheader"')
    && adminCompanyChartBlock.includes('role="cell"'),
  "company reference evidence must not promote missing representative prices or incomparable snapshots",
  failures
);

const channelAssetSignatures = {
  naver: fs.existsSync(channelAssetPaths.naver) ? fs.readFileSync(channelAssetPaths.naver).subarray(0, 12).toString("ascii") : "",
  nol: fs.existsSync(channelAssetPaths.nol) ? fs.readFileSync(channelAssetPaths.nol).subarray(0, 8).toString("hex") : "",
  yeogi: fs.existsSync(channelAssetPaths.yeogi) ? fs.readFileSync(channelAssetPaths.yeogi).subarray(0, 12).toString("ascii") : "",
  ddnayo: fs.existsSync(channelAssetPaths.ddnayo) ? fs.readFileSync(channelAssetPaths.ddnayo).subarray(0, 4).toString("hex") : ""
};

assert(
  Object.values(channelAssetPaths).every((filePath) => fs.existsSync(filePath))
    && channelAssetSignatures.naver.startsWith("RIFF") && channelAssetSignatures.naver.endsWith("WEBP")
    && channelAssetSignatures.nol === "89504e470d0a1a0a"
    && channelAssetSignatures.yeogi.startsWith("RIFF") && channelAssetSignatures.yeogi.endsWith("WEBP")
    && channelAssetSignatures.ddnayo === "00000100"
    && adminCompanyChartBlock.includes('naver: { src: "/assets/channels/naver.webp"')
    && adminCompanyChartBlock.includes('yeogi: { src: "/assets/channels/yeogi.webp"')
    && adminCompanyChartBlock.includes('yanolja: { src: "/assets/channels/nol.png"')
    && adminCompanyChartBlock.includes('tteonayo: { src: "/assets/channels/ddnayo.ico"')
    && adminCompanyChartBlock.includes('label: "NOL(야놀자)"')
    && app.includes('img[data-channel-brand-icon]')
    && app.includes('image.closest(".admin-reference-channel-icon")?.classList.add("is-fallback")')
    && ["naver.webp", "nol.png", "yeogi.webp", "ddnayo.ico"].every((fileName) => serviceWorker.includes(`/assets/channels/${fileName}`))
    && server.includes('".webp": "image/webp"')
    && server.includes('".ico": "image/x-icon"'),
  "company booking channels must use verified local brand assets with an accessible text fallback and offline cache coverage",
  failures
);

const cumulativeSlotOrder = [
  "adminDbCumulativeKpiStripHtml(model)",
  "adminDbCumulativeHistoryHtml(row, model)",
  'data-layout-slot="comparison"',
  "adminDbCumulativeWeekdayHtml(row, model)"
].map((token) => cumulativeDashboardBlock.indexOf(token));

assert(
  cumulativeDashboardBlock.includes('data-layout-contract="cumulative-db-v1"')
    && cumulativeSlotOrder.every((index) => index >= 0)
    && cumulativeSlotOrder.every((index, position) => position === 0 || index > cumulativeSlotOrder[position - 1])
    && adminCompanyChartBlock.includes('data-layout-slot="kpi-strip"')
    && adminCompanyChartBlock.includes('data-layout-slot="history"')
    && adminCompanyChartBlock.includes('data-layout-slot="company-trend"')
    && adminCompanyChartBlock.includes("키워드별 누적 수집 이력")
    && adminCompanyChartBlock.includes("수집 회차 비교")
    && adminCompanyChartBlock.includes("데이터 신뢰도 로그")
    && adminCompanyChartBlock.includes("업체별 누적 추이")
    && adminCompanyChartBlock.includes("상품·가격 기준 열기")
    && adminCompanyChartBlock.includes("function adminDbRankRangeEnd(")
    && adminCompanyChartBlock.includes("function adminDbDailyDateCoverage(")
    && adminCompanyChartBlock.includes("dailyCoverage.supply === dailyCoverage.total")
    && adminCompanyChartBlock.includes("const hasCompleteDailyPair")
    && adminCompanyChartBlock.includes("rankModel.keywordKey")
    && adminCompanyChartBlock.includes("matches.length !== 1")
    && !adminCompanyChartBlock.includes("Math.max(40")
    && cumulativeDashboardModelBlock.includes("const hasComparablePrevious")
    && cumulativeDashboardModelBlock.includes("available: hasComparablePrevious")
    && cumulativeDashboardModelBlock.includes("const latestRevenueComplete")
    && !cumulativeDashboardModelBlock.includes("optionalNumber(metrics.revenue)")
    && adminCompanyChartBlock.includes('data-chart="history-line"')
    && adminCompanyChartBlock.includes('data-chart="weekday-bars"')
    && adminCompanyChartBlock.includes('data-chart-point=')
    && adminCompanyChartBlock.includes('data-weekday=')
    && adminCompanyChartBlock.includes('{ label: "월", day: 1 }')
    && adminCompanyChartBlock.includes('{ label: "일", day: 0 }'),
  "company cumulative dashboard must keep the mockup slot order and functional chart landmarks",
  failures
);

assert(
  cumulativeCssBlock.includes("grid-template-columns: repeat(3, minmax(0, 1fr))")
    && cumulativeCssBlock.includes("grid-template-columns: repeat(2, minmax(0, 1fr))")
    && cumulativeCssBlock.includes("grid-template-columns: minmax(0, 2.5fr) minmax(220px, 1fr)")
    && cumulativeCssBlock.includes("min-height: 314px")
    && cumulativeCssBlock.includes("min-height: 242px")
    && cumulativeCssBlock.includes("min-height: 234px")
    && cumulativeCssBlock.includes("grid-template-columns: repeat(7, minmax(0, 1fr))")
    && cumulativeCssBlock.includes("stroke-dasharray: 10 9")
    && !/(#[0-9a-f]{3,8}|linear-gradient|radial-gradient|!important)/i.test(cumulativeCssBlock),
  "company cumulative mockup geometry must stay token-only without legacy gradients or important overrides",
  failures
);

const companyRangeHelperSource = app.slice(
  app.indexOf("function adminDbRankRangeEnd("),
  app.indexOf("function adminDbDailyDateCoverage(")
);
const companyDailyHelperSource = app.slice(
  app.indexOf("function adminDbDailyDateCoverage("),
  app.indexOf("function adminDbCumulativeDashboardModel(")
);
const companyRankTrendModelSource = app.slice(
  app.indexOf("function adminDbRankTrendModel("),
  app.indexOf("function adminDbRankScopeRowHtml(", app.indexOf("function adminDbRankTrendModel("))
);
const companyChartSandbox = {};
vm.createContext(companyChartSandbox);
vm.runInContext(
  `const adminDbChartClamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));\n${companyRangeHelperSource}\n${companyDailyHelperSource}`,
  companyChartSandbox
);
const companyDailyCoverageFixture = companyChartSandbox.adminDbDailyDateCoverage([
  { date: "2026-09-01", productType: "lodging", total: 10, sold: 4, estimatedRevenue: 400000 },
  { date: "2026-09-01", productType: "dayuse", total: 5, sold: NaN, estimatedRevenue: NaN },
  { date: "2026-09-02", productType: "lodging", total: 8, sold: 2, estimatedRevenue: 200000 },
  { date: "2026-09-02", productType: "dayuse", total: 2, sold: 1, estimatedRevenue: 50000 }
]);

assert(
  companyDailyCoverageFixture.length === 2
    && companyDailyCoverageFixture[0].total === 15
    && Number.isNaN(companyDailyCoverageFixture[0].sold)
    && Number.isNaN(companyDailyCoverageFixture[0].estimatedRevenue)
    && Number.isNaN(companyDailyCoverageFixture[0].rate)
    && companyDailyCoverageFixture[1].total === 10
    && companyDailyCoverageFixture[1].sold === 3
    && companyDailyCoverageFixture[1].estimatedRevenue === 250000
    && companyDailyCoverageFixture[1].rate === 0.3,
  "company cumulative daily metrics must aggregate by date and keep incomplete product-type contributions unknown",
  failures
);

assert(
  companyChartSandbox.adminDbPerformanceComparisonIsComplete(
    { rate: 0.3, supply: 20, sold: 6 },
    { rate: 0.25, supply: 20, sold: NaN },
    2
  ) === false
    && companyChartSandbox.adminDbPerformanceComparisonIsComplete(
      { rate: 0.3, supply: 20, sold: 6 },
      { rate: 0.25, supply: 20, sold: 5 },
      2
    ) === true
    && companyChartSandbox.adminDbPerformanceComparisonIsComplete(
      { rate: 0.3, supply: NaN, sold: 6 },
      { rate: 0.25, supply: 20, sold: 5 },
      2
    ) === false,
  "company collection comparison must be marked actual only when both runs share complete rate, supply, and sold evidence",
  failures
);

assert(
  companyChartSandbox.adminDbRankRangeEnd("1-65") === 65
    && Number.isNaN(companyChartSandbox.adminDbRankRangeEnd("1-10,21-30"))
    && Number.isNaN(companyChartSandbox.adminDbRankRangeEnd("11-30")),
  "company rank position must use only one stored continuous 1-N range and never reinterpret multi-range collections",
  failures
);

const rankKeywordSandbox = {
  state: { adminDbRankKeywordByCompany: { company_a: "local-key" } },
  adminDbTrendPoints(row, detail) { return detail.rankTrend?.points || []; },
  optionalNumber(value) {
    if (value === "" || value === null || value === undefined) return NaN;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  },
  fmtNumber(value) { return String(value); }
};
vm.createContext(rankKeywordSandbox);
vm.runInContext(companyRankTrendModelSource, rankKeywordSandbox);
const selectedRankKeywordModel = rankKeywordSandbox.adminDbRankTrendModel(
  { company: { companyId: "company_a" }, metrics: { rank: 99 } },
  {
    rankTrend: {
      keyword: "경남글램핑",
      keywordKey: "regional-key",
      points: [{ keyword: "경남글램핑", keywordKey: "regional-key", rank: 5, collectedAt: "2026-08-22" }],
      availableKeywords: [
        { keyword: "경남글램핑", keywordKey: "regional-key", latestRank: 5, points: [{ keywordKey: "regional-key", rank: 5, collectedAt: "2026-08-22" }] },
        { keyword: "산청글램핑", keywordKey: "local-key", latestRank: 2, points: [{ keywordKey: "local-key", rank: 4, collectedAt: "2026-08-20" }, { keywordKey: "local-key", rank: 2, collectedAt: "2026-08-22" }] }
      ]
    }
  }
);
assert(
  selectedRankKeywordModel.keyword === "산청글램핑"
    && selectedRankKeywordModel.keywordKey === "local-key"
    && selectedRankKeywordModel.latestRank === 2
    && selectedRankKeywordModel.points.map((point) => point.rank).join(",") === "4,2"
    && selectedRankKeywordModel.points.every((point) => point.keywordKey === "local-key")
    && adminDbBindEventsBlock.includes("data-admin-db-rank-keyword")
    && adminDbBindEventsBlock.includes("adminDbRankKeywordByCompany")
    && adminDbBindEventsBlock.includes("renderAdminConsoleDashboard()"),
  "company rank selector must switch the KPI and cumulative chart to one keyword-specific history without falling back to another keyword",
  failures
);

assert(
  adminCompanyChartBlock.includes("function adminDbDailyChartModel(")
    && adminCompanyChartBlock.includes("function adminDbRankTrendModel(")
    && adminCompanyChartBlock.includes("function adminDbPerformanceChartModel(")
    && adminCompanyChartBlock.includes("function adminDbLeadTimeChartHtml(")
    && !adminCompanyChartBlock.includes("function adminDbSyntheticRankPoints(")
    && !adminCompanyChartBlock.includes("function adminDbSyntheticPerformancePoints(")
    && adminCompanyChartBlock.includes('evidenceClass: "observed"')
    && adminCompanyChartBlock.includes('evidenceClass: "derived"')
    && adminCompanyChartBlock.includes("decisionEligible: false")
    && adminCompanyChartBlock.includes("실제 관측점 1개만 표시합니다")
    && adminCompanyChartBlock.includes("해당 기간의 실제 판매 관측이 없습니다")
    && adminCompanyChartBlock.includes("admin-company-history-chart")
    && adminCompanyChartBlock.includes('role="img"')
    && adminCompanyChartBlock.includes("<title id=")
    && adminCompanyChartBlock.includes("<desc id=")
    && styles.includes(".admin-company-trend-layout")
    && styles.includes(".admin-company-chart-rank-line.is-synthetic")
    && styles.includes("stroke-dasharray")
    && styles.includes("@media (max-width: 460px)"),
  "company cumulative charts must separate observed, derived, and presentation-only synthetic evidence with accessible graph markup",
  failures
);

assert(
  app.includes("function adminDbFoldedItemsHtml(")
    && app.includes('options.limit || 5')
    && app.includes('개 더보기')
    && app.includes('접기')
    && app.includes("상품명은 원본 그대로 보존")
    && !app.includes("function adminDbProductSeasonWindowProfile(")
    && !app.includes("function adminDbReferenceProductSeasonHtml(")
    && !referenceBasicsCardBlock.includes("성수기")
    && !referenceBasicsCardBlock.includes('id="adminReferenceProductNote"')
    && app.includes("과거 수집 상품명 미리보기")
    && app.includes("관측가격과 예상매출")
    && app.includes("실제 결제 매출이 아닙니다"),
  "company detail lists must fold after five items, keep latest prices and legacy boundaries explicit, and keep season notes out of the primary A-card",
  failures
);

assert(
  inlineRecrawlBlock.includes("activeInlineBusy")
    && inlineRecrawlBlock.includes("crawlSubmitBusy")
    && inlineRecrawlBlock.includes("진행 중인 수집이 끝난 뒤")
    && app.includes("다른 업체 자동수집 진행 중"),
  "company inline collection must keep one global in-flight owner and reject overlapping company requests",
  failures
);

assert(
  !server.includes("profiledCompanies.slice(0, 300)")
    && server.includes("function mergeCompanyProductSnapshots(")
    && !server.includes("const expandedDays = events.flatMap")
    && app.includes("externalPlatformUrl(entry.url) || adminDbChannelFallbackSearchUrl")
    && app.includes("hasPriceEvidence ? rawEstimatedRevenue : NaN"),
  "company detail must preserve sparse history, avoid hard list caps, sanitize channel links, and never invent zero revenue",
  failures
);

const companyQuickToolStyles = styles.slice(
  styles.indexOf(".admin-db-quick-edit {"),
  styles.indexOf(".admin-db-selected-empty-step {", styles.indexOf(".admin-db-quick-edit {"))
);
const companyChannelToolStyles = styles.slice(
  styles.indexOf(".admin-db-recheck-panel {"),
  styles.indexOf(".admin-db-collect-planline {", styles.indexOf(".admin-db-recheck-panel {"))
);
const companyLegacyDetailStyles = styles.slice(
  styles.indexOf("/* Admin company detail v21:"),
  styles.indexOf("/* Admin company review workspace:", styles.indexOf("/* Admin company detail v21:"))
);
const hardcodedCompanyPaint = /(?:background(?:-image)?|border(?:-color)?|color|box-shadow|text-shadow)\s*:[^;]*(?:#[0-9a-f]{3,8}|rgba?\(|linear-gradient\()/i;

assert(
  !/adminDbChannelComparisonPanel[\s\S]*?data-surface="light"[\s\S]*?function adminDbChannelExposureForm/.test(app)
    && !/adminDbChannelExposureForm[\s\S]*?data-surface="light"[\s\S]*?function adminDbNaverChannelObservationHtml/.test(app)
    && !themeStyles.includes("Company review tools keep the same neutral surface contract")
    && companyQuickToolStyles.includes("background: var(--surface-card)")
    && companyChannelToolStyles.includes("background: var(--surface-control)")
    && companyLegacyDetailStyles.includes("background: var(--surface-selected)")
    && /\.company-manual-section\s*\{[^}]*border:\s*1px solid var\(--border-subtle\)[^}]*background:\s*var\(--surface-control\)/i.test(styles)
    && /\.company-manual-structured-grid fieldset\s*\{[^}]*border:\s*1px solid var\(--border-subtle\)[^}]*background:\s*var\(--surface-card\)/i.test(styles)
    && /\.admin-db-user-view-bridge\s*\{[^}]*border:\s*1px solid var\(--border-subtle\)[^}]*background:\s*var\(--surface-card\)/i.test(styles)
    && !styles.includes("body.role-admin .company-manual-section,")
    && !styles.includes("body.role-admin .company-manual-structured-grid fieldset,")
    && !styles.includes("body.role-admin .admin-db-user-view-bridge,")
    && !hardcodedCompanyPaint.test(companyQuickToolStyles)
    && !hardcodedCompanyPaint.test(companyChannelToolStyles)
    && !hardcodedCompanyPaint.test(companyLegacyDetailStyles)
    && !companyQuickToolStyles.includes("!important")
    && !companyChannelToolStyles.includes("!important")
    && !companyLegacyDetailStyles.includes("!important"),
  "expanded company correction and channel tools must own token paint without legacy override layers",
  failures
);

assert(
  styles.includes(".admin-db-company:not(.admin-db-company-simple)")
    && styles.includes(".admin-company-channels-card .admin-company-channel-row")
    && /\.admin-company-channels-card \.admin-company-channel-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/i.test(styles),
  "simplified company rows and narrow channel cards must remain unclipped across desktop and mobile",
  failures
);

assert(
  inlineRecrawlBlock.includes('const inlineDetail = source === "admin_db_detail";')
    && inlineRecrawlBlock.includes("if (!inlineDetail) focusAdminCrawlProgress();")
    && submitCrawlBlock.includes('payload.recrawlContext?.source === "admin_db_detail"')
    && submitCrawlBlock.includes('status: "running"')
    && submitCrawlBlock.includes('status: "complete"')
    && submitCrawlBlock.includes('status: "error"')
    && submitCrawlBlock.includes('if (completedRecrawlContext?.source === "admin_db_detail")'),
  "company auto collection must run and report progress without leaving the company review screen",
  failures
);

assert(
  styles.includes(".admin-company-primary-grid")
    && styles.includes(".admin-company-trend-grid")
    && styles.includes(".admin-company-daily-row")
    && styles.includes("@media (prefers-reduced-motion: reduce)")
    && /\.admin-company-primary-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.7fr\)\s+minmax\(300px,\s*\.82fr\)/i.test(styles)
    && /@media \(max-width:\s*760px\)[\s\S]*?\.admin-company-primary-grid\s*\{[^}]*grid-template-columns:\s*1fr/i.test(styles),
  "company review layout must keep a wide evidence column, compact channel column, and one-column mobile fallback",
  failures
);

const companyRankStackIndex = app.indexOf('<div class="company-rank-stack">');
const companyRankBadgeIndex = app.indexOf('class="rank-badge"', companyRankStackIndex);
const companyRankChangeIndex = app.indexOf('class="company-rank-change', companyRankStackIndex);
const companyTitleIndex = app.indexOf('<div class="company-title">', companyRankStackIndex);

assert(
  companyRankStackIndex >= 0
    && companyRankBadgeIndex > companyRankStackIndex
    && companyRankChangeIndex > companyRankBadgeIndex
    && companyTitleIndex > companyRankChangeIndex,
  "place rank change badge must render below the rank badge before the company title",
  failures
);

assert(
  /\.confidence-badge,\s*\.company-rank-change\s*\{[^}]*min-height:\s*26px;/i.test(styles)
    && /\.company-main\s*\{[^}]*grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\)/i.test(styles)
    && !/company-rank-change[^{}]*\{[^}]*position:\s*absolute/i.test(styles),
  "place rank change badge must share status-pill sizing without absolute positioning",
  failures
);

if (failures.length) {
  console.error("Surface contrast checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Surface contrast checks passed (${lightSelectors.length} light, ${darkSelectors.length} dark selectors)`);
