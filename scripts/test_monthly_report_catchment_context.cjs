"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createMonthlyReportCatchmentContext, MAX_REGIONS, MAX_ENTRY_BYTES } = require("./lib/monthly_report_catchment_context.cjs");
const { normalizeDataset, calculateCatchment } = require("./lib/regional_catchment.cjs");
const { createRegionalCatchmentService } = require("./lib/regional_catchment_store.cjs");
const NOW = "2026-10-25T01:00:00.000Z", CALCULATED = "2026-10-20T01:00:00.000Z";
const center = { latitude: 36.5, longitude: 127.8, label: "합성 검수 기준점", sourceUrl: "https://www.data.go.kr/", confirmed: true };
const request = { type: "company", targetId: "c1", month: "2026-09", cutoffDate: "2026-09-30" };
const roster = { companies: [{ companyId: "c1", regionKey: "r1", regionLabel: "합성 지역" }], regions: [{ id: "r1", label: "합성 지역", level: "local" }] };
const copy = x => JSON.parse(JSON.stringify(x));
function dataset({ partial = false, publicZero = false } = {}) {
  const metric = value => ({ status: "observed_public", value });
  return { id: "synthetic-reference", provider: publicZero ? "국토지리정보원" : "SGIS", sourceUrl: publicZero ? "https://ngii.go.kr/" : "https://sgis.mods.go.kr/view/pss/openDataIntrcn",
    sourceYear: 2024, boundaryYear: 2025, crs: "EPSG:4326", gridSizeM: 1000, sourceSha256: "a".repeat(64), boundarySha256: "b".repeat(64),
    industryClassification: "TEST-KSIC-11:all", coverageBBox: [125, 33, 131, 39], completeFrame: true, units: { population: "명", establishments: "개", workers: "명" },
    cells: [36.5, 37.2].map((latitude, i) => ({ id: `가다${i}`, latitude, longitude: 127.8,
      population: partial && !i ? { status: "protected_zero", value: 0 } : metric(publicZero ? 0 : 10 + i), establishments: metric(publicZero ? 0 : 1 + i), workers: metric(publicZero ? 0 : 3 + i) })) };
}
async function saved(regionKey = "r1", options = {}) {
  const body = normalizeDataset(dataset(options));
  const snapshot = { ...await calculateCatchment({ regionKey, label: "합성 지역", center, dataset: body, now: () => new Date(CALCULATED) }), resultId: "10000000-0000-4000-8000-000000000001" };
  return { scope: { regionKey, label: "합성 지역" }, status: snapshot.status,
    configuration: { regionKey, center: copy(snapshot.scope.center), datasetId: body.id, inputFingerprint: snapshot.sourceFingerprint, configuredBy: "must-not-copy" },
    datasets: [{ ...snapshot.dataset, importedBy: "must-not-copy" }], snapshot, job: { status: "completed", privateMemo: "must-not-copy" },
    storage: { errorCode: null, lastReadSource: "stored_result", networkAttempted: false } };
}
const adapter = get => createMonthlyReportCatchmentContext({ catchmentService: { get }, now: () => new Date(NOW) });

test("saved annual reference keeps provenance, exact nine metrics, cutoff and a detached bounded snapshot", async () => {
  const value = await saved(), calls = [];
  const result = await adapter(async input => { calls.push(input); return value; })(request, roster, { asOfAt: NOW });
  assert.deepEqual(calls, [{ regionKey: "r1" }]); assert.equal(result.status, "ready"); assert.equal(result.networkAttempted, false);
  assert.equal(result.reportMonth, "2026-09"); assert.equal(result.cutoffDate, "2026-09-30"); assert.equal(result.asOfAt, NOW);
  const entry = result.entries[0]; assert.equal(entry.selectionBasis, "company_actual_location"); assert.deepEqual(entry.snapshot, value.snapshot);
  assert.equal(entry.snapshot.dataset.sourceYear, 2024); assert.equal(entry.snapshot.dataset.boundaryYear, 2025);
  assert.equal(entry.snapshot.rings.length, 3); assert.equal(entry.snapshot.rings[2].metrics.population.value, 21);
  assert.ok(Buffer.byteLength(JSON.stringify(entry.snapshot)) <= MAX_ENTRY_BYTES);
  assert.doesNotMatch(JSON.stringify(result), /must-not-copy|"cells"|configuredBy|importedBy|privateMemo/);
  value.snapshot.rings[0].metrics.population.value = 999;
  assert.equal(entry.snapshot.rings[0].metrics.population.value, 10, "source mutations cannot change approved report evidence");
  entry.snapshot.scope.center.label = "report mutation"; assert.equal(value.snapshot.scope.center.label, center.label);
});

