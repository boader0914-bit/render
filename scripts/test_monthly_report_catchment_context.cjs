"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createMonthlyReportCatchmentContext, MAX_REGIONS, MAX_ENTRY_BYTES } = require("./lib/monthly_report_catchment_context.cjs");
const { normalizeDataset, calculateCatchment, inputFingerprint, normalizeCenter } = require("./lib/regional_catchment.cjs");
const { createRegionalCatchmentService } = require("./lib/regional_catchment_store.cjs");
const { createMonthlyReportService } = require("./lib/monthly_reports.cjs");
const NOW = "2026-10-25T01:00:00.000Z", CALCULATED = "2026-10-20T01:00:00.000Z";
const ADDRESS = "합성도 합성군 시험로 10";
const center = { latitude: 36.5, longitude: 127.8, label: "합성 검수 기준점", address: ADDRESS, sourceUrl: "https://www.data.go.kr/", confirmed: true };
const request = { type: "company", targetId: "c1", month: "2026-09", cutoffDate: "2026-09-30" };
const company = (companyId = "c1", regionKey = "r1", address = ADDRESS) => ({ companyId, regionKey, regionLabel: "합성 지역", addressBasis: { status: "ready", address, basis: "saved_company_address" } });
const roster = { companies: [company()], regions: [{ id: "r1", label: "합성 지역", level: "local" }] };
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
  const companyId = options.companyId === null ? undefined : options.companyId || "c1";
  const point = { ...center, address: options.address || ADDRESS, ...(companyId === undefined ? {} : { companyId }) };
  if (options.legacy) { delete point.address; delete point.companyId; }
  const scopeCompany = options.legacy || companyId === undefined ? {} : { companyId };
  const snapshot = { ...await calculateCatchment({ regionKey, ...scopeCompany, label: "합성 지역", center: point, dataset: body, now: () => new Date(CALCULATED) }), resultId: "10000000-0000-4000-8000-000000000001" };
  return { scope: { regionKey, ...scopeCompany, label: "합성 지역" }, status: snapshot.status,
    configuration: { regionKey, ...scopeCompany, center: copy(snapshot.scope.center), datasetId: body.id, inputFingerprint: snapshot.sourceFingerprint, configuredBy: "must-not-copy" },
    datasets: [{ ...snapshot.dataset, importedBy: "must-not-copy" }], snapshot, job: { status: "completed", privateMemo: "must-not-copy" },
    storage: { errorCode: null, lastReadSource: "stored_result", networkAttempted: false } };
}
const adapter = get => createMonthlyReportCatchmentContext({ mode: "address_radius", catchmentService: { get }, now: () => new Date(NOW) });

function regionalSaved(regionKey = "r1", { missing = false, partial = false, future = false, zero = false, referenceMonth = request.month } = {}) {
  const { buildRegionalMarketSnapshot, SPECS } = require("./lib/regional_market.cjs");
  const region = { regionKey, label: "합성 지역", officialCode: "48860", level: "local", unitType: "county" };
  const scope = { regionKey, month: referenceMonth, months: 13 };
  if (missing) return buildRegionalMarketSnapshot({ region, scope, now: () => new Date(NOW) });
  const generatedAt = future ? "2026-10-25T01:00:00.001Z" : CALCULATED;
  const datasets = SPECS.map((spec, index) => {
    const period = spec.periodType === "M" ? referenceMonth : "2024";
    return { key: spec.datasetKey, periodType: spec.periodType, period, retrievedAt: CALCULATED, boundaryYear: 2025,
      rows: [{ key: spec.metricKey, unit: spec.unit, value: partial && index === 1 ? null : zero ? 0 : index + 100,
        status: partial && index === 1 ? "suppressed" : "observed" }],
      spatialContract: { version: "regional-data-contract-v1", requestedRegionKey: regionKey, officialCode: region.officialCode,
        requestedLevel: "sigungu", providedLevel: "sigungu", requestedUnitType: region.unitType, scopeKind: "administrative",
        status: "matched", evidence: "response", aggregation: "none", provider: "KOSIS", providerRegionCode: "48860",
        storedProvenance: { version: "stored-kosis-spatial-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "synthetic-proof",
          sha256: "d".repeat(64), periodType: spec.periodType, period, verifiedAt: CALCULATED,
          checks: ["safe_original_path", "original_sha256", "source_table_and_period", "metadata_region_ancestry", "raw_region_code", "metric_unit_and_period", "stored_metric_values"] } } };
  });
  return buildRegionalMarketSnapshot({ region, scope, now: () => new Date(NOW), source: { resultSha256: "e".repeat(64) },
    savedSnapshot: { schemaVersion: 1, calculationVersion: "regional-analysis-v1", contractVersion: "regional-data-contract-v1", status: "ready",
      scope, regionIdentity: region, networkAttempted: false, generatedAt, sourceFingerprint: "f".repeat(64),
      resultId: "20000000-0000-4000-8000-000000000002", groups: [{ key: "kosis", provider: "KOSIS", datasets }] } });
}
const regionalAdapter = (get, extra = {}) => createMonthlyReportCatchmentContext({ regionMarketService: { get }, now: () => new Date(NOW), ...extra });

