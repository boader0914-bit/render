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
  ".b2b-home-status-strip",
  ".b2b-home-journey article",
  ".b2b-simple-summary",
  ".b2b-interest-workbench",
  ".b2b-interest-lodge-card",
  ".b2b-my-lodge-editor-head",
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

function cssColorToRgba(value) {
  const source = String(value || "").trim();
  const hex = hexToRgb(source);
  if (hex) return { ...hex, a: 1 };
  const match = source.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!match) return null;
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4])
  };
}

function composite(foreground, background) {
  const alpha = Math.max(0, Math.min(1, foreground.a));
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha)
  };
}

function filteredLightColor(color) {
  const r = 255 - color.r;
  const g = 255 - color.g;
  const b = 255 - color.b;
  const clamp = (channel) => Math.max(0, Math.min(255, channel));
  return {
    r: clamp(-0.574 * r + 1.43 * g + 0.144 * b),
    g: clamp(0.426 * r + 0.43 * g + 0.144 * b),
    b: clamp(0.426 * r + 1.43 * g - 0.856 * b)
  };
}

function rgbContrastRatio(foreground, background) {
  const relativeLuminance = (color) => (
    0.2126 * luminancePart(color.r)
    + 0.7152 * luminancePart(color.g)
    + 0.0722 * luminancePart(color.b)
  );
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function lastCustomProperty(name) {
  const matches = [...styles.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))];
  return matches.length ? matches[matches.length - 1][1].trim() : "";
}

assert(index.includes('id="themeToggle"'), "missing authenticated theme toggle", failures);
assert(index.includes('src="/login-theme.js"'), "missing authenticated theme script", failures);
assert(styles.includes('.app-theme-toggle'), "missing authenticated theme toggle styles", failures);
assert(styles.includes(':is(body.role-admin, body.role-b2b) .app-header :where(button, a):focus-visible'), "missing authenticated header focus contract", failures);
assert(styles.includes('outline: 3px solid #8bc2ff !important'), "missing authenticated header focus outline", failures);
assert(styles.includes(':root[data-theme="light"] body.role-admin'), "missing admin light theme contract", failures);
assert(styles.includes(':root[data-theme="light"] body.role-b2b'), "missing B2B light theme contract", failures);

const directLightBodyBlocks = [...styles.matchAll(
  /:root\[data-theme="light"\] body\.role-admin,\s*:root\[data-theme="light"\] body\.role-b2b\s*\{([^{}]*)\}/g
)];
assert(directLightBodyBlocks.length > 0, "missing exact light body rule", failures);
for (const [, declarations] of directLightBodyBlocks) {
  assert(!/\bfilter\s*:/.test(declarations), "light body must not establish a filtered fixed-position containing block", failures);
}
assert(
  styles.includes('body.role-admin > :where(.app-shell, .app-legal-footer)')
    && styles.includes('body.role-b2b > :where(.app-shell, .app-legal-footer)'),
  "missing segmented light application filter",
  failures
);
assert(
  styles.includes('body.role-admin > :where(.control-drawer, .detail-sheet) :where(.drawer-panel, .sheet-panel)')
    && styles.includes('body.role-b2b > :where(.control-drawer, .detail-sheet) :where(.drawer-panel, .sheet-panel)'),
  "missing segmented light overlay panel filter",
  failures
);
assert(
  /\.detail-sheet,\s*\.control-drawer\s*\{[^{}]*position:\s*fixed;[^{}]*inset:\s*0;/s.test(styles),
  "drawer and detail sheet must remain fixed to the viewport",
  failures
);

const lightTokens = Object.fromEntries([
  "light-mode-component-border",
  "light-mode-component-border-strong",
  "light-mode-control-surface",
  "light-mode-panel-surface",
  "light-mode-placeholder",
  "light-mode-focus-color",
  "light-mode-warning-border",
  "light-mode-danger-border"
].map((name) => [name, cssColorToRgba(lastCustomProperty(name))]));
for (const [name, value] of Object.entries(lightTokens)) {
  assert(Boolean(value), `missing or invalid light mode color token: --${name}`, failures);
}

if (Object.values(lightTokens).every(Boolean)) {
  const panel = lightTokens["light-mode-panel-surface"];
  const control = lightTokens["light-mode-control-surface"];
  const displayedPanel = filteredLightColor(panel);
  const displayedControl = filteredLightColor(control);
  const displayedPlaceholder = filteredLightColor(lightTokens["light-mode-placeholder"]);
  const displayedFocus = filteredLightColor(lightTokens["light-mode-focus-color"]);
  const tokenChecks = [
    ["light placeholder", rgbContrastRatio(displayedPlaceholder, displayedControl), 4.5],
    ["light component border", rgbContrastRatio(filteredLightColor(composite(lightTokens["light-mode-component-border"], panel)), displayedPanel), 3],
    ["light component border against control", rgbContrastRatio(filteredLightColor(composite(lightTokens["light-mode-component-border"], control)), displayedControl), 3],
    ["light strong border", rgbContrastRatio(filteredLightColor(composite(lightTokens["light-mode-component-border-strong"], panel)), displayedPanel), 3],
    ["light warning border", rgbContrastRatio(filteredLightColor(composite(lightTokens["light-mode-warning-border"], panel)), displayedPanel), 3],
    ["light danger border", rgbContrastRatio(filteredLightColor(composite(lightTokens["light-mode-danger-border"], panel)), displayedPanel), 3],
    ["light focus against panel", rgbContrastRatio(displayedFocus, displayedPanel), 3],
    ["light focus against control", rgbContrastRatio(displayedFocus, displayedControl), 3]
  ];
  for (const [label, ratio, minimum] of tokenChecks) {
    assert(ratio >= minimum, `${label} contrast ${ratio.toFixed(2)} below ${minimum}`, failures);
  }
}

for (const marker of [
  "background: #eef3f9 !important",
  "border-color: var(--light-mode-component-border) !important",
  "border-color: var(--light-mode-warning-border) !important",
  "border-color: var(--light-mode-danger-border) !important",
  "outline: 3px solid var(--light-mode-focus-color) !important"
]) {
  assert(styles.includes(marker), `missing verified light token usage: ${marker}`, failures);
}

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
