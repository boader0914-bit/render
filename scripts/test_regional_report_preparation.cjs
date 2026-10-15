"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createRegionalReportPreparation } = require("./lib/regional_report_preparation.cjs");
const { DEFINITIONS } = require("./lib/kosis.cjs");

const FIXED = "2026-09-27T01:00:00.000Z";
const request = { regionKey: "sancheong", month: "2026-08", cutoffDate: "2026-09-26" };
const methods = ["collectVisitorHistory", "collectDemandStrengthHistory", "collectResourceDemandHistory", "collectDiversityHistory"];
const region = (regionKey) => ({ regionKey, name: regionKey, level: "local", active: true, selectable: true });
const stamp = "2026-09-20T01:00:00.000Z";

test("24-month preparation fills gaps in sequence, queries one search window, and reuses finished work across restart", async t => {
  const f=await fixture(t,{historyMonths:24,reuseFinishedMs:3600000});
  const {monthsEnding}=require('./lib/insight_region_history.cjs');
  const periods=monthsEnding(request.month,24),calls=[];
  methods.forEach((method,index)=>{f.options.tourismCollector[method]=async input=>{
    calls.push({method,input:structuredClone(input)});
    const result=tourismResult(index,input);
    const target=index===0?result.regions[0]:result;
    const example=target.series[0];
    target.series=(input.collectMissing?periods:periods.slice(1)).map(month=>({...example,yearMonth:month.replace('-','')}));
    return result;
  };});
  f.options.searchTrendService.refresh=async input=>{
    calls.push({method:'search',input});
    return {regionKey:input.regionKey,keyword:'산청글램핑',status:'ready',startDate:'2024-09-01',endDate:'2026-08-31',
      retrievedAt:stamp,configured:true,networkAttempted:true,series:periods.map(month=>({period:month+'-01',value:0,status:'observed'}))};
  };
  const first=await f.service.start(request);
  assert.equal((await f.service.start(request)).id,first.id);
  await f.service.awaitIdle();
  const job=await f.service.get(request);
  assert.equal(job.status,'complete');
  for(const step of job.steps.slice(0,4)){assert.equal(step.observedMonths,24);assert.equal(step.expectedMonths,24);}
  for(const {input} of calls.filter(c=>c.method!=='search')){
    assert.equal(input.months,24);assert.equal(input.concurrency,1);assert.equal(input.force,false);
  }
  assert.deepEqual(calls.map(c=>c.method),methods.flatMap(m=>[m,m]).concat('search'));
  assert.deepEqual(calls.at(-1).input,{regionKey:'sancheong',month:'2026-08',months:24});
  const reloaded=createRegionalReportPreparation(f.options),count=calls.length;
  const reused=await reloaded.start(request);
  assert.equal(reused.id,first.id);assert.equal(reused.reused,true);assert.equal(calls.length,count);
});
test("13-month preparation propagates one complete window and persists month coverage and real zero counts", async t => {
  const f = await fixture(t, { historyMonths: 13, reuseFinishedMs: 3600000 });
  const { monthsEnding } = require('./lib/insight_region_history.cjs');
  const months = monthsEnding(request.month, 13), calls = [];
  methods.forEach((method, index) => { f.options.tourismCollector[method] = async input => {
    calls.push({ method, input: structuredClone(input) });
    const result = tourismResult(index, input), target = index === 0 ? result.regions[0] : result, point = target.series[0];
    target.series = (input.collectMissing ? months : months.slice(1)).map(month => ({ ...point, yearMonth: month.replace('-', '') }));
    return result;
  }; });
  f.options.searchTrendService.refresh = async input => {
    calls.push({ method: 'search', input });
    return { regionKey: input.regionKey, keyword: '산청글램핑', status: 'ready', startDate: '2025-08-01', endDate: '2026-08-31',
      retrievedAt: stamp, configured: true, networkAttempted: true, diagnostics: { httpStatus: 200 },
      series: months.map(month => ({ period: month + '-01', value: 0, status: 'observed' })) };
  };
  const started = await f.service.start(request); await f.service.awaitIdle();
  const job = await f.service.get(request);
  assert.equal(job.historyMonths, 13); assert.equal(job.status, 'complete');
  for (const step of job.steps.slice(0, 4)) {
    assert.equal(step.observedMonths, 13); assert.equal(step.expectedMonths, 13);
    assert.equal(step.period, '202508 ~ 202608'); assert.equal(step.periods.length, 13);
    assert.equal(step.periods.every(period => period.status === 'ready'), true);
    assert.equal(step.zeroValuesObserved, step.expectedValueCount); assert.equal(step.missingMonths, 0);
  }
  for (const { input } of calls.filter(call => call.method !== 'search')) {
    assert.equal(input.months, 13); assert.equal(input.analysisMonths, 13); assert.equal(input.concurrency, 1);
  }
  assert.deepEqual(calls.at(-1).input, { regionKey: 'sancheong', month: '2026-08', months: 13 });
  assert.deepEqual(job.steps[5].diagnostics, { httpStatus: 200 });
  const count = calls.length, reloaded = createRegionalReportPreparation(f.options);
  assert.equal((await reloaded.start(request)).id, started.id); assert.equal(calls.length, count);
});

