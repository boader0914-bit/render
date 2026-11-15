"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { buildKeywordMonthlyProjection, createKeywordMonthlyAnalysis } = require("./lib/keyword_monthly_analysis.cjs");
const { publishKeywordMonthlyBundle, createKeywordMonthlyBundleAnalysis, loadBundle } = require("./lib/keyword_monthly_bundle.cjs");
const { encodePreparedResult, decodePreparedResult, calculationFingerprint, KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS } = require("./lib/keyword_monthly_prepared_results.cjs");
const { args } = require("./build_keyword_monthly_bundle.cjs");
const { gzipSync } = require("node:zlib");
const { boundedJsonBuffer } = require("./lib/bounded_company_response.cjs");
const NOW = "2026-11-15T00:00:00.000Z", KEYWORD = "검수글램핑", QUERY = { keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-20" };
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture(sold = 3) {
  const runs = [], observations = [];
  for (const [month, count] of [["2026-09", 2], ["2026-10", sold]]) {
    const id = `r-${month}`, collectedAt = `${month}-20T01:00:00.000Z`;
    runs.push({ id, keyword: KEYWORD, collectedAt, collectionQuality: { status: "complete" } });
    observations.push({ observationId: id, companyId: "a", runId: id, keyword: KEYWORD, productType: "lodging", stayDate: `${month}-20`, collectedAt,
      inventoryEvidenceVersion: 4, supply: 5, sold: count, publicBookings: count - 1, phoneBookings: 1, publicRevenue: (count - 1) * 100, phoneRevenue: 100,
      estimatedRevenue: count * 100, sharedDayUseExcluded: 0, explicitBlockedBookings: 1, phoneMissingPriceBookings: 0, partial: false, missing: false,
      dayUsePresence: "absent", dayUseSharingStatus: "not_shared", capacityBasis: { count: 5, source: "db_correction" } });
  }
  observations.push({ ...observations[1], observationId: "missing", stayDate: "2026-10-21", missing: true, sold: null, estimatedRevenue: null });
  return { companies: [{ companyId: "a", primaryName: "가상 업체", capacity: 5, capacitySource: "db_correction" }], runs,
    observations, rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {} };
}
async function setup(t, { prepareResults = true, preparedQueries, sold = 3 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-prepared-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("keyword-prepared-")); await fs.rm(root, { recursive: true, force: true }); });
  const source = fixture(sold), projection = path.join(root, "source"), output = path.join(root, "bundle");
  await buildKeywordMonthlyProjection({ source, sourceFingerprint: sha(JSON.stringify(source)), outputDir: projection, now: () => NOW });
  const sourceIndexBefore = await fs.readFile(path.join(projection, "index.json"));
  const receipt = await publishKeywordMonthlyBundle({ inputs: [{ directory: projection }], outputDir: output, now: NOW, prepareResults, ...(preparedQueries ? { preparedQueries } : {}) });
  const bundle = await loadBundle(output), service = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW });
  return { root, source, projection, output, receipt, bundle, service, sourceIndexBefore };
}
async function rewriteCatalog(output, mutate) {
  const bundle = await loadBundle(output), catalog = bundle.catalog; await mutate(catalog, bundle);
  const bytes = Buffer.from(JSON.stringify(catalog)); await fs.writeFile(bundle.catalogRead.file, bytes);
  const pointer = { ...bundle.pointer, catalogSha256: sha(bytes), catalogBytes: bytes.length }; await fs.writeFile(path.join(output, "current.json"), JSON.stringify(pointer));
}
const resultFile = (bundle, descriptor) => path.join(bundle.generationDir, "results", `${descriptor.sha256}.json${descriptor.encoding === "gzip" ? ".gz" : ""}`);

