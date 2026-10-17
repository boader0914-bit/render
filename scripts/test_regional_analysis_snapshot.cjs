"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRegionalAnalysisSnapshotBuilder, shiftMonth } = require("./lib/regional_analysis_snapshot.cjs");
const { DEFINITIONS } = require("./lib/kosis.cjs");
const scope = { regionKey: "pocheon", label: "경기도 포천시", month: "2026-09", months: 13 };
function fixture() {
  let retrievedAt = "2026-10-01T00:00:00Z";
  const calls = [];
  const series = Array.from({ length: 25 }, (_, i) => ({ yearMonth: shiftMonth(scope.month, i - 24).replace("-", ""),
    status: i === 24 ? "missing" : "complete", averageDailyVisitors: i === 24 ? 999 : 0, visitorDays: 0,
    stayOverall: 0, spendOverall: 0, values: { service: 0, culture: 0, visitor: 0, spend: 0, international: 0 } }));
  const tourismCollector = Object.fromEntries(["collectVisitorHistory", "collectDemandStrengthHistory", "collectResourceDemandHistory", "collectDiversityHistory"].map((method, i) => [method, async input => {
    calls.push({ method, ...input });
    const rows = series.map(point => ({ ...point, collectedAt: retrievedAt }));
    return { period: { endYearMonth: input.endYearMonth }, ...(i === 0 ? { regions: [{ regionKey: input.regionKey, series: rows }] } : { region: { regionKey: input.regionKey }, series: rows }), networkAttempted: false };
  }]));
  const kosisService = { getRegion: async regionKey => ({ region: { regionKey }, datasets: DEFINITIONS.map(d => ({ key: d.key, periodType: d.periodType,
    period: d.periodType === "Y" ? "2024" : "202608", status: "ready", retrievedAt, rows: d.metrics.flatMap(m => (d.breakdowns || [null]).map(b => ({ key: b?.key || m.key, unit: m.unit, value: 0, status: "observed" }))) })) }) };
  const searchTrendService = { get: async input => { calls.push({ method: "search", ...input }); return { ...input, keyword: "포천글램핑", partialMonth: false,
    startDate: "2025-09-01", endDate: "2026-09-30", retrievedAt, series: Array.from({ length: 13 }, (_, i) => ({ period: shiftMonth(scope.month, i - 12) + "-01", status: "observed", value: 0 })) }; } };
  const options = { tourismCollector, kosisService, searchTrendService, now: () => "2026-10-15T00:00:00Z" };
  return { options, calls, setTime: value => { retrievedAt = value; } };
}
test("each tourism indicator uses latest normal month inclusive13; normal zero stays observed", async () => {
  const f = fixture(), result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope, {});
  const visitor = result.groups[0];
  assert.equal(visitor.latestPeriod, "2026-08"); assert.equal(visitor.availableMonths, 13); assert.equal(visitor.expectedMonths, 13);
  assert.equal(visitor.metrics[0].rows[0].period, "2025-08"); assert.equal(visitor.metrics[0].rows.at(-1).value, 0);
  assert.equal(visitor.metrics[0].rows.at(-1).status, "observed");
  assert.equal(result.groups.find(g => g.key === "searchTrend").latestPeriod, "2026-09");
  assert.equal(result.groups.find(g => g.key === "kosis").expectedMonths, null);
  assert.equal(result.groups.find(g => g.key === "kosis").datasets.find(d => d.periodType === "Y").rows[0].value, 0);
  assert.equal(result.networkAttempted, false); assert.ok(f.calls.filter(c => c.method !== "search").every(c => c.collectMissing === false && c.force === false));
  assert.equal(result.capabilities.monthlyForecast, false);
});

