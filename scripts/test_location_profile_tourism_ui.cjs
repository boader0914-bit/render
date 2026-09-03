const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");
const themeStyles = fs.readFileSync(path.join(root, "web", "admin-theme.css"), "utf8");
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function blockBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`source block not found: ${startMarker} -> ${endMarker}`);
  }
  return source.slice(start, end);
}

function tagsWithAttribute(source, attribute) {
  const pattern = new RegExp(`<[^>]+\\b${attribute}(?:=|\\s)[^>]*>`, "g");
  return source.match(pattern) || [];
}

function cssRulesContaining(source, selectorText) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].includes(selectorText))
    .map((match) => ({ selector: match[1].trim(), body: match[2] }));
}

function declarations(ruleBody) {
  return new Map(
    [...String(ruleBody || "").matchAll(/([a-z-]+)\s*:\s*([^;]+);/gi)]
      .map((match) => [match[1].trim().toLowerCase(), match[2].trim().toLowerCase()])
  );
}

function hexToRgb(value) {
  const normalized = String(value || "").trim().replace("#", "");
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

function themeVariables(theme) {
  const marker = `html[data-theme-resolved="${theme}"]`;
  const start = themeStyles.indexOf(marker);
  const open = themeStyles.indexOf("{", start);
  const close = themeStyles.indexOf("}", open);
  if (start < 0 || open < 0 || close < 0) return new Map();
  return new Map(
    [...themeStyles.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)]
      .map((match) => [match[1], match[2]])
  );
}

// The tourism view is one compact dashboard. A single selected metric owns the
// large graph, while every selector and panel retains native tab semantics.
check(app.includes('class="location-profile-tourism-dashboard"'), "tourism dashboard wrapper is missing");
check(app.includes('class="location-profile-tourism-selector"'), "tourism metric selector is missing");

const tourismDashboardBlock = blockBetween(
  app,
  "function renderLocationProfileTourismDashboard(",
  "function renderLocationProfileSummaryCard("
);
for (const metric of ["visitor", "strength", "resourceDemand", "diversity"]) {
  check(tourismDashboardBlock.includes(`key: "${metric}"`), `tourism dashboard is missing the ${metric} metric family`);
}

const selectorTags = tagsWithAttribute(app, "data-location-tourism-metric");
check(selectorTags.length > 0, "tourism dashboard must expose metric selectors");
check(
  selectorTags.length > 0 && selectorTags.every((tag) => /\brole="tab"/.test(tag) && /\baria-selected=/.test(tag) && /\btabindex=/.test(tag)),
  "every tourism metric selector must expose role=tab, aria-selected, and roving tabindex"
);

const panelTags = tagsWithAttribute(app, "data-location-tourism-metric-panel");
check(panelTags.length > 0, "tourism dashboard must render metric panels");
check(
  panelTags.length > 0 && panelTags.every((tag) => /\brole="tabpanel"/.test(tag) && /\bhidden/.test(tag)),
  "every tourism metric panel must expose role=tabpanel and hidden state"
);
check(app.includes("state.dictionaryTourismMetric"), "selected tourism metric must persist in application state");
check(app.includes('class="location-profile-coverage'), "coverage must be rendered separately from the headline metric");

const dashboardRuntimeSource = blockBetween(
  app,
  "const LOCATION_PROFILE_TOURISM_METRICS",
  "function renderLocationProfileSummaryCard("
);
const dashboardSandbox = {
  state: { dictionaryTourismMetric: "resourceDemand" },
  escapeHtml: (value) => String(value ?? "")
};
vm.runInNewContext(`${dashboardRuntimeSource}\nthis.renderDashboard = renderLocationProfileTourismDashboard;`, dashboardSandbox);
const dashboardHtml = dashboardSandbox.renderDashboard({
  visitor: "visitor-panel",
  strength: "strength-panel",
  resourceDemand: "resource-panel",
  diversity: "diversity-panel"
});
const renderedSelectorTags = tagsWithAttribute(dashboardHtml, "data-location-tourism-metric");
const renderedPanelTags = tagsWithAttribute(dashboardHtml, "data-location-tourism-metric-panel");
check(renderedSelectorTags.length === 4, "tourism dashboard must render exactly four metric-family tabs");
check(renderedPanelTags.length === 4, "tourism dashboard must render exactly four metric-family panels");
check(renderedSelectorTags.filter((tag) => /aria-selected="true"/.test(tag)).length === 1, "exactly one tourism metric tab must be selected");
check(renderedPanelTags.filter((tag) => /\bhidden\b/.test(tag)).length === 3, "exactly three inactive tourism metric panels must be hidden");
check(
  renderedPanelTags.some((tag) => /data-location-tourism-metric-panel="resourceDemand"/.test(tag) && !/\bhidden\b/.test(tag)),
  "the metric selected in state must own the visible panel"
);