test("explicit publication stores final default-cutoff snapshots and reads them without projection decompression or engine work", async t => {
  const { output, projection, receipt, bundle, sourceIndexBefore } = await setup(t);
  assert.equal(receipt.preparedResultCount, 2); assert.equal(bundle.catalog.schemaVersion, 2);
  assert.equal(receipt.calculationFingerprint, calculationFingerprint());
  assert.deepEqual(await fs.readFile(path.join(projection, "index.json")), sourceIndexBefore);
  const expected = await createKeywordMonthlyAnalysis({ projectionDir: projection, now: () => NOW }).analyze(QUERY);
  const phases = [], originalOpen = fs.open, originalWrite = fs.writeFile, originalFetch = globalThis.fetch;
  let forbiddenReads = 0, forbiddenWrites = 0, providerCalls = 0, legacyCalls = 0;
  fs.open = async function (file, ...rest) { if (String(file).includes(`${path.sep}projections${path.sep}`)) { forbiddenReads++; throw new Error("projection opened during prepared GET"); } return originalOpen.call(this, file, ...rest); };
  fs.writeFile = async function () { forbiddenWrites++; throw new Error("runtime write"); };
  globalThis.fetch = () => { providerCalls++; throw new Error("provider call"); };
  try {
    const service = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW,
      measure: async (phase, _meta, operation) => { phases.push(phase); return operation(); }, runLegacyAnalysis: () => { legacyCalls++; throw new Error("legacy guard"); } });
    const actual = await service.readPrepared(QUERY), normal = await service.analyze(QUERY);
    assert.deepEqual(actual.snapshot, expected.snapshot); assert.deepEqual(normal.snapshot, expected.snapshot);
    assert.equal(actual.preparedResult.status, "ready"); assert.equal(actual.provenance.originalFreshnessVerified, false);
    assert.equal(actual.provenance.inputSha256, expected.provenance.inputSha256);
    assert.equal(actual.snapshot.summary.lodging.sold, 3); assert.equal(actual.snapshot.quality.coveredCompanyDays < actual.snapshot.quality.expectedCompanyDays, true);
    assert.match(actual.resultId, /^[a-f0-9]{64}$/); assert.equal(actual.resultId, normal.resultId);
    assert.ok(phases.includes("keyword_prepared_result_read")); assert.ok(!phases.some(phase => /snapshot_current|snapshot_previous|projection_read|source_validate/.test(phase)));
    assert.equal(forbiddenReads + forbiddenWrites + providerCalls + legacyCalls, 0);
  } finally { fs.open = originalOpen; fs.writeFile = originalWrite; globalThis.fetch = originalFetch; }
});

test("process-local reader recreation preserves final results while clock freshness never rewrites source times", async t => {
  const { output, service } = await setup(t), first = await service.readPrepared(QUERY);
  first.snapshot.summary.lodging.sold = 999; first.provenance.materializedAt = "2000-01-01T00:00:00Z";
  const freshReader = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => "2026-11-17T00:00:00Z" });
  const result = await freshReader.readPrepared(QUERY);
  assert.equal(result.snapshot.summary.lodging.sold, 3); assert.equal(result.snapshot.generatedAt, NOW);
  assert.equal(result.provenance.materializedAt, NOW); assert.equal(result.currentDay, "2026-11-17");
  assert.equal(result.status, "stale"); assert.ok(result.diagnostics.includes("PROJECTION_EXPIRED"));
});

