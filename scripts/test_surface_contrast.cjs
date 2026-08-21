const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const stylesPath = path.join(root, "web", "styles.css");
const themePath = path.join(root, "web", "admin-theme.css");
const appPath = path.join(root, "web", "app.js");
const indexPath = path.join(root, "web", "index.html");
const serviceWorkerPath = path.join(root, "web", "sw.js");
const styles = fs.readFileSync(stylesPath, "utf8");
const themeStyles = fs.readFileSync(themePath, "utf8");
const app = fs.readFileSync(appPath, "utf8");
const indexHtml = fs.readFileSync(indexPath, "utf8");
const serviceWorker = fs.readFileSync(serviceWorkerPath, "utf8");

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
  serviceWorker.includes("nav-icons-v28") && serviceWorker.includes('"/admin-theme.css"'),
  "service worker cache must refresh the theme rebuild release",
  failures
);

if (failures.length) {
  console.error("Surface contrast checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Surface contrast checks passed (${lightSelectors.length} light, ${darkSelectors.length} dark selectors)`);
