"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.fetch = (url) => {
  throw new Error(`Network calls are forbidden in surface contrast tests: ${url}`);
};

const root = path.resolve(__dirname, "..");
const styles = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");

const REQUIRED_COLOR_TOKENS = [
  "color-canvas",
  "color-surface-default",
  "color-surface-subtle",
  "color-surface-raised",
  "color-text-primary",
  "color-text-secondary",
  "color-text-tertiary",
  "color-text-inverse",
  "color-border-default",
  "color-border-strong",
  "color-border-focus",
  "color-action-primary",
  "color-action-primary-hover",
  "color-action-primary-pressed",
  "color-status-info",
  "color-status-success",
  "color-status-warning",
  "color-status-danger",
  "color-disabled-surface",
  "color-disabled-text",
  "color-disabled-border",
  "color-overlay-backdrop",
];

const REQUIRED_STYLE_MARKERS = [
  "Surface contrast contract v3",
  "Location contrast contract v5",
  "Dark transparent card contract v7",
  "[data-surface=\"light\"]",
  "[data-surface=\"dark\"]",
];

const LIGHT_SURFACE_SELECTORS = [
  ".b2b-secondary-context",
  ".b2b-competition-toolbar",
  ".b2b-competition-selection",
  ".b2b-map-view-controls",
  ".b2b-map-status",
  ".b2b-map-company-list",
  ".b2b-map-company-row",
  ".b2b-demand-observed-grid > article",
  ".b2b-demand-text-alternative",
  ".b2b-account-workbench",
  ".b2b-account-summary > article",
  ".b2b-account-section",
  ".admin-operations-context",
  ".admin-operations-context-grid > div",
  ".admin-member-option",
  ".admin-member-detail-workbench",
  ".admin-member-feedback",
  ".admin-operation-status",
  ".run-apply-linked-queue",
  ".run-apply-linked-list article",
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
  ".location-summary-grid > *",
];

const DARK_SURFACE_SELECTORS = [
  ".b2b-secondary-context",
  ".b2b-competition-toolbar",
  ".b2b-competition-selection",
  ".b2b-map-company-list",
  ".b2b-demand-text-alternative",
  ".b2b-account-workbench",
  ".b2b-account-section",
  ".admin-operations-context",
  ".admin-operations-context-grid > div",
  ".admin-member-option",
  ".admin-member-detail-workbench",
  ".admin-member-feedback",
  ".admin-operation-status",
  ".run-apply-linked-queue",
  ".run-apply-linked-list article",
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
  ".company-review-queue",
];

const DARK_TRANSPARENT_CARD_SELECTORS = [
  "article",
  "[data-surface=\"light\"]",
  ".admin-card",
  ".admin-console-panel",
  ".admin-db-applied-values",
  ".admin-db-review-flash",
  ".admin-db-channel-panel",
  ".admin-db-channel-compare",
  ".admin-db-channel-row",
  ".admin-operations-context",
  ".admin-member-detail-workbench",
  ".advanced-box",
  ".summary-card",
  ".report-card",
  ".report-score-card",
  ".company-card",
  ".company-cross-list",
  ".company-verification-lane",
  ".b2b-search-panel",
  ".b2b-onboarding",
  ".b2b-live-search-panel",
  ".b2b-home-workspace",
  ".b2b-interest-workbench",
  ".b2b-account-workbench",
  ".b2b-secondary-context",
  ".b2b-simple-card",
  ".b2b-brief-card",
  ".b2b-correlation-card",
  ".map-card",
  ".region-card",
  ".demand-chart",
  ".demand-table-card",
  ".demand-company-card",
  ".demand-rule-box",
  ".history-card",
  ".notice-card",
  ".location-card",
  ".run-apply-linked-queue",
];

const APP_SURFACE_CONTRACTS = [
  'class="b2b-secondary-context',
  'class="b2b-map-company-list-head',
  'data-b2b-demand-context="true"',
  'data-b2b-account-workbench="true"',
  'class="admin-operations-context',
  'data-surface="light"',
  'data-surface="dark"',
  'class="admin-db-company',
  'class="admin-db-applied-values',
  'class="admin-db-channel-row',
  'class="demand-company-card"',
  'class="demand-chart',
];

