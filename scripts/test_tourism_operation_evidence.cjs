"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createCollector, DEMAND_STRENGTH_OPERATIONS, RESOURCE_DEMAND_OPERATIONS, DIVERSITY_OPERATIONS } = require("./tourism_collector.cjs");
const { createRegionalResponseEvidenceStore } = require("./lib/regional_response_evidence.cjs");
const { operationIdentity, OPERATION_KIND } = require("./lib/tourism_stored_spatial_evidence.cjs");
const { createRegionalAnalysisSnapshotBuilder } = require("./lib/regional_analysis_snapshot.cjs");
const { storedEvidenceSummary } = require("../web/regional-data-contract.js");
const MONTH = "202609", REGION = { regionKey: "fixture_new_area", sigungu: "새로운군", ktoSggCd: "48001", sidoKey: "gyeongnam", sido: "경남", sidoFull: "경상남도" };
const DEFINITIONS = { demandStrength: DEMAND_STRENGTH_OPERATIONS, resourceDemand: RESOURCE_DEMAND_OPERATIONS, diversity: DIVERSITY_OPERATIONS };
const SOURCE = { demandStrength: "collectDemandStrength", resourceDemand: "collectResourceDemand", diversity: "collectDiversity" };
const HISTORY = { demandStrength: "collectDemandStrengthHistory", resourceDemand: "collectResourceDemandHistory", diversity: "collectDiversityHistory" };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(t, { multiPage = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tourism-operation-evidence-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("tourism-operation-evidence-")); await fs.rm(directory, { recursive: true, force: true }); });
  const regionMapFile = path.join(directory, "regions.json"), tourismDataDir = path.join(directory, "tourism_data");
  await fs.writeFile(regionMapFile, JSON.stringify({ version: "raw-operation-fixture-v1", regions: [REGION],
    provinceAliases: { gyeongnam: { ktoSidoCd: "48", aliases: ["경남", "경상남도"] } } }));
  const now = () => new Date("2026-10-17T00:00:00Z"), store = createRegionalResponseEvidenceStore({ directory: tourismDataDir, now });
  const state = { requests: 0, reads: 0, writes: 0, failWrite: false, forbiddenNetwork: false, value: 0, secretRow: false };
  const responseEvidenceStore = { write: async input => { state.writes++; if (state.failWrite) throw Object.assign(new Error("fixture"), { code: "EVIDENCE_WRITE_ERROR" }); return store.write(input); },
    read: async (...args) => { state.reads++; return store.read(...args); } };
  const env = { DATA_GO_KR_SERVICE_KEY: "fixture-private-provider-key", KTO_TOURISM_DEMAND_STRENGTH_PAGE_SIZE: "10",
    KTO_TOURISM_RESOURCE_DEMAND_PAGE_SIZE: "10", KTO_TOURISM_DIVERSITY_PAGE_SIZE: "10" };
  const collector = createCollector({ dataDir: directory, rootDir: directory, regionMapFile, env, now, responseEvidenceStore,
    fetchImpl: async input => {
      state.requests++; assert.equal(state.forbiddenNetwork, false, "A saved-read must never request a provider");
      const url = new URL(input), operationName = url.pathname.split("/").at(-1);
      const sourceKey = Object.keys(DEFINITIONS).find(source => Object.values(DEFINITIONS[source]).some(def => def.operation === operationName));
      assert.ok(sourceKey);
      const definition = Object.values(DEFINITIONS[sourceKey]).find(def => def.operation === operationName), requestedCode = url.searchParams.get(definition.codeParam);
      let rows = Object.entries(definition.expectedMetrics).filter(([code]) => sourceKey === "demandStrength" || code === requestedCode)
        .flatMap(([code, label]) => Array.from({ length: multiPage ? sourceKey === "demandStrength" ? 3 : 11 : 1 }, () => ({
          baseYm: MONTH, areaCd: "48", areaNm: "경상남도", signguCd: REGION.ktoSggCd, signguNm: REGION.sigungu,
          [definition.codeField]: code, [definition.nameField]: label, [definition.valueField]: String(state.value),
          ...(state.secretRow ? { serviceKey: env.DATA_GO_KR_SERVICE_KEY } : {})
        })));
      const totalCount = rows.length, pageNo = Number(url.searchParams.get("pageNo")), numOfRows = Number(url.searchParams.get("numOfRows"));
      rows = rows.slice((pageNo - 1) * numOfRows, pageNo * numOfRows);
      return { ok: true, status: 200, text: async () => JSON.stringify({ response: { header: { resultCode: "0000", resultMsg: "OK" },
        body: { pageNo, numOfRows, totalCount, items: { item: rows } } } }) };
    } });
  async function collect(sourceKey, force = false) { return collector[SOURCE[sourceKey]]({ yearMonth: MONTH, regionKey: REGION.regionKey, force }); }
  async function history(sourceKey, restoreStoredEvidence = true) { return collector[HISTORY[sourceKey]]({ endYearMonth: MONTH, months: 1,
    regionKey: REGION.regionKey, collectMissing: false, restoreStoredEvidence }); }
  async function cache(sourceKey) {
    const files = await fs.readdir(path.join(tourismDataDir, "cache"));
    for (const filename of files) {
      const file = path.join(tourismDataDir, "cache", filename), value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.adapter === { demandStrength: "area-tar-dem-ds-v1", resourceDemand: "area-tar-res-dem-v3", diversity: "area-tar-div-v3" }[sourceKey]) return { file, value };
    }
    throw new Error("No source cache");
  }
  async function editCache(sourceKey, mutation) { const saved = await cache(sourceKey); await mutation(saved.value); await fs.writeFile(saved.file, JSON.stringify(saved.value)); return saved; }
  async function removeProof(sourceKey) { return editCache(sourceKey, snapshot => { for (const op of Object.values(snapshot.operations)) delete op.quality.spatialEvidence; }); }
  async function changeOriginal(sourceKey, key, mutation) {
    return editCache(sourceKey, async snapshot => {
      const operation = snapshot.operations[key], identity = operationIdentity({ sourceKey, adapter: snapshot.adapter, yearMonth: MONTH,
        region: REGION, operation: DEFINITIONS[sourceKey][key].operation });
      const original = await store.read(operation.rawResponseEvidence, { kind: OPERATION_KIND, identity });
      mutation(original.payload.response);
      operation.rawResponseEvidence = await store.write({ kind: OPERATION_KIND, identity, response: original.payload.response });
      delete operation.quality.spatialEvidence;
    });
  }
  return { directory, tourismDataDir, state, collector, store, collect, history, cache, editCache, removeProof, changeOriginal };
}
function operationFromHistory(sourceKey, history, key) {
  const point = history.series[0];
  return sourceKey === "demandStrength" ? { value: point[key === "stay" ? "stayOverall" : "spendOverall"],
    proof: point[key === "stay" ? "staySpatialEvidence" : "spendSpatialEvidence"],
    diagnostic: point[key === "stay" ? "stayStoredEvidenceVerification" : "spendStoredEvidenceVerification"] }
    : { value: point.operations[key].overallValue, proof: point.operations[key].quality.spatialEvidence,
      diagnostic: point.operations[key].quality.storedEvidenceVerification };
}

