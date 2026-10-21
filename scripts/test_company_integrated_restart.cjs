"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const previousMonth = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);

async function fixture(t, { ids = ["company_a", "company_b"], months = ["2026-08", "2026-09"], now = "2026-10-17T00:00:00Z" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-integrated-restart-")), instances = new Set();
  const state = { now: new Date(now), reads: [], revisions: [], revisionFailure: "", beforeReturn: null, omitTargets: new Set() };
  const companies = ids.map(companyId => ({ companyId, primaryName: companyId, capacity: 16, capacitySource: "DB 검수값" }));
  const raw = new Map(ids.map(companyId => [companyId, { companyId, manualCorrection: { roomCount: 16, revision: 1 }, keywords: {} }]));
  const versions = new Map(ids.map(id => [id, new Map(months.map(month => [month, 1]))]));
  const observations = ids.flatMap(companyId => months.map((month, index) => ({ companyId, companyKey: companyId,
    runId: `${companyId}_${month}`, keyword: "모의 검색", collectedAt: `${month}-01T03:00:00Z`, stayDate: `${month}-03`, productType: "lodging",
    inventoryEvidenceVersion: 4, supply: 16, sold: index + 2, publicBookings: index + 2, phoneBookings: 0,
    publicRevenue: (index + 2) * 100000, phoneRevenue: 0, estimatedRevenue: (index + 2) * 100000,
    partial: false, missing: false, unknownUnavailable: 0, phoneMissingPriceBookings: 0, sharedDayUseExcluded: 0,
    capacityBasis: { count: 16, source: "manual_review" } })));
  const runs = observations.map(row => ({ id: row.runId, keyword: row.keyword, collectedAt: row.collectedAt, collectionQuality: { status: "complete" } }));
  const active = id => !raw.get(id)?.deletedAt && !raw.get(id)?.mergedIntoCompanyId;
  const readRevision = async scope => {
    state.revisions.push(clone(scope));
    if (state.revisionFailure === "null") return null;
    if (state.revisionFailure === "throw") throw Object.assign(new Error("Do not expose a private revision path"), { code: "EACCES" });
    return digest(JSON.stringify([scope.companyId, scope.month, versions.get(scope.companyId)?.get(scope.month) || 0,
      versions.get(scope.companyId)?.get(previousMonth(scope.month)) || 0, scope.calculationVersion]));
  };
  const options = {
    dataDir: root, autoStart: false, now: () => state.now, readRevision,
    catalog: async () => ({ companies: clone(companies), rawCompanies: new Map([...raw].map(([id, value]) => [id, clone(value)])), runs: clone(runs) }),
    listTargets: async ({ companyIds } = {}) => ids.filter(id => active(id) && !state.omitTargets.has(id) && (!companyIds || companyIds.includes(id)))
      .map(companyId => ({ companyId, months: [...months] })),
    loadSources: async (request, scheduling = {}) => {
      state.reads.push({ companyId: request.targetId, month: request.month, cutoffDate: request.cutoffDate, priority: scheduling.priority });
      const value = clone({ companies, runs, observations, rankObservations: [], sourceDiagnostics: {}, context: { sources: [], networkAttempted: false } });
      if (state.beforeReturn) await state.beforeReturn(request, value);
      return value;
    }
  };
  const make = (overrides = {}) => { const db = createCompanyIntegratedDb({ ...options, ...overrides }); instances.add(db); return db; };
  const directory = id => path.join(root, "company_integrated", digest(id));
  const monthFile = (id, month) => path.join(directory(id), `${month}.json`);
  const readMonth = async (id, month) => JSON.parse(await fs.readFile(monthFile(id, month), "utf8"));
  const capture = async id => Object.fromEntries(await Promise.all(["index.json", ...months.map(month => `${month}.json`)].map(async name => {
    const file = path.join(directory(id), name), bytes = await fs.readFile(file), stat = await fs.stat(file, { bigint: true });
    return [name, { bytes: bytes.toString("utf8"), mtimeNs: stat.mtimeNs.toString(), ino: stat.ino.toString() }];
  })));
  const bump = (id, month) => versions.get(id).set(month, (versions.get(id).get(month) || 0) + 1);
  const setSold = (id, month, sold) => {
    const row = observations.find(row => row.companyId === id && row.stayDate.startsWith(month)); assert.ok(row);
    row.sold = row.publicBookings = sold; row.publicRevenue = row.estimatedRevenue = sold * 100000;
  };
  const seed = async () => { const db = make(); await db.bootstrap(); await db.drain(); return db; };
  t.after(async () => {
    for (const db of instances) await db.stop();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert.ok(path.basename(resolved).startsWith("company-integrated-restart-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, ids, months, state, companies, raw, observations, options, make, seed, monthFile, readMonth, capture, bump, setSold };
}

test("unchanged closed months survive restart with zero observation reads; a changed company alone is recalculated", async t => {
  const f = await fixture(t); let db = await f.seed();
  const beforeA = await f.capture("company_a"), beforeB = await f.capture("company_b");
  const generation = (await db.status()).jobs.find(job => job.companyId === "company_a").generation;
  await db.stop(); f.state.reads.length = 0; f.state.now = new Date("2026-10-18T00:00:00Z");
  db = f.make(); await db.bootstrap(); await db.drain();
  assert.deepEqual(f.state.reads, [], "restart must not reload the unchanged current or comparison observations");
  assert.deepEqual(await f.capture("company_a"), beforeA); assert.deepEqual(await f.capture("company_b"), beforeB);
  assert.equal((await db.status()).jobs.find(job => job.companyId === "company_a").generation, generation);
  f.bump("company_b", "2026-09"); f.setSold("company_b", "2026-09", 7);
  await db.bootstrap(); await db.drain();
  assert.deepEqual(f.state.reads.map(row => [row.companyId, row.month]), [["company_b", "2026-09"], ["company_b", "2026-08"]]);
  assert.deepEqual(await f.capture("company_a"), beforeA, "an unrelated company's observations cannot rewrite this company");
  assert.equal((await db.get("company_b", { month: "2026-09" })).snapshot.summary.lodging.sold, 7);
  assert.equal(typeof (await f.readMonth("company_b", "2026-09")).sourceRevision, "string");
});

test("a prior-month source change updates the cached following-month comparison even when its own observations did not change", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed();
  const before = await f.readMonth("company_a", "2026-09");
  assert.equal(before.snapshot.summary.lodging.sold, 3); assert.equal(before.snapshot.comparison.all.previous.sold, 2);
  f.bump("company_a", "2026-08"); f.setSold("company_a", "2026-08", 8); f.state.reads.length = 0;
  await db.bootstrap(); await db.drain();
  const after = await f.readMonth("company_a", "2026-09");
  assert.equal(after.snapshot.summary.lodging.sold, 3); assert.equal(after.snapshot.comparison.all.previous.sold, 8);
  assert.notEqual(after.sourceRevision, before.sourceRevision);
  assert.ok(f.state.reads.some(row => row.month === "2026-09"));
});

test("selected room-review metadata invalidates reuse even if the supplied source token did not change", async t => {
  const f = await fixture(t); const db = await f.seed(), beforeA = await f.readMonth("company_a", "2026-09"), beforeB = await f.capture("company_b");
  f.raw.get("company_a").manualCorrection.revision++; f.state.reads.length = 0;
  await db.bootstrap(); await db.drain();
  const afterA = await f.readMonth("company_a", "2026-09");
  assert.equal(afterA.sourceRevision, beforeA.sourceRevision, "fixture deliberately omits room correction from the source token");
  assert.notEqual(afterA.sourceDigest, beforeA.sourceDigest, "the core independently binds selected room-review metadata");
  assert.ok(f.state.reads.some(row => row.companyId === "company_a"));
  assert.ok(f.state.reads.every(row => row.companyId === "company_a")); assert.deepEqual(await f.capture("company_b"), beforeB);
});

test("a changed calculation version cannot reuse an otherwise unchanged persisted month", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const old = await f.seed(); await old.stop(); f.state.reads.length = 0;
  const db = f.make({ calculationVersion: "company-integrated-restart-test-v2" }); await db.bootstrap(); await db.drain();
  const stored = await f.readMonth("company_a", "2026-09");
  assert.equal(stored.calculationVersion, "company-integrated-restart-test-v2"); assert.ok(f.state.reads.length > 0);
});

test("an input-equivalent revision transition preserves monthly bytes and timestamps, then restarts without observation reads", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); let db = await f.seed();
  const before = await f.capture("company_a"), original = await f.readMonth("company_a", "2026-09");
  f.state.now = new Date("2026-10-18T00:00:00Z"); f.bump("company_a", "2026-09"); f.state.reads.length = 0;
  await db.bootstrap(); await db.drain();
  assert.deepEqual(f.state.reads.map(row => row.month), ["2026-09", "2026-08"], "equivalence requires both full source inputs to be read once");
  assert.deepEqual(await f.capture("company_a"), before, "an equivalent input digest cannot rewrite the normal month or its index");
  const proofFile = f.monthFile("company_a", "2026-09").replace(/\.json$/, ".reuse-proof.json");
  const proof = JSON.parse(await fs.readFile(proofFile, "utf8"));
  assert.equal(proof.cacheDigest, original.cacheDigest); assert.equal(proof.sourceDigest, original.sourceDigest);
  assert.equal(proof.storedSourceRevision, original.sourceRevision); assert.notEqual(proof.sourceRevision, original.sourceRevision);
  assert.equal(proof.kind, "unchanged_company_month_inputs"); assert.equal(typeof proof.proofDigest, "string");
  const proofBytes = await fs.readFile(proofFile, "utf8"), proofStat = await fs.stat(proofFile, { bigint: true });
  await db.stop(); f.state.reads.length = 0; db = f.make();
  const result = await db.bootstrap(); await db.drain();
  assert.equal(result.reused, 2); assert.equal(result.refreshedMonths, 0); assert.deepEqual(f.state.reads, []);
  assert.deepEqual(await f.capture("company_a"), before);
  assert.equal(await fs.readFile(proofFile, "utf8"), proofBytes); assert.equal((await fs.stat(proofFile, { bigint: true })).mtimeNs, proofStat.mtimeNs);
  const view = await db.get("company_a", { month: "2026-09" });
  assert.equal(view.status, "ready"); assert.equal(view.selectedMonth, "2026-09");
  assert.equal(view.calculatedAt, original.calculatedAt); assert.equal(view.snapshot.summary.lodging.sold, 3);
});

for (const olderEngine of ["numeric", "quality", "comparison"]) test(`an ${olderEngine} calculation behavior change cannot borrow an unchanged-input proof at the same version label`, async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed(), file = f.monthFile("company_a", "2026-09");
  const older = await f.readMonth("company_a", "2026-09"), version = older.calculationVersion, inputDigest = older.sourceDigest;
  // Simulate a previously valid result produced by an older engine. Its cache
  // integrity is correct; the current source inputs and public version label
  // are deliberately identical, so neither alone proves output compatibility.
  if (olderEngine === "numeric") older.snapshot.summary.lodging.sold = 8;
  else if (olderEngine === "quality") older.snapshot.quality.warnings.push("An older engine used a different quality rule");
  else older.snapshot.comparison.all.previous.sold = 8;
  delete older.cacheDigest;
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  older.cacheDigest = digest(JSON.stringify(stable(older))); await fs.writeFile(file, JSON.stringify(older));
  f.state.now = new Date("2026-10-18T00:00:00Z"); f.bump("company_a", "2026-09"); f.state.reads.length = 0;
  await db.bootstrap(); await db.drain();
  const actual = await f.readMonth("company_a", "2026-09");
  assert.equal(actual.calculationVersion, version); assert.equal(actual.sourceDigest, inputDigest);
  assert.equal(actual.snapshot.summary.lodging.sold, 3); assert.equal(actual.snapshot.comparison.all.previous.sold, 2);
  assert.ok(!actual.snapshot.quality.warnings.includes("An older engine used a different quality rule"));
  assert.notEqual(actual.cacheDigest, older.cacheDigest); assert.notEqual(actual.calculatedAt, older.calculatedAt);
  assert.deepEqual(f.state.reads.map(row => row.month), ["2026-09", "2026-08"]);
  await assert.rejects(fs.stat(file.replace(/\.json$/, ".reuse-proof.json")), error => error.code === "ENOENT");
});

