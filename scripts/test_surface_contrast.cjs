const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const stylesPath = path.join(root, "web", "styles.css");
const themePath = path.join(root, "web", "admin-theme.css");
const appPath = path.join(root, "web", "app.js");
const indexPath = path.join(root, "web", "index.html");
const serviceWorkerPath = path.join(root, "web", "sw.js");
const serverPath = path.join(root, "scripts", "glamping_app_server.cjs");
const crawlerPath = path.join(root, "scripts", "gyeongnam_glamping_crawl.cjs");
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
  'class="admin-db-view-switch" data-ui-surface="control"',
  'data-ui-surface="metric" data-ui-interactive="true" data-admin-db-province-card=',
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

assert(
  adminNavMetaBlock.length > 0 && !/[⌂▣⇩▥⌖♙⚙•]/.test(adminNavMetaBlock),
  "admin navigation must not regress to font-dependent symbol icons",
  failures
);

assert(
  serviceWorker.includes("collection-receipt-v35") && serviceWorker.includes('"/admin-theme.css"'),
  "service worker cache must refresh the theme rebuild release",
  failures
);

assert(
  server.includes('styles.css?v=v2-20260822-collection-receipt-v17')
    && server.includes('admin-theme.css?v=v2-20260822-collection-receipt-v17')
    && server.includes('app.js?v=v2-20260822-collection-receipt-v17'),
  "server asset query versions must refresh styles, theme, and app together",
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

assert(
  crawlFormMarkup.includes("<h3>키워드</h3>") && !crawlFormMarkup.includes("새 수집"),
  "collection form must use keyword as the heading without the old new-collection title",
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
    && /id="detailRankEndInput"[^>]*value="40"[^>]*max="40"/.test(crawlFormMarkup)
    && /id="detailRankRangesInput" type="hidden" value="1-40"/.test(crawlFormMarkup),
  "basic collection must start at 1-40 with an editable end-rank control",
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
    && server.includes("items: items.slice(0, 40)"),
  "server and crawler must honor the simplified collection ranges through the stored result boundary",
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
const receiptEntityBlock = app.slice(
  app.indexOf("function runResultCanonicalEntityMap("),
  app.indexOf("function runResultReceiptModel(", app.indexOf("function runResultCanonicalEntityMap("))
);
const receiptModelBlock = app.slice(
  app.indexOf("function runResultReceiptModel("),
  app.indexOf("function collectionRouteRunCount", app.indexOf("function runResultReceiptModel("))
);
const receiptRendererBlock = app.slice(
  app.indexOf("function renderRunResultApplySummary()"),
  app.indexOf("function updateCrawlSpeedPreview", app.indexOf("function renderRunResultApplySummary()"))
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

assert(
  runResultCardMarkup.includes("최근 수집 결과")
    && !runResultCardMarkup.includes('id="runSelect"')
    && !runResultCardMarkup.includes('id="refreshRuns"'),
  "collection result card must show only the latest receipt without duplicate history controls",
  failures
);

assert(
  receiptRendererBlock.includes('class="run-result-receipt"')
    && receiptRendererBlock.includes('class="run-result-receipt-kpis"')
    && receiptRendererBlock.includes('class="run-result-receipt-exception"')
    && receiptRendererBlock.includes('data-admin-db-status-link="needs_work"')
    && receiptRendererBlock.includes("data-open-place-rank-replay")
    && receiptRendererBlock.includes("data-open-collection-archive")
    && receiptRendererBlock.includes("data-open-collection-run")
    && receiptRendererBlock.includes("전체 업체 검수큐 열기")
    && !receiptRendererBlock.includes('class="run-result-receipt" data-ui-surface="card"')
    && !receiptRendererBlock.includes("placeRankComparisonSummaryHtml")
    && !receiptRendererBlock.includes("runDbApplyLinkedQueueHtml"),
  "collection receipt must keep three summary layers and route details to their dedicated screens",
  failures
);

assert(
  receiptModelBlock.includes('label: "발견 업체"')
    && receiptModelBlock.includes('label: "DB 반영"')
    && receiptModelBlock.includes('label: "확인 업체"')
    && receiptModelBlock.includes('label: "판매율 산출"')
    && receiptModelBlock.includes('label: "확인 필요"'),
  "collection receipt must expose the agreed basic and detail KPI labels",
  failures
);

assert(
  receiptEntityBlock.includes("function runResultCanonicalEntityMap(")
    && receiptEntityBlock.includes("company.placeIds")
    && receiptEntityBlock.includes("company.bookingBusinessIds")
    && receiptEntityBlock.includes("canonicalMap.has")
    && receiptModelBlock.includes("const canonicalEntityMap")
    && receiptModelBlock.includes("canonicalEntityMap)")
    && receiptModelBlock.includes("const channelOnlyIssueCount")
    && receiptModelBlock.includes('salesStats(item, "day")'),
  "collection receipt must deduplicate by stable IDs, keep issue totals disjoint, and count day-use sales rates",
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
    && !collectPanelMarkup.includes('id="yeogiAdminCard"')
    && !app.includes('{ label: "OTA 수집"')
    && app.includes('{ label: "OTA 보조 도구", tab: "admin", adminPanelSection: "database", anchor: "#yeogiAdminCard" }'),
  "OTA batch tooling must live under company data while the collection receipt stays focused",
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