test("legacy and unprepared cutoffs are explicit and only a genuine miss invokes the optional legacy guard", async t => {
  const old = await setup(t, { prepareResults: false }), saved = await setup(t);
  const missing = await old.service.readPrepared(QUERY); assert.equal(missing.preparedResult.status, "not_prepared"); assert.equal(missing.snapshot, null);
  let calls = 0; const guarded = createKeywordMonthlyBundleAnalysis({ projectionDir: old.output, now: () => NOW, runLegacyAnalysis: async () => { calls++; throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_LEGACY_MEMORY_PRESSURE" }); } });
  assert.equal((await guarded.analyze(QUERY)).status, "needs_verification"); assert.equal(calls, 1);
  const other = await saved.service.readPrepared({ ...QUERY, cutoffDate: "2026-10-10" });
  assert.equal(other.snapshot, null); assert.equal(other.preparedResult.reasonCode, "KEYWORD_MONTHLY_CUTOFF_RESULT_NOT_PREPARED");
  const compatible = await saved.service.analyze({ ...QUERY, cutoffDate: "2026-10-10" }); assert.equal(compatible.snapshot.summary.lodging.sold, null);
});

test("additional explicitly prepared cutoffs remain separate and never substitute default dates", async t => {
  const earlier = { ...QUERY, cutoffDate: "2026-10-10" }, { service, receipt } = await setup(t, { preparedQueries: [earlier] });
  assert.equal(receipt.preparedResultCount, 3);
  const a = await service.readPrepared(earlier), b = await service.readPrepared(QUERY);
  assert.equal(a.request.cutoffDate, earlier.cutoffDate); assert.equal(a.snapshot.summary.lodging.sold, null);
  assert.equal(b.request.cutoffDate, QUERY.cutoffDate); assert.equal(b.snapshot.summary.lodging.sold, 3); assert.notEqual(a.resultId, b.resultId);
});

test("corrupt, missing and hardlinked prepared artifacts fail closed without legacy reconstruction", async t => {
  for (const kind of ["corrupt", "missing", "hardlink"]) {
    const { output, bundle, root } = await setup(t), descriptor = bundle.catalog.preparedResults.find(item => item.month === QUERY.month), file = resultFile(bundle, descriptor);
    if (kind === "corrupt") await fs.writeFile(file, "{}");
    else if (kind === "missing") await fs.unlink(file);
    else await fs.link(file, path.join(root, "artifact-link.json"));
    let calls = 0; const service = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW, runLegacyAnalysis: () => { calls++; throw new Error("should not reconstruct"); } });
    const result = await service.analyze(QUERY); assert.equal(result.status, "needs_verification", kind); assert.equal(result.snapshot, null); assert.equal(calls, 0);
  }
});

test("descriptor engine fingerprint and bound source identities must match even when outer catalog is rehashed", async t => {
  for (const field of ["calculationFingerprint", "sourceProjectionSha256", "sourceDigest"]) {
    const { output, service } = await setup(t);
    await rewriteCatalog(output, catalog => { catalog.preparedResults.find(item => item.month === QUERY.month)[field] = "f".repeat(64); });
    const result = await service.readPrepared(QUERY); assert.equal(result.status, "needs_verification", field); assert.equal(result.snapshot, null);
  }
});

test("a rehashed final snapshot from the future is rejected while historical generation time is retained", async t => {
  const { output, service } = await setup(t);
  await rewriteCatalog(output, async (catalog, bundle) => {
    const descriptor = catalog.preparedResults.find(item => item.month === QUERY.month), envelope = JSON.parse(await fs.readFile(resultFile(bundle, descriptor)));
    envelope.result.snapshot.generatedAt = "2026-11-15T01:00:00.000Z";
    const bytes = Buffer.from(JSON.stringify(envelope)); descriptor.sha256 = sha(bytes); descriptor.bytes = bytes.length;
    await fs.writeFile(resultFile(bundle, descriptor), bytes, { flag: "wx", mode: 0o600 });
  });
  const rejected = await service.readPrepared(QUERY); assert.equal(rejected.status, "needs_verification"); assert.equal(rejected.snapshot, null);
  assert.ok(rejected.diagnostics.includes("KEYWORD_MONTHLY_RESULT_CLOCK_INVALID"));
  const later = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => "2026-11-16T00:00:00.000Z" });
  const historical = await later.readPrepared(QUERY); assert.equal(historical.preparedResult.status, "ready"); assert.equal(historical.snapshot.generatedAt, "2026-11-15T01:00:00.000Z");
});

test("a pointer change during prepared-file read discards the old generation", async t => {
  const { output, projection, receipt, service } = await setup(t), oldPointer = await fs.readFile(path.join(output, "current.json"));
  await publishKeywordMonthlyBundle({ inputs: [{ directory: projection }], outputDir: output, now: NOW, prepareResults: true, expectedCurrentSha256: receipt.pointerSha256 });
  const nextPointer = await fs.readFile(path.join(output, "current.json")); await fs.writeFile(path.join(output, "current.json"), oldPointer);
  const original = fs.open; let changed = false;
  fs.open = async function (file, ...rest) { if (!changed && String(file).includes(`${path.sep}results${path.sep}`)) { changed = true; await fs.writeFile(path.join(output, "current.json"), nextPointer); } return original.call(this, file, ...rest); };
  try { const result = await service.readPrepared(QUERY); assert.equal(result.status, "needs_verification"); assert.ok(result.diagnostics.includes("KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ")); }
  finally { fs.open = original; }
});

test("an artifact changed after its byte hash but during decode is rejected before result adoption", async t => {
  const { output, bundle } = await setup(t), descriptor = bundle.catalog.preparedResults.find(item => item.month === QUERY.month), file = resultFile(bundle, descriptor);
  let changed = false, legacyCalls = 0;
  const service = createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW,
    runLegacyAnalysis: () => { legacyCalls++; throw new Error("must not fallback"); },
    measure: async (phase, _metadata, operation) => { if (phase === "keyword_prepared_result_parse" && !changed) { changed = true; await fs.writeFile(file, "{}"); } return operation(); } });
  const result = await service.analyze(QUERY); assert.equal(changed, true); assert.equal(result.status, "needs_verification"); assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.includes("KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ")); assert.equal(legacyCalls, 0);
});