function withSpatialEvidence(f, regionKey = scope.regionKey, unitType = "city", officialCode = "4165000000") {
  f.options.resolveRegion = async key => ({ regionKey: key, level: "local", unitType, officialCode, active: true, selectable: true });
  for (const [index, method] of ["collectVisitorHistory", "collectDemandStrengthHistory", "collectResourceDemandHistory", "collectDiversityHistory"].entries()) {
    const original = f.options.tourismCollector[method];
    f.options.tourismCollector[method] = async input => {
      const result = await original(input);
      const points = index === 0 ? result.regions[0].series : result.series;
      const evidence = { verified: true, regionKey, regionCode: officialCode.slice(0, 5), level: "sigungu", mappingStatus: "mapped", observedRegionCodes: [officialCode.slice(0, 5)] };
      for (const point of points) Object.assign(point, { spatialEvidence: evidence, staySpatialEvidence: evidence, spendSpatialEvidence: evidence });
      return result;
    };
  }
  return f;
}

test("new administrative regions use identical rules without named-region exceptions", async () => {
  for (const [key, type, code] of [["new_county", "county", "1111100000"], ["new_city", "city", "2222200000"], ["new_district", "autonomous_district", "3333300000"]]) {
    const f = withSpatialEvidence(fixture(), key, type, code);
    const result = await createRegionalAnalysisSnapshotBuilder(f.options)({ ...scope, regionKey: key });
    assert.equal(result.contractVersion, "regional-data-contract-v1");
    assert.equal(result.regionIdentity.officialCode, code);
    for (const group of result.groups.filter(group => group.category === "tourism")) for (const metric of group.metrics) {
      assert.equal(metric.spatialContract.status, "matched");
      assert.equal(metric.spatialContract.requestedRegionKey, key);
      assert.equal(metric.temporalPolicy.expectedMonths, 13);
      assert.equal(metric.rows[0].period, "2025-08");
      assert.equal(metric.rows.at(-1).availability.observed, true);
      assert.equal(metric.rows.at(-1).value, 0);
    }
    assert.equal(result.comparisonRules.aggregateAdministrativeUnits, false);
  }
});

test("provider input echoes never turn legacy stored values into verified regional evidence", async () => {
  const f = fixture();
  f.options.resolveRegion = async regionKey => ({ regionKey, level: "local", officialCode: "4165000000", unitType: "city" });
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope);
  assert.equal(result.groups[0].metrics[0].latestValue, 0);
  assert.equal(result.groups[0].metrics[0].spatialContract.status, "scope_unverified");
  assert.equal(result.groups[0].metrics[0].rows.at(-1).spatialContract.status, "scope_unverified");
  assert.equal(result.groups.find(group => group.key === "kosis").metrics.find(metric => metric.periodType === "Y").temporalPolicy.expectedMonths, null);
  assert.equal(result.groups.find(group => group.key === "searchTrend").spatialContract.scopeKind, "keyword");
});

test("KOSIS original proof binds to the actual monthly or annual dataset without copying its period", async () => {
  const f = withSpatialEvidence(fixture()), original = f.options.kosisService.getRegion;
  let altered = false;
  f.options.kosisService.getRegion = async regionKey => {
    const result = await original(regionKey); result.region.level = "local";
    for (const dataset of result.datasets) {
      dataset.mapping = { code: "41650" };
      dataset.spatialEvidence = { verified: true, regionKey, regionCode: "41650", level: "sigungu",
        storedProvenance: { version: "regional-response-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "fixture-original",
          sha256: "a".repeat(64), period: altered ? dataset.periodType === "Y" ? "2023" : "2026-07" : dataset.periodType === "Y" ? "2024" : "2026-08",
          periodType: dataset.periodType, verifiedAt: "2026-10-17T00:00:00Z", checks: ["hash", "period", "values", "metadata_region_ancestry"] } };
      dataset.storedEvidenceVerification = { status: "restored", reasonCode: "" };
    }
    return result;
  };
  const build = createRegionalAnalysisSnapshotBuilder(f.options), before = await build(scope);
  const datasets = before.groups.find(group => group.key === "kosis").datasets;
  assert.ok(datasets.every(dataset => dataset.spatialContract.status === "matched" && dataset.storedEvidenceVerification.reasonCode === ""));
  assert.equal(datasets.find(dataset => dataset.periodType === "Y").spatialContract.storedProvenance.period, "2024");
  assert.equal(datasets.find(dataset => dataset.periodType === "M").spatialContract.storedProvenance.period, "2026-08");
  altered = true;
  const after = await build(scope), rejected = after.groups.find(group => group.key === "kosis").datasets;
  assert.ok(rejected.every(dataset => dataset.spatialContract.status === "scope_unverified" && !dataset.spatialContract.storedProvenance));
  assert.ok(rejected.every(dataset => dataset.storedEvidenceVerification.status === "rejected"
    && dataset.storedEvidenceVerification.reasonCode === "STORED_EVIDENCE_PERIOD_OR_REFERENCE_MISMATCH"));
  assert.ok(rejected.every(dataset => dataset.rows.every(row => row.value === 0 && row.status === "observed")), "unverified period never erases a legitimate zero");
  assert.notEqual(before.sourceFingerprint, after.sourceFingerprint);
});

