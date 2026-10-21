"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createCompanyCapacityRegistry } = require("./lib/company_capacity_registry.cjs");
const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
const now = () => new Date("2026-10-21T12:00:00.000Z");
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capacity-history-index-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("capacity-history-index-")); await fs.rm(root, { recursive: true, force: true }); });
  const legacyDir = path.join(root, "legacy"), indexedDir = path.join(root, "indexed");
  const companies = { a: { companyId: "a", duplicateNotes: [{ mergedCompanyId: "old-a" }] }, b: { companyId: "b" },
    "17": { companyId: "17" }, numericMaster: { companyId: 18 }, reviewed: { companyId: "reviewed", manualCorrection: { lodgingBasisTotal: 16 } } };
  const runs = ["good", "reused", "partial", "blocked", "unknown"].map(id => ({ id, collectionQuality: { status: id === "good" ? "complete" : id } }));
  const base = { productType: "lodging", inventoryEvidenceVersion: 3, runId: "good", stayDate: "2026-09-01" };
  const rows = [
    { ...base, companyKey: "a", rawTotal: 10 }, { ...base, companyKey: "old-a", rawTotal: 18, stayDate: undefined, runId: "partial" },
    { ...base, companyKey: "a", rawTotal: 999, missing: true }, { ...base, companyKey: "a", rawTotal: 800, partial: true },
    { ...base, companyKey: "a", rawTotal: 700, inventoryEvidenceVersion: undefined }, { ...base, companyKey: "a", rawTotal: 600, failed: true },
    { ...base, companyKey: "a", rawTotal: 250, runId: "blocked" }, { ...base, companyKey: "a", rawTotal: 200, runId: "unknown" },
    { ...base, companyKey: "a", rawTotal: 500, status: "unknown" }, { ...base, companyKey: "a", rawTotal: 400, stockObserved: false },
    { ...base, companyKey: "a", rawTotal: 300, responseStatus: 500 }, { ...base, companyKey: "a", rawTotal: 200, unknownUnavailable: 1 },
    { ...base, companyKey: "a", rawTotal: 9999, productType: "dayuse" }, { ...base, companyKey: "b", rawTotal: "11", runId: "reused" },
    { ...base, companyId: "b", companyKey: "a", rawTotal: 12 }, { ...base, companyKey: "b", rawTotal: 20, stayDate: "2026-09-xx" },
    { ...base, companyId: 17, companyKey: "wrong", rawTotal: 7 }, { ...base, companyId: 18, rawTotal: 99 },
    { ...base, companyKey: "orphan", rawTotal: 90 }, { ...base, placeId: "a", rawTotal: 1000 },
    { ...base, companyKey: "reviewed", rawTotal: 30 }, { ...base, companyKey: "a", rawTotal: -1 }, {},
  ];
  const encoded = rows.map(JSON.stringify).join("\n") + "\n";
  for (const directory of [legacyDir, indexedDir]) { await fs.mkdir(path.join(directory, "history"), { recursive: true }); await fs.writeFile(path.join(directory, "history/observations.jsonl"), encoded); }
  const source = path.join(indexedDir, "history/observations.jsonl"), indexFile = path.join(indexedDir, "history/observation-index.sqlite");
  const historyCache = path.join(indexedDir, "company_integrated/capacity-history-index.json"), bases = path.join(indexedDir, "company_integrated/capacity-bases.json");
  const registry = (dataDir, observationIndex) => createCompanyCapacityRegistry({ dataDir, observationIndex, now,
    observedCapacity: company => company.observed || null, reviewedCapacity: company => company.manualCorrection?.lodgingBasisTotal || null });
  return { root, legacyDir, indexedDir, companies, runs, rows, base, source, indexFile, historyCache, bases, registry,
    appendLegacy: row => fs.appendFile(path.join(legacyDir, "history/observations.jsonl"), JSON.stringify(row) + "\n") };
}

