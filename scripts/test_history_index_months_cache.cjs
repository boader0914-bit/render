"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createHistoryIndexMonthsCache } = require("./lib/history_index_months_cache.cjs");
const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
const { readHistoryIndexMonths } = require("./lib/history_index_months.cjs");
async function fixture(t) {
  const root = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-months-cache-")));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("staydatalab-months-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexFile = path.join(root, "index.sqlite");
  return { root, indexFile, cacheFile: indexFile + ".months-v1.json" };
}
const input = f => ({ indexFile: f.indexFile, sourceFile: path.join(f.root, "observations.jsonl"), expectedSignature: "123:456:789:10:11", sourceFingerprint: "a".repeat(64), queryFingerprint: "b".repeat(64) });

test("exact month cache persists across instances and caller mutations cannot change it", async t => {
  const f = await fixture(t); let calls = 0;
  const query = async () => { calls++; return ["2026-11", "2026-09"]; };
  const first = await createHistoryIndexMonthsCache().getOrRead({ ...input(f), query }); first.push("2026-08");
  const cache = createHistoryIndexMonthsCache();
  assert.deepEqual(await cache.getOrRead({ ...input(f), query }), ["2026-11", "2026-09"]);
  assert.equal(calls, 1); assert.equal(cache.status().hits, 1);
});
test("index, source and exact query changes invalidate the selector independently", async t => {
  const f = await fixture(t); let calls = 0; const query = async () => { calls++; return ["2026-11"]; };
  const cache = createHistoryIndexMonthsCache(); await cache.getOrRead({ ...input(f), query });
  for (const field of ["expectedSignature", "sourceFingerprint", "queryFingerprint"]) {
    const changed = field === "expectedSignature" ? "124:456:789:10:11" : "c".repeat(64);
    await cache.getOrRead({ ...input(f), [field]: changed, query });
  }
  assert.equal(calls, 4);
});
test("corrupt, duplicate, unordered, sparse and oversized cache entries never supply months", async t => {
  const f = await fixture(t); const cache = createHistoryIndexMonthsCache(); let calls = 0;
  const query = async () => { calls++; return ["2026-11"]; };
  await cache.getOrRead({ ...input(f), query });
  for (const content of ["{}", "x".repeat(2 * 1024 * 1024 + 1)]) {
    await fs.writeFile(f.cacheFile, content); assert.deepEqual(await cache.getOrRead({ ...input(f), query }), ["2026-11"]);
  }
  assert.equal(calls, 3);
  for (const months of [["2026-11", "2026-11"], ["2026-09", "2026-11"], ["2026-13"], new Array(1)]) {
    await assert.rejects(cache.getOrRead({ ...input(f), expectedSignature: String(calls++), query: async () => months }), { code: "HISTORY_OBSERVATION_INDEX_INVALID" });
  }
});
test("a cache hardlink is a miss and replacement leaves the linked file untouched", async t => {
  const f = await fixture(t); const original = path.join(f.root, "untouched.json");
  await fs.writeFile(original, "untouched"); await fs.link(original, f.cacheFile);
  let calls = 0; assert.deepEqual(await createHistoryIndexMonthsCache().getOrRead({ ...input(f), query: async () => { calls++; return []; } }), []);
  assert.equal(calls, 1); assert.equal(await fs.readFile(original, "utf8"), "untouched");
});
test("failed replacement preserves old complete cache; failed query never replaces it", async t => {
  const f = await fixture(t); const first = createHistoryIndexMonthsCache();
  await first.getOrRead({ ...input(f), query: async () => ["2026-11"] }); const before = await fs.readFile(f.cacheFile);
  const broken = createHistoryIndexMonthsCache({ fileSystem: { ...fs, rename: async () => { throw Error("synthetic rename failure"); } } });
  assert.deepEqual(await broken.getOrRead({ ...input(f), expectedSignature: "changed", query: async () => ["2026-12"] }), ["2026-12"]);
  assert.deepEqual(await fs.readFile(f.cacheFile), before);
  await assert.rejects(first.getOrRead({ ...input(f), expectedSignature: "changed", query: async () => { throw Error("read failed"); } }), /read failed/);
  assert.deepEqual(await fs.readFile(f.cacheFile), before);
});
test("real index restart reuses exact months; source append still runs query and preserves original", async t => {
  const f = await fixture(t), file = path.join(f.root, "observations.jsonl");
  const old = JSON.stringify({ id: "a", companyId: "company-a", date: "2026-09-01" }) + "\n";
  await fs.writeFile(file, old);
  let index = createHistoryObservationIndex({ file, indexFile: f.indexFile });
  const began = readHistoryIndexMonths.status().started;
  try { assert.deepEqual(await index.listMonths(), ["2026-09"]); } finally { await index.close(); }
  const first = readHistoryIndexMonths.status().started; assert.equal(first, began + 1);
  index = createHistoryObservationIndex({ file, indexFile: f.indexFile });
  try {
    assert.deepEqual(await index.listMonths(), ["2026-09"]); assert.equal(readHistoryIndexMonths.status().started, first);
    const next = JSON.stringify({ id: "b", companyId: "company-a", stayDate: "2026-11-01" }) + "\n";
    await fs.appendFile(file, next);
    assert.deepEqual(await index.listMonths(), ["2026-11", "2026-09"]); assert.equal(readHistoryIndexMonths.status().started, first + 1);
    assert.equal(await fs.readFile(file, "utf8"), old + next);
  } finally { await index.close(); }
});
test("source named like the cache destination remains byte-identical across repeated month reads", async t => {
  const f = await fixture(t), file = f.cacheFile;
  const original = JSON.stringify({ companyId: "company-a", date: "2026-09-01" }) + "\n";
  await fs.writeFile(file, original);
  const index = createHistoryObservationIndex({ file, indexFile: f.indexFile });
  try {
    assert.deepEqual(await index.listMonths(), ["2026-09"]);
    assert.deepEqual(await index.listMonths(), ["2026-09"]);
    assert.equal(await fs.readFile(file, "utf8"), original);
  } finally { await index.close(); }
});
test("a source parent alias to the destination disables cache writes", async t => {
  const f = await fixture(t), alias = path.join(f.root, "alias"), actual = path.join(f.root, "actual");
  await fs.mkdir(actual); await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
  const indexFile = path.join(actual, "index.sqlite"), sourceFile = path.join(alias, "index.sqlite.months-v1.json");
  await fs.writeFile(sourceFile, "original bytes"); let calls = 0;
  await createHistoryIndexMonthsCache().getOrRead({ ...input(f), indexFile, sourceFile, query: async () => { calls++; return ["2026-09"]; } });
  assert.equal(calls, 1); assert.equal(await fs.readFile(sourceFile, "utf8"), "original bytes");
});
