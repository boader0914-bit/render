"use strict";

// LOCAL SYNTHETIC benchmark. No provider responses, credentials, production
// files, crawler or server are used. The baseline is the approved 3f49cc6
// monthly source adapter; dependencies/capacity preparation use current code.
// This isolates the adapter's allocation behavior, not a complete old release.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises"), native = require("node:fs");
const path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { Module, createRequire } = require("node:module");
const { performance } = require("node:perf_hooks");

const ROOT = path.resolve(__dirname, ".."), BASELINE = "3f49cc6948e11b0afb9af1dd8138cdead1818002";
const COMPANIES = 539, DETAIL_BYTES = 1536, HEAP_MIB = 768;
const MONTHS = ["2026-08", "2026-09", "2026-10"], NOW = "2026-11-02T00:00:00.000Z";
const idOf = index => `cmp_place_background_${index}`;
const runOf = (month, partial = false) => `synthetic_${partial ? "partial" : "complete"}_glamping_${month.replace("-", "")}01_090000`;
const dayCount = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
const round = value => Math.round(value * 1000) / 1000;
const digest = value => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const identity = row => String(row?.companyId || row?.companyKey || row?.id || "");
// The live company materializer applies this scope after loadSources returns.
// Compare the same company contract, not the intentionally reduced raw adapter
// arrays. Keep global quality/context metadata unchanged for equality checks.
function scopedSources(source, companyId) {
  const observations = (source.observations || []).filter(row => identity(row) === companyId);
  const rankObservations = (source.rankObservations || []).filter(row => identity(row) === companyId);
  const runIds = new Set([...observations, ...rankObservations].map(row => String(row.runId || "")));
  return { ...source, companies: (source.companies || []).filter(row => identity(row) === companyId), observations, rankObservations,
    runs: (source.runs || []).filter(run => runIds.has(String(run.id || run.runId || ""))) };
}

