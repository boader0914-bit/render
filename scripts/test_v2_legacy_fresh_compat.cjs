"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createCoreRepository } = require("./integration/repositories/core_store.cjs");
const { createCoreService } = require("./integration/services/core_service.cjs");
const { createCoreHttpHandler } = require("./integration/http/core_http.cjs");

function requestError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function companyRef(companyId) {
  return `company-ref-${crypto.createHash("sha256").update(`fresh-exploration:${companyId}`).digest("hex").slice(0, 24)}`;
}

function jobRef(jobId) {
  return `job-ref-${crypto.createHash("sha256").update(`fresh-job:${jobId}`).digest("hex").slice(0, 24)}`;
}

function assertSafePayload(value, label) {
  const text = JSON.stringify(value);
  for (const forbidden of ["fresh_run_", "cmp_", "tenant-a", "tenant-b", "rawPath", "sourceUrl", "C:\\\\legacy"]) {
    assert.equal(text.includes(forbidden), false, `${label} leaked ${forbidden}`);
  }
}

function projectFreshJob(session, job) {
  const admin = session.account.role === "admin";
  const projection = {
    jobRef: jobRef(job.jobId),
    clientRequestId: job.clientRequestId,
    kind: job.kind,
    status: job.status,
    keyword: job.keyword,
    collectionMode: job.collectionMode,
    productMode: job.productMode,
    detailRankRanges: job.detailRankRanges,
    progress: job.progress,
    estimatedProgress: job.estimatedProgress,
    estimatedTotalSeconds: job.estimatedTotalSeconds,
    remainingSeconds: job.remainingSeconds,
    estimatedCompleteAt: job.estimatedCompleteAt,
    currentStage: job.currentStage,
    cancelling: Boolean(job.cancelling),
    cancelReason: job.cancelReason || "",
    createdAt: job.createdAt,
    startedAt: job.startedAt || "",
    completedAt: job.completedAt || "",
    cancelledAt: job.cancelledAt || "",
    resultSummary: { ...(job.resultSummary || {}) },
    result: job.result ? {
      companyRef: companyRef(job.result.companyId),
      dataBoundary: "fresh-only",
      dataMode: job.result.dataMode === "live" ? "live" : "synthetic-test",
      ...(admin ? { companyId: job.result.companyId } : {})
    } : null,
    provisional: false,
    dataBoundary: "fresh-only",
    ...(admin ? { tenantCompanyId: job.tenantCompanyId } : {})
  };
  return projection;
}

function assertSafeJobProjection(job, options = {}) {
  assert.match(job.jobRef, /^job-ref-[a-f0-9]{24}$/);
  assert.equal(Object.hasOwn(job, "jobId"), false);
  assert.equal(Object.hasOwn(job, "runId"), false);
  if (options.admin) {
    assert.equal(typeof job.tenantCompanyId, "string");
  } else {
    assert.equal(Object.hasOwn(job, "tenantCompanyId"), false);
    assert.equal(Object.hasOwn(job.result || {}, "companyId"), false);
  }
  assert.doesNotMatch(JSON.stringify(job), /fresh_run_|derivedProfile|provider|rawPath|sourceUrl|evidenceId/i);
}

