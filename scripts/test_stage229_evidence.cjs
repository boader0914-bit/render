"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  INSIGHTS_ALGORITHM_VERSION,
  INSIGHTS_FIXTURE_VERSION,
  INSIGHTS_PROVIDER_ID,
  stableHash
} = require("./integration/contracts/insights.cjs");
const { ROOT } = require("./test_support/stage229_test_helpers.cjs");

const COMPLETION_PATH = path.join(ROOT, "docs", "stage229_completion_evidence.json");
const VISUAL_PATH = path.join(ROOT, "test", "results", "stage229_visual_qa.json");
const SIGNAL_FIXTURE_PATH = path.join(ROOT, "test", "fixtures", "stage229", "signal_contract_v1.json");
const CASE_FIXTURE_PATH = path.join(ROOT, "test", "fixtures", "stage229", "location_forecast_cases_v1.json");
const EXPECTED_SIGNAL_HASH = "690f783d1c79e4864ddbdbf8bf3f2a144dda703a54b3fd53713699e9af13367b";
const EXPECTED_CASE_HASH = "1af0ab9f240195f9738b8790f38713e7027d761e9d6fab3905436adf0d3adb93";
const EXPECTED_BASE_COMMIT = "20889063ff4cc1b016f24186bce7946dea6268d7";

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function git(...args) {
  return childProcess.execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
}

function assertNoStage230Paths() {
  const roots = [
    path.join(ROOT, "apps", "web", "src", "reporting"),
    path.join(ROOT, "scripts", "integration"),
    path.join(ROOT, "test", "fixtures"),
    path.join(ROOT, "docs")
  ];
  const discovered = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (/stage230/i.test(path.relative(ROOT, filename))) discovered.push(path.relative(ROOT, filename));
      if (entry.isDirectory()) walk(filename);
    }
  }
  roots.forEach(walk);
  assert.deepEqual(discovered, [], `unexpected Stage 230 paths: ${discovered.join(", ")}`);
}

function assertVisualReport(visual) {
  assert.equal(visual.stage, 229);
  assert.equal(visual.passed, true);
  assert.equal(visual.surfaceCount, 3);
  assert.equal(visual.conditionCombinationsPerSurface, 4);
  assert.equal(visual.screenshotCount, 12);
  assert.deepEqual(visual.surfaces.map((row) => row.id), ["admin-location", "business-location", "business-report"]);
  assert.equal(visual.accessibility.normalTextMinimumContrastRatio, 4.5);
  assert.equal(visual.accessibility.largeTextMinimumContrastRatio, 3);
  assert.equal(visual.accessibility.contrastViolations, 0);
  assert.equal(visual.accessibility.keyboardFocusVisible, true);
  assert.equal(visual.responsive.minimumCssWidth, 320);
  assert.equal(visual.responsive.zoomPercent, 200);
  assert.equal(visual.externalBrowserRequests, 0);
  assert.equal(visual.externalProviderCalls, 0);
  assert.equal(visual.serverNetworkAttempts, 0);
  assert.equal(visual.browserErrors, 0);
  assert.equal(visual.rawOrInternalValuesVisible, false);
  assert.deepEqual(visual.reportToLocationNavigation, {
    from: "/app/report",
    to: "/app/location",
    sameOrigin: true,
    passed: true
  });

  const expectedCombinations = new Set();
  for (const surface of ["admin-location", "business-location", "business-report"]) {
    for (const viewport of ["desktop", "mobile"]) {
      for (const theme of ["light", "dark"]) expectedCombinations.add(`${surface}|${viewport}|${theme}`);
    }
  }
  assert.equal(visual.results.length, 12);
  for (const row of visual.results) {
    assert.equal(row.passed, true);
    assert.deepEqual(row.browserErrors, []);
    assert.ok(row.keyboard.distinct >= 3);
    assert.ok(row.keyboard.visibleIndicators >= 2);
    assert.equal(row.inspection.loadState, "ready");
    assert.equal(row.inspection.state, "ready");
    assert.ok(row.inspection.overflowX <= 1);
    assert.equal(row.inspection.contrastViolationCount, 0);
    assert.deepEqual(row.inspection.contrastViolations, []);
    assert.deepEqual(row.inspection.forbidden, []);
    assert.ok(Object.values(row.inspection.selectors).every(Boolean));
    assert.equal(expectedCombinations.delete(`${row.surface}|${row.viewport}|${row.theme}`), true, "duplicate or unexpected visual combination");
  }
  assert.equal(expectedCombinations.size, 0);

  assert.equal(visual.special.length, 6);
  for (const surface of ["admin-location", "business-location", "business-report"]) {
    const minimum = visual.special.find((row) => row.surface === surface && row.id === "minimum-320");
    const zoom = visual.special.find((row) => row.surface === surface && row.id === "zoom-200");
    assert.ok(minimum?.passed && zoom?.passed, `${surface}: responsive special checks`);
    assert.equal(minimum.effectiveCssWidth, 320);
    assert.equal(minimum.overflowX, 0);
    assert.equal(zoom.zoomPercent, 200);
    assert.equal(Number(zoom.computedZoom), 2);
    assert.equal(zoom.effectiveCssWidth, 320);
    assert.equal(zoom.overflowX, 0);
  }
}

