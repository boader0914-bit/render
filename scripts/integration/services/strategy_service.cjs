"use strict";

const {
  BOARD_DUE_FILTERS,
  CANDIDATE_TYPES,
  ITEM_STATUSES,
  PLAN_STATUSES,
  STRATEGY_DOMAINS,
  STRATEGY_RULE_VERSION,
  STRATEGY_STAGE,
  assertBusinessSafe,
  cleanId,
  cleanText,
  clone,
  deriveStrategyCards,
  entitlementsForStrategy,
  nextMonth,
  reportGate,
  requiredDate,
  requiredMonth,
  round,
  stableHash,
  strategyError
} = require("../contracts/strategy_execution.cjs");

function roleFor(session) {
  return session?.account?.role || session?.role || "";
}

function requireSession(session) {
  if (!session?.accountId && !session?.account?.accountId && !session?.role && !session?.account?.role) {
    throw strategyError("로그인이 필요합니다.", "STRATEGY_AUTH_REQUIRED", 401);
  }
  return session;
}

function actorFor(session) {
  return {
    accountId: cleanText(session?.accountId || session?.account?.accountId || "system", 160),
    role: cleanText(roleFor(session), 48),
    label: cleanText(
      session?.account?.displayName
      || session?.profile?.displayName
      || session?.account?.username
      || session?.username
      || roleFor(session)
      || "system",
      120
    ),
    type: "account"
  };
}

