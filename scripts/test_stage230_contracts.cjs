"use strict";

const assert = require("node:assert/strict");
const {
  BOARD_DUE_FILTERS,
  CANDIDATE_TYPES,
  ITEM_STATUSES,
  KPI_DIRECTIONS,
  PLAN_STATUSES,
  STRATEGY_API_BASE,
  STRATEGY_DOMAINS,
  STRATEGY_PLAN_ENTITLEMENTS,
  STRATEGY_RULE_VERSION,
  STRATEGY_SCHEMA_VERSION,
  STRATEGY_STAGE,
  STRATEGY_STORE_KIND,
  achievedForKpi,
  assertBusinessSafe,
  assertEligiblePublishedReport,
  deriveStrategyCards,
  entitlementsForStrategy,
  nextMonth,
  normalizeChecklist,
  normalizeKpi,
  reportGate,
  stableHash
} = require("./integration/contracts/strategy_execution.cjs");
const {
  INTEGRATION_FEATURE_DEFINITIONS,
  readIntegrationFeatureFlags
} = require("./integration_feature_flags.cjs");
const {
  applyReportPatch,
  stage230Fixture
} = require("./test_support/stage230_test_helpers.cjs");

function errorCode(error) {
  return error?.code || "";
}

function main() {
  const fixture = stage230Fixture();
  assert.equal(STRATEGY_STAGE, 230);
  assert.equal(STRATEGY_SCHEMA_VERSION, 1);
  assert.equal(STRATEGY_STORE_KIND, "glamping-datalab-v2-stage230-strategy-store");
  assert.equal(STRATEGY_RULE_VERSION, "v2-stage230-deterministic-strategy-v1");
  assert.equal(STRATEGY_API_BASE, "/api/integration/strategy");
  assert.deepEqual(STRATEGY_DOMAINS, fixture.expected.domains);
  assert.deepEqual(PLAN_STATUSES, ["draft", "active", "completed", "cancelled"]);
  assert.deepEqual(ITEM_STATUSES, fixture.expected.itemStatuses);
  assert.deepEqual(KPI_DIRECTIONS, ["increase", "decrease", "maintain"]);
  assert.deepEqual(CANDIDATE_TYPES, fixture.expected.candidateKinds);
  assert.deepEqual(BOARD_DUE_FILTERS, ["all", "overdue", "this-week"]);
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.strategy.dependsOn, ["businessReport"]);
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.execution.dependsOn, ["strategy"]);
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.retrospective.dependsOn, ["execution"]);
  assert.deepEqual([
    INTEGRATION_FEATURE_DEFINITIONS.strategy.envKey,
    INTEGRATION_FEATURE_DEFINITIONS.execution.envKey,
    INTEGRATION_FEATURE_DEFINITIONS.retrospective.envKey
  ], [
    "V2_INTEGRATION_STRATEGY_ENABLED",
    "V2_INTEGRATION_EXECUTION_ENABLED",
    "V2_INTEGRATION_RETROSPECTIVE_ENABLED"
  ]);
  const dependencyBase = {
    NODE_ENV: "test",
    V2_INTEGRATION_AUTH_ENABLED: "true",
    V2_INTEGRATION_PLATFORM_CORE_ENABLED: "true",
    V2_INTEGRATION_FRESH_COMPANY_ENABLED: "true",
    V2_INTEGRATION_FRESH_OBSERVATION_ENABLED: "true",
    V2_INTEGRATION_BUSINESS_REPORT_ENABLED: "true"
  };
  assert.equal(readIntegrationFeatureFlags({}).strategy, false);
  assert.equal(readIntegrationFeatureFlags({ ...dependencyBase, V2_INTEGRATION_EXECUTION_ENABLED: "true" }).execution, false);
  assert.equal(readIntegrationFeatureFlags({
    ...dependencyBase,
    V2_INTEGRATION_STRATEGY_ENABLED: "true",
    V2_INTEGRATION_EXECUTION_ENABLED: "true",
    V2_INTEGRATION_RETROSPECTIVE_ENABLED: "true"
  }).retrospective, true);
  assert.equal(fixture.ruleVersion, STRATEGY_RULE_VERSION);
  assert.equal(
    stableHash(fixture, 64),
    "4dc8c8ba984d00773a2abe0007309a7e4d4188e0888fb116637a6434f950cf50",
    "Stage 230 fixture changed without an explicit schema/rule version update"
  );

  assert.deepEqual(reportGate(fixture.publishedReport), {
    eligible: true,
    state: "ready",
    reason: "",
    reportId: fixture.publishedReport.reportId,
    confidence: "medium"
  });
  assert.equal(assertEligiblePublishedReport(fixture.publishedReport).reportId, fixture.publishedReport.reportId);

  for (const blocked of fixture.blockedReports) {
    const report = applyReportPatch(fixture.publishedReport, blocked.patch);
    assert.equal(reportGate(report).eligible, false, blocked.id);
    assert.throws(
      () => assertEligiblePublishedReport(report),
      (error) => errorCode(error) === blocked.expectedCode && error.statusCode === 409,
      blocked.id
    );
    assert.throws(
      () => deriveStrategyCards(report, {
        companyId: fixture.companyId,
        generatedAt: fixture.asOf,
        generatedBy: "account_stage230_admin"
      }),
      (error) => errorCode(error) === blocked.expectedCode,
      `${blocked.id}: no strategy may be emitted`
    );
  }

  const input = {
    companyId: fixture.companyId,
    generatedAt: fixture.asOf,
    generatedBy: "account_stage230_admin"
  };
  const first = deriveStrategyCards(fixture.publishedReport, input);
  const second = deriveStrategyCards(structuredClone(fixture.publishedReport), input);
  assert.deepEqual(second, first, "same published report + rule version must yield byte-stable strategy cards");
  assert.equal(first.length, fixture.expected.strategyCount);
  assert.deepEqual(first.map((row) => row.domain), fixture.expected.domains);
  assert.equal(new Set(first.map((row) => row.strategyId)).size, first.length);
  assert.ok(first.every((row) => row.ruleVersion === STRATEGY_RULE_VERSION));
  assert.ok(first.every((row) => row.reportId === fixture.publishedReport.reportId));
  assert.ok(first.every((row) => row.confidence.level === "medium"));
  assert.ok(first.every((row) => row.confidence.reasons.length >= 3));
  assert.ok(first.every((row) => ["low", "medium", "high"].includes(row.difficulty)));
  assert.ok(first.every((row) => row.expectedEffect.minimum <= row.expectedEffect.maximum));
  assert.ok(first.every((row) => row.executionTiming.startDate <= row.executionTiming.dueDate));
  assert.ok(first.every((row) => row.checklist.length === 3));
  assert.ok(first.every((row) => row.kpiTemplate.metricKey && Number.isFinite(row.kpiTemplate.targetValue)));
  assert.ok(first.every((row) => row.lineage.sourceReportId === fixture.expected.reportLineage.reportId));
  assert.ok(first.every((row) => row.lineage.sourceReportVersion === fixture.expected.reportLineage.reportVersion));
  assert.ok(first.every((row) => row.lineage.sourceAlgorithmVersion === fixture.expected.reportLineage.reportAlgorithmVersion));
  assert.ok(first.every((row) => row.lineage.sourceReportPublishedAt === fixture.expected.reportLineage.reportPublishedAt));
  assert.ok(first.every((row) => row.lineage.ruleVersion === STRATEGY_RULE_VERSION));
  assert.ok(first.every((row) => row.lineage.evidenceKeys.length === row.evidence.length));
  assert.deepEqual(first.map((row) => row.title), [
    "비교군 정합 가격 유지",
    "OTA 노출 채널 보강",
    "판매율 보강 상품 구성",
    "지역 수요 연계 콘텐츠 정비",
    "리드타임 구간별 재고 점검"
  ]);
  assert.deepEqual(first.map((row) => row.strategyId), [
    "strategy_4021f6be4c4e259075094a2be032",
    "strategy_c8e3c4119c97546a71aff3fa4f04",
    "strategy_4efa43a7798a404e68a9b8d879cd",
    "strategy_34368db23ac0ec8296d93a71d570",
    "strategy_a64e1e11e7743aa669916ce005ef"
  ], "IDs are deterministic report/rule/domain hashes");
  assert.doesNotThrow(() => assertBusinessSafe(first));

  assert.deepEqual(normalizeChecklist(["첫 점검", { checklistId: "check_second", label: "둘째 점검", completed: true }]), [
    { checklistId: "check_1", label: "첫 점검", required: true, completed: false, completedAt: "" },
    { checklistId: "check_second", label: "둘째 점검", required: true, completed: true, completedAt: "" }
  ]);
  const missingKpi = normalizeKpi({ metricKey: "soldRate", label: "판매율", unit: "%", direction: "increase", targetValue: 65 });
  assert.equal(missingKpi.inputState, "missing");
  assert.equal(missingKpi.currentValue, null);
  assert.equal(missingKpi.achieved, false);
  const zeroKpi = normalizeKpi({ metricKey: "soldRate", label: "판매율", unit: "%", direction: "increase", targetValue: 65, currentValue: 0 });
  assert.equal(zeroKpi.inputState, "entered", "zero must remain distinct from a missing KPI input");
  assert.equal(zeroKpi.currentValue, 0);
  assert.equal(zeroKpi.achieved, false);
  assert.equal(achievedForKpi({ ...zeroKpi, currentValue: 65 }), true);
  assert.equal(achievedForKpi({ ...zeroKpi, direction: "decrease", currentValue: 60 }), true);
  assert.equal(achievedForKpi({ ...zeroKpi, direction: "maintain", currentValue: 65 }), true);

  assert.deepEqual(entitlementsForStrategy("unknown"), STRATEGY_PLAN_ENTITLEMENTS.free);
  assert.equal(entitlementsForStrategy("free").maxPlansPerMonth, 1);
  assert.equal(entitlementsForStrategy("basic").maxItemsPerPlan, 15);
  assert.equal(entitlementsForStrategy("pro").maxKpisPerItem, 8);
  assert.equal(nextMonth("2026-12"), "2027-01");

  console.log("Stage 230 deterministic rule/version, published-confidence gate, KPI input and entitlement contracts passed");
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
