"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createKosisService, DEFINITIONS, parseValue } = require("./lib/kosis.cjs");

const REGION = "kr_gyeonggi_pocheon";
const units = [
  { regionKey: "kr_admin_4100000000", regionId: "kr_admin_4100000000", provinceRegionId: "kr_admin_4100000000", name: "경기도", sidoFull: "경기도", level: "broad", active: true },
  { regionKey: REGION, regionId: "kr_admin_4165000000", provinceRegionId: "kr_admin_4100000000", name: "포천시", fullName: "경기도 포천시", sidoFull: "경기도", level: "local", active: true }
];
function code(definition) { return definition.regionObject === "SGG" ? "31270" : "41650"; }
function metadata(definition) {
  const province = definition.regionObject === "SGG" ? "31" : "41";
  return [
    ...definition.metrics.map(metric => ({ OBJ_ID: "ITEM", ITM_ID: metric.id, ITM_NM: metric.label, UNIT_NM: metric.unit })),
    { OBJ_ID: definition.regionObject, OBJ_ID_SN: 1, ITM_ID: province, ITM_NM: "경기도", UP_ITM_ID: "00" },
    { OBJ_ID: definition.regionObject, OBJ_ID_SN: 1, ITM_ID: code(definition), ITM_NM: "포천시", UP_ITM_ID: province },
    ...(definition.breakdowns || []).map(item => ({ OBJ_ID: definition.breakdownObject, OBJ_ID_SN: 2, ITM_ID: item.id, ITM_NM: item.metadataName }))
  ];
}
function rows(definition, options = {}) {
  return definition.metrics.flatMap(metric => (definition.breakdowns || [null]).map(breakdown => ({
    TBL_ID: definition.tableId, ORG_ID: definition.orgId, ITM_ID: metric.id, C1: code(definition),
    ...(breakdown ? { C2: breakdown.id } : {}), PRD_SE: definition.periodType === "Y" ? "A" : definition.periodType,
    PRD_DE: definition.periodType === "M" ? "202608" : "2024", UNIT_NM: metric.unit, DT: "123", LST_CHN_DE: "20260910", ...options
  })));
}
function reply(payload, status = 200) { return { status, ok: status === 200, text: async () => JSON.stringify(payload) }; }
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-kosis-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    const root = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(root) && path.basename(resolved).startsWith("staydatalab-kosis-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const regionMasterFile = path.join(directory, "regions.json");
  await fs.writeFile(regionMasterFile, JSON.stringify({ units }));
  let time = Date.parse("2026-09-26T00:00:00Z");
  const calls = [];
  const dataDir = path.join(directory, "data");
  const provider = options.provider || ((url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition)));
  const service = createKosisService({ dataDir, regionMasterFile, readApiKey: () => "test-only-secret-key", now: () => time, sleep: async ms => { time += ms; }, ...options,
    fetchImpl: async (rawUrl, init) => { const url = new URL(rawUrl); calls.push({ url, init, at: time }); const definition = DEFINITIONS.find(item => item.tableId === url.searchParams.get("tblId")); return provider(url, definition, init); }
  });
  return { service, dataDir, regionMasterFile, calls, advance: ms => { time += ms; } };
}

test("cache-only reads and missing-key refresh never contact KOSIS", async t => {
  const f = await fixture(t, { readApiKey: () => "" });
  assert.equal((await f.service.status()).status, "needs_key");
  assert.equal((await f.service.getRegion(REGION)).status, "needs_key");
  const result = await f.service.refreshRegion(REGION);
  assert.equal(result.error.code, "MISSING_KEY");
  assert.equal(result.networkAttempted, false);
  assert.equal(f.calls.length, 0);
});

test("official metadata resolves independent table codes and cache preserves source period and units", async t => {
  const f = await fixture(t);
  const result = await f.service.refreshRegion(REGION);
  assert.equal(result.status, "ready");
  assert.equal(result.datasets.length, DEFINITIONS.length);
  assert.equal(f.calls.length, DEFINITIONS.length * 2);
  for (let index = 1; index < f.calls.length; index++) assert.ok(f.calls[index].at - f.calls[index - 1].at >= 1000);
  for (const call of f.calls) {
    assert.equal(call.url.origin, "https://kosis.kr");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.url.pathname, call.url.searchParams.get("method") === "getMeta" ? "/openapi/statisticsData.do" : "/openapi/Param/statisticsParameterData.do");
    if (call.url.searchParams.get("method") === "getList") {
      const definition = DEFINITIONS.find(item => item.tableId === call.url.searchParams.get("tblId"));
      assert.equal(call.url.searchParams.get("objL1"), code(definition));
      assert.equal(call.url.searchParams.get("newEstPrdCnt"), "1");
      assert.equal(call.url.searchParams.get("smblChk"), "Y");
    }
  }
  assert.equal(result.datasets[0].sourceUpdatedAt, "2026-09-10");
  assert.notEqual(result.datasets[0].retrievedAt, result.datasets[0].sourceUpdatedAt);
  assert.equal(result.datasets[0].period, "202608");
  const cached = await f.service.getRegion(REGION);
  assert.equal(cached.networkAttempted, false);
  assert.equal(cached.status, "ready");
  assert.deepEqual(cached.datasets, result.datasets);
  const status = await f.service.status();
  assert.equal(status.cachedRegionCount, 1);
  assert.equal(status.networkAttempted, false);
  assert.equal(f.calls.length, DEFINITIONS.length * 2);
  const histories = await fs.readdir(path.join(f.dataDir, "history"));
  assert.equal(histories.length, 1);
  assert.doesNotMatch(await fs.readFile(path.join(f.dataDir, "history", histories[0]), "utf8"), /test-only-secret|apiKey/);
});

