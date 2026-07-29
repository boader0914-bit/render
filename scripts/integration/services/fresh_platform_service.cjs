"use strict";

const { cleanText } = require("../contracts/fresh_data.cjs");

const PROFILE_LABELS = Object.freeze({
  primaryName: "업체명",
  region: "지역",
  address: "주소",
  phone: "대표 전화",
  website: "웹사이트",
  notes: "검수 메모"
});

function platformError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function roleFor(session) {
  return session?.account?.role === "admin" ? "admin" : "b2b";
}

function requireSession(session) {
  if (!session?.accountId || !session?.account) {
    throw platformError("로그인이 필요합니다.", 401, "FRESH_AUTH_REQUIRED");
  }
  return session;
}

function requireAdmin(session) {
  requireSession(session);
  if (roleFor(session) !== "admin") {
    throw platformError("관리자 권한이 필요합니다.", 403, "FRESH_ROLE_FORBIDDEN");
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

function safeScalar(value) {
  if (value === null || value === undefined || value === "") return "미입력";
  const text = cleanText(value, 320);
  if (/^(?:[A-Za-z]:[\\/]|\/var\/|\/tmp\/|\/home\/|\\\\)/.test(text)) return "공개되지 않음";
  return text;
}

function latestObservation(rows, kind) {
  return rows.filter((row) => (row.observationType || row.kind) === kind)
    .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))[0] || null;
}

function observedValue(row) {
  if (!row) return null;
  const value = row.values ?? row.value;
  return value && typeof value === "object" && !Array.isArray(value) ? null : value;
}

