"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { projectIntegrated } = require("./lib/insight_company_integrated.cjs");
const ID = "cmp_cause_projection", MONTH = "2026-09", AT = "2026-10-25T01:00:00Z";
const request = { type: "company", targetId: ID, month: MONTH, cutoffDate: "2026-09-30" };
const cause = (code, channel, quantity, productKeys = []) => ({ code, channel, quantity, productKeys });
const copy = value => JSON.parse(JSON.stringify(value));
const row = (date, overrides = {}) => ({ companyId: ID, runId: "run-causes", collectedAt: "2026-09-01T00:00:00Z", date,
  productType: "lodging", inventoryEvidenceVersion: 5, supply: 10, sold: 4, publicBookings: 1, phoneBookings: 3,
  publicRevenue: 200000, phoneRevenue: 0, estimatedRevenue: 200000, phoneMissingPriceBookings: 3,
  sharedDayUseExcluded: 0, explicitBlockedBookings: 0, ...overrides });
function source(observations) { return { companies: [{ companyId: ID, primaryName: "원인 연결 검수", capacity: 10 }],
  runs: [{ id: "run-causes", collectedAt: "2026-09-01T00:00:00Z", collectionQuality: { status: "complete" } }], observations }; }
const snapshot = observations => buildMonthlyReportSnapshot(request, source(observations), AT);
const customer = value => projectIntegrated(ID, { schemaVersion: 1, companyId: ID, status: "ready", selectedMonth: MONTH,
  calculationVersion: "fixture-causes", sourceRevision: "a".repeat(64), snapshot: value }, MONTH);
function serverProjection() {
  const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8"), context = vm.createContext({});
  for (const name of ["productSnapshotNumber", "inventoryEstimateBreakdown"]) {
    const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
    assert.ok(declaration, name); vm.runInContext(declaration, context);
  }
  return value => copy(context.inventoryEstimateBreakdown(value));
}
const withoutDiagnostics = value => Array.isArray(value) ? value.map(withoutDiagnostics) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !["priceUnknownCauses", "priceUnknownCauseCoverage"].includes(key)).map(([key, item]) => [key, withoutDiagnostics(item)])) : value;

test("server observation breakdown retains only the cause contract and preserves absent versus classified empty", () => {
  const project = serverProjection(), value = cause("explicit_product_price_missing", "other", 2, ["p1", "p1"]);
  value.privateToken = "private-token";
  assert.deepEqual(project({ phoneMissingPriceBookings: 2, priceUnknownCauses: [value] }).priceUnknownCauses,
    [cause("explicit_product_price_missing", "other", 2, ["p1"])]);
  assert.deepEqual(project({ priceUnknownCauses: [] }).priceUnknownCauses, []);
  assert.equal(Object.hasOwn(project({ phoneMissingPriceBookings: null }), "priceUnknownCauses"), false);
});

test("company daily and month diagnostics sum each channel separately without changing bookings or money", () => {
  const observations = [row("2026-09-04", { priceUnknownCauses: [cause("explicit_product_price_missing", "other", 1, ["p1"]),
    cause("company_capacity_unallocated_to_products", "other", 2, ["p2"])] }),
  row("2026-09-05", { priceUnknownCauses: [cause("company_capacity_unallocated_to_products", "other", 3, ["p2", "p3"])] }),
  row("2026-09-06", { publicBookings: 2, phoneBookings: 0, sold: 2, publicRevenue: 0, estimatedRevenue: 0,
    phoneMissingPriceBookings: 0, priceUnknownCauses: [cause("public_product_price_missing", "public", 2, ["p4"])] }),
  row("2026-09-07", { productType: "dayuse", priceUnknownCauses: [cause("inferred_product_price_missing", "other", 3, ["dayuse-p1"])] })];
  const current = snapshot(observations), old = snapshot(observations.map(({ priceUnknownCauses, ...value }) => value));
  for (const field of ["summary", "daily", "companies", "changes", "ranks", "quality", "insights"]) {
    assert.deepEqual(withoutDiagnostics(current[field]), old[field], `${field} keeps all original non-diagnostic results`);
  }
  assert.deepEqual(current.summary.lodging.priceUnknownCauses, [cause("explicit_product_price_missing", "other", 1, ["p1"]),
    cause("company_capacity_unallocated_to_products", "other", 5, ["p2", "p3"]), cause("public_product_price_missing", "public", 2, ["p4"])]);
  assert.deepEqual(current.summary.lodging.priceUnknownCauseCoverage, { classifiedCompanyDays: 3, unclassifiedCompanyDays: 0 });
  assert.equal(current.summary.lodging.phoneMissingPriceBookings, 6);
  assert.equal(current.summary.lodging.sold, 10);
  assert.equal(current.summary.lodging.estimatedRevenue, 400000);
  assert.equal(current.summary.dayuse.priceUnknownCauses[0].quantity, 3);
  assert.equal(current.daily.find(day => day.date === "2026-09-06").lodging.estimatedRevenue, null);
  assert.deepEqual(current.companies[0].summary.lodging.priceUnknownCauses, current.summary.lodging.priceUnknownCauses);
});

