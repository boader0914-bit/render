"use strict";
// Synthetic saved inputs only. Compare indexed readers with the established
// JSONL adapter, including diagnostics and physical winner ordering.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"),
  os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "indexed-month-sources-"));
  const file = path.join(root, "history", "observations.jsonl"), indexFile = path.join(root, "history", "indexes", "observations.sqlite");
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.mkdir(path.join(root, "company_master"));
  const company = (id, place, extra = {}) => ({ companyId: id, primaryName: id, placeIds: [place], addresses: ["경기도 포천시"],
    keywords: { q: { keyword: "모의글램핑", runs: [{ runId: "r1", collectedAt: "2026-09-01T00:00:00Z", rank: 1 }] } }, ...extra });
  const companies = { a: company("a", "100", { duplicateNotes: [{ mergedCompanyId: "old_a" }],
    inventory: { latest: { runId: "r1", collectedAt: "2026-09-01T00:00:00Z", productSnapshot: { daily: [{ stayDate: "2026-09-07", productType: "lodging", supply: 16, sold: 1 }] } } } }),
    b: company("b", "200"), c: company("c", "300"), d: company("d", "300") };
  const master = path.join(root, "company_master", "companies.json"); await fs.writeFile(master, JSON.stringify({ companies }));
  const regionMasterFile = path.join(root, "regions.json"); await fs.writeFile(regionMasterFile, JSON.stringify({ units: [
    { active: true, selectable: true, level: "local", regionKey: "pocheon", name: "포천시", fullName: "경기도 포천시" }
  ] }));
  const observation = (extra = {}) => ({ observationId: "obs", companyKey: "a", companyId: "a", companyName: "a", runId: "r1",
    keyword: "모의글램핑", collectedAt: "2026-09-01T00:00:00Z", stayDate: "2026-09-03", productType: "lodging", inventoryEvidenceVersion: 4,
    supply: 16, sold: 0, publicBookings: 0, publicRevenue: 0, estimatedRevenue: 0, ...extra });
  const lines = ["\uFEFF" + JSON.stringify(observation()), JSON.stringify(observation({ sold: 4 })),
    JSON.stringify(observation({ companyKey: "b", companyId: "b", sold: 5 })),
    JSON.stringify(observation({ companyKey: " old_ a ", companyId: "none", stayDate: "2026-09-04", sold: 2 })),
    JSON.stringify(observation({ companyKey: "unknown", companyId: "a", stayDate: "2026-09-05" })),
    JSON.stringify(observation({ companyKey: "cmp_place_100", companyId: "none", stayDate: "2026-09-06", sold: 3 })),
    JSON.stringify(observation({ companyKey: "100", companyId: "none", stayDate: "2026-09-08" })),
    JSON.stringify(observation({ companyKey: "c", companyId: "c", stayDate: "2026-09-09" })),
    JSON.stringify(observation({ companyKey: "unmatched", companyId: "none", stayDate: "2026-09-10" })),
    JSON.stringify(observation({ stayDate: "2026-09-xx", missing: true })),
    "\uFEFF" + JSON.stringify(observation({ stayDate: "2026-09-11", partial: true })), "null", "[]", "{partial", "", "  ",
    JSON.stringify(observation({ stayDate: "2026-08-03" }))];
  // Outside-period payloads must never be decoded for a company/month read.
  for (let i = 0; i < 2000; i++) lines.push(JSON.stringify(observation({ observationId: "older-" + i, companyKey: "b", stayDate: "2025-01-03", payload: "x".repeat(512) })));
  await fs.writeFile(file, lines.join("\r\n"));
  const original = await fs.readFile(file), masterBefore = await fs.readFile(master);
  const index = createHistoryObservationIndex({ file, indexFile });
  const common = { dataDir: root, regionMasterFile, listRuns: async () => [{ id: "r1", keyword: "모의글램핑", collectedAt: "2026-09-01T00:00:00Z", collectionQuality: { status: "complete" } }], capacityForCompany: () => 16 };
  const legacy = createMonthlyReportSources(common), indexed = createMonthlyReportSources({ ...common, observationIndex: index });
  t.after(async () => { await index.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file, index, legacy, indexed, observation, original, master, masterBefore };
}
test("company/month indexed rows preserve quantities, physical winners, conflicts and global diagnostics", async t => {
  const f = await fixture(t); const request = { type: "company", targetId: "a", month: "2026-09", cutoffDate: "2026-09-30" };
  const expected = await f.legacy.loadSources(request), actual = await f.indexed.loadSources(request);
  assert.deepEqual(actual, expected);
  assert.deepEqual(buildMonthlyReportSnapshot(request, actual, "2026-10-21T00:00:00Z"), buildMonthlyReportSnapshot(request, expected, "2026-10-21T00:00:00Z"));
  assert.equal(actual.globalDiagnostics.malformedHistoryLines, 3);
  assert.equal(actual.observations.find(row => row.stayDate === "2026-09-03").sold, 4, "monthly uses physical keys, not global observation-ID winners");
  assert.ok(actual.observations.some(row => row.stayDate === "2026-09-xx" && row.missing), "invalid attempts remain available for quality decisions");
  const before = f.index.stats(); await f.indexed.loadSources(request); const after = f.index.stats();
  assert.equal(after.bytesReadOriginal, before.bytesReadOriginal, "unchanged reuse never reopens original history bodies");
  assert.equal(after.headersRead, before.headersRead, "global identity diagnostics use compact partition counts rather than every history row");
  assert.deepEqual(await fs.readFile(f.file), f.original); assert.deepEqual(await fs.readFile(f.master), f.masterBefore);
});
test("industry, region, keyword and month selectors match the established source adapter", async t => {
  const f = await fixture(t);
  for (const [type, targetId] of [["industry", "__industry_all__"], ["region", "pocheon"], ["keyword", "모의글램핑"], ["company", "b"]]) {
    const request = { type, targetId, month: "2026-09", cutoffDate: "2026-09-30" };
    assert.deepEqual(await f.indexed.loadSources(request), await f.legacy.loadSources(request), type);
  }
  assert.deepEqual(await f.indexed.options(), await f.legacy.options());
});
test("a proven append reads the new tail, preserves originals and immediately exposes a new keyword/company month", async t => {
  const f = await fixture(t); await f.index.ensure(); const before = f.index.stats();
  const row = f.observation({ observationId: "new-keyword", companyKey: "b", companyId: "b", keyword: "새키워드", stayDate: "2026-10-25" });
  const payload = "\n" + JSON.stringify(row) + "\n";
  const saved = await f.index.append(payload); assert.equal(saved.indexed, true);
  const bytes = await fs.readFile(f.file); assert.deepEqual(bytes, Buffer.concat([f.original, Buffer.from(payload)]));
  assert.equal(sha(bytes.subarray(0, f.original.length)), sha(f.original));
  const request = { type: "company", targetId: "b", month: "2026-10", cutoffDate: "2026-10-31" };
  assert.deepEqual(await f.indexed.loadSources(request), await f.legacy.loadSources(request));
  assert.ok(f.index.stats().bytesReadOriginal - before.bytesReadOriginal < 4096, "normal append does not scan the accumulated original history");
  assert.ok((await f.indexed.options()).months.includes("2026-10"));
});
test("derived-index failures are explicit and do not alter the original or a previously good aggregate", async t => {
  const f = await fixture(t), request = { type: "company", targetId: "a", month: "2026-09", cutoffDate: "2026-09-30" };
  const lastGood = await f.indexed.loadSources(request);
  const failing = createMonthlyReportSources({ dataDir: f.root, regionMasterFile: path.join(f.root, "regions.json"), listRuns: async () => [],
    observationIndex: { ensure: async () => { throw Object.assign(new Error("index not verified"), { code: "HISTORY_INDEX_UNAVAILABLE" }); } } });
  await assert.rejects(failing.loadSources(request));
  assert.deepEqual(await fs.readFile(f.file), f.original); assert.equal(lastGood.observations.find(row => row.stayDate === "2026-09-03").sold, 4);
});