function createStrategyService(options = {}) {
  const repository = options.repository;
  const insightsService = options.insightsService;
  const authService = options.authService;
  const freshService = options.freshService;
  const clock = options.clock || Date.now;
  if (!repository || !insightsService || !authService || !freshService) {
    throw new Error("Stage 230 strategy service dependencies are required");
  }
  const requested = options.capabilities || {};
  const capabilities = Object.freeze({
    strategy: Boolean(requested.strategy),
    execution: Boolean(requested.execution && requested.strategy),
    retrospective: Boolean(requested.retrospective && requested.execution && requested.strategy)
  });

  function nowIso() {
    return new Date(Number(clock())).toISOString();
  }

  function requireCapability(name) {
    if (!capabilities[name]) {
      throw strategyError(`Stage 230 ${name} capability is disabled`, "STRATEGY_FEATURE_DISABLED", 404);
    }
  }

  function metadata() {
    return {
      stage: STRATEGY_STAGE,
      ruleVersion: STRATEGY_RULE_VERSION,
      deterministic: true,
      dataBoundary: "published-stage229-business-safe-only",
      domains: [...STRATEGY_DOMAINS],
      capabilities: { ...capabilities },
      automation: {
        learnedWeights: false,
        abWinner: false,
        calibration: false,
        autoApproval: false,
        recursiveReview: false
      },
      externalProviderCalls: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0
    };
  }

  function sessionTenantId(session) {
    return cleanText(
      session?.memberships?.[0]?.companyId
      || session?.companyId
      || session?.companyIds?.[0],
      160
    );
  }

  async function tenantAccess(session, requestedTenantCompanyId = "", context = {}) {
    requireSession(session);
    const admin = roleFor(session) === "admin";
    const active = sessionTenantId(session);
    const requestedTenant = cleanText(requestedTenantCompanyId || (admin ? "" : active), 160);
    if (!requestedTenant) {
      throw strategyError("활성 업체 소속을 지정해야 합니다.", "STRATEGY_TENANT_REQUIRED", 422);
    }
    if (!admin && requestedTenant !== active) {
      throw strategyError("다른 업체의 전략·실행 데이터에는 접근할 수 없습니다.", "STRATEGY_TENANT_FORBIDDEN", 403);
    }
    const access = await authService.assertCompanyAccess(session, requestedTenant, context);
    const authPlan = cleanText(access?.entitlements?.plan || access?.membership?.plan || session?.plan || "free", 24).toLowerCase();
    return {
      tenantCompanyId: cleanText(access?.company?.companyId || requestedTenant, 160),
      plan: entitlementsForStrategy(admin ? "pro" : authPlan),
      auth: access
    };
  }

  async function subjectAccess(session, companyId, requestedTenantCompanyId = "", context = {}) {
    const access = await tenantAccess(session, requestedTenantCompanyId, context);
    let company = cleanText(companyId, 160);
    if (!company) {
      if (roleFor(session) === "admin") {
        throw strategyError("관리자 요청은 대상 신규 수집 업체를 지정해야 합니다.", "STRATEGY_COMPANY_REQUIRED", 422);
      }
      const companies = await freshService.listCompanies(session, access.tenantCompanyId, context);
      if (companies.length > 1) {
        throw strategyError("소유 숙소가 여러 개이면 대상 신규 수집 업체를 명시해야 합니다.", "STRATEGY_COMPANY_REQUIRED", 422);
      }
      company = cleanText(companies[0]?.companyId, 160);
    }
    if (!company) throw strategyError("신규 수집 업체를 찾을 수 없습니다.", "STRATEGY_COMPANY_NOT_FOUND", 404);
    company = cleanId(company, "companyId");
    const subject = await freshService.getCompany(session, company, access.tenantCompanyId, context);
    if (!subject || subject.companyId !== company) {
      throw strategyError("신규 수집 업체를 찾을 수 없습니다.", "STRATEGY_COMPANY_NOT_FOUND", 404);
    }
    return { ...access, companyId: company, company: subject };
  }

  async function subjectFromStored(session, row, requestedTenantCompanyId = "", context = {}) {
    if (!row) throw strategyError("Stage 230 항목을 찾을 수 없습니다.", "STRATEGY_NOT_FOUND", 404);
    const requested = cleanText(requestedTenantCompanyId || row.tenantCompanyId, 160);
    const access = await subjectAccess(session, row.companyId, requested, context);
    if (access.tenantCompanyId !== row.tenantCompanyId) {
      throw strategyError("다른 업체의 전략·실행 데이터에는 접근할 수 없습니다.", "STRATEGY_TENANT_FORBIDDEN", 403);
    }
    await assertPublishedLineage(session, access, row, context);
    return access;
  }

  function publicStrategy(row) {
    if (!row) return null;
    const projected = clone(row);
    delete projected.schemaVersion;
    delete projected.tenantCompanyId;
    assertBusinessSafe(projected);
    return projected;
  }

  function publicPlan(row) {
    if (!row) return null;
    const projected = clone(row);
    delete projected.schemaVersion;
    delete projected.tenantCompanyId;
    assertBusinessSafe(projected);
    return projected;
  }

  function publicRetrospective(row) {
    if (!row) return null;
    const projected = clone(row);
    delete projected.schemaVersion;
    delete projected.tenantCompanyId;
    assertBusinessSafe(projected);
    return projected;
  }

  function publicCandidate(row) {
    if (!row) return null;
    const projected = clone(row);
    delete projected.schemaVersion;
    delete projected.tenantCompanyId;
    assertBusinessSafe(projected);
    return projected;
  }

  async function reportEnvelope(session, access, query = {}, context = {}) {
    const month = query.month ? requiredMonth(query.month) : "";
    return insightsService.listMonthlyReports(session, {
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      month
    }, context);
  }

  async function selectedReport(session, access, query = {}, context = {}) {
    const envelope = await reportEnvelope(session, access, query, context);
    const reportId = cleanText(query.reportId, 160);
    const reports = Array.isArray(envelope?.reports) ? envelope.reports : [];
    const report = reportId
      ? reports.find((row) => row.reportId === reportId) || null
      : reports.find((row) => !query.month || row.month === query.month) || reports[0] || null;
    return { envelope, report, gate: reportGate(report) };
  }

  function normalizeReportFingerprint(value = {}, source = {}) {
    return {
      reportId: cleanText(value.reportId || value.sourceReportId, 160),
      version: Number(value.version ?? value.sourceReportVersion),
      publishedAt: cleanText(value.publishedAt || value.sourceReportPublishedAt, 64),
      algorithmVersion: cleanText(value.algorithmVersion || value.sourceAlgorithmVersion, 120),
      source
    };
  }

  function lineageReportFingerprints(row = {}) {
    const fingerprints = [];
    const seen = new Set();
    function add(value, source) {
      const fingerprint = normalizeReportFingerprint(value, source);
      if (fingerprint.reportId) fingerprints.push(fingerprint);
    }
    function visit(value, key = "", parent = null) {
      if (value === null || value === undefined) return;
      if (typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        if (key === "sourceReports") value.forEach((entry) => add(entry, { key }));
        value.forEach((entry) => visit(entry, "", value));
        return;
      }
      if (value.sourceReportId) add(value, { key: "sourceReportId" });
      Object.entries(value).forEach(([childKey, child]) => visit(child, childKey, value));
    }
    if (row.reportId && row.lineage) {
      add({ reportId: row.reportId, ...row.lineage }, { key: "reportId" });
    }
    visit(row);
    return fingerprints.filter((fingerprint, index, values) => (
      values.findIndex((candidate) => (
        candidate.reportId === fingerprint.reportId
        && candidate.version === fingerprint.version
        && candidate.publishedAt === fingerprint.publishedAt
        && candidate.algorithmVersion === fingerprint.algorithmVersion
      )) === index
    ));
  }

  async function publishedLineageReports(session, access, context = {}) {
    const envelope = await reportEnvelope(session, access, {}, context);
    return new Map((Array.isArray(envelope?.reports) ? envelope.reports : [])
      .filter((report) => reportGate(report).eligible)
      .map((report) => {
        const fingerprint = normalizeReportFingerprint(report, { key: "published-report" });
        return [fingerprint.reportId, fingerprint];
      })
      .filter(([reportId]) => Boolean(reportId)));
  }

  function hasPublishedLineage(row, publishedReports) {
    const fingerprints = lineageReportFingerprints(row);
    return fingerprints.length > 0 && fingerprints.every((fingerprint) => {
      const published = publishedReports.get(fingerprint.reportId);
      return Boolean(
        published
        && Number.isInteger(fingerprint.version)
        && fingerprint.version >= 1
        && fingerprint.version === published.version
        && fingerprint.publishedAt
        && fingerprint.publishedAt === published.publishedAt
        && fingerprint.algorithmVersion
        && fingerprint.algorithmVersion === published.algorithmVersion
      );
    });
  }

  async function assertPublishedLineage(session, access, row, context = {}) {
    if (!hasPublishedLineage(row, await publishedLineageReports(session, access, context))) {
      throw strategyError("공개된 live 월간 리포트 lineage가 아닌 항목은 사용할 수 없습니다.", "STRATEGY_REPORT_NOT_PUBLISHED", 409);
    }
  }

  async function visiblePublishedRows(session, access, rows, context = {}) {
    const publishedReports = await publishedLineageReports(session, access, context);
    return (Array.isArray(rows) ? rows : []).filter((row) => hasPublishedLineage(row, publishedReports));
  }

  function assertReportEligible(value) {
    if (value.gate.state === "not-published-report") {
      throw strategyError(value.gate.reason, "STRATEGY_REPORT_NOT_PUBLISHED", 409);
    }
    if (!value.gate.eligible) {
      throw strategyError(value.gate.reason, "STRATEGY_REPORT_CONFIDENCE_REQUIRED", 409);
    }
    return value.report;
  }

  function assertLimit(actual, maximum, label) {
    if (Number(actual) >= Number(maximum)) {
      throw strategyError(`${label} entitlement limit exceeded (${actual}/${maximum})`, "STRATEGY_ENTITLEMENT_LIMIT", 403);
    }
  }

  async function generateStrategies(session, payload = {}, context = {}) {
    requireCapability("strategy");
    const access = await subjectAccess(session, payload.companyId, payload.tenantCompanyId, context);
    const month = requiredMonth(payload.month);
    const reportResult = await selectedReport(session, access, { month, reportId: payload.reportId }, context);
    const report = assertReportEligible(reportResult);
    const existing = await repository.listStrategies({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      month
    });
    if (!existing.length) assertLimit(existing.length, access.plan.maxStrategyCardsPerMonth, "strategy card");
    const cards = deriveStrategyCards(report, {
      companyId: access.companyId,
      generatedAt: nowIso(),
      generatedBy: actorFor(session).label
    });
    if (cards.length > access.plan.maxStrategyCardsPerMonth) {
      throw strategyError("Deterministic strategy set exceeds the plan entitlement", "STRATEGY_ENTITLEMENT_LIMIT", 403);
    }
    const result = await repository.createStrategySet({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      clientRequestId: payload.clientRequestId,
      reportId: report.reportId,
      month,
      strategies: cards
    }, actorFor(session));
    return {
      ok: true,
      metadata: metadata(),
      idempotent: result.idempotent,
      reportGate: reportResult.gate,
      strategies: result.strategies.map(publicStrategy),
      limits: access.plan
    };
  }

  async function listStrategies(session, query = {}, context = {}) {
    requireCapability("strategy");
    const access = await subjectAccess(session, query.companyId, query.tenantCompanyId, context);
    const month = query.month ? requiredMonth(query.month) : "";
    const rows = await repository.listStrategies({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      month,
      domain: cleanText(query.domain, 32)
    });
    const visible = await visiblePublishedRows(session, access, rows, context);
    return { ok: true, metadata: metadata(), strategies: visible.map(publicStrategy), limits: access.plan };
  }

  async function createPlan(session, payload = {}, context = {}) {
    requireCapability("execution");
    const access = await subjectAccess(session, payload.companyId, payload.tenantCompanyId, context);
    const month = requiredMonth(payload.month);
    const strategyIds = [...new Set((payload.strategyIds || []).map((id) => cleanId(id, "strategyId")))];
    const candidateIds = [...new Set((payload.candidateIds || []).map((id) => cleanId(id, "candidateId")))];
    const selectedStrategies = await repository.listStrategies({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      month
    });
    const visibleStrategies = await visiblePublishedRows(session, access, selectedStrategies, context);
    const visibleStrategyIds = new Set(visibleStrategies.map((row) => row.strategyId));
    if (strategyIds.some((id) => !visibleStrategyIds.has(id))) {
      throw strategyError("공개된 live 리포트에서 생성된 전략만 계획에 적용할 수 있습니다.", "STRATEGY_REPORT_NOT_PUBLISHED", 409);
    }
    if (candidateIds.length) {
      const selectedCandidates = await repository.listCandidates({
        companyId: access.companyId,
        tenantCompanyId: access.tenantCompanyId,
        targetMonth: month
      });
      const visibleCandidates = await visiblePublishedRows(session, access, selectedCandidates, context);
      const visibleCandidateIds = new Set(visibleCandidates.map((row) => row.candidateId));
      if (candidateIds.some((id) => !visibleCandidateIds.has(id))) {
        throw strategyError("공개된 live 리포트 lineage의 다음달 후보만 계획에 적용할 수 있습니다.", "STRATEGY_REPORT_NOT_PUBLISHED", 409);
      }
    }
    const result = await repository.createPlan({
      ...payload,
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      month,
      strategyIds,
      candidateIds,
      maximumPlansPerMonth: access.plan.maxPlansPerMonth,
      maximumItemsPerPlan: access.plan.maxItemsPerPlan
    }, actorFor(session));
    return { ok: true, metadata: metadata(), idempotent: result.idempotent, plan: publicPlan(result.plan), limits: access.plan };
  }

  async function listPlans(session, query = {}, context = {}) {
    requireCapability("execution");
    const access = await subjectAccess(session, query.companyId, query.tenantCompanyId, context);
    const rows = await repository.listPlans({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      month: query.month ? requiredMonth(query.month) : "",
      status: cleanText(query.status, 32)
    });
    const visible = await visiblePublishedRows(session, access, rows, context);
    return { ok: true, metadata: metadata(), plans: visible.map(publicPlan), limits: access.plan };
  }

  async function updatePlan(session, planId, payload = {}, context = {}) {
    requireCapability("execution");
    const current = await repository.getPlan(planId);
    await subjectFromStored(session, current, payload.tenantCompanyId, context);
    const result = await repository.updatePlan(planId, payload, actorFor(session));
    return { ok: true, metadata: metadata(), idempotent: false, plan: publicPlan(result.plan) };
  }

  async function addPlanItem(session, planId, payload = {}, context = {}) {
    requireCapability("execution");
    const current = await repository.getPlan(planId);
    const access = await subjectFromStored(session, current, payload.tenantCompanyId, context);
    const result = await repository.addPlanItem(planId, {
      ...payload,
      maximumItemsPerPlan: access.plan.maxItemsPerPlan,
      maximumKpisPerItem: access.plan.maxKpisPerItem
    }, actorFor(session));
    return { ok: true, metadata: metadata(), idempotent: result.idempotent, plan: publicPlan(result.plan), item: clone(result.item), limits: access.plan };
  }

  async function updatePlanItem(session, planId, itemId, payload = {}, context = {}) {
    requireCapability("execution");
    const current = await repository.getPlan(planId);
    await subjectFromStored(session, current, payload.tenantCompanyId, context);
    const result = await repository.updatePlanItem(planId, itemId, payload, actorFor(session));
    return { ok: true, metadata: metadata(), idempotent: false, plan: publicPlan(result.plan), item: clone(result.item) };
  }

  async function addKpi(session, planId, itemId, payload = {}, context = {}) {
    requireCapability("execution");
    const current = await repository.getPlan(planId);
    const access = await subjectFromStored(session, current, payload.tenantCompanyId, context);
    const item = current.items.find((row) => row.itemId === itemId);
    if (!item) throw strategyError("실행 항목을 찾을 수 없습니다.", "STRATEGY_ITEM_NOT_FOUND", 404);
    const result = await repository.addKpi(planId, itemId, {
      ...payload,
      maximumKpisPerItem: access.plan.maxKpisPerItem
    }, actorFor(session));
    return { ok: true, metadata: metadata(), idempotent: result.idempotent, plan: publicPlan(result.plan), item: clone(result.item), kpi: clone(result.kpi), limits: access.plan };
  }

  async function updateKpi(session, planId, itemId, kpiId, payload = {}, context = {}) {
    requireCapability("execution");
    const current = await repository.getPlan(planId);
    await subjectFromStored(session, current, payload.tenantCompanyId, context);
    const result = await repository.updateKpi(planId, itemId, kpiId, payload, actorFor(session));
    return { ok: true, metadata: metadata(), idempotent: false, plan: publicPlan(result.plan), item: clone(result.item), kpi: clone(result.kpi) };
  }

  function boardRow(plan, item, asOf) {
    const today = asOf.slice(0, 10);
    const weekEndDate = new Date(`${today}T00:00:00.000Z`);
    weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 7);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);
    const open = !["done", "cancelled"].includes(item.status);
    return {
      ...clone(item),
      planId: plan.planId,
      planTitle: plan.title,
      planStatus: plan.status,
      month: plan.month,
      overdue: open && item.dueDate < today,
      thisWeek: open && item.dueDate >= today && item.dueDate <= weekEnd
    };
  }

  async function board(session, query = {}, context = {}) {
    requireCapability("execution");
    const access = await subjectAccess(session, query.companyId, query.tenantCompanyId, context);
    const status = cleanText(query.status, 32);
    if (status && !ITEM_STATUSES.includes(status)) throw strategyError("지원하지 않는 실행 상태입니다.", "STRATEGY_ITEM_STATUS_INVALID");
    const due = cleanText(query.due || "all", 32);
    if (!BOARD_DUE_FILTERS.includes(due)) throw strategyError("지원하지 않는 목표일 필터입니다.", "STRATEGY_BOARD_FILTER_INVALID");
    const owner = cleanText(query.owner, 120).toLowerCase();
    const plans = await repository.listPlans({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      month: query.month ? requiredMonth(query.month) : ""
    });
    const visiblePlans = await visiblePublishedRows(session, access, plans, context);
    const all = visiblePlans.flatMap((plan) => plan.items.map((item) => boardRow(plan, item, nowIso())));
    const items = all.filter((item) => {
      if (status && item.status !== status) return false;
      if (owner && !item.owner.toLowerCase().includes(owner)) return false;
      if (due === "overdue" && !item.overdue) return false;
      if (due === "this-week" && !item.thisWeek) return false;
      return true;
    });
    const count = (value) => all.filter((row) => row.status === value).length;
    return {
      ok: true,
      metadata: metadata(),
      board: {
        filters: { status, owner: cleanText(query.owner, 120), due },
        summary: {
          total: all.length,
          planned: count("planned"),
          inProgress: count("in-progress"),
          blocked: count("blocked"),
          done: count("done"),
          overdue: all.filter((row) => row.overdue).length,
          thisWeek: all.filter((row) => row.thisWeek).length
        },
        items
      }
    };
  }

  function retrospectiveContent(plan, payload, actor) {
    const items = plan.items.filter((item) => item.status !== "cancelled");
    if (!items.length) throw strategyError("회고에는 실행 항목이 하나 이상 필요합니다.", "STRATEGY_RETROSPECTIVE_EMPTY", 409);
    const done = items.filter((item) => item.status === "done").length;
    const kpis = items.flatMap((item) => item.kpis || []);
    const entered = kpis.filter((kpi) => kpi.inputState === "entered");
    const achieved = entered.filter((kpi) => kpi.achieved);
    const explicit = new Map((Array.isArray(payload.incompleteReasons) ? payload.incompleteReasons : []).map((row) => [cleanText(row.itemId, 160), cleanText(row.reason, 500)]));
    const incompleteReasons = items.filter((item) => item.status !== "done").map((item) => ({
      itemId: item.itemId,
      title: item.title,
      reason: explicit.get(item.itemId) || item.notes || (item.status === "blocked" ? "차단 사유 확인 필요" : "계획 기간 내 미완료")
    }));
    const strategyIds = [...new Set(items.map((item) => item.strategyId))].sort();
    const sourceReports = [...new Map(items.filter((item) => item.lineage?.sourceReportId).map((item) => [
      item.lineage.sourceReportId,
      {
        reportId: item.lineage.sourceReportId,
        version: item.lineage.sourceReportVersion || 1,
        publishedAt: item.lineage.sourceReportPublishedAt || "",
        algorithmVersion: item.lineage.sourceAlgorithmVersion || ""
      }
    ])).values()];
    return {
      summary: cleanText(payload.summary, 1000),
      execution: { done, total: items.length, rate: round((done / items.length) * 100, 1) },
      kpis: {
        achieved: achieved.length,
        entered: entered.length,
        total: kpis.length,
        achievementRate: entered.length ? round((achieved.length / entered.length) * 100, 1) : 0,
        missing: kpis.length - entered.length
      },
      incompleteReasons,
      lineage: {
        sourcePlanId: plan.planId,
        strategyIds,
        sourceReports,
        ruleVersion: STRATEGY_RULE_VERSION,
        reviewedAt: nowIso(),
        reviewedBy: actor.label
      }
    };
  }

  async function createRetrospective(session, payload = {}, context = {}) {
    requireCapability("retrospective");
    const plan = await repository.getPlan(payload.planId);
    const access = await subjectFromStored(session, plan, payload.tenantCompanyId, context);
    const content = retrospectiveContent(plan, payload, actorFor(session));
    const result = await repository.createRetrospective({
      planId: plan.planId,
      tenantCompanyId: access.tenantCompanyId,
      clientRequestId: payload.clientRequestId,
      retrospective: content
    }, actorFor(session));
    return { ok: true, metadata: metadata(), idempotent: result.idempotent, retrospective: publicRetrospective(result.retrospective) };
  }

  async function listRetrospectives(session, query = {}, context = {}) {
    requireCapability("retrospective");
    const access = await subjectAccess(session, query.companyId, query.tenantCompanyId, context);
    const rows = await repository.listRetrospectives({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      month: query.month ? requiredMonth(query.month) : "",
      planId: cleanText(query.planId, 160)
    });
    const visible = await visiblePublishedRows(session, access, rows, context);
    return { ok: true, metadata: metadata(), retrospectives: visible.map(publicRetrospective) };
  }

  function candidateRow(type, retrospective, item, strategy, targetMonth, generatedAt, actor) {
    if (!CANDIDATE_TYPES.includes(type)) throw strategyError("Unsupported candidate type", "STRATEGY_CANDIDATE_TYPE_INVALID");
    const strategyId = cleanId(strategy.strategyId, "strategyId");
    const sourceItemId = cleanText(item?.itemId, 160);
    const candidateId = `candidate_${stableHash(`${retrospective.tenantCompanyId}|${targetMonth}|${strategyId}`, 28)}`;
    return {
      candidateId,
      retrospectiveId: retrospective.retrospectiveId,
      companyId: retrospective.companyId,
      targetMonth,
      type,
      status: "candidate",
      strategyId,
      sourceItemId,
      title: strategy.title,
      reason: type === "carryover"
        ? "이전 달 미완료 실행 항목"
        : type === "repeat" ? "완료 항목의 다음 달 반복 지정" : "이전 계획에 반영되지 않은 신규 전략",
      lineage: {
        sourceRetrospectiveId: retrospective.retrospectiveId,
        sourcePlanId: retrospective.planId,
        sourceItemId,
        strategyId,
        sourceReportId: strategy.reportId,
        sourceReportVersion: strategy.lineage?.sourceReportVersion || 1,
        sourceReportPublishedAt: strategy.lineage?.sourceReportPublishedAt || "",
        sourceAlgorithmVersion: strategy.lineage?.sourceAlgorithmVersion || "",
        ruleVersion: strategy.ruleVersion,
        generatedAt,
        generatedBy: actor.label
      },
      createdAt: generatedAt
    };
  }

  async function generateNextMonthCandidates(session, retrospectiveId, payload = {}, context = {}) {
    requireCapability("retrospective");
    const retrospective = await repository.getRetrospective(retrospectiveId);
    if (!retrospective) throw strategyError("회고를 찾을 수 없습니다.", "STRATEGY_RETROSPECTIVE_NOT_FOUND", 404);
    const access = await subjectFromStored(session, retrospective, payload.tenantCompanyId, context);
    const targetMonth = requiredMonth(payload.targetMonth, "targetMonth");
    if (targetMonth !== nextMonth(retrospective.month)) {
      throw strategyError("다음달 후보의 targetMonth는 회고 월의 정확한 다음 달이어야 합니다.", "STRATEGY_CANDIDATE_MONTH_INVALID", 409);
    }
    const plan = await repository.getPlan(retrospective.planId);
    const storedStrategies = await repository.listStrategies({
      companyId: retrospective.companyId,
      tenantCompanyId: access.tenantCompanyId,
      month: retrospective.month
    });
    const strategies = await visiblePublishedRows(session, access, storedStrategies, context);
    const byId = new Map(strategies.map((row) => [row.strategyId, row]));
    const generatedAt = nowIso();
    const actor = actorFor(session);
    const selected = new Map();
    const priority = { carryover: 2, repeat: 1 };
    for (const item of [...plan.items].sort((left, right) => String(left.itemId).localeCompare(String(right.itemId)))) {
      const strategy = byId.get(item.strategyId);
      if (!strategy || item.status === "cancelled") continue;
      let type = "";
      if (item.status !== "done") {
        type = "carryover";
      } else if (item.repeatNextMonth) {
        type = "repeat";
      }
      if (type) {
        const current = selected.get(strategy.strategyId);
        if (!current || priority[type] > priority[current.type]) {
          selected.set(strategy.strategyId, candidateRow(type, retrospective, item, strategy, targetMonth, generatedAt, actor));
        }
      }
    }
    const used = new Set(plan.items.map((item) => item.strategyId));
    for (const strategy of strategies) {
      if (!used.has(strategy.strategyId) && !selected.has(strategy.strategyId)) {
        selected.set(strategy.strategyId, candidateRow("new", retrospective, null, strategy, targetMonth, generatedAt, actor));
      }
    }
    const rows = [...selected.values()].sort((left, right) => String(left.strategyId).localeCompare(String(right.strategyId)));
    const result = await repository.createCandidates({
      retrospectiveId,
      tenantCompanyId: access.tenantCompanyId,
      clientRequestId: payload.clientRequestId,
      targetMonth,
      candidates: rows
    }, actor);
    return { ok: true, metadata: metadata(), idempotent: result.idempotent, candidates: result.candidates.map(publicCandidate) };
  }

  async function listCandidates(session, query = {}, context = {}) {
    requireCapability("retrospective");
    const access = await subjectAccess(session, query.companyId, query.tenantCompanyId, context);
    const type = cleanText(query.type, 32);
    if (type && !CANDIDATE_TYPES.includes(type)) throw strategyError("지원하지 않는 후보 유형입니다.", "STRATEGY_CANDIDATE_TYPE_INVALID");
    const rows = await repository.listCandidates({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      targetMonth: query.targetMonth ? requiredMonth(query.targetMonth, "targetMonth") : "",
      type,
      retrospectiveId: cleanText(query.retrospectiveId, 160)
    });
    const visible = await visiblePublishedRows(session, access, rows, context);
    return { ok: true, metadata: metadata(), candidates: visible.map(publicCandidate) };
  }

  async function auditSummary(companyId) {
    const rows = await repository.listAudit({ companyId, limit: 100 });
    return {
      count: rows.length,
      latest: rows.slice(-10).reverse().map((row) => ({
        auditId: row.auditId,
        event: row.event,
        at: row.at,
        actorRole: row.actorRole
      }))
    };
  }

  async function workspace(session, query = {}, context = {}) {
    requireSession(session);
    const view = cleanText(query.view || (roleFor(session) === "admin" ? "admin-strategy" : "business-strategy"), 80);
    const allowedViews = [
      "business-strategy", "business-execution", "business-retrospective",
      "admin-strategy", "admin-execution", "admin-retrospective"
    ];
    if (!allowedViews.includes(view)) throw strategyError("지원하지 않는 Stage 230 workspace입니다.", "STRATEGY_VIEW_INVALID", 404);
    if (view.endsWith("strategy")) requireCapability("strategy");
    if (view.endsWith("execution")) requireCapability("execution");
    if (view.endsWith("retrospective")) requireCapability("retrospective");
    if (view.startsWith("admin-") && roleFor(session) !== "admin") {
      throw strategyError("관리자 화면에 접근할 수 없습니다.", "STRATEGY_ROLE_FORBIDDEN", 403);
    }
    if (view.startsWith("business-") && roleFor(session) === "admin") {
      throw strategyError("관리자는 관리자 workspace를 사용해야 합니다.", "STRATEGY_ROLE_FORBIDDEN", 403);
    }
    const tenant = await tenantAccess(session, query.tenantCompanyId, context);
    let companyId = cleanText(query.companyId, 160);
    if (!companyId && roleFor(session) !== "admin") {
      const companies = await freshService.listCompanies(session, tenant.tenantCompanyId, context);
      if (companies.length > 1) {
        throw strategyError("소유 숙소가 여러 개이면 workspace 대상을 명시해야 합니다.", "STRATEGY_COMPANY_REQUIRED", 422);
      }
      companyId = cleanText(companies[0]?.companyId, 160);
    }
    if (!companyId) {
      return {
        ok: true,
        metadata: metadata(),
        view,
        state: "empty",
        companyId: "",
        ...(roleFor(session) === "admin" ? { tenantCompanyId: tenant.tenantCompanyId } : {}),
        month: cleanText(query.month, 12),
        reportGate: { eligible: false, state: "not-published-report", reason: "업체를 선택하세요.", reportId: "", confidence: "insufficient" },
        strategies: [], plans: [], board: { filters: {}, summary: { total: 0, planned: 0, inProgress: 0, blocked: 0, done: 0, overdue: 0, thisWeek: 0 }, items: [] },
        retrospectives: [], candidates: [], limits: tenant.plan,
        audit: roleFor(session) === "admin" ? { count: 0, latest: [] } : undefined
      };
    }
    const access = await subjectAccess(session, companyId, tenant.tenantCompanyId, context);
    const month = query.month ? requiredMonth(query.month) : "";
    const [reportResult, strategies, plans, retrospectives, candidates, boardResult, audit] = await Promise.all([
      selectedReport(session, access, { month, reportId: query.reportId }, context),
      repository.listStrategies({ companyId, tenantCompanyId: access.tenantCompanyId, month }),
      capabilities.execution ? repository.listPlans({ companyId, tenantCompanyId: access.tenantCompanyId, month }) : Promise.resolve([]),
      capabilities.retrospective ? repository.listRetrospectives({ companyId, tenantCompanyId: access.tenantCompanyId, month }) : Promise.resolve([]),
      capabilities.retrospective ? repository.listCandidates({ companyId, tenantCompanyId: access.tenantCompanyId, targetMonth: cleanText(query.targetMonth, 12) }) : Promise.resolve([]),
      capabilities.execution ? board(session, { companyId, tenantCompanyId: access.tenantCompanyId, month, status: query.status, owner: query.owner, due: query.due }, context) : Promise.resolve({ board: { filters: {}, summary: { total: 0, planned: 0, inProgress: 0, blocked: 0, done: 0, overdue: 0, thisWeek: 0 }, items: [] } }),
      roleFor(session) === "admin" ? auditSummary(companyId) : Promise.resolve(undefined)
    ]);
    const publishedReports = await publishedLineageReports(session, access, context);
    const visibleStrategies = strategies.filter((row) => hasPublishedLineage(row, publishedReports));
    const visiblePlans = plans.filter((row) => hasPublishedLineage(row, publishedReports));
    const visiblePlanIds = new Set(visiblePlans.map((row) => row.planId));
    const visibleRetrospectives = retrospectives.filter((row) => (
      visiblePlanIds.has(row.planId) && hasPublishedLineage(row, publishedReports)
    ));
    const visibleRetrospectiveIds = new Set(visibleRetrospectives.map((row) => row.retrospectiveId));
    const visibleCandidates = candidates.filter((row) => (
      visibleRetrospectiveIds.has(row.retrospectiveId) && hasPublishedLineage(row, publishedReports)
    ));
    const visibleBoardItems = (boardResult.board?.items || []).filter((row) => visiblePlanIds.has(row.planId));
    const countStatus = (status) => visibleBoardItems.filter((row) => row.status === status).length;
    const visibleBoard = {
      filters: clone(boardResult.board?.filters || {}),
      summary: {
        total: visibleBoardItems.length,
        planned: countStatus("planned"),
        inProgress: countStatus("in-progress"),
        blocked: countStatus("blocked"),
        done: countStatus("done"),
        overdue: visibleBoardItems.filter((row) => row.overdue).length,
        thisWeek: visibleBoardItems.filter((row) => row.thisWeek).length
      },
      items: visibleBoardItems
    };
    const contentPresent = visibleStrategies.length || visiblePlans.length || visibleRetrospectives.length || visibleCandidates.length;
    return {
      ok: true,
      metadata: metadata(),
      view,
      state: contentPresent ? "ready" : reportResult.gate.state,
      companyId,
      ...(roleFor(session) === "admin" ? { tenantCompanyId: access.tenantCompanyId } : {}),
      company: {
        companyId,
        companyName: cleanText(access.company.companyName || access.company.name, 180),
        regionLabel: cleanText(access.company.regionLabel || access.company.region, 160)
      },
      month: month || cleanText(reportResult.report?.month, 12),
      reportGate: reportResult.gate,
      strategies: visibleStrategies.map(publicStrategy),
      plans: visiblePlans.map(publicPlan),
      board: visibleBoard,
      retrospectives: visibleRetrospectives.map(publicRetrospective),
      candidates: visibleCandidates.map(publicCandidate),
      limits: access.plan,
      audit
    };
  }

  return Object.freeze({
    metadata,
    workspace,
    generateStrategies,
    listStrategies,
    createPlan,
    listPlans,
    updatePlan,
    addPlanItem,
    updatePlanItem,
    addKpi,
    updateKpi,
    board,
    createRetrospective,
    listRetrospectives,
    generateNextMonthCandidates,
    listCandidates,
    actorFor
  });
}

module.exports = {
  actorFor,
  createStrategyService,
  roleFor
};
