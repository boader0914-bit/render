"use strict";

const crypto = require("node:crypto");
const { entitlementsForRole } = require("../contracts/auth.cjs");
const {
  CORE_JOB_KINDS,
  CORE_ROLES,
  cleanClientRequestId,
  cleanText,
  normalizeV2CollectionMode,
  normalizeV2DetailRankRanges,
  normalizeV2ProductMode,
  projectV2SearchHistoryEntry,
  provisionalMetadata,
  publicJob,
  stableRequestSignature
} = require("../contracts/core_ui.cjs");
const {
  COLLECTION_MODES,
  COLLECTION_PURPOSES,
  PRODUCT_MODES,
  createV2CollectionPlan
} = require("../contracts/v2_collection_plan.cjs");

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

function coreError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicCompany(company = {}) {
  return {
    companyId: cleanText(company.companyId, 160),
    companyName: cleanText(company.companyName || company.name, 180),
    regionLabel: cleanText(company.regionLabel || company.region, 180),
    category: cleanText(company.category, 80),
    status: cleanText(company.status || "fresh", 32),
    freshAt: cleanText(company.freshAt, 40),
    freshnessLabel: cleanText(company.freshnessLabel, 80),
    observationCount: nullableNumber(company.observationCount),
    dataQuality: cleanText(company.dataQuality || "complete", 32),
    missingFields: (Array.isArray(company.missingFields) ? company.missingFields : [])
      .map((value) => cleanText(value, 80)).filter(Boolean).slice(0, 24),
    businessValues: {
      naverRank: nullableNumber(company.businessValues?.naverRank),
      averagePrice: nullableNumber(company.businessValues?.averagePrice),
      weeklyRevenue: nullableNumber(company.businessValues?.weeklyRevenue),
      soldOutRate: nullableNumber(company.businessValues?.soldOutRate),
      reviewCount: nullableNumber(company.businessValues?.reviewCount)
    },
    freshDetail: company.freshDetail ? JSON.parse(JSON.stringify(company.freshDetail)) : null,
    sourceLabel: "신규 수집",
    synthetic: Boolean(company.synthetic)
  };
}

function publicInterest(row = {}, company = null) {
  return {
    interestId: row.interestId || "",
    companyId: row.companyId || "",
    company: company ? publicCompany(company) : null,
    createdAt: row.createdAt || ""
  };
}

function publicLocationCardRequest(row = {}) {
  return {
    requestId: row.requestId || "",
    clientRequestId: row.clientRequestId || "",
    companyId: row.companyId || "",
    status: row.status || "queued",
    createdAt: row.createdAt || "",
    provisional: true
  };
}

function publicTourismRequest(row = {}) {
  return {
    requestId: row.requestId || "",
    clientRequestId: row.clientRequestId || "",
    regionCode: row.regionCode || "",
    status: row.status || "queued",
    createdAt: row.createdAt || "",
    provisional: true
  };
}