test("observed zero differs from missing or suppressed values", async t => {
  assert.deepEqual(parseValue("0"), { value: 0, status: "observed" });
  for (const missing of [null, "", "-", "."]) assert.deepEqual(parseValue(missing), { value: null, status: "missing" });
  assert.deepEqual(parseValue("..."), { value: null, status: "suppressed" });
  const f = await fixture(t, { provider: (url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition, { DT: definition.key === "population" ? "0" : "..." })) });
  const result = await f.service.refreshRegion(REGION);
  assert.equal(result.status, "partial");
  assert.ok(result.datasets[0].rows.every(row => row.status === "observed" && row.value === 0));
  assert.ok(result.datasets[1].rows.every(row => row.status === "suppressed" && row.value === null));
  const cached = await f.service.getRegion(REGION);
  assert.equal(cached.datasets[0].rows[0].value, 0);
  assert.equal(cached.datasets[1].status, "partial");
});

test("incomplete response never replaces a prior complete dataset", async t => {
  let incomplete = false;
  const f = await fixture(t, { provider: (url, definition) => {
    if (url.searchParams.get("method") === "getMeta") return reply(metadata(definition));
    const values = rows(definition, { DT: incomplete ? "999" : "123" });
    return reply(incomplete && definition.key === "population" ? values.slice(0, 1) : values);
  } });
  const initial = await f.service.refreshRegion(REGION);
  f.advance(300001);
  incomplete = true;
  const updated = await f.service.refreshRegion(REGION);
  assert.equal(updated.datasets[0].status, "stale");
  assert.equal(updated.datasets[0].error.code, "MISSING_VALUES");
  assert.deepEqual(updated.datasets[0].rows, initial.datasets[0].rows);
  const cached = await f.service.getRegion(REGION);
  assert.equal(cached.datasets[0].status, "stale");
  assert.deepEqual(cached.datasets[0].rows, initial.datasets[0].rows);
  assert.equal(cached.datasets[0].retrievedAt, initial.datasets[0].retrievedAt);
  assert.equal(cached.datasets[1].rows[0].value, 999);
});

test("mixed periods, wrong units, duplicate item rows and unrelated region rows fail safely", async t => {
  for (const change of [
    values => values.map((row, index) => index ? { ...row, PRD_DE: "202607" } : row),
    values => values.map(row => ({ ...row, UNIT_NM: "천명" })),
    values => [...values, values[0]],
    values => values.map(row => ({ ...row, C1: "99999" }))
  ]) {
    const f = await fixture(t, { provider: (url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : definition.key === "population" ? change(rows(definition)) : rows(definition)) });
    const result = await f.service.refreshRegion(REGION);
    assert.equal(result.datasets[0].status, "error");
    assert.ok(["INVALID_RESPONSE", "PERIOD_MISMATCH"].includes(result.datasets[0].error.code));
    assert.equal((await f.service.getRegion(REGION)).datasets[0].status, "error");
  }
});

test("duplicate official mapping and absent parent are rejected without data requests", async t => {
  for (const transform of [values => [...values, { ...values.find(row => row.ITM_NM === "포천시") }], values => values.map(row => row.ITM_NM === "경기도" ? { ...row, ITM_NM: "다른 지역" } : row)]) {
    const f = await fixture(t, { provider: (url, definition) => reply(transform(metadata(definition))) });
    const result = await f.service.refreshRegion(REGION);
    assert.equal(result.status, "mapping_missing");
    assert.ok(f.calls.every(call => call.url.searchParams.get("method") === "getMeta"));
    assert.equal(result.datasets[0].rows.length, 0);
  }
});

test("ambiguous administrative region never guesses a provider code", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.regionMasterFile, JSON.stringify({ units: [...units, { ...units[1], regionId: "other" }] }));
  const result = await f.service.refreshRegion(REGION);
  assert.equal(result.error.code, "AMBIGUOUS_REGION");
  assert.equal(result.networkAttempted, false);
  assert.equal(f.calls.length, 0);
});

