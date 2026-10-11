"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createIndustrySourceRevision } = require("./lib/industry_source_revision.cjs");

test("saved input changes include manifest edits, rank-only runs and calendar data, exclude derived outputs and context caches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "industry-revision-"));
  try {
    const outputsDir = path.join(root, "outputs"), runDir = path.join(outputsDir, "pocheon_glamping_20260801_090000");
    await fs.mkdir(runDir, { recursive: true });
    const manifest = path.join(runDir, "manifest.json");
    await fs.writeFile(manifest, JSON.stringify({ collectionQuality: { status: "complete" } }));
    const revision = createIndustrySourceRevision({ dataDir: root, outputsDir, regionMasterFile: path.join(root, "region_master.json") });
    const before = await revision();
    assert.equal(await revision(), before, "reading metadata does not change its revision");
    const directoryStat = await fs.stat(runDir);
    await fs.writeFile(manifest, JSON.stringify({ collectionQuality: { status: "blocked" } }));
    await fs.utimes(runDir, directoryStat.atime, directoryStat.mtime);
    const after = await revision();
    assert.notEqual(after, before, "manifest itself matters even if directory mtime is unchanged");
    const rankDir = path.join(outputsDir, "sacheon_glamping_20260802_090000");
    await fs.mkdir(rankDir);
    await fs.writeFile(path.join(rankDir, "manifest.json"), JSON.stringify({ counts: { overall: 20 } }));
    const rankRevision = await revision();
    assert.notEqual(rankRevision, after, "rank-only runs do not require history rows");
    await fs.mkdir(path.join(runDir, "details"));
    await fs.writeFile(path.join(runDir, "details", "product.json"), "{\"stock\":10}");
    const detailRevision = await revision();
    assert.notEqual(detailRevision, rankRevision, "product detail JSON is a source for inventory and prices");
    const tourismDir = path.join(root, "tourism_data", "cache");
    await fs.mkdir(tourismDir, { recursive: true });
    await fs.writeFile(path.join(tourismDir, "visitors.json"), "{\"value\":1}");
    assert.equal(await revision(), detailRevision, "cache-only context is reread without rebuilding lodging arithmetic");
    const calendarDir = path.join(root, "history", "special_days");
    await fs.mkdir(calendarDir, { recursive: true });
    await fs.writeFile(path.join(calendarDir, "2026.json"), "{\"holidays\":[]}");
    const contextRevision = await revision();
    assert.notEqual(contextRevision, detailRevision, "calendar inputs can affect the saved analysis");
    await fs.mkdir(path.join(root, "industry_analysis"), { recursive: true });
    await fs.writeFile(path.join(root, "industry_analysis", "queue.json"), "{}");
    await fs.mkdir(path.join(root, "company_integrated"), { recursive: true });
    await fs.writeFile(path.join(root, "company_integrated", "capacity-bases.json"), "{}");
    await fs.writeFile(path.join(runDir, "transient.tmp"), "{} ");
    assert.equal(await revision(), contextRevision, "derived writes and temp files cannot trigger a rebuild loop");
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function revisionFixture(runSpecs = [{ id: "pocheon_glamping_20260901_090000", collectedAt: "2026-09-01T00:00:00Z", checkIn: "2026-09-01", bookingRangeDays: 30 }]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "industry-period-revision-"));
  const outputsDir = path.join(root, "outputs"), masterFile = path.join(root, "company_master", "companies.json"), historyFile = path.join(root, "history", "observations.jsonl");
  await fs.mkdir(path.dirname(masterFile), { recursive: true });
  await fs.mkdir(path.dirname(historyFile), { recursive: true });
  const first = runSpecs[0];
  const observation = { companyId: "cmp_place_101", runId: first.id, stayDate: "2026-09-01", productType: "lodging", rawTotal: 10,
    supply: 10, available: 5, sold: 5, inventoryEvidenceVersion: 4, collectedAt: first.collectedAt };
  const snapshot = { runId: first.id, collectedAt: first.collectedAt, productSnapshot: { inventoryEvidenceVersion: 4, daily: [observation] } };
  const master = { schemaVersion: 1, updatedAt: first.collectedAt, sourceIndex: {}, companies: {
    cmp_place_101: { companyId: "cmp_place_101", primaryName: "포천 글램핑", placeIds: ["101"], bookingBusinessIds: ["501"],
      firstSeenAt: first.collectedAt, lastSeenAt: first.collectedAt, firstRunId: first.id, lastRunId: first.id, runIds: [first.id],
      addresses: ["경기도 포천시"], lodgingTypes: ["글램핑"], manualCorrection: null,
      keywords: { pocheon: { keyword: "포천글램핑", firstSeenAt: first.collectedAt, lastSeenAt: first.collectedAt, latestRank: 2, latestRunId: first.id,
        runs: [{ runId: first.id, collectedAt: first.collectedAt, rank: 2, overallRank: 2 }] } },
      inventory: { latest: snapshot, snapshots: [], structureCounts: {} }
    }
  } };
  async function writeMaster() { await fs.writeFile(masterFile, JSON.stringify(master)); }
  async function writeHistory(rows = [observation]) { await fs.writeFile(historyFile, rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n"); }
  async function writeRun(spec, extra = {}) {
    const dir = path.join(outputsDir, spec.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({ collectionQuality: { status: "complete" }, keyword: "포천글램핑", ...spec, ...extra }));
    return dir;
  }
  await writeMaster(); await writeHistory();
  for (const spec of runSpecs) await writeRun(spec);
  const revision = createIndustrySourceRevision({ dataDir: root, outputsDir });
  return { root, outputsDir, masterFile, historyFile, master, observation, snapshot, revision, writeMaster, writeHistory, writeRun,
    async dispose() { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); } };
}
const monthToken = (revision, month) => `${revision.globalToken}:${revision.months[month] || ""}`;

test("October collections, history, keyword exposures and new companies preserve the September revision", async () => {
  const f = await revisionFixture();
  try {
    const before = await f.revision.periodRevisions();
    const october = { id: "pocheon_glamping_20261001_090000", collectedAt: "2026-10-01T00:00:00Z", checkIn: "2026-10-01", bookingRangeDays: 31 };
    await f.writeRun(october);
    const observation = { ...f.observation, runId: october.id, collectedAt: october.collectedAt, stayDate: "2026-10-01" };
    await f.writeHistory([f.observation, observation]);
    const company = f.master.companies.cmp_place_101;
    company.lastSeenAt = october.collectedAt; company.lastRunId = october.id; company.runIds.push(october.id);
    company.keywords.pocheon.runs.unshift({ runId: october.id, collectedAt: october.collectedAt, overallRank: 1, rank: 1 });
    Object.assign(company.keywords.pocheon, { lastSeenAt: october.collectedAt, latestRunId: october.id, latestRank: 1, bestRank: 1, runCount: 2 });
    // Actual saved rollover retains the old snapshot both in archive and the
    // previousLatest pointer. It must not double-count its September digest.
    company.inventory.snapshots.push(f.snapshot); company.inventory.previousLatest = f.snapshot;
    company.inventory.latest = { runId: october.id, collectedAt: october.collectedAt,
      productSnapshot: { inventoryEvidenceVersion: 4, daily: [observation] } };
    company.inventory.structureCounts = { lodging: 2 };
    const newCompany = structuredClone(company);
    Object.assign(newCompany, { companyId: "cmp_place_202", primaryName: "새 글램핑", placeIds: ["202"], bookingBusinessIds: ["602"],
      firstSeenAt: october.collectedAt, firstRunId: october.id, runIds: [october.id], keywords: {}, inventory: {} });
    f.master.companies.cmp_place_202 = newCompany; f.master.updatedAt = october.collectedAt; f.master.sourceIndex["place:202"] = newCompany.companyId;
    await f.writeMaster();
    const after = await f.revision.periodRevisions();
    assert.equal(monthToken(after, "2026-09"), monthToken(before, "2026-09"));
    assert.equal(after.globalToken, before.globalToken);
    assert.notEqual(monthToken(after, "2026-10"), monthToken(before, "2026-10"));
    assert.equal(typeof await f.revision(), "string", "legacy caller remains a string API");
  } finally { await f.dispose(); }
});

test("past observations, missing-row repair, saved snapshots, manifests and raw product details invalidate their month", async () => {
  const f = await revisionFixture();
  try {
    let before = await f.revision.periodRevisions();
    const modified = { ...f.observation, sold: 6 };
    await f.writeHistory([modified]);
    let after = await f.revision.periodRevisions();
    assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"), "past observation edit");
    before = after;
    await f.writeHistory([modified, { ...modified, stayDate: "2026-09-02" }]);
    after = await f.revision.periodRevisions();
    assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"), "missing history recovery");
    before = after;
    f.snapshot.productSnapshot.daily[0].price = 150000;
    await f.writeMaster();
    after = await f.revision.periodRevisions();
    assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"), "snapshot price correction");
    before = after;
    const spec = { id: f.observation.runId, collectedAt: f.observation.collectedAt, checkIn: "2026-09-01", bookingRangeDays: 30 };
    const runDir = await f.writeRun(spec, { collectionQuality: { status: "blocked" } });
    after = await f.revision.periodRevisions();
    assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"), "manifest quality correction");
    before = after;
    await fs.mkdir(path.join(runDir, "details"));
    await fs.writeFile(path.join(runDir, "details", "availability.json"), JSON.stringify({ stock: 8 }));
    after = await f.revision.periodRevisions();
    assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"), "raw provider product repair");
    before = after;
    await fs.writeFile(path.join(runDir, "old_glamping_crawl_test_report.md"), "성인 2명, 1박, 체크인 2026-09-01 / 체크아웃 2026-09-02");
    after = await f.revision.periodRevisions();
    assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"), "legacy loadRun condition fallback");
    assert.equal(after.globalToken, before.globalToken);
  } finally { await f.dispose(); }
});

test("semantic DB edits propagate to referenced months while mtime and automatic summaries do not", async () => {
  const f = await revisionFixture();
  try {
    let before = await f.revision.periodRevisions();
    const company = f.master.companies.cmp_place_101;
    company.lastSeenAt = "2026-10-05T00:00:00Z"; f.master.updatedAt = company.lastSeenAt;
    await f.writeMaster();
    let after = await f.revision.periodRevisions();
    assert.deepEqual(after, before);
    const stat = await fs.stat(f.masterFile);
    await fs.utimes(f.masterFile, stat.atime, new Date(stat.mtimeMs + 5000));
    assert.deepEqual(await f.revision.periodRevisions(), after, "mtime-only master rewrite");
    for (const [field, value] of Object.entries({ manualCorrection: { active: true, lodgingBasisTotal: 9 }, manualCorrectionRevision: 1,
      addresses: ["경상남도 사천시"], lodgingTypes: ["펜션"], industryIds: ["pension"], regionId: "kr_gyeongnam_sacheon",
      bookingBusinessIds: ["999"], mergedIntoCompanyId: "cmp_place_999", deletedAt: "2026-10-05T00:00:00Z" })) {
      before = after; company[field] = value; await f.writeMaster(); after = await f.revision.periodRevisions();
      assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"), field);
    }
    before = after; delete f.master.companies.cmp_place_101; await f.writeMaster(); after = await f.revision.periodRevisions();
    assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"), "hard company deletion");
  } finally { await f.dispose(); }
});

test("new identity conflicts and merge aliases also invalidate the other company's historical month", async () => {
  const f = await revisionFixture();
  try {
    const before = await f.revision.periodRevisions();
    f.master.companies.october = { companyId: "cmp_place_202", primaryName: "10월 신규", firstSeenAt: "2026-10-01T00:00:00Z", placeIds: ["101"],
      keywords: {}, inventory: {}, addresses: ["경기도 포천시"], lodgingTypes: ["글램핑"] };
    await f.writeMaster();
    const collision = await f.revision.periodRevisions();
    assert.notEqual(monthToken(collision, "2026-09"), monthToken(before, "2026-09"));
    f.master.companies.october.placeIds = ["202"];
    f.master.companies.october.duplicateNotes = [{ mergedCompanyId: "cmp_place_101" }];
    await f.writeMaster();
    const merged = await f.revision.periodRevisions();
    assert.notEqual(monthToken(merged, "2026-09"), monthToken(collision, "2026-09"));
    assert.equal(merged.globalToken, before.globalToken, "conflict propagation is still month scoped");
  } finally { await f.dispose(); }
});

test("run scope includes collection month, a cross-month reservation span, and referenced history months", async () => {
  const spec = { id: "pocheon_glamping_20260831_090000", collectedAt: "2026-08-31T00:00:00Z", checkIn: "2026-08-31", bookingRangeDays: 32 };
  const f = await revisionFixture([spec]);
  try {
    await f.writeHistory([f.observation, { ...f.observation, stayDate: "2026-11-01" }]);
    const before = await f.revision.periodRevisions();
    await f.writeRun(spec, { collectionQuality: { status: "partial" } });
    const after = await f.revision.periodRevisions();
    for (const month of ["2026-08", "2026-09", "2026-10", "2026-11"]) assert.notEqual(monthToken(after, month), monthToken(before, month), month);
    assert.equal(monthToken(after, "2026-12"), monthToken(before, "2026-12"));
  } finally { await f.dispose(); }
});

test("unknown run spans, malformed history and unscoped source rows conservatively change the global token", async () => {
  const f = await revisionFixture();
  try {
    let before = await f.revision.periodRevisions();
    await f.writeRun({ id: "sacheon_glamping_20261001_090000", collectedAt: "2026-10-01T00:00:00Z", checkIn: "2026-10-01" });
    let after = await f.revision.periodRevisions();
    assert.notEqual(after.globalToken, before.globalToken, "no explicit booking span");
    before = after;
    await f.writeHistory([f.observation, "{broken"]);
    after = await f.revision.periodRevisions();
    assert.notEqual(after.globalToken, before.globalToken);
    before = after;
    await f.writeHistory([f.observation, "{broken", "{broken"]);
    after = await f.revision.periodRevisions();
    assert.notEqual(after.globalToken, before.globalToken, "malformed duplicate count is meaningful");
    before = after;
    await f.writeHistory([f.observation, { companyId: "cmp_place_101", sold: 7 }]);
    after = await f.revision.periodRevisions();
    assert.notEqual(after.globalToken, before.globalToken, "unscoped history edit");
  } finally { await f.dispose(); }
});

test("calendar year changes affect its months and the preceding December; semantic region mtime changes are stable", async () => {
  const f = await revisionFixture();
  try {
    const calendarDir = path.join(f.root, "history", "special_days");
    await fs.mkdir(calendarDir, { recursive: true });
    await fs.writeFile(path.join(calendarDir, "2026.json"), "{\"holidays\":[]}");
    const regionFile = path.join(f.root, "region_master.json");
    await fs.writeFile(regionFile, "{\"schemaVersion\":1,\"units\":[]}");
    const revision = createIndustrySourceRevision({ dataDir: f.root, outputsDir: f.outputsDir, regionMasterFile: regionFile });
    const before = await revision.periodRevisions();
    await fs.writeFile(regionFile, "{ \"units\": [], \"schemaVersion\": 1 }");
    assert.deepEqual(await revision.periodRevisions(), before);
    await fs.writeFile(path.join(calendarDir, "special-days-2027.json"), "{\"holidays\":[]}");
    const after = await revision.periodRevisions();
    assert.equal(monthToken(after, "2026-09"), monthToken(before, "2026-09"));
    assert.notEqual(monthToken(after, "2026-12"), monthToken(before, "2026-12"));
    assert.notEqual(monthToken(after, "2027-01"), monthToken(before, "2027-01"));
    await fs.writeFile(regionFile, "{\"schemaVersion\":2,\"units\":[]}");
    assert.notEqual((await revision.periodRevisions()).globalToken, after.globalToken);
  } finally { await f.dispose(); }
});

test("history uses a stream, unchanged reads share its cached summary, and concurrent calls share the scan", async () => {
  const f = await revisionFixture();
  const nativeFs = require("node:fs"), originalStream = nativeFs.createReadStream, originalRead = fs.readFile;
  let historyStreams = 0, wholeHistoryReads = 0;
  try {
    await f.writeHistory(Array.from({ length: 20000 }, (_, index) => ({ ...f.observation, stayDate: `2026-${index % 2 ? "10" : "09"}-01`, available: index % 10 })));
    nativeFs.createReadStream = function(file, options) { if (file === f.historyFile) historyStreams++; return originalStream.call(this, file, options); };
    fs.readFile = function(file, ...rest) { if (file === f.historyFile) wholeHistoryReads++; return originalRead.call(this, file, ...rest); };
    const firstTask = f.revision.periodRevisions();
    assert.equal(f.revision.periodRevisions(), firstTask);
    const before = await firstTask;
    assert.deepEqual(await f.revision.periodRevisions(), before);
    assert.equal(historyStreams, 1); assert.equal(wholeHistoryReads, 0);
    const stat = await fs.stat(f.historyFile);
    await fs.utimes(f.historyFile, stat.atime, new Date(stat.mtimeMs + 5000));
    assert.deepEqual(await f.revision.periodRevisions(), before, "mtime-only history edit changes no semantic month");
    assert.equal(historyStreams, 2); assert.equal(wholeHistoryReads, 0);
  } finally { nativeFs.createReadStream = originalStream; fs.readFile = originalRead; await f.dispose(); }
});

test("snapshot and product trust flags participate in month input revisions", async () => {
  const f = await revisionFixture();
  try {
    let before = await f.revision.periodRevisions();
    for (const [target, flag, value] of [[f.snapshot, "failed", true], [f.snapshot, "failed", false],
      [f.snapshot.productSnapshot, "partial", true], [f.snapshot.productSnapshot, "queryAttempted", false]]) {
      target[flag] = value; await f.writeMaster();
      const after = await f.revision.periodRevisions();
      assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"), flag);
      before = after;
    }
  } finally { await f.dispose(); }
});

test("unreadable JSON or unknown master shapes produce conservative global revisions", async () => {
  const f = await revisionFixture();
  try {
    let before = await f.revision.periodRevisions();
    await fs.writeFile(f.masterFile, "{broken");
    let after = await f.revision.periodRevisions();
    assert.notEqual(after.globalToken, before.globalToken);
    before = after;
    await fs.writeFile(f.masterFile, JSON.stringify({ companies: [] }));
    after = await f.revision.periodRevisions();
    assert.notEqual(after.globalToken, before.globalToken, "unknown companies shape");
    await f.writeMaster();
    before = await f.revision.periodRevisions();
    f.master.companies.cmp_place_101.runIds = { unexpected: true };
    await f.writeMaster();
    after = await f.revision.periodRevisions();
    assert.notEqual(after.globalToken, before.globalToken, "unknown automatic field shape");
  } finally { await f.dispose(); }
});

test("an atomic source replacement during reading is retried before returning a revision", async () => {
  const f = await revisionFixture();
  const originalRead = fs.readFile;
  let masterReads = 0;
  try {
    const before = await f.revision.periodRevisions();
    const revision = createIndustrySourceRevision({ dataDir: f.root, outputsDir: f.outputsDir });
    fs.readFile = async function(file, ...rest) {
      const content = await originalRead.call(this, file, ...rest);
      if (file === f.masterFile && ++masterReads === 1) {
        f.master.companies.cmp_place_101.manualCorrection = { active: true, lodgingBasisTotal: 7 };
        await f.writeMaster();
      }
      return content;
    };
    const after = await revision.periodRevisions();
    assert.equal(masterReads, 2, "changed input is reparsed on the second attempt");
    assert.notEqual(monthToken(after, "2026-09"), monthToken(before, "2026-09"));
    assert.equal(after.globalToken, before.globalToken);
  } finally { fs.readFile = originalRead; await f.dispose(); }
});
