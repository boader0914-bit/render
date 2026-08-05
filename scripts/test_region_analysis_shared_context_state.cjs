"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "region analysis shared-context fixtures" });

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(app);
  assert.ok(match, `missing function ${name}`);
  const parameterOpen = app.indexOf("(", match.index);
  let parameterDepth = 0;
  let parameterClose = -1;
  for (let index = parameterOpen; index < app.length; index += 1) {
    if (app[index] === "(") parameterDepth += 1;
    if (app[index] === ")") parameterDepth -= 1;
    if (parameterDepth === 0) {
      parameterClose = index;
      break;
    }
  }
  assert.notEqual(parameterClose, -1, `missing parameter close for ${name}`);
  const bodyOpen = app.indexOf("{", parameterClose);
  let bodyDepth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyOpen; index < app.length; index += 1) {
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
    if (character === "{") bodyDepth += 1;
    if (character === "}") bodyDepth -= 1;
    if (bodyDepth === 0) return app.slice(match.index, index + 1);
  }
  assert.fail(`unbalanced function ${name}`);
}

function loadFunctions(names, context = {}) {
  const sandbox = vm.createContext(context);
  vm.runInContext(
    `${names.map(functionSource).join("\n")}\n${names.map((name) => `this.${name} = ${name};`).join("\n")}`,
    sandbox
  );
  return sandbox;
}

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalContext(regionKey = "kr_gyeonggi_pocheon") {
  return {
    matchStatus: "matched",
    regionKey,
    sido: "경기도",
    sigungu: "포천시",
    displayLabel: "경기도 포천시"
  };
}

const normalizeRegionAnalysisRegionKey = (value = "") => String(value || "").trim().slice(0, 160);
const matchedRegionContextKey = (regionContext = {}) => {
  if (!regionContext || typeof regionContext !== "object" || Array.isArray(regionContext)) return "";
  const regionKey = normalizeRegionAnalysisRegionKey(regionContext.regionKey);
  return regionContext.matchStatus === "matched" && regionKey ? regionKey : "";
};