test("an equivalence proof cannot hide changed source inputs or certify a later source revision", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed();
  f.bump("company_a", "2026-09"); await db.bootstrap(); await db.drain();
  const proofFile = f.monthFile("company_a", "2026-09").replace(/\.json$/, ".reuse-proof.json"), proof = await fs.readFile(proofFile, "utf8");
  const before = await f.readMonth("company_a", "2026-09"); f.bump("company_a", "2026-09"); f.setSold("company_a", "2026-09", 9); f.state.reads.length = 0;
  await db.bootstrap(); await db.drain();
  const after = await f.readMonth("company_a", "2026-09");
  assert.equal(after.snapshot.summary.lodging.sold, 9); assert.notEqual(after.sourceDigest, before.sourceDigest);
  assert.notEqual(after.cacheDigest, before.cacheDigest); assert.deepEqual(f.state.reads.map(row => row.month), ["2026-09", "2026-08"]);
  assert.equal(await fs.readFile(proofFile, "utf8"), proof, "an old proof is bounded and harmless; it does not modify the new result");
  f.state.reads.length = 0; await db.bootstrap(); await db.drain(); assert.deepEqual(f.state.reads, []);
});

for (const damage of ["invalid_json", "checksum", "foreign_company"]) test(`a ${damage} reuse proof is ignored and inputs are independently checked again`, async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed();
  f.bump("company_a", "2026-09"); await db.bootstrap(); await db.drain();
  const before = await f.capture("company_a"), proofFile = f.monthFile("company_a", "2026-09").replace(/\.json$/, ".reuse-proof.json");
  const proof = JSON.parse(await fs.readFile(proofFile, "utf8"));
  if (damage === "invalid_json") await fs.writeFile(proofFile, "{");
  else {
    if (damage === "checksum") proof.proofDigest = "broken";
    else {
      proof.companyId = "another_company"; delete proof.proofDigest;
      const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
      proof.proofDigest = digest(JSON.stringify(stable(proof)));
    }
    await fs.writeFile(proofFile, JSON.stringify(proof));
  }
  f.state.reads.length = 0; await db.bootstrap(); await db.drain();
  assert.deepEqual(f.state.reads.map(row => row.month), ["2026-09", "2026-08"]);
  assert.deepEqual(await f.capture("company_a"), before); assert.equal((await db.get("company_a", { month: "2026-09" })).status, "ready");
});

