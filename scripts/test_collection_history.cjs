"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createCollectionHistory, normalizeQuery, normalizedRow, stateFor } = require("./lib/collection_history.cjs");
const at = () => new Date("2026-10-13T03:00:00Z");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "collection-history-unit-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  const dataDir = path.join(root, "data"); await fs.mkdir(dataDir);
  for (const namespace of ["collector-requests", "keyword-worker-schedule", "keyword-worker-schedule-web", "keyword-worker-schedule-manual"]) await fs.mkdir(path.join(dataDir, "history", namespace), { recursive: true });
  await fs.mkdir(path.join(dataDir, "outputs"));
  async function write(relative, value) { const file = path.join(dataDir, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
  return { root, dataDir, write, service: createCollectionHistory({ dataDir, now: at, cacheTtlMs: 0 }) };
}
function request(requestId, values = {}) { return { version: 1, requestId, keyword: "경남글램핑", workerKey: "manual", trigger: "manual", status: "complete", createdAt: "2026-09-20T03:00:00Z", finishedAt: "2026-09-20T03:01:00Z", result: { runId: `run_${requestId}`, collectionQuality: { status: "complete" } }, ...values }; }
async function inventory(dir, prefix = "") {
  const files = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name), relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, await inventory(file, relative));
    else { const stat = await fs.stat(file); files[relative] = { mtime: stat.mtimeMs, sha: crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex") }; }
  }
  return files;
}

test("query dates are KST, weekly scope is Monday through Sunday, invalid ranges rejected", () => {
  const now = new Date("2026-12-31T15:01:00Z");
  assert.deepEqual([normalizeQuery({}, now).from, normalizeQuery({}, now).to], ["2027-01-01", "2027-01-01"]);
  const week = normalizeQuery({ from: "2026-09-20", to: "2026-09-21", groupBy: "week" }, at());
  assert.deepEqual([week.from, week.to], ["2026-09-14", "2026-09-27"]);
  assert.equal(normalizeQuery({ from: "2000-01-01", to: "2000-01-01", groupBy: "week", groupKey: "1999-12-27" }, at()).groupKey, "1999-12-27");
  for (const params of [{ from: "2026-02-30" }, { from: "2026-11-01", to: "2026-10-01" }, { from: "2000-01-01", to: "2026-01-01" }, { groupBy: "quarter" }, { groupBy: "week", groupKey: "2026-09-20" }, { worker: "unknown" }, { state: "wat" }, { limit: "51" }, { offset: "-1" }, { keyword: "x".repeat(161) }, { extra: "x" }]) assert.throws(() => normalizeQuery(params, at()), { statusCode: 400 });
  assert.throws(() => normalizeQuery(new URLSearchParams("from=2026-01-01&from=2026-02-01"), at()), { statusCode: 400 });
});

test("review refusal precedes failure, normal pending/partial/blocked remain distinct", () => {
  assert.equal(stateFor("failed", null, "COLLECTION_REVIEW_REQUIRED"), "review");
  assert.equal(stateFor("failed", null, "COLLECTION_SCOPE_REVIEW"), "review");
  assert.equal(stateFor("running", null), "pending");
  assert.equal(stateFor("reused", { status: "complete" }), "complete");
  assert.equal(stateFor("complete", { status: "partial" }), "partial");
  assert.equal(stateFor("blocked", { status: "complete" }), "failed");
  assert.equal(stateFor("unknown", null), "review");
});

