"use strict";

// Synthetic new regions exercise real provider parsers, immutable archives,
// restarted caches, saved snapshots and the browser's common-period model.
// No request leaves this test: every authorized refresh uses a local fixture.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createCollector, DEMAND_STRENGTH_OPERATIONS, RESOURCE_DEMAND_OPERATIONS, DIVERSITY_OPERATIONS } = require("./tourism_collector.cjs");
const { createKosisService, DEFINITIONS } = require("./lib/kosis.cjs");
const { createRegionalAnalysisSnapshotBuilder } = require("./lib/regional_analysis_snapshot.cjs");
const { createRegionalAnalysisStore } = require("./lib/regional_analysis_store.cjs");
const { comparisonModel } = require("../web/regional-comparison.js");

const MONTH = "2026-09";
const SOURCE_MONTH = "202609";
const TOURISM_DEFINITIONS = { demandStrength: DEMAND_STRENGTH_OPERATIONS, resourceDemand: RESOURCE_DEMAND_OPERATIONS, diversity: DIVERSITY_OPERATIONS };
const OPERATION_KEYS = Object.entries(TOURISM_DEFINITIONS).flatMap(([source, definitions]) => Object.keys(definitions).map(key => `${source}:${key}`));
const EXPECTED_REQUESTS = 2 * (2 + Object.values(RESOURCE_DEMAND_OPERATIONS).reduce((sum, definition) => sum + Object.keys(definition.expectedMetrics).length, 0)
  + Object.values(DIVERSITY_OPERATIONS).reduce((sum, definition) => sum + Object.keys(definition.expectedMetrics).length, 0) + DEFINITIONS.length * 2);
const FLOW_EXPECTED = {
  "demandStrength\u0000stayOverall": [0, 37], "demandStrength\u0000spendOverall": [5, 42],
  "resourceDemand\u0000service": [10, 47], "resourceDemand\u0000culture": [15, 52],
  "diversity\u0000visitor": [20, 57], "diversity\u0000spend": [25, 62], "diversity\u0000international": [30, 67]
};
const PROVINCE_ID = "kr_admin_4800000000";
const REGIONS = [
  { regionKey: "fixture_new_alpha", regionId: "kr_admin_4800100000", officialCode: "4800100000", name: "가상신규군", unitType: "county", ktoSggCd: "48001", industryCode: "38301" },
  { regionKey: "fixture_new_beta", regionId: "kr_admin_4800200000", officialCode: "4800200000", name: "가상미래시", unitType: "city", ktoSggCd: "48002", industryCode: "38302" }
];
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));

async function digestTree(root) {
  const files = {};
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else files[path.relative(root, file)] = hash(await fs.readFile(file));
    }
  }
  await walk(root);
  return files;
}

async function assertNoOriginalIO(operation) {
  const methods = ["readFile", "open", "lstat", "stat", "realpath"], originals = new Map(), attempted = [];
  for (const method of methods) {
    const original = fs[method]; originals.set(method, original);
    fs[method] = function (filename, ...args) {
      if (typeof filename === "string" && /(?:^|[\\/])evidence(?:[\\/]|$)/.test(filename)) attempted.push({ method, filename });
      return original.call(this, filename, ...args);
    };
  }
  try { await operation(); }
  finally { for (const [method, original] of originals) fs[method] = original; }
  assert.deepEqual(attempted, [], "Normal provider and saved-result GETs must not even inspect an original path");
}