for (const scenario of [
  { name: "a missing address cannot erase the saved administrative region", companyId: "no-address", savedRegion: "r1", preciseRegion: "", addressStatus: "missing" },
  { name: "a different precise address region cannot replace the saved administrative region", companyId: "different-address-region", savedRegion: "r1", preciseRegion: "r2", addressStatus: "ready" },
  { name: "an explicitly missing saved administrative region cannot be guessed from the precise address", companyId: "no-saved-region", savedRegion: "", preciseRegion: "r2", addressStatus: "ready" }
]) test("actual monthly service and warm cache: " + scenario.name, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-saved-region-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("monthly-saved-region-")); await fs.rm(dataDir, { recursive: true, force: true }); });
  const target = { ...company(scenario.companyId, scenario.savedRegion), regionLabel: scenario.savedRegion ? "원래 저장 소재지" : "저장 소재지 미확인",
    addressBasis: { status: scenario.addressStatus, address: scenario.addressStatus === "ready" ? ADDRESS : null,
      basis: "saved_company_address", regionKey: scenario.preciseRegion, regionLabel: scenario.preciseRegion ? "주소의 정밀 소재지" : "주소 소재지 미확인" } };
  const selected = { ...request, targetId: scenario.companyId, month: "2026-10", cutoffDate: "2026-10-22" };
  const regionalCalls = [], preciseCalls = [], incomingRosters = []; let sourceReads = 0;
  const precise = scenario.addressStatus === "ready" ? await saved(scenario.preciseRegion, { companyId: scenario.companyId }) : null;
  const readCatchmentContext = regionalAdapter(async input => { regionalCalls.push(input); return regionalSaved(input.regionKey); }, {
    catchmentService: { get: async input => { preciseCalls.push(input); assert.ok(precise, "no precise read is allowed without a confirmed address"); return precise; } } });
  const service = createMonthlyReportService({ dataDir, now: () => new Date(NOW), calculationVersion: "monthly-saved-region-regression-v1",
    readSourceRevision: async () => "synthetic-stable-region-source", loadSources: async () => { sourceReads++;
      return { companies: [copy(target)], observations: [], runs: [], regions: [
        { id: "r1", label: "저장 행정지역", level: "local" }, { id: "r2", label: "주소 정밀지역", level: "local" }] }; },
    readCatchmentContext: async (input, scope, options) => { incomingRosters.push(copy(scope)); return readCatchmentContext(input, scope, options); } });
  const first = await service.preview(selected), warm = await service.preview(selected);
  assert.equal(sourceReads, 2, "the second preview must exercise the materialized current/previous-month cache");
  for (const preview of [first, warm]) {
    const context = preview.context.catchment;
    assert.equal(context.reportMonth, "2026-10"); assert.equal(context.referenceMonth, "2026-09");
    assert.equal(context.entries.length, scenario.savedRegion ? 1 : 0);
    if (scenario.savedRegion) { assert.equal(context.status, "ready"); assert.equal(context.entries[0].regionKey, scenario.savedRegion);
      assert.equal(context.entries[0].regionLabel, "저장 행정지역"); assert.equal(context.entries[0].regionSnapshot.metrics[0].value, 100); }
    else { assert.equal(context.status, "missing"); assert.equal(context.selectionCoverage.unmappedCompanyCount, 1); }
    assert.equal(context.preciseEntries.length, precise ? 1 : 0);
    if (precise) { assert.equal(context.preciseEntries[0].regionKey, scenario.preciseRegion);
      assert.deepEqual(context.preciseEntries[0].snapshot, precise.snapshot, "the earlier address binding and actual saved radius result stay unchanged"); }
  }
  assert.deepEqual(regionalCalls, scenario.savedRegion ? Array.from({ length: 2 }, () => ({ regionKey: scenario.savedRegion, month: "2026-09", months: 13 })) : []);
  assert.deepEqual(preciseCalls, precise ? Array.from({ length: 2 }, () => ({ regionKey: scenario.preciseRegion, companyId: scenario.companyId, address: ADDRESS })) : []);
  assert.ok(incomingRosters.every(scope => scope.companies[0].savedAdministrativeRegionKey === scenario.savedRegion
    && scope.companies[0].savedAdministrativeRegionLabel === target.regionLabel
    && scope.companies[0].regionKey === scenario.preciseRegion), "both locations travel independently through fresh and warm service rosters");
  const draft = await service.create({ ...selected, previewToken: first.previewToken });
  const review = await service.update(draft.id, { revision: draft.revision, status: "review" });
  const issued = await service.publish(draft.id, { revision: review.revision, acknowledgeQuality: true });
  assert.deepEqual(issued.snapshot.context.catchment, first.context.catchment, "the approved two-location evidence is frozen in the issued snapshot");
});

