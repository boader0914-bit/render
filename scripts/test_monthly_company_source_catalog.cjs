"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), vm = require("node:vm");
const { createMonthlyCompanySourceCatalog, compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex"), json = value => JSON.parse(JSON.stringify(value));
const source = native.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
function extracted(name, globals = {}) { const start = source.indexOf("function " + name + "("), following = /\r?\n(?:async )?function /.exec(source.slice(start + 1)), end = start + 1 + following.index; assert.ok(start >= 0 && end > start); return vm.runInNewContext("(" + source.slice(start, end).trim() + ")", globals); }
const productSnapshotNumber = extracted("productSnapshotNumber"), maximum = extracted("companyMaximumRoomCapacity", { productSnapshotNumber });
const capacityRecord = extracted("withCompanyInventoryCapacityRecord", { companyMaximumRoomCapacity: maximum, productSnapshotNumber,
  manualCorrectionLodgingBasisTotal: correction => correction?.active === false ? null : Number(correction?.lodgingBasisTotal) || null });
const availabilityMatch = extracted("companyProductAvailabilityMatch", { extractNaverPlaceId: item => item.placeId, extractBookingBusinessId: item => item.bookingBusinessId });

async function temporary(t, beforeCleanup = async () => {}) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-company-source-")); t.after(async () => { await beforeCleanup(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); }); return root; }
function snapshot(runId, rows, extra = {}) { return { runId, collectedAt: "2026-08-01T00:00:00Z", inventoryEvidenceVersion: 4,
  productSnapshot: { runId, inventoryEvidenceVersion: 4, daily: rows, productDetails: "saved-product-body-".repeat(2000) }, ...extra }; }
function daily(date, total, extra = {}) { return { stayDate: date, productType: "lodging", rawTotal: total, supply: 16, sold: 4, publicBookings: 3, phoneBookings: 1,
  inventoryEvidenceVersion: 4, collectedAt: "2026-08-01T00:00:00Z", estimatedRevenue: 400000, publicRevenue: 300000, phoneRevenue: 100000, ...extra }; }
function rawCompanies() {
  const records = {};
  for (const [id, name, place] of [["a", "원본 A", "10"], ["b", "원본 B", "20"], ["c", "중복 C", "70"], ["d", "중복 D", "70"]]) records[id] = { companyId: id, primaryName: name, placeIds: [place], bookingBusinessIds: ["booking-" + id], lodgingTypes: ["glamping"], addresses: ["경기도 포천시 모의로"],
    runIds: ["run1"], firstRunId: "run1", lastRunId: "run1", duplicateNotes: id === "a" ? [{ mergedCompanyId: "old-a" }] : [],
    manualCorrection: { active: true, lodgingBasisTotal: 16, productStockCorrections: [{ productId: "p-" + id, count: 4 }] },
    keywords: { k: { keyword: "포천글램핑", runs: [{ runId: "run1", rank: id === "a" ? 1 : 2, collectedAt: "2026-08-01T00:00:00Z" }] } },
    inventory: { runIds: ["run1"], latest: snapshot("run1", [daily("2026-08-02", 16), daily("2026-08-03", 19), daily("2026-08-not-valid", 17), daily("2026-09-01", 12)]),
      previousLatest: snapshot("run1", [daily("2026-07-31", 11)]), snapshots: [snapshot("run1", [daily("2026-08-02", 15)])] }, largeUnusedOriginalField: "do-not-retain-all-company-body".repeat(2000) };
  return records;
}
const runs = [{ id: "run1", keyword: "포천글램핑", collectedAt: "2026-08-01T00:00:00Z", checkIn: "2026-08-01", bookingRangeDays: 32, collectionQuality: { status: "complete" } }];
async function fixture(t, { indexed = false } = {}) {
  let observationIndex = null;
  const root = await temporary(t, async () => { if (observationIndex) await observationIndex.close(); }), companyFile = path.join(root, "company_master/companies.json"), regionFile = path.join(root, "regions.json"), historyFile = path.join(root, "history/observations.jsonl");
  await fs.mkdir(path.dirname(companyFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.writeFile(companyFile, JSON.stringify({ companies: rawCompanies() }));
  await fs.writeFile(regionFile, JSON.stringify({ units: [{ active: true, selectable: true, level: "local", regionKey: "pocheon", name: "포천시", fullName: "경기도 포천시" }] }));
  await fs.writeFile(historyFile, [JSON.stringify({ ...daily("2026-08-02", 16), companyKey: "old-a", runId: "run1", observationId: "a-observation" }),
    JSON.stringify({ ...daily("2026-08-02", 16), companyKey: "name-only-unknown", runId: "run1", observationId: "unknown" }), "not-json"].join("\n") + "\n");
  if (indexed) { observationIndex = createHistoryObservationIndex({ file: historyFile, indexFile: path.join(root, "history/indexes/observations.sqlite") }); await observationIndex.ensure(); }
  const readRevision = async () => { const values = await Promise.all([companyFile, regionFile, historyFile].map(async filename => { const stat = await fs.stat(filename, { bigint: true }); return [String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.ino)]; })); return sha(JSON.stringify(values)); };
  const make = (cached, hooks = {}) => createMonthlyReportSources({ dataDir: root, regionMasterFile: regionFile, listRuns: async () => json(runs), observationIndex,
    readRevision, ...(cached ? { projectCapacityCompany: compactMonthlyCapacityCompany, companySourceVersion: "explicit-fixture-calculation-1" } : {}),
    capacityForCompany: maximum, prepareCompanies: async companies => companies, ...hooks });
  return { root, companyFile, regionFile, historyFile, make, readRevision, observationIndex };
}

test("compact global capacity metadata preserves the exact application's maximum and provider matching without full product bodies", () => {
  const cases = Object.values(rawCompanies());
  cases.push({ companyId: "legacy", placeIds: ["90"], bookingBusinessIds: ["B"], inventory: { latest: { stockBasis: { lodgingMaxTotal: 99 }, productSnapshot: { daily: [{ productType: "lodging", rawTotal: -1 }] } } } });
  cases.push({ companyId: "text", inventory: { latest: { stockBasis: { lodgingMaxTotal: 88 }, productSnapshot: { daily: [{ productType: "lodging", rawTotal: "1,123실" }, { productType: "lodging", rawTotal: "3개" }, { productType: "dayuse", rawTotal: 99999 }] } } } });
  cases.push({ companyId: "v4", inventory: { latest: { inventoryEvidenceVersion: 4, capacityBasis: { currentObservedMaximum: 27 }, productSnapshot: { inventoryEvidenceVersion: 4, daily: [] } } } });
  cases.push({ companyId: "zero", inventory: { latest: { stockBasis: { lodgingMaxTotal: 900 }, productSnapshot: { daily: [{ productType: "lodging", rawTotal: 0 }] } } } });
  cases.push({ companyId: "missing", inventory: { latest: { stockBasis: { lodgingMaxTotal: 13 }, productSnapshot: { daily: [{ productType: "lodging", rawTotal: 60, missing: true }] } } } });
  for (const company of cases) {
    const before = JSON.stringify(company), compact = compactMonthlyCapacityCompany(company); assert.equal(maximum(compact), maximum(company), company.companyId);
    for (const item of [{ placeId: "10", bookingBusinessId: "booking-a" }, { placeId: "10", bookingBusinessId: "conflicting" }, { placeId: "other", bookingBusinessId: "booking-a" }, { bookingBusinessId: "B" }, {}]) {
      assert.equal(availabilityMatch(compact, item), availabilityMatch(company, item)); assert.deepEqual(json(capacityRecord(item, compact)), json(capacityRecord(item, company)));
    }
    assert.equal(JSON.stringify(company), before); assert.ok(!JSON.stringify(compact).includes("saved-product-body"));
  }
});

test("compact rank metadata tolerates null legacy run references without inventing evidence", () => {
  const company = { companyId: "legacy-null", keywords: { k: { runs: [null, { runId: "actual", rank: 0 }] } } };
  assert.deepEqual(compactMonthlyCapacityCompany(company).keywords.k.runs, [{}, { runId: "actual", rank: 0 }]);
});

test("a derived-directory symlink cannot create files outside the configured data root", async t => {
  const root = await temporary(t), outside = await temporary(t);
  await fs.symlink(outside, path.join(root, "monthly_reports"), process.platform === "win32" ? "junction" : "dir");
  const catalog = createMonthlyCompanySourceCatalog({ dataDir: root, readRevision: async () => "actual-source",
    projectCapacityCompany: compactMonthlyCapacityCompany, loadFullCatalog: async () => ({ companies: [], regions: [], runs: [], rawCompanies: new Map() }) });
  await assert.rejects(catalog.readCompanyCatalog("absent"), { code: "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID" });
  assert.deepEqual(await fs.readdir(outside), []);
});

for (const indexed of [false, true]) test(`company-only projection preserves all source quantities, ranks, global unknown/conflict diagnostics (indexed=${indexed})`, async t => {
  const f = await fixture(t, { indexed }), direct = f.make(false), projected = f.make(true); const masterBefore = await fs.readFile(f.companyFile);
  for (const targetId of ["a", "b", "c", "absent"]) for (const month of ["2026-07", "2026-08", "2026-09"]) {
    const request = { type: "company", targetId, month, cutoffDate: "2026-09-30" };
    assert.deepEqual(json(await projected.loadSources(request)), json(await direct.loadSources(request)), targetId + "/" + month);
  }
  assert.equal(projected.sourceReadMetrics().catalogFullReads, 1); assert.equal(projected.sourceReadMetrics().capacityPreparations, 1);
  assert.equal(projected.sourceReadMetrics().companyCatalog.builds, 1); assert.equal(projected.sourceReadMetrics().companyCatalog.retainedFullCompanies, 0);
  assert.equal(projected.sourceReadMetrics().companyCatalog.companyBodyReads, 9); assert.ok(projected.sourceReadMetrics().companyCatalog.compactBytes < masterBefore.length / 2);
  assert.deepEqual(await fs.readFile(f.companyFile), masterBefore);
});

test("active-id merged-alias overrides preserve original fallback quantities, last-winner order and diagnostics", async t => {
  const f = await fixture(t, { indexed: true }), master = JSON.parse(await fs.readFile(f.companyFile));
  master.companies.b.duplicateNotes = [{ mergedCompanyId: "a" }, { mergedCompanyId: "c" }];
  master.companies.a.inventory.latest.productSnapshot.daily = [daily("2026-08-02", 23, { sold: 9, publicBookings: 8, phoneBookings: 1 })];
  master.companies.c.inventory.latest.productSnapshot.daily = [daily("2026-08-04", 29, { sold: 11, publicBookings: 10, phoneBookings: 1 })];
  await fs.writeFile(f.companyFile, JSON.stringify(master));
  const direct = f.make(false), projected = f.make(true);
  for (const targetId of ["a", "b", "c", "d"]) {
    const request = { type: "company", targetId, month: "2026-08", cutoffDate: "2026-08-31" };
    assert.deepEqual(json(await projected.loadSources(request)), json(await direct.loadSources(request)), targetId);
  }
  const b = await projected.loadSources({ type: "company", targetId: "b", month: "2026-08", cutoffDate: "2026-08-31" });
  assert.ok(b.observations.some(row => row.stayDate === "2026-08-04" && row.sold === 11));
});

test("a restart reuses the saved projection; original changes rebuild it without TTL and new companies become visible", async t => {
  const f = await fixture(t), request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  const first = f.make(true); await first.loadSources(request);
  const restarted = f.make(true); const original = await restarted.loadSources(request);
  assert.equal(restarted.sourceReadMetrics().catalogFullReads, 0); assert.equal(restarted.sourceReadMetrics().capacityPreparations, 0); assert.equal(restarted.sourceReadMetrics().companyCatalog.savedHits, 1);
  const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.primaryName = "실제 변경된 업체명"; master.companies.new = { ...master.companies.b, companyId: "new", primaryName: "새 업체", placeIds: ["new-place"] };
  await fs.writeFile(f.companyFile, JSON.stringify(master)); const refreshed = await restarted.loadSources(request);
  assert.equal(refreshed.companies.find(company => company.companyId === "a").primaryName, "실제 변경된 업체명"); assert.ok(refreshed.companies.some(company => company.companyId === "new"));
  assert.equal(restarted.sourceReadMetrics().catalogFullReads, 1); assert.notDeepEqual(refreshed.companies, original.companies);
});

test("full-catalog company reads and keyword/region/industry behavior keep the existing path", async t => {
  const f = await fixture(t), projected = f.make(true), direct = f.make(false);
  for (const [type, targetId] of [["keyword", "포천글램핑"], ["region", "pocheon"], ["industry", "__industry_all__"]]) {
    const request = { type, targetId, month: "2026-08", cutoffDate: "2026-08-31" }; assert.deepEqual(json(await projected.loadSources(request)), json(await direct.loadSources(request)));
  }
  const pair = await projected.loadSourcesWithCatalog({ type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" });
  assert.equal(pair.catalog.rawCompanies.get("b").inventory.latest.productSnapshot.daily.length, 4); assert.equal(pair.catalog._companySource, undefined);
  assert.equal(projected.sourceReadMetrics().companyCatalog.builds, 0);
});

test("recalculation sees all capacity identities but can lazily load a nonselected full company from the same verified generation", async t => {
  const f = await fixture(t); let calls = 0;
  const projected = f.make(true, { recalculateCompanyObservations: async (request, data) => {
    calls++; assert.equal(data.rawCompanies.get(request.targetId)._monthlySourceCompact, undefined);
    assert.ok(data.rawCompanies.get("b")._monthlySourceCompact); assert.equal(data.rawCompanies.size, 4);
    assert.equal(data.rawCompanies.get("b").inventory.latest.productSnapshot.daily.length, 1);
    assert.ok(!JSON.stringify(data).includes("_companySource")); const selectedB = await data._companySource.readCompany("b");
    assert.equal(selectedB.inventory.latest.productSnapshot.daily.length, 4); assert.equal(selectedB.largeUnusedOriginalField.length > 1000, true);
    assert.equal(maximum(selectedB), maximum(data.rawCompanies.get("b"))); await data._companySource.assertCurrent(); return [];
  } });
  await projected.loadSources({ type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" }); assert.equal(calls, 1);
});

test("mid-read original changes fail closed and preserve the last good source pointer and existing monthly aggregate", async t => {
  const f = await fixture(t), aggregate = path.join(f.root, "company_integrated/preserved-month.json"); await fs.mkdir(path.dirname(aggregate)); await fs.writeFile(aggregate, "preserved-month-and-calculatedAt");
  const request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" }; await f.make(true).loadSources(request);
  const pointer = path.join(f.root, "monthly_reports/company_sources/current.json"), beforePointer = await fs.readFile(pointer); let changed = false;
  const failing = f.make(true, { recalculateCompanyObservations: async () => { if (!changed) { changed = true; const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.primaryName = "changed-during-read"; await fs.writeFile(f.companyFile, JSON.stringify(master)); } return []; } });
  await assert.rejects(failing.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.deepEqual(await fs.readFile(pointer), beforePointer); assert.equal(await fs.readFile(aggregate, "utf8"), "preserved-month-and-calculatedAt");
  assert.equal((await failing.loadSources(request)).companies.find(company => company.companyId === "a").primaryName, "changed-during-read");
});

for (const corrupt of ["selected-body", "catalog", "pointer"]) test(`corrupt ${corrupt} is rejected without returning a stale result or changing originals`, async t => {
  const f = await fixture(t), projected = f.make(true), request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  await projected.loadSources(request); const original = await fs.readFile(f.companyFile), base = path.join(f.root, "monthly_reports/company_sources"), pointer = JSON.parse(await fs.readFile(path.join(base, "current.json")));
  const corruptFile = corrupt === "selected-body" ? path.join(base, pointer.generation, sha("a") + ".json") : corrupt === "catalog" ? path.join(base, pointer.generation, "catalog.json") : path.join(base, "current.json");
  await fs.writeFile(corruptFile, "corrupt-derived-only"); await assert.rejects(projected.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" }); assert.deepEqual(await fs.readFile(f.companyFile), original);
});

test("continuous source changes never publish a mixed-generation catalog", async t => {
  const f = await fixture(t), pointer = path.join(f.root, "monthly_reports/company_sources/current.json"); let preparations = 0;
  const projected = f.make(true, { prepareCompanies: async companies => { const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.primaryName = "generation-" + (++preparations); await fs.writeFile(f.companyFile, JSON.stringify(master)); return companies; } });
  await assert.rejects(projected.loadSources({ type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" }), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.equal(preparations, 2); await assert.rejects(fs.stat(pointer), { code: "ENOENT" });
});

test("only current and previous own derived generations remain after repeated source changes", async t => {
  const f = await fixture(t), projected = f.make(true), request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  for (let i = 0; i < 4; i++) { const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.primaryName = "source-" + i; await fs.writeFile(f.companyFile, JSON.stringify(master)); await projected.loadSources(request); }
  const names = await fs.readdir(path.join(f.root, "monthly_reports/company_sources")); assert.equal(names.filter(name => name.startsWith("generation-")).length, 2);
  assert.equal(projected.sourceReadMetrics().companyCatalog.cleanupFailures, 0); assert.equal(projected.sourceReadMetrics().catalogFullReads, 4);
});

async function smallGenerationFixture(t, options = {}) {
  const root = await temporary(t), directory = path.join(root, "monthly_reports/company_sources");
  const original = path.join(root, "original.txt"); await fs.writeFile(original, "original-must-remain");
  let revision = 1, changing = false, failure = null;
  const raw = { companyId: "a", primaryName: "selected", placeIds: ["a"] };
  const catalog = createMonthlyCompanySourceCatalog({ dataDir: root, readRevision: async () => "r" + revision,
    projectCapacityCompany: company => ({ companyId: company.companyId }),
    loadFullCatalog: async () => { if (failure) throw failure; if (changing) revision++;
      return { companies: [{ companyId: "a" }], rawCompanies: new Map([["a", raw]]), regions: [], runs: [] }; }, ...options });
  const names = async () => (await fs.readdir(directory)).filter(name => /^generation-[a-f0-9]{32}$/.test(name)).sort();
  return { root, directory, original, catalog, names, raw, next: () => revision++, change: () => { changing = true; revision++; },
    fail: error => { failure = error; }, read: () => catalog.readCompanyCatalog("a") };
}

test("twenty repeatedly changing reads remove every unpublished attempt without growing stored generations", async t => {
  const f = await smallGenerationFixture(t); f.change();
  for (let index = 0; index < 20; index++) await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.deepEqual(await f.names(), []); assert.equal(f.catalog.stats().abandonedGenerationsRemoved, 40);
  assert.equal(f.catalog.stats().abandonedCleanupFailures, 0);
  assert.equal(await fs.readFile(f.original, "utf8"), "original-must-remain");
});

test("failed replacements preserve the published current and previous generation byte for byte", async t => {
  const f = await smallGenerationFixture(t); await f.read(); f.next(); await f.read();
  const names = await f.names(), pointer = await fs.readFile(path.join(f.directory, "current.json")), saved = [];
  for (const name of names) for (const file of await fs.readdir(path.join(f.directory, name))) saved.push([name, file, await fs.readFile(path.join(f.directory, name, file))]);
  assert.equal(names.length, 2); f.change(); await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.deepEqual(await f.names(), names); assert.deepEqual(await fs.readFile(path.join(f.directory, "current.json")), pointer);
  for (const [name, file, bytes] of saved) assert.deepEqual(await fs.readFile(path.join(f.directory, name, file)), bytes);
});

test("load and oversized-company failures clean only their newly created unpublished generation", async t => {
  const failed = await smallGenerationFixture(t); const error = Error("source failed"); failed.fail(error);
  await assert.rejects(failed.read(), caught => caught === error); assert.deepEqual(await failed.names(), []);
  const oversized = await smallGenerationFixture(t, { maxCompanyBytes: 128 }); oversized.raw.large = "x".repeat(256);
  await assert.rejects(oversized.read(), { code: "MONTHLY_COMPANY_SOURCE_TOO_LARGE" }); assert.deepEqual(await oversized.names(), []);
});

test("write failure removes its partial generation and uncertain rename preserves a freshly published pointer", async t => {
  const writing = await smallGenerationFixture(t), originalOpen = fs.open, originalRename = fs.rename;
  try {
    fs.open = async function(file, ...args) { if (String(file).startsWith(writing.directory + path.sep) && /^[a-f0-9]{64}[.]json$/.test(path.basename(String(file)))) throw Object.assign(Error(), { code: "EACCES" }); return originalOpen.call(this, file, ...args); };
    await assert.rejects(writing.read(), { code: "EACCES" }); assert.deepEqual(await writing.names(), []);
  } finally { fs.open = originalOpen; }
  const renaming = await smallGenerationFixture(t);
  try {
    fs.rename = async function(from, to) { await originalRename.call(this, from, to); if (to === path.join(renaming.directory, "current.json")) throw Object.assign(Error(), { code: "EIO" }); };
    await assert.rejects(renaming.read(), { code: "EIO" });
    const pointer = JSON.parse(await fs.readFile(path.join(renaming.directory, "current.json")));
    assert.deepEqual(await renaming.names(), [pointer.generation]);
    assert.equal(JSON.parse(await fs.readFile(path.join(renaming.directory, pointer.generation, sha("a") + ".json"))).companyId, "a");
  } finally { fs.rename = originalRename; }
  assert.equal((await renaming.read()).rawCompanies.get("a").primaryName, "selected");
});

test("unremovable abandoned generations reach a hard count cap rather than growing on later reads", async t => {
  const f = await smallGenerationFixture(t, { maxStoredGenerations: 3, maxGenerationBytes: 4096 }), originalUnlink = fs.unlink;
  f.change();
  try {
    fs.unlink = async function(file, ...args) { if (String(file).startsWith(f.directory + path.sep) && /^[a-f0-9]{64}[.]json$/.test(path.basename(String(file)))) throw Object.assign(Error(), { code: "EACCES" }); return originalUnlink.call(this, file, ...args); };
    await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
    await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_STORAGE_LIMIT" });
    assert.equal((await f.names()).length, 3);
    await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_STORAGE_LIMIT" }); assert.equal((await f.names()).length, 3);
    assert.equal(f.catalog.stats().abandonedCleanupFailures, 3); assert.equal(f.catalog.stats().storageLimitStops, 2);
  } finally { fs.unlink = originalUnlink; }
  assert.equal(await fs.readFile(f.original, "utf8"), "original-must-remain");
});

test("prebuild byte budget reserves the next generation without deleting preexisting directories", async t => {
  const f = await smallGenerationFixture(t, { maxGenerationBytes: 256, maxStoredBytes: 512 }), name = "generation-" + "a".repeat(32);
  const full = path.join(f.directory, name); await fs.mkdir(full, { recursive: true });
  const file = path.join(full, sha("orphan") + ".json"), bytes = Buffer.alloc(500, 1); await fs.writeFile(file, bytes);
  await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_STORAGE_LIMIT" });
  assert.deepEqual(await f.names(), [name]); assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(f.catalog.stats().fullCatalogReads, 0);
});

test("an unverifiable fresh pointer preserves abandoned attempts instead of guessing what can be removed", async t => {
  const root = await temporary(t), directory = path.join(root, "monthly_reports/company_sources");
  let revision = 0;
  const catalog = createMonthlyCompanySourceCatalog({ dataDir: root, readRevision: async () => "r" + revision,
    projectCapacityCompany: company => ({ companyId: company.companyId }),
    loadFullCatalog: async () => {
      revision++;
      await fs.writeFile(path.join(directory, "current.json"), "invalid-pointer-must-remain");
      return { companies: [{ companyId: "a" }], rawCompanies: new Map([["a", { companyId: "a" }]]), regions: [], runs: [] };
    } });
  await assert.rejects(catalog.readCompanyCatalog("a"), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.equal((await fs.readdir(directory)).filter(name => /^generation-[a-f0-9]{32}$/.test(name)).length, 2);
  assert.equal(catalog.stats().abandonedCleanupFailures, 2);
  assert.equal(catalog.stats().abandonedGenerationsRemoved, 0);
  assert.equal(await fs.readFile(path.join(directory, "current.json"), "utf8"), "invalid-pointer-must-remain");
});
