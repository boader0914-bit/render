"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = (url) => {
  throw new Error(`External requests are forbidden in B2B secondary workbench tests: ${url}`);
};

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

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

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "Stage 6 mounts must not introduce duplicate ids");

for (const id of [
  "b2bCompetitionContext",
  "b2bCompetitionToolbar",
  "b2bMapViewControls",
  "b2bMapStatus",
  "b2bMapCompanyList",
  "b2bAccountWorkspace",
  "b2bAccountWorkspaceTitle",
  "b2bAccountWorkspaceBody",
]) {
  assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `#${id} must remain unique`);
}

assert.match(openingTagById("b2bAccountWorkspace"), /class="[^"]*tab-panel[^"]*"/);
assert.match(openingTagById("b2bAccountWorkspace"), /data-panel="account"/);
assert.match(openingTagById("b2bAccountWorkspace"), /aria-labelledby="b2bAccountWorkspaceTitle"/);
assert.match(openingTagById("b2bMapStatus"), /role="status"[^>]*aria-live="polite"/);
assert.match(app, /b2b:\s*\{[\s\S]*?allowedTabs:\s*\["report",\s*"rank",\s*"map",\s*"demand",\s*"account"\]/);
assert.match(functionBlock("renderAll"), /renderB2BAccountWorkspace\(\)/);
assert.match(functionBlock("setActiveTab"), /state\.activeTab === "account"[\s\S]*renderB2BAccountWorkspace\(\)/);

const compactSearchText = (value) => String(value || "").toLowerCase().replace(/\s+/g, "");
const competitionContext = {
  compactSearchText,
  b2bBoundaryBucket: (item) => item.boundary || "unknown",
  b2bCompetitionDataProfile: (item) => ({ state: item.dataState || "unavailable" }),
};
vm.createContext(competitionContext);
vm.runInContext(functionSource("b2bCompetitionFilteredItems"), competitionContext);
const filterCompetition = competitionContext.b2bCompetitionFilteredItems;
const competitionSource = [
  { name: "Blue Pool Villa", region: "Gyeongju", boundary: "local", dataState: "ready" },
  { name: "Spring Stay", region: "Jeju", boundary: "outside", dataState: "partial" },
  { name: "No Data", region: "Jeju", boundary: "outside", dataState: "unavailable" },
];
const filtered = filterCompetition(competitionSource, { query: "spring", boundary: "outside", dataState: "partial" });
assert.equal(filtered.length, 1);
assert.equal(filtered[0].name, "Spring Stay");
assert.equal(competitionSource.length, 3, "filtering must not mutate source rows");

const competitionProfileContext = {
  inventoryLinked: (item) => Boolean(item.linked),
  salesStats: (item) => item.sales || {},
  itemRevenueStats: (item) => item.revenue || { basis: "missing" },
  finiteNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  fmtNumber: (value) => String(value),
  fmtWon: (value) => String(value),
};
vm.createContext(competitionProfileContext);
vm.runInContext(functionSource("b2bCompetitionDataProfile"), competitionProfileContext);
const profile = competitionProfileContext.b2bCompetitionDataProfile;
const observedZero = profile({ linked: true, sales: { supply: 5, sold: 0 }, revenue: { basis: "observed", adjustedRevenue: 0 } });
assert.equal(observedZero.state, "ready");
assert.equal(observedZero.hasSales, true);
assert.equal(observedZero.hasRevenue, true);
const missing = profile({ linked: false, sales: {}, revenue: { basis: "missing" } });
assert.equal(missing.state, "unavailable");

assert.match(functionBlock("renderB2BCompetitionSelection"), /sourceItems\.findIndex/);
assert.match(functionBlock("renderB2BCompetitionSelection"), /visibleItems\.includes\(selected\)/);
assert.doesNotMatch(functionBlock("renderB2BCompetitionSelection"), /visibleItems\s*\[\s*0\s*\]/);
assert.match(functionBlock("bindEvents"), /data-b2b-competition-select/);
assert.match(functionBlock("bindEvents"), /b2bCompetitionQuery/);
assert.match(functionBlock("closeB2BCompetitionSelection"), /\.focus\(\)/);
assert.match(functionBlock("renderCompanies"), /item\.rank \|\| sourceIndex \+ 1/);
assert.match(functionBlock("renderCompanies"), /aria-controls="companyList"/);
assert.doesNotMatch(functionBlock("renderCompanies"), /aria-controls="b2bCompetitionSelectionTitle"/);

const coordinateContext = {
  B2B_LOCATION_STATUS_META: {
    verified: { label: "검증 위치", tone: "ready", icon: "●", mappable: true },
    resolved: { label: "확인 위치", tone: "info", icon: "●", mappable: true },
    approximate: { label: "근사 위치", tone: "warning", icon: "◆", mappable: true },
    ambiguous: { label: "위치 검토 필요", tone: "warning", icon: "?", mappable: false },
    not_found: { label: "좌표 미수집", tone: "unavailable", icon: "—", mappable: false },
    invalid: { label: "좌표 오류", tone: "error", icon: "!", mappable: false },
    pending: { label: "좌표 확인 대기", tone: "pending", icon: "…", mappable: false },
    error: { label: "좌표 확인 실패", tone: "error", icon: "!", mappable: false }
  }
};
vm.createContext(coordinateContext);
vm.runInContext(functionSource("coordinatePairsFromValue"), coordinateContext);
vm.runInContext(functionSource("coordinateFromValue"), coordinateContext);
vm.runInContext(functionSource("explicitLocationContract"), coordinateContext);
vm.runInContext(functionSource("normalizedLocationStatus"), coordinateContext);
vm.runInContext(functionSource("coordinateStatusFromValue"), coordinateContext);
const coordinate = coordinateContext.coordinateFromValue;
const coordinateStatus = coordinateContext.coordinateStatusFromValue;
assert.equal(coordinate({ longitude: 127.1, latitude: 37.5 }).source, "exact");
assert.equal(coordinateStatus({}).status, "not_found");
assert.equal(coordinateStatus({ lon: 127.1 }).status, "invalid");
assert.equal(coordinateStatus({ lon: 0, lat: 0 }).status, "invalid");
assert.equal(coordinateStatus({ lon: 37.5, lat: 127.1 }).status, "invalid");
assert.equal(coordinateStatus({ lon: 140, lat: 37 }).status, "invalid");
assert.equal(coordinateStatus({ x: 127.1, y: 37.5 }).status, "not_found");
assert.equal(coordinateStatus({ companyProfile: { location: { status: "resolved", lat: 37.5, lon: 127.1, precision: "parcel", source: "provider" } } }).status, "resolved");
assert.equal(coordinateStatus({ companyProfile: { location: { status: "resolved", lat: 37.5, lon: 127.1, precision: "street", source: "provider" } } }).status, "approximate");
assert.equal(coordinateStatus({ companyProfile: { location: { status: "approximate", lat: 37.5, lon: 127.1, precision: "street", source: "provider" } } }).status, "approximate");
assert.equal(coordinateStatus({ companyProfile: { location: { status: "resolved", lat: 37.5, lon: 127.1, precision: "locality", source: "provider" } } }).status, "ambiguous");
assert.doesNotMatch(app, /fallbackCompanyCoordinate/);
assert.doesNotMatch(app, /source:\s*"estimated"/);
assert.match(functionBlock("companyMapPointRows"), /coordinateStatusFromValue/);
assert.match(functionBlock("companyMapPointRows"), /권역 미확인/);
assert.match(functionBlock("regionBounds"), /coordinateFromValue\(region\)/);
assert.match(functionBlock("renderB2BMapCompanyList"), /role="list"/);
assert.match(functionBlock("renderB2BMapCompanyList"), /data-b2b-map-company-key/);
assert.match(functionBlock("renderB2BMapCompanyList"), /aria-pressed=/);
assert.match(functionBlock("renderB2BMapCompanyList"), /data-open-company="\$\{row\.itemIndex\}" data-b2b-map-company-key/);
assert.match(functionBlock("syncB2BMapSelectionDom"), /matches\("\[data-b2b-map-select\]"\)/);
assert.match(functionBlock("renderMapControls"), /CORE_ORDER\.map/);
assert.doesNotMatch(functionBlock("renderMapControls"), /CORE_ORDER\.slice\(0,\s*5\)/);
assert.match(functionBlock("renderMap"), /companyMapHitRadius\(\)/);
assert.match(functionBlock("renderMap"), /company-map-hit" r="\$\{companyMarkerHitRadius\.toFixed\(1\)\}"/);
assert.match(functionBlock("renderB2BMapViewControls"), /data-b2b-map-view="map"/);
assert.match(functionBlock("renderB2BMapViewControls"), /data-b2b-map-view="list"/);
assert.match(functionBlock("renderB2BMapViewControls"), /state\.mapLoadState === "unavailable"/);
assert.match(functionBlock("bindEvents"), /data-b2b-map-select/);
assert.match(app, /\.company-map-marker\[data-b2b-map-select\][\s\S]*event\.key === "Enter"[\s\S]*event\.key === " "/);

const demandContext = {
  optionalNumber: (value) => value === null || value === undefined || value === "" ? Number.NaN : Number(value),
  fmtNumber: (value) => String(value),
  fmtRate: (value) => `${Math.round(Number(value) * 100)}%`,
  fmtSearchRate: (value) => `${Number(value)}%`,
  escapeHtml: (value) => String(value),
  demandStructureSource: () => null,
  demandTrendSource: () => ({ hasSeries: false, reason: "" }),
};
vm.createContext(demandContext);
vm.runInContext(functionSource("demandTrafficObserved"), demandContext);
vm.runInContext(functionSource("demandMobileShare"), demandContext);
vm.runInContext(functionSource("demandPriorityLabel"), demandContext);
vm.runInContext(functionSource("demandTone"), demandContext);
vm.runInContext(functionSource("demandMetricValue"), demandContext);
vm.runInContext(functionSource("svgLabelLines"), demandContext);
vm.runInContext(functionSource("demandRadarChart"), demandContext);
vm.runInContext(functionSource("b2bDemandValueState"), demandContext);
vm.runInContext(functionSource("demandTrendQualityCard"), demandContext);
vm.runInContext(functionSource("demandInterpretation"), demandContext);
assert.equal(demandContext.demandTrafficObserved({ collectable: true, collectableCount: 0 }), true);
assert.equal(demandContext.demandTrafficObserved({ collectableCount: 0 }), false);
assert.equal(demandContext.demandMobileShare({ monthlyMobile: null, totalSearchVolume: 10 }), Number.NaN);
assert.equal(demandContext.demandMobileShare({ monthlyMobile: 0, totalSearchVolume: 10 }), 0);
assert.equal(demandContext.demandPriorityLabel({}), "판단 불가");
assert.equal(demandContext.demandPriorityLabel({ collectable: true, totalSearchVolume: 0 }), "보류");
assert.equal(demandContext.demandTone(null), "unknown");
assert.equal(demandContext.demandMetricValue({ score: null }), "미수집");
assert.equal(demandContext.demandMetricValue({ score: 0 }), "0점");
assert.equal(demandContext.demandMetricValue({ key: "monthlyDemand", value: 0 }), 0);
const partialRadar = demandContext.demandRadarChart([
  { label: "A", score: 80 }, { label: "B", score: 70 }, { label: "C", score: 60 }, { label: "D", score: null },
]);
assert.match(partialRadar, /<svg/);
assert.match(partialRadar, /미수집/);
assert.match(partialRadar, /<title id="demandRadarTitle">/);
assert.match(partialRadar, /<desc id="demandRadarDescription">/);
assert.match(partialRadar, /b2b-demand-radar-table/);
assert.match(partialRadar, /radar-table-scroll/);
const longLabelRadar = demandContext.demandRadarChart([
  { label: "월간 검색 수요", score: 80 },
  { label: "핵심 고객군 적합도", score: 70 },
  { label: "평일 확장 가능성", score: 60 },
]);
assert.match(longLabelRadar, /<tspan/);
assert.match(longLabelRadar, /월간 검색 수요 80점/);
const unavailableRadar = demandContext.demandRadarChart([
  { label: "A", score: 80 }, { label: "B", score: null },
]);
assert.doesNotMatch(unavailableRadar, /<svg/);
assert.match(unavailableRadar, /누락값을 0점 축으로 생성하지 않습니다/);
assert.equal(demandContext.b2bDemandValueState(0, true).state, "zero");
assert.equal(demandContext.b2bDemandValueState(12, true).state, "ready");
const unavailableDemandCard = demandContext.demandTrendQualityCard({ totalSearchVolume: 0, combinedCtr: 0 });
assert.equal(unavailableDemandCard.value, "확인 필요");
assert.equal(unavailableDemandCard.tone, "neutral");
assert.match(unavailableDemandCard.detail, /클릭 반응 확인필요/);
assert.deepEqual(
  [...demandContext.demandInterpretation({ totalSearchVolume: 0, combinedCtr: 0 })],
  ["검색광고 확인필요", "검색 추이 대기"]
);
const observedZeroDemandCard = demandContext.demandTrendQualityCard({ collectable: true, totalSearchVolume: 0, combinedCtr: 0 });
assert.equal(observedZeroDemandCard.value, "0회");
assert.equal(observedZeroDemandCard.tone, "warning");
assert.match(observedZeroDemandCard.detail, /클릭 반응 0%/);
assert.deepEqual(
  [...demandContext.demandInterpretation({ collectable: true, totalSearchVolume: 0, combinedCtr: 0 })],
  ["검색광고 확인필요", "클릭 반응 점검", "검색 추이 대기"]
);
assert.match(functionBlock("renderDemand"), /trafficObserved\s*&&\s*Number\.isFinite\(ctr\)\s*\?\s*fmtSearchRate\(ctr\)/);
assert.equal(demandContext.b2bDemandValueState(null, true).state, "unavailable");
assert.equal(demandContext.b2bDemandValueState(0, false).state, "unavailable");
assert.match(functionBlock("b2bDemandContextModel"), /"기간 미제공"/);
assert.match(functionBlock("b2bDemandContextModel"), /statisticalConfidenceProvided:\s*false/);
assert.match(functionBlock("demandTrendChart"), /b2b-demand-text-alternative/);
assert.match(functionBlock("demandTrendChart"), /<caption>/);
assert.match(functionBlock("demandRadarChart"), /structure-radar-unavailable/);
assert.match(functionBlock("demandRadarChart"), /b2b-demand-text-alternative/);
assert.match(functionBlock("demandRadarChart"), /svgLabelLines\(axis\.label, 6, 2\)/);
assert.match(functionBlock("demandRadarChart"), /pointFor\(index, 132\.5\)/);
assert.match(functionBlock("renderDemand"), /demand-region-table b2b-demand-table-scroll/);
assert.match(functionBlock("renderDemand"), /<table><caption>/);
assert.match(functionBlock("renderDemand"), /demandContext\.period/);
assert.doesNotMatch(functionBlock("renderDemand"), /dateRangeLabel\(run\).*시즌 수요 기준/);
assert.doesNotMatch(functionBlock("renderDemand"), /renderB2BDemandOutlook\s*\(/);
assert.doesNotMatch(functionBlock("syncRoleStaticLabels"), /setPanelHeading\("demand",\s*"수요 전망"/);

const accountContext = {
  b2bAccountTypeLabel: (value) => ({ member: "member", demo: "demo", test: "test", internal: "internal", master: "master" }[value] || "other"),
  b2bSafeDateTime: (value) => value ? String(value) : "missing",
};
vm.createContext(accountContext);
vm.runInContext(functionSource("b2bAccountViewModel"), accountContext);
const accountModel = accountContext.b2bAccountViewModel({
  username: "owner",
  accountType: "member",
  profile: { companyName: "Blue", phone: "010", email: "owner@example.test" },
  consents: { termsVersion: "v1", privacyVersion: "v2", marketingAccepted: false },
  password: "must-not-leak",
  token: "must-not-leak",
  cookie: "must-not-leak",
}, 2, "2026-07-31", false);
assert.equal(accountModel.username, "owner");
assert.equal(accountModel.companyName, "Blue");
assert.equal(Object.hasOwn(accountModel, "password"), false);
assert.equal(Object.hasOwn(accountModel, "token"), false);
assert.equal(Object.hasOwn(accountModel, "cookie"), false);
assert.equal(accountContext.b2bAccountViewModel({ accountType: "mystery" }).accountTypeLabel, "유형 확인 필요");
const previewAccount = accountContext.b2bAccountViewModel({ username: "admin", profile: { phone: "private" } }, 0, "", true);
assert.equal(previewAccount.username, "관리자 미리보기 세션");
assert.equal(previewAccount.contactRows[0].value, "미리보기에서 표시하지 않음");
assert.equal(previewAccount.interestCount, null);
assert.equal(previewAccount.interestUpdatedAt, "미리보기에서 표시하지 않음");

const accountRenderer = functionBlock("renderB2BAccountWorkspace");
assert.doesNotMatch(accountRenderer, /fetchJson|localStorage|<form|<input|<textarea|<select/i);
for (const href of ["/terms", "/privacy", "/refund", "/account-delete"]) {
  assert.ok(accountRenderer.includes(`href="${href}"`), `${href} must remain linked`);
}
assert.match(functionBlock("syncAdminUserViewReadOnlyControls"), /#themeToggle/);
assert.match(functionBlock("syncAdminUserViewReadOnlyControls"), /data-b2b-account-destructive/);
assert.match(functionBlock("syncAdminUserViewReadOnlyControls"), /adminPreviewHref/);
assert.match(functionBlock("syncAdminUserViewReadOnlyControls"), /removeAttribute\("href"\)/);
assert.match(accountRenderer, /previewMode \? 0 : readB2BInterestLodges\(\)\.length/);
assert.match(accountRenderer, /model\.previewMode \? ` role="link" aria-disabled="true" tabindex="-1"`/);
assert.match(functionBlock("bindEvents"), /b2bAccountDestructive[\s\S]*isAdminUserViewMode\(\)[\s\S]*preventDefault/);

const stage6Start = css.indexOf("/* Stage 6 B2B competition, map, demand, and account workbenches */");
const stage6End = css.indexOf("/* Dark transparent card contract v7", stage6Start);
assert.ok(stage6Start >= 0 && stage6End > stage6Start, "Stage 6 CSS must be bounded before the dark-card release contract");
const stage6Css = css.slice(stage6Start, stage6End);
for (const selector of [
  ".b2b-secondary-context",
  ".b2b-competition-toolbar",
  ".b2b-competition-selection",
  ".b2b-map-view-controls",
  ".b2b-map-status",
  ".b2b-map-company-list",
  ".b2b-map-company-row",
  ".b2b-demand-observed-grid",
  ".b2b-demand-text-alternative",
  ".b2b-account-workbench",
  ".b2b-account-summary",
  ".b2b-account-section",
]) {
  assert.ok(stage6Css.includes(selector), `${selector} must have a Stage 6 style contract`);
}
assert.doesNotMatch(stage6Css, /#[0-9a-f]{3,8}\b/i, "Stage 6 styles must use semantic color tokens");
assert.doesNotMatch(stage6Css, /invert\s*\(|hue-rotate\s*\(/i);
assert.doesNotMatch(stage6Css, /!important/);
assert.match(stage6Css, /var\(--color-surface-default\)/);
assert.match(stage6Css, /var\(--color-text-primary\)/);
assert.match(stage6Css, /var\(--color-border-focus\)/);
assert.match(stage6Css, /display:\s*table-row/);
assert.match(stage6Css, /var\(--touch-target-min\)|var\(--ui-control-height\)/);
assert.match(stage6Css, /body\.role-b2b \.map-caption\s*\{[\s\S]*?background:\s*var\(--color-surface-raised\)[\s\S]*?color:\s*var\(--color-text-secondary\)/);
assert.match(stage6Css, /data-map-core-tone="6"/);
assert.match(stage6Css, /\.map-marker\.core-6 circle/);
for (const [core, token] of [
  ["1", "--color-action-primary"],
  ["2", "--color-status-info"],
  ["3", "--color-status-success"],
  ["4", "--color-status-warning"],
  ["5", "--color-status-danger"],
  ["6", "--color-border-strong"],
]) {
  const legendRule = new RegExp(`data-map-core-tone="${core}"[^}]*?background:\\s*var\\(${token.replace(/[()]/g, "\\$&")}\\)`, "s");
  const markerRule = new RegExp(`\\.map-marker\\.core-${core} circle[^}]*?(?:background|fill):\\s*var\\(${token.replace(/[()]/g, "\\$&")}\\)`, "s");
  assert.match(stage6Css, legendRule, `core-${core} legend must use ${token}`);
  assert.match(stage6Css, markerRule, `core-${core} marker must use ${token}`);
}
assert.match(stage6Css, /\.company-map-marker\.adjacent \.company-map-halo/);
assert.match(stage6Css, /#companyList \.more-button\s*\{[\s\S]*?min-height:\s*var\(--touch-target-min\)/);
assert.match(stage6Css, /:is\(body\.role-b2b, body\.role-admin\) \.b2b-demand-text-alternative/);
assert.match(stage6Css, /@media \(max-width:\s*1120px\)/);
assert.match(stage6Css, /@media \(max-width:\s*720px\)/);
assert.match(stage6Css, /@media \(max-width:\s*390px\)/);
assert.match(
  stage6Css,
  /@media \(max-width:\s*720px\)[\s\S]*?body\.role-b2b \.map-caption\s*\{[^}]*position:\s*static[^}]*max-width:\s*100%[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s,
  "mobile map captions must remain fully visible instead of being clipped by the map frame",
);
assert.match(stage6Css, /prefers-reduced-motion:\s*reduce/);
assert.match(stage6Css, /overflow-wrap:\s*anywhere/);
assert.match(stage6Css, /\.radar-table-scroll\s*\{[^}]*overflow-x:\s*visible/s);
assert.match(stage6Css, /\.radar-table-scroll \.b2b-demand-radar-table\s*\{[^}]*min-width:\s*0[^}]*table-layout:\s*fixed/s);
assert.match(css, /\.structure-radar\s*\{[^}]*display:\s*block[^}]*max-width:\s*100%/s);

assert.equal(pkg.scripts["test:b2b-secondary-workbench"], "node scripts/test_b2b_secondary_workbench_ui_contract.cjs");
assert.ok(pkg.scripts.check.includes("node --check scripts/test_b2b_secondary_workbench_ui_contract.cjs"));
assert.ok(pkg.scripts.test.includes("npm run test:b2b-secondary-workbench"));

console.log("B2B secondary workbench UI contract tests passed.");