test("a result tampered before promotion never replaces the previous published pointer", async t => {
  const { output, projection, receipt } = await setup(t), before = await fs.readFile(path.join(output, "current.json"));
  await assert.rejects(publishKeywordMonthlyBundle({ inputs: [{ directory: projection }], outputDir: output, now: NOW, prepareResults: true, expectedCurrentSha256: receipt.pointerSha256,
    beforePromote: async () => { const generations = await fs.readdir(path.join(output, "generations")), next = generations.find(id => id !== receipt.generation);
      const directory = path.join(output, "generations", next, "results"), names = await fs.readdir(directory); await fs.writeFile(path.join(directory, names[0]), "{}"); } }), /RESULT_CHANGED_BEFORE_PROMOTION/);
  assert.deepEqual(await fs.readFile(path.join(output, "current.json")), before);
  assert.equal((await createKeywordMonthlyBundleAnalysis({ projectionDir: output, now: () => NOW }).readPrepared(QUERY)).snapshot.summary.lodging.sold, 3);
});

test("last-safe promotion callback binds the unchanged scope plan separately from the final v2 catalog", async t => {
  const { root, projection } = await setup(t), output = path.join(root, "candidate-bundle"); let candidate;
  const receipt = await publishKeywordMonthlyBundle({ inputs: [{ directory: projection }], outputDir: output, now: NOW, prepareResults: true,
    beforePromote: async value => { candidate = value; assert.equal(Object.isFrozen(value), true); assert.equal(value.kind, "keyword_monthly_catalog_candidate");
      assert.equal(value.catalogSchemaVersion, 2); assert.equal(value.preparedResultCount, 2); assert.equal(value.calculationFingerprint, calculationFingerprint());
      await assert.rejects(fs.access(path.join(output, "current.json"))); } });
  const published = await loadBundle(output), scopePlan = { schemaVersion: 1, kind: published.catalog.kind, createdAt: published.catalog.createdAt,
    partitions: published.catalog.partitions, scopes: published.catalog.scopes };
  assert.equal(candidate.scopePlanSha256, sha(JSON.stringify(scopePlan)));
  assert.equal(candidate.catalogSha256, published.catalogRead.sha256); assert.equal(candidate.catalogSha256, receipt.catalogSha256);
  assert.notEqual(candidate.scopePlanSha256, candidate.catalogSha256);
  assert.equal(candidate.generation, receipt.generation); assert.equal(candidate.catalogBytes, published.catalogRead.bytes.length);
  assert.ok(Object.values(candidate).every(value => typeof value === "string" || typeof value === "number"));
});

test("a candidate catalog or child index altered in the final callback cannot be promoted", async t => {
  for (const target of ["catalog", "index"]) {
    const { root, projection } = await setup(t), output = path.join(root, "corrupt-candidate");
    await assert.rejects(publishKeywordMonthlyBundle({ inputs: [{ directory: projection }], outputDir: output, now: NOW, prepareResults: true,
      beforePromote: async candidate => { const dir = path.join(output, "generations", candidate.generation), file = target === "catalog" ? path.join(dir, "catalog.json")
        : path.join(dir, "partitions", (JSON.parse(await fs.readFile(path.join(dir, "catalog.json")))).partitions[0].key, "index.json"); await fs.writeFile(file, "{}"); } }), /CHANGED_BEFORE_PROMOTION/);
    await assert.rejects(fs.access(path.join(output, "current.json")));
  }
});

test("gzip result byte/decoded bounds, private fields, and CLI opt-in are validated", async t => {
  const { projection, bundle } = await setup(t), result = await createKeywordMonthlyAnalysis({ projectionDir: projection, now: () => NOW }).analyze(QUERY);
  const partition = bundle.catalog.partitions[0].key, saved = encodePreparedResult(result, { partition, compression: "gzip" });
  const options = { currentDay: "2026-11-15", now: NOW };
  assert.deepEqual(decodePreparedResult({ bytes: saved.bytes }, saved.descriptor, options).snapshot, result.snapshot);
  assert.throws(() => decodePreparedResult({ bytes: saved.bytes }, { ...saved.descriptor, uncompressedBytes: saved.descriptor.uncompressedBytes + 1 }, options), /RESULT_MISMATCH/);
  assert.throws(() => decodePreparedResult({ bytes: saved.bytes.subarray(0, -1) }, saved.descriptor, options), /RESULT_MISMATCH/);
  const privateResult = structuredClone(result); privateResult.snapshot.guestName = "forbidden";
  assert.throws(() => encodePreparedResult(privateResult, { partition }), /UNSAFE_FIELDS/);
  const large = structuredClone(result); large.snapshot.definitions.large = "x".repeat(KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.decodedBytes);
  assert.throws(() => encodePreparedResult(large, { partition }), /SIZE_LIMIT/);
  const cli = ["--input", projection, "--output", path.join(path.dirname(projection), "cli"), "--now", NOW];
  assert.equal(args([...cli, "--prepare-results", "1"])["prepare-results"], "1");
  assert.throws(() => args([...cli, "--prepare-results", "true"]), /CLI_PREPARE_RESULTS/);
});