test("a changed or corrupt cached result cannot borrow an existing proof's source certification", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed();
  f.bump("company_a", "2026-09"); await db.bootstrap(); await db.drain();
  const file = f.monthFile("company_a", "2026-09"), damaged = await f.readMonth("company_a", "2026-09");
  damaged.snapshot.summary.lodging.sold = 999; await fs.writeFile(file, JSON.stringify(damaged));
  f.state.reads.length = 0; await db.bootstrap(); await db.drain();
  assert.deepEqual(f.state.reads.map(row => row.month), ["2026-09", "2026-08"]);
  assert.equal((await db.get("company_a", { month: "2026-09" })).snapshot.summary.lodging.sold, 3);
});

test("a revision change after equivalent source reads cannot publish a reuse proof", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed(), before = await f.capture("company_a");
  f.bump("company_a", "2026-09"); f.state.beforeReturn = async request => {
    if (request.month === "2026-08") { f.state.beforeReturn = null; f.bump("company_a", "2026-09"); }
  };
  await db.queueCompany("company_a", { months: ["2026-09"], reason: "proof_source_race" }); await db.drain();
  assert.equal((await db.get("company_a", { month: "2026-09" })).errorCode, "COMPANY_INTEGRATION_SOURCE_CHANGED");
  assert.deepEqual(await f.capture("company_a"), before);
  await assert.rejects(fs.stat(f.monthFile("company_a", "2026-09").replace(/\.json$/, ".reuse-proof.json")), error => error.code === "ENOENT");
});