test("new monthly default uses saved administrative region without requiring a precise address", async () => {
  const target = company(); target.addressBasis = { status: "missing", address: null, basis: "saved_company_address" };
  const value = regionalSaved(), calls = [], before = JSON.stringify(value);
  const result = await regionalAdapter(async input => { calls.push(input); return value; })(request, { companies: [target], regions: roster.regions });
  assert.equal(result.schemaVersion, 2); assert.equal(result.defaultMode, "administrative_region"); assert.equal(result.status, "ready");
  assert.deepEqual(calls, [{ regionKey: "r1", month: request.month, months: 13 }]);
  assert.equal(result.entries[0].mode, "administrative_region"); assert.equal(result.entries[0].originKind, "administrative_region");
  assert.deepEqual(result.entries[0].companyIds, ["c1"]); assert.equal(result.entries[0].selectionBasis, "company_saved_region");
  assert.equal(result.entries[0].regionSnapshot.metrics[0].value, 100); assert.equal(result.preciseEntries.length, 0);
  assert.equal(result.entries[0].regionSnapshot.visitorOrigins.value, null); assert.equal(result.networkAttempted, false);
  assert.equal(JSON.stringify(value), before); value.metrics[0].value = 999;
  assert.equal(result.entries[0].regionSnapshot.metrics[0].value, 100, "the report freezes a detached source DTO");
  assert.doesNotMatch(JSON.stringify(result.entries[0]), /"latitude"|"longitude"|"rings"|"center"/);
});

