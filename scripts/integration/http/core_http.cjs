"use strict";

const crypto = require("node:crypto");
const { CORE_API_BASE } = require("../contracts/core_ui.cjs");

const LEGACY_CORE_PATHS = Object.freeze(new Set([
  "/api/b2b-search",
  "/api/b2b-search/status",
  "/api/b2b-search/cancel",
  "/api/b2b-search/resume",
  "/api/b2b-my-lodge-collect",
  "/api/crawl-estimate",
  "/api/member/search-history",
  "/api/member/interest-lodges",
  "/api/runs",
  "/api/location-card-request",
  "/api/location-card-requests"
]));
const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "cancelled", "failed"]);

function isLegacyCorePath(pathname) {
  return LEGACY_CORE_PATHS.has(pathname)
    || /^\/api\/runs\/[^/]+$/.test(pathname)
    || /^\/api\/member\/runs\/[^/]+$/.test(pathname);
}

function cleanText(value, maximum = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function httpError(message, statusCode, code, retryAfterSeconds = 0) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (retryAfterSeconds) error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function opaqueCompanyRef(companyId) {
  const value = cleanText(companyId, 160);
  return value
    ? `company-ref-${crypto.createHash("sha256").update(`fresh-exploration:${value}`).digest("hex").slice(0, 24)}`
    : "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function publicResultSummary(value = {}) {
  const summary = {};
  for (const key of ["exposureSampleCount", "companyCount", "revenueSampleCount", "averageRevenue", "soldOutRate"]) {
    const number = finiteNumber(value[key]);
    if (number !== null) summary[key] = number;
  }
  return summary;
}

function publicLegacyJob(job = {}) {
  return {
    clientRequestId: cleanText(job.clientRequestId, 128),
    kind: cleanText(job.kind, 48),
    status: cleanText(job.status, 32),
    keyword: cleanText(job.keyword, 180),
    collectionMode: cleanText(job.collectionMode, 32),
    productMode: cleanText(job.productMode, 32),
    detailRankRanges: cleanText(job.detailRankRanges, 32),
    progress: finiteNumber(job.progress),
    estimatedProgress: finiteNumber(job.estimatedProgress),
    estimatedTotalSeconds: finiteNumber(job.estimatedTotalSeconds),
    remainingSeconds: finiteNumber(job.remainingSeconds),
    estimatedCompleteAt: cleanText(job.estimatedCompleteAt, 40),
    currentStage: cleanText(job.currentStage, 80),
    cancelling: Boolean(job.cancelling),
    cancelReason: cleanText(job.cancelReason, 160),
    createdAt: cleanText(job.createdAt, 40),
    startedAt: cleanText(job.startedAt, 40),
    completedAt: cleanText(job.completedAt, 40),
    cancelledAt: cleanText(job.cancelledAt, 40),
    resultSummary: publicResultSummary(job.resultSummary),
    dataBoundary: "fresh-only"
  };
}

function legacyRunSummary(job = {}) {
  const summary = publicResultSummary(job.resultSummary);
  const counts = {};
  if (summary.exposureSampleCount !== undefined) counts.naverOverall = summary.exposureSampleCount;
  if (summary.companyCount !== undefined) counts.companyCount = summary.companyCount;
  if (summary.revenueSampleCount !== undefined) counts.revenueSampleCount = summary.revenueSampleCount;
  return {
    id: cleanText(job.clientRequestId, 128),
    label: cleanText(job.keyword || job.clientRequestId, 180),
    keyword: cleanText(job.keyword, 180),
    searchKeyword: cleanText(job.keyword, 180),
    searchMode: cleanText(job.kind, 48) === "business-my-lodge" ? "company" : "keyword",
    collectionMode: cleanText(job.collectionMode, 32),
    productMode: cleanText(job.productMode, 32),
    detailRankRanges: cleanText(job.detailRankRanges, 32),
    sourceRole: cleanText(job.kind, 48).startsWith("business-") ? "b2b" : "admin",
    collectionSource: cleanText(job.kind, 48).startsWith("business-") ? "b2b_search" : "admin_search",
    status: cleanText(job.status, 32),
    updatedAt: cleanText(job.completedAt || job.cancelledAt || job.createdAt, 40),
    counts,
    dataBoundary: "fresh-only"
  };
}

function publicLegacyCompany(company = {}) {
  const values = company.businessValues || {};
  return {
    companyRef: opaqueCompanyRef(company.companyId),
    name: cleanText(company.companyName, 180),
    lodgingName: cleanText(company.companyName, 180),
    companyName: cleanText(company.companyName, 180),
    region: cleanText(company.regionLabel, 180),
    regionLabel: cleanText(company.regionLabel, 180),
    searchRegion: cleanText(company.regionLabel, 180),
    addressRegion: cleanText(company.regionLabel, 180),
    category: cleanText(company.category, 80),
    status: cleanText(company.status, 32),
    observedAt: cleanText(company.freshAt, 40),
    freshnessLabel: cleanText(company.freshnessLabel, 80),
    observationCount: finiteNumber(company.observationCount),
    dataQuality: cleanText(company.dataQuality, 32),
    naverRank: finiteNumber(values.naverRank),
    averagePrice: finiteNumber(values.averagePrice),
    weeklyRevenue: finiteNumber(values.weeklyRevenue),
    soldOutRate: finiteNumber(values.soldOutRate),
    reviewCount: finiteNumber(values.reviewCount),
    sourceLabel: cleanText(company.sourceLabel, 80)
  };
}

function legacyRunData(workspace = {}, job = {}) {
  const companyId = cleanText(job.result?.companyId, 160);
  const companyRef = cleanText(job.result?.companyRef, 80);
  const companies = companyId || companyRef
    ? (workspace.companies || []).filter((company) => (
      (companyId && company.companyId === companyId)
      || (companyRef && opaqueCompanyRef(company.companyId) === companyRef)
    ))
    : [];
  const items = companies.map(publicLegacyCompany);
  const summary = publicResultSummary(job.resultSummary);
  return {
    run: legacyRunSummary(job),
    items,
    ranking: {
      items,
      rankedItems: items
    },
    availability: {
      items,
      stats: {
        revenueSampleCount: summary.revenueSampleCount ?? null,
        averageAdjustedEstimatedRevenue: summary.averageRevenue ?? null,
        weightedSoldOutRate: summary.soldOutRate ?? null
      }
    },
    dataBoundary: "fresh-only"
  };
}

function legacyMyLodgeResponse(workspace = {}, job = {}) {
  const data = job.status === "completed" ? legacyRunData(workspace, job) : null;
  const keyword = cleanText(job.keyword, 180);
  const candidateItems = (data?.items || []).map((item) => ({
    ...item,
    matchScore: cleanText(item.companyName, 180).toLowerCase() === keyword.toLowerCase() ? 100 : null,
    matchName: cleanText(item.companyName, 180),
    matchSource: "fresh-integration",
    matchRank: finiteNumber(item.naverRank)
  }));
  const selectedItem = candidateItems[0] || null;
  return {
    ok: true,
    accepted: job.status !== "completed",
    runId: cleanText(job.clientRequestId, 128),
    keyword,
    selectedItem,
    candidateItems,
    selectedSummary: selectedItem ? {
      name: selectedItem.matchName,
      matchScore: selectedItem.matchScore,
      rank: selectedItem.matchRank,
      source: selectedItem.matchSource
    } : null,
    crawlTiming: {
      estimatedTotalSeconds: finiteNumber(job.estimatedTotalSeconds),
      estimatedCompleteAt: cleanText(job.estimatedCompleteAt, 40)
    },
    queueStatus: {
      mode: cleanText(job.status, 32),
      clientRequestId: cleanText(job.clientRequestId, 128)
    },
    job: publicLegacyJob(job),
    dataBoundary: "fresh-only"
  };
}

function kstDayKey(value = Date.now()) {
  const timestamp = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp + (9 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function secondsUntilNextKstDay(now = Date.now()) {
  const shifted = new Date(now + (9 * 60 * 60 * 1000));
  const nextUtcDay = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextUtcDay - shifted.getTime()) / 1000));
}

