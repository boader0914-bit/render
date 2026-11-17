"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { buildKeywordMonthlyProjection, KEYWORD_MONTHLY_LIMITS } = require("./lib/keyword_monthly_analysis.cjs");
const { createKeywordMonthlyBundleAnalysis, publishKeywordMonthlyBundle, loadBundle } = require("./lib/keyword_monthly_bundle.cjs");
const NOW = "2026-10-30T00:00:00.000Z", sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); } throw Error("Synthetic parallel read did not reach its checkpoint"); }
const error = code => Object.assign(Error(code), { code });
async function fixture(t, count) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-options-parallel-")), output = path.join(root, "bundle"), inputs = [];
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("keyword-options-parallel-")); await fs.rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < count; index++) {
    const keyword = `합성글램핑${index}`, companyId = `synthetic-company-${index}`, runId = `synthetic-run-${index}`, directory = path.join(root, `input-${index}`);
    const source = { companies: [{ companyId, primaryName: `합성 업체 ${index}`, capacity: 5, capacitySource: "db_correction" }],
      runs: [{ id: runId, keyword, collectedAt: "2026-10-20T01:00:00Z", collectionQuality: { status: "complete" } }],
      observations: [{ observationId: runId, companyId, runId, keyword, productType: "lodging", stayDate: "2026-10-20", collectedAt: "2026-10-20T01:00:00Z", inventoryEvidenceVersion: 4,
        supply: 5, sold: 2, publicBookings: 2, phoneBookings: 0, publicRevenue: 200, phoneRevenue: 0, estimatedRevenue: 200,
        explicitBlockedBookings: 0, sharedDayUseExcluded: 0, phoneMissingPriceBookings: 0, partial: false, missing: false,
        dayUsePresence: "absent", dayUseSharingStatus: "not_shared", capacityBasis: { count: 5, source: "db_correction" } }],
      rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {} };
    await buildKeywordMonthlyProjection({ source, sourceFingerprint: sha(JSON.stringify(source)), outputDir: directory, materializedAt: NOW, now: () => NOW });
    inputs.push({ directory });
  }
  const published = await publishKeywordMonthlyBundle({ inputs, outputDir: output, now: NOW }), bundle = await loadBundle(output);
  return { root, output, inputs, published, bundle, indexFiles: bundle.catalog.partitions.map(part => path.join(bundle.generationDir, "partitions", part.key, "index.json")) };
}

test("options concurrency is an internal strict integer bound with a default and accepted 1/4/8 variants", () => {
  const projectionDir = path.join(os.tmpdir(), "synthetic-options-constructor-only");
  for (const optionsReadConcurrency of [0, -1, 9, 1.5, NaN, Infinity, "4", null, false, [], {}])
    assert.throws(() => createKeywordMonthlyBundleAnalysis({ projectionDir, optionsReadConcurrency }), /read concurrency/);
  for (const optionsReadConcurrency of [undefined, 1, 4, 8]) assert.ok(createKeywordMonthlyBundleAnalysis({ projectionDir, optionsReadConcurrency }));
});

test("1/4/8 and default options reads bound both passes, drain reverse completions and preserve exact metadata", { timeout: 15000 }, async t => {
  const f = await fixture(t, 9), originalPointer = await fs.readFile(path.join(f.output, "current.json")), expected = await createKeywordMonthlyBundleAnalysis({ projectionDir: f.output, now: () => NOW, optionsReadConcurrency: 1 }).options();
  for (const configured of [1, 4, 8, undefined]) {
    const concurrency = configured ?? 4, gates = new Map(), finished = [], active = { first: 0, final: 0 }, peak = { first: 0, final: 0 }; let reads = 0;
    const service = createKeywordMonthlyBundleAnalysis({ projectionDir: f.output, now: () => NOW, optionsReadConcurrency: configured,
      measure: async (phase, metadata, operation) => {
        if (phase !== "keyword_index_read") return operation();
        const ordinal = ++reads, pass = ordinal <= 9 ? "first" : "final", gate = deferred(); gates.set(ordinal, gate);
        active[pass]++; peak[pass] = Math.max(peak[pass], active[pass]);
        assert.ok(metadata.inputBytes <= KEYWORD_MONTHLY_LIMITS.indexBytes);
        try { const result = await operation(); await gate.promise; return result; }
        finally { active[pass]--; finished.push(ordinal); }
      } });
    const reading = service.options();
    for (const base of [0, 9]) for (let offset = 0; offset < 9; offset += concurrency) {
      const batch = Array.from({ length: Math.min(concurrency, 9 - offset) }, (_, index) => base + offset + index + 1);
      await until(() => batch.every(ordinal => gates.has(ordinal)));
      assert.equal(reads, batch.at(-1), "next batch never starts before this entire batch settles");
      for (const ordinal of [...batch].reverse()) { gates.get(ordinal).resolve(); await until(() => finished.includes(ordinal)); }
    }
    assert.deepEqual(await reading, expected); assert.equal(reads, 18); assert.deepEqual(active, { first: 0, final: 0 });
    assert.deepEqual(peak, { first: concurrency, final: concurrency });
    assert.deepEqual(await fs.readFile(path.join(f.output, "current.json")), originalPointer);
  }
});