function createCoreService(options = {}) {
  const repository = options.repository;
  const authService = options.authService;
  const freshDataService = options.freshDataService || null;
  const freshRepository = options.freshRepository || null;
  const insightsService = options.insightsService || null;
  const clock = options.clock || (() => Date.now());
  const idFactory = options.idFactory || ((prefix) => `${prefix}_${crypto.randomUUID()}`);
  if (!repository || !authService) throw new Error("Core service dependencies are required");

  function nowIso() {
    return new Date(clock()).toISOString();
  }

  function kstDate(offsetDays = 0) {
    return new Date(clock() + (9 * 60 * 60 * 1000) + (Number(offsetDays || 0) * 86_400_000))
      .toISOString()
      .slice(0, 10);
  }

  function metadata() {
    if (freshDataService) return freshDataService.metadata();
    return provisionalMetadata({ fixtureMode: repository.currentUnsafe().fixtureMode });
  }

  function assertFreshCompatibility() {
    const current = metadata();
    if (!freshDataService || !freshRepository) {
      throw coreError(
        "The V2 compatibility API is available only with the fresh integration store.",
        404,
        "CORE_FRESH_COMPATIBILITY_NOT_AVAILABLE"
      );
    }
    if (current.fixtureMode === true || current.providerMode === "synthetic" || current.source === "synthetic-test-data") {
      throw coreError(
        "Synthetic collection results are not exposed through the V2 compatibility API.",
        503,
        "CORE_SYNTHETIC_COMPATIBILITY_DISABLED"
      );
    }
    if (Number(current.legacyRuntimeReads || 0) !== 0 || Number(current.legacyRuntimeCopies || 0) !== 0) {
      throw coreError(
        "The fresh-only compatibility boundary is not available.",
        503,
        "CORE_FRESH_BOUNDARY_INVALID"
      );
    }
    return current;
  }

  function requireSession(session) {
    if (!session || !session.accountId || !session.account) {
      throw coreError("로그인이 필요합니다.", 401, "CORE_AUTH_REQUIRED");
    }
    return session;
  }

  function roleFor(session) {
    return session.account?.role === CORE_ROLES.admin ? CORE_ROLES.admin : CORE_ROLES.business;
  }

  function requireRole(session, expected) {
    requireSession(session);
    if (roleFor(session) !== expected) {
      throw coreError("이 역할에서는 요청한 기능을 사용할 수 없습니다.", 403, "CORE_ROLE_FORBIDDEN");
    }
  }

  async function tenantFor(session, requestedCompanyId, context = {}) {
    requireSession(session);
    const role = roleFor(session);
    const requested = cleanText(requestedCompanyId, 160);
    if (role === CORE_ROLES.admin) {
      if (!requested) {
        return {
          companyId: "",
          companyName: "",
          membership: null,
          entitlements: entitlementsForRole(CORE_ROLES.admin, "pro")
        };
      }
      const access = await authService.assertCompanyAccess(session, requested, context);
      return {
        companyId: access.company.companyId,
        companyName: access.company.name || access.company.companyName || "",
        membership: access.membership,
        entitlements: entitlementsForRole(CORE_ROLES.admin, access.membership?.plan || "pro")
      };
    }
    const primary = session.memberships?.[0];
    if (!primary?.companyId) {
      throw coreError("활성 업체 소속이 필요합니다.", 403, "CORE_MEMBERSHIP_REQUIRED");
    }
    const companyId = requested || primary.companyId;
    const access = await authService.assertCompanyAccess(session, companyId, context);
    return {
      companyId: access.company.companyId,
      companyName: access.company.name || access.company.companyName || primary.companyName || "",
      membership: access.membership,
      entitlements: access.entitlements
    };
  }

  function ownedRows(rows, session) {
    const accountId = session.accountId;
    const fixtureMode = repository.currentUnsafe().fixtureMode;
    return rows.filter((row) => row.actorAccountId === accountId || (fixtureMode && row.fixtureTemplate === true));
  }

  function fixtureHistoryFor(session) {
    if (!repository.currentUnsafe().fixtureMode) return [];
    return repository.currentUnsafe().fixtureHistory.map((entry) => ({
      ...projectV2SearchHistoryEntry(entry),
      synthetic: true
    }));
  }

  async function workspace(session, query = {}, context = {}) {
    requireSession(session);
    const role = roleFor(session);
    const tenant = await tenantFor(session, query.tenantCompanyId, context);
    const store = repository.currentUnsafe();
    const companies = freshDataService
      ? (await freshDataService.listCompanies(session, tenant.companyId, context)).map(publicCompany)
      : store.companies.map(publicCompany);
    const jobs = freshDataService
      ? await freshDataService.listJobs(session)
      : ownedRows(store.jobs, session).map(publicJob)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const runtimeHistory = jobs
      .filter((job) => ["completed", "cancelled", "failed"].includes(job.status))
      .map((job) => projectV2SearchHistoryEntry({
        id: job.clientRequestId,
        runId: job.clientRequestId,
        keyword: job.keyword,
        clientRequestId: job.clientRequestId,
        runLabel: job.keyword || job.kind,
        regionLabel: "",
        detailRankRanges: job.detailRankRanges,
        collectionMode: job.collectionMode,
        collectionModeLabel: job.collectionMode === "fast" ? "빠른 순위" : "정밀 분석",
        status: job.status,
        createdAt: job.createdAt,
        completedAt: job.completedAt || job.cancelledAt,
        quotaCounted: job.status === "completed",
        resultSummary: job.resultSummary
      }));
    const history = [...fixtureHistoryFor(session), ...runtimeHistory]
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const interestRows = freshRepository?.listInterests
      ? await freshRepository.listInterests({ actorAccountId: session.accountId, tenantCompanyId: tenant.companyId })
      : ownedRows(store.interests, session);
    const interests = interestRows.map((row) => publicInterest(
      row,
      companies.find((company) => company.companyId === row.companyId) || null
    ));
    const locationCardRequests = insightsService
      ? await insightsService.listLocationCardRequests(session, context)
      : ownedRows(store.locationCardRequests, session).map(publicLocationCardRequest);
    const tourismRequests = role === CORE_ROLES.admin
      ? ownedRows(store.tourismRequests, session).map(publicTourismRequest)
      : [];
    const activeJobCount = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status)).length;
    const completedJobCount = jobs.filter((job) => job.status === "completed").length + fixtureHistoryFor(session).length;
    const partialCount = companies.filter((company) => company.dataQuality === "partial").length;
    const stateKind = companies.length || jobs.length || history.length
      ? (partialCount ? "partial" : "ready")
      : "empty";
    const selectedCompanyId = cleanText(query.companyId, 160);
    const selectedCompany = selectedCompanyId
      ? companies.find((company) => company.companyId === selectedCompanyId) || null
      : null;
    const runtimeMetadata = metadata();
    const connectorProjection = freshDataService && Array.isArray(runtimeMetadata.connectors)
      ? runtimeMetadata.connectors
      : store.connectors;

    return {
      ok: true,
      metadata: runtimeMetadata,
      role,
      view: cleanText(query.view || (role === CORE_ROLES.admin ? "admin-overview" : "business-onboarding"), 80),
      state: {
        kind: stateKind,
        message: stateKind === "empty"
          ? "통합 저장소가 비어 있습니다. 신규 수집을 요청해 시작하세요."
          : (stateKind === "partial" ? "일부 신규 수집 필드가 비어 있습니다." : "신규 수집 결과를 표시합니다."),
        partialCount
      },
      tenant: {
        companyId: tenant.companyId,
        companyName: tenant.companyName,
        plan: tenant.entitlements?.plan || (role === CORE_ROLES.admin ? "pro" : "free"),
        entitlements: tenant.entitlements || null
      },
      metrics: {
        companyCount: companies.length,
        freshCompanyCount: companies.length,
        activeJobCount,
        completedJobCount,
        interestCount: interests.length,
        locationCardRequestCount: locationCardRequests.length,
        tourismRequestCount: tourismRequests.length
      },
      companies,
      selectedCompany,
      jobs,
      history,
      interests,
      locationCardRequests,
      tourismRequests,
      connectors: role === CORE_ROLES.admin ? JSON.parse(JSON.stringify(connectorProjection)) : {},
      onboarding: {
        steps: [
          { id: "account", status: "completed" },
          { id: "fresh-collection", status: jobs.length || history.length ? "completed" : "pending" },
          { id: "interest", status: interests.length ? "completed" : "pending" },
          { id: "location-card", status: locationCardRequests.length ? "completed" : "pending" }
        ]
      },
      permissions: {
        canSearch: role === CORE_ROLES.business,
        canRequestLocationCard: role === CORE_ROLES.business,
        canManageCollection: role === CORE_ROLES.admin,
        canRequestTourism: role === CORE_ROLES.admin
      }
    };
  }

  async function createJob(session, payload = {}, context = {}) {
    requireSession(session);
    const role = roleFor(session);
    const kind = cleanText(payload.kind, 48);
    if (!CORE_JOB_KINDS.includes(kind)) throw coreError("지원하지 않는 작업 종류입니다.", 400, "CORE_JOB_KIND_INVALID");
    if (kind.startsWith("business-") && role !== CORE_ROLES.business) requireRole(session, CORE_ROLES.business);
    if (kind === "admin-collection" && role !== CORE_ROLES.admin) requireRole(session, CORE_ROLES.admin);
    const clientRequestId = cleanClientRequestId(payload.clientRequestId);
    const tenant = await tenantFor(session, payload.tenantCompanyId, context);
    const keyword = cleanText(payload.keyword || payload.lodgingName, 180);
    if (kind.startsWith("business-") && !keyword) {
      throw coreError("검색어 또는 숙소명을 입력해야 합니다.", 400, "CORE_KEYWORD_REQUIRED");
    }
    if (freshDataService && !keyword) {
      throw coreError("실수집 대상 업체명을 입력해야 합니다.", 400, "CORE_KEYWORD_REQUIRED");
    }
    if (freshDataService) {
      const result = await freshDataService.submitCollection(session, {
        ...payload,
        clientRequestId,
        kind,
        keyword,
        targetName: keyword,
        discoveryQuery: cleanText(payload.discoveryQuery || keyword, 180),
        rankingQuery: cleanText(payload.rankingQuery || keyword, 180),
        tenantCompanyId: tenant.companyId,
        collectionMode: normalizeV2CollectionMode(payload.collectionMode),
        productMode: normalizeV2ProductMode(payload.productMode)
      }, context);
      return {
        ok: true,
        idempotent: Boolean(result.idempotent),
        outcome: result.outcome,
        job: result.job,
        metadata: metadata()
      };
    }
    const signature = stableRequestSignature({ ...payload, kind, tenantCompanyId: tenant.companyId, keyword });
    const existing = repository.currentUnsafe().jobs.find((row) => (
      row.actorAccountId === session.accountId && row.clientRequestId === clientRequestId
    ));
    if (existing) {
      if (existing.requestSignature !== signature) {
        throw coreError("같은 clientRequestId를 다른 요청에 재사용할 수 없습니다.", 409, "CORE_IDEMPOTENCY_CONFLICT");
      }
      return { ok: true, metadata: metadata(), idempotent: true, job: publicJob(existing) };
    }
    const createdAt = nowIso();
    const estimatedTotalSeconds = kind === "admin-collection" ? 120 : 90;
    const job = {
      jobId: idFactory("core_job"),
      actorAccountId: session.accountId,
      tenantCompanyId: tenant.companyId,
      clientRequestId,
      requestSignature: signature,
      kind,
      keyword,
      collectionMode: normalizeV2CollectionMode(payload.collectionMode),
      productMode: normalizeV2ProductMode(payload.productMode),
      detailRankRanges: normalizeV2DetailRankRanges(
        payload.detailRankRanges,
        kind === "business-my-lodge" ? "1-5" : "1-10"
      ),
      status: "running",
      progress: 24,
      estimatedTotalSeconds,
      remainingSeconds: estimatedTotalSeconds,
      estimatedCompleteAt: new Date(clock() + estimatedTotalSeconds * 1000).toISOString(),
      currentStage: "fresh-collection-requested",
      createdAt,
      startedAt: createdAt,
      completedAt: "",
      cancelledAt: "",
      cancelReason: "",
      resultSummary: {},
      result: null
    };
    repository.transaction("core-job-create", (store) => {
      store.jobs.push(job);
      return job;
    });
    return { ok: true, metadata: metadata(), idempotent: false, job: publicJob(job) };
  }

  async function estimateCollection(session, payload = {}, context = {}) {
    requireSession(session);
    await tenantFor(session, payload.tenantCompanyId, context);
    const keyword = cleanText(payload.keyword || payload.lodgingName || payload.companyName, 180);
    const checkIn = cleanText(payload.checkIn, 16) || kstDate(0);
    const rawRangeDays = Number(payload.bookingDays ?? payload.bookingRangeDays);
    const rangeDays = Math.max(1, Math.min(31, Number.isFinite(rawRangeDays) ? Math.round(rawRangeDays) : 7));
    const checkOut = cleanText(payload.checkOut, 16) || kstDate(rangeDays - 1);
    const searchMode = cleanText(payload.searchMode, 32).toLowerCase() === "company" ? "company" : "keyword";
    const plan = createV2CollectionPlan({
      ...payload,
      keyword: keyword || "수집 대상",
      checkIn,
      checkOut,
      collectionMode: normalizeV2CollectionMode(payload.collectionMode),
      productMode: normalizeV2ProductMode(payload.productMode)
    }, { now: clock() });
    const stages = plan.stages.map((stage, index) => ({
      ...stage,
      status: index === 0 ? "active" : "pending",
      progress: index === 0 ? 1 : 0
    }));
    return {
      keyword,
      checkIn: plan.checkIn,
      checkOut: plan.checkOut,
      searchMode,
      productMode: plan.productMode,
      collectionMode: plan.collectionMode,
      collectionPurpose: plan.collectionPurpose,
      collectionPurposeLabel: COLLECTION_PURPOSES[plan.collectionPurpose] || COLLECTION_PURPOSES.revenue_detail,
      collectionProfile: plan.collectionProfile,
      collectionProfileLabel: plan.collectionPurpose === "basic_db"
        ? "기본정보 중심"
        : (plan.collectionPurpose === "demand_location" ? "수요·입지 중심" : "상세 매출 중심"),
      collectionProfileNote: plan.collectionPurpose === "basic_db"
        ? "업체 기본정보와 대표 상품을 확인합니다."
        : (plan.collectionPurpose === "demand_location"
          ? "지역 수요와 입지 신호를 확인합니다."
          : "날짜별 상품·재고·가격과 OTA 노출을 확인합니다."),
      collectRegional: plan.collectRegional,
      collectOta: plan.collectOta,
      collectBookingStock: plan.collectBookingStock,
      collectWeeklyRange: plan.collectWeeklyRange,
      detailRankRanges: plan.detailRankRanges,
      bookingRangeDays: plan.bookingRangeDays,
      bookingRangePlaceLimit: plan.bookingRangePlaceLimit,
      elapsedSeconds: 0,
      remainingSeconds: plan.estimatedTotalSeconds,
      estimatedTotalSeconds: plan.estimatedTotalSeconds,
      estimatedProgress: 1,
      estimatedCompleteAt: plan.estimatedCompleteAt,
      currentStage: stages[0] || null,
      stages,
      estimateBasis: {
        searchMode,
        searchModeLabel: searchMode === "company" ? "업체명" : "키워드",
        productMode: plan.productMode,
        productModeLabel: PRODUCT_MODES[plan.productMode] || PRODUCT_MODES.all,
        collectionPurpose: plan.collectionPurpose,
        collectionPurposeLabel: COLLECTION_PURPOSES[plan.collectionPurpose] || COLLECTION_PURPOSES.revenue_detail,
        collectionProfile: plan.collectionProfile,
        collectionMode: plan.collectionMode,
        collectionModeLabel: COLLECTION_MODES[plan.collectionMode] || COLLECTION_MODES.precision,
        detailRankRanges: plan.detailRankRanges,
        bookingRangeDays: plan.bookingRangeDays,
        bookingRangePlaceLimit: plan.bookingRangePlaceLimit,
        rankRangeCount: plan.detailPlaceLimit,
        timing: plan.timing
      },
      dataBoundary: "fresh-only"
    };
  }

  function jobFor(session, clientRequestId) {
    requireSession(session);
    const id = cleanClientRequestId(clientRequestId);
    if (freshDataService) {
      return freshDataService.getJob(session, id).then((result) => ({
        ok: true,
        job: result.job,
        metadata: metadata()
      }));
    }
    const row = repository.currentUnsafe().jobs.find((job) => (
      job.actorAccountId === session.accountId && job.clientRequestId === id
    ));
    if (!row) throw coreError("작업을 찾을 수 없습니다.", 404, "CORE_JOB_NOT_FOUND");
    return { ok: true, metadata: metadata(), job: publicJob(row) };
  }

  function cancelJob(session, clientRequestId, payload = {}) {
    requireSession(session);
    const id = cleanClientRequestId(clientRequestId);
    if (freshDataService) {
      return freshDataService.cancelJob(session, id, payload).then((result) => ({
        ok: true,
        idempotent: Boolean(result.idempotent),
        job: result.job,
        metadata: metadata()
      }));
    }
    const store = repository.currentUnsafe();
    const row = store.jobs.find((job) => job.actorAccountId === session.accountId && job.clientRequestId === id);
    if (!row) throw coreError("작업을 찾을 수 없습니다.", 404, "CORE_JOB_NOT_FOUND");
    if (row.status === "cancelled") return { ok: true, metadata: metadata(), idempotent: true, job: publicJob(row) };
    if (["completed", "failed"].includes(row.status)) {
      throw coreError("이미 종료된 작업은 취소할 수 없습니다.", 409, "CORE_JOB_TERMINAL");
    }
    repository.transaction("core-job-cancel", () => {
      row.status = "cancelled";
      row.progress = Math.max(0, Math.min(99, Number(row.progress || 0)));
      row.remainingSeconds = 0;
      row.estimatedCompleteAt = "";
      row.currentStage = "cancelled";
      row.cancelReason = cleanText(payload.reason || "user-requested", 160);
      row.cancelledAt = nowIso();
      return row;
    });
    return { ok: true, metadata: metadata(), idempotent: false, job: publicJob(row) };
  }

  function resumeJob(session, clientRequestId, payload = {}) {
    requireSession(session);
    const id = cleanClientRequestId(clientRequestId);
    if (!freshDataService) {
      throw coreError("영구 fresh worker가 구성되지 않아 작업을 재개할 수 없습니다.", 503, "CORE_RESUME_NOT_CONFIGURED");
    }
    return freshDataService.resumeJob(session, id, payload).then((result) => ({
      ok: true,
      idempotent: Boolean(result.idempotent),
      job: result.job,
      metadata: metadata()
    }));
  }

  async function addInterest(session, payload = {}, context = {}) {
    requireRole(session, CORE_ROLES.business);
    const tenant = await tenantFor(session, payload.tenantCompanyId, context);
    const companyId = cleanText(payload.companyId, 160);
    const company = freshDataService
      ? await freshDataService.getCompany(session, companyId, tenant.companyId, context).catch((error) => {
        if (error.statusCode === 404) return null;
        throw error;
      })
      : repository.currentUnsafe().companies.find((row) => row.companyId === companyId);
    if (!company) throw coreError("신규 수집 업체를 찾을 수 없습니다.", 404, "CORE_COMPANY_NOT_FOUND");
    if (freshRepository?.addInterest) {
      const saved = await freshRepository.addInterest({
        actorAccountId: session.accountId,
        tenantCompanyId: tenant.companyId,
        companyId
      }, { type: "account", accountId: session.accountId, role: roleFor(session) });
      return {
        ok: true,
        metadata: metadata(),
        idempotent: Boolean(saved.idempotent),
        interest: publicInterest(saved.interest, company)
      };
    }
    const existing = repository.currentUnsafe().interests.find((row) => (
      row.actorAccountId === session.accountId && row.companyId === companyId
    ));
    if (existing) return { ok: true, metadata: metadata(), idempotent: true, interest: publicInterest(existing, company) };
    const row = {
      interestId: idFactory("core_interest"),
      actorAccountId: session.accountId,
      companyId,
      createdAt: nowIso()
    };
    repository.transaction("core-interest-add", (store) => { store.interests.push(row); return row; });
    return { ok: true, metadata: metadata(), idempotent: false, interest: publicInterest(row, company) };
  }

  async function removeInterest(session, companyId, payload = {}, context = {}) {
    requireRole(session, CORE_ROLES.business);
    const tenant = await tenantFor(session, payload.tenantCompanyId, context);
    const target = cleanText(companyId, 160);
    if (freshRepository?.removeInterest) {
      const result = await freshRepository.removeInterest({
        actorAccountId: session.accountId,
        tenantCompanyId: tenant.companyId,
        companyId: target
      }, { type: "account", accountId: session.accountId, role: roleFor(session) });
      return { ok: true, metadata: metadata(), removed: Number(result.removed || 0), idempotent: Boolean(result.idempotent) };
    }
    let removed = 0;
    repository.transaction("core-interest-remove", (store) => {
      const before = store.interests.length;
      store.interests = store.interests.filter((row) => !(
        row.actorAccountId === session.accountId && row.companyId === target
      ));
      removed = before - store.interests.length;
      return removed;
    });
    return { ok: true, metadata: metadata(), removed, idempotent: removed === 0 };
  }

  async function createLocationCardRequest(session, payload = {}, context = {}) {
    requireRole(session, CORE_ROLES.business);
    const tenant = await tenantFor(session, payload.tenantCompanyId, context);
    const clientRequestId = cleanClientRequestId(payload.clientRequestId);
    const companyId = cleanText(payload.companyId, 160);
    const companyExists = freshDataService
      ? await freshDataService.getCompany(session, companyId, tenant.companyId, context)
        .then(() => true, (error) => {
          if (error.statusCode === 404) return false;
          throw error;
        })
      : repository.currentUnsafe().companies.some((row) => row.companyId === companyId);
    if (!companyExists) {
      throw coreError("신규 수집 업체를 찾을 수 없습니다.", 404, "CORE_COMPANY_NOT_FOUND");
    }
    if (insightsService) {
      return insightsService.requestLocationCard(session, {
        ...payload,
        clientRequestId,
        companyId,
        tenantCompanyId: tenant.companyId
      }, context);
    }
    if (freshDataService) {
      throw coreError(
        "입지카드 분석 저장소가 구성되지 않아 요청을 실행할 수 없습니다.",
        503,
        "CORE_LOCATION_CARD_PROVIDER_NOT_CONFIGURED"
      );
    }
    const existing = repository.currentUnsafe().locationCardRequests.find((row) => (
      row.actorAccountId === session.accountId && row.clientRequestId === clientRequestId
    ));
    if (existing) {
      if (existing.companyId !== companyId || existing.tenantCompanyId !== tenant.companyId) {
        throw coreError("같은 clientRequestId를 다른 요청에 재사용할 수 없습니다.", 409, "CORE_IDEMPOTENCY_CONFLICT");
      }
      return { ok: true, metadata: metadata(), idempotent: true, request: publicLocationCardRequest(existing) };
    }
    const row = {
      requestId: idFactory("core_location_card"),
      clientRequestId,
      actorAccountId: session.accountId,
      tenantCompanyId: tenant.companyId,
      companyId,
      status: "queued",
      createdAt: nowIso()
    };
    repository.transaction("core-location-card-request", (store) => { store.locationCardRequests.push(row); return row; });
    return { ok: true, metadata: metadata(), idempotent: false, request: publicLocationCardRequest(row) };
  }

  function createTourismRequest(session, payload = {}) {
    requireRole(session, CORE_ROLES.admin);
    if (freshDataService) {
      throw coreError(
        "관광 실수집 connector가 아직 승인·구성되지 않았습니다.",
        503,
        "CORE_TOURISM_PROVIDER_NOT_CONFIGURED"
      );
    }
    const clientRequestId = cleanClientRequestId(payload.clientRequestId);
    const regionCode = cleanText(payload.regionCode || "all", 32);
    const existing = repository.currentUnsafe().tourismRequests.find((row) => (
      row.actorAccountId === session.accountId && row.clientRequestId === clientRequestId
    ));
    if (existing) {
      if (existing.regionCode !== regionCode) {
        throw coreError("같은 clientRequestId를 다른 요청에 재사용할 수 없습니다.", 409, "CORE_IDEMPOTENCY_CONFLICT");
      }
      return { ok: true, metadata: metadata(), idempotent: true, request: publicTourismRequest(existing) };
    }
    const row = {
      requestId: idFactory("core_tourism"),
      clientRequestId,
      actorAccountId: session.accountId,
      regionCode,
      status: "queued",
      createdAt: nowIso()
    };
    repository.transaction("core-tourism-request", (store) => { store.tourismRequests.push(row); return row; });
    return { ok: true, metadata: metadata(), idempotent: false, request: publicTourismRequest(row) };
  }

  return Object.freeze({
    metadata,
    assertFreshCompatibility,
    workspace,
    createJob,
    estimateCollection,
    jobFor,
    cancelJob,
    resumeJob,
    addInterest,
    removeInterest,
    createLocationCardRequest,
    createTourismRequest,
    snapshotForTests: () => repository.snapshot()
  });
}

module.exports = {
  createCoreService,
  nullableNumber,
  publicCompany,
  publicInterest,
  publicLocationCardRequest,
  publicTourismRequest
};