function legacyHistoryEntry(job = {}) {
  return {
    id: cleanText(job.clientRequestId, 128),
    runId: cleanText(job.clientRequestId, 128),
    keyword: cleanText(job.keyword, 180),
    clientRequestId: cleanText(job.clientRequestId, 128),
    runLabel: cleanText(job.keyword || job.clientRequestId, 180),
    detailRankRanges: cleanText(job.detailRankRanges, 32),
    collectionMode: cleanText(job.collectionMode, 32),
    status: cleanText(job.status, 32),
    createdAt: cleanText(job.createdAt, 40),
    completedAt: cleanText(job.completedAt || job.cancelledAt, 40),
    quotaCounted: job.status === "completed",
    resultSummary: publicResultSummary(job.resultSummary),
    dataBoundary: "fresh-only"
  };
}

function legacyHistory(workspace = {}, limit = 20, now = Date.now()) {
  const terminal = (workspace.jobs || [])
    .filter((job) => TERMINAL_JOB_STATUSES.has(job.status))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const entries = terminal.slice(0, Math.max(1, Math.min(100, Number(limit) || 20))).map(legacyHistoryEntry);
  const entitlements = workspace.tenant?.entitlements || {};
  const dailyLimit = Math.max(0, Number(entitlements.dailySearchLimit || 0));
  const dayKey = kstDayKey(now);
  const usedToday = terminal.filter((job) => (
    job.status === "completed" && job.createdAt && kstDayKey(Date.parse(job.createdAt)) === dayKey
  )).length;
  return {
    quota: {
      accountType: workspace.role === "admin" ? "master" : "member",
      limited: dailyLimit > 0,
      dailyLimit: dailyLimit || null,
      usedToday,
      remainingToday: dailyLimit ? Math.max(0, dailyLimit - usedToday) : null,
      countedTotal: terminal.filter((job) => job.status === "completed").length,
      allowedRankRange: entitlements.expandedSearchAllowed ? "1-20" : "1-10",
      expandedAllowed: Boolean(entitlements.expandedSearchAllowed),
      dayKey,
      resetAfterSeconds: secondsUntilNextKstDay(now),
      latestSearch: entries[0] || null
    },
    entries
  };
}

