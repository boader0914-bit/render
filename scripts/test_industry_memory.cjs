"use strict";

// A separate, bounded-heap process exercises retained full observation rows.
// It uses no live data, files, server, scheduler or external requests. Test GC
// provides a deterministic retention check; production must not force GC.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const v8 = require("node:v8");

const ROOT = path.resolve(__dirname, "..");
const MODULE_FILE = path.join(__dirname, "lib", "industry_analysis.cjs");
const COMPANY_COUNT = 143, OBSERVED_COMPANIES = 103, RUN_COUNT = 80, DAYS_PER_RUN = 15;
const DETAIL_BYTES = 1000, HEAP_MIB = 120;
const REGIONS = [
  { id: "kr_gyeongnam_sacheon", label: "경상남도 사천시", level: "local" },
  { id: "kr_gyeonggi_pocheon", label: "경기도 포천시", level: "local" }
];

function digestRows(rows) {
  const hash = crypto.createHash("sha256");
  for (const row of rows) hash.update(JSON.stringify(row)).update("\n");
  return hash.digest("hex");
}
function stableResult(result) {
  const { generatedAt, ...stable } = result;
  return stable;
}
function loadService(mode) {
  if (mode !== "baseline") return require(MODULE_FILE).createIndustryAnalysisService;
  const Module = require("node:module");
  const old = new Module(MODULE_FILE, module);
  old.filename = MODULE_FILE;
  old.paths = Module._nodeModulePaths(path.dirname(MODULE_FILE));
  old._compile(fs.readFileSync(0, "utf8"), MODULE_FILE);
  return old.exports.createIndustryAnalysisService;
}