test("date basis never treats filesystem metadata or parent first-item time as collection execution", () => {
  const context = { id: "fixture", source: "outputs", createdAt: "2026-09-20T10:00:00Z", scheduledAt: "2026-09-20T14:30:00Z" };
  const queued = normalizedRow({ keyword: "가평글램핑", status: "queued", scheduledAt: "2026-09-20T15:30:00Z" }, context);
  assert.equal(queued.date, "2026-09-21"); assert.equal(queued.dateBasis, "scheduled"); assert.equal(queued.startedAt, null);
  const actual = normalizedRow({ keyword: "가평글램핑", status: "complete", startedAt: "2026-09-20T14:59:00Z", executionStartedAt: "2026-09-20T15:01:00Z" }, context);
  assert.equal(actual.date, "2026-09-21"); assert.equal(actual.dateBasis, "execution");
  const filesystem = normalizedRow({ keyword: "가평글램핑", collectedAt: "2026-09-20T03:00:00Z", collectedAtSource: "filesystem" }, { id: "mtime", source: "outputs" });
  assert.equal(filesystem.dateBasis, "unknown"); assert.equal(filesystem.date, null);
  const invalid = normalizedRow({ keyword: "가평", startedAt: "2026-02-30T14:00:00Z" }, { id: "invalid", source: "outputs" });
  assert.equal(invalid.dateBasis, "unknown");
});

test("all old requests are grouped and paginated beyond the previous fifty-record limit", async t => {
  const { write, service, dataDir } = await fixture(t);
  for (let index = 0; index < 67; index++) await write(`history/collector-requests/request_${String(index).padStart(3, "0")}.json`, request(`request_${String(index).padStart(3, "0")}`));
  const before = await inventory(dataDir);
  const summary = await service.query({ from: "2026-09-01", to: "2026-09-30" });
  assert.equal(summary.summary.total, 67); assert.equal(summary.groups[0].count, 67); assert.equal(summary.groups[0].key, "2026-09"); assert.equal(summary.rows, undefined);
  const first = await service.query({ from: "2026-09-01", to: "2026-09-30", groupKey: "2026-09", limit: 50 });
  const last = await service.query({ from: "2026-09-01", to: "2026-09-30", groupKey: "2026-09", offset: first.nextOffset });
  assert.equal(first.rows.length, 50); assert.equal(first.totalRows, 67); assert.equal(first.hasMore, true); assert.equal(last.rows.length, 17); assert.equal(last.hasMore, false);
  assert.equal(new Set([...first.rows, ...last.rows].map(row => row.id)).size, 67);
  assert.deepEqual(await inventory(dataDir), before, "read-only history never initializes/recover-writes a scheduler or request ledger");
});

test("scheduler all items and legacy daily outcomes retain real per-item execution dates", async t => {
  const { write, service } = await fixture(t);
  await write("history/keyword-worker-schedule-manual/scheduled_2026-09-20.json", { version: 1, id: "scheduled_2026-09-20", workerKey: "manual", trigger: "scheduled", createdAt: "2026-09-20T10:00:00Z", startedAt: "2026-09-20T14:30:00Z", scheduledAt: "2026-09-20T14:30:00Z", config: { collection: { bookingDays: 14, detailRankRanges: "1-20", dayUseMode: "inspect", token: "NO_SECRET" } }, items: [
    { keyword: "경남글램핑", status: "complete", runId: "schedule_run", durationMs: 62761, startedAt: "2026-09-20T14:31:00Z", executionStartedAt: "2026-09-20T15:01:00Z", collectionQuality: { status: "complete" } },
    { keyword: "대구글램핑", status: "queued", scheduledAt: "2026-09-20T15:30:00Z" },
    { keyword: "부산글램핑", status: "missed", scheduledAt: "2026-09-21T03:00:00Z" }
  ] });
  await write("history/daily_keyword_collection_state.json", { version: 1, days: { "2026-09-20": { createdAt: "2026-09-20T03:00:00Z", scheduledAt: "2026-09-20T05:00:00Z", items: [
    { keyword: "경남글램핑", status: "completed", runId: "daily_old", startedAt: "2026-09-20T05:00:00Z", quality: { status: "complete" } },
    { keyword: "포천글램핑", status: "partial", startedAt: "2026-09-20T06:00:00Z", quality: { status: "partial" }, error: "SECRET_RAW_ERROR" }
  ] } } });
  const value = await service.query({ from: "2026-09-20", to: "2026-09-21", groupBy: "day", groupKey: "2026-09-21" });
  assert.equal(value.summary.total, 5); assert.deepEqual(value.summary.counts, { pending: 1, complete: 2, failed: 1, partial: 1, review: 0 });
  assert.equal(value.totalRows, 3); assert.deepEqual(value.rows.map(row => row.dateBasis), ["scheduled", "scheduled", "execution"]);
  assert.equal(value.rows[2].conditions.bookingRangeDays, 14); assert.equal(value.rows[2].durationMs, 62761); assert.doesNotMatch(JSON.stringify(value), /SECRET_RAW_ERROR|NO_SECRET|"config"/);
  const weekly = await service.query({ from: "2026-09-20", to: "2026-09-21", groupBy: "week" });
  assert.deepEqual(weekly.groups.map(group => [group.key, group.count]), [["2026-09-21", 3], ["2026-09-14", 2]]);
});

