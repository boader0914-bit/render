"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createMonthlyReportOutlookEvaluation, MAX_REGIONS, MAX_ROWS } = require("./lib/monthly_report_outlook_evaluation.cjs");
const NOW = "2026-10-16T01:00:00.000Z";
const REGION = "kr_gyeongnam_sancheong";
const request = { type: "company", targetId: "cmp_wolmyeong", month: "2026-09", cutoffDate: "2026-09-30" };
const catalog = { companies: [{ companyId: request.targetId, regionKey: REGION, primaryName: "월명글램핑", regionLabel: "경상남도 산청군" }],
  regions: [{ id: REGION, label: "경상남도 산청군", level: "local" }] };
function compared(overrides = {}) {
  return { regionKey: REGION, issueMonth: "2026-09", targetPeriod: "2026-09", kind: "current", groupKey: "visitors", metricKey: "averageDailyVisitors",
    label: "일평균 방문자", unit: "명", provider: "한국관광공사", modelVersion: "regional-outlook-v1", status: "compared", reasonCode: "",
    forecastValue: 100, actualValue: 110, difference: 10, absoluteError: 10, errorPct: 9.090909, percentageReasonCode: "",
    predictionRef: { resultId: crypto.randomUUID(), publishedAt: "2026-09-02T00:00:00Z", generatedAt: "2026-09-02T00:00:00Z", proof: "journal", coverage: "recorded",
      inputLatestPeriod: "2026-08", selection: "earliest_retained_publication", retainedPublicationCount: 1 },
    actualRef: { receivedAt: "2026-10-15T00:00:00Z", period: "2026-09", sourceFingerprint: "official-100", snapshotAt: "2026-10-15T00:00:00Z",
      receiptEvidence: "source_timestamp", policy: "latest_official_as_of", firstObservedValue: 110, revised: false, sourceBatchId: null, normalizationPeriod: null }, ...overrides };
}
function saved(rows = [compared()], overrides = {}) {
  return { snapshot: { schemaVersion: 1, calculationVersion: "regional-outlook-evaluation-storage-v1", resultId: crypto.randomUUID(),
    scope: { regionKey: REGION, month: "2026-10", months: 13 }, generatedAt: "2026-10-16T00:30:00Z", evaluatedThrough: "2026-10-16T00:30:00Z",
    selectionPolicy: "earliest_retained_publication", actualPolicy: "latest_official_as_of", rows, networkAttempted: false, ...overrides },
    job: { status: "completed", errorCode: null }, storage: { errorCode: null } };
}
function reader(value, options = {}) {
  const calls = [];
  const read = createMonthlyReportOutlookEvaluation({ evaluationService: { get: async input => { calls.push(structuredClone(input)); return typeof value === "function" ? value(input) : value; },
    request: () => assert.fail("report cannot queue an evaluation"), sourceChanged: () => assert.fail("report cannot change stored evaluations") }, now: () => NOW, ...options });
  return { read, calls };
}

test("report reads only saved evaluation and snapshots target month with publication and official evidence", async () => {
  const input = saved(), before = JSON.stringify(input), f = reader(input);
  const result = await f.read(request, catalog, { asOfAt: NOW });
  assert.deepEqual(f.calls, [{ regionKey: REGION, months: 13 }]);
  assert.equal(result.schemaVersion, 1); assert.equal(result.networkAttempted, false);
  assert.equal(result.status, "ready"); assert.equal(result.asOfAt, NOW); assert.equal(result.cutoffDate, "2026-09-30");
  assert.equal(result.temporalBasis, "saved_evaluation_at_report_creation");
  assert.match(result.temporalLabel, /예약/); assert.match(result.warnings.join(" "), /사후 자료/);
  const region = result.regions[0], row = region.rows[0];
  assert.equal(region.basis, "company_actual_location"); assert.equal(region.source.resultId, input.snapshot.resultId);
  assert.equal(region.source.evaluationScopeMonth, "2026-10"); assert.deepEqual(region.summaryCounts, { total: 1, compared: 1, pending: 0, excluded: 0 });
  assert.equal(row.predictionRef.resultId, input.snapshot.rows[0].predictionRef.resultId); assert.equal(row.actualRef.receivedAt, "2026-10-15T00:00:00.000Z");
  assert.equal(row.issueMonth, "2026-09"); assert.equal(row.targetPeriod, "2026-09"); assert.equal(row.provider, "한국관광공사");
  row.actualValue = 999; assert.equal(JSON.stringify(input), before, "projection must not mutate saved result or its nested references");
});

