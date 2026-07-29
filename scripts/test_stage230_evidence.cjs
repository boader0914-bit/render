"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  CANDIDATE_TYPES,
  ITEM_STATUSES,
  PLAN_STATUSES,
  STRATEGY_DOMAINS,
  STRATEGY_RULE_VERSION,
  stableHash
} = require("./integration/contracts/strategy_execution.cjs");
const { ROOT, WORKFLOW_FIXTURE_PATH } = require("./test_support/stage230_test_helpers.cjs");

const COMPLETION_PATH = path.join(ROOT, "docs", "stage230_completion_evidence.json");
const VISUAL_PATH = path.join(ROOT, "test", "results", "stage230_visual_qa.json");
const EXPECTED_FIXTURE_HASH = "4dc8c8ba984d00773a2abe0007309a7e4d4188e0888fb116637a6434f950cf50";
const EXPECTED_BASE_COMMIT = "59002d8e190af0c1f97ad627358c4b5506f27871";
const SURFACES = [
  "business-strategy", "business-execution", "business-retrospective",
  "admin-strategy", "admin-execution", "admin-retrospective"
];

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function git(...args) {
  return childProcess.execFileSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
}

function assertVisual(visual) {
  assert.equal(visual.stage, 230);
  assert.equal(visual.passed, true);
  assert.equal(visual.surfaceCount, 6);
  assert.equal(visual.conditionCombinationsPerSurface, 4);
  assert.equal(visual.screenshotCount, 24);
  assert.deepEqual(visual.surfaces.map((row) => row.id), SURFACES);
  assert.equal(visual.results.length, 24);
  assert.equal(visual.special.length, 12);
  assert.equal(visual.accessibility.normalTextMinimumContrastRatio, 4.5);
  assert.equal(visual.accessibility.largeTextMinimumContrastRatio, 3);
  assert.equal(visual.accessibility.contrastViolations, 0);
  assert.equal(visual.accessibility.keyboardFocusVisible, true);
  assert.equal(visual.responsive.minimumCssWidth, 320);
  assert.equal(visual.responsive.zoomPercent, 200);
  for (const key of ["externalBrowserRequests", "externalProviderCalls", "serverNetworkAttempts", "legacyRuntimeReads", "legacyRuntimeCopies", "productionMutations", "browserErrors"]) {
    assert.equal(visual[key], 0, `${key} must remain zero`);
  }
  assert.equal(visual.rawOrInternalValuesVisible, false);
  assert.deepEqual(visual.navigation, {
    from: "/app/strategy",
    through: "/app/execution",
    to: "/app/retrospective",
    sameOrigin: true,
    passed: true
  });

  const combinations = new Set();
  for (const surface of SURFACES) {
    for (const viewport of ["desktop", "mobile"]) {
      for (const theme of ["light", "dark"]) combinations.add(`${surface}|${viewport}|${theme}`);
    }
  }
  for (const row of visual.results) {
    assert.equal(combinations.delete(`${row.surface}|${row.viewport}|${row.theme}`), true, "duplicate visual combination");
    assert.equal(row.passed, true);
    assert.deepEqual(row.browserErrors, []);
    assert.ok(row.keyboard.distinct >= 4);
    assert.ok(row.keyboard.visibleIndicators >= 2);
    assert.equal(row.inspection.loadState, "ready");
    assert.equal(row.inspection.state, "ready");
    assert.ok(row.inspection.overflowX <= 1);
    assert.deepEqual(row.inspection.contrastViolations, []);
    assert.deepEqual(row.inspection.forbidden, []);
    assert.ok(Object.values(row.inspection.selectorState).every(Boolean));
    assert.equal(row.inspection.navCount, row.surface.startsWith("admin-") ? 13 : 9);
  }
  assert.equal(combinations.size, 0);
  for (const surface of SURFACES) {
    const minimum = visual.special.find((row) => row.surface === surface && row.id === "minimum-320");
    const zoom = visual.special.find((row) => row.surface === surface && row.id === "zoom-200");
    assert.ok(minimum?.passed && zoom?.passed, `${surface} responsive checks`);
    assert.equal(minimum.effectiveCssWidth, 320);
    assert.ok(minimum.overflowX <= 1);
    assert.equal(zoom.zoomPercent, 200);
    assert.equal(Number(zoom.computedZoom), 2);
    assert.equal(zoom.effectiveCssWidth, 320);
    assert.ok(zoom.overflowX <= 1);
  }
}

