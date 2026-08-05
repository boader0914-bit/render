"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let networkCalls = 0;
global.fetch = async (url) => {
  networkCalls += 1;
  throw new Error(`Network calls are forbidden in region publication UI fixture tests: ${url}`);
};

const ROOT = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const {
  buildRegionInsightState,
  computeRegionDraftHash,
  normalizeRegionInsightState,
  publishRegionInsightState
} = require("./region_insight_contract.cjs");
const { projectB2BRegionInsight } = require("./region_insight_runtime.cjs");
const { __test: serverTest } = require("./glamping_app_server.cjs");

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
    if (depth === 0) return { close: index, body: source.slice(open + 1, index) };
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

function insightFixture(regionKey = "kr_gyeonggi_pocheon", attractiveness = 74) {
  return {
    regionKey,
    locationAttractiveness: {
      value: attractiveness,
      modelVersion: "location-attractiveness.fixture.v1",
      components: [
        { key: "natural_resources", value: 82, weight: 0.4, evidenceIds: ["forest-fixture-1"] },
        { key: "market_demand", value: 68, weight: 0.6, evidenceIds: ["demand-fixture-1"] }
      ]
    },
    dataQuality: {
      status: "partial",
      score: 81,
      grade: "B",
      penalties: [
        { code: "ota_sample_partial", message: "OTA 표본 4/18곳", points: 8 }
      ],
      coverage: { numerator: 14, denominator: 18, note: "14/18개 기대 출처" },
      freshness: {
        status: "fresh",
        asOf: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-04T12:00:00.000Z",
        ageDays: 0.5
      }
    },
    review: {
      status: "draft",
      reviewedDraftHash: "",
      reviewedAt: "",
      reviewer: { id: "", displayName: "" },
      adminMemo: "draft-secret-must-not-render"
    },
    publication: {
      status: "unpublished",
      publicationId: "",
      version: "",
      publishedAt: "",
      adminMemo: "publication-secret-must-not-render"
    }
  };
}

function publishedInsight(regionKey = "kr_gyeonggi_pocheon", attractiveness = 74) {
  const draft = buildRegionInsightState(insightFixture(regionKey, attractiveness));
  const reviewed = buildRegionInsightState({
    ...draft,
    review: {
      status: "reviewed",
      reviewedDraftHash: draft.draftHash,
      reviewedAt: "2026-08-05T01:00:00.000Z",
      reviewer: { id: "reviewer-secret-17", displayName: "비공개 검수자" },
      adminMemo: "review-secret-must-not-render"
    }
  });
  return publishRegionInsightState(reviewed, {
    publicationId: `publication:${regionKey}:1`,
    version: "2026.08.05.1",
    publishedAt: "2026-08-05T02:00:00.000Z",
    adminMemo: "publication-secret-must-not-render"
  });
}

