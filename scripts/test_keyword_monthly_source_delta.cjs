"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createKeywordMonthlySourceDelta } = require("./lib/keyword_monthly_source_delta.cjs");
const at = "2026-11-15T01:00:00.000Z", sha = value => crypto.createHash("sha256").update(value).digest("hex");
const sourceStamp = () => ({ before: { dev: "1", ino: "2", size: 123, mtimeNs: "4", ctimeNs: "5" }, after: { dev: "1", ino: "3", size: 234, mtimeNs: "6", ctimeNs: "7" } });
const history = (extra = {}) => ({ runId: "run_001", rows: [{ companyKey: "cmp_1", observationId: 1, stayDate: "2026-11-20", runId: "run_001", sold: 0 },
  { observationId: "1", companyKey: "cmp_1", runId: "run_001", stayDate: "2026-11-20", sold: 2 }], sourceStamp: sourceStamp(), indexUpdated: true, ...extra });
const companies = () => ({ changes: [{ companyId: "cmp_2", company: { placeIds: ["22", "11"], companyId: "cmp_2", keywords: { second: { keyword: "나", runs: [{ rank: 3, extra: "kept" }] }, first: { keyword: "가" } } }, orderIndex: 0 },
  { companyId: "cmp_deleted", company: null, orderIndex: 5 }], order: ["cmp_2", "cmp_1"], sourceStamp: sourceStamp() });
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-source-delta-test-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const make = extra => createKeywordMonthlySourceDelta({ dataDir, now: () => new Date(at), ...options, ...extra });
  return { dataDir, q: make(), make };
}
async function filesIn(root) {
  const result = [];
  async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else result.push([path.relative(root, file), sha(await fs.readFile(file))]); } }
  await walk(root); return result.sort(([a], [b]) => a.localeCompare(b));
}

test("cold inventory is read-only and does not create a namespace", async t => {
  const f = await fixture(t), listed = await f.q.listEvents();
  assert.equal(listed.status, "available"); assert.deepEqual(listed.events, []); assert.equal(listed.completeCount, 0); assert.equal(listed.readOnly, true);
  await assert.rejects(fs.lstat(f.q.directory), { code: "ENOENT" });
});

test("company snapshots, tombstones and member/key order survive without input mutation", async t => {
  const f = await fixture(t), input = companies(), before = JSON.stringify(input), recorded = await f.q.recordCompanyDelta(input);
  assert.equal(recorded.status, "complete"); assert.equal(recorded.sourceWrites, 0); assert.equal(recorded.collectionPostprocessUnaffected, undefined);
  assert.equal(JSON.stringify(input), before); const loaded = await f.q.readEvent(recorded.eventId);
  assert.equal(JSON.stringify(loaded.event.payload), before); assert.equal(loaded.event.payload.changes[1].company, null);
  assert.deepEqual(Object.keys(loaded.event.payload.changes[0].company), ["placeIds", "companyId", "keywords"]);
  assert.deepEqual(loaded.event.payload.order, ["cmp_2", "cmp_1"]);
  const pending = path.join(f.q.directory, "pending", recorded.eventId + ".json"), marker = path.join(f.q.directory, "complete", recorded.eventId + ".json");
  assert.equal(sha(await fs.readFile(pending)), JSON.parse(await fs.readFile(marker)).eventSha256);
});

test("history retains every duplicate and intermediate candidate, types, zero and index failure", async t => {
  const f = await fixture(t), input = history({ indexUpdated: false }), result = await f.q.recordHistoryDelta(input);
  assert.equal(result.status, "complete"); const loaded = await f.q.readEvent(result.eventId);
  assert.equal(loaded.event.payload.indexUpdated, false); assert.equal(loaded.event.payload.rows.length, 2);
  assert.equal(loaded.event.payload.rows[0].observationId, 1); assert.equal(loaded.event.payload.rows[1].observationId, "1");
  assert.equal(loaded.event.payload.rows[0].sold, 0); assert.equal(JSON.stringify(loaded.event.payload.rows), JSON.stringify(input.rows));
});