test("manifest fallback excludes original receipt duplicates but preserves original runs referenced only by later reuse", async t => {
  const { write, service } = await fixture(t);
  await write("history/collector-requests/actual_0001.json", request("actual_0001", { result: { runId: "actual_run", collectionQuality: { status: "complete" } } }));
  await write("history/collector-requests/actual_0002.json", request("actual_0002", { result: { runId: "actual_run", collectionQuality: { status: "complete" } } }));
  await write("history/collector-requests/reuse_0001.json", request("reuse_0001", { status: "reused", createdAt: "2026-09-21T03:00:00Z", finishedAt: "2026-09-21T03:01:00Z", result: { runId: "original_run", reused: true, collectionQuality: { status: "complete" } } }));
  await write("history/collector-requests/reuse_0002.json", request("reuse_0002", { status: "reused", createdAt: "2026-09-22T03:00:00Z", finishedAt: "2026-09-22T03:01:00Z", result: { runId: "original_run", reused: true, collectionQuality: { status: "complete" } } }));
  await write("outputs/actual_run/manifest.json", { keyword: "경남글램핑", workerKey: "manual", startedAt: "2026-09-20T03:00:30Z", collectedAt: "2026-09-20T03:01:00Z", collectionQuality: { status: "complete" } });
  await write("outputs/original_run/manifest.json", { keyword: "경남글램핑", workerKey: "manual", collectedAt: "2026-09-01T03:00:00Z", collectionQuality: { status: "complete" } });
  const all = await service.query({ from: "2026-09-01", to: "2026-09-30", groupKey: "2026-09" });
  assert.equal(all.totalRows, 5, "two real attempts, two reuse receipts, one original fallback");
  assert.equal(all.rows.filter(row => row.id === "result_actual_run").length, 0);
  assert.equal(all.rows.filter(row => row.id === "result_original_run").length, 1);
  assert.equal(all.rows.filter(row => row.requestId?.startsWith("actual")).every(row => row.dateBasis === "execution"), true);
  assert.equal(all.rows.find(row => row.requestId === "reuse_0001").date, "2026-09-21");
});

test("manifest quality missing becomes review; mtime-only is excluded with unknown-date warning", async t => {
  const { write, service } = await fixture(t);
  await write("outputs/no_quality/manifest.json", { keyword: "가평글램핑", collectedAt: "2026-09-20T03:00:00Z", outputDir: "PRIVATE_DIRECTORY", collectorRunToken: "PRIVATE_TOKEN", files: ["RAW_FILE"] });
  await write("outputs/mtime_only/manifest.json", { keyword: "가평글램핑", collectedAt: "2026-09-20T03:00:00Z", collectedAtSource: "filesystem", collectionQuality: { status: "complete" } });
  await write("outputs/no_time/manifest.json", { keyword: "가평글램핑", collectionQuality: { status: "complete" } });
  const value = await service.query({ from: "2026-09-01", to: "2026-09-30", groupKey: "2026-09" });
  assert.equal(value.summary.total, 1); assert.equal(value.summary.counts.review, 1); assert.equal(value.summary.unknownDateCount, 2);
  assert.equal(value.rows[0].workerKey, "unknown"); assert.equal(value.rows[0].dateBasis, "saved");
  assert.ok(value.warnings.some(warning => warning.code === "time_unknown" && warning.count === 2));
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_DIRECTORY|PRIVATE_TOKEN|RAW_FILE|outputDir|collectorRunToken/);
});

