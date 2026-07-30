"use strict";

const {
  INSIGHTS_ALGORITHM_VERSION,
  INSIGHTS_FIXTURE_VERSION,
  INSIGHTS_OBSERVATION_FRESH_HOURS,
  INSIGHTS_PROVIDER_ID,
  INSIGHTS_SIGNAL_FRESH_HOURS,
  INSIGHTS_STAGE,
  allowedActionsForLifecycle,
  cleanId,
  cleanText,
  clone,
  deriveCohortDescriptor,
  deriveLocationAnalysis,
  deriveReportScopes,
  insightsError,
  nextMonth,
  requiredMonth,
  selectLocationEvidence,
  selectReportEvidence,
  stableHash
} = require("../contracts/insights.cjs");

function roleFor(session) {
  return session?.account?.role === "admin" ? "admin" : "business";
}

function requireSession(session) {
  if (!session?.accountId || !session?.account) {
    throw insightsError("로그인이 필요합니다.", "INSIGHTS_AUTH_REQUIRED", 401);
  }
  return session;
}

function requireAdmin(session) {
  requireSession(session);
  if (roleFor(session) !== "admin") {
    throw insightsError("관리자 권한이 필요합니다.", "INSIGHTS_ROLE_FORBIDDEN", 403);
  }
}

function actorFor(session) {
  requireSession(session);
  return {
    type: "account",
    id: session.accountId,
    accountId: session.accountId,
    actorAccountId: session.accountId,
    role: roleFor(session),
    actorRole: roleFor(session)
  };
}

