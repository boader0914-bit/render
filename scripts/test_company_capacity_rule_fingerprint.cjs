"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises");
const path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const registryFile = path.join(__dirname, "lib/company_capacity_registry.cjs");
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const now = () => new Date("2026-10-21T12:00:00.000Z");

// Execute the real module source with a narrow test-only export. No production
// export, on-disk source file or actual-data snapshot is changed by a variant.
function loadRegistry(source) {
  const module = { exports: {} };
  new Function("require", "module", "exports", source + "\nmodule.exports.testRuleVersion = rawCapacityRuleVersion;")(require, module, module.exports);
  return module.exports;
}
function change(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, `Expected one rule location: ${before}`);
  return source.replace(before, after);
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capacity-semantic-fingerprint-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("capacity-semantic-fingerprint-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const companies = { a: { companyId: "a", duplicateNotes: [{ mergedCompanyId: "old-a" }] }, b: { companyId: "b" } };
  const runs = ["complete", "partial", "reused"].map(id => ({ id, collectionQuality: { status: id } }));
  const base = { productType: "lodging", inventoryEvidenceVersion: 3, runId: "complete" };
  const rows = [
    [{ ...base, companyKey: "a", rawTotal: 12 }, { ...base, companyId: "a", rawTotal: 15, inventoryEvidenceVersion: 4, runId: "reused" },
      { ...base, companyKey: "a", rawTotal: 90, failed: true }, { ...base, companyKey: "a", rawTotal: 99, productType: "dayuse" }],
    [{ ...base, companyKey: "old-a", rawTotal: 18, runId: "partial" }],
    [{ ...base, companyKey: "b", rawTotal: 1 }]
  ];
  const partitions = rows.map((value, i) => ({ key: `partition-${i}`, digest: digest(value), count: value.length, companyKey: value[0].companyKey || value[0].companyId }));
  let reads = 0, readRows = 0;
  const descriptor = { contentDigest: "e".repeat(64), generation: 1, source: { signature: "tiny-saved-source" } };
  const observationIndex = {
    async ensure() { return structuredClone(descriptor); },
    async revisionPartitions() { return { ...structuredClone(descriptor), partitions: structuredClone(partitions) }; },
    async readRows(query, consume) {
      assert.equal(query.parseMode, "monthly");
      const ordinal = partitions.findIndex(part => part.key === query.partitionKey); assert.ok(ordinal >= 0);
      reads++;
      for (const row of rows[ordinal]) { readRows++; consume(structuredClone(row)); }
    }
  };
  const original = path.join(root, "tiny-original.jsonl");
  await fs.writeFile(original, rows.flat().map(JSON.stringify).join("\n") + "\n", { flag: "wx" });
  const originalBytes = await fs.readFile(original);
  const cache = path.join(root, "company_integrated/capacity-history-index.json"), bases = path.join(root, "company_integrated/capacity-bases.json");
  const source = await fs.readFile(registryFile, "utf8");
  const registry = (code = source) => loadRegistry(code).createCompanyCapacityRegistry({ dataDir: root, observationIndex, now,
    observedCapacity: () => null, reviewedCapacity: () => null });
  return { root, source, companies, runs, registry, cache, bases, original, originalBytes,
    totalRows: rows.flat().length, partitionCount: partitions.length, stats: () => ({ reads, readRows }) };
}

test("raw partition fingerprint tracks every cached trust, identity, quantity, grouping and validation decision", async () => {
  const source = await fs.readFile(registryFile, "utf8"), original = loadRegistry(source).testRuleVersion();
  const mutations = [
    ["capacity-raw-partition-v2:monthly-physical-objects:per-run-max", "capacity-raw-partition-v3:monthly-physical-objects:per-run-max"],
    ["Number(value) > 0 ? Number(value) : null", "Number(value) > 1 ? Number(value) : null"],
    ["Number(row.inventoryEvidenceVersion) >= 3", "Number(row.inventoryEvidenceVersion) >= 4"],
    ["function rawCompanyIdentity(row) { return String(row.companyId || row.companyKey || \"\"); }", "function rawCompanyIdentity(row) { return String(row.companyKey || row.companyId || \"\"); }"],
    ["Number.isSafeInteger(part.count) || part.count < 1", "Number.isSafeInteger(part.count) || part.count < 2"],
    ["parseMode: \"monthly\", partitionKey: part.key", "parseMode: \"detail\", partitionKey: part.key"],
    ["rawCompanyIdentity(row) !== rawCompanyId", "rawCompanyIdentity(row) === rawCompanyId"],
    ["if (row.productType !== \"lodging\" || !trustedRawQuantity(row)) return;", "if (row.productType !== \"dayuse\" || !trustedRawQuantity(row)) return;"],
    ["const quantity = positive(row.rawTotal); if (!quantity) return;", "const quantity = positive(row.supply); if (!quantity) return;"],
    ["const runId = String(row.runId || \"\"); maxima.set", "const runId = String(row.batchId || \"\"); maxima.set"],
    ["Math.max(maxima.get(runId) || 0, quantity)", "Math.min(maxima.get(runId) || 0, quantity)"],
    ["if (rows !== part.count) throw historyFault();", "if (rows > part.count) throw historyFault();"],
    ["runs: [...maxima].sort((a, b) => a[0].localeCompare(b[0]))", "runs: [...maxima].sort((a, b) => b[0].localeCompare(a[0]))"]
  ];
  for (const [before, after] of mutations) assert.notEqual(loadRegistry(change(source, before, after)).testRuleVersion(), original, before);
});

