const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const stylesPath = path.join(root, "web", "styles.css");
const appPath = path.join(root, "web", "app.js");
const indexPath = path.join(root, "web", "index.html");
const styles = fs.readFileSync(stylesPath, "utf8");
const app = fs.readFileSync(appPath, "utf8");
const index = fs.readFileSync(indexPath, "utf8");

const requiredMarkers = [
  "Surface contrast contract v3",
  "Location contrast contract v5",
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
  ".company-review-queue"
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

assert(index.includes('id="themeToggle"'), "missing authenticated theme toggle", failures);
assert(index.includes('src="/login-theme.js"'), "missing authenticated theme script", failures);
assert(styles.includes('.app-theme-toggle'), "missing authenticated theme toggle styles", failures);
assert(styles.includes(':root[data-theme="light"] body.role-admin'), "missing admin light theme contract", failures);
assert(styles.includes(':root[data-theme="light"] body.role-b2b'), "missing B2B light theme contract", failures);

const contrastChecks = [
  ["light text", "#0f172a", "#ffffff", 7],
  ["light muted", "#475569", "#ffffff", 4.5],
  ["light accent", "#1d4ed8", "#ffffff", 4.5],
  ["light warning", "#b45309", "#fff8db", 4.5],
  ["light danger", "#b91c1c", "#fff5f5", 4.5],
  ["dark text", "#f8fbff", "#111923", 7],
  ["dark muted", "#c8d6e8", "#111923", 4.5],
  ["dark accent", "#8fc5ff", "#111923", 4.5],
  ["dark warning", "#fcd56f", "#111923", 4.5],
  ["dark danger", "#fda4af", "#111923", 4.5]
];

for (const [label, foreground, background, minimum] of contrastChecks) {
  const ratio = contrastRatio(foreground, background);
  assert(ratio >= minimum, `${label} contrast ${ratio.toFixed(2)} below ${minimum}`, failures);
}

if (failures.length) {
  console.error("Surface contrast checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Surface contrast checks passed (${lightSelectors.length} light, ${darkSelectors.length} dark selectors)`);
