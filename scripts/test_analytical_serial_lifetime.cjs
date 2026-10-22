"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), nativeFs = require("node:fs");
const path = require("node:path"), os = require("node:os"), vm = require("node:vm");
const { createRequire } = require("node:module");
const NativePromise = Promise, nativeThen = Promise.prototype.then;

// Observe real Promise edges deterministically, without forced GC or a heap
// timing assertion. The observer itself holds references: these tests prove the
// private fulfilled-tail value, not the amount/timing of actual garbage collection.
function observedModule(name, oldRetention = false) {
  const edges = [];
  class ObservedPromise extends NativePromise {
    then(onFulfilled, onRejected) {
      const child = super.then(onFulfilled, onRejected);
      edges.push({ parent: this, child });
      return child;
    }
  }
  const filename = path.join(__dirname, "lib", name), module = { exports: {} };
  let code = nativeFs.readFileSync(filename, "utf8");
  if (oldRetention) {
    const from = name === "company_capacity_registry.cjs" ? "chain = task.then(() => undefined, () => undefined);" : "serial = pending.then(() => undefined, () => undefined);";
    const to = name === "company_capacity_registry.cjs" ? "chain = task.catch(() => {});" : "serial = pending.catch(() => {});";
    assert.equal(code.split(from).length, 2); code = code.replace(from, to);
  }
  vm.runInNewContext(code, { module, exports: module.exports, require: createRequire(filename), __filename: filename,
    __dirname: path.dirname(filename), Promise: ObservedPromise, Map, Set, structuredClone, Buffer, process, console }, { filename });
  return { ...module.exports, tail(task) {
    const children = edges.filter(edge => edge.parent === task);
    assert.equal(children.length, 1, "the private serialization tail is captured before caller observation");
    return children[0].child;
  } };
}

function settlement(promise) {
  return new NativePromise(resolve => nativeThen.call(promise,
    value => resolve({ state: "fulfilled", value }), error => resolve({ state: "rejected", error })));
}

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "analytical-serial-lifetime-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("capacity callers retain their full result while the private successful tail is result-free", async t => {
  const dataDir = await temporary(t), api = observedModule("company_capacity_registry.cjs");
  const inventory = { payload: "saved-body".repeat(128 * 1024) };
  const registry = api.createCompanyCapacityRegistry({ dataDir, observedCapacity: () => 16, reviewedCapacity: () => null });
  const task = registry.prepareCompanies({ a: { companyId: "a", inventory } }, { shareReadOnlyInventory: true });
  const tail = api.tail(task), result = await settlement(task);
  assert.equal(result.state, "fulfilled", result.error?.stack); assert.equal(result.value.a.inventory, inventory);
  assert.equal(result.value.a._integratedCapacity.capacity, 16);
  assert.deepEqual(await settlement(tail), { state: "fulfilled", value: undefined });
});

test("capacity serialization preserves FIFO and caller errors while every private tail resolves undefined", async t => {
  const dataDir = await temporary(t), api = observedModule("company_capacity_registry.cjs"), error = Error("fixture failure");
  let release, entered = false;
  const gate = new NativePromise(resolve => { release = resolve; }), order = [];
  const registry = api.createCompanyCapacityRegistry({ dataDir, observedCapacity: company => { order.push(company.companyId); return 10; }, reviewedCapacity: () => null });
  const first = registry.prepareCompanies({ first: { companyId: "first" } }, { checkpoint: async () => {
    if (!entered) { entered = true; await gate; throw error; }
  } });
  const firstTail = api.tail(first), firstResult = settlement(first);
  const second = registry.prepareCompanies({ second: { companyId: "second" } }), secondTail = api.tail(second);
  await new NativePromise(setImmediate);
  assert.equal(entered, true); assert.deepEqual(order, [], "second preparation cannot enter while the first checkpoint is pending");
  release();
  const rejected = await firstResult;
  assert.equal(rejected.state, "rejected"); assert.equal(rejected.error, error, "same error reaches the caller");
  const result = await settlement(second);
  assert.equal(result.state, "fulfilled", result.error?.stack); assert.equal(result.value.second._integratedCapacity.capacity, 10);
  assert.deepEqual(order, ["second"]);
  assert.deepEqual(await settlement(firstTail), { state: "fulfilled", value: undefined });
  assert.deepEqual(await settlement(secondTail), { state: "fulfilled", value: undefined });
});

