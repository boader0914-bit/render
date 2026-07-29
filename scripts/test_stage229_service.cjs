"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  INSIGHTS_ALGORITHM_VERSION,
  INSIGHTS_FIXTURE_VERSION,
  INSIGHTS_PROVIDER_ID
} = require("./integration/contracts/insights.cjs");
const {
  createInsightsRepository
} = require("./integration/repositories/insights_store.cjs");
const {
  createDeterministicInsightsFixtureProvider
} = require("./integration/services/insights_fixture_provider.cjs");
const {
  createInsightsService
} = require("./integration/services/insights_service.cjs");
const {
  ROOT,
  assertBusinessSafe,
  createMockFreshLayer,
  observationsFor,
  session,
  stage229Fixtures,
  temporaryDirectory
} = require("./test_support/stage229_test_helpers.cjs");

const TARGET_COMPANY_ID = "cmp_place_stage229_tenant";
const OTHER_COMPANY_ID = "cmp_place_stage229_other_tenant";
const UNOWNED_COMPANY_ID = "cmp_place_stage229_unowned";
const TENANT_ONE = "tenant_stage229_one";
const TENANT_TWO = "tenant_stage229_two";

function errorCode(error) {
  return error?.code || "";
}

async function cardLifecycle(service, admin, cardId, initialVersion = 1) {
  const draft = await service.createLocationDraft(admin, cardId, {
    expectedVersion: initialVersion,
    month: "2026-07",
    forecastMonth: "2026-08",
    editorial: { headline: "합성 입지카드", summary: "신규 관측만 사용한 검증 초안" }
  });
  assert.equal(draft.card.lifecycle, "draft");
  assert.equal(draft.card.algorithmVersion, INSIGHTS_ALGORITHM_VERSION);
  const edited = await service.editLocationDraft(admin, cardId, {
    expectedVersion: draft.card.version,
    editorial: { note: "Stage 229 검수 메모" }
  });
  assert.equal(edited.card.lifecycle, "draft");
  const submitted = await service.reviewLocationCard(admin, cardId, {
    expectedVersion: edited.card.version,
    decision: "submit",
    reason: "검수 요청"
  });
  assert.equal(submitted.card.lifecycle, "in-review");
  const changes = await service.reviewLocationCard(admin, cardId, {
    expectedVersion: submitted.card.version,
    decision: "request-changes",
    reason: "요약 문구 확인"
  });
  assert.equal(changes.card.lifecycle, "changes-requested");
  const revised = await service.editLocationDraft(admin, cardId, {
    expectedVersion: changes.card.version,
    editorial: { note: "요약 문구 확인 완료" }
  });
  assert.equal(revised.card.lifecycle, "draft");
  const resubmitted = await service.reviewLocationCard(admin, cardId, {
    expectedVersion: revised.card.version,
    decision: "submit",
    reason: "재검수 요청"
  });
  const reviewed = await service.reviewLocationCard(admin, cardId, {
    expectedVersion: resubmitted.card.version,
    decision: "approve",
    reason: "공개 승인"
  });
  assert.equal(reviewed.card.lifecycle, "reviewed");
  const published = await service.publishLocationCard(admin, cardId, {
    expectedVersion: reviewed.card.version
  });
  assert.equal(published.card.lifecycle, "published");
  assert.ok(published.card.publishedAt);
  return { draft, published };
}