test("all seven operations retain exact paged response fields and restore real normal zero without another API call", async t => {
  const f = await fixture(t, { multiPage: true });
  for (const sourceKey of Object.keys(SOURCE)) {
    const result = await f.collect(sourceKey); assert.equal(result.status, "ok");
    const saved = await f.cache(sourceKey);
    for (const [key, operation] of Object.entries(saved.value.operations)) {
      assert.equal(operation.rawResponseEvidence.status, "stored"); assert.equal(operation.quality.responseEvidenceStorage.status, "stored");
      assert.equal(operation.overallValue, 0);
      const identity = operationIdentity({ sourceKey, adapter: saved.value.adapter, yearMonth: MONTH, region: REGION, operation: DEFINITIONS[sourceKey][key].operation });
      const raw = await f.store.read(operation.rawResponseEvidence, { kind: OPERATION_KIND, identity });
      assert.ok(raw.payload.response.queries.every(query => query.pages.length >= 2));
      assert.equal(JSON.stringify(raw.payload).includes("fixture-private-provider-key"), false);
      assert.equal(JSON.stringify(raw.payload).includes("https://"), false);
      assert.equal(Object.hasOwn(operation, "_evidenceQuery"), false);
    }
    await f.removeProof(sourceKey);
  }
  const requests = f.state.requests; f.state.forbiddenNetwork = true;
  for (const sourceKey of Object.keys(SOURCE)) {
    const saved = await f.cache(sourceKey), before = sha(await fs.readFile(saved.file));
    const result = await f.history(sourceKey);
    for (const key of Object.keys(DEFINITIONS[sourceKey])) {
      const observed = operationFromHistory(sourceKey, result, key);
      assert.equal(observed.value, 0); assert.equal(observed.proof.verified, true); assert.equal(observed.diagnostic.status, "restored");
      assert.equal(observed.proof.storedProvenance.period, "2026-09"); assert.ok(observed.proof.storedProvenance.checks.includes("complete_response_pages"));
    }
    assert.equal(sha(await fs.readFile(saved.file)), before);
  }
  assert.equal(f.state.requests, requests);
});