test("tourism original storage failure stays separate from source success and keeps valid observed values", async () => {
  const f = fixture();
  f.options.tourismCollector.collectDemandStrengthHistory = async input => ({ region: { regionKey: input.regionKey }, period: { endYearMonth: input.endYearMonth }, networkAttempted: false,
    series: [{ yearMonth: "202609", status: "complete", stayStatus: "ok", spendStatus: "ok", stayOverall: 0, spendOverall: 7,
      stayResponseEvidenceStorage: { status: "failed", reasonCode: "EVIDENCE_PATH_INVALID" }, spendResponseEvidenceStorage: { status: "stored", reasonCode: "" } }] });
  f.options.tourismCollector.collectResourceDemandHistory = async input => ({ region: { regionKey: input.regionKey }, period: { endYearMonth: input.endYearMonth }, networkAttempted: false,
    series: [{ yearMonth: "202609", status: "complete", values: { service: 0, culture: 8 }, operations: {
      service: { status: "ok", quality: { responseEvidenceStorage: { status: "failed", reasonCode: "EVIDENCE_WRITE_ERROR" } } }, culture: { status: "ok" } } }] });
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope);
  for (const key of ["demandStrength", "resourceDemand"]) {
    const group = result.groups.find(group => group.key === key), row = group.metrics[0].rows.at(-1);
    assert.equal(row.value, 0); assert.equal(row.status, "observed"); assert.equal(row.reasonCode, "");
    assert.equal(row.refreshErrorCode, "EVIDENCE_WRITE_ERROR");
    assert.deepEqual(row.storedEvidenceVerification, { status: "pending", reasonCode: "EVIDENCE_WRITE_ERROR" });
    assert.equal(group.metrics[1].rows.at(-1).refreshErrorCode, undefined);
  }
});

test("retained tourism values and KOSIS refresh diagnostics preserve the original-storage error code", async () => {
  const f = fixture(), original = f.options.kosisService.getRegion;
  f.options.kosisService.getRegion = async regionKey => ({ ...await original(regionKey), error: { code: "EVIDENCE_WRITE_ERROR" }, status: "stale" });
  f.options.tourismCollector.collectDemandStrengthHistory = async input => ({ region: { regionKey: input.regionKey }, period: { endYearMonth: input.endYearMonth }, networkAttempted: false,
    series: [{ yearMonth: "202609", status: "complete", stayStatus: "ok", spendStatus: "ok", stayOverall: 0, spendOverall: 7,
      refreshFailed: true, refreshReason: "response_evidence_storage_failed" }] });
  f.options.prepare = async () => ({ status: "partial", steps: [{ key: "kosis", status: "stale", errorCode: "EVIDENCE_WRITE_ERROR" },
    { key: "demandStrength", status: "partial", errorCode: "EVIDENCE_WRITE_ERROR", periods: [{ period: "202609", status: "partial", errorCode: "EVIDENCE_WRITE_ERROR" }] }] });
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope, { collectMissing: true });
  assert.equal(result.groups.find(group => group.key === "kosis").errorCode, "EVIDENCE_WRITE_ERROR");
  const group = result.groups.find(group => group.key === "demandStrength");
  assert.equal(group.errorCode, "EVIDENCE_WRITE_ERROR"); assert.equal(group.metrics[0].rows.at(-1).refreshErrorCode, "EVIDENCE_WRITE_ERROR");
  assert.ok(result.refreshDiagnostics.steps.every(step => step.errorCode === "EVIDENCE_WRITE_ERROR"));
  assert.equal(result.refreshDiagnostics.steps[1].periods[0].errorCode, "EVIDENCE_WRITE_ERROR");
});