function kosisValue(definition, metric, breakdown, region) {
  if (region === REGIONS[0]) return 0;
  if (definition.key === "population") return { T20: 12, T21: 5, T22: 7 }[metric.id];
  if (definition.key === "households") return 8;
  if (definition.key === "age_population") return breakdown.id === "0" ? 12 : breakdown.id === "5" ? 5 : breakdown.id === "10" ? 7 : 0;
  if (definition.key === "employment") return { T001: 9, T002: 4, T003: 5 }[metric.id];
  return { establishments: 3, manufacturing_establishments: 1, manufacturing_employment: 2 }[definition.key];
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "regional-provider-integration-"));
  let store;
  t.after(async () => {
    if (store) await store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("regional-provider-integration-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const tourismDataDir = path.join(directory, "tourism_data");
  const kosisDataDir = path.join(directory, "history", "kosis");
  const regionMapFile = path.join(directory, "tourism-regions.json");
  const regionMasterFile = path.join(directory, "region-master.json");
  const units = [{ regionKey: PROVINCE_ID, regionId: PROVINCE_ID, provinceRegionId: PROVINCE_ID,
    name: "경상남도", level: "broad", active: true }, ...REGIONS.map(region => ({ ...region,
    fullName: `경상남도 ${region.name}`, label: `경상남도 ${region.name}`, level: "local", active: true, selectable: true,
    provinceRegionId: PROVINCE_ID, sidoFull: "경상남도", providerMappings: { kto: { ktoSggCd: region.ktoSggCd } }
  }))];
  await fs.writeFile(regionMasterFile, JSON.stringify({ units }));
  await fs.writeFile(regionMapFile, JSON.stringify({ version: "new-provider-regions-v1", regions: REGIONS.map(region => ({
    regionKey: region.regionKey, sigungu: region.name, ktoSggCd: region.ktoSggCd, sidoKey: "gyeongnam", sido: "경남", sidoFull: "경상남도"
  })), provinceAliases: { gyeongnam: { ktoSidoCd: "48", aliases: ["경남", "경상남도"] } } }));
  const state = { requests: 0, forbidden: false, builds: 0, clock: Date.parse("2026-10-17T00:00:00Z") };
  const now = () => new Date(state.clock);
  const resolveRegion = async key => clone(units.find(region => region.regionKey === key) || null);
  const denyRequest = async () => { state.requests++; assert.fail("A cache/snapshot/read operation attempted an external request"); };
  const response = value => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });

  function newTourismCollector(fetchImpl = denyRequest) {
    return createCollector({ rootDir: directory, dataDir: directory, regionMapFile, now,
      env: { DATA_GO_KR_SERVICE_KEY: "fixture-tourism-private-key" }, fetchImpl });
  }
  function newKosisService(fetchImpl = denyRequest) {
    return createKosisService({ dataDir: kosisDataDir, regionMasterFile, readApiKey: () => "fixture-kosis-private-key",
      now: () => state.clock, sleep: async ms => { state.clock += ms; }, fetchImpl });
  }

  const tourism = newTourismCollector(async input => {
    state.requests++; assert.equal(state.forbidden, false);
    const url = new URL(input), region = REGIONS.find(item => item.ktoSggCd === url.searchParams.get("signguCd"));
    const sourceKey = Object.keys(TOURISM_DEFINITIONS).find(key => Object.values(TOURISM_DEFINITIONS[key]).some(item => item.operation === url.pathname.split("/").at(-1)));
    const definition = sourceKey && Object.values(TOURISM_DEFINITIONS[sourceKey]).find(item => item.operation === url.pathname.split("/").at(-1));
    assert.ok(region && definition);
    assert.equal(url.searchParams.get("baseYm"), SOURCE_MONTH);
    const value = OPERATION_KEYS.indexOf(`${sourceKey}:${definition.key}`) * 5 + (region === REGIONS[0] ? 0 : 37);
    const rows = Object.entries(definition.expectedMetrics).filter(([code]) => sourceKey === "demandStrength" || code === url.searchParams.get(definition.codeParam)).map(([code, label]) => ({ baseYm: SOURCE_MONTH,
      areaCd: "48", areaNm: "경상남도", signguCd: region.ktoSggCd, signguNm: region.name,
      [definition.codeField]: code, [definition.nameField]: label, [definition.valueField]: String(value) }));
    return response({ response: { header: { resultCode: "0000", resultMsg: "OK" }, body: {
      pageNo: Number(url.searchParams.get("pageNo")), numOfRows: Number(url.searchParams.get("numOfRows")),
      totalCount: rows.length, items: { item: rows }
    } } });
  });
  const kosis = newKosisService(async input => {
    state.requests++; assert.equal(state.forbidden, false);
    const url = new URL(input), definition = DEFINITIONS.find(item => item.tableId === url.searchParams.get("tblId"));
    assert.ok(definition);
    const provinceCode = definition.regionObject === "SGG" ? "38" : "48";
    const codeOf = region => definition.regionObject === "SGG" ? region.industryCode : region.ktoSggCd;
    if (url.searchParams.get("method") === "getMeta") return response([
      ...definition.metrics.map(metric => ({ OBJ_ID: "ITEM", ITM_ID: metric.id, ITM_NM: metric.label, UNIT_NM: metric.unit })),
      { OBJ_ID: definition.regionObject, OBJ_ID_SN: 1, ITM_ID: provinceCode, ITM_NM: "경상남도", UP_ITM_ID: "00" },
      ...REGIONS.map(region => ({ OBJ_ID: definition.regionObject, OBJ_ID_SN: 1, ITM_ID: codeOf(region), ITM_NM: region.name, UP_ITM_ID: provinceCode })),
      ...(definition.breakdowns || []).map(item => ({ OBJ_ID: definition.breakdownObject, OBJ_ID_SN: 2, ITM_ID: item.id, ITM_NM: item.metadataName }))
    ]);
    const region = REGIONS.find(item => codeOf(item) === url.searchParams.get("objL1"));
    assert.ok(region);
    return response(definition.metrics.flatMap(metric => (definition.breakdowns || [null]).map(breakdown => ({
      TBL_ID: definition.tableId, ORG_ID: definition.orgId, ITM_ID: metric.id, C1: codeOf(region),
      ...(breakdown ? { C2: breakdown.id } : {}), PRD_SE: definition.periodType === "Y" ? "A" : "M",
      PRD_DE: definition.periodType === "Y" ? "2024" : SOURCE_MONTH, UNIT_NM: metric.unit,
      DT: String(kosisValue(definition, metric, breakdown, region)), LST_CHN_DE: "20261001"
    }))));
  });
  for (const region of REGIONS) {
    assert.equal((await tourism.collectDemandStrength({ regionKey: region.regionKey, yearMonth: SOURCE_MONTH })).status, "ok");
    assert.equal((await tourism.collectResourceDemand({ regionKey: region.regionKey, yearMonth: SOURCE_MONTH })).status, "ok");
    assert.equal((await tourism.collectDiversity({ regionKey: region.regionKey, yearMonth: SOURCE_MONTH })).status, "ok");
    assert.equal((await kosis.refreshRegion(region.regionKey)).status, "ready");
  }
  assert.equal(state.requests, EXPECTED_REQUESTS, "Seven tourism operations and fourteen KOSIS requests per region; retention adds no request");
  state.forbidden = true;
  const restartedTourism = newTourismCollector(), restartedKosis = newKosisService();
  const sourceTree = async () => ({ tourism: await digestTree(tourismDataDir), kosis: await digestTree(kosisDataDir) });
  const initialSources = await sourceTree();
  const build = createRegionalAnalysisSnapshotBuilder({ tourismCollector: restartedTourism, kosisService: restartedKosis,
    resolveRegion, now, searchTrendService: { get: async input => ({ ...input, keyword: `${REGIONS.find(item => item.regionKey === input.regionKey).name}글램핑`,
      startDate: "2025-09-01", endDate: "2026-09-30", series: [], networkAttempted: false }) } });
  const builder = async (...args) => { state.builds++; return build(...args); };
  function newStore(buildSnapshot = builder) {
    return createRegionalAnalysisStore({ dataDir: directory, resolveRegion, now, autoStart: false, buildSnapshot });
  }
  store = newStore();
  const scope = regionKey => ({ regionKey, month: MONTH, months: 13 });
  async function readRecords() {
    return Promise.all(REGIONS.map(async region => ({ key: region.regionKey, data: await store.get(scope(region.regionKey)) })));
  }
  async function rebuild() {
    for (const region of REGIONS) await store.request(scope(region.regionKey), { collectMissing: false, reason: "test" });
    await store.waitForIdle();
    return readRecords();
  }
  async function removeSecondRegionProof() {
    for (const filename of await fs.readdir(path.join(tourismDataDir, "cache"))) {
      const file = path.join(tourismDataDir, "cache", filename), value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.region?.regionKey !== REGIONS[1].regionKey || !value.operations) continue;
      for (const operation of Object.values(value.operations)) { delete operation.rawResponseEvidence; delete operation.quality.spatialEvidence; }
      await fs.writeFile(file, JSON.stringify(value));
    }
    for (const filename of await fs.readdir(kosisDataDir)) {
      if (!/^[a-f0-9]{24}\.json$/.test(filename)) continue;
      const file = path.join(kosisDataDir, filename), value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.regionId !== REGIONS[1].regionId) continue;
      for (const dataset of Object.values(value.datasets)) { delete dataset.responseEvidence; delete dataset.spatialEvidence; }
      await fs.writeFile(file, JSON.stringify(value));
    }
  }
  return { directory, tourismDataDir, kosisDataDir, state, scope, readRecords, rebuild, sourceTree, initialSources,
    restartedTourism, restartedKosis, removeSecondRegionProof, restartStore: async () => {
      await store.close(); store = newStore(async () => assert.fail("Saved GET after restart must not calculate"));
      return readRecords();
    } };
}