test("current and future stay months bind latest closed regional reference without shifting lodging month or cutoff", async () => {
  const value = regionalSaved(), target = company(); delete target.addressBasis;
  for (const reportMonth of ["2026-10", "2026-11"]) {
    const calls = [], selected = { ...request, month: reportMonth, cutoffDate: "2026-10-22" };
    const result = await regionalAdapter(async input => { calls.push(input); return value; })(selected, { companies: [target] });
    assert.equal(result.reportMonth, reportMonth); assert.equal(result.cutoffDate, "2026-10-22"); assert.equal(result.asOfAt, NOW);
    assert.equal(result.referenceMonth, "2026-09"); assert.equal(result.entries[0].referenceMonth, "2026-09");
    assert.equal(result.referenceBasis, "min_report_month_latest_completed_month_at_creation_kst");
    assert.deepEqual(calls, [{ regionKey: "r1", month: "2026-09", months: 13 }]);
    assert.deepEqual(result.entries[0].regionSnapshot.metrics, value.metrics, "all six saved values and source periods remain unchanged");
  }
  const past = { ...request, month: "2026-05", cutoffDate: "2026-05-31" }, calls = [];
  const result = await regionalAdapter(async input => { calls.push(input); return regionalSaved("r1", { referenceMonth: "2026-05" }); })(past, { companies: [target] });
  assert.equal(result.referenceMonth, "2026-05"); assert.equal(result.reportMonth, "2026-05");
  assert.deepEqual(calls, [{ regionKey: "r1", month: "2026-05", months: 13 }]);
});

test("regional reference closes at the Korea month boundary, including a year rollover", async () => {
  const target = company(); delete target.addressBasis;
  const cases = [
    ["2026-09-30T14:59:59.999Z", "2026-10", "2026-09-30", "2026-08"],
    ["2026-09-30T15:00:00.000Z", "2026-10", "2026-10-01", "2026-09"],
    ["2026-12-31T15:00:00.000Z", "2027-01", "2027-01-01", "2026-12"]
  ];
  for (const [asOfAt, month, cutoffDate, referenceMonth] of cases) {
    const calls = [], read = createMonthlyReportCatchmentContext({ now: () => new Date(asOfAt), regionMarketService: {
      get: async input => { calls.push(input); return regionalSaved("r1", { missing: true, referenceMonth }); } } });
    const result = await read({ ...request, month, cutoffDate }, { companies: [target] }, { asOfAt });
    assert.equal(result.referenceMonth, referenceMonth); assert.equal(result.entries[0].referenceMonth, referenceMonth);
    assert.equal(result.reportMonth, month); assert.equal(result.cutoffDate, cutoffDate); assert.equal(result.status, "missing");
    assert.deepEqual(calls, [{ regionKey: "r1", month: referenceMonth, months: 13 }]);
  }
});

test("keyword regional defaults deduplicate one stored region while preserving separately bound address results", async () => {
  const companies = [company("a"), company("b", "r1", "합성도 합성군 시험로 20"), company("a")], calls = [], addressCalls = [];
  const read = regionalAdapter(async input => { calls.push(input); return regionalSaved(input.regionKey); }, {
    catchmentService: { get: async input => { addressCalls.push(input); return saved(input.regionKey, input); } } });
  const result = await read({ ...request, type: "keyword" }, { companies });
  assert.equal(calls.length, 1); assert.equal(addressCalls.length, 2); assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0].companyIds, ["a", "b"]); assert.equal(result.preciseEntries.length, 2);
  assert.ok(result.preciseEntries.every(entry => entry.mode === "address_radius" && entry.snapshot.scope.companyId === entry.companyId));
  assert.notEqual(result.preciseEntries[0].snapshot.sourceFingerprint, result.preciseEntries[1].snapshot.sourceFingerprint);
  assert.equal(result.entries[0].regionSnapshot.metrics[0].value, 100, "one regional reference never becomes a company total");
});

test("regional default keeps public zero, partial suppression and missing values distinct", async () => {
  const target = company(); delete target.addressBasis;
  for (const options of [{ zero: true }, { partial: true }, { missing: true }]) {
    const result = await regionalAdapter(async () => regionalSaved("r1", options))(request, { companies: [target] });
    const metric = result.entries[0].regionSnapshot.metrics;
    assert.equal(result.status, options.zero ? "ready" : options.partial ? "partial" : "missing");
    if (options.zero) assert.ok(metric.every(value => value.value === 0 && value.status === "observed"));
    if (options.partial) { assert.equal(metric[1].value, null); assert.equal(metric[1].status, "suppressed"); }
    if (options.missing) assert.ok(metric.every(value => value.value === null));
    assert.equal(result.entries[0].regionSnapshot.visitorOrigins.value, null);
  }
});