test("report month selects forecast target, including preceding issue month's next outlook; other targets are omitted", async () => {
  const current = compared(), prior = compared({ issueMonth: "2026-08", kind: "next", predictionRef: {
    ...current.predictionRef, resultId: crypto.randomUUID(), generatedAt: "2026-08-02T00:00:00Z", publishedAt: "2026-08-02T00:00:00Z", inputLatestPeriod: "2026-07" } });
  const later = compared({ targetPeriod: "2026-10" });
  const result = await reader(saved([current, prior, later])).read(request, catalog);
  assert.equal(result.regions[0].summaryCounts.compared, 2);
  assert.deepEqual(result.regions[0].rows.map(row => [row.issueMonth, row.kind]), [["2026-09", "current"], ["2026-08", "next"]]);
  assert.ok(result.regions[0].rows.every(row => row.targetPeriod === request.month));
});

test("normal official zero is a compared value, pending zero stays null and does not acquire an accuracy score", async () => {
  const zero = compared({ actualValue: 0, difference: -100, absoluteError: 100, errorPct: null });
  const pending = compared({ status: "pending", reasonCode: "OFFICIAL_PUBLICATION_PENDING", actualValue: 0, difference: 0, absoluteError: 0, errorPct: 0 });
  const result = await reader(saved([zero, pending])).read(request, catalog), region = result.regions[0];
  assert.equal(result.status, "partial"); assert.deepEqual(region.summaryCounts, { total: 2, compared: 1, pending: 1, excluded: 0 });
  assert.equal(region.rows[0].actualValue, 0); assert.equal(region.rows[0].errorPct, null); assert.equal(region.rows[0].percentageReasonCode, "ZERO_ACTUAL_DENOMINATOR");
  for (const field of ["actualValue", "difference", "absoluteError", "errorPct", "actualRef"]) assert.equal(region.rows[1][field], null, field);
  assert.deepEqual(region.reasonCounts, [{ code: "OFFICIAL_PUBLICATION_PENDING", label: "공식자료 공표를 기다리고 있습니다.", count: 1 }]);
  assert.equal(Object.hasOwn(region, "scores"), false, "cumulative scores for unrelated months are never copied");
});

test("a missing saved result is unknown rather than zero; a valid empty target is an explicit zero sample count", async () => {
  const absent = await reader({ snapshot: null }).read(request, catalog);
  assert.equal(absent.regions[0].summaryCounts, null); assert.equal(absent.regions[0].reasonCode, "NO_SAVED_EVALUATION");
  const noTarget = await reader(saved([compared({ targetPeriod: "2026-10" })])).read(request, catalog);
  assert.deepEqual(noTarget.regions[0].summaryCounts, { total: 0, compared: 0, pending: 0, excluded: 0 });
  assert.equal(noTarget.regions[0].reasonCode, "NO_TARGET_MONTH_FORECAST"); assert.equal(noTarget.status, "missing");
});

test("future evaluations, wrong region, obsolete evaluation scope and invalid storage version never become report facts", async () => {
  for (const [overrides, code] of [
    [{ generatedAt: "2026-10-16T02:00:00Z" }, "EVALUATION_AFTER_AS_OF"],
    [{ evaluatedThrough: "2026-10-16T02:00:00Z" }, "EVALUATION_AFTER_AS_OF"],
    [{ scope: { regionKey: REGION, month: "2026-09", months: 13 } }, "INVALID_SAVED_EVALUATION"],
    [{ scope: { regionKey: "kr_other", month: "2026-10", months: 13 } }, "INVALID_SAVED_EVALUATION"],
    [{ calculationVersion: "unknown" }, "INVALID_SAVED_EVALUATION"]]) {
    const result = await reader(saved([compared()], overrides)).read(request, catalog);
    assert.equal(result.regions[0].reasonCode, code); assert.equal(result.regions[0].summaryCounts, null); assert.deepEqual(result.regions[0].rows, []);
  }
});