test("new-region retained provider responses survive restart, saved snapshots and monthly/annual comparison without new requests", async t => {
  const f = await fixture(t), records = await f.rebuild();
  assert.equal(f.state.requests, EXPECTED_REQUESTS);
  for (const record of records) {
    assert.equal(record.data.job.status, "completed");
    assert.equal(record.data.snapshot.networkAttempted, false);
    assert.ok(record.data.snapshot.storedEvidence.restored >= 39);
    const background = record.data.snapshot.groups.find(group => group.key === "kosis");
    for (const metric of background.metrics) {
      assert.equal(metric.spatialContract.status, "matched");
      assert.equal(metric.spatialContract.storedProvenance.periodType, metric.periodType);
      assert.equal(metric.spatialContract.storedProvenance.period, metric.periodType === "Y" ? "2024" : MONTH);
      assert.equal(metric.rows[0].storedEvidenceVerification.reasonCode, "");
    }
    const unknown = record.data.snapshot.groups.find(group => group.key === "visitors").metrics[0];
    assert.equal(unknown.latestValue, null);
    assert.equal(unknown.rows.at(-1).availability.observed, false);
  }
  const flow = comparisonModel(records, "flow");
  const tourismRows = flow.filter(row => Object.hasOwn(FLOW_EXPECTED, row.key));
  assert.equal(tourismRows.length, 7, "Every operation must reach the browser comparison model");
  for (const metric of tourismRows) {
    assert.equal(metric.commonPeriod, MONTH);
    assert.deepEqual(metric.cells.map(cell => cell.value), FLOW_EXPECTED[metric.key], "Distinct values detect swapped operation wiring");
    assert.ok(metric.cells.every(cell => cell.scope.matched));
    for (const cell of metric.cells) assert.equal(cell.scope.contract.storedProvenance.period, MONTH);
  }
  assert.equal(flow.find(row => row.key.startsWith("visitors\u0000")).commonPeriod, "");
  const background = comparisonModel(records, "background");
  assert.equal(background.length, 32);
  assert.equal(background.filter(metric => metric.periodType === "M").length, 26);
  assert.equal(background.filter(metric => metric.periodType === "Y").length, 6);
  for (const metric of background) {
    assert.equal(metric.commonPeriod, metric.periodType === "Y" ? "2024" : MONTH);
    assert.equal(metric.cells[0].value, 0, "A genuine normal zero remains comparable");
    assert.ok(metric.cells.every(cell => cell.scope.matched));
  }
  assert.deepEqual(await f.sourceTree(), f.initialSources, "Derived reconstruction never rewrites provider caches or originals");

  // Verification times can change without producing a second identical result.
  f.state.clock += 60000;
  const repeated = await f.rebuild();
  for (let index = 0; index < records.length; index++) {
    assert.equal(repeated[index].data.snapshot.sourceFingerprint, records[index].data.snapshot.sourceFingerprint);
    assert.equal(repeated[index].data.snapshot.resultId, records[index].data.snapshot.resultId);
    assert.equal(repeated[index].data.job.unchanged, true);
  }
  assert.equal(f.state.requests, EXPECTED_REQUESTS);

  // Missing originals do not slow normal provider reads or saved-result GETs.
  await fs.rename(path.join(f.tourismDataDir, "evidence"), path.join(f.tourismDataDir, "evidence-held"));
  await fs.rename(path.join(f.kosisDataDir, "evidence"), path.join(f.kosisDataDir, "evidence-held"));
  const before = await digestTree(f.directory), builds = f.state.builds;
  await assertNoOriginalIO(async () => {
    assert.equal((await f.restartedKosis.getRegion(REGIONS[0].regionKey)).datasets[0].rows[0].value, 0);
    const history = await f.restartedTourism.collectDemandStrengthHistory({ regionKey: REGIONS[0].regionKey,
      endYearMonth: SOURCE_MONTH, months: 1, collectMissing: false });
    assert.equal(history.series[0].stayOverall, 0);
    const afterRestart = await f.restartStore();
    assert.deepEqual(afterRestart.map(record => record.data.snapshot), repeated.map(record => record.data.snapshot));
  });
  assert.equal(f.state.builds, builds);
  assert.equal(f.state.requests, EXPECTED_REQUESTS);
  assert.deepEqual(await digestTree(f.directory), before, "Normal cache/saved reads do not create, modify or inspect missing originals");
});