test("missing and blocked quantity rows cannot contribute diagnostic quantities or claims of completed classification", () => {
  const missing = row("2026-09-05", { missing: true, priceUnknownCauses: [cause("invalid_product_response", "other", 9, ["bad"])] });
  const data = source([row("2026-09-04", { priceUnknownCauses: [cause("inferred_product_price_missing", "other", 3)] }), missing,
    row("2026-09-06", { runId: "blocked", priceUnknownCauses: [cause("invalid_product_response", "other", 7)] })]);
  data.runs.push({ id: "blocked", collectionQuality: { status: "blocked" } });
  const value = buildMonthlyReportSnapshot(request, data, AT);
  assert.equal(value.summary.lodging.priceUnknownCauses[0].quantity, 3);
  assert.equal(value.summary.lodging.priceUnknownCauseCoverage.classifiedCompanyDays, 1);
  assert.equal(Object.hasOwn(value.daily.find(day => day.date === "2026-09-05").lodging, "priceUnknownCauses"), false);
  assert.equal(value.sources.observations.length, 1);
});

test("legacy absence unknown quantities and observed empty diagnosis remain distinct through the customer boundary", () => {
  const value = snapshot([row("2026-09-04"), row("2026-09-05", { sold: 0, publicBookings: 0, phoneBookings: 0,
    publicRevenue: 0, estimatedRevenue: 0, phoneMissingPriceBookings: 0, priceUnknownCauses: [] })]);
  assert.deepEqual(value.summary.lodging.priceUnknownCauses, []);
  assert.deepEqual(value.summary.lodging.priceUnknownCauseCoverage, { classifiedCompanyDays: 1, unclassifiedCompanyDays: 1 });
  const result = customer(value), legacy = result.snapshot.daily.find(day => day.date === "2026-09-04"), zero = result.snapshot.daily.find(day => day.date === "2026-09-05"), missing = result.snapshot.daily.find(day => day.date === "2026-09-06");
  assert.equal(Object.hasOwn(legacy, "priceUnknownCauses"), false);
  assert.deepEqual(zero.priceUnknownCauses, []); assert.equal(zero.estimatedRevenue, 0);
  assert.equal(Object.hasOwn(missing, "priceUnknownCauses"), false); assert.equal(missing.estimatedRevenue, null);
  assert.deepEqual(result.snapshot.summary.priceUnknownCauseCoverage, { classifiedCompanyDays: 1, unclassifiedCompanyDays: 1 });
});

test("customer summary daily and original-observation linkage preserve safe cause evidence without private fields", () => {
  const value = cause("company_capacity_unallocated_to_products", "other", 3, ["p1", "p2"]); value.internalPath = "/var/data/private";
  const result = customer(snapshot([row("2026-09-04", { priceUnknownCauses: [value] })]));
  const expected = [cause("company_capacity_unallocated_to_products", "other", 3, ["p1", "p2"])], day = result.snapshot.daily.find(day => day.date === "2026-09-04");
  assert.deepEqual(day.priceUnknownCauses, expected); assert.deepEqual(day.sourceObservation.priceUnknownCauses, expected);
  assert.deepEqual(result.snapshot.provenance.observations[0].priceUnknownCauses, expected);
  assert.deepEqual(result.snapshot.summary.priceUnknownCauses, expected);
  assert.doesNotMatch(JSON.stringify(result), /internalPath|\/var\/data/);
});

test("malformed diagnoses are unclassified instead of being converted into a normal empty array", () => {
  const project = serverProjection(), code = "explicit_product_price_missing";
  for (const invalid of [cause(code, "unknown", 1), cause(code, "other", 0), cause(code, "other", null),
    cause(code, "other", 1.5), cause(code, "other", -1), cause(code, "other", 1, ["/var/data/private"]),
    cause("unsupported_cause", "other", 1), cause("<script>", "other", 1)]) {
    const value = snapshot([row("2026-09-04", { priceUnknownCauses: [invalid] })]);
    assert.equal(Object.hasOwn(project({ priceUnknownCauses: [invalid] }), "priceUnknownCauses"), false);
    assert.equal(Object.hasOwn(value.sources.observations[0], "priceUnknownCauses"), false);
    assert.equal(Object.hasOwn(customer(value).snapshot.summary, "priceUnknownCauses"), false);
  }
});