test("unmapped or conflicting company regions and broad regions are never guessed from keyword text", async () => {
  let calls = 0;
  const read = regionalAdapter(async input => { calls++; return regionalSaved(input.regionKey); });
  const companies = [company("same", "r1"), company("same", "r2"), company("unmapped", "")];
  const empty = await read({ ...request, type: "keyword", targetId: "경남글램핑" }, { companies });
  assert.equal(calls, 0); assert.equal(empty.entries.length, 0); assert.equal(empty.selectionCoverage.unmappedCompanyCount, 2);
  const invalidTarget = await read({ ...request, type: "region", targetId: "invalid/region" }, roster);
  assert.equal(calls, 0); assert.equal(invalidTarget.entries.length, 0, "an invalid selected region never falls back to a company's region");
  const broad = await read({ ...request, type: "region", targetId: "r1" }, { regions: [{ id: "r1", level: "province" }] });
  assert.equal(calls, 0); assert.equal(broad.entries[0].regionSnapshot, null); assert.equal(broad.entries[0].reasonCode, "CATCHMENT_REGION_UNSUPPORTED");
});

test("regional selection is bounded by unique region count instead of the number of companies", async () => {
  const calls = [], companies = Array.from({ length: MAX_REGIONS + 2 }, (_, index) => company(`c${index}`, `r${index}`));
  const result = await regionalAdapter(async input => { calls.push(input); return regionalSaved(input.regionKey); })({ ...request, type: "keyword" }, { companies });
  assert.equal(calls.length, MAX_REGIONS); assert.equal(result.entries.length, MAX_REGIONS); assert.equal(result.status, "partial");
  assert.equal(result.selectionCoverage.selectedRegionCount, MAX_REGIONS + 2); assert.equal(result.selectionCoverage.omittedRegionCount, 2);
});

test("regional adapter rejects wrong binding, future evidence and network work without altering precise saved evidence", async () => {
  const target = company(); delete target.addressBasis;
  for (const value of [regionalSaved("r2"), regionalSaved("r1", { future: true }), { ...regionalSaved(), fingerprint: "a".repeat(64) }]) {
    const result = await regionalAdapter(async () => value)(request, { companies: [target] });
    assert.equal(result.entries[0].regionSnapshot, null); assert.equal(result.status, "unavailable");
  }
  const futureMetric = regionalSaved(); futureMetric.metrics[0].source.retrievedAt = "2026-10-25T01:00:00.001Z";
  const result = await regionalAdapter(async () => futureMetric)(request, { companies: [target] }); assert.equal(result.entries[0].regionSnapshot, null);
  await assert.rejects(regionalAdapter(async () => ({ ...regionalSaved(), networkAttempted: true }))(request, { companies: [target] }), { code: "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY" });
  const failed = await regionalAdapter(async () => { throw Error("PRIVATE_PROVIDER_SECRET"); })(request, { companies: [target] });
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_PROVIDER_SECRET/);
});

