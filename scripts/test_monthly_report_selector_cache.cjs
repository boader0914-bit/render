"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyReportSelectorRevision } = require("./lib/monthly_report_selector_revision.cjs");
const { createCompanyCapacityRegistry } = require("./lib/company_capacity_registry.cjs");

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-selector-cache-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const write = async (name, value) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Replace the fixture atomically, matching real DB write behavior and
    // avoiding dependence on the filesystem's timestamp resolution.
    const pending = `${file}.fixture.tmp`;
    await fs.writeFile(pending, typeof value === "string" ? value : JSON.stringify(value));
    await fs.rename(pending, file);
    return file;
  };
  const master = { companies: {
    alpha: { companyId: "alpha", primaryName: "첫 숙소", addresses: ["모의군 첫길"], placeIds: ["100"] },
    beta: { companyId: "beta", primaryName: "두번째 숙소", addresses: ["다른시 둘길"], placeIds: ["200"] }
  } };
  const regions = { units: [
    { regionKey: "region_one", fullName: "모의군", name: "모의군", active: true, selectable: true, level: "local" },
    { regionKey: "region_two", fullName: "다른시", name: "다른시", active: true, selectable: true, level: "local" }
  ] };
  await write("company_master/companies.json", master);
  await write("regions.json", regions);
  await write("history/observations.jsonl", JSON.stringify({ companyKey: "alpha", stayDate: "2026-09-12" }) + "\n");
  await write("outputs/one_glamping_20260912_090000/manifest.json", { id: "run-one", keyword: "모의글램핑", searchMode: "keyword", checkIn: "2026-09-12", checkOut: "2026-09-13" });
  const regionMasterFile = path.join(root, "regions.json");
  const readRevision = createMonthlyReportSelectorRevision({ dataDir: root, regionMasterFile });
  const calls = { runs: 0, capacityPreparation: 0, capacityProjection: 0 };
  async function listRuns() {
    calls.runs++;
    const directories = await fs.readdir(path.join(root, "outputs"), { withFileTypes: true });
    const rows = [];
    for (const entry of directories) {
      if (!entry.isDirectory()) continue;
      try { rows.push(JSON.parse(await fs.readFile(path.join(root, "outputs", entry.name, "manifest.json"), "utf8"))); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return rows;
  }
  function adapter(hooks = {}) {
    return createMonthlyReportSources({ dataDir: root, regionMasterFile, listRuns, readOptionsRevision: readRevision,
      now: () => new Date("2026-10-16T00:00:00.000Z"),
      prepareCompanies: async companies => { calls.capacityPreparation++; return companies; },
      capacityForCompany: () => { calls.capacityProjection++; return 16; }, ...hooks });
  }
  const cacheDirectory = path.join(root, "monthly_reports", "selector_cache");
  async function cacheFiles() {
    return (await fs.readdir(cacheDirectory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => path.join(cacheDirectory, name));
  }
  return { root, master, regions, calls, adapter, write, readRevision, cacheDirectory, cacheFiles };
}

function content(value) {
  const { selectorCache, ...fields } = value;
  return fields;
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("compact selectors persist across adapter instances without preparing capacity or retaining raw inventory", async t => {
  const f = await fixture(t);
  const first = await f.adapter().options();
  assert.equal(first.selectorCache.status, "calculated");
  assert.equal(first.selectorCache.storage, "saved");
  assert.equal(first.today, "2026-10-16");
  assert.equal(first.defaultMonth, "2026-09");
  assert.deepEqual(first.months, ["2026-10", "2026-09"]);
  assert.equal(f.calls.runs, 1);
  assert.equal(f.calls.capacityPreparation, 0, "selector display must not rebuild the capacity registry");
  assert.equal(f.calls.capacityProjection, 0, "selector display does not need room quantities");
  const [file] = await f.cacheFiles();
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(Object.keys(saved.value).sort(), ["companies", "keywords", "observedMonths", "regions"]);
  assert.deepEqual(saved.value.observedMonths, ["2026-09"]);
  assert.equal(Object.hasOwn(saved.value, "today"), false);
  assert.equal(Object.hasOwn(saved.value, "defaultMonth"), false);
  assert.equal(Object.hasOwn(saved.value, "rawCompanies"), false);
  assert.equal(Object.hasOwn(saved.value, "runs"), false);
  assert.deepEqual(Object.keys(saved.value.companies[0]).sort(), ["id", "label", "regionKey"]);
  const reopened = await f.adapter({ listRuns: async () => { throw new Error("warm selector unexpectedly read runs"); } }).options();
  assert.equal(reopened.selectorCache.status, "reused");
  assert.equal(reopened.selectorCache.calculatedAt, first.selectorCache.calculatedAt);
  assert.deepEqual(content(reopened), content(first));
  assert.ok(Number.isFinite(Date.parse(reopened.selectorCache.checkedAt)));
  assert.equal(typeof reopened.selectorCache.timings, "object");
});

test("inactive regional corrections match the prepared catalog without capacity preparation in selectors", async t => {
  const f = await fixture(t);
  f.master.companies.alpha.manualCorrection = { active: false, regionOverride: "region_two" };
  await f.write("company_master/companies.json", f.master);
  const registry = createCompanyCapacityRegistry({ dataDir: f.root, observedCapacity: () => 16, reviewedCapacity: () => null });
  const adapter = f.adapter({ prepareCompanies: registry.prepareCompanies });
  const selectors = await adapter.options();
  assert.equal(selectors.companies.find(row => row.id === "alpha").regionKey, "region_one");
  const catalog = await adapter.catalog();
  assert.equal(catalog.companies.find(row => row.companyId === "alpha").regionKey, "region_one");
  assert.equal(selectors.companies.find(row => row.id === "alpha").regionKey, catalog.companies.find(row => row.companyId === "alpha").regionKey);
});

test("warm selector lookup bypasses an active heavy source read", { timeout: 8000 }, async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  const adapter = f.adapter({ recalculateCompanyObservations: async () => { started.resolve(); await release.promise; return []; } });
  await adapter.options();
  const raw = adapter.loadSources({ type: "company", targetId: "alpha", month: "2026-09", cutoffDate: "2026-09-30" });
  await started.promise;
  let result;
  try {
    result = await Promise.race([adapter.options(), new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("a saved selector waited behind the heavy source reader")), 2500);
      timer.unref?.();
    })]);
    assert.equal(result.selectorCache.status, "reused");
    assert.deepEqual(adapter.sourceReadStatus(), { active: true, queuedForeground: 0, queuedBackground: 0 });
  } finally { release.resolve(); await raw; }
});

