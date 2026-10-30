"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const D = require("./verify_keyword_monthly_dashboard_preservation.cjs");
const NOW = "2026-10-30T12:00:00.000Z", root = path.resolve("/dashboard-preservation-fixture"), source = path.resolve("/dashboard-code-fixture"), hash = value => crypto.createHash("sha256").update(value).digest("hex"), clone = value => JSON.parse(JSON.stringify(value));
function fixture(changes = {}) {
  const config = { version: 1, enabled: true, timezone: "Asia/Seoul", firstDate: "2026-10-25", time: "09:00", keywordIntervalMinutes: 120, keywords: ["경남글램핑", "가평글램핑", "부산글램핑", "포천글램핑", "대구글램핑", "여수글램핑"], workers: [{ workerKey: "web", dailyLimit: 3 }, { workerKey: "manual", dailyLimit: 3 }], collection: { bookingDays: 21, collectionMode: "precision", collectionPurpose: "revenue_detail", detailRankRanges: "1-20", productMode: "all", dayUseMode: "inspect" } };
  const rawConfig = JSON.stringify(config), jobId = "collector_11111111-1111-4111-8111-111111111111", broker = { version: 1, halted: null, jobs: [{ id: jobId, status: "completed", createdAt: NOW, updatedAt: NOW, finishedAt: NOW, leaseHash: "b".repeat(64), leaseReleasedAt: NOW, payload: { sensitive: "MUST_NOT_BE_RETURNED" } }] };
  const catalog = { schemaVersion: 1, kind: "keyword_monthly_partition_bundle", scopes: [] }, rawCatalog = JSON.stringify(catalog), generation = "a".repeat(32), files = new Map([
    ["config/daily_keyword_collection.json", { version: 1 }], ["config/keyword-worker-schedule-manual.json", { version: 1 }], ["config/keyword-worker-schedule-web.json", { version: 1 }],
    ["collector/jobs.json", broker], ["collector-scheduled/jobs.json", { version: 1, halted: null, jobs: [] }], ["collector-web/state.json", { version: 1, active: null, halted: null }], ["history/collection_postprocess/queue.json", { version: 1, sequence: 0, jobs: {} }],
    ["keyword_monthly_analysis/current.json", { schemaVersion: 1, generation, catalogSha256: hash(rawCatalog), catalogBytes: Buffer.byteLength(rawCatalog), publishedAt: NOW }], [`keyword_monthly_analysis/generations/${generation}/catalog.json`, catalog] ]);
  const rows = [{ id: "rotation_2026-10-29_1", day: "2026-10-29", slot_index: 0, worker_key: "web", keyword: "경남글램핑", scheduled_at: "2026-10-29T00:00:00.000Z", status: "complete", started_at: "2026-10-29T00:00:01.000Z", finished_at: "2026-10-29T00:08:00.000Z", error_code: null, result_bytes: 100, receipt_bytes: 90 }, ...Array.from({ length: 6 }, (_, i) => ({ id: `rotation_2026-10-30_${i + 1}`, day: "2026-10-30", slot_index: i, worker_key: i % 2 ? "manual" : "web", keyword: config.keywords[i], scheduled_at: `2026-10-30T${String(i * 2).padStart(2, "0")}:00:00.000Z`, status: "waiting", started_at: null, finished_at: null, error_code: null, result_bytes: null, receipt_bytes: null }))];
  const days = ["2026-10-29", "2026-10-30"].map(day => ({ day, revision: 3, cursor_start: 0, cursor_next: 0, created_at: day + "T00:00:00.000Z", config_json: rawConfig })), sql = [], reads = [], stables = [];
  class DatabaseSync {
    constructor(file, options) { assert.equal(file, path.join(root, "config/collection-rotation.sqlite")); assert.deepEqual(options, { readOnly: true }); sql.push({ constructorReadOnly: true }); }
    exec(statement) { assert.ok(!/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|ATTACH)\b/i.test(statement)); sql.push(statement); }
    prepare(statement) { sql.push(statement); return { get: () => {
      if (statement === "PRAGMA query_only") return { query_only: changes.queryOnly ?? 1 };
      if (statement.includes("FROM rotation_state")) return { version: 1, revision: 3, cursor: 0, plan_state: "enabled", reason: null, updated_at: NOW, config_json: rawConfig };
      if (statement.includes("FROM rotation_days")) return { count: days.length, bytes: days.length * Buffer.byteLength(rawConfig) };
      if (statement.includes("FROM rotation_one_day_trials")) return { count: 0, bytes: 0 };
      if (statement.includes("FROM rotation_events")) return { count: 1, lastId: 1, lastAt: NOW };
      throw Error("UNEXPECTED_SQL_GET");
    }, all: () => { if (statement.includes("FROM rotation_slots")) return clone(rows); if (statement.includes("FROM rotation_days")) return clone(days); if (statement.includes("FROM rotation_one_day_trials")) return []; throw Error("UNEXPECTED_SQL_ALL"); } }; }
    close() { sql.push("CLOSE"); }
  }
  const dependencies = { fixture: true, root, source, DatabaseSync,
    read(file, maximum) { const relative = path.relative(root, file).split(path.sep).join("/"); reads.push(relative); assert.ok(files.has(relative), "only exact whitelisted saved metadata paths may be read"); const data = clone(files.get(relative)), raw = JSON.stringify(data); assert.ok(Buffer.byteLength(raw) <= maximum); return { file, bytes: Buffer.byteLength(raw), sha256: hash(raw), data }; },
    checked(file, maximum) { assert.ok(["config/collection-rotation.sqlite", "config/collection-rotation.sqlite-wal", "config/collection-rotation.sqlite-shm"].some(relative => file === path.join(root, relative))); return { file, maximum, stat: { size: 4096 } }; }, stable(record, shm) { stables.push({ file: record.file, shm: shm === true }); } };
  return { capture: () => D.captureSaved({ now: NOW }, dependencies), files, rows, sql, reads, stables, jobId };
}
test("narrow reader uses one readonly/query_only transaction and whitelisted metadata without KOSIS/source/app/secret reads", () => {
  const f = fixture(), output = f.capture(); assert.equal(output.status, "read_verified"); assert.equal(output.fixtureOnly, true); assert.equal(output.rotation.state.sixSlotConfigVerified, true); assert.equal(output.rotation.today.slotCount, 6);
  assert.equal(f.sql.filter(s => typeof s === "string" && s.includes("BEGIN")).length, 1); assert.equal(f.sql.filter(s => s === "COMMIT").length, 1); assert.equal(f.sql.filter(s => s === "CLOSE").length, 1);
  assert.equal(f.reads.length, 9); assert.ok(f.reads.every(p => !/kosis|regional_market|outputs|company_master|observations|source/i.test(p)));
  assert.ok(f.sql.filter(s => typeof s === "string" && s.includes("rotation_slots")).every(s => !/CASE.+result_json|receipt_json\s+FROM/.test(s)), "slot result and receipt bodies are not selected");
  assert.equal(f.stables.filter(r => r.shm).length, 1); assert.equal(output.kosisPathsRead, false); assert.equal(output.sourceFilesRead, false); assert.equal(output.providerCalls, 0); assert.equal(output.appStarted, false);
  const text = JSON.stringify(output); assert.ok(!text.includes("MUST_NOT_BE_RETURNED") && !text.includes("b".repeat(64)) && !text.includes("leaseHash"));
});
test("unchanged state passes while current execution, broker status and queue metadata may naturally advance", () => {
  const before = fixture().capture(), after = clone(before); after.rotation.executionMetadataSha256 = "c".repeat(64); after.rotation.state.cursor = 1; after.rotation.events.count++; after.brokers[0].jobMetadataSha256 = "d".repeat(64); after.postprocess.metadataSha256 = "e".repeat(64);
  const comparison = D.compareSnapshots(before, after); assert.equal(comparison.status, "preserved"); assert.ok(comparison.naturallyAdvanced.includes("rotation.executionMetadata")); assert.ok(comparison.naturallyAdvanced.includes("postprocess"));
});
test("config revision, exact six slots, allocations and historical metadata cannot silently change in a UI release", () => {
  const before = fixture().capture();
  for (const mutate of [r => { r.rotation.state.sixSlotConfigVerified = false; }, r => { r.rotation.state.configRawSha256 = "f".repeat(64); }, r => { r.rotation.state.revision = 4; }, r => { r.rotation.allocationSha256 = "f".repeat(64); }, r => { r.rotation.historical.executionMetadataSha256 = "f".repeat(64); }, r => { r.individualSchedules[0].sha256 = "f".repeat(64); }]) { const after = clone(before); mutate(after); assert.equal(D.compareSnapshots(before, after).status, "needs_verification"); }
});
test("broker existing jobs and protections are preserved even when new jobs are allowed", () => {
  const before = fixture().capture(), after = clone(before); after.brokers[0].jobIds.push("collector_22222222-2222-4222-8222-222222222222"); assert.equal(D.compareSnapshots(before, after).status, "preserved");
  after.brokers[0].jobIds = []; assert.equal(D.compareSnapshots(before, after).status, "needs_verification");
  const protectedAfter = clone(before); protectedAfter.webCollector.halted = true; protectedAfter.webCollector.haltCode = "NAVER_CAPTCHA"; assert.equal(D.compareSnapshots(before, protectedAfter).status, "needs_verification");
  const truncated = clone(before); truncated.brokers[0].jobIdsComplete = false; assert.equal(D.compareSnapshots(before, truncated).status, "needs_verification");
});
test("a monthly pointer change requires separate refresh evidence and is never attributed to unchanged UI", () => {
  const before = fixture().capture(), after = clone(before); after.monthlyProjection.pointerSha256 = "f".repeat(64); const comparison = D.compareSnapshots(before, after);
  assert.equal(comparison.status, "needs_verification"); assert.equal(comparison.pointerChangeRequiresSeparateRefreshEvidence, true);
});
test("cross-day comparisons and query_only failure remain unknown, not preserved or zero", () => {
  const before = fixture().capture(), after = clone(before); after.day = "2026-10-31"; assert.throws(() => D.compareSnapshots(before, after), { code: "DASHBOARD_COMPARISON_SAME_DAY_REQUIRED" });
  const f = fixture({ queryOnly: 0 }); assert.throws(f.capture, { code: "QUERY_ONLY_NOT_CONFIRMED" }); assert.ok(f.sql.includes("ROLLBACK") && f.sql.includes("CLOSE"));
});
test("real CLI reader cannot accept caller-selected source paths or run outside its bound central Shell", () => {
  assert.throws(() => D.captureSaved({ root: "/arbitrary" }), { code: "WRONG_CENTRAL_SHELL_CONTEXT" });
  if (process.platform !== "linux" || process.cwd() !== "/opt/render/project/src") assert.throws(() => D.captureSaved(), { code: "WRONG_CENTRAL_SHELL_CONTEXT" });
});
