"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { createIndustrySourceCandidateCache, witnessInputsMatch } = require("./lib/industry_source_candidate_cache.cjs");
const { YIELD_CODE } = require("./lib/cooperative_work_checkpoint.cjs");
const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const scope = { type: "industry", targetId: "__industry_all__", month: "2026-09", cutoffDate: "2026-09-30", includeContext: true };
const evidence = (companyId, count, collectedAt, extra = {}) => ({ companyId, productType: "lodging", productId: "room", count, collectedAt, sourceDate: "2026-09-29", runId: collectedAt, source: "normal_saved_product_response", ...extra });
const candidate = (value = "saved") => ({ source: { companies: [{ companyId: "a" }], observations: [{ companyId: "a", value }], runs: [], rankObservations: [], savedProductRecoveries: [], warnings: [], context: null }, persistedProductCapacityInput: { companyIds: ["a"], evidence: [], warnings: [] }, contextCompanyIds: ["a"], publicationEvidence: [] });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "industry-source-candidate-")), directory = path.join(root, "candidates");
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("industry-source-candidate-")); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, cache: createIndustrySourceCandidateCache({ directory, version: "test-v1", ...options }) };
}
async function files(directory) { return (await fs.readdir(directory)).sort(); }
async function pointer(directory) {
  const name = (await files(directory)).find(value => /^[a-f0-9]{64}\.json$/.test(value));
  const file = path.join(directory, name), bytes = await fs.readFile(file), value = JSON.parse(bytes);
  const manifestFile = path.join(directory, value.generation, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestFile));
  return { file, bytes, value, manifestFile, manifest };
}
async function rewriteManifest(item) {
  const bytes = Buffer.from(JSON.stringify(item.manifest)); await fs.writeFile(item.manifestFile, bytes);
  const { checksum, ...body } = item.value; body.manifestHash = hash(bytes);
  await fs.writeFile(item.file, JSON.stringify({ ...body, checksum: hash(body) }));
}

test("temporal witness proof permits only the exact verified before/after profile per company", () => {
  const a10 = evidence("a", 10, "2026-09-01T00:00:00Z"), a16 = evidence("a", 16, "2026-09-20T00:00:00Z"), b7 = evidence("b", 7, "2026-09-10T00:00:00Z");
  const before = { companyIds: ["a", "b"], evidence: [a10], warnings: [] };
  assert.equal(witnessInputsMatch(before, [a16, b7], { evidence: [a10, a16], warnings: [] }, scope.cutoffDate), true, "partially completed own publication is reusable");
  assert.equal(witnessInputsMatch(before, [a16, b7], { evidence: [a10, a16, b7], warnings: [] }, scope.cutoffDate), true);
  assert.equal(witnessInputsMatch(before, [a16, b7], { evidence: [a10, evidence("a", 14, "2026-09-10T00:00:00Z"), a16], warnings: [] }, scope.cutoffDate), false, "an earlier new high changes prior-day math even when the final maximum is unchanged");
  assert.equal(witnessInputsMatch(before, [a16, b7], { evidence: [], warnings: [] }, scope.cutoffDate), false, "lost verified input is not an own publication");
  assert.equal(witnessInputsMatch(before, [a16, b7], { evidence: [a10, a16, evidence("b", 12, "2026-10-01T00:00:00Z")], warnings: [] }, scope.cutoffDate), true, "future witnesses cannot change this cutoff");
  assert.equal(witnessInputsMatch(before, [a16, b7], { evidence: [a10], warnings: [{ companyId: "a", code: "SOURCE_INVALID" }] }, scope.cutoffDate), false);
  assert.equal(witnessInputsMatch(before, [a16, b7], { evidence: [{ ...a10, runId: "different-provenance" }], warnings: [] }, scope.cutoffDate), false);
  assert.equal(witnessInputsMatch(before, [a16, b7], { evidence: [a10, evidence("outside", 1, "2026-09-01T00:00:00Z")], warnings: [] }, scope.cutoffDate), false);
  assert.equal(witnessInputsMatch({ ...before, companyIds: ["a", "a"] }, [], { evidence: [], warnings: [] }, scope.cutoffDate), false);
});

