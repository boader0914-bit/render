"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createCollector, monthDateRange, DEMAND_STRENGTH_OPERATIONS,
  RESOURCE_DEMAND_OPERATIONS, DIVERSITY_OPERATIONS
} = require("./tourism_collector.cjs");

const REGION = { regionKey: "fixture_sancheong", sidoKey: "gyeongnam", sido: "경남", sidoFull: "경상남도",
  sigungu: "산청군", ktoSggCd: "48860", aliases: ["산청군", "산청"] };
const MONTH = "202609";
const definitions = [...Object.values(DEMAND_STRENGTH_OPERATIONS), ...Object.values(RESOURCE_DEMAND_OPERATIONS), ...Object.values(DIVERSITY_OPERATIONS)];

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tourism-spatial-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("tourism-spatial-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const regionMapFile = path.join(directory, "regions.json");
  await fs.writeFile(regionMapFile, JSON.stringify({ version: "spatial-fixture-v1", regions: [REGION],
    provinceAliases: { gyeongnam: { ktoSidoCd: "48", aliases: ["경남", "경상남도"] } } }));
  const state = { mode: "normal", requests: 0, failOnRequest: false };
  const collector = createCollector({ rootDir: directory, dataDir: directory, regionMapFile,
    env: { DATA_GO_KR_SERVICE_KEY: "spatial-fixture-only" }, now: () => new Date("2026-10-17T00:00:00Z"),
    fetchImpl: async input => {
      state.requests++;
      assert.equal(state.failOnRequest, false, "Cache-only reads must not request a provider");
      const url = new URL(input), operation = url.pathname.split("/").at(-1);
      let rows;
      if (operation === "locgoRegnVisitrDDList") {
        rows = Array.from({ length: monthDateRange(MONTH).expectedDays }, (_, day) => ["1", "2", "3"].map(category => ({
          baseYmd: `${MONTH}${String(day + 1).padStart(2, "0")}`, signguCode: REGION.ktoSggCd,
          signguNm: REGION.sigungu, touDivCd: category, touDivNm: category, touNum: "0"
        }))).flat();
      } else {
        const definition = definitions.find(item => item.operation === operation);
        assert.ok(definition, `Unexpected operation ${operation}`);
        const requestedCode = url.searchParams.get(definition.codeParam);
        rows = Object.entries(definition.expectedMetrics).filter(([code]) => code === requestedCode).map(([code, label]) => ({
          baseYm: MONTH, areaCd: "48", areaNm: REGION.sidoFull, signguCd: REGION.ktoSggCd, signguNm: REGION.sigungu,
          [definition.codeField]: code, [definition.nameField]: label, [definition.valueField]: "0"
        }));
      }
      if (state.mode === "empty") rows = [];
      if (state.mode === "wrong-code") rows.forEach(row => {
        if (operation === "locgoRegnVisitrDDList") row.signguCode = "48850";
        else row.signguCd = "48850";
      });
      if (state.mode === "wrong-name") rows.forEach(row => { row.signguNm = "하동군"; });
      if (state.mode === "name-only") rows.forEach(row => { delete row.signguCd; });
      if (state.mode === "many-codes" && operation !== "locgoRegnVisitrDDList") {
        const base = rows[0];
        rows = Array.from({ length: 30 }, (_, i) => ({ ...base, signguCd: String(48000 + i) }));
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ response: {
        header: { resultCode: "0000", resultMsg: "OK" }, body: {
          pageNo: 1, numOfRows: 10000, totalCount: rows.length, items: { item: rows }
        }
      } }) };
    }
  });
  const historyInput = { regionKey: REGION.regionKey, regionKeys: [REGION.regionKey], endYearMonth: MONTH, months: 1, collectMissing: true };
  return { collector, state, directory, historyInput };
}

