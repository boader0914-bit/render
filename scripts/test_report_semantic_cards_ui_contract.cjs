"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = (url) => {
  throw new Error(`External requests are forbidden in report semantic card tests: ${url}`);
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

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "semantic report work must not introduce duplicate ids");
for (const id of ["reportPanel", "reportBody"]) {
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `#${id} must remain unique`);
}

const helperContext = {
  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },
};
vm.createContext(helperContext);
vm.runInContext('const REPORT_TONES = new Set(["neutral", "info", "success", "warning", "danger", "opportunity"]);', helperContext);
for (const name of [
  "summaryIcon",
  "normalizedReportTone",
  "decisionReportTone",
  "reportSemanticIconHtml",
  "reportMetricCardHtml",
  "reportInsightItemHtml",
]) {
  vm.runInContext(functionSource(name), helperContext);
}

for (const tone of ["neutral", "info", "success", "warning", "danger", "opportunity"]) {
  assert.equal(helperContext.normalizedReportTone(tone), tone, `${tone} must remain a supported report tone`);
}
assert.equal(helperContext.normalizedReportTone("unexpected"), "neutral", "unknown report tones must fail safely to neutral");
assert.equal(helperContext.decisionReportTone("hot"), "success", "strong demand is a positive observation, not an error");
assert.equal(helperContext.decisionReportTone("watch"), "warning");
assert.equal(helperContext.decisionReportTone("error"), "danger");
assert.equal(helperContext.decisionReportTone("growth"), "opportunity");

const successCard = helperContext.reportMetricCardHtml({
  key: "sales-rate",
  label: "객실 판매율",
  value: "95%",
  note: "189/199개 추정",
  state: "ready",
  statusLabel: "판매 관측",
  tone: "success",
  icon: "rate",
});
assert.match(successCard, /class="report-semantic-card report-tone-success"/);
assert.match(successCard, /data-report-card="sales-rate"/);
assert.match(successCard, /data-report-tone="success"/);
assert.match(successCard, /data-metric-state="ready"/);
assert.match(successCard, /<svg[^>]*aria-hidden="true"/);
assert.match(successCard, /판매 관측/);
assert.doesNotMatch(successCard, /role="button"|tabindex=/, "read-only metrics must not masquerade as controls");

const neutralZeroCard = helperContext.reportMetricCardHtml({
  key: "contact-candidates",
  label: "컨택 후보",
  value: "0",
  state: "zero",
  statusLabel: "후보 없음",
  tone: "neutral",
  icon: "candidate",
});
assert.match(neutralZeroCard, /data-report-tone="neutral"/);
assert.match(neutralZeroCard, /data-metric-state="zero"/);
assert.match(neutralZeroCard, /후보 없음/);
assert.doesNotMatch(neutralZeroCard, /report-tone-danger/, "a valid zero must never be presented as an error");

const escapedUnavailableCard = helperContext.reportMetricCardHtml({
  key: "category<&",
  label: "대표 <유형>",
  value: "미수집",
  state: "unavailable",
  tone: "warning",
  icon: "tag",
});
assert.match(escapedUnavailableCard, /data-report-tone="warning"/);
assert.match(escapedUnavailableCard, /data-metric-state="unavailable"/);
assert.match(escapedUnavailableCard, /대표 &lt;유형&gt;/);
assert.doesNotMatch(escapedUnavailableCard, /대표 <유형>/);

