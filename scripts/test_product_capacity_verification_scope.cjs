"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createProductCapacityStore } = require("./lib/product_capacity_store.cjs");
const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() }; };
async function fixture(t, { companyCount = 3, runCount = 4, maxVerificationDescriptors = 2048 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-proof-scope-")), originals = [];
  t.after(async () => { const target = path.resolve(root); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith("product-proof-scope-")); await fs.rm(target, { recursive: true, force: true }); });
  for (let i = 1; i <= runCount; i++) { const file = path.join(root, "outputs", `run${i}`, "manifest.json"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify({ id: `run${i}`, quality: "complete", original: i })); originals.push(file); }
  const companies = Array.from({ length: companyCount }, (_, i) => ({ companyId: `company-${i}`, manualCorrection: null }));
  const evidence = companies.flatMap(company => originals.map((_, i) => ({ companyId: company.companyId, productId: "room", productType: "lodging", count: 10 + i, collectedAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, sourceDate: "2026-09-20", runId: `run${i + 1}`, source: "normal_saved_product_response" })));
  const store = createProductCapacityStore({ dataDir: root, maxVerificationDescriptors }); let assertions = 0;
  const revision = async () => { const digest = crypto.createHash("sha256").update(JSON.stringify(companies)); for (const file of originals) digest.update(await fs.readFile(file)); return digest.digest("hex"); };
  async function boundary() { const sourceRevision = await revision(); return { sourceRevision, assertCurrent: async () => { assertions++; if (await revision() !== sourceRevision) throw Object.assign(Error("whole-source revision changed"), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" }); } }; }
  const initial = await boundary(), context = { companies: new Map(companies.map(company => [company.companyId, company])), sourceRevision: "catalog-calculation-hash-differs-from-whole-source-baseline", assertCurrent: initial.assertCurrent };
  await store.publish(evidence, context);
  const snapshots = async () => new Map(await Promise.all((await fs.readdir(store.directory)).map(async name => [name, await fs.readFile(path.join(store.directory, name))])));
  return { root, originals, companies, evidence, store, context, boundary, snapshots, assertions: () => assertions };
}

test("one active verified source shares only descriptor hashes between bulk reads and publication while rereading every witness", async t => {
  const f = await fixture(t, { companyCount: 12 }), before = f.store.stats(), original = await f.snapshots();
  await f.store.withDescriptorVerificationScope(await f.boundary(), async () => {
    const read = await f.store.readForCompanies(f.companies); assert.deepEqual(read.evidence, f.evidence); assert.deepEqual(read.warnings, []); assert.equal(f.store.stats().descriptorScans - before.descriptorScans, 4);
    await f.store.publish(f.evidence, f.context); assert.equal(f.store.stats().descriptorScans - before.descriptorScans, 4, "publication reuses hashes verified during the same current source boundary");
    assert.deepEqual((await f.store.readForCompanies(f.companies)).evidence, f.evidence); assert.equal(f.store.stats().witnessReads - before.witnessReads, 36, "scope reuse must not cache witness contents or bypass checksum/review reads");
  });
  const after = f.store.stats(); assert.equal(after.descriptorScans - before.descriptorScans, 4); assert.ok(after.descriptorProofHits - before.descriptorProofHits >= 8); assert.ok(after.verificationChecks - before.verificationChecks >= 4); assert.equal(after.activeVerificationScopes, 0); assert.equal(after.retainedVerificationDescriptors, 0); assert.deepEqual(await f.snapshots(), original);
  await f.store.readForCompanies(f.companies); assert.equal(f.store.stats().descriptorScans - after.descriptorScans, 4, "ordinary calls still freshly walk original run descriptors");
  const next = f.store.stats(); await f.store.withDescriptorVerificationScope(await f.boundary(), () => f.store.readForCompanies(f.companies)); assert.equal(f.store.stats().descriptorScans - next.descriptorScans, 4, "same revision in another source request must not inherit the previous scope's proof");
});

for (const mutation of ["original", "correction"]) test(`a ${mutation} change rejects descriptor reuse before publication and preserves normal witness files`, async t => {
  const f = await fixture(t), original = await f.snapshots();
  await assert.rejects(f.store.withDescriptorVerificationScope(await f.boundary(), async () => {
    await f.store.readForCompanies(f.companies);
    if (mutation === "original") await fs.writeFile(f.originals[0], '{"quality":"changed"}'); else f.companies[0].manualCorrection = { lodgingBasisTotal: 8 };
    await f.store.publish(f.evidence, f.context);
  }), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.deepEqual(await f.snapshots(), original); assert.equal(f.store.stats().activeVerificationScopes, 0); assert.equal(f.store.stats().retainedVerificationDescriptors, 0);
});

test("witness checksum and correction signature remain fresh inside a descriptor verification scope", async t => {
  const f = await fixture(t, { companyCount: 1 }), [name] = await fs.readdir(f.store.directory), file = path.join(f.store.directory, name), original = await fs.readFile(file);
  await f.store.withDescriptorVerificationScope(await f.boundary(), async () => {
    await f.store.readForCompanies(f.companies); const value = JSON.parse(original); value.evidence[0].count = 999; await fs.writeFile(file, JSON.stringify(value));
    const corrupt = await f.store.readForCompanies(f.companies); assert.deepEqual(corrupt.evidence, []); assert.equal(corrupt.warnings[0].code, "PRODUCT_CAPACITY_CACHE_INVALID");
    await fs.writeFile(file, original); const changedReview = [{ ...f.companies[0], manualCorrection: { lodgingBasisTotal: 8 } }];
    const mismatched = await f.store.readForCompanies(changedReview); assert.deepEqual(mismatched.evidence, []); assert.equal(mismatched.warnings[0].code, "PRODUCT_CAPACITY_CACHE_INVALID");
  });
});

test("descriptor proof storage is bounded and releases entries on success and checkpoint interruption", async t => {
  const f = await fixture(t, { companyCount: 1, maxVerificationDescriptors: 2 });
  await f.store.withDescriptorVerificationScope(await f.boundary(), async () => { await f.store.readForCompanies(f.companies); assert.equal(f.store.stats().retainedVerificationDescriptors, 2); await f.store.publish(f.evidence, f.context); assert.ok(f.store.stats().retainedVerificationDescriptors <= 2); });
  assert.equal(f.store.stats().maximumVerificationDescriptors, 2); assert.ok(f.store.stats().descriptorProofEvictions > 0); assert.equal(f.store.stats().retainedVerificationDescriptors, 0);
  const interrupted = Object.assign(Error("checkpoint"), { code: "ANALYTICAL_WORK_YIELDED" }); let calls = 0;
  await assert.rejects(f.store.withDescriptorVerificationScope(await f.boundary(), () => f.store.readForCompanies(f.companies, { checkpoint: async () => { if (++calls === 5) throw interrupted; } })), error => error === interrupted);
  assert.equal(f.store.stats().activeVerificationScopes, 0); assert.equal(f.store.stats().retainedVerificationDescriptors, 0);
  assert.deepEqual((await f.store.readForCompanies(f.companies)).evidence, f.evidence);
});

test("an escaped asynchronous child cannot retain a closed proof or hide changed originals", async t => {
  const f = await fixture(t, { companyCount: 1 }), proceed = gate(); let child;
  await f.store.withDescriptorVerificationScope(await f.boundary(), async () => { await f.store.readForCompanies(f.companies); child = proceed.promise.then(() => f.store.readForCompanies(f.companies)); });
  assert.equal(f.store.stats().retainedVerificationDescriptors, 0); const before = f.store.stats().descriptorScans; await fs.writeFile(f.originals[0], '{"quality":"changed-after-scope"}'); proceed.resolve();
  const read = await child; assert.deepEqual(read.evidence, []); assert.equal(read.warnings[0].code, "PRODUCT_CAPACITY_SOURCE_CHANGED"); assert.ok(f.store.stats().descriptorScans > before); assert.equal(f.store.stats().retainedVerificationDescriptors, 0);
});

test("a final whole-source check rejects an otherwise completed read and diagnostics reveal no scope inputs", async t => {
  const f = await fixture(t, { companyCount: 1 });
  await assert.rejects(f.store.withDescriptorVerificationScope(await f.boundary(), async () => { await f.store.readForCompanies(f.companies); await fs.writeFile(f.originals[0], '{"quality":"changed-before-return"}'); return "must not escape"; }), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.doesNotMatch(JSON.stringify(f.store.stats()), /company-|run1|catalog-calculation|sourceRevision|assertCurrent|outputs/); assert.equal(f.store.stats().activeVerificationScopes, 0); assert.equal(f.store.stats().retainedVerificationDescriptors, 0);
  for (const options of [{}, { sourceRevision: "x", assertCurrent: null }, { sourceRevision: "", assertCurrent() {} }]) await assert.rejects(f.store.withDescriptorVerificationScope(options, () => 1), TypeError);
  for (const maxVerificationDescriptors of [0, 1.5, 4097]) assert.throws(() => createProductCapacityStore({ dataDir: f.root, maxVerificationDescriptors }), TypeError);
});