function catalogOptions(dataDir, overrides = {}) {
  const company = { companyId: "a", primaryName: "fixture", placeIds: ["10"],
    inventory: { latest: { payload: "saved-body".repeat(128 * 1024), productSnapshot: { daily: [] } } } };
  return { dataDir, readRevision: async () => "r1",
    projectCapacityCompany: require("./lib/monthly_company_source_catalog.cjs").compactMonthlyCapacityCompany,
    loadFullCatalog: async () => ({ companies: [{ companyId: "a" }], regions: [], runs: [], rawCompanies: new Map([["a", company]]) }), ...overrides };
}

test("source catalog callers receive the complete selected body while its serialization tail retains no clone", async t => {
  const dataDir = await temporary(t), api = observedModule("monthly_company_source_catalog.cjs");
  const catalog = api.createMonthlyCompanySourceCatalog(catalogOptions(dataDir));
  const task = catalog.readCompanyCatalog("a"), tail = api.tail(task), result = await settlement(task);
  assert.equal(result.state, "fulfilled", result.error?.stack); assert.equal(result.value.rawCompanies.get("a").inventory.latest.payload.length, "saved-body".length * 128 * 1024);
  assert.deepEqual(await settlement(tail), { state: "fulfilled", value: undefined });
  const next = catalog.readCompanyCatalog("a"), nextTail = api.tail(next), nextResult = await settlement(next);
  assert.equal(nextResult.state, "fulfilled"); assert.notEqual(nextResult.value, result.value, "independent caller clone contract remains");
  assert.deepEqual(await settlement(nextTail), { state: "fulfilled", value: undefined });
});

test("source catalog failure releases the queue without replacing the caller's error", async t => {
  const dataDir = await temporary(t), api = observedModule("monthly_company_source_catalog.cjs"), error = Error("catalog fixture failure");
  let release, scans = 0, fullReads = 0;
  const gate = new NativePromise(resolve => { release = resolve; });
  const options = catalogOptions(dataDir), originalLoad = options.loadFullCatalog;
  const catalog = api.createMonthlyCompanySourceCatalog({ ...options,
    readRevision: async () => { if (++scans === 1) await gate; return "r1"; },
    loadFullCatalog: async () => { if (++fullReads === 1) throw error; return originalLoad(); } });
  const first = catalog.readCompanyCatalog("a"), firstTail = api.tail(first), firstResult = settlement(first);
  const second = catalog.readCompanyCatalog("a"), secondTail = api.tail(second);
  await new NativePromise(setImmediate);
  assert.equal(scans, 1); assert.equal(fullReads, 0, "second catalog operation cannot pass the blocked first operation");
  release();
  const rejected = await firstResult;
  assert.equal(rejected.state, "rejected"); assert.equal(rejected.error, error);
  assert.equal((await settlement(second)).state, "fulfilled"); assert.equal(fullReads, 2);
  assert.deepEqual(await settlement(firstTail), { state: "fulfilled", value: undefined });
  assert.deepEqual(await settlement(secondTail), { state: "fulfilled", value: undefined });
});

test("the lifetime check distinguishes the prior catch-only successful retention", async t => {
  for (const name of ["company_capacity_registry.cjs", "monthly_company_source_catalog.cjs"]) {
    const dataDir = await temporary(t), api = observedModule(name, true);
    const task = name === "company_capacity_registry.cjs"
      ? api.createCompanyCapacityRegistry({ dataDir, observedCapacity: () => 16, reviewedCapacity: () => null }).prepareCompanies({ a: { companyId: "a" } })
      : api.createMonthlyCompanySourceCatalog(catalogOptions(dataDir)).readCompanyCatalog("a");
    const tail = api.tail(task), caller = await settlement(task), retained = await settlement(tail);
    assert.equal(caller.state, "fulfilled"); assert.equal(retained.state, "fulfilled");
    assert.equal(retained.value, caller.value, "old private tail carries the same full result; the current tests require undefined instead");
  }
});