test("changing from single-month preparation to 13 months cannot reuse a finished single-month job", async t => {
  const f = await fixture(t, { reuseFinishedMs: 3600000 });
  const first = await f.service.start(request); await f.service.awaitIdle();
  const extended = createRegionalReportPreparation({ ...f.options, historyMonths: 13 });
  const second = await extended.start(request); await extended.awaitIdle();
  assert.notEqual(first.id, second.id); assert.equal(second.historyMonths, 13); assert.equal(second.reused, undefined);
});
function tourismResult(index, input, status = "complete", value = 0) {
  const point = { yearMonth: input.endYearMonth, status, collectedAt: stamp, averageDailyVisitors: value, visitorDays: value,
    stayOverall: value, spendOverall: value, values: { service: value, culture: value, visitor: value, spend: value, international: value } };
  return { period: { endYearMonth: input.endYearMonth },
    ...(index === 0 ? { regions: [{ regionKey: input.regionKey, series: [point] }] } : { region: { regionKey: input.regionKey }, series: [point] }),
    collection: { networkAttemptedMonths: input.collectMissing ? 1 : 0, operationCallsAttempted: input.collectMissing ? 1 : 0 } };
}
function kosisResult(regionKey, { status = "ready", networkAttempted = false, value = 0 } = {}) {
  return { status, region: { regionKey }, networkAttempted, datasets: DEFINITIONS.map((definition) => ({ key: definition.key, label: definition.label,
    period: definition.periodType === "M" ? "202608" : "2024", periodType: definition.periodType, status, retrievedAt: stamp,
    rows: definition.metrics.flatMap((metric) => (definition.breakdowns || [null]).map((breakdown) => ({ key: breakdown?.key || metric.key, unit: metric.unit,
      status: value === null ? "missing" : "observed", value }))) })) };
}
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "regional-report-preparation-"));
  const allowed = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(path.resolve(dataDir).startsWith(allowed));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(allowed)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const calls = [];
  const tourismCollector = Object.fromEntries(methods.map((method, index) => [method, async (input) => {
    calls.push({ method, input: structuredClone(input) }); return tourismResult(index, input);
  }]));
  const kosisService = { getRegion: async (key) => { calls.push({ method: "getRegion", key }); return kosisResult(key); },
    refreshRegion: async (key) => { calls.push({ method: "refreshRegion", key }); return kosisResult(key, { networkAttempted: true }); } };
  const searchTrendService = { status: async () => ({ configured: true, lastCheckedAt: stamp, lastSuccessAt: stamp, errorCode: "" }),
    refresh: async ({ regionKey, month }) => ({ regionKey, keyword: "산청글램핑", status: "ready", startDate: "2025-09-01", endDate: "2026-08-31",
      retrievedAt: stamp, configured: true, cacheReused: true, networkAttempted: false,
      series: [{ period: `${month}-01`, value: 0, status: "observed" }] }) };
  const options = { dataDir, tourismCollector, kosisService, searchTrendService, resolveRegion: async (key) => region(key), now: () => new Date(FIXED), ...overrides };
  return { dataDir, calls, options, service: createRegionalReportPreparation(options) };
}