for (const marker of REQUIRED_STYLE_MARKERS) {
  assert.ok(styles.includes(marker), `missing style marker: ${marker}`);
}
for (const selector of LIGHT_SURFACE_SELECTORS) {
  assert.ok(styles.includes(selector), `missing light surface selector: ${selector}`);
}
for (const selector of DARK_SURFACE_SELECTORS) {
  assert.ok(styles.includes(selector), `missing dark surface selector: ${selector}`);
}
const darkTransparentMarker = "/* Dark transparent card contract v7: cards never reintroduce light surfaces. */";
const lightCompatibilityMarker = "/* Light theme compatibility: legacy role selectors consume real light surfaces. */";
const darkTransparentStart = styles.indexOf(darkTransparentMarker);
const lightCompatibilityStart = styles.indexOf(lightCompatibilityMarker);
assert.ok(darkTransparentStart > styles.indexOf("Surface contrast contract v4"), "transparent dark-card contract must follow legacy surface overrides");
assert.ok(lightCompatibilityStart > darkTransparentStart, "light compatibility rules must remain separate from the dark-card contract");
const darkTransparentContract = styles.slice(darkTransparentStart, lightCompatibilityStart);
assert.match(darkTransparentContract, /:root\[data-theme="dark"\]/, "transparent card rules must be dark-theme scoped");
assert.match(darkTransparentContract, /background:\s*transparent\s*!important\s*;/, "dark cards must reset background shorthand");
assert.match(darkTransparentContract, /background-color:\s*transparent\s*!important\s*;/, "dark cards must explicitly expose a transparent color");
assert.match(darkTransparentContract, /background-image:\s*none\s*!important\s*;/, "dark cards must remove legacy gradients");
assert.doesNotMatch(darkTransparentContract, /linear-gradient\s*\(/i, "dark transparent cards must not retain gradients");
assert.doesNotMatch(darkTransparentContract, /background[^;{}]*(?:#fff|rgb\s*\(\s*255|rgba\s*\(\s*255|var\(\s*--color-surface)/i, "dark transparent cards must not reintroduce a light or opaque semantic surface");
const darkTransparentBaseEnd = darkTransparentContract.indexOf("\n}\n\n");
assert.ok(darkTransparentBaseEnd > 0, "transparent dark-card base rule must be bounded");
const darkTransparentBaseRule = darkTransparentContract.slice(0, darkTransparentBaseEnd + 2);
assert.doesNotMatch(darkTransparentBaseRule, /\bborder-color\s*:/, "transparent cards must preserve selected and active border cues");
assert.doesNotMatch(darkTransparentBaseRule, /\bbox-shadow\s*:/, "transparent cards must preserve inset selection cues");
assert.match(styles, /\.b2b-interest-lodge-card\.is-selected\s*\{[^}]*border-color:[^}]*box-shadow:/s, "selected interest cards must retain border and inset cues");
assert.match(styles, /\.admin-task-list article\.active\s*\{[^}]*border-color:/s, "active administrator task cards must retain a border cue");
assert.match(styles, /\.b2b-home-journey article\.active,\s*body\.role-b2b \.b2b-home-journey article\.done\s*\{[^}]*border-color:/s, "active and completed journey cards must retain a border cue");
for (const selector of DARK_TRANSPARENT_CARD_SELECTORS) {
  assert.ok(darkTransparentContract.includes(selector), `missing transparent dark-card selector: ${selector}`);
}
for (const contract of APP_SURFACE_CONTRACTS) {
  assert.ok(app.includes(contract), `missing app surface contract: ${contract}`);
}

function rules(source) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

function declarations(body) {
  const result = new Map();
  for (const match of body.matchAll(/--([\w-]+)\s*:\s*([^;{}]+);/g)) {
    result.set(match[1], match[2].trim());
  }
  return result;
}

function exactRootSelector(selector) {
  return selector.split(",").some((part) => part.trim() === ":root");
}

function exactThemeRootSelector(selector, theme) {
  const matcher = new RegExp(`^:root\\[data-theme=(?:["']${theme}["']|${theme})\\]$`);
  return selector.split(",").some((part) => matcher.test(part.trim()));
}

function propertiesFor(selectorPredicate) {
  const result = new Map();
  for (const rule of rules(css)) {
    if (!selectorPredicate(rule.selector)) continue;
    for (const [name, value] of declarations(rule.body)) result.set(name, value);
  }
  return result;
}

const sharedProperties = propertiesFor(exactRootSelector);
const themeProperties = Object.fromEntries(["light", "dark"].map((theme) => [
  theme,
  propertiesFor((selector) => exactThemeRootSelector(selector, theme)),
]));

for (const theme of ["light", "dark"]) {
  for (const token of REQUIRED_COLOR_TOKENS) {
    assert.ok(themeProperties[theme].has(token), `${theme} theme must explicitly define --${token}`);
  }
}

const lightColorSet = [...themeProperties.light.keys()].filter((name) => name.startsWith("color-")).sort();
const darkColorSet = [...themeProperties.dark.keys()].filter((name) => name.startsWith("color-")).sort();
assert.deepEqual(lightColorSet, darkColorSet, "light and dark themes must expose the same semantic color-token set");

assert.doesNotMatch(css, /\b(?:invert|hue-rotate)\s*\(/i, "native themes must not use invert or hue-rotate filters");
assert.doesNotMatch(
  css,
  /:root\[data-theme=[^\]]+\][^{]*(?:img|video|canvas|svg)[^{]*\{[^{}]*\bfilter\s*:/i,
  "media and graphics must not need theme-specific re-inversion",
);

const REQUIRED_ALIASES = new Map([
  ["bg", "color-canvas"],
  ["panel", "color-surface-default"],
  ["ink", "color-text-primary"],
  ["muted", "color-text-secondary"],
  ["weak", "color-text-tertiary"],
  ["line", "color-border-default"],
  ["line-strong", "color-border-strong"],
  ["blue", "color-action-primary"],
  ["blue-dark", ["color-action-primary-hover", "color-action-primary-pressed"]],
  ["green", "color-status-success"],
  ["orange", "color-status-warning"],
  ["red", "color-status-danger"],
  ["ui-color-canvas", "color-canvas"],
  ["ui-color-surface", "color-surface-default"],
  ["ui-color-surface-subtle", "color-surface-subtle"],
  ["ui-color-text", "color-text-primary"],
  ["ui-color-text-muted", "color-text-secondary"],
  ["ui-color-border", "color-border-default"],
  ["ui-color-accent", "color-action-primary"],
  ["ui-color-success", "color-status-success"],
  ["ui-color-warning", "color-status-warning"],
  ["ui-color-danger", "color-status-danger"],
]);

function allPropertyValues(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`--${escaped}\\s*:\\s*([^;{}]+);`, "g"))].map((match) => match[1].trim());
}

for (const [alias, semanticContract] of REQUIRED_ALIASES) {
  const semanticTokens = Array.isArray(semanticContract) ? semanticContract : [semanticContract];
  const values = allPropertyValues(alias);
  assert.ok(values.length, `missing legacy compatibility alias --${alias}`);
  for (const value of values) {
    const matched = semanticTokens.some((semantic) => new RegExp(`var\\(\\s*--${semantic}(?:\\s*[,)]|\\s*\\))`).test(value));
    assert.ok(matched, `--${alias} must reference ${semanticTokens.map((name) => `--${name}`).join(" or ")}, received ${value}`);
  }
}

function hexToRgba(value) {
  const source = String(value || "").trim();
  const short = source.match(/^#([0-9a-f]{3}|[0-9a-f]{4})$/i);
  if (short) {
    const chars = short[1].split("").map((char) => char + char);
    return {
      r: parseInt(chars[0], 16),
      g: parseInt(chars[1], 16),
      b: parseInt(chars[2], 16),
      a: chars[3] ? parseInt(chars[3], 16) / 255 : 1,
    };
  }
  const long = source.match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!long) return null;
  return {
    r: parseInt(long[1].slice(0, 2), 16),
    g: parseInt(long[1].slice(2, 4), 16),
    b: parseInt(long[1].slice(4, 6), 16),
    a: long[1].length === 8 ? parseInt(long[1].slice(6, 8), 16) / 255 : 1,
  };
}

function rgbToRgba(value) {
  const match = String(value || "").trim().match(
    /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i,
  );
  if (!match) return null;
  const alpha = match[4]
    ? (match[4].endsWith("%") ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]))
    : 1;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
}

