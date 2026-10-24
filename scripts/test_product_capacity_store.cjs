"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createProductCapacityStore } = require("./lib/product_capacity_store.cjs");
const { productCapacityBaselineAt } = require("./lib/product_capacity_baseline.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-capacity-store-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "product-capacity-store-")); await fs.rm(root, { recursive: true, force: true }); });
  const original = path.join(root, "outputs/run1/manifest.json"); await fs.mkdir(path.dirname(original), { recursive: true }); await fs.writeFile(original, '{"quality":"complete"}');
  const company = { companyId: "company-a", manualCorrection: null }, companies = new Map([[company.companyId, company]]);
  const evidence = [{ companyId: company.companyId, productId: "room1", productType: "lodging", count: 14, collectedAt: "2026-09-01T00:00:00.000Z", sourceDate: "2026-09-05", runId: "run1", source: "normal_saved_product_response" }];
  const store = createProductCapacityStore({ dataDir: root }); let validations = 0;
  const context = { companies, sourceRevision: "verified-source-one", assertCurrent: async () => { validations++; } };
  return { root, original, company, evidence, store, context, validations: () => validations };
}
test("verified compact product witnesses survive restart without modifying original observations", async t => {
  const f = await fixture(t), before = await fs.readFile(f.original);
  assert.deepEqual(await f.store.read(f.company), { evidence: [], warning: null });
  assert.deepEqual(await f.store.publish(f.evidence, f.context), { companies: 1 });
  assert.ok(f.validations() >= 2, "both source-descriptor acquisition and final publication retain a current-source boundary");
  const next = createProductCapacityStore({ dataDir: f.root });
  assert.deepEqual((await next.read(f.company)).evidence, f.evidence);
  assert.deepEqual(await fs.readFile(f.original), before);
});
test("another company's file, corrupt checksum and changed source are warnings instead of false zero evidence", async t => {
  const f = await fixture(t); await f.store.publish(f.evidence, f.context);
  assert.deepEqual((await f.store.read({ companyId: "company-b" })).evidence, []);
  await fs.writeFile(f.original, '{"quality":"changed!"}');
  const changed = await f.store.read(f.company);
  assert.equal(changed.warning.code, "PRODUCT_CAPACITY_SOURCE_CHANGED"); assert.deepEqual(changed.evidence, []);
  const [name] = await fs.readdir(f.store.directory), file = path.join(f.store.directory, name);
  const value = JSON.parse(await fs.readFile(file)); value.evidence[0].count = 90; await fs.writeFile(file, JSON.stringify(value));
  const corrupt = await f.store.read(f.company);
  assert.equal(corrupt.warning.code, "PRODUCT_CAPACITY_CACHE_INVALID"); assert.deepEqual(corrupt.evidence, []);
});
test("review changes invalidate old normalized product quantities while an observed integrated total is not treated as a DB correction", async t => {
  const f = await fixture(t); await f.store.publish(f.evidence, f.context);
  const reviewed = { ...f.company, manualCorrection: { lodgingBasisTotal: 10 } };
  assert.equal((await f.store.read(reviewed)).warning.code, "PRODUCT_CAPACITY_CACHE_INVALID");
  const prepared = { ...f.company, manualCorrection: { lodgingBasisTotal: 14, source: "integrated_observed_basis" } };
  assert.deepEqual((await f.store.read(prepared)).evidence, f.evidence);
});
test("a failed source validation cannot replace an existing normal witness file", async t => {
  const f = await fixture(t); await f.store.publish(f.evidence, f.context);
  const [name] = await fs.readdir(f.store.directory), file = path.join(f.store.directory, name), before = await fs.readFile(file);
  let validations = 0;
  await assert.rejects(f.store.publish([{ ...f.evidence[0], count: 15 }], { ...f.context, assertCurrent: async () => {
    if (++validations > 1) throw Object.assign(new Error("changed"), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  } }), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readdir(f.store.directory), [name]);
});
test("foreign company witnesses and oversized evidence cannot be published", async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.publish([{ ...f.evidence[0], companyId: "company-b" }], f.context));
  const store = createProductCapacityStore({ dataDir: f.root, maxEvidence: 0 });
  await assert.rejects(store.publish(f.evidence, f.context));
});
test("revisiting September preserves an already verified October increase without leaking it into September", async t => {
  const f = await fixture(t), future = { ...f.evidence[0], count: 16, collectedAt: "2026-10-01T00:00:00.000Z" };
  await f.store.publish([future], { ...f.context, sourceRevision: "october" });
  await f.store.publish(f.evidence, { ...f.context, sourceRevision: "september" });
  const saved = await f.store.read(f.company);
  assert.deepEqual(saved.evidence.map(row => [row.collectedAt, row.count]), [[f.evidence[0].collectedAt, 14], [future.collectedAt, 16]]);
  assert.equal(productCapacityBaselineAt(saved.evidence, f.company.companyId, "2026-09-30T23:00:00Z").lodgingProducts.room1.count, 14);
  assert.equal(productCapacityBaselineAt(saved.evidence, f.company.companyId, "2026-10-02T00:00:00Z").lodgingProducts.room1.count, 16);
});