async function main() {
  const calls = {
    freshCompanies: 0,
    freshJobs: 0,
    freshSubmit: 0,
    freshGetJob: 0,
    freshCancel: 0,
    freshResume: 0,
    freshInterests: 0,
    legacyReads: 0
  };
  const now = "2026-07-30T03:00:00.000Z";
  const entitlements = {
    plan: "free",
    dailySearchLimit: 2,
    searchWindowDays: 7,
    monthlyExportLimit: 0,
    concurrentExportLimit: 0,
    expandedSearchAllowed: false
  };
  const sessions = {
    businessA: {
      accountId: "acct-a",
      account: { accountId: "acct-a", role: "b2b" },
      memberships: [{ companyId: "tenant-a", companyName: "A Tenant", plan: "free" }]
    },
    businessB: {
      accountId: "acct-b",
      account: { accountId: "acct-b", role: "b2b" },
      memberships: [{ companyId: "tenant-b", companyName: "B Tenant", plan: "free" }]
    },
    admin: {
      accountId: "acct-admin",
      account: { accountId: "acct-admin", role: "admin" },
      memberships: []
    }
  };
  const companies = [
    {
      companyId: "cmp_a",
      tenantCompanyId: "tenant-a",
      companyName: "Fresh A Lodge",
      regionLabel: "Gangwon",
      category: "glamping",
      status: "fresh",
      freshAt: now,
      freshnessLabel: "today",
      observationCount: 12,
      dataQuality: "complete",
      missingFields: [],
      businessValues: { naverRank: 3, averagePrice: 150000, weeklyRevenue: null, soldOutRate: null, reviewCount: 21 },
      sourceLabel: "approved live provider",
      synthetic: false,
      dataMode: "live"
    },
    {
      companyId: "cmp_b",
      tenantCompanyId: "tenant-b",
      companyName: "Fresh B Lodge",
      regionLabel: "Jeju",
      category: "pension",
      status: "fresh",
      freshAt: now,
      freshnessLabel: "today",
      observationCount: 8,
      dataQuality: "partial",
      missingFields: ["ota"],
      businessValues: { naverRank: 8, averagePrice: 120000, weeklyRevenue: null, soldOutRate: null, reviewCount: 9 },
      sourceLabel: "approved live provider",
      synthetic: false,
      dataMode: "live"
    }
  ];
  const jobs = [
    {
      jobId: "fresh_run_internal_a",
      clientRequestId: "b2b-client-done-0001",
      actorAccountId: "acct-a",
      tenantCompanyId: "tenant-a",
      kind: "business-search",
      status: "completed",
      keyword: "Fresh A",
      collectionMode: "precision",
      productMode: "all",
      detailRankRanges: "1-10",
      progress: 100,
      estimatedProgress: 100,
      estimatedTotalSeconds: 60,
      remainingSeconds: 0,
      estimatedCompleteAt: now,
      currentStage: "completed",
      createdAt: now,
      startedAt: now,
      completedAt: now,
      resultSummary: { exposureSampleCount: 1, companyCount: 1, revenueSampleCount: 0 },
      result: { companyId: "cmp_a", dataMode: "live", rawPath: "C:\\legacy\\must-not-leak" },
      provisional: false
    },
    {
      jobId: "fresh_run_internal_b",
      clientRequestId: "b2b-client-other-0001",
      actorAccountId: "acct-b",
      tenantCompanyId: "tenant-b",
      kind: "business-search",
      status: "completed",
      keyword: "Fresh B",
      collectionMode: "precision",
      productMode: "all",
      detailRankRanges: "1-10",
      progress: 100,
      createdAt: now,
      completedAt: now,
      resultSummary: { exposureSampleCount: 1, companyCount: 1 },
      result: { companyId: "cmp_b", dataMode: "live" },
      provisional: false
    }
  ];
  const interests = [];
  const cards = [];

  const authService = {
    assertRequestBoundary(context, options = {}) {
      if (options.requireCsrf && context.csrfToken !== "valid-csrf") {
        throw requestError("CSRF token required", 403, "AUTH_CSRF_INVALID");
      }
    },
    async assertCompanyAccess(session, requestedCompanyId) {
      if (session.account.role !== "admin" && session.memberships[0]?.companyId !== requestedCompanyId) {
        throw requestError("Tenant access denied", 403, "AUTH_TENANT_FORBIDDEN");
      }
      const company = { companyId: requestedCompanyId, name: `${requestedCompanyId} company` };
      return { company, membership: { companyId: requestedCompanyId, plan: "free" }, entitlements };
    }
  };

  function visibleCompanies(session, tenantCompanyId) {
    if (session.account.role === "admin") return companies;
    const tenant = tenantCompanyId || session.memberships[0]?.companyId;
    if (tenant !== session.memberships[0]?.companyId) throw requestError("Tenant access denied", 403, "FRESH_TENANT_FORBIDDEN");
    return companies.filter((company) => company.tenantCompanyId === tenant);
  }

  const freshDataService = {
    metadata() {
      return {
        stage: 228,
        provisional: false,
        dataBoundary: "fresh-integration-only",
        fixtureMode: false,
        providerMode: "live",
        source: "v2-live-fresh-collection",
        collection: { enabled: true, configured: true, mode: "live" },
        legacyRuntimeReads: 0,
        legacyRuntimeCopies: 0,
        providerCalls: 0
      };
    },
    async listCompanies(session, tenantCompanyId) {
      calls.freshCompanies += 1;
      return visibleCompanies(session, tenantCompanyId).map((row) => ({ ...row }));
    },
    async getCompany(session, companyId, tenantCompanyId) {
      const company = visibleCompanies(session, tenantCompanyId).find((row) => row.companyId === companyId);
      if (!company) throw requestError("Company outside tenant", 403, "FRESH_TENANT_FORBIDDEN");
      return { ...company };
    },
    async listJobs(session) {
      calls.freshJobs += 1;
      return jobs
        .filter((job) => session.account.role === "admin" || job.actorAccountId === session.accountId)
        .map((job) => projectFreshJob(session, job));
    },
    async submitCollection(session, payload) {
      calls.freshSubmit += 1;
      const existing = jobs.find((row) => (
        row.actorAccountId === session.accountId && row.clientRequestId === payload.clientRequestId
      ));
      if (existing) {
        return { idempotent: true, outcome: existing.status, job: projectFreshJob(session, existing) };
      }
      const completeMyLodge = payload.kind === "business-my-lodge" && payload.keyword === "Fresh A Lodge";
      const job = {
        jobId: `fresh_run_internal_${calls.freshSubmit}`,
        clientRequestId: payload.clientRequestId,
        actorAccountId: session.accountId,
        tenantCompanyId: payload.tenantCompanyId,
        kind: payload.kind,
        status: completeMyLodge ? "completed" : "queued",
        keyword: payload.keyword,
        collectionMode: payload.collectionMode,
        productMode: payload.productMode,
        detailRankRanges: payload.detailRankRanges || "1-10",
        progress: completeMyLodge ? 100 : 0,
        estimatedProgress: completeMyLodge ? 100 : 0,
        estimatedTotalSeconds: 90,
        remainingSeconds: completeMyLodge ? 0 : 90,
        estimatedCompleteAt: "2026-07-30T03:01:30.000Z",
        currentStage: completeMyLodge ? "completed" : "discovery",
        createdAt: now,
        startedAt: completeMyLodge ? now : "",
        completedAt: completeMyLodge ? now : "",
        resultSummary: completeMyLodge ? { exposureSampleCount: 1, companyCount: 1 } : {},
        result: completeMyLodge ? { companyId: "cmp_a", dataMode: "live", rawPath: "C:\\legacy\\must-not-leak" } : null,
        provisional: false
      };
      jobs.push(job);
      return { idempotent: false, outcome: job.status, job: projectFreshJob(session, job) };
    },
    async getJob(session, clientRequestId) {
      calls.freshGetJob += 1;
      const job = jobs.find((row) => row.clientRequestId === clientRequestId);
      if (!job || (session.account.role !== "admin" && job.actorAccountId !== session.accountId)) {
        throw requestError("Job access denied", 403, "FRESH_JOB_FORBIDDEN");
      }
      return { job: projectFreshJob(session, job) };
    },
    async cancelJob(session, clientRequestId, payload) {
      calls.freshCancel += 1;
      const result = await this.getJob(session, clientRequestId);
      const job = jobs.find((row) => row.clientRequestId === clientRequestId);
      job.status = "cancelled";
      job.cancelReason = payload.reason || "user-requested";
      job.cancelledAt = now;
      job.remainingSeconds = 0;
      return { idempotent: false, job: projectFreshJob(session, job) };
    },
    async resumeJob(session, clientRequestId) {
      calls.freshResume += 1;
      await this.getJob(session, clientRequestId);
      const job = jobs.find((row) => row.clientRequestId === clientRequestId);
      job.status = "queued";
      job.cancelReason = "";
      job.cancelledAt = "";
      return { idempotent: false, job: projectFreshJob(session, job) };
    }
  };

  const freshRepository = {
    async listInterests(filter) {
      calls.freshInterests += 1;
      return interests.filter((row) => row.actorAccountId === filter.actorAccountId && row.tenantCompanyId === filter.tenantCompanyId).map((row) => ({ ...row }));
    },
    async addInterest(payload) {
      const company = companies.find((row) => row.companyId === payload.companyId);
      if (!company || company.tenantCompanyId !== payload.tenantCompanyId) {
        throw requestError("Interest tenant denied", 403, "FRESH_TENANT_FORBIDDEN");
      }
      const existing = interests.find((row) => row.actorAccountId === payload.actorAccountId && row.companyId === payload.companyId);
      if (existing) return { idempotent: true, interest: { ...existing } };
      const interest = {
        interestId: `interest_internal_${interests.length + 1}`,
        actorAccountId: payload.actorAccountId,
        tenantCompanyId: payload.tenantCompanyId,
        companyId: payload.companyId,
        createdAt: now
      };
      interests.push(interest);
      return { idempotent: false, interest: { ...interest } };
    },
    async removeInterest(payload) {
      const index = interests.findIndex((row) => row.actorAccountId === payload.actorAccountId && row.tenantCompanyId === payload.tenantCompanyId && row.companyId === payload.companyId);
      if (index < 0) return { removed: 0, idempotent: true };
      interests.splice(index, 1);
      return { removed: 1, idempotent: false };
    }
  };

  const insightsService = {
    async listLocationCardRequests(session) {
      return cards.filter((row) => session.account.role === "admin" || row.tenantCompanyId === session.memberships[0]?.companyId).map((row) => ({ ...row }));
    },
    async requestLocationCard(session, payload) {
      const row = {
        requestId: `card_internal_${cards.length + 1}`,
        cardId: `card_internal_${cards.length + 1}`,
        clientRequestId: payload.clientRequestId,
        companyId: payload.companyId,
        tenantCompanyId: payload.tenantCompanyId,
        status: "requested",
        lifecycle: "requested",
        createdAt: now
      };
      cards.push(row);
      return { ok: true, idempotent: false, request: { ...row } };
    }
  };

  const coreRepository = createCoreRepository();
  const service = createCoreService({
    repository: coreRepository,
    authService,
    freshDataService,
    freshRepository,
    insightsService,
    clock: () => Date.parse(now)
  });
  const authHttp = {
    requestContext(req) {
      return { csrfToken: req.headers["x-csrf-token"] || "", host: "compat.test", origin: "https://compat.test" };
    },
    sessionForRequest(req) {
      return req.session || null;
    }
  };
  const handler = createCoreHttpHandler({
    service,
    authService,
    authHttp,
    clock: () => Date.parse(now),
    parseBody: async (req) => req.body || {},
    send(res, status, body, _type, headers = {}) {
      res.status = status;
      res.body = body;
      res.headers = headers;
    }
  });

  async function call(session, pathname, options = {}) {
    const method = options.method || "GET";
    const req = {
      method,
      session,
      body: options.body,
      headers: {
        ...(!["GET", "HEAD", "OPTIONS"].includes(method) && options.csrf !== false ? { "x-csrf-token": "valid-csrf" } : {})
      }
    };
    const res = {};
    const handled = await handler.handle(req, res, new URL(pathname, "https://compat.test"));
    assert.equal(handled, true);
    return res;
  }

  const initialBusinessWorkspace = await service.workspace(sessions.businessA, { view: "business-activity" });
  const initialBusinessJob = initialBusinessWorkspace.jobs.find((row) => row.clientRequestId === "b2b-client-done-0001");
  assert.ok(initialBusinessJob);
  assertSafeJobProjection(initialBusinessJob);
  assert.equal(initialBusinessJob.result.companyRef, companyRef("cmp_a"));
  const initialAdminWorkspace = await service.workspace(sessions.admin, { view: "admin-operations" });
  const initialAdminJob = initialAdminWorkspace.jobs.find((row) => row.clientRequestId === "b2b-client-done-0001");
  assert.ok(initialAdminJob);
  assertSafeJobProjection(initialAdminJob, { admin: true });
  assert.equal(initialAdminJob.result.companyId, "cmp_a");

  for (const pathname of [
    "/api/b2b-search", "/api/b2b-search/status", "/api/b2b-search/cancel", "/api/b2b-search/resume",
    "/api/b2b-my-lodge-collect", "/api/crawl-estimate", "/api/member/search-history",
    "/api/member/interest-lodges", "/api/member/runs/public-id", "/api/runs", "/api/runs/public-id",
    "/api/location-card-request", "/api/location-card-requests"
  ]) assert.equal(handler.isCorePath(pathname), true, `missing compatibility alias ${pathname}`);

  const estimateNoCsrf = await call(sessions.businessA, "/api/crawl-estimate", {
    method: "POST",
    csrf: false,
    body: { keyword: "Fresh A", searchMode: "company" }
  });
  assert.equal(estimateNoCsrf.status, 403);

  const estimate = await call(sessions.businessA, "/api/crawl-estimate", {
    method: "POST",
    body: {
      keyword: "Fresh A",
      searchMode: "company",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      productMode: "all",
      detailRankRanges: "1-5",
      bookingDays: 7
    }
  });
  assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  assert.equal(estimate.body.keyword, "Fresh A");
  assert.equal(estimate.body.searchMode, "company");
  assert.equal(estimate.body.collectionPurpose, "revenue_detail");
  assert.equal(estimate.body.bookingRangeDays, 7);
  assert.ok(estimate.body.estimatedTotalSeconds > 0);
  assert.ok(Array.isArray(estimate.body.stages) && estimate.body.stages.length >= 4);
  assert.equal(estimate.body.estimateBasis.timing.source, "cold-start-model");
  assert.equal(estimate.body.dataBoundary, "fresh-only");
  assertSafePayload(estimate.body, "single crawl estimate");

  const estimateTenantDenied = await call(sessions.businessA, "/api/crawl-estimate", {
    method: "POST",
    body: { keyword: "Fresh A", tenantCompanyId: "tenant-b" }
  });
  assert.equal(estimateTenantDenied.status, 403);

  const estimateBatch = await call(sessions.admin, "/api/crawl-estimate", {
    method: "POST",
    body: {
      items: Array.from({ length: 42 }, (_, index) => ({
        clientKey: `batch-${index + 1}`,
        keyword: `Fresh ${index + 1}`,
        checkIn: "2026-08-01",
        checkOut: "2026-08-07"
      }))
    }
  });
  assert.equal(estimateBatch.status, 200);
  assert.equal(estimateBatch.body.items.length, 40, "legacy batch estimates remain capped at 40");
  assert.equal(estimateBatch.body.items[0].clientKey, "batch-1");
  assert.equal(estimateBatch.body.items[0].estimate.dataBoundary, "fresh-only");
  assertSafePayload(estimateBatch.body, "batch crawl estimate");

  const noCsrf = await call(sessions.businessA, "/api/b2b-search", {
    method: "POST",
    csrf: false,
    body: { clientRequestId: "b2b-client-new-0001", keyword: "Fresh Search", detailRankRanges: "1-10" }
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(calls.freshSubmit, 0, "CSRF rejection must happen before fresh mutation");

  const expandedDenied = await call(sessions.businessA, "/api/b2b-search", {
    method: "POST",
    body: { clientRequestId: "b2b-client-new-0002", keyword: "Fresh Search", detailRankRanges: "1-20" }
  });
  assert.equal(expandedDenied.status, 403);
  assert.equal(calls.freshSubmit, 0);

  const tenantDenied = await call(sessions.businessA, "/api/b2b-search", {
    method: "POST",
    body: { clientRequestId: "b2b-client-new-0003", keyword: "Fresh Search", detailRankRanges: "1-10", tenantCompanyId: "tenant-b" }
  });
  assert.equal(tenantDenied.status, 403);
  assert.equal(calls.freshSubmit, 0);

  const created = await call(sessions.businessA, "/api/b2b-search", {
    method: "POST",
    body: { clientRequestId: "b2b-client-new-0001", keyword: "Fresh Search", detailRankRanges: "1-10" }
  });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.runId, "b2b-client-new-0001");
  assert.equal(created.body.data, null, "queued work must not fabricate a completed V2 result");
  assert.equal(calls.freshSubmit, 1);
  assert.equal(coreRepository.snapshot().jobs.length, 0, "compatibility create must not use the provisional core store");
  assertSafePayload(created.body, "search create");

  const status = await call(sessions.businessA, "/api/b2b-search/status?clientRequestId=b2b-client-new-0001");
  assert.equal(status.status, 200);
  assert.equal(status.body.active, true);
  assert.equal(status.body.requesterJob.clientRequestId, "b2b-client-new-0001");
  assertSafePayload(status.body, "search status");

  const foreignStatus = await call(sessions.businessB, "/api/b2b-search/status?clientRequestId=b2b-client-new-0001");
  assert.equal(foreignStatus.status, 403, "cross-account job access must be denied");

  const cancelled = await call(sessions.businessA, "/api/b2b-search/cancel", {
    method: "POST",
    body: { clientRequestId: "b2b-client-new-0001", reason: "test cancellation" }
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.status, "cancelled");
  assert.equal(calls.freshCancel, 1);
  assertSafePayload(cancelled.body, "search cancel");

  const resumed = await call(sessions.businessA, "/api/b2b-search/resume", {
    method: "POST",
    body: { clientRequestId: "b2b-client-new-0001", reason: "test resume" }
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.job.status, "queued");
  assert.equal(calls.freshResume, 1);

  const history = await call(sessions.businessA, "/api/member/search-history?limit=20");
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.entries.map((row) => row.runId), ["b2b-client-done-0001"]);
  assert.equal(history.body.quota.dailyLimit, 2);
  assert.equal(history.body.quota.usedToday, 1);
  assertSafePayload(history.body, "search history");

  const ownMemberRun = await call(sessions.businessA, "/api/member/runs/b2b-client-done-0001");
  assert.equal(ownMemberRun.status, 200, JSON.stringify(ownMemberRun.body));
  assert.equal(ownMemberRun.body.run.id, "b2b-client-done-0001");
  assert.equal(ownMemberRun.body.run.searchMode, "keyword");
  assert.equal(ownMemberRun.body.availability.items[0].companyName, "Fresh A Lodge");
  assert.equal(ownMemberRun.body.ranking.items[0].companyRef, companyRef("cmp_a"));
  assertSafePayload(ownMemberRun.body, "member run detail");

  const foreignMemberRun = await call(sessions.businessB, "/api/member/runs/b2b-client-done-0001");
  assert.equal(foreignMemberRun.status, 403, "another member must not read a run outside their account and tenant");
  const adminMemberRun = await call(sessions.admin, "/api/member/runs/b2b-client-done-0001");
  assert.equal(adminMemberRun.status, 200, "legacy contract allows an administrator to inspect the business-safe member projection");
  assertSafePayload(adminMemberRun.body, "admin member run detail");
  const missingAdminMemberRun = await call(sessions.admin, "/api/member/runs/not-found-run");
  assert.equal(missingAdminMemberRun.status, 404);

  const myLodgeCallsBefore = calls.freshSubmit;
  const myLodgeNoCsrf = await call(sessions.businessA, "/api/b2b-my-lodge-collect", {
    method: "POST",
    csrf: false,
    body: { lodgingName: "Fresh A Lodge" }
  });
  assert.equal(myLodgeNoCsrf.status, 403);
  const myLodgeAdminDenied = await call(sessions.admin, "/api/b2b-my-lodge-collect", {
    method: "POST",
    body: { lodgingName: "Fresh A Lodge" }
  });
  assert.equal(myLodgeAdminDenied.status, 403);
  const myLodgeMissingName = await call(sessions.businessA, "/api/b2b-my-lodge-collect", {
    method: "POST",
    body: {}
  });
  assert.equal(myLodgeMissingName.status, 400);
  const myLodgeTenantDenied = await call(sessions.businessA, "/api/b2b-my-lodge-collect", {
    method: "POST",
    body: { lodgingName: "Fresh A Lodge", tenantCompanyId: "tenant-b" }
  });
  assert.equal(myLodgeTenantDenied.status, 403);
  assert.equal(calls.freshSubmit, myLodgeCallsBefore, "rejected my-lodge requests must not reach the fresh provider boundary");

  const queuedMyLodge = await call(sessions.businessA, "/api/b2b-my-lodge-collect", {
    method: "POST",
    body: {
      clientRequestId: "my-lodge-queued-0001",
      lodgingName: "Queued Lodge",
      detailRankRanges: "1-5",
      bookingRangeDays: 7,
      bookingRangePlaceLimit: 3
    }
  });
  assert.equal(queuedMyLodge.status, 202, JSON.stringify(queuedMyLodge.body));
  assert.equal(queuedMyLodge.body.accepted, true);
  assert.equal(queuedMyLodge.body.runId, "my-lodge-queued-0001");
  assert.equal(queuedMyLodge.body.selectedItem, null, "queued live work must not fabricate a selected lodge");
  assert.deepEqual(queuedMyLodge.body.candidateItems, []);
  assertSafePayload(queuedMyLodge.body, "queued my-lodge collection");

  const completedMyLodge = await call(sessions.businessA, "/api/b2b-my-lodge-collect", {
    method: "POST",
    body: {
      clientRequestId: "my-lodge-complete-0001",
      companyName: "Fresh A Lodge",
      checkIn: "2026-08-01",
      checkOut: "2026-08-07",
      detailRankRanges: "1-5",
      bookingRangeDays: 7,
      bookingRangePlaceLimit: 3
    }
  });
  assert.equal(completedMyLodge.status, 200, JSON.stringify(completedMyLodge.body));
  assert.equal(completedMyLodge.body.accepted, false);
  assert.equal(completedMyLodge.body.keyword, "Fresh A Lodge");
  assert.equal(completedMyLodge.body.selectedItem.companyName, "Fresh A Lodge");
  assert.equal(completedMyLodge.body.selectedItem.companyRef, companyRef("cmp_a"));
  assert.equal(completedMyLodge.body.selectedSummary.source, "fresh-integration");
  assertSafePayload(completedMyLodge.body, "completed my-lodge collection");

  const completedJobCount = jobs.length;
  const completedMyLodgeRetry = await call(sessions.businessA, "/api/b2b-my-lodge-collect", {
    method: "POST",
    body: { clientRequestId: "my-lodge-complete-0001", lodgingName: "Fresh A Lodge" }
  });
  assert.equal(completedMyLodgeRetry.status, 200);
  assert.equal(jobs.length, completedJobCount, "same clientRequestId must remain idempotent");
  assertSafePayload(completedMyLodgeRetry.body, "idempotent my-lodge collection");

  const ownRef = companyRef("cmp_a");
  const interestSaved = await call(sessions.businessA, "/api/member/interest-lodges", {
    method: "PUT",
    body: { interestLodges: [{ companyRef: ownRef }] }
  });
  assert.equal(interestSaved.status, 200, JSON.stringify(interestSaved.body));
  assert.equal(interestSaved.body.interestLodges.length, 1);
  assert.equal(interestSaved.body.interestLodges[0].companyRef, ownRef);
  assertSafePayload(interestSaved.body, "interest save");

  const interestTenantDenied = await call(sessions.businessA, "/api/member/interest-lodges", {
    method: "POST",
    body: { companyId: "cmp_b" }
  });
  assert.equal(interestTenantDenied.status, 403);
  assert.equal(interests.length, 1, "cross-tenant interest denial must not mutate fresh interests");

  const location = await call(sessions.businessA, "/api/location-card-request", {
    method: "POST",
    body: { companyRef: ownRef, key: "fresh-a-location" }
  });
  assert.equal(location.status, 200, JSON.stringify(location.body));
  assert.equal(location.body.items.length, 1);
  assert.equal(location.body.items[0].companyRef, ownRef);
  assertSafePayload(location.body, "location-card request");

  const locationList = await call(sessions.businessA, "/api/location-card-requests");
  assert.equal(locationList.status, 200);
  assert.equal(locationList.body.items.length, 1);
  assertSafePayload(locationList.body, "location-card list");

  const businessRunsDenied = await call(sessions.businessA, "/api/runs");
  assert.equal(businessRunsDenied.status, 403);
  const adminRuns = await call(sessions.admin, "/api/runs");
  assert.equal(adminRuns.status, 200);
  assert.equal(adminRuns.body.runs.length, jobs.length);
  assertSafePayload(adminRuns.body, "admin runs");
  const adminRun = await call(sessions.admin, "/api/runs/b2b-client-done-0001");
  assert.equal(adminRun.status, 200);
  assert.equal(adminRun.body.run.id, "b2b-client-done-0001");
  assert.equal(adminRun.body.items[0].companyName, "Fresh A Lodge");
  assertSafePayload(adminRun.body, "admin run detail");

  let legacyFallbackCalls = 0;
  async function routeWithPlatformFlag(enabled, pathname) {
    if (enabled && handler.isCorePath(new URL(pathname, "https://compat.test").pathname)) {
      return call(sessions.admin, pathname);
    }
    legacyFallbackCalls += 1;
    return { status: 299, body: { legacy: true } };
  }
  const freshCallsBeforeFlagOff = calls.freshCompanies + calls.freshJobs + calls.freshSubmit;
  const flagOff = await routeWithPlatformFlag(false, "/api/runs");
  assert.equal(flagOff.status, 299);
  assert.equal(flagOff.body.legacy, true);
  assert.equal(legacyFallbackCalls, 1);
  assert.equal(calls.freshCompanies + calls.freshJobs + calls.freshSubmit, freshCallsBeforeFlagOff, "flag-off must not enter the fresh compatibility handler");
  assert.equal(calls.legacyReads, 0, "enabled aliases must never read a legacy store");

  const syntheticService = createCoreService({
    repository: createCoreRepository(),
    authService,
    freshRepository,
    freshDataService: {
      ...freshDataService,
      metadata: () => ({ fixtureMode: true, providerMode: "synthetic", source: "synthetic-test-data", legacyRuntimeReads: 0, legacyRuntimeCopies: 0 })
    }
  });
  assert.throws(() => syntheticService.assertFreshCompatibility(), (error) => (
    error.statusCode === 503 && error.code === "CORE_SYNTHETIC_COMPATIBILITY_DISABLED"
  ));

  console.log(JSON.stringify({
    stage: "v2-legacy-fresh-compat",
    status: "passed",
    aliases: 13,
    legacyReads: calls.legacyReads,
    freshSubmitCalls: calls.freshSubmit,
    crossTenantDenied: true,
    syntheticUserResults: 0
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