test("derived results above 8MiB round trip without losing observations or changing financial semantics", async t => {
  const { projection, bundle } = await setup(t), result = await createKeywordMonthlyAnalysis({ projectionDir: projection, now: () => NOW }).analyze(QUERY);
  result.snapshot.definitions.deliveryEvidence = Array.from({ length: 12 }, (_, index) => ({ index, note: String(index).repeat(800000) }));
  const partition = bundle.catalog.partitions[0].key, saved = encodePreparedResult(result, { partition, compression: "gzip" });
  assert.ok(saved.descriptor.uncompressedBytes > 8 * 1024 * 1024);
  assert.ok(saved.descriptor.uncompressedBytes <= KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.decodedBytes);
  const restored = decodePreparedResult({ bytes: saved.bytes }, saved.descriptor, { currentDay: "2026-11-15", now: NOW });
  assert.deepEqual(restored.snapshot, result.snapshot);
  for (const field of ["request", "activity", "latestAttempt", "lastSuccessfulAttempt"]) assert.deepEqual(restored[field], result[field]);
  assert.equal(restored.snapshot.sources.observations.length, result.snapshot.sources.observations.length);
  assert.ok(boundedJsonBuffer(restored, KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.responseBytes).length > 8 * 1024 * 1024);
  assert.equal(KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.encodedBytes, 8 * 1024 * 1024);
  assert.equal(KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.nodes, 500000);
  assert.equal(KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.decodedBytes + KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.wrapperBytes, KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.responseBytes);
});

test("a full decoded budget leaves room for the final read wrapper and rejects a gzip expansion beyond 32MiB", async t => {
  const { projection, bundle } = await setup(t), result = await createKeywordMonthlyAnalysis({ projectionDir: projection, now: () => NOW }).analyze(QUERY);
  result.snapshot.definitions.deliveryEvidence = "";
  const partition = bundle.catalog.partitions[0].key, base = encodePreparedResult(result, { partition, compression: "gzip" });
  result.snapshot.definitions.deliveryEvidence = "x".repeat(KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.decodedBytes - base.descriptor.uncompressedBytes);
  const saved = encodePreparedResult(result, { partition, compression: "gzip" });
  assert.equal(saved.descriptor.uncompressedBytes, KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.decodedBytes);
  const restored = decodePreparedResult({ bytes: saved.bytes }, saved.descriptor, { currentDay: "2026-11-15", now: NOW });
  assert.ok(boundedJsonBuffer(restored, KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.responseBytes).length <= KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.responseBytes);
  result.snapshot.definitions.deliveryEvidence += "x";
  assert.throws(() => encodePreparedResult(result, { partition, compression: "gzip" }), /SIZE_LIMIT/);
  const bomb = gzipSync(Buffer.alloc(KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.responseBytes + 1, 120));
  assert.ok(bomb.length < KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.encodedBytes);
  assert.throws(() => decodePreparedResult({ bytes: bomb }, { ...saved.descriptor, bytes: bomb.length, sha256: sha(bomb) }, { currentDay: "2026-11-15", now: NOW }), /COMPRESSION_INVALID/);
});

test("compressed derived result artifacts retain the independent 8MiB stored-byte bound", async t => {
  const { projection, bundle } = await setup(t), result = await createKeywordMonthlyAnalysis({ projectionDir: projection, now: () => NOW }).analyze(QUERY);
  result.snapshot.definitions.deliveryEvidence = crypto.randomBytes(9 * 1024 * 1024).toString("base64");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.decodedBytes);
  assert.throws(() => encodePreparedResult(result, { partition: bundle.catalog.partitions[0].key, compression: "gzip" }), /SIZE_LIMIT/);
});
