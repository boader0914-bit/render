"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), http = require("node:http"), vm = require("node:vm");
const { execFileSync } = require("node:child_process"), { createRequire } = require("node:module"), { performance, monitorEventLoopDelay } = require("node:perf_hooks");
const { createCompanyIntegratedTargets } = require("./lib/company_integrated_targets.cjs");
const { getAnalyticalPhaseDiagnostics } = require("./lib/analytical_phase_runtime.cjs");
const filename = path.join(__dirname, "lib/company_integrated_targets.cjs"), baseline = { exports: {} };
const source = execFileSync("git", ["show", "8a5c0da:scripts/lib/company_integrated_targets.cjs"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
vm.runInNewContext(source, { module: baseline, exports: baseline.exports, require: createRequire(filename), __filename: filename, __dirname: path.dirname(filename),
  Buffer, process, console, setImmediate, setTimeout, clearTimeout }, { filename: "production-8a5c0da-targets.cjs" });
const plain = value => JSON.parse(JSON.stringify(value)), turn = () => new Promise(resolve => setImmediate(resolve));
async function directory(t) { const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, "company-target-responsive-"));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), parent); assert.match(path.basename(root), /^company-target-responsive-/); await fs.rm(root, { recursive: true, force: true }); }); return root; }
function fixtureCatalog() {
  const day = (stayDate, runId) => ({ stayDate, runId });
  const companies = [
    { companyId: "a", placeIds: ["100", "shared"], runIds: ["r1", null, { mustNotBecomeRun: true }], firstRunId: "r2", lastRunId: "r1",
      duplicateNotes: [{ mergedCompanyId: "old-a" }], keywords: { one: { runs: [{ runId: "r3" }] } },
      inventory: { latest: { runId: "r1", productSnapshot: { daily: [day("2026-09-30"), day("2026-10-01")] } },
        previousLatest: { runId: "r2", productSnapshot: { daily: [day("2026-01-02")] } },
        snapshots: [null, { runId: "r3", productSnapshot: { daily: [day("2025-12-31", "r1"), day("bad-date")] } }] } },
    { companyId: "b", placeIds: ["200", "shared"], runIds: ["r1"] },
    { companyId: "deleted", deletedAt: "2026-11-01", runIds: ["r1"] },
    { companyId: "merged", mergedIntoCompanyId: "a", runIds: ["r1"] }
  ];
  const runs = [{ id: "r1", checkIn: "2026-09-30", bookingRangeDays: 2 }, { id: "r2", checkIn: "2026-01-02", bookingRangeDays: 0 },
    { id: "r3", checkIn: "2026-12-31", bookingRangeDays: 367 }];
  return { rawCompanies: new Map(companies.map(company => [company.companyId, company])), runs };
}
const history = [{ companyKey: "old-a", stayDate: "2024-03-01", runId: "history" },
  { companyId: "b", companyKey: "a", stayDate: "2024-04-01", runId: "history" },
  { placeId: "100", stayDate: "2024-05-01", runId: "history" }, { placeId: "shared", stayDate: "2024-06-01", runId: "history" },
  { companyId: "deleted", stayDate: "2024-07-01", runId: "history" }];
const index = rows => ({ readRows: async () => assert.fail("full history payloads are unnecessary"), async readHeaders(query, consume) {
  for (const row of rows) if (!query.runId || query.runId === row.runId) await consume(row);
} });

test("target identities, snapshot matching, run spans, ordering and requested scopes exactly match8a5c0da", async t => {
  const root = await directory(t), options = { dataDir: root, catalog: async () => fixtureCatalog(), readRevision: async () => "same-source", observationIndex: index(history) };
  const old = baseline.exports.createCompanyIntegratedTargets(options), current = createCompanyIntegratedTargets(options);
  for (const scope of [{}, { companyIds: ["a"] }, { companyIds: ["b", "a"] }, { companyIds: ["missing"] },
    { runId: "r1" }, { runId: "r2" }, { runId: "r3" }, { runId: "history" }, { runId: "missing" }]) {
    assert.deepEqual(await current(scope), plain(await old(scope)), JSON.stringify(scope));
  }
});