async function reportLifecycle(service, admin, reportId, initialVersion = 1) {
  const draft = await service.createReportDraft(admin, reportId, {
    expectedVersion: initialVersion,
    forecastMonth: "2026-08",
    editorial: { headline: "2026년 8월 합성 리포트", summary: "business-safe 월간 요약" }
  });
  assert.equal(draft.report.lifecycle, "draft");
  assert.equal(draft.report.state, "ready");
  assert.deepEqual(draft.report.scopes.map((row) => row.scope), ["national", "region", "own", "anonymous-cohort"]);
  assert.ok(draft.report.scopes.every((row) => row.state === "ready"));
  const submitted = await service.reviewMonthlyReport(admin, reportId, {
    expectedVersion: draft.report.version,
    decision: "submit",
    reason: "월간 검수 요청"
  });
  const reviewed = await service.reviewMonthlyReport(admin, reportId, {
    expectedVersion: submitted.report.version,
    decision: "approve",
    reason: "월간 공개 승인"
  });
  assert.equal(reviewed.report.lifecycle, "reviewed");
  const published = await service.publishMonthlyReport(admin, reportId, {
    expectedVersion: reviewed.report.version
  });
  assert.equal(published.report.lifecycle, "published");
  assert.equal(published.report.resultAvailable, true);
  return { draft, published };
}