function staleInsight(published) {
  const changedAttractiveness = {
    ...published.locationAttractiveness,
    value: 31,
    components: published.locationAttractiveness.components.map((component) => ({ ...component }))
  };
  const changedDraftHash = computeRegionDraftHash(
    published.regionKey,
    changedAttractiveness,
    published.dataQuality
  );
  return normalizeRegionInsightState({
    ...published,
    draftHash: changedDraftHash,
    locationAttractiveness: changedAttractiveness,
    review: published.review,
    publication: published.publication
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const draft = buildRegionInsightState(insightFixture());
assert.equal(projectB2BRegionInsight(null), null);
assert.equal(projectB2BRegionInsight(draft), null, "an unpublished draft must not create a B2B projection");

const published = publishedInsight();
const publicPublished = projectB2BRegionInsight(published);
assert.equal(publicPublished.regionKey, "kr_gyeonggi_pocheon");
assert.equal(publicPublished.locationAttractiveness.value, 74);
assert.equal(publicPublished.dataQuality.grade, "B");
assert.equal(publicPublished.publication.status, "published");

const stale = staleInsight(published);
const publicStale = projectB2BRegionInsight(stale);
assert.equal(stale.locationAttractiveness.value, 31, "the current internal draft may change");
assert.equal(publicStale.publication.status, "stale");
assert.equal(publicStale.locationAttractiveness.value, 74, "stale B2B output must retain the immutable publication");
assert.equal(publicStale.dataQuality.score, 81);

const matchedContext = {
  regionKey: "kr_gyeonggi_pocheon",
  matchStatus: "matched",
  sido: "경기도",
  sigungu: "포천시",
  displayLabel: "경기도 포천시"
};
const projectedRun = serverTest.publicRunForRole({
  run: { id: "publication-ui-run", keyword: "포천 글램핑" },
  regionContext: matchedContext,
  regionInsight: stale,
  adminRegionalOperations: { reviewer: "server-secret-must-not-render" }
}, "b2b");
assert.equal(projectedRun.regionInsight, undefined);
assert.equal(projectedRun.b2bRegionInsight.publication.status, "stale");
assert.equal(projectedRun.b2bRegionInsight.locationAttractiveness.value, 74);

const unpublishedRun = serverTest.publicRunForRole({
  run: { id: "unpublished-ui-run", keyword: "포천 글램핑" },
  regionContext: matchedContext,
  regionInsight: draft
}, "b2b");
assert.equal(unpublishedRun.b2bRegionInsight, null);

const otherPublished = publishedInsight("kr_gangwon_sokcho", 66);
const mismatchedRun = serverTest.publicRunForRole({
  run: { id: "mismatch-ui-run", keyword: "포천 글램핑" },
  regionContext: matchedContext,
  regionInsight: otherPublished
}, "b2b");
assert.equal(mismatchedRun.b2bRegionInsight, null, "another canonical region's publication must never be used as fallback");

for (const context of [
  { matchStatus: "ambiguous", regionKey: "kr_gyeonggi_pocheon", displayLabel: "고성" },
  { matchStatus: "unmatched", regionKey: "", displayLabel: "미등록 지역" }
]) {
  const run = serverTest.publicRunForRole({
    run: { id: `region-${context.matchStatus}` },
    regionContext: context,
    regionInsight: published
  }, "b2b");
  assert.equal(run.regionContext.regionKey, "");
  assert.equal(run.b2bRegionInsight, null);
}

const forbiddenLocalRecalculation = /locationCardForQuery|adjustedLocationScoreModel|regionGroupLocationScoreModel|weightedLocationScore|locationRuntimeStats|state\.dictionary/;
const finiteNumberSource = functionSource("finiteRegionInsightNumber");
const publicProjectionSource = functionSource("publicRegionInsightProjection");
const viewModelSource = functionSource("b2bRegionInsightViewModel");
const htmlSource = functionSource("b2bRegionInsightHtml");
const rendererSource = functionSource("renderB2BRegionInsight");
for (const [name, source] of [
  ["b2bRegionInsightViewModel", viewModelSource],
  ["b2bRegionInsightHtml", htmlSource],
  ["renderB2BRegionInsight", rendererSource]
]) {
  assert.doesNotMatch(source, forbiddenLocalRecalculation, `${name} must not recompute or substitute a local region score`);
  assert.doesNotMatch(source, /fetch\s*\(|fetchJson\s*\(/, `${name} must render only the run's public projection`);
  assert.doesNotMatch(source, /data\?\.regionInsight|data\.regionInsight/, `${name} must not read the internal region insight state`);
}
assert.match(viewModelSource, /b2bRegionInsight/);
assert.match(rendererSource, /b2bRegionInsightViewModel/);
assert.match(rendererSource, /b2bRegionInsightHtml/);

const normalizeRegionAnalysisRegionKey = (value = "") => String(value || "").trim().slice(0, 160);
const matchedRegionContextKey = (regionContext = {}) => {
  if (regionContext?.matchStatus !== "matched") return "";
  return normalizeRegionAnalysisRegionKey(regionContext?.regionKey);
};
const viewModelContext = vm.createContext({ matchedRegionContextKey, normalizeRegionAnalysisRegionKey });
vm.runInContext(`${finiteNumberSource}; ${publicProjectionSource}; ${viewModelSource}; this.b2bRegionInsightViewModel = b2bRegionInsightViewModel;`, viewModelContext);
const viewModel = viewModelContext.b2bRegionInsightViewModel;
const publishedModel = viewModel({ regionContext: matchedContext, b2bRegionInsight: publicPublished });
assert.equal(publishedModel.state, "published");
assert.equal(publishedModel.regionKey, "kr_gyeonggi_pocheon");
assert.equal(publishedModel.locationAttractiveness.value, 74);
assert.equal(publishedModel.dataQuality.grade, "B");
assert.equal(publishedModel.publication.version, "2026.08.05.1");

const staleModel = viewModel({ regionContext: matchedContext, b2bRegionInsight: publicStale });
assert.equal(staleModel.state, "stale");
assert.equal(staleModel.locationAttractiveness.value, 74);

const unpublishedModel = viewModel({
  regionContext: matchedContext,
  regionInsight: published,
  b2bRegionInsight: null
});
assert.equal(unpublishedModel.state, "unpublished", "the UI must not fall back to the internal regionInsight field");

const mismatchedModel = viewModel({
  regionContext: matchedContext,
  b2bRegionInsight: projectB2BRegionInsight(otherPublished)
});
assert.equal(mismatchedModel.state, "unmatched");
assert.equal(mismatchedModel.regionKey, "kr_gyeonggi_pocheon");

const taintedProjection = {
  ...publicPublished,
  adminMemo: "ui-admin-secret",
  draftHash: "a".repeat(64),
  reviewer: { id: "ui-reviewer-secret" },
  review: { status: "reviewed" },
  snapshot: { snapshotHash: "b".repeat(64) },
  publication: {
    ...publicPublished.publication,
    adminMemo: "nested-publication-secret",
    reviewer: { id: "nested-reviewer-secret" }
  }
};
const taintedModel = viewModel({ regionContext: matchedContext, b2bRegionInsight: taintedProjection });
const taintedModelText = JSON.stringify(taintedModel);
for (const forbidden of ["ui-admin-secret", "ui-reviewer-secret", "nested-publication-secret", "nested-reviewer-secret", "draftHash", "snapshotHash", "reviewer", "adminMemo"]) {
  assert.equal(taintedModelText.includes(forbidden), false, `view model leaked ${forbidden}`);
}

const coverageLabelSource = functionSource("regionInsightCoverageLabel");
const dateLabelSource = functionSource("regionInsightDateLabel");
const htmlContext = vm.createContext({
  B2B_LOCATION_COMPONENT_COPY: {},
  escapeHtml,
  fmtNumber: (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("ko-KR") : "확인 필요",
  compactDateTime: (value) => String(value || "").replace("T", " ").replace(".000Z", "")
});
vm.runInContext(`${finiteNumberSource}; ${coverageLabelSource}; ${dateLabelSource}; ${htmlSource}; this.b2bRegionInsightHtml = b2bRegionInsightHtml;`, htmlContext);
const renderInsight = htmlContext.b2bRegionInsightHtml;
const publishedHtml = renderInsight(publishedModel);
assert.match(publishedHtml, /class="region-insight-publication"/);
assert.match(publishedHtml, /data-region-insight-region-key="kr_gyeonggi_pocheon"/);
assert.match(publishedHtml, /발행된 지역 인사이트/);
assert.match(publishedHtml, /published/);
assert.match(publishedHtml, /경기도 포천시/);
assert.match(publishedHtml, />74</);
assert.match(publishedHtml, /B/);
assert.match(publishedHtml, /14\s*\/\s*18|14\/18/);
assert.match(publishedHtml, /OTA 표본 4\/18곳/);
assert.match(publishedHtml, /2026\.08\.05\.1/);

const staleHtml = renderInsight(staleModel);
assert.match(staleHtml, /role="status"/);
assert.match(staleHtml, /stale/);
assert.match(staleHtml, /재검수|마지막 발행/);
assert.match(staleHtml, />74</, "stale HTML must show the published score rather than the changed draft score");
assert.doesNotMatch(staleHtml, />31</);

const emptyHtml = renderInsight(unpublishedModel);
assert.match(emptyHtml, /data-region-analysis-state="unpublished"/);
assert.match(emptyHtml, /검수된 지역 인사이트가 아직 없습니다|발행된 지역 인사이트가 없습니다/);

const taintedHtml = renderInsight(taintedModel);
for (const forbidden of [
  "ui-admin-secret",
  "ui-reviewer-secret",
  "nested-publication-secret",
  "nested-reviewer-secret",
  "draftHash",
  "snapshotHash",
  "review-secret-must-not-render",
  "publication-secret-must-not-render"
]) {
  assert.equal(taintedHtml.includes(forbidden), false, `B2B HTML leaked ${forbidden}`);
}

assert.match(html, /id="regionInsightBody"[^>]*aria-live="polite"/);
assert.match(functionBlock("renderAll"), /renderB2BRegionInsight\(\)/);
assert.match(functionBlock("setActiveTab"), /state\.activeTab === "regionInsight"[\s\S]*renderB2BRegionInsight\(\)/);
const strictDictionaryMatcher = functionBlock("locationDictionaryMatchForQuery");
const strictCardResolver = functionBlock("locationCardForQuery");
assert.doesNotMatch(strictDictionaryMatcher, /bestLocation(?:Card|Group)Match|locationGroupForQuery|card-match|group-match/);
assert.match(strictDictionaryMatcher, /reason:\s*"ambiguous"/);
assert.match(strictCardResolver, /matchedRegionContextKey\(authoritativeContext\)/);
assert.doesNotMatch(strictCardResolver, /locationGroupForQuery|selectedLocationCard|cards\s*\[\s*0\s*\]|\.includes\(compactSearchText/);

const nullableScoreHelpers = {
  locationScoreFromSearchVolume: /total === 0\) return observed \? 0 : NaN/,
  locationReservationSignalScore: /!supply[^\n]*return NaN/,
  locationCompetitionBalanceScore: /!count\) return NaN/,
  locationRevenueSampleScore: /!metrics\.sampleCount\) return NaN/
};
for (const [helperName, missingGuard] of Object.entries(nullableScoreHelpers)) {
  assert.match(functionSource(helperName), missingGuard, `${helperName} must keep missing observations nullable`);
}
const attractivenessModel = functionBlock("adjustedLocationScoreModel");
const groupAttractivenessModel = functionBlock("regionGroupLocationScoreModel");
assert.doesNotMatch(attractivenessModel, /key:\s*"confidence"/, "data quality must not be an attractiveness component");
assert.doesNotMatch(attractivenessModel, /rawScore\s*\+\s*confidenceAdjustment/, "quality must not adjust attractiveness");
assert.match(attractivenessModel, /confidenceAdjustment:\s*0/);
assert.doesNotMatch(groupAttractivenessModel, /rawScore\s*\+\s*confidenceAdjustment/, "group quality must not adjust attractiveness");
assert.match(groupAttractivenessModel, /confidenceAdjustment:\s*0/);
const b2bLegacyScoreContext = functionBlock("b2bLocationScoreContext");
assert.match(b2bLegacyScoreContext, /b2bRegionInsight/);
assert.doesNotMatch(b2bLegacyScoreContext, /locationCardForQuery|adjustedLocationScoreModel|regionGroupLocationScoreModel/);
const adminWorkbench = functionBlock("renderAdminRegionInsightWorkbench");
for (const hook of [
  "data-region-insight-save-draft",
  "data-region-insight-review",
  "data-region-insight-publish",
  "data-region-insight-admin-memo",
  "data-region-insight-version"
]) {
  assert.match(adminWorkbench, new RegExp(hook), `admin workbench is missing ${hook}`);
}
assert.match(adminWorkbench, /publicRegionInsightProjection|b2bRegionInsightViewModel/);
assert.match(adminWorkbench, /입지 매력도 점수/);
assert.match(adminWorkbench, /품질 상태/);
assert.match(adminWorkbench, /출처·기간·표본·상태/);
assert.match(functionBlock("loadAdminRegionInsight"), /\/api\/region-insights\/\$\{encodeURIComponent\(regionKey\)\}/);
const mutateWorkbench = functionBlock("mutateAdminRegionInsight");
assert.match(mutateWorkbench, /method:\s*"POST"/);
assert.match(mutateWorkbench, /const auxiliaryDraft = \{[\s\S]*memoDirty:[\s\S]*versionDirty:/);
assert.match(mutateWorkbench, /requestId !== state\.adminRegionInsightRequestId/);
assert.match(mutateWorkbench, /action === "draft"[\s\S]*nextMemo\.value = auxiliaryDraft\.memo/);
assert.doesNotMatch(functionBlock("loadAdminRegionInsight"), /const auxiliaryDraft/);
const draftPayload = functionBlock("regionInsightDraftPayloadFromForm");
assert.match(draftPayload, /expectedWorkflowRevision:\s*workflowRevision/);
assert.match(draftPayload, /locationAttractiveness:[\s\S]*dataQuality:/);
const reviewAction = functionBlock("reviewAdminRegionInsight");
assert.match(reviewAction, /expectedWorkflowRevision:\s*workflowRevision/);
assert.match(reviewAction, /expectedDraftHash:\s*current\.draftHash/);
const publishAction = functionBlock("publishAdminRegionInsight");
assert.match(publishAction, /window\.confirm/);
assert.match(publishAction, /expectedWorkflowRevision:\s*workflowRevision/);
assert.match(publishAction, /expectedDraftHash:\s*current\.draftHash/);
assert.match(publishAction, /version/);
assert.match(mutateWorkbench, /REGION_WORKFLOW_REVISION_CONFLICT/);
assert.match(mutateWorkbench, /입력한 초안·메모·버전은 보존/);
const tabActivation = functionBlock("setActiveTab");
assert.match(tabActivation, /adminRegionInsightDirty[\s\S]*nextTab === "reviewPublish"[\s\S]*return true/);
assert.match(tabActivation, /confirmAdminRegionInsightNavigation/);
const runLoader = functionBlock("loadRun");
assert.match(runLoader, /loadedRunId = String\(state\.data\?\.run\?\.id \|\| ""\)/);
assert.match(runLoader, /confirmAdminRegionInsightNavigation\(\{ discard: false \}\)/);
assert.match(runLoader, /els\.runSelect\.value = loadedRunId/);
assert.match(runLoader, /requestId = \+\+state\.runRequestId/);
assert.match(runLoader, /requestId !== state\.runRequestId/);
assert.ok((runLoader.match(/requestId !== state\.runRequestId/g) || []).length >= 2, "run races must be checked before state apply and after auxiliary awaits");
assert.match(runLoader, /adminRegionInsightDirtyRevision !== dirtySnapshot\.revision/);
assert.match(runLoader, /return true/);
const historyRestore = functionBlock("restoreAppHistoryNavigation");
assert.match(historyRestore, /const targetNavigation = \{[\s\S]*Object\.assign\(state, previousNavigation\)/);
assert.match(historyRestore, /Object\.assign\(state, previousNavigation\)[\s\S]*syncAppHistoryState\(false\)/);
assert.match(functionBlock("bindEvents"), /beforeunload[\s\S]*state\.adminRegionInsightDirty/);
const regionInsightPanelStart = html.indexOf('id="regionInsightPanel"');
const nextPanelStart = html.indexOf('class="panel', regionInsightPanelStart + 1);
assert.notEqual(regionInsightPanelStart, -1, "region insight panel missing");
const regionInsightPanelSource = html.slice(regionInsightPanelStart, nextPanelStart < 0 ? html.length : nextPanelStart);
assert.doesNotMatch(regionInsightPanelSource, /data-save-admin-region-review/);

assert.equal(pkg.scripts["test:region-insight-runtime"], "node scripts/test_region_insight_runtime.cjs");
assert.equal(pkg.scripts["test:region-analysis-navigation"], "node scripts/test_region_analysis_navigation_ui_contract.cjs");
assert.equal(pkg.scripts["test:region-analysis-publication-ui"], "node scripts/test_region_analysis_publication_ui_contract.cjs");
assert.match(pkg.scripts["test:region-analysis-fixtures"], /test:region-insight-runtime/);
assert.match(pkg.scripts["test:region-analysis-fixtures"], /test:region-analysis-navigation/);
assert.match(pkg.scripts["test:region-analysis-fixtures"], /test:region-analysis-publication-ui/);
assert.equal(networkCalls, 0, "fixture-only publication UI tests must not call the network");

console.log("Region analysis published-snapshot B2B UI fixture contracts passed");