test("cold selectors wait in the shared source queue and complete without a nested queue deadlock", { timeout: 8000 }, async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  const adapter = f.adapter({ recalculateCompanyObservations: async () => { started.resolve(); await release.promise; return []; } });
  const raw = adapter.loadSources({ type: "company", targetId: "alpha", month: "2026-09", cutoffDate: "2026-09-30" });
  await started.promise;
  const pending = adapter.options();
  try {
    await until(() => adapter.sourceReadStatus().queuedForeground === 1, "cold selector never entered the source queue");
    assert.equal(f.calls.runs, 1, "the pending selector must not parse another full master while the source read is active");
  } finally { release.resolve(); }
  const [source, options] = await Promise.all([raw, pending]);
  assert.equal(source.companies[0].companyId, options.companies[0].id);
  assert.equal(options.selectorCache.status, "calculated");
  assert.equal(f.calls.runs, 2);
  assert.equal(f.calls.capacityPreparation, 1, "only the actual source read prepares room capacity");
});

test("concurrent cold selector requests build once and cannot mutate each other's returned fields", async t => {
  const f = await fixture(t), started = deferred(), release = deferred();
  let reads = 0;
  const adapter = f.adapter({ listRuns: async () => { reads++; started.resolve(); await release.promise; return []; } });
  const leader = adapter.options();
  await started.promise;
  const follower = adapter.options();
  release.resolve();
  const [one, two] = await Promise.all([leader, follower]);
  assert.equal(reads, 1);
  assert.equal(one.selectorCache.status, "calculated");
  assert.equal(two.selectorCache.status, "coalesced");
  assert.deepEqual(content(one), content(two));
  one.companies[0].label = "mutated by caller";
  one.months.push("1900-01");
  one.regions[0].label = "mutated region";
  assert.notEqual(two.companies[0].label, one.companies[0].label);
  assert.equal(two.months.includes("1900-01"), false);
  assert.notEqual(two.regions[0].label, one.regions[0].label);
  const third = await adapter.options();
  assert.notEqual(third.companies[0].label, one.companies[0].label);
  assert.equal(third.months.includes("1900-01"), false);
});