test("normal cache reuse preserves observed zeros, actual periods and stored timestamps without provider refresh", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.service.get(request), null);
  assert.equal(f.calls.length, 0, "GET before start has no provider reads");
  const started = await f.service.start(request);
  assert.equal(started.status, "queued");
  assert.deepEqual(started.progress, { completed: 0, total: 6, percent: 0 });
  started.steps[0].status = "tampered";
  await f.service.awaitIdle();
  const job = await f.service.get(request);
  assert.equal(job.status, "complete");
  assert.deepEqual(job.progress, { completed: 6, total: 6, percent: 100 });
  assert.equal(job.steps.every((step) => step.cacheReused && !step.networkAttempted && step.zeroValuesObserved > 0), true);
  assert.equal(job.steps[0].period, "202608");
  assert.equal(job.steps[0].retrievedAt, stamp);
  assert.equal(job.steps[4].periods.some((period) => period.period === "2024" && period.periodType === "Y"), true);
  assert.equal(job.steps[4].referenceOnly, true);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls.some((call) => call.method === "refreshRegion" || call.input?.collectMissing), false);
  const reloaded = createRegionalReportPreparation(f.options);
  assert.deepEqual(await reloaded.get(request), job);
  assert.equal(f.calls.length, 5, "GET and restart never refresh provider data");
});

test("only missing or partial target-month indicators are collected once in sequence", async (t) => {
  const f = await fixture(t);
  const order = [];
  methods.forEach((method, index) => { f.options.tourismCollector[method] = async (input) => {
    order.push({ method, input: structuredClone(input) });
    return tourismResult(index, input, !input.collectMissing && index !== 0 ? "missing" : "complete", !input.collectMissing && index !== 0 ? null : 12);
  }; });
  f.options.kosisService.getRegion = async (key) => { order.push({ method: "getRegion" }); return kosisResult(key, { status: "partial", value: null }); };
  f.options.kosisService.refreshRegion = async (key) => { order.push({ method: "refreshRegion" }); return kosisResult(key, { networkAttempted: true }); };
  await f.service.start(request); await f.service.awaitIdle();
  const job = await f.service.get(request);
  assert.equal(job.status, "complete");
  assert.deepEqual(order.map((call) => call.method), [methods[0], methods[1], methods[1], methods[2], methods[2], methods[3], methods[3], "getRegion", "refreshRegion"]);
  for (const { input } of order.filter((call) => call.input)) {
    assert.equal(input.endYearMonth, "202608"); assert.equal(input.months, 1); assert.equal(input.analysisMonths, 1);
    assert.equal(input.force, false); assert.equal(input.refresh, false); assert.equal(input.concurrency, 1);
    assert.deepEqual(input.regionKeys, ["sancheong"]);
  }
  assert.equal(job.steps[0].cacheReused, true);
  assert.equal(job.steps.slice(1, 5).every((step) => step.networkAttempted), true);
});

test("current month stays publication pending without calling any tourism method; future month is invalid", async (t) => {
  const f = await fixture(t);
  const current = { ...request, month: "2026-09" };
  await f.service.start(current); await f.service.awaitIdle();
  const job = await f.service.get(current);
  assert.equal(job.status, "partial");
  assert.equal(job.steps.slice(0, 4).every((step) => step.status === "publication_pending" && !step.period && !step.dataAvailable), true);
  assert.deepEqual(f.calls.map((call) => call.method), ["getRegion"]);
  await assert.rejects(f.service.start({ ...request, month: "2026-10" }), (error) => error.code === "INVALID_MONTH" && error.statusCode === 400);
});

test("same region/month concurrent starts share one job and all regions execute globally one at a time", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const barrier = new Promise((resolve) => { release = resolve; });
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  const seen = [];
  methods.forEach((method, index) => { f.options.tourismCollector[method] = async (input) => {
    seen.push(`${input.regionKey}:${method}`);
    if (input.regionKey === "sancheong" && index === 0) { entered(); await barrier; }
    return tourismResult(index, input);
  }; });
  const first = await f.service.start(request);
  await firstEntered;
  const duplicate = await f.service.start({ ...request, cutoffDate: "2026-09-25" });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.cutoffDate, request.cutoffDate, "joining a running job does not silently change its original cutoff");
  const other = { ...request, regionKey: "gapyeong" };
  await f.service.start(other);
  assert.equal((await f.service.get(other)).status, "queued");
  assert.equal(seen.length, 1);
  release(); await f.service.awaitIdle();
  assert.deepEqual(seen.map((value) => value.split(":")[0]), [...Array(4).fill("sancheong"), ...Array(4).fill("gapyeong")]);
  assert.equal((await f.service.get(request)).status, "complete");
  assert.equal((await f.service.get(other)).status, "complete");
});