test("creation timestamp is explicit and KST rollover controls eligible saved evaluation scope", async () => {
  const asOfAt = "2026-10-15T15:00:00.000Z", f = reader(saved([], { generatedAt: asOfAt, evaluatedThrough: asOfAt }));
  assert.equal((await f.read(request, catalog, { asOfAt })).asOfAt, asOfAt);
  await assert.rejects(f.read(request, catalog, { asOfAt: "2026-02-30T00:00:00Z" }), /creation timestamp/);
  await assert.rejects(f.read(request, catalog, { asOfAt: "2026-10-17T00:00:00Z" }), /creation timestamp/);
  const november = "2026-10-31T15:00:00Z", novemberSaved = saved([], { scope: { regionKey: REGION, month: "2026-11", months: 13 }, generatedAt: november, evaluatedThrough: november });
  const result = await reader(novemberSaved, { now: () => november }).read(request, catalog);
  assert.equal(result.regions[0].reasonCode, "NO_TARGET_MONTH_FORECAST");
});

test("read errors are safe missing evidence, cache-only contract violations propagate, no secret detail leaks", async () => {
  const failure = await reader(() => { throw new Error("test-private-key-value"); }).read(request, catalog);
  assert.equal(failure.regions[0].reasonCode, "EVALUATION_READ_FAILED"); assert.equal(failure.regions[0].summaryCounts, null);
  assert.doesNotMatch(JSON.stringify(failure), /test-private-key-value/);
  const network = reader(saved([], { networkAttempted: true }));
  await assert.rejects(network.read(request, catalog), { code: "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY" });
  const notWired = await createMonthlyReportOutlookEvaluation({ now: () => NOW })(request, catalog);
  assert.equal(notWired.regions[0].reasonCode, "EVALUATION_UNAVAILABLE");
});

test("last good saved result retains exact evaluation evidence while exposing failed latest refresh and storage warning", async () => {
  const input = saved(); input.job = { status: "failed", errorCode: "REGIONAL_SOURCE_UNAVAILABLE" }; input.storage = { errorCode: "REGIONAL_RESULT_INVALID" };
  const result = await reader(input).read(request, catalog);
  assert.equal(result.regions[0].rows[0].actualValue, 110); assert.equal(result.regions[0].source.jobStatus, "failed");
  assert.equal(result.regions[0].source.jobErrorCode, "REGIONAL_SOURCE_UNAVAILABLE"); assert.equal(result.regions[0].source.storageErrorCode, "REGIONAL_RESULT_INVALID");
  assert.match(result.warnings.join(" "), /마지막 정상 저장본/);
});

test("keyword uses only supplied scoped companies' actual regions, deduplicates regions and never infers region from keyword text", async () => {
  const other = "kr_admin_4413000000", scoped = { companies: [{ companyId: "cmp_a", regionKey: REGION }, { companyId: "cmp_b", regionKey: other },
    { companyId: "cmp_c", regionKey: REGION }, { companyId: "cmp_unknown", regionKey: "" }],
    regions: [...catalog.regions, { id: other, label: "충청남도 천안시", level: "local" }] };
  const f = reader(({ regionKey }) => saved([], { scope: { regionKey, month: "2026-10", months: 13 } }));
  const result = await f.read({ ...request, type: "keyword", targetId: "서울근교글램핑" }, scoped);
  assert.equal(f.calls.length, 2); assert.deepEqual(result.regions.map(region => region.regionKey).sort(), [REGION, other].sort());
  assert.ok(result.regions.every(region => region.basis === "observed_companies_actual_locations"));
  assert.equal(result.selectionCoverage.unmappedCompanyCount, 1); assert.match(result.warnings.join(" "), /관측 업체 1곳은 실제 소재지/);
  assert.match(result.warnings.join(" "), /합산하지 않습니다/); assert.doesNotMatch(JSON.stringify(f.calls), /서울근교/);
});