test("company edits, merges, deletions and reviewed regions invalidate saved selector identities", async t => {
  const f = await fixture(t), adapter = f.adapter();
  await adapter.options();
  f.master.companies.alpha.primaryName = "변경한 숙소명";
  f.master.companies.alpha.addresses = ["다른시 새주소"];
  await f.write("company_master/companies.json", f.master);
  let value = await adapter.options();
  assert.equal(value.selectorCache.status, "calculated");
  assert.equal(value.companies.find(row => row.id === "alpha").label, "변경한 숙소명 · 다른시");
  f.master.companies.alpha.manualCorrection = { regionOverride: "region_one" };
  f.master.companies.beta.mergedIntoCompanyId = "alpha";
  await f.write("company_master/companies.json", f.master);
  value = await adapter.options();
  assert.deepEqual(value.companies.map(row => row.id), ["alpha"]);
  assert.equal(value.companies[0].regionKey, "region_one");
  f.master.companies.alpha.deletedAt = "2026-10-16T00:00:00Z";
  await f.write("company_master/companies.json", f.master);
  value = await adapter.options();
  assert.deepEqual(value.companies, [], "deleted and merged company rows must not survive through a cached identity");
  assert.equal(value.selectorCache.status, "calculated");
});

test("history months, keyword-run additions or edits and region references invalidate compact selectors", async t => {
  const f = await fixture(t), adapter = f.adapter();
  await adapter.options();
  await f.write("history/observations.jsonl", [
    { stayDate: "2026-09-12", companyKey: "alpha" },
    { stayDate: "2026-08-20", companyKey: "alpha", status: "missing", sold: null }
  ].map(JSON.stringify).join("\n"));
  let value = await adapter.options();
  assert.equal(value.selectorCache.status, "calculated");
  assert.ok(value.months.includes("2026-08"), "discovering a month must not depend on treating a missing quantity as zero");
  await f.write("outputs/two_glamping_20260912_100000/manifest.json", { id: "run-two", keyword: "새키워드", searchMode: "keyword", checkIn: "2026-11-01", checkOut: "2026-11-02" });
  value = await adapter.options();
  assert.ok(value.months.includes("2026-11"));
  assert.ok(value.keywords.some(row => row.id === "새키워드"));
  await f.write("outputs/two_glamping_20260912_100000/manifest.json", { id: "run-two", keyword: "업체명", searchMode: "company", checkIn: "2026-11-01", checkOut: "2026-11-02" });
  value = await adapter.options();
  assert.equal(value.keywords.some(row => row.id === "새키워드" || row.id === "업체명"), false);
  f.regions.units[0].fullName = "새로운 모의군";
  await f.write("regions.json", f.regions);
  value = await adapter.options();
  assert.equal(value.regions.find(row => row.id === "region_one").label, "새로운 모의군");
  await fs.unlink(path.join(f.root, "outputs/one_glamping_20260912_090000/manifest.json"));
  value = await adapter.options();
  assert.deepEqual(value.keywords, [], "removed run evidence must not pin a stale keyword in the menu");
});