test("concurrent identical writes and restart reuse immutable content identity despite clock changes", async t => {
  const f = await fixture(t), results = await Promise.all(Array.from({ length: 8 }, () => f.q.recordHistoryDelta(history())));
  assert.ok(results.every(row => row.status === "complete")); assert.equal(new Set(results.map(row => row.eventId)).size, 1);
  assert.equal(results.filter(row => !row.alreadyRecorded).length, 1); const before = await filesIn(f.q.directory);
  const resumed = f.make({ now: () => new Date("2026-11-20T02:00:00Z") }); assert.equal((await resumed.recordHistoryDelta(history())).alreadyRecorded, true);
  assert.deepEqual(await filesIn(f.q.directory), before); assert.equal((await resumed.listEvents()).completeCount, 1);
});

test("a changed raw field, row order, company order or source stamp has a distinct event identity", async t => {
  const f = await fixture(t), a = await f.q.recordHistoryDelta(history()), b = await f.q.recordHistoryDelta(history({ rows: [...history().rows].reverse() }));
  const input = history(); input.sourceStamp.after.size++; const c = await f.q.recordHistoryDelta(input);
  const row = history(); row.rows[0] = { ...row.rows[0], sold: 1 }; const d = await f.q.recordHistoryDelta(row);
  const e = await f.q.recordCompanyDelta(companies()), changed = companies(); changed.order.reverse(); changed.changes[0].orderIndex = 1; const g = await f.q.recordCompanyDelta(changed);
  assert.equal(new Set([a, b, c, d, e, g].map(item => item.eventId)).size, 6);
});

test("record snapshots caller values synchronously before queued IO", async t => {
  const f = await fixture(t), input = history(), expected = JSON.stringify(input.rows), pending = f.q.recordHistoryDelta(input);
  input.rows[0].sold = 999; input.rows.reverse(); const written = await pending;
  assert.equal(JSON.stringify((await f.q.readEvent(written.eventId)).event.payload.rows), expected);
});

test("failure between pending and completion is explicit and exact retry recovers without deletion", async t => {
  let failComplete = true; const injected = { ...fs, rename: async (from, to) => {
    if (failComplete && path.basename(path.dirname(to)) === "complete") throw Object.assign(new Error("private detail"), { code: "ENOSPC" });
    return fs.rename(from, to);
  } };
  const f = await fixture(t, { fileSystem: injected }), failed = await f.q.recordHistoryDelta(history());
  assert.equal(failed.status, "needs_verification"); assert.equal(failed.errorCode, "ENOSPC"); assert.equal(failed.publicationState, "unknown"); assert.equal(failed.collectionPostprocessUnaffected, true);
  assert.equal((await f.q.listEvents()).status, "needs_verification"); assert.equal((await f.q.readEvent(failed.eventId)).status, "needs_verification");
  const pending = path.join(f.q.directory, "pending", failed.eventId + ".json"), preserved = await fs.readFile(pending);
  failComplete = false; const recovered = await f.make({ now: () => new Date("2026-11-16T00:00:00Z") }).recordHistoryDelta(history());
  assert.equal(recovered.status, "complete"); assert.equal(recovered.eventId, failed.eventId); assert.deepEqual(await fs.readFile(pending), preserved);
  assert.equal((await f.q.listEvents()).status, "available"); assert.equal(JSON.stringify(await filesIn(f.q.directory)).includes("private detail"), false);
});

test("a post-rename failure remains unknown until readback and retry certifies the same event", async t => {
  let failReadback = true; const injected = { ...fs, rename: async (from, to) => {
    await fs.rename(from, to); if (failReadback && path.basename(path.dirname(to)) === "complete") throw Object.assign(new Error("after promotion"), { code: "EIO" });
  } };
  const f = await fixture(t, { fileSystem: injected }), failed = await f.q.recordHistoryDelta(history());
  assert.equal(failed.status, "needs_verification"); assert.equal(failed.publicationState, "unknown"); assert.equal((await f.q.readEvent(failed.eventId)).status, "complete");
  const before = await filesIn(f.q.directory); failReadback = false; const repeated = await f.q.recordHistoryDelta(history());
  assert.equal(repeated.status, "complete"); assert.equal(repeated.alreadyRecorded, true); assert.deepEqual(await filesIn(f.q.directory), before);
});

