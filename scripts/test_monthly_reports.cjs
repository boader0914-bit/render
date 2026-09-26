"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMonthlyReportService, monthlyReportKeywordMembership } = require("./lib/monthly_reports.cjs");

const COMPANY_A = { companyId: "company-a", primaryName: "같은 이름", regionKey: "local-a", regionKeys: ["local-a", "broad"], keywords: ["키워드", "다른키워드"] };
const COMPANY_B = { companyId: "company-b", primaryName: "두 번째 숙소", regionKey: "local-b", regionKeys: ["local-b", "broad"], keywords: ["키워드"] };
const COMPANY_OTHER = { companyId: "different-id", primaryName: "같은 이름", regionKey: "other", keywords: ["키워드X"] };
const run = (id, quality = "complete", keyword = "키워드") => ({ id, keyword, collectedAt: "2026-08-28T03:00:00.000Z", collectionQuality: { status: quality } });
const row = (overrides = {}) => ({
  companyKey: "company-a", companyName: "같은 이름", runId: "normal", keyword: "키워드", collectedAt: "2026-08-28T03:00:00.000Z",
  stayDate: "2026-09-01", productType: "lodging", inventoryEvidenceVersion: 4,
  supply: 10, sold: 2, publicBookings: 1, phoneBookings: 1,
  publicRevenue: 100, phoneRevenue: 100, estimatedRevenue: 200,
  phonePricedBookings: 1, phoneMissingPriceBookings: 0, phoneFallbackRevenue: 0, phoneFallbackBookings: 0,
  sharedDayUseExcluded: 2, explicitBlockedBookings: 0, explicitBlockedRevenue: 0,
  partial: false, missing: false, unknownUnavailable: 0, ...overrides
});
const request = { month: "2026-09", type: "region", targetId: "broad", cutoffDate: "2026-09-30" };

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-reports-test-"));
  try {
    let now = new Date("2026-10-01T03:00:00.000Z");
    const early = row();
    let sources = {
      companies: [COMPANY_A, COMPANY_B, COMPANY_OTHER], regions: [{ id: "broad", label: "광역 지역" }],
      runs: [run("normal"), run("latest", "reused", "다른키워드"), run("failed", "failed"), run("blocked", "blocked"), run("interrupted", "interrupted"), run("partial", "partial"), { id: "legacy", keyword: "키워드" }],
      observations: [
        early, { ...early },
        row({ runId: "latest", keyword: "다른키워드", collectedAt: "2026-09-01T14:59:00.000Z", sold: 3, publicBookings: 2, publicRevenue: 200, estimatedRevenue: 300 }),
        row({ collectedAt: "2026-09-01T15:00:00.000Z", sold: 9, publicBookings: 8, publicRevenue: 800, estimatedRevenue: 900 }),
        row({ runId: "failed", collectedAt: "2026-09-01T14:58:00.000Z", sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }),
        row({ companyKey: "company-b", supply: 5, sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }),
        row({ stayDate: "2026-09-02", missing: true, sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }),
        row({ stayDate: "2026-09-03", partial: true, sharedDayUseIncomplete: true, sold: 7, publicBookings: 2, phoneBookings: 5, publicRevenue: 200, phoneRevenue: 500, estimatedRevenue: 700, explicitBlockedBookings: 2, explicitBlockedRevenue: 200 }),
        row({ stayDate: "2026-09-04", sold: 5, publicBookings: 4, publicRevenue: 400, estimatedRevenue: 500 }),
        row({ stayDate: "2026-09-04", collectedAt: "2026-09-03T03:00:00.000Z", partial: true, sold: 7, publicBookings: 2, phoneBookings: 5, publicRevenue: 200, phoneRevenue: 500, estimatedRevenue: 700, explicitBlockedRevenue: 200 }),
        row({ stayDate: "2026-09-01", productType: "dayuse", supply: 3, sold: 2, publicBookings: 2, phoneBookings: 0, publicRevenue: 100, phoneRevenue: 0, estimatedRevenue: 100, sharedDayUseExcluded: 0, dayUseScheduleStatus: "requested" }),
        row({ runId: "partial", stayDate: "2026-09-05" }),
        row({ stayDate: "2026-09-06", estimatedRevenue: 999 }),
        row({ stayDate: "2026-09-07", inventoryEvidenceVersion: 2 }),
        row({ stayDate: "2026-09-08", runId: "legacy" }),
        row({ stayDate: "2026-09-09", sold: 2, publicBookings: 0, phoneBookings: 2, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0, phonePricedBookings: 0, phoneMissingPriceBookings: 2 }),
        row({ stayDate: "2026-09-10", phonePriceEstimates: [{ sourceDate: "2026-09-11", source: "same_product_nearest_date", quantity: 1, revenue: 100, unitPrice: 100 }] }),
        row({ stayDate: "2026-09-11", runId: "blocked" }),
        row({ stayDate: "2026-09-12", runId: "interrupted" }),
        row({ stayDate: "2026-09-13", collectedAt: "2026-10-01T00:00:00.000Z" }),
        row({ stayDate: "2026-09-31" }),
        row({ companyKey: "different-id", keyword: "키워드X", sold: 10, publicBookings: 9, publicRevenue: 900, estimatedRevenue: 1000 }),
        row({ stayDate: "2025-09-01", collectedAt: "2025-08-30T00:00:00.000Z" }),
        row({ stayDate: "2026-08-31" }), row({ stayDate: "2026-10-01" })
      ],
      rankObservations: [
        { companyId: "company-a", runId: "normal", keyword: "키워드", rank: 10, collectedAt: "2026-09-01T00:00:00Z" },
        { companyId: "company-a", runId: "normal", keyword: "키워드", rank: 6, collectedAt: "2026-09-25T00:00:00Z" },
        { companyId: "company-a", runId: "normal", keyword: "다른키워드", rank: 3, collectedAt: "2026-09-25T00:00:00Z" },
        { companyId: "company-a", runId: "failed", keyword: "키워드", rank: 1, collectedAt: "2026-09-26T00:00:00Z" }
      ], context: { networkAttempted: false, sources: [] }, warnings: ["저장 원문 기반 보고서입니다."], sourceDiagnostics: { malformedHistoryLines: 1 }
    };
    let reads = 0;
    const loadSources = async () => { reads += 1; return sources; };
    const service = createMonthlyReportService({ dataDir: temporary, loadSources, now: () => now });
    const snapshot = await service.preview(request);
    const lodging = snapshot.summary.lodging;
    assert.equal(snapshot.target.label, "광역 지역");
    assert.equal(snapshot.period.start, "2026-09-01");
    assert.equal(snapshot.period.end, "2026-09-30");
    assert.equal(snapshot.period.monthClosed, true);
    assert.equal(snapshot.quality.expectedCompanyDays, 60, "broad region membership includes both local regions");
    assert.equal(snapshot.companies.length, 2);
    assert.equal(lodging.coveredCompanyDays, 7);
    assert.equal(lodging.supply, 65, "each company/stay/product is counted once, never every snapshot");
    assert.equal(lodging.sold, 16);
    assert.equal(lodging.estimatedRevenue, 1000, "unpriced/inconsistent/after-stay price evidence is unavailable");
    assert.equal(lodging.revenueCoveredCompanyDays, 4);
    assert.equal(lodging.knownPartialRevenue, 400, "public plus explicit block subtotal excludes unexplained phone gaps");
    assert.equal(lodging.knownPartialPublicRevenue, 200);
    assert.equal(lodging.knownPartialBlockedRevenue, 200);
    assert.equal(lodging.knownPartialCompanyDays, 1, "known partial totals never repeat a selected valid company-day");
    assert.equal(lodging.reservationRate, Number((16 / 65).toFixed(6)));
    assert.equal(lodging.rateDenominator, "covered_supply");
    assert.equal(lodging.partial, true);
    assert.equal(lodging.sameDayObservedCompanyDays, 1);
    assert.equal(lodging.staleDays, 6);
    assert.equal(snapshot.quality.maxObservationLeadTimeDays, 13);
    assert.equal(snapshot.summary.dayuse.sold, 2);
    assert.equal(snapshot.summary.dayuse.estimatedRevenue, 100, "day-use revenue remains separate");
    assert.equal(snapshot.daily[1].lodging.sold, null, "missing and failed zeros are not observations");
    assert.equal(snapshot.companies.find(company => company.companyId === "company-b").daily[0].lodging.sold, 0, "an observed zero remains a real zero");
    assert.equal(snapshot.sources.observations.find(value => value.date === "2026-09-01" && value.companyId === "company-a" && value.productType === "lodging").runId, "latest");
    assert.equal(snapshot.sources.partialEvidence.filter(value => !value.includedInPartialSubtotal).length, 1);
    assert.deepEqual(snapshot.sources.partialRunIds, ["partial"]);
    for (const reason of ["post_stay_observation", "duplicate_observation", "superseded_observation", "run_failed", "run_blocked", "run_interrupted", "unknown_legacy_run_quality", "legacy_inventory_evidence", "partial_inventory", "missing_response", "after_cutoff", "invalid_stay_date"]) {
      assert.ok(snapshot.quality.discardedByReason[reason] > 0, reason);
    }
    assert.equal(snapshot.changes.lodging.comparablePairs, 1);
    assert.equal(snapshot.changes.lodging.soldChange, 1, "comparison uses the same company and stay date");
    assert.equal(snapshot.ranks.rows.find(value => value.keyword === "키워드").rankImprovement, 4);
    assert.equal(snapshot.ranks.rows.find(value => value.keyword === "다른키워드").rankImprovement, null, "single rank observation is not a movement");
    assert.equal(snapshot.quality.sourceDiagnostics.malformedHistoryLines, 1);
    assert.ok(snapshot.quality.warnings.includes("저장 원문 기반 보고서입니다."));

    const company = await service.preview({ ...request, type: "company", targetId: "company-a" });
    assert.equal(company.companies.length, 1, "same name never joins another canonical company");
    assert.equal(company.quality.expectedCompanyDays, 30);
    const keyword = await service.preview({ ...request, type: "keyword", targetId: "키워드" });
    assert.equal(keyword.companies.length, 2);
    assert.equal(keyword.companies[0].daily[0].lodging.sold, 2, "keyword report uses exact requested keyword source");
    const absent = await service.preview({ ...request, type: "keyword", targetId: "키워" });
    assert.equal(absent.companies.length, 0);
    assert.equal(absent.summary.lodging.sold, null);
    assert.equal(absent.quality.status, "insufficient");

    const beforeRead = reads;
    sources.observations = [row({ sold: 1, publicBookings: 0, phoneBookings: 1, publicRevenue: 0, phoneRevenue: 100, estimatedRevenue: 100 })];
    const draft = await service.create({ ...request, previewToken: snapshot.previewToken, title: "검토용", notes: "현장 메모" });
    assert.equal(reads, beforeRead, "saving a preview reuses the server snapshot");
    assert.equal(draft.snapshot.summary.lodging.sold, 16);
    assert.equal(draft.snapshot.previewToken, undefined);
    assert.equal(draft.status, "draft");
    assert.equal(draft.revision, 1);
    snapshot.summary.lodging.sold = 9999;
    assert.equal((await service.get(draft.id)).snapshot.summary.lodging.sold, 16, "browser/caller mutations cannot affect a stored snapshot");
    await assert.rejects(service.create({ ...request, targetId: "local-a", previewToken: snapshot.previewToken }), error => error.code === "preview_mismatch");
    await assert.rejects(service.create({ ...request, previewToken: "arbitrary" }), error => error.code === "preview_expired");
    await assert.rejects(service.update(draft.id, { revision: 1, snapshot: {} }), error => error.code === "immutable_snapshot");
    await assert.rejects(service.publish(draft.id, { revision: 1, acknowledgeQuality: true }), error => error.code === "review_required");
    const review = await service.update(draft.id, { revision: 1, status: "review", notes: "검토 메모 수정" });
    assert.equal(review.revision, 2);
    await assert.rejects(service.update(draft.id, { revision: 1, title: "오래된 저장" }), error => error.code === "revision_conflict");
    await assert.rejects(service.publish(draft.id, { revision: 2 }), error => error.code === "quality_acknowledgement_required");
    const published = await service.publish(draft.id, { revision: 2, acknowledgeQuality: true });
    assert.equal(published.status, "published");
    assert.equal(published.revision, 3);
    assert.equal(published.notes, "검토 메모 수정");
    assert.ok(published.snapshotHash);
    const frozenFile = await fs.readFile(path.join(temporary, `${published.id}.json`), "utf8");
    assert.deepEqual(await service.publish(draft.id, { revision: 2, acknowledgeQuality: true }), published, "retrying successful publication is idempotent");
    assert.deepEqual(await service.publish(draft.id, { revision: 3 }), published);
    await assert.rejects(service.publish(draft.id, { revision: 1 }), error => error.code === "revision_conflict");
    await assert.rejects(service.update(draft.id, { revision: 3, notes: "덮어쓰기" }), error => error.code === "published_immutable");
    await assert.rejects(service.rebuild(draft.id, { revision: 3 }), error => error.code === "published_immutable");
    assert.equal(await fs.readFile(path.join(temporary, `${published.id}.json`), "utf8"), frozenFile, "published file bytes remain unchanged");
    const revision = await service.revise(draft.id, { revision: 3 });
    assert.equal(revision.status, "draft");
    assert.equal(revision.version, 2);
    assert.equal(revision.supersedesId, published.id);
    assert.notEqual(revision.id, published.id);
    assert.deepEqual(revision.snapshot, published.snapshot);
    assert.equal(await fs.readFile(path.join(temporary, `${published.id}.json`), "utf8"), frozenFile);
    const secondService = createMonthlyReportService({ dataDir: temporary, loadSources, now: () => now });
    const concurrent = await Promise.allSettled([
      service.update(revision.id, { revision: 1, notes: "첫 저장" }),
      secondService.update(revision.id, { revision: 1, notes: "동시 저장" })
    ]);
    assert.equal(concurrent.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(concurrent.find(value => value.status === "rejected").reason.code, "revision_conflict", "optimistic concurrency works across service instances");
    const refreshed = await service.rebuild(revision.id, { revision: 2 });
    assert.equal(refreshed.status, "draft");
    assert.equal(refreshed.revision, 3);
    assert.equal(refreshed.snapshot.summary.lodging.sold, 1, "an explicit rebuild adopts corrected source numbers in a draft");
    assert.equal((await service.get(published.id)).snapshot.summary.lodging.sold, 16, "rebuild never changes the published original");
    assert.equal((await secondService.list()).length, 2);
    assert.ok((await secondService.list())[0].summary);
    await assert.rejects(service.get("../outside"), error => error.code === "invalid_report_id");
    await assert.rejects(service.get("mr_00000000-0000-4000-8000-000000000000"), error => error.code === "report_not_found");
    for (const bad of [{ month: "2026-9" }, { month: "2026-13" }, { cutoffDate: "2026-02-30" }, { cutoffDate: "2026-10-02" }, { type: "all" }, { targetId: "" }]) {
      await assert.rejects(service.preview({ ...request, ...bad }));
    }
    now = new Date("2026-10-01T03:16:00.000Z");
    await assert.rejects(service.create({ ...request, previewToken: snapshot.previewToken }), error => error.code === "preview_expired");

    sources = { companies: [COMPANY_A], runs: [run("normal")], observations: [row({ stayDate: "2026-01-01", collectedAt: "2025-12-31T12:00:00Z" }), row({ stayDate: "2025-01-01", collectedAt: "2024-12-31T12:00:00Z" })] };
    const january = await service.preview({ month: "2026-01", type: "company", targetId: "company-a" });
    assert.equal(january.period.days, 31);
    assert.equal(january.request.cutoffDate, "2026-01-31");
    assert.equal(january.summary.lodging.sold, 2, "calendar stay month includes previous collection year but not another stay year");
    const leap = await service.preview({ month: "2024-02", type: "company", targetId: "company-a" });
    assert.equal(leap.period.days, 29);

    sources = { companies: [COMPANY_A], runs: [run("normal")], observations: Array.from({ length: 30 }, (_, i) => row({ stayDate: `2026-09-${String(i + 1).padStart(2, "0")}`, collectedAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z` })) };
    const full = await service.preview({ ...request, type: "company", targetId: "company-a" });
    assert.equal(full.quality.status, "complete");
    assert.equal(full.summary.lodging.coverageRate, 1);
    assert.equal(full.summary.lodging.sold, 60);
    assert.equal(full.quality.sameDayObservedCompanyDays, 30);
    assert.equal(full.quality.staleDays, 0);
    assert.equal(full.quality.maxObservationLeadTimeDays, 0);
    sources.globalWarnings = ["선택 범위 밖 전체 이력의 참고용 오류입니다."];
    sources.globalDiagnostics = { malformedHistoryLines: 7, unmatchedCompanyRows: 2, duplicatePlaceCompanies: 3 };
    const globallyLimited = await service.preview({ ...request, type: "company", targetId: "company-a" });
    assert.equal(globallyLimited.quality.status, "complete", "unscoped global diagnostics never downgrade valid selected report evidence");
    assert.deepEqual(globallyLimited.quality.globalWarnings, sources.globalWarnings);
    assert.deepEqual(globallyLimited.quality.globalDiagnostics, sources.globalDiagnostics);
    sources.observations = sources.observations.map(value => ({ ...value, collectedAt: "2026-08-28T03:00:00Z" }));
    const completeForecast = await service.preview({ ...request, type: "company", targetId: "company-a" });
    assert.equal(completeForecast.summary.lodging.coverageRate, 1);
    assert.equal(completeForecast.quality.status, "partial");
    assert.equal(completeForecast.quality.sameDayObservedCompanyDays, 0);
    assert.equal(completeForecast.quality.staleDays, 30);
    assert.equal(completeForecast.quality.maxObservationLeadTimeDays, 33);
    now = new Date("2026-09-15T03:00:00Z");
    const provisional = await service.preview({ month: "2026-09", type: "company", targetId: "company-a" });
    assert.equal(provisional.period.monthClosed, false);
    assert.equal(provisional.quality.status, "partial", "a full set of advance observations is still a provisional monthly report");
    assert.ok(provisional.quality.warnings.includes("아직 종료되지 않은 달의 중간 집계입니다."));

    sources = { companies: [COMPANY_A], runs: [run("normal"), { ...run("filesystem"), collectedAtSource: "filesystem" }], observations: [
      row({ partial: true, recalculationUnavailable: true, supply: 15, sold: 2, publicBookings: 2, phoneBookings: 0,
        publicRevenue: 200, phoneRevenue: 0, estimatedRevenue: 200, explicitBlockedRevenue: 999, unknownUnavailable: 8 }),
      row({ runId: "filesystem", stayDate: "2026-09-02", collectedAt: "" }),
      row({ stayDate: "2026-09-03", collectedAt: "2026-02-30T03:00:00Z" })
    ] };
    const corrected = await service.preview({ month: "2026-09", type: "company", targetId: "company-a" });
    assert.equal(corrected.summary.lodging.sold, null, "capacity corrections do not fabricate re-estimated phone quantities");
    assert.equal(corrected.summary.lodging.estimatedRevenue, null);
    assert.equal(corrected.summary.lodging.knownPartialRevenue, 200, "verified public revenue survives unavailable capacity recalculation separately");
    assert.equal(corrected.summary.lodging.knownPartialBlockedRevenue, 0, "unavailable recalculation cannot preserve old phone/block estimates");
    assert.equal(corrected.quality.discardedByReason.capacity_recalculation_unavailable, 1);
    assert.equal(corrected.quality.discardedByReason.unverified_collection_time, 1);
    assert.equal(corrected.quality.discardedByReason.invalid_collection_time, 1);

    sources = { companies: [COMPANY_A], runs: [run("normal")], observations: [
      row({ stayDate: "2026-09-01", phoneRevenue: 0, phonePricedBookings: 0, phoneMissingPriceBookings: 1, estimatedRevenue: 100 }),
      row({ stayDate: "2026-09-02", sold: 11, publicBookings: 10, phoneBookings: 1 }),
      row({ stayDate: "2026-09-03", supply: 2.5 }),
      row({ stayDate: "2026-09-04", sold: 3 }),
      row({ stayDate: "2026-09-05", explicitBlockedBookings: 2 }),
      row({ stayDate: "2026-09-06", error: "provider unavailable", sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 })
    ] };
    const guarded = await service.preview({ month: "2026-09", type: "company", targetId: "company-a" });
    assert.equal(guarded.summary.lodging.coveredCompanyDays, 1);
    assert.equal(guarded.summary.lodging.estimatedRevenue, 100, "valid public-priced subtotal survives separately unpriced phone bookings");
    assert.equal(guarded.summary.lodging.phoneMissingPriceBookings, 1);
    assert.equal(guarded.summary.lodging.revenuePartial, true);
    assert.equal(guarded.quality.discardedByReason.quantity_conflict, 4);
    assert.equal(guarded.quality.discardedByReason.missing_response, 1, "provider-error zero is never a true zero");

    const companyAt = id => ({ companyId: id, primaryName: id, keywords: ["키워드"] });
    sources = { companies: [COMPANY_A, ...["rank-only", "old-member", "future-member", "failed-member", "after-cutoff", "zero-rank", "prior-month-collector"].map(companyAt)],
      runs: [run("normal"), run("failed", "failed"), run("rank-run")],
      observations: [
        row(),
        row({ companyKey: "old-member", stayDate: "2026-08-01", collectedAt: "2026-07-30T00:00:00Z" }),
        row({ companyKey: "future-member", stayDate: "2026-10-01", collectedAt: "2026-09-30T00:00:00Z" }),
        row({ companyKey: "failed-member", runId: "failed" }),
        row({ companyKey: "after-cutoff", stayDate: "2026-09-20", collectedAt: "2026-09-18T00:00:00Z" }),
        row({ companyKey: "prior-month-collector", stayDate: "2026-09-02", collectedAt: "2026-08-30T00:00:00Z" })
      ],
      rankObservations: [
        { companyId: "rank-only", keyword: "키워드", runId: "rank-run", collectedAt: "2026-09-05T00:00:00Z", rank: 5 },
        { companyId: "old-member", keyword: "키워드", runId: "normal", collectedAt: "2026-08-05T00:00:00Z", rank: 4 },
        { companyId: "future-member", keyword: "키워드", runId: "normal", collectedAt: "2026-10-05T00:00:00Z", rank: 4 },
        { companyId: "failed-member", keyword: "키워드", runId: "failed", collectedAt: "2026-09-05T00:00:00Z", rank: 4 },
        { companyId: "after-cutoff", keyword: "키워드", runId: "normal", collectedAt: "2026-09-18T00:00:00Z", rank: 4 },
        { companyId: "zero-rank", keyword: "키워드", runId: "normal", collectedAt: "2026-09-05T00:00:00Z", rank: 0 }
      ] };
    const monthlyMembers = await service.preview({ month: "2026-09", type: "keyword", targetId: "키워드", cutoffDate: "2026-09-15" });
    assert.deepEqual(monthlyMembers.companies.map(value => value.companyId).sort(), ["company-a", "prior-month-collector", "rank-only"]);
    assert.equal(monthlyMembers.quality.expectedCompanyDays, 90, "unrelated historical/future keyword memberships never inflate the monthly denominator");
    assert.equal(monthlyMembers.quality.coveredCompanyDays, 2);
    assert.equal(monthlyMembers.companies.find(value => value.companyId === "rank-only").summary.lodging.sold, null, "a ranked company without inventory remains missing");
    assert.deepEqual(monthlyMembers.sources.targetMembership.rankOnlyCompanyIds, ["rank-only"]);
    assert.ok(monthlyMembers.sources.runIds.includes("rank-run"), "rank-only roster membership keeps its source run");
    assert.equal(monthlyMembers.sources.runs.find(value => value.id === "rank-run").rankSeriesCount, 1);
    const sharedMembership = monthlyReportKeywordMembership({ month: "2026-09", targetId: "키워드", cutoffDate: "2026-09-15" }, sources);
    assert.deepEqual([...sharedMembership.members].sort(), monthlyMembers.companies.map(value => value.companyId).sort(), "source diagnostics and report aggregation share the same keyword membership rule");

    const strandedLock = path.join(temporary, `${revision.id}.json.lock`);
    await fs.writeFile(strandedLock, "test-owned interrupted lock", "utf8");
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(strandedLock, oldTime, oldTime);
    await assert.rejects(service.update(revision.id, { revision: 3, notes: "blocked by interrupted writer" }),
      error => error.code === "report_busy" && error.lockMayBeStale === true && error.message.includes("원본 보고서는 조회"));
    assert.equal((await service.get(revision.id)).revision, 3, "a stranded lock still permits reading the complete report");
    assert.equal(await fs.readFile(strandedLock, "utf8"), "test-owned interrupted lock", "uncertain old locks are not automatically deleted");
    await fs.unlink(strandedLock);

    const corrupted = JSON.parse(frozenFile);
    corrupted.snapshot.summary.lodging.sold = 999;
    await fs.writeFile(path.join(temporary, `${published.id}.json`), JSON.stringify(corrupted), "utf8");
    await assert.rejects(service.get(published.id), error => error.code === "corrupt_report", "published snapshot integrity is verified before rendering");
    await fs.writeFile(path.join(temporary, `${published.id}.json`), frozenFile, "utf8");

    const remainingFiles = await fs.readdir(temporary);
    assert.ok(remainingFiles.every(value => value.endsWith(".json")), "atomic writes and locks leave no temporary files");
    console.log("Monthly reports: canonical company/date dedupe, KST cutoff, evidence quality, partial subtotals, preview consistency, immutable publication and concurrent revisions passed");
  } finally {
    // Only remove the unique directory created by this test under the OS temp root.
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("monthly-reports-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
