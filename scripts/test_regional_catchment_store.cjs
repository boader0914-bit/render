"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { createRegionalCatchmentService } = require("./lib/regional_catchment_store.cjs");
const { calculateCatchment, hash, normalizeCenter, normalizeDataset, inputFingerprint, addressFingerprint, validateCatchmentResult } = require("./lib/regional_catchment.cjs");
const center = { latitude: 36.5, longitude: 127.8, label: "합성 검수 기준점", address: "모의도 모의군 시험로 10", sourceUrl: "https://www.data.go.kr/", confirmed: true };
function fixture(id = "synthetic-v1") {
  const metric = value => ({ status: "observed_public", value });
  return { id, provider: "SGIS", sourceUrl: "https://sgis.mods.go.kr/view/pss/openDataIntrcn", sourceYear: 2024, boundaryYear: 2025,
    crs: "EPSG:4326", gridSizeM: 1000, sourceSha256: "a".repeat(64), boundarySha256: "b".repeat(64), industryClassification: "TEST-KSIC-11:all",
    coverageBBox: [125, 33, 131, 39], completeFrame: true, units: { population: "명", establishments: "개", workers: "명" },
    cells: [36.5, 37.2].map((latitude, i) => ({ id: `가다${i}`, latitude, longitude: 127.8, population: metric(10 + i), establishments: metric(1 + i), workers: metric(3 + i) })) };
}
const resolveRegion = async regionKey => regionKey === "r1" || regionKey === "r2" ? { regionKey, label: `합성 ${regionKey}`, level: "local", active: true, selectable: true } : null;
async function setup(t, extra = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "catchment-store-test-"));
  const service = createRegionalCatchmentService({ dataDir, resolveRegion, now: () => new Date("2026-10-21T01:00:00Z"), ...extra });
  t.after(async () => { await service.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, service };
}
async function configure(service, dataset = fixture()) {
  const imported = await service.importDataset(dataset, "local-test");
  await service.configure({ regionKey: "r1", center, datasetId: dataset.id }, "local-test");
  return imported.dataset;
}

test("GET leaves unqueried/missing distinct and performs no calculation or source read", async t => {
  let calculations = 0;
  const { service, dataDir } = await setup(t, { calculate: async input => { calculations++; return calculateCatchment(input); } });
  const initial = await service.get({ regionKey: "r1" });
  assert.equal(initial.status, "unqueried"); assert.equal(initial.snapshot, null); assert.equal(initial.configuration, null);
  await assert.rejects(fs.access(path.join(dataDir, "regional_catchment", "state.json")));
  const dataset = await configure(service);
  await fs.rename(path.join(dataDir, "regional_catchment", "datasets"), path.join(dataDir, "held-source"));
  const missing = await service.get({ regionKey: "r1" });
  assert.equal(missing.status, "missing"); assert.equal(missing.snapshot, null); assert.equal(missing.datasets[0].fingerprint, dataset.fingerprint);
  assert.equal(calculations, 0); assert.equal(missing.storage.networkAttempted, false);
});

test("concurrent requests share a single local job and immutable stored result", async t => {
  let calculations = 0;
  const { service } = await setup(t, { calculate: async input => { calculations++; await new Promise(resolve => setImmediate(resolve)); return calculateCatchment(input); } });
  await configure(service);
  const requests = await Promise.all(Array.from({ length: 5 }, () => service.request({ regionKey: "r1" })));
  assert.equal(new Set(requests.map(row => row.job.id)).size, 1);
  await service.waitForIdle();
  assert.equal(calculations, 1);
  const saved = await service.get({ regionKey: "r1" });
  assert.equal(saved.status, "ready"); assert.equal(saved.job.status, "completed"); assert.equal(saved.snapshot.rings[2].metrics.population.value, 21);
  const reused = await service.request({ regionKey: "r1" });
  assert.equal(reused.reused, true); assert.equal(reused.snapshot.resultId, saved.snapshot.resultId); assert.equal(calculations, 1);
});

