"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createSourceReadScheduler } = require("./lib/source_read_scheduler.cjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const copy = value => structuredClone(value);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-industry-rows-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("monthly-industry-rows-")); await fs.rm(root, { recursive: true, force: true }); });
  const companies = ["a", "b"].map(id => ({ companyId: id, primaryName: id, placeIds: [id], runIds: ["earlier", "current", "later"],
    manualCorrection: { lodgingBasisTotal: id === "a" ? 16 : 10 }, keywords: { source: { keyword: "source", runs: ["earlier", "current", "later"].map(runId => ({ runId })) } } }));
  const runs = [["earlier", "2026-08-20", 12], ["current", "2026-09-20", 7], ["later", "2026-09-25", 9]].map(([id, checkIn, stock]) => ({ id, checkIn,
    collectedAt: checkIn + "T00:00:00Z", collectedAtSource: "manifest", collectionQuality: { status: "complete" }, bookingRangeDays: 1, keyword: "source", stock }));
  const product = (id, name, date, stock, saleType = "숙박") => ({ bizItemId: id, name, date, stock, saleType, bookingCount: 1, occupiedBookingCount: 0,
    price: saleType === "숙박" ? 150000 : 40000, open: true });
  const stored = new Map(runs.map(run => [run.id, { run, availability: { items: companies.map(company => ({ placeId: company.companyId, checkIn: run.checkIn, bookingRangeDays: 1,
    weeklyProductDetails: [product("room", "숙박", run.checkIn, run.stock), product("lunch", "런치", run.checkIn, 2, "데이유즈"), product("dinner", "디너", run.checkIn, 2, "데이유즈")],
    dayUsePresence: "present", dayUseMode: "detail", dayUseScheduleStatus: "requested" })) } }]));
  let revision = "r1", evidence = [], onLoad = null;
  const loaded = [], owner = { revision, assertCurrent: async () => { if (revision !== owner.revision) throw Object.assign(Error("changed"), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" }); },
    readCompany: async id => companies.find(company => company.companyId === id) };
  const data = { rawCompanies: new Map(companies.map(company => [company.companyId, company])), companies: companies.map(company => ({ companyId: company.companyId, regionKey: "r" })), runs, _companySource: owner };
  const options = { cacheDirectory: root, cacheVersion: "industry-test-1", recalculateAllInventory: true,
    readProductCapacityEvidence: async () => copy(evidence),
    loadRun: async (id, options) => { loaded.push(id); assert.equal(options.skipProductCapacityStore, true); assert.equal(options.capacityCompanies.length, 2); if (onLoad) await onLoad(id); return copy(stored.get(id)); },
    projectCorrectionCompany: copy, companyProductAvailabilityMatch: (company, item) => company.placeIds.includes(item.placeId),
    applyCompanyManualCorrection: (item, company) => applyInventoryEvidence({ ...item, inventoryCapacityBaseline: { ...item.inventoryCapacityBaseline, lodging: company.manualCorrection.lodgingBasisTotal } }),
    buildHistoryObservations: value => value.availability.items.flatMap(item => ["lodging", "dayUse"].flatMap(kind => (item.inventoryEvidence[kind]?.rows || []).map(row => ({ ...row,
      productType: kind === "dayUse" ? "dayuse" : "lodging", stayDate: row.date, inventoryEvidenceVersion: item.inventoryEvidence.version,
      testBaseline: item.inventoryCapacityBaseline.lodgingProducts || {} })))) };
  const request = { type: "industry", targetId: "__industry_all__", month: "2026-09", cutoffDate: "2026-09-30" };
  return { root, industryDirectory: path.join(root, "industry_rows"), companies, stored, runs, data, owner, options, request, loaded,
    evidence: value => { evidence = value; }, onLoad: value => { onLoad = value; }, changeSource: (next = "r2", updateOwner = true) => { revision = next; if (updateOwner) owner.revision = next; } };
}
const capture = rows => ({ rows: copy(rows), evidence: copy(rows.productCapacityEvidence), warnings: copy(rows.productCapacityWarnings), revision: rows.productCapacityEvidenceRevision });
const files = async directory => { try { return (await fs.readdir(directory)).filter(name => /^[a-f0-9]{64}\.json(?:\.gz)?$/.test(name)); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
test("industry cold, warm and restarted compact units equal uncached rows, order and as-of evidence", async t => {
  const f = await fixture(t), baseline = createMonthlyCompanyRecalculation({ ...f.options, cacheDirectory: null });
  const expected = capture(await baseline(f.request, f.data)); f.loaded.length = 0;
  const helper = createMonthlyCompanyRecalculation(f.options), cold = capture(await helper(f.request, f.data));
  assert.deepEqual(cold, expected); assert.deepEqual(f.loaded, ["earlier", "current", "later"]);
  assert.deepEqual(capture(await helper(f.request, f.data)), expected); assert.equal(f.loaded.length, 3);
  const restarted = createMonthlyCompanyRecalculation(f.options);
  assert.deepEqual(capture(await restarted(f.request, f.data)), expected); assert.equal(f.loaded.length, 3);
  assert.equal(helper.stats().industryRunRowBuilds, 3); assert.equal(helper.stats().industryRunRowCacheHits, 3); assert.equal(helper.stats().runRowBuilds, 0);
  assert.equal((await files(f.industryDirectory)).length, 3); assert.equal((await files(f.root)).length, 0);
  assert.equal(cold.rows.find(row => row.companyId === "a" && row.productType === "lodging").testBaseline.room.count, 12, "earlier out-of-month normal maximum still applies");
});
test("a cooperative interruption publishes no partial result and a retry reuses only the completed run unit", async t => {
  const f = await fixture(t), baseline = createMonthlyCompanyRecalculation({ ...f.options, cacheDirectory: null });
  const expected = capture(await baseline(f.request, f.data)); f.loaded.length = 0;
  const helper = createMonthlyCompanyRecalculation(f.options), yielded = Object.assign(Error("yield"), { code: "ANALYTICAL_WORK_YIELD" });
  let published = false;
  await assert.rejects((async () => { const rows = await helper(f.request, f.data, { checkpoint: async () => { if ((await files(f.industryDirectory)).length === 1) throw yielded; } }); published = true; return rows; })(), error => error === yielded);
  assert.equal(published, false); assert.deepEqual(f.loaded, ["earlier"]); assert.equal((await files(f.industryDirectory)).length, 1);
  assert.deepEqual(capture(await helper(f.request, f.data)), expected); assert.deepEqual(f.loaded, ["earlier", "current", "later"]);
  assert.equal(helper.stats().industryRunRowCacheHits, 1);
});
test("actual industry scheduling unwinds its source slot before serving a foreground reader and reuses completed units on retry", async t => {
  const f = await fixture(t), baseline = createMonthlyCompanyRecalculation({ ...f.options, cacheDirectory: null });
  const expected = capture(await baseline(f.request, f.data)); f.loaded.length = 0;
  const helper = createMonthlyCompanyRecalculation(f.options), source = createSourceReadScheduler(), scheduler = createAnalyticalWorkScheduler({ cooperativeYield: true, cooperativeMinRunMs: 0 });
  t.after(() => scheduler.close());
  const trace = []; let attempts = 0, foreground;
  const result = await scheduler.run(async () => {
    attempts++; trace.push("attempt" + attempts);
    return source.run(() => helper(f.request, f.data, { checkpoint: async () => {
      if (!foreground && (await files(f.industryDirectory)).length === 1) foreground = scheduler.run(() => {
        assert.equal(source.status().active, false, "the cancelled reconstruction must release its source allocation before another owner runs");
        trace.push("foreground"); return "saved";
      }, { kind: "insight-company-view", detached: true });
      await source.checkpoint({ priority: "background" });
    } }), { priority: "background" });
  }, { priority: "background", kind: "industry-build" });
  assert.equal(await foreground, "saved"); assert.deepEqual(capture(result), expected);
  assert.deepEqual(trace, ["attempt1", "foreground", "attempt2"]); assert.deepEqual(f.loaded, ["earlier", "current", "later"]);
  assert.equal(scheduler.status().timing.yielded, 1); assert.equal(scheduler.status().timing.failed, 0); assert.equal(helper.stats().industryRunRowCacheHits, 1);
});
test("recalculation forwards its exact checkpoint to both capacity readers and propagates interruption before loading a run", async t => {
  const f = await fixture(t), expected = capture(await createMonthlyCompanyRecalculation({ ...f.options, cacheDirectory: null })(f.request, f.data));
  for (const dependency of ["readProductCapacityEvidence", "readPersistedProductCapacityEvidence"]) {
    const interrupted = Object.assign(Error("yield"), { code: "ANALYTICAL_WORK_YIELDED" });
    let inside = false, interrupt = true, calls = 0;
    const checkpoint = async () => { if (inside && interrupt) throw interrupted; };
    const options = { ...f.options, cacheDirectory: null, [dependency]: async (requestOrCompanies, dataOrOptions, readOptions) => {
      const passed = dependency === "readProductCapacityEvidence" ? readOptions : dataOrOptions;
      assert.equal(passed.checkpoint, checkpoint); if (passed.companyIds) assert.deepEqual(passed.companyIds, ["a", "b"]);
      calls++; inside = true; try { await passed.checkpoint(); } finally { inside = false; }
      return dependency === "readProductCapacityEvidence" ? [] : { evidence: [], warnings: [] };
    } };
    const helper = createMonthlyCompanyRecalculation(options); f.loaded.length = 0;
    await assert.rejects(helper(f.request, f.data, { checkpoint }), error => error === interrupted); assert.equal(f.loaded.length, 0);
    interrupt = false; assert.deepEqual(capture(await helper(f.request, f.data, { checkpoint })), expected); assert.equal(calls, 2);
  }
});
test("industry cache cannot read, replace or evict company cache units and region reads remain uncached", async t => {
  const f = await fixture(t), helper = createMonthlyCompanyRecalculation(f.options);
  await helper({ ...f.request, type: "company", targetId: "a" }, f.data);
  const companyFiles = await files(f.root), before = new Map(await Promise.all(companyFiles.map(async name => [name, sha(await fs.readFile(path.join(f.root, name)))])));
  assert.ok(companyFiles.every(name => name.endsWith(".json")), "company cache remains uncompressed and unchanged");
  f.loaded.length = 0; await helper(f.request, f.data); assert.equal(f.loaded.length, 3, "industry starts with its independent namespace");
  await helper(f.request, f.data); assert.equal(f.loaded.length, 3);
  assert.deepEqual(await files(f.root), companyFiles); for (const name of companyFiles) assert.equal(sha(await fs.readFile(path.join(f.root, name))), before.get(name));
  await helper({ ...f.request, type: "company", targetId: "a" }, f.data); assert.equal(f.loaded.length, 3, "company units remain warm");
  await helper({ ...f.request, type: "region", targetId: "r" }, f.data); await helper({ ...f.request, type: "region", targetId: "r" }, f.data);
  assert.equal(f.loaded.length, 9, "only industry and company opt in to compact run caching");
});
test("changed source generations and as-of capacity witnesses invalidate all relevant completed units", async t => {
  const f = await fixture(t), helper = createMonthlyCompanyRecalculation(f.options); await helper(f.request, f.data);
  f.changeSource(); await helper(f.request, f.data); assert.equal(f.loaded.length, 6);
  f.evidence([{ companyId: "a", productId: "room", productType: "lodging", count: 15, collectedAt: "2026-08-01T00:00:00Z", runId: "certified", source: "certified_saved_product_response" }]);
  const actual = capture(await helper(f.request, f.data)); assert.equal(f.loaded.length, 9);
  const baseline = createMonthlyCompanyRecalculation({ ...f.options, cacheDirectory: null }); assert.deepEqual(actual, capture(await baseline(f.request, f.data)));
  f.loaded.length = 0;
  f.evidence([{ companyId: "a", productId: "room", productType: "lodging", count: 99, collectedAt: "2026-10-01T00:00:00Z", runId: "future", source: "normal_saved_product_response" }]);
  const future = await helper(f.request, f.data); assert.equal(future.find(row => row.companyId === "a" && row.productType === "lodging").testBaseline.room.count, 12, "future witness cannot increase a past run's baseline");
});
test("a changed original during a unit build fails closed, leaving no completed old-revision unit", async t => {
  const f = await fixture(t), helper = createMonthlyCompanyRecalculation(f.options); f.onLoad(() => f.changeSource("r2", false));
  await assert.rejects(helper(f.request, f.data)); assert.equal((await files(f.industryDirectory)).length, 0);
  f.onLoad(null); f.owner.revision = "r2"; assert.ok((await helper(f.request, f.data)).length > 0);
});
test("malformed compact files rebuild while source/calculation errors never become successful empty rows", async t => {
  const f = await fixture(t), helper = createMonthlyCompanyRecalculation(f.options); await helper(f.request, f.data);
  await fs.writeFile(path.join(f.industryDirectory, (await files(f.industryDirectory))[0]), "{bad");
  await helper(f.request, f.data); assert.equal(f.loaded.length, 4);
  f.changeSource(); f.options.applyCompanyManualCorrection = () => { throw Error("calculation failed"); };
  await assert.rejects(createMonthlyCompanyRecalculation(f.options)(f.request, f.data), error => error.code === "MONTHLY_RECALCULATION_UNAVAILABLE");
});
test("oversized industry run units preserve uncached output and use a bounded remembered fallback", async t => {
  const f = await fixture(t), baseline = createMonthlyCompanyRecalculation({ ...f.options, cacheDirectory: null });
  const expected = capture(await baseline(f.request, f.data)); f.loaded.length = 0;
  const helper = createMonthlyCompanyRecalculation({ ...f.options, maxCachedRunBytes: 128 });
  assert.deepEqual(capture(await helper(f.request, f.data)), expected); assert.equal(f.loaded.length, 6);
  assert.equal(helper.stats().industryRunRowOversizeFallbacks, 3); assert.equal(helper.stats().runRowOversizeFallbacks, 0);
  assert.deepEqual(capture(await helper(f.request, f.data)), expected); assert.equal(f.loaded.length, 9);
  assert.equal((await files(f.industryDirectory)).length, 0);
});
test("146 large repetitive industry units exceed 64MiB decoded yet remain gzip-cached without raw reloads", async t => {
  const f = await fixture(t), runs = Array.from({ length: 146 }, (_, index) => ({ id: "r" + String(index).padStart(3, "0"), keyword: "source", checkIn: "2026-09-01",
    collectedAt: new Date(Date.parse("2026-09-01T00:00:00Z") + index * 60000).toISOString(), collectedAtSource: "manifest", bookingRangeDays: 1, collectionQuality: { status: "complete" } }));
  const company = { companyId: "a", primaryName: "a", placeIds: ["a"], runIds: runs.map(run => run.id) };
  f.data.runs = runs; f.data.rawCompanies = new Map([["a", company]]); f.data.companies = [{ companyId: "a" }];
  const padding = "repeated-product-capacity-price-evidence;".repeat(14000).slice(0, 512 * 1024);
  assert.ok(padding.length * runs.length > 64 * 1024 * 1024, "the uncompressed units exceed the previous physical cache budget");
  let loads = 0;
  const helper = createMonthlyCompanyRecalculation({ ...f.options, projectCorrectionCompany: null,
    loadRun: async id => { loads++; return { run: { id }, availability: { items: [{ placeId: "a" }] } }; },
    applyCompanyManualCorrection: item => ({ ...item, inventoryEvidence: { version: 4 } }),
    buildHistoryObservations: () => [{ stayDate: "2026-09-01", productType: "lodging", inventoryEvidenceVersion: 4, sold: 0, estimatedRevenue: null, padding }] });
  const first = capture(await helper(f.request, f.data)); assert.equal(loads, 146); assert.equal(first.rows.length, 146);
  assert.deepEqual(capture(await helper(f.request, f.data)), first); assert.equal(loads, 146, "a sequential replay must not thrash the old 128-entry budget");
  const names = await files(f.industryDirectory); assert.ok(names.every(name => name.endsWith(".json.gz"))); assert.equal(names.length, 146);
  const physicalBytes = (await Promise.all(names.map(async name => (await fs.stat(path.join(f.industryDirectory, name))).size))).reduce((total, bytes) => total + bytes, 0);
  assert.ok(physicalBytes < 64 * 1024 * 1024); assert.equal(helper.stats().industryRunRowCacheHits, 146);
  assert.ok(helper.stats().maximumIndustryCachedRunBytes < 6 * 1024 * 1024, "compression never loosens the decoded per-run guard");
});
