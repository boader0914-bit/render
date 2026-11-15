"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { pruneKeywordMonthlyRefreshGenerations: prune } = require("./lib/keyword_monthly_refresh_retention.cjs");
const digest = b => crypto.createHash("sha256").update(b).digest("hex"), gen = n => n.toString(16).padStart(32, "0");
const write = async (file, value) => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)); await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 }); return { bytes, sha256: digest(bytes) }; };
async function fixture(t, { current = 4, auto = [1, 2, 3, 4], incremental = [], incrementalVersions = {}, prepared = [] } = {}) {
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
    let resultFile = null;
    if (prepared.includes(n)) {
      const resultBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, fixture: "final derived result", generation })), resultHash = digest(resultBytes);
      await fs.mkdir(path.join(directory, "results")); resultFile = path.join(directory, "results", resultHash + ".json"); await write(resultFile, resultBytes);
      catalog.schemaVersion = 2; catalog.preparedResults = [{ keyword: "경남글램핑", month: "2026-10", cutoffDate: "2026-10-20", partition: key,
        sha256: resultHash, bytes: resultBytes.length, sourceProjectionSha256: digest(projection), sourceDigest: digest("source digest" + n), calculationFingerprint: digest("fixture engine") }];
    }
    const catalogRead = await write(path.join(directory, "catalog.json"), catalog);
    const pointer = { schemaVersion: 1, generation, catalogSha256: catalogRead.sha256, catalogBytes: catalogRead.bytes.length, publishedAt: at }, pointerBytes = Buffer.from(JSON.stringify(pointer));
    const publication = { schemaVersion: 1, status: "published", generation, bundleDir: root, pointerSha256: digest(pointerBytes), catalogSha256: catalogRead.sha256,
      previousPointerSha256: auto.includes(n) ? digest(generations.get(n - 1)?.pointerBytes || Buffer.from("prior")) : null,
      fixedValidationClock: at, sourceProvenancePreserved: true, originalEnvelopesRewritten: false, providerCalls: 0, collectorStarted: false, kosisReadOrChanged: false,
      ...(prepared.includes(n) ? { preparedResultCount: 1, calculationFingerprint: digest("fixture engine") } : {}) };
    const publicationRead = await write(path.join(directory, "publication-receipt.json"), publication);
    let receiptFile = null;
    if (auto.includes(n)) {
      const runId = "run-" + n, manifestSha256 = digest("manifest" + n), keyword = "경남글램핑", newer = incremental.includes(n),
        refreshVersion = newer ? incrementalVersions[n] || "keyword-monthly-incremental-v3" : "keyword-monthly-completed-run-v1", sourceKey = digest(JSON.stringify([refreshVersion, runId, manifestSha256, keyword]));
      receiptFile = path.join(root, "refresh-receipts", "complete-" + sourceKey + ".json");
      await write(receiptFile, { schemaVersion: 1, status: "published", mode: "live", generatedBy: newer ? "keyword_monthly_incremental_refresh" : "keyword_monthly_completed_run_refresh", refreshVersion, trigger: "completed_collection_postprocess", jobId: crypto.randomUUID(), sourceKey, runId, manifestSha256, keyword,
        previousPointerSha256: publication.previousPointerSha256, providerCalls: 0, sourceWrites: 0, fixtureOnly: !newer, strictIsolationVerified: newer,
        executionBasis: newer ? "verified_incremental_source_checkpoint_and_dirty_partition_rebuild" : "injected_preparation_fixture_not_fresh_kernel_validation",
        ...(newer ? { stateSha256: digest("state-" + n), preparationSha256: digest("preparation-" + n), incrementalValidated: true } : {}),
        generation, pointerSha256: digest(pointerBytes), catalogSha256: catalogRead.sha256, publicationReceiptSha256: publicationRead.sha256, finishedAt: at });
    }
    generations.set(n, { directory, projectionFile, resultFile, receiptFile, pointer, pointerBytes, publication });
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
test("v2 final-result files are audited by exact committed hash and removed only with proved old owned generations", async t => {
  const f = await fixture(t, { prepared: [1, 2, 4] }), currentResult = await fs.readFile(f.generations.get(4).resultFile), before = await fs.readFile(path.join(f.root, "current.json"));
  const result = await f.call(); assert.equal(result.status, "complete"); assert.deepEqual(result.deleted.map(row => row.generation).sort(), [gen(1), gen(2)]);
  for (const n of [1, 2]) { assert.equal(await exists(f.generations.get(n).resultFile), false); assert.equal(await exists(f.generations.get(n).receiptFile), true); }
  assert.deepEqual(await fs.readFile(f.generations.get(4).resultFile), currentResult); assert.deepEqual(await fs.readFile(path.join(f.root, "current.json")), before);
  assert.equal(await exists(f.generations.get(0).directory), true); assert.equal(await exists(f.generations.get(3).directory), true);
});
test("unknown, altered, missing and hardlinked v2 result artifacts hold the full cleanup before any generation removal", async t => {
  for (const variant of ["unknown", "altered", "missing", "hardlink"]) {
    const f = await fixture(t, { prepared: [1] }), target = f.generations.get(1);
    if (variant === "unknown") await write(path.join(target.directory, "results", "unproved.json"), { retain: true });
    if (variant === "altered") await fs.writeFile(target.resultFile, "changed result");
    if (variant === "missing") await fs.unlink(target.resultFile);
    if (variant === "hardlink") await fs.link(target.resultFile, path.join(f.parent, "retained-result-link.json"));
    await assert.rejects(f.call());
    assert.equal(await exists(target.directory), true, variant); assert.equal(await exists(f.generations.get(2).directory), true, variant);
    assert.equal(await exists(f.generations.get(4).directory), true, variant);
  }
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

test("mixed physical-copy and validated incremental owners share the newest-two backup policy", async t => {
  const f = await fixture(t, { incremental: [2, 4] }), before = await fs.readFile(path.join(f.root, "current.json"));
  const result = await f.call(); assert.deepEqual(result.deleted.map(row => row.generation).sort(), [gen(1), gen(2)]);
  assert.deepEqual(result.keptSuccessfulAuto.sort(), [gen(3), gen(4)]); assert.equal(result.ownCompletedReceiptCount, 4);
  for (const n of [1, 2, 3, 4]) assert.equal(await exists(f.generations.get(n).receiptFile), true);
  assert.deepEqual(await fs.readFile(path.join(f.root, "current.json")), before);
  const again = await f.call(); assert.equal(again.deleted.length, 0); assert.deepEqual(again.alreadyAbsent.sort(), [gen(1), gen(2)]);
});

test("manual current and a larger backup count preserve mixed-owner automatic generations", async t => {
  const f = await fixture(t, { incremental: [1, 3], current: 9 }), result = await f.call({ keepSuccessfulAuto: 3 });
  assert.deepEqual(result.deleted.map(row => row.generation), [gen(1)]);
  for (const n of [0, 2, 3, 4, 9]) assert.equal(await exists(f.generations.get(n).directory), true);
});

test("v3 v4 and v5 successful receipts retain their own exact version identity in the same policy", async t => {
  const f = await fixture(t, { incremental: [1, 2, 3, 4], incrementalVersions: { 2: "keyword-monthly-incremental-v4", 4: "keyword-monthly-incremental-v5" } });
  const originals = await Promise.all([1,2,3,4].map(n => fs.readFile(f.generations.get(n).receiptFile)));
  const result = await f.call(); assert.equal(result.ownCompletedReceiptCount, 4);
  assert.deepEqual(result.deleted.map(row => row.generation).sort(), [gen(1), gen(2)]);
  for (const [i,n] of [1,2,3,4].entries()) assert.deepEqual(await fs.readFile(f.generations.get(n).receiptFile), originals[i]);
});

test("new-owner recovery receipts require every incremental proof even when fixture mode is enabled", async t => {
  const variants = {
    missingState: value => { delete value.stateSha256; }, badState: value => { value.stateSha256 = "bad"; },
    missingPreparation: value => { delete value.preparationSha256; }, badPreparation: value => { value.preparationSha256 = null; },
    missingValidation: value => { delete value.incrementalValidated; }, unvalidated: value => { value.incrementalValidated = false; },
    fixtureProof: value => { value.fixtureOnly = true; }, missingIsolation: value => { delete value.strictIsolationVerified; },
    oldExecutionBasis: value => { value.executionBasis = "fresh_physical_capture_and_strict_isolated_normalization"; },
    oldVersion: value => { value.refreshVersion = "keyword-monthly-completed-run-v1"; }
  };
  for (const [name, mutate] of Object.entries(variants)) await t.test(name, async st => {
    const f = await fixture(st, { incremental: [1, 4] }), target = f.generations.get(1), value = JSON.parse(await fs.readFile(target.receiptFile));
    value.recoveredAfterRestart = true; mutate(value); await fs.writeFile(target.receiptFile, JSON.stringify(value));
    const before = await fs.readFile(path.join(f.root, "current.json"));
    await assert.rejects(f.call(), { code: "KEYWORD_MONTHLY_RETENTION_RECEIPT_INVALID" });
    for (const n of [0, 1, 2, 3, 4]) assert.equal(await exists(f.generations.get(n).directory), true);
    assert.deepEqual(await fs.readFile(path.join(f.root, "current.json")), before); assert.equal(await exists(target.receiptFile), true);
  });
});

test("new source keys bind the explicit incremental version and cannot reuse the old version identity", async t => {
  const f = await fixture(t, { incremental: [1] }), target = f.generations.get(1), value = JSON.parse(await fs.readFile(target.receiptFile));
  const oldKey = digest(JSON.stringify(["keyword-monthly-completed-run-v1", value.runId, value.manifestSha256, value.keyword]));
  assert.notEqual(oldKey, value.sourceKey); value.sourceKey = oldKey;
  const renamed = path.join(f.root, "refresh-receipts", "complete-" + oldKey + ".json"); await fs.rename(target.receiptFile, renamed); await fs.writeFile(renamed, JSON.stringify(value));
  await assert.rejects(f.call(), { code: "KEYWORD_MONTHLY_RETENTION_RECEIPT_INVALID" });
  assert.equal(await exists(target.directory), true); assert.equal(await exists(f.generations.get(2).directory), true); assert.equal(await exists(renamed), true);
});

test("incremental proof fields do not bypass existing publication and immutable projection audits", async t => {
  const f = await fixture(t, { incremental: [1, 2, 3, 4] }), target = f.generations.get(1);
  await fs.writeFile(target.projectionFile, "altered-incremental-projection");
  await assert.rejects(f.call(), { code: "KEYWORD_MONTHLY_RETENTION_GENERATION_HASH_MISMATCH" });
  assert.equal(await exists(f.generations.get(2).directory), true); assert.equal(await exists(f.generations.get(4).directory), true);
});

test("mixed-owner pruning never opens or changes private source checkpoints, outbox or original history", async t => {
  const f = await fixture(t, { incremental: [1, 3, 4] }), privateFiles = ["keyword_monthly_incremental/states/checkpoint.json", "keyword_monthly_incremental/history/source.json.gz",
    "keyword_monthly_source_delta/pending/event.json", "keyword_monthly_source_delta/complete/event.json", "company_master/companies.json", "history/observations.jsonl"];
  const before = new Map();
  for (const relative of privateFiles) { const file = path.join(f.parent, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "preserve-" + relative); before.set(file, await fs.readFile(file)); }
  const open = fs.open; fs.open = async (file, ...args) => { assert.equal(before.has(file), false, "Retention opened a source or checkpoint body"); return open(file, ...args); };
  let result; try { result = await f.call(); } finally { fs.open = open; }
  assert.deepEqual(result.deleted.map(row => row.generation).sort(), [gen(1), gen(2)]);
  for (const [file, bytes] of before) assert.deepEqual(await fs.readFile(file), bytes);
});