test("restart reuses result ID/calculation time without reopening the grid; saved GET is small and fast", async t => {
  const { service, dataDir } = await setup(t);
  const source = fixture(); source.sourceEncoding = "cp949"; source.sourceTransform = "none";
  await configure(service, source); await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const first = await service.get({ regionKey: "r1" }); await service.close();
  await fs.rename(path.join(dataDir, "regional_catchment", "datasets"), path.join(dataDir, "held-source"));
  let calculations = 0;
  const restarted = createRegionalCatchmentService({ dataDir, resolveRegion, calculate: async () => { calculations++; throw new Error("must not calculate"); } });
  t.after(() => restarted.close());
  const start = performance.now(), saved = await restarted.get({ regionKey: "r1" });
  assert.ok(performance.now() - start < 2000);
  assert.equal(saved.snapshot.resultId, first.snapshot.resultId); assert.equal(saved.snapshot.calculatedAt, first.snapshot.calculatedAt);
  assert.equal(saved.snapshot.dataset.sourceEncoding, "cp949"); assert.equal(saved.datasets[0].sourceEncoding, "cp949");
  assert.equal(saved.snapshot.dataset.sourceSha256, source.sourceSha256);
  assert.equal(calculations, 0); assert.equal(JSON.stringify(saved).includes('"cells":'), false);
});

test("different center hides previous numbers; failed calculation preserves old immutable bytes", async t => {
  const { service, dataDir } = await setup(t);
  const metadata = await configure(service); await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const first = await service.get({ regionKey: "r1" });
  const resultFile = path.join(dataDir, "regional_catchment", "results", `${first.snapshot.resultId}.json`), bytes = await fs.readFile(resultFile);
  await service.configure({ regionKey: "r1", center: { ...center, latitude: 36.6 }, datasetId: metadata.id });
  assert.equal((await service.get({ regionKey: "r1" })).snapshot, null);
  await fs.rename(path.join(dataDir, "regional_catchment", "datasets"), path.join(dataDir, "held-source"));
  await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const failed = await service.get({ regionKey: "r1" });
  assert.equal(failed.status, "failed"); assert.equal(failed.job.status, "failed"); assert.equal(failed.snapshot, null);
  assert.deepEqual(await fs.readFile(resultFile), bytes);
  await service.configure({ regionKey: "r1", center, datasetId: metadata.id });
  const restored = await service.get({ regionKey: "r1" });
  assert.equal(restored.snapshot.resultId, first.snapshot.resultId); assert.equal(restored.status, "ready");
});

test("new source requires a new immutable ID and calculation; old data remains unchanged", async t => {
  let calculations = 0;
  const { service } = await setup(t, { calculate: async input => { calculations++; return calculateCatchment(input); } });
  await configure(service); await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const first = await service.get({ regionKey: "r1" });
  const bad = fixture(); bad.cells[0].population.value = 100;
  await assert.rejects(service.importDataset(bad), { code: "CATCHMENT_DATASET_ID_CONFLICT" });
  bad.id = "synthetic-v2"; await service.importDataset(bad);
  await service.configure({ regionKey: "r1", center, datasetId: bad.id });
  assert.equal((await service.get({ regionKey: "r1" })).snapshot, null);
  await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const second = await service.get({ regionKey: "r1" });
  assert.notEqual(second.snapshot.resultId, first.snapshot.resultId); assert.equal(second.snapshot.rings[2].metrics.population.value, 111); assert.equal(calculations, 2);
});

test("late old-center calculation is superseded and cannot publish over a new center", async t => {
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { service } = await setup(t, { calculate: async input => { entered(); await gate; return calculateCatchment(input); } });
  await configure(service); await service.request({ regionKey: "r1" }); await enteredPromise;
  await service.configure({ regionKey: "r1", center: { ...center, longitude: 128 }, datasetId: "synthetic-v1" });
  release(); await service.waitForIdle();
  const view = await service.get({ regionKey: "r1" });
  assert.equal(view.snapshot, null); assert.equal(view.job.status, "superseded");
});