test("normal reads do no raw inspection; normalized legacy caches without original references are never promoted", async t => {
  const f = await fixture(t); await f.collect("resourceDemand"); await f.removeProof("resourceDemand");
  f.state.forbiddenNetwork = true;
  await f.history("resourceDemand", false); assert.equal(f.state.reads, 0);
  await f.editCache("resourceDemand", snapshot => { for (const op of Object.values(snapshot.operations)) delete op.rawResponseEvidence; });
  const result = await f.history("resourceDemand");
  for (const key of ["service", "culture"]) { const op = operationFromHistory("resourceDemand", result, key);
    assert.equal(op.value, 0); assert.equal(op.proof, undefined); assert.equal(op.diagnostic.status, "pending"); }
  assert.equal(f.state.reads, 0);
});

for (const [label, mutation, reason] of [
  ["wrong region", raw => { raw.queries[0].pages[0].rows[0].signguCd = "48002"; }, "TOURISM_ORIGINAL_REGION_MISMATCH"],
  ["wrong name", raw => { raw.queries[0].pages[0].rows[0].signguNm = "다른군"; }, "TOURISM_ORIGINAL_REGION_MISMATCH"],
  ["wrong month", raw => { raw.queries[0].pages[0].rows[0].baseYm = "202608"; }, "TOURISM_ORIGINAL_PERIOD_MISMATCH"],
  ["missing page", raw => { raw.queries[0].pages.pop(); }, "TOURISM_ORIGINAL_PAGE_INCOMPLETE"],
  ["conflicting total", raw => { raw.queries[0].pages[1].totalCount++; }, "TOURISM_ORIGINAL_PAGE_INCOMPLETE"],
  ["bad API code", raw => { raw.queries[0].pages[0].apiCode = "99"; }, "TOURISM_ORIGINAL_RESPONSE_FAILED"],
  ["blocked HTTP", raw => { raw.queries[0].pages[0].httpStatus = 403; }, "TOURISM_ORIGINAL_RESPONSE_FAILED"],
  ["missing is not zero", raw => { delete raw.queries[0].pages[0].rows[0].tarSvcDemIxVal; }, "TOURISM_ORIGINAL_VALUE_INVALID"],
  ["wrong metric code", raw => { raw.queries[0].pages[0].rows[0].tarSvcDemIxCd = "invalid"; }, "TOURISM_ORIGINAL_METRIC_CODE_MISMATCH"],
  ["conflicting duplicate", raw => { raw.queries[0].pages[0].rows[1].tarSvcDemIxVal = "1"; }, "TOURISM_ORIGINAL_METRICS_INVALID"]
]) test(`original ${label} cannot lend scope proof to a normal scalar`, async t => {
  const f = await fixture(t, { multiPage: true }); await f.collect("resourceDemand");
  await f.changeOriginal("resourceDemand", "service", mutation); f.state.forbiddenNetwork = true;
  const result = await f.history("resourceDemand"), observed = operationFromHistory("resourceDemand", result, "service");
  assert.equal(observed.value, 0); assert.equal(observed.proof.verified, false);
  assert.equal(observed.diagnostic.status, "rejected"); assert.equal(observed.diagnostic.reasonCode, reason);
});

