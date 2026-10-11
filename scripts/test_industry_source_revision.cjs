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