test("a source graph larger than 32MiB is reused after restart through bounded ordered gzip shards", { timeout: 20000 }, async t => {
  const f = await fixture(t), value = candidate(), size = 600 * 1024;
  value.source.observations = Array.from({ length: 60 }, (_, index) => ({ companyId: "a", index, text: "x".repeat(size) }));
  assert.ok(value.source.observations.length * size > 32 * 1024 * 1024);
  let writes = 0; assert.equal(await f.cache.write(scope, "revision-1", value, { checkpoint: async () => { writes++; } }), true);
  const item = await pointer(f.directory), shards = item.manifest.arrays.flatMap(group => group.files);
  assert.ok(shards.length > 5); assert.ok(shards.every(row => row.decodedBytes <= 6 * 1024 * 1024)); assert.ok(writes > 5);
  const fresh = createIndustrySourceCandidateCache({ directory: f.directory, version: "test-v1" }); let reads = 0;
  const restored = await fresh.read(scope, "revision-1", { checkpoint: async () => { reads++; } });
  assert.equal(restored.source.observations.length, 60); assert.equal(restored.source.observations[0].index, 0); assert.equal(restored.source.observations.at(-1).index, 59);
  assert.equal(restored.source.observations[31].text.length, size); assert.equal(reads, shards.length);
  assert.deepEqual(restored.persistedProductCapacityInput, value.persistedProductCapacityInput);
  assert.ok(f.cache.stats().maximumDecodedBytes <= 6 * 1024 * 1024); assert.ok(f.cache.stats().maximumPhysicalBytes <= 64 * 1024 * 1024);
  assert.equal(await fresh.read(scope, "changed-raw-revision"), null); assert.equal(await fresh.read({ ...scope, month: "2026-10" }, "revision-1"), null);
  assert.equal(await createIndustrySourceCandidateCache({ directory: f.directory, version: "changed-code-version" }).read(scope, "revision-1"), null);
});

test("oversized individual or total decoded data preserves the previous complete pointer", async t => {
  const f = await fixture(t, { maxEntryBytes: 4096, maxBytes: 50000, maxDecodedBytes: 12000 });
  assert.equal(await f.cache.write(scope, "r1", candidate()), true); const before = await pointer(f.directory);
  const oversized = candidate("x".repeat(5000)); assert.equal(await f.cache.write(scope, "r2", oversized), false);
  assert.deepEqual(await fs.readFile(before.file), before.bytes); assert.equal((await f.cache.read(scope, "r1")).source.observations[0].value, "saved");
  const total = candidate(); total.source.observations = Array.from({ length: 10 }, () => ({ value: "x".repeat(2000) }));
  assert.equal(await f.cache.write(scope, "r3", total), false); assert.deepEqual(await fs.readFile(before.file), before.bytes);
  assert.equal((await files(f.directory)).filter(name => name.includes("generation-")).length, 1); assert.equal(f.cache.stats().oversizeSkips, 2);
});

test("corrupt or truncated gzip and changed manifest integrity cause a safe cache miss", async t => {
  const f = await fixture(t); await f.cache.write(scope, "r1", candidate()); let item = await pointer(f.directory);
  const chunk = item.manifest.arrays.flatMap(group => group.files)[0]; await fs.writeFile(path.join(f.directory, item.value.generation, chunk.name), Buffer.from([31, 139, 8]));
  assert.equal(await f.cache.read(scope, "r1"), null);
  await f.cache.write(scope, "r1", candidate()); item = await pointer(f.directory); item.manifest.scope.month = "2026-10"; await fs.writeFile(item.manifestFile, JSON.stringify(item.manifest));
  assert.equal(await f.cache.read(scope, "r1"), null, "the immutable manifest digest must match its published pointer");
});