test("daily/run metadata has bounded checkpoints and header reads yield after16rows or10ms", async t => {
  const root = await directory(t); let dailyReads = 0, headerReads = 0, lastDaily = 0, lastHeader = 0, maxDailyGap = 0, maxHeaderGap = 0, yieldedAtFirstSlowHeader = false;
  const daily = Array.from({ length: 3000 }, () => ({ get stayDate() { dailyReads++; return "2026-09-01"; } }));
  const companies = new Map([["a", { companyId: "a", runIds: ["run"], inventory: { snapshots: [{ runId: "run", productSnapshot: { daily } }] } }]]);
  const rows = Array.from({ length: 80 }, (_, n) => ({ companyId: "a", runId: "run", get stayDate() {
    headerReads++; if (n === 0) { const until = performance.now() + 12; while (performance.now() < until) {} } return "2026-10-01";
  } }));
  const targets = createCompanyIntegratedTargets({ dataDir: root, catalog: async () => ({ rawCompanies: companies, runs: [{ id: "run", checkIn: "2026-09-01", bookingRangeDays: 366 }] }),
    observationIndex: index(rows), checkpoint: async () => {
      maxDailyGap = Math.max(maxDailyGap, dailyReads - lastDaily); maxHeaderGap = Math.max(maxHeaderGap, headerReads - lastHeader);
      if (headerReads === 1) yieldedAtFirstSlowHeader = true; lastDaily = dailyReads; lastHeader = headerReads; await turn();
    } });
  assert.equal((await targets()).length, 1); assert.equal(dailyReads, 3000); assert.equal(headerReads, 80);
  assert.ok(maxDailyGap <= 256, maxDailyGap); assert.ok(maxHeaderGap <= 16, maxHeaderGap); assert.equal(yieldedAtFirstSlowHeader, true);
});

