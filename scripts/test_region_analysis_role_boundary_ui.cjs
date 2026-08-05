"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const { installFixtureNetworkGuard, LOCAL_HOSTS } = require("./fixture_network_guard.cjs");
const {
  buildRegionInsightState,
  publishRegionInsightState
} = require("./region_insight_contract.cjs");

const ROOT = path.resolve(__dirname, "..");
const APP_SOURCE = fs.readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
const REGION_ANALYSIS_TABS = Object.freeze({
  admin: Object.freeze(["map", "demand", "dictionary", "reviewPublish"]),
  b2b: Object.freeze(["map", "demand", "regionInsight"])
});
const ADMIN_ANALYSIS_TABS = Object.freeze(["report", "rank", "historyOps"]);

function balancedRange(source, openIndex, openCharacter = "{", closeCharacter = "}") {
  assert.equal(source[openIndex], openCharacter, `expected ${openCharacter} at ${openIndex}`);
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
    if (depth === 0) return { open: openIndex, close: index, body: source.slice(openIndex + 1, index) };
  }
  assert.fail(`unbalanced ${openCharacter}${closeCharacter} block`);
}

function constantObjectSource(name) {
  const marker = `const ${name} =`;
  const markerIndex = APP_SOURCE.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing ${name}`);
  const openIndex = APP_SOURCE.indexOf("{", markerIndex + marker.length);
  const range = balancedRange(APP_SOURCE, openIndex);
  return APP_SOURCE.slice(range.open, range.close + 1);
}

function functionSource(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(APP_SOURCE);
  assert.ok(match, `missing function ${name}`);
  const parameterOpen = APP_SOURCE.indexOf("(", match.index);
  let depth = 0;
  let parameterClose = -1;
  for (let index = parameterOpen; index < APP_SOURCE.length; index += 1) {
    if (APP_SOURCE[index] === "(") depth += 1;
    if (APP_SOURCE[index] === ")") depth -= 1;
    if (depth === 0) {
      parameterClose = index;
      break;
    }
  }
  assert.notEqual(parameterClose, -1, `missing parameter close for ${name}`);
  const range = balancedRange(APP_SOURCE, APP_SOURCE.indexOf("{", parameterClose));
  return APP_SOURCE.slice(match.index, range.close + 1);
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
  return JSON.parse(JSON.stringify(value));
}

function assertNoPrivateFields(value, location = "projection") {
  const forbidden = /^(?:reviewer|adminMemo|draftHash|reviewedDraftHash|snapshotHash|publicationHistory|auditHistory|history|publishedBy)$/i;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateFields(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.doesNotMatch(key, forbidden, `${location}.${key} must remain private`);
    assertNoPrivateFields(nested, `${location}.${key}`);
  }
}

function publishedFixture() {
  const base = buildRegionInsightState({
    regionKey: "kr_gyeonggi_pocheon",
    locationAttractiveness: {
      value: 72,
      modelVersion: "role-boundary-fixture-v1",
      components: [
        { key: "market_demand", value: 72, weight: 1, evidenceIds: ["fixture-demand"] }
      ]
    },
    dataQuality: {
      status: "partial",
      score: 76,
      grade: "B",
      penalties: [{ code: "fixture_partial", message: "fixture coverage only", points: 8 }],
      coverage: { numerator: 3, denominator: 5, note: "fixture coverage" },
      freshness: {
        status: "fresh",
        asOf: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
        ageDays: 0
      }
    },
    review: {
      status: "draft",
      reviewer: { id: "private-reviewer", displayName: "Private Reviewer" },
      adminMemo: "PRIVATE_DRAFT_MEMO"
    },
    publication: { status: "unpublished" }
  });
  const reviewed = buildRegionInsightState({
    ...base,
    review: {
      status: "reviewed",
      reviewedDraftHash: base.draftHash,
      reviewedAt: "2026-08-05T01:00:00.000Z",
      reviewer: { id: "private-reviewer", displayName: "Private Reviewer" },
      adminMemo: "PRIVATE_REVIEW_MEMO"
    }
  });
  return {
    draft: base,
    published: publishRegionInsightState(reviewed, {
      publicationId: "role-boundary-publication-v1",
      version: "role-boundary-v1",
      publishedAt: "2026-08-05T02:00:00.000Z",
      publishedBy: "private-publisher",
      adminMemo: "PRIVATE_PUBLISH_MEMO",
      registryVersion: "location-region-registry-fixture-v1",
      regionIdentity: {
        regionKey: "kr_gyeonggi_pocheon",
        sido: "경기도",
        sigungu: "포천시",
        displayLabel: "경기도 포천시"
      }
    })
  };
}

async function listenLocalhost(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object" && address.port > 0);
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main() {
  const APP_NAVIGATION = vm.runInNewContext(`(${constantObjectSource("APP_NAVIGATION")})`, {
    ADMIN_ANALYSIS_TABS,
    REGION_ANALYSIS_TABS
  });
  const navigation = loadFunctions([
    "navigationModel",
    "navigationEntries",
    "drawerNavigationEntries",
    "regionAnalysisTabIds",
    "regionAnalysisTabItems",
    "resolveRegionAnalysisReturnTab",
    "resolveHistoryTabForRole"
  ], {
    APP_NAVIGATION,
    REGION_ANALYSIS_TABS,
    currentRole: () => "admin",
    firstRoleTab: () => "report"
  });

  for (const role of ["admin", "b2b"]) {
    const topLevel = plain(navigation.navigationEntries(role));
    const regionEntries = topLevel.filter((item) => item.key === "region-analysis");
    assert.equal(regionEntries.length, 1, `${role} must expose one top-level region analysis menu`);
    assert.equal(regionEntries[0].drawerChildren, false, `${role} drawer must keep region analysis as one item`);
    const configuredTabs = plain(navigation.regionAnalysisTabIds(role));
    assert.deepEqual(configuredTabs, [...REGION_ANALYSIS_TABS[role]], `${role} region tabs mismatch`);
    assert.deepEqual(
      plain(navigation.regionAnalysisTabItems(role)).map((item) => item.tab),
      [...REGION_ANALYSIS_TABS[role]],
      `${role} region tab children must follow the role contract`
    );
    const drawerRegionEntries = plain(navigation.drawerNavigationEntries(role))
      .filter((item) => item.key === "region-analysis" || REGION_ANALYSIS_TABS.admin.includes(item.tab) || REGION_ANALYSIS_TABS.b2b.includes(item.tab));
    assert.deepEqual(drawerRegionEntries.map((item) => item.key), ["region-analysis"], `${role} drawer must not duplicate region child links`);
  }

  const b2bTabs = plain(navigation.regionAnalysisTabIds("b2b"));
  for (const adminOnlyTab of ["dictionary", "reviewPublish"]) {
    assert.equal(b2bTabs.includes(adminOnlyTab), false);
    assert.equal(
      navigation.resolveHistoryTabForRole(adminOnlyTab, plain(APP_NAVIGATION.b2b.allowedTabs), b2bTabs),
      "map",
      `${adminOnlyTab} history must fail closed to the first B2B region tab`
    );
    assert.equal(navigation.resolveRegionAnalysisReturnTab(adminOnlyTab, b2bTabs), "map");
  }

  const networkGuard = installFixtureNetworkGuard({
    allowLocalhost: true,
    label: "region role-boundary UI fixture"
  });
  const localServer = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  try {
    assert.deepEqual([...LOCAL_HOSTS].sort(), ["127.0.0.1", "::1", "[::1]", "localhost"].sort());
    const baseUrl = await listenLocalhost(localServer);
    const localResponse = await fetch(`${baseUrl}/fixture-health`);
    assert.equal(localResponse.status, 204, "localhost fixture requests must remain available");
    assert.throws(
      () => fetch("https://example.invalid/forbidden-region-ui-fixture"),
      /External network is forbidden in region role-boundary UI fixture/
    );
    assert.equal(networkGuard.blockedAttempts(), 1, "the external request must be rejected before transport");

    const { __test: serverTest } = require("./glamping_app_server.cjs");
    const { draft, published } = publishedFixture();
    const { draftHash: _publishedDraftHash, ...publishedWithoutDraftHash } = published;
    const stale = buildRegionInsightState({
      ...publishedWithoutDraftHash,
      locationAttractiveness: {
        ...published.locationAttractiveness,
        value: 29,
        components: published.locationAttractiveness.components.map((component) => ({ ...component, value: 29 }))
      }
    });
    assert.equal(stale.publication.status, "stale");

    const regionContext = {
      regionKey: "kr_gyeonggi_pocheon",
      matchStatus: "matched",
      sido: "경기도",
      sigungu: "포천시",
      displayLabel: "경기도 포천시"
    };
    const internalRun = {
      run: { id: "role-boundary-run", keyword: "포천 글램핑" },
      regionContext,
      regionInsight: stale,
      adminRegionalOperations: { adminMemo: "PRIVATE_OPERATIONS_MEMO", reviewer: "private-reviewer" }
    };
    assert.equal(serverTest.publicRunForRole(internalRun, "admin"), internalRun, "admin keeps the internal workbench record");
    const publicRun = serverTest.publicRunForRole(internalRun, "b2b");
    assert.equal(Object.hasOwn(publicRun, "regionInsight"), false);
    assert.equal(Object.hasOwn(publicRun, "adminRegionalOperations"), false);
    assert.equal(publicRun.b2bRegionInsight.publication.status, "stale");
    assert.equal(publicRun.b2bRegionInsight.locationAttractiveness.value, 72, "B2B keeps the immutable published value");
    assert.notEqual(publicRun.b2bRegionInsight.locationAttractiveness.value, 29, "the current admin draft must not cross the role boundary");
    assertNoPrivateFields(publicRun);
    const serializedPublicRun = JSON.stringify(publicRun);
    for (const sentinel of [
      "PRIVATE_DRAFT_MEMO",
      "PRIVATE_REVIEW_MEMO",
      "PRIVATE_PUBLISH_MEMO",
      "PRIVATE_OPERATIONS_MEMO",
      "private-reviewer",
      "private-publisher"
    ]) {
      assert.equal(serializedPublicRun.includes(sentinel), false, `B2B projection leaked ${sentinel}`);
    }

    const unpublishedRun = serverTest.publicRunForRole({
      run: { id: "role-boundary-unpublished" },
      regionContext,
      regionInsight: draft
    }, "b2b");
    assert.equal(unpublishedRun.b2bRegionInsight, null, "unpublished drafts must not create a B2B card");

    const view = loadFunctions([
      "finiteRegionInsightNumber",
      "publicRegionInsightProjection",
      "b2bRegionInsightViewModel"
    ], { state: { data: null } });
    const publishedModel = plain(view.b2bRegionInsightViewModel(publicRun));
    assert.equal(publishedModel.available, true);
    assert.equal(publishedModel.state, "stale");
    assert.equal(publishedModel.locationAttractiveness.value, 72);
    const internalOnlyModel = plain(view.b2bRegionInsightViewModel({
      regionContext,
      regionInsight: published,
      b2bRegionInsight: null
    }));
    assert.equal(internalOnlyModel.available, false, "B2B UI must not fall back to the internal regionInsight record");
    assert.equal(internalOnlyModel.state, "unpublished");
  } finally {
    await closeServer(localServer);
    networkGuard.restore();
  }

  console.log("Region analysis role-boundary UI fixture checks passed (single menu, role tabs, published snapshot, localhost-only)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