test("restart marks unfinished records interrupted and never silently resumes collection", async (t) => {
  const f = await fixture(t);
  await f.service.start(request); await f.service.awaitIdle();
  const file = path.join(f.dataDir, "jobs.json"), saved = JSON.parse(await fs.readFile(file, "utf8"));
  const savedJob = saved.jobs[`${request.regionKey}|${request.month}`];
  savedJob.status = "running"; savedJob.finishedAt = "";
  savedJob.steps.forEach((step, index) => { if (index) step.status = index === 1 ? "running" : "queued"; });
  await fs.writeFile(file, JSON.stringify(saved));
  const before = f.calls.length;
  const restarted = createRegionalReportPreparation(f.options);
  const job = await restarted.get(request); await restarted.awaitIdle();
  assert.equal(job.status, "interrupted");
  assert.equal(job.errorCode, "PREPARATION_INTERRUPTED");
  assert.equal(job.steps[0].status, "ready");
  assert.equal(job.steps.slice(1).every((step) => step.status === "interrupted"), true);
  assert.equal(f.calls.length, before);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).jobs[`${request.regionKey}|${request.month}`].status, "interrupted");
});

test("provider period or region mismatch never becomes the requested report's complete data", async (t) => {
  const f = await fixture(t);
  f.options.tourismCollector[methods[0]] = async (input) => tourismResult(0, { ...input, endYearMonth: "202607" });
  f.options.tourismCollector[methods[1]] = async (input) => tourismResult(1, { ...input, regionKey: "wrong" });
  await f.service.start(request); await f.service.awaitIdle();
  const job = await f.service.get(request);
  assert.equal(job.status, "partial");
  assert.equal(job.steps[0].status, "failed"); assert.equal(job.steps[0].errorCode, "PERIOD_MISMATCH");
  assert.equal(job.steps[1].status, "failed"); assert.equal(job.steps[1].errorCode, "REGION_MISMATCH");
  assert.equal(job.steps[0].dataAvailable, false);
});

test("partial cache survives refresh failure, safe codes contain no credential strings, and missing is not zero", async (t) => {
  const f = await fixture(t);
  methods.forEach((method, index) => { f.options.tourismCollector[method] = async (input) => {
    if (index === 0) {
      if (input.collectMissing) throw new Error("secret-token=https://provider/?serviceKey=private");
      return tourismResult(0, input, "partial", 2);
    }
    return tourismResult(index, input, "missing", null);
  }; });
  f.options.kosisService.getRegion = async (key) => kosisResult(key, { status: "partial", value: 7 });
  f.options.kosisService.refreshRegion = async () => { throw Object.assign(new Error("password=private"), { code: "NETWORK_ERROR" }); };
  await f.service.start(request); await f.service.awaitIdle();
  const job = await f.service.get(request);
  assert.equal(job.steps[0].status, "partial"); assert.equal(job.steps[0].dataAvailable, true); assert.equal(job.steps[0].cacheReused, true);
  assert.equal(job.steps[0].networkAttempted, null, "a thrown request has unknown network outcome");
  assert.equal(job.steps[0].errorCode, "PROVIDER_FAILED");
  assert.equal(job.steps[1].status, "missing"); assert.equal(job.steps[1].zeroValuesObserved, 0); assert.equal(job.steps[1].dataAvailable, false);
  assert.equal(job.steps[4].status, "partial"); assert.equal(job.steps[4].errorCode, "NETWORK_ERROR"); assert.equal(job.steps[4].dataAvailable, true);
  const stored = await fs.readFile(path.join(f.dataDir, "jobs.json"), "utf8");
  assert.equal(/secret|private|password|serviceKey/.test(stored), false);
});