test("network errors redact keys and preserve byte-identical last successful cache", async t => {
  let fail = false;
  const f = await fixture(t, { provider: (url, definition) => {
    if (fail) throw new Error(`provider failed ${url.toString()}`);
    return reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition));
  } });
  await f.service.refreshRegion(REGION);
  const file = (await fs.readdir(f.dataDir)).find(name => /^[a-f0-9]{24}\.json$/.test(name));
  const before = await fs.readFile(path.join(f.dataDir, file), "utf8");
  fail = true;
  f.advance(300001);
  const result = await f.service.refreshRegion(REGION);
  assert.equal(result.status, "partial");
  assert.equal(result.error.code, "NETWORK_ERROR");
  assert.equal(f.calls.length, DEFINITIONS.length * 2 + 1, "Stop remaining requests on network/auth/quota failure");
  assert.equal(await fs.readFile(path.join(f.dataDir, file), "utf8"), before);
  assert.doesNotMatch(JSON.stringify([result, await f.service.status()]), /test-only-secret|apiKey|provider failed/);
});

test("parallel refreshes coalesce and successful attempts observe cooldown", async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.service.refreshRegion(REGION), f.service.refreshRegion(REGION)]);
  assert.equal(a.status, "ready");
  assert.equal(b.status, "ready");
  assert.equal(f.calls.length, DEFINITIONS.length * 2);
  const next = await f.service.refreshRegion(REGION);
  assert.equal(next.status, "cooldown");
  assert.equal(next.networkAttempted, false);
  assert.equal(f.calls.length, DEFINITIONS.length * 2);
});

test("daily request budget stops externally attempted calls and persists across service instances", async t => {
  const f = await fixture(t, { dailyBudget: 1 });
  const result = await f.service.refreshRegion(REGION);
  assert.equal(result.error.code, "QUOTA_EXCEEDED");
  assert.equal(f.calls.length, 1);
  const other = createKosisService({ dataDir: f.dataDir, regionMasterFile: f.regionMasterFile, readApiKey: () => "fake", now: () => Date.parse("2026-09-26T00:00:00Z"), dailyBudget: 1, fetchImpl: async () => assert.fail("persisted budget must prevent request") });
  assert.equal((await other.refreshRegion(REGION)).networkAttempted, false);
});

test("oversized and timeout responses never become successful observations", async t => {
  const huge = await fixture(t, { provider: async () => ({ ok: true, status: 200, headers: { get: () => String(3 * 1024 * 1024) }, text: async () => assert.fail("oversized response should not be read") }) });
  assert.equal((await huge.service.refreshRegion(REGION)).error.code, "INVALID_RESPONSE");
  const slow = await fixture(t, { timeoutMs: 10, provider: async () => new Promise(() => {}) });
  assert.equal((await slow.service.refreshRegion(REGION)).error.code, "TIMEOUT");
  assert.equal(slow.calls.length, 1);
});

test("provider authentication error cannot leak upstream error text", async t => {
  const f = await fixture(t, { provider: async () => reply({ err: "11", errMsg: "test-only-secret-key invalid" }) });
  const result = await f.service.refreshRegion(REGION);
  assert.equal(result.error.code, "AUTH_ERROR");
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /test-only-secret/);
});

test("age groups validate the second classification and annual A responses remain annual", async t => {
  const f = await fixture(t);
  const result = await f.service.refreshRegion(REGION);
  const age = result.datasets.find(dataset => dataset.key === "age_population");
  assert.equal(age.rows.length, 22);
  assert.equal(age.rows[0].key, "all_ages");
  assert.equal(age.rows.at(-1).key, "age_100_plus");
  const call = f.calls.find(call => call.url.searchParams.get("tblId") === age.tableId && call.url.searchParams.get("method") === "getList");
  assert.equal(call.url.searchParams.get("objL2"), "0+5+10+15+20+25+30+35+40+45+50+55+60+65+70+75+80+85+90+95+100+105+");
  assert.equal(result.datasets.find(dataset => dataset.key === "employment").periodType, "Y");
  assert.equal(result.datasets.find(dataset => dataset.key === "employment").period, "2024");
  const broken = await fixture(t, { provider: (url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition, definition.breakdowns ? { C2: "unknown" } : {})) });
  assert.equal((await broken.service.refreshRegion(REGION)).datasets.find(dataset => dataset.key === "age_population").error.code, "INVALID_RESPONSE");
});

