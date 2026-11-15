"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), zlib = require("node:zlib"), { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { KEYWORD_MONTHLY_SOURCE_BUDGET: BUDGET } = require("./lib/keyword_monthly_source_budget.cjs");
const { normalizePair } = require("./lib/keyword_monthly_incremental_normalize.cjs"), A = require("./lib/keyword_monthly_analysis.cjs"), CLI = require("./build_keyword_monthly_projection.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex"), MiB = 1024 ** 2;
const at = "2026-11-15T00:00:00.000Z", keyword = "SYNTHETIC_LARGE_KEYWORD";
function wiring(count) {
  const witness = "s".repeat(180 * 1024);
  return { sources: { loadSources: async request => {
    const runId = "synthetic_" + request.month, collectedAt = request.month + "-14T00:00:00.000Z";
    return { companies: [{ companyId: "synthetic_company", primaryName: "Synthetic budget fixture", capacity: 5 }],
      runs: [{ id: runId, keyword, collectedAt, collectionQuality: { status: "complete" } }],
      observations: Array.from({ length: count }, (_, i) => ({ companyId: "synthetic_company", runId, keyword, observationId: "synthetic_" + i,
        stayDate: request.month + "-20", collectedAt, productType: "lodging", inventoryEvidenceVersion: 4, supply: 5, sold: 2, publicBookings: 2, phoneBookings: 0,
        publicRevenue: 200, phoneRevenue: 0, estimatedRevenue: 200, sourceWitness: witness })),
      rankObservations: [], savedProductRecoveries: [], warnings: [], sourceDiagnostics: {}, globalWarnings: [], globalDiagnostics: {} };
  } } };
}
const call = count => ({ wiring: wiring(count), keyword, month: "2026-11", cutoffDate: "2026-11-15", capturedAt: at });
async function largeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-source-budget-large-"));
  try {
    const small = await normalizePair(call(2)), smallNoBuffer = await normalizePair({ ...call(2), retainBytes: false });
    assert.equal(smallNoBuffer.bytes, null); for (const key of ["source", "inputSha256", "inputBytes", "provenance", "records", "removed"]) assert.deepEqual(smallNoBuffer[key], small[key]);
    assert.equal(hash(small.bytes), smallNoBuffer.inputSha256);
    const normalized = await normalizePair({ ...call(200), retainBytes: false });
    assert.ok(normalized.inputBytes > 64 * MiB && normalized.inputBytes < BUDGET.normalizedJsonBytes); assert.equal(normalized.bytes, null);
    let retained = await normalizePair(call(200)); assert.equal(hash(retained.bytes), normalized.inputSha256); assert.equal(retained.inputSha256, normalized.inputSha256);
    assert.equal(retained.inputBytes, normalized.inputBytes); assert.deepEqual(retained.provenance, normalized.provenance); assert.deepEqual(retained.records, normalized.records); retained = null;
    const sourceFile = path.join(root, "synthetic-source.json"), output = path.join(root, "projection"), serialized = JSON.stringify(normalized.source);
    assert.equal(Buffer.byteLength(serialized), normalized.inputBytes); assert.equal(hash(serialized), normalized.inputSha256); await fs.writeFile(sourceFile, serialized, { flag: "wx" });
    const result = await CLI.run(["--source", sourceFile, "--output", output, "--now", at, "--data-through", at, "--compression", "gzip", "--publish-months", "2026-11"]);
    assert.equal(result.sourceFingerprint, normalized.inputSha256); assert.equal(result.sourceUnchanged, true);
    const index = JSON.parse(await fs.readFile(path.join(output, "index.json"))), scope = index.keywords[0].scopes[0], decodedProjectionBytes = scope.uncompressedBytes;
    assert.ok(decodedProjectionBytes > 64 * MiB && decodedProjectionBytes < BUDGET.decodedProjectionBytes);
    let compressed = await fs.readFile(path.join(output, "projections", scope.scopeKey + ".json.gz"));
    let decoded = zlib.gunzipSync(compressed, { maxOutputLength: BUDGET.decodedProjectionBytes }), envelope = JSON.parse(decoded);
    assert.equal(envelope.source.observations.length, 400); assert.ok(envelope.source.observations.every(row => row.sourceWitness.length === 180 * 1024));
    assert.equal(hash(JSON.stringify(envelope.source)), envelope.sourceDigest); assert.equal(hash(compressed), scope.sha256);
    envelope = null; decoded = null; compressed = null;
    const read = await A.createKeywordMonthlyAnalysis({ projectionDir: output, now: () => at }).analyze({ keyword, month: "2026-11", cutoffDate: "2026-11-15" });
    assert.ok(read.snapshot); assert.equal(read.snapshot.summary.lodging.sold, 2); assert.equal(read.snapshot.summary.lodging.estimatedRevenue, 200);
    assert.equal(read.snapshot.sources.observations.length, 1); assert.ok(read.snapshot.comparison); assert.equal(hash(await fs.readFile(sourceFile)), normalized.inputSha256);
    const originalIndex = await fs.readFile(path.join(output, "index.json")); index.keywords[0].scopes[0].uncompressedBytes = BUDGET.decodedProjectionBytes + 1;
    await fs.writeFile(path.join(output, "index.json"), JSON.stringify(index));
    const rejected = await A.createKeywordMonthlyAnalysis({ projectionDir: output, now: () => at }).analyze({ keyword, month: "2026-11", cutoffDate: "2026-11-15" });
    assert.equal(rejected.snapshot, null); assert.ok(rejected.diagnostics.includes("KEYWORD_MONTHLY_INVALID_INDEX")); await fs.writeFile(path.join(output, "index.json"), originalIndex);
    await assert.rejects(normalizePair({ ...call(280), retainBytes: false }), { code: "KEYWORD_INCREMENTAL_SOURCE_BOUND" });
    const tooLarge = path.join(root, "oversized-synthetic.json"), handle = await fs.open(tooLarge, "wx"); try { await handle.truncate(BUDGET.normalizedJsonBytes + 1); } finally { await handle.close(); }
    await assert.rejects(CLI.safeInput(tooLarge), /KEYWORD_MONTHLY_CLI_INPUT_BOUND/);
    const usage = process.memoryUsage(); process.stdout.write(JSON.stringify({ status: "passed", syntheticOnly: true, inputBytes: normalized.inputBytes, decodedProjectionBytes,
      rowCountPreserved: 400, selectedRows: 1, inputHashAndProvenanceExact: true, over96MiBRejected: true, sourceUnchanged: true,
      endpointMemoryOnly: true, heapUsed: usage.heapUsed, rss: usage.rss, heapSizeLimit: require("node:v8").getHeapStatistics().heap_size_limit }) + "\n");
  } finally { assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith("keyword-source-budget-large-")); await fs.rm(root, { recursive: true, force: true }); }
}
if (process.argv.includes("--large-budget-fixture")) largeFixture().catch(error => { process.stderr.write(String(error.stack) + "\n"); process.exitCode = 1; });
else {
  test("normalized, CLI, decoded projection, coordinator and physical oracle share the same explicit96MiB budget", async () => {
    assert.equal(BUDGET.normalizedJsonBytes, 96 * MiB); assert.equal(A.KEYWORD_MONTHLY_LIMITS.decodedProjectionBytes, BUDGET.decodedProjectionBytes);
    assert.equal(require("./prepare_keyword_monthly_release.cjs").LIMITS.source, BUDGET.normalizedJsonBytes);
    assert.equal(A.KEYWORD_MONTHLY_LIMITS.projectionBytes, 32 * MiB); assert.equal(A.KEYWORD_MONTHLY_LIMITS.observations, 50000);
    assert.equal(require("./lib/keyword_monthly_prepared_results.cjs").KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.encodedBytes, 8 * MiB);
    assert.equal(require("./lib/keyword_monthly_refresh_preparation.cjs").LIMITS.generationBytes, 128 * MiB);
    for (const name of ["build_keyword_monthly_projection.cjs", "reconstruct_keyword_monthly_source_copy.cjs", "verify_keyword_monthly_incremental_realcopy.cjs"])
      assert.match(await fs.readFile(path.join(__dirname, name), "utf8"), /keyword_monthly_source_budget\.cjs/);
  });
  test("a real source above64MiB round-trips unchanged within an explicit1GiB child and96MiB remains a hard bound", { timeout: 120000 }, async () => {
    const result = await promisify(execFile)(process.execPath, ["--max-old-space-size=1024", __filename, "--large-budget-fixture"], { timeout: 110000, maxBuffer: MiB, windowsHide: true });
    const value = JSON.parse(result.stdout.trim()); assert.equal(value.status, "passed"); assert.equal(value.rowCountPreserved, 400); assert.ok(value.inputBytes > 64 * MiB);
    assert.equal(value.over96MiBRejected, true); assert.equal(value.inputHashAndProvenanceExact, true); assert.equal(value.sourceUnchanged, true);
    assert.ok(value.heapSizeLimit <= 1.3 * 1024 ** 3); process.stdout.write("synthetic_source_budget_result " + JSON.stringify(value) + "\n");
  });
}
