"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createMonthlyObservationIdentityResolver } = require("./lib/monthly_observation_identity.cjs");
const { reviewMonthlyUnmatchedIdentityRows, observationKey, identityRecordInKeywordScope } = require("./lib/monthly_observation_identity_review.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { monthlyReportKeywordMembership } = require("./lib/monthly_reports.cjs");
const company = { companyId: "cmp_place_101", primaryName: "Fixture", placeIds: ["101"], bookingBusinessIds: ["201"] };
const run = { id: "r1", keyword: "경주글램핑", collectedAt: "2026-11-14T08:04:17.834Z", collectionQuality: { status: "complete" } };
const request = { type: "keyword", targetId: run.keyword, month: "2026-11", cutoffDate: "2026-11-16" };
const raw = extra => ({ companyKey: "fixture-name-only", runId: run.id, keyword: run.keyword, collectedAt: run.collectedAt,
  stayDate: "2026-11-20", productType: "lodging", inventoryEvidenceVersion: 4, rank: 1, supply: 10, available: 8, sold: 2,
  publicBookings: 1, phoneBookings: 1, estimatedRevenue: 200, publicRevenue: 100, phoneRevenue: 100, sourceUrl: "https://pcmap.place.naver.com/accommodation/101", ...extra });
const resolver = () => createMonthlyObservationIdentityResolver({ companies: [company] });
async function review(rows, counterparts = [], extra = {}) {
  const observations = new Map(counterparts.map(row => [observationKey(row, row.companyId), row]));
  return reviewMonthlyUnmatchedIdentityRows({ records: rows.map(row => ({ row })), observations, resolver: resolver(), runs: new Map([[run.id, run]]), ...extra });
}
test("provider-bound counterpart is already represented without changing its current reviewed measurements", async () => {
  const legacy = raw(), canonical = { ...legacy, companyId: company.companyId, companyKey: company.companyId, supply: 16, sold: 3 };
  const before = JSON.stringify(canonical), result = await review([legacy, { ...legacy }], [canonical]);
  assert.equal(result.identityReview.alreadyRepresentedRows, 2); assert.equal(result.identityReview.recoveredRows, 0);
  assert.equal(result.identityReview.unresolvedRows, 0); assert.equal(result.recoveries.length, 0); assert.equal(JSON.stringify(canonical), before);
});
test("a canonical ID or persisted recalculation flag alone is not circular proof of representation", async () => {
  const canonical = { ...raw(), companyId: company.companyId, companyKey: company.companyId, sourceUrl: "", readOnlyRecalculated: true };
  const result = await review([raw()], [canonical]);
  assert.equal(result.identityReview.unresolvedRows, 1); assert.equal(result.identityReview.reasonCounts.COUNTERPART_PROVENANCE_UNVERIFIED, 1);
});
test("private current saved-run provenance can prove a counterpart after privacy projection", async () => {
  const canonical = { ...raw(), companyId: company.companyId, companyKey: company.companyId, sourceUrl: "" };
  const result = await review([raw()], [canonical], { origins: new Map([[observationKey(canonical, company.companyId), "saved_run_recalculation"]]) });
  assert.equal(result.identityReview.alreadyRepresentedRows, 1);
});
test("an independently identified missing unit is returned once with all quantity, null, partial and error fields preserved", async () => {
  const legacy = raw({ partial: true, missing: true, estimatedRevenue: null, sold: 0, publicBookings: 0, phoneBookings: 0 }), before = JSON.stringify(legacy);
  const result = await review([legacy, { ...legacy }]);
  assert.equal(result.identityReview.recoveredRows, 1); assert.equal(result.identityReview.alreadyRepresentedRows, 1);
  assert.deepEqual(result.recoveries[0].row, { ...legacy, companyKey: company.companyId, companyId: company.companyId });
  assert.equal(JSON.stringify(legacy), before); assert.equal(result.recoveries[0].row.estimatedRevenue, null); assert.equal(result.recoveries[0].row.missing, true);
});
test("contradictory raw versions of one unit remain for review rather than taking an arbitrary last row", async () => {
  const result = await review([raw(), raw({ sold: 3 })]);
  assert.equal(result.recoveries.length, 0); assert.equal(result.identityReview.unresolvedRows, 2);
  assert.equal(result.identityReview.reasonCounts.CANDIDATE_ROWS_CONFLICT, 2);
});
test("collection-time mismatch never overwrites a canonical counterpart", async () => {
  const canonical = { ...raw(), companyId: company.companyId, companyKey: company.companyId, collectedAt: "2026-11-14T08:04:18Z" };
  const result = await review([raw()], [canonical]);
  assert.equal(result.identityReview.unresolvedRows, 1); assert.equal(result.identityReview.reasonCounts.COUNTERPART_TIME_MISMATCH, 1);
});
test("a global duplicate-place exclusion is not bypassed by a separate unique booking ID", async () => {
  const result = await review([raw({ sourceUrl: "https://booking.naver.com/booking/3/bizes/201" })], [], { blockedCompanyIds: new Set([company.companyId]) });
  assert.equal(result.identityReview.unresolvedRows, 1); assert.equal(result.identityReview.reasonCounts.IDENTITY_AMBIGUOUS_PLACE_ID, 1);
});
test("name-only and invalid observation grain remain unknown", async () => {
  const result = await review([raw({ sourceUrl: "" }), raw({ collectedAt: "2026-02-30T00:00:00Z" }), raw({ productType: "other" })]);
  assert.equal(result.identityReview.unresolvedRows, 3); assert.equal(result.recoveries.length, 0);
});
test("missing, conflicting, failed and unknown run lineage cannot create a recovered unit", async () => {
  for (const runs of [new Map(), new Map([[run.id, { ...run, keyword: "other" }]]), new Map([[run.id, { ...run, collectionQuality: "failed" }]]), new Map([[run.id, { ...run, collectionQuality: "unknown" }]])]) {
    const result = await review([raw()], [], { runs }); assert.equal(result.identityReview.unresolvedRows, 1); assert.equal(result.recoveries.length, 0);
  }
});
test("every physical record is counted once and evidence digest changes independently of financial values", async () => {
  const a = await review([raw()]), b = await review([raw({ sourceUrl: "" })]);
  assert.equal(a.identityReview.totalRows, a.identityReview.alreadyRepresentedRows + a.identityReview.recoveredRows + a.identityReview.unresolvedRows);
  assert.match(a.identityReview.evidenceDigest, /^[a-f0-9]{64}$/); assert.notEqual(a.identityReview.evidenceDigest, b.identityReview.evidenceDigest);
  assert.equal(Object.values(b.identityReview.reasonCounts).reduce((n, v) => n + v, 0), b.identityReview.unresolvedRows);
});
test("cooperative interruption propagates without source mutation", async () => {
  const stop = new Error("cooperative stop"), row = raw(), before = JSON.stringify(row);
  await assert.rejects(review([row], [], { checkpoint: async () => { throw stop; } }), error => error === stop); assert.equal(JSON.stringify(row), before);
});
test("review cohort follows the existing independent monthly membership policy at timezone and quality boundaries", () => {
  const cases = [raw(), raw({ collectedAt: "2026-11-16T15:00:00Z" }), raw({ collectedAt: "2026-11-16T14:59:59Z" }),
    raw({ stayDate: "2026-10-31", rank: null }), raw({ stayDate: "2026-10-31", rank: 1 }), raw({ inventoryEvidenceVersion: 2, rank: null }),
    raw({ keyword: "other" }), raw({ collectedAt: "", rank: null }), raw({ collectedAt: "2026-10-31T14:59:59Z", rank: 1 }),
    ...[true, false, null, ""].map(rank => raw({ inventoryEvidenceVersion: 2, rank }))];
  for (const currentRun of [run, { ...run, collectionQuality: "failed" }, { ...run, collectionQuality: "partial" }, { ...run, collectedAtSource: "filesystem" }]) for (const row of cases) {
    const expected = monthlyReportKeywordMembership(request, { observations: [{ ...row, companyId: "candidate", companyKey: "candidate" }], runs: [currentRun] }).members.has("candidate");
    assert.equal(identityRecordInKeywordScope(row, currentRun, request), expected, JSON.stringify([row.collectedAt, row.stayDate, row.rank, currentRun.collectionQuality]));
  }
});
async function source(t, rows, { fallback = [], hooks = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "identity-source-review-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, "company_master")); await fs.mkdir(path.join(root, "history")); await fs.mkdir(path.join(root, "monthly_reports"));
  const files = new Map([
    [path.join(root, "company_master/companies.json"), JSON.stringify({ companies: { [company.companyId]: { ...company,
      keywords: { k: { keyword: run.keyword, runs: [{ runId: run.id, rank: 1, collectedAt: run.collectedAt }] } },
      inventory: { snapshots: [{ runId: run.id, collectedAt: run.collectedAt, productSnapshot: { daily: fallback } }] } } } })],
    [path.join(root, "history/observations.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n"],
    [path.join(root, "monthly_reports/mr_preserved.json"), '{"status":"issued","fixture":true}']
  ]);
  for (const [file, text] of files) await fs.writeFile(file, text);
  const service = createMonthlyReportSources({ dataDir: root, regionMasterFile: path.join(root, "regions.json"), listRuns: async () => [run], ...hooks });
  const value = await service.loadSources(request, { includeContext: false });
  for (const [file, text] of files) assert.equal(await fs.readFile(file, "utf8"), text, "original history, master and issued report stay byte-identical");
  return value;
}
test("integrated source cancels an obsolete unresolved diagnostic only after proving the existing fallback unit", async t => {
  const row = raw(), value = await source(t, [row, { ...row }], { fallback: [row] });
  assert.equal(value.observations.length, 1); assert.equal(value.observations[0].sold, 2);
  assert.equal(value.sourceDiagnostics.unmatchedCompanyRows, 0); assert.equal(value.identityReview.alreadyRepresentedRows, 2);
  assert.equal(value.warnings.some(message => message.includes("고유번호")), false);
});
test("integrated recovery uses existing reviewed projection and preserves partial/null rather than manufacturing success", async t => {
  const row = raw({ partial: true, estimatedRevenue: null }); let projections = 0;
  const value = await source(t, [row], { hooks: { projectObservation: (observed, master) => { projections++; assert.equal(master.companyId, company.companyId); return { ...observed, supply: 16 }; } } });
  assert.equal(value.identityReview.recoveredRows, 1); assert.equal(value.observations.length, 1); assert.equal(value.observations[0].supply, 16);
  assert.equal(value.observations[0].partial, true); assert.equal(value.observations[0].estimatedRevenue, null); assert.equal(projections, 1);
});
test("unverifiable source URL remains unresolved in the integrated source", async t => {
  const value = await source(t, [raw({ sourceUrl: "https://evil.invalid/accommodation/101" })]);
  assert.equal(value.observations.length, 0); assert.equal(value.identityReview.unresolvedRows, 1); assert.equal(value.sourceDiagnostics.unmatchedCompanyRows, 1);
});
test("current saved-product reconstruction keeps precedence over all legacy quantities", async t => {
  const canonical = { ...raw(), companyId: company.companyId, companyKey: company.companyId, sourceUrl: "", supply: 16, sold: 4 };
  const value = await source(t, [raw()], { hooks: { recalculateCompanyObservations: async () => [canonical] } });
  assert.equal(value.identityReview.alreadyRepresentedRows, 1); assert.equal(value.observations.length, 1); assert.equal(value.observations[0].sold, 4);
});
