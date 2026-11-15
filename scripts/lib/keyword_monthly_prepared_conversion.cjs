"use strict";
// Explicit immutable-generation conversion only. No application, collector,
// source adapter, customer configuration or issued-report module is imported.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const B = require("./keyword_monthly_bundle.cjs"), H = require("./keyword_monthly_refresh_preparation.cjs");
const { calculationFingerprint, queryId } = require("./keyword_monthly_prepared_results.cjs");
const VERSION = "keyword-monthly-prepared-conversion-v1", GUARD = "reconstruct_keyword_monthly_prepared_conversion.cjs";
const LIMITS = Object.freeze({ generationBytes: 128 * 1024 ** 2, inventoryBytes: 16 * 1024 ** 2, receiptBytes: 16 * 1024 ** 2,
  files: 32768, scratchBytes: 1024 ** 3, timeoutMs: 55 * 60000, heapMiB: 512, scopes: 4096 });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const bytesFor = value => Buffer.from(JSON.stringify(value));
const fault = code => Object.assign(new Error(code), { code });
const need = (value, code) => { if (!value) throw fault(code); };
const safeCode = error => /^(?:ISOLATION_|KEYWORD_)[A-Z0-9_]{1,150}$/.test(error?.code || "") ? error.code : "KEYWORD_PREPARED_CONVERSION_FAILED";
function semantic(result) { return { status: result.status, request: result.request, snapshot: result.snapshot, activity: result.activity,
  latestAttempt: result.latestAttempt, lastSuccessfulAttempt: result.lastSuccessfulAttempt, diagnostics: result.diagnostics }; }
const logicalHash = result => hash(bytesFor(semantic(result)));
function sourceIdentity(loaded) { return { generation: loaded.pointer.generation, pointerSha256: loaded.pointerRead.sha256, catalogSha256: loaded.catalogRead.sha256 }; }
function inputsFor(loaded) { return loaded.catalog.partitions.map(part => ({ directory: path.join(loaded.generationDir, "partitions", part.key),
  exposeScopes: loaded.catalog.scopes.filter(scope => scope.partition === part.key).map(({ keyword, month }) => ({ keyword, month })) })); }