test("invalid/broad region, unknown keys and future source year fail closed", async t => {
  const { service } = await setup(t);
  await assert.rejects(service.get({ regionKey: "unknown" }), { code: "CATCHMENT_INVALID_REGION" });
  await assert.rejects(service.get({ regionKey: "r1", refresh: true }), { code: "CATCHMENT_INVALID_INPUT" });
  const future = fixture(); future.sourceYear = 2099;
  await assert.rejects(service.importDataset(future), { code: "CATCHMENT_SOURCE_PERIOD_INVALID" });
  await assert.rejects(service.request({ regionKey: "r1" }), { code: "CATCHMENT_CONFIGURATION_REQUIRED" });
});

test("restart reports an interrupted job without silently replaying calculation on GET", async t => {
  const { service, dataDir } = await setup(t);
  await configure(service); await service.request({ regionKey: "r1" }); await service.waitForIdle(); await service.close();
  const file = path.join(dataDir, "regional_catchment", "state.json"), stored = JSON.parse(await fs.readFile(file, "utf8"));
  const job = Object.values(stored.jobs)[0]; job.status = "running"; job.finishedAt = null;
  await fs.writeFile(file, JSON.stringify(stored));
  let calculations = 0;
  const restarted = createRegionalCatchmentService({ dataDir, resolveRegion, calculate: async () => { calculations++; throw new Error("must not replay"); } });
  t.after(() => restarted.close());
  const view = await restarted.get({ regionKey: "r1" });
  assert.equal(view.status, "stale"); assert.equal(view.job.status, "interrupted"); assert.equal(view.job.errorCode, "CATCHMENT_CALCULATION_INTERRUPTED");
  assert.ok(view.snapshot.resultId); assert.equal(calculations, 0);
});

test("corrupt persisted configuration is rejected without replacing immutable results", async t => {
  const { service, dataDir } = await setup(t);
  await configure(service); await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const prior = await service.get({ regionKey: "r1" }); await service.close();
  const file = path.join(dataDir, "regional_catchment", "state.json"), stored = JSON.parse(await fs.readFile(file, "utf8"));
  Object.values(stored.configurations)[0].center.latitude = 37.5; await fs.writeFile(file, JSON.stringify(stored));
  const restarted = createRegionalCatchmentService({ dataDir, resolveRegion }); t.after(() => restarted.close());
  const view = await restarted.get({ regionKey: "r1" });
  assert.equal(view.storage.errorCode, "CATCHMENT_STORE_INVALID"); assert.equal(view.snapshot, null);
  await assert.rejects(restarted.importDataset(fixture("other")), { code: "CATCHMENT_STORE_INVALID" });
  const preserved = JSON.parse(await fs.readFile(path.join(dataDir, "regional_catchment", "results", `${prior.snapshot.resultId}.json`), "utf8"));
  assert.equal(preserved.rings[2].metrics.population.value, 21);
});

test("tampered result numbers never pass the independently saved content hash", async t => {
  const { service, dataDir } = await setup(t);
  await configure(service); await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const first = await service.get({ regionKey: "r1" });
  const file = path.join(dataDir, "regional_catchment", "results", `${first.snapshot.resultId}.json`), corrupted = structuredClone(first.snapshot);
  corrupted.rings[0].metrics.population.value = 999999; corrupted.rings[0].metrics.population.publishedSum = 999999;
  await fs.writeFile(file, JSON.stringify(corrupted));
  const view = await service.get({ regionKey: "r1" });
  assert.equal(view.status, "failed"); assert.equal(view.snapshot, null); assert.equal(view.storage.errorCode, "CATCHMENT_RESULT_INVALID");
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).rings[0].metrics.population.value, 999999, "GET never repairs or overwrites raw evidence");
});