test("saved annual reference keeps provenance, exact nine metrics, cutoff and a detached bounded snapshot", async () => {
  const value = await saved(), calls = [];
  const result = await adapter(async input => { calls.push(input); return value; })(request, roster, { asOfAt: NOW });
  assert.deepEqual(calls, [{ regionKey: "r1", companyId: "c1", address: ADDRESS }]); assert.equal(result.status, "ready"); assert.equal(result.networkAttempted, false);
  assert.equal(result.reportMonth, "2026-09"); assert.equal(result.cutoffDate, "2026-09-30"); assert.equal(result.asOfAt, NOW);
  const entry = result.entries[0]; assert.equal(entry.selectionBasis, "company_actual_address"); assert.equal(entry.companyId, "c1"); assert.deepEqual(entry.snapshot, value.snapshot);
  assert.equal(entry.snapshot.scope.center.address, ADDRESS); assert.equal(entry.snapshot.scope.center.kind, "address_reference_point");
  assert.deepEqual(result.selectionCoverage, { selectedRegionCount: 1, includedRegionCount: 1, omittedRegionCount: 0, selectedAddressCount: 1, includedAddressCount: 1, omittedAddressCount: 0, unmappedCompanyCount: 0 });
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

test("keyword scopes bound company-address reads while retaining true unique-region coverage", async () => {
  const calls = [], companies = Array.from({ length: MAX_REGIONS + 2 }, (_, i) => company(`c${String(i).padStart(2, "0")}`, "r1", `합성도 합성군 시험로 ${10 + i}`));
  companies.push(company("unmapped", ""), copy(companies[0]));
  const result = await adapter(async input => { calls.push(input); return saved(input.regionKey, { companyId: input.companyId, address: input.address }); })({ ...request, type: "keyword", targetId: "검색어는지역이아님" }, { companies });
  assert.equal(calls.length, MAX_REGIONS); assert.equal(new Set(calls.map(row => row.companyId)).size, MAX_REGIONS); assert.equal(result.status, "partial");
  assert.ok(calls.every(row => row.regionKey === "r1" && row.address));
  assert.deepEqual(result.selectionCoverage, { selectedRegionCount: 1, includedRegionCount: 1, omittedRegionCount: 0, selectedAddressCount: MAX_REGIONS + 2, includedAddressCount: MAX_REGIONS, omittedAddressCount: 2, unmappedCompanyCount: 1 });
  assert.ok(result.entries.every(e => e.selectionBasis === "observed_companies_actual_addresses"));
  const empty = await adapter(async () => { throw Error("must not infer keyword region"); })({ ...request, type: "keyword", targetId: "경남글램핑" }, { companies: [{ companyId: "x" }] });
  assert.equal(empty.entries.length, 0); assert.equal(empty.status, "missing"); assert.equal(empty.selectionCoverage.unmappedCompanyCount, 1);
});

test("bounded address selection reports distinct omitted regions separately from omitted addresses", async () => {
  const companies = Array.from({ length: MAX_REGIONS + 2 }, (_, i) => company(`c${String(i).padStart(2, "0")}`, `r${String(i).padStart(2, "0")}`));
  const result = await adapter(async input => saved(input.regionKey, input))({ ...request, type: "keyword" }, { companies });
  assert.equal(result.entries.length, MAX_REGIONS); assert.equal(result.status, "partial");
  assert.deepEqual(result.selectionCoverage, { selectedRegionCount: MAX_REGIONS + 2, includedRegionCount: MAX_REGIONS, omittedRegionCount: 2,
    selectedAddressCount: MAX_REGIONS + 2, includedAddressCount: MAX_REGIONS, omittedAddressCount: 2, unmappedCompanyCount: 0 });
});

test("equivalent saved address spelling is normalized before the exact company read", async () => {
  const calls = [], target = company("c1", "r1", "  합성도　합성군   시험로 １０  ");
  const result = await adapter(async input => { calls.push(input); return saved(); })(request, { companies: [target] });
  assert.equal(result.status, "ready"); assert.deepEqual(calls, [{ regionKey: "r1", companyId: "c1", address: ADDRESS }]);
});

test("two companies in one region keep separate company-address evidence and repeated company IDs are read once", async () => {
  const companies = [company("a", "r1", ADDRESS), company("b", "r1", "합성도 합성군 시험로 20"), company("a", "r1", ADDRESS)], calls = [];
  const result = await adapter(async input => { calls.push(input); return saved(input.regionKey, input); })({ ...request, type: "keyword" }, { companies });
  assert.equal(result.status, "ready"); assert.equal(result.entries.length, 2); assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls.map(row => row.companyId)), new Set(["a", "b"]));
  assert.equal(result.selectionCoverage.selectedRegionCount, 1); assert.equal(result.selectionCoverage.selectedAddressCount, 2);
  for (const entry of result.entries) {
    const selected = companies.find(row => row.companyId === entry.companyId);
    assert.equal(entry.snapshot.scope.companyId, entry.companyId); assert.equal(entry.snapshot.scope.center.companyId, entry.companyId);
    assert.equal(entry.snapshot.scope.center.address, selected.addressBasis.address);
  }
  assert.notEqual(result.entries[0].snapshot.sourceFingerprint, result.entries[1].snapshot.sourceFingerprint);
});