test("a superseded generation cannot publish an equivalent-input reuse proof", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed(), before = await f.capture("company_a");
  f.bump("company_a", "2026-09");
  let entered, release, selectedReads = 0;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.state.beforeReturn = async request => {
    if (request.month !== "2026-09") return;
    if (++selectedReads === 1) { entered(); await gate; }
    else throw Object.assign(new Error("The newer generation is deliberately stopped before its source inspection completes"), { code: "TEST_NEW_GENERATION_STOPPED" });
  };
  await db.queueCompany("company_a", { months: ["2026-09"], reason: "old_generation" }); const running = db.drain();
  try { await started; await db.queueCompany("company_a", { months: ["2026-09"], reason: "new_generation" }); }
  finally { release(); await running; }
  assert.equal((await db.get("company_a", { month: "2026-09" })).errorCode, "TEST_NEW_GENERATION_STOPPED");
  assert.deepEqual(await f.capture("company_a"), before);
  await assert.rejects(fs.stat(f.monthFile("company_a", "2026-09").replace(/\.json$/, ".reuse-proof.json")), error => error.code === "ENOENT");
});

test("KST day advancement invalidates only the open month and keeps completed months untouched", async t => {
  const f = await fixture(t, { ids: ["company_a"], months: ["2026-09", "2026-10"], now: "2026-10-17T14:59:59Z" });
  const old = await f.seed(), september = await fs.readFile(f.monthFile("company_a", "2026-09"), "utf8"); await old.stop();
  f.state.now = new Date("2026-10-17T15:00:00Z"); f.state.reads.length = 0;
  const db = f.make(); await db.bootstrap(); await db.drain();
  assert.deepEqual(f.state.reads.map(row => row.month), ["2026-10", "2026-09"]);
  assert.equal(await fs.readFile(f.monthFile("company_a", "2026-09"), "utf8"), september);
  const stored = await f.readMonth("company_a", "2026-10"); assert.equal(stored.cutoffDate, "2026-10-18");
  assert.equal(stored.snapshot.period.monthClosed, false);
});