function legacyStatus(job = null, now = Date.now()) {
  const visible = job ? publicLegacyJob(job) : null;
  const active = Boolean(job && ACTIVE_JOB_STATUSES.has(job.status));
  const startedAtMs = Date.parse(job?.startedAt || job?.createdAt || "");
  const elapsedSeconds = active && Number.isFinite(startedAtMs)
    ? Math.max(0, Math.floor((now - startedAtMs) / 1000))
    : 0;
  const expectedAt = Date.parse(job?.estimatedCompleteAt || "");
  const delayedSeconds = active && Number.isFinite(expectedAt) && now > expectedAt
    ? Math.floor((now - expectedAt) / 1000)
    : 0;
  return {
    active,
    startedAt: visible?.startedAt || null,
    elapsedSeconds,
    estimatedTotalSeconds: active ? visible.estimatedTotalSeconds : null,
    remainingSeconds: active ? visible.remainingSeconds : null,
    estimatedProgress: active ? visible.estimatedProgress : null,
    estimatedCompleteAt: active ? (visible.estimatedCompleteAt || null) : null,
    isDelayed: delayedSeconds > 0,
    delayedSeconds,
    cancelling: active && Boolean(visible.cancelling),
    cancelReason: visible?.cancelReason || "",
    sourceRole: job ? (cleanText(job.kind, 48).startsWith("business-") ? "b2b" : "admin") : "",
    currentStage: visible?.currentStage || null,
    activeJob: active ? visible : null,
    queueLength: active ? 1 : 0,
    queuedJobs: active && job.status === "queued" ? [visible] : [],
    requesterJob: visible
  };
}