function assertCompletionEvidence(evidence, visual) {
  assert.equal(evidence.schemaVersion, "stage229-local-acceptance-v1");
  assert.equal(evidence.stage, 229);
  assert.equal(evidence.status, "local-acceptance-passed");
  assert.deepEqual(evidence.blockers, []);
  assert.match(evidence.scope, /local acceptance only/i);
  assert.equal(evidence.source.branch, git("branch", "--show-current"));
  assert.equal(evidence.source.baseCommit, EXPECTED_BASE_COMMIT);
  assert.doesNotThrow(() => git("merge-base", "--is-ancestor", evidence.source.baseCommit, "HEAD"));
  assert.equal(evidence.source.workingTree, "uncommitted-preview-checkpoint");
  assert.equal(evidence.source.legacyDataImported, false);
  assert.deepEqual(evidence.versions, {
    providerId: INSIGHTS_PROVIDER_ID,
    fixtureVersion: INSIGHTS_FIXTURE_VERSION,
    algorithmVersion: INSIGHTS_ALGORITHM_VERSION
  });
  assert.equal(evidence.fixtureHashes.signalContract, EXPECTED_SIGNAL_HASH);
  assert.equal(evidence.fixtureHashes.locationForecastCases, EXPECTED_CASE_HASH);
  assert.deepEqual(evidence.freshnessGates.completeLeadDays, [14, 7, 1]);
  assert.equal(evidence.freshnessGates.minimumCompleteSeries, 3);
  assert.equal(evidence.freshnessGates.minimumStockPairPoints, 9);
  assert.equal(evidence.freshnessGates.latestCompleteLeadtimePointMaximumAgeHours, 24);
  assert.equal(evidence.freshnessGates.latestScoredOtaPointMaximumAgeHours, 24);
  assert.equal(evidence.freshnessGates.everyRequiredSignalKindMaximumAgeHours, 168);
  assert.equal(evidence.freshnessGates.forecastAndReportMonth, "exact-next-month-from-asOf");
  assert.equal(evidence.freshnessGates.signalFixturePeriod, "asOf-current-month");

  assert.deepEqual(evidence.runtimeBoundary, {
    dataBoundary: "fresh-integration-stage229-only",
    externalProviderCalls: 0,
    credentialReads: 0,
    legacyRuntimeReads: 0,
    legacyRuntimeCopies: 0,
    productionMutations: 0,
    stage230Assets: 0
  });
  assert.equal(evidence.cohortContract.minimumAnonymousPeers, 3);
  assert.ok(Object.entries(evidence.cohortContract).filter(([key]) => key !== "minimumAnonymousPeers").every(([, value]) => value === true));
  assert.equal(evidence.evidenceBoundary.adminExposesInternalRelationId, false);
  assert.equal(evidence.evidenceBoundary.businessExposesInternalRelationId, false);
  assert.equal(evidence.evidenceBoundary.businessExposesPeerIds, false);
  assert.equal(evidence.lifecycle.ownershipRevalidatedOnEveryMutation, true);
  assert.equal(evidence.lifecycle.publishFreshnessRevalidated, true);
  assert.equal(evidence.lifecycle.minimumSampleGateBlocksPublish, true);
  assert.equal(evidence.lifecycle.collectingStatePreservedWithActiveRunAndNoReport, true);
  assert.equal(evidence.rollback.individualCardOrReportRollback, false);
  assert.equal(evidence.rollback.isolatedSameVolumeRestore, true);
  assert.equal(evidence.rollback.renameSwapWithBackupJournal, true);
  assert.equal(evidence.rollback.restartRecovery, true);
  assert.equal(evidence.rollback.corruptSnapshotLeavesLiveStateUnchanged, true);
  assert.deepEqual(evidence.rollback.preflightBeforeLiveWrite, ["filesHash", "fileChecksum", "fileSize", "schema", "storeOwnership"]);

  assert.equal(evidence.visualAcceptance.report, "test/results/stage229_visual_qa.json");
  assert.equal(evidence.visualAcceptance.screenshotCount, visual.screenshotCount);
  assert.equal(evidence.visualAcceptance.contrastViolations, 0);
  assert.equal(evidence.visualAcceptance.horizontalOverflowViolations, 0);
  assert.equal(evidence.visualAcceptance.browserErrors, 0);
  assert.equal(evidence.visualAcceptance.externalBrowserRequests, 0);
  assert.equal(evidence.visualAcceptance.reportToLocationNavigation, "passed");

  const requiredCommands = [
    "node scripts/test_stage229_contracts.cjs",
    "node scripts/test_stage229_service.cjs",
    "node scripts/test_stage229_server.cjs",
    "node scripts/test_stage229_security.cjs",
    "node scripts/test_stage229_ui_contracts.cjs",
    "node scripts/test_stage229_visual.cjs",
    "node scripts/test_stage229_visual.cjs --write-evidence",
    "npm run build:ui",
    "git diff --check"
  ];
  const commands = new Map(evidence.validation.commands.map((row) => [row.command, row]));
  for (const command of requiredCommands) {
    const row = commands.get(command);
    assert.ok(row, `missing validation command ${command}`);
    assert.match(row.status, /^passed/);
  }
  assert.equal(commands.get("node scripts/test_stage229_visual.cjs").trackedEvidenceMutated, false);
  assert.equal(commands.get("node scripts/test_stage229_visual.cjs --write-evidence").trackedEvidenceMutated, true);
  assert.equal(evidence.validation.preWiringRegressionSuite.status, "passed");
  assert.equal(evidence.validation.finalRegressionSuite.command, "npm test");
  assert.equal(evidence.validation.finalRegressionSuite.status, "passed");
  assert.match(evidence.validation.finalRegressionSuite.scope, /Stages 222 through 229/);
  assert.equal(evidence.validation.packageStage229Wiring, "present-and-final-rerun-passed");

  assert.equal(evidence.previewDeployment.status, "pending-checkpoint");
  assert.equal(evidence.previewDeployment.commitCreated, false);
  assert.equal(evidence.previewDeployment.pushed, false);
  assert.equal(evidence.previewDeployment.renderDeploymentObserved, false);
  assert.equal(evidence.previewDeployment.renderSmokeTested, false);
  assert.match(evidence.previewDeployment.note, /outside this local acceptance evidence/i);

  for (const artifact of evidence.artifacts) {
    assert.equal(path.isAbsolute(artifact), false, `artifact must be repository-relative: ${artifact}`);
    assert.doesNotMatch(artifact, /stage230/i);
    assert.equal(fs.existsSync(path.join(ROOT, artifact)), true, `missing evidence artifact: ${artifact}`);
  }
}