test("invalid dates, ambiguous or broad regions, and malformed storage fail before provider calls", async (t) => {
  const f = await fixture(t, { resolveRegion: async (key) => key === "broad" ? { ...region(key), level: "broad" } : key === "unknown" ? null : region(key) });
  for (const input of [{ ...request, cutoffDate: "2026-02-30" }, { ...request, cutoffDate: "2026-09-28" }, { ...request, month: "2026-13" },
    { ...request, month: "1999-12" }, { ...request, cutoffDate: "1999-12-31" },
    { ...request, regionKey: "broad" }, { ...request, regionKey: "unknown" }, { ...request, regionKey: "../escape" }, { ...request, force: true }]) {
    await assert.rejects(f.service.start(input), (error) => error.statusCode === 400);
  }
  assert.equal(f.calls.length, 0);
  await fs.writeFile(path.join(f.dataDir, "jobs.json"), "malformed");
  const damaged = createRegionalReportPreparation(f.options);
  await assert.rejects(damaged.get(request), (error) => error.code === "PREPARATION_STORAGE_ERROR");
  assert.equal(f.calls.length, 0);
});

test("a cache-only reader violating its network contract stops that step before refresh", async (t) => {
  const f = await fixture(t);
  let visits = 0;
  f.options.tourismCollector[methods[0]] = async (input) => { visits++; return tourismResult(0, { ...input, collectMissing: true }); };
  await f.service.start(request); await f.service.awaitIdle();
  const job = await f.service.get(request);
  assert.equal(visits, 1);
  assert.equal(job.steps[0].errorCode, "CACHE_ONLY_VIOLATION");
  assert.equal(job.steps[0].status, "failed");
});