test("corrupt pending or marker is held and never overwritten or interpreted as zero", async t => {
  for (const kind of ["pending", "complete"]) await t.test(kind, async st => {
    const f = await fixture(st), result = await f.q.recordHistoryDelta(history()), file = path.join(f.q.directory, kind, result.eventId + ".json");
    const bytes = await fs.readFile(file), value = JSON.parse(bytes);
    if (kind === "pending") value.payload.rows[0].sold = 5; else value.eventSha256 = "f".repeat(64);
    await fs.writeFile(file, JSON.stringify(value)); const corrupted = await fs.readFile(file);
    assert.equal((await f.q.readEvent(result.eventId)).status, "needs_verification"); assert.equal((await f.q.recordHistoryDelta(history())).status, "needs_verification");
    assert.deepEqual(await fs.readFile(file), corrupted);
  });
});

test("partial temporary file remains for review and cannot certify an event", async t => {
  let failedOnce = false; const injected = { ...fs, open: async (file, ...args) => {
    const handle = await fs.open(file, ...args);
    if (!failedOnce && typeof file === "string" && file.endsWith(".tmp") && path.basename(path.dirname(file)) === "pending") {
      failedOnce = true; return { ...handle, writeFile: async () => { await handle.writeFile("{"); throw Object.assign(new Error("disk"), { code: "ENOSPC" }); }, sync: () => handle.sync(), close: () => handle.close() };
    }
    return handle;
  } };
  const f = await fixture(t, { fileSystem: injected }), failed = await f.q.recordHistoryDelta(history());
  assert.equal(failed.status, "needs_verification"); const before = await filesIn(f.q.directory);
  assert.equal((await f.q.recordHistoryDelta(history())).status, "needs_verification"); assert.deepEqual(await filesIn(f.q.directory), before);
  const listed = await f.q.listEvents(); assert.equal(listed.status, "needs_verification"); assert.deepEqual(listed.events, []); assert.equal(listed.completeCount, 0);
});

test("completion marker changed across a payload read is not certified", async t => {
  let mutate = false, markerFile = null;
  const injected = { ...fs, open: async (file, ...args) => {
    if (mutate && file.endsWith(".json") && path.basename(path.dirname(file)) === "pending") {
      mutate = false; const value = JSON.parse(await fs.readFile(markerFile)); value.completedAt = "2026-11-16T00:00:00Z"; await fs.writeFile(markerFile, JSON.stringify(value));
    }
    return fs.open(file, ...args);
  } };
  const f = await fixture(t, { fileSystem: injected }), result = await f.q.recordHistoryDelta(history());
  markerFile = path.join(f.q.directory, "complete", result.eventId + ".json"); mutate = true;
  const read = await f.q.readEvent(result.eventId); assert.equal(read.status, "needs_verification"); assert.equal(read.errorCode, "KEYWORD_DELTA_EVIDENCE_CHANGED");
});

test("foreign namespace entries are preserved and prevent admission", async t => {
  const f = await fixture(t); await f.q.recordHistoryDelta(history()); const foreign = path.join(f.q.directory, "unowned.json"); await fs.writeFile(foreign, "foreign");
  const result = await f.q.recordCompanyDelta(companies()); assert.equal(result.errorCode, "KEYWORD_DELTA_INVENTORY_INVALID");
  assert.equal((await f.q.listEvents()).events, null); assert.equal(await fs.readFile(foreign, "utf8"), "foreign");
});

test("invalid, lossy, cyclic, accessor and out-of-order inputs do not begin IO", async t => {
  const f = await fixture(t); let invoked = false; const accessor = history(); Object.defineProperty(accessor, "sourceStamp", { enumerable: true, get() { invoked = true; return {}; } });
  const cycle = history(); cycle.rows[0].cycle = cycle;
  const invalidCompany = companies(); invalidCompany.changes[0].orderIndex = 1;
  const values = [accessor, cycle, history({ rows: [{ sold: NaN }] }), history({ rows: [{ omitted: undefined }] }), history({ rows: [{ date: new Date(at) }] }), history({ runId: "../escape" }), history({ sourceStamp: {} })];
  for (const value of values) assert.equal((await f.q.recordHistoryDelta(value)).publicationState, "not_started");
  assert.equal((await f.q.recordCompanyDelta(invalidCompany)).status, "needs_verification"); assert.equal(invoked, false);
  await assert.rejects(fs.lstat(f.q.directory), { code: "ENOENT" });
});