test("indexed capacity history preserves locked bases, review warnings, raw trust gates, missing dates, typed identities and current run quality", async t => {
  const f = await fixture(t), index = createHistoryObservationIndex({ file: f.source, indexFile: f.indexFile });
  try {
    const legacy = f.registry(f.legacyDir), indexed = f.registry(f.indexedDir, index), originals = structuredClone(f.companies), sourceBefore = await fs.readFile(f.source);
    let expected = await legacy.prepareCompanies(f.companies, { runs: f.runs }), actual = await indexed.prepareCompanies(f.companies, { runs: f.runs });
    assert.deepEqual(actual, expected); assert.deepEqual(f.companies, originals); assert.deepEqual(await fs.readFile(f.source), sourceBefore);
    assert.equal(actual.a._integratedCapacity.capacity, 18, "Missing-date trusted evidence still seeds capacity");
    assert.equal(actual.b._integratedCapacity.capacity, 20, "Company ID priority and invalid-date historical evidence match legacy behavior");
    assert.equal(actual["17"]._integratedCapacity.capacity, 7); assert.equal(actual.numericMaster._integratedCapacity.capacity, null, "Canonical master ID types remain unchanged");
    assert.equal(actual.reviewed._integratedCapacity.capacity, 16); assert.equal(actual.reviewed._integratedCapacity.observedMaximum, 30);
    const warm = index.stats();
    const changedRuns = f.runs.map(run => run.id === "blocked" ? { ...run, collectionQuality: { status: "complete" } } : run);
    expected = await legacy.prepareCompanies(f.companies, { runs: changedRuns }); actual = await indexed.prepareCompanies(f.companies, { runs: changedRuns });
    assert.deepEqual(actual, expected); assert.equal(actual.a._integratedCapacity.capacity, 18); assert.equal(actual.a._integratedCapacity.observedMaximum, 250);
    assert.match(actual.a._integratedCapacity.warnings[0], /250.*18/);
    assert.equal(index.stats().rowsRead, warm.rowsRead, "Run quality is applied to cached raw maxima without rereading rows");
    assert.equal(index.stats().bytesReadOriginal, warm.bytesReadOriginal);
    const merged = structuredClone(f.companies); merged.a.duplicateNotes = []; merged.b.duplicateNotes = [{ mergedCompanyId: "old-a" }, { mergedCompanyId: "orphan" }];
    expected = await legacy.prepareCompanies(merged, { runs: f.runs }); actual = await indexed.prepareCompanies(merged, { runs: f.runs });
    assert.deepEqual(actual, expected); assert.equal(actual.b._integratedCapacity.observedMaximum, 90); assert.equal(actual.b._integratedCapacity.capacity, 20);
    assert.equal(index.stats().rowsRead, warm.rowsRead, "Current merge ownership is resolved from raw references, not frozen into cache");
  } finally { await index.close(); }
});

test("restart reuses durable maxima and append only rereads the touched partition, preserving unrelated basis and cache entries", async t => {
  const f = await fixture(t); let index = createHistoryObservationIndex({ file: f.source, indexFile: f.indexFile });
  try {
    let registry = f.registry(f.indexedDir, index);
    const first = await registry.prepareCompanies(f.companies, { runs: f.runs });
    const cacheBefore = await fs.readFile(f.historyCache), cacheStat = await fs.stat(f.historyCache, { bigint: true }), basesBefore = await fs.readFile(f.bases);
    await index.close(); index = createHistoryObservationIndex({ file: f.source, indexFile: f.indexFile }); registry = f.registry(f.indexedDir, index);
    assert.deepEqual(await registry.prepareCompanies(f.companies, { runs: f.runs }), first);
    assert.equal(index.stats().sourceReads, 0); assert.equal(index.stats().rowsRead, 0); assert.equal(index.stats().bytesReadOriginal, 0);
    assert.deepEqual(await fs.readFile(f.historyCache), cacheBefore); assert.equal((await fs.stat(f.historyCache, { bigint: true })).mtimeNs, cacheStat.mtimeNs);
    const partitionsBefore = (await index.revisionPartitions()).partitions;
    const target = partitionsBefore.find(part => part.companyKey === "a" && !part.companyId && part.month === "2026-09");
    assert.ok(target);
    const newRow = { ...f.base, companyKey: "a", rawTotal: 31, observationId: "new-row" }, payload = JSON.stringify(newRow) + "\n";
    const receipt = await index.append(payload); assert.equal(receipt.indexed, true);
    const afterAppend = index.stats(), result = await registry.prepareCompanies(f.companies, { runs: f.runs });
    assert.equal(index.stats().rowsRead - afterAppend.rowsRead, target.count + 1, "Only the changed company/month raw partition is read");
    assert.equal(index.stats().bytesReadOriginal, Buffer.byteLength(payload));
    assert.equal(result.a._integratedCapacity.capacity, 18); assert.equal(result.a._integratedCapacity.observedMaximum, 31);
    assert.deepEqual(result.b, first.b); assert.deepEqual(await fs.readFile(f.bases), basesBefore, "Existing locked basis records are not rewritten by a larger unreviewed observation");
    const oldParts = new Map(JSON.parse(cacheBefore).partitions.map(part => [part.key, part]));
    const nextParts = JSON.parse(await fs.readFile(f.historyCache)).partitions;
    for (const part of nextParts) if (part.key !== target.key) assert.deepEqual(part, oldParts.get(part.key), "Untouched compact partitions remain identical");
    const calls = index.stats(), expanded = { ...f.companies, extra: { companyId: "extra", primaryName: "새 검색어 업체" } };
    await registry.prepareCompanies(expanded, { runs: f.runs });
    assert.equal(index.stats().rowsRead, calls.rowsRead); assert.equal(index.stats().bytesReadOriginal, calls.bytesReadOriginal);
  } finally { await index.close(); }
});

