"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { buildKeywordMonthlyProjection, createKeywordMonthlyAnalysis, KEYWORD_MONTHLY_LIMITS } = require("./lib/keyword_monthly_analysis.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const NOW = "2026-10-30T00:00:00.000Z", keyword = "압축검증글램핑";
function fixture(size = 1) {
  return { companies: [{ companyId: "a", primaryName: "검증 A" }], runs: [{ id: "r", keyword, collectedAt: "2026-10-01T00:00:00Z", collectionQuality: "complete" }],
    observations: Array.from({ length: size }, (_, i) => ({ companyId: "a", runId: "r", keyword, observationId: `o${i}`, productType: "lodging", stayDate: "2026-10-10", collectedAt: "2026-10-01T00:00:00Z",
      inventoryEvidenceVersion: 4, supply: 10, sold: 2, publicBookings: 2, phoneBookings: 0, publicRevenue: 200, phoneRevenue: 0, estimatedRevenue: 200,
      ...(size > 1 ? { publicValidationPadding: "p".repeat(238000) } : {}) })), rankObservations: [] };
}
async function setup(t, source = fixture(), extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-gzip-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("keyword-gzip-")); await fs.rm(root, { recursive: true, force: true }); });
  const directory = path.join(root, "projection");
  await buildKeywordMonthlyProjection({ source, sourceFingerprint: hash(JSON.stringify(source)), materializedAt: NOW, now: () => NOW, outputDir: directory, ...extra });
  return { directory, indexFile: path.join(directory, "index.json"), service: createKeywordMonthlyAnalysis({ projectionDir: directory, now: () => NOW }) };
}
const query = { keyword, month: "2026-10", cutoffDate: "2026-10-01" };
async function gzipExisting(directory, indexFile) {
  const index = JSON.parse(await fs.readFile(indexFile)), scope = index.keywords[0].scopes[0];
  const decoded = await fs.readFile(path.join(directory, "projections", `${scope.scopeKey}.json`));
  const bytes = gzipSync(decoded);
  const file = path.join(directory, "projections", `${scope.scopeKey}.json.gz`);
  await fs.writeFile(file, bytes, { flag: "wx" });
  Object.assign(scope, { encoding: "gzip", uncompressedBytes: decoded.length, bytes: bytes.length, sha256: hash(bytes) });
  await fs.writeFile(indexFile, JSON.stringify(index));
  return { index, scope, file };
}
test("a complete scope over 32MiB is stored losslessly compressed without widening stored-file or decoded limits", async t => {
  const { directory, indexFile, service } = await setup(t, fixture(150));
  const index = JSON.parse(await fs.readFile(indexFile)), scope = index.keywords[0].scopes[0];
  assert.equal(scope.encoding, "gzip");
  assert.ok(scope.uncompressedBytes > KEYWORD_MONTHLY_LIMITS.projectionBytes);
  assert.ok(scope.uncompressedBytes <= KEYWORD_MONTHLY_LIMITS.decodedProjectionBytes);
  assert.ok(scope.bytes < KEYWORD_MONTHLY_LIMITS.projectionBytes);
  const file = path.join(directory, "projections", `${scope.scopeKey}.json.gz`), before = await fs.stat(file);
  const actual = await service.analyze(query);
  assert.equal(actual.status, "available"); assert.equal(actual.snapshot.summary.lodging.sold, 2);
  assert.equal(actual.snapshot.sources.selectedObservationCount, 1);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  assert.equal(hash(await fs.readFile(file)), scope.sha256);
});
test("compressed metadata, declared decoded length, corrupted gzip and payload mismatch fail closed", async t => {
  for (const kind of ["length", "corrupt", "encoding", "decoded_limit"]) {
    const { directory, indexFile, service } = await setup(t);
    const { index, scope, file } = await gzipExisting(directory, indexFile);
    if (kind === "length") scope.uncompressedBytes++;
    if (kind === "corrupt") { const bytes = Buffer.from("invalid gzip"); await fs.writeFile(file, bytes); scope.bytes = bytes.length; scope.sha256 = hash(bytes); }
    if (kind === "encoding") scope.encoding = "brotli";
    if (kind === "decoded_limit") scope.uncompressedBytes = KEYWORD_MONTHLY_LIMITS.decodedProjectionBytes + 1;
    await fs.writeFile(indexFile, JSON.stringify(index));
    const actual = await service.analyze(query);
    assert.equal(actual.status, "needs_verification", kind); assert.equal(actual.snapshot, null, kind);
  }
});
test("legacy uncompressed projections retain exact responses when losslessly encoded", async t => {
  const { directory, indexFile, service } = await setup(t);
  const original = await service.analyze(query);
  await gzipExisting(directory, indexFile);
  const encoded = await service.analyze(query);
  assert.equal(encoded.status, "available");
  assert.deepEqual(encoded.snapshot, original.snapshot);
  assert.deepEqual(encoded.activity, original.activity);
});

test("explicit gzip preparation reduces storage while preserving the entire small-scope snapshot and provenance", async t => {
  const plain = await setup(t), compressed = await setup(t, fixture(), { compression: "gzip" });
  const [before, after] = await Promise.all([plain.service.analyze(query), compressed.service.analyze(query)]);
  const index = JSON.parse(await fs.readFile(compressed.indexFile)), scope = index.keywords[0].scopes[0];
  assert.equal(scope.encoding, "gzip"); assert.ok(scope.bytes < scope.uncompressedBytes);
  assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(after.activity, before.activity);
  assert.equal(after.provenance.inputSha256, before.provenance.inputSha256); assert.equal(after.provenance.sourceDigest, before.provenance.sourceDigest);
  assert.equal(after.provenance.materializedAt, before.provenance.materializedAt); assert.equal(after.provenance.dataThrough, before.provenance.dataThrough);
});