test("decompression and cumulative decoded limits are checked before accepting or expanding shards", async t => {
  const f = await fixture(t, { maxEntryBytes: 4096, maxBytes: 40000, maxDecodedBytes: 12000 });
  await f.cache.write(scope, "r1", candidate()); let item = await pointer(f.directory), chunk = item.manifest.arrays.flatMap(group => group.files)[0];
  const bomb = Buffer.from(JSON.stringify([{ value: "x".repeat(10000) }])); await fs.writeFile(path.join(f.directory, item.value.generation, chunk.name), gzipSync(bomb));
  chunk.hash = hash(bomb); chunk.decodedBytes = 100; await rewriteManifest(item);
  assert.equal(await f.cache.read(scope, "r1"), null, "gzip output is bounded independently from claimed length and checksum");
  await f.cache.write(scope, "r1", candidate()); item = await pointer(f.directory); const group = item.manifest.arrays.find(row => row.files.length);
  group.files = Array.from({ length: 6 }, () => ({ ...group.files[0], decodedBytes: 3000 })); await rewriteManifest(item);
  assert.equal(await f.cache.read(scope, "r1"), null, "total decoded budget includes every declared shard");
});

test("checkpoint cancellation is never converted to optional-cache failure and leaves saved data intact", async t => {
  const f = await fixture(t); await f.cache.write(scope, "r1", candidate()); const before = await pointer(f.directory);
  const stop = Object.assign(Error("yield"), { code: YIELD_CODE });
  await assert.rejects(f.cache.write(scope, "r2", candidate("replacement"), { checkpoint: async () => { throw stop; } }), error => error === stop);
  assert.deepEqual(await fs.readFile(before.file), before.bytes); assert.equal((await files(f.directory)).filter(name => name.includes("generation-")).length, 1);
  await assert.rejects(f.cache.read(scope, "r1", { checkpoint: async () => { throw stop; } }), error => error === stop);
  const failure = Error("source checkpoint failed");
  await assert.rejects(f.cache.read(scope, "r1", { checkpoint: async () => { throw failure; } }), error => error === failure);
  assert.equal((await f.cache.read(scope, "r1")).source.observations[0].value, "saved");
});

test("bounded entry eviction touches only disposable candidate files, with no raw or report deletion", async t => {
  const f = await fixture(t, { maxEntries: 1, maxEntryBytes: 4096, maxBytes: 20000 });
  const sentinel = path.join(f.root, "issued-report.json"); await fs.writeFile(sentinel, "unchanged-issued"); await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(path.join(f.directory, "not-a-candidate.json"), "unknown-owner");
  await f.cache.write(scope, "r1", candidate()); await f.cache.write({ ...scope, month: "2026-10" }, "r2", candidate("new"));
  assert.equal(await f.cache.read(scope, "r1"), null); assert.equal((await f.cache.read({ ...scope, month: "2026-10" }, "r2")).source.observations[0].value, "new");
  assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged-issued"); assert.equal(await fs.readFile(path.join(f.directory, "not-a-candidate.json"), "utf8"), "unknown-owner");
  assert.ok(f.cache.stats().maximumPhysicalBytes <= 20000); assert.equal((await files(f.directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length, 1);
});

test("a symlink cache root cannot be read, published, or recursively cleaned", async t => {
  const f = await fixture(t), elsewhere = path.join(f.root, "other-owner"); await fs.mkdir(elsewhere); await fs.writeFile(path.join(elsewhere, "keep.txt"), "keep");
  try { await fs.symlink(elsewhere, f.directory, process.platform === "win32" ? "junction" : "dir"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("symlink unavailable"); throw error; }
  assert.equal(await f.cache.write(scope, "r1", candidate()), false); assert.equal(await f.cache.read(scope, "r1"), null);
  assert.equal(await fs.readFile(path.join(elsewhere, "keep.txt"), "utf8"), "keep"); assert.deepEqual(await files(elsewhere), ["keep.txt"]);
});
