"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDataset, normalizeCenter, calculateCatchment, validateCatchmentResult, EARTH_RADIUS_KM, haversineKm, inputFingerprint } = require("./lib/regional_catchment.cjs");
const center = { latitude: 36.5, longitude: 127.8, label: "합성 검수 기준점", sourceUrl: "https://www.data.go.kr/", confirmed: true };
const metric = (value, status = "observed_public") => ({ status, value });
const point = distance => ({ latitude: center.latitude + distance / EARTH_RADIUS_KM * 180 / Math.PI, longitude: center.longitude });
function fixture() {
  return { id: "synthetic-grid", provider: "SGIS", sourceUrl: "https://sgis.mods.go.kr/view/pss/openDataIntrcn", sourceYear: 2024, boundaryYear: 2025,
    crs: "EPSG:4326", gridSizeM: 1000, sourceSha256: "a".repeat(64), boundarySha256: "b".repeat(64), industryClassification: "TEST-KSIC-11:all",
    coverageBBox: [125, 33, 131, 39], completeFrame: true, units: { population: "명", establishments: "개", workers: "명" },
    cells: [0, 50, 75, 100, 101].map((d, i) => ({ id: `가다-${i}`, ...point(d), population: metric(10 + i), establishments: metric(1 + i), workers: metric(3 + i) })) };
}
const calculate = input => calculateCatchment({ regionKey: "test", label: "합성 자료", center, dataset: normalizeDataset(input), now: () => new Date("2026-10-21T01:00:00Z") });

test("50km/100km boundary cells are assigned once; cumulative equals disjoint rings", async () => {
  const result = await calculate(fixture());
  assert.equal(result.status, "ready");
  const [inner, outer, total] = result.rings;
  assert.equal(inner.coverage.selectedCells, 2); assert.equal(outer.coverage.selectedCells, 2); assert.equal(total.coverage.selectedCells, 4);
  for (const key of ["population", "establishments", "workers"]) assert.equal(total.metrics[key].value, inner.metrics[key].value + outer.metrics[key].value);
  assert.equal(total.metrics.population.value, 46);
  assert.ok(Math.abs(haversineKm(center, point(50)) - 50) < 1e-8);
  assert.equal(result.networkAttempted, false);
  assert.equal(result.method.coverageBasis, "administrator_declared_not_independently_verified");
  assert.equal(inner.coverage.boundaryCells, 1);
});

test("coverage incomplete or clipped never presents a whole-radius total", async () => {
  const partial = fixture(); partial.completeFrame = false;
  const result = await calculate(partial);
  assert.equal(result.rings[2].metrics.population.value, null);
  assert.equal(result.rings[2].metrics.population.publishedSum, 46);
  const clipped = fixture(); clipped.coverageBBox = [127.7, 36.4, 128, 37.5]; clipped.cells = clipped.cells.slice(0, 2);
  const clippedResult = await calculate(clipped);
  assert.equal(clippedResult.rings[0].coverage.bboxContainsCircle, false);
  assert.equal(clippedResult.rings[0].metrics.population.value, null);
  assert.equal(clippedResult.rings[0].metrics.population.publishedSum, 21);
});

test("SGIS protected zero and suppression remain unknown rather than zero", async () => {
  const input = fixture(); input.cells[0].population = metric(0, "protected_zero"); input.cells[1].population = metric(null, "suppressed");
  input.cells[2].population = metric(null, "not_acquired"); input.cells[3].population = metric(null, "not_provided");
  const result = await calculate(input), population = result.rings[2].metrics.population;
  assert.equal(population.value, null); assert.equal(population.publishedSum, null);
  assert.equal(population.protectedZeroCells, 1); assert.equal(population.suppressedCells, 1); assert.equal(population.missingCells, 2);
  assert.equal(result.rings[0].metrics.establishments.value, 3);
  const publicZero = fixture(); publicZero.cells[0].population = metric(0);
  assert.throws(() => normalizeDataset(publicZero), { code: "CATCHMENT_PROTECTED_ZERO_REQUIRED" });
});

test("documented non-protected published zero is retained, never inferred from an absent cell", async () => {
  const input = fixture(); input.provider = "국토지리정보원"; input.sourceUrl = "https://www.data.go.kr/data/15059921/fileData.do";
  input.cells[0].population = metric(0); input.cells = input.cells.slice(0, 1);
  const result = await calculate(input);
  assert.equal(result.rings[0].metrics.population.value, 0);
  assert.equal(result.rings[1].metrics.population.value, null);
  assert.equal(result.rings[1].metrics.population.publishedSum, null);
  assert.equal(result.rings[2].metrics.population.value, null, "an unobserved outer band cannot be inferred zero by the cumulative total");
});