async function child(mode) {
  global.fetch = async () => { throw new Error("External requests forbidden in industry memory fixture"); };
  assert.equal(typeof global.gc, "function", "fixture process must use --expose-gc");
  const createService = loadService(mode), weakSources = [], reads = [], samples = [];
  let clock = new Date("2026-10-11T00:00:00Z");
  const idleTimers = new Set(), timerHistory = [];
  if (mode === "idle") {
    const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
    global.setTimeout = (callback, delay, ...args) => {
      if (delay !== 30000) return realSetTimeout(callback, delay, ...args);
      const handle = { callback, unreferenced: false, unref() { this.unreferenced = true; return this; } };
      idleTimers.add(handle); timerHistory.push(handle); return handle;
    };
    global.clearTimeout = handle => {
      if (timerHistory.includes(handle)) idleTimers.delete(handle);
      else realClearTimeout(handle);
    };
  }
  function memory(label) {
    const value = process.memoryUsage();
    samples.push({ label, heapMiB: Math.round(value.heapUsed / 1024 / 1024 * 10) / 10,
      rssMiB: Math.round(value.rss / 1024 / 1024 * 10) / 10 });
    console.log(JSON.stringify({ stage: "memory", ...samples.at(-1) }));
  }
  function pair(month) {
    const stamp = month + "-01T00:00:00Z";
    const companies = Array.from({ length: COMPANY_COUNT }, (_, index) => ({
      companyId: `fixture-${index}`, primaryName: `모의 글램핑 ${index}`, capacity: 10,
      capacitySource: "관리자 검수", regionKey: index < 5 || index === 103 || index === 104 ? REGIONS[0].id : REGIONS[1].id,
      lodgingTypes: ["글램핑"]
    }));
    const rawCompanies = new Map(companies.map(company => [company.companyId,
      { ...company, addresses: [REGIONS.find(region => region.id === company.regionKey).label + " 모의로"] }]));
    const runs = Array.from({ length: RUN_COUNT }, (_, index) => ({ id: `fixture-${month}-${index}`, keyword: "모의글램핑",
      collectedAt: stamp, collectedAtSource: "manifest", searchMode: "keyword", collectionQuality: { status: "complete" } }));
    // Rank-only members preserve missing inventory. Every run exposes only its
    // own top twenty; the month union can contain more than twenty companies.
    const rankObservations = companies.map((company, index) => ({ companyId: company.companyId,
      runId: runs[index % RUN_COUNT].id, keyword: "모의글램핑", collectedAt: stamp, rank: index % 20 + 1 }));
    const observations = [];
    for (let runIndex = 0; runIndex < RUN_COUNT; runIndex++) for (let rank = 0; rank < 20; rank++) {
      const companyId = companies[(runIndex * 20 + rank) % OBSERVED_COMPANIES].companyId;
      for (let day = 1; day <= DAYS_PER_RUN; day++) {
        const date = month + "-" + String(day).padStart(2, "0");
        // Independent, flattened strings model retained price-basis detail.
        // Sharing one repeated padding string would understate live heap cost.
        const priceNote = Buffer.alloc(DETAIL_BYTES, (observations.length % 251) + 1).toString("base64");
        observations.push({ companyId, companyKey: companyId, observationId: `${month}-${observations.length}`,
          runId: runs[runIndex].id, keyword: "모의글램핑", stayDate: date, collectedAt: stamp,
          productType: "lodging", inventoryEvidenceVersion: 4, supply: 10, sold: 3,
          publicBookings: 1, phoneBookings: 2, publicRevenue: 100, phoneRevenue: 200, estimatedRevenue: 300,
          phonePricedBookings: 2, phoneMissingPriceBookings: 0, phoneFallbackRevenue: 0, phoneFallbackBookings: 0,
          sharedDayUseExcluded: 0, explicitBlockedBookings: 0, explicitBlockedRevenue: 0,
          partial: false, missing: false, unknownUnavailable: 0,
          phonePriceEstimates: [{ sourceDate: date, sourceType: "lodging", bookings: 2, estimatedPrice: 100,
            basisNote: `${month}/${runIndex}/${rank}/${day}:` + priceNote }] });
      }
    }
    const digest = digestRows(observations);
    weakSources.push({ month, rows: new WeakRef(observations), digest });
    return { source: { companies, observations, runs, rankObservations, regions: REGIONS },
      catalog: { companies, rawCompanies, runs, regions: REGIONS } };
  }
  // Keep the pre-existing TTL/eviction regression under an explicit allowance;
  // the separate uncached mode verifies the smaller production-default budget.
  const service = createService({ now: () => clock, ...(mode === "uncached" ? {} : { sourceCacheMaxBytes: 128 * 1024 * 1024 }), sources: {
    loadSourcesWithCatalog: async request => {
      // End the WeakRef keep-alive job before checking a previous allocation.
      await new Promise(resolve => setImmediate(resolve));
      global.gc();
      const retained = weakSources.filter(source => source.rows.deref() !== undefined).map(source => source.month);
      memory(`before-read-${request.month}`);
      console.log(JSON.stringify({ stage: "source-read", month: request.month, retainedPriorMonths: retained }));
      if (mode !== "baseline") assert.deepEqual(retained, [], "expired/different-month full rows must be released BEFORE the next allocation");
      reads.push(request.month);
      const value = pair(request.month);
      memory(`allocated-${request.month}`);
      return value;
    },
    loadSources: async () => { throw new Error("paired reader required"); },
    catalog: async () => { throw new Error("paired reader must share its catalog"); }
  }, readContext: async () => ({ sources: [], warnings: [], networkAttempted: false }) });
  function unchangedSource() {
    const latest = weakSources.at(-1), rows = latest.rows.deref();
    assert.ok(rows, "valid same-month cache remains reachable");
    assert.equal(digestRows(rows), latest.digest, "aggregation cannot mutate source identity/hash");
  }
  const query = (month, region) => ({ month, industry: "glamping", region });
  let first = await service.analyze(query("2026-09", REGIONS[0].id));
  assert.equal(first.summary.companyCount, 7);
  assert.equal(first.summary.observedCompanies, 5);
  assert.equal(first.summary.coveredCompanyDays, 5 * DAYS_PER_RUN);
  assert.equal(first.summary.expectedCompanyDays, 7 * 30);
  assert.ok(Math.abs(first.summary.reservationRate - .3) < Number.EPSILON);
  assert.equal(first.summary.estimatedRevenue, 5 * DAYS_PER_RUN * 300);
  const original = stableResult(first);
  if (mode === "uncached") {
    const latest = weakSources.at(-1);
    assert.equal(digestRows(latest.rows.deref()), latest.digest, "the original retained evidence is not trimmed to fit the cache");
    first = null;
    await new Promise(resolve => setImmediate(resolve)); global.gc();
    assert.ok(weakSources.every(source => source.rows.deref() === undefined), "the default 8 MiB budget must release an oversize completed source without waiting for TTL");
    const reloaded = await service.analyze(query("2026-09", REGIONS[0].id));
    assert.deepEqual(stableResult(reloaded), original, "not caching an oversize source cannot change any result value");
    assert.deepEqual(reads, ["2026-09", "2026-09"]);
    await service.stop();
    console.log(JSON.stringify({ status: "passed", mode, observationsPerRead: RUN_COUNT * 20 * DAYS_PER_RUN,
      peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), samples })); return;
  }
  unchangedSource(); memory("first-analysis");
  // The other regional condition uses the same unexpired source allocation.
  const otherRegion = await service.analyze(query("2026-09", REGIONS[1].id));
  assert.equal(otherRegion.summary.companyCount, 136);
  assert.equal(reads.length, 1);
  first = null;
  clock = new Date(clock.getTime() + 31000);
  const sameMonthReload = await service.analyze(query("2026-09", REGIONS[0].id));
  assert.deepEqual(stableResult(sameMonthReload), original, "expiration alone preserves every output field");
  assert.deepEqual(reads, ["2026-09", "2026-09"]);
  unchangedSource(); memory("expired-same-month-analysis");
  clock = new Date(clock.getTime() + 31000);
  const october = await service.analyze(query("2026-10", REGIONS[0].id));
  assert.equal(october.summary.companyCount, 7);
  assert.equal(october.summary.expectedCompanyDays, 7 * 31);
  assert.deepEqual(reads, ["2026-09", "2026-09", "2026-10"]);
  unchangedSource(); memory("second-month-analysis");
  clock = new Date(clock.getTime() + 31000);
  const reopened = await service.analyze(query("2026-09", REGIONS[0].id));
  assert.deepEqual(stableResult(reopened), original, "reloading released sources preserves every numerical and source field");
  assert.deepEqual(reads, ["2026-09", "2026-09", "2026-10", "2026-09"]);
  unchangedSource(); memory("reopened-first-month");
  if (mode === "idle") {
    assert.equal(idleTimers.size, 1, "replaced sources cancel old expiry timers");
    assert.ok(timerHistory.every(timer => timer.unreferenced), "source timers must not keep the server process alive");
    timerHistory[0].callback();
    unchangedSource();
    assert.equal(idleTimers.size, 1, "stale callbacks cannot evict the current source");
    clock = new Date(clock.getTime() + 31000);
    for (const timer of idleTimers) timer.callback();
    idleTimers.clear();
    // No industry read occurs between idle expiration and the other engine's
    // allocation. Lazy-only expiry would retain the last full observation set.
    await new Promise(resolve => setImmediate(resolve)); global.gc();
    assert.ok(weakSources.every(source => source.rows.deref() === undefined), "idle TTL must release rows without a subsequent industry request");
    memory("idle-expired-before-company-read");
    const independentCompanySource = pair("2026-10");
    assert.equal(digestRows(independentCompanySource.source.observations), weakSources.at(-1).digest);
    memory("independent-company-source-allocation");
    assert.equal(reads.length, 4, "independent engine allocation is not an industry reload");
  }
  await service.stop();
  if (mode === "current") {
    await new Promise(resolve => setImmediate(resolve)); global.gc();
    assert.ok(weakSources.every(source => source.rows.deref() === undefined), "stop must release completed full-source references");
  }
  if (mode === "idle") assert.equal(idleTimers.size, 0, "stop leaves no source timer behind");
  console.log(JSON.stringify({ status: "passed", mode, heapLimitMiB: Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024),
    observationsPerRead: RUN_COUNT * 20 * DAYS_PER_RUN, companyCount: COMPANY_COUNT,
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), samples }));
}

