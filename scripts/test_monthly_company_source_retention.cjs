"use strict";

// Tiny authored catalogs only. Observe the factory's private WeakMap entries
// without forcing GC or treating reachability assertions as measured RSS.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { createRequire } = require("node:module");
const catalogFile = path.join(__dirname, "lib", "monthly_company_source_catalog.cjs");
const clone = value => JSON.parse(JSON.stringify(value));

function observedFactory() {
  const writes = [], module = { exports: {} };
  class ObservedWeakMap extends WeakMap {
    set(key, value) { writes.push({ key, value }); return super.set(key, value); }
  }
  vm.runInNewContext(native.readFileSync(catalogFile, "utf8"), {
    module, exports: module.exports, require: createRequire(catalogFile), __filename: catalogFile,
    __dirname: path.dirname(catalogFile), WeakMap: ObservedWeakMap, Map, Buffer
  }, { filename: catalogFile });
  return { ...module.exports, writes };
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-company-retention-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "monthly-company-retention-")); await fs.rm(root, { recursive: true, force: true }); });
  const observed = observedFactory(), fulls = [];
  let revision = "r1";
  function fullCatalog() {
    const full = { companies: [{ companyId: "a", primaryName: "Company A", nested: { future: [0, false, null] } }, { companyId: "b", primaryName: "Company B" }],
      regions: [{ id: "local", aliases: ["one"] }], runs: [{ id: "run1", collectionQuality: { status: "complete" } }],
      rawCompanies: new Map([["a", { companyId: "a", primaryName: "Company A", keywords: { k: { runs: [{ runId: "run1", nested: { keep: true } }] } }, inventory: { daily: [{ supply: 7 }] } }],
        ["b", { companyId: "b", primaryName: "Company B" }]]) };
    fulls.push(full); return full;
  }
  const catalog = observed.createMonthlyCompanySourceCatalog({ dataDir: root, readRevision: async () => revision,
    loadFullCatalog: async () => fullCatalog(), projectCapacityCompany: company => clone({ companyId: company.companyId, primaryName: company.primaryName, keywords: company.keywords }),
    useSourceReadValidationBoundary: true, shareFrozenCatalogMetadata: true, ...options });
  return { root, catalog, fulls, writes: observed.writes, setRevision: value => { revision = value; } };
}
function containsObject(root, target) {
  const pending = [root], seen = new Set();
  while (pending.length) { const value = pending.pop(); if (value === target) return true; if (!value || typeof value !== "object" || seen.has(value)) continue; seen.add(value);
    if (value instanceof Map) for (const [key, item] of value) pending.push(key, item);
    for (const key of Object.keys(value)) pending.push(value[key]); }
  return false;
}
const values = data => clone({ companies: data.companies, regions: data.regions, runs: data.runs, rawCompanies: [...data.rawCompanies] });

test("shared metadata replaces the private retained graph with the independent frozen tree", async t => {
  const f = await fixture(t), data = await f.catalog.readCatalog();
  assert.equal(f.writes.length, 1); const { key: entry, value: copied } = f.writes[0], full = f.fulls[0];
  for (const key of ["companies", "regions", "runs", "rawCompanies"]) {
    assert.strictEqual(entry.value[key], copied[key], key);
    assert.equal(Object.isFrozen(copied[key]), true);
  }
  for (const key of ["companies", "regions", "runs"]) {
    assert.notStrictEqual(copied[key], full[key]);
    assert.equal(containsObject(entry, full[key]), false, `${key} original array is not retained by the private entry`);
    assert.equal(containsObject(entry, full[key][0]), false, `${key} original row is not retained by the private entry`);
    assert.equal(Object.isFrozen(full[key]), false);
    assert.equal(Object.isFrozen(full[key][0]), false);
    assert.strictEqual(data[key], copied[key]);
  }
  full.companies[0].primaryName = "caller-owned mutation"; full.runs[0].collectionQuality.status = "caller-owned mutation";
  const again = await f.catalog.readCatalog(); assert.equal(again.companies[0].primaryName, "Company A"); assert.equal(again.runs[0].collectionQuality.status, "complete");
  assert.notStrictEqual(data.rawCompanies, again.rawCompanies); assert.strictEqual(data.rawCompanies.get("a"), again.rawCompanies.get("a"));
  assert.equal(f.catalog.stats().sharedMetadataBuilds, 1); assert.equal(f.catalog.stats().sharedMetadataReads, 2);
});

test("retention change preserves mutable selected bodies, saved bytes and fresh-process values", async t => {
  const f = await fixture(t), first = await f.catalog.readCompanyCatalog("a"), expected = values(first);
  const entry = f.writes[0].key, pointerFile = path.join(f.catalog.directory, "current.json"), pointer = await fs.readFile(pointerFile),
    savedCatalogFile = path.join(f.catalog.directory, entry.pointer.generation, "catalog.json"), savedCatalog = await fs.readFile(savedCatalogFile);
  first.rawCompanies.get("a").inventory.daily[0].supply = 999; first.rawCompanies.clear();
  assert.deepEqual(values(await f.catalog.readCompanyCatalog("a")), expected);
  assert.deepEqual(await fs.readFile(pointerFile), pointer); assert.deepEqual(await fs.readFile(savedCatalogFile), savedCatalog);
  const observed = observedFactory(), restarted = observed.createMonthlyCompanySourceCatalog({ dataDir: f.root, readRevision: async () => "r1",
    loadFullCatalog: async () => { throw Error("unchanged saved generation must be reused"); },
    projectCapacityCompany: company => clone({ companyId: company.companyId, primaryName: company.primaryName, keywords: company.keywords }),
    useSourceReadValidationBoundary: true, shareFrozenCatalogMetadata: true });
  assert.deepEqual(values(await restarted.readCompanyCatalog("a")), expected);
  assert.equal(restarted.stats().builds, 0); assert.equal(restarted.stats().savedHits, 1);
  assert.deepEqual(await fs.readFile(pointerFile), pointer); assert.deepEqual(await fs.readFile(savedCatalogFile), savedCatalog);
});

test("new revision replaces metadata while an earlier reader keeps only its immutable snapshot", async t => {
  const f = await fixture(t), first = await f.catalog.readCatalog(), firstValue = values(first);
  f.setRevision("r2"); const second = await f.catalog.readCatalog();
  assert.notStrictEqual(first.companies, second.companies); assert.notStrictEqual(first.runs, second.runs);
  assert.deepEqual(values(first), firstValue); assert.equal(f.catalog.stats().builds, 2);
  await assert.rejects(first._companySource.assertCurrent(), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  await second._companySource.assertCurrent();
});

test("generic mutable-copy consumers retain their existing independent contract", async t => {
  const f = await fixture(t, { shareFrozenCatalogMetadata: false }), first = await f.catalog.readCatalog(), original = values(first);
  assert.equal(f.writes.length, 0); assert.equal(Object.isFrozen(first.companies), false);
  first.companies[0].primaryName = "private edit"; first.runs[0].collectionQuality.status = "private edit"; first.rawCompanies.get("a").keywords.k.runs[0].nested.keep = false;
  assert.deepEqual(values(await f.catalog.readCatalog()), original); assert.equal(f.catalog.stats().sharedMetadataBuilds, 0);
});
