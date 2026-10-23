"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { test } = require("node:test");
const { aggregateFields, compactCompanyInventory, createCompanyBootstrapStore, acceptsGzip } = require("./lib/company_bootstrap.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-bootstrap-store-"));
  t.after(async () => { assert.ok(root.startsWith(os.tmpdir() + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const sourceFile = path.join(root, "companies.json"), cacheFile = path.join(root, "cache.json");
  const write = async (amount = 16) => fs.writeFile(sourceFile, JSON.stringify({ companies: { one: { companyId: "one", amount } } }));
  await write();
  const calls = [];
  const options = { sourceFile, cacheFile, projectionVersion: "fixture-v1", emptyMaster: () => ({ companies: {} }),
    project: async master => { calls.push(master); return { totalCompanies: Object.keys(master.companies).length, companies: Object.values(master.companies) }; } };
  return { root, sourceFile, cacheFile, write, calls, options, store: createCompanyBootstrapStore(options) };
}

test("compact snapshots retain real zero/null, weekday aggregates and capacity warnings, omit detail evidence", () => {
  const snapshot = { runId: "current", collectedAt: "today", confidenceGrade: "D", structureFlags: ["grouped_range"],
    capacityReview: { required: true, codes: ["conflict"] }, stockBasis: { lodgingMaxTotal: 0 },
    salesSignal: { lodging: { totalSold: 0, averageRate: null, byDayType: [{ label: "평일", sold: 0 }] }, dayUsePresence: "unknown" },
    revenue: { lodging: { revenue: null, pricedSoldOut: 0, byDayType: "금요일 0개", phonePriceEstimates: [{ amount: 10 }] } },
    rooms: [{ name: "반려견 바베큐 수영장 회의실" }],
    productSnapshot: { products: [{ name: "large" }], daily: [{ total: 0 }], capacityBasis: { count: 0, source: "db_correction" }, summary: { dailyCount: 31 } } };
  const original = JSON.stringify(snapshot);
  const inventory = compactCompanyInventory({ latest: snapshot, snapshots: [snapshot, { runId: "previous", collectedAt: "yesterday" }] });
  assert.equal(inventory.latest.salesSignal.lodging.totalSold, 0);
  assert.equal(inventory.latest.salesSignal.lodging.averageRate, null);
  assert.deepEqual(inventory.latest.salesSignal.lodging.byDayType, [{ label: "평일", sold: 0 }]);
  assert.equal(inventory.latest.revenue.lodging.revenue, null);
  assert.equal(inventory.latest.revenue.lodging.byDayType, "금요일 0개");
  assert.deepEqual(inventory.latest.capacityReview.codes, ["conflict"]);
  assert.equal(inventory.latest.productSnapshot.capacityBasis.count, 0);
  assert.ok(inventory.latest._bootstrapFeatureText.includes("반려견"));
  assert.equal(inventory.latest.revenue.lodging.phonePriceEstimates, undefined);
  assert.equal(inventory.latest.productSnapshot.products, undefined);
  assert.equal(inventory.latest.productSnapshot.daily, undefined);
  assert.equal(inventory.previousLatest.runId, "previous");
  assert.deepEqual(inventory.snapshots, []);
  assert.equal(JSON.stringify(snapshot), original, "projection must never mutate saved evidence");
  assert.equal(aggregateFields({ rooms: 0, manualCorrectionHistory: [1] }).rooms, 0);
});

test("positive gzip quality values are accepted and zero/unknown are not", () => {
  for (const header of ["gzip", "br, gzip, deflate", "gzip;q=0.5", "gzip; q=1"]) assert.equal(acceptsGzip(header), true, header);
  for (const header of ["", "br", "gzip;q=0", "gzip;q=0.0", "xgzip", "gzip;q=invalid"]) assert.equal(acceptsGzip(header), false, header);
});

test("single-flight build stores compact values and both encoded representations, then reuses memory", async t => {
  const f = await fixture(t), original = await fs.readFile(f.sourceFile);
  const values = await Promise.all([f.store.get(), f.store.get(), f.store.get()]);
  assert.equal(f.calls.length, 1);
  assert.equal(values[0].cacheStatus, "calculated");
  assert.deepEqual(JSON.parse(zlib.gunzipSync(values[0].gzip)), values[0].data);
  assert.equal(values[0].data.companies[0].amount, 16);
  assert.equal((await f.store.get()).cacheStatus, "memory");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await fs.readFile(f.sourceFile), original);
});

test("new process/store reuses validated saved projection without reparsing the source", async t => {
  const f = await fixture(t); await f.store.get();
  let sourceReads = 0;
  const fileSystem = { ...fs, readFile: async (...args) => { if (args[0] === f.sourceFile) sourceReads += 1; return fs.readFile(...args); } };
  const reopened = createCompanyBootstrapStore({ ...f.options, fileSystem, project: () => { throw new Error("must not recompute"); } });
  assert.equal((await reopened.get()).cacheStatus, "saved");
  assert.equal(sourceReads, 0);
});

test("source edits and same-size atomic replacement invalidate stored/memory projection", async t => {
  const f = await fixture(t); const first = await f.store.get();
  const replacement = path.join(f.root, "replacement.json");
  await fs.writeFile(replacement, (await fs.readFile(f.sourceFile, "utf8")).replace('"amount":16', '"amount":18'));
  await fs.rename(replacement, f.sourceFile);
  const second = await f.store.get();
  assert.equal(second.data.companies[0].amount, 18);
  assert.notEqual(second.data.sourceRevision, first.data.sourceRevision);
  assert.equal(second.cacheStatus, "calculated");
});

test("projection version changes rebuild and tampered derived values are never trusted", async t => {
  const f = await fixture(t); await f.store.get();
  const saved = JSON.parse(await fs.readFile(f.cacheFile, "utf8")); saved.data.companies[0].amount = 99;
  await fs.writeFile(f.cacheFile, JSON.stringify(saved));
  const rebuilt = await createCompanyBootstrapStore(f.options).get();
  assert.equal(rebuilt.cacheStatus, "calculated"); assert.equal(rebuilt.data.companies[0].amount, 16);
  const changedCode = await createCompanyBootstrapStore({ ...f.options, projectionVersion: "fixture-v2" }).get();
  assert.equal(changedCode.cacheStatus, "calculated");
});

test("corrupt/missing/invalid source is an error, never an empty successful DB", async t => {
  const f = await fixture(t); await f.store.get();
  const lastGood = await fs.readFile(f.cacheFile);
  await fs.writeFile(f.sourceFile, "{broken");
  await assert.rejects(f.store.get(), SyntaxError);
  await fs.writeFile(f.sourceFile, JSON.stringify({ companies: [] }));
  await assert.rejects(f.store.get(), error => error.code === "COMPANY_BOOTSTRAP_INVALID_SOURCE");
  assert.deepEqual(await fs.readFile(f.cacheFile), lastGood, "failed builds retain the previous saved projection");
});

test("a genuinely absent company source is an empty DB, while unreadable source is not", async t => {
  const f = await fixture(t); await fs.unlink(f.sourceFile);
  assert.equal((await f.store.get()).data.totalCompanies, 0);
  const failedFs = { ...fs, stat: async () => { throw Object.assign(new Error("private pathname"), { code: "EACCES" }); } };
  await assert.rejects(createCompanyBootstrapStore({ ...f.options, fileSystem: failedFs }).get(), error => error.code === "EACCES");
});

test("a previously known source disappearing is a storage error across memory and server restarts", async t => {
  const f = await fixture(t); await f.store.get();
  const lastGood = await fs.readFile(f.cacheFile);
  await fs.unlink(f.sourceFile);
  await assert.rejects(f.store.get(), error => error.code === "COMPANY_BOOTSTRAP_SOURCE_MISSING");
  const restarted = createCompanyBootstrapStore({ ...f.options, projectionVersion: "new-release" });
  await assert.rejects(restarted.get(), error => error.code === "COMPANY_BOOTSTRAP_SOURCE_MISSING");
  assert.deepEqual(await fs.readFile(f.cacheFile), lastGood);
});

test("source changes during construction retry; an endless changing source fails explicitly", async t => {
  const f = await fixture(t);
  let calls = 0;
  const store = createCompanyBootstrapStore({ ...f.options, project: async master => {
    calls += 1; if (calls === 1) { await f.write(19); store.invalidate(); }
    return f.options.project(master);
  } });
  assert.equal((await store.get()).data.companies[0].amount, 19); assert.equal(calls, 2);
  let amount = 20;
  const racing = createCompanyBootstrapStore({ ...f.options, projectionVersion: "racing", project: async master => {
    const replacement = path.join(f.root, `racing-${amount}.json`);
    await fs.writeFile(replacement, JSON.stringify({ companies: { one: { companyId: "one", amount: amount++ } } }));
    await fs.rename(replacement, f.sourceFile);
    return f.options.project(master);
  } });
  await assert.rejects(racing.get(), error => error.code === "COMPANY_BOOTSTRAP_SOURCE_CHANGED" && error.statusCode === 503);
});

test("cache storage failure still returns the current projection and preserves source", async t => {
  const f = await fixture(t), original = await fs.readFile(f.sourceFile);
  const fileSystem = { ...fs, writeFile: async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); } };
  const result = await createCompanyBootstrapStore({ ...f.options, fileSystem }).get();
  assert.equal(result.data.companies[0].amount, 16);
  assert.deepEqual(await fs.readFile(f.sourceFile), original);
});