test("unmapped company and broad region never borrow neighbouring or local evaluations", async () => {
  const f = reader(saved());
  assert.deepEqual((await f.read({ ...request, targetId: "cmp_missing" }, catalog)).regions, []);
  const result = await f.read({ ...request, type: "region", targetId: "gyeongnam" }, { regions: [{ id: "gyeongnam", label: "경상남도", level: "broad" }] });
  assert.equal(result.regions[0].reasonCode, "REGION_LEVEL_UNSUPPORTED"); assert.deepEqual(f.calls, []);
});

test("pending and excluded reasons are preserved in Korean; invalid comparison evidence cannot introduce a numeric actual", async () => {
  const invalid = compared({ actualRef: { ...compared().actualRef, receivedAt: "2026-10-17T00:00:00Z" } });
  const excluded = compared({ status: "excluded", reasonCode: "UNSUPPORTED_FORECAST_METADATA", provider: "", forecastValue: null });
  const open = compared({ status: "pending", reasonCode: "TARGET_MONTH_OPEN", targetPeriod: "2026-10", issueMonth: "2026-10", actualValue: null,
    predictionRef: { ...compared().predictionRef, generatedAt: "2026-10-02T00:00:00Z", publishedAt: "2026-10-02T00:00:00Z", inputLatestPeriod: "2026-09" } });
  const result = await reader(saved([invalid, excluded])).read(request, catalog);
  assert.equal(result.regions[0].summaryCounts.excluded, 2); assert.equal(result.regions[0].rows[0].actualValue, null);
  assert.equal(result.regions[0].rows[1].reasonCode, "UNSUPPORTED_FORECAST_METADATA");
  const october = await reader(saved([open])).read({ ...request, month: "2026-10" }, catalog);
  assert.equal(october.status, "pending"); assert.equal(october.regions[0].rows[0].reasonLabel, "대상월이 아직 끝나지 않았습니다.");
});

test("report projection remains bounded while counts explicitly cover omitted rows and regions", async () => {
  const large = Array.from({ length: MAX_ROWS + 10 }, () => compared()), f = reader(saved(large));
  const result = await f.read(request, catalog), region = result.regions[0];
  assert.equal(region.rows.length, MAX_ROWS); assert.equal(region.truncated, true); assert.equal(region.summaryCounts.total, MAX_ROWS + 10);
  const many = { companies: Array.from({ length: MAX_REGIONS + 1 }, (_, index) => ({ companyId: `cmp_${index}`, regionKey: `region_${index}` })) };
  const readMany = reader({ snapshot: null }), all = await readMany.read({ ...request, type: "keyword" }, many);
  assert.equal(all.regions.length, MAX_REGIONS); assert.equal(readMany.calls.length, MAX_REGIONS); assert.match(all.warnings.join(" "), /일부 지역/);
  assert.deepEqual(all.selectionCoverage, { selectedRegionCount: MAX_REGIONS + 1, includedRegionCount: MAX_REGIONS, omittedRegionCount: 1, unmappedCompanyCount: 0 });
  assert.ok(JSON.stringify(all).length < 40000);
});

test("all compared included regions cannot imply complete coverage when a region or an unknown company was omitted", async () => {
  const many = { companies: Array.from({ length: MAX_REGIONS + 1 }, (_, index) => ({ companyId: `cmp_${index}`, regionKey: `region_${index}` })) };
  const f = reader(({ regionKey }) => saved([compared({ regionKey })], { scope: { regionKey, month: "2026-10", months: 13 } }));
  const limited = await f.read({ ...request, type: "keyword" }, many);
  assert.ok(limited.regions.every(region => region.status === "ready")); assert.equal(limited.status, "partial");
  const exact = await f.read({ ...request, type: "keyword" }, { companies: many.companies.slice(0, MAX_REGIONS) });
  assert.equal(exact.status, "ready"); assert.equal(exact.selectionCoverage.omittedRegionCount, 0);
  const mixed = await reader(saved()).read({ ...request, type: "keyword" }, { ...catalog, companies: [...catalog.companies, { companyId: "cmp_unknown", regionKey: "" }] });
  assert.equal(mixed.regions[0].status, "ready"); assert.equal(mixed.status, "partial"); assert.equal(mixed.selectionCoverage.unmappedCompanyCount, 1);
  assert.match(mixed.warnings.join(" "), /관측 업체 1곳은 실제 소재지가 확인되지 않아/);
});