test("unrelated lifecycle edits and LF/CRLF transport reuse the exact durable cache after restart", async t => {
  const f = await fixture(t), first = await f.registry().prepareCompanies(f.companies, { runs: f.runs });
  const before = await fs.readFile(f.cache), stat = await fs.stat(f.cache, { bigint: true }), reads = f.stats();
  const edited = change(f.source,
    "chain = task.then(() => undefined, () => undefined);",
    "chain = task.then(function completed() {}, function failed() {});");
  const variants = [edited, "// Unrelated registry lifecycle documentation.\n" + f.source, f.source.replace(/\r?\n/g, "\r\n")];
  for (const code of variants) {
    assert.deepEqual(await f.registry(code).prepareCompanies(f.companies, { runs: f.runs }), first);
    assert.deepEqual(f.stats(), reads, "Fresh factories must not reread raw rows after unrelated code transport/lifecycle changes");
    assert.deepEqual(await fs.readFile(f.cache), before);
    assert.equal((await fs.stat(f.cache, { bigint: true })).mtimeNs, stat.mtimeNs);
  }
  assert.deepEqual(await fs.readFile(f.original), f.originalBytes);
});

test("the first semantic-version transition rebuilds every old partition without accepting an old whole-file rule hash", async t => {
  const f = await fixture(t), first = await f.registry().prepareCompanies(f.companies, { runs: f.runs });
  const saved = JSON.parse(await fs.readFile(f.cache, "utf8")), { checksum, ...body } = saved;
  // Actual preceding 0c LF whole-file rule hash. It is never an allowlist entry.
  body.ruleVersion = "6665aea5b80c9cb2112aadda6d3ef544ecd169de240d818e48118ded60d67496";
  await fs.writeFile(f.cache, JSON.stringify({ ...body, checksum: digest(body) }));
  const reads = f.stats(), bases = await fs.readFile(f.bases);
  assert.deepEqual(await f.registry().prepareCompanies(f.companies, { runs: f.runs }), first);
  assert.equal(f.stats().reads - reads.reads, f.partitionCount);
  assert.equal(f.stats().readRows - reads.readRows, f.totalRows);
  assert.notEqual(JSON.parse(await fs.readFile(f.cache, "utf8")).ruleVersion, body.ruleVersion);
  assert.deepEqual(await fs.readFile(f.bases), bases, "Version migration preserves existing locked room counts and history");
  assert.deepEqual(await fs.readFile(f.original), f.originalBytes);
});

test("changed raw trust rebuilds maxima while preserving previously locked capacity", async t => {
  const f = await fixture(t), first = await f.registry().prepareCompanies(f.companies, { runs: f.runs });
  assert.equal(first.a._integratedCapacity.observedMaximum, 18); assert.equal(first.b._integratedCapacity.observedMaximum, 1);
  const bases = await fs.readFile(f.bases), reads = f.stats();
  const changedTrust = change(f.source, "Number(row.inventoryEvidenceVersion) >= 3", "Number(row.inventoryEvidenceVersion) >= 4");
  const afterTrust = await f.registry(changedTrust).prepareCompanies(f.companies, { runs: f.runs });
  assert.equal(afterTrust.a._integratedCapacity.observedMaximum, 15);
  assert.equal(afterTrust.a._integratedCapacity.capacity, 18);
  assert.equal(afterTrust.b._integratedCapacity.observedMaximum, null); assert.equal(afterTrust.b._integratedCapacity.capacity, 1);
  assert.equal(f.stats().reads - reads.reads, f.partitionCount);
  assert.deepEqual(await fs.readFile(f.bases), bases);
  assert.deepEqual(await fs.readFile(f.original), f.originalBytes);
});
