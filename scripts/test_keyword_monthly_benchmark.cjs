"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { buildKeywordMonthlyBenchmark: build } = require("./lib/keyword_monthly_benchmark.cjs");
function row(companyId, supply, sold, extra = {}) {
  return { companyId, date: "2026-10-01", productType: "lodging", runQuality: "complete", supply, sold, publicBookings: sold, phoneBookings: 0,
    revenueEligible: true, revenuePartial: false, estimatedRevenue: sold * 100, publicRevenue: sold * 100, phoneRevenue: 0,
    observationLeadTimeDays: 0, inventoryEvidenceVersion: 4, dayUseSharingStatus: "not_shared", phoneValuationPolicy: "observed_product_price", ...extra };
}
function fixture(rows = [row("a", 2, 2), row("b", 8, 0)]) {
  return { request: { month: "2026-10" }, companies: [{ companyId: "a", primaryName: "작은 업체" }, { companyId: "b", primaryName: "큰 업체" }, { companyId: "rank", primaryName: "순위만 있는 업체" }], sources: { observations: rows, partialEvidence: [{ companyId: "a", knownPartialRevenue: 99999999 }] } };
}
test("weighted whole mean includes chosen once and stays distinct from equal-company and peer mean", () => {
  const value = build(fixture(), { companyId: "a" });
  assert.equal(value.monthly.includesSelected, true); assert.equal(value.monthly.all.reservationRate, 0.2);
  assert.equal(value.monthly.equalCompany.all.reservationRate, 0.5); assert.equal(value.monthly.peers.reservationRate, 0);
  assert.equal(value.monthly.all.companyCount, 2); assert.equal(value.monthly.rosterCompanyCount, 3);
  assert.equal(value.monthly.equalCompany.all.reservationRateCompanyCount, 2);
  assert.equal(value.selected.reservationRate, 1); assert.equal(value.sameDates.all.reservationRate, 0.2);
});
test("rank-only and absent quantities remain unknown while actual observed zero is a real zero", () => {
  const value = build(fixture(), { companyId: "rank" }), rank = value.companies.find(v => v.companyId === "rank");
  assert.equal(rank.sold, null); assert.equal(rank.reservationRate, null); assert.equal(rank.soldPerObservedCompanyDay, null);
  assert.equal(value.companies.find(v => v.companyId === "b").reservationRate, 0);
  assert.equal(value.sameDates.dateCount, 0); assert.equal(value.sameDates.all.reservationRate, null);
});
test("zero supply is observed but not an invented zero reservation rate or denominator member", () => {
  const value = build(fixture([row("a", 0, 0), row("b", 8, 0)]));
  assert.equal(value.selected.observedCompanyDays, 1); assert.equal(value.selected.reservationRate, null);
  assert.equal(value.selected.soldPerObservedCompanyDay, 0); assert.equal(value.monthly.equalCompany.all.reservationRateCompanyCount, 1);
});
test("per-observed-company-day averages use actual days, not month days or collection counts", () => {
  const value = build(fixture([row("a", 2, 2), row("a", 2, 0, { date: "2026-10-02" }), row("b", 8, 0)]));
  assert.equal(value.selected.soldPerObservedCompanyDay, 1); assert.equal(value.monthly.all.soldPerObservedCompanyDay, 2 / 3);
  assert.equal(value.selected.coverageRate, 2 / 31); assert.equal(value.monthly.equalCompany.all.soldPerObservedCompanyDay, 0.5);
});
test("partial, missing and unknown run quantities cannot enter normal benchmark cohorts", () => {
  for (const extra of [{ partial: true }, { missing: true }, { unknownUnavailable: 1 }, { runQuality: "partial" }, { runQuality: undefined }, { runQuality: "blocked" }, { supply: undefined }, { phoneBookings: undefined }]) {
    const value = build(fixture([row("a", 2, 2, extra), row("b", 8, 0)]), { companyId: "a" });
    assert.equal(value.selected.observedCompanyDays, 0); assert.equal(value.selected.reservationRate, null);
    assert.equal(value.monthly.all.reservationRate, 0); assert.equal(value.monthly.all.companyCount, 1);
  }
});
test("inconsistent quantities are excluded without overriding selected snapshot financial values", () => {
  const source = fixture([row("a", 2, 3), row("b", 8, 1, { publicBookings: 0 })]), before = JSON.stringify(source);
  const value = build(source); assert.equal(value.status, "missing"); assert.equal(value.monthly.all.sold, null); assert.equal(value.exclusions.quantity_conflict, 2); assert.equal(JSON.stringify(source), before);
});
test("complete price cohort requires explicit complete flags and never adds partial response money", () => {
  const value = build(fixture([row("a", 2, 2, { revenuePartial: true }), row("b", 8, 0)]));
  assert.equal(value.selected.amountPerCompletePriceCompanyDay, null);
  assert.equal(value.monthly.all.completePriceCompanyDays, 1); assert.equal(value.monthly.all.completePriceAmount, 0);
  assert.equal(value.monthly.equalCompany.all.completePriceCompanyCount, 1);
  for (const extra of [{ revenuePartial: undefined }, { revenueEligible: undefined }, { revenueEligible: false }, { publicRevenue: 10000 }]) {
    assert.equal(build(fixture([row("a", 2, 2, extra)])).selected.completePriceCompanyDays, 0);
  }
});
test("same-date comparison restricts both sides to compatible actual observation timing and evidence", () => {
  const rows = [row("a", 2, 2), row("a", 2, 1, { date: "2026-10-02", observationLeadTimeDays: 2 }), row("b", 8, 0), row("b", 8, 4, { date: "2026-10-02", observationLeadTimeDays: 1 }), row("b", 8, 4, { date: "2026-10-03" })];
  const value = build(fixture(rows), { companyId: "a" });
  assert.equal(value.sameDates.dateCount, 1); assert.equal(value.sameDates.expectedSelectedDates, 2); assert.equal(value.sameDates.selectedDateCoverageRate, 0.5);
  assert.equal(value.sameDates.selected.reservationRate, 1); assert.equal(value.sameDates.all.reservationRate, 0.2);
  assert.equal(value.sameDates.exclusions.observation_timing_changed, 1); assert.equal(value.sameDates.daily[0].date, "2026-10-01");
});
test("selected observation is not duplicated once per peer and peer counts are explicit per date", () => {
  const source = fixture([row("a", 2, 2), row("b", 8, 0), row("c", 10, 0)]); source.companies.push({ companyId: "c", name: "세 번째" });
  const value = build(source); assert.equal(value.sameDates.all.supply, 20); assert.equal(value.sameDates.all.sold, 2);
  assert.equal(value.sameDates.all.observedCompanyDays, 3); assert.equal(value.sameDates.peerCountMin, 2); assert.equal(value.sameDates.peerCountMax, 2);
});
test("unknown timing and incompatible inventory/sharing basis are not silently treated as paired", () => {
  for (const [extra, code] of [[{ observationLeadTimeDays: undefined }, "observation_timing_unknown"], [{ inventoryEvidenceVersion: undefined }, "inventory_basis_unknown"], [{ inventoryEvidenceVersion: 3 }, "inventory_basis_changed"]]) {
    const value = build(fixture([row("a", 2, 2), row("b", 8, 0, extra)])); assert.equal(value.sameDates.dateCount, 0); assert.equal(value.sameDates.exclusions[code], 1);
  }
  for (const dayUseSharingStatus of ["", "unknown", "unconfirmed", "not_applicable", "future_unrecognized_status"]) {
    const value = build(fixture([row("a", 2, 2, { productType: "dayuse" }), row("b", 8, 0, { productType: "dayuse", dayUseSharingStatus })]), { productType: "dayuse" });
    assert.equal(value.sameDates.dateCount, 0); assert.equal(value.sameDates.exclusions.sharing_basis_unknown, 1);
  }
});
test("money paired dates and denominators are distinct from quantity dates, and unknown policy blocks money only", () => {
  const value = build(fixture([row("a", 2, 2), row("b", 8, 0, { phoneValuationPolicy: "" })]));
  assert.equal(value.sameDates.dateCount, 1); assert.equal(value.sameDates.completePrice.dateCount, 0);
  assert.equal(value.sameDates.completePrice.all.amountPerCompletePriceCompanyDay, null); assert.equal(value.sameDates.exclusions.price_policy_unknown, 1);
  assert.equal(value.monthly.all.amountPerCompletePriceCompanyDay, 100);
});
test("duplicate observations do not double count and conflicting duplicates fail closed", () => {
  const same = row("a", 2, 2), value = build(fixture([same, { ...same }, row("b", 8, 0)]));
  assert.equal(value.identicalDuplicates, 1); assert.equal(value.monthly.all.sold, 2);
  const bad = build(fixture([same, { ...same, sold: 1, publicBookings: 1 }]));
  assert.equal(bad.status, "needs_verification"); assert.equal(bad.code, "BENCHMARK_DUPLICATE_OBSERVATION_CONFLICT"); assert.equal(bad.monthly, null);
});
test("foreign month, unlisted company, unsupported products and duplicate roster IDs fail or exclude explicitly", () => {
  const value = build(fixture([row("x", 2, 2), row("a", 2, 2, { date: "2026-09-30" }), row("b", 8, 0)]));
  assert.equal(value.exclusions.company_outside_snapshot, 1); assert.equal(value.exclusions.date_outside_month, 1);
  assert.equal(build(fixture(), { productType: "all" }).status, "needs_verification");
  const duplicate = fixture(); duplicate.companies.push(duplicate.companies[0]); assert.equal(build(duplicate).status, "needs_verification");
  assert.equal(build({ companies: fixture().companies, request: { month: "2026-10" } }).status, "needs_verification");
});
test("one company has an inclusive whole mean but no manufactured peer benchmark", () => {
  const source = fixture([row("a", 2, 2)]); source.companies = [source.companies[0]]; const value = build(source);
  assert.equal(value.monthly.all.reservationRate, 1); assert.equal(value.monthly.peers.reservationRate, null);
  assert.equal(value.monthly.equalCompany.peers.reservationRateCompanyCount, 0); assert.equal(value.sameDates.dateCount, 0);
});
test("browser UMD and CJS shim run exactly the same pure calculation without DOM or network", () => {
  const context = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-benchmark.js"), "utf8"), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.KeywordMonthlyBenchmark.buildKeywordMonthlyBenchmark(fixture()))), build(fixture()));
});
