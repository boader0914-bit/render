"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createRegionalMarketMissingService, WEEK_MS, MAX_REGIONS, MAX_STATE_BYTES } = require("./lib/regional_market_missing.cjs");
const { createKosisService, DEFINITIONS } = require("./lib/kosis.cjs");
const NOW = "2026-10-26T01:00:00.000Z", KEYS = ["population", "households", "establishments", "employment", "manufacturing_establishments", "manufacturing_employment"];
const canonical = regionKey => ({ regionKey, officialCode: "48860", level: "local", unitType: "county", active: true, selectable: true });
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
function result(status = "not_needed", overrides = {}) {
  return { marketCollection: { schemaVersion: 1, mode: "missing_only", status, attemptedDatasetKeys: [], collectedDatasetKeys: [], eligibleDatasetKeys: [],
    skipped: KEYS.map(datasetKey => ({ datasetKey, status: "available", reasonCode: "" })), remaining: [], changed: false, networkAttempted: false, stopReason: null, ...overrides } };
}
const collected = () => result("complete", { attemptedDatasetKeys: [...KEYS], collectedDatasetKeys: [...KEYS], eligibleDatasetKeys: [...KEYS], skipped: [], changed: true, networkAttempted: true });
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "regional-market-missing-")); t.after(async () => {
    const resolved = path.resolve(dataDir); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("regional-market-missing-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const source = path.join(dataDir, "original-source.json"); await fs.writeFile(source, "authoritative immutable source"); const sourceHash = digest(await fs.readFile(source));
  let current = NOW; const calls = [], projections = [];
  const options = { dataDir, readTargets: async () => ["sancheong", "jinju"], resolveRegion: async key => canonical(key),
    kosisService: { refreshMissingMarketRegion: async key => { calls.push(key); return result(); } },
    onRegionChanged: async (key, summary) => { projections.push({ key, summary }); }, now: () => current, ...overrides };
  const service = createRegionalMarketMissingService(options); t.after(() => service.close());
  return { dataDir, source, sourceHash, calls, projections, service, options, advance: ms => { current = new Date(Date.parse(current) + ms).toISOString(); },
    file: path.join(dataDir, "regional_market_missing", "latest-job.json"), directory: path.join(dataDir, "regional_market_missing") };
}
async function run(f) { const requested = await f.service.request(); assert.equal(requested.reused, false); await f.service.idle(); return (await f.service.get()).job; }

test("constructor and get are cache-only and never create a missing directory or enumerate target companies", async t => {
  const f = await fixture(t, { readTargets: async () => { assert.fail("target inventory is not a GET side effect"); } });
  assert.deepEqual(await f.service.get(), { schemaVersion: 1, intervalHours: 168, maxRegions: MAX_REGIONS, job: null });
  assert.deepEqual(await fs.readdir(f.dataDir), ["original-source.json"]); assert.deepEqual(f.calls, []);
});
test("one shared service call per distinct eligible registered region and safe cache-only projections", async t => {
  const f = await fixture(t, { readTargets: async () => ["sancheong", "sancheong", "jinju", null, "not a key", "inactive", "broad", "district"],
    resolveRegion: async key => ({ ...canonical(key), ...(key === "inactive" ? { active: false } : key === "broad" ? { level: "broad" } : key === "district" ? { unitType: "general_district" } : {}) }) });
  const job = await run(f); assert.equal(job.status, "partial"); assert.deepEqual(f.calls, ["jinju", "sancheong"]); assert.equal(f.projections.length, 2);
  assert.deepEqual(job.inventory, { inputCount: 8, uniqueRegionCount: 5, eligibleRegionCount: 2, unknownRegionCount: 2, excludedCount: 3 });
  assert.equal(job.counts.networkAttemptedRegions, 0); assert.equal(job.counts.changedRegions, 0); assert.equal(job.counts.inspectedRegions, 2);
  assert.equal(digest(await fs.readFile(f.source)), f.sourceHash); assert.deepEqual((await fs.readdir(f.dataDir)).sort(), ["original-source.json", "regional_market_missing"]);
});
test("all valid cached statistics are complete without provider-network claims and still produce missing local projections", async t => {
  const f = await fixture(t); const job = await run(f); assert.equal(job.status, "complete"); assert.equal(job.counts.collectedDatasets, 0);
  assert.ok(job.regions.every(item => item.summary.status === "not_needed" && item.projected)); assert.equal(f.projections.length, 2);
});
test("a missing-only successful refresh records table counts without persisting source payload, company PII, tokens or coordinates", async t => {
  const f = await fixture(t, { readTargets: async () => ["jinju"], kosisService: { refreshMissingMarketRegion: async () => ({ ...collected(), datasets: [{ raw: "PRIVATE_PROVIDER_RESPONSE", apiKey: "PRIVATE_KEY" }], phone: "PRIVATE_CONTACT" }) } });
  const job = await run(f); assert.equal(job.status, "complete"); assert.equal(job.counts.collectedDatasets, 6); assert.equal(job.counts.networkAttemptedRegions, 1);
  const saved = await fs.readFile(f.file, "utf8"); for (const value of ["PRIVATE_PROVIDER_RESPONSE", "PRIVATE_KEY", "PRIVATE_CONTACT", "latitude", "longitude"]) assert.equal(saved.includes(value), false);
});
test("suppressed, unverified, absent and true available values remain separate without conversion to zero", async t => {
  const f = await fixture(t, { readTargets: async () => ["jinju"], kosisService: { refreshMissingMarketRegion: async () => result("partial", {
    skipped: [{ datasetKey: "population", status: "available", reasonCode: "" }, { datasetKey: "households", status: "suppressed", reasonCode: "MISSING_VALUES" }, { datasetKey: "employment", status: "unverified", reasonCode: "RAW_RESPONSE_NOT_RETAINED" }],
    remaining: [{ datasetKey: "establishments", status: "missing", reasonCode: "NO_DATA" }] }) } });
  const job = await run(f); assert.equal(job.status, "partial"); assert.equal(job.counts.missingDatasets, 1); assert.equal(job.counts.heldDatasets, 2);
  assert.deepEqual(job.regions[0].summary.skipped.map(item => item.status), ["available", "suppressed", "unverified"]); assert.equal(JSON.stringify(job).includes('"value":0'), false);
});
for (const reason of ["AUTH_ERROR", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR", "EVIDENCE_WRITE_ERROR", "CACHE_READ_ERROR"]) {
  test(`${reason} stops subsequent regions and remains blocked for the entire weekly window`, async t => {
    const calls = []; const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async key => { calls.push(key); return result("blocked", { skipped: [], stopReason: reason }); } } });
    const job = await run(f); assert.equal(job.status, "blocked"); assert.equal(job.stopReason, reason); assert.deepEqual(calls, ["jinju"]);
    assert.equal(job.regions[1].status, "not_checked"); assert.equal(job.regions[1].reasonCode, reason); assert.equal(f.projections.length, 0);
    f.advance(WEEK_MS - 1); assert.equal((await f.service.request()).reused, true); await f.service.idle(); assert.equal(calls.length, 1);
  });
}
test("shared KOSIS in-flight work is held without false attribution or retry", async t => {
  const calls = []; const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async key => { calls.push(key); return result("shared_inflight", { skipped: [] }); } } });
  const job = await run(f); assert.equal(job.status, "blocked"); assert.equal(job.stopReason, "SHARED_INFLIGHT"); assert.deepEqual(calls, ["jinju"]); assert.equal(job.counts.networkAttemptedRegions, 0);
});
test("concurrent requests reuse one durable job, and get never triggers another attempt", async t => {
  let resume; const wait = new Promise(resolve => { resume = resolve; }); const calls = [];
  const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async key => { calls.push(key); await wait; return collected(); } } });
  const requests = await Promise.all([f.service.request(), f.service.request(), f.service.request()]); assert.equal(requests.filter(value => !value.reused).length, 1);
  assert.equal(new Set(requests.map(value => value.job.id)).size, 1); await f.service.get(); await f.service.get(); resume(); await f.service.idle();
  assert.deepEqual(calls, ["jinju", "sancheong"]); assert.equal((await f.service.get()).job.status, "complete");
});
test("cache-only readers remain valid through this instance's repeated atomic job replacements", async t => {
  const calls = []; const f = await fixture(t, { readTargets: async () => Array.from({ length: 8 }, (_, index) => `region_${index}`),
    kosisService: { refreshMissingMarketRegion: async key => { calls.push(key); await new Promise(resolve => setImmediate(resolve)); return collected(); } } });
  const request = await f.service.request();
  const observations = await Promise.all(Array.from({ length: 8 }, async () => {
    const values = []; for (let index = 0; index < 12; index++) values.push(await f.service.get()); return values;
  }));
  await f.service.idle(); assert.equal(calls.length, 8);
  for (const value of observations.flat()) { assert.equal(value.job.id, request.job.id); assert.notEqual(value.job.status, "needs_verification"); }
  assert.equal((await f.service.get()).job.status, "complete");
});
test("success, partial and failed jobs cannot move the weekly window by being requested again", async t => {
  for (const outcome of [result(), result("partial", { remaining: [{ datasetKey: "population", status: "missing", reasonCode: "NO_DATA" }] }), new Error("secret failure")]) {
    let calls = 0; const f = await fixture(t, { readTargets: async () => ["jinju"], kosisService: { refreshMissingMarketRegion: async () => { calls++; if (outcome instanceof Error) throw outcome; return outcome; } } });
    const first = await run(f), at = first.nextEligibleAt; f.advance(WEEK_MS - 1); const repeat = await f.service.request(); assert.equal(repeat.reused, true); assert.equal(repeat.job.nextEligibleAt, at); assert.equal(calls, 1);
    f.advance(1); assert.equal((await f.service.request()).reused, false); await f.service.idle(); assert.equal(calls, 2);
  }
});
test("a recovered unfinished job is a verification hold with zero file writes and no automatic collection, including after seven days", async t => {
  const f = await fixture(t); await fs.mkdir(f.directory);
  const job = { schemaVersion: 1, id: "12345678-1234-4234-8234-123456789abc", kind: "weekly_missing_market", mode: "missing_only", status: "running", queuedAt: NOW, startedAt: NOW, finishedAt: null,
    nextEligibleAt: new Date(Date.parse(NOW) + WEEK_MS).toISOString(), inventory: { inputCount: 1, uniqueRegionCount: 1, eligibleRegionCount: 1, unknownRegionCount: 0, excludedCount: 0 },
    regions: [{ regionKey: "jinju", status: "running", reasonCode: null, summary: null, projected: false }], excluded: [], counts: { inspectedRegions: 0, networkAttemptedRegions: 0, unknownAttemptRegions: 1, changedRegions: 0, collectedDatasets: 0, missingDatasets: 0, heldDatasets: 0 }, stopReason: null };
  await fs.writeFile(f.file, JSON.stringify({ schemaVersion: 1, job })); const before = await fs.readFile(f.file);
  assert.equal((await f.service.get()).job.status, "needs_verification"); f.advance(2 * WEEK_MS); const request = await f.service.request(); assert.equal(request.reused, true); assert.equal(request.job.stopReason, "INTERRUPTED_JOB");
  assert.deepEqual(await fs.readFile(f.file), before); assert.deepEqual(f.calls, []); assert.deepEqual(await fs.readdir(f.directory), ["latest-job.json"]);
});
test("invalid provider summary stops the job and never outputs arbitrary provider error text", async t => {
  const calls = []; const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async key => { calls.push(key); return { marketCollection: { ...collected().marketCollection, attemptedDatasetKeys: ["age_population"], error: "PRIVATE_KEY" } }; } } });
  const job = await run(f); assert.equal(job.status, "needs_verification"); assert.equal(job.stopReason, "COLLECTION_CONTRACT_INVALID"); assert.deepEqual(calls, ["jinju"]); assert.equal(JSON.stringify(job).includes("PRIVATE_KEY"), false);
});
test("cache projection failure is visible and does not replay already collected KOSIS tables", async t => {
  const calls = []; const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async key => { calls.push(key); return collected(); } }, onRegionChanged: async () => { throw new Error("private callback failure"); } });
  const job = await run(f); assert.equal(job.status, "needs_verification"); assert.equal(job.stopReason, "CACHE_PROJECTION_FAILED"); assert.equal(job.counts.collectedDatasets, 6); assert.deepEqual(calls, ["jinju"]);
  assert.equal((await f.service.request()).reused, true); assert.equal(JSON.stringify(job).includes("private"), false);
});
test("a lost provider acknowledgement is an unknown attempt rather than a reported zero network attempt", async t => {
  const f = await fixture(t, { kosisService: { refreshMissingMarketRegion: async () => { throw new Error("lost response with private authentication detail"); } } });
  const job = await run(f); assert.equal(job.counts.unknownAttemptRegions, 1); assert.equal(job.counts.inspectedRegions, 0);
  assert.equal(job.regions[0].status, "needs_verification"); assert.equal(job.regions[0].summary, null); assert.equal(JSON.stringify(job).includes("authentication"), false);
});
test("first partial evidence can change the cache without falsely claiming any fully collected dataset", async t => {
  const f = await fixture(t, { readTargets: async () => ["jinju"], kosisService: { refreshMissingMarketRegion: async () => result("partial", {
    attemptedDatasetKeys: ["population"], eligibleDatasetKeys: ["population"], collectedDatasetKeys: [], changed: true, networkAttempted: true,
    remaining: [{ datasetKey: "population", status: "missing", reasonCode: "MISSING_VALUES" }], skipped: [] }) } });
  const job = await run(f); assert.equal(job.status, "partial"); assert.equal(job.counts.changedRegions, 1); assert.equal(job.counts.collectedDatasets, 0); assert.equal(f.projections.length, 1);
});
test("inventory failures and a noncanonical resolver stop before any provider call", async t => {
  for (const options of [{ readTargets: async () => { throw new Error("private roster"); } }, { resolveRegion: async () => { throw new Error("private resolver"); } }]) {
    const f = await fixture(t, options), job = await run(f); assert.equal(job.status, "needs_verification"); assert.deepEqual(f.calls, []); assert.equal(JSON.stringify(job).includes("private"), false);
  }
  const f = await fixture(t, { resolveRegion: async () => canonical("another") }), job = await run(f); assert.equal(job.status, "partial"); assert.equal(job.inventory.excludedCount, 2); assert.deepEqual(f.calls, []);
});
test("an oversized distinct inventory fails closed rather than collecting an arbitrary subset", async t => {
  const f = await fixture(t, { readTargets: async () => Array.from({ length: MAX_REGIONS + 1 }, (_, index) => `region_${index}`) });
  const job = await run(f); assert.equal(job.status, "failed"); assert.equal(job.stopReason, "INVENTORY_TOO_LARGE"); assert.deepEqual(f.calls, []);
});
test("bad, oversized and unexpectedly shaped stored state fails closed without collecting", async t => {
  const f = await fixture(t); await fs.mkdir(f.directory);
  for (const bytes of ["not json", JSON.stringify({ schemaVersion: 1, job: {}, private: "PII" }), "x".repeat(MAX_STATE_BYTES + 1)]) {
    await fs.writeFile(f.file, bytes); await assert.rejects(f.service.get(), { code: "REGIONAL_MARKET_MISSING_STATE_INVALID" }); await assert.rejects(f.service.request(), { code: "REGIONAL_MARKET_MISSING_STATE_INVALID" }); assert.deepEqual(f.calls, []);
  }
});
test("directory and state symlinks are rejected without following or changing their targets", async t => {
  if (process.platform === "win32") { t.skip("Windows symlink creation is privilege-dependent; checked on Linux in release validation"); return; }
  const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), "regional-market-outside-")); t.after(async () => {
    const resolved = path.resolve(outside); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("regional-market-outside-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.symlink(outside, f.directory); await assert.rejects(f.service.get(), { code: "REGIONAL_MARKET_MISSING_UNSAFE_PATH" }); await assert.rejects(f.service.request(), { code: "REGIONAL_MARKET_MISSING_UNSAFE_PATH" }); assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(f.directory); await fs.mkdir(f.directory); const target = path.join(outside, "sentinel.json"); await fs.writeFile(target, "unaltered"); await fs.symlink(target, f.file);
  await assert.rejects(f.service.get(), { code: "REGIONAL_MARKET_MISSING_STATE_INVALID" }); await assert.rejects(f.service.request(), { code: "REGIONAL_MARKET_MISSING_STATE_INVALID" }); assert.equal(await fs.readFile(target, "utf8"), "unaltered");
});
test("an unexplained existing request lock is not removed or bypassed", async t => {
  const f = await fixture(t); await fs.mkdir(f.directory); const lock = path.join(f.directory, "request.lock"); await fs.writeFile(lock, "preserved stale lock");
  await assert.rejects(f.service.request(), { code: "REGIONAL_MARKET_MISSING_LOCKED" }); assert.equal(await fs.readFile(lock, "utf8"), "preserved stale lock"); assert.deepEqual(f.calls, []);
});
test("request rejects forcing, scope changes and collection knobs rather than accepting an implicit override", async t => {
  const f = await fixture(t); for (const input of [{ force: true }, { regionKey: "jinju" }, { collectMissing: false }, { intervalHours: 1 }, null, []]) await assert.rejects(f.service.request(input), { code: "REGIONAL_MARKET_MISSING_INVALID_REQUEST" });
  assert.deepEqual(f.calls, []); await f.service.close(); await assert.rejects(f.service.request(), { code: "REGIONAL_MARKET_MISSING_CLOSED" });
});

async function combinedFixture(t, outcome = "complete") {
  const regionKey = "kr_gyeonggi_pocheon", f = await fixture(t, { readTargets: async () => [regionKey], resolveRegion: async key => ({ ...canonical(key), officialCode: "4165000000", unitType: "city" }) });
  const regionMasterFile = path.join(f.dataDir, "region-master.json");
  await fs.writeFile(regionMasterFile, JSON.stringify({ units: [
    { regionKey: "kr_admin_4100000000", regionId: "kr_admin_4100000000", provinceRegionId: "kr_admin_4100000000", name: "경기도", sidoFull: "경기도", level: "broad", active: true },
    { regionKey, regionId: "kr_admin_4165000000", provinceRegionId: "kr_admin_4100000000", name: "포천시", fullName: "경기도 포천시", sidoFull: "경기도", level: "local", active: true }
  ] }));
  let clockOffset = 0; const network = [];
  const kosisService = createKosisService({ dataDir: path.join(f.dataDir, "kosis"), regionMasterFile, readApiKey: () => "synthetic-key-for-injected-provider", now: () => Date.parse(f.options.now()) + clockOffset,
    sleep: async ms => { clockOffset += ms; }, fetchImpl: async rawUrl => {
      const url = new URL(rawUrl), definition = DEFINITIONS.find(item => item.tableId === url.searchParams.get("tblId")); network.push(definition.key);
      if (outcome === "quota") return { ok: true, status: 200, text: async () => JSON.stringify({ err: "40", errMsg: "synthetic quota fixture" }) };
      const sgg = definition.regionObject === "SGG", code = sgg ? "31270" : "41650", province = sgg ? "31" : "41";
      const payload = url.searchParams.get("method") === "getMeta" ? [
        ...definition.metrics.map(metric => ({ OBJ_ID: "ITEM", ITM_ID: metric.id, ITM_NM: metric.label, UNIT_NM: metric.unit })),
        { OBJ_ID: definition.regionObject, OBJ_ID_SN: 1, ITM_ID: province, ITM_NM: "경기도", UP_ITM_ID: "00" },
        { OBJ_ID: definition.regionObject, OBJ_ID_SN: 1, ITM_ID: code, ITM_NM: "포천시", UP_ITM_ID: province }
      ] : definition.metrics.map(metric => ({ TBL_ID: definition.tableId, ORG_ID: definition.orgId, ITM_ID: metric.id, C1: code, PRD_SE: definition.periodType === "Y" ? "A" : "M",
        PRD_DE: definition.periodType === "M" ? "202609" : "2024", UNIT_NM: metric.unit, DT: outcome === "partial" ? "..." : "123", LST_CHN_DE: "20261010" }));
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    } });
  await f.service.close();
  const service = createRegionalMarketMissingService({ ...f.options, kosisService }); t.after(() => service.close());
  return { ...f, service, network, kosisService };
}
test("real KOSIS missing-only service and coordinator agree on six-table success and later cache-only weekly checks", async t => {
  const f = await combinedFixture(t), first = await run(f); assert.equal(first.status, "complete"); assert.equal(first.counts.collectedDatasets, 6);
  assert.equal(f.network.length, 12); assert.equal(f.network.includes("age_population"), false); assert.equal(f.projections.length, 1);
  f.advance(WEEK_MS); const second = await run(f); assert.equal(second.status, "complete"); assert.equal(second.regions[0].summary.status, "not_needed");
  assert.equal(second.counts.networkAttemptedRegions, 0); assert.equal(f.network.length, 12); assert.equal(f.projections.length, 2);
});
test("real first partial KOSIS evidence is changed with zero complete tables and six suppressed holds", async t => {
  const f = await combinedFixture(t, "partial"), job = await run(f); assert.equal(job.status, "partial"); assert.equal(job.counts.collectedDatasets, 0);
  assert.equal(job.counts.changedRegions, 1); assert.equal(job.counts.heldDatasets, 6); assert.equal(job.counts.missingDatasets, 0); assert.equal(f.network.length, 12);
  assert.equal(job.regions[0].summary.changed, true); assert.equal(f.projections.length, 1);
});
test("real KOSIS quota stop is propagated without any subsequent table or region calls", async t => {
  const f = await combinedFixture(t, "quota"), job = await run(f); assert.equal(job.status, "blocked"); assert.equal(job.stopReason, "QUOTA_EXCEEDED");
  assert.equal(f.network.length, 1); assert.equal(job.counts.networkAttemptedRegions, 1); assert.equal(job.counts.collectedDatasets, 0); assert.equal(f.projections.length, 0);
});