test("queued bootstrap and owner reentry share one load without reversing the lease wait", { timeout: 3000 }, async t => {
  const f = await fixture(t), scheduler = createAnalyticalWorkScheduler(), entered = gate(), nested = gate();
  const store = createCompanyBootstrapStore({ ...f.options, runWork: (operation, options) => scheduler.run(operation, options) });
  const owner = scheduler.run(async () => { entered.resolve(); await nested.promise; return store.get(); });
  await entered.promise; const queued = store.get();
  assert.equal(f.calls.length, 0); assert.equal(scheduler.status().queuedForeground, 1); nested.resolve();
  const owned = await owner; assert.equal(await queued, owned); assert.equal(f.calls.length, 1);
  await scheduler.close();
});

test("completed bootstrap groups do not certify a new call after invalidation while old callers wait", { timeout: 3000 }, async t => {
  const f = await fixture(t), scheduler = createAnalyticalWorkScheduler(), entered = gate(), nested = gate(), built = gate(), release = gate();
  const store = createCompanyBootstrapStore({ ...f.options, runWork: (operation, options) => scheduler.run(operation, options) });
  const owner = scheduler.run(async () => {
    entered.resolve(); await nested.promise; const value = await store.get(); built.resolve(value); await release.promise; return value;
  });
  await entered.promise; const oldQueued = store.get(); nested.resolve(); const old = await built.promise;
  await f.write(27); store.invalidate(); const current = store.get();
  assert.equal(scheduler.status().queuedForeground, 2); release.resolve();
  assert.equal(await owner, old); assert.equal(await oldQueued, old);
  assert.equal((await current).data.companies[0].amount, 27); assert.equal(f.calls.length, 2);
  await scheduler.close();
});