test("the last-day cutoff is refreshed once when the month becomes closed, even though its date string is unchanged", async t => {
  const f = await fixture(t, { ids: ["company_a"], months: ["2026-09"], now: "2026-09-30T14:59:59Z" });
  const old = await f.seed(), before = await f.readMonth("company_a", "2026-09"); await old.stop();
  assert.equal(before.cutoffDate, "2026-09-30"); assert.equal(before.snapshot.period.monthClosed, false);
  f.state.now = new Date("2026-09-30T15:00:00Z"); f.state.reads.length = 0;
  const db = f.make(); await db.bootstrap(); await db.drain(); const after = await f.readMonth("company_a", "2026-09");
  assert.equal(after.cutoffDate, before.cutoffDate); assert.equal(after.snapshot.period.monthClosed, true);
  assert.deepEqual(f.state.reads.map(row => row.month), ["2026-09", "2026-08"]);
  f.state.reads.length = 0; await db.bootstrap(); await db.drain(); assert.deepEqual(f.state.reads, []);
});

for (const failure of ["null", "throw"]) test(`an unavailable ${failure} revision preserves the last normal month and exposes only the safe code`, async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed(), before = await f.capture("company_a");
  f.state.revisionFailure = failure; f.state.reads.length = 0;
  await db.queueCompany("company_a", { months: ["2026-09"], reason: "revision_error_test" }); await db.drain();
  const view = await db.get("company_a", { month: "2026-09" });
  assert.equal(view.status, "failed"); assert.equal(view.errorCode, "COMPANY_INTEGRATION_REVISION_UNAVAILABLE");
  assert.equal(view.snapshot.summary.lodging.sold, 3); assert.deepEqual(await f.capture("company_a"), before);
  assert.deepEqual(f.state.reads, []); assert.ok(!JSON.stringify(view).includes("private revision path"));
});