test("missing or ambiguous saved addresses never fall back to an available regional reference point", async () => {
  let calls = 0;
  for (const addressBasis of [undefined, { status: "missing", address: null, basis: "saved_company_address" }, { status: "ambiguous", address: null, basis: "saved_company_address" }]) {
    const target = company(); target.addressBasis = addressBasis;
    const result = await adapter(async () => { calls++; return saved("r1", { companyId: null }); })(request, { companies: [target], regions: roster.regions });
    assert.equal(calls, 0); assert.equal(result.entries.length, 1); assert.equal(result.entries[0].snapshot, null); assert.notEqual(result.status, "ready");
    assert.equal(result.entries[0].reasonCode, addressBasis?.status === "ambiguous" ? "CATCHMENT_ADDRESS_AMBIGUOUS" : "CATCHMENT_ADDRESS_REQUIRED");
  }
});

test("regional reports read only their selected region and require address-bound saved evidence", async () => {
  const calls = [], value = await saved("r1", { companyId: null });
  const result = await adapter(async input => { calls.push(input); return value; })({ ...request, type: "region", targetId: "r1" }, roster);
  assert.deepEqual(calls, [{ regionKey: "r1" }]); assert.equal(result.status, "ready"); assert.equal(result.entries[0].selectionBasis, "selected_region_address");
  const legacy = await adapter(async () => saved("r1", { companyId: null, legacy: true }))({ ...request, type: "region", targetId: "r1" }, roster);
  assert.equal(legacy.entries[0].snapshot, null); assert.equal(legacy.status, "unavailable");
});

test("company scope excludes other owned companies; broad or inactive region never calls the saved reader", async () => {
  const calls = [], get = async input => { calls.push(input.regionKey); return saved(input.regionKey); };
  await adapter(get)(request, { companies: [...roster.companies, company("other", "r2")] });
  assert.deepEqual(calls, ["r1"]);
  for (const region of [{ id: "r1", level: "province" }, { id: "r1", level: "local", active: false }, { id: "r1", level: "local", unitType: "general_district" }]) {
    const result = await adapter(async () => { throw Error("must not read"); })({ ...request, type: "region", targetId: "r1" }, { regions: [region] });
    assert.equal(result.entries[0].reasonCode, "CATCHMENT_REGION_UNSUPPORTED"); assert.equal(result.entries[0].snapshot, null);
  }
});

test("unconfigured, missing, failed, unavailable and unsafe error strings never become zero or ready", async () => {
  for (const [status, code] of [["unqueried", "CATCHMENT_CENTER_NOT_CONFIGURED"], ["missing", "NO_SAVED_CATCHMENT"], ["failed", "CATCHMENT_CALCULATION_FAILED"]]) {
    const result = await adapter(async () => ({ scope: { regionKey: "r1", companyId: "c1" }, status, snapshot: null, storage: { networkAttempted: false } }))(request, roster);
    assert.equal(result.entries[0].status, status); assert.equal(result.entries[0].reasonCode, code); assert.equal(result.entries[0].snapshot, null);
  }
  const result = await createMonthlyReportCatchmentContext({ mode: "address_radius", now: () => new Date(NOW) })(request, roster);
  assert.equal(result.status, "unavailable"); assert.equal(result.entries[0].reasonCode, "CATCHMENT_SERVICE_UNAVAILABLE");
  const failed = await adapter(async () => { throw Error("https://secret.test/?token=private"); })(request, roster);
  assert.equal(failed.entries[0].reasonCode, "CATCHMENT_READ_FAILED"); assert.doesNotMatch(JSON.stringify(failed), /secret|token|private/);
});