test("missing and malformed sources are warnings; link and escaped sources never leak", async t => {
  const { root, dataDir, write, service } = await fixture(t);
  await fs.rm(path.join(dataDir, "history", "keyword-worker-schedule-web"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "history", "collector-requests", "corrupt_0001.json"), "bad-json SECRET_CORRUPTION");
  await write("history/collector-requests/review_0001.json", request("review_0001", { status: "failed", errorCode: "COLLECTION_REVIEW_REQUIRED", stack: "SECRET_STACK", message: "SECRET_MESSAGE" }));
  const outside = path.join(root, "outside"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "manifest.json"), JSON.stringify({ keyword: "SECRET_OUTSIDE", collectedAt: "2026-09-20T03:00:00Z", collectionQuality: { status: "complete" } }));
  await fs.symlink(outside, path.join(dataDir, "outputs", "external_link"), process.platform === "win32" ? "junction" : "dir");
  const value = await service.query({ from: "2026-09-01", to: "2026-09-30", state: "attention", groupKey: "2026-09" });
  assert.equal(value.summary.total, 1); assert.equal(value.summary.counts.review, 1);
  assert.equal(value.sources.web.status, "absent");
  for (const name of ["source_missing", "record_invalid", "unsafe_path"]) assert.ok(value.warnings.some(warning => warning.code === name), name);
  assert.doesNotMatch(JSON.stringify(value), /SECRET_/);
});

test("concurrent requests share one read snapshot and only matching worker/keyword/state are counted", async t => {
  const { dataDir, write } = await fixture(t);
  await write("history/collector-requests/pending_0001.json", request("pending_0001", { status: "pending", result: null, finishedAt: null }));
  await write("history/collector-requests/failed_0001.json", request("failed_0001", { workerKey: "web", keyword: "포천글램핑", status: "failed", errorCode: "COLLECTOR_UPLOAD_FAILED" }));
  const service = createCollectionHistory({ dataDir, now: at, cacheTtlMs: 5000 });
  const original = fs.readFile; let reads = 0;
  fs.readFile = async (...args) => { if (String(args[0]).startsWith(dataDir)) reads += 1; return original(...args); };
  try {
    const values = await Promise.all(Array.from({ length: 12 }, () => service.query({ from: "2026-09-01", to: "2026-09-30", worker: "manual", keyword: "경남", state: "pending" })));
    assert.equal(values.every(value => value.summary.total === 1 && value.summary.counts.pending === 1), true);
    assert.equal(reads, 2, "parallel queries scan each receipt once");
    await service.query({ from: "2026-09-01", to: "2026-09-30" }); assert.equal(reads, 2, "cached period/filter switches use same read snapshot");
  } finally { fs.readFile = original; }
});

test("completion timestamp fallback, malformed complete receipt and latest terminal are explicit", async t => {
  const { write, service } = await fixture(t);
  await write("history/collector-requests/complete_broken.json", request("complete_broken", { result: null }));
  await write("history/collector-requests/pending_latest.json", request("pending_latest", { status: "pending", result: null, createdAt: "2026-09-29T03:00:00Z" }));
  await write("outputs/completion_time/manifest.json", { keyword: "가평글램핑", completedAt: "2026-09-21T03:00:00Z", collectionQuality: { status: "complete" } });
  const value = await service.query({ from: "2026-09-01", to: "2026-09-30", groupKey: "2026-09" });
  assert.deepEqual(value.summary.counts, { pending: 1, complete: 1, failed: 0, partial: 0, review: 1 });
  assert.equal(value.summary.latest.requestId, "pending_latest"); assert.equal(value.summary.latestTerminal.runId, "completion_time");
  assert.equal(value.groups[0].latestTerminal.runId, "completion_time");
  const broken = value.rows.find(row => row.requestId === "complete_broken"); assert.equal(broken.status, "unknown"); assert.equal(broken.recordedStatus, "complete");
  const saved = value.rows.find(row => row.runId === "completion_time"); assert.equal(saved.dateBasis, "saved"); assert.equal(saved.date, "2026-09-21");
  assert.ok(value.warnings.some(warning => warning.code === "record_invalid"));
});