function assertCompletion(evidence, visual) {
  assert.equal(evidence.schemaVersion, "stage230-local-acceptance-v1");
  assert.equal(evidence.stage, 230);
  assert.equal(evidence.status, "local-component-acceptance-passed");
  assert.deepEqual(evidence.blockers, []);
  assert.equal(evidence.source.branch, git("branch", "--show-current"));
  assert.equal(evidence.source.baseCommit, EXPECTED_BASE_COMMIT);
  assert.doesNotThrow(() => git("merge-base", "--is-ancestor", EXPECTED_BASE_COMMIT, "HEAD"));
  assert.equal(evidence.source.legacyDataImported, false);
  assert.equal(evidence.versions.ruleVersion, STRATEGY_RULE_VERSION);
  assert.equal(evidence.versions.fixtureHash, EXPECTED_FIXTURE_HASH);
  assert.deepEqual(evidence.publishedReportGate.domains, [...STRATEGY_DOMAINS]);
  assert.equal(evidence.publishedReportGate.insufficientReportStrategyCount, 0);
  assert.equal(evidence.publishedReportGate.unpublishedReportStrategyCount, 0);
  assert.deepEqual(evidence.workflow.planStatuses, [...PLAN_STATUSES]);
  assert.deepEqual(evidence.workflow.itemStatuses, [...ITEM_STATUSES]);
  assert.deepEqual(evidence.workflow.candidateTypes, [...CANDIDATE_TYPES]);
  assert.equal(evidence.workflow.lineageMissing, 0);
  assert.equal(evidence.workflow.candidateReuseBlocked, true);
  assert.equal(evidence.workflow.kpiMissingIsNotZero, true);
  for (const key of ["externalProviderCalls", "credentialReads", "legacyRuntimeReads", "legacyRuntimeCopies", "productionMutations", "stage231Assets"]) {
    assert.equal(evidence.securityBoundary[key], 0, `${key} evidence`);
  }
  assert.equal(evidence.securityBoundary.tenantOwnershipServerEnforced, true);
  assert.equal(evidence.securityBoundary.entitlementServerEnforced, true);
  assert.equal(evidence.securityBoundary.businessProjectionExposesTenantCompanyId, false);
  assert.ok(Object.values(evidence.automationBoundary).every((value) => value === false));
  assert.equal(evidence.visualAcceptance.report, "test/results/stage230_visual_qa.json");
  assert.equal(evidence.visualAcceptance.screenshotCount, visual.screenshotCount);
  assert.equal(evidence.visualAcceptance.specialCheckCount, visual.special.length);
  assert.equal(evidence.visualAcceptance.contrastViolations, 0);
  assert.equal(evidence.visualAcceptance.horizontalOverflowViolations, 0);
  assert.equal(evidence.visualAcceptance.browserErrors, 0);
  assert.equal(evidence.visualAcceptance.externalBrowserRequests, 0);

  const required = [
    "node scripts/test_stage230_contracts.cjs",
    "node scripts/test_stage230_service.cjs",
    "node scripts/test_stage230_server.cjs",
    "node scripts/test_stage230_security.cjs",
    "node scripts/test_stage230_ui_contracts.cjs",
    "node scripts/test_stage230_visual.cjs",
    "node scripts/test_stage230_visual.cjs --write-evidence",
    "npm run typecheck:ui",
    "npm run build:ui"
  ];
  const commands = new Map(evidence.validation.commands.map((row) => [row.command, row]));
  for (const command of required) assert.equal(commands.get(command)?.status, "passed", `missing passed command ${command}`);
  assert.equal(commands.get("node scripts/test_stage230_visual.cjs").trackedEvidenceMutated, false);
  assert.equal(commands.get("node scripts/test_stage230_visual.cjs --write-evidence").trackedEvidenceMutated, true);
  assert.ok(["present", "present-and-final-rerun-passed"].includes(evidence.validation.packageStage230Wiring));
  assert.ok(["scheduled-after-evidence-validator", "passed"].includes(evidence.validation.finalRegressionSuite.status));
  assert.equal(evidence.previewDeployment.status, "pending-verified-checkpoint");
  assert.equal(evidence.previewDeployment.commitCreated, false);
  assert.equal(evidence.previewDeployment.pushed, false);
  assert.equal(evidence.previewDeployment.renderDeploymentObserved, false);
  for (const artifact of evidence.artifacts) {
    assert.equal(path.isAbsolute(artifact), false);
    assert.equal(fs.existsSync(path.join(ROOT, artifact)), true, `missing artifact ${artifact}`);
  }
}

function assertSourcesAndWiring() {
  assert.equal(stableHash(readJson(WORKFLOW_FIXTURE_PATH), 64), EXPECTED_FIXTURE_HASH);
  const docs = `${read("docs/stage230_strategy_execution_retrospective.md")}\n${read("docs/stage230_rollback_runbook.md")}`;
  for (const phrase of ["published", "confidence", "carryover", "soft-cancel", "rollback", "V2_INTEGRATION_STRATEGY_ENABLED"]) {
    assert.match(docs, new RegExp(phrase, "i"), `documentation missing ${phrase}`);
  }
  const serviceTest = read("scripts/test_stage230_service.cjs");
  const acceptanceTests = `${serviceTest}\n${read("scripts/test_stage230_server.cjs")}\n${JSON.stringify(readJson(WORKFLOW_FIXTURE_PATH))}`;
  for (const phrase of ["STRATEGY_REPORT_NOT_PUBLISHED", "STRATEGY_REPORT_CONFIDENCE_REQUIRED", "STRATEGY_CANDIDATE_ALREADY_PLANNED", "sourceRetrospectiveIds", "businessSafeStrategyAssert"]) {
    assert.ok(acceptanceTests.includes(phrase), `Stage 230 acceptance missing ${phrase}`);
  }
  const packageJson = readJson(path.join(ROOT, "package.json"));
  assert.match(packageJson.scripts.check, /test_stage230_evidence\.cjs/);
  assert.match(packageJson.scripts["test:stage230"], /test:strategy-evidence/);
  assert.match(packageJson.scripts.test, /test:stage230/);
  const stage231NamedAssets = [...fs.readdirSync(path.join(ROOT, "scripts", "integration"), { recursive: true })]
    .filter((entry) => /stage231/i.test(String(entry)));
  assert.deepEqual(stage231NamedAssets, []);
}

function main() {
  const evidence = readJson(COMPLETION_PATH);
  const visual = readJson(VISUAL_PATH);
  assertVisual(visual);
  assertCompletion(evidence, visual);
  assertSourcesAndWiring();
  console.log("Stage 230 completion evidence, fixture hash, 24-screen visual QA, package wiring and Stage 231 deferral checks passed");
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