function sanitizeEditorial(value = {}) {
  const publicText = (input, maximum, label) => {
    const text = cleanText(input, maximum);
    if (
      /(?:https?:\/\/|file:\/\/|(?:[A-Za-z]:[\\/])|(?:^|\s)(?:\/var\/|\/tmp\/|\/home\/|\\\\)|(?:^|[\s"'(])(?:outputs|customer_db|company_master|tourism_data)[\\/])/i.test(text)
      || /\b(?:source[-_ ]?key|source[-_ ]?url|evidence[-_ ]?id|raw[-_ ]?evidence[-_ ]?id|raw[-_ ]?payload|internal[-_ ]?formula|stack[-_ ]?trace|internal[-_ ]?error)\b/i.test(text)
      || /\bcmp_[A-Za-z0-9_-]+\b/.test(text)
      || /\b(?:evidence_snapshot|signal|observation|location_card|monthly_report)_[A-Za-z0-9_-]+\b/i.test(text)
    ) {
      throw insightsError(`${label} contains non-public source, path, formula, error, or company identity text`, "INSIGHTS_PUBLIC_TEXT_FORBIDDEN", 400);
    }
    return text;
  };
  return {
    headline: publicText(value.headline, 180, "headline"),
    summary: publicText(value.summary, 1000, "summary"),
    note: publicText(value.note, 1000, "note")
  };
}

function createInsightsService(options = {}) {
  const repository = options.repository;
  const provider = options.provider;
  const freshRepository = options.freshRepository;
  const freshService = options.freshService;
  const signalRepository = options.signalRepository || null;
  const authService = options.authService;
  const clock = options.clock || (() => Date.now());
  const capabilities = Object.freeze({
    reliability: Boolean(options.capabilities?.reliability),
    locationCard: Boolean(options.capabilities?.locationCard),
    businessReport: Boolean(options.capabilities?.businessReport)
  });
  if (!repository || !provider || !freshRepository || !freshService || !authService) {
    throw new Error("Stage 229 insights service dependencies are required");
  }
  const fixtureMode = provider.kind === "deterministic-fixture";
  const providerEnabled = provider.enabled !== false && typeof provider.collect === "function";
  const providerStatus = providerEnabled
    ? (fixtureMode ? "test-fixture" : "configured")
    : "provider-not-configured";

  function isSyntheticSignal(row = {}) {
    return row.synthetic === true
      || row.provenance?.synthetic === true
      || cleanText(row.fixtureVersion, 120) === INSIGHTS_FIXTURE_VERSION
      || cleanText(row.source, 120) === INSIGHTS_PROVIDER_ID;
  }

  function visibleSignals(rows = []) {
    return fixtureMode ? rows : rows.filter((row) => !isSyntheticSignal(row));
  }

  async function connectorSignals(companyId) {
    if (fixtureMode || !signalRepository?.listSignals) return [];
    const rows = await signalRepository.listSignals({ companyId, synthetic: false });
    return rows.filter((row) => row?.synthetic === false && row?.dataMode === "live");
  }

  function mergeSignals(...groups) {
    const byId = new Map();
    for (const row of groups.flat().filter(Boolean)) {
      if (!fixtureMode && isSyntheticSignal(row)) continue;
      if (row?.signalId && !byId.has(row.signalId)) byId.set(row.signalId, row);
    }
    return [...byId.values()];
  }

  function visibleFreshRows(rows = []) {
    return fixtureMode
      ? rows
      : rows.filter((row) => row?.synthetic === false && row?.dataMode === "live");
  }

  function liveProfileValue(rows, kind) {
    const row = rows
      .filter((entry) => (entry?.observationType || entry?.kind) === kind)
      .sort((left, right) => String(right.observedAt || "").localeCompare(String(left.observedAt || "")))[0];
    const value = row?.value ?? row?.values;
    return cleanText(value, 180);
  }

  function visibleFreshCompany(company = {}, rows = []) {
    if (fixtureMode) return company;
    const name = liveProfileValue(rows, "profile.company-name");
    const region = liveProfileValue(rows, "profile.region");
    const category = liveProfileValue(rows, "profile.category");
    return {
      companyId: cleanText(company.companyId, 160),
      companyName: name,
      name,
      region,
      regionLabel: region,
      category,
      synthetic: false,
      dataMode: "live"
    };
  }

  function isSyntheticArtifact(row = {}) {
    return row.synthetic === true
      || row.analysis?.synthetic === true
      || row.report?.synthetic === true
      || row.report?.analysis?.synthetic === true
      || cleanText(row.evidenceSummary?.fixtureVersion, 120) === INSIGHTS_FIXTURE_VERSION
      || cleanText(row.analysis?.fixtureVersion, 120) === INSIGHTS_FIXTURE_VERSION
      || cleanText(row.report?.fixtureVersion, 120) === INSIGHTS_FIXTURE_VERSION;
  }

  function businessVisibleArtifact(row = {}) {
    return fixtureMode || (
      !isSyntheticArtifact(row)
      && row.synthetic === false
      && row.dataMode === "live"
    );
  }

  function assertVisibleArtifact(row, label) {
    if (!businessVisibleArtifact(row)) {
      throw insightsError(`${label}을 찾을 수 없습니다.`, "INSIGHTS_ARTIFACT_NOT_FOUND", 404);
    }
    return row;
  }

  function nowIso() {
    return new Date(Number(clock())).toISOString();
  }

  function requireCapability(name) {
    if (!capabilities[name]) {
      throw insightsError(`Stage 229 ${name} capability is disabled`, "INSIGHTS_FEATURE_DISABLED", 404);
    }
  }

  function assertForecastMonth(value, asOf, expectedMonth = nextMonth(asOf)) {
    const month = requiredMonth(value, "forecastMonth");
    if (month !== expectedMonth) {
      throw insightsError("forecastMonth는 기준일의 정확한 다음 달이어야 합니다.", "INSIGHTS_FORECAST_MONTH_INVALID", 400);
    }
    return month;
  }

  function assertPublishFreshness(analysis) {
    const now = Number(clock());
    const within = (value, maximumHours) => {
      const observedAt = Date.parse(String(value || ""));
      const age = now - observedAt;
      return Number.isFinite(observedAt) && age >= 0 && age <= maximumHours * 3_600_000;
    };
    const leadtimeAt = analysis?.forecast?.freshness?.inputLatestObservedAt;
    const otaAt = analysis?.readiness?.freshness?.otaLatestObservedAt;
    const signalAt = analysis?.readiness?.freshness?.latestSignalAt;
    if (
      !within(leadtimeAt, INSIGHTS_OBSERVATION_FRESH_HOURS)
      || !within(otaAt, INSIGHTS_OBSERVATION_FRESH_HOURS)
      || !within(signalAt, INSIGHTS_SIGNAL_FRESH_HOURS)
    ) {
      throw insightsError("검수된 evidence snapshot의 최신성 기준이 만료되어 다시 수집·검수해야 합니다.", "INSIGHTS_SAMPLE_GATE", 409);
    }
  }

  function metadata() {
    const diagnostics = provider.diagnostics();
    return {
      stage: INSIGHTS_STAGE,
      algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
      fixtureVersion: fixtureMode ? INSIGHTS_FIXTURE_VERSION : "",
      providerId: cleanText(provider.id, 120),
      providerStatus,
      fixtureMode,
      dataBoundary: "fresh-integration-stage229-only",
      capabilities: clone(capabilities),
      externalProviderCalls: Number(diagnostics.externalRequests || 0),
      credentialReads: Number(diagnostics.credentialReads || 0),
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0
    };
  }

  async function recentStepUp(session) {
    if (typeof authService.assertRecentReauthentication === "function") {
      authService.assertRecentReauthentication(session);
    }
  }

  function sessionTenantId(session) {
    return cleanText(session?.memberships?.[0]?.companyId, 160);
  }

  async function assertCompany(session, companyId, requestedTenantCompanyId = "", context = {}) {
    requireSession(session);
    const id = cleanId(companyId, "companyId");
    if (roleFor(session) === "admin") {
      const identity = await freshRepository.getCompany(id);
      if (!fixtureMode && (identity?.synthetic !== false || identity?.dataMode !== "live")) {
        throw insightsError("실수집되지 않은 업체는 분석할 수 없습니다.", "INSIGHTS_COMPANY_NOT_FOUND", 404);
      }
      const ownedTenantCompanyIds = Array.isArray(identity.tenantCompanyIds)
        ? identity.tenantCompanyIds.map((value) => cleanText(value, 160)).filter(Boolean)
        : [];
      const requested = cleanText(requestedTenantCompanyId, 160);
      if (requested && !ownedTenantCompanyIds.includes(requested)) {
        throw insightsError("요청한 업체 소유권이 신규 수집 identity에 없습니다.", "INSIGHTS_TENANT_FORBIDDEN", 403);
      }
      if (!requested && ownedTenantCompanyIds.length === 0) {
        throw insightsError("신규 수집 identity에서 업체 소유권을 확정할 수 없습니다.", "INSIGHTS_TENANT_REQUIRED", 422);
      }
      return {
        companyId: id,
        tenantCompanyId: requested || ownedTenantCompanyIds[0] || "",
        identity,
        company: await freshService.getCompany(session, id, requested || "", context)
      };
    }
    const tenantCompanyId = sessionTenantId(session);
    if (!tenantCompanyId) throw insightsError("활성 업체 소속이 필요합니다.", "INSIGHTS_MEMBERSHIP_REQUIRED", 403);
    const requested = cleanText(requestedTenantCompanyId || tenantCompanyId, 160);
    if (requested !== tenantCompanyId) {
      throw insightsError("다른 업체의 분석 데이터에는 접근할 수 없습니다.", "INSIGHTS_TENANT_FORBIDDEN", 403);
    }
    await authService.assertCompanyAccess(session, tenantCompanyId, context);
    const company = await freshService.getCompany(session, id, tenantCompanyId, context);
    return { companyId: id, tenantCompanyId, identity: null, company };
  }

  async function companyInputs(companyId) {
    const [company, storedObservations, storedSignals, completedConnectorSignals, runs] = await Promise.all([
      freshRepository.getCompany(companyId, { projection: "business-safe" }),
      freshRepository.listObservations({ companyId, limit: 100_000 }),
      repository.listSignals({ companyId, limit: 100_000 }),
      connectorSignals(companyId),
      freshRepository.listRuns({ statuses: ["queued", "running", "retry-wait", "cancel-requested"] })
    ]);
    return {
      company: visibleFreshCompany(company, visibleFreshRows(storedObservations)),
      observations: visibleFreshRows(storedObservations),
      signals: mergeSignals(storedSignals, completedConnectorSignals),
      collecting: visibleFreshRows(runs).some((run) => run.companyId === companyId || run.checkpoint?.companyId === companyId)
    };
  }

  async function analysisInputs(session, companyId, requestedTenantCompanyId = "", context = {}) {
    const access = await assertCompany(session, companyId, requestedTenantCompanyId, context);
    return companyInputs(access.companyId);
  }

  async function allCompanyInputs() {
    const identities = await freshRepository.listCompanies({ projection: "identity" });
    const ownedIdentities = identities.filter((identity) => (
      (fixtureMode || (identity.synthetic === false && identity.dataMode === "live"))
      &&
      Array.isArray(identity.tenantCompanyIds)
      && identity.tenantCompanyIds.map((value) => cleanText(value, 160)).some(Boolean)
    ));
    return Promise.all(ownedIdentities.map(async (identity) => {
      const [company, observations] = await Promise.all([
        freshRepository.getCompany(identity.companyId, { projection: "business-safe" }),
        freshRepository.listObservations({ companyId: identity.companyId, limit: 100_000 })
      ]);
      const visibleObservations = visibleFreshRows(observations);
      return { company: visibleFreshCompany(company, visibleObservations), observations: visibleObservations };
    }));
  }

  async function ensureSignals(companyId, periodMonth, actor) {
    const existing = visibleSignals(await repository.listSignals({ companyId, limit: 100_000 }));
    if (!providerEnabled) {
      return {
        providerStatus,
        collected: null,
        appended: { inserted: 0, duplicates: 0 },
        signals: existing
      };
    }
    const company = await freshRepository.getCompany(companyId, { projection: "business-safe" });
    const observedAt = nowIso();
    const runId = `insights_fixture_${stableHash(`${companyId}|${periodMonth}|${observedAt.slice(0, 10)}|${INSIGHTS_FIXTURE_VERSION}`, 28)}`;
    const collected = await provider.collect({
      companyId,
      runId,
      observedAt,
      periodMonth,
      region: company.region || ""
    });
    const appended = await repository.appendSignals(collected.signals, { actor, runId });
    return {
      providerStatus,
      collected,
      appended,
      signals: visibleSignals(await repository.listSignals({ companyId, limit: 100_000 }))
    };
  }

  async function evidenceFor(companyId, observations, signals, analysis, actor, options = {}) {
    const locationLineage = selectLocationEvidence(observations, signals, {
      asOf: analysis.asOf,
      forecastMonth: analysis.forecast.forecastMonth
    });
    const reportLineage = Array.isArray(options.reportCompanies)
      ? selectReportEvidence(companyId, options.reportCompanies, { asOf: analysis.asOf })
      : null;
    const uniqueRows = (rows, idKey) => {
      const selected = new Map();
      for (const row of rows.filter(Boolean)) {
        const id = cleanText(row?.[idKey], 160) || stableHash(row, 64);
        if (!selected.has(id)) selected.set(id, row);
      }
      return [...selected.values()].sort((left, right) => (
        String(left?.[idKey] || "").localeCompare(String(right?.[idKey] || ""))
      ));
    };
    const selectedObservations = uniqueRows([
      ...locationLineage.observations,
      ...(reportLineage?.observations || [])
    ], "observationId");
    const selectedSignals = uniqueRows(locationLineage.signals, "signalId");
    const observedTimes = [
      ...selectedObservations.map((row) => row.observedAt),
      ...selectedSignals.map((row) => row.observedAt)
    ].filter(Boolean).sort();
    return repository.appendEvidenceSnapshot({
      companyId,
      observedAtRange: { from: observedTimes[0] || "", to: observedTimes.at(-1) || "" },
      observationCount: selectedObservations.length,
      signalCount: selectedSignals.length,
      internal: {
        algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
        observationIds: selectedObservations.map((row) => row.observationId).filter(Boolean),
        signalIds: selectedSignals.map((row) => row.signalId).filter(Boolean),
        inputPeriod: analysis.forecast.inputPeriod,
        forecastMonth: analysis.forecast.forecastMonth,
        completeSeriesCount: locationLineage.completeSeriesCount,
        ...(reportLineage ? {
          reportLineage: {
            asOf: reportLineage.asOf,
            companyIds: reportLineage.companyIds,
            scopeCompanyIds: reportLineage.scopeCompanyIds,
            cohortSnapshotHash: reportLineage.cohortSnapshotHash
          }
        } : {})
      }
    }, actor);
  }

  function evidenceSummary(evidence, analysis) {
    return {
      algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
      fixtureVersion: fixtureMode ? INSIGHTS_FIXTURE_VERSION : "",
      inputRange: clone(evidence?.observedAtRange || analysis?.forecast?.inputPeriod || { from: "", to: "" }),
      observationCount: Number(evidence?.observationCount || 0),
      signalCount: Number(evidence?.signalCount || 0),
      sourceBoundary: "fresh-integration-stage229-only"
    };
  }

  function publicReadiness(analysis, collecting = false, options = {}) {
    const readiness = clone(analysis?.readiness || {
      state: "not-collected",
      sampleCount: 0,
      minimumSampleCount: 3,
      freshness: { observations: "missing", signals: "missing" },
      confidence: "insufficient",
      confidenceCauses: ["신규 관측이 없습니다."],
      nextCollectionCta: { kind: "collect-leadtime", label: "신규 반복 관측 시작" }
    });
    if (collecting && readiness.state !== "ready") readiness.state = "collecting";
    const dimensionReasons = (analysis?.dimensions || [])
      .filter((dimension) => dimension.state !== "ready")
      .map((dimension) => `${dimension.label} 입력이 준비되지 않았습니다.`);
    readiness.missingReasons = [...new Set([
      ...(analysis?.forecast?.missingReasons || []),
      ...(options.missingReasons || []),
      ...dimensionReasons
    ])];
    readiness.freshnessLabel = readiness.freshness?.observations === "fresh" && readiness.freshness?.signals === "fresh"
      ? "최신성 충족"
      : "최신성 보강 필요";
    readiness.confidenceLabel = readiness.confidence === "high"
      ? "높음"
      : readiness.confidence === "medium" ? "보통" : "데이터 부족";
    readiness.inputPeriod = clone(analysis?.forecast?.inputPeriod || { from: "", to: "" });
    if (readiness.nextCollectionCta) {
      readiness.nextCollectionCta.path = options.admin ? "/admin/collection" : "/app/activity";
    }
    return readiness;
  }

  async function auditSummary(filter) {
    const rows = await repository.listAudit({ ...filter, limit: 40 });
    return {
      count: rows.length,
      latest: rows.slice(-8).reverse().map((row) => ({
        auditId: row.auditId,
        event: row.event,
        at: row.at,
        actorRole: row.actorRole
      }))
    };
  }

  async function publicCard(row, options = {}) {
    if (!row) return null;
    const admin = Boolean(options.admin);
    const analysis = clone(row.analysis || null);
    const ready = analysis?.state === "ready";
    const synthetic = isSyntheticArtifact(row);
    const dimensions = (analysis?.dimensions || []).map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      state: dimension.state,
      score: admin || ready ? dimension.score : null
    }));
    return {
      cardId: row.cardId,
      ...(admin ? { clientRequestId: row.clientRequestId } : {}),
      companyId: row.companyId,
      lifecycle: row.lifecycle,
      version: row.version,
      state: row.lifecycle !== "published" && !admin
        ? "not-published"
        : (analysis?.state || "not-collected"),
      requestedAt: row.requestedAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
      synthetic,
      sourceLabel: synthetic
        ? "Stage 229 결정적 합성 fixture"
        : (providerStatus === "provider-not-configured" ? "실제 신호 미수집" : "신규 수집 신호"),
      editorial: clone(row.editorial || {}),
      algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
      overallScore: admin || ready ? (analysis?.overallScore ?? null) : null,
      dimensions,
      forecast: analysis?.forecast || null,
      readiness: publicReadiness(analysis, options.collecting, { admin }),
      evidence: clone(row.evidenceSummary || evidenceSummary(options.evidence, analysis)),
      allowedActions: admin ? allowedActionsForLifecycle(row.lifecycle) : [],
      audit: admin ? await auditSummary({ cardId: row.cardId }) : undefined
    };
  }

  async function publicReport(row, options = {}) {
    if (!row) return null;
    const admin = Boolean(options.admin);
    const content = clone(row.report || null);
    const ready = content?.state === "ready";
    const synthetic = isSyntheticArtifact(row);
    const scopes = (content?.scopes || []).map((scope) => ({
      scope: scope.scope,
      label: scope.label,
      state: scope.state,
      sampleCount: scope.sampleCount,
      minimumSampleCount: scope.minimumSampleCount,
      anonymous: scope.anonymous,
      cohort: scope.cohort,
      metrics: admin || scope.state === "ready" ? scope.metrics : null,
      missingReasons: clone(scope.missingReasons || [])
    }));
    const reportReadiness = publicReadiness(content?.analysis, Boolean(options.collecting), {
      admin,
      missingReasons: (content?.scopes || []).flatMap((scope) => scope.missingReasons || [])
    });
    if (!options.collecting || content?.state === "ready") reportReadiness.state = content?.state || reportReadiness.state;
    const projectedState = options.collecting && content?.state !== "ready"
      ? "collecting"
      : (content?.state || "not-collected");
    return {
      reportId: row.reportId,
      ...(admin ? { clientRequestId: row.clientRequestId } : {}),
      companyId: row.companyId,
      month: row.month,
      lifecycle: row.lifecycle,
      version: row.version,
      state: row.lifecycle !== "published" && !admin ? "not-published" : projectedState,
      requestedAt: row.requestedAt,
      updatedAt: row.updatedAt,
      publishedAt: row.publishedAt,
      synthetic,
      sourceLabel: synthetic
        ? "Stage 229 결정적 합성 fixture"
        : (providerStatus === "provider-not-configured" ? "실제 신호 미수집" : "신규 수집 신호"),
      editorial: clone(row.editorial || {}),
      algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
      scopes,
      forecast: content?.forecast || null,
      readiness: reportReadiness,
      evidence: clone(row.evidenceSummary || evidenceSummary(options.evidence, content?.analysis)),
      locationCardPath: "/app/location",
      locationCardId: cleanText(content?.locationCardId, 160),
      allowedActions: admin ? allowedActionsForLifecycle(row.lifecycle) : [],
      audit: admin ? await auditSummary({ reportId: row.reportId }) : undefined,
      resultAvailable: ready
    };
  }

  async function requestLocationCard(session, payload = {}, context = {}) {
    requireCapability("locationCard");
    const access = await assertCompany(session, payload.companyId, payload.tenantCompanyId, context);
    if (!access.tenantCompanyId) {
      throw insightsError("입지카드에는 소유 tenant가 필요합니다.", "INSIGHTS_TENANT_REQUIRED", 422);
    }
    const result = await repository.createLocationCardRequest({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      clientRequestId: payload.clientRequestId,
      synthetic: fixtureMode,
      dataMode: fixtureMode ? "test-fixture" : "live"
    }, actorFor(session));
    return {
      ok: true,
      metadata: metadata(),
      idempotent: result.idempotent,
      request: {
        requestId: result.card.cardId,
        cardId: result.card.cardId,
        clientRequestId: result.card.clientRequestId,
        companyId: result.card.companyId,
        status: result.card.lifecycle,
        lifecycle: result.card.lifecycle,
        createdAt: result.card.requestedAt,
        provisional: false
      }
    };
  }

  async function listLocationCardRequests(session, context = {}) {
    requireCapability("locationCard");
    requireSession(session);
    const admin = roleFor(session) === "admin";
    const tenantCompanyId = admin ? "" : sessionTenantId(session);
    if (!admin) {
      if (!tenantCompanyId) {
        throw insightsError("활성 업체 소속이 필요합니다.", "INSIGHTS_MEMBERSHIP_REQUIRED", 403);
      }
      await authService.assertCompanyAccess(session, tenantCompanyId, context);
    }
    const rows = await repository.listLocationCards({ tenantCompanyId });
    return rows.filter(businessVisibleArtifact).map((row) => ({
      requestId: row.cardId,
      cardId: row.cardId,
      clientRequestId: row.clientRequestId,
      companyId: row.companyId,
      status: row.lifecycle,
      lifecycle: row.lifecycle,
      createdAt: row.requestedAt,
      provisional: false
    }));
  }

  async function createLocationDraft(session, cardId, payload = {}) {
    requireCapability("locationCard");
    requireAdmin(session);
    const current = await repository.getLocationCard(cardId);
    if (!current) throw insightsError("입지카드를 찾을 수 없습니다.", "INSIGHTS_CARD_NOT_FOUND", 404);
    assertVisibleArtifact(current, "입지카드");
    const access = await assertCompany(session, current.companyId, current.tenantCompanyId);
    const asOf = nowIso();
    const month = requiredMonth(payload.month || asOf.slice(0, 7), "month");
    if (month !== asOf.slice(0, 7)) {
      throw insightsError("signal period는 기준일이 속한 달이어야 합니다.", "INSIGHTS_SIGNAL_PERIOD_INVALID", 400);
    }
    const forecastMonth = assertForecastMonth(payload.forecastMonth || nextMonth(asOf), asOf);
    await ensureSignals(access.companyId, month, actorFor(session));
    const inputs = await companyInputs(access.companyId);
    const analysis = deriveLocationAnalysis({
      observations: inputs.observations,
      signals: inputs.signals,
      asOf,
      forecastMonth
    });
    const evidenceResult = await evidenceFor(access.companyId, inputs.observations, inputs.signals, analysis, actorFor(session));
    const safeEvidence = evidenceSummary(evidenceResult.evidence, analysis);
    const transitioned = await repository.transitionLocationCard(cardId, {
      expectedVersion: payload.expectedVersion || current.version,
      to: "draft",
      patch: {
        evidenceSnapshotId: evidenceResult.evidence.evidenceSnapshotId,
        evidenceSummary: safeEvidence,
        analysis,
        editorial: sanitizeEditorial(payload.editorial || current.editorial)
      }
    }, actorFor(session));
    return {
      ok: true,
      metadata: metadata(),
      card: await publicCard(transitioned.card, {
        admin: true,
        collecting: inputs.collecting,
        evidence: safeEvidence
      })
    };
  }

  async function editLocationDraft(session, cardId, payload = {}) {
    requireCapability("locationCard");
    requireAdmin(session);
    const current = await repository.getLocationCard(cardId);
    if (!current) throw insightsError("입지카드를 찾을 수 없습니다.", "INSIGHTS_CARD_NOT_FOUND", 404);
    assertVisibleArtifact(current, "입지카드");
    await assertCompany(session, current.companyId, current.tenantCompanyId);
    const to = current.lifecycle === "changes-requested" ? "draft" : "draft";
    const transitioned = await repository.transitionLocationCard(cardId, {
      expectedVersion: payload.expectedVersion,
      to,
      patch: { editorial: sanitizeEditorial({ ...current.editorial, ...(payload.editorial || payload) }) }
    }, actorFor(session));
    return { ok: true, metadata: metadata(), card: await publicCard(transitioned.card, { admin: true }) };
  }

  async function createOrEditLocationDraft(session, cardId, payload = {}) {
    const current = await repository.getLocationCard(cardId);
    if (!current) throw insightsError("입지카드를 찾을 수 없습니다.", "INSIGHTS_CARD_NOT_FOUND", 404);
    assertVisibleArtifact(current, "입지카드");
    return current.lifecycle === "requested"
      ? createLocationDraft(session, cardId, payload)
      : editLocationDraft(session, cardId, payload);
  }

  async function reviewLocationCard(session, cardId, payload = {}) {
    requireCapability("locationCard");
    requireAdmin(session);
    const current = await repository.getLocationCard(cardId);
    if (!current) throw insightsError("입지카드를 찾을 수 없습니다.", "INSIGHTS_CARD_NOT_FOUND", 404);
    assertVisibleArtifact(current, "입지카드");
    await assertCompany(session, current.companyId, current.tenantCompanyId);
    const decision = cleanText(payload.decision, 40);
    let to;
    if (decision === "submit") to = "in-review";
    else if (decision === "approve") to = "reviewed";
    else if (["request-changes", "changes-requested"].includes(decision)) to = "changes-requested";
    else throw insightsError("지원하지 않는 검수 결정입니다.", "INSIGHTS_REVIEW_DECISION_INVALID");
    if (decision !== "submit") await recentStepUp(session);
    const transitioned = await repository.transitionLocationCard(cardId, {
      expectedVersion: payload.expectedVersion,
      to,
      patch: {
        review: {
          decision,
          reason: cleanText(payload.reason, 500),
          reviewedAt: nowIso(),
          reviewedBy: session.accountId
        }
      }
    }, actorFor(session));
    return { ok: true, metadata: metadata(), card: await publicCard(transitioned.card, { admin: true }) };
  }

  async function publishLocationCard(session, cardId, payload = {}) {
    requireCapability("locationCard");
    requireAdmin(session);
    await recentStepUp(session);
    const current = await repository.getLocationCard(cardId);
    if (!current) throw insightsError("입지카드를 찾을 수 없습니다.", "INSIGHTS_CARD_NOT_FOUND", 404);
    assertVisibleArtifact(current, "입지카드");
    await assertCompany(session, current.companyId, current.tenantCompanyId);
    if (current.analysis?.state !== "ready" || current.analysis?.forecast?.state !== "ready") {
      throw insightsError("최소 반복 관측과 모든 입지 차원이 준비되기 전에는 공개할 수 없습니다.", "INSIGHTS_SAMPLE_GATE", 409);
    }
    assertPublishFreshness(current.analysis);
    const transitioned = await repository.transitionLocationCard(cardId, {
      expectedVersion: payload.expectedVersion,
      to: "published",
      patch: {}
    }, actorFor(session));
    return { ok: true, metadata: metadata(), card: await publicCard(transitioned.card, { admin: true }) };
  }

  async function listLocationCards(session, query = {}, context = {}) {
    requireCapability("locationCard");
    const companyId = cleanId(query.companyId, "companyId");
    const access = await assertCompany(session, companyId, query.tenantCompanyId, context);
    const admin = roleFor(session) === "admin";
    const rows = await repository.listLocationCards({
      companyId,
      tenantCompanyId: admin ? "" : access.tenantCompanyId
    });
    const eligible = rows.filter(businessVisibleArtifact);
    const visible = admin ? eligible : eligible.filter((row) => row.lifecycle === "published");
    const inputs = await companyInputs(companyId);
    const cards = await Promise.all(visible.map((row) => publicCard(row, { admin, collecting: inputs.collecting })));
    return {
      ok: true,
      metadata: metadata(),
      state: cards[0]?.state || (eligible.length ? "not-published" : (inputs.collecting ? "collecting" : "not-collected")),
      readiness: cards[0]?.readiness || publicReadiness(null, inputs.collecting),
      cards,
      requestState: eligible[0]?.lifecycle || "not-requested"
    };
  }

  async function createMonthlyReport(session, payload = {}, context = {}) {
    requireCapability("businessReport");
    requireAdmin(session);
    const access = await assertCompany(session, payload.companyId, payload.tenantCompanyId, context);
    if (!access.tenantCompanyId) throw insightsError("월간 리포트에는 소유 tenant가 필요합니다.", "INSIGHTS_TENANT_REQUIRED", 422);
    const asOf = nowIso();
    const month = assertForecastMonth(payload.month, asOf);
    const result = await repository.createMonthlyReport({
      companyId: access.companyId,
      tenantCompanyId: access.tenantCompanyId,
      clientRequestId: payload.clientRequestId,
      month,
      synthetic: fixtureMode,
      dataMode: fixtureMode ? "test-fixture" : "live"
    }, actorFor(session));
    return { ok: true, metadata: metadata(), idempotent: result.idempotent, report: await publicReport(result.report, { admin: true }) };
  }

  async function createReportDraft(session, reportId, payload = {}) {
    requireCapability("businessReport");
    requireAdmin(session);
    const current = await repository.getMonthlyReport(reportId);
    if (!current) throw insightsError("월간 리포트를 찾을 수 없습니다.", "INSIGHTS_REPORT_NOT_FOUND", 404);
    assertVisibleArtifact(current, "월간 리포트");
    await assertCompany(session, current.companyId, current.tenantCompanyId);
    const asOf = nowIso();
    const forecastMonth = assertForecastMonth(payload.forecastMonth || current.month, asOf, current.month);
    if (current.month !== nextMonth(asOf)) {
      throw insightsError("월간 리포트 month는 기준일의 정확한 다음 달이어야 합니다.", "INSIGHTS_FORECAST_MONTH_INVALID", 400);
    }
    await ensureSignals(current.companyId, asOf.slice(0, 7), actorFor(session));
    const [inputs, companies, cards] = await Promise.all([
      companyInputs(current.companyId),
      allCompanyInputs(),
      repository.listLocationCards({
        companyId: current.companyId,
        tenantCompanyId: current.tenantCompanyId,
        lifecycle: "published"
      })
    ]);
    const analysis = deriveLocationAnalysis({
      observations: inputs.observations,
      signals: inputs.signals,
      asOf,
      forecastMonth
    });
    const scopes = deriveReportScopes(current.companyId, companies, { asOf });
    const visibleCards = cards.filter(businessVisibleArtifact);
    const publishedLocationReady = Boolean(visibleCards[0]?.cardId);
    const ready = analysis.state === "ready"
      && scopes.every((scope) => scope.state === "ready")
      && publishedLocationReady;
    const report = {
      state: ready ? "ready" : "insufficient-data",
      algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
      month: current.month,
      analysis,
      forecast: analysis.forecast,
      scopes,
      readiness: {
        ...analysis.readiness,
        state: ready ? "ready" : "insufficient-data",
        confidenceCauses: [
          ...analysis.readiness.confidenceCauses,
          ...scopes.filter((scope) => scope.state !== "ready").map((scope) => `${scope.label} 표본 ${scope.sampleCount}/${scope.minimumSampleCount}`),
          ...(publishedLocationReady ? [] : ["공개된 입지카드가 없습니다."])
        ]
      },
      locationCardId: visibleCards[0]?.cardId || "",
      cohort: deriveCohortDescriptor(inputs.company, inputs.observations)
    };
    const evidenceResult = await evidenceFor(
      current.companyId,
      inputs.observations,
      inputs.signals,
      analysis,
      actorFor(session),
      { reportCompanies: companies }
    );
    const safeEvidence = evidenceSummary(evidenceResult.evidence, analysis);
    const transitioned = await repository.transitionMonthlyReport(reportId, {
      expectedVersion: payload.expectedVersion || current.version,
      to: "draft",
      patch: {
        evidenceSnapshotId: evidenceResult.evidence.evidenceSnapshotId,
        evidenceSummary: safeEvidence,
        report,
        editorial: sanitizeEditorial(payload.editorial || current.editorial)
      }
    }, actorFor(session));
    return { ok: true, metadata: metadata(), report: await publicReport(transitioned.report, { admin: true, evidence: safeEvidence }) };
  }

  async function editReportDraft(session, reportId, payload = {}) {
    requireCapability("businessReport");
    requireAdmin(session);
    const current = await repository.getMonthlyReport(reportId);
    if (!current) throw insightsError("월간 리포트를 찾을 수 없습니다.", "INSIGHTS_REPORT_NOT_FOUND", 404);
    assertVisibleArtifact(current, "월간 리포트");
    await assertCompany(session, current.companyId, current.tenantCompanyId);
    const transitioned = await repository.transitionMonthlyReport(reportId, {
      expectedVersion: payload.expectedVersion,
      to: "draft",
      patch: { editorial: sanitizeEditorial({ ...current.editorial, ...(payload.editorial || payload) }) }
    }, actorFor(session));
    return { ok: true, metadata: metadata(), report: await publicReport(transitioned.report, { admin: true }) };
  }

  async function reviewMonthlyReport(session, reportId, payload = {}) {
    requireCapability("businessReport");
    requireAdmin(session);
    const current = await repository.getMonthlyReport(reportId);
    if (!current) throw insightsError("월간 리포트를 찾을 수 없습니다.", "INSIGHTS_REPORT_NOT_FOUND", 404);
    assertVisibleArtifact(current, "월간 리포트");
    await assertCompany(session, current.companyId, current.tenantCompanyId);
    const decision = cleanText(payload.decision, 40);
    let to;
    if (decision === "submit") to = "in-review";
    else if (decision === "approve") to = "reviewed";
    else if (["request-changes", "changes-requested"].includes(decision)) to = "changes-requested";
    else throw insightsError("지원하지 않는 검수 결정입니다.", "INSIGHTS_REVIEW_DECISION_INVALID");
    if (decision !== "submit") await recentStepUp(session);
    const transitioned = await repository.transitionMonthlyReport(reportId, {
      expectedVersion: payload.expectedVersion,
      to,
      patch: {
        review: {
          decision,
          reason: cleanText(payload.reason, 500),
          reviewedAt: nowIso(),
          reviewedBy: session.accountId
        }
      }
    }, actorFor(session));
    return { ok: true, metadata: metadata(), report: await publicReport(transitioned.report, { admin: true }) };
  }

  async function publishMonthlyReport(session, reportId, payload = {}) {
    requireCapability("businessReport");
    requireAdmin(session);
    await recentStepUp(session);
    const current = await repository.getMonthlyReport(reportId);
    if (!current) throw insightsError("월간 리포트를 찾을 수 없습니다.", "INSIGHTS_REPORT_NOT_FOUND", 404);
    assertVisibleArtifact(current, "월간 리포트");
    await assertCompany(session, current.companyId, current.tenantCompanyId);
    const content = current.report;
    const publishedCard = content?.locationCardId
      ? await repository.getLocationCard(content.locationCardId)
      : null;
    if (
      content?.state !== "ready"
      || content?.forecast?.state !== "ready"
      || !Array.isArray(content?.scopes)
      || content.scopes.length !== 4
      || content.scopes.some((scope) => scope.state !== "ready")
      || publishedCard?.lifecycle !== "published"
      || !businessVisibleArtifact(publishedCard)
      || publishedCard?.companyId !== current.companyId
      || publishedCard?.tenantCompanyId !== current.tenantCompanyId
    ) {
      throw insightsError("forecast, 4개 리포트 범위와 공개 입지카드 gate가 준비되기 전에는 공개할 수 없습니다.", "INSIGHTS_SAMPLE_GATE", 409);
    }
    assertPublishFreshness(content.analysis);
    const transitioned = await repository.transitionMonthlyReport(reportId, {
      expectedVersion: payload.expectedVersion,
      to: "published",
      patch: {}
    }, actorFor(session));
    return { ok: true, metadata: metadata(), report: await publicReport(transitioned.report, { admin: true }) };
  }

  async function listMonthlyReports(session, query = {}, context = {}) {
    requireCapability("businessReport");
    const companyId = cleanId(query.companyId, "companyId");
    const access = await assertCompany(session, companyId, query.tenantCompanyId, context);
    const admin = roleFor(session) === "admin";
    const month = query.month ? requiredMonth(query.month, "month") : "";
    const rows = await repository.listMonthlyReports({
      companyId,
      tenantCompanyId: admin ? "" : access.tenantCompanyId,
      month
    });
    const inputs = await companyInputs(companyId);
    const eligible = rows.filter(businessVisibleArtifact);
    const visible = admin ? eligible : eligible.filter((row) => row.lifecycle === "published");
    const reports = await Promise.all(visible.map((row) => publicReport(row, { admin, collecting: inputs.collecting })));
    return {
      ok: true,
      metadata: metadata(),
      state: reports[0]?.state || (eligible.length ? "not-published" : (inputs.collecting ? "collecting" : "not-collected")),
      readiness: reports[0]?.readiness || publicReadiness(null, inputs.collecting),
      reports,
      locationCardPath: "/app/location"
    };
  }

  async function workspace(session, query = {}, context = {}) {
    requireSession(session);
    const view = cleanText(query.view, 80);
    const locationView = ["business-location", "admin-location"].includes(view);
    const reportView = view === "business-report";
    if (locationView) requireCapability("locationCard");
    if (reportView) {
      requireCapability("businessReport");
    }
    const admin = roleFor(session) === "admin";
    if (!admin && cleanText(query.companyId, 160)) {
      throw insightsError("사업자는 workspace의 분석 대상을 임의로 변경할 수 없습니다.", "INSIGHTS_TENANT_FORBIDDEN", 403);
    }
    const tenantCompanyId = admin ? "" : sessionTenantId(session);
    const subjectRows = await freshService.listCompanies(session, tenantCompanyId, context);
    const subjects = subjectRows.map((company) => ({
      companyId: company.companyId,
      companyName: cleanText(company.companyName || company.name, 180),
      regionLabel: cleanText(company.regionLabel || company.region, 160)
    }));
    let companyId = admin ? cleanText(query.companyId, 160) : "";
    if (!companyId) companyId = subjects[0]?.companyId || "";
    if (!companyId) {
      return {
        ok: true,
        metadata: metadata(),
        view,
        state: "not-collected",
        readiness: publicReadiness(null, false),
        companyId: "",
        subjects,
        locationCard: null,
        monthlyReport: null,
        reportScopes: [],
        forecast: null,
        audit: { count: 0, latest: [] },
        allowedActions: admin ? ["request"] : [],
        locationCardPath: "/app/location"
      };
    }
    const [cardsEnvelope, reportsEnvelope] = await Promise.all([
      capabilities.locationCard
        ? listLocationCards(session, { companyId, tenantCompanyId: query.tenantCompanyId }, context)
        : Promise.resolve({ state: "not-published", readiness: publicReadiness(null, false), cards: [] }),
      capabilities.businessReport
        ? listMonthlyReports(session, { companyId, tenantCompanyId: query.tenantCompanyId, month: query.month || "" }, context)
        : Promise.resolve({ state: "not-published", readiness: publicReadiness(null, false), reports: [] })
    ]);
    const locationCard = cardsEnvelope.cards[0] || null;
    const monthlyReport = reportsEnvelope.reports[0] || null;
    const selectedState = reportView ? reportsEnvelope.state : cardsEnvelope.state;
    const selectedReadiness = reportView ? reportsEnvelope.readiness : cardsEnvelope.readiness;
    return {
      ok: true,
      metadata: metadata(),
      view,
      state: selectedState,
      readiness: selectedReadiness,
      companyId,
      subjects,
      locationCard,
      monthlyReport,
      reportScopes: monthlyReport?.scopes || [],
      forecast: monthlyReport?.forecast || locationCard?.forecast || null,
      audit: roleFor(session) === "admin" ? (monthlyReport?.audit || locationCard?.audit || { count: 0, latest: [] }) : undefined,
      allowedActions: admin ? (locationCard?.allowedActions || ["request"]) : [],
      locationCardPath: "/app/location"
    };
  }

  async function createSnapshot(session, label) {
    requireAdmin(session);
    await recentStepUp(session);
    const snapshot = await repository.createSnapshot(actorFor(session), label);
    return {
      ok: true,
      metadata: metadata(),
      snapshot: {
        snapshotId: snapshot.snapshotId,
        storeRevision: snapshot.storeRevision,
        label: snapshot.label,
        createdAt: snapshot.createdAt,
        fileCount: snapshot.files.length,
        checksum: snapshot.filesHash
      }
    };
  }

  async function listSnapshots(session) {
    requireAdmin(session);
    const snapshots = await repository.listSnapshots();
    return {
      ok: true,
      metadata: metadata(),
      snapshots: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        storeRevision: snapshot.storeRevision,
        label: snapshot.label,
        createdAt: snapshot.createdAt,
        fileCount: snapshot.files.length,
        checksum: snapshot.filesHash
      }))
    };
  }

  async function rollbackSnapshot(session, snapshotId) {
    requireAdmin(session);
    await recentStepUp(session);
    return { ...(await repository.rollbackSnapshot(snapshotId, actorFor(session))), metadata: metadata() };
  }

  return Object.freeze({
    metadata,
    workspace,
    requestLocationCard,
    listLocationCardRequests,
    createLocationDraft,
    editLocationDraft,
    createOrEditLocationDraft,
    reviewLocationCard,
    publishLocationCard,
    listLocationCards,
    createMonthlyReport,
    createReportDraft,
    editReportDraft,
    reviewMonthlyReport,
    publishMonthlyReport,
    listMonthlyReports,
    createSnapshot,
    listSnapshots,
    rollbackSnapshot,
    analysisInputs,
    actorFor
  });
}

module.exports = {
  actorFor,
  createInsightsService,
  roleFor,
  sanitizeEditorial
};
