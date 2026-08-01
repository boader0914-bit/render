"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = (url) => {
  throw new Error(`Network calls are forbidden in administrator operations UI contract tests: ${url}`);
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

function functionMatch(name) {
  const matcher = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = matcher.exec(app);
  assert.ok(match, `missing function ${name}`);
  return match;
}

function functionRange(name) {
  const match = functionMatch(name);
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

function functionBlock(name) {
  return functionRange(name).range.body;
}

function functionSource(name) {
  const { match, range } = functionRange(name);
  return app.slice(match.index, range.close + 1);
}

function openingTagById(id) {
  const match = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, "i"));
  assert.ok(match, `missing element #${id}`);
  return match[0];
}

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "administrator operations mounts must not introduce duplicate ids");

for (const id of [
  "adminCollectionOverview",
  "adminRegionOverview",
  "adminConsoleDashboard",
  "adminMemberRequestDashboard",
  "adminSettingsOverview",
  "crawlForm",
  "trafficKeyForm",
  "trafficKeyCancelButton",
  "trafficKeyVerifyButton",
]) {
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `#${id} must remain unique`);
}

assert.match(openingTagById("adminCollectionOverview"), /aria-label="[^"]+"/);
assert.doesNotMatch(openingTagById("adminCollectionOverview"), /aria-live=/, "large collection summary must not be a noisy live region");
assert.match(openingTagById("adminRegionOverview"), /aria-label="[^"]+"/);
assert.doesNotMatch(openingTagById("adminRegionOverview"), /aria-live=/, "large region summary must not be a noisy live region");
assert.doesNotMatch(openingTagById("adminSettingsOverview"), /aria-live=/, "secret input changes must not announce the entire settings summary");
assert.match(openingTagById("crawlForm"), /aria-describedby="[^"]*adminCollectionOverview[^"]*crawlStatus/);
assert.match(openingTagById("trafficKeyForm"), /aria-describedby="[^"]*trafficKeyStatus[^"]*trafficKeyVerifyResult[^"]*adminSettingsOverview/);
assert.match(openingTagById("trafficKeyForm"), /autocomplete="off"/, "credential form must opt out of login autofill");
for (const id of [
  "naverClientIdInput",
  "naverClientSecretInput",
  "searchadApiKeyInput",
  "searchadSecretKeyInput",
  "searchadCustomerIdInput",
]) {
  assert.match(openingTagById(id), /autocomplete="new-password"/, `${id} must not reuse login credentials`);
}
assert.match(functionBlock("renderAdminCollectionOverview"), /role="status" aria-live="polite" aria-atomic="true"/);
assert.match(functionBlock("renderAdminRegionOverview"), /role="status" aria-live="polite" aria-atomic="true"/);
assert.match(functionBlock("renderAdminSettingsOverview"), /role="status" aria-live="polite" aria-atomic="true"/);

const valueState = vm.runInNewContext(`(${functionSource("adminValueState")})`);
assert.equal(valueState(null), "unavailable");
assert.equal(valueState(undefined), "unavailable");
assert.equal(valueState(""), "unavailable");
assert.equal(valueState(Number.NaN), "unavailable");
assert.equal(valueState(false), "unavailable");
assert.equal(valueState([]), "unavailable");
assert.equal(valueState({}), "unavailable");
assert.equal(valueState(0), "zero");
assert.equal(valueState("0"), "zero");
assert.equal(valueState(1), "ready");
assert.equal(valueState(-1), "unavailable");

const countValueState = vm.runInNewContext(`(${functionSource("adminCountValueState")})`);
for (const value of [null, undefined, "", "   ", false, true, [], {}, Number.NaN, Number.POSITIVE_INFINITY, -1, "not-a-number"]) {
  assert.equal(countValueState(value), "unavailable", `invalid count ${String(value)} must not render as an observed value`);
}
assert.equal(countValueState(0), "zero");
assert.equal(countValueState("0"), "zero");
assert.equal(countValueState(4), "ready");

