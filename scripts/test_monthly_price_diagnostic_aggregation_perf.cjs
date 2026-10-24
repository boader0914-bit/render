"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { performance } = require("node:perf_hooks");
const file = require.resolve("./lib/monthly_reports.cjs"), source = fs.readFileSync(file, "utf8");
const start = source.indexOf("function priceUnknownCauses(value) {"), end = source.indexOf("\nfunction ratio(", start);
assert.ok(start >= 0 && end > start, "benchmark uses the actual production normalization and summary helpers");
const helperSource = source.slice(start, end);
const oldSummary = `function priceUnknownCauseSummary(rows) {
  const classified = rows.map(row => priceUnknownCauses(row.priceUnknownCauses)).filter(value => value !== null);
  if (!classified.length) return {};
  const byCause = new Map();
  for (const causes of classified) for (const cause of causes) {
    const key = cause.channel + ':' + cause.code, previous = byCause.get(key);
    if (previous) { previous.quantity += cause.quantity; previous.productKeys = [...new Set([...previous.productKeys, ...cause.productKeys])]; }
    else byCause.set(key, { ...cause, productKeys: [...cause.productKeys] });
  }
  return { priceUnknownCauses: [...byCause.values()], priceUnknownCauseCoverage: {
    classifiedCompanyDays: classified.length, unclassifiedCompanyDays: rows.length - classified.length } };
}`;
const oldHelpers = helperSource.slice(0, helperSource.indexOf("function priceUnknownCauseSummary(rows) {")) + oldSummary;
const codes = new Set(["explicit_product_price_missing", "inferred_product_price_missing", "product_maxima_exceed_company_capacity", "proportional_price_evidence_incomplete",
  "company_capacity_unallocated_to_products", "public_product_price_missing", "dayuse_unverified", "invalid_product_response"]);
const compileHelpers = (text, SetClass = Set) => Function("Set", "PRICE_UNKNOWN_CAUSE_CODES", text + "\nreturn {priceUnknownCauses,priceUnknownCauseSummary};")(SetClass, codes);
const current = compileHelpers(helperSource), previous = compileHelpers(oldHelpers);
const cause = (quantity, keys, extras = {}) => ({ code: "company_capacity_unallocated_to_products", channel: "other", quantity, productKeys: keys, ...extras });

test("Set accumulation preserves exact source, cause and product order, legacy missingness and input bytes", () => {
  const rows = [{}, { priceUnknownCauses: null }, { priceUnknownCauses: [] }, { priceUnknownCauses: [cause(1, ["b", "a", "b"])] },
    { priceUnknownCauses: [cause(2, ["c", "a"]), cause(3, ["z"], { channel: "public" })] },
    { priceUnknownCauses: [cause(4, ["d"]), cause(1, ["p"], { code: "public_product_price_missing", channel: "public" })] },
    { priceUnknownCauses: [cause(0, ["invalid-zero"])] }];
  const bytes = JSON.stringify(rows), actual = current.priceUnknownCauseSummary(rows), expected = previous.priceUnknownCauseSummary(rows);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.priceUnknownCauses[0], cause(7, ["b", "a", "c", "d"]));
  assert.deepEqual(actual.priceUnknownCauseCoverage, { classifiedCompanyDays: 4, unclassifiedCompanyDays: 3 });
  assert.equal(JSON.stringify(rows), bytes);
  assert.deepEqual(current.priceUnknownCauseSummary([{ priceUnknownCauses: null }]), {});
});

test("company/date selection, reservation and financial snapshots are byte-equivalent to the former summary algorithm", () => {
  const before = new Module(file, module); before.filename = file; before.paths = Module._nodeModulePaths(path.dirname(file));
  before._compile(source.slice(0, start) + oldHelpers + source.slice(end), file);
  const { buildMonthlyReportSnapshot } = require(file), companies = ["cmp_a", "cmp_b"].map(companyId => ({ companyId, primaryName: companyId, regionKey: "region_test" }));
  const rows = [];
  for (const company of companies) for (let day = 1; day <= 3; day++) rows.push({ companyId: company.companyId, companyKey: company.companyId,
    runId: "saved_normal", collectedAt: "2027-01-01T00:00:00Z", stayDate: "2027-01-0" + day, productType: "lodging", inventoryEvidenceVersion: 5,
    supply: 10, sold: 3, publicBookings: 1, phoneBookings: 2, publicRevenue: 100000, phoneRevenue: 100000, estimatedRevenue: 200000,
    phoneMissingPriceBookings: 1, priceUnknownCauses: [cause(1, [company.companyId + "_sku"])], partial: false, missing: false });
  const inputs = { companies, runs: [{ id: "saved_normal", collectedAt: "2027-01-01T00:00:00Z", collectionQuality: { status: "complete" } }], observations: rows };
  const request = { type: "region", targetId: "region_test", month: "2027-01", cutoffDate: "2027-01-31" }, at = "2027-02-02T00:00:00Z", bytes = JSON.stringify(inputs);
  const actual = buildMonthlyReportSnapshot(request, inputs, at), expected = before.exports.buildMonthlyReportSnapshot(request, inputs, at);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(actual.summary.lodging.sold, 18); assert.equal(actual.summary.lodging.estimatedRevenue, 1200000);
  assert.equal(actual.summary.lodging.phoneMissingPriceBookings, 6); assert.equal(JSON.stringify(inputs), bytes);
});

test("543 companies and 31 dates accumulate 10000 product keys with linear insertion work", () => {
  let insertions = 0;
  class CountingSet extends Set { add(value) { insertions++; return super.add(value); } }
  const measured = compileHelpers(helperSource, CountingSet), rows = []; let inputKeys = 0;
  for (let day = 0; day < 31; day++) for (let company = 0; company < 543; company++) {
    const size = company === 0 ? 62 : company <= 35 ? 26 : 27;
    const keys = Array.from({ length: size }, (_, index) => "sku_" + ((company * 27 + index) % 10000)); inputKeys += keys.length;
    rows.push({ priceUnknownCauses: [cause(1, keys)] });
  }
  const began = performance.now(), result = measured.priceUnknownCauseSummary(rows), elapsed = performance.now() - began;
  assert.equal(rows.length, 16833); assert.equal(inputKeys / rows.length, 27);
  assert.equal(result.priceUnknownCauses[0].quantity, rows.length); assert.equal(result.priceUnknownCauses[0].productKeys.length, 10000);
  assert.equal(new Set(result.priceUnknownCauses[0].productKeys).size, 10000);
  assert.ok(insertions <= inputKeys * 3, "normalization and merging must insert only a bounded multiple of input keys, never each growing union per row");
  console.log(JSON.stringify({ benchmark: "SYNTHETIC", companies: 543, days: 31, averageKeys: 27, maxKeys: 62, unionKeys: 10000,
    inputKeys, measuredSetInsertions: insertions, elapsedMs: Math.round(elapsed) }));
  // The old copying algorithm must demonstrably fail the same complexity bound.
  insertions = 0;
  const oldMeasured = compileHelpers(oldHelpers, CountingSet), smaller = rows.slice(0, 543 * 2), smallKeys = smaller.reduce((sum, row) => sum + row.priceUnknownCauses[0].productKeys.length, 0);
  oldMeasured.priceUnknownCauseSummary(smaller);
  assert.ok(insertions > smallKeys * 20, "the operation-count regression detects the previous repeated-union behavior");
});