// The overview cards use a separate native action button for the same metric
// state as the tabs. The article and its progressbar stay outside that button.
const summaryCardSource = blockBetween(
  app,
  "function renderLocationProfileSummaryCard(",
  "function locationProfileStrengthSummaryModel("
);
const summaryCardState = { dictionaryTourismMetric: "strength" };
const summaryCardSandbox = {
  state: summaryCardState,
  LOCATION_PROFILE_TOURISM_METRICS: new Set(["visitor", "strength", "resourceDemand", "diversity"]),
  locationProfileActiveTourismMetric() {
    return summaryCardState.dictionaryTourismMetric;
  },
  escapeHtml: (value) => String(value ?? ""),
  renderLocationProfileCoverage: () => '<span role="progressbar"></span>'
};
vm.runInNewContext(`${summaryCardSource}\nthis.renderSummaryCard = renderLocationProfileSummaryCard;`, summaryCardSandbox);
const summaryCardsHtml = [
  ["visitor", "지역 방문자"],
  ["strength", "체류·소비"],
  ["resourceDemand", "관광자원 수요"],
  ["diversity", "관광 다양성"]
].map(([key, title]) => summaryCardSandbox.renderSummaryCard({ key, title, value: "1", coverage: { expectedMonths: 12 } })).join("");
const renderedSummaryArticles = summaryCardsHtml.match(/<article\b[^>]*class="[^"]*location-profile-summary-card[^"]*"[^>]*>/g) || [];
const renderedSummaryActions = tagsWithAttribute(summaryCardsHtml, "data-location-summary-metric");
const renderedSummaryActionBodies = summaryCardsHtml.match(/<button\b[^>]*data-location-summary-metric[^>]*>[\s\S]*?<\/button>/g) || [];
check(renderedSummaryArticles.length === 4, "overview must retain exactly four tourism summary articles");
check(
  renderedSummaryArticles.every((tag) => !/\brole=/.test(tag) && !/\btabindex=/.test(tag) && !/\baria-pressed=/.test(tag)),
  "tourism summary articles must remain semantic noninteractive containers"
);
check(
  renderedSummaryActions.length === 4 && renderedSummaryActions.every((tag) => /^<button\b/.test(tag) && /\btype="button"/.test(tag) && /\bclass="location-profile-summary-card-action"/.test(tag) && /\baria-pressed=/.test(tag) && /\baria-controls=/.test(tag) && /\baria-label=/.test(tag)),
  "every tourism summary article must expose one native labelled action button with persistent selected state"
);
check(renderedSummaryActions.filter((tag) => /aria-pressed="true"/.test(tag)).length === 1, "exactly one tourism summary action must be pressed");
check(renderedSummaryActionBodies.every((button) => !/role="progressbar"/.test(button)), "summary progressbars must not be nested inside action buttons");

function fakeInteractiveNode(dataset = {}) {
  const attributes = new Map();
  const classes = new Set();
  return {
    dataset,
    hidden: false,
    tabIndex: null,
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      }
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name);
    }
  };
}

const metricKeys = ["visitor", "strength", "resourceDemand", "diversity"];
const summaryArticleNodes = metricKeys.map(() => fakeInteractiveNode());
const summaryNodes = metricKeys.map((key, index) => {
  const button = fakeInteractiveNode({ locationSummaryMetric: key });
  button.closest = (selector) => selector === ".location-profile-summary-card" ? summaryArticleNodes[index] : null;
  return button;
});
const metricTabNodes = metricKeys.map((key) => fakeInteractiveNode({ locationTourismMetric: key }));
const metricPanelNodes = metricKeys.map((key) => fakeInteractiveNode({ locationTourismMetricPanel: key }));
const profileTabNodes = ["basic", "tourism", "supply", "history"].map((key) => fakeInteractiveNode({ locationProfileTab: key }));
const profilePanelNodes = ["basic", "tourism", "supply", "history"].map((key) => fakeInteractiveNode({ locationProfilePanel: key }));
const nodesBySelector = new Map([
  ["[data-location-summary-metric]", summaryNodes],
  ["[data-location-tourism-metric]", metricTabNodes],
  ["[data-location-tourism-metric-panel]", metricPanelNodes],
  ["[data-location-profile-tab]", profileTabNodes],
  ["[data-location-profile-panel]", profilePanelNodes]
]);
const activationRoot = {
  querySelectorAll(selector) {
    return nodesBySelector.get(selector) || [];
  }
};
const activationSource = blockBetween(
  app,
  "function activateLocationProfileTourismMetric(",
  "function renderLocationProfileTourismDashboard("
);
const activationSandbox = {
  state: { dictionaryDetailTab: "basic", dictionaryTourismMetric: "visitor" },
  LOCATION_PROFILE_TOURISM_METRICS: new Set(metricKeys),
  els: { dictionaryResult: activationRoot }
};
vm.runInNewContext(`${activationSource}\nthis.activateMetric = activateLocationProfileTourismMetric;`, activationSandbox);
check(activationSandbox.activateMetric("resourceDemand") === true, "a valid tourism metric must activate");
check(activationSandbox.state.dictionaryTourismMetric === "resourceDemand", "metric activation must persist in application state");
check(activationSandbox.state.dictionaryDetailTab === "basic", "the existing metric tabs must not unexpectedly change the outer detail tab");
check(summaryNodes[2].getAttribute("aria-pressed") === "true" && summaryNodes.every((node, index) => index === 2 || node.getAttribute("aria-pressed") === "false"), "metric-tab activation must synchronize the pressed summary card");
check(summaryArticleNodes[2].classList.contains("active") && summaryArticleNodes.every((node, index) => index === 2 || !node.classList.contains("active")), "metric activation must place the visual active state on the summary article");
check(metricTabNodes[2].getAttribute("aria-selected") === "true" && metricTabNodes[2].tabIndex === 0, "metric activation must select the matching tab");
check(metricTabNodes.every((node, index) => index === 2 || (node.getAttribute("aria-selected") === "false" && node.tabIndex === -1)), "metric activation must retain roving tabindex for inactive tabs");
check(metricPanelNodes.every((node, index) => node.hidden === (index !== 2)), "metric activation must reveal only the matching metric panel");
check(activationSandbox.activateMetric("diversity", { revealTourism: true, root: activationRoot }) === true, "summary-card activation must reveal tourism details");
check(activationSandbox.state.dictionaryDetailTab === "tourism", "summary-card activation must persist the tourism detail tab");
check(profileTabNodes[1].getAttribute("aria-selected") === "true" && profileTabNodes[1].tabIndex === 0, "summary-card activation must select the tourism detail tab");
check(profilePanelNodes.every((node, index) => node.hidden === (index !== 1)), "summary-card activation must reveal only the tourism detail panel");
check(activationSandbox.activateMetric("unknown", { revealTourism: true, root: activationRoot }) === false, "unknown summary metrics must be ignored");