test("protected zero and missing coverage retain null totals while legitimate public zero stays zero", async () => {
  const partial = await saved("r1", { partial: true });
  const result = await adapter(async () => partial)(request, roster);
  const metric = result.entries[0].snapshot.rings[2].metrics.population;
  assert.equal(result.status, "partial"); assert.equal(metric.value, null); assert.equal(metric.publishedSum, 11); assert.equal(metric.protectedZeroCells, 1);
  const zero = await saved("r1", { publicZero: true });
  const observed = await adapter(async () => zero)(request, roster);
  assert.equal(observed.status, "ready"); assert.equal(observed.entries[0].snapshot.rings[2].metrics.population.value, 0);
  assert.equal(observed.entries[0].snapshot.rings[2].metrics.population.publishedSum, 0);
});

test("keyword scopes use actual selected company locations, de-duplicate regions, and bound reads", async () => {
  const calls = [], companies = Array.from({ length: MAX_REGIONS + 2 }, (_, i) => ({ companyId: `c${i}`, regionKey: `r${String(i).padStart(2, "0")}` }));
  companies.push({ companyId: "unmapped", regionKey: "" }, { companyId: "same", regionKey: "r00" });
  const result = await adapter(async ({ regionKey }) => { calls.push(regionKey); return saved(regionKey); })({ ...request, type: "keyword", targetId: "검색어는지역이아님" }, { companies });
  assert.equal(calls.length, MAX_REGIONS); assert.equal(new Set(calls).size, MAX_REGIONS); assert.equal(result.status, "partial");
  assert.deepEqual(result.selectionCoverage, { selectedRegionCount: MAX_REGIONS + 2, includedRegionCount: MAX_REGIONS, omittedRegionCount: 2, unmappedCompanyCount: 1 });
  assert.ok(result.entries.every(e => e.selectionBasis === "observed_companies_actual_locations"));
  const empty = await adapter(async () => { throw Error("must not infer keyword region"); })({ ...request, type: "keyword", targetId: "경남글램핑" }, { companies: [{ companyId: "x" }] });
  assert.equal(empty.entries.length, 0); assert.equal(empty.status, "missing"); assert.equal(empty.selectionCoverage.unmappedCompanyCount, 1);
});

test("company scope excludes other owned companies; broad or inactive region never calls the saved reader", async () => {
  const calls = [], get = async input => { calls.push(input.regionKey); return saved(input.regionKey); };
  await adapter(get)(request, { companies: [...roster.companies, { companyId: "other", regionKey: "r2" }] });
  assert.deepEqual(calls, ["r1"]);
  for (const region of [{ id: "r1", level: "province" }, { id: "r1", level: "local", active: false }, { id: "r1", level: "local", unitType: "general_district" }]) {
    const result = await adapter(async () => { throw Error("must not read"); })({ ...request, type: "region", targetId: "r1" }, { regions: [region] });
    assert.equal(result.entries[0].reasonCode, "CATCHMENT_REGION_UNSUPPORTED"); assert.equal(result.entries[0].snapshot, null);
  }
});

test("unconfigured, missing, failed, unavailable and unsafe error strings never become zero or ready", async () => {
  for (const [status, code] of [["unqueried", "CATCHMENT_CENTER_NOT_CONFIGURED"], ["missing", "NO_SAVED_CATCHMENT"], ["failed", "CATCHMENT_CALCULATION_FAILED"]]) {
    const result = await adapter(async () => ({ scope: { regionKey: "r1" }, status, snapshot: null, storage: { networkAttempted: false } }))(request, roster);
    assert.equal(result.entries[0].status, status); assert.equal(result.entries[0].reasonCode, code); assert.equal(result.entries[0].snapshot, null);
  }
  const result = await createMonthlyReportCatchmentContext({ now: () => new Date(NOW) })(request, roster);
  assert.equal(result.status, "unavailable"); assert.equal(result.entries[0].reasonCode, "CATCHMENT_SERVICE_UNAVAILABLE");
  const failed = await adapter(async () => { throw Error("https://secret.test/?token=private"); })(request, roster);
  assert.equal(failed.entries[0].reasonCode, "CATCHMENT_READ_FAILED"); assert.doesNotMatch(JSON.stringify(failed), /secret|token|private/);
});