test("original values and normalized values must agree, even with a valid content hash", async t => {
  const f = await fixture(t); await f.collect("demandStrength");
  await f.changeOriginal("demandStrength", "stay", raw => { raw.queries[0].pages[0].rows[0].tarSjrnDsIxVal = "17"; });
  const result = operationFromHistory("demandStrength", await f.history("demandStrength"), "stay");
  assert.equal(result.value, 0); assert.equal(result.diagnostic.reasonCode, "TOURISM_STORED_VALUES_MISMATCH");
});

test("a missing referenced original stays pending and cannot reuse an older verified flag", async t => {
  const f = await fixture(t); await f.collect("demandStrength");
  const saved = await f.cache("demandStrength"), reference = saved.value.operations.stay.rawResponseEvidence;
  await fs.unlink(path.join(f.tourismDataDir, reference.relativePath));
  f.state.forbiddenNetwork = true;
  const observed = operationFromHistory("demandStrength", await f.history("demandStrength"), "stay");
  assert.equal(observed.value, 0); assert.equal(observed.diagnostic.status, "pending");
  assert.equal(observed.diagnostic.reasonCode, "EVIDENCE_NOT_FOUND"); assert.equal(observed.proof.verified, false);
});

test("a tampered original is rejected even if normalized cache already had a verified scope", async t => {
  const f = await fixture(t); await f.collect("demandStrength");
  const saved = await f.cache("demandStrength"), file = path.join(f.tourismDataDir, saved.value.operations.stay.rawResponseEvidence.relativePath);
  const bytes = await fs.readFile(file, "utf8"); assert.ok(bytes.includes('"tarSjrnDsIxVal":"0"'));
  await fs.writeFile(file, bytes.replace('"tarSjrnDsIxVal":"0"', '"tarSjrnDsIxVal":"1"'));
  const observed = operationFromHistory("demandStrength", await f.history("demandStrength"), "stay");
  assert.equal(observed.value, 0); assert.equal(observed.diagnostic.status, "rejected");
  assert.equal(observed.diagnostic.reasonCode, "EVIDENCE_HASH_MISMATCH"); assert.equal(observed.proof.verified, false);
});

test("another month or operation's valid raw reference cannot be borrowed", async t => {
  const f = await fixture(t); await f.collect("demandStrength");
  await f.editCache("demandStrength", snapshot => { snapshot.operations.stay.rawResponseEvidence = snapshot.operations.spend.rawResponseEvidence; });
  const observed = operationFromHistory("demandStrength", await f.history("demandStrength"), "stay");
  assert.equal(observed.value, 0); assert.equal(observed.diagnostic.reasonCode, "EVIDENCE_IDENTITY_MISMATCH");
  assert.equal(observed.proof.verified, false);
});

test("identical response archives share immutable identity without replacing stored originals", async t => {
  const f = await fixture(t); await f.collect("demandStrength");
  const saved = await f.cache("demandStrength"), before = new Map();
  for (const op of Object.values(saved.value.operations)) {
    const file = path.join(f.tourismDataDir, op.rawResponseEvidence.relativePath);
    before.set(op.rawResponseEvidence.evidenceId, { hash: sha(await fs.readFile(file)), stat: await fs.stat(file) });
  }
  await f.collect("demandStrength", true);
  for (const op of Object.values((await f.cache("demandStrength")).value.operations)) {
    const original = before.get(op.rawResponseEvidence.evidenceId); assert.ok(original);
    const file = path.join(f.tourismDataDir, op.rawResponseEvidence.relativePath), stat = await fs.stat(file);
    assert.equal(sha(await fs.readFile(file)), original.hash); assert.equal(stat.ino, original.stat.ino); assert.equal(stat.mtimeMs, original.stat.mtimeMs);
  }
});