async function inventory(directory) {
  const files = []; let total = 0;
  async function walk(current, relative, depth) {
    need(depth <= 12 && files.length <= LIMITS.files, "KEYWORD_PREPARED_CONVERSION_INVENTORY_BOUND");
    const before = await H.checked(current, true), entries = await fs.readdir(current, { withFileTypes: true });
    need(entries.length <= LIMITS.files, "KEYWORD_PREPARED_CONVERSION_INVENTORY_BOUND"); entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(current, entry.name), rel = path.join(relative, entry.name);
      need(!entry.isSymbolicLink(), "KEYWORD_PREPARED_CONVERSION_UNSAFE_SOURCE");
      if (entry.isDirectory()) await walk(file, rel, depth + 1);
      else {
        const read = await B.readBundleFile(file, LIMITS.generationBytes); total += read.size;
        need(total <= LIMITS.generationBytes && files.length < LIMITS.files, "KEYWORD_PREPARED_CONVERSION_INVENTORY_BOUND");
        files.push({ relative: rel.split(path.sep).join("/"), bytes: read.size, sha256: read.sha256,
          dev: read.stamp.dev, ino: read.stamp.ino, mtimeMs: read.stamp.mtimeMs, ctimeMs: read.stamp.ctimeMs, nlink: read.stamp.nlink });
      }
    }
    need(H.same(before, await H.checked(current, true)), "KEYWORD_PREPARED_CONVERSION_SOURCE_CHANGED");
  }
  await walk(directory, "", 0);
  const value = { directory, totalBytes: total, fileCount: files.length, files };
  need(bytesFor(value).length <= LIMITS.inventoryBytes, "KEYWORD_PREPARED_CONVERSION_INVENTORY_BOUND");
  return { ...value, sha256: hash(bytesFor(value)) };
}
async function assertInventory(expected) {
  need(expected && H.SHA.test(expected.sha256 || "") && typeof expected.directory === "string", "KEYWORD_PREPARED_CONVERSION_INVENTORY_INVALID");
  const actual = await inventory(expected.directory);
  need(actual.sha256 === expected.sha256, "KEYWORD_PREPARED_CONVERSION_SOURCE_CHANGED"); return actual;
}
async function assertUnlocked(dataDir, { publishing = false } = {}) {
  for (const relative of ["keyword_monthly_incremental/worker-lock.json", "keyword_monthly_incremental/worker-lock-recovery-claim.json",
    ...(!publishing ? ["keyword_monthly_analysis/publish.lock"] : [])]) {
    try { await fs.lstat(path.join(dataDir, ...relative.split("/"))); throw fault("KEYWORD_PREPARED_CONVERSION_WRITER_BUSY"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
async function initialBundle(dataDir, expectedSha256) {
  need(H.SHA.test(expectedSha256 || ""), "KEYWORD_PREPARED_CONVERSION_EXPECTED_POINTER_REQUIRED");
  const loaded = await B.loadBundle(path.join(dataDir, "keyword_monthly_analysis"));
  need(loaded.pointerRead.sha256 === expectedSha256, "KEYWORD_PREPARED_CONVERSION_POINTER_CHANGED"); return loaded;
}
async function writeNew(file, value, maximum = LIMITS.receiptBytes) {
  const bytes = bytesFor(value); need(bytes.length > 0 && bytes.length <= maximum, "KEYWORD_PREPARED_CONVERSION_RECEIPT_BOUND");
  const handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const read = await H.read(file, maximum); need(read.sha256 === hash(bytes), "KEYWORD_PREPARED_CONVERSION_READBACK_FAILED"); return read;
}
function scopePlanSha256(inputs, parts, now) {
  const byIndex = new Map(), scopes = [];
  for (let n = 0; n < inputs.length; n++) {
    const part = parts[n]; byIndex.set(part.index.sha256, { key: part.index.sha256, indexSha256: part.index.sha256, indexBytes: part.index.size });
    for (const scope of inputs[n].exposeScopes) scopes.push({ ...scope, partition: part.index.sha256 });
  }
  const catalog = B.validateCatalog({ schemaVersion: 1, kind: "keyword_monthly_partition_bundle", createdAt: new Date(now).toISOString(),
    partitions: [...byIndex.values()], scopes: scopes.sort((a, b) => JSON.stringify([a.keyword, a.month]).localeCompare(JSON.stringify([b.keyword, b.month]))) });
  return hash(bytesFor(catalog));
}
async function compile(job, { isolation, fixture = false } = {}) {
  need(job?.version === VERSION && H.validIso(job.now) && H.SHA.test(job.expectedCurrentSha256 || "") && H.SHA.test(job.calculationFingerprint || "")
    && job.calculationFingerprint === calculationFingerprint() && H.inside(job.operationsDir, job.jobDir)
    && path.dirname(job.operationsDir) === path.join(job.dataDir, "operations") && path.basename(job.jobDir) === job.conversionId
    && /^[a-f0-9]{32}$/.test(job.conversionId || ""), "KEYWORD_PREPARED_CONVERSION_JOB_INVALID");
  need(fixture || isolation?.mode === "seccomp" && isolation.pid === process.pid, "KEYWORD_PREPARED_CONVERSION_ISOLATION_REQUIRED");
  const started = Date.now(), initial = await initialBundle(job.dataDir, job.expectedCurrentSha256);
  need(initial.catalog.schemaVersion === 1 && JSON.stringify(sourceIdentity(initial)) === JSON.stringify(job.source), "KEYWORD_PREPARED_CONVERSION_SOURCE_INVALID");
  const original = await inventory(initial.generationDir);
  need(original.sha256 === job.sourceInventorySha256, "KEYWORD_PREPARED_CONVERSION_SOURCE_CHANGED");
  const inputs = inputsFor(initial), legacy = B.createKeywordMonthlyBundleAnalysis({ projectionDir: path.join(job.dataDir, "keyword_monthly_analysis"), now: () => job.now });
  const options = await legacy.options(), queries = initial.catalog.scopes.map(scope => ({ keyword: scope.keyword, month: scope.month,
    cutoffDate: options.keywords?.find(row => row.keyword === scope.keyword)?.defaultCutoffs?.[scope.month] }));
  need(["available", "stale"].includes(options.status) && queries.length > 0 && queries.length <= LIMITS.scopes
    && queries.every(query => H.validDay(query.cutoffDate)), "KEYWORD_PREPARED_CONVERSION_SCOPE_UNAVAILABLE");
  const parity = [], checkpoints = [], resultSizes = [];
  const checkpoint = label => { const m = process.memoryUsage(); checkpoints.push({ label, heapUsed: m.heapUsed, rss: m.rss, external: m.external }); };
  const deadline = () => need(Date.now() - started < LIMITS.timeoutMs, "KEYWORD_PREPARED_CONVERSION_TIME_BOUND");
  for (let n = 0; n < queries.length; n++) {
    deadline(); let result = await legacy.analyze(queries[n]);
    need(["available", "stale"].includes(result.status) && result.snapshot && queryId(result.request) === queryId(queries[n]), "KEYWORD_PREPARED_CONVERSION_LEGACY_UNAVAILABLE");
    const resultJsonBytes = Buffer.byteLength(JSON.stringify(result)), memory = process.memoryUsage();
    resultSizes.push({ query: { ...queries[n] }, resultJsonBytes, observationCount: result.snapshot.sources.observations.length,
      memory: { heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, rss: memory.rss, external: memory.external, arrayBuffers: memory.arrayBuffers } });
    parity.push({ query: queries[n], status: result.status, logicalSha256: logicalHash(result), selectedDigest: result.snapshot.sources.digest,
      inputSha256: result.provenance.inputSha256, dataThrough: result.provenance.dataThrough }); result = null; checkpoint(`legacy_${n + 1}`);
  }
  // Preserve bounded, payload-free size evidence even when a later encode
  // rejects a result. Source rows, prices and customer data are not copied.
  const resultSizesRead = await writeNew(path.join(job.jobDir, "legacy-result-sizes.json"), {
    schemaVersion: 1, kind: "keyword_monthly_legacy_result_sizes", calculationFingerprint: job.calculationFingerprint,
    scopeCount: resultSizes.length, maximumResultJsonBytes: Math.max(...resultSizes.map(row => row.resultJsonBytes)), results: resultSizes
  });
  deadline(); const preparation = await B.prepareKeywordMonthlyBundle({ inputs, now: job.now, maxTotalBytes: LIMITS.generationBytes,
    prepareResults: true, preparedOutputDir: path.join(job.jobDir, "prepared-results") });
  const preparationRead = await writeNew(path.join(job.jobDir, "publication-preparation.json"), preparation);
  const candidateDir = path.join(job.jobDir, "candidate"), publication = await B.publishPrevalidatedKeywordMonthlyBundle({ inputs, outputDir: candidateDir,
    now: job.now, maxTotalBytes: LIMITS.generationBytes, preparation });
  const verified = await B.verifyPrevalidatedKeywordMonthlyBundle({ projectionDir: candidateDir, expectedCatalogSha256: publication.catalogSha256,
    preparation, wantedScopes: initial.catalog.scopes.map(({ keyword, month }) => ({ keyword, month })) });
  const saved = B.createKeywordMonthlyBundleAnalysis({ projectionDir: candidateDir, now: () => job.now });
  for (let n = 0; n < parity.length; n++) {
    deadline(); let result = await saved.readPrepared(parity[n].query);
    need(result.preparedResult?.status === "ready" && logicalHash(result) === parity[n].logicalSha256,
      "KEYWORD_PREPARED_CONVERSION_LOGICAL_MISMATCH"); result = null; parity[n].exact = true; checkpoint(`prepared_${n + 1}`);
  }
  await assertInventory(original); await initialBundle(job.dataDir, job.expectedCurrentSha256);
  need(calculationFingerprint() === job.calculationFingerprint, "KEYWORD_PREPARED_CONVERSION_CODE_CHANGED");
  return { schemaVersion: 1, version: VERSION, status: "staged", conversionId: job.conversionId, source: job.source,
    sourceInventorySha256: original.sha256, fixedClock: job.now, calculationFingerprint: job.calculationFingerprint,
    scopeCount: parity.length, preparedResultCount: preparation.preparedResults.descriptors.length, parity, paritySha256: hash(bytesFor(parity)),
    preparationSha256: preparationRead.sha256, candidate: { directory: candidateDir, ...verified }, publication,
    legacyResultSizes: { file: "legacy-result-sizes.json", sha256: resultSizesRead.sha256, bytes: resultSizesRead.bytes.length },
    scopePlanSha256: scopePlanSha256(inputs, preparation.parts, job.now), isolation, elapsedMs: Date.now() - started,
    memory: { interpretation: "endpoint checkpoints only, not continuous peak", checkpoints },
    fixtureOnly: fixture, sourceWrites: 0, providerCalls: 0, appEntryExecutions: 0, issuedReportsChanged: false, originalFreshnessVerified: false };
}
module.exports = { VERSION, GUARD, LIMITS, hash, bytesFor, fault, need, safeCode, semantic, logicalHash, sourceIdentity, inputsFor,
  inventory, assertInventory, assertUnlocked, initialBundle, writeNew, scopePlanSha256, compile };