function resolveCustomProperty(name, properties, seen = new Set()) {
  assert.ok(!seen.has(name), `circular CSS custom property: --${[...seen, name].join(" -> --")}`);
  seen.add(name);
  const value = properties.get(name);
  assert.ok(value, `missing CSS custom property --${name}`);
  const variable = value.match(/^var\(\s*--([\w-]+)(?:\s*,[\s\S]*)?\)$/);
  if (!variable) return value;
  return resolveCustomProperty(variable[1], properties, seen);
}

function colorFor(theme, token) {
  const properties = new Map([...sharedProperties, ...themeProperties[theme]]);
  const raw = resolveCustomProperty(token, properties);
  const color = hexToRgba(raw) || rgbToRgba(raw);
  assert.ok(color, `${theme} --${token} must resolve to a literal hex/rgb color, received ${raw}`);
  assert.equal(color.a, 1, `${theme} --${token} must be opaque for contrast calculation`);
  return color;
}

function luminancePart(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground, background) {
  const luminance = (color) => (
    0.2126 * luminancePart(color.r)
    + 0.7152 * luminancePart(color.g)
    + 0.0722 * luminancePart(color.b)
  );
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

const TEXT_BACKGROUNDS = ["color-canvas", "color-surface-default", "color-surface-subtle", "color-surface-raised"];
const contrastContracts = [];
for (const foreground of ["color-text-primary", "color-text-secondary", "color-text-tertiary"]) {
  for (const background of TEXT_BACKGROUNDS) contrastContracts.push([foreground, background, 4.5]);
}
for (const background of ["color-action-primary", "color-action-primary-hover", "color-action-primary-pressed"]) {
  contrastContracts.push(["color-text-inverse", background, 4.5]);
}
for (const foreground of ["color-status-info", "color-status-success", "color-status-warning", "color-status-danger"]) {
  contrastContracts.push([foreground, "color-surface-default", 4.5]);
  contrastContracts.push([foreground, "color-canvas", 4.5]);
}
for (const foreground of ["color-border-default", "color-border-strong", "color-border-focus"]) {
  contrastContracts.push([foreground, "color-canvas", 3]);
  contrastContracts.push([foreground, "color-surface-default", 3]);
}
contrastContracts.push(["color-disabled-text", "color-disabled-surface", 3]);
contrastContracts.push(["color-disabled-border", "color-disabled-surface", 3]);

for (const theme of ["light", "dark"]) {
  for (const [foregroundToken, backgroundToken, minimum] of contrastContracts) {
    const ratio = contrastRatio(colorFor(theme, foregroundToken), colorFor(theme, backgroundToken));
    assert.ok(
      ratio >= minimum,
      `${theme} ${foregroundToken} on ${backgroundToken} contrast ${ratio.toFixed(2)} is below ${minimum}:1`,
    );
  }
}

const LEGACY_REFERENCE_CONTRASTS = [
  ["light text", "#0f172a", "#ffffff", 7],
  ["light muted", "#475569", "#ffffff", 4.5],
  ["light accent", "#1d4ed8", "#ffffff", 4.5],
  ["light warning", "#b45309", "#fff8db", 4.5],
  ["light danger", "#b91c1c", "#fff5f5", 4.5],
  ["dark text", "#f8fbff", "#111923", 7],
  ["dark muted", "#c8d6e8", "#111923", 4.5],
  ["dark accent", "#8fc5ff", "#111923", 4.5],
  ["dark warning", "#fcd56f", "#111923", 4.5],
  ["dark danger", "#fda4af", "#111923", 4.5],
];
for (const [label, foreground, background, minimum] of LEGACY_REFERENCE_CONTRASTS) {
  const ratio = contrastRatio(hexToRgba(foreground), hexToRgba(background));
  assert.ok(ratio >= minimum, `${label} reference contrast ${ratio.toFixed(2)} is below ${minimum}:1`);
}

assert.ok(index.includes('id="themeToggle"'), "authenticated shell must retain its theme toggle");
assert.ok(index.indexOf('src="/login-theme.js"') < index.indexOf('href="/styles.css"'), "theme bootstrap must run before application CSS loads");
assert.match(styles, /:focus-visible/);
assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);

console.log(
  `Native semantic theme contrast checks passed (${LIGHT_SURFACE_SELECTORS.length} light, ${DARK_SURFACE_SELECTORS.length} dark, ${DARK_TRANSPARENT_CARD_SELECTORS.length} transparent dark-card selectors; ${REQUIRED_COLOR_TOKENS.length} shared color tokens)`,
);