function repeatObservationCount(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = [
      row.companyId,
      row.observationType || row.kind,
      row.targetDate,
      row.channel,
      row.productKey
    ].join("|");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function verifiedChanges(auditRows) {
  return auditRows
    .filter((row) => ["verified.approved", "verified.rejected"].includes(row.event))
    .flatMap((row) => {
      const before = row.details?.before?.profile || {};
      const after = row.details?.after?.profile || row.details?.after?.rejectedCandidate || {};
      return Object.keys(PROFILE_LABELS).filter((field) => before[field] !== after[field]).map((field) => ({
        changeId: `${row.auditId || row.eventId || "change"}:${field}`,
        fieldLabel: PROFILE_LABELS[field],
        previousValue: safeScalar(before[field]),
        currentValue: safeScalar(after[field]),
        changedAt: row.at || row.createdAt || row.occurredAt || ""
      }));
    })
    .filter((row) => row.changedAt)
    .slice(-40)
    .reverse();
}

function createFreshPlatformService(options = {}) {
  const repository = options.repository;
  const collectionService = options.collectionService;
  const worker = options.worker;
  const authService = options.authService;
  const clock = options.clock || (() => Date.now());
  const scheduleWork = typeof options.scheduleWork === "function" ? options.scheduleWork : (() => false);
  if (!repository || !collectionService || !worker || !authService) {
    throw new Error("Fresh platform service dependencies are required");
  }

  function notifyWorker(reason) {
    try {
      return scheduleWork(reason) !== false;
    } catch {
      // The run is already durable. A later bounded runtime pump or process
      // restart recovery can safely claim it without failing the HTTP mutation.
      return false;
    }
  }

  function metadata() {
    const provider = worker.diagnostics().provider;
    return {
      stage: 228,
      provisional: false,
      acceptance: "durable-synthetic-vertical-slice",
      dataBoundary: "fresh-integration-only",
      store: "glamping-datalab-v2-fresh-integration-store",
      source: "synthetic-fresh-collection",
      fixtureMode: false,
      providerCalls: Number(provider?.externalNetworkCalls || 0),
      syntheticProviderCalls: Number(provider?.syntheticCalls || 0),
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      processRestartRecovery: true
    };
  }

  async function tenantFor(session, requestedCompanyId = "", context = {}) {
    requireSession(session);
    if (roleFor(session) === "admin") {
      const requested = cleanText(requestedCompanyId, 160);
      if (!requested) return "";
      const access = await authService.assertCompanyAccess(session, requested, context);
      return cleanText(access?.company?.companyId || requested, 160);
    }
    const primary = session.memberships?.[0];
    if (!primary?.companyId) {
      throw platformError("활성 업체 소속이 필요합니다.", 403, "FRESH_MEMBERSHIP_REQUIRED");
    }
    const requested = cleanText(requestedCompanyId || primary.companyId, 160);
    if (requested !== primary.companyId) {
      throw platformError("다른 업체의 통합 데이터에는 접근할 수 없습니다.", 403, "FRESH_TENANT_FORBIDDEN");
    }
    await authService.assertCompanyAccess(session, requested, context);
    return requested;
  }

  async function detailFor(projection) {
    const companyId = projection.companyId;
    const [observations, verified, audits] = await Promise.all([
      repository.listObservations({ companyId, limit: 100_000 }),
      repository.getCompany(companyId, { projection: "verified" }),
      repository.listAudit({ companyId, limit: 1000 })
    ]);
    const derived = projection.dataQuality || {};
    const completeness = derived.dataCompleteness || {};
    const freshness = derived.freshness || {};
    const confidence = derived.confidence || {};
    const profile = verified?.status === "approved" ? verified.profile || {} : {};
    const profileFields = Object.entries(PROFILE_LABELS).filter(([field]) => cleanText(profile[field], 1));
    const latestAt = freshness.latestObservedAt || projection.collection?.lastObservedAt || "";
    const validUntil = latestAt
      ? new Date(Date.parse(latestAt) + 7 * 24 * 60 * 60 * 1000).toISOString()
      : "";
    const sources = new Set(observations.map((row) => row.source).filter(Boolean));
    const repeatCount = repeatObservationCount(observations);
    const firstObservedAt = observations.map((row) => row.observedAt).filter(Boolean).sort()[0] || "";
    const missingModes = Array.isArray(completeness.missingModes) ? completeness.missingModes : [];
    const enrichmentAction = projection.dataQuality?.enrichmentCta?.action || "none";
    const verificationRequired = enrichmentAction === "request-verification";
    return {
      state: Number(completeness.score || 0) === 100 ? "ready" : "partial",
      completeness: {
        state: Number(completeness.score || 0) === 100 ? "complete" : "partial",
        displayValue: `${Number(completeness.score || 0)}%`,
        detail: `quick/detail/OTA ${Number((completeness.collectedModes || []).length)} / 3 계층 수집`,
        verifiedFields: profileFields.length,
        totalFields: Object.keys(PROFILE_LABELS).length,
        missingFields: missingModes
      },
      freshness: {
        state: freshness.state || "missing",
        displayValue: freshness.state === "fresh" ? "최신" : (freshness.state || "미수집"),
        detail: latestAt ? `마지막 관측 ${latestAt}` : "신규 관측이 필요합니다.",
        observedAt: latestAt,
        validUntil
      },
      confidence: {
        state: confidence.level || "insufficient",
        displayValue: `${Number(confidence.score || 0)}점`,
        detail: confidence.verified ? "수동 검수와 신규 관측을 반영했습니다." : "신규 관측 기반이며 수동 검수를 기다립니다.",
        basis: `수집 완전성 ${Number(completeness.score || 0)}%, 검수 ${confidence.verified ? "승인" : "대기"}`
      },
      provenance: {
        summary: `합성 신규 수집 ${sources.size}개 provider 출처 · raw 경로 비공개`,
        sourceCount: sources.size,
        lastVerifiedAt: verified?.reviewedAt || ""
      },
      verifiedValues: profileFields.map(([field, label]) => ({
        field,
        label,
        value: safeScalar(profile[field]),
        verified: true,
        verifiedAt: verified.reviewedAt || ""
      })),
      changes: verifiedChanges(audits),
      enrichment: {
        state: projection.dataQuality?.enrichmentCta?.required ? "required" : "complete",
        ctaLabel: verificationRequired
          ? "관리자 검수 요청하기"
          : (missingModes.length ? "신규 수집으로 보강하기" : "보강 완료"),
        detail: verificationRequired
          ? "필수 수집 계층은 완료되었으며 수동 검수 승인을 기다립니다."
          : (missingModes.length ? `${missingModes.join(", ")} 계층을 보강해야 합니다.` : "필수 수집과 검수가 모두 준비되었습니다."),
        missingFields: missingModes
      },
      observations: {
        displayCount: `${observations.length}건`,
        repeatCount,
        firstObservedAt,
        lastObservedAt: latestAt,
        summary: repeatCount ? `동일 관측 키의 후속 시점 ${repeatCount}건을 보존했습니다.` : "첫 관측 세트를 보존했습니다."
      }
    };
  }

  async function publicCompany(projection) {
    const observations = await repository.listObservations({ companyId: projection.companyId, limit: 100_000 });
    const detail = await detailFor(projection);
    const rank = observedValue(latestObservation(observations, "profile.rank"));
    const reviewCount = observedValue(latestObservation(observations, "profile.review-count"));
    const prices = observations
      .filter((row) => (row.observationType || row.kind) === "product.price")
      .map(observedValue).map(Number).filter(Number.isFinite);
    const averagePrice = prices.length ? Math.round(prices.reduce((sum, value) => sum + value, 0) / prices.length) : null;
    return {
      companyId: projection.companyId,
      companyName: projection.name,
      regionLabel: projection.region,
      category: "glamping",
      status: detail.state === "ready" ? "fresh" : "partial",
      freshAt: projection.collection?.lastObservedAt || "",
      freshnessLabel: detail.freshness.displayValue,
      observationCount: Number(projection.collection?.observationCount || observations.length),
      dataQuality: detail.state === "ready" ? "complete" : "partial",
      missingFields: detail.completeness.missingFields,
      businessValues: {
        naverRank: Number.isFinite(Number(rank)) ? Number(rank) : null,
        averagePrice,
        weeklyRevenue: null,
        soldOutRate: null,
        reviewCount: Number.isFinite(Number(reviewCount)) ? Number(reviewCount) : null
      },
      freshDetail: detail,
      sourceLabel: "신규 합성 수집",
      synthetic: true
    };
  }

  async function listCompanies(session, requestedTenantCompanyId = "", context = {}) {
    const tenantCompanyId = await tenantFor(session, requestedTenantCompanyId, context);
    const projections = roleFor(session) === "admin"
      ? await repository.listCompanies({ projection: "business-safe" })
      : await repository.listBusinessSafeCompanies(tenantCompanyId);
    return Promise.all(projections.map(publicCompany));
  }

  async function getCompany(session, companyId, requestedTenantCompanyId = "", context = {}) {
    const tenantCompanyId = await tenantFor(session, requestedTenantCompanyId, context);
    const projection = roleFor(session) === "admin"
      ? await repository.getCompany(companyId, { projection: "business-safe" })
      : await repository.getBusinessSafeCompany(companyId, tenantCompanyId);
    return publicCompany(projection);
  }

  async function listJobs(session) {
    requireSession(session);
    const rows = await repository.listRuns(roleFor(session) === "admin" ? {} : { actorAccountId: session.accountId });
    return rows.map(collectionService.projectStage227Job)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async function submitCollection(session, payload = {}, context = {}) {
    requireSession(session);
    const role = roleFor(session);
    const kind = cleanText(payload.kind || (role === "admin" ? "admin-collection" : "business-search"), 48);
    if (role === "admin" && kind !== "admin-collection") {
      throw platformError("관리자는 관리자 수집만 실행할 수 있습니다.", 403, "FRESH_ROLE_FORBIDDEN");
    }
    if (role === "b2b" && !["business-search", "business-my-lodge"].includes(kind)) {
      throw platformError("사업자 수집 유형이 아닙니다.", 403, "FRESH_ROLE_FORBIDDEN");
    }
    const tenantCompanyId = await tenantFor(session, payload.tenantCompanyId, context);
    const actor = actorFor(session);
    const submitted = await collectionService.submit({
      ...payload,
      kind,
      tenantCompanyId,
      targetDate: cleanText(payload.targetDate, 16) || new Date(clock()).toISOString().slice(0, 10)
    }, actor);
    if (!["completed", "cancelled", "failed"].includes(submitted.run?.status)) {
      notifyWorker("collection-submitted");
    }
    return {
      ...submitted,
      outcome: submitted.run.status
    };
  }

  async function getJob(session, clientRequestId) {
    requireSession(session);
    return collectionService.getByClientRequestId(clientRequestId, actorFor(session));
  }

  async function cancelJob(session, clientRequestId, payload = {}) {
    const existing = await getJob(session, clientRequestId);
    const cancelled = await collectionService.cancel(existing.run.runId, payload, actorFor(session));
    if (cancelled.run?.status === "cancel-requested") notifyWorker("collection-cancel-requested");
    return { ...cancelled, outcome: cancelled.run?.status || "cancel-requested" };
  }

  async function resumeJob(session, clientRequestId, payload = {}) {
    const existing = await getJob(session, clientRequestId);
    const resumed = await collectionService.resume(existing.run.runId, payload, actorFor(session));
    if (!["completed", "cancelled", "failed"].includes(resumed.run?.status)) {
      notifyWorker("collection-resumed");
    }
    return { ...resumed, outcome: resumed.run?.status || "queued" };
  }

  async function reviewCompany(session, companyId, payload = {}) {
    requireAdmin(session);
    if (typeof authService.assertRecentReauthentication === "function") {
      authService.assertRecentReauthentication(session);
    }
    const reviewed = await repository.reviewVerifiedProfile({ ...payload, companyId }, actorFor(session));
    await repository.refreshDerivedProfile(companyId, actorFor(session));
    return { ok: true, ...reviewed, company: await getCompany(session, companyId) };
  }

  async function createSnapshot(session, label) {
    requireAdmin(session);
    const row = await repository.createSnapshot(actorFor(session), label);
    return { ok: true, snapshot: {
      snapshotId: row.snapshotId,
      snapshotKind: row.snapshotKind,
      storeRevision: row.storeRevision,
      label: row.label,
      createdAt: row.createdAt,
      fileCount: row.fileCount
    } };
  }

  async function listSnapshots(session) {
    requireAdmin(session);
    const rows = await repository.listSnapshots();
    return { ok: true, snapshots: rows.map((row) => ({
      snapshotId: row.snapshotId,
      snapshotKind: row.snapshotKind,
      storeRevision: row.storeRevision,
      label: row.label,
      createdAt: row.createdAt,
      fileCount: row.fileCount
    })) };
  }

  async function rollbackSnapshot(session, snapshotId) {
    requireAdmin(session);
    if (typeof authService.assertRecentReauthentication === "function") {
      authService.assertRecentReauthentication(session);
    }
    return repository.rollbackSnapshot(snapshotId, actorFor(session));
  }

  return Object.freeze({
    metadata,
    listCompanies,
    getCompany,
    listJobs,
    submitCollection,
    getJob,
    cancelJob,
    resumeJob,
    reviewCompany,
    createSnapshot,
    listSnapshots,
    rollbackSnapshot,
    actorFor
  });
}

module.exports = {
  createFreshPlatformService,
  repeatObservationCount,
  safeScalar,
  verifiedChanges
};