test("archive write failures preserve an existing complete cache with no automatic retry", async t => {
  const f = await fixture(t);
  for (const sourceKey of Object.keys(SOURCE)) await f.collect(sourceKey);
  f.state.failWrite = true; f.state.value = 77;
  for (const sourceKey of Object.keys(SOURCE)) {
    const saved = await f.cache(sourceKey), before = sha(await fs.readFile(saved.file)), requests = f.state.requests;
    const result = await f.collect(sourceKey, true);
    assert.equal(result.cache.hit, true); assert.equal(result.cache.refreshFailed, true); assert.equal(result.cache.refreshReason, "response_evidence_storage_failed");
    assert.equal(sha(await fs.readFile(saved.file)), before);
    assert.equal(f.state.requests - requests, sourceKey === "demandStrength" ? 2 : Object.values(DEFINITIONS[sourceKey]).reduce((n, def) => n + Object.keys(def.expectedMetrics).length, 0));
  }
});

test("a first collection can retain valid values while distinguishing archive failure from provider failure", async t => {
  const f = await fixture(t); f.state.failWrite = true;
  const result = await f.collect("demandStrength");
  assert.equal(result.status, "ok"); assert.equal(result.stay.overallValue, 0);
  assert.equal(result.stay.rawResponseEvidence.status, "not_stored");
  assert.deepEqual(result.stay.quality.responseEvidenceStorage, { status: "failed", reasonCode: "EVIDENCE_WRITE_ERROR" });
});

test("initial archive failures remain explicit in each source's history points", async t => {
  const f = await fixture(t); f.state.failWrite = true;
  for (const sourceKey of Object.keys(SOURCE)) {
    const result = await f.collector[HISTORY[sourceKey]]({ endYearMonth: MONTH, months: 1,
      regionKey: REGION.regionKey, collectMissing: true });
    const point = result.series[0]; assert.equal(point.status, "complete");
    for (const key of Object.keys(DEFINITIONS[sourceKey])) {
      const storage = sourceKey === "demandStrength" ? point[key === "stay" ? "stayResponseEvidenceStorage" : "spendResponseEvidenceStorage"]
        : point.operations[key].quality.responseEvidenceStorage;
      assert.deepEqual(storage, { status: "failed", reasonCode: "EVIDENCE_WRITE_ERROR" });
      assert.equal(operationFromHistory(sourceKey, result, key).value, 0);
    }
  }
});