test("null/string/reversed/outside coordinates and unconfirmed center are rejected", () => {
  for (const bad of [{ latitude: null }, { latitude: "36.5" }, { latitude: 127.8, longitude: 36.5 }, { longitude: 0 }]) {
    assert.throws(() => normalizeCenter({ ...center, ...bad }), { code: "CATCHMENT_INVALID_COORDINATE" });
  }
  assert.throws(() => normalizeCenter({ ...center, confirmed: false }), { code: "CATCHMENT_CENTER_CONFIRMATION_REQUIRED" });
  const input = fixture(); input.cells[0].latitude = null;
  assert.throws(() => normalizeDataset(input), { code: "CATCHMENT_INVALID_COORDINATE" });
});

test("duplicate IDs/positions, mixed units/year/classification and negatives are rejected", () => {
  for (const mutate of [
    input => { input.cells[1].id = input.cells[0].id; },
    input => { input.cells[1].latitude = input.cells[0].latitude; },
    input => { input.units.population = "천명"; },
    input => { input.cells[0].population.unit = "가구"; },
    input => { input.cells[0].sourceYear = 2023; },
    input => { input.cells[0].workers.industryClassification = "KSIC-10"; },
    input => { input.cells[0].population.value = -1; },
    input => { input.cells[0].workers = metric(0, "suppressed"); }
  ]) { const input = fixture(); mutate(input); assert.throws(() => normalizeDataset(input)); }
});

test("spatial source/hash/CRS/resolution and bounded schema fail closed", () => {
  for (const mutate of [
    input => { input.gridSizeM = 10000; }, input => { input.crs = "EPSG:5179"; },
    input => { input.sourceSha256 = "not-a-hash"; }, input => { input.sourceUrl = "https://sgis.mods.go.kr.attacker.example/data"; },
    input => { input.coverageBBox = [131, 33, 125, 39]; }, input => { input.officiallyVerified = true; },
    input => { input.cells[0].unexpected = 1; }, input => { input.sourceTransform = "guessed"; }
  ]) { const input = fixture(); mutate(input); assert.throws(() => normalizeDataset(input)); }
});

test("canonical fingerprint ignores row ordering, changes with coordinates/source data", () => {
  const input = fixture(), first = normalizeDataset(input), reordered = structuredClone(input); reordered.cells.reverse();
  assert.equal(first.fingerprint, normalizeDataset(reordered).fingerprint);
  const normalizedCenter = normalizeCenter(center);
  assert.notEqual(inputFingerprint(normalizedCenter, first), inputFingerprint({ ...normalizedCenter, latitude: 36.6 }, first));
  const changed = fixture(); changed.cells[0].population.value++;
  assert.notEqual(first.fingerprint, normalizeDataset(changed).fingerprint);
});

test("calculation yields during grid scan and retains classification/provenance", async () => {
  const dataset = normalizeDataset(fixture()); let yielded = false;
  setImmediate(() => { yielded = true; });
  const result = await calculateCatchment({ regionKey: "test", label: "test", center, dataset, yieldEvery: 1 });
  assert.equal(yielded, true); assert.equal(result.dataset.industryClassification, "TEST-KSIC-11:all");
  assert.equal(result.dataset.provenance, "administrator_imported");
});

test("strict result validator rejects malformed rings, misleading certainty and inconsistent totals", async () => {
  const result = await calculate(fixture());
  assert.equal(validateCatchmentResult(result, { requireResultId: false }), result);
  for (const mutate of [
    value => { value.rings[0].key = "total100"; },
    value => { value.rings.pop(); },
    value => { value.rings[0].metrics.population.value = Infinity; },
    value => { value.rings[0].metrics.population.value = -1; },
    value => { delete value.rings[0].metrics.population.status; },
    value => { value.rings[0].metrics.population.unit = "천명"; },
    value => { value.rings[0].metrics.population.protectedZeroCells = 1; },
    value => { value.rings[2].metrics.population.value = 100; },
    value => { value.rings[1].metrics.population.publishedSum++; },
    value => { value.rings[2].coverage.bboxContainsCircle = false; },
    value => { value.status = "missing"; }
  ]) {
    const changed = structuredClone(result); mutate(changed);
    assert.throws(() => validateCatchmentResult(changed, { requireResultId: false }), { code: "CATCHMENT_RESULT_INVALID" });
  }
  const incomplete = fixture(); incomplete.completeFrame = false;
  const partial = await calculate(incomplete); partial.rings[0].metrics.population.value = partial.rings[0].metrics.population.publishedSum;
  partial.rings[0].metrics.population.status = "observed_public";
  assert.throws(() => validateCatchmentResult(partial, { requireResultId: false }), { code: "CATCHMENT_RESULT_INVALID" });
  const protectedZero = structuredClone(result);
  protectedZero.rings[0].metrics.population.value = 0; protectedZero.rings[0].metrics.population.publishedSum = 0;
  protectedZero.rings[2].metrics.population.value = protectedZero.rings[1].metrics.population.value;
  protectedZero.rings[2].metrics.population.publishedSum = protectedZero.rings[1].metrics.population.publishedSum;
  assert.throws(() => validateCatchmentResult(protectedZero, { requireResultId: false }), { code: "CATCHMENT_RESULT_INVALID" });
});