test("wrong region, center, version, input identity, metrics, excessive metadata and future sources are unavailable", async () => {
  const mutations = [v => { v.scope.regionKey = "r2"; }, v => { v.configuration.center.latitude = 35; },
    v => { v.scope.companyId = "another"; }, v => { v.configuration.companyId = "another"; },
    v => { v.snapshot.scope.companyId = "another"; }, v => { v.snapshot.scope.center.companyId = "another"; },
    v => { v.configuration.center.address = "합성도 합성군 시험로 99"; }, v => { v.snapshot.scope.center.addressFingerprint = "c".repeat(64); },
    v => { v.snapshot.calculationVersion = "future-version"; }, v => { v.configuration.inputFingerprint = "c".repeat(64); },
    v => { v.configuration.datasetId = "different"; }, v => { v.snapshot.rings[2].metrics.population.value++; },
    v => { v.snapshot.dataset.sourceYear = 2028; }, v => { v.snapshot.notes = Array.from({ length: 13 }, () => "x"); },
    v => { v.snapshot.method.gridBoundaryAccuracy = "x".repeat(3000); }, v => { delete v.storage.networkAttempted; }];
  for (const mutate of mutations) { const value = await saved(); mutate(value); const result = await adapter(async () => value)(request, roster);
    assert.equal(result.status, "unavailable"); assert.equal(result.entries[0].snapshot, null); }
});

test("an internally valid saved result for an old or another company address is rejected against the current roster", async () => {
  for (const options of [{ address: "합성도 합성군 이전로 99" }, { companyId: "another" }, { companyId: null, legacy: true }]) {
    const value = await saved("r1", options), result = await adapter(async () => value)(request, roster);
    assert.equal(result.entries[0].snapshot, null); assert.equal(result.status, "unavailable");
  }
  const value = await saved(), changed = normalizeCenter({ ...center, companyId: "c1", address: "합성도 합성군 이전로 99" });
  value.snapshot.scope.center = changed; value.configuration.center = copy(changed);
  value.snapshot.sourceFingerprint = inputFingerprint(changed, value.snapshot.dataset); value.configuration.inputFingerprint = value.snapshot.sourceFingerprint;
  const result = await adapter(async () => value)(request, roster);
  assert.equal(result.entries[0].snapshot, null); assert.equal(result.status, "unavailable");
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
  const resolveCompanyAddress = async companyId => companyId === "c1" ? { companyId, regionKey: "r1", address: ADDRESS } : null;
  const service = createRegionalCatchmentService({ dataDir, resolveRegion, resolveCompanyAddress, now: () => new Date(CALCULATED) });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const source = dataset(); await service.importDataset(source, "test-only"); await service.configure({ regionKey: "r1", companyId: "c1", center, datasetId: source.id }, "test-only");
  await service.request({ regionKey: "r1", companyId: "c1" }); await service.waitForIdle(); await service.close();
  const folder = path.join(dataDir, "regional_catchment"), statePath = path.join(folder, "state.json"), before = await fs.readFile(statePath);
  await fs.rename(path.join(folder, "datasets"), path.join(dataDir, "held-source"));
  let calculations = 0;
  const restarted = createRegionalCatchmentService({ dataDir, resolveRegion, resolveCompanyAddress, calculate: async () => { calculations++; throw Error("must not calculate"); } });
  t.after(() => restarted.close());
  const read = createMonthlyReportCatchmentContext({ mode: "address_radius", catchmentService: restarted, now: () => new Date(NOW) });
  const first = await read(request, roster), second = await read(request, roster);
  assert.equal(first.status, "ready"); assert.equal(first.entries[0].snapshot.resultId, second.entries[0].snapshot.resultId); assert.equal(calculations, 0);
  assert.deepEqual(await fs.readFile(statePath), before); assert.doesNotMatch(JSON.stringify(first), /"cells"/);
});