test("safe event IDs, symlinked namespace and hardlinked payload fail closed", async t => {
  const f = await fixture(t); assert.equal((await f.q.readEvent("../foreign")).errorCode, "KEYWORD_DELTA_EVENT_ID_INVALID");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "keyword-source-delta-outside-")); t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, f.q.directory, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.q.recordHistoryDelta(history())).status, "needs_verification"); assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(f.q.directory);
  const result = await f.q.recordHistoryDelta(history()), file = path.join(f.q.directory, "pending", result.eventId + ".json");
  await fs.link(file, path.join(outside, "linked.json"));
  assert.equal((await f.q.readEvent(result.eventId)).errorCode, "KEYWORD_DELTA_PATH_UNSAFE"); assert.equal((await f.q.listEvents()).events, null);
});

test("event/storage/entry limits preserve earlier complete events and failed input", async t => {
  const f = await fixture(t, { limits: { entries: 2 } }), good = await f.q.recordHistoryDelta(history()), before = await filesIn(f.q.directory);
  assert.equal(good.status, "complete"); const full = await f.q.recordHistoryDelta(history({ runId: "run_002" })); assert.equal(full.errorCode, "KEYWORD_DELTA_OUTBOX_BOUND");
  assert.deepEqual(await filesIn(f.q.directory), before);
  const small = await fixture(t, { limits: { eventBytes: 200 } }); assert.equal((await small.q.recordHistoryDelta(history())).errorCode, "KEYWORD_DELTA_EVENT_BOUND");
  const disk = await fixture(t, { limits: { outboxBytes: 100 } }); assert.equal((await disk.q.recordHistoryDelta(history())).errorCode, "KEYWORD_DELTA_OUTBOX_BOUND");
  assert.equal((await f.q.readEvent(good.eventId)).status, "complete");
});

test("listing reads small completion descriptors, paginates a fixed snapshot and catches late events", async t => {
  let payloadReads = 0; const injected = { ...fs, open: async (file, ...args) => {
    if (typeof file === "string" && path.basename(path.dirname(file)) === "pending" && file.endsWith(".json")) payloadReads++;
    return fs.open(file, ...args);
  } };
  const f = await fixture(t, { fileSystem: injected }); for (let n = 1; n <= 3; n++) assert.equal((await f.q.recordHistoryDelta(history({ runId: "run_" + n }))).status, "complete");
  payloadReads = 0; const first = await f.q.listEvents({ limit: 1 }); assert.equal(first.status, "available"); assert.equal(first.events.length, 1); assert.equal(first.events[0].payloadValidated, false); assert.equal(payloadReads, 0);
  const second = await f.q.listEvents({ limit: 2, offset: first.nextOffset, expectedInventorySha256: first.inventorySha256 });
  assert.equal(second.events.length, 2); assert.equal(second.nextOffset, null); assert.equal(new Set([...first.events, ...second.events].map(row => row.eventId)).size, 3);
  await f.q.recordHistoryDelta(history({ runId: "run_late" }));
  const stale = await f.q.listEvents({ limit: 1, offset: 1, expectedInventorySha256: first.inventorySha256 }); assert.equal(stale.errorCode, "KEYWORD_DELTA_INVENTORY_CHANGED"); assert.equal(stale.events, null);
});

test("source files are never opened, changed, removed, or copied", async t => {
  const f = await fixture(t), sentinels = ["company_master/companies.json", "history/observations.jsonl", "outputs/run_001/manifest.json", "kosis/data.json", "config/protection.json"];
  for (const relative of sentinels) { const file = path.join(f.dataDir, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "original-" + relative); }
  const before = new Map(await Promise.all(sentinels.map(async relative => [relative, sha(await fs.readFile(path.join(f.dataDir, relative)))])));
  const operations = [];
  const injected = { ...fs, open: async (file, ...args) => { operations.push(["open", file]); assert.ok(file.startsWith(f.q.directory + path.sep) || file === f.q.directory || file === f.dataDir); return fs.open(file, ...args); },
    unlink: async () => { throw Error("No deletion permitted"); }, rm: async () => { throw Error("No deletion permitted"); }, readFile: async () => { throw Error("Source body read prohibited"); } };
  const q = f.make({ fileSystem: injected }); assert.equal((await q.recordCompanyDelta(companies())).status, "complete"); const saved = await q.recordHistoryDelta(history()); assert.equal(saved.status, "complete");
  assert.equal((await q.readEvent(saved.eventId)).status, "complete"); assert.equal((await q.listEvents()).status, "available"); assert.ok(operations.length > 0);
  for (const relative of sentinels) assert.equal(sha(await fs.readFile(path.join(f.dataDir, relative))), before.get(relative));
});