function assertSourcesAndWiring() {
  const signalFixture = readJson(SIGNAL_FIXTURE_PATH);
  const caseFixture = readJson(CASE_FIXTURE_PATH);
  assert.equal(stableHash(signalFixture, 64), EXPECTED_SIGNAL_HASH);
  assert.equal(stableHash(caseFixture, 64), EXPECTED_CASE_HASH);

  const monthlyReportDoc = fs.readFileSync(path.join(ROOT, "docs", "stage229_location_forecast_monthly_report.md"), "utf8");
  const rollbackDoc = fs.readFileSync(path.join(ROOT, "docs", "stage229_rollback_runbook.md"), "utf8");
  assert.match(monthlyReportDoc, /complete D14·D7·D1 lead-time 시계열의 최신 관측점/);
  assert.match(monthlyReportDoc, /OTA 최신 관측점이 각각 기준일로부터 24시간 이내/);
  assert.match(monthlyReportDoc, /signal fixture의 수집 기간은 예측 대상 월이 아니라 기준일이 속한 현재 월/);
  assert.match(rollbackDoc, /격리된 동일 볼륨 restore 디렉터리/);
  assert.match(rollbackDoc, /live state에는 쓰지 않는다/);
  assert.match(rollbackDoc, /backup journal/);

  const serviceTest = fs.readFileSync(path.join(ROOT, "scripts", "test_stage229_service.cjs"), "utf8");
  for (const pattern of [
    /INSIGHTS_FORECAST_MONTH_INVALID/,
    /tenant_stage229_reassigned/,
    /25 \* 3_600_000/,
    /obs_stage229_service_peer_ancient_irrelevant/,
    /cohortSnapshotHash/,
    /corrupt-after-snapshot/,
    /state, "collecting"/
  ]) assert.match(serviceTest, pattern);

  const visualTest = fs.readFileSync(path.join(ROOT, "scripts", "test_stage229_visual.cjs"), "utf8");
  assert.match(visualTest, /process\.argv\.includes\("--write-evidence"\)/);
  assert.match(visualTest, /largeText \? 3 : 4\.5/);
  assert.match(visualTest, /document\.documentElement\.style\.zoom = "2"/);
  assert.match(visualTest, /externalRequests\.push/);

  const packageJson = readJson(path.join(ROOT, "package.json"));
  assert.match(packageJson.scripts.check, /test_stage229_evidence\.cjs/);
  assert.match(packageJson.scripts["test:stage229"], /test:insights-evidence/);
  assert.match(packageJson.scripts.test, /test:stage229/);
  assertNoStage230Paths();
}

function main() {
  const completion = readJson(COMPLETION_PATH);
  const visual = readJson(VISUAL_PATH);
  assertVisualReport(visual);
  assertCompletionEvidence(completion, visual);
  assertSourcesAndWiring();
  console.log("Stage 229 completion evidence, fixtures, visual QA, local-only scope and deployment checkpoint checks passed");
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