test("raw rule upgrades rebuild compact maxima from SQLite while corrupt caches fail closed and preserve locked bases", async t => {
  const f = await fixture(t), index = createHistoryObservationIndex({ file: f.source, indexFile: f.indexFile });
  try {
    await f.registry(f.indexedDir, index).prepareCompanies(f.companies, { runs: f.runs });
    const original = JSON.parse(await fs.readFile(f.historyCache)), basesBefore = await fs.readFile(f.bases), counts = index.stats();
    const { checksum, ...oldBody } = original; oldBody.ruleVersion = "a".repeat(64);
    await fs.writeFile(f.historyCache, JSON.stringify({ ...oldBody, checksum: hash(oldBody) }));
    await f.registry(f.indexedDir, index).prepareCompanies(f.companies, { runs: f.runs });
    assert.ok(index.stats().rowsRead > counts.rowsRead); assert.equal(index.stats().bytesReadOriginal, counts.bytesReadOriginal);
    const good = await fs.readFile(f.historyCache); await fs.writeFile(f.historyCache, "{broken");
    const beforeError = index.stats();
    await assert.rejects(f.registry(f.indexedDir, index).prepareCompanies(f.companies, { runs: f.runs }), { code: "CAPACITY_HISTORY_INDEX_UNAVAILABLE" });
    assert.equal(index.stats().rowsRead, beforeError.rowsRead); assert.deepEqual(await fs.readFile(f.bases), basesBefore);
    assert.equal(await fs.readFile(f.historyCache, "utf8"), "{broken");
    await fs.writeFile(f.historyCache, good);
    assert.throws(() => f.registry(f.indexedDir, {}), TypeError);
  } finally { await index.close(); }
});

test("a source generation change during partition projection preserves the last verified cache and capacity bases", async t => {
  const f = await fixture(t), index = createHistoryObservationIndex({ file: f.source, indexFile: f.indexFile });
  try {
    await f.registry(f.indexedDir, index).prepareCompanies(f.companies, { runs: f.runs });
    const cacheBefore = await fs.readFile(f.historyCache), basesBefore = await fs.readFile(f.bases);
    assert.equal((await index.append(JSON.stringify({ ...f.base, companyKey: "a", rawTotal: 32 }) + "\n")).indexed, true);
    let calls = 0;
    const racing = { ...index, async ensure() {
      if (++calls === 2) await index.append(JSON.stringify({ ...f.base, companyKey: "b", rawTotal: 33 }) + "\n");
      return index.ensure();
    } };
    await assert.rejects(f.registry(f.indexedDir, racing).prepareCompanies(f.companies, { runs: f.runs }), { code: "CAPACITY_HISTORY_INDEX_UNAVAILABLE" });
    assert.deepEqual(await fs.readFile(f.historyCache), cacheBefore); assert.deepEqual(await fs.readFile(f.bases), basesBefore);
    const actual = await f.registry(f.indexedDir, index).prepareCompanies(f.companies, { runs: f.runs });
    assert.equal(actual.a._integratedCapacity.capacity, 18); assert.equal(actual.b._integratedCapacity.capacity, 20);
    assert.equal(actual.a._integratedCapacity.observedMaximum, 32); assert.equal(actual.b._integratedCapacity.observedMaximum, 33);
  } finally { await index.close(); }
});

test("removed raw partitions stop contributing maxima while the existing locked room basis remains preserved", async t => {
  const f = await fixture(t), index = createHistoryObservationIndex({ file: f.source, indexFile: f.indexFile });
  try {
    const registry = f.registry(f.indexedDir, index), original = await registry.prepareCompanies(f.companies, { runs: f.runs });
    const basesBefore = await fs.readFile(f.bases);
    const remaining = f.rows.filter(row => !["a", "old-a"].includes(String(row.companyId || row.companyKey || "")));
    await fs.writeFile(f.source, remaining.map(JSON.stringify).join("\n") + "\n");
    const actual = await registry.prepareCompanies(f.companies, { runs: f.runs });
    assert.equal(actual.a._integratedCapacity.capacity, original.a._integratedCapacity.capacity);
    assert.equal(actual.a._integratedCapacity.observedMaximum, null, "Removed raw maxima must not survive in a compact cache");
    assert.deepEqual(actual.b, original.b); assert.deepEqual(await fs.readFile(f.bases), basesBefore);
    const cached = JSON.parse(await fs.readFile(f.historyCache));
    assert.ok(cached.partitions.every(part => !["a", "old-a"].includes(part.rawCompanyId)));
    assert.equal(index.stats().rebuilt, 2, "Unrecognized source replacement is conservatively revalidated once");
  } finally { await index.close(); }
});