function observation(companyIndex, month, day) {
  const date = `${month}-${String(day).padStart(2, "0")}`, partialRun = companyIndex === 1;
  const row = { observationId: `synthetic-${companyIndex}-${date}`, companyKey: idOf(companyIndex),
    companyId: idOf(companyIndex), runId: runOf(month, partialRun), keyword: "[SYNTHETIC] 배후시장 글램핑",
    stayDate: date, collectedAt: `${month}-01T00:00:00.000Z`, productType: "lodging", inventoryEvidenceVersion: 4,
    rawTotal: 27, supply: 27, available: 24, sold: 3, publicBookings: 1, phoneBookings: 2,
    publicRevenue: 100000, phoneRevenue: 200000, estimatedRevenue: 300000, partial: day === 4, missing: day === 5,
    unknownUnavailable: day === 4 ? 1 : 0, phoneMissingPriceBookings: 0, missingPriceSoldOut: 0 };
  if (day === 5) Object.assign(row, { sold: null, available: null, publicBookings: null, phoneBookings: null,
    publicRevenue: null, phoneRevenue: null, estimatedRevenue: null, observationStatus: "unobserved", queryAttempted: false });
  return row;
}
function company(index) {
  const snapshots = MONTHS.map(month => {
    const daily = Array.from({ length: dayCount(month) }, (_, offset) => {
      const row = observation(index, month, offset + 1);
      return { ...row, phonePriceEstimates: [{ sourceDate: row.stayDate, sourceType: "lodging", bookings: 2, estimatedPrice: 100000,
        basisNote: `SYNTHETIC/${index}/${row.stayDate}/` + "x".repeat(DETAIL_BYTES) }] };
    });
    return { runId: runOf(month, index === 1), collectedAt: `${month}-01T00:00:00.000Z`, inventoryEvidenceVersion: 4,
      productSnapshot: { runId: runOf(month, index === 1), inventoryEvidenceVersion: 4,
        capacityBasis: { observedMaximum: 27 }, daily, products: [{ id: `room-${index}`, name: "[SYNTHETIC] 원문 객실", stock: 27 }] } };
  });
  return { companyId: idOf(index), primaryName: `[SYNTHETIC] 글램핑 ${index}`, placeIds: [String(index === 3 ? 900000002 : 900000000 + index)],
    addresses: ["경상남도 산청군 모의로"], regions: ["경상남도 산청군"], lodgingTypes: ["글램핑"],
    runIds: MONTHS.map(month => runOf(month, index === 1)),
    manualCorrection: index === 0 ? { active: true, lodgingBasisTotal: 16 } : null,
    inventory: { latest: snapshots[2], previousLatest: snapshots[1], snapshots: [snapshots[0]] },
    keywords: { synthetic: { keyword: "[SYNTHETIC] 배후시장 글램핑", runs: MONTHS.map(month => ({
      runId: runOf(month, index === 1), collectedAt: `${month}-01T00:00:00.000Z`, rank: index % 20 + 1, overallRank: index % 20 + 1 })) } } };
}
async function fileHash(file) {
  const hash = crypto.createHash("sha256"), stream = native.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  const stat = await fs.stat(file);
  return { bytes: stat.size, sha256: hash.digest("hex"), mtimeMs: stat.mtimeMs };
}
async function inputInventory(fixture) {
  return Object.fromEntries(await Promise.all(["company_master/companies.json", "history/observations.jsonl", "regions.json", "runs.json", "baseline-adapter.cjs"]
    .map(async name => [name, await fileHash(path.join(fixture, name))])));
}
async function seed(fixture) {
  const masterFile = path.join(fixture, "company_master/companies.json"), historyFile = path.join(fixture, "history/observations.jsonl");
  await fs.mkdir(path.dirname(masterFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  const master = await fs.open(masterFile, "wx"), history = await fs.open(historyFile, "wx");
  let observationRows = 0;
  try {
    await master.write('{"schemaVersion":1,"companies":{');
    for (let index = 0; index < COMPANIES; index++) {
      await master.write(`${index ? "," : ""}${JSON.stringify(idOf(index))}:${JSON.stringify(company(index))}`);
      let batch = "";
      for (const month of MONTHS) for (let day = 1; day <= dayCount(month); day++) {
        const row = observation(index, month, day); batch += JSON.stringify(row) + "\n"; observationRows++;
        if (index === 0 && day === 6) { batch += JSON.stringify(row) + "\n"; observationRows++; }
      }
      await history.write(batch);
    }
    // Unknown identity and one malformed line must remain reference warnings,
    // while known duplicate place owners remain excluded, never counted twice.
    await history.write(JSON.stringify({ ...observation(0, "2026-09", 7), companyKey: "unknown", companyId: "unknown" }) + '\n{"malformed\n');
    observationRows += 2;
    await master.write('},"sourceIndex":{},"duplicateResolutions":{}}');
  } finally { await master.close(); await history.close(); }
  await fs.writeFile(path.join(fixture, "regions.json"), JSON.stringify({ units: [{ regionKey: "sancheong", regionId: "38310", fullName: "경상남도 산청군",
    name: "산청군", level: "local", active: true, selectable: true, aliases: ["경남 산청군"], provinceRegionKey: "gyeongnam" }] }), { flag: "wx" });
  const runs = MONTHS.flatMap(month => [false, true].map(partial => ({ id: runOf(month, partial), keyword: "[SYNTHETIC] 배후시장 글램핑",
    searchMode: "keyword", collectedAt: `${month}-01T00:00:00.000Z`, collectedAtSource: "manifest", checkIn: `${month}-01`,
    bookingRangeDays: dayCount(month), collectionQuality: { status: partial ? "partial" : "complete" } })));
  await fs.writeFile(path.join(fixture, "runs.json"), JSON.stringify(runs), { flag: "wx" });
  const source = spawnSync("git", ["show", `${BASELINE}:scripts/lib/monthly_report_sources.cjs`], { cwd: ROOT, windowsHide: true,
    encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  assert.equal(source.status, 0, "The exact approved baseline adapter must exist locally");
  await fs.writeFile(path.join(fixture, "baseline-adapter.cjs"), source.stdout, { flag: "wx" });
  return { companyCount: COMPANIES, months: MONTHS, snapshotRows: COMPANIES * MONTHS.reduce((sum, month) => sum + dayCount(month), 0),
    historyLines: observationRows, detailBytesPerSnapshotRow: DETAIL_BYTES, masterBytes: (await fs.stat(masterFile)).size };
}

async function childMain(mode, fixture, work, resultFile) {
  assert.ok(["baseline", "optimized"].includes(mode));
  let networkAttempts = 0;
  const forbidden = () => { networkAttempts++; throw Error("Network forbidden in synthetic memory benchmark"); };
  global.fetch = forbidden;
  for (const name of ["node:http", "node:https"]) { const module = require(name); module.request = forbidden; module.get = forbidden; }
  const net = require("node:net"); net.connect = forbidden; net.createConnection = forbidden;
  const counts = { masterFullReads: 0, masterStreams: 0, historyStreams: 0, preparations: 0, sharedInventoryPreparations: 0, sourceCalls: 0 };
  const masterPath = path.join(fixture, "company_master/companies.json"), historyPath = path.join(fixture, "history/observations.jsonl");
  const originalRead = fs.readFile, originalStream = native.createReadStream;
  fs.readFile = async function(file, ...args) { if (String(file) === masterPath) counts.masterFullReads++; return originalRead.call(this, file, ...args); };
  native.createReadStream = function(file, ...args) {
    if (String(file) === masterPath) counts.masterStreams++;
    if (String(file) === historyPath || String(file) === path.join(work, "history/observations.jsonl")) counts.historyStreams++;
    return originalStream.call(this, file, ...args);
  };
  let peakRss = 0, peakHeap = 0, peakExternal = 0, samples = 0;
  const sample = () => { const memory = process.memoryUsage(); samples++; peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed); peakExternal = Math.max(peakExternal, memory.external); };
  sample(); const timer = setInterval(sample, 25), started = performance.now();
  try {
    const logicalFile = path.join(ROOT, "scripts/lib/monthly_report_sources.cjs"), localRequire = createRequire(logicalFile);
    let createMonthlyReportSources;
    if (mode === "baseline") {
      const compiled = new Module(logicalFile, module);
      compiled.filename = logicalFile; compiled.paths = Module._nodeModulePaths(path.dirname(logicalFile)); compiled.require = localRequire;
      compiled._compile(await fs.readFile(path.join(fixture, "baseline-adapter.cjs"), "utf8"), logicalFile);
      ({ createMonthlyReportSources } = compiled.exports);
    } else ({ createMonthlyReportSources } = localRequire(logicalFile));
    const { createCompanyCapacityRegistry } = localRequire("./company_capacity_registry.cjs");
    const { buildMonthlyReportSnapshot } = localRequire("./monthly_reports.cjs");
    const registry = createCompanyCapacityRegistry({ dataDir: work, now: () => new Date(NOW),
      observedCapacity: value => Math.max(0, ...[value.inventory?.latest, value.inventory?.previousLatest, ...(value.inventory?.snapshots || [])]
        .filter(Boolean).flatMap(snapshot => (snapshot.productSnapshot?.daily || []).map(row => Number(row.rawTotal) || 0))),
      reviewedCapacity: value => value.manualCorrection?.active === false ? null : value.manualCorrection?.lodgingBasisTotal || null });
    const runs = JSON.parse(await fs.readFile(path.join(fixture, "runs.json"), "utf8"));
    const adapter = createMonthlyReportSources({ dataDir: fixture, regionMasterFile: path.join(fixture, "regions.json"), listRuns: async () => runs,
      prepareCompanies: async (companies, options) => { counts.preparations++; if (options.shareReadOnlyInventory) counts.sharedInventoryPreparations++;
        sample(); const value = await registry.prepareCompanies(companies, options); sample(); return value; },
      capacityForCompany: value => value._integratedCapacity?.capacity ?? null,
      projectObservation: (row, value) => ({ ...row, supply: value._integratedCapacity?.capacity ?? row.supply,
        capacityBasis: { count: value._integratedCapacity?.capacity ?? null, source: value._integratedCapacity?.source ?? "unknown" } }),
      readContext: async () => ({ sources: [], networkAttempted: false }), readSpecialDays: async () => null });
    const contracts = [], timings = [];
    const loadScoped = async request => {
      const raw = await adapter.loadSources(request, { priority: "background" }); sample();
      return { source: scopedSources(raw, request.targetId), rawCounts: { companies: raw.companies.length,
        observations: raw.observations.length, ranks: raw.rankObservations.length, runs: raw.runs.length } };
    };
    for (const [companyIndex, month] of [[0, "2026-09"], [0, "2026-10"], [1, "2026-09"], [2, "2026-09"]]) {
      const request = { type: "company", targetId: idOf(companyIndex), month, cutoffDate: `${month}-${dayCount(month)}` };
      const phase = performance.now(); counts.sourceCalls++;
      const { source, rawCounts } = await loadScoped(request); sample();
      const sourceMs = performance.now() - phase, snapshot = buildMonthlyReportSnapshot(request, source, NOW); sample();
      const selected = snapshot.sources.observations;
      assert.ok(Array.isArray(selected));
      if (companyIndex === 0) {
        assert.ok(selected.length > 0); assert.ok(selected.every(row => row.supply === 16), "reviewed capacity remains fixed at sixteen");
        assert.equal(snapshot.summary.lodging.sold, (dayCount(month) - 2) * 3);
        assert.equal(snapshot.summary.lodging.supply, (dayCount(month) - 2) * 16);
        assert.equal(snapshot.summary.lodging.estimatedRevenue, (dayCount(month) - 2) * 300000);
        assert.ok(snapshot.quality.discardedByReason.partial_inventory > 0);
        assert.ok(snapshot.quality.discardedByReason.missing_quantity > 0);
      }
      if (companyIndex === 1) assert.equal(snapshot.summary.lodging.containsPartialRun, true);
      if (companyIndex === 2) { assert.equal(selected.length, 0); assert.ok(source.sourceDiagnostics.duplicatePlaceCompanies > 0); }
      assert.ok(source.globalDiagnostics.malformedHistoryLines > 0);
      const canonical = { period: snapshot.period, summary: snapshot.summary, quality: snapshot.quality, daily: snapshot.daily,
        companies: snapshot.companies, selectedObservationCount: snapshot.sources.selectedObservationCount,
        diagnostics: source.sourceDiagnostics, globalDiagnostics: source.globalDiagnostics,
        warnings: source.warnings, globalWarnings: source.globalWarnings };
      contracts.push({ companyIndex, month, scopedSourceHash: digest(source), snapshotHash: digest(snapshot), contractHash: digest(canonical), contract: canonical,
        rawAdapterCounts: rawCounts, scopedRankRows: source.rankObservations.length, scopedObservationRows: source.observations.length });
      timings.push({ companyIndex, month, sourceMs: round(sourceMs), totalMs: round(performance.now() - phase) });
      sample();
    }
    assert.equal(networkAttempts, 0);
    const result = { mode, status: "verified", environment: "local synthetic source adapter and real capacity registry; no live server or provider data",
      heapLimitMiB: HEAP_MIB, forceGcUsed: false, elapsedMs: round(performance.now() - started), timings, reads: counts,
      memory: { sampledPeakRssMiB: round(peakRss / 1048576), processHighWaterRssMiB: round(process.resourceUsage().maxRSS / 1024),
        sampledPeakHeapMiB: round(peakHeap / 1048576), sampledPeakExternalMiB: round(peakExternal / 1048576), samples,
        note: "Timer/checkpoint samples can miss synchronous heap peaks; process maxRSS is the lifetime resident high-water mark" },
      networkAttempts, contracts };
    await fs.writeFile(resultFile, JSON.stringify(result, null, 2), { flag: "wx" });
    console.log(JSON.stringify({ mode, status: result.status, elapsedMs: result.elapsedMs, memory: result.memory, reads: result.reads }));
  } finally { clearInterval(timer); fs.readFile = originalRead; native.createReadStream = originalStream; }
}

async function runChild(mode, fixture, temporary) {
  const work = path.join(temporary, mode), resultFile = path.join(work, "result.json");
  await fs.mkdir(path.join(work, "history"), { recursive: true });
  await fs.link(path.join(fixture, "history/observations.jsonl"), path.join(work, "history/observations.jsonl"));
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const started = performance.now(), child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MIB}`, __filename,
    "--child", mode, fixture, work, resultFile], { cwd: ROOT, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-32768); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32768); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10 * 60 * 1000);
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer);
  let result = null; try { result = JSON.parse(await fs.readFile(resultFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exit.code === 0 && result?.status === "verified") return result;
  return { mode, status: "failed", elapsedMs: round(performance.now() - started), exit, timedOut,
    failure: /heap out of memory|Allocation failed|reached heap limit/i.test(stderr) ? "HEAP_LIMIT_REACHED" : timedOut ? "TIMEOUT" : "BENCHMARK_FAILED",
    stdout, stderr, note: "A benchmark process failure is not a production collection failure" };
}
async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--child") return childMain(...argv.slice(1));
  let output = null;
  if (argv.length) { assert.equal(argv.length, 2); assert.equal(argv[0], "--output"); output = path.resolve(argv[1]); }
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "company-background-memory-")), fixture = path.join(temporary, "fixture");
  await fs.mkdir(fixture);
  const metadata = await seed(fixture), before = await inputInventory(fixture);
  const baseline = await runChild("baseline", fixture, temporary), optimized = await runChild("optimized", fixture, temporary);
  const after = await inputInventory(fixture);
  assert.deepEqual(after, before, "all synthetic source contents and timestamps remain unchanged");
  let comparison = { status: "not_comparable", reason: "One or both child processes did not finish; no numerical-equivalence claim is made" };
  if (baseline.status === "verified" && optimized.status === "verified") {
    const majorContractsEqual = optimized.contracts.length === baseline.contracts.length
      && optimized.contracts.every((row, index) => row.companyIndex === baseline.contracts[index].companyIndex
        && row.month === baseline.contracts[index].month && row.contractHash === baseline.contracts[index].contractHash);
    const fullSnapshotHashesEqual = optimized.contracts.every((row, index) => row.snapshotHash === baseline.contracts[index]?.snapshotHash);
    const scopedSourceHashesEqual = optimized.contracts.every((row, index) => row.scopedSourceHash === baseline.contracts[index]?.scopedSourceHash);
    const equal = majorContractsEqual && fullSnapshotHashesEqual && scopedSourceHashesEqual;
    comparison = { status: equal ? "verified" : "failed", fullSnapshotHashesEqual, scopedSourceHashesEqual,
      majorContractsEqual, ...(equal ? {} : { reason: "Scoped source, full snapshot or major numeric/quality contracts changed; inspect the retained child contracts" }),
      peakRssReductionMiB: round(baseline.memory.processHighWaterRssMiB - optimized.memory.processHighWaterRssMiB),
      runtimeRatio: round(optimized.elapsedMs / baseline.elapsedMs), baselineMasterReads: baseline.reads.masterFullReads,
      optimizedMasterReads: optimized.reads.masterFullReads, optimizedMasterStreams: optimized.reads.masterStreams };
  }
  const report = { schemaVersion: 1, status: optimized.status === "verified" && comparison.status === "verified" ? "verified" : "verification_incomplete",
    environment: "LOCAL SYNTHETIC benchmark, not production performance or actual reservation processing", baselineCommit: BASELINE,
    baselineScope: "Exact old monthly source adapter with current shared dependencies and real current capacity registry",
    fixture: { ...metadata, inputs: before }, sourceInputsUnchanged: true, noNetwork: true, forceGcUsed: false,
    temporaryEvidence: temporary, baseline, optimized, comparison };
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  else await fs.writeFile(path.join(temporary, "comparison.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ environment: report.environment, status: report.status, fixture: metadata,
    baseline: { status: baseline.status, memory: baseline.memory, elapsedMs: baseline.elapsedMs, failure: baseline.failure },
    optimized: { status: optimized.status, memory: optimized.memory, elapsedMs: optimized.elapsedMs, failure: optimized.failure },
    comparison, sourceInputsUnchanged: true, evidence: output || path.join(temporary, "comparison.json") }, null, 2));
  if (report.status !== "verified") process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = { main, childMain };
