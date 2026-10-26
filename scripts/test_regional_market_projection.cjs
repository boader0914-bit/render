"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createSavedRegionalMarketProjector } = require("./lib/regional_market_projection.cjs");
const { SPECS, buildRegionalMarketSnapshot } = require("./lib/regional_market.cjs");
const NOW = "2026-10-26T01:00:00.000Z", THEN = "2026-10-17T12:00:00.000Z";
const region = { regionKey: "projection_fixture_county", label: "모의도 검증군", officialCode: "1111100000", level: "local", unitType: "county", active: true, selectable: true };
const scope = { regionKey: region.regionKey, label: region.label, month: "2026-09", months: 13 };
const checks = ["safe_original_path", "original_sha256", "source_table_and_period", "metadata_region_ancestry", "raw_region_code", "metric_unit_and_period", "stored_metric_values"];
const sha = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function savedFixture() {
  return { schemaVersion: 1, calculationVersion: "regional-analysis-v1", contractVersion: "regional-data-contract-v1", resultId: "12345678-1234-4234-8234-123456789abc", sourceFingerprint: "a".repeat(64),
    generatedAt: THEN, builtAt: THEN, status: "partial", networkAttempted: false, scope: { ...scope },
    regionIdentity: { regionKey: region.regionKey, officialCode: region.officialCode, level: "local", unitType: "county" },
    groups: [{ key: "kosis", provider: "KOSIS", datasets: SPECS.map((spec, index) => ({ key: spec.datasetKey, periodType: spec.periodType,
      period: spec.periodType === "M" ? "2026-09" : "2024", retrievedAt: THEN, storedEvidenceVerification: { status: "restored", reasonCode: "" },
      spatialContract: { version: "regional-data-contract-v1", requestedRegionKey: region.regionKey, officialCode: region.officialCode, requestedLevel: "sigungu", requestedUnitType: "county", provider: "KOSIS", providerRegionCode: "11111", providedLevel: "sigungu", scopeKind: "administrative", status: "matched", evidence: "response", aggregation: "none",
        storedProvenance: { version: "stored-kosis-spatial-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "projection-proof", sha256: "b".repeat(64), period: spec.periodType === "M" ? "2026-09" : "2024", periodType: spec.periodType, verifiedAt: THEN, checks } },
      rows: [{ key: spec.metricKey, unit: spec.unit, status: "observed", value: index }] })) }] };
}
function fixture(changeRaw = () => {}, changeProjection = () => {}, changeMarket = () => {}) {
  const raw = savedFixture(); changeRaw(raw);
  const market = buildRegionalMarketSnapshot({ region, scope, savedSnapshot: raw, source: { resultSha256: sha(raw) }, now: () => NOW }); changeMarket(market);
  const projected = { snapshot: structuredClone(raw), storage: { errorCode: null }, job: { status: "completed" } }; changeProjection(projected);
  const calls = [];
  const projector = createSavedRegionalMarketProjector({ analysisStore: {
    request: async (...args) => { calls.push(["request", ...args]); return { job: { status: "queued" } }; },
    waitForIdle: async () => { calls.push(["idle"]); }, get: async value => { calls.push(["get", value]); return projected; }
  }, marketService: { get: async value => { calls.push(["market", value]); return market; } } });
  return { raw, projected, market, calls, projector };
}

test("six proven totals including true zero pass despite explicitly unknown boundary year", async () => {
  const f = fixture(), source = JSON.stringify(f.raw), result = await f.projector(region.regionKey, { remaining: [] });
  assert.equal(result.verified, true); assert.equal(result.resultId, f.raw.resultId); assert.equal(f.market.status, "partial");
  assert.equal(f.market.scope.boundaryYearStatus, "unrecorded"); assert.equal(f.market.metrics[0].value, 0);
  assert.deepEqual(result.availableDatasetKeys, SPECS.map(spec => spec.datasetKey)); assert.equal(JSON.stringify(f.raw), source);
  assert.deepEqual(f.calls, [["request", { regionKey: region.regionKey, months: 13 }, { collectMissing: false, reason: "source_changed" }], ["idle"],
    ["get", { regionKey: region.regionKey, months: 13 }], ["market", { regionKey: region.regionKey }]]);
});

test("a successful queue cannot verify a different saved result, source fingerprint, region, month or window", async t => {
  for (const [label, changeProjection, changeMarket] of [
    ["result", value => { value.snapshot.resultId = "22345678-1234-4234-8234-123456789abc"; }, () => {}],
    ["source fingerprint", value => { value.snapshot.sourceFingerprint = "c".repeat(64); }, () => {}],
    ["month", value => { value.snapshot.scope.month = "2026-08"; }, () => {}],
    ["saved analysis region", value => { value.snapshot.scope.regionKey = "another_county"; }, () => {}],
    ["saved analysis window", value => { value.snapshot.scope.months = 24; }, () => {}],
    ["region", () => {}, value => { value.scope.regionKey = "another_county"; }],
    ["window", () => {}, value => { value.scope.months = 24; }]
  ]) await t.test(label, async () => { const f = fixture(() => {}, changeProjection, changeMarket); await assert.rejects(f.projector(region.regionKey, { remaining: [] })); });
});

test("missing, interrupted, active and failed saved results never produce verified receipts", async t => {
  for (const status of ["queued", "running", "interrupted", "failed"]) await t.test(status, async () => {
    const f = fixture(() => {}, value => { value.job.status = status; }); await assert.rejects(f.projector(region.regionKey, { remaining: [] }));
  });
  for (const change of [value => { value.snapshot = null; }, value => { value.storage.errorCode = "REGIONAL_STORE_UNAVAILABLE"; }]) {
    const f = fixture(() => {}, change); await assert.rejects(f.projector(region.regionKey, { remaining: [] }));
  }
});

test("missing or unverified required data fails rather than becoming a verified empty/zero projection", async t => {
  for (const status of ["missing", "partial", "suppressed", "publication_pending", "error"]) await t.test(status, async () => {
    const f = fixture(raw => { raw.groups[0].datasets[0].rows[0].status = status; raw.groups[0].datasets[0].rows[0].value = null; });
    await assert.rejects(f.projector(region.regionKey, { remaining: [] }));
  });
  const unverified = fixture(raw => { raw.groups[0].datasets[0].spatialContract.status = "scope_unverified"; });
  assert.equal(unverified.market.status, "needs_verification"); await assert.rejects(unverified.projector(region.regionKey, { remaining: [] }));
});

test("a local-budget partial result may verify exactly the two proven totals without claiming the four missing tables", async () => {
  const f = fixture(raw => { raw.groups[0].datasets = raw.groups[0].datasets.slice(0, 2); });
  const remaining = SPECS.slice(2).map(spec => ({ datasetKey: spec.datasetKey, status: "blocked", reasonCode: "QUOTA_EXCEEDED" }));
  const result = await f.projector(region.regionKey, { remaining });
  assert.equal(result.verified, true); assert.deepEqual(result.availableDatasetKeys, ["population", "households"]);
  assert.equal(f.market.metrics.filter(metric => metric.status === "observed").length, 2);
  assert.ok(f.market.metrics.slice(2).every(metric => metric.value === null));
});

test("a partial budget receipt does not excuse an unproven one of its supposedly available totals", async () => {
  const f = fixture(raw => { raw.groups[0].datasets = raw.groups[0].datasets.slice(0, 2); raw.groups[0].datasets[1].rows[0].status = "missing"; raw.groups[0].datasets[1].rows[0].value = null; });
  await assert.rejects(f.projector(region.regionKey, { remaining: SPECS.slice(2).map(spec => ({ datasetKey: spec.datasetKey })) }));
});

test("altered numbers, missing proof, negative/noninteger values and network claims fail strict saved DTO validation", async t => {
  for (const change of [value => { value.metrics[0].value = 8; }, value => { value.metrics[0].value = -1; }, value => { value.metrics[0].value = 0.5; },
    value => { value.metrics[0].source.storedProvenance = null; }, value => { value.networkAttempted = true; }]) await t.test(String(change), async () => {
    const f = fixture(() => {}, () => {}, change); await assert.rejects(f.projector(region.regionKey, { remaining: [] }));
  });
});

test("provider or storage failures are surfaced without fabricating a verification result", async () => {
  for (const failingMethod of ["request", "waitForIdle", "get"]) {
    const analysisStore = { request: async () => {}, waitForIdle: async () => {}, get: async () => ({ snapshot: savedFixture(), storage: {}, job: { status: "completed" } }) };
    analysisStore[failingMethod] = async () => { throw new Error("fixture storage failure"); };
    const projector = createSavedRegionalMarketProjector({ analysisStore, marketService: { get: async () => assert.fail("failed analysis cannot read a market projection") } });
    await assert.rejects(projector(region.regionKey, { remaining: [] }));
  }
});