const interactionHandlers = blockBetween(
  app,
  'els.dictionaryResult?.addEventListener("click"',
  "async function init("
);
check(interactionHandlers.includes('event.target.closest("[data-location-summary-metric]")'), "summary cards must have delegated click handling");
check(!interactionHandlers.includes('event.target.closest?.("[data-location-summary-metric]")'), "native summary buttons must not duplicate Enter and Space activation in a custom keydown handler");
check((interactionHandlers.match(/activateLocationProfileTourismMetric\(/g) || []).length >= 2, "summary cards and metric tabs must share the metric activation helper");

// The representative visitor window must describe completed months. The old
// current-month heading made an expected pending month look like a data defect.
const visitorPanelBlock = blockBetween(
  app,
  "function renderLocationProfileVisitorRollingPanel(",
  "function renderLocationProfileVisitorPanel("
);
check(!visitorPanelBlock.includes("현재월 포함 최근 12개월"), "visitor headline still uses the current-month window");
check(!visitorPanelBlock.includes("이번 달 기준 최근 12개월"), "visitor chart title still uses the current month as its endpoint");
check(visitorPanelBlock.includes("최근 완료월 기준 12개월"), "visitor headline must identify the latest completed 12-month window");
check(
  visitorPanelBlock.includes("renderLocationProfileCoverage(target.coverage"),
  "visitor panel must render coverage separately from the headline metric"
);
check(app.includes('const label = options.label || "자료 확보"'), "visitor coverage must be labelled as data availability");
check(
  app.includes("const visitorSummaryWindow = visitorRolling?.confirmed?.ready ? visitorRolling.confirmed : visitorRolling?.target")
    && app.includes('visitorRolling.confirmed?.ready ? "확정기간 자료" : "최신 기준창 자료"'),
  "visitor summary coverage must use the same completed window as its representative total"
);
check(!app.includes('? "이번 달 기준 12개월"'), "source status must not restore the current-month visitor label");
check(app.includes("최근 완료월 기준 12개월") && app.includes("지표별 기간 상이"), "the overview must identify the visitor period without implying every provider shares it");
check(
  app.includes("const stayCompleteYearMonths = new Set")
    && app.includes("stayCompleteYearMonths.has(entry.yearMonth)"),
  "stay and spend summary coverage must count the intersection of complete months"
);

const coverageSource = blockBetween(
  app,
  "function locationProfileCoverageModel(",
  "function locationProfileSeriesMissingMonths("
);
const coverageSandbox = {
  finiteNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  fmtNumber: (value) => String(value),
  escapeHtml: (value) => String(value ?? "")
};
vm.runInNewContext(
  `${coverageSource}\nthis.coverageModel = locationProfileCoverageModel; this.renderCoverage = renderLocationProfileCoverage;`,
  coverageSandbox
);
const partialCoverageHtml = coverageSandbox.renderCoverage(
  { expectedMonths: 12, completeMonths: 10, partialMonths: 0, missingMonths: 2 },
  { detail: "자료대기 2026.08, 2026.09" }
);
const completeCoverageHtml = coverageSandbox.renderCoverage(
  { expectedMonths: 12, completeMonths: 12, partialMonths: 0, missingMonths: 0 }
);
const emptyCoverageHtml = coverageSandbox.renderCoverage(
  { expectedMonths: 12, completeMonths: 0, partialMonths: 0, missingMonths: 12 }
);
check(partialCoverageHtml.includes("location-profile-coverage is-partial"), "10/12 coverage must be presented as partial availability");
check(partialCoverageHtml.includes("자료 확보") && partialCoverageHtml.includes("10/12"), "coverage must pair its fraction with a data-availability label");
check(partialCoverageHtml.includes('role="progressbar"') && partialCoverageHtml.includes('aria-valuenow="10"'), "coverage must expose an accessible progress value");
check(partialCoverageHtml.includes("자료대기 2026.08, 2026.09"), "coverage must name pending months when supplied");
check(completeCoverageHtml.includes("location-profile-coverage is-complete"), "12/12 coverage must be presented as complete");
check(emptyCoverageHtml.includes("location-profile-coverage is-missing"), "0/12 coverage must be presented as unavailable");

function buildMonthlySeries({
  startYear = 2025,
  startMonth = 8,
  values = {},
  partial = [],
  failed = [],
  missingReason = "provider_month_missing"
} = {}) {
  return Array.from({ length: 12 }, (_, index) => {
    const absoluteMonth = startYear * 12 + startMonth - 1 + index;
    const year = Math.floor(absoluteMonth / 12);
    const month = absoluteMonth % 12 + 1;
    const yearMonth = `${year}${String(month).padStart(2, "0")}`;
    if (Object.prototype.hasOwnProperty.call(values, index)) {
      return { yearMonth, axisLabel: `${year}.${String(month).padStart(2, "0")}`, status: "complete", value: values[index], hasValue: true };
    }
    if (failed.includes(index)) {
      return { yearMonth, axisLabel: `${year}.${String(month).padStart(2, "0")}`, status: "unavailable", reason: "history_collection_failed", value: null, hasValue: false };
    }
    if (partial.includes(index)) {
      return { yearMonth, axisLabel: `${year}.${String(month).padStart(2, "0")}`, status: "partial", reason: "provider_partial_response", value: null, hasValue: false };
    }
    return { yearMonth, axisLabel: `${year}.${String(month).padStart(2, "0")}`, status: "unavailable", reason: missingReason, value: null, hasValue: false };
  });
}

// Exercise the chart renderer directly: zero points show an empty state, one
// point stays a point, two adjacent points make one line, and a missing month
// splits the line instead of becoming a zero-value observation.
const chartSource = blockBetween(
  app,
  "function locationProfileTourismSeriesEntryFailed(",
  "function locationProfileLatestPoint("
);
const chartSandbox = {
  escapeHtml: (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;"),
  fmtNumber: (value) => String(value),
  tourismVisitorYearMonth: (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    return /^\d{6}$/.test(digits) ? digits : "";
  },
  tourismVisitorMonthLabel: (yearMonth) => `${String(yearMonth).slice(0, 4)}.${String(yearMonth).slice(4, 6)}`
};
vm.runInNewContext(`${chartSource}\nthis.renderChart = renderLocationProfileLineChart; this.entryFailed = locationProfileTourismSeriesEntryFailed; this.seriesObserved = locationProfileTourismSeriesHasObservedValue;`, chartSandbox);

const noPointChart = chartSandbox.renderChart([], { id: "none" });
const onePointChart = chartSandbox.renderChart([
  { yearMonth: "202607", axisLabel: "2026.07", value: 120, hasValue: true }
], { id: "one", showAllLabels: true });
const twoPointChart = chartSandbox.renderChart([
  { yearMonth: "202606", axisLabel: "2026.06", value: 100, hasValue: true },
  { yearMonth: "202607", axisLabel: "2026.07", value: 120, hasValue: true }
], { id: "two", showAllLabels: true });
const gapChart = chartSandbox.renderChart([
  { yearMonth: "202605", axisLabel: "2026.05", value: 100, hasValue: true },
  { yearMonth: "202606", axisLabel: "2026.06", value: 0, hasValue: false, status: "missing" },
  { yearMonth: "202607", axisLabel: "2026.07", value: 120, hasValue: true }
], { id: "gap", showAllLabels: true });
const failedChart = chartSandbox.renderChart([
  { yearMonth: "202605", axisLabel: "2026.05", value: 100, hasValue: true },
  { yearMonth: "202606", axisLabel: "2026.06", value: null, hasValue: false, status: "failed" }
], { id: "failed", showAllLabels: true });
const failedReasonChart = chartSandbox.renderChart([
  { yearMonth: "202605", axisLabel: "2026.05", value: 100, hasValue: true },
  { yearMonth: "202606", axisLabel: "2026.06", value: null, hasValue: false, status: "unavailable", reason: "history_collection_failed" }
], { id: "failed-reason", showAllLabels: true });
const compactChart = chartSandbox.renderChart(buildMonthlySeries({
  values: { 0: 102000, 4: 124000, 8: 111000, 11: 133000 },
  partial: [3],
  failed: [6]
}), { id: "compact", showAllLabels: true, compactMonthLabels: true, unit: "명" });

const count = (source, pattern) => (source.match(pattern) || []).length;
check(noPointChart.includes("location-profile-chart-empty"), "zero observed points must render the compact empty state");
check(count(onePointChart, /class="location-profile-chart-point"/g) === 1, "one observed point must remain visible");
check(count(onePointChart, /class="location-profile-chart-line"/g) === 0, "one observed point must not fabricate a line");
check(count(twoPointChart, /class="location-profile-chart-point"/g) === 2, "two adjacent observations must both remain visible");
check(count(twoPointChart, /class="location-profile-chart-line"/g) === 1, "two adjacent observations must render one line segment");
check(count(gapChart, /class="location-profile-chart-point"/g) === 2, "a missing month must not render a zero-value point");
check(count(gapChart, /class="location-profile-chart-line"/g) === 0, "a missing month must break the line between isolated observations");
check(gapChart.includes("location-profile-chart-missing-zone"), "missing months must have an explicit visual zone");
check(gapChart.includes("location-profile-chart-latest-label"), "the latest observed value must be labelled on the graph");
check(!gapChart.includes("NaN"), "chart markup must never expose NaN coordinates or values");
check(gapChart.includes('viewBox="0 0 400 240"'), "chart must use the compact responsive viewBox");
check(gapChart.includes('text-anchor="end"'), "y-axis values must align away from the plotting area");
check(failedChart.includes("location-profile-chart-missing-zone is-failed") && failedChart.includes("실패"), "provider failures must be distinct from ordinary pending months");
check(failedReasonChart.includes("location-profile-chart-missing-zone is-failed") && failedReasonChart.includes("수집실패 1"), "a preserved failure reason must not be downgraded to a pending month");
check(!gapChart.includes('tabindex="0"') && gapChart.includes('aria-hidden="true"'), "chart points must not create redundant nested image focus stops");
check(gapChart.includes("관측값:"), "the chart description must expose its observed values to assistive technology");
check(compactChart.includes("location-profile-chart-state-key") && compactChart.includes("부분수집 1") && compactChart.includes("수집실패 1"), "dense 12-month charts must move missing-state labels into a non-overlapping key");
check(!/location-profile-chart-missing-zone[^>]*>[\s\S]*?<text[^>]*>/.test(compactChart.split("location-profile-chart-latest-label")[0]), "dense 12-month missing zones must not repeat overlapping text inside every month");
check(count(compactChart, /location-profile-chart-axis/g) === 6, "the compact chart must render six desktop month labels");
check(count(compactChart, /location-profile-chart-axis is-compact-secondary/g) === 2, "two lower-priority month labels must be available for compact-container hiding");
check(compactChart.includes('text-anchor="start">25.08</text>') && compactChart.includes('text-anchor="end">26.07</text>'), "edge month labels must anchor inward to avoid clipping");
check(/>\d+(?:\.\d+)?만<\/text>/.test(compactChart), "large y-axis values must use compact Korean units instead of clipping comma-formatted labels");

const compactAxisLabels = [...compactChart.matchAll(/<text class="location-profile-chart-axis([^\"]*)" x="([0-9.]+)"[^>]*text-anchor="([^"]+)">([^<]*)<\/text>/g)]
  .map((match) => ({ secondary: match[1].includes("is-compact-secondary"), x: Number(match[2]), anchor: match[3], text: match[4] }));
for (const containerWidth of [420, 390, 360]) {
  const fontSize = containerWidth <= 320 ? 18 : containerWidth <= 420 ? 14 : containerWidth <= 500 ? 11 : 9;
  const renderedFontSize = fontSize * containerWidth / 400;
  const visibleLabels = compactAxisLabels.filter((label) => containerWidth > 420 || !label.secondary);
  const intervals = visibleLabels.map((label) => {
    const textWidth = label.text.length * fontSize * .62;
    if (label.anchor === "start") return [label.x, label.x + textWidth];
    if (label.anchor === "end") return [label.x - textWidth, label.x];
    return [label.x - textWidth / 2, label.x + textWidth / 2];
  });
  check(renderedFontSize >= 12, `${containerWidth}px chart labels must remain at least 12px after SVG scaling`);
  check(intervals.every(([start, end]) => start >= 0 && end <= 400), `${containerWidth}px chart labels must stay inside the viewBox`);
  check(intervals.every((interval, index) => index === 0 || intervals[index - 1][1] <= interval[0]), `${containerWidth}px chart labels must not overlap`);
}
const compactYAxisLabels = [...compactChart.matchAll(/<g class="location-profile-chart-gridline">[\s\S]*?<text x="([0-9.]+)"[^>]*>([^<]*)<\/text><\/g>/g)]
  .map((match) => ({ x: Number(match[1]), text: match[2] }));
check(compactYAxisLabels.length === 5, "the compact chart must retain five readable y-axis guides");
check(compactYAxisLabels.every((label) => {
  const estimatedWidthAtSmallestContainer = [...label.text]
    .reduce((width, character) => width + (/^[\x00-\x7F]$/.test(character) ? 18 * .62 : 18), 0);
  return estimatedWidthAtSmallestContainer <= label.x;
}), "compact y-axis labels must fit left of the plot even at the <=320px SVG font size");

// Exercise the provider history shape through evidence normalization and then
// the chart renderer. Fatal collector metadata can arrive with a generic
// missing/unavailable status, so reason/failed must survive the point mapping.
const tourismIndexEvidenceSource = blockBetween(
  app,
  "function locationProfileTourismIndexOperation(",
  "function locationProfileResourceDemandEvidence("
);
const evidenceSandbox = {
  optionalNumber: (value) => value === null || value === undefined || value === "" ? NaN : Number(value),
  tourismVisitorYearMonth: chartSandbox.tourismVisitorYearMonth,
  tourismVisitorMonthLabel: chartSandbox.tourismVisitorMonthLabel,
  tourismVisitorMonthIndex: (value) => {
    const yearMonth = chartSandbox.tourismVisitorYearMonth(value);
    return yearMonth ? Number(yearMonth.slice(0, 4)) * 12 + Number(yearMonth.slice(4, 6)) - 1 : NaN;
  },
  locationProfileTourismSeriesEntryFailed: chartSandbox.entryFailed,
  locationProfileRowsForRegion: () => [],
  locationProfileFindRegion: () => null,
  locationProfileFirstObject: (...values) => values.find((value) => value && typeof value === "object") || null,
  locationProfileVisitorPeriodLabel: (period) => `${period.startYearMonth}~${period.endYearMonth}`,
  locationProfileObservedAt: (...values) => values.find(Boolean) || ""
};
vm.runInNewContext(
  `${tourismIndexEvidenceSource}\nthis.buildEvidence = locationProfileTourismIndexEvidence;`,
  evidenceSandbox
);
const providerHistoryEvidence = evidenceSandbox.buildEvidence({
  history: {
    period: { startYearMonth: "202605", endYearMonth: "202607", latestClosedYearMonth: "202607", months: 3 },
    region: {
      collectedAt: "2026-08-01T00:00:00.000Z",
      series: [
        { yearMonth: "202605", status: "complete", operations: { service: { status: "complete", overallValue: 71, metrics: [] } } },
        { yearMonth: "202606", status: "unavailable", reason: "history_collection_failed", failed: true, operations: { service: { status: "unavailable", reason: "provider_month_missing", failed: false, metrics: [] } } },
        { yearMonth: "202607", status: "missing", reason: "provider_month_missing", failed: false, operations: { service: { status: "unavailable", reason: "invalid_response", failed: true, metrics: [] } } }
      ]
    },
    sourceLabel: "한국관광공사"
  }
}, { regionKey: "kr_gyeongnam_sancheong" }, null, {
  seriesSpecs: [{ key: "service", label: "서비스", title: "서비스 자원 수요" }]
});
const normalizedProviderSeries = providerHistoryEvidence.seriesByKey.service;
const topFailurePoint = normalizedProviderSeries.find((entry) => entry.yearMonth === "202606");
const operationFailurePoint = normalizedProviderSeries.find((entry) => entry.yearMonth === "202607");
check(topFailurePoint?.reason === "history_collection_failed" && topFailurePoint?.entryFailed === true && topFailurePoint?.failed === true, "top-level collector failure metadata must survive tourism-index point normalization");
check(topFailurePoint?.operationReason === "provider_month_missing" && topFailurePoint?.operationFailed === false, "operation metadata must remain inspectable when a top-level fatal reason takes precedence");
check(operationFailurePoint?.operationReason === "invalid_response" && operationFailurePoint?.operationFailed === true && operationFailurePoint?.failed === true, "operation-level collector failure metadata must survive tourism-index point normalization");
const providerPipelineChart = chartSandbox.renderChart(normalizedProviderSeries, { id: "provider-pipeline", showAllLabels: true, compactMonthLabels: true });
check(count(providerPipelineChart, /location-profile-chart-missing-zone is-failed/g) === 2, "collector-shaped fatal months must render as failures across the evidence-to-chart pipeline");
check(providerPipelineChart.includes("수집실패 2") && !providerPipelineChart.includes("자료대기 2"), "collector-shaped fatal months must not be relabelled as ordinary data waiting");
const missingMonthsSource = blockBetween(
  app,
  "function locationProfileSeriesMissingMonths(",
  "function locationProfileSelectableTourismSeriesItems("
);
const missingMonthsSandbox = {
  tourismVisitorYearMonth: chartSandbox.tourismVisitorYearMonth,
  locationProfileTourismSeriesEntryFailed: chartSandbox.entryFailed
};
vm.runInNewContext(`${missingMonthsSource}\nthis.missingMonths = locationProfileSeriesMissingMonths;`, missingMonthsSandbox);
const providerPipelineCoverageText = missingMonthsSandbox.missingMonths(normalizedProviderSeries);
check(providerPipelineCoverageText.includes("수집실패 2026.06, 2026.07"), "coverage detail must list collector-shaped fatal months as collection failures");
check(!providerPipelineCoverageText.includes("자료대기 2026.06") && !providerPipelineCoverageText.includes("자료대기 2026.07"), "coverage detail must not downgrade fatal months to data waiting");

// Empty sub-series stay folded instead of competing with observed series for
// the one visible chart slot. If every series is empty, one honest empty panel
// remains visible and the rest stay in a disclosure.
const seriesSelectorSource = blockBetween(
  app,
  "function locationProfileSelectableTourismSeriesItems(",
  "function renderLocationProfilePlacePanel("
);
const seriesSelectorSandbox = {
  state: { dictionaryTourismSeries: { resourceDemand: "culture" } },
  fmtNumber: (value) => String(value),
  escapeHtml: (value) => String(value ?? "")
};
vm.runInNewContext(
  `${seriesSelectorSource}\nthis.activeSeries = locationProfileActiveTourismSeries; this.renderSelector = renderLocationProfileSeriesSelector;`,
  seriesSelectorSandbox
);
const mixedItems = [
  { key: "service", label: "서비스", valueLabel: "123", note: "10/12개월", hasData: true },
  { key: "culture", label: "문화", valueLabel: "관측 없음", note: "0/12개월", hasData: false }
];
const mixedActive = seriesSelectorSandbox.activeSeries("resourceDemand", mixedItems);
const mixedSelector = seriesSelectorSandbox.renderSelector("resourceDemand", mixedItems, mixedActive);
check(mixedActive === "service", "a stored empty-series selection must fall back to an observed series");
check(tagsWithAttribute(mixedSelector, "data-location-tourism-series").length === 1, "zero-coverage series must not occupy a graph tab");
check(mixedSelector.includes("완전월 없는 계열 1개") && mixedSelector.includes("문화"), "folded zero-coverage series must remain discoverable without claiming partial metadata is absent");
const emptyItems = mixedItems.map((item) => ({ ...item, valueLabel: "관측 없음", note: "0/12개월", hasData: false }));
const emptyActive = seriesSelectorSandbox.activeSeries("resourceDemand", emptyItems);
const emptySelector = seriesSelectorSandbox.renderSelector("resourceDemand", emptyItems, emptyActive);
check(emptyActive === "service", "an all-empty family must retain one explicit empty panel");
check(tagsWithAttribute(emptySelector, "data-location-tourism-series").length === 1, "an all-empty family must expose only one empty graph tab");
check(emptySelector.includes("완전월 없는 계열 1개"), "remaining all-empty series must stay folded");

// Run the real strength and tourism-index panel builders with provider-shaped
// 12-month rows. Partial/missing metadata alone must not keep a 0-observation
// series beside an actually observed series.
const strengthPanelSource = blockBetween(
  app,
  "function locationProfileRecentSeriesWindow(",
  "function locationProfileTourismIndexValueLabel("
);
const indexPanelSource = blockBetween(
  app,
  "function locationProfileTourismIndexValueLabel(",
  "function renderLocationProfileResourceDemandPanel("
);
const panelSandbox = {
  state: {
    dictionaryTourismSeries: { strength: "spend", resourceDemand: "culture" },
    locationTourismIndexRefresh: {}
  },
  escapeHtml: (value) => String(value ?? ""),
  fmtNumber: (value) => String(value),
  tourismVisitorYearMonth: (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    return /^\d{6}$/.test(digits) ? digits : "";
  },
  tourismVisitorMonthIndex: (value) => {
    const yearMonth = String(value || "");
    if (!/^\d{6}$/.test(yearMonth)) return NaN;
    return Number(yearMonth.slice(0, 4)) * 12 + Number(yearMonth.slice(4, 6)) - 1;
  },
  tourismVisitorMonthFromIndex: (value) => {
    const year = Math.floor(Number(value) / 12);
    const month = Number(value) % 12 + 1;
    return `${year}${String(month).padStart(2, "0")}`;
  },
  tourismVisitorMonthLabel: (value) => `${String(value).slice(0, 4)}.${String(value).slice(4, 6)}`,
  locationProfileVisitorPeriodLabel: (period) => `${period.startYearMonth}~${period.endYearMonth}`,
  locationProfilePeriodLabel: () => "최근 저장 기간",
  locationProfileLatestPoint: (series = []) => series.filter((entry) => entry.hasValue && Number.isFinite(Number(entry.value))).at(-1) || null,
  locationProfileTourismSeriesHasObservedValue: chartSandbox.seriesObserved,
  tourismDemandStrengthUnitLabel: () => "지수",
  tourismDemandStrengthSeriesState: () => ({ chartText: "최근 12개월 관측 없음" }),
  tourismDemandStrengthNumberLabel: (value) => String(value),
  renderLocationProfileLineChart: () => '<div class="test-chart"></div>',
  renderLocationProfileCoverage: () => '<div class="test-coverage"></div>',
  locationProfileSeriesMissingMonths: () => "부분수집",
  locationProfileStatusBadge: (observed, yes, no) => `<span>${observed ? yes : no}</span>`,
  isAdminRole: () => false
};
vm.runInNewContext(
  `${seriesSelectorSource}\n${strengthPanelSource}\n${indexPanelSource}\nthis.renderStrengthPanel = renderLocationProfileStrengthPanel; this.renderIndexPanel = renderLocationProfileTourismIndexPanel;`,
  panelSandbox
);
const referencePeriod = { startYearMonth: "202508", endYearMonth: "202607", latestClosedYearMonth: "202607" };
const strengthPanelHtml = panelSandbox.renderStrengthPanel({
  staySeries: buildMonthlySeries({ values: { 10: 98, 11: 103 } }),
  spendSeries: buildMonthlySeries({ partial: [9, 10, 11] }),
  sourceLabel: "한국관광공사"
}, "산청군", { referencePeriod });
check(tagsWithAttribute(strengthPanelHtml, "data-location-tourism-series").length === 1, "a partial-only strength series must be folded behind the observed series");
check(strengthPanelHtml.includes("완전월 없는 계열 1개") && strengthPanelHtml.includes("부분수집 3개월"), "the folded strength series must retain its partial-month metadata");

const indexPanelHtml = panelSandbox.renderIndexPanel({
  periodRange: referencePeriod,
  sourceLabel: "한국관광공사",
  seriesSpecs: [
    { key: "service", label: "관광 서비스", title: "관광 서비스 수요" },
    { key: "culture", label: "문화 자원", title: "문화 자원 수요" }
  ],
  seriesByKey: {
    service: buildMonthlySeries({ values: { 8: 71, 11: 76 } }),
    culture: buildMonthlySeries({ partial: [10], failed: [11] })
  }
}, "산청군", { sourceKey: "resourceDemand", regionKey: "kr_gyeongnam_sancheong" });
check(tagsWithAttribute(indexPanelHtml, "data-location-tourism-series").length === 1, "a partial/failure-only tourism index series must be folded behind the observed series");
check(indexPanelHtml.includes("완전월 없는 계열 1개") && indexPanelHtml.includes("부분수집 1개월"), "the folded tourism index series must preserve useful collection metadata");

const strengthSummarySource = blockBetween(
  app,
  "function locationProfileStrengthSummaryModel(",
  "function renderObservedLocationProfile("
);
const strengthSummarySandbox = {
  locationProfileTourismSeriesHasObservedValue: chartSandbox.seriesObserved,
  tourismVisitorYearMonth: chartSandbox.tourismVisitorYearMonth,
  tourismVisitorMonthLabel: chartSandbox.tourismVisitorMonthLabel
};
vm.runInNewContext(`${strengthSummarySource}\nthis.summaryModel = locationProfileStrengthSummaryModel;`, strengthSummarySandbox);
const commonMonthSummary = strengthSummarySandbox.summaryModel(
  buildMonthlySeries({ values: { 9: 91, 11: 111 } }),
  buildMonthlySeries({ values: { 9: 191, 10: 210 } })
);
check(commonMonthSummary.commonYearMonth === "202605", "strength summary must choose the latest common complete month");
check(commonMonthSummary.stayPoint?.value === 91 && commonMonthSummary.spendPoint?.value === 191, "strength summary must pair both values from that same common month");
check(commonMonthSummary.note === "2026.05 공통 완전월", "strength summary must name the shared month explicitly");

const noCommonMonthSummary = strengthSummarySandbox.summaryModel(
  buildMonthlySeries({ values: { 11: 111 } }),
  buildMonthlySeries({ values: { 10: 210 } })
);
check(!noCommonMonthSummary.commonYearMonth, "different latest months must not be presented as a common period");
check(noCommonMonthSummary.stayLabel === "체류 · 2026.07" && noCommonMonthSummary.spendLabel === "소비 · 2026.06", "without a common month, each strength value must carry its own month");
check(noCommonMonthSummary.note.includes("공통 완전월 없음"), "without a common month, the summary must disclose the mismatch");
const emptyStrengthSummary = strengthSummarySandbox.summaryModel(buildMonthlySeries(), buildMonthlySeries());
check(emptyStrengthSummary.stayPoint === null && emptyStrengthSummary.spendPoint === null && emptyStrengthSummary.note === "최근 자료 대기", "missing strength observations must stay missing rather than becoming zero");
const nullStrengthSummary = strengthSummarySandbox.summaryModel(
  [{ yearMonth: "202607", status: "complete", hasValue: true, value: null }],
  [{ yearMonth: "202607", status: "complete", hasValue: true, value: null }]
);
check(nullStrengthSummary.stayPoint === null && nullStrengthSummary.spendPoint === null, "null strength payloads must not be coerced into observed zero values");
check(
  app.includes("const strengthSummary = locationProfileStrengthSummaryModel(staySummarySeries, spendSummarySeries)")
    && app.includes("label: strengthSummary.stayLabel")
    && app.includes("label: strengthSummary.spendLabel")
    && app.includes('"공통 완전월 없음 · 계열별 기준월"'),
  "the summary card must render the aligned strength model and disclose unmatched periods"
);

check(app.includes("item.observedPoints.length === 1") && app.includes("최근 12개월 관측 없음"), "zero observations must not be labelled as a single observation");
check(
  app.includes('els.dictionaryResult?.addEventListener("keydown"')
    && app.includes('"ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"')
    && app.includes("tabs[nextIndex].click()"),
  "tourism tabs must support arrow, Home, and End keyboard navigation"
);

const focusSource = blockBetween(
  app,
  "function focusLocationProfileTab(",
  "function locationProfileActiveTourismMetric("
);
let requestedFocusId = "";
let focusOptions = null;
const selectedProfileTab = {
  getAttribute: (name) => name === "aria-selected" ? "true" : null,
  focus: (options) => {
    focusOptions = options;
    focusSandbox.document.activeElement = selectedProfileTab;
  }
};
const focusSandbox = {
  document: {
    activeElement: null,
    getElementById: (id) => {
      requestedFocusId = id;
      return selectedProfileTab;
    }
  }
};
vm.runInNewContext(`${focusSource}\nthis.focusProfileTab = focusLocationProfileTab;`, focusSandbox);
check(focusSandbox.focusProfileTab("tourism") === true, "the rerendered main profile tab must receive focus");
check(requestedFocusId === "location-profile-tab-tourism", "main profile focus must resolve the new tab by its stable id");
check(focusOptions?.preventScroll === true, "restoring main profile tab focus must not jump the page");
const profileTabClickBlock = blockBetween(
  app,
  'const profileTab = event.target.closest("[data-location-profile-tab]")',
  'const dictionaryNavigate = event.target.closest("[data-dictionary-navigate]")'
);
check(
  profileTabClickBlock.indexOf("renderLocationDictionary(") < profileTabClickBlock.indexOf("focusLocationProfileTab(tab)"),
  "main profile click handling must focus the replacement tab after rerender"
);

// Verify normalization also preserves null semantics when a provider payload
// contains a numeric zero alongside a missing status.
const rollingSource = blockBetween(
  app,
  "function locationProfileVisitorRollingMonth(",
  "function locationProfileVisitorRollingEvidence("
);
const rollingSandbox = {
  optionalNumber: (value) => value === null || value === undefined || value === "" ? NaN : Number(value),
  tourismVisitorYearMonth: (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    return /^\d{6}$/.test(digits) ? digits : "";
  },
  tourismVisitorMonthIndex: (value) => {
    const yearMonth = String(value || "");
    if (!/^\d{6}$/.test(yearMonth)) return NaN;
    return Number(yearMonth.slice(0, 4)) * 12 + Number(yearMonth.slice(4, 6)) - 1;
  },
  tourismVisitorMonthFromIndex: (value) => {
    const year = Math.floor(Number(value) / 12);
    const month = Number(value) % 12 + 1;
    return `${year}${String(month).padStart(2, "0")}`;
  },
  tourismVisitorMonthLabel: (value) => String(value)
};
vm.runInNewContext(
  `${rollingSource}\nthis.normalizeMonth = locationProfileVisitorRollingMonth; this.normalizeWindow = locationProfileVisitorRollingWindow;`,
  rollingSandbox
);
const missingZero = rollingSandbox.normalizeMonth({ yearMonth: "202606", status: "missing", visitorCount: 0 });
check(missingZero.hasValue === false && missingZero.value === null, "missing visitor observations must remain null even when the payload contains zero");

// No tourism graph may force a desktop-sized SVG into a smaller card. This is
// a source-level guard against the 620/820px regression at desktop and mobile.
const graphRules = cssRulesContaining(styles, ".location-profile-chart");
const chartRules = graphRules.filter((rule) => /(^|[\s,])\.location-profile-chart(?:[\s.{:#]|$)/.test(rule.selector));
check(chartRules.length > 0, "location profile chart CSS rule is missing");
check(
  chartRules.every((rule) => !/min-width\s*:\s*[1-9]\d*px/i.test(rule.body)),
  "location profile charts must not use a fixed pixel min-width"
);
check(
  chartRules.some((rule) => {
    const values = declarations(rule.body);
    return values.get("width") === "100%" && values.get("min-width") === "0";
  }),
  "the base location profile chart must use width:100% and min-width:0"
);

const scrollRules = cssRulesContaining(styles, ".location-profile-chart-scroll");
check(scrollRules.length > 0, "location profile chart container CSS rule is missing");
check(
  scrollRules.every((rule) => !/overflow-x\s*:\s*auto/i.test(rule.body)),
  "location profile chart containers must not restore horizontal auto-scrolling"
);
check(
  scrollRules.some((rule) => /overflow(?:-x)?\s*:\s*(?:hidden|clip)/i.test(rule.body)),
  "location profile chart container must clip responsive SVG overflow"
);

const axisRules = cssRulesContaining(styles, ".location-profile-chart-axis");
const axisFontSizes = axisRules.flatMap((rule) => [...rule.body.matchAll(/font-size\s*:\s*([0-9.]+)px/gi)].map((match) => Number(match[1])));
check(axisFontSizes.some((size) => size >= 12), "chart axis labels must be at least 12px for legibility");
check(axisFontSizes.some((size) => size >= 18), "mobile SVG labels must compensate for compact-viewBox scaling");
check(
  /@container\s*\(max-width:\s*420px\)[\s\S]*?\.location-profile-tourism-dashboard \.location-profile-chart-axis\.is-compact-secondary\s*\{[^}]*display:\s*none/i.test(styles),
  "compact chart containers must hide lower-priority month labels"
);
check(styles.includes("max-width: 600px"), "tourism charts must cap desktop scaling so labels stay balanced");
check(styles.includes(".location-profile-chart-missing-zone"), "missing-zone graph styling is missing");
check(styles.includes(".location-profile-chart-latest-label"), "latest-value graph label styling is missing");

// Token contrast is checked independently for both themes because these graph
// labels and status badges appear on light and dark surfaces.
for (const theme of ["light", "dark"]) {
  const tokens = themeVariables(theme);
  const surface = tokens.get("--surface-control");
  const primary = tokens.get("--text-primary");
  const secondary = tokens.get("--text-secondary");
  const accent = tokens.get("--accent");
  const accentStrong = tokens.get("--accent-strong");
  const selectedSurface = tokens.get("--surface-selected");
  const warning = tokens.get("--warning");
  const warningStrong = tokens.get("--warning-strong");
  const dangerStrong = tokens.get("--danger-strong");
  check(contrastRatio(primary, surface) >= 4.5, `${theme} primary chart text must meet 4.5:1 contrast`);
  check(contrastRatio(secondary, surface) >= 4.5, `${theme} secondary chart text must meet 4.5:1 contrast`);
  check(contrastRatio(accent, surface) >= 3, `${theme} primary chart line must meet 3:1 graphical contrast`);
  check(contrastRatio(warning, surface) >= 3, `${theme} pending-month indicator must meet 3:1 graphical contrast`);
  check(contrastRatio(accentStrong, selectedSurface) >= 4.5, `${theme} latest-value label must meet 4.5:1 contrast`);
  check(contrastRatio(warningStrong, surface) >= 4.5, `${theme} pending-month text must meet 4.5:1 contrast`);
  check(contrastRatio(dangerStrong, surface) >= 4.5, `${theme} failed-month text must meet 4.5:1 contrast`);
}

check(
  /\.location-profile-chart-line\s*\{[^}]*stroke:\s*var\(--profile-series-accent\)/s.test(styles),
  "chart line must use the theme-aware series accent token"
);
check(
  /\.location-profile-chart-(?:axis|latest-label)[^{]*\{[^}]*var\(--text-(?:primary|secondary)\)/s.test(styles),
  "chart labels must use a theme-aware readable text token"
);
check(
  /\.location-profile-chart-missing-zone rect\s*\{[^}]*var\(--warning\)/s.test(styles)
    && /\.location-profile-chart-missing-zone text\s*\{[^}]*var\(--warning-strong\)/s.test(styles),
  "pending-month zones and labels must use warning theme tokens"
);
check(
  /\.location-profile-tourism-dashboard \.location-profile-chart-missing-zone\.is-failed text\s*\{[^}]*var\(--danger-strong\)/s.test(styles),
  "failed-month text must use the high-contrast danger token"
);
check(
  /\.location-profile-chart-latest-label rect\s*\{[^}]*var\(--surface-selected\)/s.test(styles)
    && /\.location-profile-chart-latest-label text\s*\{[^}]*var\(--theme-accent-strong\)/s.test(styles),
  "latest-value labels must use selected-surface and accent theme tokens"
);

if (failures.length) {
  console.error("Location profile tourism UI checks failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log("Location profile tourism UI checks passed");
}