try {
  const sharedApi = loadFunctions([
    "regionAnalysisSharedContext",
    "sameRegionAnalysisHistoryState",
    "resolveRegionAnalysisHistoryState"
  ], {
    normalizeRegionAnalysisRegionKey,
    matchedRegionContextKey
  });

  const publication = {
    regionKey: "kr_gyeonggi_pocheon",
    dataQuality: {
      status: "partial",
      score: 78,
      grade: "B",
      coverage: { numerator: 14, denominator: 18, ratio: 14 / 18 },
      freshness: {
        status: "fresh",
        asOf: "2026-08-04T15:00:00.000Z",
        updatedAt: "2026-08-05T00:10:00.000Z",
        ageDays: 0.4
      }
    },
    publication: {
      status: "published",
      version: "2026.08.05.1",
      publishedAt: "2026-08-05T01:00:00.000Z"
    }
  };
  const measurementPeriod = {
    start: "2026-08-01",
    end: "2026-08-07",
    label: "2026.08.01~2026.08.07"
  };
  const complete = plain(sharedApi.regionAnalysisSharedContext({
    run: { id: "run-pocheon", measurementPeriod },
    regionContext: canonicalContext(),
    b2bRegionInsight: publication
  }));

  assert.equal(complete.regionKey, "kr_gyeonggi_pocheon");
  assert.equal(complete.displayLabel, "경기도 포천시");
  assert.equal(complete.matchStatus, "matched");
  assert.equal(complete.runId, "run-pocheon");
  assert.deepEqual(complete.measurementPeriod, measurementPeriod);
  assert.equal(complete.asOf, "2026-08-04T15:00:00.000Z");
  assert.equal(complete.publicationVersion, "2026.08.05.1");
  assert.equal(complete.status, "partial");
  assert.deepEqual(complete.freshness, publication.dataQuality.freshness);
  assert.deepEqual(complete.coverage, publication.dataQuality.coverage);

  for (const regionContext of [
    { matchStatus: "unmatched", regionKey: "kr_gyeonggi_pocheon", displayLabel: "미등록 지역" },
    { matchStatus: "ambiguous", regionKey: "kr_gyeonggi_pocheon", displayLabel: "고성" },
    { matchStatus: "inactive", regionKey: "kr_gyeonggi_pocheon", displayLabel: "비활성 지역" }
  ]) {
    const rejected = plain(sharedApi.regionAnalysisSharedContext({
      run: { id: "run-rejected", measurementPeriod },
      regionContext,
      b2bRegionInsight: publication
    }));
    assert.equal(rejected.regionKey, "", `${regionContext.matchStatus} must not become the shared canonical region`);
    assert.equal(rejected.publicationVersion, null, "an unconnected region must not inherit publication metadata");
    assert.equal(rejected.status, null, "an unconnected region must not inherit data status");
  }

  const wrongPublication = plain(sharedApi.regionAnalysisSharedContext({
    run: { id: "run-pocheon", measurementPeriod },
    regionContext: canonicalContext(),
    b2bRegionInsight: {
      ...publication,
      regionKey: "kr_gyeongnam_hadong",
      publication: { ...publication.publication, version: "wrong-region-version" }
    }
  }));
  assert.equal(wrongPublication.regionKey, "kr_gyeonggi_pocheon");
  assert.equal(wrongPublication.publicationVersion, null, "another region's publication must not populate the shared context");
  assert.equal(wrongPublication.status, null);
  assert.equal(wrongPublication.freshness, null);
  assert.equal(wrongPublication.coverage, null);

  const missing = plain(sharedApi.regionAnalysisSharedContext({
    run: { id: "run-missing" },
    regionContext: canonicalContext(),
    b2bRegionInsight: null
  }));
  assert.equal(missing.measurementPeriod, null);
  assert.equal(missing.asOf, null);
  assert.equal(missing.publicationVersion, null);
  assert.equal(missing.status, null);
  assert.equal(missing.freshness, null);
  assert.equal(missing.coverage, null);

  const zero = plain(sharedApi.regionAnalysisSharedContext({
    run: { id: "run-zero", measurementPeriod },
    regionContext: canonicalContext(),
    b2bRegionInsight: {
      ...publication,
      dataQuality: {
        status: "zero",
        coverage: { numerator: 0, denominator: 4, ratio: 0 },
        freshness: { status: "fresh", asOf: "2026-08-05T00:00:00.000Z" }
      }
    }
  }));
  assert.equal(zero.status, "zero", "a measured zero must not be collapsed into missing");
  assert.deepEqual(zero.coverage, { numerator: 0, denominator: 4, ratio: 0 });

  const baseHistory = {
    app: "lodging-datalab",
    role: "b2b",
    tab: "regionInsight",
    runId: "run-pocheon",
    lastRegionAnalysisTab: "regionInsight",
    regionKey: "kr_gyeonggi_pocheon",
    measurementPeriod
  };
  assert.equal(sharedApi.sameRegionAnalysisHistoryState(baseHistory, { ...baseHistory }), true);
  assert.equal(sharedApi.sameRegionAnalysisHistoryState(
    baseHistory,
    { measurementPeriod: { ...measurementPeriod }, regionKey: baseHistory.regionKey, lastRegionAnalysisTab: baseHistory.lastRegionAnalysisTab, runId: baseHistory.runId, tab: baseHistory.tab, role: baseHistory.role, app: baseHistory.app }
  ), true, "property order and cloned period values must not create duplicate history entries");
  for (const changed of [
    { tab: "map" },
    { runId: "run-other" },
    { regionKey: "kr_gyeongnam_hadong" },
    { lastRegionAnalysisTab: "demand" },
    { measurementPeriod: { ...measurementPeriod, end: "2026-08-08" } }
  ]) {
    assert.equal(
      sharedApi.sameRegionAnalysisHistoryState(baseHistory, { ...baseHistory, ...changed }),
      false,
      `history comparison must detect ${Object.keys(changed)[0]} changes`
    );
  }

  const b2bHistoryOptions = {
    currentRole: "b2b",
    allowedTabs: ["report", "rank", "map", "demand", "regionInsight", "account"],
    allowedRegionTabs: ["map", "demand", "regionInsight"],
    canonicalRegionKey: "kr_gyeonggi_pocheon",
    currentRunId: "run-pocheon"
  };
  const allowedHistory = plain(sharedApi.resolveRegionAnalysisHistoryState(baseHistory, b2bHistoryOptions));
  assert.equal(allowedHistory.tab, "regionInsight");
  assert.equal(allowedHistory.lastRegionAnalysisTab, "regionInsight");
  assert.equal(allowedHistory.regionKey, "kr_gyeonggi_pocheon");
  assert.equal(allowedHistory.runId, "run-pocheon");
  assert.deepEqual(allowedHistory.measurementPeriod, measurementPeriod);

  const adminHistoryInB2B = plain(sharedApi.resolveRegionAnalysisHistoryState({
    ...baseHistory,
    role: "admin",
    tab: "reviewPublish",
    lastRegionAnalysisTab: "reviewPublish",
    runId: "run-admin-other",
    regionKey: "kr_gyeongnam_hadong"
  }, b2bHistoryOptions));
  assert.equal(adminHistoryInB2B.tab, "map", "an admin-only region tab must fail closed to the B2B map tab");
  assert.equal(adminHistoryInB2B.lastRegionAnalysisTab, "map");
  assert.notEqual(adminHistoryInB2B.regionKey, "kr_gyeongnam_hadong");
  assert.notEqual(adminHistoryInB2B.runId, "run-admin-other");
  assert.ok(!["dictionary", "reviewPublish"].includes(adminHistoryInB2B.tab));

  const mismatchedCanonical = plain(sharedApi.resolveRegionAnalysisHistoryState({
    ...baseHistory,
    regionKey: "kr_gyeongnam_hadong"
  }, b2bHistoryOptions));
  assert.equal(mismatchedCanonical.regionKey, "", "history cannot restore a different canonical region");

  const dictionaryState = {
    activeTab: "dictionary",
    data: { regionContext: canonicalContext() },
    regionAnalysisRegionKey: "kr_gyeonggi_pocheon",
    selectedLocationCard: null
  };
  const dictionaryEls = { dictionarySearchInput: { value: "" } };
  const selectedKeys = [];
  const dictionaryApi = loadFunctions(["runDictionarySearch"], {
    state: dictionaryState,
    els: dictionaryEls,
    matchedRegionContextKey,
    locationCardForQuery: () => ({
      card: { regionKey: "kr_gyeongnam_hadong", searchKeyword: "하동글램핑" },
      group: null,
      alias: null,
      reason: "card-exact"
    }),
    setRegionAnalysisRegionKey: (regionKey) => {
      dictionaryState.regionAnalysisRegionKey = regionKey;
      selectedKeys.push(regionKey);
      return regionKey;
    },
    renderLocationDictionary: () => {}
  });
  dictionaryApi.runDictionarySearch("하동글램핑");
  assert.equal(dictionaryState.regionAnalysisRegionKey, "kr_gyeonggi_pocheon");
  assert.equal(selectedKeys.at(-1), "kr_gyeonggi_pocheon", "an arbitrary dictionary card cannot replace the run's canonical region context");

  dictionaryState.data.regionContext = { matchStatus: "ambiguous", regionKey: "kr_gyeonggi_pocheon" };
  dictionaryApi.runDictionarySearch("하동글램핑");
  assert.equal(dictionaryState.regionAnalysisRegionKey, "", "an ambiguous run stays unconnected even when a dictionary card matches");

  assert.equal(networkGuard.blockedAttempts(), 0);
  console.log("Region analysis shared context state fixture checks passed");
} finally {
  networkGuard.restore();
}