test("regional evidence mismatch survives snapshots and changes their fingerprint", async () => {
  const f = withSpatialEvidence(fixture());
  const build = createRegionalAnalysisSnapshotBuilder(f.options), verified = await build(scope);
  const original = f.options.tourismCollector.collectVisitorHistory;
  f.options.tourismCollector.collectVisitorHistory = async input => {
    const result = await original(input);
    for (const row of result.regions[0].series) row.spatialEvidence = { ...row.spatialEvidence, regionKey: "another_city" };
    return result;
  };
  const mismatched = await build(scope);
  assert.equal(mismatched.groups[0].metrics[0].latestValue, null, "a confirmed wrong area cannot feed comparisons or forecasts");
  assert.equal(mismatched.groups[0].metrics[0].rows.find(row => row.period === verified.groups[0].metrics[0].latestPeriod).referenceValue,
    verified.groups[0].metrics[0].latestValue, "source value is preserved separately for review");
  assert.equal(mismatched.groups[0].metrics[0].spatialContract.status, "response_mismatch");
  assert.notEqual(mismatched.sourceFingerprint, verified.sourceFingerprint);
});
test("failed/missing zero is not an observed value and wrong regions are rejected", async () => {
  const f = fixture();
  f.options.tourismCollector.collectVisitorHistory = async () => ({ regions: [{ regionKey: "other", series: [{ yearMonth: "202609", status: "complete", averageDailyVisitors: 0 }] }] });
  f.options.tourismCollector.collectDemandStrengthHistory = async () => ({ region: { regionKey: scope.regionKey }, series: [{ yearMonth: "202609", status: "failed", stayOverall: 0, spendOverall: 0 }] });
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope);
  assert.equal(result.groups[0].errorCode, "REGION_MISMATCH"); assert.equal(result.groups[0].metrics[0].latestValue, null);
  assert.equal(result.groups[1].metrics[0].rows.at(-1).status, "error"); assert.equal(result.groups[1].metrics[0].latestValue, null);
});
test("source normalization never joins independently scaled search batches", async () => {
  const f = fixture();
  f.options.searchTrendService.get = async input => ({ ...input, keyword: "포천글램핑", partialMonth: false, startDate: "2025-10-01", endDate: "2026-09-30",
    series: input.months === 12 ? [{ period: "2026-09-01", value: 50, status: "observed" }] : [] });
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope);
  const trend = result.groups.find(g => g.key === "searchTrend");
  assert.equal(trend.availableMonths, 1); assert.equal(trend.metrics[0].rows.find(row => row.period === "2025-09").value, null);
  assert.equal(trend.normalizationPeriod, "2025-10-01 ~ 2026-09-30");
});
test("cache-only contract violation fails the build; only explicit refresh invokes preparation", async () => {
  const f = fixture(); let prepared = 0;
  f.options.prepare = async () => { prepared++; return { id: "job", status: "partial", steps: [] }; };
  const build = createRegionalAnalysisSnapshotBuilder(f.options);
  await build(scope); assert.equal(prepared, 0);
  await build(scope, { collectMissing: true }); assert.equal(prepared, 1);
  f.options.tourismCollector.collectVisitorHistory = async () => ({ collection: { operationCallsAttempted: 1 } });
  await assert.rejects(() => createRegionalAnalysisSnapshotBuilder(f.options)(scope), error => error.code === "REGIONAL_CACHE_ONLY_VIOLATION");
});
test("identical values retain source fingerprint across receive-time changes", async () => {
  const f = fixture(), build = createRegionalAnalysisSnapshotBuilder(f.options);
  const first = await build(scope); f.setTime("2026-10-02T00:00:00Z");
  const second = await build(scope);
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
});
test("failed KOSIS refresh preserves stale normal values with their real annual period", async () => {
  const f = fixture(), original = f.options.kosisService.getRegion;
  f.options.kosisService.getRegion = async key => {
    const result = await original(key);
    return { ...result, status: "stale", error: { code: "QUOTA_EXCEEDED" }, datasets: result.datasets.map(dataset => ({ ...dataset, status: "stale" })) };
  };
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope), group = result.groups.find(item => item.key === "kosis");
  assert.equal(group.metrics[0].latestValue, 0); assert.equal(group.stale, true); assert.equal(group.errorCode, "QUOTA_EXCEEDED");
  assert.equal(group.datasets.find(item => item.periodType === "Y").period, "2024");
});