test("metadata/history/revision phases retain only numeric iteration evidence under the existing bootstrap run", async t => {
  const root = await directory(t), diagnostics = getAnalyticalPhaseDiagnostics();
  const targets = createCompanyIntegratedTargets({ dataDir: root, catalog: async () => fixtureCatalog(), readRevision: async () => "private-fixture-source-token", observationIndex: index(history) });
  await diagnostics.run("company-bootstrap", () => targets());
  const record = diagnostics.status().records.at(-1), expected = ["target_catalog_read", "target_metadata_project", "target_identity_index", "target_history_header_read", "target_snapshot_merge", "target_revision_verify"];
  for (const phase of expected) assert.ok(record.phases.some(row => row.phase === phase && row.status === "completed"), phase);
  const metadata = record.phases.find(row => row.phase === "target_metadata_project").metadata;
  assert.equal(metadata.partitionCount, 4); assert.ok(metadata.rowCount > 0);
  assert.equal(record.phases.find(row => row.phase === "target_history_header_read").metadata.rowCount, history.length);
  assert.ok(Object.values(metadata).every(value => Number.isSafeInteger(value) && value >= 0));
  assert.doesNotMatch(JSON.stringify(record), /private-fixture|old-a|shared|history"/);
});

test("large saved-metadata discovery serves HTTP before the full metadata batch and preserves exact results", async t => {
  const root = await directory(t), total = 12, rowsPerCompany = 12000;
  async function run(create) {
    let projected = 0, health, began = 0, healthLatencyMs, healthBeforeMetadataEnd;
    const server = http.createServer((req, res) => { healthLatencyMs = performance.now() - began; healthBeforeMetadataEnd = projected < total; res.end("ok"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const rawCompanies = new Map(Array.from({ length: total }, (_, n) => ["c" + n, {
      get companyId() { projected++; return "c" + n; }, runIds: ["run"], inventory: { snapshots: Array.from({ length: 30 }, (_, k) => ({ runId: "run", productSnapshot: {
        daily: Array.from({ length: rowsPerCompany / 30 }, (_, day) => ({ stayDate: "2026-" + String(1 + k % 12).padStart(2, "0") + "-" + String(1 + day % 28).padStart(2, "0") }))
      } })) }
    }]));
    const eventLoop = monitorEventLoopDelay({ resolution: 1 }); eventLoop.enable(); await new Promise(resolve => setTimeout(resolve, 10));
    try {
      const targets = create({ dataDir: root, observationIndex: index([]), catalog: async () => {
        began = performance.now(); health = new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}/api/health`, response => {
          response.resume(); response.on("end", () => resolve(response.statusCode));
        }).on("error", reject));
        return { rawCompanies, runs: [{ id: "run", checkIn: "2026-09-01", bookingRangeDays: 30 }] };
      } });
      const rows = await targets(); assert.equal(await health, 200); await turn();
      return { rows: plain(rows), healthBeforeMetadataEnd, healthLatencyMs, eventLoopMaxGapMs: eventLoop.max / 1e6 };
    } finally { eventLoop.disable(); await new Promise(resolve => server.close(resolve)); }
  }
  const old = await run(baseline.exports.createCompanyIntegratedTargets), current = await run(createCompanyIntegratedTargets);
  assert.deepEqual(current.rows, old.rows); assert.equal(old.healthBeforeMetadataEnd, false); assert.equal(current.healthBeforeMetadataEnd, true);
  console.log(JSON.stringify({ syntheticTargetDiscovery: true, metadataRows: total * rowsPerCompany, baseline: { healthLatencyMs: old.healthLatencyMs, eventLoopMaxGapMs: old.eventLoopMaxGapMs },
    current: { healthLatencyMs: current.healthLatencyMs, eventLoopMaxGapMs: current.eventLoopMaxGapMs }, productionCauseProven: false }));
});

test("a synthetic cold header adapter with256-row macro boundaries is bounded earlier by the target callback", async t => {
  const root = await directory(t), total = 512;
  async function run(create) {
    let inspected = 0, health, began = 0, healthLatencyMs, headerRowsAtHealth;
    const server = http.createServer((req, res) => { healthLatencyMs = performance.now() - began; headerRowsAtHealth = inspected; res.end("ok"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const monitor = monitorEventLoopDelay({ resolution: 1 }); monitor.enable(); await new Promise(resolve => setTimeout(resolve, 10));
    try {
      const observationIndex = { readRows: async () => assert.fail("header-only discovery"), async readHeaders(query, consume) {
        began = performance.now(); health = new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}/api/health`, response => {
          response.resume(); response.on("end", () => resolve(response.statusCode));
        }).on("error", reject));
        for (let n = 0; n < total; n++) {
          const until = performance.now() + 1; while (performance.now() < until) {} inspected++;
          await consume({ companyId: "a", runId: "saved", stayDate: "2026-09-" + String(1 + n % 28).padStart(2, "0") });
          if ((n + 1) % 256 === 0) await turn();
        }
      } };
      const list = create({ dataDir: root, observationIndex, catalog: async () => ({ rawCompanies: new Map([["a", { companyId: "a" }]]), runs: [] }) });
      const rows = await list(); assert.equal(await health, 200); await turn();
      return { rows: plain(rows), healthLatencyMs, headerRowsAtHealth, eventLoopMaxGapMs: monitor.max / 1e6 };
    } finally { monitor.disable(); await new Promise(resolve => server.close(resolve)); }
  }
  const old = await run(baseline.exports.createCompanyIntegratedTargets), current = await run(createCompanyIntegratedTargets);
  assert.deepEqual(current.rows, old.rows); assert.ok(old.headerRowsAtHealth >= 256, old.headerRowsAtHealth);
  assert.ok(current.headerRowsAtHealth < 256, current.headerRowsAtHealth); assert.ok(current.headerRowsAtHealth < total);
  console.log(JSON.stringify({ syntheticColdHeaders: true, headerRows: total, simulatedSyncPerRowMs: 1, adapterMacroBatch: 256,
    baseline: { healthLatencyMs: old.healthLatencyMs, headerRowsAtHealth: old.headerRowsAtHealth, eventLoopMaxGapMs: old.eventLoopMaxGapMs },
    current: { healthLatencyMs: current.healthLatencyMs, headerRowsAtHealth: current.headerRowsAtHealth, eventLoopMaxGapMs: current.eventLoopMaxGapMs }, productionCauseProven: false }));
});

test("a checkpoint failure cannot publish partial targets or replace the last verified cache", async t => {
  const root = await directory(t); let token = "old", fail = false, catalogReads = 0;
  const list = createCompanyIntegratedTargets({ dataDir: root, readRevision: async () => token, observationIndex: index(history), catalog: async () => { catalogReads++; return fixtureCatalog(); },
    checkpoint: async () => { if (fail) throw Error("private source failure"); await turn(); } });
  const good = await list(); token = "new"; fail = true; await assert.rejects(list(), { code: "COMPANY_TARGET_SOURCE_UNAVAILABLE" });
  token = "old"; fail = false; assert.deepEqual(await list(), good); assert.equal(catalogReads, 2);
  assert.throws(() => createCompanyIntegratedTargets({ dataDir: root, catalog() {}, checkpoint: null }), TypeError);
});
