"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { normalizeMonthlyReportIdentityReview: validate, buildMonthlyReportSnapshot: snapshot } = require("./lib/monthly_reports.cjs");
const { publicSource } = require("./reconstruct_keyword_monthly_source_copy.cjs");
const K = require("./lib/keyword_monthly_analysis.cjs"), B = require("./lib/keyword_monthly_bundle.cjs");
const NOW = "2026-11-16T03:00:00.000Z", KEYWORD = "synthetic_identity_keyword", sha = value => crypto.createHash("sha256").update(value).digest("hex");
const review = (extra = {}) => ({ schemaVersion: 1, basis: "raw_unresolved_identity_rows", totalRows: 10, alreadyRepresentedRows: 4, recoveredRows: 3, unresolvedRows: 3,
  reasonCounts: { SOURCE_ID_UNKNOWN: 2, COUNTERPART_TIME_MISMATCH: 1 }, evidenceDigest: "a".repeat(64), catalogDigest: "b".repeat(64), ...extra });
function sourceFixture() {
  const observations = [], runs = [];
  for (let day = 1; day <= 30; day++) {
    const stayDate = "2026-09-" + String(day).padStart(2, "0"), id = "synthetic_" + day, collectedAt = stayDate + "T01:00:00.000Z";
    runs.push({ id, keyword: KEYWORD, collectedAt, collectionQuality: { status: "complete" } });
    observations.push({ companyId: "synthetic_company", keyword: KEYWORD, runId: id, productType: "lodging", stayDate, collectedAt, inventoryEvidenceVersion: 4,
      supply: 5, sold: 2, publicBookings: 2, phoneBookings: 0, publicRevenue: 20000, phoneRevenue: 0, estimatedRevenue: 20000, sharedDayUseExcluded: 0,
      explicitBlockedBookings: 0, phoneMissingPriceBookings: 0, partial: false, missing: false, unknownUnavailable: 0,
      dayUsePresence: "absent", dayUseSharingStatus: "not_shared", capacityBasis: { count: 5, source: "db_correction" } });
  }
  return { companies: [{ companyId: "synthetic_company", primaryName: "Synthetic identity company", capacity: 5, capacitySource: "db_correction" }], runs,
    observations, rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {} };
}
const request = { type: "keyword", targetId: KEYWORD, month: "2026-09", cutoffDate: "2026-09-30" };
async function temporary(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "identity-review-projection-")); t.after(async () => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("identity-review-projection-")); await fs.rm(root, { recursive: true, force: true }); }); return root; }
test("reviewed identity reference keeps monetary values and quality unchanged while binding the source digest", () => {
  const source = sourceFixture(), original = JSON.stringify(source), old = snapshot(request, source, NOW), input = review({ totalRows: 3710, alreadyRepresentedRows: 3710, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {} }), classified = snapshot(request, { ...source, identityReview: input }, NOW);
  assert.equal(old.quality.status, "complete"); assert.equal(classified.quality.status, "complete"); assert.deepEqual(classified.summary, old.summary); assert.deepEqual(classified.daily, old.daily);
  assert.deepEqual(classified.companies, old.companies); assert.deepEqual(classified.sources.observations, old.sources.observations); assert.deepEqual(classified.quality.identityReview, input);
  assert.equal(old.sources.digest, sha(JSON.stringify(old.sources.observations))); assert.notEqual(classified.sources.digest, old.sources.digest);
  assert.notEqual(snapshot(request, { ...source, identityReview: review({ evidenceDigest: "c".repeat(64) }) }, NOW).sources.digest, classified.sources.digest);
  input.alreadyRepresentedRows = 0; assert.equal(classified.quality.identityReview.alreadyRepresentedRows, 3710); assert.equal(JSON.stringify(source), original);
});
test("all3710 already represented records do not erase actual price or inventory quality limitations", () => {
  const source = sourceFixture(); Object.assign(source.observations[0], { estimatedRevenue: null, publicRevenue: null, phoneRevenue: null, revenuePartial: true, phoneMissingPriceBookings: 2 });
  const old = snapshot(request, source, NOW), identityReview = review({ totalRows: 3710, alreadyRepresentedRows: 3710, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {} }), classified = snapshot(request, { ...source, identityReview }, NOW);
  assert.equal(old.quality.status, "partial"); assert.equal(classified.quality.status, "partial"); assert.ok(classified.quality.revenueExcludedCompanyDays > 0);
  assert.deepEqual(classified.summary, old.summary); assert.deepEqual(classified.daily, old.daily); assert.deepEqual(classified.quality.warnings, old.quality.warnings);
  assert.equal(classified.quality.revenueExcludedCompanyDays, old.quality.revenueExcludedCompanyDays);
});
test("real zero classification is preserved and absent historical classification is not manufactured as zero", () => {
  const zero = review({ totalRows: 0, alreadyRepresentedRows: 0, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {} });
  assert.equal(validate(zero).totalRows, 0); assert.deepEqual(snapshot(request, { ...sourceFixture(), identityReview: zero }, NOW).quality.identityReview, zero);
  assert.equal(Object.hasOwn(snapshot(request, sourceFixture(), NOW).quality, "identityReview"), false);
});
for (const [name, change] of [
  ["null", () => null], ["array", () => []], ["private field", r => ({ ...r, privateToken: "not retained" })], ["unknown field", r => ({ ...r, rows: [] })],
  ["wrong basis", r => ({ ...r, basis: "rooms" })], ["negative", r => ({ ...r, recoveredRows: -1 })], ["fraction", r => ({ ...r, totalRows: 10.5 })],
  ["oversized", r => ({ ...r, totalRows: 100000001, alreadyRepresentedRows: 99999995 })], ["wrong sum", r => ({ ...r, totalRows: 11 })],
  ["nested reason", r => ({ ...r, reasonCounts: { SOURCE_ID_UNKNOWN: { count: 3 } } })], ["zero reason", r => ({ ...r, reasonCounts: { SOURCE_ID_UNKNOWN: 3, SOURCE_ID_MISSING: 0 } })],
  ["wrong reason sum", r => ({ ...r, reasonCounts: { SOURCE_ID_UNKNOWN: 2 } })], ["unsafe reason", r => ({ ...r, reasonCounts: { PRIVATE_TOKEN: 3 } })],
  ["long reason", r => ({ ...r, reasonCounts: { ["A".repeat(81)]: 3 } })], ["too many reasons", r => ({ ...r, totalRows: 72, unresolvedRows: 65, reasonCounts: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ["REASON_" + i, 1])) })],
  ["invalid digest", r => ({ ...r, evidenceDigest: "not-a-sha" })]
]) test(`untrusted ${name} identity review is rejected before publication rather than silently stripped`, () => {
  const value = change(review()); assert.throws(() => validate(value), { code: "MONTHLY_REPORT_IDENTITY_REVIEW_INVALID" });
  assert.throws(() => snapshot(request, { ...sourceFixture(), identityReview: value }, NOW), { code: "MONTHLY_REPORT_IDENTITY_REVIEW_INVALID" });
  assert.throws(() => publicSource({ identityReview: value }, {}), { code: "MONTHLY_REPORT_IDENTITY_REVIEW_INVALID" });
});
test("accessors are refused without evaluating an untrusted identity count", () => {
  const value = review(); let calls = 0; Object.defineProperty(value, "totalRows", { enumerable: true, get() { calls++; return 10; } });
  assert.throws(() => validate(value), { code: "MONTHLY_REPORT_IDENTITY_REVIEW_INVALID" }); assert.equal(calls, 0);
});
test("public source privacy projection retains only the strict review contract", () => {
  const removed = {}, input = { identityReview: review(), address: "private synthetic", nested: { identityReview: review(), cookie: "private synthetic" } }, safe = publicSource(input, removed);
  assert.deepEqual(safe.identityReview, review()); assert.deepEqual(safe.nested.identityReview, review()); assert.equal(Object.hasOwn(safe, "address"), false); assert.equal(Object.hasOwn(safe.nested, "cookie"), false);
  assert.equal(removed[".address"], 1); assert.equal(removed[".nested.cookie"], 1);
});
test("current and previous month classifications are independent and a historical month never inherits another month's review", () => {
  const current = review(), prior = review({ totalRows: 2, alreadyRepresentedRows: 2, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {}, evidenceDigest: "c".repeat(64) });
  const meta = identityReview => ({ warnings: [], sourceDiagnostics: {}, globalWarnings: [], globalDiagnostics: {}, ...(identityReview ? { identityReview } : {}) });
  const source = { ...sourceFixture(), identityReview: review({ evidenceDigest: "d".repeat(64) }), monthlySourceMetadata: { "2026-09": meta(current), "2026-08": meta(prior), "2026-07": meta() } };
  assert.deepEqual(K.sourceForKeywordMonthlyRequest(source, request).identityReview, current);
  assert.deepEqual(K.sourceForKeywordMonthlyRequest(source, { ...request, month: "2026-08" }).identityReview, prior);
  assert.equal(Object.hasOwn(K.sourceForKeywordMonthlyRequest(source, { ...request, month: "2026-07" }), "identityReview"), false);
});
test("strict month metadata survives projection and prepared gzip delivery without legacy recalculation", async t => {
  const root = await temporary(t), source = sourceFixture(), current = review(), prior = review({ totalRows: 1, alreadyRepresentedRows: 1, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {}, evidenceDigest: "c".repeat(64) });
  source.runs.push({ id: "synthetic_previous", keyword: KEYWORD, collectedAt: "2026-08-30T01:00:00.000Z", collectionQuality: { status: "complete" } });
  source.observations.push({ ...source.observations[0], runId: "synthetic_previous", stayDate: "2026-08-30", collectedAt: "2026-08-30T01:00:00.000Z" });
  source.monthlySourceMetadata = { "2026-09": { warnings: [], sourceDiagnostics: {}, globalWarnings: [], globalDiagnostics: {}, identityReview: current },
    "2026-08": { warnings: [], sourceDiagnostics: {}, globalWarnings: [], globalDiagnostics: {}, identityReview: prior } };
  const projection = path.join(root, "projection"), output = path.join(root, "bundle");
  await K.buildKeywordMonthlyProjection({ source, sourceFingerprint: sha(JSON.stringify(source)), outputDir: projection, now: () => NOW,
    sourceProvenance: { observationScope: "normalized_multirun", normalizationCutoffs: { "2026-08": "2026-08-30", "2026-09": "2026-09-30" } } });
  await B.publishKeywordMonthlyBundle({ inputs: [{ directory: projection }], outputDir: output, now: NOW, prepareResults: true });
  const service = B.createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW, runLegacyAnalysis: async () => assert.fail("prepared delivery must not recalculate") });
  const result = await service.readPrepared({ keyword: KEYWORD, month: request.month, cutoffDate: request.cutoffDate });
  assert.equal(result.preparedResult.status, "ready"); assert.deepEqual(result.snapshot.quality.identityReview, current); assert.deepEqual(result.snapshot.comparison.previousQuality.identityReview, prior);
  assert.equal(result.snapshot.quality.status, "complete"); assert.deepEqual(result.snapshot.summary, snapshot(request, sourceFixture(), NOW).summary);
});