function matched(value) {
  assert.deepEqual(value, { verified: true, regionKey: REGION.regionKey, regionCode: "48860", level: "sigungu",
    mappingStatus: "mapped", observedRegionCodes: ["48860"], reasonCode: "" });
}
function pending(value, reasonCode) {
  assert.ok(value, "A new validated attempt must retain its unverified scope");
  assert.equal(value.verified, false); assert.equal(value.regionCode, ""); assert.equal(value.mappingStatus, "mapped");
  assert.equal(value.regionKey, REGION.regionKey); assert.equal(value.level, "sigungu");
  assert.equal(value.reasonCode, reasonCode);
}
async function histories(f, options = {}) {
  const input = { ...f.historyInput, ...options };
  const visitors = await f.collector.collectVisitorHistory(input);
  const demand = await f.collector.collectDemandStrengthHistory(input);
  const resource = await f.collector.collectResourceDemandHistory(input);
  const diversity = await f.collector.collectDiversityHistory(input);
  return { visitor: visitors.regions[0].series[0], demand: demand.series[0], resource: resource.series[0], diversity: diversity.series[0] };
}

test("raw-validated normal zero retains geographic evidence for every source and cached history", async t => {
  const f = await fixture(t), results = await histories(f);
  assert.equal(results.visitor.averageDailyVisitors, 0); matched(results.visitor.spatialEvidence);
  assert.equal(results.demand.stayOverall, 0); assert.equal(results.demand.spendOverall, 0);
  matched(results.demand.staySpatialEvidence); matched(results.demand.spendSpatialEvidence);
  for (const result of [results.resource, results.diversity]) {
    assert.equal(result.status, "complete");
    for (const operation of Object.values(result.operations)) { assert.equal(operation.overallValue, 0); matched(operation.quality.spatialEvidence); }
  }
  const calls = f.state.requests; f.state.failOnRequest = true;
  const cached = await histories(f, { collectMissing: false });
  assert.equal(f.state.requests, calls);
  matched(cached.visitor.spatialEvidence); matched(cached.demand.staySpatialEvidence); matched(cached.demand.spendSpatialEvidence);
  for (const result of [cached.resource, cached.diversity]) for (const operation of Object.values(result.operations)) matched(operation.quality.spatialEvidence);
});

test("different raw region codes never verify the echoed requested region", async t => {
  const f = await fixture(t); f.state.mode = "wrong-code";
  const result = await histories(f);
  assert.equal(result.visitor.averageDailyVisitors, null); pending(result.visitor.spatialEvidence, "NO_DATA");
  assert.equal(result.demand.stayOverall, null); pending(result.demand.staySpatialEvidence, "REGION_MISMATCH");
  pending(result.demand.spendSpatialEvidence, "REGION_MISMATCH");
  assert.deepEqual(result.demand.staySpatialEvidence.observedRegionCodes, ["48850"]);
  for (const item of [result.resource, result.diversity]) for (const operation of Object.values(item.operations)) {
    pending(operation.quality.spatialEvidence, "REGION_MISMATCH"); assert.deepEqual(operation.quality.spatialEvidence.observedRegionCodes, ["48850"]);
  }
});

test("successful empty responses retain no-data evidence and never become observed zero or unsupported", async t => {
  const f = await fixture(t); f.state.mode = "empty";
  const result = await histories(f);
  assert.equal(result.visitor.averageDailyVisitors, null); pending(result.visitor.spatialEvidence, "NO_DATA");
  assert.equal(result.demand.stayOverall, null); pending(result.demand.staySpatialEvidence, "NO_DATA");
  pending(result.demand.spendSpatialEvidence, "NO_DATA");
  for (const item of [result.resource, result.diversity]) for (const operation of Object.values(item.operations)) {
    assert.equal(operation.overallValue, null); pending(operation.quality.spatialEvidence, "NO_DATA");
  }
  assert.doesNotMatch(JSON.stringify(result), /unsupported/i);
});

test("mapping verification pending is independent of the presence of returned rows", async t => {
  const f = await fixture(t), filename = path.join(f.directory, "regions.json");
  const map = JSON.parse(await fs.readFile(filename, "utf8"));
  map.regions[0].codeStatus = "region_code_verify_required";
  await fs.writeFile(filename, JSON.stringify(map));
  const result = await f.collector.collectVisitorHistory(f.historyInput), evidence = result.regions[0].series[0].spatialEvidence;
  assert.equal(evidence.verified, false); assert.equal(evidence.mappingStatus, "pending");
  assert.equal(evidence.regionCode, ""); assert.equal(evidence.reasonCode, "MAPPING_MISSING");
  assert.deepEqual(evidence.observedRegionCodes, ["48860"]);
});

