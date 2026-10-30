"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { pruneKeywordMonthlyRefreshGenerations: prune } = require("./lib/keyword_monthly_refresh_retention.cjs");
const digest = b => crypto.createHash("sha256").update(b).digest("hex"), gen = n => n.toString(16).padStart(32, "0");
const write = async (file, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 }); return { bytes, sha256: digest(bytes) }; };
async function fixture(t, { current = 4, auto = [1, 2, 3, 4] } = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-retention-test-"));
  // Every recursive test cleanup is confined to the exact verified mkdtemp root.
  const realParent = await fs.realpath(parent); assert.equal(path.resolve(realParent), path.resolve(parent));
  t.after(async () => { assert.equal(await fs.realpath(parent), realParent); await fs.rm(realParent, { recursive: true, force: true }); });
  const root = path.join(parent, "keyword_monthly_analysis"); await fs.mkdir(root, { mode: 0o700 }); await fs.mkdir(path.join(root, "generations")); await fs.mkdir(path.join(root, "refresh-receipts"));
  const generations = new Map();
  for (const n of [...new Set([0, ...auto, current])]) {
    const generation = gen(n), directory = path.join(root, "generations", generation), at = `2026-10-${String(n + 1).padStart(2, "0")}T00:00:00.000Z`;
    await fs.mkdir(directory); await fs.mkdir(path.join(directory, "partitions"));
    const projection = Buffer.from(JSON.stringify({ schemaVersion: 1, test: "immutable derived data", n })), scope = digest("scope" + n);
    const index = { schemaVersion: 1, calculationVersion: "keyword-monthly-v1", sourceFingerprint: digest("source" + n), keywords: [{ keyword: "경남글램핑", scopes: [{ scopeKey: scope, sha256: digest(projection), bytes: projection.length }] }] };
    const indexBytes = Buffer.from(JSON.stringify(index)), key = digest(indexBytes), partition = path.join(directory, "partitions", key); await fs.mkdir(partition); await fs.mkdir(path.join(partition, "projections"));
    await write(path.join(partition, "index.json"), indexBytes); const projectionFile = path.join(partition, "projections", scope + ".json"); await write(projectionFile, projection);
    const catalog = { schemaVersion: 1, kind: "keyword_monthly_partition_bundle", createdAt: at, partitions: [{ key, indexSha256: key, indexBytes: indexBytes.length }], scopes: [{ keyword: "경남글램핑", month: "2026-10", partition: key }] };
    const catalogRead = await write(path.join(directory, "catalog.json"), catalog);
    const pointer = { schemaVersion: 1, generation, catalogSha256: catalogRead.sha256, catalogBytes: catalogRead.bytes.length, publishedAt: at }, pointerBytes = Buffer.from(JSON.stringify(pointer));
    const publication = { schemaVersion: 1, status: "published", generation, bundleDir: root, pointerSha256: digest(pointerBytes), catalogSha256: catalogRead.sha256,
      previousPointerSha256: auto.includes(n) ? digest(generations.get(n - 1)?.pointerBytes || Buffer.from("prior")) : null,
      fixedValidationClock: at, sourceProvenancePreserved: true, originalEnvelopesRewritten: false, providerCalls: 0, collectorStarted: false, kosisReadOrChanged: false };
    const publicationRead = await write(path.join(directory, "publication-receipt.json"), publication);
    let receiptFile = null;
    if (auto.includes(n)) {
      const runId = "run-" + n, manifestSha256 = digest("manifest" + n), keyword = "경남글램핑", sourceKey = digest(JSON.stringify(["keyword-monthly-completed-run-v1", runId, manifestSha256, keyword]));
      receiptFile = path.join(root, "refresh-receipts", "complete-" + sourceKey + ".json");
      await write(receiptFile, { schemaVersion: 1, status: "published", mode: "live", generatedBy: "keyword_monthly_completed_run_refresh", refreshVersion: "keyword-monthly-completed-run-v1", trigger: "completed_collection_postprocess", jobId: crypto.randomUUID(), sourceKey, runId, manifestSha256, keyword,
        previousPointerSha256: publication.previousPointerSha256, providerCalls: 0, sourceWrites: 0, fixtureOnly: true, strictIsolationVerified: false, executionBasis: "injected_preparation_fixture_not_fresh_kernel_validation",
        generation, pointerSha256: digest(pointerBytes), catalogSha256: catalogRead.sha256, publicationReceiptSha256: publicationRead.sha256, finishedAt: at });
    }
    generations.set(n, { directory, projectionFile, receiptFile, pointer, pointerBytes, publication });
  }
  const expectedCurrentPointerSha256 = (await write(path.join(root, "current.json"), generations.get(current).pointerBytes)).sha256;
  const call = extra => prune({ projectionDir: root, expectedCurrentPointerSha256, assertLeaseHeld: async () => true, fixture: true, ...extra });
  return { root, parent, generations, expectedCurrentPointerSha256, call };
}
const exists = async p => { try { await fs.lstat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
test("prunes only older own successful auto generations and preserves current, newest two, manual and all proofs", async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.root, "current.json")), result = await f.call();
  assert.equal(result.status, "complete"); assert.deepEqual(result.deleted.map(x => x.generation).sort(), [gen(1), gen(2)]);
  for (const n of [0, 3, 4]) assert.equal(await exists(f.generations.get(n).directory), true);
  for (const n of [1, 2, 3, 4]) assert.equal(await exists(f.generations.get(n).receiptFile), true);
  assert.deepEqual(await fs.readFile(path.join(f.root, "current.json")), before); assert.equal(result.operatingPointerChanged, false); assert.equal(result.completionProofReceiptsRemoved, 0);
  const repeat = await f.call(); assert.equal(repeat.deleted.length, 0); assert.deepEqual(repeat.alreadyAbsent.sort(), [gen(1), gen(2)]);
});
test("manual current generation does not consume automatic backup retention", async t => {
  const f = await fixture(t, { current: 9 }), result = await f.call();
  assert.deepEqual(result.deleted.map(x => x.generation).sort(), [gen(1), gen(2)]);
  for (const n of [0, 3, 4, 9]) assert.equal(await exists(f.generations.get(n).directory), true);
});
test("an explicit larger backup count keeps the additional previous auto generation", async t => {
  const f = await fixture(t), result = await f.call({ keepSuccessfulAuto: 3 }); assert.deepEqual(result.deleted.map(x => x.generation), [gen(1)]);
});
test("foreign completed receipts and foreign generation entries are preserved without being followed", async t => {
  const f = await fixture(t); const original = JSON.parse(await fs.readFile(f.generations.get(1).receiptFile, "utf8")); original.generatedBy = "manual_export"; await fs.writeFile(f.generations.get(1).receiptFile, JSON.stringify(original));
  const outside = path.join(f.parent, "unrelated-originals"); await fs.mkdir(outside); await write(path.join(outside, "do-not-remove.json"), { original: true });
  const foreignLink = path.join(f.root, "generations", "a".repeat(32)); await fs.symlink(outside, foreignLink, process.platform === "win32" ? "junction" : "dir");
  const result = await f.call(); assert.deepEqual(result.deleted.map(x => x.generation), [gen(2)]); assert.equal(await exists(f.generations.get(1).directory), true); assert.equal(await exists(path.join(outside, "do-not-remove.json")), true);
});
test("wrong namespace, missing lease, malformed pointer and active publication lock do not delete", async t => {
  const f = await fixture(t);
  await assert.rejects(f.call({ projectionDir: f.parent }), e => e.code === "KEYWORD_MONTHLY_RETENTION_OPTIONS_INVALID");
  await assert.rejects(f.call({ assertLeaseHeld: async () => false }), e => e.code === "KEYWORD_MONTHLY_RETENTION_LEASE_NOT_HELD");
  await assert.rejects(f.call({ expectedCurrentPointerSha256: "f".repeat(64) }), e => e.code === "KEYWORD_MONTHLY_RETENTION_POINTER_CHANGED");
  await write(path.join(f.root, "publish.lock"), { owner: "different publisher" });
  await assert.rejects(f.call(), e => e.code === "KEYWORD_MONTHLY_RETENTION_PUBLICATION_LOCKED");
  assert.equal(await exists(f.generations.get(1).directory), true); assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, "publish.lock"))), { owner: "different publisher" });
});
test("own generation path traversal or malformed receipt fails closed", async t => {
  const f = await fixture(t), file = f.generations.get(1).receiptFile, own = JSON.parse(await fs.readFile(file)); own.generation = "../../outputs"; await fs.writeFile(file, JSON.stringify(own));
  await assert.rejects(f.call(), e => e.code === "KEYWORD_MONTHLY_RETENTION_RECEIPT_INVALID"); assert.equal(await exists(f.generations.get(2).directory), true);
});
test("own generation symlink cannot redirect deletion to originals", async t => {
  const f = await fixture(t), target = f.generations.get(1), moved = path.join(f.parent, "moved-originals"); await fs.rename(target.directory, moved); await fs.symlink(moved, target.directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.call(), e => e.code === "KEYWORD_MONTHLY_RETENTION_PATH_UNSAFE"); assert.equal(await exists(path.join(moved, "catalog.json")), true); assert.equal(await exists(f.generations.get(2).directory), true);
});
test("hardlinked own projection, altered projection or unexpected file rejects the entire preflight", async t => {
  for (const variant of ["hardlink", "altered", "unexpected"]) {
    const f = await fixture(t), target = f.generations.get(1);
    if (variant === "hardlink") await fs.link(target.projectionFile, path.join(f.parent, "original-link.json"));
    if (variant === "altered") await fs.writeFile(target.projectionFile, "changed evidence");
    if (variant === "unexpected") await write(path.join(target.directory, "unexpected-original.json"), { retained: true });
    await assert.rejects(f.call(), e => /^KEYWORD_MONTHLY_RETENTION_(PATH_UNSAFE|GENERATION_HASH_MISMATCH|GENERATION_UNKNOWN_ENTRY)$/.test(e.code));
    assert.equal(await exists(f.generations.get(2).directory), true);
  }
});
test("publication receipt hash and pointer/catalog linkage are required", async t => {
  const f = await fixture(t), file = f.generations.get(1).receiptFile, own = JSON.parse(await fs.readFile(file)); own.publicationReceiptSha256 = "f".repeat(64); await fs.writeFile(file, JSON.stringify(own));
  await assert.rejects(f.call(), e => e.code === "KEYWORD_MONTHLY_RETENTION_GENERATION_HASH_MISMATCH"); assert.equal(await exists(f.generations.get(2).directory), true);
});
test("a changed current pointer after planning aborts before any deletion and does not restore or overwrite it", async t => {
  const f = await fixture(t); let calls = 0; const changed = f.generations.get(0).pointerBytes;
  await assert.rejects(f.call({ assertLeaseHeld: async () => { if (++calls === 2) await fs.writeFile(path.join(f.root, "current.json"), changed); return true; } }), e => e.code === "KEYWORD_MONTHLY_RETENTION_POINTER_CHANGED");
  assert.deepEqual(await fs.readFile(path.join(f.root, "current.json")), changed); assert.equal(await exists(f.generations.get(1).directory), true); assert.equal(await exists(path.join(f.root, "publish.lock")), false);
});
test("lease loss after planning aborts before deletion while preserving prior good/current generations", async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(f.call({ assertLeaseHeld: async () => ++calls === 1 }), e => e.code === "KEYWORD_MONTHLY_RETENTION_LEASE_NOT_HELD");
  assert.equal(await exists(f.generations.get(1).directory), true); assert.equal(await exists(f.generations.get(4).directory), true);
});
test("the initial manual baseline with no previous pointer cannot be claimed as an auto-owned generation", async t => {
  const f = await fixture(t), file = f.generations.get(1).receiptFile, own = JSON.parse(await fs.readFile(file)), initial = f.generations.get(0);
  const pub = await fs.readFile(path.join(initial.directory, "publication-receipt.json"));
  Object.assign(own, { generation: gen(0), pointerSha256: digest(initial.pointerBytes), catalogSha256: initial.pointer.catalogSha256, publicationReceiptSha256: digest(pub), previousPointerSha256: null });
  await fs.writeFile(file, JSON.stringify(own));
  await assert.rejects(f.call(), e => e.code === "KEYWORD_MONTHLY_RETENTION_RECEIPT_INVALID");
  assert.equal(await exists(initial.directory), true); assert.equal(await exists(f.generations.get(2).directory), true);
});
test("production pruning rejects injected fixture completion proofs", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t); await assert.rejects(f.call({ fixture: false }), e => e.code === "KEYWORD_MONTHLY_RETENTION_RECEIPT_INVALID");
  assert.equal(await exists(f.generations.get(1).directory), true);
});