test("even a matching pointer hash cannot publish a malformed certainty/ring structure", async t => {
  const { service, dataDir } = await setup(t);
  const partial = fixture(); partial.completeFrame = false;
  await configure(service, partial); await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const first = await service.get({ regionKey: "r1" }); await service.close();
  const stateFile = path.join(dataDir, "regional_catchment", "state.json"), originalState = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const resultFile = path.join(dataDir, "regional_catchment", "results", `${first.snapshot.resultId}.json`);
  for (const mutate of [
    result => { result.rings[0].metrics.population.value = 10; result.rings[0].metrics.population.status = "observed_public"; },
    result => { result.rings[0].key = "total100"; },
    result => { result.rings[2].metrics.population.knownCells = 99; },
    result => { result.rings[0].metrics.population.value = -1; }
  ]) {
    const malformed = structuredClone(first.snapshot); mutate(malformed);
    const state = structuredClone(originalState); Object.values(state.pointers)[0].resultSha256 = hash(malformed);
    await fs.writeFile(resultFile, JSON.stringify(malformed)); await fs.writeFile(stateFile, JSON.stringify(state));
    const restarted = createRegionalCatchmentService({ dataDir, resolveRegion });
    const view = await restarted.get({ regionKey: "r1" });
    assert.equal(view.snapshot, null); assert.equal(view.status, "failed"); assert.equal(view.storage.errorCode, "CATCHMENT_RESULT_INVALID");
    await restarted.close();
  }
});

test("corrupt newest revision falls back only to a verified matching center/source revision", async t => {
  const { service, dataDir } = await setup(t);
  await configure(service); await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const first = await service.get({ regionKey: "r1" });
  const firstFile = path.join(dataDir, "regional_catchment", "results", `${first.snapshot.resultId}.json`), firstBytes = await fs.readFile(firstFile);
  await service.configure({ regionKey: "r1", center: { ...center, latitude: 36.6 }, datasetId: "synthetic-v1" });
  await service.request({ regionKey: "r1" }); await service.waitForIdle();
  await service.configure({ regionKey: "r1", center, datasetId: "synthetic-v1" });
  await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const newest = await service.get({ regionKey: "r1" }); assert.notEqual(newest.snapshot.resultId, first.snapshot.resultId);
  const newestFile = path.join(dataDir, "regional_catchment", "results", `${newest.snapshot.resultId}.json`);
  const corrupt = structuredClone(newest.snapshot); corrupt.rings[2].metrics.population.value = 999;
  await fs.writeFile(newestFile, JSON.stringify(corrupt)); await fs.rename(path.join(dataDir, "regional_catchment", "datasets"), path.join(dataDir, "held-source"));
  const fallback = await service.get({ regionKey: "r1" });
  assert.equal(fallback.status, "stale"); assert.equal(fallback.snapshot.resultId, first.snapshot.resultId); assert.equal(fallback.snapshot.rings[2].metrics.population.value, 21);
  assert.equal(fallback.storage.errorCode, "CATCHMENT_RESULT_INVALID"); assert.deepEqual(await fs.readFile(firstFile), firstBytes);
});

test("malformed calculated output fails before publication and preserves prior result bytes", async t => {
  let malformed = false;
  const { service, dataDir } = await setup(t, { calculate: async input => {
    const value = await calculateCatchment(input); if (malformed) value.rings[0].metrics.population.value = Infinity; return value;
  } });
  await configure(service); await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const first = await service.get({ regionKey: "r1" }), folder = path.join(dataDir, "regional_catchment", "results");
  const firstFile = path.join(folder, `${first.snapshot.resultId}.json`), bytes = await fs.readFile(firstFile); malformed = true;
  await service.configure({ regionKey: "r1", center: { ...center, latitude: 36.6 }, datasetId: "synthetic-v1" });
  await service.request({ regionKey: "r1" }); await service.waitForIdle();
  const failed = await service.get({ regionKey: "r1" });
  assert.equal(failed.status, "failed"); assert.equal(failed.job.errorCode, "CATCHMENT_RESULT_INVALID"); assert.equal(failed.snapshot, null);
  assert.deepEqual(await fs.readFile(firstFile), bytes); assert.equal((await fs.readdir(folder)).length, 1);
});