test("a revision changing during source reads cannot publish mixed data or loop automatically; explicit retry publishes the latest data", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed(), before = await fs.readFile(f.monthFile("company_a", "2026-09"), "utf8");
  f.bump("company_a", "2026-09"); f.setSold("company_a", "2026-09", 4); f.state.reads.length = 0;
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.state.beforeReturn = async request => { if (request.month === "2026-09") { f.state.beforeReturn = null; entered(); await gate; } };
  await db.queueCompany("company_a", { months: ["2026-09"], reason: "race_fixture" }); const running = db.drain();
  try { await started; f.bump("company_a", "2026-09"); f.setSold("company_a", "2026-09", 5); }
  finally { release(); await running; }
  const failed = await db.get("company_a", { month: "2026-09" });
  assert.equal(failed.status, "failed"); assert.equal(failed.errorCode, "COMPANY_INTEGRATION_SOURCE_CHANGED");
  assert.equal(await fs.readFile(f.monthFile("company_a", "2026-09"), "utf8"), before);
  assert.equal(failed.snapshot.summary.lodging.sold, 3); assert.equal(f.state.reads.length, 2, "a changed revision must not cause an unbounded automatic retry");
  await db.queueCompany("company_a", { months: ["2026-09"], reason: "explicit_retry" }); await db.drain();
  const recovered = await db.get("company_a", { month: "2026-09" }); assert.equal(recovered.status, "ready"); assert.equal(recovered.snapshot.summary.lodging.sold, 5);
});

test("persisted unfinished and failed work resumes after restart instead of being skipped as a reusable idle job", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); let db = await f.seed();
  const before = await f.capture("company_a");
  for (const status of ["queued", "processing", "failed"]) {
    await db.queueCompany("company_a", { months: ["2026-09"], reason: "recovery_test" }); await db.stop();
    const file = path.join(f.root, "company_integrated", "queue.json"), state = JSON.parse(await fs.readFile(file, "utf8"));
    state.jobs.company_a.status = status; state.jobs.company_a.errorCode = status === "failed" ? "COMPANY_INTEGRATION_SOURCE_CHANGED" : null;
    await fs.writeFile(file, JSON.stringify(state));
    db = f.make(); await db.bootstrap(); await db.drain();
    assert.equal((await db.status()).jobs.find(job => job.companyId === "company_a").status, "idle");
    assert.equal((await db.get("company_a", { month: "2026-09" })).status, "ready");
    assert.deepEqual(await f.capture("company_a"), before, "recovery can reuse the existing verified month without rewriting it");
  }
});

