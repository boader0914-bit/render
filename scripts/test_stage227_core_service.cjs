"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./test_stage227_helpers.cjs");
const { createCoreRepository } = require("./integration/repositories/core_store.cjs");
const { createCoreService } = require("./integration/services/core_service.cjs");

const fixture = JSON.parse(fs.readFileSync(
  path.join(ROOT, "test", "fixtures", "stage227", "fresh_collection.json"),
  "utf8"
));
const BUSINESS_COMPANY_ID = "fresh-tenant-business";
const OTHER_COMPANY_ID = "fresh-tenant-other";
const businessSession = Object.freeze({
  accountId: "acct-stage227-business",
  account: { role: "b2b" },
  memberships: [{ companyId: BUSINESS_COMPANY_ID, companyName: "Fresh Tenant Business" }]
});
const otherBusinessSession = Object.freeze({
  accountId: "acct-stage227-other",
  account: { role: "b2b" },
  memberships: [{ companyId: OTHER_COMPANY_ID, companyName: "Fresh Tenant Other" }]
});
const adminSession = Object.freeze({
  accountId: "acct-stage227-admin",
  account: { role: "admin" },
  memberships: []
});

const authService = {
  async assertCompanyAccess(session, companyId) {
    const membership = session.memberships?.find((row) => row.companyId === companyId);
    if (session.account?.role !== "admin" && !membership) {
      const error = new Error("tenant denied");
      error.statusCode = 403;
      error.code = "AUTH_TENANT_FORBIDDEN";
      throw error;
    }
    return {
      company: { companyId, name: membership?.companyName || `Admin company ${companyId}` },
      membership: membership || null,
      entitlements: { plan: session.account?.role === "admin" ? "pro" : "free", dailySearchLimit: 2, exportLimit: 0 }
    };
  }
};

function deterministicIds() {
  let id = 0;
  return (prefix) => `${prefix}_stage227_${String(++id).padStart(4, "0")}`;
}

function errorCode(reason) {
  return reason && typeof reason === "object" ? reason.code : "";
}