test("inherited object property names cannot be selected as registered datasets", async t => {
  const { service } = await setup(t);
  for (const datasetId of ["__proto__", "constructor", "toString"]) await assert.rejects(service.configure({ regionKey: "r1", center, datasetId }), { code: "CATCHMENT_DATASET_NOT_FOUND" });
  assert.equal((await service.get({ regionKey: "r1" })).status, "unqueried");
});

test("address centers retain administrator provenance, normalized address and company identity in the result fingerprint", async () => {
  const a = normalizeCenter({ ...center, address: "  모의도　모의군   시험로 １０  ", companyId: "company-a" });
  const b = normalizeCenter({ ...center, companyId: "company-b" });
  assert.equal(a.address, center.address); assert.equal(a.addressFingerprint, addressFingerprint(center.address));
  assert.equal(a.kind, "address_reference_point"); assert.equal(a.provenance, "administrator_address_matched");
  const dataset = normalizeDataset(fixture());
  assert.notEqual(inputFingerprint(a, dataset), inputFingerprint(b, dataset));
  const result = await calculateCatchment({ regionKey: "r1", companyId: "company-a", label: "모의", center: a, dataset });
  validateCatchmentResult(result, { regionKey: "r1", companyId: "company-a", center: a, requireResultId: false });
  assert.throws(() => validateCatchmentResult({ ...result, scope: { ...result.scope, companyId: "company-b" } }, { requireResultId: false }), { code: "CATCHMENT_RESULT_INVALID" });
});

test("regional direct-address configuration requires a building or parcel number and accepts detailed road/parcel addresses", async t => {
  const { service } = await setup(t); await service.importDataset(fixture());
  for (const address of ["경기도 수원시 영통구 매탄1동", "경남 산청군 산청읍 웅석봉로285번길"]) {
    await assert.rejects(service.configure({ regionKey: "r1", center: { ...center, address }, datasetId: "synthetic-v1" }), { code: "CATCHMENT_ADDRESS_REQUIRED" });
  }
  assert.equal((await service.get({ regionKey: "r1" })).configuration, null);
  for (const address of ["경남 산청군 산청읍 웅석봉로285번길 80-20", "경기도 수원시 영통구 매탄동 123-4번지", "경남 산청군 산청읍 묵곡리 산 10-2"]) {
    const saved = await service.configure({ regionKey: "r1", center: { ...center, address }, datasetId: "synthetic-v1" });
    assert.equal(saved.configuration.center.address, address); assert.equal(saved.configuration.center.kind, "address_reference_point");
  }
});

test("same-region companies never share results or fall back to the regional address reference", async t => {
  const addresses = new Map([["company-a", center.address], ["company-b", center.address]]);
  const { service, dataDir } = await setup(t, { resolveCompanyAddress: async companyId => addresses.get(companyId) || null });
  await configure(service); await service.request({ regionKey: "r1" }); await service.waitForIdle();
  for (const companyId of addresses.keys()) {
    await service.configure({ regionKey: "r1", companyId, center, datasetId: "synthetic-v1" });
    await service.request({ regionKey: "r1", companyId });
  }
  await service.waitForIdle();
  const a = await service.get({ regionKey: "r1", companyId: "company-a", address: center.address });
  const b = await service.get({ regionKey: "r1", companyId: "company-b", address: center.address });
  const regional = await service.get({ regionKey: "r1" });
  assert.equal(a.status, "ready"); assert.equal(b.status, "ready");
  assert.equal(a.snapshot.scope.companyId, "company-a"); assert.equal(b.snapshot.scope.center.companyId, "company-b");
  assert.notEqual(a.snapshot.sourceFingerprint, b.snapshot.sourceFingerprint);
  assert.notEqual(a.snapshot.resultId, b.snapshot.resultId); assert.notEqual(a.snapshot.resultId, regional.snapshot.resultId);
  const missing = await service.get({ regionKey: "r1", companyId: "company-c", address: center.address });
  assert.equal(missing.status, "unqueried"); assert.equal(missing.snapshot, null); assert.equal(missing.configuration, null);
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, "regional_catchment", "state.json"), "utf8"));
  assert.equal(Object.keys(stored.configurations).length, 3); assert.ok(stored.configurations[hash(["r1", "company-a"])]);
  assert.ok(stored.configurations[hash("r1")]);
});

