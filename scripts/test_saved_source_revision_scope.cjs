"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { savedIndustryRevisionScope } = require("./lib/saved_source_revision_scope.cjs");
const { createMonthlyReportSourceRevision } = require("./lib/monthly_report_source_revision.cjs");
const { createIndustrySourceRevision } = require("./lib/industry_source_revision.cjs");
const { createIndustryAnalysisStore } = require("./lib/industry_analysis_store.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "saved-source-scope-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const options = { dataDir: path.join(root, "data"), outputsDir: path.join(root, "outputs"),
    regionMasterFile: path.join(root, "references", "regions.json"), tourismRegionMapFile: path.join(root, "references", "tourism.json") };
  const write = async (file, contents) => {
    const resolved = path.resolve(file);
    assert.ok(resolved.startsWith(path.resolve(root) + path.sep), "fixture writes remain in its temporary directory");
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, contents);
    return resolved;
  };
  return { root, options, write };
}

test("native monthly and industry readers expose the same scope only for the same resolved input paths", async t => {
  const { options } = await fixture(t);
  const expected = savedIndustryRevisionScope(options);
  assert.equal(typeof expected, "string");
  const monthly = createMonthlyReportSourceRevision(options), industry = createIndustrySourceRevision(options);
  assert.equal(monthly.industrySourceScope, expected);
  assert.equal(industry.industrySourceScope, expected);
  const equivalent = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, path.join(path.dirname(value), ".", path.basename(value))]));
  assert.equal(savedIndustryRevisionScope(equivalent), expected);
  assert.equal(createMonthlyReportSourceRevision({ ...equivalent, fileSystem: fs, includeContext: false }).industrySourceScope, expected,
    "excluding monthly-only context does not remove industry inputs from the full source inspection");
  assert.equal(createIndustrySourceRevision(equivalent).industrySourceScope, expected);
  assert.equal(savedIndustryRevisionScope({}), null);
  assert.equal(savedIndustryRevisionScope({ dataDir: options.dataDir }), null);
  assert.equal(savedIndustryRevisionScope({ outputsDir: options.outputsDir }), null);
});

test("different data, output or reference roots cannot authorize saved industry probe reuse", async t => {
  const { options } = await fixture(t);
  const expected = createIndustrySourceRevision(options).industrySourceScope;
  for (const field of ["dataDir", "outputsDir", "regionMasterFile", "tourismRegionMapFile"]) {
    const different = { ...options, [field]: options[field] + "-other" };
    assert.notEqual(savedIndustryRevisionScope(different), expected, field);
    assert.notEqual(createMonthlyReportSourceRevision(different).industrySourceScope, expected, `monthly ${field}`);
    assert.notEqual(createIndustrySourceRevision(different).industrySourceScope, expected, `industry ${field}`);
  }
  for (const field of ["regionMasterFile", "tourismRegionMapFile"]) {
    const missing = { ...options }; delete missing[field];
    assert.notEqual(createMonthlyReportSourceRevision(missing).industrySourceScope, expected, `missing ${field}`);
  }
  const swapped = { ...options, regionMasterFile: options.tourismRegionMapFile, tourismRegionMapFile: options.regionMasterFile };
  assert.notEqual(savedIndustryRevisionScope(swapped), expected, "reference roles are ordered, not an unordered path set");
});

test("custom monthly filesystems never grant the native filesystem scope even when methods delegate to native fs", async t => {
  const { options } = await fixture(t);
  const native = createMonthlyReportSourceRevision(options);
  assert.ok(native.industrySourceScope);
  const delegated = { ...fs };
  assert.equal(createMonthlyReportSourceRevision({ ...options, fileSystem: delegated }).industrySourceScope, null);
  assert.equal(createMonthlyReportSourceRevision({ ...options, fileSystem: { ...fs, lstat: (...args) => fs.lstat(...args) } }).industrySourceScope, null);
  assert.equal(createMonthlyReportSourceRevision({ ...options, fileSystem: fs }).industrySourceScope, native.industrySourceScope);
});

