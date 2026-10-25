"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createProductCapacityStore } = require("./lib/product_capacity_store.cjs");
const { productCapacityBaselineAt } = require("./lib/product_capacity_baseline.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { cooperativeWorkCheckpoint } = require("./lib/cooperative_work_checkpoint.cjs");
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
test("bulk witness checkpoints interrupt every company and source-file boundary without returning a warning or partial evidence", async t => {
  const f = await fixture(t), other = { ...f.company, companyId: "company-b" }, companies = [f.company, other];
  const context = { ...f.context, companies: new Map(companies.map(company => [company.companyId, company])) };
  await f.store.publish([...f.evidence, { ...f.evidence[0], companyId: other.companyId }], context);
  const names = await fs.readdir(f.store.directory), originals = new Map(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(f.store.directory, name))])));
  const originalRaw = await fs.readFile(f.original); let boundaries = 0;
  const expected = await f.store.readForCompanies(companies, { checkpoint: async () => { boundaries++; } }); assert.ok(boundaries >= 10);
  for (let stop = 1; stop <= boundaries; stop++) {
    let visited = 0, returned = false;
    const interrupted = Object.assign(Error("checkpoint"), { code: "ANALYTICAL_WORK_YIELDED" });
    await assert.rejects((async () => { const value = await f.store.readForCompanies(companies, { checkpoint: async () => { if (++visited === stop) throw interrupted; } }); returned = true; return value; })(), error => error === interrupted);
    assert.equal(returned, false, "an interrupted optional store cannot return empty normal evidence or a cache warning");
    assert.deepEqual(await f.store.readForCompanies(companies), expected, "a new read starts with fresh source descriptors");
  }
  for (const name of names) assert.deepEqual(await fs.readFile(path.join(f.store.directory, name)), originals.get(name));
  assert.deepEqual(await fs.readFile(f.original), originalRaw);
  await assert.rejects(f.store.readForCompanies(companies, { checkpoint: null }), TypeError);
});
test("publication can stop during preparation without creating a witness or temporary file and retry completes normally", async t => {
  const f = await fixture(t), other = { ...f.company, companyId: "company-b" }, evidence = [...f.evidence, { ...f.evidence[0], companyId: other.companyId }];
  const context = { ...f.context, companies: new Map([[f.company.companyId, f.company], [other.companyId, other]]) };
  const original = await fs.readFile(f.original), interrupted = Object.assign(Error("yield"), { code: "ANALYTICAL_WORK_YIELDED" }); let checkpoints = 0, returned = false;
  await assert.rejects((async () => { const result = await f.store.publish(evidence, { ...context, checkpoint: async () => { if (++checkpoints === 3) throw interrupted; } }); returned = true; return result; })(), error => error === interrupted);
  assert.equal(returned, false); assert.deepEqual(await fs.readdir(f.store.directory).catch(error => { if (error.code === "ENOENT") return []; throw error; }), []);
  assert.deepEqual(await f.store.publish(evidence, context), { companies: 2 });
  assert.deepEqual((await f.store.readForCompanies([f.company, other])).evidence, evidence); assert.deepEqual(await fs.readFile(f.original), original);
  await assert.rejects(f.store.publish(evidence, { ...context, checkpoint: null }), TypeError);
});
test("publication interruption between commits retains only independently valid complete witnesses and no temporary files", async t => {
  const f = await fixture(t), other = { ...f.company, companyId: "company-b" }, companies = [f.company, other];
  const evidence = [...f.evidence, { ...f.evidence[0], companyId: other.companyId }], context = { ...f.context, companies: new Map(companies.map(company => [company.companyId, company])) };
  const original = await fs.readFile(f.original), interrupted = Object.assign(Error("yield"), { code: "ANALYTICAL_WORK_YIELDED" }); let returned = false;
  await assert.rejects((async () => { const result = await f.store.publish(evidence, { ...context, checkpoint: async () => {
    const names = await fs.readdir(f.store.directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    assert.equal(names.some(name => name.endsWith(".tmp")), false, "checkpoint occurs outside the atomic file write");
    if (names.length === 1) throw interrupted;
  } }); returned = true; return result; })(), error => error === interrupted);
  assert.equal(returned, false); const names = await fs.readdir(f.store.directory); assert.equal(names.length, 1); assert.match(names[0], /^[a-f0-9]{64}\.json$/);
  const body = JSON.parse(await fs.readFile(path.join(f.store.directory, names[0]))), company = companies.find(value => value.companyId === body.companyId);
  assert.ok(company); const saved = await f.store.read(company); assert.equal(saved.warning, null); assert.deepEqual(saved.evidence, evidence.filter(row => row.companyId === company.companyId));
  const completedFile = path.join(f.store.directory, names[0]); await fs.utimes(completedFile, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
  const completedBefore = await fs.stat(completedFile), completedBytes = await fs.readFile(completedFile); let retryValidations = 0;
  assert.deepEqual(await f.store.publish(evidence, { ...context, assertCurrent: async () => { retryValidations++; } }), { companies: 2 });
  assert.equal(retryValidations, 2, "retry validates the source globally and writes only the remaining witness");
  assert.equal((await fs.stat(completedFile)).mtimeMs, completedBefore.mtimeMs, "an already verified identical witness must not be rewritten on retry");
  assert.deepEqual(await fs.readFile(completedFile), completedBytes); assert.deepEqual((await f.store.readForCompanies(companies)).evidence, evidence);
  assert.equal((await fs.readdir(f.store.directory)).some(name => name.endsWith(".tmp")), false); assert.deepEqual(await fs.readFile(f.original), original);
});
test("an industry publication finishes the current atomic witness before yielding to a foreground reader", async t => {
  const f = await fixture(t), other = { ...f.company, companyId: "company-b" }, companies = [f.company, other];
  const evidence = [...f.evidence, { ...f.evidence[0], companyId: other.companyId }], scheduler = createAnalyticalWorkScheduler({ cooperativeYield: true, cooperativeMinRunMs: 0 });
  t.after(() => scheduler.close());
  let validations = 0, foreground, attempts = 0; const trace = [];
  const context = { ...f.context, companies: new Map(companies.map(company => [company.companyId, company])), checkpoint: async () => { cooperativeWorkCheckpoint(); }, assertCurrent: async () => {
    if (++validations === 2) {
      foreground = scheduler.run(async () => {
        const names = await fs.readdir(f.store.directory); assert.equal(names.some(name => name.endsWith(".tmp")), false); assert.equal(names.length, 1);
        assert.equal((await f.store.read(f.company)).warning, null); trace.push("foreground");
      }, { kind: "insight-company-view", detached: true });
      cooperativeWorkCheckpoint();
      trace.push("first-commit-validated");
    }
  } };
  const result = await scheduler.run(async () => { attempts++; return f.store.publish(evidence, context); }, { priority: "background", kind: "industry-build" });
  await foreground;
  assert.deepEqual(result, { companies: 2 }); assert.equal(attempts, 2); assert.deepEqual(trace, ["first-commit-validated", "foreground"]);
  assert.equal(scheduler.status().timing.yielded, 1); assert.equal(scheduler.status().timing.failed, 0);
  assert.deepEqual((await f.store.readForCompanies(companies)).evidence, evidence);
});
test("only exact verified witness bodies skip replacement; source and review revisions still rebuild", async t => {
  const f = await fixture(t); await f.store.publish(f.evidence, f.context);
  const [name] = await fs.readdir(f.store.directory), file = path.join(f.store.directory, name);
  await fs.utimes(file, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
  const original = await fs.readFile(file), oldTime = (await fs.stat(file)).mtimeMs; let validations = 0;
  assert.deepEqual(await f.store.publish(f.evidence, { ...f.context, assertCurrent: async () => { validations++; } }), { companies: 1 });
  assert.equal(validations, 1, "even a completely unchanged publication retains its final current-source assertion");
  assert.equal((await fs.stat(file)).mtimeMs, oldTime); assert.deepEqual(await fs.readFile(file), original);
  await f.store.publish(f.evidence, { ...f.context, sourceRevision: "verified-source-two" });
  assert.equal(JSON.parse(await fs.readFile(file)).sourceRevision, "verified-source-two"); assert.notEqual((await fs.stat(file)).mtimeMs, oldTime);
  const reviewed = { ...f.company, manualCorrection: { lodgingBasisTotal: 10 } }, reviewedRows = [{ ...f.evidence[0], count: 10 }];
  await f.store.publish(reviewedRows, { ...f.context, sourceRevision: "verified-source-two", companies: new Map([[reviewed.companyId, reviewed]]) });
  assert.deepEqual((await f.store.read(reviewed)).evidence, reviewedRows); assert.equal((await f.store.read(f.company)).warning.code, "PRODUCT_CAPACITY_CACHE_INVALID");
});
test("private unchanged-body capture is unavailable for corrupt, stale or wrong-review witness files", async t => {
  const f = await fixture(t); await f.store.publish(f.evidence, f.context); let verified = 0;
  await f.store.read(f.company, new Map(), { onVerified: () => { verified++; } }); assert.equal(verified, 1);
  await f.store.read({ ...f.company, manualCorrection: { lodgingBasisTotal: 10 } }, new Map(), { onVerified: () => { verified++; } }); assert.equal(verified, 1);
  const [name] = await fs.readdir(f.store.directory), file = path.join(f.store.directory, name), original = await fs.readFile(file);
  const value = JSON.parse(original); value.evidence[0].count = 90; await fs.writeFile(file, JSON.stringify(value));
  await f.store.read(f.company, new Map(), { onVerified: () => { verified++; } }); assert.equal(verified, 1);
  await fs.writeFile(file, original); await fs.writeFile(f.original, '{"quality":"changed!"}');
  await f.store.read(f.company, new Map(), { onVerified: () => { verified++; } }); assert.equal(verified, 1);
});