function legacyInterestPayload(workspace = {}) {
  const rows = (workspace.interests || []).map((interest) => {
    const company = interest.company || {};
    const values = company.businessValues || {};
    return {
      key: opaqueCompanyRef(interest.companyId),
      companyRef: opaqueCompanyRef(interest.companyId),
      lodgingName: cleanText(company.companyName, 180),
      companyName: cleanText(company.companyName, 180),
      regionLabel: cleanText(company.regionLabel, 180),
      observedAt: cleanText(company.freshAt, 40),
      dataQuality: cleanText(company.dataQuality, 32),
      naverRank: finiteNumber(values.naverRank),
      averagePrice: finiteNumber(values.averagePrice),
      createdAt: cleanText(interest.createdAt, 40),
      dataBoundary: "fresh-only"
    };
  });
  return {
    version: 3,
    interestLodges: rows,
    updatedAt: rows.map((row) => row.createdAt).filter(Boolean).sort().at(-1) || "",
    storage: "fresh_integration"
  };
}

function legacyLocationRequests(workspace = {}) {
  const items = (workspace.locationCardRequests || []).map((row) => ({
    key: cleanText(row.clientRequestId, 128),
    clientRequestId: cleanText(row.clientRequestId, 128),
    companyRef: opaqueCompanyRef(row.companyId),
    status: cleanText(row.status || row.lifecycle, 32),
    firstSeenAt: cleanText(row.createdAt, 40),
    updatedAt: cleanText(row.createdAt, 40),
    dataBoundary: "fresh-only"
  }));
  return {
    schemaVersion: 3,
    updatedAt: items.map((row) => row.updatedAt).filter(Boolean).sort().at(-1) || "",
    requests: Object.fromEntries(items.map((row) => [row.key, row])),
    items
  };
}