test("a name-only demand response preserves existing metric semantics but cannot prove its code", async t => {
  const f = await fixture(t); f.state.mode = "name-only";
  const result = await f.collector.collectDemandStrengthHistory(f.historyInput);
  assert.equal(result.series[0].stayOverall, 0);
  pending(result.series[0].staySpatialEvidence, "MAPPING_MISSING"); pending(result.series[0].spendSpatialEvidence, "MAPPING_MISSING");
  assert.deepEqual(result.series[0].staySpatialEvidence.observedRegionCodes, []);
});

test("raw code with a conflicting region name stays unverified for all sources", async t => {
  const f = await fixture(t); f.state.mode = "wrong-name";
  const result = await histories(f);
  pending(result.visitor.spatialEvidence, "REGION_MISMATCH"); pending(result.demand.staySpatialEvidence, "REGION_MISMATCH");
  for (const item of [result.resource, result.diversity]) for (const operation of Object.values(item.operations)) pending(operation.quality.spatialEvidence, "REGION_MISMATCH");
});

test("observed raw code diagnostics remain bounded and cannot verify mixed geographic scope", async t => {
  const f = await fixture(t); f.state.mode = "many-codes";
  const result = await f.collector.collectDemandStrengthHistory(f.historyInput);
  const evidence = result.series[0].staySpatialEvidence;
  pending(evidence, "REGION_MISMATCH"); assert.equal(evidence.observedRegionCodes.length, 16);
  assert.ok(evidence.observedRegionCodes.every(code => /^\d{5}$/.test(code)));
});

test("legacy caches stay readable without inventing geographic evidence or requesting providers", async t => {
  const f = await fixture(t); await histories(f);
  const cacheDirectory = path.join(f.directory, "tourism_data", "cache");
  for (const file of await fs.readdir(cacheDirectory)) {
    if (!file.endsWith(".json")) continue;
    const filename = path.join(cacheDirectory, file), value = JSON.parse(await fs.readFile(filename, "utf8"));
    await fs.writeFile(filename, JSON.stringify(value, (key, item) => key === "spatialEvidence" ? undefined : item));
  }
  f.state.failOnRequest = true;
  const cached = await histories(f, { collectMissing: false });
  assert.equal(cached.visitor.averageDailyVisitors, 0); assert.equal(cached.demand.stayOverall, 0);
  assert.equal(Object.hasOwn(cached.visitor, "spatialEvidence"), false);
  assert.equal(Object.hasOwn(cached.demand, "staySpatialEvidence"), false);
  assert.equal(Object.hasOwn(cached.demand, "spendSpatialEvidence"), false);
  for (const item of [cached.resource, cached.diversity]) for (const operation of Object.values(item.operations)) assert.equal(Object.hasOwn(operation.quality, "spatialEvidence"), false);
});

test("a newly fetched complete visitor response can add raw proof to an existing legacy cache", async t => {
  const f = await fixture(t); await f.collector.collectVisitorHistory(f.historyInput);
  const cacheDirectory = path.join(f.directory, "tourism_data", "cache");
  const file = (await fs.readdir(cacheDirectory)).find(name => name.startsWith("visitors__"));
  const filename = path.join(cacheDirectory, file), value = JSON.parse(await fs.readFile(filename, "utf8"));
  await fs.writeFile(filename, JSON.stringify(value, (key, item) => key === "spatialEvidence" ? undefined : item));
  const before = f.state.requests;
  const result = await f.collector.collectVisitorHistory({ ...f.historyInput, force: true });
  assert.ok(f.state.requests > before); matched(result.regions[0].series[0].spatialEvidence);
  const stored = JSON.parse(await fs.readFile(filename, "utf8")); matched(stored.allRegions[0].quality.spatialEvidence);
});
