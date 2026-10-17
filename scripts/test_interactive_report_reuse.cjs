"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyReportService } = require("./lib/monthly_reports.cjs");
const { createMonthlyReportSourceRevision } = require("./lib/monthly_report_source_revision.cjs");

const request = { type: "company", targetId: "cmp_place_1", month: "2026-09", cutoffDate: "2026-09-30" };
const backgroundRequest = { ...request, type: "industry", targetId: "__industry_all__" };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

// This deadline only detects queue dependency/deadlock in a tiny fixture. It
// does not predict production latency or simulate production with CPU loops.
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish independently of deferred background work`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "interactive-report-reuse-"));
  const outstandingGates = [];
  const gate = () => {
    const value = { entered: deferred(), release: deferred(), checkpointAttempted: deferred(), passedCheckpoint: false };
    outstandingGates.push(value); return value;
  };
  t.after(async () => {
    for (const value of outstandingGates) value.release.resolve();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("interactive-report-reuse-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function write(name, value) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  }
  const master = await write("company_master/companies.json", { companies: {
    cmp_place_1: { companyId: "cmp_place_1", primaryName: "모의 저장자료 업체", placeIds: ["1"], addresses: ["모의도 모의군 검수로"],
      keywords: { test: { keyword: "모의글램핑", runs: [{ runId: "saved-september", rank: 1, collectedAt: "2026-09-21T00:00:00Z" }] } } }
  } });
  const regionMasterFile = await write("regions.json", { units: [
    { regionKey: "region-test", regionId: "region-test", fullName: "모의도 모의군", name: "모의군", level: "local", active: true, selectable: true }
  ] });
  const tourismRegionMapFile = await write("tourism-map.json", {});
  const manifest = await write("outputs/saved-september/manifest.json", { id: "saved-september", keyword: "모의글램핑",
    collectedAt: "2026-09-21T00:00:00Z", collectionQuality: { status: "complete" } });
  const row = sold => ({ companyId: "cmp_place_1", runId: "saved-september", collectedAt: "2026-09-21T00:00:00Z",
    stayDate: "2026-09-22", productType: "lodging", inventoryEvidenceVersion: 4, supply: 16, sold,
    publicBookings: 1, phoneBookings: sold - 1, publicRevenue: 100000, phoneRevenue: (sold - 1) * 100000,
    estimatedRevenue: sold * 100000, sharedDayUseExcluded: 0, explicitBlockedBookings: 0 });
  const history = await write("history/observations.jsonl", JSON.stringify(row(2)) + "\n");
  const originalFiles = [master, regionMasterFile, tourismRegionMapFile, manifest, history];
  const originals = () => Promise.all(originalFiles.map(file => fs.readFile(file, "utf8")));
  const state = { events: [], fullReads: 0, activeFullReads: 0, peakFullReads: 0, prepareGate: null, revisionGate: null, contextGate: null };
  const nativeRevision = createMonthlyReportSourceRevision({ dataDir: root, outputsDir: path.join(root, "outputs"),
    regionMasterFile, tourismRegionMapFile, includeContext: false });
  const readRevision = input => nativeRevision(input);
  readRevision.industrySourceScope = nativeRevision.industrySourceScope;
  readRevision.inspect = async input => {
    const pending = state.revisionGate; state.revisionGate = null;
    if (pending) { pending.entered.resolve(); await pending.release.promise; }
    const result = await nativeRevision.inspect(input);
    state.events.push("fresh-revision-complete"); return result;
  };
  const sources = createMonthlyReportSources({ dataDir: root, regionMasterFile, readRevision,
    listRuns: async () => {
      state.fullReads++; state.activeFullReads++; state.peakFullReads = Math.max(state.peakFullReads, state.activeFullReads);
      state.events.push("full-read-start");
      return [JSON.parse(await fs.readFile(manifest, "utf8"))];
    },
    capacityForCompany: () => 16,
    prepareCompanies: async (companies, { checkpoint }) => {
      const pending = state.prepareGate; state.prepareGate = null;
      if (pending) {
        pending.entered.resolve(); await pending.release.promise;
        pending.checkpointAttempted.resolve(); await checkpoint();
        pending.passedCheckpoint = true; state.events.push("background-checkpoint-passed");
      }
      return companies;
    },
    readSpecialDays: async () => {
      state.events.push("full-read-complete"); state.activeFullReads--;
      return { categories: { holidays: { status: "ready", items: [] } }, networkAttempted: false };
    }
  });
  const service = createMonthlyReportService({ dataDir: path.join(root, "monthly_reports"), loadSources: sources.loadSources,
    readSourceRevision: sources.readRevision, runInteractiveRead: sources.runInteractiveRead,
    readReportContext: async () => {
      const pending = state.contextGate; state.contextGate = null;
      if (pending) { pending.entered.resolve(); await pending.release.promise; }
      return { sources: [], warnings: [], networkAttempted: false };
    }, now: () => new Date("2026-10-17T00:00:00Z") });
  return { root, history, row, originals, gate, state, sources, service };
}

test("saved preview finishes while an active background reconstruction yields at its preparation checkpoint", { timeout: 6000 }, async t => {
  const f = await fixture(t), warm = await f.service.preview(request), original = await f.originals();
  assert.equal(warm.generation.cacheStatus, "calculated"); assert.equal(warm.summary.lodging.sold, 2);
  assert.equal(f.state.fullReads, 2);
  const backgroundGate = f.gate(), revisionGate = f.gate(), contextGate = f.gate();
  f.state.prepareGate = backgroundGate;
  let backgroundDone = false;
  const background = f.sources.loadSourcesWithCatalog(backgroundRequest, { priority: "background", includeContext: false })
    .then(value => { backgroundDone = true; f.state.events.push("background-returned"); return value; });
  await backgroundGate.entered.promise;
  f.state.revisionGate = revisionGate; f.state.contextGate = contextGate;
  const preview = f.service.preview(request).then(value => { f.state.events.push("preview-returned"); return value; });
  await revisionGate.entered.promise;
  backgroundGate.release.resolve(); await backgroundGate.checkpointAttempted.promise;
  await turn(); await turn();
  assert.equal(backgroundGate.passedCheckpoint, false, "interactive inspection pauses the background reader at its explicit safe boundary");
  assert.equal(f.state.activeFullReads, 1, "the paused reader retains the single full-source slot");
  const nextBackground = f.sources.loadSourcesWithCatalog(backgroundRequest, { priority: "background", includeContext: false });
  assert.deepEqual(f.sources.sourceReadStatus(), { active: true, queuedForeground: 0, queuedBackground: 1 });
  revisionGate.release.resolve(); await contextGate.entered.promise;
  assert.equal(backgroundGate.passedCheckpoint, false, "the lease covers saved context and not only the source check");
  assert.equal(f.state.fullReads, 3, "neither a hit nor queued maintenance reconstructs another full source");
  contextGate.release.resolve();
  const reused = await bounded(preview, "saved preview");
  assert.equal(backgroundDone, false, "the saved response is ready before active background work finishes");
  assert.equal(reused.generation.cacheStatus, "reused");
  assert.deepEqual(reused.summary, warm.summary); assert.deepEqual(reused.companies, warm.companies);
  assert.equal(reused.generation.sourceInspection.checks, 1, "reuse performs one fresh native source inspection");
  assert.ok(reused.generation.sourceInspection.counts.files > 0);
  await Promise.all([background, nextBackground]);
  assert.ok(f.state.events.indexOf("preview-returned") < f.state.events.indexOf("background-returned"));
  assert.equal(f.state.peakFullReads, 1); assert.equal(f.state.activeFullReads, 0);
  assert.deepEqual(await f.originals(), original, "reused previews and maintenance do not edit saved source evidence");
  assert.deepEqual(await f.service.list(), [], "preview QA never publishes or saves a customer report");
  t.diagnostic(`Synthetic saved-preview phase: ${reused.generation.timings.previewTotalMs} ms; production latency requires live measurement.`);
});

test("a new background source read waits while a reused preview reads its local attachments", { timeout: 6000 }, async t => {
  const f = await fixture(t); await f.service.preview(request);
  const contextGate = f.gate(); f.state.contextGate = contextGate;
  const preview = f.service.preview(request); await contextGate.entered.promise;
  const before = f.state.fullReads;
  const background = f.sources.loadSourcesWithCatalog(backgroundRequest, { priority: "background", includeContext: false });
  await turn();
  assert.equal(f.state.fullReads, before, "maintenance cannot begin reconstructing a catalog during saved result serialization/attachments");
  assert.deepEqual(f.sources.sourceReadStatus(), { active: false, queuedForeground: 0, queuedBackground: 1 });
  contextGate.release.resolve();
  assert.equal((await bounded(preview, "preview with pending maintenance")).generation.cacheStatus, "reused");
  await background;
  assert.equal(f.state.fullReads, before + 1); assert.equal(f.state.peakFullReads, 1);
  assert.equal(f.state.activeFullReads, 0);
});

test("a changed saved source releases paused background work before rebuilding a foreground miss without overlapping full sources", { timeout: 6000 }, async t => {
  const f = await fixture(t), warm = await f.service.preview(request);
  await fs.writeFile(f.history, JSON.stringify(f.row(3)) + "\n");
  const changedOriginals = await f.originals();
  const backgroundGate = f.gate(), revisionGate = f.gate();
  f.state.prepareGate = backgroundGate;
  const background = f.sources.loadSourcesWithCatalog(backgroundRequest, { priority: "background", includeContext: false })
    .then(value => { f.state.events.push("background-returned"); return value; });
  await backgroundGate.entered.promise;
  f.state.revisionGate = revisionGate;
  const preview = f.service.preview(request);
  await revisionGate.entered.promise;
  backgroundGate.release.resolve(); await backgroundGate.checkpointAttempted.promise;
  await turn(); await turn();
  assert.equal(backgroundGate.passedCheckpoint, false, "the active reader is initially paused by source validation");
  const readsBeforeMiss = f.state.fullReads;
  revisionGate.release.resolve();
  const changed = await bounded(preview, "foreground rebuild after a source edit");
  await background;
  assert.equal(backgroundGate.passedCheckpoint, true, "foreground source demand wakes paused maintenance instead of waiting on its own lease");
  assert.equal(changed.generation.cacheStatus, "calculated");
  assert.equal(warm.summary.lodging.sold, 2); assert.equal(changed.summary.lodging.sold, 3);
  assert.equal(changed.summary.lodging.estimatedRevenue, 300000);
  assert.equal(f.state.fullReads, readsBeforeMiss + 2, "a miss reads current and comparison months after the active background read");
  assert.equal(f.state.peakFullReads, 1, "a foreground miss must not duplicate a full observation/catalog heap");
  assert.equal(f.state.activeFullReads, 0);
  const returned = f.state.events.indexOf("background-returned");
  assert.ok(returned >= 0 && f.state.events.slice(returned + 1).includes("full-read-start"));
  assert.deepEqual(await f.originals(), changedOriginals, "the only source edit is the explicit test fixture change");
  const last = await f.service.preview(request);
  assert.equal(last.generation.cacheStatus, "reused"); assert.equal(last.summary.lodging.sold, 3);
});