test("an unreferenced legacy cache keeps normal values but cannot borrow another region's common-month proof", async t => {
  const f = await fixture(t), verified = await f.rebuild();
  await f.removeSecondRegionProof();
  const sourceBytes = await f.sourceTree();
  const rebuilt = await f.rebuild();
  assert.equal(f.state.requests, EXPECTED_REQUESTS);
  assert.deepEqual(await f.sourceTree(), sourceBytes);
  assert.notEqual(rebuilt[1].data.snapshot.resultId, verified[1].data.snapshot.resultId);
  const kosis = rebuilt[1].data.snapshot.groups.find(group => group.key === "kosis");
  for (const metric of kosis.metrics) {
    assert.equal(metric.spatialContract.status, "scope_unverified");
    assert.equal(metric.rows[0].storedEvidenceVerification.status, "pending");
    assert.equal(metric.spatialContract.storedProvenance, undefined);
  }
  const population = kosis.metrics.find(metric => metric.key === "population:population");
  assert.equal(population.latestValue, 12);
  assert.equal(population.rows[0].status, "observed");
  for (const metric of comparisonModel(rebuilt, "background")) {
    assert.equal(metric.commonPeriod, "");
    assert.equal(metric.cells[1].value, null);
    assert.equal(metric.cells[1].latestValue, kosis.metrics.find(item => `kosis\u0000${item.key}` === metric.key).latestValue);
  }
  const tourismRows = comparisonModel(rebuilt, "flow").filter(row => Object.hasOwn(FLOW_EXPECTED, row.key));
  assert.equal(tourismRows.length, 7);
  for (const metric of tourismRows) {
    assert.equal(metric.commonPeriod, "");
    assert.equal(metric.cells[1].latestValue, FLOW_EXPECTED[metric.key][1]);
    assert.equal(metric.cells[1].scope.matched, false);
    assert.equal(metric.cells[1].storedEvidenceVerification.status, "pending");
  }
});