function runChild(mode, input) {
  const result = spawnSync(process.execPath, ["--expose-gc", `--max-old-space-size=${HEAP_MIB}`,
    "--max-semi-space-size=4", __filename, "--child", mode], {
    cwd: ROOT, windowsHide: true, encoding: "utf8", input, timeout: 60000, maxBuffer: 1024 * 1024
  });
  process.stdout.write(result.stdout || "");
  if (result.error) throw result.error;
  if (result.status !== 0) process.stderr.write(result.stderr || "");
  return result;
}
async function main() {
  if (process.argv[2] === "--child") return child(process.argv[3]);
  const baselineIndex = process.argv.indexOf("--compare-baseline");
  if (baselineIndex >= 0) {
    const ref = process.argv[baselineIndex + 1];
    assert.ok(ref && /^[\w./-]+$/.test(ref), "provide a local baseline Git ref");
    const source = spawnSync("git", ["show", `${ref}:scripts/lib/industry_analysis.cjs`],
      { cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
    assert.equal(source.status, 0, source.stderr);
    const baseline = runChild("baseline", source.stdout);
    assert.notEqual(baseline.status, 0, "the old cache must fail this bounded-heap fixture");
    assert.match(baseline.stderr || "", /heap out of memory|Allocation failed/i, "baseline failure must be heap exhaustion, not a fixture assertion");
    console.log("Baseline cache failed with the expected heap exhaustion.");
  }
  const current = runChild("current");
  assert.equal(current.status, 0, "current cache must pass bounded-heap and source-retention checks");
  const idle = runChild("idle");
  assert.equal(idle.status, 0, "idle expiry must release full sources before another engine allocates");
  const uncached = runChild("uncached");
  assert.equal(uncached.status, 0, "the default byte budget must release an oversize source immediately and preserve recalculated values");
  console.log("Industry memory fixture passed: bounded cache, regional reuse, idle and replacement release, unchanged hashes and exact outputs.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