test("same-date grouped recovery keeps null SKU identity and safe recovery provenance without adding money twice", () => {
  const estimate = { productKey: null, productKeys: ["p1", "p2"], quantity: 3, unitPrice: 100000, revenue: 300000,
    source: "same_product_same_date", sourceDate: "2026-09-04", quantitySource: "uniform_current_catalog_price_v1",
    recoveryPolicy: "uniform_current_catalog_price_v1", estimatedQuantity: true };
  const policy = { policy: "uniform_current_catalog_price_v1", quantity: 3, revenue: 300000, productKeys: ["p1", "p2"],
    estimatedQuantity: true, sourceDate: "2026-09-04", unitPrice: 100000, rawPayload: "private-token" };
  const input = row("2026-09-04", { phoneRevenue: 300000, estimatedRevenue: 500000, phoneMissingPriceBookings: 0,
    phonePriceEstimates: [estimate], priceUnknownCauses: [], priceRecoveryPolicy: "inventory_price_recovery_v1",
    phoneValuation: { policy: "proportional_product_shortfall_v2", quantityPolicy: "residual_product_shortfall_proportional",
      roundingPolicy: "round_each_stay_date_krw", unroundedRevenue: 300000, recoveryPolicies: [policy] } });
  const breakdown = serverProjection()(input);
  assert.equal(breakdown.phonePriceEstimates[0].productKey, null);
  assert.deepEqual(breakdown.phonePriceEstimates[0].productKeys, ["p1", "p2"]);
  assert.equal(breakdown.phonePriceEstimates[0].source, "same_product_same_date");
  assert.equal(breakdown.phonePriceEstimates[0].recoveryPolicy, "uniform_current_catalog_price_v1");
  assert.equal(breakdown.priceRecoveryPolicy, "inventory_price_recovery_v1");
  const value = snapshot([input]), projected = customer(value), day = projected.snapshot.daily.find(day => day.date === "2026-09-04");
  assert.equal(value.sources.observations[0].phonePriceEstimates[0].productKey, null);
  assert.equal(value.sources.observations[0].priceRecoveryPolicy, "inventory_price_recovery_v1");
  assert.equal(day.priceRecoveryPolicy, "inventory_price_recovery_v1");
  assert.deepEqual(day.phoneValuation.recoveryPolicies, [{ policy: "uniform_current_catalog_price_v1", quantity: 3,
    revenue: 300000, productKeys: ["p1", "p2"], estimatedQuantity: true, sourceDate: "2026-09-04", unitPrice: 100000 }]);
  assert.deepEqual(day.sourceObservation.phoneValuation.recoveryPolicies, day.phoneValuation.recoveryPolicies);
  assert.equal(value.summary.lodging.estimatedRevenue, 500000); assert.equal(value.summary.lodging.phoneRevenue, 300000);
  assert.doesNotMatch(JSON.stringify(projected), /rawPayload|private-token/);
});

test("catalog-identity recovery metadata remains an estimate and legacy rows gain no invented recovery policy", () => {
  const policy = { policy: "catalog_single_room_identity_v1", quantity: 1, revenue: 120000,
    productKeys: ["catalog-p1"], estimatedQuantity: true, sourceDate: "2026-09-04" };
  const value = snapshot([row("2026-09-04", { priceRecoveryPolicy: "inventory_price_recovery_v1",
    phoneValuation: { policy: "proportional_product_shortfall_v2", recoveryPolicies: [policy] } })]);
  const day = customer(value).snapshot.daily.find(day => day.date === "2026-09-04");
  assert.deepEqual(day.phoneValuation.recoveryPolicies, [policy]);
  assert.equal(Object.hasOwn(customer(snapshot([row("2026-09-04")])).snapshot.daily.find(day => day.date === "2026-09-04"), "priceRecoveryPolicy"), false);
});

test("customer recovery evidence rejects zero fractional or unsupported money and incomplete product identity", () => {
  const valid = { policy: "catalog_single_room_identity_v1", quantity: 1, revenue: 120000, productKeys: ["p1"], estimatedQuantity: true, sourceDate: "2026-09-04" };
  for (const change of [{ revenue: 0 }, { revenue: null }, { revenue: 1.5 }, { revenue: -1 }, { quantity: 0 }, { quantity: 1.5 },
    { productKeys: [] }, { productKeys: ["p1", "p1"] }, { productKeys: ["/private"] }, { sourceDate: "2026-02-30" }, { unitPrice: 0 }, { unitPrice: -1 },
    { policy: "unsupported_policy" }, { estimatedQuantity: false }]) {
    const value = snapshot([row("2026-09-04", { priceRecoveryPolicy: "unsupported_policy",
      phoneValuation: { policy: "proportional_product_shortfall_v2", recoveryPolicies: [{ ...valid, ...change }] } })]);
    const day = customer(value).snapshot.daily.find(day => day.date === "2026-09-04");
    assert.equal(Object.hasOwn(day.phoneValuation, "recoveryPolicies"), false, JSON.stringify(change));
    assert.equal(Object.hasOwn(day, "priceRecoveryPolicy"), false);
    assert.equal(Object.hasOwn(value.sources.observations[0], "priceRecoveryPolicy"), false);
    assert.equal(Object.hasOwn(serverProjection()({ priceRecoveryPolicy: "unsupported_policy" }), "priceRecoveryPolicy"), false);
  }
});