test("a missing derived month is rebuilt despite an unchanged revision, and genuine missing observations remain null", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed();
  await fs.unlink(f.monthFile("company_a", "2026-09")); f.state.reads.length = 0;
  await db.bootstrap(); await db.drain();
  assert.deepEqual(f.state.reads.map(row => row.month), ["2026-09", "2026-08"]);
  assert.equal((await db.get("company_a", { month: "2026-09" })).snapshot.summary.lodging.sold, 3);
  const removed = f.observations.findIndex(row => row.companyId === "company_a" && row.stayDate.startsWith("2026-09")); f.observations.splice(removed, 1);
  f.bump("company_a", "2026-09"); await db.bootstrap(); await db.drain();
  assert.equal((await db.get("company_a", { month: "2026-09" })).snapshot.summary.lodging.sold, null, "saved absence cannot become a normal zero reservation");
});

test("deleted and merged company identities cannot serve their prior saved month as an active company", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const db = await f.seed(), before = await f.capture("company_a");
  for (const [field, value] of [["deletedAt", "2026-10-17T03:00:00Z"], ["mergedIntoCompanyId", "company_other"]]) {
    f.raw.get("company_a")[field] = value; f.state.reads.length = 0;
    await db.bootstrap(); await db.drain();
    await assert.rejects(db.get("company_a", { month: "2026-09" }), error => error.code === "company_not_found");
    assert.deepEqual(await f.capture("company_a"), before); assert.deepEqual(f.state.reads, []);
    delete f.raw.get("company_a")[field];
  }
});

test("a structurally damaged cached snapshot is not certified reusable merely because its revision and monthClosed fields survive", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const old = await f.seed(); await old.stop();
  const file = f.monthFile("company_a", "2026-09"), damaged = await f.readMonth("company_a", "2026-09");
  damaged.snapshot = { period: { ...damaged.snapshot.period } }; await fs.writeFile(file, JSON.stringify(damaged));
  f.state.reads.length = 0; const db = f.make(); await db.bootstrap(); await db.drain();
  const result = await db.get("company_a", { month: "2026-09" });
  assert.equal(result.snapshot.summary.lodging.sold, 3); assert.ok(f.state.reads.some(row => row.month === "2026-09"));
});

test("a cached snapshot with a foreign company request is rebuilt instead of being served under the matching outer filename", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const old = await f.seed(); await old.stop();
  const file = f.monthFile("company_a", "2026-09"), damaged = await f.readMonth("company_a", "2026-09");
  damaged.snapshot.request.targetId = "another_company"; await fs.writeFile(file, JSON.stringify(damaged));
  f.state.reads.length = 0; const db = f.make(); await db.bootstrap(); await db.drain();
  const result = await db.get("company_a", { month: "2026-09" });
  assert.equal(result.snapshot.request.targetId, "company_a"); assert.ok(f.state.reads.some(row => row.month === "2026-09"));
});

test("an active company whose last discovered source disappears still checks its indexed months after restart", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const old = await f.seed(); await old.stop();
  f.observations.splice(0); f.state.omitTargets.add("company_a"); f.bump("company_a", "2026-08"); f.bump("company_a", "2026-09");
  f.state.reads.length = 0; f.state.revisions.length = 0;
  const db = f.make(); await db.bootstrap(); await db.drain();
  const result = await db.get("company_a", { month: "2026-09" });
  assert.ok(f.state.revisions.some(scope => scope.companyId === "company_a"), "discovery absence cannot bypass revision checks for already indexed active companies");
  assert.ok(result.status !== "ready" || result.snapshot.summary.lodging.sold === null,
    "a deleted final source cannot leave old sales certified as a current ready result");
});

test("a shape-valid numeric cache edit is rejected by its derived integrity marker and recovered from saved observations", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const old = await f.seed(); await old.stop();
  const file = f.monthFile("company_a", "2026-09"), damaged = await f.readMonth("company_a", "2026-09");
  assert.equal(typeof damaged.cacheDigest, "string"); damaged.snapshot.summary.lodging.sold = 999;
  await fs.writeFile(file, JSON.stringify(damaged)); f.state.reads.length = 0;
  const db = f.make(); const pending = await db.get("company_a", { month: "2026-09" });
  assert.equal(pending.snapshot, null, "a known-damaged snapshot must not be exposed before bootstrap completes");
  await db.bootstrap(); await db.drain();
  assert.equal((await db.get("company_a", { month: "2026-09" })).snapshot.summary.lodging.sold, 3);
  assert.ok(f.state.reads.some(row => row.month === "2026-09"));
});

