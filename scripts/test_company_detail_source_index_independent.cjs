"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const { createCompanyDetailSourceIndex } = require("./lib/company_detail_source_index.cjs");
const { readScopedCompanyMaster, readScopedCompanyHistory } = require("./lib/company_detail_store.cjs");

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "detail-index-independent-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const masterFile = path.join(dataDir, "company_master/companies.json"), historyFile = path.join(dataDir, "history/observations.jsonl"),
    pointer = path.join(dataDir, "company_master/detail_source_index/current.json");
  const companies = Object.fromEntries(["one", "two", "three"].map((id, index) => [id,
    { companyId: id, primaryName: "업체" + index, aliases: ["공통별칭", "별칭" + index], duplicateNotes: [{ mergedCompanyId: "old-" + id }],
      keywords: { "[모의]검색": { runs: [{ runId: "fixed", rank: index + 1 }] } }, capacity: index + 10 }]));
  await fs.mkdir(path.dirname(masterFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.writeFile(masterFile, JSON.stringify({ companies }));
  return { dataDir, masterFile, historyFile, pointer, companies };
}
const matches = (row, company) => {
  const keys = new Set([company.companyId, company.primaryName, ...(company.aliases || []), ...(company.duplicateNotes || []).map(row => row.mergedCompanyId)]);
  return keys.has(row.companyKey) || keys.has(row.companyName);
};

test("deterministic mixed identity transitions retain exact original scoped order and values for every company", async t => {
  const f = await fixture(t), identities = ["one", "two", "three", "old-one", "old-two", "별칭0", "별칭1", "공통별칭", "unknown"];
  let seed = 0x7130;
  const random = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const rows = Array.from({ length: 1200 }, (_, index) => ({ observationId: index % 11 === 0 ? random(37) + 1 : "obs-" + random(37),
    companyKey: identities[random(identities.length)], companyName: identities[random(identities.length)],
    sold: index % 7 === 0 ? null : random(5), missing: index % 7 === 0, payload: "한글🌿\r\n" + index }));
  await fs.writeFile(f.historyFile, rows.map(row => JSON.stringify(row)).join("\r\n") + '\n{"partial');
  const original = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]);
  const index = createCompanyDetailSourceIndex({ dataDir: f.dataDir }); await index.prepare();
  for (const [id, company] of Object.entries(f.companies)) {
    assert.deepEqual(await index.readMaster(f.masterFile, id), await readScopedCompanyMaster(f.masterFile, id));
    assert.deepEqual(await index.readHistory(f.historyFile, company, matches), await readScopedCompanyHistory(f.historyFile, company, matches));
  }
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), original);
});

test("a failed replacement-generation write preserves the complete last normal pointer and source bytes", async t => {
  const f = await fixture(t); await fs.writeFile(f.historyFile, JSON.stringify({ observationId: "valid-zero", companyKey: "one", sold: 0 }) + "\n");
  await createCompanyDetailSourceIndex({ dataDir: f.dataDir }).prepare();
  const pointer = await fs.readFile(f.pointer);
  const replacement = { companies: structuredClone(f.companies) }; replacement.companies.one.capacity = 17;
  await fs.writeFile(f.masterFile, JSON.stringify(replacement));
  const inputs = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), fileSystem = Object.create(fs);
  let failed = false;
  fileSystem.writeFile = async (filename, ...args) => {
    if (String(filename).includes(path.sep + "generation_")) { failed = true; throw Object.assign(new Error("Derived storage unavailable"), { code: "ENOSPC" }); }
    return fs.writeFile(filename, ...args);
  };
  const index = createCompanyDetailSourceIndex({ dataDir: f.dataDir, fileSystem });
  await assert.rejects(index.prepare(), { code: "COMPANY_DETAIL_SOURCE_INDEX_WRITE_FAILED" });
  assert.equal(failed, true); assert.equal(index.status().ready, false);
  assert.deepEqual(await fs.readFile(f.pointer), pointer);
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), inputs);
});
