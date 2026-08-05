"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

global.fetch = (url) => {
  throw new Error(`Network calls are forbidden in region analysis navigation fixtures: ${url}`);
};

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");

function balancedBlockFrom(source, marker, openCharacter = "{", closeCharacter = "}") {
  const markerIndex = typeof marker === "number" ? marker : source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing source marker: ${marker}`);
  const openIndex = source.indexOf(openCharacter, markerIndex);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
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
    if (character === openCharacter) depth += 1;
    if (character === closeCharacter) depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }
  assert.fail(`unbalanced block after ${marker}`);
}

function functionBlock(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(app);
  assert.ok(match, `missing function ${name}`);
  const parameterOpen = app.indexOf("(", match.index);
  let depth = 0;
  let parameterClose = -1;
  for (let index = parameterOpen; index < app.length; index += 1) {
    if (app[index] === "(") depth += 1;
    if (app[index] === ")") depth -= 1;
    if (depth === 0) {
      parameterClose = index;
      break;
    }
  }
  return balancedBlockFrom(app, app.indexOf("{", parameterClose));
}

assert.match(app, /const REGION_ANALYSIS_TABS = Object\.freeze\(\{\s*admin: Object\.freeze\(\["map", "demand", "dictionary", "reviewPublish"\]\),\s*b2b: Object\.freeze\(\["map", "demand", "regionInsight"\]\)/s);
assert.match(app, /key: "region-analysis"[\s\S]*?drawerChildren: false/);
assert.match(app, /lastRegionAnalysisTab: "map"/);
assert.match(app, /regionAnalysisRegionKey: ""/);

const b2bNavigation = balancedBlockFrom(app, app.indexOf("b2b:", app.indexOf("const APP_NAVIGATION")));
assert.match(b2bNavigation, /tab: "regionInsight"/);
assert.doesNotMatch(b2bNavigation, /tab: "dictionary"/);
assert.doesNotMatch(b2bNavigation, /tab: "reviewPublish"/);

const drawerNavigationEntries = vm.runInNewContext(
  `(function(role) {${functionBlock("drawerNavigationEntries")}})`,
  {
    navigationEntries: () => [
      { key: "region-analysis", tab: "map", drawerChildren: false, children: [{ key: "region-map", tab: "map" }, { key: "region-demand", tab: "demand" }] },
      { key: "analytics", tab: "report", children: [{ key: "market", tab: "report" }, { key: "rank", tab: "rank" }] },
      { key: "more", action: "drawer" }
    ]
  }
);
const drawerEntries = drawerNavigationEntries("admin");
assert.deepEqual(Array.from(drawerEntries, (item) => item.key), ["region-analysis", "market", "rank"]);

const resolveRegionAnalysisReturnTab = vm.runInNewContext(
  `(function(lastTab, allowedTabs) {${functionBlock("resolveRegionAnalysisReturnTab")}})`,
  { firstRoleTab: () => "report" }
);
assert.equal(resolveRegionAnalysisReturnTab("dictionary", ["map", "demand", "dictionary"]), "dictionary");
assert.equal(resolveRegionAnalysisReturnTab("dictionary", ["map", "demand", "regionInsight"]), "map");
assert.equal(resolveRegionAnalysisReturnTab("unknown", ["map", "demand"]), "map");

const resolveHistoryTabForRole = vm.runInNewContext(
  `(function(tab, allowedTabs, allowedRegionTabs) {${functionBlock("resolveHistoryTabForRole")}})`,
  {
    REGION_ANALYSIS_TABS: {
      admin: ["map", "demand", "dictionary", "reviewPublish"],
      b2b: ["map", "demand", "regionInsight"]
    },
    firstRoleTab: () => "report",
    resolveRegionAnalysisReturnTab
  }
);
assert.equal(resolveHistoryTabForRole("dictionary", ["report", "map", "demand", "regionInsight"], ["map", "demand", "regionInsight"]), "map");
assert.equal(resolveHistoryTabForRole("reviewPublish", ["report", "map", "demand", "regionInsight"], ["map", "demand", "regionInsight"]), "map");
assert.equal(resolveHistoryTabForRole("regionInsight", ["report", "map", "demand", "regionInsight"], ["map", "demand", "regionInsight"]), "regionInsight");
assert.equal(resolveHistoryTabForRole("unknown", ["report", "map", "demand", "regionInsight"], ["map", "demand", "regionInsight"]), "report");

const normalizeRegionAnalysisRegionKey = (value = "") => String(value || "").trim().slice(0, 160);
const matchedRegionContextKey = vm.runInNewContext(
  `(function(regionContext = {}) {${functionBlock("matchedRegionContextKey")}})`,
  { normalizeRegionAnalysisRegionKey }
);
assert.equal(matchedRegionContextKey({ matchStatus: "matched", regionKey: "kr_gyeonggi_pocheon" }), "kr_gyeonggi_pocheon");
assert.equal(matchedRegionContextKey({ matchStatus: "unmatched", regionKey: "kr_gyeonggi_pocheon" }), "");
assert.equal(matchedRegionContextKey({ matchStatus: "ambiguous", regionKey: "kr_gangwon_goseong" }), "");
assert.equal(matchedRegionContextKey({ status: "matched", matched: true, region: { regionKey: "kr_gyeongnam_hadong" } }), "kr_gyeongnam_hadong");

assert.match(functionBlock("syncAppHistoryState"), /lastRegionAnalysisTab:/);
assert.match(functionBlock("syncAppHistoryState"), /regionKey:/);
assert.match(functionBlock("restoreAppHistoryState"), /historyState\.lastRegionAnalysisTab/);
assert.match(functionBlock("restoreAppHistoryState"), /historyState\.regionKey/);
assert.match(functionBlock("loadRun"), /matchedRegionContextKey\(data\.regionContext\)/);
assert.doesNotMatch(functionBlock("loadRun"), /b2bRegionReviewSummary\?\.regionKey|data\.run\?\.regionKey/);
assert.doesNotMatch(functionBlock("loadLocationDictionary"), /cards\?\.\[0\]|cards\[0\]/);
assert.doesNotMatch(functionBlock("renderLocationDictionary"), /cards\[0\]|result\.card\s*\|\|\s*state\.selectedLocationCard/);
assert.doesNotMatch(functionBlock("renderLocationDictionary"), /locationCardForQuery\(/);

assert.match(html, /id="regionAnalysisTabs" role="tablist"/);
for (const panel of ["mapPanel", "demandPanel", "dictionaryPanel", "regionInsightPanel", "reviewPublishPanel"]) {
  assert.match(html, new RegExp(`id="${panel}"`));
}
assert.match(html, /id="regionInsightPanel"[\s\S]*?id="regionInsightBody"/);
assert.match(functionBlock("renderAll"), /renderB2BRegionInsight\(\)/);
assert.match(functionBlock("setActiveTab"), /state\.activeTab === "regionInsight"[\s\S]*?renderB2BRegionInsight\(\)/);
assert.match(html, /id="reviewPublishPanel"[\s\S]*?id="reviewPublishBody"/);
assert.match(functionBlock("renderAll"), /renderAdminRegionInsightWorkbench\(\)/);
assert.match(functionBlock("setActiveTab"), /state\.activeTab === "reviewPublish"[\s\S]*?renderAdminRegionInsightWorkbench\(\)/);
assert.doesNotMatch(html, /id="dictionarySearchInput"[^>]*\bvalue=/);

const renderTabs = functionBlock("renderRegionAnalysisNavigation");
assert.match(renderTabs, /role="tab"/);
assert.match(renderTabs, /aria-controls=/);
assert.match(renderTabs, /aria-selected/);
assert.match(renderTabs, /regionAnalysisTabPresentation/);
assert.match(renderTabs, /button\.tabIndex = tabState\.tabIndex/);
const keyboard = functionBlock("handleRegionAnalysisTabKeydown");
for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) assert.match(keyboard, new RegExp(`"${key}"`));
assert.match(keyboard, /event\.preventDefault\(\)/);
assert.match(keyboard, /regionAnalysisTabIndexForKey/);
assert.match(css, /\.region-analysis-navigation\[hidden\]\s*\{[^}]*display: none/s);
assert.match(css, /\.region-analysis-tabs \[role="tab"\]\s*\{[^}]*min-height: var\(--touch-target-min\)/s);
assert.match(css, /\.region-analysis-tabs \[role="tab"\]:focus-visible\s*\{[^}]*outline:/s);
assert.match(css, /\[data-legacy-navigation\]\s*\{[^}]*display:\s*none\s*!important/s);

console.log("Region analysis navigation fixture contract checks passed");