test("new configuration rejects an absent address, ambiguous company address, mismatched address and changed address during confirmation", async t => {
  let canonical = center.address, calls = 0, changeDuringConfigure = false;
  const { service } = await setup(t, { resolveCompanyAddress: async () => { calls++; return changeDuringConfigure && calls > 1 ? "모의도 모의군 다른로 20" : canonical; } });
  await service.importDataset(fixture());
  const legacy = { ...center }; delete legacy.address;
  await assert.rejects(service.configure({ regionKey: "r1", center: legacy, datasetId: "synthetic-v1" }), { code: "CATCHMENT_ADDRESS_REQUIRED" });
  canonical = null;
  await assert.rejects(service.configure({ regionKey: "r1", companyId: "company-a", center, datasetId: "synthetic-v1" }), { code: "CATCHMENT_COMPANY_ADDRESS_REQUIRED" });
  canonical = "모의도 모의군 다른로 20";
  await assert.rejects(service.configure({ regionKey: "r1", companyId: "company-a", center, datasetId: "synthetic-v1" }), { code: "CATCHMENT_ADDRESS_MISMATCH" });
  canonical = center.address; changeDuringConfigure = true; calls = 0;
  await assert.rejects(service.configure({ regionKey: "r1", companyId: "company-a", center, datasetId: "synthetic-v1" }), { code: "CATCHMENT_ADDRESS_MISMATCH" });
  assert.equal((await service.get({ regionKey: "r1", companyId: "company-a", address: center.address })).configuration, null);
});

test("changed canonical address hides saved company numbers and blocks reuse without changing old evidence", async t => {
  let canonical = center.address, resolverCalls = 0;
  const { service, dataDir } = await setup(t, { resolveCompanyAddress: async companyId => { resolverCalls++; return { companyId, regionKey: "r1", address: canonical }; } });
  await service.importDataset(fixture());
  await service.configure({ regionKey: "r1", companyId: "company-a", center, datasetId: "synthetic-v1" });
  await service.request({ regionKey: "r1", companyId: "company-a" }); await service.waitForIdle();
  const first = await service.get({ regionKey: "r1", companyId: "company-a" });
  const file = path.join(dataDir, "regional_catchment", "results", first.snapshot.resultId + ".json"), bytes = await fs.readFile(file);
  resolverCalls = 0;
  assert.equal((await service.get({ regionKey: "r1", companyId: "company-a", address: "  모의도 모의군  시험로 10 " })).snapshot.resultId, first.snapshot.resultId);
  assert.equal(resolverCalls, 0, "an authoritative monthly address is compared directly without a second master read");
  canonical = "모의도 모의군 이사로 20";
  const changed = await service.get({ regionKey: "r1", companyId: "company-a" });
  assert.equal(changed.snapshot, null); assert.equal(changed.storage.errorCode, "CATCHMENT_ADDRESS_MISMATCH");
  assert.equal((await service.get({ regionKey: "r1", companyId: "company-a", address: canonical })).snapshot, null);
  await assert.rejects(service.request({ regionKey: "r1", companyId: "company-a" }), { code: "CATCHMENT_ADDRESS_MISMATCH" });
  assert.deepEqual(await fs.readFile(file), bytes);
});