test("snapshot expires to pick up an updated receipt and keeps pending unchanged", async t => {
  const { dataDir, write } = await fixture(t); let instant = new Date("2026-10-13T03:00:00Z");
  const service = createCollectionHistory({ dataDir, now: () => instant, cacheTtlMs: 5000 });
  const pending = request("changing_0001", { status: "pending", result: null, finishedAt: null });
  await write("history/collector-requests/changing_0001.json", pending);
  assert.equal((await service.query({ from: "2026-09-01", to: "2026-09-30" })).summary.counts.pending, 1);
  await write("history/collector-requests/changing_0001.json", request("changing_0001", { status: "partial", result: { runId: "changing_run", collectionQuality: { status: "partial", reason: "booking_targets_incomplete" } } }));
  assert.equal((await service.query({ from: "2026-09-01", to: "2026-09-30" })).summary.counts.pending, 1, "bounded snapshot cache still showing prior safe result");
  instant = new Date(instant.getTime() + 5001);
  const updated = await service.query({ from: "2026-09-01", to: "2026-09-30" }); assert.equal(updated.summary.counts.partial, 1); assert.equal(updated.summary.counts.pending, 0);
});

test("an undated original receipt retains its referenced result's authoritative storage date", async t => {
  const { write, service } = await fixture(t);
  await write("history/collector-requests/undated_0001.json", request("undated_0001", { createdAt: null, finishedAt: null, result: { runId: "known_saved_result", collectionQuality: { status: "complete" } } }));
  await write("outputs/known_saved_result/manifest.json", { keyword: "경남글램핑", completedAt: "2026-09-21T03:00:00Z", checkIn: "2026-09-21", checkOut: "2026-10-04", bookingRangeDays: 14, collectionQuality: { status: "complete" } });
  const value = await service.query({ from: "2026-09-01", to: "2026-09-30", groupKey: "2026-09" });
  assert.equal(value.summary.total, 1); assert.equal(value.summary.unknownDateCount, 0);
  assert.equal(value.rows[0].requestId, "undated_0001"); assert.equal(value.rows[0].dateBasis, "saved"); assert.equal(value.rows[0].date, "2026-09-21");
  assert.equal(value.rows[0].conditions.bookingRangeDays, 14);
});

test("rotation records retain waiting and uncertain gaps without duplicating stored successful runs", async t => {
  const {dataDir,write}=await fixture(t);
  const base={day:"2026-09-21",workerKey:"web",keyword:"경남글램핑",scheduledAt:"2026-09-21T00:00:00Z",
    conditions:{checkIn:"2026-09-21",checkOut:"2026-10-21",bookingRangeDays:31,searchMode:"keyword"}};
  const items=[{...base,id:"rotation_2026-09-21_1",status:"complete",runId:"rotation_done",startedAt:base.scheduledAt,collectionQuality:{status:"complete"}},
    {...base,id:"rotation_2026-09-21_2",status:"waiting",workerKey:"manual"},
    {...base,id:"rotation_2026-09-21_3",status:"uncertain",errorCode:"ROTATION_RESTART_EXECUTION_UNCERTAIN"}];
  await write("outputs/rotation_done/manifest.json",{keyword:base.keyword,workerKey:"web",startedAt:base.scheduledAt,collectionQuality:{status:"complete"}});
  const before=await inventory(dataDir);
  const service=createCollectionHistory({dataDir,now:at,cacheTtlMs:0,readRotationHistory:async()=>items});
  const value=await service.query({from:"2026-09-01",to:"2026-09-30",groupKey:"2026-09"});
  assert.equal(value.summary.total,3);
  assert.deepEqual(value.summary.counts,{pending:1,complete:1,failed:0,partial:0,review:1});
  assert.ok(value.rows.every(row=>row.source==="rotation" && row.trigger==="scheduled" && row.conditions.bookingRangeDays===31));
  assert.deepEqual(await inventory(dataDir),before,"History reads preserve raw results and existing receipts");
});