const renderLocationCandidatePublicData = vm.runInNewContext(
  `(${functionSource("renderLocationCandidatePublicData")})`,
  { escapeHtml: String, fmtNumber: String }
);
assert.equal(renderLocationCandidatePublicData(null), "", "a missing saved location request must render safely");
assert.equal(renderLocationCandidatePublicData(undefined), "", "an undefined saved location request must render safely");
assert.equal(
  renderLocationCandidatePublicData({ baseInfo: null, publicData: null }),
  "",
  "nullable saved location sections must render safely"
);

const collectionContext = {
  state: { crawlProgressRunning: false },
  currentCrawlFormPayload: () => ({}),
  crawlPreviewMeta: () => ({}),
  clientSearchIntent: (keyword) => keyword === "스테이폴리오"
    ? { intent: "platform_search", lodgingCategoryKey: "", region: null }
    : { intent: "region_search", lodgingCategoryKey: "pension", region: { query: "가평" } },
  searchIntentHintMeta: (keyword) => keyword === "스테이폴리오"
    ? { text: "플랫폼 검색은 수집 연결 전", supported: false }
    : { text: keyword ? "지역 검색" : "검색어 입력", supported: Boolean(keyword) },
  collectionPurposeProfile: () => ({ key: "basic_db", label: "기본", defaultRange: "1-10" }),
  productModeLabel: (value) => value,
  lodgingCategoryIntentLabel: (value) => value,
  formatElapsed: (value) => `${value}s`,
};
vm.createContext(collectionContext);
vm.runInContext(functionSource("adminCollectionReadinessModel"), collectionContext);
const readiness = collectionContext.adminCollectionReadinessModel;
let model = readiness({ keyword: "", productMode: "lodging", collectionPurpose: "basic_db" }, {});
assert.equal(model.stateKey, "blocked");
assert.equal(model.executable, false);
model = readiness({ keyword: "스테이폴리오", productMode: "lodging", collectionPurpose: "basic_db" }, {});
assert.equal(model.stateKey, "blocked");
model = readiness({ keyword: "가평펜션", productMode: "lodging", collectionPurpose: "basic_db" }, {});
assert.equal(model.stateKey, "preview");
assert.equal(model.serverResolved, false);
model = readiness(
  { keyword: "가평펜션", productMode: "lodging", collectionPurpose: "basic_db" },
  { resolvedIntent: { intent: "region_search", lodgingCategoryKey: "pension", region: { query: "가평" } }, intentSupported: true }
);
assert.equal(model.stateKey, "ready");
assert.equal(model.serverResolved, true);
assert.equal(model.productLabel, "lodging");
assert.equal(model.categoryLabel, "pension");
model = readiness({ keyword: "가평펜션", productMode: "lodging", collectionPurpose: "basic_db" }, { estimateError: true });
assert.equal(model.stateKey, "warning");
collectionContext.state.crawlProgressRunning = true;
assert.equal(readiness({ keyword: "가평펜션", productMode: "lodging", collectionPurpose: "basic_db" }, {}).stateKey, "running");

const estimateScheduleContext = {
  state: { crawlProgressRunning: false, crawlEstimateRequestId: 9, crawlEstimateTimer: 77 },
  cleared: 0,
  scheduled: 0,
  currentCrawlFormPayload: () => ({ keyword: "" }),
  isAdminRole: () => true,
};
estimateScheduleContext.clearCrawlEstimateTimer = () => {
  estimateScheduleContext.cleared += 1;
  estimateScheduleContext.state.crawlEstimateTimer = null;
};
estimateScheduleContext.setTimeout = () => {
  estimateScheduleContext.scheduled += 1;
  return 1;
};
vm.createContext(estimateScheduleContext);
vm.runInContext(functionSource("scheduleCrawlEstimatePreviewRefresh"), estimateScheduleContext);
estimateScheduleContext.scheduleCrawlEstimatePreviewRefresh({ keyword: "   " });
assert.equal(estimateScheduleContext.cleared, 1, "clearing a keyword must cancel the pending estimate timer");
assert.equal(estimateScheduleContext.state.crawlEstimateRequestId, 10, "clearing a keyword must invalidate an in-flight estimate response");
assert.equal(estimateScheduleContext.scheduled, 0, "an empty keyword must not schedule another estimate request");

