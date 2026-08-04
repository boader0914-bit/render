"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = (url) => {
  throw new Error(`Network calls are forbidden in B2B detail-sheet tests: ${url}`);
};

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");

function balancedRange(source, startIndex) {
  const open = source.indexOf("{", startIndex);
  assert.notEqual(open, -1, "expected opening brace");
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return { open, close: index, body: source.slice(open + 1, index) };
  }
  assert.fail("expected balanced block");
}

function functionRange(name) {
  const matcher = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = matcher.exec(app);
  assert.ok(match, `missing function ${name}`);
  const parameterOpen = app.indexOf("(", match.index);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let parameterClose = -1;
  for (let index = parameterOpen; index < app.length; index += 1) {
    const character = app[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0) {
      parameterClose = index;
      break;
    }
  }
  assert.notEqual(parameterClose, -1, `missing parameter close for ${name}`);
  return { match, range: balancedRange(app, parameterClose) };
}

function functionSource(name) {
  const { match, range } = functionRange(name);
  return app.slice(match.index, range.close + 1);
}

function functionBlock(name) {
  return functionRange(name).range.body;
}

function openingTagById(id) {
  const match = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, "i"));
  assert.ok(match, `missing #${id}`);
  return match[0];
}

function flatCssRules(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

// The detail sheet intentionally remains a sibling of the app shell so the
// overlay manager can make the application inert without disabling the dialog.
assert.equal((html.match(/id="detailSheet"/g) || []).length, 1, "#detailSheet must remain unique");
const appShellIndex = html.indexOf('class="app-shell"');
const footerIndex = html.indexOf('class="app-legal-footer"');
const sheetIndex = html.indexOf('id="detailSheet"');
assert.ok(appShellIndex >= 0 && footerIndex > appShellIndex && sheetIndex > footerIndex, "detail sheet must remain outside the inert app shell");

const detailSheet = openingTagById("detailSheet");
const sheetPanel = html.match(/<section\b[^>]*class="[^"]*sheet-panel[^"]*"[^>]*>/i)?.[0] || "";
assert.match(detailSheet, /class="[^"]*detail-sheet[^"]*"/);
assert.match(detailSheet, /\bhidden\b/);
assert.match(sheetPanel, /role="dialog"/);
assert.match(sheetPanel, /aria-modal="true"/);
assert.match(sheetPanel, /aria-labelledby="sheetTitle"/);
assert.match(sheetPanel, /tabindex="-1"/);
assert.match(html, /data-close-sheet[^>]*aria-label="[^"]+"/);

const sheetTabs = [...html.matchAll(/<button\b[^>]*data-sheet-tab="([^"]+)"[^>]*>/g)];
assert.deepEqual(sheetTabs.map((match) => match[1]), ["booking", "platform", "search"]);
for (const match of sheetTabs) {
  assert.match(match[0], /role="tab"/);
  assert.match(match[0], /aria-selected="(?:true|false)"/);
  assert.match(match[0], /aria-controls="sheetBody"/);
  assert.match(match[0], /tabindex="(?:0|-1)"/);
}
const sheetBodyTag = openingTagById("sheetBody");
assert.match(sheetBodyTag, /role="tabpanel"/);
assert.match(sheetBodyTag, /aria-labelledby="sheetTab/);
assert.match(sheetBodyTag, /tabindex="0"/);

const overlayBackground = functionBlock("accessibleOverlayBackgroundElements");
assert.match(overlayBackground, /\.app-shell/);
assert.match(overlayBackground, /\.app-legal-footer/);
assert.doesNotMatch(overlayBackground, /detailSheet/, "the active dialog must never be made inert");
assert.match(functionBlock("setAccessibleOverlayBackgroundInactive"), /\.inert\s*=/);
assert.match(functionBlock("setAccessibleOverlayBackgroundInactive"), /aria-hidden/);
assert.match(functionBlock("handleAccessibleOverlayKeydown"), /event\.key\s*===\s*["']Escape["']/);
assert.match(functionBlock("handleAccessibleOverlayKeydown"), /event\.key\s*!==\s*["']Tab["']/);
assert.match(functionBlock("openSheet"), /renderSheet\(\)[\s\S]*openAccessibleOverlay\(els\.detailSheet/);
assert.match(functionBlock("closeSheet"), /closeAccessibleOverlay\(els\.detailSheet\)/);
assert.match(functionBlock("renderSheet"), /aria-selected/);
assert.match(functionBlock("renderSheet"), /tabindex/);
assert.match(functionBlock("renderSheet"), /aria-labelledby/);

// Rendering a selected record is a pure presentation operation. It must not
// perform provider requests, mutate browser persistence, or embed an external URL.
for (const name of ["renderSheet", "renderSheetBooking", "renderSheetPlatform", "renderSheetSearch"]) {
  const source = functionSource(name);
  assert.doesNotMatch(source, /\bfetch\s*\(/, `${name} must not fetch`);
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage)\b/, `${name} must not mutate browser storage`);
  assert.doesNotMatch(source, /https?:\/\//i, `${name} must not embed an external request URL`);
  assert.doesNotMatch(source, /\/api\//, `${name} must not call an API`);
}

// Numeric state must be derived from provenance, not from a falsy/defaulted
// value. Exercise the actual helper in a VM to lock missing and observed zero
// apart without loading the application or touching data.
const metricContext = {
  finiteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  },
  optionalNumber(value) {
    if (value == null || value === "" || typeof value === "boolean") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  },
  weeklyRows(item, kind = "lodging") {
    return item?.__rows?.[kind] || [];
  },
};
vm.createContext(metricContext);
vm.runInContext(functionSource("sheetMetricPresentation"), metricContext);
const presentMetric = metricContext.sheetMetricPresentation;
const won = (value) => `${value}원`;

const missingMetric = presentMetric(0, { observed: false, formatValue: won });
assert.equal(missingMetric.state, "missing");
assert.notEqual(missingMetric.valueText, "0원", "an unobserved default zero must not be presented as measured revenue");

const notApplicableMetric = presentMetric(123, { applicable: false, observed: true, formatValue: won });
assert.equal(notApplicableMetric.state, "unavailable");

const pendingMetric = presentMetric(0, { pending: true, observed: false, formatValue: won });
assert.equal(pendingMetric.state, "pending");
assert.match(`${pendingMetric.valueText} ${pendingMetric.statusLabel}`, /계산 대기/);

const zeroMetric = presentMetric(0, { observed: true, formatValue: won });
assert.equal(zeroMetric.state, "zero");
assert.equal(zeroMetric.valueText, "0원");
assert.match(zeroMetric.statusLabel, /실제 0/);

const readyMetric = presentMetric(145, { observed: true, formatValue: won });
assert.equal(readyMetric.state, "ready");
assert.equal(readyMetric.valueText, "145원");

const invalidMetric = presentMetric(Number.NaN, { observed: true, formatValue: won });
assert.equal(invalidMetric.state, "missing");
assert.doesNotMatch(invalidMetric.valueText, /NaN|0원/, "an invalid source must not be formatted as a measured value");
const errorMetric = presentMetric(0, { error: true, observed: true, formatValue: won });
assert.equal(errorMetric.state, "error");

for (const presentation of [missingMetric, notApplicableMetric, pendingMetric, zeroMetric, readyMetric, invalidMetric, errorMetric]) {
  assert.ok(["ready", "zero", "missing", "pending", "unavailable", "error"].includes(presentation.state));
  assert.ok(["neutral", "info", "success", "warning", "danger"].includes(presentation.tone));
  assert.equal(typeof presentation.statusLabel, "string");
  assert.ok(presentation.statusLabel.length > 0);
}

vm.runInContext(functionSource("revenueObservationProfile"), metricContext);
const observeRevenue = metricContext.revenueObservationProfile;
const presentationForRevenue = (profile, value = 0) => presentMetric(value, {
  observed: profile.revenueObserved || profile.soldObservedZero,
  pending: profile.revenuePending,
  error: profile.revenueError,
  formatValue: won,
});

const crawlerDefaultDayUse = observeRevenue({
  dayUseItemCount: 0,
  dayUseWeeklyDays: 0,
  dayUseWeeklyTotalStock: 0,
  dayUseWeeklyTotalSoldOut: 0,
  dayUseWeeklyEstimatedRevenue: 0,
  dayUseWeeklyAdjustedRevenue: 0,
  dayUseWeeklyMissingPriceEstimatedRevenue: 0,
  dayUseWeeklyPricedSoldOut: 0,
  dayUseWeeklyMissingPriceSoldOut: 0,
}, "day", { sold: 0 }, "range");
assert.equal(crawlerDefaultDayUse.scopeObserved, false);
assert.equal(presentationForRevenue(crawlerDefaultDayUse).state, "missing", "crawler default day-use zeros are not observed revenue");

const observedDayUseZero = observeRevenue({
  dayUseItemCount: 1,
  dayUseTotalStock: 4,
  dayUseAvailableStock: 4,
  basisDayUseRevenue: 0,
  basisDayUseAdjustedRevenue: 0,
  basisDayUsePricedSoldOut: 0,
  basisDayUseMissingPriceSoldOut: 0,
}, "day", { sold: 0 }, "basis");
assert.equal(presentationForRevenue(observedDayUseZero).state, "zero");

const pendingDayUseRevenue = observeRevenue({
  dayUseItemCount: 1,
  dayUseTotalStock: 4,
  dayUseAvailableStock: 2,
  basisDayUseRevenue: 0,
  basisDayUseAdjustedRevenue: 0,
  basisDayUsePricedSoldOut: 0,
  basisDayUseMissingPriceSoldOut: 2,
}, "day", { sold: 2 }, "basis");
assert.equal(presentationForRevenue(pendingDayUseRevenue).state, "pending");

const precisionOnly = observeRevenue({ basisLodgingRevenuePrecisionRate: 0 }, "lodging", { sold: 0 }, "basis");
assert.equal(presentationForRevenue(precisionOnly).state, "missing", "precision-only defaults must not imply observed revenue");

const pendingLodgingRevenue = observeRevenue({ nightItemCount: 1, nightTotalStock: 4, nightAvailableStock: 2 }, "lodging", { sold: 2 }, "basis");
assert.equal(presentationForRevenue(pendingLodgingRevenue).state, "pending");

const observedLodgingZero = observeRevenue({
  nightItemCount: 1,
  nightTotalStock: 4,
  nightAvailableStock: 4,
  basisLodgingRevenue: 0,
  basisLodgingAdjustedRevenue: 0,
  basisLodgingMissingPriceSoldOut: 0,
}, "lodging", { sold: 0 }, "basis");
assert.equal(presentationForRevenue(observedLodgingZero).state, "zero");

const observedLodgingPositive = observeRevenue({ basisLodgingRevenue: 145 }, "lodging", { sold: 1 }, "basis");
assert.equal(presentationForRevenue(observedLodgingPositive, 145).state, "ready");
assert.equal(presentationForRevenue(crawlerDefaultDayUse).state, "missing");

const invalidRevenueSource = observeRevenue({ basisLodgingRevenue: "not-a-number" }, "lodging", { sold: 0 }, "missing");
assert.equal(presentationForRevenue(invalidRevenueSource).state, "error");

Object.assign(metricContext, {
  naverCouponInfo() { return { visible: false, named: false, names: "", detail: "수동 확인" }; },
  platformShortName(value) { return String(value || ""); },
  fmtNumber(value) { return String(value); },
  isAdminRole() { return false; },
});
vm.runInContext(functionSource("platformStatus"), metricContext);
vm.runInContext(functionSource("b2bPlatformModel"), metricContext);
const classifyPlatform = metricContext.platformStatus;
const modelPlatform = metricContext.b2bPlatformModel;
assert.equal(classifyPlatform({ sourceStatus: "exposed", status: "OTA 노출 확인" })[2], "ready");
assert.equal(classifyPlatform({ sourceStatus: "needs_manual", status: "확인 필요" })[2], "pending");
assert.equal(classifyPlatform({ sourceStatus: "not_found", status: "OTA 미사용 추정" })[2], "zero");
assert.equal(classifyPlatform({ sourceStatus: "auto_failed", status: "자동확인 실패" })[2], "error");
assert.equal(classifyPlatform({ uiPlaceholder: true })[2], "missing");
assert.equal(classifyPlatform({ status: "새로운 알 수 없는 상태" })[2], "pending", "unknown platform states fail closed to pending");

const pendingOnlyOta = modelPlatform({}, [
  { platform: "여기어때", sourceStatus: "needs_manual", status: "확인 필요" },
], { otaCheckNeeded: false });
assert.equal(pendingOnlyOta.hasOta, false);
assert.equal(pendingOnlyOta.metrics.find((metric) => metric.label === "OTA").state, "pending");
assert.notEqual(pendingOnlyOta.decision.label, "채널 보조 가능");

const mixedOta = modelPlatform({}, [
  { platform: "야놀자", sourceStatus: "exposed", status: "OTA 노출 확인" },
  { platform: "여기어때", sourceStatus: "needs_manual", status: "확인 필요" },
], { otaCheckNeeded: false });
assert.equal(mixedOta.hasOta, true);
assert.equal(mixedOta.visibleRows.length, 1, "only ready platform rows contribute to exposed channel counts");

assert.ok((app.match(/data-sheet-value-state=/g) || []).length >= 4, "detail metrics must expose source-aware state to DOM and assistive tests");
assert.match(app, /sheet-value-state-\$\{[^}]*(?:\.state|valueState)[^}]*\}/, "detail metrics must retain a non-color semantic state class");
assert.ok((app.match(/sheetMetricPresentation\s*\(/g) || []).length >= 3, "sheet renderers must use the shared state helper");
for (const name of ["sheetRevenuePanel", "b2bPlatformModel", "sheetSearchTrafficPresentation"]) {
  assert.match(functionBlock(name), /sheetMetricPresentation\s*\(/, `${name} must use source-aware metric presentation`);
}
const revenuePanelSource = functionBlock("sheetRevenuePanel");
assert.doesNotMatch(revenuePanelSource, /\.basis\s*!==\s*["']missing["']/, "calculation basis must not stand in for revenue provenance");
assert.match(revenuePanelSource, /revenueObserved/);
assert.match(revenuePanelSource, /revenuePending/);
assert.match(revenuePanelSource, /revenueError/);
assert.match(revenuePanelSource, /const totalPending\s*=\s*!totalError\s*&&\s*\(lodgingPending\s*\|\|\s*dayUsePending\)/);
assert.match(functionBlock("b2bPlatformModel"), /valueState\s*===\s*["']ready["']/, "only classified ready rows may count as exposed platforms");
for (const name of ["renderB2BPlatformBrief", "renderB2BSearchBrief", "renderSheetPlatform", "renderSheetSearch"]) {
  assert.match(functionBlock(name), /data-sheet-value-state=/, `${name} must expose state in rendered markup`);
}

// The sheet is outside .app-shell, so it owns direct semantic surface aliases.
const semanticStart = /\.detail-sheet\s*\{\s*--sheet-canvas-surface:/.exec(css)?.index ?? -1;
const semanticMarker = css.indexOf("/* Detail sheet semantic contrast and state contract v1. */");
const semanticEnd = css.indexOf("/* End detail sheet semantic contrast and state contract v1. */");
assert.ok(semanticStart >= 0 && semanticMarker > semanticStart, "missing bounded detail-sheet semantic contract");
assert.ok(semanticEnd > semanticMarker, "missing detail-sheet semantic contract end marker");
const semanticBase = css.slice(semanticStart, semanticMarker);
const semanticContract = css.slice(semanticMarker, semanticEnd);
for (const token of [
  "--sheet-canvas-surface",
  "--sheet-section-surface",
  "--sheet-card-surface",
  "--sheet-card-border",
  "--sheet-tone",
  "--sheet-tone-border",
  "--sheet-tone-surface",
]) {
  assert.ok(semanticBase.includes(token), `missing detail sheet token ${token}`);
}
assert.match(semanticBase, /\.sheet-panel[\s\S]*?background:\s*var\(--sheet-canvas-surface/);
assert.match(semanticContract, /\.sheet-b2b-(?:detail|insight|platform)[\s\S]*?background:\s*var\(--sheet-tone-surface\)/);
assert.match(semanticContract, /\.sheet-b2b-(?:platform-grid|detail-grid)[\s\S]*?background:\s*var\(--sheet-card-surface\)/);
assert.doesNotMatch(`${semanticBase}\n${semanticContract}`, /background(?:-color)?\s*:[^;{}]*(?:#fff(?:fff)?\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i, "base detail surfaces must not leak a hardcoded white card into dark mode");

for (const tone of ["info", "success", "warning", "danger"]) {
  assert.ok(css.includes(`var(--color-status-${tone})`), `missing semantic ${tone} token usage`);
}
assert.ok(css.includes("var(--color-accent-secondary)"), "opportunity/accent state must use the semantic secondary accent");
assert.match(css, /\.detail-sheet \[data-sheet-value-state\]\s*\{/);
for (const state of ["zero", "missing", "pending", "unavailable", "error"]) {
  assert.match(css, new RegExp(`(?:sheet-value-state-${state}|data-sheet-value-state=["']${state}["'])`), `missing sheet value-state styling for ${state}`);
}

assert.match(css, /\.detail-sheet :is\([^)]*\.manual[^)]*\)\s*\{/);
assert.match(css, /\.detail-sheet :is\([^)]*\.manual[^)]*\)\s*\{[^}]*--sheet-tone:\s*var\(--color-status-success\)/s);
const manualConfidenceRule = flatCssRules(css).find(({ selector }) => selector === ".search-row.confidence-row.manual");
assert.ok(manualConfidenceRule, "missing manual confidence row rule");
assert.doesNotMatch(manualConfidenceRule.body, /#f6fef9|#bbf7d0/i, "manual confidence row must not retain a light-only hardcoded surface");

const detailPackRule = flatCssRules(css).find(({ selector }) => selector === ".b2b-detail-pack");
assert.ok(detailPackRule, "missing B2B detail pack rule");
assert.match(detailPackRule.body, /var\(--sheet-card-surface,\s*var\(--color-surface-subtle\)\)/);
assert.equal(flatCssRules(css).filter(({ selector }) => selector.includes("body.role-b2b") && selector.includes(".b2b-detail-pack")).length, 0, "B2B detail packs must not receive a theme-agnostic dark role override");

const statusRuleIndex = css.indexOf(":is(body.role-admin, body.role-b2b) #detailSheet [data-sheet-value-state] em.sheet-value-status");
const genericAdminEmIndex = css.indexOf("body.role-admin .detail-sheet :is(\n  .sheet-booking-bars");
assert.ok(statusRuleIndex > genericAdminEmIndex, "state status color must follow the generic administrator em rule");
assert.match(css.slice(statusRuleIndex, statusRuleIndex + 700), /color:\s*var\(--sheet-value-tone[^;]*!important/);
assert.match(css, /\.structure-badge\[data-sheet-value-state\]\s*\{[^}]*color:\s*var\(--sheet-value-tone,[^;]*!important/s, "non-ready sheet status badges must use the source-aware value-state tone");
assert.match(css, /\.structure-badge:is\([\s\S]*?data-sheet-value-state="ready"[\s\S]*?data-sheet-value-state="zero"[\s\S]*?\)\s*\{[^}]*color:\s*var\(--sheet-tone,[^;]*!important/s, "observed sheet status badges must preserve their semantic quality tone");
assert.match(css, /\.progress\s*\{[^}]*background:\s*var\(--sheet-section-surface,\s*var\(--color-surface-subtle\)\)/s);
assert.match(css, /\.sheet-history-grid strong\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
assert.match(css, /\[data-sheet-value-state="missing"\]\s*\{[^}]*--sheet-value-tone:\s*var\(--color-text-secondary\)/s);
assert.match(css, /\[data-sheet-value-state="pending"\]\s*\{[^}]*--sheet-value-tone:\s*var\(--color-status-warning\)/s);
assert.match(css, /a\.platform-row\[data-sheet-value-state\]:hover\s*\{[^}]*background:\s*color-mix/s);
assert.match(css, /a\.platform-row\[data-sheet-value-state\]:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-border-focus\)[^}]*box-shadow:\s*var\(--focus-ring\)/s, "platform links must own a valid high-contrast focus outline instead of treating the shadow token as outline syntax");

const unsafeLegacySheetRules = flatCssRules(css).filter(({ selector, body }) => (
  selector.includes("body.role-b2b") &&
  /\.sheet-panel|\.sheet-tabs button|\.sheet-date-bar (?:>|small)|\.sheet-weekday-bars (?:b|strong)/.test(selector) &&
  /#121822|#8fc7ff|#b8c4d6/.test(body)
));
assert.deepEqual(unsafeLegacySheetRules, [], "detail sheet must not inherit an unscoped hardcoded dark role surface");
const unsafeActiveTabRules = flatCssRules(css).filter(({ selector, body }) => selector.includes("body.role-b2b .sheet-tabs button.active") && /linear-gradient/.test(body));
assert.deepEqual(unsafeActiveTabRules, [], "light-mode sheet tabs must not inherit a hardcoded dark active gradient");
assert.match(css, /:root\[data-theme="light"\][\s\S]*?:where\([\s\S]*?\.sheet-panel,[\s\S]*?\)\s*\{[^}]*background:\s*var\(--color-surface-default\)\s*!important/s);

// Any legacy hardcoded pale administrator sheet rule must be explicitly light
// scoped; an unscoped rule would override the direct dark semantic contract.
const paleBackground = /background(?:-color)?\s*:[^;{}]*(?:#fff(?:fff)?\b|#f[5-9a-f][0-9a-f]{4}\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i;
const hardcodedAdminSheetRules = flatCssRules(css).filter(({ selector, body }) => selector.includes("body.role-admin") && selector.includes(".detail-sheet") && paleBackground.test(body));
for (const { selector } of hardcodedAdminSheetRules) {
  assert.match(selector, /:root\[data-theme=["']light["']\]/, `hardcoded light sheet rule is not theme scoped: ${selector}`);
}

assert.match(css, /\.sheet-tabs button\s*\{[^}]*min-height:\s*var\(--touch-target-min\)/s);
assert.match(css, /\.close-button\s*\{[^}]*width:\s*var\(--touch-target-min\)[^}]*height:\s*var\(--touch-target-min\)/s);
assert.match(css, /@media\s*\(max-width:\s*420px\)[\s\S]*?\.detail-sheet \.sheet-body :is\([\s\S]*?input:not\(\[type="checkbox"\]\)[\s\S]*?textarea:not\(\.sr-only\)[\s\S]*?min-height:\s*var\(--touch-target-min\)/s, "visible mobile sheet form controls must provide a 44px touch target while preserving screen-reader-only inputs");
assert.match(css, /\.sheet-head h2,\s*\.drawer-head h2\s*\{[^}]*overflow-wrap:\s*anywhere/s);
assert.match(css, /\.sheet-body\s*\{[^}]*overflow-y:\s*auto/s);
assert.match(css, /@media\s*\(max-width:\s*340px\)[\s\S]*?\.sheet-history-grid,[\s\S]*?\.revenue-day-grid,[\s\S]*?grid-template-columns:\s*1fr/s);
assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.sheet-history-grid,[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
assert.match(css, /:focus-visible/);
assert.match(css, /var\(--focus-ring\)|outline:\s*2px solid var\(--color-border-focus\)/);

console.log("B2B detail sheet UI contracts passed.");
