"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { build } = require("../web/regional-location-summary.js");
const scope = { regionKey: "fixture-region", month: "2026-09", months: 13 };
const input = extra => ({ regionKey: scope.regionKey, month: scope.month, ...extra });
const contract = extra => ({ version: "regional-data-contract-v1", requestedRegionKey: scope.regionKey, officialCode: "12345", requestedLevel: "sigungu", requestedUnitType: "county",
  provider: "한국관광공사", providerRegionCode: "12345", providedLevel: "sigungu", scopeKind: "administrative", status: "matched", evidence: "response", aggregation: "none", ...extra });
const months = (end = "2026-08", count = 13) => Array.from({ length: count }, (_, index) => new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5)) - count + index, 1)).toISOString().slice(0, 7));
const metric = (key, extra = {}) => ({ key, unit: "지수", periodType: "M", rows: months().map(period => ({ period, status: "observed", value: 10, spatialContract: contract() })), ...extra });
const result = groups => ({ scope: { ...scope }, snapshot: { scope: { ...scope }, resultId: "saved-fixture", generatedAt: "2026-10-19T00:00:00Z", groups }, job: null });
const group = (key = "demandStrength", metrics = [metric("stayOverall"), metric("spendOverall")], extra = {}) => ({ key, provider: "한국관광공사", periodType: "M", metrics, spatialContract: contract({ status: "scope_unverified", evidence: "unverified" }), ...extra });
const card = (model, key = "strength") => model.cards.find(item => item.key === key);
function freeze(value) { if (value && typeof value === "object") { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; }

test("unqueried and loading states do not invent zero coverage; a loaded empty response is missing", () => {
  for (const model of [build(input()), build(input({ result: null }))]) {
    assert.equal(model.status, "unqueried"); assert.equal(card(model).coverage, null); assert.equal(card(model).items[0].valueLabel, "확인 전");
  }
  const loading = build(input({ loading: true }));
  assert.equal(loading.status, "loading"); assert.equal(card(loading).coverage, null); assert.equal(card(loading).items[0].valueLabel, "확인 중");
  const empty = build(input({ result: { scope, snapshot: null } }));
  assert.equal(empty.status, "missing"); assert.equal(card(empty).items[0].value, null);
  const loaded = build(input({ result: result([]) }));
  assert.equal(card(loaded).status, "missing"); assert.equal(card(loaded).coverage.completeMonths, 0); assert.equal(card(loaded).coverage.expectedMonths, 13);
});

test("a scope-validated null snapshot confirms 0/13 saved observations while every numeric value stays unknown", () => {
  const data = freeze({ scope: { ...scope }, snapshot: null }), model = build(input({ result: data }));
  assert.equal(model.status, "missing"); assert.equal(model.resultId, "");
  for (const summary of model.cards) {
    assert.equal(summary.status, "missing");
    assert.deepEqual(summary.coverage, { expectedMonths: 13, completeMonths: 0, partialMonths: 0, missingMonths: 13, startPeriod: "2025-09", endPeriod: "2026-09", rate: 0 });
    for (const item of summary.metrics) { assert.equal(item.value, null); assert.equal(item.period, ""); assert.equal(item.valueLabel, "관측 없음"); assert.deepEqual(item.coverage, summary.coverage); }
  }
  for (const options of [{ result: undefined }, { loading: true }, { error: "조회 실패" }, { result: { scope, snapshot: null, storage: { errorCode: "REGIONAL_STORE_UNAVAILABLE" } } }]) {
    const unavailable = build(input(options));
    assert.ok(unavailable.cards.every(summary => summary.coverage === null && summary.metrics.every(item => item.value === null && item.coverage === null)));
  }
});

test("latest official normal month and its 13-month coverage survive an unavailable requested month", () => {
  const rows = [...metric("stayOverall").rows, { period: "2026-09", status: "partial", value: 999 }];
  const model = build(input({ result: result([group("demandStrength", [metric("stayOverall", { rows }), metric("spendOverall")])]) }));
  const summary = card(model), item = summary.metrics[0];
  assert.equal(summary.status, "ready"); assert.equal(item.period, "2026-08"); assert.equal(item.value, 10);
  assert.deepEqual([item.coverage.startPeriod, item.coverage.endPeriod, item.coverage.completeMonths, item.coverage.expectedMonths], ["2025-08", "2026-08", 13, 13]);
  assert.equal(item.requested.status, "partial"); assert.equal(item.lagMonths, 1); assert.equal(summary.note, "2026-08 최근 정상월 · 13개월 기준");
});

test("real zero and canonical visitor totals and units remain independent", () => {
  const model = build(input({ result: result([group("visitors", [metric("averageDailyVisitors", { unit: "명", rows: [{ period: "2026-08", status: "observed", value: 45048 }] }), metric("visitorDays", { unit: "인일", rows: [{ period: "2026-08", status: "observed", value: 1396483 }] })]), group("demandStrength", [metric("stayOverall", { rows: [{ period: "2026-08", status: "observed", value: 0 }] }), metric("spendOverall")])]) }));
  assert.equal(card(model).metrics[0].value, 0); assert.equal(card(model).metrics[0].valueLabel, "0 지수"); assert.equal(card(model).metrics[0].coverage.completeMonths, 1);
  const visitors = card(model, "visitor").metrics;
  assert.deepEqual(visitors.map(item => [item.value, item.unit]), [[45048, "명"], [1396483, "인일"]]);
});

test("coverage keeps each metric's latest window and its internal missingness", () => {
  const stay = metric("stayOverall"), spend = metric("spendOverall", { rows: months("2026-07").map(period => ({ period, status: period === "2026-03" ? "missing" : "observed", value: 3 })) });
  const summary = card(build(input({ result: result([group("demandStrength", [stay, spend])]) })));
  assert.equal(summary.status, "partial"); assert.equal(summary.coverage.perMetricWindows, true);
  assert.deepEqual(summary.metrics.map(item => [item.period, item.coverage.completeMonths]), [["2026-08", 13], ["2026-07", 12]]);
  assert.match(summary.note, /지표별 최근 정상월/);
});

test("normal observations with pending proof stay visible; row scope overrides unverified group metadata", () => {
  const rows = [{ period: "2026-09", status: "observed", value: 69.5, spatialContract: contract({ status: "scope_unverified", evidence: "unverified" }), storedEvidenceVerification: { status: "pending", reasonCode: "TOURISM_ORIGINAL_RESPONSE_NOT_STORED" } }];
  const summary = card(build(input({ result: result([group("demandStrength", [metric("stayOverall", { rows }), metric("spendOverall")])]) })));
  assert.equal(summary.metrics[0].value, 69.5); assert.equal(summary.metrics[0].evidenceStatus, "pending"); assert.equal(summary.metrics[0].referenceOnly, true);
  assert.equal(summary.metrics[1].comparisonEligible, true); assert.equal(summary.metrics[1].referenceOnly, false);
  assert.equal(summary.metrics[0].evidenceCoverage.pendingMonths, 1); assert.equal(summary.metrics[0].evidenceCoverage.storedVerifiedMonths, 0);
});

test("canonical requestedPoint outside the latest-normal window retains partial and rejected proof diagnostics", () => {
  const requestedPoint = { period: "2026-09", status: "partial", value: null, reasonCode: "PARTIAL_DATA",
    spatialContract: contract({ status: "scope_unverified", evidence: "unverified" }),
    storedEvidenceVerification: { status: "rejected", reasonCode: "VISITOR_RAW_INCOMPLETE_DAYS" } };
  const item = card(build(input({ result: result([group("visitors", [metric("averageDailyVisitors", { unit: "명", requestedPoint })])]) })), "visitor").metrics[0];
  assert.equal(item.period, "2026-08"); assert.equal(item.value, 10); assert.equal(item.coverage.completeMonths, 13);
  assert.deepEqual(item.requested, { period: "2026-09", status: "partial", reasonCode: "PARTIAL_DATA", spatialStatus: "scope_unverified", evidenceStatus: "rejected", evidenceReasonCode: "VISITOR_RAW_INCOMPLETE_DAYS" });
  const missing = card(build(input({ result: result([group("demandStrength", [metric("stayOverall", { requestedPoint: { period: "2026-09", status: "missing", value: null, reasonCode: "NOT_COLLECTED" } })])]) }))).metrics[0];
  assert.equal(missing.requested.reasonCode, "NOT_COLLECTED"); assert.equal(missing.period, "2026-08");
});

test("numeric coverage and stored-original evidence coverage remain separate for the same 13 months", () => {
  const proof = { version: "stored-test-v1", sourceKind: "stored_raw_response", evidenceId: "original-august", sha256: "a".repeat(64), period: "2026-08", verifiedAt: "2026-10-19T00:00:00Z", checks: ["region", "period", "value"] };
  const rows = months().map(period => ({ period, status: "observed", value: 0,
    spatialContract: period === "2026-08" ? contract({ storedProvenance: proof }) : contract({ status: "scope_unverified", evidence: "unverified" }),
    storedEvidenceVerification: period === "2026-08" ? { status: "restored" } : { status: "pending", reasonCode: "TOURISM_ORIGINAL_RESPONSE_NOT_STORED" } }));
  const summary = card(build(input({ result: result([group("demandStrength", [metric("stayOverall", { rows }), metric("spendOverall", { rows })])]) })));
  assert.equal(summary.coverage.completeMonths, 13); assert.equal(summary.evidenceCoverage.storedVerifiedMonths, 1);
  assert.deepEqual(summary.metrics[0].evidenceCoverage, { expectedMonths: 13, observedMonths: 13, scopeVerifiedMonths: 1, storedVerifiedMonths: 1, unverifiedObservedMonths: 12, unobservedMonths: 0, pendingMonths: 12, rejectedMonths: 0 });
  assert.equal(summary.metrics[0].evidenceStatus, "restored"); assert.equal(summary.metrics[0].value, 0);
});

test("a latest-month metric proof cannot verify other months or override explicitly rejected proof", () => {
  const proof = { version: "stored-test-v1", sourceKind: "stored_raw_response", evidenceId: "latest-original", sha256: "b".repeat(64), period: "2026-08", verifiedAt: "2026-10-19T00:00:00Z" };
  const rows = months().map(period => ({ period, status: "observed", value: 7 }));
  const read = (storedProvenance = proof, storedEvidenceVerification) => card(build(input({ result: result([group("demandStrength", [metric("stayOverall", { rows, spatialContract: contract({ storedProvenance }), storedEvidenceVerification })])]) }))).metrics[0];
  assert.equal(read().evidenceCoverage.storedVerifiedMonths, 1); assert.equal(read().originalVerified, true);
  const wrongPeriod = read({ ...proof, period: "2026-09" });
  assert.equal(wrongPeriod.evidenceCoverage.storedVerifiedMonths, 0); assert.equal(wrongPeriod.originalVerified, false); assert.equal(wrongPeriod.value, 7);
  const rejected = read(proof, { status: "rejected", reasonCode: "STORED_RESPONSE_VALUE_MISMATCH" });
  assert.equal(rejected.evidenceCoverage.storedVerifiedMonths, 0); assert.equal(rejected.originalVerified, false); assert.equal(rejected.evidenceStatus, "rejected");
});

test("partial, suppressed, pending, invalid numeric and future points never become a normal headline", () => {
  const rows = [
    { period: "2025-10", status: "partial", value: 100 }, { period: "2025-11", status: "suppressed", value: 100 },
    { period: "2025-12", status: "publication_pending", value: 100 }, { period: "2026-01", status: "failed", value: 100 },
    { period: "2026-02", status: "observed", value: -1 }, { period: "2026-03", status: "observed", value: "100" },
    { period: "2026-04", status: "observed", value: NaN }, { period: "2026-05", status: "observed", value: Infinity },
    { period: "2026-10", status: "observed", value: 100 }
  ];
  const item = card(build(input({ result: result([group("demandStrength", [metric("stayOverall", { rows })])]) }))).metrics[0];
  assert.equal(item.value, null); assert.equal(item.period, ""); assert.equal(item.coverage.completeMonths, 0);
  assert.equal(item.coverage.partialMonths, 1); assert.equal(item.coverage.suppressedMonths, 1); assert.equal(item.coverage.publicationPendingMonths, 1);
});

test("duplicate monthly observations and duplicate metric/group keys cannot choose an arbitrary normal value", () => {
  const duplicate = [{ period: "2026-08", status: "observed", value: 1 }, { period: "2026-08", status: "observed", value: 2 }];
  const cases = [[group("demandStrength", [metric("stayOverall", { rows: duplicate })])], [group("demandStrength", [metric("stayOverall"), metric("stayOverall")])], [group(), group()]];
  for (const groups of cases) { const item = card(build(input({ result: result(groups) }))).metrics[0]; assert.equal(item.value, null); assert.equal(item.status, "error"); }
});

test("selected region, month and 13-month scope must match every response envelope", () => {
  for (const location of ["scope", "snapshot", "management", "job"]) for (const replacement of [{ regionKey: "other-region" }, { month: "2026-08" }, { months: 12 }]) {
    const data = result([group()]);
    if (location === "scope") Object.assign(data.scope, replacement);
    else { data[location] ||= {}; data[location].scope = { ...scope, ...replacement }; }
    const model = build(input({ result: data }));
    assert.equal(model.status, "mismatch"); assert.equal(model.resultId, ""); assert.ok(model.cards.every(item => item.metrics.every(metric => metric.value === null)));
  }
});

test("an explicit wrong row geography cannot leak a different region's value", () => {
  const rows = [{ period: "2026-09", status: "observed", value: 999, spatialContract: contract({ requestedRegionKey: "other-region" }) }, { period: "2026-08", status: "observed", value: 7, spatialContract: contract() }];
  const item = card(build(input({ result: result([group("demandStrength", [metric("stayOverall", { rows })])]) }))).metrics[0];
  assert.equal(item.value, 7); assert.equal(item.period, "2026-08"); assert.equal(item.requested.status, "error"); assert.equal(item.requested.reasonCode, "REGION_MISMATCH");
});

test("mapping holds retain their distinct recorded reason rather than becoming a wrong-geography error", () => {
  const rows = [{ period: "2026-09", status: "error", value: null, reasonCode: "MAPPING_MISSING", spatialContract: contract({ status: "mapping_pending" }) }];
  const item = card(build(input({ result: result([group("demandStrength", [metric("stayOverall", { rows })])]) }))).metrics[0];
  assert.equal(item.value, null); assert.equal(item.requested.reasonCode, "MAPPING_MISSING");
});

test("failed confirmation preserves the supplied canonical result and reports stale state without mutation", () => {
  const data = freeze(result([group()])), before = JSON.stringify(data);
  const model = build(input({ result: data, loading: true, error: "확인 실패" }));
  assert.equal(card(model).metrics[0].value, 10); assert.equal(model.loading, true); assert.equal(model.stale, true); assert.equal(model.error, "확인 실패"); assert.equal(JSON.stringify(data), before);
});

test("browser adapter uses only the supplied canonical contract and never fetches or reads storage", () => {
  const context = { RegionalDataContract: require("../web/regional-data-contract.js"), fetch() { throw new Error("unexpected network"); }, localStorage: new Proxy({}, { get() { throw new Error("unexpected storage"); } }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/regional-location-summary.js"), "utf8"), context);
  const model = context.RegionalLocationSummary.build(input({ result: result([group()]) }));
  assert.equal(card(model).metrics[0].value, 10); assert.equal(card(model).metrics[0].coverage.expectedMonths, 13);
});