(async () => {
  const emptyRepository = createCoreRepository();
  const emptyService = createCoreService({
    repository: emptyRepository,
    authService,
    clock: () => Date.parse("2026-07-29T06:00:00.000Z"),
    idFactory: deterministicIds()
  });
  const emptyWorkspace = await emptyService.workspace(businessSession, { view: "business-onboarding" });
  assert.equal(emptyWorkspace.metadata.source, "empty");
  assert.equal(emptyWorkspace.metadata.providerCalls, 0);
  assert.equal(emptyWorkspace.metadata.legacyRuntimeReads, 0);
  assert.equal(emptyWorkspace.state.kind, "empty");
  assert.deepEqual(emptyWorkspace.companies, []);
  assert.deepEqual(emptyWorkspace.history, []);
  assert.deepEqual(emptyWorkspace.interests, []);
  assert.equal(emptyWorkspace.metrics.companyCount, 0);
  assert.equal(emptyService.snapshotForTests().storeKind, "stage227-provisional-memory");

  const repository = createCoreRepository({ fixture });
  const service = createCoreService({
    repository,
    authService,
    clock: () => Date.parse("2026-07-29T06:10:00.000Z"),
    idFactory: deterministicIds()
  });
  const populated = await service.workspace(businessSession, { view: "business-activity" });
  assert.equal(populated.metadata.source, "synthetic-fresh-collection");
  assert.equal(populated.metadata.fixtureMode, true);
  assert.ok(["ready", "partial"].includes(populated.state.kind));
  assert.equal(populated.metrics.companyCount, fixture.companies.length);
  assert.equal(populated.metrics.completedJobCount, fixture.history.length);
  assert.deepEqual(
    populated.companies.map((company) => company.businessValues),
    fixture.companies.map((company) => company.businessValues),
    "the service must project fixture-authored business values without recalculation"
  );
  assert.ok(populated.history.every((row) => row.synthetic === true), "fixture history must be explicitly synthetic");

  const request = {
    kind: "business-search",
    clientRequestId: "stage227-search-0001",
    keyword: "Fresh search keyword",
    collectionMode: "precision",
    productMode: "all",
    detailRankRanges: "1-10"
  };
  const created = await service.createJob(businessSession, request);
  assert.equal(created.idempotent, false);
  assert.equal(created.job.status, "running");
  assert.equal(created.job.progress, 24);
  const replay = await service.createJob(businessSession, request);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.job.jobId, created.job.jobId);
  await assert.rejects(
    service.createJob(businessSession, { ...request, keyword: "Different request" }),
    (reason) => errorCode(reason) === "CORE_IDEMPOTENCY_CONFLICT"
  );

  const refreshedService = createCoreService({ repository, authService, idFactory: deterministicIds() });
  const recovered = refreshedService.jobFor(businessSession, request.clientRequestId);
  assert.equal(recovered.job.jobId, created.job.jobId, "refresh recovery must resolve the same in-memory fresh-store job by clientRequestId");
  const cancelled = refreshedService.cancelJob(businessSession, request.clientRequestId, { reason: "user-requested" });
  assert.equal(cancelled.idempotent, false);
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(cancelled.job.remainingSeconds, 0);
  const cancelledAgain = refreshedService.cancelJob(businessSession, request.clientRequestId);
  assert.equal(cancelledAgain.idempotent, true);
  const afterCancel = await refreshedService.workspace(businessSession, { view: "business-activity" });
  assert.ok(afterCancel.history.some((row) => row.clientRequestId === request.clientRequestId && row.status === "cancelled"));

  await assert.rejects(
    service.createJob(businessSession, { ...request, clientRequestId: "stage227-tenant-0001", tenantCompanyId: OTHER_COMPANY_ID }),
    (reason) => Number(reason.statusCode) === 403,
    "cross-company requests must be rejected by the auth service"
  );
  assert.throws(
    () => service.createTourismRequest(businessSession, { clientRequestId: "stage227-tourism-0001", regionCode: "all" }),
    (reason) => Number(reason.statusCode) === 403 && errorCode(reason) === "CORE_ROLE_FORBIDDEN"
  );
  await assert.rejects(
    service.createJob(adminSession, { ...request, clientRequestId: "stage227-admin-wrong-01" }),
    (reason) => Number(reason.statusCode) === 403 && errorCode(reason) === "CORE_ROLE_FORBIDDEN"
  );

  const fixtureCompanyId = fixture.companies[0].companyId;
  const interest = await service.addInterest(businessSession, { companyId: fixtureCompanyId });
  assert.equal(interest.idempotent, false);
  assert.equal((await service.addInterest(businessSession, { companyId: fixtureCompanyId })).idempotent, true);
  assert.equal((await service.workspace(businessSession, { view: "business-activity" })).interests.length, 1);
  assert.equal((await service.workspace(otherBusinessSession, { view: "business-activity" })).interests.length, 0, "interests are account/tenant scoped");
  assert.equal((await service.removeInterest(businessSession, fixtureCompanyId)).removed, 1);
  assert.equal((await service.removeInterest(businessSession, fixtureCompanyId)).idempotent, true);

  const locationPayload = { clientRequestId: "stage227-location-0001", companyId: fixtureCompanyId };
  const location = await service.createLocationCardRequest(businessSession, locationPayload);
  assert.equal(location.idempotent, false);
  assert.equal((await service.createLocationCardRequest(businessSession, locationPayload)).idempotent, true);
  assert.equal((await service.workspace(businessSession, { view: "business-location" })).locationCardRequests.length, 1);
  assert.equal((await service.workspace(otherBusinessSession, { view: "business-location" })).locationCardRequests.length, 0);

  const adminJob = await service.createJob(adminSession, {
    kind: "admin-collection",
    clientRequestId: "stage227-admin-collection-0001",
    collectionMode: "fast"
  });
  assert.equal(adminJob.job.kind, "admin-collection");
  const tourismPayload = { clientRequestId: "stage227-tourism-0002", regionCode: "all" };
  assert.equal(service.createTourismRequest(adminSession, tourismPayload).idempotent, false);
  assert.equal(service.createTourismRequest(adminSession, tourismPayload).idempotent, true);
  const adminWorkspace = await service.workspace(adminSession, { view: "admin-collection" });
  assert.equal(adminWorkspace.permissions.canManageCollection, true);
  assert.equal(adminWorkspace.permissions.canRequestTourism, true);
  assert.equal(adminWorkspace.tourismRequests.length, 1);
  assert.equal(Object.keys(adminWorkspace.connectors).length, 3);

  const snapshot = service.snapshotForTests();
  assert.equal(snapshot.jobs.length, 2, "only fresh provisional jobs are in the Stage 227 store");
  assert.equal(snapshot.tourismRequests.length, 1);
  assert.equal(snapshot.locationCardRequests.length, 1);
  assert.equal(snapshot.interests.length, 0);
  assert.equal(JSON.stringify(snapshot).includes("outputs"), false, "store rows must not expose legacy/raw output paths");

  console.log("Stage 227 empty/fixture service, role, tenant, idempotency, cancellation and refresh-recovery checks passed");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