test("first archive failure stays pending through an actual collector, saved history restore and public snapshot while native zero remains normal", async t => {
  const f = await fixture(t); f.state.failWrite = true;
  for (const sourceKey of Object.keys(SOURCE)) await f.collect(sourceKey);
  f.state.forbiddenNetwork = true;
  for (const sourceKey of Object.keys(SOURCE)) {
    const restored = await f.history(sourceKey);
    for (const key of Object.keys(DEFINITIONS[sourceKey])) {
      const point = operationFromHistory(sourceKey, restored, key);
      assert.equal(point.proof.verified, true, "The actual successful provider response still proves its native scope");
      assert.equal(point.proof.storedProvenance, undefined, "An archive write failure cannot invent stored raw proof");
      assert.equal(point.diagnostic.status, "pending"); assert.equal(point.diagnostic.reasonCode, "EVIDENCE_WRITE_ERROR");
      assert.equal(point.value, 0);
    }
  }
  const snapshot = await createRegionalAnalysisSnapshotBuilder({ tourismCollector: f.collector,
    kosisService: { getRegion: async () => null }, searchTrendService: { get: async () => null },
    resolveRegion: async () => ({ ...REGION, level: "local", officialCode: "4800100000", unitType: "county", active: true, selectable: true }),
    now: () => new Date("2026-10-17T00:00:00Z") })({ regionKey: REGION.regionKey, month: "2026-09", months: 13 }, { collectMissing: false });
  const groups = snapshot.groups.filter(group => ["demandStrength", "resourceDemand", "diversity"].includes(group.key));
  assert.equal(groups.length, 3);
  const latest = groups.flatMap(group => group.metrics.map(metric => metric.rows.find(row => row.period === "2026-09")));
  assert.equal(latest.length, 7);
  for (const row of latest) {
    assert.equal(row.status, "observed"); assert.equal(row.value, 0); assert.equal(row.spatialContract.status, "matched");
    assert.equal(row.refreshErrorCode, "EVIDENCE_WRITE_ERROR");
    assert.equal(row.storedEvidenceVerification.status, "pending"); assert.equal(row.storedEvidenceVerification.reasonCode, "EVIDENCE_WRITE_ERROR");
    const summary = storedEvidenceSummary(row.spatialContract, row.storedEvidenceVerification);
    assert.ok(summary.reason.includes("보관하지 못했습니다"));
  }
  assert.equal(snapshot.storedEvidence.restored, 0); assert.ok(snapshot.storedEvidence.pending >= 7);
});

test("legacy native response proof without any known archive failure remains compatible", async t => {
  const f = await fixture(t); await f.collect("demandStrength");
  await f.editCache("demandStrength", snapshot => { for (const operation of Object.values(snapshot.operations)) {
    delete operation.rawResponseEvidence; delete operation.quality.responseEvidenceStorage;
  } });
  const point = operationFromHistory("demandStrength", await f.history("demandStrength"), "stay");
  assert.equal(point.value, 0); assert.equal(point.proof.verified, true); assert.equal(point.diagnostic.status, "already_verified");
});

test("a failed archive refresh keeps its reason on the returned history but leaves the old source cache unchanged", async t => {
  const f = await fixture(t);
  for (const sourceKey of Object.keys(SOURCE)) await f.collect(sourceKey);
  f.state.failWrite = true; f.state.value = 13;
  for (const sourceKey of Object.keys(SOURCE)) {
    const saved = await f.cache(sourceKey), before = sha(await fs.readFile(saved.file));
    const result = await f.collector[HISTORY[sourceKey]]({ endYearMonth: MONTH, months: 1,
      regionKey: REGION.regionKey, collectMissing: true, force: true });
    assert.equal(result.series[0].refreshFailed, true);
    assert.equal(result.series[0].refreshReason, "response_evidence_storage_failed");
    assert.equal(sha(await fs.readFile(saved.file)), before);
    f.state.forbiddenNetwork = true;
    const reread = await f.history(sourceKey);
    assert.equal(reread.series[0].refreshFailed, false);
    assert.equal(reread.series[0].refreshReason, "");
    for (const key of Object.keys(DEFINITIONS[sourceKey])) assert.equal(operationFromHistory(sourceKey, reread, key).value, 0);
    f.state.forbiddenNetwork = false;
  }
});

test("provider secrets are rejected from the archive and cannot overwrite a complete cache", async t => {
  const f = await fixture(t); await f.collect("diversity"); const saved = await f.cache("diversity"), before = sha(await fs.readFile(saved.file));
  f.state.secretRow = true; f.state.value = 3;
  const result = await f.collect("diversity", true);
  assert.equal(result.cache.refreshReason, "response_evidence_storage_failed"); assert.equal(sha(await fs.readFile(saved.file)), before);
  const files = await fs.readdir(path.join(f.tourismDataDir, "evidence", "responses", OPERATION_KIND));
  for (const file of files) assert.equal((await fs.readFile(path.join(f.tourismDataDir, "evidence", "responses", OPERATION_KIND, file), "utf8")).includes("fixture-private-provider-key"), false);
});