function searchResponse(input, series, errorCode = "") {
  return { ...input, keyword: "포천글램핑", partialMonth: false, startDate: shiftMonth(input.month, 1 - input.months) + "-01",
    endDate: shiftMonth(input.month, 1) + "-01", series, errorCode };
}
const searchRows = (count, end = scope.month, value = 50) => Array.from({ length: count }, (_, i) => ({
  period: shiftMonth(end, i + 1 - count) + "-01", status: "observed", value
}));

test("extended history picks usable13 over a partial24 response without stitching relative batches", async () => {
  const f = fixture(); f.options.includeHistory = true;
  f.options.searchTrendService.get = async input => searchResponse(input,
    input.months === 24 ? searchRows(1, "2025-09", 99) : input.months === 13 ? searchRows(13, scope.month, 40) : searchRows(12, scope.month, 20));
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope), search = result.groups.find(group => group.key === "searchTrend");
  assert.equal(search.latestPeriod, "2026-09"); assert.equal(search.availableMonths, 13); assert.equal(search.errorCode, "");
  assert.equal(search.normalizationPeriod, "2025-09-01 ~ 2026-10-01");
  assert.ok(search.metrics[0].historyRows.every(row => row.value === 40));
  assert.equal(search.metrics[0].historyRows.length, 13);
});

test("extended history ranks two supported targets, then freshness, then normal count, preserving a single batch", async () => {
  const f = fixture(); f.options.includeHistory = true;
  f.options.searchTrendService.get = async input => searchResponse(input,
    input.months === 24 ? searchRows(24, "2026-08", 24) : input.months === 13 ? searchRows(13, scope.month, 13) : searchRows(12, scope.month, 12));
  let search = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(group => group.key === "searchTrend");
  assert.equal(search.metrics[0].latestValue, 13, "Fresher normal month wins when both windows support both targets");
  f.options.searchTrendService.get = async input => searchResponse(input, searchRows(input.months, scope.month, input.months));
  search = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(group => group.key === "searchTrend");
  assert.equal(search.metrics[0].latestValue, 24, "More normal history wins at equal freshness and target support");
  assert.equal(search.metrics[0].historyRows.length, 24);
  f.options.searchTrendService.get = async input => searchResponse(input,
    input.months === 24 ? searchRows(5, scope.month, 24) : input.months === 13 ? searchRows(13, "2026-08", 13) : []);
  search = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(group => group.key === "searchTrend");
  assert.equal(search.metrics[0].latestValue, 13, "Five newer values must not displace six or more usable normal months");
});

test("extended history does not carry rejected24 cache errors into a normal13 response", async () => {
  const f = fixture(); f.options.includeHistory = true;
  f.options.searchTrendService.get = async input => {
    if (input.months === 24) throw Object.assign(new Error("bad-cache"), { code: "CACHE_READ_ERROR" });
    return searchResponse(input, searchRows(input.months, scope.month, input.months));
  };
  const search = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(group => group.key === "searchTrend");
  assert.equal(search.status, "ready"); assert.equal(search.errorCode, ""); assert.equal(search.metrics[0].latestValue, 13);
});

test("extended history rejects duplicate months and failed zeros in candidate ranking", async () => {
  const f = fixture(); f.options.includeHistory = true;
  f.options.searchTrendService.get = async input => searchResponse(input, input.months === 24
    ? [...searchRows(24), ...searchRows(1)] : input.months === 13 ? searchRows(13, scope.month, 0)
      : searchRows(12).map(row => ({ ...row, status: "failed", value: 0 })));
  const search = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(group => group.key === "searchTrend");
  assert.equal(search.status, "ready"); assert.equal(search.errorCode, ""); assert.equal(search.metrics[0].latestValue, 0);
  assert.equal(search.availableMonths, 13);
});