function crawlControl(disabled = false) {
  return {
    disabled,
    dataset: {},
    hasAttribute(name) {
      return name === "data-crawl-disabled-before-run" && Object.prototype.hasOwnProperty.call(this.dataset, "crawlDisabledBeforeRun");
    },
  };
}
const initiallyEnabledCrawlControl = crawlControl(false);
const initiallyDisabledCrawlControl = crawlControl(true);
const crawlControlContext = {
  els: {
    keywordInput: initiallyEnabledCrawlControl,
    checkInInput: initiallyDisabledCrawlControl,
    crawlForm: { querySelectorAll: () => [] },
  },
};
vm.createContext(crawlControlContext);
vm.runInContext(functionSource("syncCrawlExecutionControls"), crawlControlContext);
crawlControlContext.syncCrawlExecutionControls(true);
assert.equal(initiallyEnabledCrawlControl.disabled, true);
assert.equal(initiallyDisabledCrawlControl.disabled, true);
crawlControlContext.syncCrawlExecutionControls(false);
assert.equal(initiallyEnabledCrawlControl.disabled, false, "run completion must restore an originally enabled field");
assert.equal(initiallyDisabledCrawlControl.disabled, true, "run completion must preserve an originally disabled field");

const submitCrawlSource = functionBlock("submitCrawl");
assert.match(submitCrawlSource, /intentSupported === false[\s\S]*setCrawlProgress\(false, "", "", preview, payload\)/);
assert.doesNotMatch(submitCrawlSource, /intentSupported === false[\s\S]{0,240}submitButton\.disabled = false/, "server-rejected intent must remain blocked");
assert.match(functionBlock("setCrawlProgress"), /crawlExecutionPayload/);
assert.match(functionBlock("setCrawlProgress"), /syncCrawlExecutionControls\(active\)/);
assert.match(functionBlock("setCrawlProgress"), /if \(active && submitButton\) submitButton\.disabled = true/, "restored active collection must also lock submit");

for (const endpoint of [
  "/api/crawl-estimate",
  "/api/crawl",
  "/api/crawl-status",
  "/api/runs",
  "/api/b2b-members/",
  "/api/account-delete-requests/",
  "/api/settings/traffic-keys",
  "/api/settings/traffic-keys/verify",
]) {
  assert.ok(app.includes(endpoint), `${endpoint} must preserve its existing API contract`);
}

assert.match(app, /data-admin-metric-state=/);
assert.match(functionBlock("adminAnalyticsOverviewHtml"), /categorySummary\.primaryCounts/);
assert.match(functionBlock("adminAnalyticsOverviewHtml"), /observedPlatforms/);
assert.doesNotMatch(functionBlock("adminAnalyticsOverviewHtml"), /platformStats\.names\.length\s*:/);

const analyticsContext = {
  state: { data: {}, companyMaster: null },
  isAdminRole: () => true,
  summarizeSales: () => ({ sold: 0, supply: 0 }),
  reportPlatformStats: () => ({ names: ["네이버", "NOL"], counts: { 네이버: 0, NOL: 0 } }),
  activeKeyword: () => "fixture",
  dateRangeLabel: () => "기간 확인",
  compactDateTime: () => "2026-07-31",
  escapeHtml: (value) => String(value ?? ""),
  fmtNumber: (value) => String(value),
  adminAnalyticsValueCell: (label, value, note) => `<metric data-label="${label}" data-value="${value === null ? "NULL" : value}">${note}</metric>`,
};
vm.createContext(analyticsContext);
vm.runInContext(functionSource("adminAnalyticsOverviewHtml"), analyticsContext);
analyticsContext.state.data = { run: { id: "run-1" }, availability: { items: [{}] } };
let analyticsHtml = analyticsContext.adminAnalyticsOverviewHtml("summary");
assert.match(analyticsHtml, /data-label="판매 표본" data-value="NULL"/);
assert.match(analyticsHtml, /data-label="대표 유형" data-value="NULL"/);
assert.match(analyticsHtml, /data-label="확인 플랫폼" data-value="NULL"/);
analyticsContext.state.data = {
  run: { id: "run-2" },
  availability: { items: [{ nightTotalStock: 0, nightAvailableStock: 0 }] },
  companyMaster: { categorySummary: { totalCompanies: 0, primaryCounts: {} } },
};
analyticsHtml = analyticsContext.adminAnalyticsOverviewHtml("summary");
assert.match(analyticsHtml, /data-label="판매 표본" data-value="0"/);
assert.match(analyticsHtml, /data-label="대표 유형" data-value="0"/);