test("KOSIS reuses complete caches for at most 30 days and preserves stale values after refresh failure", async (t) => {
  const f = await fixture(t);
  let refreshes = 0;
  f.options.kosisService.getRegion = async (key) => {
    const cached = kosisResult(key);
    cached.datasets[0].retrievedAt = "2026-08-01T00:00:00.000Z";
    return cached;
  };
  f.options.kosisService.refreshRegion = async () => { refreshes++; throw Object.assign(new Error("network"), { code: "NETWORK_ERROR" }); };
  await f.service.start(request); await f.service.awaitIdle();
  const step = (await f.service.get(request)).steps[4];
  assert.equal(refreshes, 1);
  assert.equal(step.status, "partial"); assert.equal(step.dataAvailable, true); assert.equal(step.cacheReused, true);
  assert.equal(step.periods[0].retrievedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(step.periods.find((period) => period.key === "employment").period, "2024");
  const custom = createRegionalReportPreparation({ ...f.options, kosisCacheTtlMs: 365 * 86400000 });
  await custom.start(request); await custom.awaitIdle();
  assert.equal(refreshes, 1, "an explicit longer test TTL is honored");
  assert.equal((await custom.get(request)).steps[4].status, "ready");
});

test("missing KOSIS timestamps or malformed ready metric schemas cannot pass the reuse gate", async (t) => {
  const f = await fixture(t);
  let refreshes = 0;
  f.options.kosisService.refreshRegion = async (key) => { refreshes++; return kosisResult(key, { networkAttempted: true }); };
  const variants = [
    (cached) => { cached.datasets[0].retrievedAt = ""; },
    (cached) => { cached.datasets[0].rows.pop(); },
    (cached) => { cached.datasets[0].rows[0].unit = "퍼센트"; },
    (cached) => { cached.datasets[0].rows[0].value = "0"; },
    (cached) => { cached.datasets[0].periodType = "Y"; },
    (cached) => { cached.datasets[0].rows[1] = { ...cached.datasets[0].rows[0] }; }
  ];
  for (const mutate of variants) {
    f.options.kosisService.getRegion = async (key) => { const cached = kosisResult(key); mutate(cached); return cached; };
    await f.service.start(request); await f.service.awaitIdle();
    assert.equal((await f.service.get(request)).steps[4].status, "ready", "valid refresh replaces incomplete presentation");
  }
  assert.equal(refreshes, variants.length);
});

test("existing scheduler budget and concurrency errors retain safe actionable error codes", async (t) => {
  const f = await fixture(t);
  const expected = [
    ["REGIONAL_SOURCE_BUSY", "REGIONAL_SOURCE_BUSY"],
    ["tourism_visitor_history_busy", "REGIONAL_SOURCE_BUSY"],
    ["tourism_demand_strength_daily_quota_exceeded", "QUOTA_EXCEEDED"],
    ["tourism_demand_strength_manual_active", "REGIONAL_SOURCE_BUSY"],
    ["tourism_visitor_history_busy", "REGIONAL_SOURCE_BUSY"],
    ["tourism_demand_strength_state_unavailable", "CACHE_READ_ERROR"]
  ];
  for (const [sourceCode, targetCode] of expected) {
    f.options.tourismCollector[methods[1]] = async (input) => {
      if (!input.collectMissing) return tourismResult(1, input, "missing", null);
      throw Object.assign(new Error("sensitive details must not persist"), { code: sourceCode });
    };
    await f.service.start(request); await f.service.awaitIdle();
    const step = (await f.service.get(request)).steps[1];
    assert.equal(step.errorCode, targetCode); assert.equal(step.status, "failed");
  }
});


test("search trend auth failure does not discard prepared public indicators or invent a zero", async t => {
  const f=await fixture(t,{searchTrendService:{refresh:async ({regionKey})=>({regionKey,keyword:'산청글램핑',status:'failed',configured:true,errorCode:'AUTH_ERROR',networkAttempted:true,series:[]})}});
  await f.service.start(request); await f.service.awaitIdle();
  const job=await f.service.get(request), step=job.steps.find(row=>row.key==='searchTrend');
  assert.equal(job.status,'partial'); assert.equal(job.searchKeyword,'산청글램핑');
  assert.equal(step.errorCode,'AUTH_ERROR'); assert.equal(step.dataAvailable,false); assert.equal(step.zeroValuesObserved,0);
  assert.equal(job.steps.slice(0,5).every(row=>row.status==='ready'),true);
});

test("old five-step completed jobs migrate to partial without new collection", async t => {
  const f=await fixture(t); await f.service.start(request); await f.service.awaitIdle();
  const file=path.join(f.dataDir,'jobs.json'), saved=JSON.parse(await fs.readFile(file,'utf8'));
  saved.jobs[request.regionKey+'|'+request.month].steps.pop();
  await fs.writeFile(file,JSON.stringify(saved));
  const before=f.calls.length, loaded=createRegionalReportPreparation(f.options);
  const job=await loaded.get(request);
  assert.equal(job.status,'partial'); assert.equal(job.steps[5].status,'missing');
  assert.equal(job.progress.total,6); assert.equal(f.calls.length,before);
});

test("current-month trend is collected independently of tourism publication delay", async t => {
  let calls=0;
  const f=await fixture(t,{searchTrendService:{refresh:async ({regionKey,month})=>{calls++;return {regionKey,keyword:'산청글램핑',status:'partial',partialMonth:true,
    startDate:'2025-10-01',endDate:'2026-09-26',retrievedAt:stamp,configured:true,networkAttempted:true,series:[{period:month+'-01',value:23,status:'observed'}]};}}});
  const current={...request,month:'2026-09'};
  await f.service.start(current); await f.service.awaitIdle();
  const job=await f.service.get(current);
  assert.equal(calls,1); assert.equal(job.steps[5].dataAvailable,true); assert.equal(job.steps[5].partialMonth,true);
  assert.equal(job.steps[0].status,'publication_pending');
  await f.service.get(current); assert.equal(calls,1,'status polling never collects');
});

test("normal no-observation responses, publication delay and provider failures retain distinct safe diagnostics", async t => {
  const f = await fixture(t);
  const cases = [
    { reason: 'empty_verified', httpStatus: 200, apiCode: '03', status: 'missing', code: 'NO_DATA' },
    { reason: 'no_observation', httpStatus: 200, apiCode: '03', status: 'missing', code: 'NO_DATA' },
    { reason: 'period_not_closed', httpStatus: 200, apiCode: '00', status: 'publication_pending', code: 'PUBLICATION_PENDING' },
    { reason: 'api_error', httpStatus: 200, apiCode: '22', status: 'failed', code: 'QUOTA_EXCEEDED' },
    { reason: 'api_error', httpStatus: 200, apiCode: '30', status: 'failed', code: 'AUTH_ERROR' },
    { reason: 'no_observation', httpStatus: 503, apiCode: '03', status: 'failed', code: 'PROVIDER_FAILED' },
    { reason: 'timeout', httpStatus: null, apiCode: '', status: 'failed', code: 'TIMEOUT' },
    { reason: 'request_failed', httpStatus: null, apiCode: '', status: 'failed', code: 'NETWORK_ERROR' },
    { reason: 'no_observation', httpStatus: 200, apiCode: 'serviceKey=PRIVATE', status: 'missing', code: 'NO_DATA' }
  ];
  for (const item of cases) {
    f.options.tourismCollector[methods[1]] = async input => {
      const result = tourismResult(1, input, 'missing', null);
      const point = result.series[0]; point.reason = item.reason;
      point.quality = { httpStatus: item.httpStatus, apiCode: item.apiCode, message: 'serviceKey=PRIVATE', endpoint: 'https://private/' };
      result.collection.networkFailedMonths = input.collectMissing ? 1 : 0;
      return result;
    };
    await f.service.start(request); await f.service.awaitIdle();
    const step = (await f.service.get(request)).steps[1];
    assert.equal(step.status, item.status, item.reason); assert.equal(step.errorCode, item.code, item.reason);
    assert.equal(step.dataAvailable, false); assert.equal(step.zeroValuesObserved, 0);
    assert.deepEqual(step.diagnostics, { ...(item.httpStatus ? { httpStatus: item.httpStatus } : {}), ...(/^\d{2,3}$/.test(item.apiCode) ? { providerCode: item.apiCode } : {}) });
  }
  assert.equal(/PRIVATE|serviceKey|https:\/\/private/.test(await fs.readFile(path.join(f.dataDir, 'jobs.json'), 'utf8')), false);
});

test("a failed month does not mark other complete months as failed or discard their observed zeros", async t => {
  const f = await fixture(t, { historyMonths: 13 });
  const { monthsEnding } = require('./lib/insight_region_history.cjs');
  f.options.tourismCollector[methods[1]] = async input => {
    const result = tourismResult(1, input), point = result.series[0];
    result.series = monthsEnding(request.month, 13).map(month => ({ ...point, yearMonth: month.replace('-', '') }));
    result.series.at(-1).status = 'missing'; result.series.at(-1).stayOverall = null; result.series.at(-1).spendOverall = null;
    result.series.at(-1).reason = 'timeout';
    result.collection.networkFailedMonths = 1;
    result.collection.refreshErrors = [{ yearMonth: '202608', reason: 'timeout' }];
    return result;
  };
  await f.service.start(request); await f.service.awaitIdle();
  const step = (await f.service.get(request)).steps[1];
  assert.equal(step.status, 'partial'); assert.equal(step.errorCode, 'TIMEOUT');
  assert.equal(step.observedMonths, 12); assert.equal(step.failedMonths, 1); assert.equal(step.zeroValuesObserved, 24);
  assert.equal(step.periods.slice(0, -1).every(period => period.status === 'ready' && period.errorCode === ''), true);
  assert.equal(step.periods.at(-1).errorCode, 'TIMEOUT');
});

test("opt-in latest-month alignment checks new publication then fills the oldest month once per source", async t => {
  const f = await fixture(t, { historyMonths: 13, alignLatestObserved: true, now: () => new Date('2026-10-15T01:00:00.000Z') });
  const { monthsEnding } = require('./lib/insight_region_history.cjs');
  const calls = [], target = { ...request, month: '2026-09', cutoffDate: '2026-10-14' };
  methods.forEach((method, index) => { f.options.tourismCollector[method] = async input => {
    calls.push({ method, input: structuredClone(input) });
    const result = tourismResult(index, input), location = index === 0 ? result.regions[0] : result, example = location.series[0];
    result.period.months = input.months;
    location.series = monthsEnding(input.endYearMonth.slice(0, 4) + '-' + input.endYearMonth.slice(4), input.months).map(month => ({ ...example,
      yearMonth: month.replace('-', ''), ...(month === '2026-09' ? { status: 'missing', averageDailyVisitors: null, visitorDays: null,
        stayOverall: null, spendOverall: null, values: {}, reason: 'no_observation', quality: { httpStatus: 200, apiCode: '03' } } : {}) }));
    return result;
  }; });
  await f.service.start(target); await f.service.awaitIdle();
  const job = await f.service.get(target);
  for (const [index, step] of job.steps.slice(0, 4).entries()) {
    assert.equal(step.status, 'ready'); assert.equal(step.period, '202508 ~ 202608');
    assert.equal(step.requestedPeriod, '202609'); assert.equal(step.windowEndPeriod, '202608');
    assert.equal(step.observedMonths, 13); assert.equal(step.expectedMonths, 13); assert.equal(step.missingMonths, 0);
    assert.equal(step.alignedToLatestObserved, true); assert.equal(step.latestObservedPeriod, '202608');
    assert.equal(step.latestRequestedStatus, 'missing'); assert.equal(step.latestRequestedErrorCode, 'NO_DATA');
    assert.deepEqual(step.latestRequestedDiagnostics, { httpStatus: 200, providerCode: '03' });
    const inputs = calls.filter(call => call.method === methods[index]).map(call => call.input);
    assert.deepEqual(inputs.map(input => [input.endYearMonth, input.months, input.collectMissing]), [
      ['202609', index < 2 ? 25 : 24, false], ['202609', 13, true], ['202608', 13, true]
    ]);
    assert.equal(inputs.every(input => input.force === false && input.concurrency === 1), true);
    assert.equal(step.collectionPasses, 2);
  }
});

test("opt-in alignment never requests the ongoing tourism month and retains its publication-pending status separately", async t => {
  const f = await fixture(t, { historyMonths: 13, alignLatestObserved: true });
  const { monthsEnding } = require('./lib/insight_region_history.cjs'), calls = [];
  methods.forEach((method, index) => { f.options.tourismCollector[method] = async input => {
    calls.push(input); const result = tourismResult(index, input), location = index === 0 ? result.regions[0] : result;
    location.series = monthsEnding('2026-08', input.months).map(month => ({ ...location.series[0], yearMonth: month.replace('-', '') }));
    return result;
  }; });
  const target = { ...request, month: '2026-09' };
  await f.service.start(target); await f.service.awaitIdle();
  for (const step of (await f.service.get(target)).steps.slice(0, 4)) {
    assert.equal(step.status, 'ready'); assert.equal(step.observedMonths, 13); assert.equal(step.collectionPasses, 0);
    assert.equal(step.windowEndPeriod, '202608'); assert.equal(step.latestRequestedErrorCode, 'PUBLICATION_PENDING');
    assert.equal(step.latestRequestedStatus, 'publication_pending');
  }
  assert.equal(calls.every(input => input.endYearMonth === '202608' && input.collectMissing === false), true);
});

test("latest-month alignment stops on quota failure and keeps the last complete 13-month window", async t => {
  const f = await fixture(t, { historyMonths: 13, alignLatestObserved: true, now: () => new Date('2026-10-15T01:00:00.000Z') });
  const { monthsEnding } = require('./lib/insight_region_history.cjs'), calls = [];
  f.options.tourismCollector[methods[1]] = async input => {
    calls.push(input); const result = tourismResult(1, input), example = result.series[0];
    result.period.months = input.months;
    result.series = monthsEnding(input.endYearMonth.slice(0, 4) + '-' + input.endYearMonth.slice(4), input.months).map(month => ({ ...example,
      yearMonth: month.replace('-', ''), ...(month === '2026-09' ? { status: 'missing', stayOverall: null, spendOverall: null,
        reason: input.collectMissing ? 'api_error' : 'no_observation', quality: { httpStatus: 200, apiCode: input.collectMissing ? '22' : '03' } } : {}) }));
    return result;
  };
  const target = { ...request, month: '2026-09', cutoffDate: '2026-10-14' };
  await f.service.start(target); await f.service.awaitIdle();
  const step = (await f.service.get(target)).steps[1];
  assert.equal(step.status, 'partial'); assert.equal(step.errorCode, 'QUOTA_EXCEEDED');
  assert.equal(step.windowEndPeriod, '202608'); assert.equal(step.observedMonths, 13); assert.equal(step.cacheReused, true);
  assert.equal(step.latestRequestedErrorCode, 'QUOTA_EXCEEDED'); assert.equal(step.collectionPasses, 1);
  assert.equal(calls.length, 2, 'one cache read and one refresh; quota failure prevents supplemental collection');
  assert.deepEqual(step.diagnostics, { httpStatus: 200, providerCode: '22' });
});