function createCoreHttpHandler(options = {}) {
  const service = options.service;
  const authService = options.authService;
  const authHttp = options.authHttp;
  const send = options.send;
  const parseBody = options.parseBody;
  const clock = options.clock || (() => Date.now());
  if (!service || !authService || !authHttp || !send || !parseBody) {
    throw new Error("Core HTTP handler dependencies are required");
  }

  function isCorePath(pathname) {
    return pathname === CORE_API_BASE
      || pathname.startsWith(`${CORE_API_BASE}/`)
      || isLegacyCorePath(pathname);
  }

  function sessionAndContext(req, mutation) {
    const context = authHttp.requestContext(req);
    const session = authHttp.sessionForRequest(req);
    if (!session) {
      const error = new Error("로그인이 필요합니다.");
      error.statusCode = 401;
      error.code = "CORE_AUTH_REQUIRED";
      throw error;
    }
    authService.assertRequestBoundary(context, {
      mutation,
      requireCsrf: mutation,
      session
    });
    return { session, context };
  }

  function requireRole(session, expected) {
    const role = session?.account?.role === "admin" ? "admin" : "b2b";
    if (role !== expected) {
      throw httpError("This V2 compatibility route is not available for the current role.", 403, "CORE_ROLE_FORBIDDEN");
    }
  }

  async function compatibilityWorkspace(session, context, view) {
    return service.workspace(session, { view }, context);
  }

  function legacyClientRequestId(session, prefix, payload = {}) {
    const supplied = cleanText(payload.clientRequestId, 128);
    if (supplied) return supplied;
    const canonical = JSON.stringify({
      account: cleanText(session?.accountId, 160),
      day: kstDayKey(clock()),
      keyword: cleanText(payload.lodgingName || payload.companyName || payload.keyword || payload.query, 180),
      checkIn: cleanText(payload.checkIn, 16),
      checkOut: cleanText(payload.checkOut, 16),
      productMode: cleanText(payload.productMode || "all", 32),
      collectionMode: cleanText(payload.collectionMode || "precision", 32),
      detailRankRanges: cleanText(payload.detailRankRanges || "1-5", 32)
    });
    return `${prefix}-${crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 28)}`;
  }

  function resolveVisibleCompany(workspace, value = {}) {
    const rawCompanyId = cleanText(value.companyId, 160);
    const companyRef = cleanText(value.companyRef || value.key, 80);
    const company = (workspace.companies || []).find((row) => (
      (rawCompanyId && row.companyId === rawCompanyId)
      || (companyRef && opaqueCompanyRef(row.companyId) === companyRef)
    ));
    if (company) return company;
    if (rawCompanyId) {
      throw httpError("The requested company is outside the current tenant.", 403, "CORE_COMPANY_FORBIDDEN");
    }
    throw httpError("A fresh-collected companyRef is required.", 422, "CORE_COMPANY_REF_REQUIRED");
  }

  async function handleLegacy(req, res, reqUrl, method, session, context) {
    const pathname = reqUrl.pathname;
    service.assertFreshCompatibility();

    if (method === "POST" && pathname === "/api/b2b-search") {
      requireRole(session, "b2b");
      const payload = await parseBody(req);
      const before = await service.workspace(session, {
        view: "business-search",
        tenantCompanyId: payload.tenantCompanyId || ""
      }, context);
      const entitlements = before.tenant?.entitlements || {};
      const requestedRange = cleanText(payload.detailRankRanges || "1-10", 32);
      if (!entitlements.expandedSearchAllowed && requestedRange !== "1-10") {
        throw httpError("The current plan allows only the 1-10 detail range.", 403, "CORE_SEARCH_RANGE_FORBIDDEN");
      }
      const history = legacyHistory(before, 20, clock());
      const existing = (before.jobs || []).find((job) => job.clientRequestId === cleanText(payload.clientRequestId, 128));
      if (!existing && history.quota.limited && history.quota.remainingToday <= 0) {
        throw httpError(
          "The daily search limit has been reached.",
          429,
          "CORE_DAILY_SEARCH_LIMIT",
          history.quota.resetAfterSeconds
        );
      }
      const created = await service.createJob(session, { ...payload, kind: "business-search" }, context);
      const job = created.job;
      const complete = job.status === "completed";
      const after = complete ? await compatibilityWorkspace(session, context, "business-report") : null;
      send(res, created.idempotent || complete ? 200 : 202, {
        ok: true,
        accepted: !complete,
        runId: cleanText(job.clientRequestId, 128),
        data: complete ? legacyRunData(after, job) : null,
        crawlTiming: {
          estimatedTotalSeconds: finiteNumber(job.estimatedTotalSeconds),
          estimatedCompleteAt: cleanText(job.estimatedCompleteAt, 40)
        },
        queueStatus: {
          mode: cleanText(job.status, 32),
          clientRequestId: cleanText(job.clientRequestId, 128)
        },
        searchHistory: TERMINAL_JOB_STATUSES.has(job.status) ? legacyHistoryEntry(job) : null,
        job: publicLegacyJob(job),
        dataBoundary: "fresh-only"
      });
      return;
    }

    if (method === "POST" && pathname === "/api/b2b-my-lodge-collect") {
      requireRole(session, "b2b");
      const payload = await parseBody(req);
      const keyword = cleanText(payload.lodgingName || payload.companyName || payload.keyword || payload.query, 180);
      if (!keyword) {
        throw httpError("숙소명을 입력해야 수집할 수 있습니다.", 400, "CORE_KEYWORD_REQUIRED");
      }
      const created = await service.createJob(session, {
        ...payload,
        clientRequestId: legacyClientRequestId(session, "legacy-my-lodge", payload),
        kind: "business-my-lodge",
        keyword,
        lodgingName: keyword,
        collectionMode: cleanText(payload.collectionMode || "precision", 32),
        productMode: cleanText(payload.productMode || "all", 32),
        detailRankRanges: cleanText(payload.detailRankRanges || "1-5", 32),
        bookingRangeDays: Math.max(1, Math.min(31, Math.round(Number(payload.bookingRangeDays) || 7))),
        bookingRangePlaceLimit: Math.max(1, Math.min(5, Math.round(Number(payload.bookingRangePlaceLimit) || 3)))
      }, context);
      const job = created.job;
      const complete = job.status === "completed";
      const workspace = complete ? await compatibilityWorkspace(session, context, "business-report") : null;
      send(res, created.idempotent || complete ? 200 : 202, legacyMyLodgeResponse(workspace, job));
      return;
    }

    if (method === "POST" && pathname === "/api/crawl-estimate") {
      const payload = await parseBody(req);
      if (Array.isArray(payload.items)) {
        const items = payload.items.slice(0, 40);
        send(res, 200, {
          items: await Promise.all(items.map(async (item) => ({
            clientKey: cleanText(item?.clientKey, 240),
            estimate: await service.estimateCollection(session, item || {}, context)
          })))
        });
        return;
      }
      send(res, 200, await service.estimateCollection(session, payload, context));
      return;
    }

    if (method === "GET" && pathname === "/api/b2b-search/status") {
      requireRole(session, "b2b");
      const requestedId = cleanText(reqUrl.searchParams.get("clientRequestId"), 128);
      let job = null;
      if (requestedId) {
        job = (await service.jobFor(session, requestedId)).job;
      } else {
        const workspace = await compatibilityWorkspace(session, context, "business-activity");
        job = (workspace.jobs || []).find((row) => ACTIVE_JOB_STATUSES.has(row.status)) || null;
      }
      send(res, 200, legacyStatus(job, clock()));
      return;
    }

    if (method === "POST" && ["/api/b2b-search/cancel", "/api/b2b-search/resume"].includes(pathname)) {
      requireRole(session, "b2b");
      const payload = await parseBody(req);
      const workspace = await compatibilityWorkspace(session, context, "business-activity");
      const requestedId = cleanText(payload.clientRequestId || reqUrl.searchParams.get("clientRequestId"), 128);
      const fallbackStatuses = pathname.endsWith("/resume") ? new Set(["cancelled", "failed"]) : ACTIVE_JOB_STATUSES;
      const target = requestedId
        ? (workspace.jobs || []).find((row) => row.clientRequestId === requestedId)
        : (workspace.jobs || []).find((row) => fallbackStatuses.has(row.status));
      if (!target) {
        send(res, 200, {
          ok: false,
          active: false,
          message: pathname.endsWith("/resume") ? "No resumable fresh collection was found." : "No active fresh collection was found.",
          status: legacyStatus(null, clock())
        });
        return;
      }
      const operation = pathname.endsWith("/resume") ? service.resumeJob : service.cancelJob;
      const changed = await operation(session, target.clientRequestId, payload);
      send(res, 200, {
        ok: true,
        active: ACTIVE_JOB_STATUSES.has(changed.job.status),
        message: pathname.endsWith("/resume") ? "Fresh collection resumed." : "Fresh collection cancellation requested.",
        status: legacyStatus(changed.job, clock()),
        job: publicLegacyJob(changed.job)
      });
      return;
    }

    if (method === "GET" && pathname === "/api/member/search-history") {
      requireRole(session, "b2b");
      const workspace = await compatibilityWorkspace(session, context, "business-activity");
      send(res, 200, legacyHistory(workspace, reqUrl.searchParams.get("limit") || 20, clock()));
      return;
    }

    const memberRunMatch = pathname.match(/^\/api\/member\/runs\/([^/]+)$/);
    if (method === "GET" && memberRunMatch) {
      const runId = cleanText(decodeURIComponent(memberRunMatch[1]), 128);
      const admin = session?.account?.role === "admin";
      const workspace = await compatibilityWorkspace(session, context, admin ? "admin-collection" : "business-report");
      const job = (workspace.jobs || []).find((row) => row.clientRequestId === runId);
      if (!job) {
        throw httpError(
          admin ? "Fresh collection run not found." : "본인 검색 이력에 있는 리포트만 열람할 수 있습니다.",
          admin ? 404 : 403,
          admin ? "CORE_RUN_NOT_FOUND" : "CORE_RUN_FORBIDDEN"
        );
      }
      send(res, 200, legacyRunData(workspace, job));
      return;
    }

    if (method === "GET" && pathname === "/api/member/interest-lodges") {
      requireRole(session, "b2b");
      send(res, 200, legacyInterestPayload(await compatibilityWorkspace(session, context, "business-interest")));
      return;
    }

    if (["POST", "PUT"].includes(method) && pathname === "/api/member/interest-lodges") {
      requireRole(session, "b2b");
      const payload = await parseBody(req);
      const workspace = await compatibilityWorkspace(session, context, "business-interest");
      if (Array.isArray(payload.interestLodges)) {
        const desiredCompanies = [...new Map(
          payload.interestLodges
            .map((row) => resolveVisibleCompany(workspace, row))
            .map((company) => [company.companyId, company])
        ).values()];
        const desiredIds = new Set(desiredCompanies.map((company) => company.companyId));
        const currentIds = new Set((workspace.interests || []).map((row) => row.companyId));
        for (const company of desiredCompanies) {
          if (!currentIds.has(company.companyId)) {
            await service.addInterest(session, { companyId: company.companyId }, context);
          }
        }
        for (const companyId of currentIds) {
          if (!desiredIds.has(companyId)) await service.removeInterest(session, companyId, {}, context);
        }
      } else {
        const company = resolveVisibleCompany(workspace, payload);
        if (cleanText(payload.action, 16).toLowerCase() === "remove" || payload.remove === true) {
          await service.removeInterest(session, company.companyId, {}, context);
        } else {
          await service.addInterest(session, { companyId: company.companyId }, context);
        }
      }
      send(res, 200, legacyInterestPayload(await compatibilityWorkspace(session, context, "business-interest")));
      return;
    }

    if (method === "GET" && pathname === "/api/runs") {
      requireRole(session, "admin");
      const workspace = await compatibilityWorkspace(session, context, "admin-collection");
      send(res, 200, { runs: (workspace.jobs || []).map(legacyRunSummary), dataBoundary: "fresh-only" });
      return;
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (method === "GET" && runMatch) {
      requireRole(session, "admin");
      const runId = cleanText(decodeURIComponent(runMatch[1]), 128);
      const workspace = await compatibilityWorkspace(session, context, "admin-collection");
      const job = (workspace.jobs || []).find((row) => row.clientRequestId === runId);
      if (!job) throw httpError("Fresh collection run not found.", 404, "CORE_RUN_NOT_FOUND");
      send(res, 200, legacyRunData(workspace, job));
      return;
    }

    if (method === "GET" && pathname === "/api/location-card-requests") {
      send(res, 200, legacyLocationRequests(await compatibilityWorkspace(session, context, "location-card")));
      return;
    }

    if (method === "POST" && pathname === "/api/location-card-request") {
      requireRole(session, "b2b");
      const payload = await parseBody(req);
      if (payload.status && payload.status !== "requested") {
        throw httpError("Legacy location-card status changes are not part of the fresh request lifecycle.", 409, "CORE_LOCATION_STATUS_UNSUPPORTED");
      }
      const workspace = await compatibilityWorkspace(session, context, "business-location");
      const company = resolveVisibleCompany(workspace, payload);
      const candidateId = cleanText(payload.clientRequestId || payload.key, 128);
      const clientRequestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(candidateId)
        ? candidateId
        : `legacy-location-${crypto.createHash("sha256").update(`${session.accountId}|${company.companyId}|${candidateId}`).digest("hex").slice(0, 24)}`;
      await service.createLocationCardRequest(session, {
        clientRequestId,
        companyId: company.companyId
      }, context);
      send(res, 200, legacyLocationRequests(await compatibilityWorkspace(session, context, "business-location")));
      return;
    }

    throw httpError("V2 compatibility route or method not found.", 404, "CORE_COMPATIBILITY_ROUTE_NOT_FOUND");
  }

  async function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    if (!isCorePath(pathname)) return false;
    const method = String(req.method || "GET").toUpperCase();
    try {
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
      const { session, context } = sessionAndContext(req, mutation);

      if (isLegacyCorePath(pathname)) {
        await handleLegacy(req, res, reqUrl, method, session, context);
        return true;
      }

      if (method === "GET" && pathname === `${CORE_API_BASE}/workspace`) {
        send(res, 200, await service.workspace(session, {
          view: reqUrl.searchParams.get("view") || "",
          companyId: reqUrl.searchParams.get("companyId") || "",
          tenantCompanyId: reqUrl.searchParams.get("tenantCompanyId") || ""
        }, context));
        return true;
      }
      if (method === "POST" && pathname === `${CORE_API_BASE}/jobs`) {
        const result = await service.createJob(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 202, result);
        return true;
      }
      const jobStatusMatch = pathname.match(/^\/api\/integration\/core\/jobs\/([^/]+)$/);
      if (method === "GET" && jobStatusMatch) {
        send(res, 200, await service.jobFor(session, decodeURIComponent(jobStatusMatch[1])));
        return true;
      }
      const jobMutationMatch = pathname.match(/^\/api\/integration\/core\/jobs\/([^/]+)\/(cancel|resume)$/);
      if (method === "POST" && jobMutationMatch) {
        const operation = jobMutationMatch[2] === "resume" ? service.resumeJob : service.cancelJob;
        send(res, 200, await operation(
          session,
          decodeURIComponent(jobMutationMatch[1]),
          await parseBody(req)
        ));
        return true;
      }
      if (method === "POST" && pathname === `${CORE_API_BASE}/interests`) {
        const result = await service.addInterest(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }
      const interestMatch = pathname.match(/^\/api\/integration\/core\/interests\/([^/]+)$/);
      if (method === "DELETE" && interestMatch) {
        send(res, 200, await service.removeInterest(
          session,
          decodeURIComponent(interestMatch[1]),
          { tenantCompanyId: reqUrl.searchParams.get("tenantCompanyId") || "" },
          context
        ));
        return true;
      }
      if (method === "POST" && pathname === `${CORE_API_BASE}/location-card-requests`) {
        const result = await service.createLocationCardRequest(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 202, result);
        return true;
      }
      if (method === "POST" && pathname === `${CORE_API_BASE}/admin/tourism-requests`) {
        const result = service.createTourismRequest(session, await parseBody(req));
        send(res, result.idempotent ? 200 : 202, result);
        return true;
      }
      send(res, 404, {
        error: "Stage 227 core API route not found",
        code: "CORE_ROUTE_NOT_FOUND",
        metadata: service.metadata()
      });
      return true;
    } catch (error) {
      const headers = error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {};
      send(res, error.statusCode || 500, {
        error: error.message || String(error),
        code: error.code || undefined,
        retryAfterSeconds: error.retryAfterSeconds || undefined,
        metadata: service.metadata()
      }, "application/json; charset=utf-8", headers);
      return true;
    }
  }

  return Object.freeze({ handle, isCorePath });
}

module.exports = { createCoreHttpHandler };