async function main() {
  const freshRoot = temporaryDirectory("stage229-service-fresh-");
  const legacyRoot = temporaryDirectory("stage229-service-legacy-");
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
    freshStoreId: "fresh_store_stage229_service",
    clock: () => tick,
    idFactory: () => `stage229service${String(++serial).padStart(6, "0")}`,
    legacyPaths: [legacyRoot, path.join(legacyRoot, "config"), path.join(legacyRoot, "outputs")]
  };
  try {
    const repository = createInsightsRepository(repositoryOptions);
    const initialized = await repository.initialize();
    assert.equal(initialized.algorithmVersion, INSIGHTS_ALGORITHM_VERSION);
    assert.equal(initialized.fixtureVersion, INSIGHTS_FIXTURE_VERSION);
    assert.deepEqual(initialized.counts, {
      signals: 0,
      evidenceSnapshots: 0,
      locationCards: 0,
      monthlyReports: 0,
      audit: 1
    });

    const { signal } = stage229Fixtures();
    const provider = createDeterministicInsightsFixtureProvider({ fixture: signal });
    const fresh = createMockFreshLayer();
    fresh.companies.set(UNOWNED_COMPANY_ID, {
      companyId: UNOWNED_COMPANY_ID,
      companyName: "Stage 229 unowned fresh identity",
      name: "Stage 229 unowned fresh identity",
      region: "Stage 229 synthetic region",
      regionLabel: "Stage 229 synthetic region",
      category: "glamping",
      tenantCompanyIds: [],
      synthetic: true
    });
    fresh.observations.set(UNOWNED_COMPANY_ID, observationsFor(fresh.readyCase, UNOWNED_COMPANY_ID));
    fresh.observations.get(TARGET_COMPANY_ID).push({
      observationId: "obs_stage229_service_ancient_irrelevant",
      companyId: TARGET_COMPANY_ID,
      kind: "quick.profile",
      observedAt: "2025-01-01T00:00:00.000Z",
      value: true,
      synthetic: true
    });
    fresh.observations.get("cmp_place_stage229_cohort_a").push({
      observationId: "obs_stage229_service_peer_ancient_irrelevant",
      companyId: "cmp_place_stage229_cohort_a",
      kind: "quick.profile",
      observedAt: "2025-01-01T00:00:00.000Z",
      value: true,
      synthetic: true
    });
    const service = createInsightsService({
      repository,
      provider,
      freshRepository: fresh.freshRepository,
      freshService: fresh.freshService,
      authService: fresh.authService,
      capabilities: { reliability: true, locationCard: true, businessReport: true },
      clock: () => tick
    });
    const admin = session("admin", "", "admin");
    const businessOne = session("business", TENANT_ONE, "business-one");
    const businessTwo = session("business", TENANT_TWO, "business-two");

    assert.deepEqual(service.metadata(), {
      stage: 229,
      algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
      fixtureVersion: INSIGHTS_FIXTURE_VERSION,
      providerId: INSIGHTS_PROVIDER_ID,
      fixtureMode: true,
      dataBoundary: "fresh-integration-stage229-only",
      capabilities: { reliability: true, locationCard: true, businessReport: true },
      externalProviderCalls: 0,
      credentialReads: 0,
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      productionMutations: 0
    });

    const requestPayload = {
      companyId: TARGET_COMPANY_ID,
      clientRequestId: "stage229-location-request-0001"
    };
    const requested = await service.requestLocationCard(businessOne, requestPayload);
    assert.equal(requested.idempotent, false);
    assert.equal(requested.request.lifecycle, "requested");
    assert.equal((await service.requestLocationCard(businessOne, requestPayload)).idempotent, true);
    await assert.rejects(
      service.createLocationDraft(admin, requested.request.cardId, {
        expectedVersion: 1,
        month: "2026-07",
        forecastMonth: "2026-09"
      }),
      (error) => errorCode(error) === "INSIGHTS_FORECAST_MONTH_INVALID" && error.statusCode === 400,
      "card forecast month must be the exact month after asOf"
    );
    const beforePublish = await service.listLocationCards(businessOne, { companyId: TARGET_COMPANY_ID });
    assert.equal(beforePublish.state, "not-published");
    assert.deepEqual(beforePublish.cards, []);

    await assert.rejects(
      service.createLocationDraft(businessOne, requested.request.cardId, {}),
      (error) => errorCode(error) === "INSIGHTS_ROLE_FORBIDDEN" && error.statusCode === 403
    );
    await assert.rejects(
      service.requestLocationCard(businessOne, {
        companyId: OTHER_COMPANY_ID,
        clientRequestId: "stage229-tenant-escape-0001"
      }),
      (error) => errorCode(error) === "INSIGHTS_TENANT_FORBIDDEN" && error.statusCode === 403
    );
    await assert.rejects(
      service.listLocationCards(businessTwo, { companyId: TARGET_COMPANY_ID }),
      (error) => errorCode(error) === "INSIGHTS_TENANT_FORBIDDEN" && error.statusCode === 403
    );

    const cardFlow = await cardLifecycle(service, admin, requested.request.cardId);
    assert.equal(cardFlow.draft.card.state, "ready");
    assert.equal(cardFlow.draft.card.overallScore, 76.2);
    assert.equal(cardFlow.draft.card.forecast.forecastMonth, "2026-08");
    assert.equal(cardFlow.draft.card.forecast.sampleCount, 3);
    assert.equal(cardFlow.draft.card.evidence.algorithmVersion, INSIGHTS_ALGORITHM_VERSION);
    assert.equal(JSON.stringify(cardFlow.draft).includes("evidenceSnapshotId"), false, "admin card projection must not expose an evidence snapshot ID");
    assert.ok((await repository.listSignals({ companyId: TARGET_COMPANY_ID, limit: 100 })).every((row) => row.periodMonth === "2026-07"), "signal fixture period must equal the asOf month");
    const storedCard = await repository.getLocationCard(requested.request.cardId);
    assert.ok(storedCard.evidenceSnapshotId, "the internal durable record keeps the evidence snapshot relation");
    const cardEvidence = await repository.getEvidenceSnapshot(storedCard.evidenceSnapshotId);
    assert.ok(cardEvidence, "repository-only evidence lookup must recover the exact internal snapshot");
    assert.equal(cardEvidence.internal.observationIds.includes("obs_stage229_service_ancient_irrelevant"), false);
    assert.equal(cardEvidence.internal.observationIds.length, 19, "card evidence must keep only complete D14/D7/D1 rows and scored OTA");
    assert.equal(cardEvidence.internal.signalIds.length, 9, "card evidence must keep one latest signal for every required kind");
    const publishedCards = await service.listLocationCards(businessOne, { companyId: TARGET_COMPANY_ID });
    assert.equal(publishedCards.state, "ready");
    assert.equal(publishedCards.cards.length, 1);
    assert.equal(publishedCards.cards[0].lifecycle, "published");
    assert.equal(publishedCards.cards[0].overallScore, 76.2);
    assert.deepEqual(publishedCards.cards[0].allowedActions, []);
    assert.equal(publishedCards.cards[0].audit, undefined);
    assert.equal(JSON.stringify(publishedCards).includes(storedCard.evidenceSnapshotId), false, "business card projection must not expose an evidence snapshot ID");
    assertBusinessSafe(publishedCards, {
      allowedCompanyIds: [TARGET_COMPANY_ID],
      forbiddenCompanyIds: [OTHER_COMPANY_ID, "cmp_place_stage229_cohort_a", "cmp_place_stage229_cohort_b", "cmp_place_stage229_cohort_c"]
    });

    await assert.rejects(
      service.createMonthlyReport(admin, {
        companyId: TARGET_COMPANY_ID,
        tenantCompanyId: TENANT_ONE,
        clientRequestId: "stage229-invalid-month-report",
        month: "2026-09"
      }),
      (error) => errorCode(error) === "INSIGHTS_FORECAST_MONTH_INVALID" && error.statusCode === 400,
      "report month must be the exact month after asOf"
    );
    const reportRequested = await service.createMonthlyReport(admin, {
      companyId: TARGET_COMPANY_ID,
      tenantCompanyId: TENANT_ONE,
      clientRequestId: "stage229-monthly-report-0001",
      month: "2026-08"
    });
    assert.equal(reportRequested.idempotent, false);
    assert.equal((await service.createMonthlyReport(admin, {
      companyId: TARGET_COMPANY_ID,
      tenantCompanyId: TENANT_ONE,
      clientRequestId: "stage229-monthly-report-0001",
      month: "2026-08"
    })).idempotent, true);
    await assert.rejects(
      service.createReportDraft(admin, reportRequested.report.reportId, {
        expectedVersion: 1,
        forecastMonth: "2026-09"
      }),
      (error) => errorCode(error) === "INSIGHTS_FORECAST_MONTH_INVALID" && error.statusCode === 400,
      "report forecast month must equal its exact next-month report month"
    );
    const reportFlow = await reportLifecycle(service, admin, reportRequested.report.reportId);
    assert.equal(reportFlow.draft.report.forecast.forecastMonth, "2026-08");
    assert.equal(reportFlow.draft.report.locationCardPath, "/app/location");
    assert.equal(JSON.stringify(reportFlow.draft).includes("evidenceSnapshotId"), false, "admin report projection must not expose an evidence snapshot ID");
    assert.ok((await repository.listSignals({ companyId: TARGET_COMPANY_ID, limit: 100 })).every((row) => row.periodMonth === "2026-07"), "report draft must collect signals for the current asOf month, not the forecast month");
    const storedReport = await repository.getMonthlyReport(reportRequested.report.reportId);
    assert.ok(storedReport.evidenceSnapshotId, "the internal report record must retain its evidence relation");
    const reportEvidence = await repository.getEvidenceSnapshot(storedReport.evidenceSnapshotId);
    const peerIds = [
      "cmp_place_stage229_cohort_a",
      "cmp_place_stage229_cohort_b",
      "cmp_place_stage229_cohort_c"
    ];
    const expectedPeerMetricIds = peerIds.flatMap((companyId) => (
      fresh.observations.get(companyId)
        .filter((row) => ["product.price", "ota.exposure"].includes(row.kind))
        .map((row) => row.observationId)
    ));
    assert.ok(expectedPeerMetricIds.every((id) => reportEvidence.internal.observationIds.includes(id)), "internal report evidence must include each eligible peer's scored metric IDs");
    assert.equal(reportEvidence.internal.observationIds.includes("obs_stage229_service_peer_ancient_irrelevant"), false);
    assert.deepEqual(reportEvidence.internal.reportLineage.scopeCompanyIds.anonymousCohort, peerIds);
    assert.equal(
      reportEvidence.internal.reportLineage.companyIds.includes(UNOWNED_COMPANY_ID),
      false,
      "an unowned fresh identity must never enter national report lineage"
    );
    assert.equal(
      Object.values(reportEvidence.internal.reportLineage.scopeCompanyIds).flat().includes(UNOWNED_COMPANY_ID),
      false,
      "an unowned fresh identity must never enter any cohort/report scope"
    );
    const unownedMetricIds = fresh.observations.get(UNOWNED_COMPANY_ID).map((row) => row.observationId);
    assert.ok(
      unownedMetricIds.every((id) => !reportEvidence.internal.observationIds.includes(id)),
      "an unowned fresh identity must not contribute report evidence observations"
    );
    assert.match(reportEvidence.internal.reportLineage.cohortSnapshotHash, /^[a-f0-9]{64}$/);
    const publishedReports = await service.listMonthlyReports(businessOne, {
      companyId: TARGET_COMPANY_ID,
      month: "2026-08"
    });
    assert.equal(publishedReports.state, "ready");
    assert.equal(publishedReports.reports.length, 1);
    assert.equal(publishedReports.locationCardPath, "/app/location");
    assert.equal(publishedReports.reports[0].locationCardPath, "/app/location");
    assert.equal(publishedReports.reports[0].audit, undefined);
    const businessReportJson = JSON.stringify(publishedReports);
    assert.equal(businessReportJson.includes(storedReport.evidenceSnapshotId), false, "business report projection must not expose an evidence snapshot ID");
    assert.ok(expectedPeerMetricIds.every((id) => !businessReportJson.includes(id)), "business report projection must not expose peer evidence row IDs");
    assertBusinessSafe(publishedReports, {
      allowedCompanyIds: [TARGET_COMPANY_ID],
      forbiddenCompanyIds: [OTHER_COMPANY_ID, "cmp_place_stage229_cohort_a", "cmp_place_stage229_cohort_b", "cmp_place_stage229_cohort_c"]
    });

    const businessWorkspace = await service.workspace(businessOne, { view: "business-report", month: "2026-08" });
    assert.equal(businessWorkspace.state, "ready");
    assert.equal(businessWorkspace.locationCardPath, "/app/location");
    assert.equal(Object.hasOwn(businessWorkspace, "audit"), true);
    assert.equal(businessWorkspace.audit, undefined);
    assertBusinessSafe(businessWorkspace, {
      allowedCompanyIds: [TARGET_COMPANY_ID],
      forbiddenCompanyIds: [OTHER_COMPANY_ID, "cmp_place_stage229_cohort_a", "cmp_place_stage229_cohort_b", "cmp_place_stage229_cohort_c"]
    });
    await assert.rejects(
      service.workspace(businessOne, { view: "business-report", companyId: OTHER_COMPANY_ID }),
      (error) => errorCode(error) === "INSIGHTS_TENANT_FORBIDDEN" && error.statusCode === 403
    );

    const collectingFresh = createMockFreshLayer({
      runs: [{ runId: "run_stage229_collecting", companyId: OTHER_COMPANY_ID, status: "running" }]
    });
    const collectingService = createInsightsService({
      repository,
      provider,
      freshRepository: collectingFresh.freshRepository,
      freshService: collectingFresh.freshService,
      authService: collectingFresh.authService,
      capabilities: { reliability: true, locationCard: true, businessReport: true },
      clock: () => tick
    });
    const collectingReports = await collectingService.listMonthlyReports(businessTwo, {
      companyId: OTHER_COMPANY_ID,
      month: "2026-08"
    });
    assert.equal(collectingReports.reports.length, 0);
    assert.equal(collectingReports.state, "collecting", "an active fresh run with no report must remain collecting");
    const collectingWorkspace = await collectingService.workspace(businessTwo, { view: "business-report", month: "2026-08" });
    assert.equal(collectingWorkspace.state, "collecting", "business report workspace must preserve the collecting state");

    const insufficientRequest = await service.requestLocationCard(businessTwo, {
      companyId: OTHER_COMPANY_ID,
      clientRequestId: "stage229-insufficient-card-0001"
    });
    const insufficientDraft = await service.createLocationDraft(admin, insufficientRequest.request.cardId, {
      expectedVersion: 1,
      month: "2026-07",
      forecastMonth: "2026-08",
      editorial: { headline: "표본 부족 검증 카드" }
    });
    assert.equal(insufficientDraft.card.state, "insufficient-data");
    assert.equal(insufficientDraft.card.overallScore, null);
    assert.equal(insufficientDraft.card.forecast.value, null);
    const insufficientSubmitted = await service.reviewLocationCard(admin, insufficientRequest.request.cardId, {
      expectedVersion: insufficientDraft.card.version,
      decision: "submit",
      reason: "표본 gate 검증"
    });
    const insufficientReviewed = await service.reviewLocationCard(admin, insufficientRequest.request.cardId, {
      expectedVersion: insufficientSubmitted.card.version,
      decision: "approve",
      reason: "공개 시도 전 검증"
    });
    await assert.rejects(
      service.publishLocationCard(admin, insufficientRequest.request.cardId, {
        expectedVersion: insufficientReviewed.card.version
      }),
      (error) => errorCode(error) === "INSIGHTS_SAMPLE_GATE" && error.statusCode === 409,
      "minimum sample gate must block publication even after review"
    );
    const insufficientPublic = await service.listLocationCards(businessTwo, { companyId: OTHER_COMPANY_ID });
    assert.equal(insufficientPublic.state, "not-published");
    assert.deepEqual(insufficientPublic.cards, []);
    const insufficientAdmin = await service.listLocationCards(admin, {
      companyId: OTHER_COMPANY_ID,
      tenantCompanyId: TENANT_TWO
    });
    assert.equal(insufficientAdmin.cards[0].state, "insufficient-data");
    assert.equal(insufficientAdmin.cards[0].overallScore, null);
    assert.equal(insufficientAdmin.cards[0].forecast.value, null);
    assert.equal(insufficientAdmin.cards[0].forecast.interval, null);
    assertBusinessSafe(insufficientPublic, {
      allowedCompanyIds: [OTHER_COMPANY_ID],
      forbiddenCompanyIds: [TARGET_COMPANY_ID, "cmp_place_stage229_cohort_a", "cmp_place_stage229_cohort_b", "cmp_place_stage229_cohort_c"]
    });

    const snapshot = await service.createSnapshot(admin, "after-stage229-publish");
    assert.ok(snapshot.snapshot.snapshotId);
    const extraRequest = await service.requestLocationCard(businessOne, {
      companyId: TARGET_COMPANY_ID,
      clientRequestId: "stage229-after-snapshot-0002"
    });
    assert.equal(extraRequest.idempotent, false);
    assert.equal((await repository.listLocationCards({ companyId: TARGET_COMPANY_ID })).length, 2);
    const snapshotRoot = path.join(freshRoot, "stage229-insights", "snapshots", snapshot.snapshot.snapshotId);
    const snapshotManifest = JSON.parse(fs.readFileSync(path.join(snapshotRoot, "snapshot.json"), "utf8"));
    const tamperEntry = snapshotManifest.files.find((entry) => entry.relative.includes("location-cards"))
      || snapshotManifest.files.find((entry) => entry.relative !== "manifest.json");
    assert.ok(tamperEntry, "snapshot must contain a managed file to verify before restore");
    const tamperPath = path.join(snapshotRoot, "files", ...tamperEntry.relative.split("/"));
    const pristineSnapshotBytes = fs.readFileSync(tamperPath);
    fs.appendFileSync(tamperPath, "\ncorrupt-after-snapshot");
    await assert.rejects(
      service.rollbackSnapshot(admin, snapshot.snapshot.snapshotId),
      (error) => errorCode(error) === "INSIGHTS_SNAPSHOT_CORRUPT" && error.statusCode === 500,
      "a late snapshot-file checksum mismatch must fail before any live-store write"
    );
    assert.equal((await repository.listLocationCards({ companyId: TARGET_COMPANY_ID })).length, 2, "failed rollback must leave the live card state unchanged");
    assert.equal((await repository.listMonthlyReports({ companyId: TARGET_COMPANY_ID, month: "2026-08" })).length, 1, "failed rollback must leave the live report state unchanged");
    assert.deepEqual(
      fs.readdirSync(path.join(freshRoot, "stage229-insights")).filter((name) => name.startsWith(".stage229-restore-")),
      [],
      "failed preflight must clean its isolated restore transaction"
    );
    fs.writeFileSync(tamperPath, pristineSnapshotBytes);

    const ownershipDraft = await service.createLocationDraft(admin, extraRequest.request.cardId, {
      expectedVersion: 1,
      month: "2026-07",
      forecastMonth: "2026-08",
      editorial: { headline: "ownership drift 검증 카드" }
    });
    const targetIdentity = fresh.companies.get(TARGET_COMPANY_ID);
    const originalTenantCompanyIds = [...targetIdentity.tenantCompanyIds];
    targetIdentity.tenantCompanyIds = ["tenant_stage229_reassigned"];
    await assert.rejects(
      service.reviewLocationCard(admin, extraRequest.request.cardId, {
        expectedVersion: ownershipDraft.card.version,
        decision: "submit",
        reason: "소유권 변경 후 검수 차단"
      }),
      (error) => errorCode(error) === "INSIGHTS_TENANT_FORBIDDEN" && error.statusCode === 403,
      "stored card ownership must be revalidated against the current fresh identity"
    );
    targetIdentity.tenantCompanyIds = originalTenantCompanyIds;

    const staleCardRequest = await service.requestLocationCard(businessOne, {
      companyId: TARGET_COMPANY_ID,
      clientRequestId: "stage229-stale-publish-card-0003"
    });
    const staleCardDraft = await service.createLocationDraft(admin, staleCardRequest.request.cardId, {
      expectedVersion: 1,
      month: "2026-07",
      forecastMonth: "2026-08",
      editorial: { headline: "publish freshness 재검증 카드" }
    });
    const staleCardSubmitted = await service.reviewLocationCard(admin, staleCardRequest.request.cardId, {
      expectedVersion: staleCardDraft.card.version,
      decision: "submit",
      reason: "freshness 재검증"
    });
    const staleCardReviewed = await service.reviewLocationCard(admin, staleCardRequest.request.cardId, {
      expectedVersion: staleCardSubmitted.card.version,
      decision: "approve",
      reason: "시간 경과 전 승인"
    });
    const freshTick = tick;
    tick += 25 * 3_600_000;
    await assert.rejects(
      service.publishLocationCard(admin, staleCardRequest.request.cardId, {
        expectedVersion: staleCardReviewed.card.version
      }),
      (error) => errorCode(error) === "INSIGHTS_SAMPLE_GATE" && error.statusCode === 409,
      "draft-time freshness must be rechecked after 24 hours before card publication"
    );
    tick = freshTick;

    const ownershipReportRequest = await service.createMonthlyReport(admin, {
      companyId: TARGET_COMPANY_ID,
      tenantCompanyId: TENANT_ONE,
      clientRequestId: "stage229-report-ownership-drift-0002",
      month: "2026-08"
    });
    const ownershipReportDraft = await service.createReportDraft(admin, ownershipReportRequest.report.reportId, {
      expectedVersion: 1,
      forecastMonth: "2026-08",
      editorial: { headline: "report ownership drift 검증" }
    });
    targetIdentity.tenantCompanyIds = ["tenant_stage229_reassigned"];
    await assert.rejects(
      service.editReportDraft(admin, ownershipReportRequest.report.reportId, {
        expectedVersion: ownershipReportDraft.report.version,
        editorial: { note: "변경된 소유권에서는 저장 금지" }
      }),
      (error) => errorCode(error) === "INSIGHTS_TENANT_FORBIDDEN" && error.statusCode === 403,
      "stored report ownership must be revalidated against the current fresh identity"
    );
    targetIdentity.tenantCompanyIds = originalTenantCompanyIds;

    const staleReportRequest = await service.createMonthlyReport(admin, {
      companyId: TARGET_COMPANY_ID,
      tenantCompanyId: TENANT_ONE,
      clientRequestId: "stage229-stale-publish-report-0003",
      month: "2026-08"
    });
    const staleReportDraft = await service.createReportDraft(admin, staleReportRequest.report.reportId, {
      expectedVersion: 1,
      forecastMonth: "2026-08",
      editorial: { headline: "report publish freshness 재검증" }
    });
    const staleReportSubmitted = await service.reviewMonthlyReport(admin, staleReportRequest.report.reportId, {
      expectedVersion: staleReportDraft.report.version,
      decision: "submit",
      reason: "freshness 재검증"
    });
    const staleReportReviewed = await service.reviewMonthlyReport(admin, staleReportRequest.report.reportId, {
      expectedVersion: staleReportSubmitted.report.version,
      decision: "approve",
      reason: "시간 경과 전 승인"
    });
    tick += 25 * 3_600_000;
    await assert.rejects(
      service.publishMonthlyReport(admin, staleReportRequest.report.reportId, {
        expectedVersion: staleReportReviewed.report.version
      }),
      (error) => errorCode(error) === "INSIGHTS_SAMPLE_GATE" && error.statusCode === 409,
      "draft-time freshness must be rechecked after 24 hours before report publication"
    );
    tick = freshTick;

    tick += 1_000;
    const rolledBack = await service.rollbackSnapshot(admin, snapshot.snapshot.snapshotId);
    assert.equal(rolledBack.ok, true);
    assert.equal((await repository.listLocationCards({ companyId: TARGET_COMPANY_ID })).length, 1);
    const rollbackAudit = await repository.listAudit({ event: "insights.snapshot.rolled-back", limit: 10 });
    assert.equal(rollbackAudit.length, 1);
    assert.equal(rollbackAudit[0].details.snapshotId, snapshot.snapshot.snapshotId);

    const diagnostics = await repository.diagnostics();
    assert.equal(diagnostics.externalRequests, 0);
    assert.equal(diagnostics.credentialReads, 0);
    assert.equal(diagnostics.legacyRuntimeReads, 0);
    assert.equal(diagnostics.legacyRuntimeCopies, 0);
    assert.equal(diagnostics.productionMutations, 0);
    assert.ok(diagnostics.counts.audit >= 1);
    assert.equal(provider.diagnostics().externalRequests, 0);
    assert.equal(provider.diagnostics().credentialReads, 0);

    const restartedRepository = createInsightsRepository({
      ...repositoryOptions,
      idFactory: () => `unusedrestart${String(++serial).padStart(6, "0")}`
    });
    const restarted = await restartedRepository.initialize();
    assert.equal(restarted.storeId, initialized.storeId);
    assert.equal((await restartedRepository.listLocationCards({ companyId: TARGET_COMPANY_ID })).length, 1);
    assert.equal((await restartedRepository.listMonthlyReports({ companyId: TARGET_COMPANY_ID, month: "2026-08" })).length, 1);

    assert.equal(fs.readdirSync(legacyRoot).length, 0, "Stage 229 must not read, copy or write legacy runtime directories");
    console.log("Stage 229 service tenant, cold-start, lifecycle, publication, audit, rollback and restart checks passed");
  } finally {
    fs.rmSync(freshRoot, { recursive: true, force: true });
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