test("failed refresh and cooldown survive a service restart without changing good values", async t => {
  let failed = false;
  const f = await fixture(t, { provider: (url, definition) => failed ? reply({ err: "40", errMsg: "secret-containing provider message" }) : reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition)) });
  await f.service.refreshRegion(REGION);
  f.advance(300001);
  failed = true;
  await f.service.refreshRegion(REGION);
  const service = createKosisService({ dataDir: f.dataDir, regionMasterFile: f.regionMasterFile, readApiKey: () => "fake", now: () => Date.parse("2026-09-26T00:05:20Z"), fetchImpl: async () => assert.fail("restart cooldown must stop request") });
  const cached = await service.getRegion(REGION);
  assert.equal(cached.status, "partial");
  assert.equal(cached.datasets[0].status, "stale");
  assert.equal(cached.datasets[0].rows[0].value, 123);
  assert.equal(cached.error.code, "QUOTA_EXCEEDED");
  assert.equal((await service.status()).status, "partial");
  assert.equal((await service.refreshRegion(REGION)).status, "cooldown");
  assert.doesNotMatch(JSON.stringify(cached), /secret-containing/);
});

test("official no-data code is distinct from authentication failure and never becomes zero", async t => {
  const f = await fixture(t, { provider: () => reply({ err: "30", errMsg: "자료없음" }) });
  const result = await f.service.refreshRegion(REGION);
  assert.equal(result.error.code, "NO_DATA");
  assert.ok(result.datasets.every(dataset => dataset.rows.length === 0));
  assert.equal((await f.service.getRegion(REGION)).error.code, "NO_DATA");
  assert.equal((await f.service.status()).status, "error");
});

test("explicit metadata ancestors resolve intermediate districts while cycles fail closed", async t => {
  for (const cyclic of [false, true]) {
    const f = await fixture(t, { provider: (url, definition) => {
      if (url.searchParams.get("method") !== "getMeta") return reply(rows(definition));
      const values = metadata(definition);
      const local = values.find(row => row.ITM_NM === "포천시");
      const parent = local.UP_ITM_ID;
      local.UP_ITM_ID = "intermediate";
      values.push({ OBJ_ID: definition.regionObject, OBJ_ID_SN: 1, ITM_ID: "intermediate", ITM_NM: "이전 행정구역", UP_ITM_ID: cyclic ? code(definition) : parent });
      return reply(values);
    } });
    assert.equal((await f.service.refreshRegion(REGION)).status, cyclic ? "mapping_missing" : "ready");
  }
});

test("first partial snapshots preserve observed zero, missing and suppressed rows after restart", async t => {
  const f = await fixture(t, { provider: (url, definition) => {
    if (url.searchParams.get("method") === "getMeta") return reply(metadata(definition));
    const values = rows(definition, { DT: "..." });
    if (definition.key === "population") {
      values[0].DT = "0";
      values[1].DT = "...";
      values.pop(); // Missing female item must persist as its own null row.
    }
    return reply(values);
  } });
  const first = await f.service.refreshRegion(REGION);
  assert.equal(first.status, "partial");
  const restarted = createKosisService({ dataDir: f.dataDir, regionMasterFile: f.regionMasterFile, readApiKey: () => "fake", now: () => Date.parse("2026-09-26T00:00:30Z"), fetchImpl: async () => assert.fail("cache-only read must not request") });
  const read = await restarted.getRegion(REGION);
  assert.equal(read.status, "partial");
  assert.ok(read.datasets.every(dataset => dataset.status === "partial"));
  assert.deepEqual(read.datasets[0].rows, first.datasets[0].rows);
  assert.deepEqual(read.datasets[0].rows.map(row => [row.value, row.status]), [[0, "observed"], [null, "suppressed"], [null, "missing"]]);
  assert.equal(read.datasets[0].period, first.datasets[0].period);
  assert.equal(read.datasets[0].retrievedAt, first.datasets[0].retrievedAt);
  const status = await restarted.status();
  assert.equal(status.status, "partial");
  assert.equal(status.cachedRegionCount, 1);
  assert.equal(status.completeRegionCount, 0);
  assert.equal(status.lastSuccessAt, null);
});

test("a new partial observation cannot overwrite a previous ready snapshot or mix periods", async t => {
  let partial = true;
  const f = await fixture(t, { provider: (url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition, { DT: partial ? "..." : "321" })) });
  await f.service.refreshRegion(REGION);
  f.advance(300001);
  partial = false;
  const good = await f.service.refreshRegion(REGION);
  assert.equal(good.status, "ready");
  f.advance(300001);
  partial = true;
  await f.service.refreshRegion(REGION);
  const read = await f.service.getRegion(REGION);
  assert.equal(read.status, "partial");
  assert.ok(read.datasets.every(dataset => dataset.status === "stale"));
  for (let index = 0; index < good.datasets.length; index++) assert.deepEqual(read.datasets[index].rows, good.datasets[index].rows);
  assert.ok(read.datasets.every(dataset => dataset.rows.every(row => row.value === 321)));
});