test("wrong region, center, version, input identity, metrics, excessive metadata and future sources are unavailable", async () => {
  const mutations = [v => { v.scope.regionKey = "r2"; }, v => { v.configuration.center.latitude = 35; },
    v => { v.snapshot.calculationVersion = "future-version"; }, v => { v.configuration.inputFingerprint = "c".repeat(64); },
    v => { v.configuration.datasetId = "different"; }, v => { v.snapshot.rings[2].metrics.population.value++; },
    v => { v.snapshot.dataset.sourceYear = 2028; }, v => { v.snapshot.notes = Array.from({ length: 13 }, () => "x"); },
    v => { v.snapshot.method.gridBoundaryAccuracy = "x".repeat(3000); }, v => { delete v.storage.networkAttempted; }];
  for (const mutate of mutations) { const value = await saved(); mutate(value); const result = await adapter(async () => value)(request, roster);
    assert.equal(result.status, "unavailable"); assert.equal(result.entries[0].snapshot, null); }
});

test("creation timestamp is independent from observation cutoff, rejects future results, preserves stale saved evidence", async () => {
  const future = await saved(); future.snapshot.calculatedAt = "2026-10-25T01:00:00.001Z";
  const excluded = await adapter(async () => future)(request, roster);
  assert.equal(excluded.entries[0].reasonCode, "CATCHMENT_AFTER_AS_OF"); assert.equal(excluded.entries[0].snapshot, null);
  const stale = await saved(); stale.status = "stale"; stale.storage.errorCode = "CATCHMENT_STORAGE_UNAVAILABLE"; stale.job.status = "failed";
  const result = await adapter(async () => stale)(request, roster);
  assert.equal(result.status, "partial"); assert.equal(result.entries[0].status, "stale"); assert.equal(result.entries[0].snapshot.resultId, stale.snapshot.resultId);
  assert.equal(result.entries[0].storage.jobStatus, "failed");
  await assert.rejects(adapter(async () => stale)(request, roster, { asOfAt: "2026-10-25T01:00:00.001Z" }), TypeError);
  await assert.rejects(adapter(async () => stale)({ ...request, cutoffDate: "2026-10-26" }, roster), TypeError);
});

test("network contract violations propagate rather than being hidden as missing background", async () => {
  for (const mutate of [v => { v.networkAttempted = true; }, v => { v.storage.networkAttempted = true; }, v => { v.snapshot.networkAttempted = true; }]) {
    const value = await saved(); mutate(value);
    await assert.rejects(adapter(async () => value)(request, roster), { code: "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY" });
  }
});

test("actual saved service works after its original grid is removed without calculations or file writes", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-catchment-context-"));
  const resolveRegion = async regionKey => regionKey === "r1" ? { regionKey, label: "합성 지역", level: "local", active: true } : null;
  const service = createRegionalCatchmentService({ dataDir, resolveRegion, now: () => new Date(CALCULATED) });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const source = dataset(); await service.importDataset(source, "test-only"); await service.configure({ regionKey: "r1", center, datasetId: source.id }, "test-only");
  await service.request({ regionKey: "r1" }); await service.waitForIdle(); await service.close();
  const folder = path.join(dataDir, "regional_catchment"), statePath = path.join(folder, "state.json"), before = await fs.readFile(statePath);
  await fs.rename(path.join(folder, "datasets"), path.join(dataDir, "held-source"));
  let calculations = 0;
  const restarted = createRegionalCatchmentService({ dataDir, resolveRegion, calculate: async () => { calculations++; throw Error("must not calculate"); } });
  t.after(() => restarted.close());
  const read = createMonthlyReportCatchmentContext({ catchmentService: restarted, now: () => new Date(NOW) });
  const first = await read(request, roster), second = await read(request, roster);
  assert.equal(first.status, "ready"); assert.equal(first.entries[0].snapshot.resultId, second.entries[0].snapshot.resultId); assert.equal(calculations, 0);
  assert.deepEqual(await fs.readFile(statePath), before); assert.doesNotMatch(JSON.stringify(first), /"cells"/);
});