test("a validated bootstrap memory hit stays fast but an epoch change during its stat rebuilds", { timeout: 3000 }, async t => {
  const f = await fixture(t), scheduler = createAnalyticalWorkScheduler(), entered = gate(), release = gate(), statEntered = gate(), statRelease = gate();
  let admissions = 0, pauseStat = false;
  const fileSystem = { ...fs, stat: async (...args) => {
    const value = await fs.stat(...args);
    if (pauseStat) { pauseStat = false; statEntered.resolve(); await statRelease.promise; }
    return value;
  } };
  const store = createCompanyBootstrapStore({ ...f.options, fileSystem,
    runWork: (operation, options) => { admissions++; return scheduler.run(operation, options); } });
  assert.equal(admissions, 0, "constructing the store must not invoke a late-bound scheduler");
  await store.get();
  const owner = scheduler.run(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  assert.equal((await store.get()).cacheStatus, "memory"); assert.equal(admissions, 1);
  release.resolve(); await owner;
  pauseStat = true; const racing = store.get(); await statEntered.promise;
  await f.write(31); store.invalidate(); statRelease.resolve();
  const current = await racing; assert.equal(current.cacheStatus, "calculated"); assert.equal(current.data.companies[0].amount, 31);
  assert.equal(admissions, 2); assert.equal(f.calls.length, 2); await scheduler.close();
});

test("admitted bootstrap retains active invalidation retries and nested duplicate result identity", { timeout: 3000 }, async t => {
  const f = await fixture(t), scheduler = createAnalyticalWorkScheduler(); let projects = 0;
  const store = createCompanyBootstrapStore({ ...f.options, runWork: (operation, options) => scheduler.run(operation, options),
    project: async master => {
      if (++projects === 1) { await f.write(37); store.invalidate(); }
      return f.options.project(master);
    } });
  const values = await scheduler.run(() => Promise.all([store.get(), store.get()]));
  assert.equal(values[0], values[1]); assert.equal(values[0].data.companies[0].amount, 37); assert.equal(projects, 2);
  await scheduler.close();
});
