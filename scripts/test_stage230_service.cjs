"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  STRATEGY_RULE_VERSION
} = require("./integration/contracts/strategy_execution.cjs");
const {
  createStrategyRepository
} = require("./integration/repositories/strategy_store.cjs");
const {
  createStrategyService
} = require("./integration/services/strategy_service.cjs");
const {
  ROOT,
  businessSafeStrategyAssert,
  createMockStage230Dependencies,
  strategySession,
  temporaryDirectory
} = require("./test_support/stage230_test_helpers.cjs");

const COMPANY_ID = "cmp_place_stage230_tenant";
const TENANT_ONE = "tenant_stage230_one";
const TENANT_TWO = "tenant_stage230_two";

function code(error) {
  return error?.code || "";
}

async function main() {
  const freshRoot = temporaryDirectory("stage230-service-fresh-");
  const legacyRoot = temporaryDirectory("stage230-service-legacy-");
  let tick = Date.parse("2026-07-29T00:00:00.000Z");
  let serial = 0;
  const env = {
    NODE_ENV: "test",
    V2_INTEGRATION_DATA_DIR: freshRoot,
    DATA_DIR: legacyRoot,
    CONFIG_DIR: path.join(legacyRoot, "config"),
    OUTPUTS_DIR: path.join(legacyRoot, "outputs")
  };
  const repositoryOptions = {
    env,
    projectRoot: ROOT,
    parentInsightsStoreId: "insights_store_stage229_service",
    clock: () => tick,
    idFactory: () => `stage230service${String(++serial).padStart(6, "0")}`,
    legacyPaths: [legacyRoot, path.join(legacyRoot, "config"), path.join(legacyRoot, "outputs")]
  };
  try {
    const repository = createStrategyRepository(repositoryOptions);
    const initialized = await repository.initialize();
    assert.equal(initialized.ruleVersion, STRATEGY_RULE_VERSION);
    assert.equal(initialized.parentInsightsStoreId, "insights_store_stage229_service");
    assert.deepEqual(initialized.counts, { strategies: 0, plans: 0, retrospectives: 0, candidates: 0, audit: 1 });

    const dependencies = createMockStage230Dependencies();
    const service = createStrategyService({
      repository,
      ...dependencies,
      capabilities: { strategy: true, execution: true, retrospective: true },
      clock: () => tick
    });
    const business = strategySession("business", TENANT_ONE, "business-one", "basic");
    const freeBusiness = strategySession("business", TENANT_ONE, "business-free-limit", "free");
    const otherBusiness = strategySession("business", TENANT_TWO, "business-two", "basic");
    const admin = strategySession("admin", "", "admin", "pro");

    assert.deepEqual(service.metadata(), {
      stage: 230,
      ruleVersion: STRATEGY_RULE_VERSION,
      deterministic: true,
      dataBoundary: "published-stage229-business-safe-only",
      domains: ["price", "channel", "product", "content", "leadtime"],
      capabilities: { strategy: true, execution: true, retrospective: true },
      automation: { learnedWeights: false, abWinner: false, calibration: false, autoApproval: false, recursiveReview: false },
      externalProviderCalls: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0
    });

    const initialWorkspace = await service.workspace(business, { view: "business-strategy", month: "2026-08" });
    assert.equal(initialWorkspace.state, "ready", "an eligible published report may expose the ready generation gate before cards exist");
    assert.equal(initialWorkspace.reportGate.eligible, true);
    assert.deepEqual(initialWorkspace.strategies, []);
    assert.equal(Object.hasOwn(initialWorkspace, "audit"), true);
    assert.equal(initialWorkspace.audit, undefined, "business workspace must not expose audit actors");

    const generationPayload = {
      companyId: COMPANY_ID,
      tenantCompanyId: TENANT_ONE,
      month: "2026-08",
      reportId: dependencies.publishedReport.reportId,
      clientRequestId: "stage230-generate-0001"
    };
    const generated = await service.generateStrategies(business, generationPayload);
    assert.equal(generated.idempotent, false);
    assert.equal(generated.strategies.length, 5);
    assert.deepEqual(generated.strategies.map((row) => row.domain), dependencies.fixture.expected.domains);
    for (const strategy of generated.strategies) {
      assert.equal(strategy.lineage.sourceReportId, dependencies.publishedReport.reportId);
      assert.equal(strategy.lineage.sourceReportVersion, 6);
      assert.equal(strategy.lineage.sourceReportPublishedAt, "2026-07-29T00:00:00.000Z");
      assert.equal(strategy.lineage.sourceAlgorithmVersion, "v2-stage229-location-forecast-v1");
      assert.equal(strategy.lineage.ruleVersion, STRATEGY_RULE_VERSION);
      assert.ok(strategy.lineage.generatedBy);
      assert.ok(strategy.lineage.generatedAt);
      assert.ok(strategy.lineage.evidenceKeys.length >= 1);
    }
    assert.equal((await service.generateStrategies(business, generationPayload)).idempotent, true);
    businessSafeStrategyAssert(generated, { allowedCompanyIds: [COMPANY_ID], forbiddenCompanyIds: ["cmp_place_stage230_other"] });

    for (const blocked of dependencies.fixture.blockedReports) {
      const blockedDependencies = createMockStage230Dependencies({ reportPatch: blocked.patch });
      const blockedService = createStrategyService({
        repository,
        ...blockedDependencies,
        capabilities: { strategy: true, execution: true, retrospective: true },
        clock: () => tick
      });
      await assert.rejects(
        blockedService.generateStrategies(business, { ...generationPayload, clientRequestId: `stage230-blocked-${blocked.id}` }),
        (error) => code(error) === blocked.expectedCode && error.statusCode === 409,
        `${blocked.id}: strategy generation must remain empty`
      );
    }
    assert.equal((await repository.listStrategies({ companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE })).length, 5);

    const strategyByDomain = new Map(generated.strategies.map((row) => [row.domain, row]));
    const planPayload = {
      companyId: COMPANY_ID,
      tenantCompanyId: TENANT_ONE,
      month: "2026-08",
      title: "2026년 8월 실행계획",
      owner: "운영 담당자",
      dueDate: "2026-08-31",
      strategyIds: generated.strategies.map((row) => row.strategyId),
      clientRequestId: "stage230-plan-0001"
    };
    const createdPlan = await service.createPlan(business, planPayload);
    assert.equal(createdPlan.idempotent, false);
    assert.equal(createdPlan.plan.status, "draft");
    assert.equal(createdPlan.plan.lineage.ruleVersion, STRATEGY_RULE_VERSION);
    assert.equal((await service.createPlan(business, planPayload)).idempotent, true);
    assert.equal(
      (await service.createPlan(freeBusiness, planPayload)).idempotent,
      true,
      "same plan request must replay after the free monthly plan limit is full"
    );
    await assert.rejects(
      service.createPlan(business, { ...planPayload, title: "같은 key의 다른 계획", dueDate: "2026-08-30" }),
      (error) => code(error) === "STRATEGY_IDEMPOTENCY_CONFLICT" && error.statusCode === 409
    );

    const planId = createdPlan.plan.planId;
    const itemInputs = [
      { key: "overdue", strategy: strategyByDomain.get("price"), owner: "가격 담당자", dueDate: "2026-07-28", repeatNextMonth: true },
      { key: "price-repeat", strategy: strategyByDomain.get("price"), owner: "가격 담당자", dueDate: "2026-08-03", repeatNextMonth: true },
      { key: "channel-repeat", strategy: strategyByDomain.get("channel"), owner: "채널 담당자", dueDate: "2026-08-04", repeatNextMonth: true },
      { key: "this-week", strategy: strategyByDomain.get("product"), owner: "상품 담당자", dueDate: "2026-08-02", repeatNextMonth: false }
    ];
    const items = [];
    for (const input of itemInputs) {
      const result = await service.addPlanItem(business, planId, {
        tenantCompanyId: TENANT_ONE,
        clientRequestId: `stage230-item-${input.key}`,
        strategyId: input.strategy.strategyId,
        title: `${input.strategy.title} ${input.key}`,
        owner: input.owner,
        dueDate: input.dueDate,
        notes: input.key === "overdue" ? "채널 검수 대기" : "공개 리포트 근거",
        repeatNextMonth: input.repeatNextMonth
      });
      assert.equal(result.idempotent, false);
      items.push(result.item);
    }
    assert.equal((await service.addPlanItem(business, planId, {
      tenantCompanyId: TENANT_ONE,
      clientRequestId: "stage230-item-overdue",
      strategyId: itemInputs[0].strategy.strategyId,
      title: `${itemInputs[0].strategy.title} overdue`,
      owner: itemInputs[0].owner,
      dueDate: itemInputs[0].dueDate,
      notes: "채널 검수 대기",
      repeatNextMonth: true
    })).idempotent, true);

    const missingKpi = await service.addKpi(business, planId, items[0].itemId, {
      tenantCompanyId: TENANT_ONE,
      clientRequestId: "stage230-kpi-missing",
      metricKey: "soldRate",
      label: "판매율",
      unit: "%",
      direction: "increase",
      targetValue: 65
    });
    assert.equal(missingKpi.kpi.inputState, "missing");
    const enteredKpi = await service.addKpi(business, planId, items[1].itemId, {
      tenantCompanyId: TENANT_ONE,
      clientRequestId: "stage230-kpi-entered",
      metricKey: "soldRate",
      label: "판매율",
      unit: "%",
      direction: "increase",
      targetValue: 65,
      currentValue: 61
    });
    assert.equal(enteredKpi.kpi.inputState, "entered");
    assert.equal(enteredKpi.kpi.achieved, false);
    const updatedKpi = await service.updateKpi(business, planId, items[1].itemId, enteredKpi.kpi.kpiId, {
      tenantCompanyId: TENANT_ONE,
      expectedVersion: enteredKpi.kpi.version,
      currentValue: 70
    });
    assert.equal(updatedKpi.kpi.achieved, true);
    assert.equal(updatedKpi.kpi.version, 2);
    await assert.rejects(
      service.updateKpi(business, planId, items[1].itemId, enteredKpi.kpi.kpiId, {
        tenantCompanyId: TENANT_ONE,
        expectedVersion: 1,
        currentValue: 71
      }),
      (error) => code(error) === "STRATEGY_VERSION_CONFLICT" && error.statusCode === 409
    );

    const currentPlanBeforeStates = await repository.getPlan(planId);
    await service.updatePlanItem(business, planId, items[0].itemId, {
      tenantCompanyId: TENANT_ONE,
      expectedVersion: currentPlanBeforeStates.version,
      status: "blocked",
      checklistUpdates: [{ checklistId: items[0].checklist[0].checklistId, completed: true }]
    });
    let currentPlan = await repository.getPlan(planId);
    await service.updatePlanItem(business, planId, items[1].itemId, {
      tenantCompanyId: TENANT_ONE,
      expectedVersion: currentPlan.version,
      status: "done"
    });
    currentPlan = await repository.getPlan(planId);
    await service.updatePlanItem(business, planId, items[2].itemId, {
      tenantCompanyId: TENANT_ONE,
      expectedVersion: currentPlan.version,
      status: "done"
    });
    currentPlan = await repository.getPlan(planId);
    const active = await service.updatePlan(business, planId, {
      tenantCompanyId: TENANT_ONE,
      expectedVersion: currentPlan.version,
      status: "active",
      notes: "월간 실행 중"
    });
    assert.equal(active.plan.status, "active");

    const allBoard = await service.board(business, { companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE, month: "2026-08" });
    assert.deepEqual(allBoard.board.summary, {
      total: 4,
      planned: 1,
      inProgress: 0,
      blocked: 1,
      done: 2,
      overdue: 1,
      thisWeek: 1
    });
    assert.deepEqual((await service.board(business, { companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE, due: "overdue" })).board.items.map((row) => row.itemId), [items[0].itemId]);
    assert.deepEqual((await service.board(business, { companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE, due: "this-week" })).board.items.map((row) => row.itemId), [items[3].itemId]);
    assert.equal((await service.board(business, { companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE, status: "done" })).board.items.length, 2);
    assert.equal((await service.board(business, { companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE, owner: "가격" })).board.items.length, 2);

    const retrospectivePayload = {
      planId,
      tenantCompanyId: TENANT_ONE,
      clientRequestId: "stage230-retrospective-0001",
      summary: "가격 항목은 일부 이월하고 완료 항목의 KPI를 확인했습니다.",
      incompleteReasons: [
        { itemId: items[0].itemId, reason: "채널 검수 일정 지연" },
        { itemId: items[3].itemId, reason: "상품 상세 확인 중" }
      ]
    };
    const retrospective = await service.createRetrospective(business, retrospectivePayload);
    assert.equal(retrospective.idempotent, false);
    assert.deepEqual(retrospective.retrospective.execution, { done: 2, total: 4, rate: 50 });
    assert.deepEqual(retrospective.retrospective.kpis, { achieved: 1, entered: 1, total: 6, achievementRate: 100, missing: 5 });
    assert.equal(retrospective.retrospective.incompleteReasons.length, 2);
    assert.equal(retrospective.retrospective.lineage.sourceReports[0].reportId, dependencies.publishedReport.reportId);
    assert.equal(retrospective.retrospective.lineage.sourceReports[0].version, 6);
    assert.equal(retrospective.retrospective.lineage.sourceReports[0].publishedAt, dependencies.publishedReport.publishedAt);
    assert.equal(retrospective.retrospective.lineage.sourceReports[0].algorithmVersion, dependencies.publishedReport.algorithmVersion);
    assert.equal((await service.createRetrospective(business, retrospectivePayload)).idempotent, true);

    const candidatePayload = { tenantCompanyId: TENANT_ONE, clientRequestId: "stage230-candidates-0001", targetMonth: "2026-09" };
    const candidates = await service.generateNextMonthCandidates(business, retrospective.retrospective.retrospectiveId, candidatePayload);
    assert.equal(candidates.idempotent, false, "first candidate generation must report a write");
    assert.equal(candidates.candidates.length, 5, "one candidate per source strategy after dedupe");
    assert.equal(new Set(candidates.candidates.map((row) => row.strategyId)).size, 5, "same strategy with multiple plan items must dedupe");
    const byStrategy = new Map(candidates.candidates.map((row) => [row.strategyId, row]));
    assert.equal(byStrategy.get(strategyByDomain.get("price").strategyId).type, "carryover", "carryover outranks repeat for the same strategy");
    assert.equal(byStrategy.get(strategyByDomain.get("channel").strategyId).type, "repeat");
    assert.equal(byStrategy.get(strategyByDomain.get("product").strategyId).type, "carryover");
    assert.deepEqual(candidates.candidates.filter((row) => row.type === "new").map((row) => row.strategyId).sort(), [
      strategyByDomain.get("content").strategyId,
      strategyByDomain.get("leadtime").strategyId
    ].sort());
    assert.ok(candidates.candidates.every((row) => row.lineage.sourceReportVersion === 6));
    assert.ok(candidates.candidates.every((row) => row.lineage.sourceReportPublishedAt === dependencies.publishedReport.publishedAt));
    const replayCandidates = await service.generateNextMonthCandidates(business, retrospective.retrospective.retrospectiveId, candidatePayload);
    assert.equal(replayCandidates.idempotent, true);
    assert.deepEqual(replayCandidates.candidates.map((row) => row.candidateId), candidates.candidates.map((row) => row.candidateId));
    assert.equal((await repository.listCandidates({ tenantCompanyId: TENANT_ONE, targetMonth: "2026-09" })).length, 5);

    const candidatePlan = await service.createPlan(business, {
      ...planPayload,
      month: "2026-09",
      dueDate: "2026-09-28",
      strategyIds: [],
      candidateIds: [candidates.candidates[0].candidateId],
      title: "후보에서 만든 다음달 계획",
      clientRequestId: "stage230-candidate-plan-0001"
    });
    assert.deepEqual(candidatePlan.plan.candidateIds, [candidates.candidates[0].candidateId]);
    assert.deepEqual(candidatePlan.plan.lineage.sourceRetrospectiveIds, [retrospective.retrospective.retrospectiveId]);
    assert.equal(candidatePlan.plan.lineage.appliedBy, "b2b");
    assert.ok(candidatePlan.plan.lineage.appliedAt);
    const limitItems = [];
    for (let index = 0; index < 5; index += 1) {
      limitItems.push((await service.addPlanItem(freeBusiness, candidatePlan.plan.planId, {
        clientRequestId: `stage230-free-item-${index + 1}`,
        strategyId: candidatePlan.plan.strategyIds[0],
        title: `무료 한도 항목 ${index + 1}`,
        dueDate: `2026-09-${String(index + 1).padStart(2, "0")}`
      })).item);
    }
    assert.equal((await service.addPlanItem(freeBusiness, candidatePlan.plan.planId, {
      clientRequestId: "stage230-free-item-5",
      strategyId: candidatePlan.plan.strategyIds[0],
      title: "무료 한도 항목 5",
      dueDate: "2026-09-05"
    })).idempotent, true, "same item request must replay after the free item limit is full");
    await assert.rejects(
      service.addPlanItem(freeBusiness, candidatePlan.plan.planId, {
        clientRequestId: "stage230-free-item-6",
        strategyId: candidatePlan.plan.strategyIds[0],
        title: "무료 한도 초과 항목",
        dueDate: "2026-09-06"
      }),
      (error) => code(error) === "STRATEGY_ENTITLEMENT_LIMIT" && error.statusCode === 403
    );
    const limitKpiPayload = {
      clientRequestId: "stage230-free-kpi-2",
      metricKey: "soldRate",
      label: "무료 한도 KPI",
      unit: "%",
      direction: "increase",
      targetValue: 65
    };
    assert.equal((await service.addKpi(
      freeBusiness,
      candidatePlan.plan.planId,
      limitItems[4].itemId,
      limitKpiPayload
    )).idempotent, false);
    assert.equal((await service.addKpi(
      freeBusiness,
      candidatePlan.plan.planId,
      limitItems[4].itemId,
      limitKpiPayload
    )).idempotent, true, "same KPI request must replay after the free KPI limit is full");
    await assert.rejects(
      service.addKpi(freeBusiness, candidatePlan.plan.planId, limitItems[4].itemId, {
        ...limitKpiPayload,
        clientRequestId: "stage230-free-kpi-3",
        metricKey: "averagePrice",
        label: "무료 한도 초과 KPI"
      }),
      (error) => code(error) === "STRATEGY_ENTITLEMENT_LIMIT" && error.statusCode === 403
    );
    await assert.rejects(
      service.createPlan(business, {
        ...planPayload,
        month: "2026-09",
        dueDate: "2026-09-28",
        strategyIds: [],
        candidateIds: [candidates.candidates[0].candidateId],
        title: "같은 후보 재사용 차단",
        clientRequestId: "stage230-candidate-plan-reuse-0001"
      }),
      (error) => code(error) === "STRATEGY_CANDIDATE_ALREADY_PLANNED" && error.statusCode === 409
    );
    const currentCandidatePlan = await repository.getPlan(candidatePlan.plan.planId);
    const cancelled = await service.updatePlan(business, candidatePlan.plan.planId, {
      tenantCompanyId: TENANT_ONE,
      expectedVersion: currentCandidatePlan.version,
      status: "cancelled",
      notes: "soft delete semantics"
    });
    assert.equal(cancelled.plan.status, "cancelled");
    assert.equal((await service.listPlans(business, { companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE, status: "cancelled" })).plans.length, 1, "soft-cancelled plan remains queryable");
    await assert.rejects(
      service.addPlanItem(business, candidatePlan.plan.planId, {
        tenantCompanyId: TENANT_ONE,
        clientRequestId: "stage230-item-after-cancel",
        strategyId: generated.strategies[0].strategyId,
        title: "취소 계획 추가 금지"
      }),
      (error) => code(error) === "STRATEGY_PLAN_CLOSED" && error.statusCode === 409
    );
    await assert.rejects(
      service.createPlan(freeBusiness, { ...planPayload, title: "entitlement 초과", clientRequestId: "stage230-plan-limit-0001" }),
      (error) => code(error) === "STRATEGY_ENTITLEMENT_LIMIT" && error.statusCode === 403
    );

    await assert.rejects(
      service.listStrategies(otherBusiness, { companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE }),
      (error) => code(error) === "STRATEGY_TENANT_FORBIDDEN" && error.statusCode === 403
    );
    await assert.rejects(
      service.updatePlan(otherBusiness, planId, { status: "cancelled" }),
      (error) => code(error) === "STRATEGY_TENANT_FORBIDDEN" && error.statusCode === 403
    );

    const businessWorkspace = await service.workspace(business, { view: "business-retrospective", month: "2026-08", targetMonth: "2026-09" });
    assert.equal(businessWorkspace.state, "ready");
    assert.equal(businessWorkspace.strategies.length, 5);
    assert.equal(businessWorkspace.plans.length, 1);
    assert.equal(businessWorkspace.retrospectives.length, 1);
    assert.equal(businessWorkspace.candidates.length, 5);
    businessSafeStrategyAssert(businessWorkspace, { allowedCompanyIds: [COMPANY_ID], forbiddenCompanyIds: ["cmp_place_stage230_other"] });
    const adminWorkspace = await service.workspace(admin, {
      view: "admin-retrospective",
      companyId: COMPANY_ID,
      tenantCompanyId: TENANT_ONE,
      month: "2026-08",
      targetMonth: "2026-09"
    });
    assert.ok(adminWorkspace.audit.count >= 1);
    assert.ok(adminWorkspace.audit.latest.every((row) => row.auditId && row.event && row.at && row.actorRole));

    const audit = await repository.listAudit({ companyId: COMPANY_ID, limit: 1000 });
    const completeAudit = await repository.listAudit({ limit: 1000 });
    assert.equal(completeAudit.length, audit.length + 1, "the unscoped bootstrap audit is preserved separately from company activity");
    for (const event of [
      "strategy.generated",
      "strategy.plan.created",
      "strategy.plan.updated",
      "strategy.plan-item.created",
      "strategy.plan-item.updated",
      "strategy.kpi.created",
      "strategy.kpi.updated",
      "strategy.retrospective.created",
      "strategy.candidates.generated"
    ]) assert.ok(audit.some((row) => row.event === event), `missing audit ${event}`);
    assert.ok(audit.filter((row) => /updated$/.test(row.event)).every((row) => row.details.before && row.details.after), "updates need before/after audit");
    assert.ok(audit.some((row) => row.event === "strategy.plan.updated" && row.details.after?.status === "cancelled"), "soft delete must be audited");

    const diagnostics = await repository.diagnostics();
    assert.equal(diagnostics.externalProviderCalls, 0);
    assert.equal(diagnostics.credentialReads, 0);
    assert.equal(diagnostics.legacyRuntimeReads, 0);
    assert.equal(diagnostics.legacyRuntimeCopies, 0);
    assert.equal(diagnostics.productionMutations, 0);
    assert.deepEqual(diagnostics.counts, { strategies: 5, plans: 2, retrospectives: 1, candidates: 5, audit: completeAudit.length });
    assert.equal(fs.existsSync(path.join(legacyRoot, "outputs")), false);
    assert.equal(fs.existsSync(path.join(legacyRoot, "config")), false);

    const reopened = createStrategyRepository(repositoryOptions);
    const reopenedSummary = await reopened.initialize();
    assert.deepEqual(reopenedSummary.counts, diagnostics.counts, "durable Stage 230 state survives repository restart");
    assert.equal((await reopened.listStrategies({ companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE })).length, 5);
    assert.equal((await reopened.listCandidates({ companyId: COMPANY_ID, tenantCompanyId: TENANT_ONE, targetMonth: "2026-09" })).length, 5);

    console.log("Stage 230 service report gate, deterministic strategies, plan CRUD, board, KPI, audit, retrospective, candidate dedupe, tenant and durability checks passed");
  } finally {
    fs.rmSync(freshRoot, { recursive: true, force: true });
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