test("KST day and month boundaries update dynamic selector fields without rebuilding saved source fields", async t => {
  const f = await fixture(t);
  let clock = new Date("2026-10-31T14:59:59.000Z");
  const adapter = f.adapter({ now: () => clock });
  const before = await adapter.options();
  assert.equal(before.today, "2026-10-31");
  assert.deepEqual(before.months, ["2026-10", "2026-09"]);
  assert.equal(before.defaultMonth, "2026-09");
  clock = new Date("2026-10-31T15:00:00.000Z");
  const after = await adapter.options();
  assert.equal(after.selectorCache.status, "reused");
  assert.equal(after.today, "2026-11-01");
  assert.deepEqual(after.months, ["2026-11", "2026-09"], "October was synthetic, not an observed month to retain forever");
  assert.equal(after.defaultMonth, "2026-11");
  clock = new Date("2026-11-01T15:00:00.000Z");
  const nextDay = await adapter.options();
  assert.equal(nextDay.today, "2026-11-02");
  assert.equal(nextDay.selectorCache.status, "reused");
  assert.equal(f.calls.runs, 1);
});

test("a corrupt selector file rebuilds from valid sources and never serves an empty success", async t => {
  const f = await fixture(t), adapter = f.adapter();
  const original = await adapter.options();
  const [file] = await f.cacheFiles();
  await fs.writeFile(file, "{broken derived cache");
  const restored = await adapter.options();
  assert.equal(restored.selectorCache.status, "calculated");
  assert.deepEqual(content(restored), content(original));
  assert.equal(f.calls.runs, 2);
  assert.equal((await f.cacheFiles()).length, 1);
});

test("a broken source rejects rather than serving stale selectors, preserves the old file, and recovers after repair", async t => {
  const f = await fixture(t), adapter = f.adapter();
  await adapter.options();
  const [file] = await f.cacheFiles(), preserved = await fs.readFile(file, "utf8");
  await f.write("company_master/companies.json", "{broken source");
  await assert.rejects(adapter.options(), error => error.code === "MONTHLY_SOURCE_UNAVAILABLE");
  assert.equal(await fs.readFile(file, "utf8"), preserved);
  f.master.companies.alpha.primaryName = "복구된 숙소";
  await f.write("company_master/companies.json", f.master);
  const restored = await adapter.options();
  assert.equal(restored.selectorCache.status, "calculated");
  assert.match(restored.companies[0].label, /복구된 숙소/);
});

test("source-revision failures and changes during a saved lookup cannot certify old selectors as current", async t => {
  const f = await fixture(t);
  let failRevision = false, mutateAfterRead = false;
  const adapter = f.adapter({ readOptionsRevision: async () => {
    if (failRevision) throw Object.assign(new Error("fixture metadata failure"), { code: "MONTHLY_SOURCE_REVISION_UNAVAILABLE" });
    const revision = await f.readRevision();
    if (mutateAfterRead) {
      mutateAfterRead = false;
      f.master.companies.alpha.primaryName = "읽는 동안 변경됨";
      await f.write("company_master/companies.json", f.master);
    }
    return revision;
  } });
  await adapter.options();
  const [file] = await f.cacheFiles(), preserved = await fs.readFile(file, "utf8");
  failRevision = true;
  await assert.rejects(adapter.options(), error => error.code === "MONTHLY_SOURCE_REVISION_UNAVAILABLE");
  assert.equal(await fs.readFile(file, "utf8"), preserved);
  failRevision = false; mutateAfterRead = true;
  await assert.rejects(adapter.options(), error => error.code === "MONTHLY_SOURCE_CHANGED");
  assert.equal(await fs.readFile(file, "utf8"), preserved);
  const refreshed = await adapter.options();
  assert.equal(refreshed.selectorCache.status, "calculated");
  assert.match(refreshed.companies[0].label, /읽는 동안 변경됨/);
});

test("selector cache version changes rebuild derived menus without touching raw source files", async t => {
  const f = await fixture(t);
  const revision = await f.readRevision();
  await f.adapter({ selectorCacheVersion: "monthly-selector-v1" }).options();
  const changed = await f.adapter({ selectorCacheVersion: "monthly-selector-v2" }).options();
  assert.equal(changed.selectorCache.status, "calculated");
  assert.equal(await f.readRevision(), revision);
  assert.equal(f.calls.runs, 2);
  assert.equal((await f.cacheFiles()).length, 1, "the compact selector store retains only the current version");
});