test("first-pass partial failures settle their batch and preserve descriptor-ordered failure metadata", { timeout: 10000 }, async t => {
  const f = await fixture(t, 6), held = deferred(); let reads = 0, settled = false;
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: f.output, now: () => NOW, optionsReadConcurrency: 4,
    measure: async (phase, metadata, operation) => {
      if (phase !== "keyword_index_read") return operation();
      const ordinal = ++reads;
      if (ordinal === 1) throw error("KEYWORD_MONTHLY_SYNTHETIC_FIRST");
      if (ordinal === 2) await held.promise;
      if (ordinal === 3) throw error("KEYWORD_MONTHLY_SYNTHETIC_THIRD");
      return operation();
    } });
  const reading = service.options().then(value => { settled = true; return value; });
  await until(() => reads === 4); await tick(); assert.equal(settled, false); assert.equal(reads, 4);
  held.resolve(); const result = await reading;
  assert.equal(result.status, "available"); assert.deepEqual(result.bundle.unavailablePartitions, [
    { partition: f.bundle.catalog.partitions[0].key, code: "KEYWORD_MONTHLY_SYNTHETIC_FIRST" },
    { partition: f.bundle.catalog.partitions[2].key, code: "KEYWORD_MONTHLY_SYNTHETIC_THIRD" } ]);
  assert.equal(reads, 10, "six first-pass reads plus four verified successful indexes");
  for (const scope of f.bundle.catalog.scopes) assert.equal(result.keywords.find(row => row.keyword === scope.keyword).availabilityByMonth[scope.month],
    [f.bundle.catalog.partitions[0].key, f.bundle.catalog.partitions[2].key].includes(scope.partition) ? "needs_verification" : "available");
});

test("final failures drain all started reads and propagate the first descriptor error without late work", { timeout: 10000 }, async t => {
  const f = await fixture(t, 6), first = deferred(), sibling = deferred(), unhandled = []; let reads = 0, active = 0, settled = false;
  const onUnhandled = value => unhandled.push(value); process.on("unhandledRejection", onUnhandled); t.after(() => process.removeListener("unhandledRejection", onUnhandled));
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: f.output, now: () => NOW, optionsReadConcurrency: 4,
    measure: async (phase, metadata, operation) => {
      if (phase !== "keyword_index_read") return operation();
      const ordinal = ++reads; active++;
      try {
        if (ordinal === 7) { await first.promise; throw error("KEYWORD_MONTHLY_SYNTHETIC_FIRST_FINAL"); }
        if (ordinal === 8) throw error("KEYWORD_MONTHLY_SYNTHETIC_SECOND_FINAL");
        if (ordinal === 9) await sibling.promise;
        return await operation();
      } finally { active--; }
    } });
  const reading = service.options().then(value => { settled = true; return value; });
  await until(() => reads === 10); first.resolve(); await tick(); await tick();
  assert.equal(settled, false); assert.ok(active > 0); assert.equal(reads, 10, "no later final batch starts after a failed batch");
  sibling.resolve(); const result = await reading;
  assert.equal(active, 0); assert.deepEqual(result.diagnostics, ["KEYWORD_MONTHLY_SYNTHETIC_FIRST_FINAL"]); assert.equal(result.status, "needs_verification");
  await tick(); assert.deepEqual(unhandled, []);
  assert.equal((await service.options()).status, "available", "the failed flight is gone only after all of its reads drained");
});

test("parallel final verification still catches actual index tampering and a newly published pointer", { timeout: 15000 }, async t => {
  for (const change of ["index", "pointer"]) {
    const f = await fixture(t, 4), pointerFile = path.join(f.output, "current.json"), beforePointer = await fs.readFile(pointerFile), beforeIndex = await fs.readFile(f.indexFiles[0]);
    let replacement;
    if (change === "pointer") {
      await publishKeywordMonthlyBundle({ inputs: f.inputs, outputDir: f.output, now: NOW, expectedCurrentSha256: f.published.pointerSha256 });
      replacement = await fs.readFile(pointerFile); await fs.writeFile(pointerFile, beforePointer);
    }
    let reads = 0;
    const service = createKeywordMonthlyBundleAnalysis({ projectionDir: f.output, now: () => NOW, optionsReadConcurrency: 4,
      measure: async (phase, metadata, operation) => {
        if (phase === "keyword_index_read" && ++reads === 5) await fs.writeFile(change === "index" ? f.indexFiles[0] : pointerFile, change === "index" ? "{}" : replacement);
        return operation();
      } });
    const result = await service.options(); assert.equal(result.status, "needs_verification", change); assert.deepEqual(result.keywords, []);
    assert.deepEqual(result.diagnostics, ["KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"]);
    await fs.writeFile(pointerFile, beforePointer); await fs.writeFile(f.indexFiles[0], beforeIndex);
    assert.equal((await service.options()).status, "available");
  }
});

test("options parallelism does not parallelize financial reads or alter KST freshness and saved provenance", { timeout: 10000 }, async t => {
  const f = await fixture(t, 3); let at = NOW, active = 0, peak = 0;
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: f.output, now: () => at, optionsReadConcurrency: 8,
    measure: async (phase, metadata, operation) => { if (phase !== "keyword_index_read") return operation(); active++; peak = Math.max(peak, active); try { await tick(); return await operation(); } finally { active--; } } });
  const scope = f.bundle.catalog.scopes[0], result = await service.analyze({ keyword: scope.keyword, month: scope.month, cutoffDate: "2026-10-20" });
  assert.equal(result.status, "available"); assert.equal(result.snapshot.summary.lodging.sold, 2); assert.equal(peak, 1);
  const initial = await service.options(); at = "2026-11-01T00:00:00.000Z"; const stale = await service.options();
  assert.equal(stale.currentDay, "2026-11-01"); assert.equal(stale.status, "stale");
  assert.equal(stale.provenance.originalFreshnessVerified, false); assert.equal(stale.provenance.dataThrough, initial.provenance.dataThrough);
  for (const row of stale.keywords) assert.equal(row.provenanceByMonth["2026-10"].materializedAt, NOW);
});