for (const icon of ["company", "rate", "tag", "platform", "candidate", "package", "search", "opportunity", "history", "tourism", "operation", "dayuse"]) {
  const markup = helperContext.summaryIcon(icon);
  assert.match(markup, /<svg[^>]*class="summary-icon-svg"[^>]*aria-hidden="true"/, `${icon} icon must be decorative`);
  assert.doesNotMatch(markup, /<script|https?:\/\//i, `${icon} must remain an inline, local icon`);
}

const renderReport = functionBlock("renderReport");
assert.match(renderReport, /reportMetricCardHtml\(\{\s*key:\s*"sales-rate"[\s\S]*?tone:\s*rateTone[\s\S]*?icon:\s*"rate"/);
assert.match(renderReport, /candidateCount\s*===\s*0\s*\?\s*"zero"\s*:\s*"ready"/);
assert.match(renderReport, /candidateCount\s*\?\s*"opportunity"\s*:\s*"neutral"/, "zero contact candidates must remain neutral");
assert.match(renderReport, /adminReportKpiCardsHtml\(\{\s*items,\s*sales,\s*overview:\s*adminOverview,\s*candidateCount,\s*productGapCount\s*\}\)/);
assert.match(renderReport, /reportInsightItemHtml\(\{\s*key:\s*"sales-strength"/);
assert.match(renderReport, /reportInsightItemHtml\(\{\s*key:\s*"search-demand"/);
assert.match(renderReport, /reportInsightItemHtml\(\{\s*key:\s*"product-expansion"[\s\S]*?tone:\s*dayUseCount\s*\?\s*"opportunity"\s*:\s*"warning"/);
assert.match(renderReport, /report-semantic-section report-tone-info/);
assert.match(renderReport, /report-semantic-section report-tone-opportunity/);
assert.doesNotMatch(renderReport, /\bfetch\s*\(|XMLHttpRequest|https?:\/\//, "report rendering must not initiate external requests");

const adminKpis = functionBlock("adminReportKpiCardsHtml");
const adminKpiKeys = [...adminKpis.matchAll(/key:\s*"([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(adminKpiKeys, ["companies", "sales-sample", "primary-category", "platforms", "contact-candidates", "product-gap"], "admin summary must expose one flat, unique six-card KPI grid");
assert.equal((adminKpis.match(/reportMetricCardHtml\(\{/g) || []).length, 6, "admin summary must render exactly six KPI cards");
assert.match(adminKpis, /key:\s*"sales-sample"[\s\S]*?tone:\s*overview\.salesObserved\s*\?/);
assert.match(adminKpis, /key:\s*"primary-category"[\s\S]*?overview\.categoryCount\s*\?\s*"info"\s*:\s*"warning"/);
assert.match(adminKpis, /key:\s*"platforms"[\s\S]*?overview\.observedPlatforms\?\.length\s*\?\s*"info"\s*:\s*"warning"/);
assert.match(adminKpis, /key:\s*"contact-candidates"[\s\S]*?tone:\s*candidateTone/);
assert.match(adminKpis, /key:\s*"product-gap"[\s\S]*?tone:\s*productGapCount\s*\?\s*"warning"\s*:\s*"success"/);
assert.doesNotMatch(adminKpis, /\bfetch\s*\(|XMLHttpRequest|https?:\/\//);

const analyticsModel = functionBlock("adminAnalyticsOverviewModel");
assert.match(analyticsModel, /categorySummaryObserved/);
assert.match(analyticsModel, /observedPlatforms/);
const analyticsOverview = functionBlock("adminAnalyticsOverviewHtml");
assert.match(analyticsOverview, /report-basis-card/);
assert.match(analyticsOverview, /overview\.hasRun\s*\?\s*"수집 결과 기준"\s*:\s*"미수집"/);
assert.doesNotMatch(analyticsOverview, /adminAnalyticsValueCell|admin-operations-context-grid|reportMetricCardHtml/, "analysis basis must stay a single horizontal summary without nested KPI cards");
assert.doesNotMatch(analyticsOverview, /\bfetch\s*\(|XMLHttpRequest/);

const evidenceContext = {};
vm.createContext(evidenceContext);
vm.runInContext(functionSource("locationEvidencePresentation"), evidenceContext);
assert.deepEqual({ ...evidenceContext.locationEvidencePresentation("tourism") }, { tone: "info", icon: "tourism" });
assert.deepEqual({ ...evidenceContext.locationEvidencePresentation("operation") }, { tone: "warning", icon: "operation" });
assert.deepEqual({ ...evidenceContext.locationEvidencePresentation("expansionRisk") }, { tone: "opportunity", icon: "opportunity" });
assert.deepEqual({ ...evidenceContext.locationEvidencePresentation("dayUse") }, { tone: "success", icon: "dayuse" });
assert.deepEqual({ ...evidenceContext.locationEvidencePresentation("unknown") }, { tone: "neutral", icon: "trust" });

const evidenceBlock = functionBlock("renderLocationEvidence");
assert.match(evidenceBlock, /data-location-evidence-key=/);
assert.match(evidenceBlock, /data-report-tone=/);
assert.match(evidenceBlock, /reportSemanticIconHtml/);
assert.match(evidenceBlock, /\/100/, "judgment evidence must expose the score unit as text");

const historyBlock = functionBlock("renderLocationScoreOverrideHistory");
assert.match(historyBlock, /report-tone-/);
assert.match(historyBlock, /data-report-tone=/);
assert.match(historyBlock, /reportSemanticIconHtml\("history"/);
assert.match(historyBlock, /row\.at[\s\S]*?row\.by[\s\S]*?row\.note/, "history timestamp, actor and reason must remain visible");

const realityBlock = functionBlock("renderLocationReality");
assert.equal((realityBlock.match(/reportMetricCardHtml\(\{/g) || []).length, 4, "reality comparison must reuse four semantic metric cards");
assert.match(realityBlock, /key:\s*"top-exposure"[\s\S]*?tone:\s*itemCount\s*\?\s*"info"\s*:\s*"neutral"[\s\S]*?icon:\s*"company"/);
assert.match(realityBlock, /key:\s*"room-sales-rate"[\s\S]*?tone:\s*salesTone[\s\S]*?icon:\s*"rate"/);
assert.match(realityBlock, /key:\s*"ad-ratio"[\s\S]*?tone:\s*adTone[\s\S]*?icon:\s*"platform"/);
assert.match(realityBlock, /key:\s*"monthly-search"[\s\S]*?tone:\s*searchTone[\s\S]*?icon:\s*"search"/);
assert.match(realityBlock, /runtime\.items[\s\S]*?runtime\.sales[\s\S]*?runtime\.adCount[\s\S]*?runtime\.searchVolume/);
assert.doesNotMatch(realityBlock, /\bfetch\s*\(|XMLHttpRequest/);

assert.match(css, /\/\* Summary report semantic cards v1 \*\//, "semantic report styles need an owned responsibility marker");
assert.match(css, /\.report-tone-neutral[\s\S]*?--report-tone:/);
assert.match(css, /\.report-tone-info[\s\S]*?--report-tone:/);
assert.match(css, /\.report-tone-success[\s\S]*?--report-tone:/);
assert.match(css, /\.report-tone-warning[\s\S]*?--report-tone:/);
assert.match(css, /\.report-tone-danger[\s\S]*?--report-tone:/);
assert.match(css, /\.report-tone-opportunity[\s\S]*?--report-tone:/);
assert.match(css, /:root\[data-theme="light"\]\s+\.report-tone-warning\s*\{[^}]*--report-tone:\s*color-mix\(in srgb,\s*var\(--color-status-warning\)\s*88%,\s*#000000\)/s, "light warning text and status accents must use the contrast-safe report alias");
assert.match(css, /:root\[data-theme="light"\]\s+\.report-tone-neutral\s*\{[^}]*--report-tone:\s*color-mix\(in srgb,\s*var\(--color-border-strong\)\s*88%,\s*#000000\)/s, "light neutral text and status accents must remain readable");
assert.match(css, /:root\[data-theme="light"\]\s+\.report-tone-opportunity\s*\{[^}]*--report-tone:\s*color-mix\(in srgb,\s*var\(--color-accent-secondary\)\s*84%,\s*#000000\)/s, "light opportunity text and status accents must remain readable");
assert.match(css, /\.report-metric-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s, "desktop six-card KPI grid must use a balanced three-column layout");
assert.match(css, /\.report-basis-card\s*\{[^}]*background:\s*color-mix\([^}]*var\(--color-status-info\)/s, "analysis basis must be a single low-tint semantic surface");
assert.match(css, /\.report-hero\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--color-status-info\)\s*8%,\s*var\(--color-surface-raised\)\)/s, "report hero must use a low-tint semantic surface instead of a decorative gradient");
assert.match(css, /body\.role-b2b\s+\.report-hero\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--color-status-info\)\s*8%,\s*var\(--color-surface-raised\)\)/s, "the later role-specific selector must preserve the semantic hero surface");
assert.match(css, /\.report-semantic-card\s*\{[^}]*min-width:\s*0[^}]*background:\s*color-mix\([^}]*var\(--report-tone/s);
assert.match(css, /\.report-semantic-icon\s*\{[^}]*width:\s*(?:36|38|40)px[^}]*height:\s*(?:36|38|40)px/s);
assert.match(css, /\.report-insight-copy\s*\{[^}]*grid-area:\s*copy/s);
assert.match(css, /\.report-insight-item\s*\{[^}]*min-width:\s*0/s);
assert.match(css, /\.report-semantic-copy,\s*\.report-insight-copy\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s);
assert.match(css, /\.report-channel-grid\s*>\s*\.report-semantic-card/);
assert.match(css, /\.location-score-history\s*\{[^}]*background:\s*(?:var\(--color-surface|color-mix\()/s, "dark history must use a semantic surface");
assert.doesNotMatch(css, /\.location-score-history\s*\{[^}]*background:\s*#(?:fff|ffffff|fbfcfd)/is, "history must not leak a white hardcoded card into dark mode");
assert.match(css, /\.location-evidence[\s\S]*?\.location-evidence-copy\s*\{[^}]*min-width:\s*0/s);
assert.match(css, /\.location-evidence-copy\s+span\s*\{[^}]*overflow-wrap:\s*anywhere/s);

assert.match(css, /@media\s*\(max-width:\s*360px\)[\s\S]*?\.report-metric-grid[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/s, "320px report metrics must safely switch to one column");
assert.match(css, /@media\s*\(min-width:\s*361px\)\s*and\s*\(max-width:\s*720px\)[\s\S]*?\.report-metric-grid[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s, "390px report metrics must use two readable columns");
assert.match(css, /\.report-semantic-card[\s\S]*?overflow-wrap:\s*anywhere/, "long Korean labels and values must remain readable");
assert.doesNotMatch(css, /filter\s*:\s*(?:invert|hue-rotate)/i, "semantic report cards must not reintroduce whole-page inversion");
assert.doesNotMatch(html, /<(?:link|script)\b[^>]+(?:href|src)="https?:\/\//i, "report icons and assets must stay local");

console.log("Report semantic card structure, tones, icons, responsive layout, and no-network contracts passed");