test("extended24 display scope may reuse a whole valid13 response when24 cache is not forecastable", async () => {
  const f = fixture(); f.options.includeHistory = true;
  f.options.searchTrendService.get = async input => searchResponse(input,
    input.months === 24 ? searchRows(1, "2025-09", 99) : input.months === 13 ? searchRows(13, scope.month, 40) : []);
  const search = (await createRegionalAnalysisSnapshotBuilder(f.options)({ ...scope, months: 24 })).groups.find(group => group.key === "searchTrend");
  assert.equal(search.metrics[0].historyRows.length, 13); assert.equal(search.metrics[0].rows.length, 24);
  assert.equal(search.metrics[0].latestValue, 40); assert.equal(search.availableMonths, 13);
  assert.ok(search.metrics[0].historyRows.every(row => row.value === 40));
});

test("requested-month evidence survives a latest-normal-ended13-month display window", async () => {
  const f = fixture(), original = f.options.tourismCollector.collectVisitorHistory;
  f.options.tourismCollector.collectVisitorHistory = async input => {
    const result = await original(input);
    result.regions[0].series.at(-1).reason = "period_not_closed";
    return result;
  };
  const group = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups[0], metric = group.metrics[0];
  assert.equal(metric.rows.length, 13); assert.equal(metric.rows.at(-1).period, "2026-08");
  assert.equal(metric.requestedPoint.period, "2026-09"); assert.equal(metric.requestedPoint.status, "publication_pending");
  assert.equal(metric.requestedPoint.reasonCode, "PUBLICATION_PENDING"); assert.equal(group.latestRequestedStatus, "publication_pending");
  assert.equal(group.latestRequestedPeriod, "202609");
  assert.equal(metric.rows[0].value, 0); assert.equal(metric.rows[0].reasonCode, "");
});

test("known cache, HTTP and unknown reasons remain distinct without copying provider text", async () => {
  const f = fixture(), original = f.options.tourismCollector.collectVisitorHistory;
  f.options.tourismCollector.collectVisitorHistory = async input => {
    const result = await original(input), list = result.regions[0].series;
    Object.assign(list.at(-1), { status: "missing", value: 0, diagnostics: { httpStatus: 401, apiCode: "30", secret: "DO_NOT_COPY" } });
    Object.assign(list.at(-2), { status: "missing", reason: "monthly_cache_missing" });
    Object.assign(list.at(-3), { status: "missing", reason: "https://private.invalid/?key=DO_NOT_COPY" });
    return result;
  };
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope), metric = result.groups[0].metrics[0];
  assert.equal(metric.requestedPoint.status, "error"); assert.equal(metric.requestedPoint.reasonCode, "AUTH_ERROR");
  assert.deepEqual(metric.requestedPoint.diagnostics, { httpStatus: 401, providerCode: "30" });
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_COPY|private\.invalid/);
  // Inspect retained extended history because the normal display ends before
  // the missing tail, rather than pretending these months were successful.
  f.options.includeHistory = true;
  const history = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups[0].metrics[0].historyRows;
  assert.equal(history.find(row => row.period === "2026-08").reasonCode, "NOT_COLLECTED");
  assert.equal(history.find(row => row.period === "2026-07").reasonCode, "UNRECORDED_REASON");
});

test("search authentication and thrown read failures are preserved on unavailable requested data", async () => {
  const f = fixture();
  f.options.searchTrendService.get = async input => ({ ...searchResponse(input, searchRows(input.months).map(row => ({ ...row, status: "missing", value: null })), "MISSING_KEY") });
  let search = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(group => group.key === "searchTrend");
  assert.equal(search.metrics[0].requestedPoint.reasonCode, "MISSING_KEY"); assert.equal(search.metrics[0].requestedPoint.status, "error");
  f.options.searchTrendService.get = async () => { throw Object.assign(new Error("unsafe"), { code: "NETWORK_ERROR" }); };
  search = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(group => group.key === "searchTrend");
  assert.equal(search.metrics[0].requestedPoint.reasonCode, "NETWORK_ERROR"); assert.equal(search.metrics[0].requestedPoint.status, "error");
});