test("the monthly full revision detects additions and edits of every industry input family using real saved files", async t => {
  const { options, write } = await fixture(t);
  const run = path.join(options.outputsDir, "pocheon_glamping_20260901_090000");
  const inputs = [
    ["master", path.join(options.dataDir, "company_master", "companies.json")],
    ["history", path.join(options.dataDir, "history", "observations.jsonl")],
    ["region reference", options.regionMasterFile],
    ["tourism reference", options.tourismRegionMapFile],
    ["run manifest", path.join(run, "manifest.json")],
    ["run detail", path.join(run, "details", "product.json")],
    ["calendar", path.join(options.dataDir, "history", "special_days", "2026.json")]
  ];
  const revision = createMonthlyReportSourceRevision(options);
  let previous = await revision();
  assert.match(previous, /^[a-f0-9]{64}$/);
  for (const [label, file] of inputs) {
    await write(file, JSON.stringify({ version: 1, source: label }));
    const added = await revision();
    assert.notEqual(added, previous, `${label} addition invalidates the full revision`);
    assert.equal(await revision(), added, `${label} unchanged source is stable`);
    await write(file, JSON.stringify({ version: 22, source: label, changed: true }));
    const edited = await revision();
    assert.notEqual(edited, added, `${label} edit invalidates the full revision`);
    previous = edited;
  }
  await write(path.join(options.outputsDir, "sacheon_glamping_20260902_090000", "manifest.json"), '{"collectedAt":"2026-09-02T00:00:00Z"}');
  assert.notEqual(await revision(), previous, "a new run is discovered after previously stable directory reads");
});

test("a verified monthly revision authorizes reuse of an industry probe but never replaces the saved industry tokens", async t => {
  const { options, write } = await fixture(t);
  await write(path.join(options.dataDir, "company_master", "companies.json"), '{"schemaVersion":1,"companies":{}}');
  await write(path.join(options.dataDir, "history", "observations.jsonl"), "");
  await write(options.regionMasterFile, '{"regions":[]}');
  await write(options.tourismRegionMapFile, '{"regions":[]}');
  await write(path.join(options.outputsDir, "pocheon_glamping_20260901_090000", "manifest.json"),
    '{"keyword":"포천글램핑","collectedAt":"2026-09-01T00:00:00Z","checkIn":"2026-09-01","bookingRangeDays":30,"collectionQuality":{"status":"complete"}}');
  const monthly = createMonthlyReportSourceRevision(options), industry = createIndustrySourceRevision(options);
  assert.equal(monthly.industrySourceScope, industry.industrySourceScope);
  const request = { industry: "glamping", region: "all", month: "2026-09", cutoffDate: "2026-09-30" };
  let industryReads = 0;
  const store = createIndustryAnalysisStore({ dataDir: options.dataDir, autoStart: false, now: () => new Date("2026-10-17T00:00:00Z"),
    savedReferenceRevisionScope: monthly.industrySourceScope,
    readSourceRevision: () => { industryReads++; return industry.periodRevisions(); },
    calculate: async selected => ({ request: selected, summary: { sold: 0 }, period: { monthClosed: true } }) });
  t.after(() => store.stop());
  await store.get(request); await store.drain();
  const queueFile = path.join(options.dataDir, "industry_analysis", "queue.json");
  const originalQueue = await fs.readFile(queueFile, "utf8"), savedQueue = JSON.parse(originalQueue);
  const fullRevision = await monthly(), ownRevision = await industry.periodRevisions();
  assert.notEqual(fullRevision, ownRevision.globalToken);
  assert.deepEqual(savedQueue.sourceSnapshot, ownRevision, "the durable store retains its own global/month tokens");
  const beforeReadCount = industryReads;
  const proof = { scope: monthly.industrySourceScope, revision: fullRevision };
  const first = await store.readSaved(request, { verifiedSourceRevision: proof });
  assert.equal(first.storage.sourceTokenMatches, true, "matching own industry tokens validate the snapshot despite a different monthly hash");
  assert.equal(first.storage.sourceRevisionMatches, true);
  const second = await store.readSaved(request, { verifiedSourceRevision: proof });
  assert.equal(second.storage.sourceTokenMatches, true);
  assert.equal(industryReads, beforeReadCount + 1, "the same verified superset revision reuses the real industry's completed probe");
  assert.equal(await fs.readFile(queueFile, "utf8"), originalQueue, "saved report reads never overwrite source tokens or enqueue work");
  await write(path.join(options.dataDir, "history", "special_days", "2026.json"), '{"holidays":["2026-09-28"]}');
  const changedFullRevision = await monthly();
  assert.notEqual(changedFullRevision, fullRevision);
  const changed = await store.readSaved(request, { verifiedSourceRevision: { scope: monthly.industrySourceScope, revision: changedFullRevision } });
  assert.equal(industryReads, beforeReadCount + 2, "a changed verified full revision requires a fresh industry probe");
  assert.equal(changed.storage.sourceTokenMatches, false, "fresh industry tokens, rather than the monthly token, detect the changed calendar");
  assert.equal(changed.storage.stale, true);
  assert.equal(await fs.readFile(queueFile, "utf8"), originalQueue, "inspection preserves the existing queue and last normal result");
});