assert.match(functionBlock("renderAdminRegionOverview"), /waiting:[\s\S]*error:/);
assert.match(functionBlock("renderAdminRegionOverview"), /API 미신청·미연결은 지역 오류가 아님/);
assert.doesNotMatch(functionBlock("adminSelectedRegion"), /regions\[0\]/);
assert.match(functionBlock("adminRegionCardHtml"), /aria-pressed/);
assert.match(functionBlock("loadLocationDictionary"), /state\.dictionary\s*=\s*\{\s*error:/);
assert.match(functionBlock("loadLocationCardRequests"), /renderAdminRegionOverview\(\)/);
assert.match(functionBlock("adminRegionalDetailPanel"), /data-admin-region-back/);
assert.match(functionBlock("bindEvents"), /adminRegionReturnFocusKey[\s\S]*data-admin-region-key/);
assert.match(functionBlock("saveAdminRegionReview"), /window\.confirm/);
assert.match(functionBlock("saveAdminRegionReview"), /regionLabel[\s\S]*statusLabel/);
assert.match(functionBlock("applyAdminRegionApproval"), /window\.confirm/);

for (const hook of [
  "data-admin-member-select",
  "data-admin-member-back",
  "data-admin-member-filter-clear",
  "data-admin-member-query",
  "data-admin-member-status-filter",
  "data-admin-member-type-filter",
]) {
  assert.ok(app.includes(hook), `${hook} member workbench hook must remain available`);
}
assert.match(functionBlock("adminConsoleMemberPanel"), /adminMemberRecordKey/);
assert.doesNotMatch(functionBlock("adminConsoleMemberPanel"), /adminConsoleMemberLegacyPanel/);
assert.match(functionBlock("adminMemberSelectButton"), /aria-pressed/);
assert.match(functionBlock("adminMemberDetailHtml"), /tabindex="-1"/);
assert.match(functionBlock("adminMaskedContact"), /\*\*\*/);
assert.match(functionBlock("adminConsoleAccountDeletePanel"), /adminMaskedContact\(request\.contact/);
assert.doesNotMatch(functionBlock("adminConsoleAccountDeletePanel"), /escapeHtml\(request\.contact/);
assert.match(app, /window\.confirm\(`\$\{request\?\.username/);
assert.match(functionBlock("adminConsoleMemberPanel"), /visibleLimit\s*=\s*50/);
assert.match(functionBlock("adminConsoleMemberPanel"), /selectedVisible[\s\S]*rows\.push\(selected\)/);
assert.match(functionBlock("adminConsoleAccountDeletePanel"), /adminCountMetricHtml\("미처리"/);
assert.match(functionBlock("adminConsoleAccountDeletePanel"), /상태 미확인/);
assert.match(functionBlock("adminConsoleAccountDeletePanel"), /요청 식별자 없음 · 읽기 전용/);

const deleteStatusContext = {};
vm.createContext(deleteStatusContext);
vm.runInContext(functionSource("adminDeleteRequestStatusKey"), deleteStatusContext);
assert.equal(deleteStatusContext.adminDeleteRequestStatusKey("received"), "received");
assert.equal(deleteStatusContext.adminDeleteRequestStatusKey("legacy"), "unknown");
assert.equal(deleteStatusContext.adminDeleteRequestStatusKey(""), "unknown");

const memberFilterContext = {
  state: { adminMemberFilters: {} },
  compactSearchText: (value) => String(value || "").replace(/\s+/g, "").toLowerCase(),
  adminMemberSearchText: (member) => JSON.stringify(member).replace(/\s+/g, "").toLowerCase(),
};
vm.createContext(memberFilterContext);
for (const name of ["adminMemberStatusKey", "adminMemberAccountTypeKey", "adminMemberMatchesFilters"]) {
  vm.runInContext(functionSource(name), memberFilterContext);
}
const unknownMember = { username: "legacy-user", status: "pending", accountType: "legacy" };
assert.equal(memberFilterContext.adminMemberStatusKey("pending"), "unknown");
assert.equal(memberFilterContext.adminMemberAccountTypeKey("legacy"), "unknown");
assert.equal(memberFilterContext.adminMemberMatchesFilters(unknownMember, { status: "unknown", accountType: "unknown" }), true);
assert.equal(memberFilterContext.adminMemberMatchesFilters(unknownMember, { query: "legacy", status: "unknown", accountType: "unknown" }), true);
assert.equal(memberFilterContext.adminMemberMatchesFilters(unknownMember, { status: "active", accountType: "all" }), false);
assert.match(functionBlock("adminMemberDetailHtml"), /policyMutable[\s\S]*disabled/);
assert.match(functionBlock("adminMemberDetailHtml"), /expandedPolicyKnown/);
assert.match(functionBlock("adminMemberDetailHtml"), /typeof expandedPolicyValue === "boolean"/);
assert.match(functionBlock("updateB2BMemberAdminPolicy"), /expandedPolicyKnown/);
assert.match(functionBlock("updateB2BMemberAdminPolicy"), /typeof expandedPolicyValue === "boolean"/);
assert.doesNotMatch(functionBlock("updateB2BMemberAdminPolicy"), /Boolean\(policy\.expandedAllowed \|\| policy\.expandedSearchAllowed\)/);

function assertGuardBeforeFetch(name) {
  const block = functionBlock(name);
  const guard = block.indexOf("allowAdminOperationsMutation");
  const fetch = block.indexOf("fetchJson");
  assert.ok(guard >= 0, `${name} must use the administrator mutation guard`);
  assert.match(block, /if\s*\([^\n;]*allowAdminOperationsMutation[^\n;]*\)\s*return/, `${name} must return when its mutation guard rejects the action`);
  if (fetch >= 0) assert.ok(guard < fetch, `${name} must guard before its first fetch`);
}

for (const name of [
  "updateB2BMemberAdminPolicy",
  "updateAccountDeleteRequestStatus",
  "submitTrafficKeys",
  "verifyTrafficKeys",
  "saveLocationCardCandidateAction",
  "saveLocationCardRequestQueueAction",
  "saveLocationScoreOverride",
  "applyAdminRegionCompanyBulkReview",
  "saveAdminRegionReview",
]) {
  assertGuardBeforeFetch(name);
}

function assertRejectedGuardMakesNoRequest(name, args = [], additions = {}) {
  let fetchCount = 0;
  const context = {
    state: {},
    els: { trafficKeyVerifyButton: {} },
    allowAdminOperationsMutation: () => false,
    fetchJson: () => {
      fetchCount += 1;
      throw new Error(`${name} must not request data after a rejected guard`);
    },
    ...additions,
  };
  vm.createContext(context);
  vm.runInContext(functionSource(name), context);
  context[name](...args);
  assert.equal(fetchCount, 0, `${name} must make zero requests when the guard rejects the action`);
}

assertRejectedGuardMakesNoRequest("updateB2BMemberAdminPolicy", ["member-1", {}]);
assertRejectedGuardMakesNoRequest("updateAccountDeleteRequestStatus", ["request-1", {}]);
assertRejectedGuardMakesNoRequest("submitTrafficKeys", [{ preventDefault() {} }]);
assertRejectedGuardMakesNoRequest("verifyTrafficKeys");
assertRejectedGuardMakesNoRequest("saveLocationCardCandidateAction", [{ dataset: { locationCandidateAction: "requested" } }]);
assertRejectedGuardMakesNoRequest("saveLocationScoreOverride", [{}, false]);

const submitTrafficKeys = functionBlock("submitTrafficKeys");
assert.doesNotMatch(submitTrafficKeys, /verifyTrafficKeys\s*\(/, "saving keys must not automatically contact external APIs");
assert.match(submitTrafficKeys, /adminSettingsSaving/);
assert.match(submitTrafficKeys, /adminSettingsDirty = false/);
assert.match(submitTrafficKeys, /!Object\.keys\(payload\)\.length[\s\S]*trafficKeyForm\.reset\(\)/);
assert.match(functionBlock("verifyTrafficKeys"), /window\.confirm/);
assert.match(functionBlock("cancelTrafficKeyDraft"), /trafficKeyForm\.reset\(\)/);
assert.match(functionBlock("cancelTrafficKeyDraft"), /adminSettingsDirty = false/);
assert.match(functionBlock("loadTrafficState"), /renderTrafficState\(\{ error: true \}\)/);
assert.match(functionBlock("renderAdminSettingsOverview"), /datalabConfigured/);
assert.match(functionBlock("renderAdminSettingsOverview"), /searchadConfigured/);
assert.doesNotMatch(functionBlock("renderAdminSettingsOverview"), /clientSecret|secretKey|apiKeyStorage|configDir|cookie|token/i);
assert.match(functionBlock("bindEvents"), /adminSettingsDirty/);
assert.match(functionBlock("bindEvents"), /String\(input\.value \|\| ""\)\.trim\(\)/);
assert.match(functionBlock("bindEvents"), /trafficKeyCancelButton/);
assert.match(functionBlock("verifyTrafficKeys"), /adminSettingsVerifying = true/);
assert.match(functionBlock("verifyTrafficKeys"), /adminSettingsVerifying = false/);
assert.match(functionBlock("submitTrafficKeys"), /adminSettingsVerifying/);

const trafficStateContext = {
  state: {},
  els: { trafficApiState: { textContent: "" } },
  renderTrafficVerification() {},
  renderAdminSettingsOverview() {},
  renderDemand() {},
};
vm.createContext(trafficStateContext);
vm.runInContext(functionSource("renderTrafficState"), trafficStateContext);
trafficStateContext.renderTrafficState({ datalabConfigured: true, searchadConfigured: true, verification: { datalab: { ok: true }, searchad: { ok: false } } });
assert.equal(trafficStateContext.els.trafficApiState.textContent, "일부 연결 확인");
trafficStateContext.renderTrafficState({ datalabConfigured: true, searchadConfigured: true, verification: { datalab: { ok: true }, searchad: { ok: true } } });
assert.equal(trafficStateContext.els.trafficApiState.textContent, "연동 정상");
trafficStateContext.renderTrafficState({ datalabConfigured: true, searchadConfigured: false });
assert.equal(trafficStateContext.els.trafficApiState.textContent, "키 저장됨");
trafficStateContext.renderTrafficState({ error: true });
assert.equal(trafficStateContext.els.trafficApiState.textContent, "조회 실패");

const securityPanel = functionBlock("adminConsoleSecurityPanel");
assert.doesNotMatch(securityPanel, /escapeHtml\([^)]*storage\./, "internal storage paths must not be rendered");
assert.match(securityPanel, /내부 경로 비공개/);

const stageMarker = "/* Stage 5 admin operations workbenches */";
const stageStart = css.indexOf(stageMarker);
const stageEnd = css.indexOf("/* Light theme compatibility", stageStart);
assert.ok(stageStart >= 0 && stageEnd > stageStart, "Stage 5 styles must have a bounded responsibility block");
const stageCss = css.slice(stageStart, stageEnd);
for (const selector of [
  ".admin-operations-context",
  ".admin-operation-status",
  ".admin-member-toolbar",
  ".admin-member-workbench",
  ".admin-member-option",
  ".admin-member-detail-workbench",
  ".admin-settings-actions",
]) {
  assert.ok(stageCss.includes(selector), `${selector} must have a Stage 5 style contract`);
}
assert.match(stageCss, /min-height:\s*var\(--touch-target-min\)/);
assert.match(stageCss, /@media \(min-width: 721px\) and \(max-width: 1120px\)/);
assert.match(stageCss, /@media \(max-width: 720px\)/);
assert.match(stageCss, /@media \(max-width: 390px\)/);
assert.match(stageCss, /overflow-wrap:\s*anywhere/);
assert.match(stageCss, /#adminMemberRequestDashboard \.admin-member-option\[aria-pressed="true"\]/, "selected member styling must outrank the dashboard button base rule");
assert.match(stageCss, /#adminMemberRequestDashboard[\s\S]*:disabled[\s\S]*--color-disabled-surface/, "member and settings disabled controls must retain a semantic disabled surface");
assert.match(stageCss, /button\.danger:not\(:disabled\)/, "member account suspension must remain visually distinct");
assert.match(stageCss, /button\.restore:not\(:disabled\)/, "member account restoration must remain visually distinct");
assert.match(stageCss, /data-admin-member-back/, "member mobile return action must meet the shared touch-target contract");
assert.match(stageCss, /advanced-box > summary/, "settings disclosure must meet the shared touch-target contract");
assert.match(stageCss, /@media \(max-width: 720px\)[\s\S]*\.admin-member-option[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/, "member rows must collapse before common 393-540px mobile widths");
assert.match(stageCss, /\.admin-region-detail-actions[\s\S]*data-admin-region-back|\.admin-region-detail-actions/, "region detail must expose a bounded return-action layout");
assert.doesNotMatch(stageCss, /#[0-9a-f]{3,8}\b/i, "Stage 5 workbench styles must use semantic tokens instead of new hex colors");
assert.doesNotMatch(stageCss, /filter:\s*(?:invert|hue-rotate)/i);
assert.doesNotMatch(css, /body\.role-admin \.company-master-route-summary article\s*\{[^}]*rgba\(/s, "settings route summary must not retain a fixed dark-only surface");
const surfaceV3Start = css.indexOf("/* Surface contrast contract v3");
const surfaceV3End = css.indexOf("/* Surface contrast contract v4", surfaceV3Start);
assert.ok(surfaceV3Start >= 0 && surfaceV3End > surfaceV3Start, "final surface normalization block must remain bounded");
const surfaceV3Css = css.slice(surfaceV3Start, surfaceV3End);
assert.match(surfaceV3Css, /\.history-ops-log button:not\(\.watch\):not\(\.bad\)/, "final surface normalization must not erase history warning and failure tones");
assert.match(surfaceV3Css, /\.history-ops-log article:not\(\.good\):not\(\.watch\):not\(\.bad\)/, "final surface normalization must not erase history success tones");
assert.match(surfaceV3Css, /\.demand-signal-card:not\(\.positive\):not\(\.warning\)/, "final surface normalization must preserve demand status tones");
assert.match(surfaceV3Css, /\.collection-diagnostic-list div:not\(\.good\):not\(\.watch\):not\(\.bad\)/, "final surface normalization must preserve collection diagnostic tones");
assert.match(surfaceV3Css, /\.admin-region-ops-queue-grid article:not\(\.good\):not\(\.watch\):not\(\.hot\)/, "final surface normalization must not erase region queue tones");
assert.doesNotMatch(surfaceV3Css, /\.history-ops-log button,|\.history-ops-log article,|\.demand-signal-card,|\.collection-diagnostic-list div,|\.company-insight-grid div,|\.b2b-company-card-summary div,/, "final surface normalization must not contain unqualified status-card selectors");
const adminReadabilityStart = css.indexOf("/* Admin readability final pass");
const adminReadabilityEnd = css.indexOf("/* Final contrast lock", adminReadabilityStart);
const adminReadabilityCss = css.slice(adminReadabilityStart, adminReadabilityEnd);
assert.match(adminReadabilityCss, /\.admin-delete-row:not\(\.verifying\):not\(\.processing\):not\(\.completed\):not\(\.rejected\)/, "admin readability normalization must preserve deletion request status surfaces");
assert.match(css, /\.admin-console-dashboard article:not\(\.good\):not\(\.watch\):not\(\.hot\)/, "light compatibility must preserve administrator status surfaces");
assert.match(css, /\.admin-member-request-dashboard article:not\(\.verifying\):not\(\.processing\):not\(\.completed\):not\(\.rejected\)/, "light compatibility must preserve deletion request status surfaces");

for (const forbidden of ["rgba(13, 20, 29", "#dcecff", "#e7f1ff", "#1f4f83"]) {
  const adminOpsLegacyStart = css.indexOf("body.role-admin #adminConsoleDashboard");
  const adminOpsLegacyEnd = css.indexOf("body.role-admin .company-master-route-summary", adminOpsLegacyStart);
  assert.doesNotMatch(css.slice(adminOpsLegacyStart, adminOpsLegacyEnd), new RegExp(forbidden.replace(/[()]/g, "\\$&"), "i"), `light-compatible administrator operations rules must not retain ${forbidden}`);
}

console.log("Administrator collection, analytics, region, member, and settings UI contract checks passed");