test("safe refresh diagnostics retain real attempts while receive timestamps do not cause new input fingerprints", async () => {
  const f = fixture(); let finishedAt = "2026-10-15T01:00:00Z";
  f.options.prepare = async () => ({ id: "prep", status: "partial", finishedAt, steps: [
    { key: "visitors", status: "partial", networkAttempted: true, finishedAt, diagnostics: { httpStatus: 401, secret: "DO_NOT_COPY" },
      periods: [{ requestedPeriod: "202609", status: "failed", errorCode: "AUTH_ERROR", finishedAt, secret: "DO_NOT_COPY" }] },
    { key: "searchTrend", status: "failed", errorCode: "RAW_SECRET_DO_NOT_COPY", networkAttempted: false },
    { key: "RAW_SECRET_DO_NOT_COPY", status: "failed" }
  ] });
  const build = createRegionalAnalysisSnapshotBuilder(f.options), first = await build(scope, { collectMissing: true });
  assert.equal(first.refreshDiagnostics.steps.length, 2); assert.equal(first.refreshDiagnostics.steps[0].periods[0].errorCode, "AUTH_ERROR");
  assert.equal(first.refreshDiagnostics.steps[1].errorCode, "PROVIDER_FAILED");
  assert.doesNotMatch(JSON.stringify(first), /DO_NOT_COPY/);
  finishedAt = "2026-10-15T02:00:00Z";
  assert.equal((await build(scope, { collectMissing: true })).sourceFingerprint, first.sourceFingerprint);
});

test("a partial stay/spend bundle preserves explicitly normal individual metrics including real zero", async () => {
  const f = fixture(), original = f.options.tourismCollector.collectDemandStrengthHistory;
  f.options.tourismCollector.collectDemandStrengthHistory = async input => {
    const result = await original(input);
    Object.assign(result.series.at(-1), { status: "partial", stayStatus: "ok", stayOverall: 0, spendStatus: "error", spendOverall: null, spendReason: "timeout" });
    return result;
  };
  const group = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(item => item.key === "demandStrength");
  const stay = group.metrics.find(metric => metric.key === "stayOverall"), spend = group.metrics.find(metric => metric.key === "spendOverall");
  assert.equal(stay.latestPeriod, "2026-09"); assert.equal(stay.latestValue, 0); assert.equal(stay.requestedPoint.status, "observed");
  assert.equal(spend.requestedPoint.status, "error"); assert.equal(spend.requestedPoint.reasonCode, "TIMEOUT"); assert.equal(spend.requestedPoint.value, null);
  assert.equal(group.latestRequestedStatus, "partial");
});

test("regional index operation evidence preserves valid overall values without accepting conflicting quality", async () => {
  const f = fixture(), original = f.options.tourismCollector.collectResourceDemandHistory;
  let conflict = false;
  f.options.tourismCollector.collectResourceDemandHistory = async input => {
    const result = await original(input);
    Object.assign(result.series.at(-1), { status: "partial", values: { service: 0, culture: null }, operations: {
      service: { status: "partial", overallCode: "ALL", overallValue: 0, metrics: [{ code: "ALL", value: 0 }], quality: { overallComplete: true, conflictCount: conflict ? 1 : 0 } },
      culture: { status: "error", reason: "request_failed" }
    } }); return result;
  };
  let group = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(item => item.key === "resourceDemand");
  assert.equal(group.metrics[0].requestedPoint.status, "observed"); assert.equal(group.metrics[0].latestValue, 0);
  assert.equal(group.metrics[1].requestedPoint.status, "error"); assert.equal(group.metrics[1].requestedPoint.reasonCode, "NETWORK_ERROR");
  conflict = true;
  group = (await createRegionalAnalysisSnapshotBuilder(f.options)(scope)).groups.find(item => item.key === "resourceDemand");
  assert.equal(group.metrics[0].requestedPoint.status, "error"); assert.equal(group.metrics[0].requestedPoint.value, null);
  assert.equal(group.metrics[0].requestedPoint.reasonCode, "INVALID_RESPONSE");
});