test("address changes while a company calculation is running prevent publication", async t => {
  let canonical = center.address, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const { service, dataDir } = await setup(t, { resolveCompanyAddress: async () => canonical,
    calculate: async input => { entered(); await gate; return calculateCatchment(input); } });
  await service.importDataset(fixture());
  await service.configure({ regionKey: "r1", companyId: "company-a", center, datasetId: "synthetic-v1" });
  await service.request({ regionKey: "r1", companyId: "company-a" }); await waiting;
  canonical = "모의도 모의군 이사로 20"; release(); await service.waitForIdle();
  const view = await service.get({ regionKey: "r1", companyId: "company-a" });
  assert.equal(view.snapshot, null); assert.equal(view.job.status, "superseded"); assert.equal(view.job.errorCode, "CATCHMENT_ADDRESS_MISMATCH");
  await assert.rejects(fs.access(path.join(dataDir, "regional_catchment", "results")));
});

test("a company address changing during saved-result reads cannot slip through GET or calculation reuse", async t => {
  let sequence = [];
  const { service } = await setup(t, { resolveCompanyAddress: async () => sequence.length ? sequence.shift() : center.address });
  await service.importDataset(fixture());
  await service.configure({ regionKey: "r1", companyId: "company-a", center, datasetId: "synthetic-v1" });
  await service.request({ regionKey: "r1", companyId: "company-a" }); await service.waitForIdle();
  sequence = [center.address, "모의도 모의군 이사로 20"];
  assert.equal((await service.get({ regionKey: "r1", companyId: "company-a" })).snapshot, null);
  sequence = [center.address, "모의도 모의군 이사로 20"];
  await assert.rejects(service.request({ regionKey: "r1", companyId: "company-a" }), { code: "CATCHMENT_ADDRESS_MISMATCH" });
});

test("legacy regional snapshots remain byte-identical and readable, while address-free new calculation is blocked", async t => {
  const { service, dataDir } = await setup(t);
  const metadata = await service.importDataset(fixture()); await service.close();
  const legacy = { ...center }; delete legacy.address;
  const point = normalizeCenter(legacy), body = normalizeDataset(fixture());
  const result = { ...await calculateCatchment({ regionKey: "r1", label: "합성 r1", center: legacy, dataset: body }), resultId: require("node:crypto").randomUUID() };
  const stateFile = path.join(dataDir, "regional_catchment", "state.json"), stored = JSON.parse(await fs.readFile(stateFile, "utf8"));
  stored.configurations[hash("r1")] = { regionKey: "r1", label: "합성 r1", center: point, datasetId: body.id,
    inputFingerprint: inputFingerprint(point, metadata.dataset), configurationFingerprint: hash(["r1", point, body.id]) };
  stored.pointers[hash("r1")] = { inputFingerprint: result.sourceFingerprint, resultId: result.resultId, resultSha256: hash(result), revisions: [] };
  const resultFile = path.join(dataDir, "regional_catchment", "results", result.resultId + ".json");
  await fs.mkdir(path.dirname(resultFile), { recursive: true }); await fs.writeFile(resultFile, JSON.stringify(result)); await fs.writeFile(stateFile, JSON.stringify(stored));
  const beforeState = await fs.readFile(stateFile), beforeResult = await fs.readFile(resultFile);
  const priorFetch = global.fetch; let networkCalls = 0; global.fetch = async () => { networkCalls++; throw Error("No network allowed"); };
  t.after(() => { global.fetch = priorFetch; });
  const restarted = createRegionalCatchmentService({ dataDir, resolveRegion }); t.after(() => restarted.close());
  const view = await restarted.get({ regionKey: "r1" });
  assert.equal(view.status, "ready"); assert.equal(view.snapshot.scope.center.kind, "declared_reference_point");
  await assert.rejects(restarted.request({ regionKey: "r1" }), { code: "CATCHMENT_ADDRESS_REQUIRED" });
  assert.equal((await restarted.get({ regionKey: "r1", address: center.address })).snapshot, null);
  assert.deepEqual(await fs.readFile(stateFile), beforeState); assert.deepEqual(await fs.readFile(resultFile), beforeResult); assert.equal(networkCalls, 0);
});