test("a legacy month remains displayable during its one-time migration, then the next restart reuses the new markers without observation reads", async t => {
  const f = await fixture(t, { ids: ["company_a"] }); const old = await f.seed(); await old.stop();
  const file = f.monthFile("company_a", "2026-09"), legacy = await f.readMonth("company_a", "2026-09");
  delete legacy.sourceRevision; delete legacy.metadataRevision; delete legacy.cacheDigest; await fs.writeFile(file, JSON.stringify(legacy));
  f.state.reads.length = 0; let db = f.make();
  assert.equal((await db.get("company_a", { month: "2026-09" })).snapshot.summary.lodging.sold, 3);
  await db.bootstrap(); await db.drain();
  const migrated = await f.readMonth("company_a", "2026-09");
  assert.equal(typeof migrated.sourceRevision, "string"); assert.equal(typeof migrated.cacheDigest, "string");
  assert.ok(f.state.reads.some(row => row.month === "2026-09"));
  await db.stop(); f.state.reads.length = 0; db = f.make(); await db.bootstrap(); await db.drain();
  assert.deepEqual(f.state.reads, []); assert.equal((await db.get("company_a", { month: "2026-09" })).snapshot.summary.lodging.sold, 3);
});

test("an explicit successful scope recovers only that month from the current bootstrap failure generation, even with a fixed clock", async t => {
  const f = await fixture(t); const db = await f.seed();
  const fixedClock = f.state.now.toISOString();
  f.state.revisionFailure = "null";
  await assert.rejects(db.bootstrap(), error => error.code === "COMPANY_INTEGRATION_REVISION_UNAVAILABLE");
  assert.equal((await db.get("company_a", { month: "2026-09" })).status, "failed");
  f.state.revisionFailure = ""; f.bump("company_a", "2026-09"); f.setSold("company_a", "2026-09", 7);
  await db.queueCompany("company_a", { months: ["2026-09"], reason: "explicit_recovery" }); await db.drain();
  const recovered = await db.get("company_a", { month: "2026-09" });
  assert.equal(recovered.status, "ready"); assert.equal(recovered.errorCode, null); assert.equal(recovered.snapshot.summary.lodging.sold, 7);
  assert.equal((await db.get("company_a", { month: "2026-08" })).status, "failed", "another month was not independently verified after the global failure");
  assert.equal((await db.get("company_b", { month: "2026-09" })).status, "failed", "one company cannot certify another company's unverified saved month");
  f.state.revisionFailure = "throw";
  await assert.rejects(db.bootstrap(), error => error.code === "COMPANY_INTEGRATION_REVISION_UNAVAILABLE");
  assert.equal((await db.get("company_a", { month: "2026-09" })).status, "failed", "a new failure generation invalidates the earlier recovery at the same timestamp");
  f.state.revisionFailure = ""; f.bump("company_a", "2026-09"); f.setSold("company_a", "2026-09", 8);
  await db.queueCompany("company_a", { months: ["2026-09"], reason: "second_explicit_recovery" }); await db.drain();
  assert.equal((await db.get("company_a", { month: "2026-09" })).status, "ready");
  assert.equal((await db.get("company_b", { month: "2026-09" })).status, "failed");
  assert.equal(f.state.now.toISOString(), fixedClock, "all success/failure events deliberately share the same clock value");
  await db.bootstrap(); await db.drain();
  assert.equal((await db.get("company_a", { month: "2026-08" })).status, "ready");
  assert.equal((await db.get("company_b", { month: "2026-09" })).status, "ready", "a successful full bootstrap clears the global failure after checking every scope");
});
